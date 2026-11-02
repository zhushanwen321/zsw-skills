// 5h 窗口恢复判定（轮询核心谓词，独立成模块便于单测）。
//
// 语义：相对上一轮快照出现「额度变多」= 窗口已重置。三个信号互为冗余（重置时刻
// 必然同时出现）：pct 下降 / used 下降 / resetSec 上升。阈值用途见各常量注释。

/** pct 两位小数舍入余量：下降超过 0.1 才算真下降。 */
const PCT_DROP_THRESHOLD = 0.1
/** used 绝对量下降阈值（次数/token 数），同 pct 余量语义。 */
const USED_DROP_THRESHOLD = 0.1
/** resetSec 是「服务端时刻减本地时钟」的差值，有秒级时钟抖动；正常倒数每轮递减数百秒，上升超过 60 秒才算新窗口。 */
const RESET_RISE_THRESHOLD = 60

/**
 * 相对上一轮是否出现「额度变多」（窗口重置信号）。
 * pct 下降 / used 下降 / resetSec 上升，任一命中即恢复；返回首个命中的信号名或 null。
 * 快照形态：{ pct: number|null, used: number|null|undefined, resetSec: number|null }。
 */
export function detectRecovery(prev, cur) {
  if (prev.pct !== null && cur.pct !== null && prev.pct - cur.pct > PCT_DROP_THRESHOLD) return 'pct-drop'
  if (prev.used !== undefined && prev.used !== null && cur.used !== undefined && cur.used !== null
    && prev.used - cur.used > USED_DROP_THRESHOLD) return 'used-drop'
  if (prev.resetSec !== null && cur.resetSec !== null && cur.resetSec - prev.resetSec > RESET_RISE_THRESHOLD) return 'reset-jump'
  return null
}

/** 引擎输出 wins[0] → 判定快照。 */
export function snapshotOf(wins) {
  const w = wins[0] ?? {}
  return { pct: w.pct ?? null, used: w.used ?? null, resetSec: w.resetSec ?? null }
}
