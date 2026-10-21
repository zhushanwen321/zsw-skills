// A2 点块脚本：轮询对话流 workflow-block 并点击（设 drawer 选中态），最多 8 分钟
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9480');
const page = browser.contexts()[0].pages()[0];
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const t0 = Date.now();
while (Date.now() - t0 < 8 * 60 * 1000) {
  try {
    const r = await page.evaluate(() => {
      // 对话视图中的 workflow 工具块（当前会话需可见）
      const blocks = Array.from(document.querySelectorAll('[data-testid=workflow-block]'))
        .filter(e => e.getBoundingClientRect().width > 0);
      if (!blocks.length) return 'noblock';
      const last = blocks[blocks.length - 1];
      (last.querySelector('[data-testid=workflow-block-chips]') || last).click();
      return 'clicked:' + last.innerText.slice(0, 40).replace(/\n/g, '|');
    });
    if (r !== 'noblock') { log(r); await page.waitForTimeout(800);
      const st = await page.evaluate(() => {
        const t = document.querySelector('[data-testid=drawer-workflow-model-trigger]');
        return t ? 'TRIGGER_UP' : (document.querySelector('[data-testid=drawer-workflow-empty]') ? 'empty' : 'other');
      });
      log('drawer:', st);
      if (st === 'TRIGGER_UP') { log('SELECTION DONE'); break; }
    }
  } catch (e) { log('ERR', e.message.slice(0, 50)); }
  await page.waitForTimeout(900);
}
