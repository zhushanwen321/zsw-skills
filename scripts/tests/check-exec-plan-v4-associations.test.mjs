// check-exec-plan-v4-associations.test.mjs — 三类关联声明编译期对账的 CLI 行为测试
//
// 对应实现：dev-flow-v4/scripts/check-exec-plan.mjs 的 checkAssociations（D0 编译门附加段）。
// 对账规则 = co-change 关联的 trigger/related 必须落进实施计划且同 dev 节点覆盖（跨文件
// 契约改动拆节点 = 另一侧漏改在过程中不可见）；exempt 必须带非空理由。语义是否合理
// 不由本门判定（归影响面审），本文件只断言结构判据与错误分类。
//
// 运行：node --test scripts/tests/check-exec-plan-v4-associations.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkPlan } from "../../skills/self/dev-workflow/dev-flow-v4/scripts/check-exec-plan.mjs";

const HASH = "abc1234def5678abc1234def5678abc1234abcd";

function basePlan() {
  return {
    version: 1,
    mode: "dev",
    projectRoot: "/tmp/assoc-project",
    planPath: "/tmp/tech-design/assoc/p.impl-plan.json",
    designDocPath: "/tmp/tech-design/assoc/p.md",
    baseline: HASH,
    statusPath: "/tmp/skill-data/dev-flow/assoc/p.status.json",
    testPlan: { fullSuite: { program: "pnpm", args: ["test"] } },
    commitTemplate: "feat(assoc): {unitId} — {summary}",
    nodes: [
      { id: "u-1", kind: "dev", deps: [], designRef: "§3.2", territory: ["src/a/"], testCommand: { program: "pnpm", args: ["-C", "src/a", "test"] }, promptFile: "/tmp/prompts/u-1.md" },
      { id: "u-2", kind: "dev", deps: ["u-1"], designRef: "§3.3", territory: ["src/b/"], testCommand: { program: "npm", args: ["test"] }, promptFile: "/tmp/prompts/u-2.md" },
    ],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  };
}

function assocErrors(raw) {
  return checkPlan(raw).errors.filter((e) => e.category === "assoc");
}

function withAssoc(assoc) {
  const p = basePlan();
  p.associations = assoc;
  return p;
}

test("无 associations 字段 → 无 assoc 错误（可选字段）", () => {
  assert.deepEqual(assocErrors(basePlan()), []);
});

test("co-change 同节点覆盖 → 无 assoc 错误", () => {
  const raw = withAssoc([{ id: "a-1", kind: "contract", trigger: "src/a/gate.mjs", related: ["src/a/workflow.ts"], action: "co-change" }]);
  assert.deepEqual(assocErrors(raw), []);
});

test("co-change 跨 dev 节点 → FAIL assoc（分属不同节点）", () => {
  const raw = withAssoc([{ id: "a-1", kind: "contract", trigger: "src/a/gate.mjs", related: ["src/b/workflow.ts"], action: "co-change" }]);
  const errs = assocErrors(raw);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /分属不同 dev 节点/);
  assert.match(errs[0].message, /u-1/);
  assert.match(errs[0].message, /u-2/);
});

test("co-change 文件未被任何节点 territory 覆盖 → FAIL assoc（需改项未落计划）", () => {
  const raw = withAssoc([{ id: "a-1", kind: "registry", trigger: "src/c/roles.json", related: ["src/a/gate.mjs"], action: "co-change" }]);
  const errs = assocErrors(raw);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /未被任何 dev 节点 territory 覆盖/);
  assert.match(errs[0].message, /src\/c\/roles.json/);
});

test("exempt 带理由 → 跨节点与未覆盖均豁免", () => {
  const raw = withAssoc([{ id: "a-1", kind: "contract", trigger: "src/c/x.mjs", related: ["src/b/y.mjs"], action: "exempt", rationale: "另一侧已废弃，下迭代删除" }]);
  assert.deepEqual(assocErrors(raw), []);
});

test("exempt 无理由 → FAIL assoc（空理由等于没登记豁免）", () => {
  const raw = withAssoc([{ id: "a-1", kind: "contract", trigger: "src/a/x.mjs", related: ["src/a/y.mjs"], action: "exempt" }]);
  const errs = assocErrors(raw);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /rationale/);
});

test("associations 非数组 → FAIL assoc", () => {
  const raw = withAssoc({ id: "a-1" });
  const errs = assocErrors(raw);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /必须是数组/);
});

test("kind/action 非法 → FAIL assoc（枚举校验）", () => {
  const raw = withAssoc([{ id: "a-1", kind: "link", trigger: "src/a/x.mjs", related: ["src/a/y.mjs"], action: "sync" }]);
  const errs = assocErrors(raw);
  assert.ok(errs.some((e) => /kind 必须是 contract\/registry\/build-artifact/.test(e.message)));
  assert.ok(errs.some((e) => /action 必须是 co-change\/exempt/.test(e.message)));
});

test("trigger 绝对路径 / related 空数组 → FAIL assoc（路径形态）", () => {
  const raw = withAssoc([{ id: "a-1", kind: "contract", trigger: "/abs/x.mjs", related: [], action: "co-change" }]);
  const errs = assocErrors(raw);
  assert.ok(errs.some((e) => /trigger 须为相对仓库根路径/.test(e.message)));
  assert.ok(errs.some((e) => /related 须为非空相对路径数组/.test(e.message)));
});

test("acceptance 模式跳过关联对账（D3 不重复 D0 判据）", () => {
  const p = basePlan();
  p.mode = "acceptance";
  p.nodes = [];
  p.acceptance = { groups: { core: [], nonCore: [] }, nodes: [{ id: "v-1", kind: "verify", deps: [], script: "scripts/verify/a.sh", artifactsDir: "out/a" }] };
  p.associations = "not-an-array";
  assert.deepEqual(assocErrors(p), []);
});
