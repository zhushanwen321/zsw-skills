#!/usr/bin/env node
// 设计文档渲染脚本：把设计包目录内六个章节 JSON 拼装为阅读视图 <目录名>.rendered.md。
// 章节 JSON 是权威源（规格见 references/design-doc-schema.md），渲染产物非权威——
// 仅供人与审查者阅读；由写作流程在「每次章节 JSON 修改后」与「每轮修复后」调用。
//
// 渲染规则（ANCHORS 规格 §4）：
//   - 标题 + 头部表（设计分型 / P 级 / 风险分）+ 人工审核导航表 + 五段骨架各章节
//   - 长文本字段原样输出；数组渲染为 md 表格（产物表）或条目列表（决策 / 拆分单元）
//   - 决策渲染为带（A 级）/（B 级）标记的条目；§3 各节编号固定（3.1 终态与 3.4
//     迁移波次仅终态型渲染，演进型跳号省略），使 reviewNav 的 §3.3 锚点恒指决策节
//   - 渲染幂等：同输入同输出（固定字段顺序、无时间戳；缺字段渲染为 —）
//
// 用法：
//   node render-design-doc.mjs <设计目录>
// 输出：exit 0 = 已生成渲染产物（stdout 一行路径）；exit 1 = 章节 JSON 缺失 / 解析
//   失败（指明文件名与错误）或 md 输入迁移指引；exit 2 = 用法错误

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const MIGRATION_HINT =
  "本工具只接受分章节 JSON 设计目录（<name>/meta.json … s5-breakdown.json）；md 文件不是有效输入。存量 md 设计包继续处理请用技能 git 历史版本；新设计按 references/design-doc-schema.md 产出。";

const CHAPTER_FILES = [
  ["meta.json", "meta"],
  ["s1-context.json", "s1"],
  ["s2-status.json", "s2"],
  ["s3-solution.json", "s3"],
  ["s4-accept.json", "s4"],
  ["s5-breakdown.json", "s5"],
];

function failUsage(msg) {
  process.stderr.write(`用法错误：${msg}\n用法：node render-design-doc.mjs <设计目录>\n`);
  process.exit(2);
}

const designDir = process.argv[2];
if (!designDir) failUsage("缺少设计目录参数");
let dirStat;
try {
  dirStat = statSync(designDir);
} catch {
  failUsage(`设计目录不存在（${designDir}）`);
}
if (dirStat.isFile()) {
  if (designDir.endsWith(".md")) {
    process.stdout.write(MIGRATION_HINT + "\n");
    process.exit(1);
  }
  failUsage("参数须是设计包目录（含六个章节 JSON），不是单个文件");
}

// ── 读取六章节 JSON（失败指明文件名与错误） ──

const docs = {};
const loadErrors = [];
for (const [file, key] of CHAPTER_FILES) {
  let raw;
  try {
    raw = readFileSync(join(designDir, file), "utf8");
  } catch {
    loadErrors.push(`缺少 ${file}——渲染需要六个章节 JSON 全部存在（清单见 references/design-doc-schema.md）`);
    continue;
  }
  try {
    docs[key] = JSON.parse(raw);
  } catch (e) {
    loadErrors.push(`${file} 解析失败：${e.message}`);
  }
}
if (loadErrors.length > 0) {
  for (const m of loadErrors) process.stdout.write(m + "\n");
  process.exit(1);
}

// ── 渲染基础函数 ──

const arr = (v) => (Array.isArray(v) ? v : []);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";

/** 表格单元格：竖线转义、换行压成空格；缺失值显示 —（渲染不校验合法性，只忠实呈现） */
function cell(v) {
  if (isEmpty(v)) return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 长文本字段原样输出；缺失显示 — */
function prose(v) {
  return isEmpty(v) ? "—" : String(v);
}

/** md 表格：headers + rows（单元格已 cell 化的原文由调用方传入，此处只做转义） */
function table(headers, rows) {
  const lines = [
    `| ${headers.map((h) => cell(h)).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const r of rows) lines.push(`| ${r.map((c) => cell(c)).join(" | ")} |`);
  return lines.join("\n");
}

/** 数组 join 为顿号分隔串；空数组返回 null（调用方据此省略整行） */
function joinList(items) {
  const list = arr(items).filter((x) => !isEmpty(x));
  return list.length === 0 ? null : list.join("、");
}

/** 枚举值 → 中文标注（未识别的值原样显示，渲染不拦截） */
const ENUM_LABELS = {
  designType: { terminal: "终态型（terminal）", evolution: "演进型（evolution）" },
  status: { verified: "已核实（verified）", pending: "待核实（pending）" },
  nature: { authority: "权威（authority）", projection: "派生视图（projection）", cache: "缓存（cache）" },
  depNature: { contract: "契约级（contract）", observed: "观察级（observed）", bet: "押注（bet）" },
  verdict: { asset: "资产域（asset）", faulty: "故障密集域（faulty）", unfixed: "未修到（unfixed）" },
};
const label = (map, v) => (isEmpty(v) ? "—" : (map[v] ?? v));

// ── 拼装 ──

const meta = docs.meta ?? {};
const s1 = docs.s1 ?? {};
const s2 = docs.s2 ?? {};
const s3 = docs.s3 ?? {};
const s4 = docs.s4 ?? {};
const s5 = docs.s5 ?? {};
const isTerminal = meta.designType === "terminal";
const out = [];

function section(heading) {
  out.push(heading, "");
}

// 头部：标题 + 产物地位声明 + 分型 / P 级 / 风险分表

out.push(`# ${isEmpty(meta.name) ? basename(designDir) : meta.name}`);
out.push("");
out.push(
  "> 本文件由渲染脚本从六章节 JSON 生成，是阅读视图而非权威源——修改请编辑章节 JSON 后重跑 `scripts/render-design-doc.mjs`；字段规格见 `references/design-doc-schema.md`。",
);
out.push("");
section("## 头部");
const headRows = [
  ["设计分型", `${label(ENUM_LABELS.designType, meta.designType)}——${cell(meta.typeRationale)}`],
  ["功能分级", cell(meta.priority)],
  ["风险分", `${cell(meta.riskScore)}——${cell(meta.riskRationale)}`],
];
// 关联登记（relatedDocs）：空数组不渲染该行；每条「path——relation」用分号分隔
const relatedDocs = arr(meta.relatedDocs);
if (relatedDocs.length > 0) {
  headRows.push([
    "关联登记",
    relatedDocs.map((r) => `${cell(r?.path)}——${cell(r?.relation)}`).join("；"),
  ]);
}
out.push(table(["项", "值"], headRows), "");

// 人工审核导航表

section("## 人工审核导航");
out.push(
  table(
    ["锚点", "决策 id", "决策标题", "级别", "命中判据", "关键影响"],
    arr(meta.reviewNav).map((r) => [
      cell(r?.anchor),
      cell(r?.decisionId),
      cell(r?.title),
      isEmpty(r?.level) ? "—" : `${r.level} 级`,
      cell(r?.criteria),
      cell(r?.impact),
    ]),
  ),
  "",
);

// §1 背景目标

section("## 1. 背景目标");
section("### 1.1 背景");
out.push(prose(s1.background), "");
if (arr(s1.goals).length > 0) {
  section("### 1.2 设计目标");
  out.push(table(["id", "目标陈述"], arr(s1.goals).map((g) => [g?.id, g?.statement])), "");
}
section("### 1.3 范围外");
out.push(prose(s1.outOfScope), "");

// §2 现状与问题分析

section("## 2. 现状与问题分析");
section("### 2.1 使用者视角现状");
out.push(prose(s2.currentBehaviour), "");
section("### 2.2 端到端大流程图");
// 内容自带 ``` 围栏时外层升级为四反引号——同长围栏会交错截断，ASCII 图会掉出代码块
const flowText = prose(s2.flowDiagram);
const flowFence = flowText.includes("```") ? "````" : "```";
out.push(flowFence, flowText, flowFence, "");

const problems = arr(s2.problems);
if (problems.length > 0) {
  section("### 2.3 问题清单");
  out.push(
    table(["id", "环节", "现象", "根因"], problems.map((p) => [p?.id, p?.stage, p?.symptom, p?.rootCause])),
    "",
  );
}
const assumptions = arr(s2.assumptions);
if (assumptions.length > 0) {
  section("### 2.4 前提清单");
  out.push(
    table(
      ["id", "前提陈述", "状态", "核实动作", "不成立时的影响"],
      assumptions.map((a) => [a?.id, a?.statement, label(ENUM_LABELS.status, a?.status), a?.evidence, a?.impactIfFalse]),
    ),
    "",
  );
}
const assumptionExclusions = arr(s2.assumptionExclusions);
if (assumptionExclusions.length > 0) {
  section("#### 否定性断言排除记录");
  out.push(
    table(
      ["断言", "候选写者", "排除证据"],
      assumptionExclusions.map((x) => [x?.assertion, x?.candidateWriters, x?.exclusionEvidence]),
    ),
    "",
  );
}

const at = s2.artifactTables ?? {};
const stateCopies = arr(at.stateCopies);
if (stateCopies.length > 0) {
  section("### 2.5 状态副本清单");
  out.push(
    table(
      ["id", "状态", "持有位置", "性质", "同步机制", "排除依据"],
      stateCopies.map((c) => [
        c?.id,
        c?.state,
        c?.location,
        label(ENUM_LABELS.nature, c?.nature),
        c?.excluded === true ? "—" : c?.sync,
        c?.excluded === true ? c?.exclusionNote : "—",
      ]),
    ),
    "",
  );
}
const signalImplications = arr(at.signalImplications);
if (signalImplications.length > 0) {
  section("### 2.6 信号-蕴涵表");
  out.push(
    table(
      ["id", "触发信号", "设计假设它意味着", "实际意味着", "错配形态"],
      signalImplications.map((r) => [r?.id, r?.signal, r?.assumedImplies, r?.actuallyImplies, r?.mismatch]),
    ),
    "",
  );
}
const repairHistory = arr(at.repairHistory);
if (repairHistory.length > 0) {
  section("### 2.7 修复史判定表");
  out.push(
    table(
      ["id", "机制", "修复次数", "回摆情况", "定性"],
      repairHistory.map((r) => [r?.id, r?.mechanism, r?.fixCount, r?.oscillation, label(ENUM_LABELS.verdict, r?.verdict)]),
    ),
    "",
  );
}
const upstreamDeps = arr(at.upstreamDeps);
if (upstreamDeps.length > 0) {
  section("### 2.8 上游依赖清单");
  out.push(
    table(
      ["id", "依赖", "性质", "退场条件"],
      upstreamDeps.map((r) => [r?.id, r?.dependency, label(ENUM_LABELS.depNature, r?.nature), r?.exitCondition]),
    ),
    "",
  );
}

// §3 解决方案（3.1 终态与 3.4 迁移波次仅终态型渲染；编号固定使 §3.3 恒指决策节）

section("## 3. 解决方案");
const terminalForm = s3.terminalForm;
if (isTerminal && terminalForm != null && typeof terminalForm === "object") {
  section("### 3.1 终态");
  const axioms = arr(terminalForm.axioms);
  if (axioms.length > 0) {
    section("#### 公理清单");
    out.push(table(["id", "不变量陈述"], axioms.map((a) => [a?.id, a?.statement])), "");
  }
  section("#### 终态形态");
  out.push(prose(terminalForm.targetForm), "");
  const gaps = arr(terminalForm.gapTable);
  if (gaps.length > 0) {
    section("#### 终态-现状差距表");
    out.push(
      table(["id", "域", "现状", "终态", "差距说明"], gaps.map((g) => [g?.id, g?.domain, g?.current, g?.target, g?.note])),
      "",
    );
  }
}
const options = arr(s3.options);
if (options.length > 0) {
  section("### 3.2 多方案对比");
  out.push(
    table(
      ["id", "方案", "长期架构评估", "短期成本", "风险", "推荐", "成本说明"],
      options.map((o) => [
        o?.id,
        o?.name,
        o?.longTerm,
        o?.shortTerm,
        o?.risk,
        o?.recommended === true ? "✅ 推荐" : "❌",
        o?.costNote,
      ]),
    ),
    "",
  );
}
const decisions = arr(s3.decisions);
if (decisions.length > 0) {
  section("### 3.3 关键决策与权衡");
  for (const d of decisions) {
    out.push(`**${cell(d?.id)}：${cell(d?.title)}（${cell(d?.level)} 级）**`);
    out.push("");
    out.push(`- **环节**：${cell(d?.stage)}`);
    out.push(`- **采用**：${cell(d?.choice)}`);
    out.push(`- **不采用**：${cell(d?.rejected)}`);
    out.push(`- **证据**：${cell(d?.evidence)}`);
    const gapRefs = joinList(d?.gapRefs);
    if (gapRefs !== null) out.push(`- **差距引用**：${gapRefs}`);
    const unitRefs = joinList(d?.unitRefs);
    if (unitRefs !== null) out.push(`- **单元引用**：${unitRefs}`);
    const axiomRefs = joinList(d?.axiomRefs);
    if (axiomRefs !== null) out.push(`- **公理引用**：${axiomRefs}`);
    const impact = (d?.impact ?? {});
    out.push(
      `- **效果**：架构：${cell(impact.architecture)}；功能：${cell(impact.function)}；复杂度：${cell(impact.complexity)}；性能：${cell(impact.performance)}；资源：${cell(impact.resource)}；红线：${cell(impact.redline)}`,
    );
    out.push("");
  }
}
if (isTerminal) {
  const waves = arr(s3.migrationWaves);
  if (waves.length > 0) {
    section("### 3.4 迁移波次");
    out.push(
      table(
        ["id", "目标交付版本", "波次内容", "消除差距"],
        waves.map((w) => [w?.id, w?.targetVersion, w?.scope, joinList(w?.gapRefs)]),
      ),
      "",
    );
  }
}

// §4 验收

section("## 4. 验收");
const scenarios = arr(s4.scenarios);
if (scenarios.length > 0) {
  section("### 4.1 验证场景");
  out.push(
    table(
      ["id", "场景", "步骤", "通过标准", "回溯目标"],
      scenarios.map((v) => [v?.id, v?.scene, v?.steps, v?.criteria, joinList(v?.goalRefs)]),
    ),
    "",
  );
}
const redlights = arr(s4.assertionRedlights);
if (redlights.length > 0) {
  section("### 4.2 断言-红灯映射表");
  out.push(
    table(
      ["id", "运行时假设", "变红的机器检查", "补建项"],
      redlights.map((r) => [r?.id, r?.assumption, r?.redlight, r?.buildItem]),
    ),
    "",
  );
}
section("### 4.3 e2e 影响面评估");
const e2eItems = arr(s4.e2eImpact?.items);
if (e2eItems.length > 0) {
  out.push(table(["受影响测试资产", "需跑子集与命令"], e2eItems.map((i) => [i?.name, i?.action])), "");
} else {
  out.push(`无受影响项（${cell(s4.e2eImpact?.noneReason)}）`, "");
}

// §5 下一层拆分

section("## 5. 下一层拆分");
const units = arr(s5.units);
if (units.length > 0) {
  section("### 5.1 拆分单元");
  for (const u of units) {
    out.push(`**${cell(u?.id)}：${cell(u?.title)}**`);
    out.push("");
    out.push(`- **拆分理由**：${cell(u?.justification)}`);
    const files = joinList(u?.files);
    out.push(`- **文件**：${files === null ? "—" : files}`);
    const checkpoints = joinList(u?.checkpoints);
    out.push(`- **待验证检查点**：${checkpoints === null ? "—" : checkpoints}`);
    out.push("");
  }
}
section("### 5.2 文件改动地图");
out.push(prose(s5.fileMap), "");

// ── 写盘 ──

const renderedPath = join(designDir, `${basename(designDir)}.rendered.md`);
writeFileSync(renderedPath, out.join("\n"));
process.stdout.write(`已生成 ${renderedPath}\n`);
