// 查询规范（fetchers）与 provider 预设（presets）的加载。
//
// 权威顺序：taiji 远程配置覆盖（~/.taiji/remote-config/quota-fetchers.json 的
// data.fetchers / data.presets 非空时整体生效）→ vendored 基线副本（specs/ 下两份，
// 源自 taiji main e86cda257）。与 taiji runtime「基线 ⊕ 远程」合并视图同口径。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeclarativeFetcherConfig, isRecord } from './engine.mjs'

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const SPECS_DIR = join(SCRIPTS_DIR, '..', 'specs')

function readJsonFileSync(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonIfExists(path) {
  try {
    return readJsonFileSync(path)
  } catch (err) {
    if ((err)?.code === 'ENOENT') return undefined
    throw err
  }
}

/** preset 元素形状校验（对齐 taiji isQuotaPreset 的关键字段；未知字段放行）。 */
function isPresetValid(v) {
  if (!isRecord(v)) return false
  if (typeof v['fetcher'] !== 'string' || v['fetcher'] === '') return false
  if (typeof v['label'] !== 'string') return false
  if (!Array.isArray(v['auth']) || !v['auth'].every((k) => typeof k === 'string')) return false
  const match = v['match']
  if (!isRecord(match)) return false
  if (match['baseUrlPattern'] !== undefined && typeof match['baseUrlPattern'] !== 'string') return false
  if (match['namePattern'] !== undefined && typeof match['namePattern'] !== 'string') return false
  return true
}

/**
 * 加载 fetcher 规范表：{ fetchers: Record<id, config>, source: 'remote' | 'baseline' }。
 * 远程条目逐个过形状 guard，畸形条目丢弃（不影响其余），全部畸形/为空回落基线。
 */
export function loadFetcherSpecs(taijiDataDir) {
  const remote = readJsonIfExists(join(taijiDataDir, 'remote-config', 'quota-fetchers.json'))
  const remoteFetchers = remote?.data?.fetchers
  if (isRecord(remoteFetchers)) {
    const accepted = {}
    for (const [id, cfg] of Object.entries(remoteFetchers)) {
      if (isDeclarativeFetcherConfig(cfg)) accepted[id] = cfg
    }
    if (Object.keys(accepted).length > 0) return { fetchers: accepted, source: 'remote' }
  }
  const baseline = readJsonFileSync(join(SPECS_DIR, 'quota-fetchers.json'))
  const fetchers = {}
  for (const [id, cfg] of Object.entries(baseline.fetchers)) {
    if (isDeclarativeFetcherConfig(cfg)) fetchers[id] = cfg
  }
  return { fetchers, source: 'baseline' }
}

/** 加载 preset 列表（远程覆盖同口径，畸形元素丢弃）。 */
export function loadPresets(taijiDataDir) {
  const remote = readJsonIfExists(join(taijiDataDir, 'remote-config', 'quota-fetchers.json'))
  const remotePresets = remote?.data?.presets
  if (Array.isArray(remotePresets)) {
    const accepted = remotePresets.filter(isPresetValid)
    if (accepted.length > 0) return accepted
  }
  const baseline = readJsonFileSync(join(SPECS_DIR, 'quota-presets.json'))
  return baseline.presets.filter(isPresetValid)
}

/**
 * 按 baseUrl / name 匹配 preset（对齐 taiji matchQuotaPreset：baseUrl 包含匹配优先于
 * name 正则匹配，按 preset 声明序首命中）。
 */
export function matchQuotaPreset(name, baseUrl, presets) {
  const normalizedBaseUrl = baseUrl?.toLowerCase() ?? ''
  const normalizedName = name?.toLowerCase() ?? ''
  if (!normalizedBaseUrl && !normalizedName) return undefined
  for (const preset of presets) {
    const { baseUrlPattern, namePattern } = preset.match
    if (baseUrlPattern && normalizedBaseUrl.includes(baseUrlPattern.toLowerCase())) return preset
    if (namePattern && normalizedName) {
      const regex = new RegExp(namePattern, 'i')
      if (regex.test(normalizedName)) return preset
    }
  }
  return undefined
}
