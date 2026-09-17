import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9223');
const page = b.contexts()[0].pages().find(p => p.url().includes('subagent-filter-demo'));
const r = {};
r.lists = await page.$$eval('[data-list]', ls => ls.map(l => l.dataset.list + ':' + l.querySelectorAll('.card').length));
r.countsA = await page.$$eval('[data-scheme="A"] [data-cnt]', es => es.map(e => e.dataset.cnt + '=' + e.textContent));
await page.click('[data-scheme="A"] [data-f="all"]');
r.afterAllCards = await page.$$eval('[data-list="A"] .card', c => c.length);
r.activeBtnA = (await page.textContent('[data-scheme="A"] .on')).trim();
await page.click('input[value="narrow"]');
r.narrowRunningCnt = await page.textContent('[data-scheme="A"] [data-cnt="running"]');
r.narrowA_cards = await page.$$eval('[data-list="A"] .card', c => c.length); // all=7 不受口径影响
await page.click('input[value="coarse"]');
await page.click('[data-scheme="A"] [data-f="running"]');
// D 下拉
await page.click('#dropTrigger');
r.dropOpen = await page.$eval('#dropD', el => el.classList.contains('open'));
await page.click('[data-scheme="D"] .filter-drop-menu [data-f="finished"]');
r.dropAfter = {
  label: await page.textContent('#dropLabel'),
  cards: await page.$$eval('[data-list="D"] .card', c => c.length),
  closed: await page.$eval('#dropD', el => !el.classList.contains('open')),
};
r.bCntDisplay = await page.$eval('.filter-text .cnt', el => getComputedStyle(el).display);
r.bUnderline = await page.$eval('.filter-text button.on', el => getComputedStyle(el, '::after').height);
console.log(JSON.stringify(r, null, 1));
