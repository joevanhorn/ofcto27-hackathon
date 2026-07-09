// "Proof" clip: shows the REAL spoke Okta admin console (Groups + Identity
// Providers) empty, then the portal provisioning the spoke live (baseline +
// Org2Org IdP), then the SAME admin console with the group + IdP now present.
// Admin console is pre-authenticated via storageState so no admin login footage.
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";

const OUT = process.env.REC_DIR || "/tmp/rec";
const E = process.env;
const CONSOLE = E.SPOKE_ADMIN_CONSOLE.replace(/\/$/, "");
const GROUPS = `${CONSOLE}/admin/groups`;
const IDPS = `${CONSOLE}/admin/access/identity-providers`;

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: E.ADMIN_AUTH || `${process.env.HOME}/spoke-admin-auth.json`,
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();

async function caption(text) {
  // Self-healing: the Okta admin console (React) wipes injected nodes, so re-add
  // on an interval and keep the text in a window var that survives re-render.
  await page.evaluate((t) => {
    window.__capText = t;
    const CSS =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
      "background:linear-gradient(0deg,rgba(9,13,22,.97),rgba(9,13,22,.85));color:#fff;" +
      "font:600 19px/54px -apple-system,'Segoe UI',system-ui,Arial;text-align:center;" +
      "letter-spacing:.01em;border-top:2px solid #6366f1;box-shadow:0 -6px 22px rgba(0,0,0,.4)";
    function ensure() {
      let el = document.getElementById("__cap");
      if (!el) { el = document.createElement("div"); el.id = "__cap"; el.style.cssText = CSS; (document.body || document.documentElement).appendChild(el); }
      if (el.textContent !== window.__capText) el.textContent = window.__capText;
    }
    ensure();
    if (!window.__capTimer) window.__capTimer = setInterval(ensure, 350);
  }, text).catch(() => {});
}
const go = async (url, wait = 4000) => { await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {}); await page.waitForTimeout(wait); };

try {
  // ── BEFORE ──────────────────────────────────────────────────────────
  await go(GROUPS, 4200);
  await caption("BEFORE · the target Okta org — no baseline group yet");
  await page.waitForTimeout(3200);
  await go(IDPS, 4200);
  await caption("BEFORE · no federation to the hub yet");
  await page.waitForTimeout(3000);

  // ── PROVISION (portal) ──────────────────────────────────────────────
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await caption("The Division Lead provisions a governed spoke from the portal");
  await page.waitForTimeout(1800);
  await page.getByRole("link", { name: /sign in with okta/i }).first().click();
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await oktaLogin(page, { user: E.LOGIN_USER, pass: E.LOGIN_PASS, totpSecret: E.TOTP_SECRET });
  await page.waitForTimeout(1200);
  await page.locator("#org-name").fill("NA Sales Demo");
  await page.getByRole("button", { name: /preview plan/i }).click();
  await page.waitForTimeout(1500);
  await caption("Live terraform apply — baseline template + SAML Org2Org federation");
  await page.locator("#provision-btn").click();
  await page.locator("#result-card").waitFor({ state: "visible", timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // ── AFTER ───────────────────────────────────────────────────────────
  await go(GROUPS, 4500);
  await caption("AFTER · Baseline-Users group — created in Okta by the portal");
  await page.waitForTimeout(3600);
  await go(IDPS, 4500);
  await caption("AFTER · Hub SSO federation (SAML Org2Org) — applied automatically");
  await page.waitForTimeout(3600);
} catch (e) {
  console.log("ERR:", e.message);
} finally {
  await ctx.close();
  await browser.close();
  console.log("proof clip captured");
}
