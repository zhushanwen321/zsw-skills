// delivery-gate-v6.test.mjs — delivery-v6 裁决器（16 事件 / 凭据文件 / 验收包哈希 / 失效表 / 任务替换 / 租约 /
// verdict-rules 开关 / finding-categories 阻塞语义 / content-manifest 指纹与干净构建豁免）测试
// 运行：node --test scripts/tests/delivery-gate-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "delivery-gate.mjs");
const POLICY_DIR = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "policies");

// 进程内调用 gate（模块只加载一次，逐用例毫秒级）：垫片与 CLI 走同一 main 分发，
// 返回 { status, stdout, stderr } 与 spawnSync 同口径；HOME 隔离由垫片按调用切换。
// CLI 进程级语义（--help 文本等）由文末对拍用例经 spawn 钉住
const gateModule = await import(pathToFileURL(GATE).href);
function runGate(args, home) {
  return gateModule.runGateCommand(args, home);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath, "utf8"));
}

/** spawn 直跑 CLI：仅供防漂移对拍（进程内结果 vs CLI 结果一致性），常规用例走 runGate */
function runGateSpawn(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
    timeout: 60_000,
  });
}

function assertOk(result, message = "命令应成功") {
  assert.equal(result.status, 0, `${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertFailure(result, expectedStatus = 1) {
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /恢复动作：/, "每个错误都必须给出恢复动作");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function evidenceFile(taskDir, name, content) {
  const filePath = join(taskDir, "evidence", name);
  writeFileSync(filePath, content ?? `# ${name}\n原始证据。\n`);
  return { artifact: `evidence/${name}`, artifactSha256: sha256File(filePath) };
}

// 模板仓：每测试进程只构建一次「初始提交仓」，fixture 经 cpSync 复制实例化——git 对象是
// 内容寻址的只读数据，复制保真（实测复制仓 commit/rev-parse 与全新 init 仓行为一致），
// 省掉每 fixture 的 init/add/commit 三连 spawn
let repoTemplateDir = null;
function materializeRepoTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-gate-v6-tpl-"));
  mkdirSync(dir, { recursive: true });
  // git 身份经 commit 的 -c 内联（省两次 spawn：模板是全部用例的公共前缀成本）
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** v2 fixture：真实 git 项目 + 隔离 HOME + 已 init 的任务目录与三把凭据 id（intent 传 null 则不带意图） */
function makeV2Fixture(t, { taskId = "task-a", intent = "原始需求：开关关闭后零写入\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-gate-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
  cpSync(repoTemplateDir, projectDir, { recursive: true });
  mkdirSync(home);
  const intentPath = join(root, "intent.md");
  if (intent !== null) writeFileSync(intentPath, intent);

  const initArgs = ["init", "--project-root", projectDir, "--task-id", taskId];
  if (intent !== null) initArgs.push("--intent-file", intentPath);
  const initResult = runGate(initArgs, home);
  assertOk(initResult, "init 应成功");
  const initOutput = JSON.parse(parseStdout(initResult));
  const gate = (...args) => runGate(args, home);
  return {
    root,
    projectDir,
    home,
    intentPath,
    taskDir: initOutput.taskDir,
    creds: initOutput.credentials,
    slug: basename(dirname(initOutput.taskDir)),
    initOutput,
    gate,
  };
}

function parseStdout(result) {
  const text = result.stdout.trim();
  const firstBrace = text.indexOf("{");
  return text.slice(firstBrace >= 0 ? firstBrace : 0);
}

/** 空候选快照（设计 §4.5：无外部候选的新任务也生成，使 externalContractReview.detectionSha256
 * 有可绑定对象）。返回文件内容 sha256。 */
function writeEmptyCandidateSnapshot(fx, acceptanceVersion) {
  const dir = join(fx.taskDir, "evidence", `acceptance-v${acceptanceVersion}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }, null, 2)}\n`);
  return sha256(readFileSync(path, "utf8"));
}

/** 标准备收包：R1（两证据类型、不可风险接受）+ R2（可风险接受）+ 增量 I1。
 * 带 externalContractReview 空处置表（V6 世代新任务键必填，§5.1 检查 2）。 */
function writeAcceptancePackage(fx, { acceptanceVersion = 1, r1RiskAcceptable = false } = {}) {
  writeJson(join(fx.taskDir, "acceptance.json"), {
    schemaVersion: 1,
    acceptanceVersion,
    taskId: basename(fx.taskDir),
    projectRoot: realpathSync(fx.projectDir),
    objective: "开关关闭后系统零写入",
    requirements: [
      { id: "R1", kind: "goal", statement: "开关关闭后任何路径不产生新写入", required: true, riskAcceptable: r1RiskAcceptable, evidenceKinds: ["command", "inspection"] },
      { id: "R2", kind: "goal", statement: "开关开启时读写路径正常", required: true, riskAcceptable: true, evidenceKinds: ["command"] },
    ],
    nonGoals: ["云端同步"],
    riskLevel: "low",
    exploratoryReview: "not-required",
    reviewDimensions: [],
    externalContractReview: { detectionSha256: writeEmptyCandidateSnapshot(fx, acceptanceVersion), dispositions: [] },
  });
  writeJson(join(fx.taskDir, "increments.json"), {
    schemaVersion: 1,
    acceptanceVersion,
    items: [
      { id: "I1", title: "开关与写入路径", requirementIds: ["R1", "R2"], testCommand: { program: "true", args: [] } },
    ],
  });
}

function currentRevision(fx) {
  const result = fx.gate("revision", "--project-root", fx.projectDir);
  assertOk(result);
  return result.stdout.trim();
}

// 事件追加走意图命令组（信封由 gate 构造；本辅助把既有事件对象形态翻译为意图参数）
const INTENT_OPTION_KEYS = new Map([
  ["reopenOf", "--reopen-of"], ["origin", "--origin"],
  ["consequenceRefutation", "--consequence-refutation"], ["consequenceRefutationType", "--consequence-refutation-type"],
  ["firstDetectedStage", "--first-detected-stage"], ["expectedStage", "--expected-stage"],
  ["regressionTestRef", "--regression-test-ref"], ["mode", "--mode"],
  ["fromRevision", "--from-revision"], ["toRevision", "--to-revision"], ["nature", "--nature"],
]);

function appendEvent(fx, event, role) {
  const base = ["--task-dir", fx.taskDir, "--credential", fx.creds[role]];
  const rev = event.revision !== undefined ? ["--revision", event.revision] : [];
  const opts = [];
  for (const [field, flag] of INTENT_OPTION_KEYS) {
    if (event[field] !== undefined) opts.push(flag, String(event[field]));
  }
  switch (event.type) {
    case "EvidenceRecorded":
      return fx.gate("record-evidence", ...base,
        "--requirement-id", event.requirementId, "--kind", event.kind, "--result", event.result,
        "--summary", event.summary, "--artifact", event.artifact,
        ...(event.artifactSha256 !== undefined ? ["--artifact-sha256", event.artifactSha256] : []),
        ...(event.assertionIds !== undefined ? ["--assertion-ids", JSON.stringify(event.assertionIds)] : []),
        ...(event.adversarialFormIds !== undefined ? ["--adversarial-form-ids", JSON.stringify(event.adversarialFormIds)] : []),
        ...rev);
    case "FindingRaised":
      return fx.gate("record-finding", ...base,
        "--summary", event.summary, "--category", event.category, "--severity", event.severity,
        "--requirement-ids", JSON.stringify(event.requirementIds), "--artifact", event.artifact,
        ...(event.findingId !== undefined ? ["--finding-id", event.findingId] : []),
        ...opts, ...rev);
    case "FindingResolved":
      return fx.gate("resolve-finding", ...base,
        "--finding-id", event.findingId, "--summary", event.summary, "--artifact", event.artifact, ...rev);
    case "ResolutionReaffirmed":
      return fx.gate("reaffirm-resolution", ...base,
        "--finding-id", event.findingId, "--original-resolution-event-id", event.originalResolutionEventId,
        "--basis", event.basis, "--summary", event.summary, "--artifact", event.artifact, ...rev);
    case "ImplementationRecorded":
      return fx.gate("record-implementation", ...base,
        "--increment-id", event.incrementId, "--summary", event.summary, "--artifact", event.artifact,
        "--merge-receipt", JSON.stringify(event.mergeReceipt),
        ...(event.artifactSha256 !== undefined ? ["--artifact-sha256", event.artifactSha256] : []),
        ...rev);
    case "ExplorationCompleted":
      return fx.gate("record-exploration", ...base,
        "--summary", event.summary, "--dimensions", JSON.stringify(event.dimensions),
        "--coverage-manifest-sha256", event.coverageManifestSha256, "--artifact", event.artifact,
        ...(event.artifactSha256 !== undefined ? ["--artifact-sha256", event.artifactSha256] : []),
        ...rev);
    case "AssuranceCompleted":
      return fx.gate("complete-assurance", ...base,
        "--summary", event.summary, "--coverage-manifest-sha256", event.coverageManifestSha256,
        "--exploration-event-id", event.explorationEventId,
        "--increment-receipts", JSON.stringify(event.incrementReceipts), "--artifact", event.artifact,
        ...(event.evidenceEventIds !== undefined ? ["--evidence-event-ids", JSON.stringify(event.evidenceEventIds)] : []),
        ...(event.cleanBuild !== undefined ? ["--clean-build", JSON.stringify(event.cleanBuild)] : []),
        ...(event.artifactSha256 !== undefined ? ["--artifact-sha256", event.artifactSha256] : []),
        ...opts, ...rev);
    case "RepairRoundRecorded":
      return fx.gate("record-repair-round", ...base,
        "--round", String(event.round), "--summary", event.summary,
        "--trigger-finding-ids", JSON.stringify(event.triggerFindingIds),
        "--affected-assertion-ids", JSON.stringify(event.affectedAssertionIds), "--artifact", event.artifact,
        ...(event.incrementReceipts !== undefined ? ["--increment-receipts", JSON.stringify(event.incrementReceipts)] : []),
        ...(event.artifactSha256 !== undefined ? ["--artifact-sha256", event.artifactSha256] : []),
        ...opts, ...rev);
    case "AssuranceRevisionDrift":
      return fx.gate("record-assurance-drift", ...base,
        "--summary", event.summary, "--setup-revision", event.setupRevision,
        "--finalize-revision", event.finalizeRevision, "--drift-seq", String(event.driftSeq), ...rev);
    default:
      throw new Error(`测试辅助未路由事件类型 ${event.type}——补 appendEvent 路由分支`);
  }
}

function appendEvidence(fx, { requirementId, kind, result = "verified", revision, name }) {
  const { artifact, artifactSha256 } = evidenceFile(fx.taskDir, name ?? `${requirementId}-${kind}.md`);
  return appendEvent(fx, {
    type: "EvidenceRecorded",
    actor: "assurance",
    acceptanceVersion: readJson(join(fx.taskDir, "acceptance.json")).acceptanceVersion,
    revision,
    summary: `${requirementId} ${kind} ${result}`,
    requirementId,
    kind,
    result,
    artifact,
    artifactSha256,
  }, "assurance");
}

/** record-review 的默认审查 artifact（versioned 文件名） */
function writeReviewArtifact(fx) {
  const version = readJson(join(fx.taskDir, "acceptance.json")).acceptanceVersion;
  evidenceFile(fx.taskDir, `acceptance-review-v${version}.md`, `# 审查报告 v${version}\n判据可证伪。\n`);
}

/** 在隔离 HOME 写用户级策略覆盖（loadPolicySources 同名文件整体替换；须在 snapshot-policy 之前写入才会进快照） */
function overrideUserPolicy(fx, name, value) {
  const dir = join(fx.home, ".agents", "skill-data", "delivery-policies");
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, name), value);
}

/** 追加一条 FindingRaised（actor=assurance），artifact 自动落 evidence 目录 */
function raiseFinding(fx, revision, findingId, category, severity, requirementIds) {
  const artifact = evidenceFile(fx.taskDir, `finding-${findingId}.md`, `# ${findingId}\n${category} 发现。\n`);
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: `发现 ${findingId}`, findingId, category, severity, requirementIds,
    artifact: artifact.artifact,
  }, "assurance"));
}

/** 快照 + 审查通过 + 批准 + 方案批准 + 实现 —— 完整链路到「待取证」状态 */
function driveToAssuranceStage(fx) {
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  writeReviewArtifact(fx);
  assertOk(fx.gate(
    "record-review", "--task-dir", fx.taskDir, "--conclusion", "pass",
    "--summary", "审查通过", "--credential", fx.creds.assurance,
  ));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "批准 v1", "--credential", fx.creds.user,
  ));
  const manifest = evidenceFile(fx.taskDir, "solution.md", "# 方案\n");
  writeJson(join(fx.taskDir, "evidence", "package-manifest.json"), [{ name: "solution.md", sha256: manifest.artifactSha256 }]);
  assertOk(fx.gate(
    "record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案确认",
    "--package-file", join(fx.taskDir, "evidence", "package-manifest.json"),
    "--credential", fx.creds.user,
  ));
  const revision = currentRevision(fx);
  const implArtifact = evidenceFile(fx.taskDir, "impl-I1.md", "# 实现报告\n");
  assertOk(appendEvent(fx, {
    type: "ImplementationRecorded",
    actor: "builder",
    acceptanceVersion: 1,
    revision,
    summary: "I1 实现",
    incrementId: "I1",
    artifact: implArtifact.artifact,
    mergeReceipt: { fromRevision: revision, toRevision: revision, patchSha256: sha256("patch") },
  }, "builder"));
  return revision;
}

/** 探索 + 全量证据 + 保证完成（含逐增量回执与绑定）——到 accepted 所需的保证事件 */
function driveAssuranceComplete(fx, revision, { r1Inspection = "verified", r2 = "verified", skipR1Evidence = false } = {}) {
  if (!skipR1Evidence) {
    for (const [requirementId, kind, result] of [
      ["R1", "command", "verified"],
      ["R1", "inspection", r1Inspection],
      ["R2", "command", r2],
    ]) {
      assertOk(appendEvidence(fx, { requirementId, kind, result, revision }), `证据 ${requirementId}/${kind} 应登记成功`);
    }
  }
  const explore = evidenceFile(fx.taskDir, "explore.md", "# 探索\n");
  const exploreResult = appendEvent(fx, {
    type: "ExplorationCompleted",
    actor: "assurance",
    acceptanceVersion: 1,
    revision,
    summary: "探索完成",
    dimensions: ["smoke"],
    coverageManifestSha256: explore.artifactSha256,
    artifact: explore.artifact,
  }, "assurance");
  assertOk(exploreResult);
  const explorationEventId = JSON.parse(parseStdout(exploreResult)).eventId;

  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const evidenceIds = events.filter((e) => e.type === "EvidenceRecorded").map((e) => e.eventId);
  const coverageSha = explore.artifactSha256;
  const receiptArtifact = evidenceFile(fx.taskDir, "i1-receipt.md", "# 回执\n");
  const final = evidenceFile(fx.taskDir, "assurance-final.md", "# 保证完成\n");
  assertOk(appendEvent(fx, {
    type: "AssuranceCompleted",
    actor: "assurance",
    acceptanceVersion: 1,
    revision,
    summary: "独立保证完成",
    evidenceEventIds: evidenceIds,
    coverageManifestSha256: coverageSha,
    explorationEventId,
    incrementReceipts: [{
      incrementId: "I1",
      program: "true",
      args: [],
      exitCode: 0,
      logSha256: sha256("test ok"),
      cwd: fx.projectDir,
      artifactSha256: receiptArtifact.artifactSha256,
    }],
    cleanBuild: null,
    artifact: final.artifact,
  }, "assurance"));
}

function evaluate(fx) {
  const result = fx.gate("evaluate", "--task-dir", fx.taskDir);
  assertOk(result);
  return JSON.parse(parseStdout(result));
}

// ── 1. init 与凭据文件 ──

test("init 凭据文件化：stdout 无私钥、凭据目录 0600、幂等复用不重发", (t) => {
  const fx = makeV2Fixture(t);
  assert.ok(!Object.hasOwn(fx.initOutput, "builderKey"), "stdout 不得输出私钥");
  assert.ok(!Object.hasOwn(fx.initOutput, "userKey"), "stdout 不得输出私钥");
  assert.equal(fx.initOutput.intentSha256, sha256(readFileSync(fx.intentPath, "utf8")));
  const credDir = join(fx.home, ".agents", "skill-data", "delivery-keys", fx.slug, "task-a");
  for (const role of ["builder", "assurance", "user"]) {
    const keyPath = join(credDir, `${role}.key`);
    assert.ok(existsSync(keyPath), `凭据文件应存在：${role}`);
    const mode = statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600, `凭据文件权限应为 0600：${role}`);
  }
  // 任务目录与证据目录内不得出现私钥
  const stack = [fx.taskDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else {
        assert.ok(!readFileSync(entryPath, "utf8").includes("PRIVATE KEY"), `私钥不得写入任务目录：${entryPath}`);
      }
    }
  }
  // 幂等复用
  const reused = fx.gate("init", "--project-root", fx.projectDir, "--task-id", "task-a", "--resume-existing");
  assertOk(reused);
  const reusedOutput = JSON.parse(parseStdout(reused));
  assert.equal(reusedOutput.reused, true);
  assert.ok(!Object.hasOwn(reusedOutput, "builderKey"), "幂等 init 不得输出私钥");
  assert.equal(reusedOutput.credentials.user, fx.creds.user);
});

test("血统拦截：同仓库同 intent 二次 init 拒绝；declare-independent 后放行", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const blocked = fx.gate("init", "--project-root", fx.projectDir, "--task-id", "task-b", "--intent-file", fx.intentPath);
  assertFailure(blocked);
  assert.match(blocked.stderr, /血统检查未通过/);
  // 在既有任务上签署独立声明（绑定新任务 intent 与未替换清单）后放行
  const declared = fx.gate("declare-independent", "--task-dir", fx.taskDir, "--credential", fx.creds.user);
  assertOk(declared);
  const after = fx.gate("init", "--project-root", fx.projectDir, "--task-id", "task-b", "--intent-file", fx.intentPath);
  assertOk(after, "declare-independent 声明过同 intent 后，新 init 应放行");
});

test("set-intent 一次写入；不同内容修改被拒绝", (t) => {
  const fx = makeV2Fixture(t, { taskId: "no-intent", intent: null });
  const newIntent = join(fx.root, "intent2.md");
  writeFileSync(newIntent, "另一个不同的需求\n");
  const first = fx.gate("set-intent", "--task-dir", fx.taskDir, "--file", newIntent);
  assertOk(first);
  writeFileSync(fx.intentPath, "原始需求：开关关闭后零写入\n");
  const second = fx.gate("set-intent", "--task-dir", fx.taskDir, "--file", fx.intentPath);
  assertFailure(second);
  assert.match(second.stderr, /不可修改/);
});

// ── 2. 审查链与绑定 ──

test("未审查不得批准；后发 reject 审查击穿既有批准", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  writeReviewArtifact(fx);
  const noReview = fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "未审查批准", "--credential", fx.creds.user,
  );
  assertFailure(noReview);
  assert.match(noReview.stderr, /批准前置不满足/);
  assertOk(fx.gate("record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "批准", "--credential", fx.creds.user,
  ));
  let verdict = evaluate(fx);
  assert.notEqual(verdict.state, "draft");
  // 同组合后发打回审查 → 旧通过失效 → 批准失效
  assertOk(fx.gate("record-review", "--task-dir", fx.taskDir, "--conclusion", "reject", "--summary", "复审打回", "--credential", fx.creds.assurance));
  verdict = evaluate(fx);
  assert.equal(verdict.state, "draft", "后发 reject 应击穿批准");
});

test("V6 写入防护：冻结后直写被 chmod 拒；绕过 chmod 的改动被篡改检测拦；intent 篡改仍使批准失效", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision);
  assert.equal(evaluate(fx).state, "accepted");
  // ① 批准即冻结：验收包两文件 0444 + frozen/v1 快照在盘
  for (const fileName of ["acceptance.json", "increments.json"]) {
    const mode = statSync(join(fx.taskDir, fileName)).mode & 0o777;
    assert.equal(mode, 0o444, `${fileName} 批准后应 0444（写入当时防护）`);
    assert.ok(existsSync(join(fx.taskDir, "frozen", "v1", fileName)), `frozen/v1/${fileName} 快照应存在`);
  }
  // ② 冻结后直写（普通写权限）被拒——AG-2 类「修复组直改已冻结 increments.json」写入当秒失败
  const increments = readJson(join(fx.taskDir, "increments.json"));
  increments.items[0].testCommand.program = "false";
  assert.throws(() => writeJson(join(fx.taskDir, "increments.json"), increments), undefined, "0444 文件直写应 EACCES");
  assert.equal(evaluate(fx).state, "accepted", "写入被拒，包未变，accepted 保持");
  // ③ 绕过 chmod 的改动（模拟持 root/所有者强改）：加载时篡改检测拦下并给出恢复动作
  chmodSync(join(fx.taskDir, "increments.json"), 0o644);
  writeJson(join(fx.taskDir, "increments.json"), increments);
  const tampered = fx.gate("evaluate", "--task-dir", fx.taskDir);
  assertFailure(tampered);
  assert.match(tampered.stderr, /冻结的验收包被改动/, "篡改检测应拦截并指向恢复动作");
  assert.match(tampered.stderr, /open-revision/, "恢复动作应指向合法解冻通道");
  // ④ 合法解冻通道：open-revision 登记 RevisionOpened 后恢复可编辑，再改回并重批
  assertOk(fx.gate("open-revision", "--task-dir", fx.taskDir, "--reason", "测试：修正测试命令", "--credential", fx.creds.user));
  increments.items[0].testCommand.program = "true";
  writeJson(join(fx.taskDir, "increments.json"), increments);
  // ⑤ 篡改 intent → 批准失效（intent.md 不冻结，哈希绑定照常生效）
  writeFileSync(join(fx.taskDir, "intent.md"), "原始需求：开关关闭后零写入（被改）\n");
  assert.equal(evaluate(fx).state, "draft", "改 intent 应使批准失效");
});

test("策略快照固定：任务内 evaluate 按快照执行，快照文件漂移使批准失效", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision);
  assert.equal(evaluate(fx).state, "accepted");
  const snapshotPath = join(fx.taskDir, "policy-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot["verdict-rules.json"].maxDriftChain = 99;
  writeJson(snapshotPath, snapshot);
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "draft", "快照文件被篡改后批准应失效（快照哈希不匹配）");
  // 已有快照且内容不同时拒绝重新生成
  const regen = fx.gate("snapshot-policy", "--task-dir", fx.taskDir);
  assertFailure(regen);
});

// ── 3. 状态机与判定式 ──

test("完整链路 draft → design → … → accepted；无 DesignApproved 时停在 design", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  writeReviewArtifact(fx);
  assertOk(fx.gate("record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "批准", "--credential", fx.creds.user,
  ));
  assert.equal(evaluate(fx).state, "design", "批准后未确认方案应停在设计阶段");
  const manifest = evidenceFile(fx.taskDir, "solution.md", "# 方案\n");
  writeJson(join(fx.taskDir, "evidence", "package-manifest.json"), [{ name: "solution.md", sha256: manifest.artifactSha256 }]);
  assertOk(fx.gate(
    "record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案确认",
    "--package-file", join(fx.taskDir, "evidence", "package-manifest.json"),
    "--credential", fx.creds.user,
  ));
  assert.equal(evaluate(fx).state, "acceptance-approved", "方案确认且零实现应为 acceptance-approved");
  const revision = currentRevision(fx);
  const implArtifact = evidenceFile(fx.taskDir, "impl-I1.md", "# 实现报告\n");
  assertOk(appendEvent(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision,
    summary: "I1", incrementId: "I1", artifact: implArtifact.artifact,
    mergeReceipt: { fromRevision: revision, toRevision: revision, patchSha256: sha256("p") },
  }, "builder"));
  assert.equal(evaluate(fx).state, "candidate", "实现齐但缺保证应为 candidate");
  driveAssuranceComplete(fx, revision);
  assert.equal(evaluate(fx).state, "accepted");
});

test("accepted_with_risk 逐缺口判定：多缺口须 --gap-id 指定，各接受后放行", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx, { r1RiskAcceptable: true });
  const revision = driveToAssuranceStage(fx);
  // R1：command=partial（缺口绑事件 id）、inspection 完全缺失（派生缺口）；R2 verified
  assertOk(appendEvidence(fx, { requirementId: "R1", kind: "command", result: "partial", revision }));
  assertOk(appendEvidence(fx, { requirementId: "R2", kind: "command", revision }));
  driveAssuranceComplete(fx, revision, { skipR1Evidence: true });
  assert.equal(evaluate(fx).state, "candidate", "存在未接受缺口应为 candidate");
  const r1Gaps = evaluate(fx).requirements.find((r) => r.id === "R1").evidence
    .filter((e) => e.result !== "verified");
  assert.equal(r1Gaps.length, 2, "R1 应有两个缺口（command=partial + inspection=missing）");
  // 多缺口不给 --gap-id 应拒绝（防登记项与用户批准项错位）
  const noGapId = fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "requirement", "--target-id", "R1",
    "--confirmation", "user-explicit", "--summary", "未指定缺口",
    "--credential", fx.creds.user,
  );
  assertFailure(noGapId);
  assert.match(noGapId.stderr, /--gap-id/);
  // 指定不属于该需求的 gapId 应拒绝
  const wrongGapId = fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "requirement", "--target-id", "R1",
    "--gap-id", sha256("not-a-gap"), "--confirmation", "user-explicit", "--summary", "错误缺口",
    "--credential", fx.creds.user,
  );
  assertFailure(wrongGapId);
  assert.match(wrongGapId.stderr, /不是需求 R1 的未接受缺口/);
  // 只接受 command 缺口：另一类缺口未接受仍卡
  assertOk(fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "requirement", "--target-id", "R1",
    "--gap-id", r1Gaps.find((e) => e.kind === "command").gapId,
    "--confirmation", "user-explicit", "--summary", "接受缺口其一",
    "--credential", fx.creds.user,
  ));
  assert.equal(evaluate(fx).state, "candidate", "另一类证据缺口未接受仍卡");
  assertOk(fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "requirement", "--target-id", "R1",
    "--gap-id", r1Gaps.find((e) => e.kind === "inspection").gapId,
    "--confirmation", "user-explicit", "--summary", "接受缺口其二",
    "--credential", fx.creds.user,
  ));
  assert.equal(evaluate(fx).state, "accepted_with_risk", "两类缺口各自接受后应 accepted_with_risk");
});

// ── 4. 凭据边界 ──

test("跨角色凭据与跨任务凭据一律拒绝", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  // 意图命令组通道走同一断言：record-evidence 固定 assurance 角色，builder 凭据出示被拒
  const cross = fx.gate(
    "record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified",
    "--summary", "x", "--artifact", "evidence/x.md", "--artifact-sha256", sha256("x"),
    "--credential", fx.creds.builder,
  );
  assertFailure(cross);
  assert.match(cross.stderr, /必须出示 assurance 凭据|不可写 evidence 域/);
  const unknown = fx.gate(
    "record-finding", "--task-dir", fx.taskDir,
    "--summary", "x", "--category", "defect", "--severity", "non-blocker",
    "--requirement-ids", "[]", "--artifact", "evidence/x.md",
    "--credential", `${fx.slug}/other-task/builder`,
  );
  assertFailure(unknown);
  assert.match(unknown.stderr, /与任务登记不符/);
});

// ── 5. 保证完成绑定（防跨 run 拼接）──

test("AssuranceCompleted 绑定校验：假 evidenceEventIds / 回执缺增量 / 退出码非 0 无效", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  assertOk(appendEvidence(fx, { requirementId: "R1", kind: "command", revision }));
  assertOk(appendEvidence(fx, { requirementId: "R1", kind: "inspection", revision }));
  assertOk(appendEvidence(fx, { requirementId: "R2", kind: "command", revision }));
  const explore = evidenceFile(fx.taskDir, "explore.md");
  const exploreResult = appendEvent(fx, {
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "探索", dimensions: ["smoke"], coverageManifestSha256: explore.artifactSha256, artifact: explore.artifact,
  }, "assurance");
  assertOk(exploreResult);
  const explorationEventId = JSON.parse(parseStdout(exploreResult)).eventId;
  const final = evidenceFile(fx.taskDir, "assurance-final.md");

  const badIds = appendEvent(fx, {
    type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "假证据 id", evidenceEventIds: [sha256("not-exist")],
    coverageManifestSha256: explore.artifactSha256, explorationEventId,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("l"), cwd: fx.projectDir, artifactSha256: sha256("a") }],
    cleanBuild: null, artifact: final.artifact,
  }, "assurance");
  assert.ok(badIds.status === 0 || badIds.status === 1, "append 结果不决定绑定有效性（绑定校验在 verdict 端）");

  // 形态合法但绑定不满足的事件可入流，但 verdict 端保证无效（fold 只做结构校验，绑定校验在 verdict）
  // —— 用「回执 exitCode=1」构造绑定不满足
  const redReceipt = appendEvent(fx, {
    type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "红回执", evidenceEventIds: [sha256("placeholder")],
    coverageManifestSha256: explore.artifactSha256, explorationEventId,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 1, logSha256: sha256("l"), cwd: fx.projectDir, artifactSha256: sha256("a") }],
    cleanBuild: null, artifact: final.artifact,
  }, "assurance");
  // evidenceEventIds 指向不存在事件在 shape 层可过、fold 不查（verdict 查），append 应成功
  assert.ok(redReceipt.status === 0 || /假证据|不满足/.test(redReceipt.stderr));
  const verdict = evaluate(fx);
  assert.equal(verdict.missing.assuranceCompleted, true, "回执红或假绑定的保证不得计入");
});

// ── 6. 漂移链 ──

test("连续漂移超上限进 revision-unstable；确认基线后恢复", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision);
  assert.equal(evaluate(fx).state, "accepted");
  // 制造真实 revision 变化（保证期后受验树被改动 → 漂移非预期修复，旧证据同时过期）
  writeFileSync(join(fx.projectDir, "a.txt"), "changed\n");
  const rev2 = currentRevision(fx);
  for (const [setup, finalize, seq] of [[revision, "intermediate", 1], ["intermediate", rev2, 2]]) {
    assertOk(appendEvent(fx, {
      type: "AssuranceRevisionDrift", actor: "assurance", acceptanceVersion: 1,
      revision: finalize, summary: `漂移 ${seq}`, setupRevision: setup, finalizeRevision: finalize, driftSeq: seq,
    }, "assurance"));
  }
  const twoDrifts = evaluate(fx);
  assert.equal(twoDrifts.state, "candidate", "链长 2 未超上限（effective>2 才 unstable），但旧证据已过期应降 candidate");
  assert.ok(twoDrifts.driftChain.chainLength >= 2, "链长至少应计到 2");
  // 第三条相接漂移使链=3 → 超上限
  assertOk(appendEvent(fx, {
    type: "AssuranceRevisionDrift", actor: "assurance", acceptanceVersion: 1,
    revision: rev2, summary: "漂移 3", setupRevision: rev2, finalizeRevision: rev2, driftSeq: 3,
  }, "assurance"));
  const unstable = evaluate(fx);
  assert.equal(unstable.state, "revision-unstable", "链长 3 超上限 2 应 unstable");
  assertOk(fx.gate(
    "confirm-baseline", "--task-dir", fx.taskDir, "--reason", "排查完成：写入源已停",
    "--credential", fx.creds.user, "--revision", rev2,
  ));
  const after = evaluate(fx);
  assert.notEqual(after.state, "revision-unstable", "确认基线后漂移计数归零应脱离 unstable");
});

// ── 7. 任务替换三段协议 ──

test("任务替换：prepare 占用 → 二次 prepare 拒 → commit 前任 superseded 且继承发现参与判定", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision);
  const defectArtifact = evidenceFile(fx.taskDir, "defect-X.md");
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "未决缺陷", findingId: "F-KEEP", category: "defect", severity: "blocker",
    requirementIds: ["R1"], artifact: defectArtifact.artifact,
  }, "assurance"));
  assert.equal(evaluate(fx).state, "implementing");
  // 新任务接管
  const intentPath = join(fx.root, "intent.md");
  const successor = fx.gate("init", "--project-root", fx.projectDir, "--task-id", "task-succ");
  assertOk(successor);
  const successorDir = JSON.parse(parseStdout(successor)).taskDir;
  const prepare = fx.gate(
    "supersede-prepare", "--task-dir", successorDir, "--predecessor-dir", fx.taskDir,
    "--summary", "凭据丢失接管", "--credential", `${fx.slug}/task-succ/user`,
  );
  assertOk(prepare);
  // 前任被占用：第三个任务再 prepare 应拒
  const third = fx.gate("init", "--project-root", fx.projectDir, "--task-id", "task-third");
  assertOk(third);
  const thirdDir = JSON.parse(parseStdout(third)).taskDir;
  const blocked = fx.gate(
    "supersede-prepare", "--task-dir", thirdDir, "--predecessor-dir", fx.taskDir,
    "--summary", "二次占用", "--credential", `${fx.slug}/task-third/user`,
  );
  assertFailure(blocked);
  assert.match(blocked.stderr, /未完成的替换 prepare/);
  // 后继任务在 prepare 阶段禁止批准与交付
  const succEvaluate = fx.gate("evaluate", "--task-dir", successorDir);
  assert.ok(succEvaluate.status !== 0 || JSON.parse(parseStdout(succEvaluate)).state === "supersede-pending", "后继在 prepare 未 commit 时应 supersede-pending");
  // commit：前任标 supersededBy、继承 F-KEEP 参与新任务判定
  const commit = fx.gate(
    "supersede-commit", "--task-dir", successorDir, "--summary", "替换落定",
    "--credential", `${fx.slug}/task-succ/user`,
  );
  assertOk(commit);
  const predecessorTask = readJson(join(fx.taskDir, "task.json"));
  assert.equal(predecessorTask.supersededBy.successorTaskId, "task-succ");
  assert.equal(evaluate(fx).state, "superseded", "前任应输出 superseded");
  // 后继任务继承 F-KEEP：即使无本地事件也阻 accepted（需要补验收包后评估）
  writeJson(join(successorDir, "acceptance.json"), { ...readJson(join(fx.taskDir, "acceptance.json")), taskId: "task-succ" });
  writeJson(join(successorDir, "increments.json"), readJson(join(fx.taskDir, "increments.json")));
  writeFileSync(join(successorDir, "intent.md"), readFileSync(intentPath, "utf8"));
  assertOk(fx.gate("snapshot-policy", "--task-dir", successorDir));
  evidenceFile(successorDir, "acceptance-review-v1.md", "# 继承审查\n验收包与前任一致。\n");
  assertOk(fx.gate("record-review", "--task-dir", successorDir, "--conclusion", "pass", "--summary", "继承审查", "--credential", `${fx.slug}/task-succ/assurance`));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", successorDir, "--confirmation", "user-explicit",
    "--summary", "批准继承包", "--credential", `${fx.slug}/task-succ/user`,
  ));
  const succVerdict = JSON.parse(parseStdout(fx.gate("evaluate", "--task-dir", successorDir)));
  assert.ok(
    succVerdict.openFindings.some((finding) => finding.findingId === "F-KEEP" && finding.inherited),
    "继承发现 F-KEEP 应出现在后继 openFindings",
  );
  // 继承发现与本地 FindingRaised 同语义：FindingResolved 与 reopenOf 都必须接受继承
  // id——否则继承 blocker 除用户接受风险外无任何机器合法出口（修复死路）
  const resolveArtifact = evidenceFile(successorDir, "inherited-resolved.md");
  assertOk(fx.gate(
    "resolve-finding", "--task-dir", successorDir,
    "--finding-id", "F-KEEP", "--summary", "修复继承发现", "--artifact", resolveArtifact.artifact,
    "--credential", `${fx.slug}/task-succ/assurance`,
  ));
  // reopen 谓词（criterionChanged）：修复尝试提交使 revision 变化——判据环境变化后复发重开在表内
  spawnSync("git", ["commit", "--allow-empty", "-qm", "fix attempt for F-KEEP"], { cwd: fx.projectDir });
  const reopenArtifact = evidenceFile(successorDir, "inherited-reopen.md");
  assertOk(fx.gate(
    "record-finding", "--task-dir", successorDir,
    "--summary", "继承问题复发", "--category", "defect", "--severity", "blocker",
    "--requirement-ids", JSON.stringify(["R1"]), "--finding-id", "F-KEEP-RE",
    "--reopen-of", "F-KEEP", "--artifact", reopenArtifact.artifact,
    "--credential", `${fx.slug}/task-succ/assurance`,
  ));
  const reopenedVerdict = JSON.parse(parseStdout(fx.gate("evaluate", "--task-dir", successorDir)));
  assert.equal(reopenedVerdict.quality.uniqueMustFix, 1, "继承问题经 reopenOf 重开不重复计数（根 id 折叠）");
});

test("reopen 谓词：同版本同 revision 无变化重开拒绝；revision 变化后放行（状态机设计 criterionChanged 接线）", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  const artifact = evidenceFile(fx.taskDir, "predicate-finding.md");
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "谓词用例发现", findingId: "F-PRED", category: "defect", severity: "blocker",
    requirementIds: ["R1"], artifact: artifact.artifact,
  }, "assurance"));
  assertOk(fx.gate("resolve-finding", "--task-dir", fx.taskDir, "--finding-id", "F-PRED",
    "--summary", "修复", "--artifact", artifact.artifact, "--credential", fx.creds.assurance,
    "--revision", revision));
  // 同版本同 revision：判据环境无变化，重开被拒
  const rejected = fx.gate("record-finding", "--task-dir", fx.taskDir,
    "--summary", "复发", "--category", "defect", "--severity", "blocker",
    "--requirement-ids", JSON.stringify(["R1"]), "--finding-id", "F-PRED-RE",
    "--reopen-of", "F-PRED", "--artifact", artifact.artifact,
    "--revision", revision, "--credential", fx.creds.assurance);
  assertFailure(rejected);
  assert.match(rejected.stderr, /reopen 谓词不满足/);
  // 修复尝试提交（revision 变化）后：修复后复发走重开在表内（缺陷族 reopenOf 不重复计数通道）
  spawnSync("git", ["commit", "--allow-empty", "-qm", "fix attempt for F-PRED"], { cwd: fx.projectDir });
  const reopened = fx.gate("record-finding", "--task-dir", fx.taskDir,
    "--summary", "修复后复发", "--category", "defect", "--severity", "blocker",
    "--requirement-ids", JSON.stringify(["R1"]), "--finding-id", "F-PRED-RE2",
    "--reopen-of", "F-PRED", "--artifact", artifact.artifact,
    "--revision", currentRevision(fx), "--credential", fx.creds.assurance);
  assertOk(reopened);
});

test("事件信封 channel：--channel=workflow 落信封、缺省 manual、非法值拒绝（V5 完整性设计 §7.3 来源记录）", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  const artifact = evidenceFile(fx.taskDir, "channel-finding.md");
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "通道用例", findingId: "F-CH", category: "defect", severity: "blocker",
    requirementIds: ["R1"], artifact: artifact.artifact,
  }, "assurance"));
  assertOk(fx.gate("resolve-finding", "--task-dir", fx.taskDir, "--finding-id", "F-CH",
    "--summary", "解决", "--artifact", artifact.artifact, "--credential", fx.creds.assurance,
    "--channel", "workflow"));
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.find((record) => record.type === "FindingResolved").channel, "workflow", "显式 --channel=workflow 应落信封");
  assert.equal(events.find((record) => record.type === "FindingRaised").channel, "manual", "CLI 缺省按 manual 记录");
  const bad = fx.gate("record-finding", "--task-dir", fx.taskDir,
    "--summary", "非法通道", "--category", "defect", "--severity", "blocker",
    "--requirement-ids", JSON.stringify(["R1"]), "--artifact", artifact.artifact,
    "--finding-id", "F-CH2", "--channel", "bogus", "--credential", fx.creds.assurance);
  assertFailure(bad);
  assert.match(bad.stderr, /--channel 取值非法/);
});

// ── 8. 写事务租约 ──

test("租约：acquire/heartbeat/release；append --run-id 非持有者被拒", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("lease-acquire", "--project-root", fx.projectDir, "--run-id", "run-1"));
  assertOk(fx.gate("lease-heartbeat", "--project-root", fx.projectDir, "--run-id", "run-1"));
  const foreign = fx.gate("lease-heartbeat", "--project-root", fx.projectDir, "--run-id", "run-2");
  assertFailure(foreign);
  const revision = currentRevision(fx);
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  writeReviewArtifact(fx);
  assertOk(fx.gate("record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "批准", "--credential", fx.creds.user,
  ));
  const implArtifact = evidenceFile(fx.taskDir, "impl-I1.md");
  const event = {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision,
    summary: "I1", incrementId: "I1", artifact: implArtifact.artifact,
    mergeReceipt: { fromRevision: revision, toRevision: revision, patchSha256: sha256("p") },
  };
  const intentArgs = [
    "--task-dir", fx.taskDir, "--increment-id", event.incrementId, "--summary", event.summary,
    "--artifact", event.artifact, "--merge-receipt", JSON.stringify(event.mergeReceipt),
  ];
  const wrongRun = fx.gate(
    "record-implementation", ...intentArgs,
    "--credential", fx.creds.builder, "--run-id", "run-2",
  );
  assertFailure(wrongRun);
  assert.match(wrongRun.stderr, /不是当前代次/);
  assertOk(fx.gate(
    "record-implementation", ...intentArgs,
    "--credential", fx.creds.builder, "--run-id", "run-1",
  ));
  assertOk(fx.gate("lease-release", "--project-root", fx.projectDir, "--run-id", "run-1"));
});

test("租约持租互斥：心跳新鲜期间异 runId acquire 被拒（活性由心跳承重，不因登记进程退出而被接管）", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("lease-acquire", "--project-root", fx.projectDir, "--run-id", "run-holder"));
  // 登记租约的 CLI 进程已退出（短命进程）——但心跳刚写入、仍在新鲜窗口内：
  // 异 runId 的 acquire 必须被拒（持租 workflow 的周期心跳是活性信号）
  const foreignAcquire = fx.gate("lease-acquire", "--project-root", fx.projectDir, "--run-id", "run-other");
  assertFailure(foreignAcquire);
  assert.match(foreignAcquire.stderr, /仍存活/);
  // 同 runId 重复 acquire 幂等续租
  assertOk(fx.gate("lease-acquire", "--project-root", fx.projectDir, "--run-id", "run-holder"));
  assertOk(fx.gate("lease-release", "--project-root", fx.projectDir, "--run-id", "run-holder"));
});

test("verdict.openFindings 透传归因字段（origin/firstDetectedStage/expectedStage/regressionTestRef，未填输出 null）", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  const artifact = evidenceFile(fx.taskDir, "finding-attrib.md");
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "带归因的发现", findingId: "F-ATTR", category: "defect", severity: "blocker",
    requirementIds: ["R1"], origin: "design", firstDetectedStage: "assuring", expectedStage: "design",
    regressionTestRef: "test-attr-1", artifact: artifact.artifact,
  }, "assurance"));
  const verdict = evaluate(fx);
  const attributed = verdict.openFindings.find((finding) => finding.findingId === "F-ATTR");
  assert.ok(attributed !== undefined, "F-ATTR 应在 openFindings");
  assert.equal(attributed.origin, "design");
  assert.equal(attributed.firstDetectedStage, "assuring");
  assert.equal(attributed.expectedStage, "design");
  assert.equal(attributed.regressionTestRef, "test-attr-1");
  // 未填归因字段的发现输出 null（主 agent 读 verdict 时字段恒存在、可判空）
  const artifact2 = evidenceFile(fx.taskDir, "finding-noattrib.md");
  assertOk(appendEvent(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "无归因的发现", findingId: "F-NOATTR", category: "boundary", severity: "non-blocker",
    requirementIds: [], artifact: artifact2.artifact,
  }, "assurance"));
  const next = evaluate(fx);
  const plain = next.openFindings.find((finding) => finding.findingId === "F-NOATTR");
  assert.ok(plain !== undefined);
  assert.equal(plain.origin, null);
  assert.equal(plain.firstDetectedStage, null);
  assert.equal(plain.expectedStage, null);
  assert.equal(plain.regressionTestRef, null);
});

// ── 9. 幂等与 verdict 字段 ──

test("append 完全相同事件幂等；verdict 含缺口 gapId 与非必需失败披露", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  // 发现引用独立文件（impl 报告已被意图命令哈希登记，发现类契约不带哈希不可复用该路径）
  const findingArtifact = evidenceFile(fx.taskDir, "finding-idem.md");
  const event = {
    type: "FindingRaised", actor: "builder", acceptanceVersion: 1, revision,
    summary: "重复幂等", findingId: "F-IDEM", category: "defect", severity: "non-blocker",
    requirementIds: ["R2"], artifact: findingArtifact.artifact,
  };
  const first = appendEvent(fx, event, "builder");
  assertOk(first);
  const second = appendEvent(fx, event, "builder");
  assertOk(second);
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(events.filter((line) => line.includes("F-IDEM")).length, 1, "相同事件不得重复追加");
  const verdict = evaluate(fx);
  const r1Command = verdict.requirements.find((r) => r.id === "R1").evidence.find((e) => e.kind === "command");
  assert.ok(r1Command.gapId, "missing 缺口应有确定性派生 gapId");
  assert.equal(r1Command.result, "missing");
});

// ── 10. 增量测试命令必填与证据防覆盖写 ──

test("无 testCommand 的增量被 validate-acceptance 拒绝（裁决器要求回执覆盖全部增量）", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const increments = readJson(join(fx.taskDir, "increments.json"));
  delete increments.items[0].testCommand;
  writeJson(join(fx.taskDir, "increments.json"), increments);
  const result = fx.gate("validate-acceptance", "--task-dir", fx.taskDir);
  assertFailure(result);
  assert.match(result.stderr, /testCommand/);
});

test("已登记 artifact 禁止覆盖写：同路径不同哈希被拒，新文件名放行", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  const revision = driveToAssuranceStage(fx);
  const first = evidenceFile(fx.taskDir, "r1-command.md", "# v1 原始证据\n");
  assertOk(appendEvent(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "R1 command verified", requirementId: "R1", kind: "command", result: "verified",
    artifact: first.artifact, artifactSha256: first.artifactSha256,
  }, "assurance"));
  // 覆盖写：磁盘内容被改后，新事件以新哈希引用同一路径 → 预防性拒绝
  writeFileSync(join(fx.taskDir, "evidence", "r1-command.md"), "# v2 被覆盖的证据\n");
  const overwritten = appendEvent(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "R1 command 重记", requirementId: "R1", kind: "command", result: "verified",
    artifact: first.artifact, artifactSha256: sha256("# v2 被覆盖的证据\n"),
  }, "assurance");
  assertFailure(overwritten);
  assert.match(overwritten.stderr, /不同内容哈希登记/);
  assert.match(overwritten.stderr, /新文件名/);
  // 磁盘哈希与事件声明不一致（文件被改但事件沿用旧哈希）→ 同样拒绝
  const staleSha = appendEvent(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "R1 command 旧哈希", requirementId: "R1", kind: "command", result: "verified",
    artifact: first.artifact, artifactSha256: first.artifactSha256,
  }, "assurance");
  assertFailure(staleSha);
  assert.match(staleSha.stderr, /哈希与事件声明不一致/);
  // 新文件名 + 与磁盘一致的新哈希 → 放行
  const fresh = evidenceFile(fx.taskDir, "r1-command-2.md", "# v2 新文件名证据\n");
  assertOk(appendEvent(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "R1 command 新文件", requirementId: "R1", kind: "command", result: "verified",
    artifact: fresh.artifact, artifactSha256: fresh.artifactSha256,
  }, "assurance"));
});

// ── 11. verdict-rules 开关（requireAcceptanceReview / requireDesignApproved）──

test("requireAcceptanceReview=false：不做 record-review 直接批准成功（reviewEventId=none），evaluate 不停 draft/design", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  overrideUserPolicy(fx, "verdict-rules.json", { maxDriftChain: 2, requireAcceptanceReview: false, requireDesignApproved: false });
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  const approve = fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "免审查批准", "--credential", fx.creds.user,
  );
  assertOk(approve, "requireAcceptanceReview=false 时无 record-review 也应批准成功");
  assert.match(approve.stderr, /requireAcceptanceReview=false，本次批准免审查/);
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const approval = events.find((event) => event.type === "AcceptanceApproved");
  assert.equal(approval.reviewEventId, "none", "免审查批准事件应携带 reviewEventId=none");
  const verdict = evaluate(fx);
  assert.equal(verdict.missing.acceptanceApproval, false, "免审查批准应计入有效批准");
  assert.notEqual(verdict.state, "draft", "批准有效则不得停 draft");
  assert.notEqual(verdict.state, "design", "requireDesignApproved=false 时不得停 design");
  assert.equal(verdict.state, "acceptance-approved", "批准且零实现应为 acceptance-approved");
});

test("默认策略：reviewEventId=none 的批准双路被拒——命令前置拦截 + 手工 append 语义层拦截", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  // 命令路径：未 record-review 直接批准 → 前置 fail（requireAcceptanceReview 默认 true）
  const noReview = fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "未审查批准", "--credential", fx.creds.user,
  );
  assertFailure(noReview);
  assert.match(noReview.stderr, /批准前置不满足/);
  // 手工 append 通道已退役：伪造事件 JSON 的通道在 CLI 面结构性关闭（语义层
  // reviewEventId=none 拒绝仍在 appendEvent 内保留，作为内部路径的纵深防线）
  writeReviewArtifact(fx);
  assertOk(fx.gate(
    "record-review", "--task-dir", fx.taskDir, "--conclusion", "pass",
    "--summary", "通过", "--credential", fx.creds.assurance,
  ));
  const forged = fx.gate(
    "append", "--task-dir", fx.taskDir,
    "--event", JSON.stringify({ type: "AcceptanceApproved", reviewEventId: "none", confirmation: "user-explicit" }),
    "--credential", fx.creds.user,
  );
  assertFailure(forged);
  assert.match(forged.stderr, /append 已退役/);
  // 拦截只针对 none 语义：正常绑定审查的批准仍应成功
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "正常批准", "--credential", fx.creds.user,
  ));
  assert.notEqual(evaluate(fx).state, "draft", "绑定真实审查的批准应有效");
});

test("requireDesignApproved=false：无 DesignApproved 时 state 路由跳过 design，全链路直达 accepted", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  overrideUserPolicy(fx, "verdict-rules.json", { maxDriftChain: 2, requireAcceptanceReview: true, requireDesignApproved: false });
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  writeReviewArtifact(fx);
  assertOk(fx.gate(
    "record-review", "--task-dir", fx.taskDir, "--conclusion", "pass",
    "--summary", "审查通过", "--credential", fx.creds.assurance,
  ));
  assertOk(fx.gate(
    "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit",
    "--summary", "批准 v1", "--credential", fx.creds.user,
  ));
  // 批准后、零实现时刻：requireDesignApproved=false 使路由跳过 design 位，直落 acceptance-approved
  const verdict = evaluate(fx);
  assert.notEqual(verdict.state, "design", "requireDesignApproved=false 时不得落 design");
  assert.equal(verdict.state, "acceptance-approved", "批准且零实现应 acceptance-approved");
  assert.equal(verdict.missing.designApproval, true, "未做方案批准时缺口如实披露");
  // 不补 record-design-approved，直接实现 + 保证完成 → accepted
  const revision = currentRevision(fx);
  const implArtifact = evidenceFile(fx.taskDir, "impl-I1.md", "# 实现报告\n");
  assertOk(appendEvent(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision,
    summary: "I1 实现", incrementId: "I1", artifact: implArtifact.artifact,
    mergeReceipt: { fromRevision: revision, toRevision: revision, patchSha256: sha256("patch") },
  }, "builder"));
  driveAssuranceComplete(fx, revision);
  assert.equal(evaluate(fx).state, "accepted", "全程无 DesignApproved 也应 accepted");
});

// ── 12. finding-categories 阻塞语义与风险接受开关 ──

test("blocksAccepted 三态与 riskAcceptAllowed：cosmetic 不阻、defect 可接受放行、boundary 确认前阻塞且禁风险接受", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  overrideUserPolicy(fx, "finding-categories.json", {
    categories: [
      { id: "defect", blocksAccepted: true, exits: ["fix-then-resolve", "user-risk-accept-if-allowed"], riskAcceptAllowed: true },
      { id: "boundary", blocksAccepted: "until-confirmed", exits: ["assurance-confirm-declared"], riskAcceptAllowed: false },
      { id: "cosmetic", blocksAccepted: false, exits: ["user-risk-accept-if-allowed"], riskAcceptAllowed: true },
    ],
  });
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision);
  // 负例：blocksAccepted=false（cosmetic）不阻 accepted
  raiseFinding(fx, revision, "F-COS", "cosmetic", "non-blocker", ["R2"]);
  assert.equal(evaluate(fx).state, "accepted", "blocksAccepted=false 的分类不得阻 accepted");
  // 正例：blocksAccepted=true（defect）未决阻 accepted；riskAcceptAllowed=true 接受后放行
  raiseFinding(fx, revision, "F-DEF", "defect", "non-blocker", ["R2"]);
  assert.equal(evaluate(fx).state, "candidate", "defect 未决应阻 accepted");
  assertOk(fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "finding", "--target-id", "F-DEF",
    "--confirmation", "user-explicit", "--summary", "接受缺陷风险", "--credential", fx.creds.user,
  ));
  assert.equal(evaluate(fx).state, "accepted_with_risk", "riskAcceptAllowed=true 的缺陷接受后应 accepted_with_risk");
  // 正例：blocksAccepted=until-confirmed（boundary）未确认阻 accepted
  raiseFinding(fx, revision, "F-BND", "boundary", "non-blocker", ["R1"]);
  assert.equal(evaluate(fx).state, "candidate", "boundary 未确认应阻 accepted");
  // 负例：riskAcceptAllowed=false 拒绝风险接受，出路是 FindingResolved
  const denied = fx.gate(
    "accept-risk", "--task-dir", fx.taskDir, "--target-type", "finding", "--target-id", "F-BND",
    "--confirmation", "user-explicit", "--summary", "试图接受边界风险", "--credential", fx.creds.user,
  );
  assertFailure(denied);
  assert.match(denied.stderr, /不允许风险接受（策略 riskAcceptAllowed=false）/);
  const resolved = evidenceFile(fx.taskDir, "bnd-resolved.md", "# 边界确认\n已论证声明边界。\n");
  assertOk(appendEvent(fx, {
    type: "FindingResolved", actor: "assurance", acceptanceVersion: 1, revision,
    summary: "边界已论证确认", findingId: "F-BND", artifact: resolved.artifact,
  }, "assurance"));
  assert.equal(evaluate(fx).state, "accepted_with_risk", "boundary 确认后不再阻塞（F-DEF 已接受维持 accepted_with_risk）");
});

// ── 13. content-manifest 指纹与干净构建豁免 ──

test("content-manifest 指纹：非 git 目录清单哈希、内容变化敏感、空/重复/越界清单拒绝", (t) => {
  const root = mkdtempSync(join(tmpdir(), "delivery-manifest-rev-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "plain");
  const home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  overrideUserPolicy({ home }, "revision.json", { mode: "content-manifest", runsFromIgnoredArtifacts: false });
  writeFileSync(join(project, "app.out"), "artifact-v1\n");
  writeFileSync(join(project, "delivery-manifest.txt"), "# 纳入 revision 的产物\napp.out\n");
  const run = (args) => runGate(args, home);
  const first = run(["revision", "--project-root", project]);
  assertOk(first);
  assert.match(first.stdout.trim(), /^manifest-[0-9a-f]{24}$/, "清单模式 revision 应输出 manifest-<24hex>");
  // 清单条目内容变化 → revision 变化
  writeFileSync(join(project, "app.out"), "artifact-v2\n");
  const second = run(["revision", "--project-root", project]);
  assertOk(second);
  assert.notEqual(second.stdout, first.stdout, "清单内容变化必须改变 revision");
  assert.match(second.stdout.trim(), /^manifest-[0-9a-f]{24}$/);
  // 空清单（仅注释与空行）
  writeFileSync(join(project, "delivery-manifest.txt"), "# 只有注释\n\n");
  const empty = run(["revision", "--project-root", project]);
  assertFailure(empty);
  assert.match(empty.stderr, /内容清单为空/);
  // 重复条目
  writeFileSync(join(project, "delivery-manifest.txt"), "app.out\napp.out\n");
  const dup = run(["revision", "--project-root", project]);
  assertFailure(dup);
  assert.match(dup.stderr, /重复条目/);
  // 越界条目
  writeFileSync(join(project, "delivery-manifest.txt"), "../secret.txt\n");
  const escape = run(["revision", "--project-root", project]);
  assertFailure(escape);
  assert.match(escape.stderr, /越界/);
  // 对照：默认 auto-git 策略下非 git 目录明确失败，恢复动作指引 content-manifest 出路
  const plainHome = join(root, "home2");
  mkdirSync(plainHome);
  const autoGit = runGate(["revision", "--project-root", project], plainHome);
  assertFailure(autoGit);
  assert.match(autoGit.stderr, /mode=content-manifest/);
});

test("runsFromIgnoredArtifacts=true：mode=content-manifest 豁免干净构建，无 cleanBuild 的 AssuranceCompleted 仍有效直达 accepted", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  writeFileSync(join(fx.projectDir, "delivery-manifest.txt"), "a.txt\n");
  overrideUserPolicy(fx, "revision.json", { mode: "content-manifest", runsFromIgnoredArtifacts: true });
  const revision = driveToAssuranceStage(fx);
  assert.match(revision, /^manifest-[0-9a-f]{24}$/, "全链路 revision 应为清单指纹");
  driveAssuranceComplete(fx, revision); // cleanBuild: null
  const verdict = evaluate(fx);
  assert.equal(verdict.missing.assuranceCompleted, false, "清单模式应豁免干净构建记录");
  assert.equal(verdict.state, "accepted");
});

test("runsFromIgnoredArtifacts=true 对照：mode=auto-git 不豁免，缺干净构建的 AssuranceCompleted 判无效停 candidate", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  overrideUserPolicy(fx, "revision.json", { mode: "auto-git", runsFromIgnoredArtifacts: true });
  const revision = driveToAssuranceStage(fx);
  driveAssuranceComplete(fx, revision); // cleanBuild: null
  const verdict = evaluate(fx);
  assert.equal(verdict.missing.assuranceCompleted, true, "auto-git 模式从 ignored 产物运行必须附干净构建");
  assert.equal(verdict.state, "candidate", "缺干净构建应停 candidate 而非错误宣告 accepted");
});

// ── DEV 代收敛机制（ResolutionReaffirmed / RiskPreauthorized）──

test("DEV 收敛：ResolutionReaffirmed 在新 revision 恢复已修发现的 resolved 态；reaffirmableFindings 提供核对清单", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  const rev1 = currentRevision(fx);
  raiseFinding(fx, rev1, "F-A1", "defect", "blocker", ["R1"]);
  const resArtifact = evidenceFile(fx.taskDir, "resolve-a1.md");
  const resolved = appendEvent(fx, {
    type: "FindingResolved", actor: "assurance", acceptanceVersion: 1, revision: rev1,
    summary: "已修复 F-A1", findingId: "F-A1", artifact: resArtifact.artifact,
  }, "assurance");
  assertOk(resolved);
  const resolutionEventId = JSON.parse(parseStdout(resolved)).eventId;

  // rev1 上：resolved、不列入 reaffirmable
  assert.equal(evaluate(fx).openFindings.filter((f) => f.findingId === "F-A1").length, 0);
  assert.equal(evaluate(fx).reaffirmableFindings.filter((f) => f.findingId === "F-A1").length, 0);

  // 修复提交 → revision 前进：旧 resolution 失效回 open，列入 reaffirmable（带原 resolution eventId）
  writeFileSync(join(fx.projectDir, "b.txt"), "fix\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "fix F-A1"], { cwd: fx.projectDir });
  let verdict = evaluate(fx);
  assert.equal(verdict.openFindings.filter((f) => f.findingId === "F-A1").length, 1, "revision 前进后旧 resolution 应失效");
  const reaffirmable = verdict.reaffirmableFindings.find((f) => f.findingId === "F-A1");
  assert.ok(reaffirmable, "F-A1 应列入 reaffirmableFindings");
  assert.deepEqual(reaffirmable.originalResolutionEventIds, [resolutionEventId]);
  assert.equal(reaffirmable.lastResolvedRevision, rev1);

  // 重认领：锚定原 resolution 的 eventId
  const basisArtifact = evidenceFile(fx.taskDir, "reaffirm-a1.md");
  assertOk(appendEvent(fx, {
    type: "ResolutionReaffirmed", actor: "assurance", acceptanceVersion: 1, revision: currentRevision(fx),
    summary: "原修复仍有效（本轮增量测试全绿）", findingId: "F-A1",
    originalResolutionEventId: resolutionEventId,
    basis: "本轮逐增量测试在当前 revision 复跑全部 exit 0", artifact: basisArtifact.artifact,
  }, "assurance"));
  verdict = evaluate(fx);
  assert.equal(verdict.openFindings.filter((f) => f.findingId === "F-A1").length, 0, "重认领后 F-A1 不再 open");
  assert.equal(verdict.reaffirmableFindings.filter((f) => f.findingId === "F-A1").length, 0, "已不 open 的不再列 reaffirmable");

  // 反例：锚定不存在的 resolution → fold 拒绝
  const bad = appendEvent(fx, {
    type: "ResolutionReaffirmed", actor: "assurance", acceptanceVersion: 1, revision: currentRevision(fx),
    summary: "x", findingId: "F-A1", originalResolutionEventId: `nonexistent-${resolutionEventId}`,
    basis: "x", artifact: basisArtifact.artifact,
  }, "assurance");
  assertFailure(bad);
  assert.match(bad.stderr, /originalResolutionEventId/);
});

test("DEV 收敛：风险预授权——standing 接受按类别/名额放行；blocker 与 requirement 目标永不可预授权；重放校验一致", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  const rev = currentRevision(fx);
  raiseFinding(fx, rev, "F-A1", "defect", "non-blocker", ["R2"]);
  raiseFinding(fx, rev, "F-A2", "defect", "non-blocker", ["R2"]);
  raiseFinding(fx, rev, "F-A3", "defect", "blocker", ["R2"]);
  const accept = (targetType, targetId, confirmation, extra = []) =>
    fx.gate("accept-risk", "--task-dir", fx.taskDir, "--target-type", targetType, "--target-id", targetId,
      "--confirmation", confirmation, "--summary", "s", "--credential", fx.creds.user, "--revision", rev, ...extra);

  // 预授权前 standing 被拒
  assertFailure(accept("finding", "F-A1", "standing-authorization"));
  // 登记（user 凭据；confirmation 由命令固定 user-explicit）
  assertOk(fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "boundary", "--max-findings", "5",
    "--summary", "boundary 预授权", "--credential", fx.creds.user));
  // 类别不匹配（F-A1 是 defect）→ 拒
  assertFailure(accept("finding", "F-A1", "standing-authorization"));
  // 追加 defect 授权，名额 1
  assertOk(fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "defect", "--max-findings", "1",
    "--summary", "suggestion 档预授权", "--credential", fx.creds.user));
  assertOk(accept("finding", "F-A1", "standing-authorization"), "defect+non-blocker 命中预授权应通过");
  // 名额耗尽 → 拒
  assertFailure(accept("finding", "F-A2", "standing-authorization"));
  // blocker：standing 永拒（分级安全底线）
  assertFailure(accept("finding", "F-A3", "standing-authorization"));
  // requirement 目标（证据缺口）standing 永拒
  assertFailure(accept("requirement", "R1", "standing-authorization", ["--gap-id", "0".repeat(64)]));
  // user-explicit 通道不受预授权影响（blocker 用户可显式接受）
  assertOk(accept("finding", "F-A3", "user-explicit"), "user-explicit 不依赖预授权");
  // 绕过命令直接拼 RiskAccepted 事件的通道已随 append 退役封闭（fold 侧重放校验
  // 保留在 appendEvent 内作内部路径纵深防线；CLI 面只剩 accept-risk 单一入口）
  const bad = fx.gate(
    "append", "--task-dir", fx.taskDir,
    "--event", JSON.stringify({
      type: "RiskAccepted", actor: "user", acceptanceVersion: 1, revision: rev,
      summary: "x", targetType: "finding", targetId: "F-A2", gapId: "F-A2",
      evidenceState: "failed", confirmation: "standing-authorization",
    }),
    "--credential", fx.creds.user,
  );
  assertFailure(bad);
  assert.match(bad.stderr, /append 已退役/);
});

test("DEV 收敛：preauthorize-risk 输入校验——未登记分类与非法名额被拒；maxSeverity 恒 non-blocker", (t) => {
  const fx = makeV2Fixture(t);
  writeAcceptancePackage(fx);
  assertOk(fx.gate("validate-acceptance", "--task-dir", fx.taskDir));
  assertOk(fx.gate("snapshot-policy", "--task-dir", fx.taskDir));
  assertFailure(fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "nonexistent-cat",
    "--max-findings", "3", "--summary", "s", "--credential", fx.creds.user));
  assertFailure(fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "defect",
    "--max-findings", "0", "--summary", "s", "--credential", fx.creds.user));
  const wrongRole = fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "defect",
    "--max-findings", "3", "--summary", "s", "--credential", fx.creds.assurance);
  assertFailure(wrongRole, 1);
  const ok = fx.gate("preauthorize-risk", "--task-dir", fx.taskDir, "--categories", "defect,boundary",
    "--max-findings", "2", "--summary", "s", "--credential", fx.creds.user);
  assertOk(ok);
  const event = JSON.parse(parseStdout(ok));
  assert.equal(event.maxSeverity, "non-blocker", "severity 上限硬编码 non-blocker（blocker 永不可预授权）");
  assert.equal(event.confirmation, "user-explicit");
});

// ── 防漂移对拍：进程内垫片与 CLI spawn 同输入必须同结果（钉住垫片与 CLI 的一致性）──

test("垫片对拍：两份同构 fixture 各走一条通道，命令序列结果归一化后逐字段一致", (t) => {
  // init 等命令有副作用，同一 fixture 无法双通道重放——用两份同构 fixture 各走一条通道，
  // 输出中的 fixture 根路径归一化后逐字段比对（含退出码与 stderr 文本）
  const makeParityFixture = (label) => {
    const root = mkdtempSync(join(tmpdir(), `delivery-gate-parity-${label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projectDir = join(root, "project");
    const home = join(root, "home");
    if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
    cpSync(repoTemplateDir, projectDir, { recursive: true });
    mkdirSync(home);
    return { root, projectDir, home };
  };
  // stdout/stderr 含 fixture 绝对路径（tmp 根与 realpath 两形态）与每次运行天然不同的
  // 派生值（projectSlug=绝对路径哈希、init 新生成公钥），归一化后才能逐字节比
  const normalize = (text, fixture) => {
    let normalized = text;
    for (const pathForm of [realpathSync(fixture.root), fixture.root]) {
      normalized = normalized.split(pathForm).join("<FIXTURE>");
    }
    return normalized
      .replace(/project-[0-9a-f]{8}/g, "<SLUG>")
      .replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g, "<PUBLIC KEY>");
  };
  const inProcessFx = makeParityFixture("a");
  const cliFx = makeParityFixture("b");
  const commandSequences = [
    { args: ["init", "--project-root", inProcessFx.projectDir, "--task-id", "task-a"], cliArgs: ["init", "--project-root", cliFx.projectDir, "--task-id", "task-a"], expectStatus: 0 },
    { args: ["revision", "--project-root", inProcessFx.projectDir], cliArgs: ["revision", "--project-root", cliFx.projectDir], expectStatus: 0 },
    { args: ["no-such-command"], cliArgs: ["no-such-command"], expectStatus: 2 },
  ];
  for (const { args, cliArgs, expectStatus } of commandSequences) {
    const inProcess = runGate(args, inProcessFx.home);
    const viaCli = runGateSpawn(cliArgs, cliFx.home);
    assert.equal(inProcess.status, expectStatus, `进程内预期退出码：${args.join(" ")}\nstderr：${inProcess.stderr}`);
    assert.equal(inProcess.status, viaCli.status, `status 应一致：${args.join(" ")}`);
    assert.equal(
      normalize(inProcess.stdout, inProcessFx),
      normalize(viaCli.stdout, cliFx),
      `stdout 归一化后应逐字节一致：${args.join(" ")}`,
    );
    assert.equal(
      normalize(inProcess.stderr, inProcessFx),
      normalize(viaCli.stderr, cliFx),
      `stderr 归一化后应逐字节一致：${args.join(" ")}`,
    );
  }
});
