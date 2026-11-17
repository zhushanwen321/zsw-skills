// kernel-judgments.mjs — 交付事务内核·判定单源库（V6）
//
// 单源纪律：发现 open 判定、可用探索集、探索 due、修复轮预算、full 保证资格——全部只保留
// 本文件这一份实现。消费方两类：
//   ① delivery-gate.mjs / delivery-core.mjs（同进程 import，函数直调）
//   ② workflow 产物（zcode 产物禁模块语法，禁 import 本文件）——经 delivery-core.mjs 的
//      JSON 子命令消费：open-findings / usable-explorations / exploration-due / repair-budget /
//      full-qualification
// 禁止在 workflow 源码里复刻本库判定逻辑（口径漂移的根源，V4 已证：三套 open 实现、
// 三处探索集、两处轮上限，靠注释人工同步必然失同步）。
//
// 输入约定：records = 事件记录数组（gate world.entries[].record 形态，含 seq 字段）；
// 全部函数为纯函数（除 isArtifactUsable 回调由调用方注入磁盘校验）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel", "rules.json");

/** 内核规则（预算 / 护栏）。唯一权威 = kernel/rules.json；workflow 侧本地常量须与本值一致
 *  （scripts/tests/delivery-core-v6.test.mjs 对拍 workflow 源码字面量）。 */
export const KERNEL_RULES = JSON.parse(readFileSync(RULES_PATH, "utf8"));

export function kernelBudgets() {
  return KERNEL_RULES.budgets;
}

export function kernelGuardrails() {
  return KERNEL_RULES.guardrails;
}

const seqOf = (record) => (typeof record.seq === "number" ? record.seq : 0);

/** 发现 open 集（V4 三套实现的收敛单源）。
 * 口径：同验收版本的 FindingRaised 入集；FindingResolved / ResolutionReaffirmed 在
 * 当前裁决 revision 上把对应 finding 移出集——新 revision 上旧 resolution 失效，
 * finding 保持 open 待重新确认（重认领同口径）。与 gate 折叠语义一致（gate 以本函数
 * 结果为准，折叠结构仅用于归因字段富化）。 */
export function openFindingsFromEvents(records, { revision, acceptanceVersion }) {
  const open = new Map();
  const raised = new Map();
  for (const record of records) {
    // 任务替换继承发现（TaskSuperseded phase=prepare 的 inheritedFindings）：无独立
    // FindingRaised 事件，随 prepare 事件视同 raise（与 gate 折叠同口径，跨版本持久参与
    // 判定）。prepare 是任务级事件（acceptanceVersion=0，登记早于后继验收包成型），
    // 不做版本过滤
    if (record.type === "TaskSuperseded" && record.phase === "prepare" && Array.isArray(record.inheritedFindings)) {
      for (const inherited of record.inheritedFindings) {
        if (typeof inherited.findingId !== "string") continue;
        const synthetic = { ...inherited, type: "FindingRaised", actor: record.actor, acceptanceVersion: record.acceptanceVersion, revision: record.revision };
        open.set(inherited.findingId, synthetic);
        raised.set(inherited.findingId, synthetic);
      }
      continue;
    }
    if (record.acceptanceVersion !== acceptanceVersion) continue;
    if (typeof record.findingId !== "string") continue;
    if (record.type === "FindingRaised") {
      open.set(record.findingId, record);
      raised.set(record.findingId, record);
    } else if (record.type === "FindingResolved" && record.revision === revision) {
      open.delete(record.findingId);
    } else if (record.type === "ResolutionReaffirmed" && record.revision === revision) {
      open.delete(record.findingId);
    }
  }
  return { openIds: new Set(open.keys()), openRecords: [...open.values()], raisedRecords: [...raised.values()] };
}

/** 可用探索集的过滤与序信息（磁盘 artifact 校验由调用方注入：在盘 + artifactSha256 一致）。
 * 返回的 usable 列表按事件序排列；latestId 供「引用最新可用探索」的口径复用。 */
export async function usableExplorations(records, { acceptanceVersion, isArtifactUsable }) {
  const sameVersion = records.filter(
    (record) => record.type === "ExplorationCompleted" && record.acceptanceVersion === acceptanceVersion,
  );
  const usable = [];
  for (const record of sameVersion) {
    if (await isArtifactUsable(record)) usable.push(record);
  }
  return {
    usable,
    usableIds: new Set(usable.map((record) => record.eventId)),
    latestUsableId: usable.length > 0 ? usable[usable.length - 1].eventId : "none",
  };
}

/** 探索 due 判定（V4 两处实现的收敛单源）。
 * due = 无任何可用探索，或最近一次验收批准 / 方案批准晚于最新可用探索（判据或关键设计
 * 变化后未重新探索）。usableList = 调用方已算好的可用探索记录列表（gate 传折叠结果，
 * core 传 usableExplorations 输出）；atSeq 给定时按历史时点判定（gate 校验历史 full 的
 * 登记时点是否当时合格），缺省判当前时点（workflow 发起前预判）。 */
export function explorationDue(records, usableList, { atSeq = Number.POSITIVE_INFINITY } = {}) {
  const lastChangeSeqBefore = Math.max(
    0,
    ...records
      .filter((record) => record.type === "AcceptanceApproved" || record.type === "DesignApproved")
      .map(seqOf)
      .filter((seq) => seq < atSeq),
  );
  const usableBefore = usableList.filter((record) => seqOf(record) < atSeq);
  if (usableBefore.length === 0) return { due: true, reason: "无可用探索" };
  const latestUsableSeq = Math.max(...usableBefore.map(seqOf));
  if (lastChangeSeqBefore > latestUsableSeq) {
    return { due: true, reason: `最近判据变化（seq ${lastChangeSeqBefore}）晚于最新可用探索（seq ${latestUsableSeq}）` };
  }
  return { due: false, reason: `最新可用探索（seq ${latestUsableSeq}）不早于最近判据变化（seq ${lastChangeSeqBefore}）` };
}

/** 修复轮预算（V4 双实现 + V5 新增跨 run 保证预算的收敛单源）。
 * perVersion 口径与 gate V4 一致：behavior 性质 RepairRoundRecorded + 首次保证之后的
 * DesignApproved / AcceptanceApproved 修订各按一轮（nature=environment|evidence 不计轮）。
 * crossRun 口径（V5 新增）：保证 run 次数（AssuranceCompleted）+ perVersion 轮数——
 * 每次 full/recheck 重入保证循环都消耗预算，超上限由 evaluate 判 process-failed 停回。 */
export function repairBudgetFromEvents(records) {
  const budgets = KERNEL_RULES.budgets;
  const behaviorRepairRounds = records.filter(
    (record) => record.type === "RepairRoundRecorded" && (record.nature ?? "behavior") === "behavior",
  ).length;
  const assuranceSeqs = records.filter((record) => record.type === "AssuranceCompleted").map(seqOf);
  const firstAssuranceSeq = assuranceSeqs.length > 0 ? Math.min(...assuranceSeqs) : null;
  const offLoopRevisions =
    firstAssuranceSeq === null
      ? 0
      : records.filter(
          (record) =>
            seqOf(record) > firstAssuranceSeq &&
            (record.type === "DesignApproved" || record.type === "AcceptanceApproved"),
        ).length;
  const perVersionUsed = behaviorRepairRounds + offLoopRevisions;
  const assuranceRuns = assuranceSeqs.length;
  const crossRunUsed = assuranceRuns + perVersionUsed;
  return {
    behaviorRepairRounds,
    offLoopRevisions,
    perVersionUsed,
    perVersionCap: budgets.repairPerVersionCap,
    perVersionRemaining: Math.max(0, budgets.repairPerVersionCap - perVersionUsed),
    nextBehaviorRoundAllowed: perVersionUsed + 1 <= budgets.repairPerVersionCap,
    assuranceRuns,
    crossRunUsed,
    crossRunCap: budgets.assuranceCrossRunCap,
    crossRunRemaining: Math.max(0, budgets.assuranceCrossRunCap - crossRunUsed),
    crossRunExceeded: crossRunUsed > budgets.assuranceCrossRunCap,
  };
}

/** full 保证资格判定（gate priorFullQualified / hasPriorValidFull 的收敛单源）。
 * 判定历史 full 保证（AssuranceCompleted mode=full，同验收版本）是否合格——能否作为
 * recheck / full-first 的资格基础（gate missing.assuranceFullFirst 判定与 workflow 预检
 * 的同口径依据）。逐条口径（与 gate buildVerdict 一致）：
 *   ① 回执覆盖全部增量——不查回执红绿（红 = full 发现了缺陷，属正常修复链起点）
 *   ② 引用的证据事件可解析（id === "none" 豁免；证据集合由调用方传入折算后的分组——
 *      artifact 失效事件已在折算阶段被过滤，此处不重复校验磁盘）
 *   ③ 探索引用存在（schema 2 无条件要求；schema 1 仅 exploratoryReview=required 时要求）
 * 输入 = 折算后的分组记录（gate world.fold 的 assurances/evidence/explorations 三组，
 * core loadWorld 同构）；beforeSeq 给定时只判早于该 seq 的 full（判定某 recheck 的
 * prior 资格），缺省判全部。返回 qualified（存在合格 full）+ qualifiedEventIds +
 * inspections（逐条合格性与不合格原因）。 */
export function priorFullQualification(
  { assurances, evidence, explorations },
  { incrementIds, usesAssertions, exploratoryReviewRequired = false, beforeSeq = Number.POSITIVE_INFINITY } = {},
) {
  const knownEvidenceIds = new Set(evidence.map((record) => record.eventId));
  const allExplorationIds = new Set(explorations.map((record) => record.eventId));
  const inspections = assurances
    .filter((record) => (record.mode ?? "full") === "full" && seqOf(record) < beforeSeq)
    .map((record) => {
      const receipts = Array.isArray(record.incrementReceipts) ? record.incrementReceipts : [];
      const covered = new Set(receipts.map((receipt) => receipt.incrementId));
      const missingIncrementIds = incrementIds.filter((id) => !covered.has(id));
      const missingEvidenceIds = record.evidenceEventIds.filter((id) => id !== "none" && !knownEvidenceIds.has(id));
      const reasons = [];
      if (missingIncrementIds.length > 0) {
        reasons.push(`回执未覆盖全部增量（缺 ${missingIncrementIds.join(", ")}）`);
      }
      if (missingEvidenceIds.length > 0) {
        reasons.push(`引用的证据事件不可解析（${missingEvidenceIds.join(", ")}）`);
      }
      const explorationRefOk = usesAssertions
        ? allExplorationIds.has(record.explorationEventId)
        : (!exploratoryReviewRequired || allExplorationIds.has(record.explorationEventId));
      if (!explorationRefOk) {
        reasons.push(`探索引用缺失或失效（explorationEventId=${record.explorationEventId}）`);
      }
      return { eventId: record.eventId, seq: seqOf(record), qualified: reasons.length === 0, reasons };
    });
  const qualifiedEventIds = inspections.filter((item) => item.qualified).map((item) => item.eventId);
  return { qualified: qualifiedEventIds.length > 0, qualifiedEventIds, inspections };
}

/** 定级改判统计（护栏③：同一条目反复改定级触发停回）。
 * root = reopenOf 链的根 findingId；每个 root 收集 (category, severity) 去重组合，
 * 组合数超过 findingRegradeHalt 即熔断（不允许多次改判收敛与停机判据）。 */
export function findingRegrades(records) {
  const halt = KERNEL_RULES.budgets.findingRegradeHalt;
  const raisedById = new Map();
  for (const record of records) {
    if (record.type === "FindingRaised" && typeof record.findingId === "string") raisedById.set(record.findingId, record);
  }
  const rootOf = (findingId, seen = new Set()) => {
    if (seen.has(findingId)) return findingId;
    const record = raisedById.get(findingId);
    if (!record || record.reopenOf === undefined) return findingId;
    seen.add(findingId);
    return rootOf(record.reopenOf, seen);
  };
  const gradesByRoot = new Map();
  for (const record of raisedById.values()) {
    const root = rootOf(record.findingId);
    if (!gradesByRoot.has(root)) gradesByRoot.set(root, new Set());
    gradesByRoot.get(root).add(`${record.category}/${record.severity}`);
  }
  const offenders = [...gradesByRoot.entries()]
    .filter(([, grades]) => grades.size > halt)
    .map(([root, grades]) => ({ root, grades: [...grades] }));
  return { halt, offenders };
}

/** 任务阶段推导（writeMatrix「角色 × 当前状态 × 目标域」的当前状态单源）。
 * 只看事件流（不含 verdict——verdict 是判定产物不是写入授权依据）。任务终态与
 * deriveFlowState 的差异：accepted / accepted_with_risk / process-failed 是 verdict
 * 裁决态，本函数在裁决前阶段返回 finalizing；写入矩阵 states 引用本函数词表。 */
export function taskPhaseFromEvents(records, { incrementsCount = null } = {}) {
  const lastOfType = (type, predicate = () => true) => {
    const matches = records.filter((record) => record.type === type && predicate(record));
    return matches.length > 0 ? matches[matches.length - 1] : null;
  };
  if (lastOfType("TaskSuperseded", (record) => record.phase === "committed")) return "superseded";
  if (lastOfType("TaskSupersedeCancelled")) return "supersede-cancelled";
  if (lastOfType("TaskSuperseded", (record) => record.phase === "prepare")) return "supersede-pending";
  const approvals = records.filter((record) => record.type === "AcceptanceApproved");
  if (approvals.length === 0) {
    const passReview = records.some((record) => record.type === "AcceptanceReviewed" && record.conclusion === "pass");
    return passReview ? "acceptance-reviewed" : "acceptance-drafting";
  }
  if (!records.some((record) => record.type === "DesignApproved")) {
    // route-design 是无事件的路由步（acceptance-approved → design），事件流不可见——
    // 批准后、DesignApproved 前按缺省路径取 design（verificationOnly 直进实现属策略
    // 分支，同样无事件，replay 的 content 事件不依赖此区分）
    return "design";
  }
  const implementedIds = new Set(
    records.filter((record) => record.type === "ImplementationRecorded").map((record) => record.incrementId),
  );
  if (incrementsCount !== null) {
    if (implementedIds.size < incrementsCount) return "implementing";
  } else if (implementedIds.size === 0) {
    return "implementing";
  }
  if (!records.some((record) => record.type === "AssuranceCompleted")) return "implementation-recorded";
  return "finalizing";
}

/** 节点事件视图重建 projectNodeEvents（status.json 派生视图单源）：按事件序列重放 node 域转移表重建节点条目。
 * events = status.events 数组（{seq,node,event,detail,payload?}）；payload 为结构化字段
 * （commit/evidence/reason/basis），缺 payload 的历史事件只能重建 status+attempts（partial）。
 * core 的 node-project 用它做「事件 → 节点状态」视图重建与篡改检测。 */
export function projectNodeEvents(events, nodeTable) {
  const nodes = new Map();
  let partialEvents = 0;
  // 只有这些事件类型携带可恢复的结构化字段；begin/reset/suspend/resume 天然无 payload
  const PAYLOAD_BEARING_EVENTS = new Set(["finish-done", "block", "fail", "reconcile-done", "manual-disposition"]);
  const findTransition = (eventName, fromStatus) =>
    nodeTable.transitions.find((candidate) => candidate.event === eventName && candidate.from === fromStatus);
  for (const record of events) {
    const nodeName = record.node;
    if (typeof nodeName !== "string" || nodeName === "") continue;
    if (nodeName === "*") continue; // 引擎级 reconcile 警示行，不落在具体节点上
    const current = nodes.get(nodeName) ?? { status: "pending", attempts: 0 };
    const fromStatus = current.status ?? "pending";
    const transition = findTransition(record.event, fromStatus);
    if (transition === undefined) continue; // 非法/未知事件不影响重建视图（重放宽容：以 events 为准重建）
    const priorAttempts = typeof current.attempts === "number" ? current.attempts : 0;
    const payload = record.payload ?? null;
    if (payload === null && PAYLOAD_BEARING_EVENTS.has(record.event)) partialEvents += 1;
    let entry;
    switch (record.event) {
      case "begin":
        entry = { status: "in-progress", attempts: priorAttempts + 1 };
        break;
      case "finish-done":
        entry = { status: "done", attempts: Math.max(1, priorAttempts), ...(payload?.commit !== undefined ? { commit: payload.commit } : {}) };
        break;
      case "block":
        entry = { status: "blocked", attempts: priorAttempts, ...(payload?.reason !== undefined ? { reason: payload.reason } : {}) };
        break;
      case "fail":
        entry = { status: "failed", attempts: priorAttempts, ...(payload?.reason !== undefined ? { reason: payload.reason } : {}) };
        break;
      case "reset":
      case "resume":
        entry = { status: "pending", attempts: priorAttempts };
        break;
      case "suspend":
        entry = { status: "suspended", attempts: priorAttempts };
        break;
      case "reconcile-pending":
        entry = { status: "pending", attempts: priorAttempts };
        break;
      case "reconcile-done":
        entry = { status: "done", attempts: Math.max(1, priorAttempts + 1), ...(payload?.commit !== undefined ? { commit: payload.commit } : {}) };
        break;
      case "manual-disposition":
        entry = { status: "done", attempts: Math.max(1, priorAttempts), ...(payload?.basis !== undefined ? { evidence: `人工处置：${payload.basis}` } : {}) };
        break;
      default:
        continue;
    }
    nodes.set(nodeName, entry);
  }
  return { nodes: Object.fromEntries(nodes), partialEvents };
}
