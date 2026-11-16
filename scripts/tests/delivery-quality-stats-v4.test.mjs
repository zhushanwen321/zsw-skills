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
