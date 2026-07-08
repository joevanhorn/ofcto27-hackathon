// Full programmatic recording of the real portal flow.
// Beat 1: real Okta login (dana, incl. TOTP). Beat 2: request -> live terraform
// stream. Beat 3: hub->spoke SSO. Then the block beat (non-member -> 403).
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";

const OUT = process.env.REC_DIR || "/tmp/rec";
const E = process.env;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

// ─────────────────────────── Happy path ───────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: `${OUT}/happy`, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  log("goto portal");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  log("beat 1: sign in with Okta");
  await page.getByRole("link", { name: /sign in with okta/i }).first().click();
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await oktaLogin(page, { user: E.LOGIN_USER, pass: E.LOGIN_PASS, totpSecret: E.TOTP_SECRET });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/h1-signed-in.png` });

  log("beat 2: request a spoke");
  await page.locator("#org-name").fill("NA Sales Demo");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /preview plan/i }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/h2-plan.png` });
  await page.locator("#provision-btn").click();
  log("provisioning… (real terraform 3-pass federation, a few minutes)");
  // Wait for the definitive success signal: the result card becomes visible.
  await page.locator("#result-card").waitFor({ state: "visible", timeout: 480000 })
    .catch(() => log("WARN: result card not visible in time"));
  log("provision complete");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/h3-provisioned.png` });

  log("beat 3: SSO into the spoke");
  const open = page.getByRole("button", { name: /open \(sso\)|open sso/i }).first();
  if (await open.count().catch(() => 0)) {
    await open.click();
    await page.waitForTimeout(6000); // let the SAML round-trip + spoke dashboard render
  } else {
    log("WARN: Open (SSO) button not found");
  }
  await page.screenshot({ path: `${OUT}/h4-sso.png` });
  log("final url:", page.url());
  await ctx.close();
  log("happy path video saved");
}

// ─────────────────────────── Block beat ───────────────────────────
if (E.NONMEMBER_USER) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: `${OUT}/block`, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  log("block beat: sign in as non-member");
  await page.getByRole("link", { name: /sign in with okta/i }).first().click();
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await oktaLogin(page, { user: E.NONMEMBER_USER, pass: E.NONMEMBER_PASS, totpSecret: E.NONMEMBER_TOTP });
  await page.waitForTimeout(2000);
  await page.locator("#org-name").fill("Rogue Org").catch(() => {});
  await page.getByRole("button", { name: /preview plan/i }).click().catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("#provision-btn").click().catch(() => {});
  await page.getByText(/blocked by the governance guardrail|not authorized/i).first()
    .waitFor({ timeout: 15000 }).catch(() => log("WARN: guardrail banner not seen"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/b1-blocked.png` });
  await ctx.close();
  log("block beat video saved");
}

await browser.close();
log("done");
