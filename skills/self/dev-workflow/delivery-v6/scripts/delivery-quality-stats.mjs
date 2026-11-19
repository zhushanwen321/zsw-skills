#!/usr/bin/env node
// V6 交付质量监控：输出合并稿 §13 的 11 项交付质量指标（逐项口径见各指标处注释）。
// 计轮口径与 delivery-gate 同步（合并稿 §7.1）：behavior 修复轮 + 保证后方案/验收修订
// 各计一轮；nature=environment/evidence 重试不计。卡住续跑事件流无信号，由调用方经
// --stuck-continuation-count 传入。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 预算上限读内核规则单源（C-20 对齐 gate 裁决口径）：不再硬编码 10/3——rules.json 调整后
// 统计与裁决同步生效
import { KERNEL_RULES } from "./lib/kernel-judgments.mjs";

const USAGE = "用法：node delivery-quality-stats.mjs <taskDir> [--json] [--stuck-continuation-count N]——读取该任务的 events.jsonl（与 verdict.json，若存在），输出合并稿 §13 的交付质量指标";
const args = process.argv.slice(2);
const taskDir = args.find((value, index) => index % 2 === 0 && !value.startsWith("--"));
const json = args.includes("--json");
const stuckIndex = args.indexOf("--stuck-continuation-count");
const stuckContinuationCount = stuckIndex >= 0 && /^\d+$/.test(args[stuckIndex + 1] ?? "") ? Number(args[stuckIndex + 1]) : 0;
if (!taskDir || args.some((value, index) => index % 2 === 0 && value.startsWith("--") && value !== "--json" && value !== "--stuck-continuation-count")) {
  console.error(USAGE);
  process.exit(2);
}
const eventsPath = resolve(taskDir, "events.jsonl");
let events;
try {
  events = readFileSync(eventsPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
} catch (error) {
  console.error(`无法读取 ${eventsPath}：${error.message}。恢复动作：确认 delivery-gate init 已创建任务目录，且 events.jsonl 完整后重试`);
  process.exit(1);
}
// 过程审查记录（V5 渐进式 review）：实现过程中的审查结论由各审查节点独立落盘 append-only，
// 与交付事件流分离（事件流只记 gate 裁判事实，过程层记录审查中间结论）。辅助观测：文件缺失
// 按空数组处理，单行解析失败只告警跳过，不拖垮主统计
const processReviewPath = resolve(taskDir, "process-review.jsonl");
const processReviewEntries = [];
let processReviewSource = "process-review.jsonl";
if (existsSync(processReviewPath)) {
  const lines = readFileSync(processReviewPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    try {
      processReviewEntries.push(JSON.parse(lines[index]));
    } catch {
      console.error(`警告：${processReviewPath} 第 ${index + 1} 行 JSON 解析失败，已跳过该行（过程记录为辅助观测，不影响主统计）`);
    }
  }
} else {
  processReviewSource = "process-review.jsonl 缺失";
}
const processReviewByMechanism = {};
const processReviewByVerdict = {};
let processReviewFailedFindings = 0;
for (const entry of processReviewEntries) {
  const mechanism = entry.mechanism ?? "unclassified";
  processReviewByMechanism[mechanism] = (processReviewByMechanism[mechanism] ?? 0) + 1;
  const verdict = entry.verdict ?? "unclassified";
  processReviewByVerdict[verdict] = (processReviewByVerdict[verdict] ?? 0) + 1;
  if (entry.verdict === "fail") processReviewFailedFindings += 1;
}
const findings = new Map();
const history = [];
const repairs = [];
for (const event of events) {
  if (event.type === "FindingRaised") {
    findings.set(event.findingId, event);
    history.push(event);
  }
  // 任务替换继承的发现按裁决器同口径计入（delivery-gate 把 inheritedFindings 折叠为
  // finding 参与判定——blocker 继承同样推进 uniqueMustFix；这里漏计会让临界第 10→11 条
  // 低估）。origin 标 inherited 便于区分本地发现与继承发现
  if (event.type === "TaskSuperseded" && Array.isArray(event.inheritedFindings)) {
    for (const inherited of event.inheritedFindings) {
      if (inherited === null || typeof inherited !== "object" || typeof inherited.findingId !== "string") continue;
      const merged = { ...inherited, type: "FindingRaised", origin: "inherited" };
      if (!findings.has(inherited.findingId)) {
        findings.set(inherited.findingId, merged);
        history.push(merged);
      }
    }
  }
  if (event.type === "RepairRoundRecorded") repairs.push(event);
}
function rootId(id, seen = new Set()) {
  if (seen.has(id)) throw new Error(`reopenOf 循环：${id}`);
  const event = findings.get(id);
  if (!event?.reopenOf) return id;
  seen.add(id);
  return rootId(event.reopenOf, seen);
}
// 阻断分类按策略实例化（C-21 对齐 gate 裁决口径）：「defect 位」= blocksAccepted===true 的
// 分类集合，不再字面量比对 "defect"。策略源 = 任务快照 policy-snapshot.json（裁决按快照
// 执行）；快照缺失/不可解析时回退技能自带默认词表并披露来源——回退是统计层的降级披露，
// 不是裁决行为
const blockingCategories = (() => {
  const readBlockingIds = (text) => {
    try {
      const doc = JSON.parse(text);
      const ids = (Array.isArray(doc.categories) ? doc.categories : [])
        .filter((entry) => entry !== null && typeof entry === "object" && entry.blocksAccepted === true)
        .map((entry) => entry.id)
        .filter((id) => typeof id === "string" && id !== "");
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    }
  };
  const snapshotPath = resolve(taskDir, "policy-snapshot.json");
  if (existsSync(snapshotPath)) {
    const ids = readBlockingIds(readFileSync(snapshotPath, "utf8"));
    if (ids !== null) return { ids, source: "policy-snapshot.json" };
  }
  const defaultPath = join(dirname(fileURLToPath(import.meta.url)), "..", "policies", "finding-categories.json");
  const ids = existsSync(defaultPath) ? readBlockingIds(readFileSync(defaultPath, "utf8")) : null;
  return ids !== null ? { ids, source: "技能默认 finding-categories.json（任务快照缺失，回退）" } : { ids: ["defect"], source: "内置回退（defect）" };
})();
const isBlockingDefect = (event) => blockingCategories.ids.includes(event.category) && event.severity === "blocker";
const uniqueMustFix = new Set(history.filter(isBlockingDefect).map((event) => rootId(event.findingId)));
const origins = {};
const stages = {};
for (const event of history) {
  const origin = event.origin ?? "unclassified";
  origins[origin] = (origins[origin] ?? 0) + 1;
  const stage = event.firstDetectedStage ?? "unclassified";
  stages[stage] = (stages[stage] ?? 0) + 1;
}
// 计轮口径（与 delivery-gate 同步，合并稿 §7.1）：behavior 性质修复轮 + 首次保证之后的
// DesignApproved（方案修订）/ AcceptanceApproved（验收版本递增）各按一轮；nature=
// environment/evidence 的重试轮不计
const behaviorRepairs = repairs.filter((event) => (event.nature ?? "behavior") === "behavior");
const firstAssurance = events.find((event) => event.type === "AssuranceCompleted");
const postAssuranceRevisions = firstAssurance === undefined
  ? 0
  : events.filter((event) => (event.seq ?? 0) > (firstAssurance.seq ?? 0) && (event.type === "DesignApproved" || event.type === "AcceptanceApproved")).length;
const repairRounds = behaviorRepairs.length + postAssuranceRevisions;
// escapedByStage：机器无阶段全序，按 (expectedStage -> firstDetectedStage) 不等对分布汇总
//（相等即在最早应发现阶段发现；未配齐两字段不计入）
const escapedPairs = {};
let stagePairTotal = 0;
let stagePairMatched = 0;
for (const event of history) {
  if (typeof event.expectedStage !== "string" || typeof event.firstDetectedStage !== "string") continue;
  stagePairTotal += 1;
  if (event.expectedStage === event.firstDetectedStage) {
    stagePairMatched += 1;
    continue;
  }
  const key = `${event.expectedStage}->${event.firstDetectedStage}`;
  escapedPairs[key] = (escapedPairs[key] ?? 0) + 1;
}
// assuranceMustFixFirstRun：首条 AssuranceCompleted(mode=full) 时点未解决 blocker 数
//（按事件流序：该事件之前 FindingRaised 的 defect blocker 中尚无 FindingResolved 的不同根数）
const firstFull = events.find((event) => event.type === "AssuranceCompleted" && (event.mode ?? "full") === "full");
let assuranceMustFixFirstRun = 0;
if (firstFull !== undefined) {
  const cutoff = firstFull.seq ?? 0;
  const resolvedBefore = new Set(events.filter((event) => event.type === "FindingResolved" && (event.seq ?? 0) < cutoff).map((event) => event.findingId));
  const unresolvedRoots = new Set();
  for (const event of events) {
    if ((event.seq ?? 0) >= cutoff) break;
    if (event.type === "FindingRaised" && isBlockingDefect(event) && !resolvedBefore.has(event.findingId)) {
      unresolvedRoots.add(rootId(event.findingId));
    }
  }
  assuranceMustFixFirstRun = unresolvedRoots.size;
}
// targetedReviewRate：recheck 数 /（full + recheck 总数）——修复后只执行定向复核的比例
const assuranceEvents = events.filter((event) => event.type === "AssuranceCompleted");
const recheckCount = assuranceEvents.filter((event) => event.mode === "recheck").length;
const fullCount = assuranceEvents.filter((event) => (event.mode ?? "full") === "full").length;
const targetedReviewRate = fullCount + recheckCount > 0 ? recheckCount / (fullCount + recheckCount) : 0;
// finalExplorations：末次 AssuranceCompleted 之后再登记的 ExplorationCompleted 数
//（= 合并稿 §13 finalExplorationRate 的单任务计数形态，0 = 未重开探索）
const lastAssuranceSeq = assuranceEvents.length > 0 ? Math.max(...assuranceEvents.map((event) => event.seq ?? 0)) : 0;
const finalExplorations = events.filter((event) => event.type === "ExplorationCompleted" && (event.seq ?? 0) > lastAssuranceSeq).length;
// evidenceIntegrityFailures：裁决器 evaluate 输出的 missing.missingArtifacts（含
// hash-mismatch）计数——读 verdict.json（由 evaluate 生成；无 verdict 时输出 0 并标注来源缺失）
let evidenceIntegrityFailures = 0;
let evidenceIntegritySource = "verdict.json";
const verdictPath = resolve(taskDir, "verdict.json");
if (existsSync(verdictPath)) {
  try {
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
    evidenceIntegrityFailures = Array.isArray(verdict.missing?.missingArtifacts) ? verdict.missing.missingArtifacts.length : 0;
  } catch {
    evidenceIntegritySource = "verdict.json 不可读（按 0 计）";
  }
} else {
  evidenceIntegritySource = "verdict.json 缺失（按 0 计；先运行 delivery-gate evaluate）";
}
const report = {
  taskDir: resolve(taskDir),
  uniqueMustFix: uniqueMustFix.size,
  repairRounds,
  repairRoundsBreakdown: {
    behaviorRepairRounds: behaviorRepairs.length,
    designRevisionsAfterAssurance: postAssuranceRevisions > 0 ? events.filter((event) => (event.seq ?? 0) > (firstAssurance.seq ?? 0) && event.type === "DesignApproved").length : 0,
    acceptanceRevisionsAfterAssurance: postAssuranceRevisions > 0 ? events.filter((event) => (event.seq ?? 0) > (firstAssurance.seq ?? 0) && event.type === "AcceptanceApproved").length : 0,
  },
  processFailed: uniqueMustFix.size > KERNEL_RULES.budgets.uniqueMustFixCap || repairRounds > KERNEL_RULES.budgets.repairPerVersionCap,
  processBudgets: { uniqueMustFixCap: KERNEL_RULES.budgets.uniqueMustFixCap, repairPerVersionCap: KERNEL_RULES.budgets.repairPerVersionCap },
  blockingCategories: blockingCategories.ids,
  blockingCategoriesSource: blockingCategories.source,
  findings: history.length,
  reopenedFindings: history.filter((event) => event.reopenOf !== undefined).length,
  origins,
  firstDetectedStages: stages,
  latestRepairRound: repairs.at(-1)?.round ?? 0,
  // ── 合并稿 §13 补齐指标 ──
  expectedStageAccuracy: stagePairTotal > 0 ? stagePairMatched / stagePairTotal : null,
  escapedByStage: escapedPairs,
  assuranceMustFixFirstRun,
  targetedReviewRate,
  finalExplorations,
  evidenceIntegrityFailures,
  evidenceIntegritySource,
  processReview: {
    entries: processReviewEntries.length,
    byMechanism: processReviewByMechanism,
    byVerdict: processReviewByVerdict,
    failedFindings: processReviewFailedFindings,
    source: processReviewSource,
  },
  // 卡住续跑（审查未解决仍继续交付）属 dev-flow 侧观测，事件流无信号：由调用方按
  // dev-flow 执行记录统计后经 --stuck-continuation-count 传入（缺省 0）
  stuckContinuationCount,
};
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`taskDir: ${report.taskDir}`);
  console.log(`uniqueMustFix: ${report.uniqueMustFix} / ${report.processBudgets.uniqueMustFixCap}（阻断分类：${report.blockingCategories.join(" / ")}，来源 ${report.blockingCategoriesSource}）`);
  console.log(`repairRounds: ${report.repairRounds} / ${report.processBudgets.repairPerVersionCap}（behavior ${behaviorRepairs.length} + 保证后方案/验收修订 ${postAssuranceRevisions}）`);
  console.log(`processFailed: ${report.processFailed}`);
  console.log(`findings: ${report.findings}（reopened ${report.reopenedFindings}）`);
  console.log(`origins: ${JSON.stringify(report.origins)}`);
  console.log(`firstDetectedStages: ${JSON.stringify(report.firstDetectedStages)}`);
  console.log(`expectedStageAccuracy: ${report.expectedStageAccuracy === null ? "无配对样本" : report.expectedStageAccuracy}`);
  console.log(`escapedByStage: ${JSON.stringify(report.escapedByStage)}`);
  console.log(`assuranceMustFixFirstRun: ${report.assuranceMustFixFirstRun}`);
  console.log(`targetedReviewRate: ${report.targetedReviewRate}（recheck ${recheckCount} / full+recheck ${fullCount + recheckCount}）`);
  console.log(`finalExplorations: ${report.finalExplorations}`);
  console.log(`evidenceIntegrityFailures: ${report.evidenceIntegrityFailures}（来源 ${report.evidenceIntegritySource}）`);
  console.log(`stuckContinuationCount: ${report.stuckContinuationCount}`);
  console.log(`processReview: ${report.processReview.entries} 条（fail ${report.processReview.failedFindings}）`);
  console.log(`processReviewByMechanism: ${JSON.stringify(report.processReview.byMechanism)}（来源 ${report.processReview.source}）`);
}
