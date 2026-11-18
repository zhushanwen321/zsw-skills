// full-qualification-v6.test.mjs — full 保证资格判定单源回归（kernel-judgments 的
// priorFullQualification，经 delivery-core full-qualification JSON 子命令消费）
//
// 覆盖（判定收编缺口回归：V6 前两个 workflow 各持一份弱化本地副本——证据集收全部
// EvidenceRecorded 不滤工件失效、工件只查存在性无 sha256 校验，与裁决器口径漂移）：
//   1. 纯函数：beforeSeq 上界只判早于参照 seq 的 full（gate hasPriorValidFull 语义）
//   2. 合格 prior full → qualified=true（回执覆盖全部增量 + 证据事件可解析 + 探索引用存在）
//   3. full 引用的证据工件被篡改（内容哈希失效）→ qualified=false 且原因指向该证据事件——
//      口径升级回归：旧本地副本只查存在性会放行此场景（预检放行、终判被拒白跑）
//   4. 无任何 full 保证 → qualified=false（首次完整保证不可被 recheck 替代）
//   5. gate evaluate 与 core 子命令同口径对拍：无合格 full 的 recheck 触发
//      verdict.missing.assuranceFullFirst 且 core 判 qualified=false；有合格 prior full
//      的 recheck 两侧均通过
//
// fixture 构造同 delivery-core-v5.test.mjs（真实任务目录：init 生成任务/凭据/策略快照）。
// 运行：node --test scripts/tests/full-qualification-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const KERNEL = await import(join(V6, "scripts", "lib", "kernel-judgments.mjs"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
async function runCore(args) {
  return CORE_MODULE.runCoreCommandInProcess(args);
}
// 进程内调用（模块只加载一次，逐用例毫秒级）：垫片与 CLI 走同一分发，返回 { status, stdout, stderr } 与 spawnSync 同口径
const GATE_MODULE = await import(pathToFileURL(GATE).href);
const CORE_MODULE = await import(pathToFileURL(CORE).href);

function runGate(args, home) {
  return GATE_MODULE.runGateCommand(args, home);
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// 模板仓：每测试进程只构建一次「初始提交仓」，fixture 经 cpSync 复制实例化——git 对象是
// 内容寻址的只读数据，复制保真，省掉每 fixture 的 init/add/commit 三连 spawn
let repoTemplateDir = null;
function materializeRepoTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "full-qual-v6-tpl-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // repo 级身份经追加 .git/config 写入（后续 commit 依赖 repo config）
  appendFileSync(join(dir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFixture(t, { taskId = "full-qual" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "full-qual-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(home);
  if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
  cpSync(repoTemplateDir, projectDir, { recursive: true });
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "关闭后任何路径零写入；开启时行为正常\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

/** 空候选快照（设计 §4.5）：本文件 fixture 无外部契约，照 delivery-gate-v6 测试同款落空候选
 * 快照文件，供 acceptance.json 的 externalContractReview.detectionSha256 绑定（该键 V6 新任务必填）。 */
function writeEmptyCandidateSnapshot(fx, acceptanceVersion) {
  const dir = join(fx.taskDir, "evidence", `acceptance-v${acceptanceVersion}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }, null, 2)}\n`);
  return sha256(readFileSync(path, "utf8"));
}

/** schema 2 最小验收包（含断言与反例场景）——形态同 delivery-core-v5.test.mjs 夹具 */
function writeSchema2Package(fx) {
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
    ],
    adversarialForms: [
      { id: "AF1", assertionId: "A1", qualifier: "关闭", entryPoint: "auto", initialState: "开启", operation: "关闭后写入", timing: "命令期", expected: "不写", testAssetRefs: ["test-A1"], rationale: "入口" },
    ],
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["smoke"],
    // delivery-gate 新检查（§5.1 检查 2）：V6 世代新任务 externalContractReview 键必填，空处置表合法
    externalContractReview: { detectionSha256: writeEmptyCandidateSnapshot(fx, 1), dispositions: [] },
  }, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "开关", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
}

function gate(fx, ...args) {
  return runGate(args, fx.home);
}
async function core(fx, ...args) {
  return runCore(args);
}
function evidence(fx, name) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, `# ${name}\n`);
  return `evidence/${name}`;
}

/** 推进到「已批准 + 已确认方案」——review/approve/design 三连（同 delivery-core-v5 夹具） */
function driveToImplementing(t) {
  const fx = makeFixture(t);
  writeSchema2Package(fx);
  ok(gate(fx, "validate-acceptance", "--task-dir", fx.taskDir), "验收包应合法");
  ok(gate(fx, "snapshot-policy", "--task-dir", fx.taskDir));
  evidence(fx, "acceptance-review-v1.md");
  ok(gate(fx, "record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance));
  ok(gate(fx, "approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user));
  const manifest = evidence(fx, "solution.md");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, manifest), "utf8")) }])}\n`);
  ok(gate(fx, "record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user));
  return fx;
}

/** 登记探索 + 证据 + full 保证（首次完整取证三连），返回各事件 */
function driveFullAssurance(fx) {
  const explorationArtifact = evidence(fx, "exploration-1.md");
  ok(gate(fx, "record-exploration", "--task-dir", fx.taskDir,
    "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", explorationArtifact,
    "--credential", fx.creds.assurance), "探索登记");
  const records = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const explorationId = records.filter((e) => e.type === "ExplorationCompleted").at(-1).eventId;
  const evidenceArtifact = evidence(fx, "ev-1.md");
  const evidenceAppend = gate(fx, "record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified", "--summary", "取证",
    "--artifact", evidenceArtifact,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--credential", fx.creds.assurance);
  ok(evidenceAppend, "证据登记");
  const evidenceEvent = JSON.parse(parseStdout(evidenceAppend));
  const artifact = evidence(fx, "assurance-1.md");
  const assuranceAppend = gate(fx, "complete-assurance", "--task-dir", fx.taskDir,
    "--mode", "full",
    "--summary", "首次完整保证",
    "--evidence-event-ids", JSON.stringify([evidenceEvent.eventId]),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--clean-build", JSON.stringify({ buildId: "build-1", artifactSha256: sha256("clean") }),
    "--artifact", artifact,
    "--credential", fx.creds.assurance);
  ok(assuranceAppend, "full 保证登记");
  const assuranceEvent = JSON.parse(parseStdout(assuranceAppend));
  return { explorationId, evidenceEvent, assuranceEvent };
}

/** 在既有探索/证据之上登记 recheck（定向复核 + 全量确定性回执） */
function appendRecheck(fx, { explorationId, evidenceEvent }) {
  const artifact = evidence(fx, "recheck-1.md");
  const recheckAppend = gate(fx, "complete-assurance", "--task-dir", fx.taskDir,
    "--mode", "recheck",
    "--summary", "修复后定向复核",
    "--evidence-event-ids", JSON.stringify([evidenceEvent.eventId]),
    "--coverage-manifest-sha256", sha256("cov-recheck"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("recheck-log"), cwd: fx.projectDir, artifactSha256: sha256("recheck-receipt") }]),
    "--clean-build", JSON.stringify({ buildId: "build-recheck", artifactSha256: sha256("recheck-clean") }),
    "--artifact", artifact,
    "--credential", fx.creds.assurance);
  ok(recheckAppend, "recheck 保证登记");
  return JSON.parse(parseStdout(recheckAppend));
}

// ── 纯函数层（不经 CLI，直接对拍库导出）──

test("priorFullQualification 纯函数：beforeSeq 只判早于参照 seq 的 full", async () => {
  const full = (seq) => ({
    type: "AssuranceCompleted", mode: "full", eventId: `A-${seq}`, seq,
    incrementReceipts: [{ incrementId: "I1" }], evidenceEventIds: ["E-1"], explorationEventId: "X-1",
  });
  const input = {
    assurances: [full(5), full(9)],
    evidence: [{ eventId: "E-1" }],
    explorations: [{ eventId: "X-1" }],
  };
  const ctx = { incrementIds: ["I1"], usesAssertions: true };
  assert.equal(KERNEL.priorFullQualification(input, ctx).qualified, true, "缺省判全部时存在合格 full");
  const before = KERNEL.priorFullQualification(input, { ...ctx, beforeSeq: 6 });
  assert.equal(before.qualified, true);
  assert.deepEqual(before.qualifiedEventIds, ["A-5"], "beforeSeq=6 只取 seq<6 的 full");
  const none = KERNEL.priorFullQualification(input, { ...ctx, beforeSeq: 5 });
  assert.equal(none.qualified, false, "beforeSeq=5 无早于参照的 full");
  assert.deepEqual(none.inspections, [], "无候选 full 时 inspections 为空");
});

test("priorFullQualification 纯函数：逐条不合格原因（回执缺口 / 证据不可解析 / 探索引用缺失）", async () => {
  const bad = {
    assurances: [{
      type: "AssuranceCompleted", mode: "full", eventId: "A-bad", seq: 3,
      incrementReceipts: [], evidenceEventIds: ["E-missing", "none"], explorationEventId: "X-none",
    }],
    evidence: [{ eventId: "E-1" }],
    explorations: [],
  };
  const result = KERNEL.priorFullQualification(bad, { incrementIds: ["I1", "I2"], usesAssertions: true, exploratoryReviewRequired: false });
  assert.equal(result.qualified, false);
  const reasons = result.inspections[0].reasons.join("；");
  assert.match(reasons, /I1/, "原因应列出未覆盖的增量");
  assert.match(reasons, /I2/, "原因应列出未覆盖的增量");
  assert.match(reasons, /E-missing/, "原因应指向不可解析的证据事件（none 豁免不列）");
  assert.match(reasons, /X-none/, "原因应指向缺失的探索引用");
});

// ── CLI 层（真实任务夹具端到端）──

test("full-qualification：合格 prior full → qualified=true", async (t) => {
  const fx = driveToImplementing(t);
  const { assuranceEvent } = driveFullAssurance(fx);
  const result = JSON.parse(parseStdout(await core(fx, "full-qualification", "--task-dir", fx.taskDir)));
  assert.equal(result.taskDir, fx.taskDir);
  assert.equal(result.acceptanceVersion, 1);
  assert.equal(result.qualified, true, "回执覆盖全部增量 + 证据可解析 + 探索引用存在 → 合格");
  assert.deepEqual(result.qualifiedEventIds, [assuranceEvent.eventId]);
  assert.equal(result.inspections.length, 1);
  assert.deepEqual(result.inspections[0].reasons, []);
});

test("full-qualification：证据工件被篡改 → qualified=false 且原因指向该证据事件", async (t) => {
  const fx = driveToImplementing(t);
  const { evidenceEvent } = driveFullAssurance(fx);
  // 篡改 full 引用的证据工件内容（磁盘哈希 ≠ 事件绑定哈希）——gate 同款折算把失效证据
  // 滤出证据集合，引用它的 full 随之不可解析（旧 workflow 本地副本只查存在性，此处放行）
  writeFileSync(join(fx.taskDir, "evidence", "ev-1.md"), "# 被篡改的内容\n");
  const result = JSON.parse(parseStdout(await core(fx, "full-qualification", "--task-dir", fx.taskDir)));
  assert.equal(result.qualified, false, "引用失效证据的 full 不能给 recheck 背书");
  assert.deepEqual(result.qualifiedEventIds, []);
  assert.equal(result.inspections.length, 1, "full 保证事件自身工件完好，仍入 inspections");
  assert.ok(
    result.inspections[0].reasons.some((reason) => reason.includes(evidenceEvent.eventId)),
    `原因应指向失效证据事件 ${evidenceEvent.eventId}，实际：${JSON.stringify(result.inspections[0].reasons)}`,
  );
});

test("full-qualification：无任何 full 保证 → qualified=false", async (t) => {
  const fx = driveToImplementing(t);
  const result = JSON.parse(parseStdout(await core(fx, "full-qualification", "--task-dir", fx.taskDir)));
  assert.equal(result.qualified, false);
  assert.deepEqual(result.qualifiedEventIds, []);
  assert.deepEqual(result.inspections, []);
});

test("full-qualification：与 gate evaluate 同口径——无合格 full 的 recheck 触发 assuranceFullFirst", async (t) => {
  const fx = driveToImplementing(t);
  // 场景 A：只登记探索 + 证据，直接以 recheck 收尾（无先前 full）
  const explorationArtifact = evidence(fx, "exploration-1.md");
  ok(gate(fx, "record-exploration", "--task-dir", fx.taskDir,
    "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", explorationArtifact,
    "--credential", fx.creds.assurance), "探索登记");
  const records = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const explorationId = records.filter((e) => e.type === "ExplorationCompleted").at(-1).eventId;
  const evidenceArtifact = evidence(fx, "ev-1.md");
  const evidenceAppend = gate(fx, "record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified", "--summary", "取证",
    "--artifact", evidenceArtifact,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--credential", fx.creds.assurance);
  ok(evidenceAppend, "证据登记");
  appendRecheck(fx, { explorationId, evidenceEvent: JSON.parse(parseStdout(evidenceAppend)) });
  const verdict = JSON.parse(parseStdout(gate(fx, "evaluate", "--task-dir", fx.taskDir)));
  assert.ok(verdict.missing.assuranceFullFirst, "基础校验通过的 recheck 在无先前 full 时触发 full-first 判定");
  const qual = JSON.parse(parseStdout(await core(fx, "full-qualification", "--task-dir", fx.taskDir)));
  assert.equal(qual.qualified, false, "core 子命令同口径判不合格");
});

test("full-qualification：有合格 prior full 的 recheck 两侧均通过", async (t) => {
  const fx = driveToImplementing(t);
  const { explorationId, evidenceEvent } = driveFullAssurance(fx);
  appendRecheck(fx, { explorationId, evidenceEvent });
  const verdict = JSON.parse(parseStdout(gate(fx, "evaluate", "--task-dir", fx.taskDir)));
  assert.equal(verdict.missing.assuranceFullFirst ?? null, null, "合格 prior full 使 recheck 不触发 full-first 判定");
  const qual = JSON.parse(parseStdout(await core(fx, "full-qualification", "--task-dir", fx.taskDir)));
  assert.equal(qual.qualified, true, "core 子命令同口径判合格");
});
