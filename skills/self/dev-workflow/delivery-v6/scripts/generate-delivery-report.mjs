#!/usr/bin/env node
// generate-delivery-report.mjs — 机器生成交付终态报告（V5 交付完整性改造机制六·设计 §10）。
//
// 职责边界：报告的全部数字与状态由任务目录权威记录直读派生，LLM 只做解释、不决定
// 数字与状态（设计 §10：终态报告由 verdict、事件流、status 与工作流运行记录生成）。
// 缺少运行记录的项标 unknown，禁止按 0 或成功补齐——unknown 是诚实披露，不是待清除
// 的噪音（实跑实证：STEPFUN 实际 12 单元终报写 10、GLM 自修复 3 条终报写 2，均因
// 报告由 LLM 手工转抄；本脚本消除转抄层）。
//
// 数据源 → 分节映射（全部为只读；判定/校验逻辑一律 import 单源库，不另立副本）：
//   1 交付终态与判定时间   verdict.json 直读
//   2 循环尝试账           loop-attempts.jsonl → kernel-judgments parseLoopAttemptsText
//                          + loopAttemptsBudget（cap 键 LOOP_BUDGET_CAP_KEYS 单源）
//   3 执行通道统计         loop-attempts.jsonl 的 path 字段（workflow/manual 分开）+
//                          events.jsonl 的 AssuranceCompleted 计数 + workflow 观测记录
//                          （~/.agents/skill-data/workflow-observability/<task-id>/，缺=unknown）
//   4 节点执行失败与恢复   status.json → kernel-judgments projectNodeEvents 重放
//   5 偏差与自修复         self-repairs.jsonl 直读（行 schema 见 resilience.shared.ts）
//   6 revision 来源对账    kernel-judgments deriveRevisionProvenance（事件流经 gate
//                          loadWorld 加载并验签；当前 revision 证据问题与历史登记痕迹分开）
//   7 单元与节点数量       increments.json items 数 + status.json nodes 数（不数报告文字）
//
// 事件级通道归属的诚实边界：events.jsonl 事件 schema（gate EVENT_SCHEMAS）不含 runId
// 字段——gate 意图命令的 --run-id 只做写租约代次复核、不写入事件记录。因此「某条保证
// 事件由 workflow 还是手工路径登记」无法从权威记录判定，报告对该归属如实标 unknown；
// 通道区分只在 loop-attempts.jsonl 的 path 字段（覆盖已接入登记的循环）。

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_RULES,
  LOOP_BUDGET_CAP_KEYS,
  deriveRevisionProvenance,
  loopAttemptsBudget,
  parseLoopAttemptsText,
  projectNodeEvents,
} from "./lib/kernel-judgments.mjs";
import { computeRevision, loadWorld } from "./delivery-gate.mjs";

const SCRIPT_NAME = "generate-delivery-report";

function usageFail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.stderr.write(`用法：node ${SCRIPT_NAME}.mjs --task-dir <任务目录> [--status-file <dev-flow status.json>] [--out <输出路径>]\n`);
  process.exit(2);
}

function fail(message, recovery) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}${recovery ? ` 恢复动作：${recovery}` : ""}\n`);
  process.exit(1);
}

// ── 参数解析（与 delivery-core parseOptions 同形的轻量版：本脚本只有三个参数）──
const rawArgs = process.argv.slice(2);
const options = {};
for (let index = 0; index < rawArgs.length; index += 1) {
  const token = rawArgs[index];
  const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
  if (!match) usageFail(`无法解析参数 ${JSON.stringify(token)}。`);
  const key = match[1];
  if (match[2] !== undefined) {
    options[key] = match[2];
    continue;
  }
  const value = rawArgs[++index];
  if (value === undefined) usageFail(`参数 --${key} 缺值。`);
  options[key] = value;
}
for (const key of ["task-dir"]) {
  if (!(key in options)) usageFail(`缺少必填参数 --${key}。`);
}
for (const key of Object.keys(options)) {
  if (!["task-dir", "status-file", "out"].includes(key)) usageFail(`未知参数 --${key}。`);
}
const taskDir = resolve(options["task-dir"]);
if (!isAbsolute(taskDir)) usageFail("--task-dir 须为任务目录绝对路径。");
if (!existsSync(taskDir)) {
  fail(`任务目录不存在：${taskDir}`, `核对 delivery-gate init 输出的 taskDir 后重试。`);
}

// ── 通用读取：缺失 → {status:"unknown"}，可解析 → {status:"ok", ...} ──
// unknown 纪律（设计 §10 硬约束）：数据源缺失或不可解析时只记原因，不猜数字。
function readJsonIfPresent(filePath, label) {
  if (!existsSync(filePath)) return { status: "unknown", reason: `${label} 缺失` };
  try {
    return { status: "ok", value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { status: "unknown", reason: `${label} 不是合法 JSON：${error.message}` };
  }
}

function readLinesIfPresent(filePath, label) {
  if (!existsSync(filePath)) return { status: "unknown", reason: `${label} 缺失` };
  const rows = [];
  const badLines = [];
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") rows.push(parsed);
    } catch {
      badLines.push(line.slice(0, 60));
    }
  }
  return { status: "ok", rows, badLines };
}

// ── 分节 1：交付终态与判定时间（verdict.json 直读）──
const verdictFile = readJsonIfPresent(join(taskDir, "verdict.json"), "verdict.json");
const verdict = verdictFile.status === "ok" ? verdictFile.value : null;
const verdictSection =
  verdict !== null && typeof verdict === "object"
    ? {
        status: "ok",
        state: typeof verdict.state === "string" ? verdict.state : null,
        revision: typeof verdict.revision === "string" ? verdict.revision : null,
        acceptanceVersion: typeof verdict.acceptanceVersion === "number" ? verdict.acceptanceVersion : null,
        generatedAt: typeof verdict.generatedAt === "string" ? verdict.generatedAt : null,
        generatedBy: typeof verdict.generatedBy === "string" ? verdict.generatedBy : null,
        nextAction: typeof verdict.nextAction === "string" ? verdict.nextAction : null,
      }
    : { status: "unknown", reason: verdictFile.reason ?? "verdict.json 缺失" };

// ── 世界加载（分节 3/6 的事件流来源；早期任务无验收包时降级只读事件流）──
// 事件流不可读不终止整个报告：分节 1/2/5/7 不依赖事件流，照常输出；依赖事件流的
// 分节 3（保证事件数）与分节 6（对账）标 unknown——数据源坏 ≠ 报告整体不可产出。
let world = null;
let worldError = "";
try {
  world = loadWorld(taskDir);
} catch (error) {
  try {
    world = loadWorld(taskDir, { requirePackage: false });
  } catch (fallbackError) {
    world = null;
    worldError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
  }
}
const records = world !== null ? world.entries.map((entry) => entry.record) : [];
const eventsReadable = world !== null;

// ── 分节 2：循环尝试账（按 loop 分组；cap 键单源）──
const loopAttemptsFile = readLinesIfPresent(join(taskDir, "loop-attempts.jsonl"), "loop-attempts.jsonl");
const loopsSection = { status: loopAttemptsFile.status, reason: loopAttemptsFile.reason ?? null, loops: [] };
if (loopAttemptsFile.status === "ok") {
  const loopNames = [];
  for (const row of loopAttemptsFile.rows) {
    if (typeof row.loop === "string" && row.loop !== "" && !loopNames.includes(row.loop)) loopNames.push(row.loop);
  }
  for (const loopName of loopNames) {
    const capKey = LOOP_BUDGET_CAP_KEYS[loopName];
    const cap = capKey !== undefined ? KERNEL_RULES.budgets[capKey] : null;
    loopsSection.loops.push({
      loop: loopName,
      ...loopAttemptsBudget(loopAttemptsFile.rows, { loop: loopName, cap }),
      ...(capKey === undefined ? { note: `循环 ${loopName} 未接入尝试预算（已知缺口）：cap=null 表示尚无机器上界，不表示无限制` } : {}),
    });
  }
}

// ── 分节 3：执行通道统计（workflow 与手工补登记分开）──
// 判定依据：loop-attempts.jsonl 的 path 字段（workflow|manual，登记时由通道自报并经
// CLI 词表校验）。事件级归属 unknown——events.jsonl 事件 schema 无 runId 字段（见文件
// 头注释），无法判定单条保证事件出自哪条通道。
const channelsSection = { loops: loopsSection.status === "ok" ? [] : null, assuranceEvents: null, eventChannelAttribution: "unknown" };
if (loopsSection.status === "ok") {
  for (const loopRow of loopsSection.loops) {
    const byPath = { workflow: { started: 0, byOutcome: {} }, manual: { started: 0, byOutcome: {} } };
    const runIds = { workflow: new Set(), manual: new Set() };
    const seen = new Set();
    for (const row of loopAttemptsFile.rows) {
      if (row.loop !== loopRow.loop) continue;
      if (typeof row.attemptKey !== "string" || typeof row.event !== "string") continue;
      const dedupeKey = `${row.attemptKey}\u0000${row.event}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const path = row.path === "manual" ? "manual" : "workflow";
      if (row.event === "started") {
        byPath[path].started += 1;
        if (typeof row.runId === "string" && row.runId !== "") runIds[path].add(row.runId);
      }
      if (row.event === "finished" && typeof row.outcome === "string") {
        byPath[path].byOutcome[row.outcome] = (byPath[path].byOutcome[row.outcome] ?? 0) + 1;
      }
    }
    channelsSection.loops.push({
      loop: loopRow.loop,
      workflow: { ...byPath.workflow, runs: runIds.workflow.size },
      manual: { ...byPath.manual, runs: runIds.manual.size },
    });
  }
}
const assuranceByMode = {};
for (const record of records.filter((record) => record.type === "AssuranceCompleted")) {
  const mode = typeof record.mode === "string" ? record.mode : "full";
  assuranceByMode[mode] = (assuranceByMode[mode] ?? 0) + 1;
}
channelsSection.assuranceEvents = eventsReadable
  ? { total: records.filter((record) => record.type === "AssuranceCompleted").length, byMode: assuranceByMode }
  : { status: "unknown", reason: `events.jsonl 不可读：${worldError}` };

// workflow 观测记录（可选数据源；目录形态见 delivery-v6 SKILL 观测参数段）：
// <观测根>/<task-id>/<execution-id>.jsonl——每个 execution 文件一次执行。
// 不存在 = unknown（观测是可选通道，缺观测 ≠ 零次执行——历史任务与未开观测的 run 无记录）。
const observabilityRoot = join(homedir(), ".agents", "skill-data", "workflow-observability");
// taskId 优先取事件流世界的 task.json；world 不可用时直读任务目录 task.json（同一权威文件）
const taskJsonDirect = readJsonIfPresent(join(taskDir, "task.json"), "task.json");
const taskId =
  world !== null && typeof world.task.taskId === "string"
    ? world.task.taskId
    : taskJsonDirect.status === "ok" && typeof taskJsonDirect.value?.taskId === "string"
      ? taskJsonDirect.value.taskId
      : "";
const observabilityDir = taskId !== "" ? join(observabilityRoot, taskId) : "";
let observability = { status: "unknown", reason: "task.json 缺 taskId，观测目录无法定位" };
if (observabilityDir !== "") {
  if (!existsSync(observabilityDir)) {
    observability = { status: "unknown", reason: `观测目录不存在：${observabilityDir}（观测未开启或本任务无观测记录——不等于零次执行）` };
  } else {
    try {
      const executions = readdirSync(observabilityDir).filter((name) => name.endsWith(".jsonl"));
      const bySkill = {};
      for (const name of executions) {
        let skill = "unknown";
        try {
          const firstLine = readFileSync(join(observabilityDir, name), "utf8").split("\n").find((line) => line.trim() !== "");
          if (firstLine !== undefined) {
            const parsed = JSON.parse(firstLine);
            if (parsed !== null && typeof parsed === "object" && typeof parsed.skill === "string") skill = parsed.skill;
          }
        } catch {
          // 单文件首行不可解析：按 unknown 归组（观测是辅助数据源，不阻塞报告）
        }
        bySkill[skill] = (bySkill[skill] ?? 0) + 1;
      }
      observability = { status: "ok", executions: executions.length, bySkill };
    } catch (error) {
      observability = { status: "unknown", reason: `观测目录不可读：${error.message}` };
    }
  }
}
channelsSection.observability = observability;

// ── 分节 4：节点执行失败与恢复（status.json 事件重放，projectNodeEvents 单源）──
// status.json 是 dev-flow 段产物（路径在 exec-plan 的 statusPath，不在任务目录）：
// --status-file 显式传入，缺省探测任务目录内 status.json（两者都缺 = unknown）。
const statusFilePath = options["status-file"] !== undefined ? resolve(options["status-file"]) : join(taskDir, "status.json");
const statusFile = readJsonIfPresent(statusFilePath, `status.json（${statusFilePath}）`);
let nodeSection = { status: "unknown", reason: statusFile.reason ?? "status.json 缺失" };
if (statusFile.status === "ok" && statusFile.value !== null && typeof statusFile.value === "object") {
  const events = Array.isArray(statusFile.value.events) ? statusFile.value.events : [];
  const projection = projectNodeEvents(events, KERNEL_RULES.domains.node);
  const byStatus = {};
  for (const entry of Object.values(projection.nodes)) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  }
  // 失败与恢复序列（D1 呈报重点）：fail / reconcile-* / manual-disposition 按节点分组
  //（设计 §10「D1 曾失败与最终恢复分别呈现」——终态 done 不掩盖中间失败）
  const failureSequences = {};
  for (const record of events) {
    if (typeof record.node !== "string" || record.node === "" || record.node === "*") continue;
    if (!["fail", "reconcile-pending", "reconcile-done", "manual-disposition"].includes(record.event)) continue;
    if (failureSequences[record.node] === undefined) failureSequences[record.node] = [];
    failureSequences[record.node].push({ seq: record.seq, event: record.event, detail: typeof record.detail === "string" ? record.detail : "" });
  }
  nodeSection = {
    status: "ok",
    file: statusFilePath,
    eventsReplayed: events.length,
    partialEvents: projection.partialEvents,
    nodeCount: Object.keys(projection.nodes).length,
    byStatus,
    nodes: projection.nodes,
    failureSequences,
  };
}

// ── 分节 5：偏差与自修复（self-repairs.jsonl 直读计数）──
const selfRepairsFile = readLinesIfPresent(join(taskDir, "self-repairs.jsonl"), "self-repairs.jsonl");
let selfRepairsSection = { status: selfRepairsFile.status, reason: selfRepairsFile.reason ?? null };
if (selfRepairsFile.status === "ok") {
  const byKind = {};
  const byOutcome = {};
  const byWorkflow = {};
  for (const row of selfRepairsFile.rows) {
    byKind[row.kind ?? "unclassified"] = (byKind[row.kind ?? "unclassified"] ?? 0) + 1;
    byOutcome[row.outcome ?? "unclassified"] = (byOutcome[row.outcome ?? "unclassified"] ?? 0) + 1;
    byWorkflow[row.workflow ?? "unclassified"] = (byWorkflow[row.workflow ?? "unclassified"] ?? 0) + 1;
  }
  selfRepairsSection = {
    status: "ok",
    total: selfRepairsFile.rows.length,
    byKind,
    byOutcome,
    byWorkflow,
    ...(selfRepairsFile.badLines.length > 0 ? { unparseableLines: selfRepairsFile.badLines.length } : {}),
  };
}

// ── 分节 6：revision 来源对账（当前证据问题与历史登记痕迹分开）──
// currentRevision 取 verdict.json 的裁决 revision（报告与最近裁决同口径）；verdict 缺失
// 时退 computeRevision（项目当前内容）——两者都不可得则不猜，标 unknown。
// 事件流不可读时本节整体 unknown：对账输入是事件流，「无锚点」与「事件流坏」语义不同，
// 不得把后者伪装成前者。
let currentRevision = verdictSection.status === "ok" && verdictSection.revision !== null ? verdictSection.revision : null;
let currentRevisionSource = "verdict.json";
if (currentRevision === null && world !== null) {
  try {
    currentRevision = computeRevision(world.task.projectRoot);
    currentRevisionSource = "computeRevision（verdict.json 缺失，取项目当前内容指纹）";
  } catch {
    currentRevision = null;
    currentRevisionSource = "unknown（verdict.json 缺失且 revision 计算失败）";
  }
}
let provenanceSection = !eventsReadable
  ? { status: "unknown", reason: `events.jsonl 不可读：${worldError}` }
  : currentRevision === null
    ? { status: "unknown", reason: "currentRevision 不可得，对账无判定源" }
    : null;
if (provenanceSection === null) {
  const provenance = deriveRevisionProvenance(records, { currentRevision });
  const currentEvidenceProblems = provenance.revisions.filter(
    (item) => item.source === "unknown" && (item.toRevision === currentRevision || item.fromRevision === currentRevision),
  );
  provenanceSection = {
    status: "ok",
    enabled: provenance.enabled,
    currentRevision,
    currentRevisionSource,
    explainedRevision: provenance.explainedRevision,
    currentRevisionExplained: provenance.explainedRevision === currentRevision,
    unknownCount: provenance.unknownCount,
    currentEvidenceProblems,
    history: provenance.revisions,
  };
}

// ── 分节 7：单元与节点数量（直读权威文件，不数报告文字）──
const incrementsFile = readJsonIfPresent(join(taskDir, "increments.json"), "increments.json");
const incrementsSection =
  incrementsFile.status === "ok" && incrementsFile.value !== null && Array.isArray(incrementsFile.value.items)
    ? { status: "ok", unitCount: incrementsFile.value.items.length, ids: incrementsFile.value.items.map((item) => item?.id ?? "?") }
    : { status: "unknown", reason: incrementsFile.reason ?? "increments.items 缺失或非数组" };
const nodeCountSection =
  nodeSection.status === "ok"
    ? { status: "ok", dagNodeCount: nodeSection.nodeCount, source: nodeSection.file }
    : { status: "unknown", reason: nodeSection.reason };

// ── 组装 JSON 对象与 markdown 渲染 ──
const report = {
  taskDir,
  taskId: taskId !== "" ? taskId : null,
  generatedBy: SCRIPT_NAME,
  generatedAt: new Date().toISOString(),
  disclaimer: "本报告由权威记录生成；叙事解释可由 agent 补充，数字与状态以本文件为准。缺少运行记录的项标 unknown，不按 0 或成功补齐。",
  verdict: verdictSection,
  loopAttempts: loopsSection,
  channels: channelsSection,
  nodeEvents: nodeSection,
  selfRepairs: selfRepairsSection,
  revisionProvenance: provenanceSection,
  counts: { increments: incrementsSection, dagNodes: nodeCountSection },
};

const fmtUnknown = (reason) => `unknown（${reason}）`;
const fmtOutcomeMap = (byOutcome) =>
  Object.keys(byOutcome).length === 0 ? "无" : Object.entries(byOutcome).map(([outcome, count]) => `${outcome} ${count}`).join(" / ");

const lines = [];
lines.push(`# 交付终态报告（机器生成）：${taskId !== "" ? taskId : taskDir}`);
lines.push("");
lines.push("> 本报告由权威记录生成；叙事解释可由 agent 补充，数字与状态以本文件为准。缺少运行记录的项标 unknown，不按 0 或成功补齐。");
lines.push(`> 生成时间：${report.generatedAt}；任务目录：${taskDir}`);
lines.push("");

lines.push("## 1. 交付终态与判定时间");
lines.push("");
if (verdictSection.status === "ok") {
  lines.push(`- 终态（state）：${verdictSection.state ?? "unknown"}`);
  lines.push(`- 裁决 revision：${verdictSection.revision ?? "unknown"}；acceptanceVersion：${verdictSection.acceptanceVersion ?? "unknown"}`);
  lines.push(`- 判定时间：${verdictSection.generatedAt ?? "unknown"}（生成者 ${verdictSection.generatedBy ?? "unknown"}）`);
  if (verdictSection.nextAction !== null) lines.push(`- 下一步指引（nextAction 原文）：${verdictSection.nextAction}`);
} else {
  lines.push(`- ${fmtUnknown(verdictSection.reason)}——先运行 delivery-gate evaluate 生成 verdict.json 后重跑本报告`);
}
lines.push("");

lines.push("## 2. 循环尝试账（loop-attempts.jsonl，按循环分组）");
lines.push("");
if (loopsSection.status === "ok") {
  if (loopsSection.loops.length === 0) {
    lines.push("- 无循环尝试记录（loop-attempts.jsonl 为空或无合法行）——未发起过已接入登记的循环");
  } else {
    lines.push("| 循环 | started（跨 run 累计） | finished 结果分布 | 上限 | 超限 |");
    lines.push("|---|---|---|---|---|");
    for (const loop of loopsSection.loops) {
      lines.push(
        `| ${loop.loop} | ${loop.started} | ${fmtOutcomeMap(loop.byOutcome)} | ${loop.cap ?? "null（未接入）"} | ${loop.exceeded ? "**超限**" : "否"} |`,
      );
    }
    for (const loop of loopsSection.loops) {
      if (loop.note !== undefined) lines.push(`- ${loop.note}`);
    }
  }
} else {
  lines.push(`- ${fmtUnknown(loopsSection.reason)}`);
}
lines.push("");

lines.push("## 3. 执行通道统计（workflow 与手工补登记分开）");
lines.push("");
if (channelsSection.loops !== null) {
  if (channelsSection.loops.length === 0) {
    lines.push("- 已登记循环：无（未发起过已接入登记的循环）");
  } else {
    lines.push("| 循环 | 通道 | 执行次数（runId 去重） | started | finished 结果分布 |");
    lines.push("|---|---|---|---|---|");
    for (const loop of channelsSection.loops) {
      lines.push(`| ${loop.loop} | workflow | ${loop.workflow.runs} | ${loop.workflow.started} | ${fmtOutcomeMap(loop.workflow.byOutcome)} |`);
      lines.push(`| ${loop.loop} | manual（手工补登记） | ${loop.manual.runs} | ${loop.manual.started} | ${fmtOutcomeMap(loop.manual.byOutcome)} |`);
    }
  }
} else {
  lines.push(`- 已登记循环：${fmtUnknown(loopsSection.reason)}`);
}
lines.push(
  channelsSection.assuranceEvents.status === "unknown"
    ? `- 保证事件数（events.jsonl AssuranceCompleted 直读）：${fmtUnknown(channelsSection.assuranceEvents.reason)}`
    : `- 保证事件数（events.jsonl AssuranceCompleted 直读）：${channelsSection.assuranceEvents.total}（${fmtOutcomeMap(channelsSection.assuranceEvents.byMode)}）`,
);
lines.push(
  `- 单条保证事件的通道归属：unknown——events.jsonl 事件 schema 不含 runId 字段（--run-id 只做写租约复核、不写入事件），无法从权威记录判定该事件由 workflow 还是手工路径登记`,
);
if (observability.status === "ok") {
  const bySkillText = Object.entries(observability.bySkill).map(([skill, count]) => `${skill} ${count}`).join(" / ");
  lines.push(`- workflow 观测记录：${observability.executions} 个执行文件（${bySkillText || "无"}）——目录 ${observabilityDir}`);
} else {
  lines.push(`- workflow 观测记录：${fmtUnknown(observability.reason)}`);
}
lines.push("");

lines.push("## 4. 节点执行失败与恢复（status.json 事件重放）");
lines.push("");
if (nodeSection.status === "ok") {
  lines.push(`- 节点 ${nodeSection.nodeCount} 个（${Object.entries(nodeSection.byStatus).map(([status, count]) => `${status} ${count}`).join(" / ") || "无"}）；重放事件 ${nodeSection.eventsReplayed} 条；缺结构化 payload 的历史事件 ${nodeSection.partialEvents} 条`);
  const failureNodes = Object.keys(nodeSection.failureSequences);
  if (failureNodes.length === 0) {
    lines.push("- 无失败/恢复事件（fail / reconcile / manual-disposition 均未出现）");
  } else {
    lines.push("- 失败与恢复序列（曾失败的节点单独呈现，终态 done 不掩盖中间失败）：");
    for (const node of failureNodes) {
      const sequence = nodeSection.failureSequences[node].map((item) => `#${item.seq} ${item.event}${item.detail !== "" ? `（${item.detail}）` : ""}`).join(" → ");
      const terminal = nodeSection.nodes[node]?.status ?? "unknown";
      lines.push(`  - ${node}：${sequence}；终态 ${terminal}`);
    }
  }
} else {
  lines.push(`- ${fmtUnknown(nodeSection.reason)}——status.json 是 dev-flow 段产物（路径在 exec-plan 的 statusPath），经 --status-file 传入后可呈现本节`);
}
lines.push("");

lines.push("## 5. 偏差与自修复（self-repairs.jsonl 直读）");
lines.push("");
if (selfRepairsSection.status === "ok") {
  lines.push(`- 自修复事件共 ${selfRepairsSection.total} 条：${fmtOutcomeMap(selfRepairsSection.byKind) || "无"}`);
  lines.push(`- 结果分布：${fmtOutcomeMap(selfRepairsSection.byOutcome) || "无"}；来源 workflow：${fmtOutcomeMap(selfRepairsSection.byWorkflow) || "无"}`);
  if (selfRepairsSection.unparseableLines !== undefined) lines.push(`- 不可解析行 ${selfRepairsSection.unparseableLines} 条（已跳过，未计入）`);
} else {
  lines.push(`- ${fmtUnknown(selfRepairsSection.reason)}`);
}
lines.push("");

lines.push("## 6. revision 来源对账（当前证据问题与历史登记痕迹分开披露）");
lines.push("");
if (provenanceSection.status === "ok") {
  lines.push(`- 当前裁决 revision：${provenanceSection.currentRevision}（来源 ${provenanceSection.currentRevisionSource}）；对账链条解释到：${provenanceSection.explainedRevision ?? "（无锚点——候选尚未形成，不做对账）"}`);
  if (!provenanceSection.enabled) {
    lines.push("- 候选形成锚点不存在（无 ImplementationRecorded / RepairRoundRecorded / RevisionBaselineConfirmed）：对账未启用，验收起草期的项目变化不属于对账范围");
  } else {
    lines.push(`- 当前 revision 的证据问题：${provenanceSection.currentEvidenceProblems.length} 个 unknown 区间指向当前 revision；unknown 区间共 ${provenanceSection.unknownCount} 个${provenanceSection.currentRevisionExplained ? "（链条解释到当前 revision，无尾部缺口）" : "（**存在尾部缺口：当前内容无登记来源**）"}`);
    if (provenanceSection.history.length > 0) {
      lines.push("- 历史 revision 登记痕迹（按事件序）：");
      lines.push("  | from → to | 来源 | 事件 | 登记者 |");
      lines.push("  |---|---|---|---|");
      for (const item of provenanceSection.history) {
        lines.push(`  | ${item.fromRevision ?? "?"} → ${item.toRevision} | ${item.source} | ${item.eventRef ?? "（无事件可归因）"} | ${item.actor ?? "?"} |`);
      }
    } else {
      lines.push("- 历史 revision 登记痕迹：无（锚点存在但无 revision 变化记录）");
    }
  }
} else {
  lines.push(`- ${fmtUnknown(provenanceSection.reason)}`);
}
lines.push("");

lines.push("## 7. 单元与节点数量（直读权威文件）");
lines.push("");
lines.push(
  `- 单元数（increments.json items）：${incrementsSection.status === "ok" ? `${incrementsSection.unitCount}（${incrementsSection.ids.join("、") || "无"}）` : fmtUnknown(incrementsSection.reason)}`,
);
lines.push(
  `- DAG 节点数（status.json nodes）：${nodeCountSection.status === "ok" ? nodeCountSection.dagNodeCount : fmtUnknown(nodeCountSection.reason)}`,
);
lines.push("");

lines.push("## 附：JSON 数据对象");
lines.push("");
lines.push("```json");
lines.push(JSON.stringify(report, null, 2));
lines.push("```");
lines.push("");

const markdown = lines.join("\n");
if (options.out !== undefined) {
  try {
    writeFileSync(resolve(options.out), markdown, "utf8");
    process.stdout.write(`${SCRIPT_NAME}: 报告已写入 ${resolve(options.out)}（${markdown.length} 字符）\n`);
  } catch (error) {
    fail(`无法写入输出文件 ${options.out}：${error.message}`, `检查目标目录写权限后重试，或去掉 --out 改为 stdout 输出。`);
  }
} else {
  process.stdout.write(markdown);
}
