#!/usr/bin/env node
// quota-wait —— 查询套餐额度并守到 5h 窗口恢复（或到点）后退出。
//
// 用法（由 quota-wait 技能以后台 bash 形态调用，也可手动执行）：
//   node quota-wait.mjs --agent <pi|zcode> --provider <名> [--until <时刻>] [选项]
//
// 退出条件只有两个：额度恢复（相对上一轮「变多」：pct 下降 / used 下降 / resetSec 上升）
// 或 --until 到点（缺省 6 小时兜底）。两种都是 exit 0，末行输出 JSON 摘要（含下一次
// 5h 窗口结束时刻）。额度够用不是退出条件——守望场景下调用时额度本来就是够的。
//
// 退出码：0 正常返回（recovered / deadline）；2 参数错误；3 首查失败；4 轮询连续失败；
// 5 该套餐无 5h 窗口数据。

import { loadFetcherSpecs, loadPresets } from './lib/spec.mjs'
import { runDeclarativeFetcher } from './lib/engine.mjs'
import { loadContext, resolveProvider, resolveCredential, resolveParamsForFetch } from './lib/resolve.mjs'
import { detectRecovery, snapshotOf } from './lib/recovery.mjs'

// ── 参数解析 ────────────────────────────────────────────────

const USAGE = `用法: quota-wait.mjs --agent <pi|zcode> --provider <名> [选项]

必填:
  --agent <pi|zcode>       当前 agent（决定 provider 名解析域与 zcode 兜底凭证是否参与）
  --provider <名>          pi 传 taiji provider id（如 zai-coding-cn）；
                           zcode 传 provider 名（如 account:bigmodel-individual-coding-plan、
                           kimi-for-coding），映射见 config/provider-map.json

可选:
  --until <时刻>           目标时刻：ISO 串 / HH:mm（今天已过取明天）/ +40s、+3h 相对延迟。
                           到点无论额度状态都返回（reason=deadline）。缺省 = 启动后 6 小时
  --interval-min <分钟>    轮询间隔，默认 15（接受小数用于短测）；临近预计恢复点自动对齐
  --buffer-sec <秒>        恢复点对齐缓冲，默认 60（防窗口边界竞争）
  --max-failures <次>      连续查询失败上限，默认 4（约一个间隔周期的 4 倍）
  --dry-run                只查一次打印结果，不进入轮询
  -h, --help               本帮助`

function parseArgs(argv) {
  const opts = { agent: undefined, provider: undefined, until: undefined, intervalMin: 15, bufferSec: 60, maxFailures: 4, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`缺少 ${a} 的值`)
      return v
    }
    if (a === '--agent') opts.agent = next()
    else if (a === '--provider') opts.provider = next()
    else if (a === '--until') opts.until = next()
    else if (a === '--interval-min') opts.intervalMin = Number(next())
    else if (a === '--buffer-sec') opts.bufferSec = Number(next())
    else if (a === '--max-failures') opts.maxFailures = Number(next())
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '-h' || a === '--help') opts.help = true
    else throw new UsageError(`未知参数：${a}`)
  }
  for (const key of ['intervalMin', 'bufferSec', 'maxFailures']) {
    if (!Number.isFinite(opts[key]) || opts[key] <= 0) throw new UsageError(`${key} 必须为正数`)
  }
  if (!opts.help) {
    if (opts.agent !== 'pi' && opts.agent !== 'zcode') throw new UsageError('--agent 必须为 pi 或 zcode')
    if (!opts.provider) throw new UsageError('缺少 --provider')
  }
  return opts
}

class UsageError extends Error {}

/** --until 解析：ISO / HH:mm[:ss]（今天已过取明天）/ +Ns +Nm +Nh +Nd。返回 epoch ms。 */
function parseUntil(raw, now = new Date()) {
  const rel = raw.match(/^\+(\d+)([smhd])$/)
  if (rel) {
    const n = Number(rel[1])
    const unitMs = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[rel[2]]
    return now.getTime() + n * unitMs
  }
  const clock = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (clock) {
    const [, hh, mm, ss] = clock
    const today = new Date(now)
    today.setHours(Number(hh), Number(mm), Number(ss ?? 0), 0)
    const target = today.getTime() > now.getTime() ? today : new Date(today.getTime() + 86_400_000)
    return target.getTime()
  }
  const t = Date.parse(raw)
  if (Number.isNaN(t)) throw new UsageError(`--until 无法解析：${raw}（支持 ISO 串 / HH:mm / +40s / +3h 形态）`)
  return t
}

// ── 时间与输出工具 ──────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function ts() {
  return new Date().toLocaleTimeString('sv-SE', { hour12: false })
}

function fmtLocal(epochMs) {
  const d = new Date(epochMs)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const fmtDur = (sec) => {
  if (sec === null || sec === undefined) return '--'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分${sec % 60}秒`
}

/** 失败 reason → 面向用户的恢复指引（对齐 taiji 失败语义）。 */
const REASON_HINTS = {
  unauthorized: '凭证无效或过期：去 taiji 设置页刷新该 provider 的 Cookie / 重存 API Key 后重试',
  network: '网络失败：检查网络与代理设置后重试（额度端点为国内站点，勿走全局代理）',
  'no-subscription': '该凭证名下无对应套餐订阅：确认 key 属于同一套餐账号',
  parse: '响应解析失败：查询规范可能与平台接口漂移，需同步技能 specs/ 下的规范副本',
  not_configured: '缺少查询参数（如 workspace 地址）：去 taiji 设置页补全该 provider 的额度配置',
  'no-credential': '无凭证：去 taiji 设置页配置该 provider 的额度查询凭证',
  'credential-unavailable': '凭证文件读取失败：检查 taiji secrets 目录文件状态',
  'credential-unsupported': '凭证形态不支持（command / 未定义环境变量引用）：修正 taiji 侧凭据配置',
  'cookie-invalid-format': 'Cookie 格式无效（无 name=value 对）：在 taiji 设置页重新粘贴整串 Cookie',
}

// ── 主流程 ──────────────────────────────────────────────────

/** 最近一次成功查询的数据与时刻（模块级：query 闭包写、printSummary 读）。 */
let lastGood = null
let lastGoodAt = null

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  if (typeof fetch !== 'function') {
    throw new Error('当前 node 无原生 fetch，需要 node ≥ 18')
  }
  const deadline = opts.until !== undefined ? parseUntil(opts.until) : Date.now() + 6 * 3600_000
  const intervalMs = opts.intervalMin * 60_000
  const bufferMs = opts.bufferSec * 1000

  // 解析链：上下文 → 规范/预设 → provider → 凭证
  const ctx = loadContext()
  const { fetchers, source: specSource } = loadFetcherSpecs(ctx.taijiDataDir)
  const presets = loadPresets(ctx.taijiDataDir)
  const resolved = resolveProvider(opts.agent, opts.provider, ctx, presets)
  const fetcherSpec = fetchers[resolved.fetcherId]
  if (fetcherSpec === undefined) {
    throw new Error(`fetcher "${resolved.fetcherId}" 不在查询规范表（规范来源：${specSource}）。恢复指引：同步技能 specs/quota-fetchers.json`)
  }
  const credential = resolveCredential(opts.agent, opts.provider, resolved, fetcherSpec, ctx)
  if (credential.error) {
    console.error(`[quota-wait] ${credential.error}`)
    process.exitCode = 3
    return
  }
  const quotaParams = resolveParamsForFetch(ctx, resolved.taijiProviderId)
  console.log(`[${ts()}] 解析：${opts.provider} -> taiji/${resolved.taijiProviderId} fetcher=${resolved.fetcherId} 凭证=${credential.source} 规范=${specSource}`)

  let failures = 0
  let rounds = 0

  const query = async () => {
    const outcome = await runDeclarativeFetcher(fetcherSpec, credential.credential, { quotaParams })
    if (outcome.ok) {
      lastGood = outcome.data
      lastGoodAt = Date.now()
      return outcome.data
    }
    throw new Error(`查询失败（${outcome.reason}）：${REASON_HINTS[outcome.reason] ?? '未知原因'}`)
  }

  const fiveHour = () => snapshotOf(lastGood.wins)
  const nextResetEpoch = () => (fiveHour().resetSec !== null ? lastGoodAt + fiveHour().resetSec * 1000 : null)

  // 首查
  let first
  try {
    first = await query()
  } catch (err) {
    console.error(`[${ts()}] ${err.message}`)
    process.exitCode = 3
    return
  }
  const s0 = snapshotOf(first.wins)
  if (s0.resetSec === null && s0.pct === null) {
    console.error(`[${ts()}] 该套餐无 5h 窗口数据（fetcher=${resolved.fetcherId}，如 stepfun TOKEN 家族只有月度额度）。恢复指引：确认套餐类型，或换 --provider`)
    process.exitCode = 5
    return
  }
  const firstReset = nextResetEpoch()
  console.log(
    `[${ts()}] 首查：5h 已用 ${s0.pct ?? '--'}%（used=${s0.used ?? '--'}），距窗口结束 ${fmtDur(s0.resetSec)}` +
    `${firstReset !== null ? `（约 ${fmtLocal(firstReset)}）` : ''}；周 ${first.wins[1].pct ?? '--'}% / 月 ${first.wins[2].pct ?? '--'}%`,
  )

  if (opts.dryRun) {
    printSummary('dry-run', s0, firstReset, rounds)
    return
  }

  // 轮询
  let baseline = s0
  for (;;) {
    if (Date.now() >= deadline) {
      printSummary('deadline', fiveHour(), nextResetEpoch(), rounds)
      return
    }
    // 唤醒时刻：常规间隔、deadline、预计恢复点 + 缓冲，三者取最近
    const resetAt = nextResetEpoch()
    const wakeAt = Math.min(
      Date.now() + intervalMs,
      deadline,
      resetAt !== null ? resetAt + bufferMs : Number.POSITIVE_INFINITY,
    )
    await sleep(wakeAt - Date.now())
    if (Date.now() >= deadline) {
      printSummary('deadline', fiveHour(), nextResetEpoch(), rounds)
      return
    }
    rounds++
    try {
      const data = await query()
      const cur = snapshotOf(data.wins)
      const signal = detectRecovery(baseline, cur)
      baseline = cur
      failures = 0
      if (signal !== null) {
        console.log(`[${ts()}] 额度恢复（信号：${signal}）：5h 已用 ${cur.pct ?? '--'}%，新窗口距结束 ${fmtDur(cur.resetSec)}`)
        printSummary('recovered', cur, nextResetEpoch(), rounds)
        return
      }
      console.log(`[${ts()}] 第 ${rounds} 轮：5h 已用 ${cur.pct ?? '--'}%（used=${cur.used ?? '--'}），距窗口结束 ${fmtDur(cur.resetSec)}——继续等待`)
    } catch (err) {
      failures++
      console.error(`[${ts()}] 第 ${rounds} 轮 ${err.message}（连续失败 ${failures}/${opts.maxFailures}）`)
      if (failures >= opts.maxFailures) {
        console.error(`[${ts()}] 连续 ${opts.maxFailures} 轮查询失败，放弃等待。最后一次成功：5h 已用 ${fiveHour().pct ?? '--'}%，距窗口结束 ${fmtDur(fiveHour().resetSec)}`)
        process.exitCode = 4
        return
      }
    }
  }
}

function printSummary(reason, fiveHour, resetEpoch, rounds) {
  const summary = {
    reason,
    nextFiveHourReset: resetEpoch !== null ? new Date(resetEpoch).toISOString() : null,
    nextFiveHourResetLocal: resetEpoch !== null ? fmtLocal(resetEpoch) : null,
    fiveHour,
    windows: lastGood?.wins ?? null,
    label: lastGood?.label ?? null,
    polledRounds: rounds,
  }
  console.log(JSON.stringify(summary))
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  console.error(`[quota-wait] ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 3
})
