#!/usr/bin/env node
// check-no-text-assertion.mjs — 断言路径文字匹配防回潮门禁（2026-11-04 结构化断言改造配套）
//
// 背景：workflow 引擎的断言已按「结构化断言改造」字段化（判定依据 = agent 产结构化
// 字段或 JSON 文件；自由文本/工具输出上的字面搜索判定全部退役——审计与分析见
// dev-workflow 门禁文本匹配审计）。本脚本防两类回潮：
//   ① 已退役判定点的字面匹配复活；
//   ② 新增「在 agent 返回文本 / 工具 stdout 上搜证据行并据以判定」的代码。
//
// 形态 = 基线锁定 + 增量门禁：扫描四个业务单源的 `.includes(` / `.test(` / `indexOf(`
// 命中点，与基线快照（scripts/text-assertion-baseline.json）比对——
//   - 命中 ⊆ 基线：通过（基线内的存量命中均已归类为保留区：协议解析 / 格式校验 /
//     路径集合判定 / 枚举合法判定——这些是结构化断言的合法判定原语，见改造分析 §0/§5.3）
//   - 有新增命中：exit 1，要求处置——属保留区的更新基线（node scripts/check-no-text-assertion.mjs --update，
//     并在提交说明写明该命中的归类理由）；属证据扫描的改为结构化判定
//   - 删减不拦（存量自然收敛方向）
//
// 基线键 = 文件 + 命中行内容（多重集，同文件同内容按出现次数计）：行号仅作展示。
// 按行号锁定会被行移动整体误报——并行单元插删一行，其下所有命中都变成「新增」。
//
// 用法：node scripts/check-no-text-assertion.mjs [--update]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(repoRoot, "scripts", "text-assertion-baseline.json");
// 扫描对象 = 现行代全部业务单源（构建名单 NAMES 对应的 shared.ts；V1-V3 代单源已归档
// 退出构建树，不再扫描）。基线键含归档路径的存量条目随归档失效，--update 时自然清除
const TARGETS = [
  "skills/self/dev-workflow/workflows/src/design-code-sync-loop.shared.ts",
  "skills/self/dev-workflow/workflows/src/design-code-sync-v2.shared.ts",
  "skills/self/dev-workflow/workflows/src/tech-review-loop-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/wave-executor-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/dev-consistency-loop-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/acceptance-design-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/candidate-build-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/independent-assurance-dev.shared.ts",
  "skills/self/dev-workflow/workflows/src/tech-review-loop-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/wave-executor-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/dev-consistency-loop-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/acceptance-design-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/candidate-build-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/independent-assurance-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/assurance-repair-loop-v4.shared.ts",
  "skills/self/dev-workflow/workflows/src/tech-review-loop-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/wave-executor-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/dev-consistency-loop-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/acceptance-design-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/candidate-build-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/independent-assurance-v5.shared.ts",
  "skills/self/dev-workflow/workflows/src/assurance-repair-loop-v5.shared.ts",
];
// 覆盖六类字面匹配 API（2026-11-04 审查缺陷 7 修正：只扫三类会漏 .match/.exec/
// startsWith/endsWith 回潮——本次退役的判定点恰有 /词表符号.../.exec 与 startsWith("[process]") 形态）
const API_RE = /\.includes\(|\.test\(|\.indexOf\(|\.match\(|\.exec\(|\.startsWith\(|\.endsWith\(/;

const scanFile = (rel) => {
  const out = [];
  const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (API_RE.test(l)) out.push([i + 1, l.trim().slice(0, 160)]);
  });
  return out;
};

const current = {};
for (const rel of TARGETS) current[rel] = scanFile(rel);

// 基线条目第三元 = 归类标签（protocol-parse | format-validation | path-set | enum-check |
// unclassified）：使「该命中为何属保留区」可被 grep 复查——误归类（实为证据扫描却登记为
// 保留区）机器查不出存在性、只能靠标签抽查兜住。--update 按内容沿用旧标签（同文件同内容
// 出现多次时按序消费旧标签），新命中标 unclassified；校验只按内容多重集匹配，标签不参与，
// 未归类计数随通过信息输出提醒补标
const contentKey = (rel, content) => `${rel}\t${content}`;

const readOldCategories = () => {
  try {
    const old = JSON.parse(readFileSync(BASELINE, "utf8"));
    const pools = new Map();
    for (const rel of TARGETS)
      for (const e of old[rel] ?? []) {
        const cat = e.length >= 3 ? e[2] : "unclassified";
        const k = contentKey(rel, e[1]);
        if (!pools.has(k)) pools.set(k, []);
        pools.get(k).push(cat);
      }
    return pools;
  } catch {
    return new Map();
  }
};

const update = process.argv.includes("--update");
if (update) {
  const oldCats = readOldCategories();
  const tagged = {};
  let unclassified = 0;
  for (const rel of TARGETS)
    tagged[rel] = current[rel].map(([l, c]) => {
      const pool = oldCats.get(contentKey(rel, c));
      const cat = pool && pool.length > 0 ? pool.shift() : "unclassified";
      if (cat === "unclassified") unclassified += 1;
      return [l, c, cat];
    });
  writeFileSync(BASELINE, `${JSON.stringify(tagged, null, 1)}\n`);
  const total = Object.values(tagged).reduce((n, v) => n + v.length, 0);
  console.log(`基线已更新：${total} 处存量命中（新增命中标 unclassified：${unclassified} 处）。归类标签可直接编辑基线第三元修正；新增命中点须在提交说明写明归类理由。`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`基线快照不可读（${BASELINE}）——运行 node scripts/check-no-text-assertion.mjs --update 生成后重试`);
  process.exit(1);
}

const additions = [];
const totals = { current: 0, baseline: 0, removed: 0 };
for (const rel of TARGETS) {
  const remaining = new Map();
  for (const e of baseline[rel] ?? []) {
    const k = contentKey(rel, e[1]);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
    totals.baseline += 1;
  }
  for (const [l, c] of current[rel]) {
    totals.current += 1;
    const k = contentKey(rel, c);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else additions.push(`${rel}:${l}  ${c}`);
  }
  for (const n of remaining.values()) totals.removed += n;
}

if (additions.length === 0) {
  const unclassified = Object.values(baseline).reduce(
    (n, entries) => n + entries.filter((e) => e.length < 3 || e[2] === "unclassified").length,
    0,
  );
  const tagNote = unclassified > 0 ? `；未归类 ${unclassified} 处（编辑基线第三元补标签，类别：protocol-parse/format-validation/path-set/enum-check）` : "；归类标签齐全";
  console.log(`文字匹配断言防回潮：通过（当前 ${totals.current} 处命中 ⊆ 基线 ${totals.baseline} 处；基线外新增 0；基线已收敛 ${totals.removed} 处${tagNote}）`);
  process.exit(0);
}

console.error(`文字匹配断言防回潮：发现 ${additions.length} 处基线外新增命中——判定路径禁止新增字面匹配（证据扫描形态已全部字段化）。逐条处置：`);
for (const a of additions) console.error(`  - ${a}`);
console.error(`处置：属保留区（协议解析 / 格式校验 / 路径集合判定 / 枚举合法判定）→ node scripts/check-no-text-assertion.mjs --update 更新基线，并在提交说明写明归类理由；属对 agent 返回文本或工具输出的证据搜索 → 改为结构化判定（agent 产枚举/布尔字段，引擎枚举/等值/集合判定），不允许合入。`);
process.exit(1);
