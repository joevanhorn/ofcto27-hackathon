// Produce a clean, captioned clip: real Okta login (incl. MFA) -> request ->
// live terraform apply -> governed spoke provisioned. Ends on the success state.
// (SSO finale is demoed live; not in this clip.)
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";

const OUT = process.env.REC_DIR || "/tmp/rec";
const E = process.env;

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:linear-gradient(0deg,rgba(9,13,22,.96),rgba(9,13,22,.82));" +
        "color:#fff;font:600 19px/52px system-ui,'Segoe UI',Arial;text-align:center;letter-spacing:.02em;" +
        "border-top:2px solid #6366f1;box-shadow:0 -6px 20px rgba(0,0,0,.35)";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text).catch(() => {});
}

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await caption(page, "Self-service Okta spoke provisioning — governed, and easier than shadow IT");
  await page.waitForTimeout(2200);

  // Beat 1 — real login (caption shows on the portal before we leave to Okta).
  await caption(page, "①  Real Okta sign-in — with phishing-resistant MFA");
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: /sign in with okta/i }).first().click();
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await oktaLogin(page, { user: E.LOGIN_USER, pass: E.LOGIN_PASS, totpSecret: E.TOTP_SECRET });
  await page.waitForTimeout(1500);
  await caption(page, "Signed in as a Division Lead — authorized by Okta group membership");
  await page.waitForTimeout(2200);

  // Beat 2 — request + deterministic knobs + plan.
  await caption(page, "②  Request a spoke — every option a closed choice, no misconfiguration");
  await page.locator("#org-name").fill("NA Sales Demo");
  await page.waitForTimeout(1400);
  await page.getByRole("button", { name: /preview plan/i }).click();
  await page.waitForTimeout(2200);

  // Beat 3 — live terraform apply.
  await caption(page, "③  Real terraform apply — provisioning a governed Okta org, live");
  await page.locator("#provision-btn").click();
  await page.locator("#result-card").waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await caption(page, "✓  Spoke provisioned & federated to the hub — governed, in seconds");
  // Show the My Orgs result.
  await page.locator("#orgs-card").scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(3500);
} catch (e) {
  console.log("ERR:", e.message);
} finally {
  await ctx.close();
  await browser.close();
  console.log("clip captured");
}
