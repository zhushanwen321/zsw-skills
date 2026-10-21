// A2 自动切换脚本：守候 drawer workflow trigger 出现 → 点开 → 选 GLM-5.3-Flash
import { chromium } from 'playwright';
const EP = 'http://localhost:9480';
const SHOT = process.env.HOME + '/Code/tai-ji-workspace/feat-workflow-change-model/.tmp/dev-flow/subagent-model-switch.acceptance/A2';
const browser = await chromium.connectOverCDP(EP);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

async function jsel(fn, arg) {
  try { return await page.evaluate(fn, arg); } catch (e) { return 'ERR:' + e.message.slice(0, 60); }
}

// 步骤1：守候 trigger（最多 8 分钟）
let clicked = false;
const t0 = Date.now();
while (Date.now() - t0 < 8 * 60 * 1000) {
  // 清模态
  const modal = await jsel(() => !!document.querySelector('[role=dialog][aria-label=设置]'));
  if (modal === true) { await page.keyboard.press('Escape'); log('cleared settings modal'); await page.waitForTimeout(300); }
  // 开 drawer
  const w = await jsel(() => document.querySelector('[data-testid=drawer-area]')?.getBoundingClientRect().width ?? -1);
  if (typeof w === 'number' && w < 50) {
    await jsel(() => { document.querySelector('[title="侧边抽屉"]')?.click(); return 1; });
    await page.waitForTimeout(400);
  }
  // 停在 workflow tab
  const onWf = await jsel(() => { const a = document.querySelector('[data-testid=drawer-area]'); return a ? !!Array.from(a.querySelectorAll('button[title]')).find(b => b.title === '工作流' && (b.getAttribute('aria-selected') !== 'false' || true)) && a.innerText.includes('工作流') : false; });
  if (onWf !== true) {
    await jsel(() => { const t = Array.from(document.querySelectorAll('[data-testid=drawer-area] button[title]')).find(b => b.title === '工作流'); t?.click(); return 1; });
    await page.waitForTimeout(300);
  }
  // trigger 在场？
  const trig = await jsel(() => { const t = document.querySelector('[data-testid=drawer-workflow-model-trigger]'); if (!t) return null; return t.innerText.replace(/\n/g, '|'); });
  if (trig) {
    log('TRIGGER UP:', trig);
    await jsel(() => { document.querySelector('[data-testid=drawer-workflow-model-trigger]').click(); return 1; });
    await page.waitForTimeout(600);
    // 点 GLM-5.3-Flash 候选
    const picked = await jsel(() => { const item = document.querySelector('[data-testid=model-picker-item-glm-5.3-flash]'); if (!item) return 'no-candidate:' + (document.querySelector('[data-testid=model-picker-list]')?.innerText.replace(/\n/g,'|').slice(0,150) ?? 'no-list'); item.click(); return 'picked'; });
    log('PICK:', picked);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: SHOT + '/switch-clicked.png' });
    clicked = true;
    break;
  }
  await page.waitForTimeout(700);
}
log(clicked ? 'SWITCH DONE' : 'TIMEOUT no trigger');
process.exit(clicked ? 0 : 2);
