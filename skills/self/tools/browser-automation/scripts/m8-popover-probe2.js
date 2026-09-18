const { chromium } = require("playwright");
const EP = "http://localhost:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const browser = await chromium.connectOverCDP(EP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("localhost:1420")) || ctx.pages()[0];
  const input = page.locator("[data-testid=composer-input],.composer-input").first();
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await sleep(200);
  await page.keyboard.type("/", { delay: 20 });
  await sleep(1200);

  const r = await page.evaluate(() => {
    const wrap = document.querySelector("[data-radix-popper-content-wrapper],[data-reka-popper-content-wrapper]");
    if (!wrap) return { found: false };
    const cs = getComputedStyle(wrap);
    const content = wrap.firstElementChild;
    const ccs = content ? getComputedStyle(content) : null;
    const box = document.querySelector("[data-testid=composer-box]");
    const wr = wrap.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    // all buttons anywhere in wrapper
    const btns = Array.from(wrap.querySelectorAll("button"));
    const first = btns[0];
    const fcs = first ? getComputedStyle(first) : null;
    return {
      found: true,
      wrapBg: cs.backgroundColor,
      contentBg: ccs?.backgroundColor,
      contentBorder: ccs?.borderColor,
      contentRadius: ccs?.borderRadius,
      contentBoxShadow: ccs?.boxShadow.slice(0, 50),
      contentCls: content?.className.slice(0, 100),
      gap: Math.round(br.y - (wr.y + wr.height)),
      width: Math.round(wr.width),
      boxWidth: Math.round(br.width),
      btnCount: btns.length,
      firstBg: fcs?.backgroundColor,
      firstColor: fcs?.color,
      firstText: first?.textContent?.trim().slice(0, 30),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await page.keyboard.press("Escape");
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
