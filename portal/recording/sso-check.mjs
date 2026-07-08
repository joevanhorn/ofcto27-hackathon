// Isolated check: login as dana, then hit the pre-staged hub launch link and
// see where we land (should be the spoke dashboard after JIT).
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";
const OUT = process.env.REC_DIR || "/tmp/rec";
const E = process.env;
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /sign in with okta/i }).first().click();
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await oktaLogin(page, { user: E.LOGIN_USER, pass: E.LOGIN_PASS, totpSecret: E.TOTP_SECRET });
  console.log("logged in, url:", page.url());
  await page.goto(E.SSO_URL, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/sso-final.png` });
  console.log("SSO landing url:", page.url());
} catch (e) { console.log("ERR:", e.message); await page.screenshot({ path: `${OUT}/sso-err.png` }).catch(() => {}); }
finally { await browser.close(); }
