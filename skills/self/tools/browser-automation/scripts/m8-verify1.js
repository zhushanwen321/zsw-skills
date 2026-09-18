const { chromium } = require("playwright");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("localhost:1420"));
  const input = page.locator("[data-testid=composer-input],.composer-input").first();
  // 空聚焦
  await input.click(); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("Backspace");
  await input.click(); await sleep(400);
  const focusR = await page.evaluate(() => {
    const box = document.querySelector("[data-testid=composer-box]");
    const cs = getComputedStyle(box);
    return { boxShadow: cs.boxShadow, border: cs.borderColor, cls: box.className };
  });
  console.log("[focus empty]", JSON.stringify(focusR));
  // 注入 slash chip
  await page.keyboard.type("/", { delay: 20 }); await sleep(600);
  await page.keyboard.press("Enter"); await sleep(400);
  const chipR = await page.evaluate(() => {
    const inp = document.querySelector(".composer-input");
    const chip = inp.querySelector(".slash-chip");
    if (!chip) return { found: false };
    const cs = getComputedStyle(chip);
    return { bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight };
  });
  console.log("[slash chip]", JSON.stringify(chipR));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
