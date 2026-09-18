// M8 Composer 状态截图捕获脚本 — 连 CDP 9222，对每个状态截取 composer 区域
const { chromium } = require("playwright");
const EP = "http://localhost:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP(EP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("localhost:1420")) || ctx.pages()[0];

  // helper: 截取 composer-box（+ popover 若存在）的并集区域，加 padding
  async function clipComposer(tag, extraTop = 0) {
    const info = await page.evaluate(() => {
      const box = document.querySelector("[data-testid=composer-box]");
      const pop = document.querySelector("[data-radix-popper-content-wrapper],[role=listbox]")
        || document.querySelector(".reka-popover-content")
        || Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"))[0];
      const dpr = window.devicePixelRatio || 1;
      const br = box?.getBoundingClientRect();
      // 找所有可能的 popover 浮层（portal body）
      const pops = Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper],.reka-popover-content,[data-reka-popper-content-wrapper]"))
        .map((p) => p.getBoundingClientRect())
        .filter((r) => r.width > 0);
      return { dpr, br: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null, pops };
    });
    const br = info.br;
    let top = br.y, bottom = br.y + br.h, left = br.x, right = br.x + br.w;
    // 合并 popover 区域
    for (const p of info.pops) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y + p.height);
      left = Math.min(left, p.x);
      right = Math.max(right, p.x + p.width);
    }
    const padTop = 40 + extraTop, padBottom = 24, padX = 16;
    const clip = {
      x: Math.max(0, left - padX),
      y: Math.max(0, top - padTop),
      width: right - left + padX * 2,
      height: bottom - top + padTop + padBottom,
    };
    await page.screenshot({ path: `/tmp/e2e-M8-${tag}.png`, clip });
    console.log(`captured /tmp/e2e-M8-${tag}.png clip=`, JSON.stringify(clip), "pops=", info.pops.length);
  }

  const input = page.locator("[data-testid=composer-input],.composer-input").first();

  // ── 1. landing-meta：当前态（meta chips 已渲染）──
  await sleep(300);
  await clipComposer("landing-meta");

  // ── 2. input：输入文本 ──
  await input.click();
  await sleep(200);
  await page.keyboard.type("重构 PanelHeader 的视觉层，去掉 border-b", { delay: 15 });
  await sleep(300);
  await clipComposer("input");

  // ── 3. command-popover：清空再输入 / 触发浮层 ──
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await sleep(200);
  await page.keyboard.type("/", { delay: 30 });
  await sleep(800); // 等命令浮层
  await clipComposer("command-popover", 20);
  // 关掉浮层
  await page.keyboard.press("Escape");
  await sleep(200);

  // ── 4. focus：清空，聚焦（不输入）──
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await sleep(200);
  // 点一下输入区确保聚焦
  await input.click();
  await sleep(400);
  await clipComposer("focus");

  // ── 5. inline-chip：输入 / 触发浮层 → Enter 选中首项插入 slash chip ──
  await input.click();
  await page.keyboard.type("/", { delay: 30 });
  await sleep(700);
  await page.keyboard.press("Enter");
  await sleep(400);
  await clipComposer("inline-chip");

  await browser.close();
  console.log("DONE");
}
main().catch((e) => { console.error(e); process.exit(1); });
