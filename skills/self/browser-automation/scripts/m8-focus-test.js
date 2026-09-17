const { chromium } = require("playwright");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("localhost:1420"));
  const input = page.locator(".composer-input").first();
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await sleep(200);
  await page.mouse.click(10, 10);
  await sleep(300);
  let r0 = await page.evaluate(() => {
    const b = document.querySelector("[data-testid=composer-box]");
    return { cls: b.className, shadow: getComputedStyle(b).boxShadow.slice(0,40), border: getComputedStyle(b).borderColor };
  });
  console.log("[blurred]", JSON.stringify(r0));
  await input.click();
  await sleep(500);
  let r1 = await page.evaluate(() => {
    const b = document.querySelector("[data-testid=composer-box]");
    return { cls: b.className, shadow: getComputedStyle(b).boxShadow.slice(0,40), border: getComputedStyle(b).borderColor, active: document.activeElement?.className?.slice(0,40) };
  });
  console.log("[focused]", JSON.stringify(r1));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
