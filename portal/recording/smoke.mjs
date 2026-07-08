// Pipeline smoke test: can we launch Chromium headless on this box, drive the
// portal, and capture video? Records ~5s of the sim portal, saves a webm.
import { chromium } from "playwright";

const OUT = process.env.REC_DIR || "/tmp/rec";
const URL = process.env.PORTAL_URL || "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// Best-effort: click a visible sign-in control if present (sim identity switcher).
for (const label of ["Sign in as Division Lead", "Division Lead"]) {
  const b = page.getByText(label, { exact: false }).first();
  if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/smoke.png` });
await context.close(); // flushes the video
const video = await page.video()?.path();
await browser.close();
console.log("VIDEO:", video);
console.log("SHOT :", `${OUT}/smoke.png`);
