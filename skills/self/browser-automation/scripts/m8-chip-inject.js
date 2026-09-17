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
  await page.keyboard.type("/", { delay: 20 });
  await sleep(800);
  await page.keyboard.press("Enter");
  await sleep(500);
  const r = await page.evaluate(() => {
    const inp = document.querySelector(".composer-input");
    const slash = inp?.querySelector(".slash-chip");
    const mention = inp?.querySelector(".mention-chip");
    const chip = slash || mention;
    if (!chip) return { found: false, text: inp?.textContent?.slice(0, 30) };
    const cs = getComputedStyle(chip);
    return {
      found: true,
      kind: slash ? "slash" : "mention",
      bg: cs.backgroundColor,
      color: cs.color,
      fontWeight: cs.fontWeight,
      cls: chip.className.slice(0, 50),
      text: chip.textContent?.trim().slice(0, 20),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
