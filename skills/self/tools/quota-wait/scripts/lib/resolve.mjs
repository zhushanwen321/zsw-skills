// provider 名与凭证的解析链（taiji 权威优先，zcode 兜底）。
//
// 数据源（全部只读）：
//   ~/.taiji/agent/config/providers.json  taiji 侧 quota 配置（fetcher/enabled/credentialSource/params/cookieSet）
//   ~/.taiji/agent/models.json            provider 声明（name/baseUrl/apiKey）
//   ~/.taiji/agent/auth.json              凭据（type=api_key 的 key / type=oauth 的 access）
//   ~/.taiji/secrets/<pid>-cookie.txt     cookie 凭证（mimo/stepfun/opencode/opendesign）
//   ~/.taiji/secrets/<pid>-apikey.txt     额度专属 key（credentialSource=exclusive 时）
//   ~/.zcode/v2/provider_config.json      zcode 自定义 provider（api-key 兜底源）
//   config/provider-map.json              zcode 名 → taiji provider id 的人工映射
//
// 凭证判定与 taiji QuotaService.getCredential 同语义：exclusive 只读专属 key 文件；
// provider 源 auth.json → models.json；cookie 读 secrets；zcode 侧 key 仅作 api-key
// 形态的最后兜底（zcode 账户登录态 key 不是平台 API key，探针实测 401，不参与）。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchQuotaPreset } from './spec.mjs'

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** taiji 数据目录（对齐 taiji getDataDir：env 覆盖 → ~/.taiji）。 */
export function resolveTaijiDataDir(env = process.env) {
  const fromEnv = env['TAIJI_AGENT_DATA_DIR']?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.taiji')
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err)?.code === 'ENOENT') return undefined
    throw err
  }
}

function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (err) {
    if ((err)?.code === 'ENOENT') return undefined
    throw err
  }
}

/** 加载解析链所需的全部上下文（一次读盘，后续解析纯内存）。 */
export function loadContext() {
  const taijiDataDir = resolveTaijiDataDir()
  const agentDir = join(taijiDataDir, 'agent')
  if (!existsSync(agentDir)) {
    throw new Error(
      `taiji 数据目录不存在：${taijiDataDir}。本 CLI 依赖 taiji 的额度查询配置（providers.json / auth.json / secrets）。` +
        `恢复指引：确认 taiji 已在本机初始化，或用环境变量 TAIJI_AGENT_DATA_DIR 指向实际数据目录后重试。`,
    )
  }
  return {
    taijiDataDir,
    agentDir,
    secretsDir: join(taijiDataDir, 'secrets'),
    providersExtras: readJsonIfExists(join(agentDir, 'config', 'providers.json'))?.providers ?? {},
    models: readJsonIfExists(join(agentDir, 'models.json'))?.providers ?? {},
    auth: readJsonIfExists(join(agentDir, 'auth.json')) ?? {},
    zcodeProviders: readJsonIfExists(join(homedir(), '.zcode', 'v2', 'provider_config.json'))
      ?.config?.providerConfigRules?.providerRules ?? [],
    providerMap: readJsonIfExists(join(SCRIPTS_DIR, '..', 'config', 'provider-map.json'))?.zcodeToTaiji ?? {},
  }
}

/** taiji 侧已知 provider id 全集（quota 配置 ∪ models 声明 ∪ auth 凭据）。 */
export function knownTaijiProviderIds(ctx) {
  return new Set([...Object.keys(ctx.providersExtras), ...Object.keys(ctx.models), ...Object.keys(ctx.auth)])
}

/** zcode 侧按名找 provider 规则（providerName / providerId / templateId 三处匹配）。 */
function findZcodeRule(ctx, name) {
  return ctx.zcodeProviders.find(
    (r) => r?.providerName === name || r?.providerId === name || r?.templateId === name,
  )
}

/**
 * provider 解析：把调用方传入的 provider 名解析为 { taijiProviderId, fetcherId, via }。
 *
 * 链序（pi 与 zcode 输入共用；--agent 只影响第 3 步是否补 zcode 侧 baseUrl）：
 *   1. 映射文件精确命中（zcode 命名 → taiji id）
 *   2. 同名直查 taiji（pi 输入本身就是 taiji provider id）
 *   3. preset 模式匹配（传入名 + zcode baseUrl）→ fetcher → taiji 里配置了该 fetcher 的条目
 */
export function resolveProvider(agent, providerName, ctx, presets) {
  const via = []
  const mapped = ctx.providerMap[providerName]
  if (mapped !== undefined) {
    if (knownTaijiProviderIds(ctx).has(mapped)) {
      return finishResolution(ctx, mapped, presets, [...via, `map:${providerName}->${mapped}`])
    }
    via.push(`map-target-missing:${mapped}`)
  }
  if (knownTaijiProviderIds(ctx).has(providerName)) {
    return finishResolution(ctx, providerName, presets, [...via, `exact:${providerName}`])
  }
  const baseUrl = agent === 'zcode' ? findZcodeRule(ctx, providerName)?.config?.api?.baseUrl : undefined
  const preset = matchQuotaPreset(providerName, baseUrl, presets)
  if (preset !== undefined) {
    // 3a. taiji 里显式配置了该 fetcher 的条目（enabled 优先，取首个）
    const configured = Object.entries(ctx.providersExtras)
      .filter(([, extras]) => extras?.quota?.fetcher === preset.fetcher && extras?.quota?.enabled !== false)
      .map(([pid]) => pid)
    if (configured.length > 0) {
      return finishResolution(ctx, configured[0], presets, [...via, `preset:${preset.fetcher}->${configured[0]}`])
    }
    // 3b. taiji 里 name/baseUrl 命中同一 preset 的 provider
    const byName = [...knownTaijiProviderIds(ctx)].find((pid) => {
      const m = ctx.models[pid]
      return matchQuotaPreset(m?.name ?? pid, m?.baseUrl, presets)?.fetcher === preset.fetcher
    })
    if (byName !== undefined) {
      return finishResolution(ctx, byName, presets, [...via, `preset-name:${preset.fetcher}->${byName}`])
    }
  }
  const known = [...knownTaijiProviderIds(ctx)].sort().join(', ')
  throw new Error(
    `provider "${providerName}" 无法解析到 taiji 侧条目（已尝试：映射文件 / 同名直查 / preset 模式匹配）。` +
      `taiji 已知 provider：${known || '(无)'}。恢复指引：在技能目录 config/provider-map.json 的 zcodeToTaiji 里加一行` +
      ` "${providerName}": "<上述某个 taiji provider id>" 后重试。`,
  )
}

/** 由 taiji provider id 定 fetcher：显式 quota.fetcher 优先，否则按 name/baseUrl 匹配 preset。 */
function finishResolution(ctx, pid, presets, via) {
  const explicit = ctx.providersExtras[pid]?.quota?.fetcher
  if (explicit !== undefined) return { taijiProviderId: pid, fetcherId: explicit, via }
  const m = ctx.models[pid]
  const preset = matchQuotaPreset(m?.name ?? pid, m?.baseUrl, presets)
  if (preset !== undefined) return { taijiProviderId: pid, fetcherId: preset.fetcher, via }
  throw new Error(
    `taiji provider "${pid}" 无额度查询配置（providers.json 无 quota.fetcher，name/baseUrl 也未命中任何 preset）。` +
      `恢复指引：在 taiji 设置页为该 provider 配置额度查询后重试。`,
  )
}

/** quota params（新 params 字段优先，旧版 workspace 单字段映射为 params.workspaceUrl）。 */
export function resolveParamsForFetch(ctx, pid) {
  const quota = ctx.providersExtras[pid]?.quota
  if (!quota) return undefined
  if (quota.params && Object.keys(quota.params).length > 0) return quota.params
  if (quota.workspace) return { workspaceUrl: quota.workspace }
  return undefined
}

/** 读 secret 文件（去空白）；缺失返回 undefined。 */
function readSecret(ctx, filename) {
  return readTextIfExists(join(ctx.secretsDir, filename))
}

/**
 * 凭证解析：按 fetcher 的 auth 形态逐个尝试，返回 { credential, kind, source } 或
 * { error }（error 为可直接面向用户的恢复指引文案）。
 *
 * 顺序对齐 taiji resolveCredential：exclusive 专属 key（仅 api-key 形态）→ 按 auth
 * 数组序逐形态（api-key：auth.json → models.json；oauth：auth.json access；cookie：
 * secrets 文件）→ zcode 侧 api-key 兜底（仅 api-key 形态且 zcode 配置里确有该 key）。
 */
export function resolveCredential(agent, providerName, resolved, fetcherSpec, ctx) {
  const pid = resolved.taijiProviderId
  const quota = ctx.providersExtras[pid]?.quota ?? {}
  // credentialSource 判定对齐 taiji resolveQuotaCredentialSource：显式值优先，缺省按 apiKeySet 推断
  const source = quota.credentialSource ?? (quota.apiKeySet ? 'exclusive' : 'provider')
  const tried = []

  for (const kind of fetcherSpec.auth) {
    if (kind === 'api-key') {
      if (source === 'exclusive') {
        const key = readSecret(ctx, `${pid}-apikey.txt`)
        if (key) return { credential: key, kind, source: `secrets:${pid}-apikey.txt` }
        tried.push(`专属 key 文件 ${ctx.secretsDir}/${pid}-apikey.txt 缺失`)
        continue
      }
      // provider 源：auth.json（api_key 的 key / oauth 的 access 同为合法 bearer 凭据）→ models.json apiKey
      const authEntry = ctx.auth[pid]
      if (authEntry?.type === 'api_key' && authEntry.key) {
        return { credential: authEntry.key, kind, source: `auth.json:${pid}` }
      }
      if (authEntry?.type === 'oauth' && authEntry.access) {
        return { credential: authEntry.access, kind, source: `auth.json:${pid}(oauth)` }
      }
      const modelsKey = ctx.models[pid]?.apiKey
      if (typeof modelsKey === 'string' && modelsKey.trim() !== '') {
        return { credential: modelsKey, kind, source: `models.json:${pid}` }
      }
      tried.push(`auth.json / models.json 无 ${pid} 的 api-key 凭据`)
    } else if (kind === 'oauth') {
      const authEntry = ctx.auth[pid]
      if (authEntry?.type === 'oauth' && authEntry.access) {
        return { credential: authEntry.access, kind, source: `auth.json:${pid}(oauth)` }
      }
      tried.push(`auth.json 无 ${pid} 的 oauth 凭据`)
    } else if (kind === 'cookie') {
      const cookie = readSecret(ctx, `${pid}-cookie.txt`)
      if (cookie) return { credential: cookie, kind, source: `secrets:${pid}-cookie.txt` }
      tried.push(`cookie 文件 ${ctx.secretsDir}/${pid}-cookie.txt 缺失`)
    }
  }

  // zcode 兜底：仅 api-key 形态；自定义 provider 的 key 是真实平台 API key，可用
  if (fetcherSpec.auth.includes('api-key') && agent === 'zcode') {
    const rule = findZcodeRule(ctx, providerName)
    const key = rule?.config?.access?.type === 'api-key' ? rule.config.access.apiKey : undefined
    if (typeof key === 'string' && key.trim() !== '') {
      return { credential: key, kind: 'api-key', source: `zcode:${rule.providerName ?? rule.providerId}` }
    }
  }

  const needCookie = fetcherSpec.auth.includes('cookie')
  const hint = needCookie
    ? `恢复指引：在 taiji 设置页为 ${pid} 保存套餐 Cookie（额度查询只认浏览器 Cookie）后重试。`
    : `恢复指引：在 taiji 设置页为 ${pid} 配置额度查询凭证（专属 Key 或 provider 凭据）后重试。`
  return { error: `无可用凭证（已尝试：${tried.join('；') || '无'}）。${hint}` }
}
