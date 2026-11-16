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
