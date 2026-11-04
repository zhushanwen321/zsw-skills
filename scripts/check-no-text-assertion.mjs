#!/usr/bin/env node
// check-no-text-assertion.mjs — 断言路径文字匹配防回潮门禁（2026-11-04 结构化断言改造配套）
//
// 背景：四技能 workflow 引擎的断言已按「结构化断言改造」字段化（判定依据 = agent 产结构化
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
// 用法：node scripts/check-no-text-assertion.mjs [--update]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(repoRoot, "scripts", "text-assertion-baseline.json");
const TARGETS = [
  "skills/self/dev-workflow/workflows/src/dev-consistency-loop.shared.ts",
  "skills/self/dev-workflow/workflows/src/design-code-sync-loop.shared.ts",
  "skills/self/dev-workflow/workflows/src/wave-executor.shared.ts",
  "skills/self/dev-workflow/workflows/src/tech-review-loop.shared.ts",
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

const update = process.argv.includes("--update");
if (update) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 1)}\n`);
  const total = Object.values(current).reduce((n, v) => n + v.length, 0);
  console.log(`基线已更新：${total} 处存量命中（全部视为已归类保留区）。新增命中点须在提交说明写明归类理由。`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`基线快照不可读（${BASELINE}）——运行 node scripts/check-no-text-assertion.mjs --update 生成后重试`);
  process.exit(1);
}

const keyOf = (line, content) => `${line}\t${content}`;
const additions = [];
const totals = { current: 0, baseline: 0, removed: 0 };
for (const rel of TARGETS) {
  const base = new Map((baseline[rel] ?? []).map(([l, c]) => [keyOf(l, c), false]));
  totals.baseline += base.size;
  for (const [l, c] of current[rel]) {
    totals.current += 1;
    const k = keyOf(l, c);
    if (base.has(k)) base.set(k, true);
    else additions.push(`${rel}:${l}  ${c}`);
  }
  totals.removed += [...base.values()].filter((used) => !used).length;
}

if (additions.length === 0) {
  console.log(`文字匹配断言防回潮：通过（当前 ${totals.current} 处命中 ⊆ 基线 ${totals.baseline} 处；基线外新增 0；基线已收敛 ${totals.removed} 处）`);
  process.exit(0);
}

console.error(`文字匹配断言防回潮：发现 ${additions.length} 处基线外新增命中——判定路径禁止新增字面匹配（证据扫描形态已全部字段化）。逐条处置：`);
for (const a of additions) console.error(`  - ${a}`);
console.error(`处置：属保留区（协议解析 / 格式校验 / 路径集合判定 / 枚举合法判定）→ node scripts/check-no-text-assertion.mjs --update 更新基线，并在提交说明写明归类理由；属对 agent 返回文本或工具输出的证据搜索 → 改为结构化判定（agent 产枚举/布尔字段，引擎枚举/等值/集合判定），不允许合入。`);
process.exit(1);
