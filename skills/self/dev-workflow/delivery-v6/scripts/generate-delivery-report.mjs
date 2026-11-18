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
//                          + loopAttemptsBudget（cap 键 LOOP_BUDGET_CAP_KEYS 单源）；
//                          修复进度（verdict.quality.repairRounds 直读 + 验收复审首次
//                          通过轮次 = started 序列里首个 passed 的尝试序号）
//   3 执行通道统计         loop-attempts.jsonl 的 path 字段（workflow/manual 分开）+
//                          events.jsonl 的 AssuranceCompleted 计数 + workflow 观测记录
//                          （~/.agents/skill-data/workflow-observability/<task-id>/，缺=unknown）
//   4 节点执行失败与恢复   status.json → kernel-judgments projectNodeEvents 重放
//   5 偏差与自修复         self-repairs.jsonl 直读（行 schema 见 resilience.shared.ts）
//   6 revision 来源对账    kernel-judgments deriveRevisionProvenance（事件流经 gate
//                          loadWorld 加载并验签；当前 revision 证据问题与历史登记痕迹分开）
//   7 单元与节点数量       increments.json items 数 + status.json nodes 数（不数报告文字）
//   8 宿主类断言证据覆盖   acceptance.json 的 requiredEnvironment 声明 × verdict 断言
//                          证据状态（gate evaluate 已并入环境档位核对，覆盖 = 存在 verified）
//   9 未决待办             pending-actions.json open 计数直读（损坏标 unknown，不冒充 0）
//   首段 runtime readiness verdict.runtimeReadiness 直读（overall 四态 + 逐契约能力状态；
//                          缺 verdict / 缺字段 → unknown——设计《V6 运行可用性升级》§12.1：
//                          报告首段披露，防文字画像与机器结论脱节）
//  10 外部契约清单         acceptance.json externalContracts（契约 id + essential）×
//                          environment-contracts.current.json 指针 → <sha>.json 快照
//                          （resolver 状态 + aggregateHash；指针/快照缺 → unknown）
//  11 runtime probe 统计   events.jsonl EvidenceRecorded(runtimeProbe=true) × probe artifact
//                          JSON（cases 实算通过率 + summary skipped 直读；artifact 不可读
//                          不冒充 0）
//  12 证据环境计数         全部 EvidenceRecorded 事件 × artifact environment.kind 三类分列
//                          （official-runner / real-host / fake-host；无法归类的逐条披露）
//  13 parity 差异清单      evidence/fake-host-parity-*.json（IA 落盘：records/mismatches/
//                          problems；§8.3——差异不是立即失败，披露 + 处置指引）
//  14 工具链与验证资产     project-capabilities.json 摘录（--capabilities-file 或任务目录
//                          内探测；文件缺 → unknown，沿用 status.json 同款可选参数模式）
//
// 口径边界：产品运行成本由验收判据测量，不在本报告；跨任务度量（反例实现误判数、
// 修复后同族缺陷复发数、终报与权威记录差异）不在单任务报告产出——终报由本脚本从
// 权威记录机器生成，差异结构性为零（头部声明同文）。
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
  process.stderr.write(`用法：node ${SCRIPT_NAME}.mjs --task-dir <任务目录> [--status-file <dev-flow status.json>] [--capabilities-file <project-capabilities.json>] [--out <输出路径>]\n`);
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
  if (!["task-dir", "status-file", "capabilities-file", "out"].includes(key)) usageFail(`未知参数 --${key}。`);
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

// ── 首段披露：runtime readiness（设计《V6 运行可用性升级》§12.1，verdict.runtimeReadiness
// 直读）──。readiness 是 accepted 判定的机器结论（overall 四态 + 逐契约能力状态），报告
// 首段照登防止文字画像与机器结论脱节；verdict 缺失或字段缺失 → unknown（缺字段常见于
// 升级前旧 verdict，恢复动作 = 重跑 evaluate），不猜 established。
const runtimeReadinessSection = (() => {
  if (verdictSection.status !== "ok" || verdict === null || typeof verdict !== "object") {
    return { status: "unknown", reason: verdictSection.reason ?? "verdict.json 缺失" };
  }
  const readiness = verdict.runtimeReadiness;
  if (readiness === null || readiness === undefined || typeof readiness !== "object" || typeof readiness.overall !== "string") {
    return { status: "unknown", reason: "verdict.json 无 runtimeReadiness 字段（升级前旧 verdict 或 evaluate 版本过旧）——重跑 delivery-gate evaluate 后重新生成报告" };
  }
  const contracts = Array.isArray(readiness.contracts) ? readiness.contracts : [];
  return {
    status: "ok",
    overall: readiness.overall,
    overallLegal: ["established", "not-established", "unknown", "not-applicable"].includes(readiness.overall),
    contracts: contracts.map((contract) => ({
      contractId: contract?.contractId ?? "?",
      essential: contract?.essential === true,
      authorityHash: typeof contract?.authorityHash === "string" ? contract.authorityHash : null,
      authorityStatus: contract?.authorityStatus ?? "unknown",
      capabilities: Array.isArray(contract?.capabilities)
        ? contract.capabilities.map((capability) => ({
            id: capability?.id ?? "?",
            state: capability?.state ?? "unknown",
            reason: typeof capability?.reason === "string" ? capability.reason : null,
            evidenceEventId: capability?.evidenceEventId ?? null,
          }))
        : [],
    })),
    ...(Array.isArray(readiness.nonEssentialGaps) && readiness.nonEssentialGaps.length > 0 ? { nonEssentialGaps: readiness.nonEssentialGaps } : {}),
  };
})();

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

// ── 修复进度（设计 §13.2「首次验收通过轮次与全部尝试轮次分别统计」）──
// 修复轮数 = verdict.quality.repairRounds 直读；验收复审首次通过轮次 = acceptance-review
// 循环 started 序列里首个 finished outcome=passed 的尝试序号（按 loop-attempts.jsonl 文件序，
// attemptKey 首次 started 记序——去重口径与 loopAttemptsBudget 一致），无 passed 尝试标 unknown
let firstPassedRound = null;
if (loopAttemptsFile.status === "ok") {
  const roundByAttempt = new Map();
  for (const row of loopAttemptsFile.rows) {
    if (row.loop !== "acceptance-review") continue;
    if (typeof row.attemptKey !== "string" || typeof row.event !== "string") continue;
    if (row.event === "started" && !roundByAttempt.has(row.attemptKey)) roundByAttempt.set(row.attemptKey, roundByAttempt.size + 1);
    if (row.event === "finished" && row.outcome === "passed" && roundByAttempt.has(row.attemptKey)) {
      firstPassedRound = roundByAttempt.get(row.attemptKey);
      break;
    }
  }
}
const repairProgressSection = {
  repairRounds:
    verdictSection.status === "ok" && verdict !== null && typeof verdict.quality?.repairRounds === "number"
      ? verdict.quality.repairRounds
      : { status: "unknown", reason: "verdict.json 缺失或 quality.repairRounds 不可读" },
  acceptanceReviewFirstPassedRound:
    loopAttemptsFile.status !== "ok"
      ? { status: "unknown", reason: loopAttemptsFile.reason ?? "loop-attempts.jsonl 不可读" }
      : firstPassedRound === null
        ? { status: "unknown", reason: "验收复审无 passed 尝试（尚未通过或未发起）" }
        : { status: "ok", round: firstPassedRound },
};

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

// ── 分节 8：宿主类断言证据覆盖（设计 §13.2「宿主类断言真实环境证据覆盖率」）──
// 数据源：盘上 acceptance.json 的 requiredEnvironment 声明（宿主类断言清单）+ verdict 的
// 断言证据状态（verdict.requirements[].assertions[].evidence[].result）。gate evaluate 已把
// 环境档位核对并入 result（宿主类证据不满足 requiredEnvironment 时 verified 降级 partial），
// 因此「覆盖」= 该断言存在 result=verified 的证据条目——本节做覆盖统计，不重复实现环境
// 判定。schema 1 验收包无断言级声明，宿主类断言为 0（如实标注，不是缺数据）。
const acceptanceFile = readJsonIfPresent(join(taskDir, "acceptance.json"), "acceptance.json");
let hostCoverageSection = { status: "unknown", reason: null, total: null, covered: null, uncovered: [] };
if (acceptanceFile.status !== "ok") {
  hostCoverageSection.reason = acceptanceFile.reason;
} else if (verdictSection.status !== "ok") {
  hostCoverageSection.reason = "verdict.json 缺失——断言证据状态不可得（先运行 delivery-gate evaluate）";
} else if (acceptanceFile.value?.schemaVersion !== 2) {
  hostCoverageSection = { status: "ok", total: 0, covered: 0, uncovered: [], note: "验收包为 schema 1（需求级判定），无断言级宿主环境声明" };
} else {
  const assertionEvidenceById = new Map();
  for (const requirement of verdict.requirements ?? []) {
    for (const assertion of requirement.assertions ?? []) {
      assertionEvidenceById.set(assertion.id, assertion.evidence ?? []);
    }
  }
  const hostAssertions = [];
  for (const requirement of acceptanceFile.value.requirements ?? []) {
    for (const assertion of requirement.assertions ?? []) {
      if (assertion !== null && typeof assertion === "object" && assertion.requiredEnvironment !== undefined && assertion.requiredEnvironment !== null) {
        hostAssertions.push(assertion);
      }
    }
  }
  const isCovered = (assertion) => (assertionEvidenceById.get(assertion.id) ?? []).some((entry) => entry?.result === "verified");
  hostCoverageSection = {
    status: "ok",
    total: hostAssertions.length,
    covered: hostAssertions.filter(isCovered).length,
    uncovered: hostAssertions.filter((assertion) => !isCovered(assertion)).map((assertion) => ({ id: assertion.id, requiredEnvironment: assertion.requiredEnvironment })),
  };
}

// ── 分节 9：未决待办（pending-actions.json open 计数直读）──
// 容忍形态与 delivery-core readPending 的查询路径一致：文件损坏标 unknown 并披露原因，
// 不冒充 0——blocking 待办不得按不存在处理（交付义务 pending 类的 accepted 前置）
const pendingSection = (() => {
  const filePath = join(taskDir, "pending-actions.json");
  if (!existsSync(filePath)) return { status: "unknown", reason: "pending-actions.json 缺失" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      status: "ok",
      open: items.filter((item) => item !== null && typeof item === "object" && item.status === "open").length,
      total: items.length,
    };
  } catch (error) {
    return { status: "unknown", reason: `pending-actions.json 不是合法 JSON：${error.message}` };
  }
})();

// ── 证据 artifact 直读（分节 11/12 共用）──
// EvidenceRecorded.artifact 两形态都合法：gate 意图命令登记 taskDir 相对路径，IA workflow
// 落盘绝对路径。artifact 不可解析 → unknown 并记原因——证据文件坏了不冒充「无环境」。
function readEvidenceArtifactDoc(artifact) {
  if (typeof artifact !== "string" || artifact === "") return { status: "unknown", reason: "事件缺 artifact 字段" };
  const path = isAbsolute(artifact) ? artifact : join(taskDir, artifact);
  return readJsonIfPresent(path, `证据 artifact ${artifact}`);
}

// ── 分节 10：外部契约清单（acceptance.externalContracts × 环境契约快照）──
// 契约 id 与 essential 的唯一权威 = 验收包声明；resolver 状态与 aggregateHash 唯一权威 =
// environment-contracts.current.json 指针指向的按哈希分文件快照（resolve-external-contracts
// --write 产物）。声明了契约但快照缺条目 → resolver 状态 unknown（不冒充 resolved，也不
// 冒充 unavailable——「未解析」与「解析后不可用」语义不同）。未声明 externalContracts
// 是确定事实（contracts: []），不是缺数据。
const externalContractsSection = (() => {
  if (acceptanceFile.status !== "ok") {
    return { status: "unknown", reason: acceptanceFile.reason ?? "acceptance.json 缺失", declaredCount: null, contracts: null, snapshotAvailable: false, snapshotReason: null };
  }
  const declared = Array.isArray(acceptanceFile.value?.externalContracts) ? acceptanceFile.value.externalContracts : [];
  let snapshotAvailable = false;
  let snapshotReason = null;
  let snapshotSha256 = null;
  let snapshotContracts = [];
  const pointer = readJsonIfPresent(join(taskDir, "environment-contracts.current.json"), "environment-contracts.current.json");
  if (pointer.status !== "ok") {
    snapshotReason = `${pointer.reason}（未运行 resolve-external-contracts --write）`;
  } else if (typeof pointer.value?.snapshotPath !== "string" || pointer.value.snapshotPath === "") {
    snapshotReason = "current 指针缺 snapshotPath 字段（指针损坏）——重跑 resolve-external-contracts --write 重建";
  } else {
    const snapshotFile = readJsonIfPresent(join(taskDir, pointer.value.snapshotPath), `环境契约快照 ${pointer.value.snapshotPath}`);
    if (snapshotFile.status !== "ok" || !Array.isArray(snapshotFile.value?.contracts)) {
      // 快照手改/损坏的恢复动作（§4.3）：重跑 resolve --write 重建，不手工修复
      snapshotReason = snapshotFile.status !== "ok"
        ? `${snapshotFile.reason}——重跑 resolve-external-contracts --write 重建`
        : "快照 contracts 缺失或非数组（快照损坏）——重跑 resolve-external-contracts --write 重建";
    } else {
      snapshotAvailable = true;
      snapshotSha256 = typeof pointer.value.snapshotSha256 === "string" ? pointer.value.snapshotSha256 : null;
      snapshotContracts = snapshotFile.value.contracts;
    }
  }
  return {
    status: "ok",
    declaredCount: declared.length,
    snapshotAvailable,
    snapshotReason,
    snapshotSha256,
    contracts: declared.map((contract) => {
      const entry = snapshotContracts.find((item) => item !== null && typeof item === "object" && item.id === contract?.id);
      return {
        id: contract?.id ?? "?",
        essential: contract?.essential === true,
        resolverStatus: entry === undefined ? "unknown" : entry.status ?? "unknown",
        resolverKind: entry?.resolver?.kind ?? null,
        // 快照文件字段名 aggregateHash（resolve --write 落盘形态）；stdout 摘要形态叫
        // authorityAggregateHash——两形态并存兼容，避免消费端断裂
        aggregateHash: entry?.aggregateHash ?? entry?.authorityAggregateHash ?? null,
      };
    }),
  };
})();

// ── 分节 11：runtime probe 统计（EvidenceRecorded runtimeProbe=true × probe artifact）──
// 次数 = 事件数；通过率与 skipped 由 artifact cases 实算（观察值不只 passed 布尔，failed
// case 的 observed 是契约形态的定位线索——失败 case 是正常发现入口，逐条披露不隐藏）。
// artifact 不可读的 probe 单独计数，不计入 cases 汇总（不冒充 0 cases）。
const runtimeProbeSection = (() => {
  if (!eventsReadable) {
    return { status: "unknown", reason: `events.jsonl 不可读：${worldError}`, probes: null, totals: null };
  }
  const probeEvents = records.filter((record) => record.type === "EvidenceRecorded" && record.runtimeProbe === true);
  const probes = probeEvents.map((event) => {
    const base = {
      eventId: event.eventId ?? null,
      artifact: event.artifact ?? null,
      contractCapabilityIds: Array.isArray(event.contractCapabilityIds) ? event.contractCapabilityIds : [],
    };
    const doc = readEvidenceArtifactDoc(event.artifact);
    if (doc.status !== "ok") {
      return { ...base, artifactReadable: false, artifactUnknownReason: doc.reason, caseStats: { status: "unknown", reason: doc.reason } };
    }
    const cases = Array.isArray(doc.value?.cases) ? doc.value.cases : [];
    const caseStats = { status: "ok", total: cases.length, passed: 0, failed: 0, withoutVerdict: 0 };
    const failingCases = [];
    for (const item of cases) {
      if (item?.passed === true) caseStats.passed += 1;
      else {
        // passed=false 或无 passed 判定都进披露明细；无判定不计失败（不冒充 failed）
        if (item?.passed === false) caseStats.failed += 1;
        else caseStats.withoutVerdict += 1;
        failingCases.push({
          capabilityId: item?.capabilityId ?? "?",
          judged: item?.passed === false,
          operation: typeof item?.operation === "string" ? item.operation : "",
          observed: item?.observed !== null && item?.observed !== undefined && typeof item.observed === "object" ? item.observed : null,
        });
      }
    }
    return {
      ...base,
      artifactReadable: true,
      environmentKind: doc.value?.environment?.kind ?? null,
      caseStats,
      // 驱动自报 summary 直读（IA 校验纪律：跳过落为 failed case + observed 记理由，
      // skipped 一般为 0；非 0 或缺 summary 都照实呈现）
      summary: doc.value?.summary !== null && doc.value?.summary !== undefined && typeof doc.value.summary === "object" ? doc.value.summary : null,
      ...(failingCases.length > 0 ? { failingCases } : {}),
    };
  });
  const readable = probes.filter((probe) => probe.caseStats.status === "ok");
  const totals = {
    probeCount: probeEvents.length,
    unreadableArtifacts: probes.length - readable.length,
    cases: { total: 0, passed: 0, failed: 0, withoutVerdict: 0 },
    skippedFromSummary: 0,
  };
  for (const probe of readable) {
    totals.cases.total += probe.caseStats.total;
    totals.cases.passed += probe.caseStats.passed;
    totals.cases.failed += probe.caseStats.failed;
    totals.cases.withoutVerdict += probe.caseStats.withoutVerdict;
    totals.skippedFromSummary += typeof probe.summary?.skipped === "number" ? probe.summary.skipped : 0;
  }
  return { status: "ok", probes, totals };
})();

// ── 分节 12：证据环境计数（全部 EvidenceRecorded × artifact environment.kind）──
// 三类分列是设计 §12.2 第 3 条（official-runner / real-host / fake-host）；kind 缺失或
// 词表外的证据逐条披露（无法归类的证据不能悄悄计入任何一类）。
const evidenceEnvironmentSection = (() => {
  if (!eventsReadable) {
    return { status: "unknown", reason: `events.jsonl 不可读：${worldError}`, total: null, counts: null, missingEnvironment: [] };
  }
  const evidenceEvents = records.filter((record) => record.type === "EvidenceRecorded");
  const counts = { "official-runner": 0, "real-host": 0, "fake-host": 0 };
  const missingEnvironment = [];
  for (const event of evidenceEvents) {
    const doc = readEvidenceArtifactDoc(event.artifact);
    const kind = doc.status === "ok" ? doc.value?.environment?.kind : undefined;
    if (typeof kind === "string" && kind in counts) counts[kind] += 1;
    else {
      missingEnvironment.push({
        eventId: event.eventId ?? null,
        artifact: event.artifact ?? null,
        reason: doc.status !== "ok" ? doc.reason : kind === undefined ? "artifact 无 environment 字段" : `environment.kind=${JSON.stringify(kind)} 不在证据环境词表`,
      });
    }
  }
  return { status: "ok", total: evidenceEvents.length, counts, missingEnvironment };
})();

// ── 分节 13：fake-host parity 差异清单（IA 落盘 evidence/fake-host-parity-*.json）──
// 落盘形态（independent-assurance-v6）：{records[], mismatches[], problems[]}。无文件 =
// 无 parity 记录（IA 无 parity 义务或无记录时不落盘）——是确定事实，但「无记录」不等于
// 「已验证无差异」，note 明示。差异样本（mismatches）不是立即失败：披露 + 处置指引（§8.3）。
const paritySection = (() => {
  const evidenceDir = join(taskDir, "evidence");
  let files = [];
  if (existsSync(evidenceDir)) {
    try {
      files = readdirSync(evidenceDir).filter((name) => name.startsWith("fake-host-parity-") && name.endsWith(".json")).sort();
    } catch (error) {
      return { status: "unknown", reason: `evidence 目录不可读：${error.message}`, files: null, records: null, mismatches: null, problems: null, unreadableFiles: [] };
    }
  }
  const parityRecords = [];
  const mismatches = [];
  const problems = [];
  const unreadableFiles = [];
  for (const name of files) {
    const parsed = readJsonIfPresent(join(evidenceDir, name), name);
    if (parsed.status !== "ok") {
      unreadableFiles.push({ file: name, reason: parsed.reason });
      continue;
    }
    const doc = parsed.value;
    if (Array.isArray(doc?.records)) parityRecords.push(...doc.records);
    if (Array.isArray(doc?.mismatches)) mismatches.push(...doc.mismatches);
    if (Array.isArray(doc?.problems)) problems.push(...doc.problems);
  }
  return {
    status: "ok",
    files: files.length,
    records: parityRecords,
    mismatches,
    problems,
    unreadableFiles,
    ...(files.length === 0 ? { note: "无 fake-host parity 记录文件——IA 无 parity 义务或无 parity 记录时不落盘；无记录 ≠ 已验证无差异" } : {}),
  };
})();

// ── 分节 14：工具链与验证资产状态（project-capabilities.json 摘录）──
// 快照落 dev-flow 段 skill-data（寻址依赖 projectRoot 探针），报告不复制寻址算法——
// --capabilities-file 显式传入（与 status.json 同款可选参数模式），缺省探测任务目录内
// 副本；两者都缺 → unknown。toolchain/testConfig 是探测事实摘录，不缓存执行结果。
const capabilitiesPath = options["capabilities-file"] !== undefined ? resolve(options["capabilities-file"]) : join(taskDir, "project-capabilities.json");
const toolchainSection = (() => {
  const file = readJsonIfPresent(capabilitiesPath, `project-capabilities.json（${capabilitiesPath}）`);
  if (file.status !== "ok") {
    return { status: "unknown", reason: file.reason, file: capabilitiesPath, toolchain: null, testConfig: null };
  }
  const value = file.value;
  return {
    status: "ok",
    file: capabilitiesPath,
    toolchain: Array.isArray(value?.toolchain)
      ? value.toolchain.map((entry) => ({ id: entry?.id ?? "?", status: entry?.status ?? "unknown", command: entry?.command ?? null }))
      : { status: "unknown", reason: "toolchain 缺失或非数组（快照版本过旧）——重跑 detect-project-capabilities 重建" },
    testConfig: Array.isArray(value?.testConfig)
      ? value.testConfig.map((entry) => ({ runner: entry?.runner ?? "?", zeroTestPassThrough: entry?.zeroTestPassThrough === true }))
      : { status: "unknown", reason: "testConfig 缺失或非数组（快照版本过旧）——重跑 detect-project-capabilities 重建" },
  };
})();

// ── 组装 JSON 对象与 markdown 渲染 ──
const report = {
  taskDir,
  taskId: taskId !== "" ? taskId : null,
  generatedBy: SCRIPT_NAME,
  generatedAt: new Date().toISOString(),
  disclaimer: "本报告由权威记录生成；叙事解释可由 agent 补充，数字与状态以本文件为准。缺少运行记录的项标 unknown，不按 0 或成功补齐。产品运行成本由验收判据测量，不在本报告；跨任务度量（反例实现误判数、修复后同族缺陷复发数、终报与权威记录差异）不在单任务报告产出——终报由本脚本从权威记录机器生成，差异结构性为零。",
  verdict: verdictSection,
  runtimeReadiness: runtimeReadinessSection,
  loopAttempts: loopsSection,
  repairProgress: repairProgressSection,
  channels: channelsSection,
  nodeEvents: nodeSection,
  selfRepairs: selfRepairsSection,
  revisionProvenance: provenanceSection,
  hostEvidenceCoverage: hostCoverageSection,
  pendingActions: pendingSection,
  externalContracts: externalContractsSection,
  runtimeProbes: runtimeProbeSection,
  evidenceEnvironments: evidenceEnvironmentSection,
  parity: paritySection,
  toolchainAssets: toolchainSection,
  counts: { increments: incrementsSection, dagNodes: nodeCountSection },
};

const fmtUnknown = (reason) => `unknown（${reason}）`;
const fmtOutcomeMap = (byOutcome) =>
  Object.keys(byOutcome).length === 0 ? "无" : Object.entries(byOutcome).map(([outcome, count]) => `${outcome} ${count}`).join(" / ");

const lines = [];
lines.push(`# 交付终态报告（机器生成）：${taskId !== "" ? taskId : taskDir}`);
lines.push("");
lines.push("> 本报告由权威记录生成；叙事解释可由 agent 补充，数字与状态以本文件为准。缺少运行记录的项标 unknown，不按 0 或成功补齐。");
lines.push("> 口径：产品运行成本由验收判据测量，不在本报告；跨任务度量（反例实现误判数、修复后同族缺陷复发数、终报与权威记录差异）不在单任务报告产出——终报由本脚本从权威记录机器生成，差异结构性为零。");
lines.push(`> 生成时间：${report.generatedAt}；任务目录：${taskDir}`);
lines.push("");

lines.push("## 1. 交付终态与判定时间");
lines.push("");
if (verdictSection.status === "ok") {
  lines.push(`- 终态（state）：${verdictSection.state ?? "unknown"}`);
  lines.push(`- 裁决 revision：${verdictSection.revision ?? "unknown"}；acceptanceVersion：${verdictSection.acceptanceVersion ?? "unknown"}`);
  lines.push(`- 判定时间：${verdictSection.generatedAt ?? "unknown"}（生成者 ${verdictSection.generatedBy ?? "unknown"}）`);
  if (verdictSection.nextAction !== null) lines.push(`- 下一步指引（nextAction 原文）：${verdictSection.nextAction}`);
  // 首段 runtime readiness 披露（设计 §12.1）：机器结论照登，防文字画像与 verdict 脱节
  if (runtimeReadinessSection.status === "ok") {
    lines.push(`- 运行可用性（runtime readiness，verdict 直读）：overall=${runtimeReadinessSection.overall}${runtimeReadinessSection.overallLegal ? "" : "（词表外值，如实照登）"}`);
    for (const contract of runtimeReadinessSection.contracts) {
      lines.push(`  - 契约 ${contract.contractId}（${contract.essential ? "essential" : "非 essential"}）：authority=${contract.authorityStatus}${contract.authorityHash !== null ? `（hash ${contract.authorityHash.slice(0, 12)}…）` : ""}`);
      for (const capability of contract.capabilities) {
        lines.push(`    - 能力 ${capability.id}：${capability.state}${capability.reason !== null ? `（${capability.reason}）` : ""}${capability.evidenceEventId !== null ? `（证据 ${capability.evidenceEventId}）` : ""}`);
      }
    }
    if (Array.isArray(runtimeReadinessSection.nonEssentialGaps)) {
      for (const gap of runtimeReadinessSection.nonEssentialGaps) {
        lines.push(`  - 非增强契约缺口（不进入 overall，逐条披露）：${gap.contractId ?? "?"} 能力 ${gap.capabilityId ?? "?"} 状态 ${gap.state ?? "unknown"}（${gap.reason ?? "无理由记录"}）`);
      }
    }
  } else {
    lines.push(`- 运行可用性（runtime readiness）：${fmtUnknown(runtimeReadinessSection.reason)}`);
  }
} else {
  lines.push(`- ${fmtUnknown(verdictSection.reason)}——先运行 delivery-gate evaluate 生成 verdict.json 后重跑本报告`);
  lines.push(`- 运行可用性（runtime readiness）：${fmtUnknown(runtimeReadinessSection.reason)}`);
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
lines.push(
  `- 修复轮数（verdict.quality.repairRounds 直读）：${typeof repairProgressSection.repairRounds === "number" ? repairProgressSection.repairRounds : fmtUnknown(repairProgressSection.repairRounds.reason)}`,
);
lines.push(
  `- 验收复审首次通过轮次（started 序列里首个 passed 尝试的序号）：${repairProgressSection.acceptanceReviewFirstPassedRound.status === "ok" ? `第 ${repairProgressSection.acceptanceReviewFirstPassedRound.round} 次` : fmtUnknown(repairProgressSection.acceptanceReviewFirstPassedRound.reason)}`,
);
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

lines.push("## 8. 宿主类断言证据覆盖（requiredEnvironment 声明 × verdict 断言证据状态）");
lines.push("");
if (hostCoverageSection.status === "ok") {
  if (hostCoverageSection.total === 0) {
    lines.push(`- 宿主类断言（带 requiredEnvironment 声明）：0 条${hostCoverageSection.note !== undefined ? `——${hostCoverageSection.note}` : ""}`);
  } else {
    lines.push(`- 宿主类断言 ${hostCoverageSection.total} 条：覆盖 ${hostCoverageSection.covered}、未覆盖 ${hostCoverageSection.uncovered.length}——覆盖 = 存在 result=verified 的证据条目（gate evaluate 已并入环境档位核对：宿主类证据不满足 requiredEnvironment 时 verified 降级 partial）`);
    for (const item of hostCoverageSection.uncovered) {
      lines.push(`  - 未覆盖：${item.id}（requiredEnvironment：${JSON.stringify(item.requiredEnvironment)}）`);
    }
  }
} else {
  lines.push(`- ${fmtUnknown(hostCoverageSection.reason)}`);
}
lines.push("");

lines.push("## 9. 未决待办（pending-actions.json 直读）");
lines.push("");
if (pendingSection.status === "ok") {
  lines.push(`- open 待办 ${pendingSection.open} 条 / 总计 ${pendingSection.total} 条——open 待办即交付义务的 pending 类（accepted 前置），关闭走 delivery-core pending resolve`);
} else {
  lines.push(`- ${fmtUnknown(pendingSection.reason)}`);
}
lines.push("");

lines.push("## 10. 外部契约清单与权威哈希（acceptance.externalContracts × 环境契约快照）");
lines.push("");
if (externalContractsSection.status !== "ok") {
  lines.push(`- ${fmtUnknown(externalContractsSection.reason)}`);
} else if (externalContractsSection.declaredCount === 0) {
  lines.push("- 验收包未声明 externalContracts：本任务无外部契约依赖（不是缺数据）");
} else {
  lines.push(externalContractsSection.snapshotAvailable
    ? `- 环境契约快照：可用（snapshotSha256 ${externalContractsSection.snapshotSha256 ?? "unknown"}）`
    : `- 环境契约快照：${fmtUnknown(externalContractsSection.snapshotReason)}`);
  lines.push("");
  lines.push("| 契约 | essential | resolver 状态 | resolver | aggregateHash |");
  lines.push("|---|---|---|---|---|");
  for (const contract of externalContractsSection.contracts) {
    lines.push(`| ${contract.id} | ${contract.essential ? "是" : "否"} | ${contract.resolverStatus} | ${contract.resolverKind ?? "unknown"} | ${contract.aggregateHash ?? "unknown"} |`);
  }
}
lines.push("");

lines.push("## 11. runtime probe 统计（EvidenceRecorded runtimeProbe=true × probe artifact 直读）");
lines.push("");
if (runtimeProbeSection.status !== "ok") {
  lines.push(`- ${fmtUnknown(runtimeProbeSection.reason)}`);
} else if (runtimeProbeSection.totals.probeCount === 0) {
  lines.push("- 无 runtime probe 证据事件（0 次——事件流可读，缺 probe 是确定事实；essential 契约的 runtime 义务因此保持 open，结论以 verdict.runtimeReadiness 为准）");
} else {
  for (const probe of runtimeProbeSection.probes) {
    if (probe.caseStats.status !== "ok") {
      lines.push(`- probe ${probe.eventId ?? "?"}（${probe.artifact}）：${fmtUnknown(probe.caseStats.reason)}`);
      continue;
    }
    const stats = probe.caseStats;
    const summaryNote = probe.summary !== null && typeof probe.summary.skipped === "number" ? `；驱动自报 summary skipped ${probe.summary.skipped}` : "";
    lines.push(`- probe ${probe.eventId ?? "?"}（${probe.artifact}，环境 ${probe.environmentKind ?? "unknown"}）：cases ${stats.total}、passed ${stats.passed}、failed ${stats.failed}${stats.withoutVerdict > 0 ? `、无 passed 判定 ${stats.withoutVerdict}` : ""}${summaryNote}`);
    for (const item of probe.failingCases ?? []) {
      const observedText = item.observed === null ? "（无 observed 键值）" : JSON.stringify(item.observed);
      lines.push(`  - ${item.judged ? "failed" : "无判定"} case（${item.capabilityId}）：${item.operation || "（无 operation）"} → observed ${observedText}`);
    }
  }
  const totals = runtimeProbeSection.totals;
  const passRate = totals.cases.total > 0 ? `${Math.round((totals.cases.passed / totals.cases.total) * 100)}%` : "unknown（无 cases）";
  lines.push(`- 汇总：probe ${totals.probeCount} 次、cases ${totals.cases.total}、通过 ${totals.cases.passed}（通过率 ${passRate}）、failed ${totals.cases.failed}${totals.cases.withoutVerdict > 0 ? `、无 passed 判定 ${totals.cases.withoutVerdict}（按 unknown 披露，不计入通过/失败）` : ""}${totals.skippedFromSummary > 0 ? `、summary skipped ${totals.skippedFromSummary}` : ""}${totals.unreadableArtifacts > 0 ? `；artifact 不可读 ${totals.unreadableArtifacts} 个（未计入 cases 汇总）` : ""}`);
}
lines.push("");

lines.push("## 12. 证据环境计数（全部 EvidenceRecorded × artifact environment.kind）");
lines.push("");
if (evidenceEnvironmentSection.status !== "ok") {
  lines.push(`- ${fmtUnknown(evidenceEnvironmentSection.reason)}`);
} else {
  const counts = evidenceEnvironmentSection.counts;
  lines.push(`- 证据事件 ${evidenceEnvironmentSection.total} 条：official-runner ${counts["official-runner"]}、real-host ${counts["real-host"]}、fake-host ${counts["fake-host"]}${evidenceEnvironmentSection.missingEnvironment.length > 0 ? `、无法归类 ${evidenceEnvironmentSection.missingEnvironment.length}` : ""}`);
  for (const item of evidenceEnvironmentSection.missingEnvironment) {
    lines.push(`  - 无法归类：${item.eventId ?? "?"}（${item.artifact}）——${item.reason}`);
  }
}
lines.push("");

lines.push("## 13. fake-host parity 差异清单（IA 落盘 fake-host-parity-*.json）");
lines.push("");
if (paritySection.status !== "ok") {
  lines.push(`- ${fmtUnknown(paritySection.reason)}`);
} else if (paritySection.files === 0) {
  lines.push(`- ${paritySection.note}`);
} else {
  const sampleCount = paritySection.records.reduce((sum, record) => sum + (Array.isArray(record?.parity) ? record.parity.length : 0), 0);
  lines.push(`- parity 记录文件 ${paritySection.files} 个：对照样本 ${sampleCount} 个、语义差异 ${paritySection.mismatches.length} 个`);
  for (const mismatch of paritySection.mismatches) {
    lines.push(`  - 差异：${mismatch?.mockAssetId ?? "?"} 样本 ${mismatch?.sampleId ?? "?"}——mock=${JSON.stringify(mismatch?.mockValue ?? null)} / real=${JSON.stringify(mismatch?.realValue ?? null)}（same=false 不是立即失败：该 mock 不得继续作为该语义的证明，处置 = 升级为真实环境断言或修 mock）`);
  }
  for (const problem of paritySection.problems) {
    lines.push(`  - 校验问题：${problem}`);
  }
  for (const item of paritySection.unreadableFiles) {
    lines.push(`  - 文件不可解析：${item.file}——${fmtUnknown(item.reason)}`);
  }
}
lines.push("");

lines.push("## 14. 工具链与验证资产状态（project-capabilities.json 摘录）");
lines.push("");
if (toolchainSection.status !== "ok") {
  lines.push(`- ${fmtUnknown(toolchainSection.reason)}——dev-flow 段快照经 --capabilities-file 传入后可呈现本节`);
} else {
  const toolchain = toolchainSection.toolchain;
  if (Array.isArray(toolchain)) {
    lines.push(toolchain.length === 0
      ? "- 工具链（toolchain）：项目未声明受管工具链（typescript / eslint）——未声明不是缺口，是项目事实"
      : `- 工具链（toolchain）：${toolchain.map((entry) => `${entry.id}=${entry.status}${entry.command !== null ? `（${entry.command}）` : ""}`).join("、")}`);
  } else {
    lines.push(`- 工具链（toolchain）：${fmtUnknown(toolchain.reason)}`);
  }
  const testConfig = toolchainSection.testConfig;
  if (Array.isArray(testConfig)) {
    lines.push(testConfig.length === 0
      ? "- 测试配置（testConfig）：未探测到测试 runner 配置"
      : `- 测试配置（testConfig）：${testConfig.map((entry) => `${entry.runner}${entry.zeroTestPassThrough ? "（zeroTestPassThrough=true 空跑放行在册）" : ""}`).join("、")}`);
  } else {
    lines.push(`- 测试配置（testConfig）：${fmtUnknown(testConfig.reason)}`);
  }
}
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
