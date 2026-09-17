// M8 popover + send computed probe
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
  await sleep(900);

  const r = await page.evaluate(() => {
    const picks = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderColor, radius: cs.borderRadius, boxShadow: cs.boxShadow.slice(0,60), cls: el.className.slice(0,120), text: el.textContent?.trim().slice(0,30) };
    };
    // popover content
    const pop = document.querySelector("[data-radix-popper-content-wrapper] [role=listbox], [data-reka-popper-content-wrapper], .reka-popover-content");
    const popWrap = document.querySelector("[data-radix-popper-content-wrapper], [data-reka-popper-content-wrapper]");
    // first item (active)
    const items = Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper] button, .reka-popover-content button, [role=listbox] button"));
    const firstItem = items[0];
    const firstCs = firstItem ? getComputedStyle(firstItem) : null;
    // popWrap rect (for gap measurement)
    const wrapRect = popWrap?.getBoundingClientRect();
    const boxRect = document.querySelector("[data-testid=composer-box]")?.getBoundingClientRect();
    return {
      pop: picks(".reka-popover-content") || picks("[data-radix-popper-content-wrapper] > *"),
      popWrap: popWrap ? { bg: getComputedStyle(popWrap).backgroundColor } : null,
      gap: wrapRect && boxRect ? Math.round(boxRect.y - (wrapRect.y + wrapRect.height)) : null,
      firstItem: firstCs ? { bg: firstCs.backgroundColor, color: firstCs.color, cls: firstItem.className.slice(0,100), text: firstItem.textContent?.trim().slice(0,25) } : null,
      itemCount: items.length,
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await page.keyboard.press("Escape");
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
