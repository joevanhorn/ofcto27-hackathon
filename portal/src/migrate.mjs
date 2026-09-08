// "Migrate to Okta-managed" — phases 3 + 4 of docs/ad-to-okta-journey.md,
// automated against a spoke org whose AD import (phases 1-2) is complete.
//
// What it does, in order, streaming every step through onLine:
//   1. discover  — find the Active Directory app instance, its imported users,
//                  and the AD-mastered groups (read-only mirrors)
//   2. mirror    — create an Okta-native twin of each AD group and copy members
//   3. re-target — move any app assignments off AD groups onto the twins
//   4. rules     — where the imported tv* attributes exist on the user profile,
//                  create attribute-driven groups + group rules (the "your OU
//                  tree becomes policy" moment); best-effort, never fatal
//   5. flip      — deactivate the AD app: profile sourcing falls through to
//                  Okta and delegated authentication ends
//   6. passwords — set each migrated user's Okta password to the TaskVantage
//                  demo password (stands in for the AD Password Sync agent:
//                  "same password, now against Okta"); then verify users report
//                  Okta as their credential provider
//
// Everything Okta-side it creates carries a marker so reset.mjs can find it:
// groups get "[tv-migrated]" in the description, group rules get a "tv-" name
// prefix. SECURITY: tokens only ever travel in Authorization headers; the demo
// password is sent to the Okta API and never emitted through onLine.

import { sswsHeader } from "./config.mjs";

export const MIGRATED_MARKER = "[tv-migrated]";
export const RULE_PREFIX = "tv-";

function makeClient(domain, token) {
  const headers = {
    authorization: sswsHeader(token),
    accept: "application/json",
    "content-type": "application/json",
  };
  return async (method, p, body) => {
    const r = await fetch(`https://${domain}${p}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* empty body */ }
    return { status: r.status, ok: r.ok, json };
  };
}

/**
 * Run the migration. Pass either {domain, token} or a pre-built {api} (tests).
 *
 * @param {object} args
 * @param {string} [args.domain] - spoke org domain
 * @param {string} [args.token] - spoke admin SSWS token
 * @param {(method, path, body?) => Promise<{status,ok,json}>} [args.api]
 * @param {string} [args.demoPassword] - password set on flipped users (password-sync stand-in)
 * @param {(line: string) => void} [args.onLine]
 * @returns {Promise<{status: "migrated"|"blocked"|"error", reason?: string, summary?: object}>}
 */
export async function runAdMigration({ domain, token, api, demoPassword, onLine = () => {} }) {
  const call = api || makeClient(domain, token);
  const say = (s) => onLine(`>> migrate: ${s}`);

  try {
    // --- 1. discover -------------------------------------------------------
    const apps = await call("GET", "/api/v1/apps?limit=200");
    if (!apps.ok) return { status: "error", reason: `apps list failed (HTTP ${apps.status})` };
    const adApp = (Array.isArray(apps.json) ? apps.json : []).find(
      (a) => a.name === "active_directory"
    );
    if (!adApp) {
      say("blocked — no Active Directory integration on this org (finish the import first)");
      return { status: "blocked", reason: "no AD integration found — complete phases 1-2 first" };
    }
    say(`found AD integration '${adApp.label || adApp.name}' (${adApp.status})`);

    const appUsers = await call("GET", `/api/v1/apps/${adApp.id}/users?limit=500`);
    const userIds = (Array.isArray(appUsers.json) ? appUsers.json : [])
      .map((u) => u.id)
      .filter(Boolean);
    say(`${userIds.length} AD-imported user(s)`);

    const groupsRes = await call("GET", "/api/v1/groups?limit=200");
    const adGroups = (Array.isArray(groupsRes.json) ? groupsRes.json : []).filter(
      (g) =>
        g.type === "APP_GROUP" &&
        g.profile &&
        g.profile.windowsDomainQualifiedName // AD-mastered groups carry this
    );
    say(`${adGroups.length} AD-mastered group(s) to mirror`);

    // --- 2. mirror groups --------------------------------------------------
    const mapping = new Map(); // AD group id -> native group id
    let membershipsCopied = 0;
    for (const g of adGroups) {
      const name = g.profile.name;
      const desc = `Okta-native replacement for AD group '${name}' ${MIGRATED_MARKER}`;
      let created = await call("POST", "/api/v1/groups", {
        profile: { name, description: desc },
      });
      if (!created.ok) {
        created = await call("POST", "/api/v1/groups", {
          profile: { name: `${name} (Okta)`, description: desc },
        });
      }
      if (!created.ok || !created.json || !created.json.id) {
        say(`mirror FAILED for '${name}' — skipping`);
        continue;
      }
      const nativeId = created.json.id;
      mapping.set(g.id, nativeId);

      const members = await call("GET", `/api/v1/groups/${g.id}/users?limit=200`);
      for (const m of Array.isArray(members.json) ? members.json : []) {
        const add = await call("PUT", `/api/v1/groups/${nativeId}/users/${m.id}`);
        if (add.ok || add.status === 204) membershipsCopied++;
      }
      say(`mirrored '${name}' (${(members.json || []).length} member(s))`);
    }

    // --- 3. re-target app assignments -------------------------------------
    let retargeted = 0;
    for (const app of Array.isArray(apps.json) ? apps.json : []) {
      if (app.id === adApp.id) continue;
      const assigned = await call("GET", `/api/v1/apps/${app.id}/groups?limit=100`);
      for (const asg of Array.isArray(assigned.json) ? assigned.json : []) {
        const nativeId = mapping.get(asg.id);
        if (!nativeId) continue;
        const put = await call("PUT", `/api/v1/apps/${app.id}/groups/${nativeId}`, {});
        if (put.ok) {
          await call("DELETE", `/api/v1/apps/${app.id}/groups/${asg.id}`);
          retargeted++;
          say(`re-targeted '${app.label || app.name}' from an AD group to its Okta twin`);
        }
      }
    }
    if (!retargeted) say("no app assignments were riding AD groups — nothing to re-target");

    // --- 4. attribute-driven groups + rules (best-effort) ------------------
    let rulesCreated = 0;
    try {
      const schema = await call("GET", "/api/v1/meta/schemas/user/default");
      const custom =
        (schema.json &&
          schema.json.definitions &&
          schema.json.definitions.custom &&
          schema.json.definitions.custom.properties) ||
        {};
      if (custom.tvOrgTerritoryID) {
        const territories = new Set();
        for (const id of userIds) {
          const u = await call("GET", `/api/v1/users/${id}`);
          const t = u.json && u.json.profile && u.json.profile.tvOrgTerritoryID;
          if (t) territories.add(t);
        }
        for (const t of territories) {
          const grp = await call("POST", "/api/v1/groups", {
            profile: {
              name: `Territory ${t}`,
              description: `Attribute-rule managed (tvOrgTerritoryID == ${t}) ${MIGRATED_MARKER}`,
            },
          });
          if (!grp.ok || !grp.json || !grp.json.id) continue;
          const rule = await call("POST", "/api/v1/groups/rules", {
            type: "group_rule",
            name: `${RULE_PREFIX}territory-${t}`.slice(0, 50),
            conditions: {
              expression: {
                value: `user.tvOrgTerritoryID == "${t}"`,
                type: "urn:okta:expression:1.0",
              },
            },
            actions: { assignUserToGroups: { groupIds: [grp.json.id] } },
          });
          if (rule.ok && rule.json && rule.json.id) {
            await call("POST", `/api/v1/groups/rules/${rule.json.id}/lifecycle/activate`);
            rulesCreated++;
            say(`rule: tvOrgTerritoryID == "${t}" -> group 'Territory ${t}' (the OU tree is now policy)`);
          }
        }
      } else {
        say("tvOrgTerritoryID not mapped to the user profile — skipping attribute rules");
      }
    } catch {
      say("attribute-rule step skipped (non-fatal)");
    }

    // --- 5. flip -----------------------------------------------------------
    if (adApp.status === "ACTIVE") {
      const deact = await call("POST", `/api/v1/apps/${adApp.id}/lifecycle/deactivate`);
      if (!deact.ok) {
        say(`FLIP FAILED — could not deactivate the AD integration (HTTP ${deact.status})`);
        return { status: "error", reason: `AD app deactivate failed (HTTP ${deact.status})` };
      }
      say("AD integration deactivated — profile sourcing falls through to Okta");
    } else {
      say("AD integration already inactive");
    }

    // --- 6. password continuity + verification -----------------------------
    let passwordsSet = 0;
    let oktaSourced = 0;
    for (const id of userIds) {
      if (demoPassword) {
        const set = await call("POST", `/api/v1/users/${id}`, {
          credentials: { password: { value: demoPassword } },
        });
        if (set.ok) passwordsSet++;
      }
      const check = await call("GET", `/api/v1/users/${id}`);
      const provider =
        check.json && check.json.credentials && check.json.credentials.provider;
      if (provider && provider.type === "OKTA") oktaSourced++;
    }
    if (demoPassword) {
      say(`password continuity: ${passwordsSet}/${userIds.length} users keep their password (Password Sync stand-in)`);
    }
    say(`verified: ${oktaSourced}/${userIds.length} users now Okta-sourced`);

    const summary = {
      users: userIds.length,
      groupsMirrored: mapping.size,
      membershipsCopied,
      appsRetargeted: retargeted,
      rulesCreated,
      passwordsSet,
      oktaSourced,
    };
    say(
      `complete — ${summary.groupsMirrored} groups mirrored, ${rulesCreated} attribute rule(s), ` +
        `${oktaSourced}/${summary.users} users Okta-sourced. AD is now load-bearing nothing.`
    );
    return { status: "migrated", summary };
  } catch (e) {
    const reason = String(e && e.message);
    say(`error — ${reason}`);
    return { status: "error", reason };
  }
}
