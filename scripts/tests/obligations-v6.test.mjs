// obligations-v6.test.mjs — 交付义务派生与 accepted 前置回归
// （设计《V5 交付完整性与语义可信性改造》机制三 §7.1）
//
// 覆盖：
//   1. 纯函数 deriveObligations：断言/需求两级证据义务 state 映射（verified→satisfied、
//      已接受风险→explicitly-waived、其余→open）、阶段义务复用 verdict.missing、受控修复轮
//      satisfied 披露、pending 待办 open、策略允许跳过 design 时不生成该阶段义务
//   2. CLI obligations 子命令：全登记任务无 openRequired（正常路径零误伤）
//   3. blocking 待办进入 accepted 前置：open pending → 不得 accepted（verdict 列明
//      open 义务清单与恢复动作）→ resolve 后 accepted 恢复
//   4. 显式豁免绑定用户裁决：accepted_with_risk 场景中缺口义务 state=explicitly-waived
//      （数据源头是签名 RiskAccepted 事件，无凭空 waived）
//
// 运行：node --test scripts/tests/obligations-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const KERNEL = await import(join(V6, "scripts", "lib", "kernel-judgments.mjs"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
function runCore(args, home) {
  return spawnSync(process.execPath, [CORE, ...args], { encoding: "utf8", env: { ...process.env, ...(home ? { HOME: home } : {}) }, timeout: 60_000 });
}
function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// ── 1. 纯函数 ──

const verdictView = (overrides = {}) => ({
  requirements: [
    {
      id: "R1", required: true,
      evidence: [
        { kind: "command", result: "partial", eventId: "EV-1", gapId: "GAP-R1-CMD", riskAccepted: false },
        { kind: "inspection", result: "partial", eventId: "EV-2", gapId: "GAP-R1-INS", riskAccepted: true },
      ],
      assertions: [{
        id: "A1",
        evidence: [
          { kind: "command", result: "partial", eventId: "EV-A1", gapId: "GAP-A1-CMD", riskAccepted: false },
          { kind: "inspection", result: "failed", eventId: "EV-3", gapId: "GAP-3", riskAccepted: false },
        ],
      }],
    },
    {
      id: "R2", required: false,
      evidence: [{ kind: "command", result: "missing", eventId: null, gapId: "GAP-M", riskAccepted: false }],
    },
  ],
  missing: { designApproval: false, incrementIds: [], assuranceCompleted: false, explorationCompleted: false },
  ...overrides,
});
const acceptanceView = { schemaVersion: 2 };

test("deriveObligations：断言义务三级 state 映射 + 非必需需求不进 openRequired", () => {
  const result = KERNEL.deriveObligations({ verdict: verdictView(), acceptance: acceptanceView });
  const byId = new Map(result.obligations.map((item) => [item.id, item]));
  assert.equal(byId.get("assert-A1-command").state, "open", "未接受的必需断言缺口 → open");
  assert.deepEqual(byId.get("assert-A1-command").evidenceRefs, ["GAP-A1-CMD"], "open/waived 绑缺口 id（accept-risk 对账锚点）");
  assert.equal(byId.get("assert-A1-inspection").state, "explicitly-waived", "需求级已接受的缺口 → 豁免（豁免语义与 verdict 单源）");
  assert.deepEqual(byId.get("assert-A1-inspection").evidenceRefs, ["GAP-R1-INS"], "豁免绑定需求级缺口 id（RiskAccepted.gapId 裁决锚点）");
  // R2 非必需：义务披露但 required=false，缺口不进 openRequired（accepted 只看必需义务）
  assert.equal(byId.get("assert-R2-command").required, false);
  assert.equal(byId.get("assert-R2-command").state, "open");
  assert.ok(!result.openRequired.some((item) => item.id === "assert-R2-command"), "非必需需求的缺口不阻 accepted");
  assert.deepEqual(result.openRequired.map((item) => item.id), ["assert-A1-command"], "必需断言 open 进 openRequired");
});

test("deriveObligations：schema 1 降级需求×类型粒度；阶段义务复用 missing；修复轮与 pending 派生", () => {
  const verdict = verdictView({
    requirements: [
      {
        id: "R1", required: true,
        evidence: [{ kind: "command", result: "missing", eventId: null, gapId: "GAP-1", riskAccepted: false }],
      },
    ],
    missing: { designApproval: false, incrementIds: [], assuranceCompleted: true, explorationCompleted: true },
  });
  delete verdict.requirements[0].assertions;
  const records = [
    { seq: 9, eventId: "RR-1", type: "RepairRoundRecorded", round: 1 },
  ];
  const pendingItems = [{ id: "pa-1", status: "open", note: "善后：清理临时探针" }];
  const result = KERNEL.deriveObligations({ verdict, acceptance: { schemaVersion: 1 }, records, pendingItems });
  const byId = new Map(result.obligations.map((item) => [item.id, item]));
  assert.ok(byId.has("assert-R1-command"), "schema 1 无断言层：义务粒度 = 需求×证据类型");
  assert.equal(byId.get("stage-design-approval").state, "satisfied", "missing.designApproval=false → satisfied");
  assert.equal(byId.get("stage-implementation").state, "satisfied");
  assert.equal(byId.get("stage-assurance").state, "open", "missing.assuranceCompleted=true → open");
  assert.equal(byId.get("stage-exploration").state, "open");
  assert.equal(byId.get("repair-RR-1").state, "satisfied", "受控修复轮登记即 satisfied（披露视图）");
  assert.equal(byId.get("pending-pa-1").state, "open", "open 待办即 open 义务");
  assert.ok(result.openRequired.some((item) => item.id === "pending-pa-1"));
  assert.ok(result.openRequired.some((item) => item.id === "stage-assurance"));
});

test("deriveObligations：策略允许跳过 design 与 verificationOnly 时不生成 design 阶段义务", () => {
  const verdict = verdictView();
  const withDesign = KERNEL.deriveObligations({ verdict, acceptance: acceptanceView, designStageRequired: true });
  assert.ok(withDesign.obligations.some((item) => item.id === "stage-design-approval"), "必需 design 时生成阶段义务");
  const skipped = KERNEL.deriveObligations({ verdict, acceptance: acceptanceView, designStageRequired: false });
  assert.ok(!skipped.obligations.some((item) => item.id === "stage-design-approval"), "策略允许跳过 design 不生成义务（与状态路由同一判定源）");
  const verificationOnly = KERNEL.deriveObligations({ verdict, acceptance: acceptanceView, verificationOnly: true });
  assert.ok(!verificationOnly.obligations.some((item) => item.id === "stage-design-approval"), "只核验模式无 design 阶段义务");
});

// ── 2-4. 真实任务目录端到端 ──

function makeFixture(t, { taskId = "obligations" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "obligations-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(projectDir);
  mkdirSync(home);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: projectDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: projectDir });
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectDir });
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "关闭后零写入；开启时读写正常\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

function evidenceFile(fx, name) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, `# ${name}\n`);
  return `evidence/${name}`;
}

/** 推进到「已批准 + 方案确认 + 实现 + 探索」。R1 必需（command+inspection，不可接受风险），
 * R2 可接受风险（command）——两条需求的证据均未登记，由各用例自行补齐。 */
function driveToImplemented(t) {
  const fx = makeFixture(t);
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: basename(fx.taskDir),
    projectRoot: realpathSync(fx.projectDir),
    objective: "关闭后零写入，开启时正常",
    requirements: [
      {
        id: "R1", kind: "invariant", statement: "关闭后任何路径零写入", required: true, riskAcceptable: false,
        evidenceKinds: ["command", "inspection"],
        assertions: [
          { id: "A1", statement: "关闭后不写", qualifiers: ["关闭"], given: "关闭", when: "写入", then: "不写", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"] },
        ],
      },
      {
        id: "R2", kind: "goal", statement: "开启时读写正常", required: true, riskAcceptable: true,
        evidenceKinds: ["command"],
        assertions: [
          { id: "A2", statement: "开启可写入", qualifiers: ["开启"], given: "开启", when: "写入", then: "成功", adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"] },
        ],
      },
    ],
    adversarialForms: [
      { id: "AF1", assertionId: "A1", qualifier: "关闭", entryPoint: "auto", initialState: "开启", operation: "关闭写入", timing: "命令期", expected: "不写", testAssetRefs: ["test-A1"], rationale: "关闭路径" },
      { id: "AF2", assertionId: "A2", qualifier: "开启", entryPoint: "repository", initialState: "开启", operation: "写入", timing: "正常路径", expected: "成功", testAssetRefs: ["test-A2"], rationale: "开启路径" },
    ],
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["smoke"],
  }, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "开关", requirementIds: ["R1", "R2"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  evidenceFile(fx, "acceptance-review-v1.md");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const solution = evidenceFile(fx, "solution.md");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, solution), "utf8")) }])}\n`);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "impl I1"], { cwd: fx.projectDir });
  const revision = runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim();
  ok(runGate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", evidenceFile(fx, "explore.md"), "--revision", revision,
    "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", evidenceFile(fx, "impl-I1.md"), "--merge-receipt", JSON.stringify({ fromRevision: revision, toRevision: revision, patchSha256: sha256("patch") }),
    "--revision", revision, "--credential", fx.creds.builder], fx.home));
  return { fx, revision };
}

/** 逐条登记证据 + full 保证（kindList 由调用方给定，未列出的证据缺口保留）。 */
function driveAssurance(fx, revision, kindList) {
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const explorationId = events.find((entry) => entry.type === "ExplorationCompleted").eventId;
  const evidenceIds = [];
  for (const [requirementId, assertionId, formId, kind] of kindList) {
    const append = runGate(["record-evidence", "--task-dir", fx.taskDir,
      "--requirement-id", requirementId, "--kind", kind, "--result", "verified", "--summary", `取证 ${requirementId}/${kind}`,
      "--artifact", evidenceFile(fx, `ev-${requirementId}-${kind}.md`), "--revision", revision,
      "--assertion-ids", JSON.stringify([assertionId]), "--adversarial-form-ids", JSON.stringify([formId]),
      "--credential", fx.creds.assurance], fx.home);
    ok(append, `证据 ${requirementId}/${kind} 登记`);
    evidenceIds.push(JSON.parse(parseStdout(append)).eventId);
  }
  ok(runGate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify(evidenceIds),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--clean-build", JSON.stringify({ buildId: "b1", artifactSha256: sha256("clean") }),
    "--artifact", evidenceFile(fx, "assurance-full.md"), "--revision", revision,
    "--credential", fx.creds.assurance], fx.home), "full 保证登记");
}

function evaluate(fx) {
  const result = runGate(["evaluate", "--task-dir", fx.taskDir], fx.home);
  ok(result, "evaluate 应成功");
  return JSON.parse(parseStdout(result));
}

test("obligations 子命令：全登记任务无 openRequired（正常路径零误伤）", (t) => {
  const { fx, revision } = driveToImplemented(t);
  driveAssurance(fx, revision, [
    ["R1", "A1", "AF1", "command"],
    ["R1", "A1", "AF1", "inspection"],
    ["R2", "A2", "AF2", "command"],
  ]);
  const result = JSON.parse(parseStdout(runCore(["obligations", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(result.acceptanceVersion, 1);
  assert.equal(result.openRequired.length, 0, "全登记任务无 open 必需义务");
  const byId = new Map(result.obligations.map((item) => [item.id, item]));
  assert.equal(byId.get("assert-A1-command").state, "satisfied");
  assert.equal(byId.get("assert-A2-command").state, "satisfied");
  for (const stageId of ["stage-design-approval", "stage-implementation", "stage-assurance", "stage-exploration"]) {
    assert.equal(byId.get(stageId).state, "satisfied", `${stageId} 应 satisfied`);
  }
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "义务视图不误伤正常交付路径");
  assert.deepEqual(verdict.missing.openObligations, [], "无 open 义务时清单为空");
});

test("blocking 待办进入 accepted 前置：open pending 阻断，resolve 后恢复", (t) => {
  const { fx, revision } = driveToImplemented(t);
  driveAssurance(fx, revision, [
    ["R1", "A1", "AF1", "command"],
    ["R1", "A1", "AF1", "inspection"],
    ["R2", "A2", "AF2", "command"],
  ]);
  ok(runCore(["pending", "add", "--task-dir", fx.taskDir, "--kind", "awaiting-restore", "--note", "额度中断，恢复后先核对保证回执"], fx.home), "登记待办");
  const before = JSON.parse(parseStdout(runCore(["obligations", "--task-dir", fx.taskDir], fx.home)));
  assert.deepEqual(before.openRequired.map((item) => item.id), ["pending-pa-1"], "子命令视角：open 待办即 open 必需义务");
  const blocked = evaluate(fx);
  assert.notEqual(blocked.state, "accepted", "open 必需义务阻断 accepted");
  assert.notEqual(blocked.state, "accepted_with_risk");
  assert.deepEqual(blocked.missing.openObligations.map((item) => item.id), ["pending-pa-1"]);
  assert.match(blocked.missing.openObligations[0].recovery, /pending resolve/, "恢复动作指向既有 pending 命令");
  ok(runCore(["pending", "resolve", "--task-dir", fx.taskDir, "--id", "pa-1", "--outcome", "回执已核对"], fx.home), "关闭待办");
  const after = JSON.parse(parseStdout(runCore(["obligations", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(after.openRequired.length, 0, "resolve 后义务闭环");
  const restored = evaluate(fx);
  assert.equal(restored.state, "accepted", "待办关闭后 accepted 恢复");
});

test("显式豁免绑定用户裁决：accepted_with_risk 场景缺口义务 state=explicitly-waived", (t) => {
  const { fx, revision } = driveToImplemented(t);
  // R2（riskAcceptable=true）证据不登记留缺口；R1 全登记
  driveAssurance(fx, revision, [
    ["R1", "A1", "AF1", "command"],
    ["R1", "A1", "AF1", "inspection"],
  ]);
  const gapVerdict = evaluate(fx);
  assert.equal(gapVerdict.state, "candidate", "R2 缺口未接受时应为 candidate");
  const gap = gapVerdict.requirements.find((r) => r.id === "R2").evidence[0];
  ok(runGate(["accept-risk", "--task-dir", fx.taskDir, "--target-type", "requirement", "--target-id", "R2",
    "--confirmation", "user-explicit", "--summary", "用户接受开启路径验证延后", "--gap-id", gap.gapId,
    "--credential", fx.creds.user], fx.home), "用户裁决接受 R2 缺口");
  const waived = evaluate(fx);
  assert.equal(waived.state, "accepted_with_risk", "缺口经用户裁决后进入 accepted_with_risk");
  const result = JSON.parse(parseStdout(runCore(["obligations", "--task-dir", fx.taskDir], fx.home)));
  const r2 = result.obligations.find((item) => item.id === "assert-A2-command");
  assert.equal(r2.state, "explicitly-waived", "豁免义务 state=explicitly-waived（源头是签名 RiskAccepted 事件）");
  assert.deepEqual(r2.evidenceRefs, [gap.gapId], "豁免绑定裁决指向的缺口 id");
  assert.equal(result.openRequired.length, 0, "豁免后无 open 必需义务");
});
