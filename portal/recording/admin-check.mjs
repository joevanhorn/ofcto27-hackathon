// Verify we can log into the spoke Okta admin console and reach the Groups +
// Identity Providers pages. Screenshots each stage. Saves auth state for reuse.
import { chromium } from "playwright";
import { oktaLogin } from "./okta-login.mjs";
const OUT = process.env.REC_DIR || "/tmp/rec";
const E = process.env;
const CONSOLE = E.SPOKE_ADMIN_CONSOLE.replace(/\/$/, "");
const done = /-admin\.oktapreview\.com\/admin/;
const shot = async (p, n) => { await p.screenshot({ path: `${OUT}/${n}.png`, fullPage: false }).catch(() => {}); console.log("shot", n, "|", p.url().slice(0, 80)); };

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
try {
  await page.goto(CONSOLE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "adm-01-landing");
  // If we hit the sign-in widget, log in.
  if (!done.test(page.url())) {
    await oktaLogin(page, { user: E.SPOKE_ADMIN_USER, pass: E.SPOKE_ADMIN_PASS, totpSecret: E.SPOKE_ADMIN_TOTP_SECRET, doneUrl: done });
  }
  await page.waitForTimeout(3000);
  await shot(page, "adm-02-dashboard");
  // Groups
  await page.goto(`${CONSOLE}/admin/groups`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot(page, "adm-03-groups");
  // Identity Providers
  await page.goto(`${CONSOLE}/admin/access/identity-providers`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot(page, "adm-04-idps");
  await ctx.storageState({ path: `${OUT}/admin-auth.json` });
  console.log("saved admin-auth.json");
} catch (e) { console.log("ERR:", e.message); await shot(page, "adm-99-err"); }
finally { await browser.close(); }
