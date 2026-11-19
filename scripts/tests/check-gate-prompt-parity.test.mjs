// check-gate-prompt-parity.test.mjs —「有 gate 无前置提示」护栏的五对账 fixture 测试
//
// 被测实现：scripts/check-gate-prompt-parity.mjs。fixture 为临时最小仓库（--root 指向，
// --global-agents-dir 指向 fixture 内全局副本目录），每个用例验证一类红灯/绿灯形态，
// 不对本仓库状态做断言（并行修复期间的仓库红绿由主会话运行脚本观察，不进测试）。
//
// 用例：
//   1. 全绿 fixture → exit 0
//   2. workflow 未供给条件必查旗标 --empty-scope-refutation → exit 1 带 file:line
//   3. guardrails.documentation 的 requiredIn 文件关键词零命中 → exit 1
//   4. P0-N 死引用（rubric 无定义编号）→ exit 1
//   5. P0-V 系列无 rubric 定义 → exit 1
//   6. scripts/*.mjs 引用不存在 → exit 1
//   7. gate INTENT_SPECS 提取失败 → exit 2（脚本自身错误，不谎报业务红灯）
//   8. 对账 1 三面化：pi 壳 findings 条目 SCHEMA 缺实传字段（R1-03 形态）→ exit 1
//   9. 对账 1 三面化：prompt 声明行含 "|null"（R1-26 形态）→ exit 1
//  10. 对账 4：副本正文与源不一致（model/color 行差异放行）→ exit 1
//  11. 对账 4：运行时副本缺失 → exit 1
//  12. 对账 3/R1-20：value-review agent 的 P0-V-N 未在 rubric-value-review.md 定义 → exit 1
//  13. 对账 5：策略键消费方 token 零命中（死键形态）→ exit 1
//  14. 对账 5：evidenceKinds 策略词表与 gate 常量不同值 → exit 1
//
// 运行：node --test scripts/tests/check-gate-prompt-parity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMjsScript } from "./helpers/mjs-runner.mjs";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "..", "check-gate-prompt-parity.mjs");
const DEV = "skills/self/dev-workflow";
const DELIVERY = `${DEV}/delivery-v6`;
const TECH = `${DEV}/tech-design-v6`;
const WORKFLOWS = `${DEV}/workflows/src`;

function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const GATE_FIXTURE = `const EVIDENCE_KINDS = ["command", "scenario", "inspection"];
const GUARDRAIL_KEYS = { boundaryBanOnAssertedRequirements: true, regradeHaltEnabled: false, emptyScopeBoundaryRequiresRefutation: true, consequenceRefutationRequired: true };

const INTENT_SPECS = {
  "record-implementation": {
    type: "ImplementationRecorded",
    role: "builder",
    required: ["task-dir", "summary", "credential"],
    optional: ["revision", "run-id"],
    build: () => ({}),
  },
  "record-repair-round": {
    type: "RepairRoundRecorded",
    role: "builder",
    required: ["task-dir", "round", "summary", "credential"],
    optional: ["revision", "run-id"],
    build: () => ({}),
  },
  "record-finding": {
    type: "FindingRaised",
    role: null,
    required: ["task-dir", "summary", "credential"],
    optional: ["requirement-ids", "consequence-refutation", "consequence-refutation-type", "empty-scope-refutation", "contract-capability-ids", "authority-backed", "authority-hash", "authority-observation-ref", "revision", "run-id"],
    jsonFields: { "requirement-ids": "requirementIds" },
    build: () => ({}),
  },
  "resolve-finding": {
    type: "FindingResolved",
    role: "assurance",
    required: ["task-dir", "finding-id", "summary", "credential"],
    optional: ["revision", "run-id"],
    build: () => ({}),
  },
  "record-evidence": {
    type: "EvidenceRecorded",
    role: "assurance",
    required: ["task-dir", "requirement-id", "summary", "credential"],
    optional: ["assertion-ids", "contract-capability-ids", "revision", "run-id"],
    flags: ["runtime-probe"],
    jsonFields: { "assertion-ids": "assertionIds" },
    build: () => ({}),
  },
};

function guarded(guardrailStrict, message) {
  if (guardrailStrict) {
    fail(message, "补充 --empty-scope-refutation 后重登");
  }
  if (!message) {
    if (guardrailStrict) {
      fail(message, "补充 --authority-backed --authority-hash --authority-observation-ref 后重登");
    }
  }
}
`;

const WORKFLOW_ALL_FLAGS = `// BOUNDARY_RULE fixture（护栏判据关键词在场）
interface FindingDraft {
  summary: string;
  emptyScopeRefutation?: string;
  consequenceRefutation?: string;
  consequenceRefutationType?: string;
  contractCapabilityIds?: string[];
  authorityBacked?: boolean;
  authorityHash?: string;
  authorityObservationRef?: string;
}

const FINDINGS_DECLARATION = '返回结构（严格 JSON）：{ "summary": string, "findings": [{ "summary": string, "emptyScopeRefutation": string, "consequenceRefutation": string, "consequenceRefutationType": string, "contractCapabilityIds": string[], "authorityBacked": boolean, "authorityHash": string, "authorityObservationRef": string }] }';

function intentArgsFor(event: DeliveryEvent): string[] {
  const base = ["--task-dir", taskDir, "--channel", "workflow"];
  switch (event.type) {
    case "FindingRaised":
      return ["record-finding", ...base, "--summary", event.summary,
        "--empty-scope-refutation", String(event.emptyScopeRefutation),
        "--consequence-refutation", String(event.consequenceRefutation),
        "--consequence-refutation-type", String(event.consequenceRefutationType),
        "--contract-capability-ids", JSON.stringify(event.contractCapabilityIds),
        "--authority-backed", "true", "--authority-hash", String(event.authorityHash),
        "--authority-observation-ref", String(event.authorityObservationRef)];
    default:
      throw new Error(\`intentArgsFor 未路由事件类型 \${event.type}\`);
  }
}
`;

const WORKFLOW_MISSING_FLAG = WORKFLOW_ALL_FLAGS.replace(
  '        "--empty-scope-refutation", String(event.emptyScopeRefutation),\n',
  "",
);

const PI_SHELL_FIXTURE = `// pi 壳 fixture：findings 条目 SCHEMA（与 shared.ts prompt 声明逐字段对齐）
const SCHEMA_FindingDraft = {
  type: "object",
  properties: {
    summary: { type: "string", description: "缺陷现象与影响" },
    emptyScopeRefutation: { type: "string", description: "空关联 boundary 的论证" },
    consequenceRefutation: { type: "string" },
    consequenceRefutationType: { type: "string" },
    contractCapabilityIds: { type: "array", items: { type: "string" } },
    authorityBacked: { type: "boolean" },
    authorityHash: { type: "string" },
    authorityObservationRef: { type: "string" },
  },
  required: ["summary"],
};

const SCHEMA_BY_KEY = {
  BuilderOutcome: {
    type: "object",
    properties: { findings: { type: "array", items: SCHEMA_FindingDraft } },
    required: ["summary", "findings"],
  },
};
`;

// agent 源与副本 fixture：正文一致，仅 frontmatter model 行特化（对账 4 放行该差异）
const AGENT_SOURCE_DOC = `---
name: "tech-design-value-review"
description: "fixture agent"
color: yellow
model: "test/model-src"
thoughtLevel: max
---

# fixture value review agent

按 P0-V1 检查方向与量级（判据见 review/rubric-value-review.md）。
`;
const AGENT_COPY_DOC = AGENT_SOURCE_DOC.replace('model: "test/model-src"', 'model: "test/model-copy"');

function rulesFixture(roleFile) {
  return JSON.stringify({
    guardrails: {
      boundaryBanOnAssertedRequirements: true,
      regradeHaltEnabled: false,
      emptyScopeBoundaryRequiresRefutation: true,
      consequenceRefutationRequired: true,
      documentation: {
        boundaryBanOnAssertedRequirements: {
          keywords: ["BOUNDARY_RULE"],
          requiredIn: [roleFile, `${WORKFLOWS}/candidate-build-v6.shared.ts`],
        },
        regradeHaltEnabled: {
          keywords: ["BOUNDARY_RULE"],
          requiredIn: [roleFile, `${WORKFLOWS}/candidate-build-v6.shared.ts`],
        },
        emptyScopeBoundaryRequiresRefutation: {
          keywords: ["BOUNDARY_RULE"],
          requiredIn: [roleFile, `${WORKFLOWS}/candidate-build-v6.shared.ts`],
        },
        consequenceRefutationRequired: {
          keywords: ["BOUNDARY_RULE"],
          requiredIn: [roleFile, `${WORKFLOWS}/candidate-build-v6.shared.ts`],
        },
      },
    },
    budgets: { t2RewriteAttemptCap: 2, d2ItemReflowCap: 3 },
    predicates: { userConfirmation: { decider: "gate" } },
    domains: { task: {}, node: {}, finding: {}, exploration: {}, "acceptance-package": {} },
  }, null, 2);
}

const CORE_FIXTURE = `// delivery-core fixture（消费 token 在场）
const ADJUDICATION_PREDICATES = new Set(["userConfirmation"]);
const BUDGET_KEYS = { t2RewriteAttemptCap: 2, d2ItemReflowCap: 3 };
// decider 词表消费位：谓词裁决方分类
`;

function createFixture({ workflow = WORKFLOW_ALL_FLAGS, piShell = PI_SHELL_FIXTURE, roleDoc = "判据：BOUNDARY_RULE 在场即算登记。\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-prompt-parity-"));
  writeFile(root, `${DELIVERY}/scripts/delivery-gate.mjs`, GATE_FIXTURE);
  writeFile(root, `${DELIVERY}/scripts/kernel/rules.json`, rulesFixture(`${DELIVERY}/references/roles/explorer.md`));
  writeFile(root, `${DELIVERY}/scripts/delivery-core.mjs`, CORE_FIXTURE);
  writeFile(root, `${DELIVERY}/references/roles/explorer.md`, roleDoc);
  writeFile(root, `${DELIVERY}/policies/evidence-kinds.json`, JSON.stringify({
    evidenceKinds: ["command", "scenario", "inspection"],
    environmentKinds: ["fake-host", "official-runner", "real-host"],
  }, null, 2));
  writeFile(root, `${DELIVERY}/policies/finding-categories.json`, JSON.stringify({
    categories: { defect: { id: "defect", blocksAccepted: true, exits: ["fix-then-resolve"] } },
  }, null, 2));
  writeFile(root, `${DELIVERY}/policies/external-contract-classes.json`, JSON.stringify({
    schemaVersion: 1, classes: [],
  }, null, 2));
  writeFile(root, `${DELIVERY}/policies/known-answer-samples.json`, JSON.stringify({
    expectedStageAccuracy: "人工标注样例集说明（fixture）",
  }, null, 2));
  for (const name of [
    "acceptance-design-v6.shared.ts",
    "independent-assurance-v6.shared.ts",
    "assurance-repair-loop-v6.shared.ts",
    "wave-executor-v6.shared.ts",
    "dev-consistency-loop-v6.shared.ts",
    "tech-review-loop-v6.shared.ts",
  ]) {
    writeFile(root, `${WORKFLOWS}/${name}`, "// fixture：无意图命令映射\n");
  }
  writeFile(root, `${WORKFLOWS}/candidate-build-v6.shared.ts`, workflow);
  writeFile(root, `${WORKFLOWS}/candidate-build-v6.pi.tpl.js`, piShell);
  // 对账 3 fixture：rubric（design-doc 的 P0-7 + value-review 的 P0-V1）+ 现存脚本引用
  writeFile(root, `${TECH}/review/rubric-design-doc.md`, "| P0-7 | fixture 检查项 |\n");
  writeFile(root, `${TECH}/review/rubric-value-review.md`, "| P0-V1 | fixture 方向检查项 | 复述不出来 |\n");
  writeFile(root, `${TECH}/scripts/check-design-doc.mjs`, "// fixture 脚本\n");
  writeFile(root, `${TECH}/references/guide.md`, "见 rubric-design-doc.md 的 P0-7（`scripts/check-design-doc.mjs`）。\n");
  // 对账 4 fixture：源 agent + 两处运行时副本（正文一致，model 行特化）
  writeFile(root, `${TECH}/agents/tech-design-value-review.md`, AGENT_SOURCE_DOC);
  writeFile(root, ".zcode/agents/tech-design-value-review.md", AGENT_COPY_DOC);
  writeFile(root, "global-agents/tech-design-value-review.md", AGENT_COPY_DOC);
  return root;
}

function run(root) {
  return runMjsScript(CHECKER, ["--root", root, "--global-agents-dir", join(root, "global-agents")]);
}

test("全绿 fixture：五对账无红灯，exit 0", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 0, `应 exit 0：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /全绿/);
});

test("条件必查旗标未供给：workflow 缺 --empty-scope-refutation → exit 1 带 file:line", (t) => {
  const root = createFixture({ workflow: WORKFLOW_MISSING_FLAG });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /未供给条件必查旗标 --empty-scope-refutation/);
  assert.match(result.stdout, /candidate-build-v6\.shared\.ts:\d+/);
});

test("护栏关键词零命中：requiredIn 文件缺判据词 → exit 1", (t) => {
  const root = createFixture({ roleDoc: "只有流程描述，没有判据关键词。\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /explorer\.md（护栏 boundaryBanOnAssertedRequirements）→ 关键词零命中/);
});

test("P0-N 死引用：引用 rubric 未定义的编号 → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, `${TECH}/references/dead-ref.md`, "对应审查 P0-26。\n");
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /P0-26 在 rubric 无定义/);
});

test("P0-V 无 rubric：系列引用但无任何 P0-V 条目定义 → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  unlinkSync(join(root, `${TECH}/review/rubric-value-review.md`));
  writeFile(root, `${TECH}/references/value-ref.md`, "加载价值审判据（P0-V 系列），条目 P0-V1。\n");
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /P0-V/);
});

test("脚本路径引用不存在：scripts/ghost.mjs → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, `${TECH}/references/dead-script.md`, "运行 `node scripts/ghost.mjs`。\n");
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /scripts\/ghost\.mjs 在仓库不存在/);
});

test("gate 形态变化：INTENT_SPECS 提取失败 → exit 2（脚本自身错误）", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, `${DELIVERY}/scripts/delivery-gate.mjs`, "// 没有 INTENT_SPECS\n");
  const result = run(root);
  assert.equal(result.status, 2, `应 exit 2：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /脚本错误/);
});

test("对账 1 三面化：pi 壳 findings 条目 SCHEMA 缺实传字段（R1-03 形态）→ exit 1", (t) => {
  const root = createFixture({
    piShell: PI_SHELL_FIXTURE.replace(
      '    emptyScopeRefutation: { type: "string", description: "空关联 boundary 的论证" },\n',
      "",
    ),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /pi 壳 findings 条目 SCHEMA 缺字段 emptyScopeRefutation/);
  assert.match(result.stdout, /candidate-build-v6\.pi\.tpl\.js:\d+\(SCHEMA_FindingDraft\)/);
});

test("对账 1 三面化：prompt 声明行含 |null（R1-26 形态）→ exit 1", (t) => {
  const root = createFixture({
    workflow: WORKFLOW_ALL_FLAGS.replace(
      '"emptyScopeRefutation": string,',
      '"emptyScopeRefutation": string|null,',
    ),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /prompt 声明行含 "\|null"/);
  assert.match(result.stdout, /R1-26 形态/);
});

test("对账 1 三面化：interface FindingDraft 缺实传字段 → exit 1", (t) => {
  const root = createFixture({
    workflow: WORKFLOW_ALL_FLAGS.replace("  emptyScopeRefutation?: string;\n", ""),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /在 interface FindingDraft 缺定义/);
  assert.match(result.stdout, /字段 emptyScopeRefutation/);
});

test("对账 4：副本正文与源不一致（model/color 行差异放行）→ exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, ".zcode/agents/tech-design-value-review.md",
    AGENT_COPY_DOC.replace("按 P0-V1 检查方向与量级", "按 P0-V1 检查方向（旧副本表述）"));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /与运行时副本不一致/);
  assert.match(result.stdout, /\.zcode\/agents/);
});

test("对账 4：运行时副本缺失 → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  unlinkSync(join(root, ".zcode/agents/tech-design-value-review.md"));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /运行时副本缺失/);
});

test("对账 3/R1-20：value-review agent 的 P0-V-N 未在 rubric-value-review.md 定义 → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, ".zcode/agents/tech-design-value-review.md",
    AGENT_COPY_DOC.replace("按 P0-V1 检查方向与量级（判据见 review/rubric-value-review.md）。", "按 P0-V9 检查（判据见 review/rubric-value-review.md）。"));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /P0-V9 未在 rubric-value-review\.md 定义/);
});

test("对账 5：策略键消费方 token 零命中（死键形态）→ exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 桩替换 delivery-core（predicates.*.decider 的登记消费方）：token 缺席即零命中红灯。
  // budgets.t2RewriteAttemptCap 已入豁免登记（判定实装在 workflow 内嵌常量，C-12），豁免键
  // 的消费缺席按设计不红灯——旧断言以它为样例与豁免表自相矛盾，2026-11-19 换非豁免键
  writeFile(root, `${DELIVERY}/scripts/delivery-core.mjs`, "// delivery-core fixture：谓词裁决方 token 未接线\nconst ADJUDICATION_PREDICATES = new Set();\n");
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /策略键 predicates\.\*\.decider（谓词裁决方词表）\s*的消费 token decider 零命中/);
});

test("对账 5：evidenceKinds 策略词表与 gate 常量不同值 → exit 1", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFile(root, `${DELIVERY}/policies/evidence-kinds.json`, JSON.stringify({
    evidenceKinds: ["command", "scenario", "inspection", "manual-review"],
    environmentKinds: ["fake-host"],
  }, null, 2));
  const result = run(root);
  assert.equal(result.status, 1, `应 exit 1：stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /evidenceKinds 策略词表与 gate 判定常量不同值/);
  assert.match(result.stdout, /manual-review/);
});
