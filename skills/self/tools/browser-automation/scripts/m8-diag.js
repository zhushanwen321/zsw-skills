const { chromium } = require("playwright");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("localhost:1420"));
  const input = page.locator(".composer-input").first();
  await input.click(); await sleep(300);
  await page.mouse.click(10,10); await sleep(300); // blur
  const f1 = await page.evaluate(() => ({ inputFocus: window.__m8inputFocus, boxFocus: window.__m8boxFocus, m8mounted: document.querySelector('[data-testid=composer-box]')?.getAttribute('data-m8-mounted') }));
  console.log("[after blur]", JSON.stringify(f1));
  await input.click(); await sleep(400); // focus
  const f2 = await page.evaluate(() => { const b = document.querySelector('[data-testid=composer-box]'); return { inputFocus: window.__m8inputFocus, boxFocus: window.__m8boxFocus, cls: b.className.slice(0,90), shadow: getComputedStyle(b).boxShadow.slice(0,40) }; });
  console.log("[after focus]", JSON.stringify(f2));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
