import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
