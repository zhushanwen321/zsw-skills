import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0]

await page.getByTestId('composer-box').waitFor({ timeout: 5000 })
const input = page.getByRole('textbox')
await input.click()
await page.keyboard.press('Meta+A')
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)

await page.keyboard.type('#token', { delay: 50 })
await page.waitForTimeout(1500)

// 精确取：button > div.flex-1 > div(主行) + div(副行)
const result = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper], [data-reka-popper-content-wrapper], [role="dialog"]'))
  const last = all[all.length - 1]
  if (!last) return null
  const buttons = Array.from(last.querySelectorAll('button, [role="option"]'))
  return buttons.slice(0, 4).map((b) => {
    // 取 .flex-1 容器内的子 div
    const container = b.querySelector('div.flex-1, div.min-w-0')
    if (!container) return { main: '?', sub: '?' }
    const lines = container.querySelectorAll('div')
    return {
      main: lines[0]?.textContent?.trim() ?? '',
      sub: lines[1]?.textContent?.trim() ?? '',
    }
  })
}).catch(() => null)

console.log('#token 前 4 候选（精确 main/sub 分行）:')
result?.forEach((r, i) => {
  console.log(`  [${i}] 主行="${r.main}"  副行="${r.sub}"`)
})

await page.keyboard.press('Meta+A')
await page.keyboard.press('Backspace')
await browser.close()
