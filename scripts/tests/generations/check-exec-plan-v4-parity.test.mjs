// check-exec-plan-v4-parity.test.mjs — v4 校验器差分测试（wave-executor-v4 validatePlan ↔ dev-flow-v4 check-exec-plan）
//
// v1 差分（check-exec-plan-parity.test.mjs）只锚定 dev-flow-v1；v4 的 kind=review（过程审查
// 节点）扩展要求两侧逐字同源，本文件把 v4 纳入机器对账：从 pi 构建产物零转抄提取
// validatePlan 及依赖闭包实跑，与 validatePlanSchema 逐 fixture 断言 ok 与错误文案完全一致
//（错误顺序也一致——早退位置即契约）。
//
// 运行：node --test scripts/tests/check-exec-plan-v4-parity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { validatePlanSchema } from "../../../skills/self/dev-workflow/dev-flow-v4/scripts/check-exec-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PI_ARTIFACT = join(ROOT, "skills", "self", "dev-workflow", "workflows", "pi", "wave-executor-v4.js");

function loadReferenceValidatePlan() {
  const src = readFileSync(PI_ARTIFACT, "utf-8");
  const parts = [];
  for (const name of ["TEST_WHITELIST", "NOOP_CMD_STUB_RE", "NOOP_CMD_ECHO_RE", "NOOP_CMD_STUB_HEAD_RE", "SHELL_SAFE_ARG_RE"]) {
    const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(m, `构建产物中未找到 const ${name}——提取探针与实现失配，须同步更新探针`);
    parts.push(m[0]);
  }
  for (const name of ["shellQuoteArg", "noopCommandError", "isRec", "isStr", "isStrArr", "joinPath", "territoryFormatErrors", "detectCycle", "validatePlan"]) {
    const m = src.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"));
    assert.ok(m, `构建产物中未找到 function ${name}——提取探针与实现失配，须同步更新探针`);
    parts.push(m[0]);
  }
  return vm.runInNewContext(`${parts.join("\n")}\nvalidatePlan`, {}, { timeout: 5000 });
}

const referenceValidatePlan = loadReferenceValidatePlan();

const HASH = "abc1234def5678abc1234def5678abc1234abcd";

function legalDevPlan() {
  return {
    version: 1,
    mode: "dev",
    projectRoot: "/tmp/parity-v4",
    planPath: "/tmp/tech-design/parity/p.impl-plan.json",
    designDocPath: "/tmp/tech-design/parity/p.md",
    baseline: HASH,
    statusPath: "/tmp/skill-data/dev-flow/parity/p.status.json",
    testPlan: { fullSuite: { program: "pnpm", args: ["test"] } },
    commitTemplate: "feat(parity): {unitId} — {summary}",
    nodes: [
      { id: "u-1", kind: "dev", deps: [], designRef: "§3.2", territory: ["src/a/"], testCommand: { program: "pnpm", args: ["-C", "src/a", "test"] }, promptFile: "/tmp/prompts/u-1.md" },
      { id: "review-u-1", kind: "review", deps: ["u-1"], script: "scripts/check-a.mjs", promptFile: "/tmp/prompts/review-u-1.md", mechanism: "dependency-recheck" },
    ],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  };
}

function legalAcceptancePlan() {
  return {
    version: 1,
    mode: "acceptance",
    projectRoot: "/tmp/parity-v4",
    planPath: "/tmp/tech-design/parity/p.impl-plan.json",
    designDocPath: "/tmp/tech-design/parity/p.md",
    baseline: HASH,
    statusPath: "/tmp/skill-data/dev-flow/parity/p.status.json",
    testPlan: { fullSuite: { program: "pnpm", args: ["test"] } },
    nodes: [],
    acceptance: {
      groups: { core: [], nonCore: [] },
      nodes: [
        { id: "v-1", kind: "verify", deps: [], script: "scripts/verify/a.sh", artifactsDir: "out/accept/a" },
        { id: "i-1", kind: "inspect", deps: ["v-1"], promptFile: "/tmp/prompts/i-1.md", artifactsRefs: ["v-1"] },
      ],
    },
  };
}

const CASES = [
  { name: "合法 dev 计划（review 节点 script+promptFile 双配）", build: legalDevPlan, ok: true },
  { name: "合法 acceptance 计划", build: legalAcceptancePlan, ok: true },
  {
    name: "review 节点 script only（机器检查独立成节点）",
    build: () => { const p = legalDevPlan(); delete p.nodes[1].promptFile; return p; },
    ok: true,
  },
  {
    name: "review 节点 promptFile only（高风险声明驱动必审）",
    build: () => { const p = legalDevPlan(); delete p.nodes[1].script; return p; },
    ok: true,
  },
  {
    name: "review 节点 mechanism 缺省（合法，缺省 machine-check）",
    build: () => { const p = legalDevPlan(); delete p.nodes[1].mechanism; return p; },
    ok: true,
  },
  {
    name: "review 节点 script/promptFile 双无",
    build: () => { const p = legalDevPlan(); delete p.nodes[1].script; delete p.nodes[1].promptFile; return p; },
    ok: false,
    expect: /script 与 promptFile 至少填一项/,
  },
  {
    name: "acceptance 模式含 review 节点",
    build: () => { const p = legalAcceptancePlan(); p.acceptance.nodes.push({ id: "r-1", kind: "review", deps: ["v-1"], script: "scripts/check-a.mjs" }); return p; },
    ok: false,
    expect: /review 节点属 D1 过程审查/,
  },
  {
    name: "kind 词表外（review 扩展后的词表文案两侧一致）",
    build: () => { const p = legalDevPlan(); p.nodes[1].kind = "audit"; return p; },
    ok: false,
    expect: /kind 必须是 dev\/verify\/inspect\/review/,
  },
  {
    name: "review 节点 deps 引用不存在",
    build: () => { const p = legalDevPlan(); p.nodes[1].deps = ["u-ghost"]; return p; },
    ok: false,
    expect: /deps 引用了不存在的节点/,
  },
];

for (const c of CASES) {
  test(`v4 差分：${c.name}`, () => {
    const raw = c.build();
    const ref = referenceValidatePlan(raw);
    const port = validatePlanSchema(raw);
    assert.equal(
      port.ok,
      ref.ok,
      `ok 不一致：ref=${ref.ok} port=${port.ok}（ref errors=${JSON.stringify(ref.errors)}；port errors=${JSON.stringify(port.errors)}）`,
    );
    assert.equal(ref.ok, c.ok, `预期 ok=${c.ok}，ref 实际=${ref.ok}（${JSON.stringify(ref.errors)}）`);
    if (!ref.ok) {
      assert.deepEqual(
        port.errors.map((e) => e.message),
        [...ref.errors],
        "错误文案不一致（顺序与逐字须完全相同）",
      );
      if (c.expect !== undefined) {
        assert.ok(
          ref.errors.some((m) => c.expect.test(m)),
          `错误文案未含预期片段 ${c.expect}：${JSON.stringify(ref.errors)}`,
        );
      }
    }
  });
}
