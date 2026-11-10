// semantic-cache.mjs — 语义检查结果缓存（sync-conformance-plane U2/M2）
//
// 语义权威（设计 sync-conformance-plane）：
//   D7   semantic 按义务摘要 + 输入哈希 + checker 版本缓存；内容未变不重复消耗 agent
//        （依据：两个真实 D5 运行 291.19M token 中 278.54M 为缓存读取）
//   段三 语义 checker 的最小输入包 = 规范化义务绑定 + 目标 artifact + evidenceInputs + rubric
//   V7   同义务同哈希第二轮对账零 agent 调用；artifact 变化后相关证据失效并重新调用
//
// 缓存是纯内存键值表（键派生函数导出，M4 引擎可落盘持久化——u-m2 只固化键语义与
// 命中/失效行为，持久化形态属引擎期实施细节）。键含 checker 版本：checker 升版即全量失效。

import { canonicalJson } from "../kernel/facts.mjs";

/**
 * 缓存键 = 义务摘要哈希 + 输入哈希集（name:hash 规范序）+ checker 版本。
 * 任一成分变化 → 新键 → 旧缓存天然失效（输入变化失效，V7 第三步）。
 * inputHashes = { 输入名: 内容哈希 }（registry 用 hashContent 现算）。
 */
export function buildCacheKey({ obligation, inputHashes, checkerVersion }) {
  const inputs = Object.keys(inputHashes).sort().map((name) => `${name}:${inputHashes[name]}`);
  return ["sem-cache-v1", obligation.summaryHash, inputs.join(","), checkerVersion].join("|");
}

/**
 * 创建缓存实例。verdict 形态 = { result: "pass"|"fail", summary: 非空字符串 }。
 * stats 供零调用复用断言（G7）：hits = 命中次数（每次命中 = 零 agent 调用）。
 */
export function createSemanticCache() {
  const store = new Map();
  const stats = { hits: 0, misses: 0, sets: 0 };
  return {
    buildKey: buildCacheKey,
    get(key) {
      const v = store.get(key);
      if (v !== undefined) stats.hits += 1;
      else stats.misses += 1;
      return v;
    },
    // 存储前经 canonicalJson 规范化拷贝：同一判定内容键序不同也复用同一形态（段三规范化口径）
    set(key, verdict) {
      store.set(key, JSON.parse(canonicalJson(verdict)));
      stats.sets += 1;
    },
    clear() {
      store.clear();
    },
    size: () => store.size,
    stats,
  };
}
