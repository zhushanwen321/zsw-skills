// M8 computed styles probe — 采集关键元素的计算样式供甄别
const { chromium } = require("playwright");
const EP = "http://localhost:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP(EP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("localhost:1420")) || ctx.pages()[0];
  const input = page.locator("[data-testid=composer-input],.composer-input").first();

  // 清空到干净态
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await sleep(200);

  const probe = async (label) => {
    const r = await page.evaluate(() => {
      const box = document.querySelector("[data-testid=composer-box]");
      const inp = document.querySelector(".composer-input");
      const cs = getComputedStyle(box);
      const ics = getComputedStyle(inp);
      // 发送位按钮
      const sendBtn = box.querySelector(".composer-bar > button:last-of-type, .composer-bar button.bg-accent, .composer-bar [class*=bg-accent]");
      const stopBtn = box.querySelector(".stop-btn");
      const sendCs = sendBtn ? getComputedStyle(sendBtn) : null;
      // chip
      const slashChip = inp.querySelector(".slash-chip");
      const mention = inp.querySelector(".mention-chip");
      const chipCs = slashChip ? getComputedStyle(slashChip) : (mention ? getComputedStyle(mention) : null);
      const chipCls = slashChip ? slashChip.className : (mention ? mention.className : null);
      return {
        boxShadow: cs.boxShadow, border: cs.borderColor, borderWidth: cs.borderWidth,
        boxClass: box.className, inputClass: inp.className,
        isFocused: ics.color,
        send: sendCs ? { bg: sendCs.backgroundColor, cls: sendBtn.className } : null,
        chip: chipCs ? { bg: chipCs.backgroundColor, color: chipCs.color, fontWeight: chipCs.fontWeight, cls: chipCls } : null,
      };
    });
    console.log(`\n[${label}]`, JSON.stringify(r, null, 2));
  };

  await probe("1-empty-unfocused");

  // 点击聚焦（空）
  await input.click();
  await sleep(300);
  await probe("2-empty-focused");

  // 输入文本（has-input + focused）
  await page.keyboard.type("hello world", { delay: 10 });
  await sleep(300);
  await probe("3-hasInput-focused");

  // blur（点 composer 外）
  await page.mouse.click(50, 50);
  await sleep(300);
  await probe("4-hasInput-blurred");

  // 输入 / + Enter 注入 slash chip
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/", { delay: 20 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(400);
  await probe("5-slash-chip-injected");

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
