// check-gate-prompt-parity.test.mjs —「有 gate 无前置提示」护栏的三对账 fixture 测试
//
// 被测实现：scripts/check-gate-prompt-parity.mjs。fixture 为临时最小仓库（--root 指向），
// 每个用例验证一类红灯/绿灯形态，不对本仓库状态做断言（并行修复期间的仓库红绿由主会话
// 运行脚本观察，不进测试）。
//
// 用例：
//   1. 全绿 fixture → exit 0
//   2. workflow 未供给条件必查旗标 --empty-scope-refutation → exit 1 带 file:line
//   3. guardrails.documentation 的 requiredIn 文件关键词零命中 → exit 1
//   4. P0-N 死引用（rubric 无定义编号）→ exit 1
//   5. P0-V 系列无 rubric 定义 → exit 1
//   6. scripts/*.mjs 引用不存在 → exit 1
//   7. gate INTENT_SPECS 提取失败 → exit 2（脚本自身错误，不谎报业务红灯）
//
// 运行：node --test scripts/tests/check-gate-prompt-parity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const GATE_FIXTURE = `const INTENT_SPECS = {
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
    case "EvidenceRecorded":
      return ["record-evidence", ...base, "--summary", event.summary,
        "--contract-capability-ids", JSON.stringify(event.contractCapabilityIds), "--runtime-probe"];
    default:
      throw new Error(\`intentArgsFor 未路由事件类型 \${event.type}\`);
  }
}
`;

const WORKFLOW_MISSING_FLAG = `// BOUNDARY_RULE fixture（护栏判据关键词在场）
function intentArgsFor(event: DeliveryEvent): string[] {
  const base = ["--task-dir", taskDir, "--channel", "workflow"];
  switch (event.type) {
    case "FindingRaised":
      return ["record-finding", ...base, "--summary", event.summary,
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

function rulesFixture(roleFile) {
  return JSON.stringify({
    guardrails: {
      boundaryBanOnAssertedRequirements: true,
      documentation: {
        boundaryBanOnAssertedRequirements: {
          keywords: ["BOUNDARY_RULE"],
          requiredIn: [roleFile, `${WORKFLOWS}/candidate-build-v6.shared.ts`],
        },
      },
    },
  }, null, 2);
}

function createFixture({ workflow = WORKFLOW_ALL_FLAGS, roleDoc = "判据：BOUNDARY_RULE 在场即算登记。\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-prompt-parity-"));
  writeFile(root, `${DELIVERY}/scripts/delivery-gate.mjs`, GATE_FIXTURE);
  writeFile(root, `${DELIVERY}/scripts/kernel/rules.json`, rulesFixture(`${DELIVERY}/references/roles/explorer.md`));
  writeFile(root, `${DELIVERY}/references/roles/explorer.md`, roleDoc);
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
  // 对账 3 fixture：一个 rubric + 一条现存编号引用 + 一个可解析的脚本引用
  writeFile(root, `${TECH}/review/rubric-design-doc.md`, "| P0-7 | fixture 检查项 |\n");
  writeFile(root, `${TECH}/scripts/check-design-doc.mjs`, "// fixture 脚本\n");
  writeFile(root, `${TECH}/references/guide.md`, "见 rubric-design-doc.md 的 P0-7（`scripts/check-design-doc.mjs`）。\n");
  return root;
}

function run(root) {
  return runMjsScript(CHECKER, ["--root", root]);
}

test("全绿 fixture：三对账无红灯，exit 0", (t) => {
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
