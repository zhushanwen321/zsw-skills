// host-environment-v6.test.mjs — 宿主类断言的环境要求与证据环境检查回归
// （设计《V5 交付完整性与语义可信性改造》机制二 §6.1/§6.2 gate 侧）
//
// 覆盖：
//   1. 断言 requiredEnvironment 字段校验：kind 限 official-runner|real-host（fake-host
//      不得作为要求）、capability 可选、未知键拒绝——additive 可选字段缺省不限制
//   2. 证据环境元数据满足要求：verified 保持，任务可 accepted
//   3. 证据无环境元数据（markdown artifact）→ verified 降级 partial（真实环境不可用时
//      只能 unknown/partial，不能 verified），environmentGap 披露原因与恢复方向
//   4. 模拟环境（fake-host）不能独立证明宿主类断言：official-runner 与 real-host 要求
//      均拒绝 fake-host 证据
//   5. 分层证据规则：real-host 证据满足 official-runner 要求（真实环境是官方运行器的超集）
//   6. 环境词表落策略包 evidence-kinds.json（environmentKinds），随快照受冻结保护
//
// 运行：node --test scripts/tests/host-environment-v6.test.mjs

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
const EVIDENCE_KINDS = JSON.parse(readFileSync(join(V6, "policies", "evidence-kinds.json"), "utf8"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function makeFixture(t, { taskId = "host-env" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-env-v6-"));
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
  writeFileSync(intentPath, "斜杠命令按真实宿主规则分发到用户可见输出\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

function evidenceFile(fx, name, content) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, content);
  return `evidence/${name}`;
}

function environmentDocument({ kind, name = "pi-coding-agent", version = "1.0.0", source = "official release archive", sourceHash = sha256("official"), driver = "bin/pi" }) {
  return {
    summary: "宿主集成证据",
    environment: { kind, name, version, source, sourceHash, driver },
  };
}

/** 推进到「已批准 + 方案确认 + 实现 + 探索」，断言 A1 带调用方给定的 requiredEnvironment
 *（null = 不带该字段）。实现提交与探索绑定当前 revision（gate 前置）。 */
function driveToCandidate(t, { required } = {}) {
  const fx = makeFixture(t);
  const revisionA = runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim();
  const assertion = {
    id: "A1", statement: "斜杠命令按真实宿主规则分发", qualifiers: ["真实宿主"], given: "已注册", when: "调用", then: "分发", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
  };
  if (required !== null) assertion.requiredEnvironment = required;
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: basename(fx.taskDir),
    projectRoot: realpathSync(fx.projectDir),
    objective: "命令在真实宿主上正确分发",
    requirements: [
      {
        id: "R1", kind: "invariant", statement: "命令分发遵循宿主真实解析规则", required: true, riskAcceptable: false,
        evidenceKinds: ["command", "inspection"],
        assertions: [assertion],
      },
    ],
    adversarialForms: [
      { id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "带空格调用", timing: "命令期", expected: "按真实解析规则分发", testAssetRefs: ["test-A1"], rationale: "宿主解析差异" },
    ],
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["smoke"],
  }, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "命令分发", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home), "验收包应合法");
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  evidenceFile(fx, "acceptance-review-v1.md", "# 审查\n");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const solution = evidenceFile(fx, "solution.md", "# 方案\n");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, solution), "utf8")) }])}\n`);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "impl I1"], { cwd: fx.projectDir });
  const revisionB = runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim();
  ok(runGate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", evidenceFile(fx, "explore.md", "# 探索\n"), "--revision", revisionB,
    "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", evidenceFile(fx, "impl-I1.md", "# 实现\n"), "--merge-receipt", JSON.stringify({ fromRevision: revisionA, toRevision: revisionB, patchSha256: sha256("patch") }),
    "--revision", revisionB, "--credential", fx.creds.builder], fx.home));
  return { fx, revisionB };
}

/** 逐 kind 登记证据（artifact 由调用方给定文本），随后 full 保证，返回 evaluate 的 verdict。 */
function driveEvidenceAndAssurance(fx, revisionB, { commandArtifact, inspectionArtifact }) {
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const explorationId = events.find((entry) => entry.type === "ExplorationCompleted").eventId;
  const evidenceIds = [];
  for (const [kind, artifact] of [["command", commandArtifact], ["inspection", inspectionArtifact]]) {
    const append = runGate(["record-evidence", "--task-dir", fx.taskDir,
      "--requirement-id", "R1", "--kind", kind, "--result", "verified", "--summary", `取证 ${kind}`,
      "--artifact", artifact, "--revision", revisionB,
      "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
      "--credential", fx.creds.assurance], fx.home);
    ok(append, `证据 ${kind} 登记`);
    evidenceIds.push(JSON.parse(parseStdout(append)).eventId);
  }
  ok(runGate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify(evidenceIds),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--clean-build", JSON.stringify({ buildId: "b1", artifactSha256: sha256("clean") }),
    "--artifact", evidenceFile(fx, "assurance-full.md", "# 保证\n"), "--revision", revisionB,
    "--credential", fx.creds.assurance], fx.home), "full 保证登记");
}

function evaluate(fx) {
  const result = runGate(["evaluate", "--task-dir", fx.taskDir], fx.home);
  ok(result, "evaluate 应成功");
  return JSON.parse(parseStdout(result));
}

// ── 1. 断言字段校验 ──

test("requiredEnvironment 校验：kind 限 official-runner|real-host，fake-host 不得作为要求，未知键拒绝", (t) => {
  const fx = makeFixture(t);
  const base = (requiredEnvironment) => ({
    schemaVersion: 2, acceptanceVersion: 1, taskId: basename(fx.taskDir), projectRoot: realpathSync(fx.projectDir),
    objective: "宿主契约", nonGoals: [], riskLevel: "high", exploratoryReview: "required", reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "宿主契约", required: true, riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{ id: "A1", statement: "分发", qualifiers: ["q"], given: "g", when: "w", then: "t", adversarialFormRefs: ["AF1"], testAssetRefs: ["t"], requiredEnvironment }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "q", entryPoint: "auto", initialState: "s", operation: "o", timing: "t", expected: "e", testAssetRefs: ["t"], rationale: "r" }],
  });
  const tryValidate = (acceptance) => {
    writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
    writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
      schemaVersion: 1, acceptanceVersion: 1,
      items: [{ id: "I1", title: "命令分发", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
    }, null, 2)}\n`);
    return runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home);
  };
  const legal = tryValidate(base({ kind: "real-host", capability: "slash-command-dispatch" }));
  ok(legal, "合法 requiredEnvironment 应通过");
  const fakeAsRequirement = tryValidate(base({ kind: "fake-host" }));
  assert.notEqual(fakeAsRequirement.status, 0, "fake-host 不得作为断言要求（模拟环境不是要求档位）");
  assert.match(fakeAsRequirement.stderr, /official-runner.*real-host/);
  const unknownKey = tryValidate(base({ kind: "real-host", extra: 1 }));
  assert.notEqual(unknownKey.status, 0, "requiredEnvironment 未知键应被拒");
  assert.match(unknownKey.stderr, /含未知字段 extra/);
  const emptyCapability = tryValidate(base({ kind: "real-host", capability: " " }));
  assert.notEqual(emptyCapability.status, 0, "空 capability 应被拒");
  // 缺省不限制（additive 可选）
  const withoutField = tryValidate(base(undefined));
  ok(withoutField, "不带 requiredEnvironment 的断言照常通过（缺省不限制）");
});

// ── 2. 环境满足 → verified 保持 ──

test("证据环境元数据满足要求：verified 保持，任务可 accepted；real-host 证据满足 official-runner 要求", (t) => {
  // official-runner 要求 + real-host 证据（真实环境是官方运行器的超集，§6.2 分层规则）
  const { fx, revisionB } = driveToCandidate(t, { required: { kind: "official-runner", capability: "slash-command-dispatch" } });
  driveEvidenceAndAssurance(fx, revisionB, {
    commandArtifact: evidenceFile(fx, "ev-command.json", `${JSON.stringify(environmentDocument({ kind: "real-host", source: "host binary" }), null, 2)}\n`),
    inspectionArtifact: evidenceFile(fx, "ev-inspection.json", `${JSON.stringify(environmentDocument({ kind: "official-runner" }), null, 2)}\n`),
  });
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "环境元数据满足要求时 verified 不降级");
  const entry = verdict.requirements.find((r) => r.id === "R1").assertions[0].evidence[0];
  assert.equal(entry.result, "verified");
  assert.equal(entry.environmentGap, undefined, "满足要求时不产生环境缺口");
});

// ── 3. 无环境元数据 → verified 降级 partial ──

test("证据无环境元数据（markdown artifact）：verified 降级 partial，environmentGap 披露，不得 accepted", (t) => {
  const { fx, revisionB } = driveToCandidate(t, { required: { kind: "real-host" } });
  driveEvidenceAndAssurance(fx, revisionB, {
    commandArtifact: evidenceFile(fx, "ev-command.md", "# 纯文字证据（无环境元数据）\n"),
    inspectionArtifact: evidenceFile(fx, "ev-inspection.md", "# 同样无元数据\n"),
  });
  const verdict = evaluate(fx);
  assert.notEqual(verdict.state, "accepted", "宿主类断言缺真实环境证据不得 accepted");
  const assertion = verdict.requirements.find((r) => r.id === "R1").assertions[0];
  for (const entry of assertion.evidence) {
    assert.equal(entry.result, "partial", "verified 因环境不满足降级 partial");
    assert.match(entry.environmentGap.reason, /环境元数据|模拟环境/);
    assert.ok(entry.gapId, "降级后产生缺口 id（走既有证据缺口通道）");
  }
  assert.ok(verdict.missing.evidence.some((gap) => gap.requirementId === "R1"), "缺口进 missing.evidence（补真机证据或用户裁决）");
});

// ── 4. 模拟环境不能独立证明宿主类断言 ──

test("fake-host 证据不能独立证明宿主类断言：official-runner 与 real-host 要求均降级", (t) => {
  for (const requiredKind of ["official-runner", "real-host"]) {
    const { fx, revisionB } = driveToCandidate(t, { required: { kind: requiredKind } });
    driveEvidenceAndAssurance(fx, revisionB, {
      commandArtifact: evidenceFile(fx, "ev-command.json", `${JSON.stringify(environmentDocument({ kind: "fake-host", name: "fake-pi", source: "test harness" }), null, 2)}\n`),
      inspectionArtifact: evidenceFile(fx, "ev-inspection.json", `${JSON.stringify(environmentDocument({ kind: "fake-host", name: "fake-pi", source: "test harness" }), null, 2)}\n`),
    });
    const verdict = evaluate(fx);
    assert.notEqual(verdict.state, "accepted", `${requiredKind} 要求下 fake-host 证据不得放行 accepted`);
    const entry = verdict.requirements.find((r) => r.id === "R1").assertions[0].evidence[0];
    assert.equal(entry.result, "partial", `${requiredKind} 要求下 fake-host 证据降级`);
    assert.match(entry.environmentGap.reason, /不能独立证明宿主类断言|不满足断言要求/);
  }
});

// ── 5. 词表与快照保护 ──

test("环境词表落策略包 evidence-kinds.json（environmentKinds 三档，随快照冻结）", () => {
  assert.deepEqual(EVIDENCE_KINDS.environmentKinds, ["fake-host", "official-runner", "real-host"]);
  // 词表经 snapshot-policy 进入任务快照——改词表 = 策略升级通道（既有机制），测试只锚定包内词表存在
});
