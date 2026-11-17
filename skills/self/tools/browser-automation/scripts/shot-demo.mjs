import { chromium } from 'playwright';
const b = await chromium.launch({
  executablePath: '/Users/zhushanwen/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
});
const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file:///Users/zhushanwen/Code/tai-ji-yang-workspace/docs/provider-migration-demo.html');
await p.waitForTimeout(300);
// clip screenshot of the panel region
const stage = p.locator('.stage');
await stage.scrollIntoViewIfNeeded();
await p.waitForTimeout(200);
await stage.screenshot({ path: '/tmp/demo-stage.png' });
// light mode
await p.click('[data-mode-btn="light"]');
await p.waitForTimeout(200);
await stage.screenshot({ path: '/tmp/demo-stage-light.png' });
// routes page
await p.click('[data-page="routes"]');
await p.waitForTimeout(200);
await stage.screenshot({ path: '/tmp/demo-routes.png' });
await b.close();
console.log('ok');
