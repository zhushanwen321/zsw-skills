// delivery-golden-v6.test.mjs — 交付体系 V6 golden 任务端到端测试。
// golden 任务（机器判定层）：每次改 kernel/gate 后必跑；agent 语义行为的 golden 需活跑，不在本文件范围。
// 运行：node --test scripts/tests/delivery-golden-v6.test.mjs
//
// 两个场景（各自独立 tmp fixture，互不共享目录）：
//   golden-normal：schema 1 正常流全生命周期走通（init → set-intent → … → accepted，预算零缺陷消耗）。
//   golden-defect：schema 2 预置缺陷流——四条 V6 定级护栏/预算熔断断言，断言「预期拦截阶段 + 报错关键词」。
//
// helper 自包含复制自 scripts/tests/delivery-gate-v6.test.mjs（不跨文件 import）；
// schema 2 验收包 assertions/adversarialForms 构造参照 scripts/tests/delivery-gate-v4-quality-v5.test.mjs。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "delivery-gate.mjs");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath, "utf8"));
}

// 进程内调用（模块只加载一次，逐用例毫秒级）：垫片与 CLI 走同一分发，返回 { status, stdout, stderr } 与 spawnSync 同口径
const GATE_MODULE = await import(pathToFileURL(GATE).href);

function runGate(args, home) {
  return GATE_MODULE.runGateCommand(args, home);
}

function assertOk(result, message = "命令应成功") {
  assert.equal(result.status, 0, `${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertFailure(result, message = "命令应被拒绝") {
  assert.equal(result.status, 1, `${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /恢复动作：/, "每个错误都必须给出恢复动作");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseStdout(result) {
  const text = result.stdout.trim();
  const firstBrace = text.indexOf("{");
  return text.slice(firstBrace >= 0 ? firstBrace : 0);
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
  const dir = mkdtempSync(join(tmpdir(), "delivery-golden-v6-tpl-"));
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // repo 级身份经追加 .git/config 写入（后续 commit 依赖 repo config）
  appendFileSync(join(dir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** v2 fixture：真实 git 项目 + 隔离 HOME + 已 init 的任务目录与三把凭据 id（intent 传 null 则不带意图） */
function makeV2Fixture(t, { taskId = "task-a", intent = "原始需求：开关关闭后零写入\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-golden-v6-"));
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

function currentRevision(fx) {
  const result = fx.gate("revision", "--project-root", fx.projectDir);
  assertOk(result);
  return result.stdout.trim();
}

// 事件追加走意图命令组（信封由 gate 构造；本辅助把既有事件对象形态翻译为意图参数）
const INTENT_OPTION_KEYS = new Map([
  ["reopenOf", "--reopen-of"], ["origin", "--origin"],
  ["consequenceRefutation", "--consequence-refutation"], ["consequenceRefutationType", "--consequence-refutation-type"],
  ["emptyScopeRefutation", "--empty-scope-refutation"],
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
        ...rev);
    case "FindingRaised":
      return fx.gate("record-finding", ...base,
        "--summary", event.summary, "--category", event.category, "--severity", event.severity,
        "--requirement-ids", JSON.stringify(event.requirementIds), "--artifact", event.artifact,
        ...(event.findingId !== undefined ? ["--finding-id", event.findingId] : []),
        ...opts, ...rev);
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
        ...opts, ...rev);
    default:
      throw new Error(`golden 测试辅助未路由事件类型 ${event.type}——补 appendEvent 路由分支`);
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

/** golden-normal 验收包：schema 1，R1（invariant，不可风险接受，command+inspection）+ R2（goal，可风险接受，command） */
function writeAcceptancePackage(fx) {
  writeJson(join(fx.taskDir, "acceptance.json"), {
    schemaVersion: 1,
    acceptanceVersion: 1,
    taskId: basename(fx.taskDir),
    projectRoot: realpathSync(fx.projectDir),
    objective: "开关关闭后系统零写入",
    requirements: [
      { id: "R1", kind: "invariant", statement: "开关关闭后任何路径不产生新写入", required: true, riskAcceptable: false, evidenceKinds: ["command", "inspection"] },
      { id: "R2", kind: "goal", statement: "开关开启时读写路径正常", required: true, riskAcceptable: true, evidenceKinds: ["command"] },
    ],
    nonGoals: ["云端同步"],
    riskLevel: "low",
    exploratoryReview: "not-required",
    reviewDimensions: [],
  });
  writeJson(join(fx.taskDir, "increments.json"), {
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [
      { id: "I1", title: "开关与写入路径", requirementIds: ["R1", "R2"], testCommand: { program: "true", args: [] } },
    ],
  });
}

/** golden-defect 验收包：schema 2，R1 行为由断言 A1/A2 明文覆盖（护栏①的前提），R2 由 A3 覆盖 */
function writeSchema2AcceptancePackage(fx) {
  writeJson(join(fx.taskDir, "acceptance.json"), {
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
          { id: "A1", statement: "在途判断时关闭不写", qualifiers: ["含在途"], given: "开启且判断在途", when: "关闭", then: "不写", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"] },
          { id: "A2", statement: "关闭后显式命令不写", qualifiers: ["显式命令"], given: "关闭", when: "执行命令", then: "不写", adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"] },
        ],
      },
      {
        id: "R2", kind: "goal", statement: "开启时正常", required: true, riskAcceptable: true,
        evidenceKinds: ["command"],
        assertions: [
          { id: "A3", statement: "开启时可写入", qualifiers: ["开启"], given: "开启", when: "写入", then: "成功", adversarialFormRefs: ["AF3"], testAssetRefs: ["test-A3"] },
        ],
      },
    ],
    adversarialForms: [
      { id: "AF1", assertionId: "A1", qualifier: "含在途", entryPoint: "auto", initialState: "模型延时", operation: "等待中关闭", timing: "等待窗口", expected: "不写", testAssetRefs: ["test-A1"], rationale: "在途关闭" },
      { id: "AF2", assertionId: "A2", qualifier: "显式命令", entryPoint: "command", initialState: "关闭", operation: "执行命令", timing: "命令期", expected: "不写", testAssetRefs: ["test-A2"], rationale: "命令入口" },
      { id: "AF3", assertionId: "A3", qualifier: "开启", entryPoint: "repository", initialState: "开启", operation: "写入", timing: "正常路径", expected: "成功", testAssetRefs: ["test-A3"], rationale: "正向对照" },
    ],
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["smoke"],
  });
  writeJson(join(fx.taskDir, "increments.json"), {
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "开关", requirementIds: ["R1", "R2"], testCommand: { program: "true", args: [] } }],
  });
}

/** 快照 + 审查通过 + 批准 + 方案批准（方案包哈希清单 = evidence/package-manifest.json）——到「已批准待实现」 */
function driveToApproval(fx) {
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
  return currentRevision(fx);
}

/** 登记一条 FindingRaised（actor=assurance），artifact 独立落 evidence 目录 */
function raiseFinding(fx, revision, { findingId, category, severity, requirementIds, reopenOf, consequenceRefutation, emptyScopeRefutation }) {
  const artifact = evidenceFile(fx.taskDir, `finding-${findingId}.md`, `# ${findingId}\n${category}/${severity} 发现。\n`);
  return appendEvent(fx, {
    type: "FindingRaised",
    actor: "assurance",
    acceptanceVersion: 1,
    revision,
    summary: `发现 ${findingId}`,
    findingId,
    category,
    severity,
    requirementIds,
    artifact: artifact.artifact,
    ...(reopenOf !== undefined ? { reopenOf } : {}),
    ...(consequenceRefutation !== undefined ? { consequenceRefutation, consequenceRefutationType: "not-observable" } : {}),
    // 空关联 boundary 必须附不影响任何需求的论证（空关联护栏：requirementIds=[] 不得绕过定级护栏）
    ...(emptyScopeRefutation !== undefined ? { emptyScopeRefutation } : {}),
  }, "assurance");
}

function evaluate(fx) {
  const result = fx.gate("evaluate", "--task-dir", fx.taskDir);
  assertOk(result);
  return JSON.parse(parseStdout(result));
}

// ── golden-normal：schema 1 正常流，全生命周期走通 ──

test("golden-normal：init→set-intent→…→complete-assurance→evaluate 全生命周期 accepted，预算零缺陷消耗", async (t) => {
  const fx = makeV2Fixture(t, { taskId: "golden-normal", intent: null });
  const intentFile = join(fx.root, "golden-intent.md");
  writeFileSync(intentFile, "原始需求：开关关闭后零写入\n");
  assertOk(fx.gate("set-intent", "--task-dir", fx.taskDir, "--file", intentFile), "set-intent 应一次写入成功");
  writeAcceptancePackage(fx);
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
  assert.equal(evaluate(fx).state, "acceptance-approved", "批准且方案确认、零实现应停 acceptance-approved");

  const revision = currentRevision(fx);
  // 探索先于实现登记
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
  assertOk(exploreResult, "record-exploration 应成功");
  const explorationEventId = JSON.parse(parseStdout(exploreResult)).eventId;

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
  }, "builder"), "record-implementation 应成功");
  assert.equal(evaluate(fx).state, "candidate", "实现齐但缺保证应停 candidate");

  // 两需求逐证据类型取证：R1 command+inspection、R2 command
  for (const [requirementId, kind] of [["R1", "command"], ["R1", "inspection"], ["R2", "command"]]) {
    assertOk(appendEvidence(fx, { requirementId, kind, revision }), `record-evidence ${requirementId}/${kind} 应成功`);
  }

  // 保证完成：全量证据绑定 + 唯一增量全量回执
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const evidenceIds = events.filter((entry) => entry.type === "EvidenceRecorded").map((entry) => entry.eventId);
  const receiptArtifact = evidenceFile(fx.taskDir, "i1-receipt.md", "# 回执\n");
  const final = evidenceFile(fx.taskDir, "assurance-final.md", "# 保证完成\n");
  assertOk(appendEvent(fx, {
    type: "AssuranceCompleted",
    actor: "assurance",
    acceptanceVersion: 1,
    revision,
    summary: "独立保证完成",
    evidenceEventIds: evidenceIds,
    coverageManifestSha256: explore.artifactSha256,
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
  }, "assurance"), "complete-assurance 应成功");

  const verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "完整正常流应达 accepted");
  assert.deepEqual(verdict.openFindings, [], "正常流不得有任何未决发现");
  assert.equal(verdict.quality.budgets.repairPerVersion.used, 0, "无修复轮：per-version 用量应为 0");
  assert.equal(verdict.quality.budgets.repairPerVersion.cap, 3);
  assert.equal(verdict.quality.budgets.uniqueMustFix.count, 0, "无 must-fix：计数应为 0");
  assert.equal(verdict.quality.budgets.uniqueMustFix.cap, 10);
  // 跨 run 保证预算口径 = 保证 run 次数 + 修复轮数：唯一一次 full 保证自身计入 1（非缺陷性消耗，
  // 上限 6 未动）；零缺陷消耗的语义由 repairPerVersion=0 与 uniqueMustFix=0 承重
  assert.equal(verdict.quality.budgets.assuranceCrossRun.used, 1);
  assert.equal(verdict.quality.budgets.assuranceCrossRun.cap, 6);
});

// ── golden-defect：schema 2 预置缺陷流，四条护栏/预算断言 ──

test("golden-defect：boundary 越权 / 非 blocker 无后果论证 / 改判熔断 / 预算熔断 四缺陷在预期阶段被拦", async (t) => {
  const fx = makeV2Fixture(t, { taskId: "golden-defect" });
  writeSchema2AcceptancePackage(fx);
  const revision = driveToApproval(fx);

  // 预置缺陷 1（护栏①）boundary 越权：拦截阶段 = record-finding 写入当时。
  // R1 的行为已被断言 A1/A2 明文覆盖（schema 2），指向 R1 的 boundary 申报必须被拒。
  const boundaryBan = raiseFinding(fx, revision, {
    findingId: "F-BND-TRY", category: "boundary", severity: "blocker", requirementIds: ["R1"],
  });
  assertFailure(boundaryBan, "有断言覆盖的需求不得申报 boundary");
  assert.match(boundaryBan.stderr, /断言级判据明文覆盖（schema 2 assertions）/);
  assert.match(boundaryBan.stderr, /不得申报为边界/);

  // 预置缺陷 2（护栏②）非 blocker 无后果论证：拦截阶段 = record-finding 写入当时。
  const noRefutation = raiseFinding(fx, revision, {
    findingId: "F-NB-TRY", category: "defect", severity: "non-blocker", requirementIds: ["R1"],
  });
  assertFailure(noRefutation, "schema 2 非 blocker 必须携带后果否证论证");
  assert.match(noRefutation.stderr, /consequenceRefutation/);
  assert.match(noRefutation.stderr, /必须是非空字符串/);

  // 预置缺陷 4（预算熔断）先于缺陷 3 执行：使 must-fix 根计数恰为 11（无链上 blocker 占额），
  // 「第 11 条登记后熔断」的边界精确；缺陷 3 是写入端护栏，不受 verdict 终态影响，放在最后。
  for (let index = 1; index <= 10; index += 1) {
    assertOk(raiseFinding(fx, revision, {
      findingId: `F-M${index}`, category: "defect", severity: "blocker", requirementIds: ["R1"],
    }), `第 ${index} 条 must-fix 登记应成功`);
  }
  const atCap = evaluate(fx);
  assert.equal(atCap.quality.budgets.uniqueMustFix.count, 10, "10 条不同 must-fix 未超上限");
  assert.notEqual(atCap.state, "process-failed", "第 10 条不得触发预算熔断（判定式为 >10）");
  // 第 11 条：登记端不拦（拦截阶段 = evaluate）
  assertOk(raiseFinding(fx, revision, {
    findingId: "F-M11", category: "defect", severity: "blocker", requirementIds: ["R1"],
  }), "第 11 条 must-fix 登记本身不拒——预算拦截在 evaluate 端");
  const overCap = evaluate(fx);
  assert.equal(overCap.state, "process-failed", "第 11 条不同 must-fix 后 evaluate 应判 process-failed");
  assert.ok(overCap.quality.budgets.uniqueMustFix.count >= 11, "must-fix 根计数应 ≥ 11");
  assert.equal(overCap.quality.budgets.uniqueMustFix.cap, 10);
  assert.match(
    overCap.nextAction,
    /预算耗尽停回用户（修复轮预算 0\/3、跨 run 保证预算 0\/6、不同 must-fix 11\/10）/,
    "nextAction 应指向预算耗尽停回用户裁决",
  );

  // 预置缺陷 3（护栏③）改判熔断：同一 reopenOf 根链（findingRegradeHalt=2，>2 种组合即熔断）。
  // 拦截阶段 = record-finding 写入当时。每个组合独立 artifact 文件（raiseFinding 按 findingId 落盘）。
  assertOk(raiseFinding(fx, revision, {
    findingId: "F-G0", category: "defect", severity: "blocker", requirementIds: ["R1"],
  }), "根发现 F-G0 应登记成功（reopenOf 需指向已存在的 finding）");
  assertOk(raiseFinding(fx, revision, {
    findingId: "F-G1", category: "defect", severity: "blocker", requirementIds: ["R1"], reopenOf: "F-G0",
  }), "组合 1/3（defect/blocker 重开，未新增组合）应放行");
  assertOk(raiseFinding(fx, revision, {
    findingId: "F-G2", category: "defect", severity: "non-blocker", requirementIds: ["R1"],
    reopenOf: "F-G0", consequenceRefutation: "该行为用户不可观察：仅内部计数变化",
  }), "组合 2/3（defect/non-blocker，共 2 种未超上限）应放行");
  const halted = raiseFinding(fx, revision, {
    findingId: "F-G3", category: "boundary", severity: "non-blocker", requirementIds: [],
    reopenOf: "F-G0", consequenceRefutation: "该行为用户不可观察：仅内部计数变化",
    // 空关联 boundary 的新合法形态：携带不影响任何需求的论证，使其抵达改判熔断检查
    emptyScopeRefutation: "该发现只涉模拟环境内部计数路径，R1/R2 的断言行为均不经过该路径（逐条对照过）",
  });
  assertFailure(halted, "第 3 种定级组合应触发改判熔断");
  assert.match(halted.stderr, /定级组合数超过 2 种/);
  assert.match(halted.stderr, /定级反复改写触发熔断/);
  assert.match(halted.stderr, /停回用户裁决定级/);
});
