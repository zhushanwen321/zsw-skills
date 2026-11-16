#!/usr/bin/env node
// V4 交付质量监控：不同 must-fix、实现性修复轮次、来源阶段与重新打开情况。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const taskDir = process.argv[2];
const json = process.argv.includes("--json");
if (!taskDir) {
  console.error("用法：node delivery-quality-stats.mjs <taskDir> [--json]——读取该任务的 events.jsonl，输出不同 must-fix、修复轮次与来源阶段");
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
const findings = new Map();
const history = [];
const repairs = [];
for (const event of events) {
  if (event.type === "FindingRaised") {
    findings.set(event.findingId, event);
    history.push(event);
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
const uniqueMustFix = new Set(history.filter((event) => event.category === "defect" && event.severity === "blocker").map((event) => rootId(event.findingId)));
const origins = {};
const stages = {};
for (const event of history) {
  const origin = event.origin ?? "unclassified";
  origins[origin] = (origins[origin] ?? 0) + 1;
  const stage = event.firstDetectedStage ?? "unclassified";
  stages[stage] = (stages[stage] ?? 0) + 1;
}
const report = {
  taskDir: resolve(taskDir),
  uniqueMustFix: uniqueMustFix.size,
  repairRounds: repairs.length,
  processFailed: uniqueMustFix.size > 10 || repairs.length > 3,
  findings: history.length,
  reopenedFindings: history.filter((event) => event.reopenOf !== undefined).length,
  origins,
  firstDetectedStages: stages,
  latestRepairRound: repairs.at(-1)?.round ?? 0,
};
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`taskDir: ${report.taskDir}`);
  console.log(`uniqueMustFix: ${report.uniqueMustFix} / 10`);
  console.log(`repairRounds: ${report.repairRounds} / 3`);
  console.log(`processFailed: ${report.processFailed}`);
  console.log(`findings: ${report.findings}（reopened ${report.reopenedFindings}）`);
  console.log(`origins: ${JSON.stringify(report.origins)}`);
  console.log(`firstDetectedStages: ${JSON.stringify(report.firstDetectedStages)}`);
}
