import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "skills", "self", "dev-workflow", "delivery-v4", "scripts", "delivery-quality-stats.mjs");

test("质量统计区分重开与不同问题，并按上限判过程失败", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-quality-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [];
  for (let index = 1; index <= 11; index += 1) {
    events.push({ type: "FindingRaised", findingId: `F-${index}`, category: "defect", severity: "blocker", origin: index % 2 ? "design" : "implementation", firstDetectedStage: "assuring" });
  }
  events.push({ type: "FindingRaised", findingId: "F-12", category: "defect", severity: "blocker", reopenOf: "F-1" });
  events.push({ type: "RepairRoundRecorded", round: 1 });
  writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const result = spawnSync(process.execPath, [CLI, dir, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.uniqueMustFix, 11);
  assert.equal(report.reopenedFindings, 1);
  assert.equal(report.repairRounds, 1);
  assert.equal(report.processFailed, true);
  assert.equal(report.origins.design, 6);
});

test("任务替换继承的发现计入 uniqueMustFix（与裁决器同口径）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-quality-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [
    { type: "FindingRaised", findingId: "F-LOCAL", category: "defect", severity: "blocker", origin: "implementation", firstDetectedStage: "assuring" },
    // 继承发现（TaskSuperseded.inheritedFindings）：gate 折叠为同语义 FindingRaised 参与
    // 判定——监控侧漏计会让临界第 10→11 条低估
    { type: "TaskSuperseded", phase: "prepare", inheritedFindings: [
      { findingId: "F-INH1", category: "defect", severity: "blocker", requirementIds: ["R1"] },
      { findingId: "F-INH2", category: "defect", severity: "non-blocker", requirementIds: ["R1"] },
    ] },
    // 继承问题复发经 reopenOf 重开：不重复计数
    { type: "FindingRaised", findingId: "F-INH1-RE", category: "defect", severity: "blocker", reopenOf: "F-INH1" },
  ];
  writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const result = spawnSync(process.execPath, [CLI, dir, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.uniqueMustFix, 2, "本地 1 + 继承 blocker 1（继承 non-blocker 不计），reopenOf 折叠");
  assert.equal(report.origins.inherited, 2, "继承发现按 origin=inherited 区分本地与继承");
});

test("合并稿 §13 七项新指标逐项断言 + 计轮与裁决器同口径", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-quality-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [
    // 首条 full 保证（seq 5）之前：3 条不同 blocker，其中 F-1 已解决 → 首轮保证时未解决 2 条
    { seq: 1, type: "FindingRaised", findingId: "F-1", category: "defect", severity: "blocker", origin: "design", firstDetectedStage: "design", expectedStage: "design" },
    { seq: 2, type: "FindingRaised", findingId: "F-2", category: "defect", severity: "blocker", origin: "implementation", firstDetectedStage: "assuring", expectedStage: "design" },
    { seq: 3, type: "FindingRaised", findingId: "F-3", category: "defect", severity: "blocker", origin: "testing", firstDetectedStage: "assuring", expectedStage: "D2" },
    { seq: 4, type: "FindingResolved", findingId: "F-1" },
    { seq: 5, type: "AssuranceCompleted", mode: "full" },
    // 修复轮：r1 behavior + r2 environment（不计轮）
    { seq: 6, type: "RepairRoundRecorded", round: 1 },
    { seq: 7, type: "RepairRoundRecorded", round: 2, nature: "environment" },
    // 保证后验收版本递增 = off-loop 计轮 1 次
    { seq: 8, type: "AcceptanceApproved" },
    // recheck 保证（定向复核）+ 末次保证后的新探索（最终阶段重新开放探索 1 次）
    { seq: 9, type: "AssuranceCompleted", mode: "recheck" },
    { seq: 10, type: "ExplorationCompleted" },
  ];
  writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  // verdict.json 供 evidenceIntegrityFailures 读取
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ missing: { missingArtifacts: [{ artifact: "evidence/x.md" }, { artifact: "evidence/y.md", reason: "hash-mismatch" }] } }));
  const result = spawnSync(process.execPath, [CLI, dir, "--json", "--stuck-continuation-count", "2"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  // expectedStageAccuracy：3 条有配对，1 条命中（F-1 design=design）= 1/3
  assert.equal(report.expectedStageAccuracy, 1 / 3);
  // escapedByStage：F-2 design->assuring、F-3 D2->assuring
  assert.deepEqual(report.escapedByStage, { "design->assuring": 1, "D2->assuring": 1 });
  // 首条 full 时点未解决 blocker：F-2、F-3（F-1 已 resolved）
  assert.equal(report.assuranceMustFixFirstRun, 2);
  // targetedReviewRate：recheck 1 / (full 1 + recheck 1) = 0.5
  assert.equal(report.targetedReviewRate, 0.5);
  // 末次 AssuranceCompleted(seq 9) 之后的 ExplorationCompleted(seq 10) = 1
  assert.equal(report.finalExplorations, 1);
  // evidenceIntegrityFailures：verdict.missing.missingArtifacts 计数
  assert.equal(report.evidenceIntegrityFailures, 2);
  assert.equal(report.stuckContinuationCount, 2);
  // 计轮：behavior 1 + environment 0（不计）+ off-loop 验收递增 1 = 2
  assert.equal(report.repairRounds, 2);
  assert.equal(report.repairRoundsBreakdown.behaviorRepairRounds, 1);
  assert.equal(report.repairRoundsBreakdown.acceptanceRevisionsAfterAssurance, 1);
  assert.equal(report.processFailed, false);
});

test("evidenceIntegrityFailures：无 verdict.json 时按 0 计并标注来源", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-quality-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ seq: 1, type: "FindingRaised", findingId: "F-1", category: "defect", severity: "blocker" })}\n`);
  const result = spawnSync(process.execPath, [CLI, dir, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evidenceIntegrityFailures, 0);
  assert.match(report.evidenceIntegritySource, /verdict\.json 缺失/);
});
