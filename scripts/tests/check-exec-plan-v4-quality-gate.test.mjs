// check-exec-plan-v4-quality-gate.test.mjs — D0 编译门质量契约核对段的 CLI 行为测试
//
// 对应实现：skills/self/dev-workflow/dev-flow-v4/scripts/check-exec-plan.mjs 尾段——交付体系
// 任务（--task-dir）主校验、增量契约与验收绑定全过后调 delivery-v4 check-quality-contract，
// 且 designDocPath 可解析时追加传 --design-dir，使 D0 门覆盖机制对账（s4-accept.json
// criterionMechanisms）与测试绑定（verificationBindings）一致性（此前缺传 --design-dir，
// 该两段只在 tech-design 侧 T2 门核对，D0 漏检——review-fix-loop MF-1-7）。
//
// 差分测试（check-exec-plan-parity.test.mjs）只对账 validatePlanSchema / checkPlan 的
// schema 段（锚定 dev-flow-v5 版本），--task-dir 三段附加核对由本文件按 CLI 行为断言：
//   - 机制对账缺行（criterionMechanisms 无该断言行）→ FAIL: quality（含缺口文案）
//   - 机制与绑定齐备 → PASS exit 0（追加 --design-dir 后正常链路不误伤）
//
// 运行：node --test scripts/tests/check-exec-plan-v4-quality-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_SCRIPT = join(ROOT, "skills/self/dev-workflow/dev-flow-v4/scripts/check-exec-plan.mjs");

// 验收包联合哈希复刻（与 check-exec-plan.mjs / delivery-gate.mjs 同口径：解析内容规范
// JSON 的联合 sha256——绑定的是内容不是字节，键序/空白不影响）
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function acceptancePackageSha256(acceptanceParsed, incrementsParsed) {
  return createHash("sha256")
    .update(
      canonicalJson({
        "acceptance.json": canonicalJson(acceptanceParsed),
        "increments.json": canonicalJson(incrementsParsed),
      }),
      "utf8",
    )
    .digest("hex");
}

/** 构建全套 fixture：git 仓 + 设计包（六章节子集）+ 交付任务目录 + exec-plan。
 *  s4 形态可注入——缺行场景与齐备场景共用基座 */
function buildFixture(t, s4) {
  const root = mkdtempSync(join(tmpdir(), "v4-quality-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const designParent = join(root, "tech-design");
  const designDir = join(designParent, "pkg");
  const taskDir = join(root, "task");
  mkdirSync(project);
  mkdirSync(designDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });

  // 设计包：渲染视图 + 设计目录（meta / s3 / s4）——designDocPath → 设计目录推导的
  // 契约形态（.rendered.md 同级 <name>/ 目录）
  writeFileSync(join(designParent, "pkg.rendered.md"), "# design\n");
  const acceptance = {
    schemaVersion: 2,
    acceptanceVersion: 2,
    requirements: [{ id: "req-1", assertions: [{ id: "as-1", text: "断言一" }] }],
    adversarialForms: [{ id: "af-1", testAssetRefs: ["tests/af-1.test.mjs"] }],
  };
  const increments = {
    schemaVersion: 1,
    acceptanceVersion: 2,
    items: [{ id: "inc-1", title: "增量一", requirementIds: ["req-1"], testCommand: { program: "node", args: ["--test", "tests/"] } }],
  };
  writeFileSync(join(designDir, "meta.json"), JSON.stringify({
    acceptanceBinding: {
      taskDir,
      acceptanceVersion: 2,
      acceptancePackageSha256: acceptancePackageSha256(acceptance, increments),
    },
  }));
  writeFileSync(join(designDir, "s3-solution.json"), JSON.stringify({ decisions: [{ id: "dec-1", title: "决策一" }] }));
  writeFileSync(join(designDir, "s4-accept.json"), JSON.stringify(s4));

  // 交付任务目录：acceptance.json + increments.json（binding 哈希与之对账）
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify(acceptance));
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify(increments));

  // impl-plan（check-quality-contract 读 execPlan.planPath 取 acceptancePlan）+ exec-plan
  const planPath = join(root, "pkg.impl-plan.json");
  writeFileSync(planPath, JSON.stringify({ acceptancePlan: [{ adversarialFormRefs: ["af-1"] }] }));
  const execPlanPath = join(root, "pkg.exec-plan.json");
  writeFileSync(execPlanPath, JSON.stringify({
    version: 1,
    skillVersion: "4.2.0",
    mode: "dev",
    projectRoot: project,
    planPath,
    designDocPath: join(designParent, "pkg.rendered.md"),
    baseline: "abc1234def5678abc1234def5678abc1234abcd",
    statusPath: join(root, "pkg.status.json"),
    commitTemplate: "feat(pkg): {unitId} — {summary}",
    testPlan: { fullSuite: { program: "node", args: ["--test"] } },
    nodes: [
      {
        id: "u-1",
        kind: "dev",
        deps: [],
        incrementId: "inc-1",
        territory: ["src/"],
        testCommand: { program: "node", args: ["--test", "tests/"] },
        promptFile: join(root, "pkg.prompts/u-1.md"),
      },
    ],
  }));
  return { execPlanPath, taskDir };
}

function runCli(fx) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, fx.execPlanPath, "--task-dir", fx.taskDir], { encoding: "utf8" });
}

const FULL_S4 = {
  criterionMechanisms: [
    { assertionId: "as-1", decisionIds: ["dec-1"], mechanismRefs: ["§3.1"], consistency: "pass", counterexample: "已核无反例：正常路径与边界各走一遍" },
  ],
  verificationBindings: [
    { adversarialFormId: "af-1", testRef: "tests/af-1.test.mjs", preconditions: ["环境就绪"], actions: ["执行反例操作"], assertions: ["失败路径断言"] },
  ],
};

test("D0 门质量契约核对：criterionMechanisms 缺断言行 → FAIL: quality（--design-dir 已追加传参）", (t) => {
  const s4 = { criterionMechanisms: [], verificationBindings: FULL_S4.verificationBindings };
  const fx = buildFixture(t, s4);
  const r = runCli(fx);
  assert.equal(r.status, 1, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /^FAIL: quality: /m, `应含 quality 分类行，实际：${r.stdout}`);
  assert.match(r.stdout, /断言 as-1 缺 criterionMechanisms 对账行/, `缺口文案应在输出中（证明 --design-dir 已传、机制对账段已执行），实际：${r.stdout}`);
});

test("D0 门质量契约核对：机制与绑定齐备 → PASS exit 0（追加 --design-dir 不误伤正常链路）", (t) => {
  const fx = buildFixture(t, FULL_S4);
  const r = runCli(fx);
  assert.equal(r.status, 0, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), "PASS");
});
