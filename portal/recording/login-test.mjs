// Verify the full real Okta login (incl. TOTP) end-to-end, with stage screenshots.
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";
const OUT = process.env.REC_DIR || "/tmp/rec";
const USER = process.env.LOGIN_USER, PASS = process.env.LOGIN_PASS, SECRET = process.env.TOTP_SECRET;
const shot = async (page, n) => { await page.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {}); console.log("shot", n, "|", page.url().slice(0, 70)); };

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await shot(page, "01-portal");
  await page.getByRole("link", { name: /sign in with okta/i }).first().click({ timeout: 8000 })
    .catch(async () => { await page.getByText(/sign in with okta/i).first().click({ timeout: 8000 }); });
  await page.waitForURL(/oktapreview\.com/, { timeout: 20000 }).catch(() => {});
  await shot(page, "02-okta");
  await oktaLogin(page, { user: USER, pass: PASS, totpSecret: SECRET, onStage: (s) => shot(page, `stage-${s}`) });
  await page.waitForTimeout(1500);
  await shot(page, "09-signed-in");
  const sess = await page.evaluate(async () => (await fetch("/api/session")).json()).catch(() => null);
  console.log("SESSION:", JSON.stringify(sess));
} catch (e) {
  console.log("ERROR:", e.message);
  await shot(page, "99-error");
} finally { await browser.close(); }
