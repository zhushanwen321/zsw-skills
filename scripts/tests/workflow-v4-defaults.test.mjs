// workflow-v4-defaults.test.mjs — V4 workflow 默认路径与覆盖校验输入契约
//
// 覆盖（对应实现：tech-review-loop-v4 / dev-consistency-loop-v4 产物 + check-dispositions.mjs）：
//   1. T2 四席默认模板 basename 与仓库 tech-design-v4/agents/ 实际文件一致（默认主审
//      模板断链会让 zcode 默认参数发起直接 setup-failure——2026-11-16 对抗审查 P1）
//   2. D2 默认 reviewer 模板（zcode/pi 两产物）与仓库 dev-flow-v4/agents/ 实际文件一致
//   3. T2 覆盖校验输入 = problems-critical.json（minor 项不进覆盖校验——与修复者
//      critical-only 锚点集同源；传全量 problems.json 会强制修复者处置 minor）
//   4. check-dispositions 组合语义：dispositions 只覆盖 critical 子集时，全量 problems
//      判 exit 1、critical-only problems 判 exit 0（机制正确性的直接证据）
//
// 运行：node --test scripts/tests/workflow-v4-defaults.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
const T2_AGENTS = join(ROOT, "skills/self/dev-workflow/tech-design-v4/agents");
const D2_AGENTS = join(ROOT, "skills/self/dev-workflow/dev-flow-v4/agents");
const CHECK_DISPOSITIONS = join(ROOT, "skills/self/dev-workflow/tech-design-v4/scripts/check-dispositions.mjs");

test("T2 默认四席模板 basename 均存在于仓库 agents 目录", () => {
  const product = readFileSync(join(WF, "tech-review-loop-v4.dwf.ts"), "utf8");
  const entries = [...product.matchAll(/\{ dim: "(\w+)", file: "([\w.-]+\.md)" \}/g)].map((m) => ({ dim: m[1], file: m[2] }));
  assert.equal(entries.length, 4, `应解析出四席模板声明（实际 ${entries.length}）`);
  const onDisk = new Set(readdirSync(T2_AGENTS));
  for (const entry of entries) {
    assert.ok(onDisk.has(entry.file), `默认模板 ${entry.file}（维度 ${entry.dim}）不存在于 ${T2_AGENTS}——默认参数发起 T2 会 setup-failure`);
  }
});

test("D2 默认 reviewer 模板（zcode/pi 两产物）存在于仓库 agents 目录", () => {
  const onDisk = new Set(readdirSync(D2_AGENTS));
  for (const product of ["dev-consistency-loop-v4.dwf.ts", "pi/dev-consistency-loop-v4.js"]) {
    const text = readFileSync(join(WF, product), "utf8");
    const hits = [...text.matchAll(/dev-flow-v4\/agents\/([\w.-]+\.md)/g)].map((m) => m[1]);
    assert.ok(hits.length > 0, `${product} 应声明默认 reviewer 模板路径`);
    for (const file of new Set(hits)) {
      assert.ok(onDisk.has(file), `${product} 默认模板 ${file} 不存在于 ${D2_AGENTS}——不显式传 reviewerTemplate 时 D2 启动失败`);
    }
  }
});

test("T2 覆盖校验输入为 problems-critical.json（minor 不进覆盖校验）", () => {
  for (const product of ["tech-review-loop-v4.dwf.ts", "pi/tech-review-loop-v4.js"]) {
    const text = readFileSync(join(WF, product), "utf8");
    assert.ok(text.includes('"--problems", `${roundAbs}/problems-critical.json`'), `${product} 覆盖校验应传 problems-critical.json`);
    assert.ok(!text.includes('"--problems", `${roundAbs}/problems.json`'), `${product} 覆盖校验不得传全量 problems.json`);
    assert.ok(text.includes("problems-critical.json"), `${product} 应写入 critical-only 问题清单`);
  }
});

test("check-dispositions：只覆盖 critical 子集时全量 problems 拒绝、critical-only 放行", () => {
  const dir = mkdtempSync(join(tmpdir(), "v4-disp-"));
  try {
    const problems = [
      { ref: "review-main#1", title: "critical 级问题" },
      { ref: "review-main#2", title: "minor 级问题" },
    ];
    const criticalOnly = [problems[0]];
    const dispositions = [
      {
        id: "D-1-1",
        title: "修复 critical 项",
        source: ["review-main#1"],
        action: "fixed",
        location: "s3-solution.json",
        reenactment: "重演验证",
        attackHints: "无",
        affectsDecision: "影响",
        affectsDelivery: "影响",
      },
    ];
    writeFileSync(join(dir, "problems.json"), JSON.stringify({ round: 1, problems }));
    writeFileSync(join(dir, "problems-critical.json"), JSON.stringify({ round: 1, problems: criticalOnly }));
    writeFileSync(join(dir, "dispositions.json"), JSON.stringify({ dispositions }));
    const run = (problemsFile) =>
      spawnSync(process.execPath, [CHECK_DISPOSITIONS, join(dir, "dispositions.json"), "--problems", join(dir, problemsFile)], { encoding: "utf8" });
    const full = run("problems.json");
    assert.equal(full.status, 1, "全量 problems 下 minor ref 未被处置应拒绝");
    assert.ok(full.stdout.includes("review-main#2"), "拒绝报告应点名未覆盖的 minor ref");
    const critical = run("problems-critical.json");
    assert.equal(critical.status, 0, "critical-only problems 下 minor 不要求处置应放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
