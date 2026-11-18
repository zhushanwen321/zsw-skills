import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECKER = join(ROOT, "skills", "self", "dev-workflow", "delivery-v4", "scripts", "check-quality-contract.mjs");
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "quality-contract-v4-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskDir = join(root, "task");
  const designDir = join(root, "design");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(designDir, { recursive: true });
  writeJson(join(taskDir, "acceptance.json"), {
    schemaVersion: 2,
    requirements: [{ id: "R1", assertions: [{ id: "A1" }] }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", testAssetRefs: ["verify-af1"] }],
  });
  writeJson(join(designDir, "s3-solution.json"), { decisions: [{ id: "D1" }] });
  return { root, taskDir, designDir };
}

function run(taskDir, kind, path) {
  return spawnSync(process.execPath, [CHECKER, "--task-dir", taskDir, kind, path], { encoding: "utf8" });
}
function validS4() {
  return {
    criterionMechanisms: [{ assertionId: "A1", decisionIds: ["D1"], mechanismRefs: ["D1.choice"], consistency: "pass", counterexample: "未发现能满足机制却违反断言的输入", resolution: "" }],
    verificationBindings: [{ adversarialFormId: "AF1", testRef: "verify-af1", preconditions: ["在途任务"], actions: ["等待中关闭"], assertions: ["存储零新增"] }],
  };
}

test("设计目录缺对账与绑定时失败，补齐后通过", (t) => {
  const fx = fixture(t);
  writeJson(join(fx.designDir, "s4-accept.json"), {});
  let result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /criterionMechanisms|verificationBindings/);
  writeJson(join(fx.designDir, "s4-accept.json"), validS4());
  result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 0, result.stdout);
});

test("机制冲突未清零时不得通过", (t) => {
  const fx = fixture(t);
  const s4 = validS4();
  s4.criterionMechanisms[0].consistency = "conflict";
  writeJson(join(fx.designDir, "s4-accept.json"), s4);
  const result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /consistency=conflict/);
});

test("consistency 三值词表：not-applicable 带理由通过、空理由拒；conflict 带 resolution 通过、缺 resolution 拒", (t) => {
  const fx = fixture(t);
  // not-applicable + counterexample 理由 → 通过
  const na = validS4();
  na.criterionMechanisms[0].consistency = "not-applicable";
  writeJson(join(fx.designDir, "s4-accept.json"), na);
  let result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 0, result.stdout);
  // not-applicable + 空理由 → 拒
  const naEmpty = validS4();
  naEmpty.criterionMechanisms[0].consistency = "not-applicable";
  naEmpty.criterionMechanisms[0].counterexample = "";
  writeJson(join(fx.designDir, "s4-accept.json"), naEmpty);
  result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not-applicable.*缺不适用理由/);
  // conflict + resolution → 通过（机器只拦无处置结果的 conflict；T2 完成口径要求最终清零）
  const conflictResolved = validS4();
  conflictResolved.criterionMechanisms[0].consistency = "conflict";
  conflictResolved.criterionMechanisms[0].resolution = "改用方案 B 的机制消除冲突（处置完成）";
  writeJson(join(fx.designDir, "s4-accept.json"), conflictResolved);
  result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 0, result.stdout);
  // 词表外值 → 拒
  const bad = validS4();
  bad.criterionMechanisms[0].consistency = "maybe";
  writeJson(join(fx.designDir, "s4-accept.json"), bad);
  result = run(fx.taskDir, "--design-dir", fx.designDir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /词表/);
});

test("场景不适用豁免：exec-plan.formNotApplicable 带理由的场景不要求进 acceptancePlan/D3 节点，空理由拒", (t) => {
  const fx = fixture(t);
  const implPlanPath = join(fx.root, "impl.json");
  const execPlanPath = join(fx.root, "exec.json");
  // AF1 未进 acceptancePlan/nodes，带理由豁免 → 通过
  writeJson(implPlanPath, { acceptancePlan: [] });
  writeJson(execPlanPath, { planPath: implPlanPath, mode: "acceptance", acceptance: { nodes: [] }, formNotApplicable: [{ adversarialFormId: "AF1", rationale: "该场景的命令入口在本任务未启用" }] });
  let result = run(fx.taskDir, "--exec-plan", execPlanPath);
  assert.equal(result.status, 0, result.stdout);
  // 空理由 → 拒
  writeJson(execPlanPath, { planPath: implPlanPath, mode: "acceptance", acceptance: { nodes: [] }, formNotApplicable: [{ adversarialFormId: "AF1", rationale: "" }] });
  result = run(fx.taskDir, "--exec-plan", execPlanPath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /formNotApplicable.*缺不适用理由/);
  // 引用未知场景 → 拒
  writeJson(execPlanPath, { planPath: implPlanPath, mode: "acceptance", acceptance: { nodes: [] }, formNotApplicable: [{ adversarialFormId: "AF-UNKNOWN", rationale: "理由" }] });
  result = run(fx.taskDir, "--exec-plan", execPlanPath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /formNotApplicable 引用未知反例场景/);
});

test("执行计划必须覆盖全部反例场景，D3 节点也须覆盖", (t) => {
  const fx = fixture(t);
  const implPlanPath = join(fx.root, "impl.json");
  const execPlanPath = join(fx.root, "exec.json");
  writeJson(implPlanPath, { acceptancePlan: [] });
  writeJson(execPlanPath, { planPath: implPlanPath, mode: "acceptance", acceptance: { nodes: [] } });
  let result = run(fx.taskDir, "--exec-plan", execPlanPath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /acceptancePlan|acceptance.nodes/);
  writeJson(implPlanPath, { acceptancePlan: [{ id: "A1", adversarialFormRefs: ["AF1"] }] });
  writeJson(execPlanPath, { planPath: implPlanPath, mode: "acceptance", acceptance: { nodes: [{ id: "verify-af1", adversarialFormRefs: ["AF1"] }] } });
  result = run(fx.taskDir, "--exec-plan", execPlanPath);
  assert.equal(result.status, 0, result.stdout);
});
