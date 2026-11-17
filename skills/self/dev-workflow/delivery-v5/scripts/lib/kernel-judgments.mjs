// kernel-judgments.mjs — 交付事务内核·判定单源库（V5）
//
// 单源纪律：发现 open 判定、可用探索集、探索 due、修复轮预算——全部只保留本文件这一份
// 实现。消费方两类：
//   ① delivery-gate.mjs / delivery-core.mjs（同进程 import，函数直调）
//   ② workflow 产物（zcode 产物禁模块语法，禁 import 本文件）——经 delivery-core.mjs 的
//      JSON 子命令消费：open-findings / usable-explorations / exploration-due / repair-budget
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
 *  （scripts/tests/delivery-core-v5.test.mjs 对拍 workflow 源码字面量）。 */
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
