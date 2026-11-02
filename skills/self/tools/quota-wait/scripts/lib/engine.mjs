// 声明式额度查询引擎 —— 自 taiji 仓移植的 vendored 副本。
//
// 源：taiji main e86cda257（2026-11-01）
//   packages/runtime/src/services/quota-providers/{declarative-engine,declarative-fetch,header-froms,types}.ts
//   packages/shared/src/quota-types.ts（normalizeCookieHeader / extractQuotaWorkspaceId）
//   packages/shared/src/quota-presets.ts 不在本文件（presets 数据在 specs/quota-presets.json，
//   matchQuotaPreset 在 spec.mjs）。
//
// 与源实现的差异（本 CLI 只读额度，不做 cookie 滑动续期回写）：
//   1. 不捕获/不返回响应 Set-Cookie（taiji 用它做 cookie 回写，CLI 只读）；
//   2. 无 logger 依赖（纯函数模块，失败全部以 reason 返回值表达）；
//   3. 类型注解剥除，逻辑逐函数对齐。
//
// 同步纪律：taiji 侧引擎或 baseline-fetchers.json 演进后需重新 vendor 本文件与
// specs/ 下两份数据（比对源 commit 标记与 taiji HEAD）。

// ── 常量与基础谓词（源 types.ts）──────────────────────────────

/** 无限窗口（未订阅/不支持）：pct 与 resetSec 均无数据。 */
const INFINITE_WIN = Object.freeze({ pct: null, resetSec: null })

const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_REDIRECT_MIN = 300
const HTTP_REDIRECT_MAX = 400

/** HTTP 状态 → 失败 reason（401/403 与 redirect:'manual' 下的 3xx 均为凭证失效）。 */
export function statusToReason(status) {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'unauthorized'
  if (status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX) return 'unauthorized'
  return 'network'
}

const FAIL_REASONS = ['unauthorized', 'network', 'no-subscription', 'parse', 'not_configured', 'no-credential', 'credential-unavailable', 'credential-unsupported', 'cookie-invalid-format']

export function isFailReason(v) {
  return typeof v === 'string' && FAIL_REASONS.includes(v)
}

export function isRecord(v) {
  return typeof v === 'object' && v !== null
}

const MS_PER_SEC = 1000

/** ISO 时间戳 → 距今剩余秒（已过期 → 0）。 */
export function isoResetRemaining(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.floor(ms / MS_PER_SEC))
}

/** 数值取值归一：number 或数值串 → 有限 number；其余 → undefined（kimi 的量以字符串数值下发，bigmodel 以 number 下发）。 */
export function numericField(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

// ── cookie 归一与 workspace 反提取（源 shared/quota-types.ts）──────────

/** 归一用户粘贴 cookie 的空白伪影并剥掉可选的 `Cookie:` 头名；归一后为空返回空串。 */
export function normalizeCookieHeader(raw) {
  return raw
    .replace(/^\s*cookie\s*:/i, '')
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return ''
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return name ? `${name}=${value}` : ''
    })
    .filter((pair) => pair !== '')
    .join('; ')
}

const WORKSPACE_ID_RE = /^wrk_[A-Za-z0-9]+$/

/** 从已配置的 workspace 地址提取 workspace id（裸 wrk_ id 或路径内匹配）；提取不到返回 null。 */
export function extractQuotaWorkspaceId(workspaceUrl) {
  const trimmed = workspaceUrl.trim()
  if (WORKSPACE_ID_RE.test(trimmed)) return trimmed
  return trimmed.match(/wrk_[A-Za-z0-9]+/)?.[0] ?? null
}

// ── 动态请求头 headerFroms（源 header-froms.ts）──────────────

const HEADER_FROM_SOURCES = ['params', 'cookie']

export function isHeaderFromValid(h) {
  if (!isRecord(h)) return false
  if (typeof h['from'] !== 'string' || !HEADER_FROM_SOURCES.includes(h['from'])) return false
  if (typeof h['key'] !== 'string' || h['key'] === '') return false
  if (typeof h['header'] !== 'string' || h['header'] === '') return false
  if (h['extractor'] !== undefined && h['extractor'] !== 'quotaWorkspaceId') return false
  if (h['failReason'] !== undefined && !isFailReason(h['failReason'])) return false
  return h['from'] === 'cookie' || h['failReason'] !== undefined
}

export function isHeaderFromsValid(v) {
  return v === undefined || (Array.isArray(v) && v.every(isHeaderFromValid))
}

/** 从归一化 cookie 串取指定字段值（缺失/空值 = undefined）。 */
export function extractCookieField(cookie, field) {
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim().toLowerCase() === field.toLowerCase()) {
      const value = pair.slice(eq + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** 动态请求头解析：params 源缺失/反提取失败 → failReason（整体失败）；cookie 源缺失 → 不置该头。 */
export function resolveHeaderFroms(headerFroms, credential, quotaParams) {
  const headers = {}
  for (const hf of headerFroms) {
    if (hf.from === 'params') {
      const raw = quotaParams?.[hf.key]
      if (raw === undefined || raw === '') {
        if (hf.failReason !== undefined) return { failure: hf.failReason }
        continue
      }
      const value = hf.extractor === 'quotaWorkspaceId' ? extractQuotaWorkspaceId(raw) : raw
      if (value === null) {
        if (hf.failReason !== undefined) return { failure: hf.failReason }
        continue
      }
      headers[hf.header] = value
    } else {
      const value = extractCookieField(credential, hf.key)
      if (value !== undefined) headers[hf.header] = value
    }
  }
  return { headers }
}

// ── 配置 guard（源 declarative-engine.ts，远程覆盖配置的形状防线）──────

const CREDENTIAL_MODES = ['bearer', 'raw', 'cookie']
const SLOTS = ['fiveHour', 'week', 'month']
const RESET_MODES = ['iso', 'epochMs', 'relativeLabel', 'zonelessUtcWallClock', 'epochMsElseRelativeLabel', 'relativeMs', 'epochSecOrMs']
const PCT_VIAS = ['direct', 'percent01to100', 'usedOverLimit', 'remainingToUsed', 'fractionRemainingToUsed']
const REQUEST_METHODS = ['GET', 'POST']

function isPathValid(v) {
  if (typeof v === 'string') return v !== ''
  return Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && p !== '')
}

function isGateValid(g) {
  if (!isRecord(g) || typeof g['path'] !== 'string' || g['path'] === '') return false
  return g['missing'] === 'query-fail' || g['missing'] === 'infinite-win'
}

function isGateValueValid(g) {
  if (!isRecord(g) || !isPathValid(g['path'])) return false
  return typeof g['equals'] === 'number' || typeof g['notEquals'] === 'number'
}

function isPctValid(p) {
  if (!isRecord(p)) return false
  const pathRequired = p['via'] !== 'usedOverLimit'
  if (typeof p['via'] !== 'string' || !PCT_VIAS.includes(p['via'])) return false
  return !pathRequired || isPathValid(p['path'])
}

function isResetSecValid(r) {
  if (!isRecord(r) || !isPathValid(r['path'])) return false
  if (typeof r['mode'] !== 'string' || !RESET_MODES.includes(r['mode'])) return false
  return r['fromRequest'] === undefined || typeof r['fromRequest'] === 'string'
}

function isUsedLimitValid(u) {
  if (!isRecord(u) || !isPathValid(u['limit'])) return false
  if (u['used'] !== undefined && !isPathValid(u['used'])) return false
  if (u['remaining'] !== undefined && !isPathValid(u['remaining'])) return false
  const hasUsed = u['used'] !== undefined
  const hasRemaining = u['remaining'] !== undefined
  if (!(hasUsed || hasRemaining)) return false
  return u['unit'] === undefined || typeof u['unit'] === 'string'
}

function isWindowBaseFieldsValid(w) {
  if (typeof w['slot'] !== 'string' || !SLOTS.includes(w['slot'])) return false
  if (w['fromRequest'] !== undefined && typeof w['fromRequest'] !== 'string') return false
  return true
}

function isWindowValid(w) {
  if (!isRecord(w)) return false
  if (!isWindowBaseFieldsValid(w)) return false
  return (
    (w['gate'] === undefined || isGateValid(w['gate'])) &&
    (w['gateValue'] === undefined || isGateValueValid(w['gateValue'])) &&
    (w['pct'] === undefined || isPctValid(w['pct'])) &&
    (w['resetSec'] === undefined || isResetSecValid(w['resetSec'])) &&
    (w['usedLimit'] === undefined || isUsedLimitValid(w['usedLimit']))
  )
}

function isRequestEntryValid(r) {
  if (!isRecord(r) || typeof r['name'] !== 'string' || r['name'] === '' || typeof r['url'] !== 'string' || r['url'] === '') return false
  if (r['role'] !== undefined && r['role'] !== 'primary' && r['role'] !== 'auxiliary') return false
  if (r['method'] !== undefined && !REQUEST_METHODS.includes(r['method'])) return false
  return r['body'] === undefined || typeof r['body'] === 'string'
}

function isStatusMapValid(m) {
  return isRecord(m) && Object.values(m).every(isFailReason)
}

function isBodyCodeSuccessElementValid(s) {
  return typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean'
}

function isBodyCodeSuccessValid(success) {
  if (Array.isArray(success)) return success.length > 0 && success.every(isBodyCodeSuccessElementValid)
  return isBodyCodeSuccessElementValid(success)
}

function isBodyCodeValid(b) {
  if (!isRecord(b) || !isPathValid(b['path'])) return false
  if (!isBodyCodeSuccessValid(b['success'])) return false
  if (b['map'] !== undefined && !isRecord(b['map'])) return false
  if (b['else'] !== undefined && !isFailReason(b['else'])) return false
  if (b['missing'] !== undefined && b['missing'] !== 'else' && b['missing'] !== 'parse') return false
  return b['successRequires'] === undefined || isPathValid(b['successRequires'])
}

/** 声明式配置形状 guard（拒绝 = 拒用该配置整体）。 */
export function isDeclarativeFetcherConfig(v) {
  if (!isRecord(v)) return false
  if (typeof v['label'] !== 'string' || v['label'] === '') return false
  if (!Array.isArray(v['auth']) || !v['auth'].every((a) => typeof a === 'string')) return false
  if (typeof v['credential'] !== 'string' || !CREDENTIAL_MODES.includes(v['credential'])) return false
  if (v['strictNumbers'] !== undefined && typeof v['strictNumbers'] !== 'boolean') return false
  if (v['extraHeaders'] !== undefined && !isRecord(v['extraHeaders'])) return false
  if (v['headerFroms'] !== undefined && !isHeaderFromsValid(v['headerFroms'])) return false
  if (v['statusMap'] !== undefined && !isStatusMapValid(v['statusMap'])) return false
  if (v['bodyCode'] !== undefined && !isBodyCodeValid(v['bodyCode'])) return false
  if (v['requires'] !== undefined && !Array.isArray(v['requires'])) return false
  if (!Array.isArray(v['requests']) || v['requests'].length === 0 || !v['requests'].every(isRequestEntryValid)) return false
  return Array.isArray(v['windows']) && v['windows'].length > 0 && v['windows'].every(isWindowValid)
}

// ── 字段路径原语（源 declarative-engine.ts）──────────────────

/** 归一失败信号：字段存在但形态漂移 → 上抛归 parse，不静默降级。 */
class WireDriftError extends Error {}

function pickBracketIndexed(cur, idx, path, key) {
  if (!Array.isArray(cur)) {
    if (cur === undefined || cur === null) return undefined
    throw new WireDriftError(`array expected at '${key}${idx[0]}' in '${path}'`)
  }
  return cur[Number(idx[1])]
}

function isConditionalMissByDrift(cur, field, configValue) {
  const numericConfig = /^\d+$/.test(configValue)
  return cur.some((e) => {
    if (!isRecord(e)) return true
    const v = e[field]
    if (typeof v === 'string') return false
    if (typeof v === 'number') return !numericConfig
    return true
  })
}

function conditionMatches(entryValue, configValue) {
  if (typeof entryValue === 'number') return /^\d+$/.test(configValue) && String(entryValue) === configValue
  return entryValue === configValue
}

function pickBracketConditional(cur, cond, path, key) {
  if (!Array.isArray(cur)) {
    if (cur === undefined || cur === null) return undefined
    throw new WireDriftError(`array expected at '${key}${cond[0]}' in '${path}'`)
  }
  const [, field, value] = cond
  const hit = cur.find((e) => isRecord(e) && conditionMatches(e[field], value))
  if (!hit && cur.length > 0 && isConditionalMissByDrift(cur, field, value)) {
    throw new WireDriftError(`condition field type drift at '${key}${cond[0]}' in '${path}'`)
  }
  return hit
}

function pickSegment(cur, seg, path) {
  if (cur === undefined || cur === null) return undefined
  const m = seg.match(/^([^\[]+)((?:\[[^\]]*\])?)$/)
  if (!m) return undefined
  const [, key, bracket] = m
  if (typeof cur !== 'object' || cur === null) {
    throw new WireDriftError(`container expected at '${key}' in '${path}'`)
  }
  const next = cur[key]
  if (!bracket) return next
  const idx = bracket.match(/^\[(\d+)\]$/)
  if (idx) return pickBracketIndexed(next, idx, path, key)
  const cond = bracket.match(/^\[([^=\]]+)=([^\]]+)\]$/)
  if (cond) return pickBracketConditional(next, cond, path, key)
  return undefined
}

function pickSinglePath(data, path) {
  let cur = data
  for (const seg of path.split('.')) {
    cur = pickSegment(cur, seg, path)
  }
  return cur
}

/** 路径求值：单路径串或双形态数组（camelCase / snake_case 首命中生效）。 */
function pickPath(data, path) {
  if (typeof path === 'string') return pickSinglePath(data, path)
  for (const p of path) {
    const v = pickSinglePath(data, p)
    if (v !== undefined) return v
  }
  return undefined
}

/** wire 数值归一：缺失合法；存在则必须可归一，否则漂移归 parse。strict = 只接受原生 number。 */
function strictNumeric(v, strict = false) {
  if (v === undefined || v === null) return undefined
  if (strict && typeof v !== 'number') throw new WireDriftError(`non-number field: ${JSON.stringify(v)}`)
  const n = numericField(v)
  if (n === undefined) throw new WireDriftError(`unparseable numeric field: ${JSON.stringify(v)}`)
  return n
}

function strictString(v) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new WireDriftError(`non-string field: ${JSON.stringify(v)}`)
  return v
}

// ── resetSec 各模式求值器 ────────────────────────────────────

const SEC_PER_DAY = 86400
const SEC_PER_HOUR = 3600
const SEC_PER_MIN = 60
const PERCENT_SCALE = 100
/** epoch 单位消歧阈值：秒级戳恒 < 1e11，毫秒级戳恒 > 1e11。 */
const EPOCH_MS_THRESHOLD = 1e11
const LABEL_DELIM_LEN = 2

function parseRelativeLabel(label) {
  const d = label.match(/(\d+)d/)
  const h = label.match(/(\d+)h/)
  const m = label.match(/(\d+)m/)
  let sec = 0
  if (d) sec += Number(d[1]) * SEC_PER_DAY
  if (h) sec += Number(h[1]) * SEC_PER_HOUR
  if (m) sec += Number(m[1]) * SEC_PER_MIN
  return sec
}

function evalIsoReset(raw) {
  const s = strictString(raw)
  return s ? isoResetRemaining(s) : null
}

function evalEpochMsReset(raw) {
  const n = strictNumeric(raw)
  if (n === undefined) return null
  const rem = Math.floor(n / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
  return rem > 0 ? rem : null
}

function evalRelativeLabelReset(raw) {
  const s = strictString(raw)
  return s ? parseRelativeLabel(s) : null
}

function evalZonelessUtcReset(raw) {
  const s = strictString(raw)
  if (!s) return null
  // 无时区标记串按 UTC 解析（与固定发送的 x-timezone: UTC 一致）
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)
  const t = zoneless ? Date.parse(`${s.replace(' ', 'T')}Z`) : Date.parse(s)
  if (Number.isNaN(t)) return null
  const sec = Math.floor((t - Date.now()) / MS_PER_SEC)
  return sec > 0 ? sec : null
}

function evalRelativeMsReset(raw) {
  const n = strictNumeric(raw)
  return n !== undefined && n > 0 ? Math.ceil(n / MS_PER_SEC) : null
}

// epochMsElseRelativeLabel：number/数值串走 epoch；非数值串走相对 label（zhipu 双格式）
function evalEpochMsElseRelativeLabelReset(raw) {
  if (typeof raw === 'number') return evalEpochMsReset(raw)
  const s = strictString(raw)
  if (s === undefined) return null
  const ms = Number(s)
  if (ms && !Number.isNaN(ms)) {
    const rem = Math.floor(ms / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
    if (rem > 0) return rem
  }
  return parseRelativeLabel(s)
}

// epochSecOrMs：按量级消歧秒/毫秒（protojson int64 单位二义）
function evalEpochSecOrMsReset(raw) {
  const n = strictNumeric(raw)
  if (n === undefined || n <= 0) return null
  const ms = n > EPOCH_MS_THRESHOLD ? n : n * MS_PER_SEC
  const rem = Math.floor(ms / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
  return rem > 0 ? rem : null
}

const RESET_EVALUATORS = {
  iso: evalIsoReset,
  epochMs: evalEpochMsReset,
  relativeLabel: evalRelativeLabelReset,
  zonelessUtcWallClock: evalZonelessUtcReset,
  epochMsElseRelativeLabel: evalEpochMsElseRelativeLabelReset,
  relativeMs: evalRelativeMsReset,
  epochSecOrMs: evalEpochSecOrMsReset,
}

function evalResetSec(raw, mode) {
  return RESET_EVALUATORS[mode](raw)
}

/** label 模板插值：`{{path}}` 替换；任一路径缺失 → 去掉插值段并剥尾部分隔符。 */
function evalLabel(template, data) {
  if (!template.includes('{{')) return template
  const segs = template.match(/\{\{([^}]+)\}\}/g) ?? []
  const paths = segs.map((s) => s.slice(LABEL_DELIM_LEN, -LABEL_DELIM_LEN))
  const values = paths.map((p) => strictString(pickPath(data, p)))
  if (values.every((v) => v !== undefined)) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, p) => strictString(pickPath(data, p)) ?? '')
  }
  return template.replace(/\{\{[^}]+\}\}/g, '').replace(/[-\s]+$/, '')
}

// ── 窗口求值 ────────────────────────────────────────────────

function allRequiresMissing(data, requires) {
  return requires.every((p) => {
    const v = pickPath(data, p)
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0)
  })
}

/** 窗口门控求值（gate 存在性 + gateValue 取值门控）；返回非 null = 整窗提前返回。 */
function evalWindowGate(win, source, strict) {
  if (win.gate) {
    const hit = pickPath(source, win.gate.path)
    if (hit === undefined || hit === null) {
      return win.gate.missing === 'query-fail' ? { win: INFINITE_WIN, queryFail: true } : { win: INFINITE_WIN }
    }
  }
  if (win.gateValue) {
    const v = strictNumeric(pickPath(source, win.gateValue.path), strict)
    if (win.gateValue.equals !== undefined && v !== win.gateValue.equals) return { win: INFINITE_WIN }
    if (win.gateValue.notEquals !== undefined && v === win.gateValue.notEquals) return { win: INFINITE_WIN }
  }
  return null
}

/** 绝对量求值（usedLimit）：used 折算内建（used ?? limit−remaining）。 */
function evalUsedLimit(win, source, strict) {
  if (!win.usedLimit) return undefined
  const limit = strictNumeric(pickPath(source, win.usedLimit.limit), strict)
  const usedRaw = win.usedLimit.used !== undefined ? strictNumeric(pickPath(source, win.usedLimit.used), strict) : undefined
  const remaining = win.usedLimit.remaining !== undefined ? strictNumeric(pickPath(source, win.usedLimit.remaining), strict) : undefined
  const used = usedRaw ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
  if (limit === undefined || used === undefined || limit <= 0) return undefined
  return { used, limit, unit: win.usedLimit.unit ?? 'requests' }
}

/** pct.raw 经 via 变换。 */
function pctFromVia(via, raw) {
  switch (via) {
    case 'direct':
      return raw
    case 'percent01to100':
      return raw * PERCENT_SCALE
    case 'remainingToUsed':
      return Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - raw))
    case 'fractionRemainingToUsed':
      return Math.round((1 - Math.max(0, Math.min(1, raw))) * PERCENT_SCALE * PERCENT_SCALE) / PERCENT_SCALE
    case 'usedOverLimit':
      return null
  }
  return null
}

function isInfiniteWinFromPct(win, pct, usedLimit) {
  if ((win.pct?.via === 'direct' || win.pct?.via === 'fractionRemainingToUsed') && pct === null) return true
  return win.pct?.via === 'usedOverLimit' && !usedLimit
}

function evalWindowPct(win, source, strict, usedLimit) {
  let pct = null
  if (win.pct?.path) {
    const raw = strictNumeric(pickPath(source, win.pct.path), strict)
    if (raw !== undefined) pct = pctFromVia(win.pct.via, raw)
  }
  if (isInfiniteWinFromPct(win, pct, usedLimit)) return { pct, infiniteWin: true }
  if (win.pct?.via === 'usedOverLimit' && usedLimit) pct = Math.round((usedLimit.used / usedLimit.limit) * PERCENT_SCALE)
  return { pct }
}

/** resetSec 求值（源可覆写：mimo resetSec 来自辅助 detail 请求）。辅助源字段漂移只降级该数据位 null。 */
function evalWindowResetSec(win, reqs, source, failSafeSources) {
  if (!win.resetSec) return null
  const overrideName = win.resetSec.fromRequest
  const resetSrc = overrideName ? reqs.byName[overrideName] : source
  if (overrideName === undefined || !failSafeSources.has(overrideName)) {
    return evalResetSec(pickPath(resetSrc, win.resetSec.path), win.resetSec.mode)
  }
  try {
    return evalResetSec(pickPath(resetSrc, win.resetSec.path), win.resetSec.mode)
  } catch (e) {
    if (e instanceof WireDriftError) return null
    throw e
  }
}

function evalWindow(win, reqs, strict, failSafeSources) {
  const source = win.fromRequest ? reqs.byName[win.fromRequest] : reqs.byName[reqs.primaryName]
  const gate = evalWindowGate(win, source, strict)
  if (gate) return gate
  const usedLimit = evalUsedLimit(win, source, strict)
  const { pct, infiniteWin } = evalWindowPct(win, source, strict, usedLimit)
  if (infiniteWin) return { win: INFINITE_WIN }
  const resetSec = evalWindowResetSec(win, reqs, source, failSafeSources)
  if (usedLimit && win.usedLimit?.output !== false) {
    return { win: { pct, used: usedLimit.used, limit: usedLimit.limit, unit: usedLimit.unit, resetSec } }
  }
  return { win: { pct, resetSec } }
}

/** 盲跑全部窗口声明路径（只验形态不消费值；辅助请求路径缺失合法跳过）。 */
function prevalidateWindowPaths(config, primary) {
  const primaryDef = config.requests.find((r) => r.role !== 'auxiliary') ?? config.requests[0]
  for (const win of config.windows) {
    const source = win.fromRequest ? reqsByName(primary, primaryDef.name, win.fromRequest) : primary
    const touch = (p) => { if (p) pickPath(source, p) }
    if (win.gate) touch(win.gate.path)
    if (win.gateValue) touch(win.gateValue.path)
    if (win.pct?.path) touch(win.pct.path)
    if (win.resetSec) touch(win.resetSec.path)
    if (win.usedLimit) {
      touch(win.usedLimit.used)
      touch(win.usedLimit.limit)
      if (win.usedLimit.remaining) touch(win.usedLimit.remaining)
    }
  }
}

function reqsByName(primary, primaryName, name) {
  if (name === undefined || name === primaryName) return primary
  return undefined
}

// ── 请求与业务码判定 ────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 8000

/** 构造 credential header（redirect:'manual' + 3xx 判 unauthorized 在 fetchPrimary）。 */
function buildHeaders(config, credential, extra) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    ...(config.requests.some((r) => r.body !== undefined) ? { 'content-type': 'application/json' } : {}),
    ...extra,
  }
  if (config.credential === 'bearer') headers['authorization'] = `Bearer ${credential}`
  else if (config.credential === 'raw') headers['authorization'] = credential
  else headers['cookie'] = credential
  return headers
}

/** 决策字段形态判定（缺失按 missing 的声明确定去向；类型非法恒归 parse）。 */
function assertBodyCodeUsable(code, bodyCode, allowsStringCode) {
  if (code === undefined || code === null) {
    if (bodyCode.missing === 'parse') throw new WireDriftError(`missing body code at '${JSON.stringify(bodyCode.path)}'`)
    return
  }
  const legal = typeof code === 'string' ? allowsStringCode : typeof code === 'number' || typeof code === 'boolean'
  if (!legal) throw new WireDriftError(`illegal body code: ${JSON.stringify(code)}`)
}

function bodyCodeMappedFailureReason(code, bodyCode) {
  const mapped = (typeof code === 'string' || typeof code === 'number') ? bodyCode.map?.[String(code)] : undefined
  return mapped ?? bodyCode.else ?? 'no-subscription'
}

/** 在体业务码判定；返回非 null = 提前失败返回。 */
function evaluateBodyCode(config, primaryData) {
  const bodyCode = config.bodyCode
  if (!bodyCode) return null
  const code = pickPath(primaryData, bodyCode.path)
  const successValues = Array.isArray(bodyCode.success) ? bodyCode.success : [bodyCode.success]
  const allowsStringCode = successValues.some((s) => typeof s === 'string')
  assertBodyCodeUsable(code, bodyCode, allowsStringCode)
  const isSuccess = code !== undefined && code !== null && successValues.some((s) => s === code)
  if (!isSuccess) return { ok: false, reason: bodyCodeMappedFailureReason(code, bodyCode) }
  if (bodyCode.successRequires !== undefined && !isRecord(pickPath(primaryData, bodyCode.successRequires))) return { ok: false, reason: 'parse' }
  return null
}

function evaluateRequires(config, primaryData) {
  if (config.requires && allRequiresMissing(primaryData, config.requires)) return { ok: false, reason: 'no-subscription' }
  return null
}

/** 窗口装配（未声明的 slot 恒 INFINITE_WIN）。 */
function assembleWindows(config, reqs) {
  const wins = { fiveHour: INFINITE_WIN, week: INFINITE_WIN, month: INFINITE_WIN }
  const primaryDef = config.requests.find((r) => r.role !== 'auxiliary') ?? config.requests[0]
  const failSafeSources = new Set(config.requests.filter((r) => r !== primaryDef).map((r) => r.name))
  for (const win of config.windows) {
    const r = evalWindow(win, reqs, config.strictNumbers === true, failSafeSources)
    if (r.queryFail) return { ok: false, reason: 'no-subscription' }
    wins[win.slot] = r.win
  }
  return { ok: true, data: { label: evalLabel(config.label, reqs.byName[reqs.primaryName]), wins: [wins.fiveHour, wins.week, wins.month] } }
}

/** 凭证归一与请求头装配。cookie 模式空判据判归一后的值（cookie-invalid-format 分流）。 */
function prepareFetchHeaders(config, credential, fetcherConfig) {
  const resolvedCredential = config.credential === 'cookie' ? normalizeCookieHeader(credential) : credential
  if (!resolvedCredential) return { failure: config.credential === 'cookie' ? 'cookie-invalid-format' : 'unauthorized' }
  const resolvedHeaders = resolveHeaderFroms(config.headerFroms ?? [], resolvedCredential, fetcherConfig?.quotaParams)
  if ('failure' in resolvedHeaders) return { failure: resolvedHeaders.failure }
  return { headers: buildHeaders(config, resolvedCredential, { ...(config.extraHeaders ?? {}), ...resolvedHeaders.headers }) }
}

/** 单请求执行（源 declarative-fetch.ts fetchPrimary，剥除 Set-Cookie 捕获）。 */
async function fetchPrimary(config, def, headers, fetchImpl) {
  let resp
  try {
    resp = await fetchImpl(def.url, {
      headers,
      ...(def.method !== undefined ? { method: def.method } : {}),
      ...(def.body !== undefined ? { body: def.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!resp.ok) {
    void resp.body?.cancel()
    const mapped = config.statusMap?.[String(resp.status)]
    return { ok: false, reason: mapped ?? statusToReason(resp.status) }
  }
  try {
    const data = await resp.json()
    if (!isRecord(data)) return { ok: false, reason: 'parse' }
    return { ok: true, data }
  } catch {
    return { ok: false, reason: 'parse' }
  }
}

/** 辅助请求并行 + 独立降级（失败仅缺该数据源，不拖垮主数据）。 */
async function fetchAuxiliaryRequests(config, primaryDef, headers, fetchImpl, reqs) {
  await Promise.allSettled(config.requests.filter((r) => r !== primaryDef).map(async (def) => {
    const r = await fetchPrimary(config, def, headers, fetchImpl)
    if (r.ok) reqs.byName[def.name] = r.data
  }))
}

/**
 * 执行声明式 fetcher：成功返回 { ok, data: { label, wins: [5h, 周, 月] } }，失败返回 { ok: false, reason }。
 */
export async function runDeclarativeFetcher(config, credential, fetcherConfig) {
  const prepared = prepareFetchHeaders(config, credential, fetcherConfig)
  if ('failure' in prepared) return { ok: false, reason: prepared.failure }
  const headers = prepared.headers

  const fetchImpl = (url, init) => fetch(url, init)
  const primaryDef = config.requests.find((r) => r.role !== 'auxiliary') ?? config.requests[0]
  const primary = await fetchPrimary(config, primaryDef, headers, fetchImpl)
  if (!primary.ok) return primary
  const reqs = { primaryName: primaryDef.name, byName: { [primaryDef.name]: primary.data } }
  await fetchAuxiliaryRequests(config, primaryDef, headers, fetchImpl, reqs)

  // 求值段：任何 wire 形态漂移 → parse（fail-visible 不静默降级）。先盲跑全部窗口路径再进业务判定。
  try {
    prevalidateWindowPaths(config, reqs.byName[reqs.primaryName])
    const primaryData = reqs.byName[reqs.primaryName]
    const bodyResult = evaluateBodyCode(config, primaryData)
    if (bodyResult) return bodyResult
    const requiresResult = evaluateRequires(config, primaryData)
    if (requiresResult) return requiresResult
    return assembleWindows(config, reqs)
  } catch (e) {
    if (e instanceof WireDriftError) return { ok: false, reason: 'parse' }
    throw e
  }
}
