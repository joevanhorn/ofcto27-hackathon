// Reusable real Okta OIE login for Playwright, including the method chooser + software TOTP.
import crypto from "node:crypto";

function b32d(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  s = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, val = 0, out = [];
  for (const ch of s) { const i = A.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(sec, t = Date.now()) {
  const key = b32d(sec); let ctr = Math.floor(t / 1000 / 30);
  const buf = Buffer.alloc(8); for (let i = 7; i >= 0; i--) { buf[i] = ctr & 0xff; ctr = Math.floor(ctr / 256); }
  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const off = mac[mac.length - 1] & 0xf;
  const code = ((mac[off] & 0x7f) << 24) | ((mac[off + 1] & 0xff) << 16) | ((mac[off + 2] & 0xff) << 8) | (mac[off + 3] & 0xff);
  return String(code % 1e6).padStart(6, "0");
}

const CHOOSER = /select from the following|verify it.?s you with a security method/i;

async function onChooser(page) {
  return (await page.getByText(CHOOSER).first().count().catch(() => 0)) > 0;
}
// Click the "Select" control in the option row matching labelRe.
async function chooseMethod(page, labelRe) {
  const row = page.locator("div,li").filter({ hasText: labelRe }).filter({ has: page.getByText(/^\s*select\s*$/i) }).last();
  await row.waitFor({ timeout: 8000 });
  await row.getByText(/^\s*select\s*$/i).first().click();
  await page.waitForTimeout(800);
}
const clickVerify = (page) =>
  page.getByRole("button", { name: /verify|sign in|next/i }).first().click({ timeout: 8000 })
    .catch(async () => { await page.locator('input[type="submit"]').first().click().catch(() => {}); });

export async function oktaLogin(page, { user, pass, totpSecret, doneUrl = /localhost:3000/, onStage = () => {} }) {
  // 1) identifier
  const id = page.locator('input[name="identifier"], input[autocomplete="username"]').first();
  await id.waitFor({ timeout: 20000 });
  await id.fill(user);
  await onStage("username");
  const next = page.getByRole("button", { name: /^next$/i }).first();
  if (await next.count().catch(() => 0)) { await next.click(); await page.waitForTimeout(1200); }

  // 2) may land on a method chooser -> pick Password
  if (await onChooser(page)) { await chooseMethod(page, /password/i); }
  const pw = page.locator('input[type="password"]').first();
  await pw.waitFor({ timeout: 15000 });
  await pw.fill(pass);
  await onStage("password");
  await clickVerify(page);
  await page.waitForTimeout(1500);

  // 3) second factor (TOTP) — chooser (if shown), then the code field
  if (totpSecret) {
    await Promise.race([
      page.waitForURL(doneUrl, { timeout: 8000 }).catch(() => {}),
      page.getByText(/enter a code|enter code/i).first().waitFor({ timeout: 10000 }).catch(() => {}),
    ]);
    if (!doneUrl.test(page.url())) {
      if (await onChooser(page)) { await chooseMethod(page, /enter a code|okta verify/i); }
      const code = page.getByRole("textbox").first();
      await code.waitFor({ timeout: 10000 });
      await code.fill(totp(totpSecret));
      await onStage("totp");
      await clickVerify(page);
    }
  }
  await page.waitForURL(doneUrl, { timeout: 25000 }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}
