// revision-provenance-v6.test.mjs — revision 来源对账回归（设计《V5 交付完整性与语义可信性改造》机制三 §7.2）
//
// 覆盖：
//   1. 纯函数 deriveRevisionProvenance：来源派生（implementation / candidate-repair /
//      assurance-repair / environment / external-baseline）、断链 unknown、尾部漂移 unknown、
//      无锚点不启用、drift 事件不充当来源
//   2. CLI revision-provenance 子命令（真实任务目录）：来源清单与 unknownCount
//   3. 正常全登记任务不误伤：schema 2 全链路 evaluate 保持 accepted，missing.revisionProvenance 为空
//   4. 手工直改产生 unknown：候选受验树被直改后 evaluate 不得 accepted，恢复动作三选一可读
//   5. 用户确认外部基线（既有 confirm-baseline 命令）接链：unknown 区间消除
//
// 设计 §12 阶段 1 的「只读回放 GLM/STEPFUN 历史任务」在本仓无对应任务目录，
// 以测试构造的「正常全登记 / 手工直改」两类任务替代验证误伤与阻断；历史任务回放
// 登记为待实跑项（见交付报告）。
//
// 运行：node --test scripts/tests/revision-provenance-v6.test.mjs

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

const rec = (overrides) => ({ seq: 0, eventId: "E", actor: "builder", recordedAt: "T", ...overrides });

test("deriveRevisionProvenance：implementation / candidate-repair / assurance-repair / environment 来源派生", () => {
  const records = [
    rec({ seq: 1, type: "AcceptanceApproved", revision: "r0" }),
    // 候选修复（首个保证之前）
    rec({ seq: 2, type: "RepairRoundRecorded", actor: "builder", fromRevision: "r0", toRevision: "r1", round: 1 }),
    // 实现（mergeReceipt 回执）
    rec({ seq: 3, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r1", toRevision: "r2" } }),
    rec({ seq: 4, type: "AssuranceCompleted", revision: "r2" }),
    // 保证修复（首个保证之后）与环境重试
    rec({ seq: 5, type: "RepairRoundRecorded", fromRevision: "r2", toRevision: "r3", round: 2 }),
    rec({ seq: 6, type: "RepairRoundRecorded", fromRevision: "r3", toRevision: "r4", round: 2, nature: "environment" }),
  ];
  const result = KERNEL.deriveRevisionProvenance(records, { currentRevision: "r4" });
  assert.equal(result.enabled, true);
  assert.equal(result.unknownCount, 0, "全登记链条无 unknown");
  assert.deepEqual(result.revisions.map((item) => item.source), ["candidate-repair", "implementation", "assurance-repair", "environment"], "修复轮按首个保证事件前后分候选/保证修复，environment nature 归环境采集");
  assert.equal(result.explainedRevision, "r4");
  assert.equal(result.revisions.every((item) => typeof item.eventRef === "string" && typeof item.actor === "string"), true, "来源条目带事件归因");
});

test("deriveRevisionProvenance：尾部漂移与断链记 unknown；无锚点不启用；drift 不充当来源", () => {
  // 尾部漂移：链条解释到 r2，当前 revision 是手工直改后的 rX
  const tail = KERNEL.deriveRevisionProvenance(
    [rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r2" } })],
    { currentRevision: "rX" },
  );
  assert.equal(tail.unknownCount, 1);
  assert.deepEqual(tail.revisions.at(-1), { fromRevision: "r2", toRevision: "rX", source: "unknown", eventRef: null, actor: null, recordedAt: null }, "尾部缺口 eventRef 为空（无事件可归因）");
  // 断链：实现回执声称从 r5 续接，但链条当前在 r2——中间存在无来源变化
  const broken = KERNEL.deriveRevisionProvenance([
    rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r2" } }),
    rec({ seq: 2, type: "RepairRoundRecorded", fromRevision: "r5", toRevision: "r6", round: 1 }),
  ], { currentRevision: "r6" });
  assert.equal(broken.unknownCount, 1);
  assert.deepEqual({ from: broken.revisions[1].fromRevision, to: broken.revisions[1].toRevision }, { from: "r2", to: "r5" }, "断链区间按 unknown 记录（unknown 排在首锚 change 之后）");
  assert.equal(broken.revisions[2].source, "candidate-repair", "无保证事件时修复轮归候选修复（首保证前）");
  // 无锚点（无实现/修复/基线确认）：候选未形成，不对账（验收起草期变化不判）
  const dormant = KERNEL.deriveRevisionProvenance(
    [rec({ seq: 1, type: "ExplorationCompleted", revision: "r0" })],
    { currentRevision: "rOther" },
  );
  assert.equal(dormant.enabled, false);
  assert.equal(dormant.unknownCount, 0);
  // AssuranceRevisionDrift 只登记漂移现象，不充当合法来源（否则会把无来源改动洗成已解释）
  const withDrift = KERNEL.deriveRevisionProvenance([
    rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r1" } }),
    rec({ seq: 2, type: "AssuranceRevisionDrift", setupRevision: "r1", finalizeRevision: "r9", driftSeq: 1 }),
  ], { currentRevision: "r9" });
  assert.equal(withDrift.unknownCount, 1, "drift 不能解释 r1→r9 的变化，仍为 unknown");
});

test("deriveRevisionProvenance：用户确认外部基线（RevisionBaselineConfirmed）接链消除 unknown", () => {
  const records = [
    rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r1" } }),
    // 外部进程改写后用户确认新基线：confirmedRevision 就是当时 explained 的下一站
    rec({ seq: 2, type: "RevisionBaselineConfirmed", actor: "user", confirmedRevision: "rBase" }),
    // 之后修复从新基线续接
    rec({ seq: 3, type: "RepairRoundRecorded", fromRevision: "rBase", toRevision: "r2", round: 1 }),
  ];
  const result = KERNEL.deriveRevisionProvenance(records, { currentRevision: "r2" });
  assert.equal(result.unknownCount, 0, "外部基线确认使链条接续，无 unknown");
  assert.deepEqual(result.revisions.map((item) => item.source), ["implementation", "external-baseline", "candidate-repair"]);
});

test("deriveRevisionProvenance：缺 from 的修复轮不把未登记直改洗成已解释（洗白通道封堵）", () => {
  // 探针场景：实现 r0→r2 后项目树被直改到 r5（无任何事件），随后补一条只带 to=r5、
  // 不带 fromRevision 的修复轮——修复轮未声称从 r2 续接，r2→r5 之间的变化无基线确认
  const records = [
    rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r2" } }),
    rec({ seq: 2, type: "RepairRoundRecorded", toRevision: "r5", round: 1 }),
  ];
  const result = KERNEL.deriveRevisionProvenance(records, { currentRevision: "r5" });
  assert.equal(result.explainedRevision, "r5");
  assert.ok(result.unknownCount >= 1, "缺 from 的修复轮无法确认修复前基线，区间记 unknown");
  const unknown = result.revisions.find((item) => item.source === "unknown");
  assert.deepEqual(
    { from: unknown.fromRevision, to: unknown.toRevision },
    { from: "r2", to: "r5" },
    "unknown 区间从链条已解释位指向该修复轮的 to",
  );
  assert.equal(
    result.revisions.some((item) => item.toRevision === "r5" && item.source === "candidate-repair"),
    false,
    "缺 from 的修复轮不得按 candidate-repair 正常分类（否则直改被洗白）",
  );
});

test("deriveRevisionProvenance：unknown 存在后再登记 AssuranceCompleted 不消除 unknown", () => {
  const records = [
    rec({ seq: 1, type: "ImplementationRecorded", mergeReceipt: { fromRevision: "r0", toRevision: "r2" } }),
    rec({ seq: 2, type: "RepairRoundRecorded", toRevision: "r5", round: 1 }),
    // 后续保证：AssuranceCompleted 不在来源锚点事件词表内，不产来源记录
    rec({ seq: 3, type: "AssuranceCompleted", revision: "r5" }),
  ];
  const result = KERNEL.deriveRevisionProvenance(records, { currentRevision: "r5" });
  assert.equal(result.unknownCount, 1, "unknown 不因后续保证完成被洗白（设计 §7.2：不得用下一次 AssuranceCompleted 变成正常历史）");
  assert.equal(result.revisions.some((item) => item.source === "unknown" && item.toRevision === "r5"), true);
});

// ── 2-5. 真实任务目录端到端 ──

function makeFixture(t, { taskId = "rev-prov" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rev-prov-v6-"));
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
  writeFileSync(intentPath, "关闭后任何路径零写入；开启时行为正常\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

function revisionOf(fx) {
  const result = runGate(["revision", "--project-root", fx.projectDir], fx.home);
  ok(result, "revision 计算应成功");
  return result.stdout.trim();
}

function evidenceFile(fx, name, content) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, content ?? `# ${name}\n`);
  return `evidence/${name}`;
}

/** 推进到「已批准 + 方案确认」并完成一轮真实实现（链条 r0→r1：项目树真实前进一次提交），
 * 返回 {revisionA, revisionB}。 */
function driveToImplemented(t) {
  const fx = makeFixture(t);
  const revisionA = revisionOf(fx);
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
  }, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "开关", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  evidenceFile(fx, "acceptance-review-v1.md");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const solution = evidenceFile(fx, "solution.md");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, solution), "utf8")) }])}\n`);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  // 真实实现：项目树前进一次提交（builder 写文件 + commit），mergeReceipt 记录 r0→r1
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "impl I1"], { cwd: fx.projectDir });
  const revisionB = revisionOf(fx);
  assert.notEqual(revisionA, revisionB, "实现提交应前进 revision");
  // 候选探索（实现登记前置：schema 2 反例审查绑定当前 revision——先提交后探索）
  ok(runGate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", evidenceFile(fx, "explore.md"), "--revision", revisionB,
    "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", evidenceFile(fx, "impl-I1.md"), "--merge-receipt", JSON.stringify({ fromRevision: revisionA, toRevision: revisionB, patchSha256: sha256("patch") }),
    "--revision", revisionB, "--credential", fx.creds.builder], fx.home), "实现登记");
  return { fx, revisionA, revisionB };
}

/** 在 revisionB 上补齐证据 + full 保证（accepted 所需的其余事件）。 */
function driveAssurance(fx, revisionB) {
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const explorationId = events.find((entry) => entry.type === "ExplorationCompleted").eventId;
  const evidenceIds = [];
  for (const kind of ["command", "inspection"]) {
    const append = runGate(["record-evidence", "--task-dir", fx.taskDir,
      "--requirement-id", "R1", "--kind", kind, "--result", "verified", "--summary", `取证 ${kind}`,
      "--artifact", evidenceFile(fx, `ev-${kind}.md`), "--revision", revisionB,
      "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
      "--credential", fx.creds.assurance], fx.home);
    ok(append, `证据 ${kind} 登记`);
    evidenceIds.push(JSON.parse(parseStdout(append)).eventId);
  }
  const receipt = JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]);
  ok(runGate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify(evidenceIds),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", receipt, "--clean-build", JSON.stringify({ buildId: "b1", artifactSha256: sha256("clean") }),
    "--artifact", evidenceFile(fx, "assurance-full.md"), "--revision", revisionB,
    "--credential", fx.creds.assurance], fx.home), "full 保证登记");
}

test("revision-provenance 子命令：来源清单与 unknownCount（真实任务目录）", (t) => {
  const { fx, revisionA, revisionB } = driveToImplemented(t);
  const provenance = JSON.parse(parseStdout(runCore(["revision-provenance", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(provenance.taskDir, fx.taskDir);
  assert.equal(provenance.enabled, true, "存在实现锚点，对账启用");
  assert.equal(provenance.unknownCount, 0, "全登记任务无 unknown");
  assert.equal(provenance.explainedRevision, revisionB);
  const implRow = provenance.revisions.find((item) => item.source === "implementation");
  assert.deepEqual({ from: implRow.fromRevision, to: implRow.toRevision }, { from: revisionA, to: revisionB }, "implementation 来源取 mergeReceipt 回执");
  assert.equal(typeof implRow.eventRef, "string", "来源条目可归因到事件 id");
});

test("正常全登记任务不误伤：evaluate 保持 accepted，missing.revisionProvenance 为空", (t) => {
  const { fx, revisionB } = driveToImplemented(t);
  driveAssurance(fx, revisionB);
  const verdict = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(verdict.state, "accepted", "schema 2 全登记任务应 accepted（来源对账不误伤正常路径）");
  assert.equal(verdict.missing.revisionProvenance ?? null, null, "无 unknown 时缺口为空");
});

test("手工直改产生 unknown：evaluate 阻断交付终态并给出三选一恢复动作", (t) => {
  const { fx, revisionB } = driveToImplemented(t);
  driveAssurance(fx, revisionB);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home), "直改前应 accepted");
  // 模拟主会话裸改 / 外部进程写入：项目树前进一次未登记提交
  writeFileSync(join(fx.projectDir, "a.txt"), "tampered\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "off-loop edit"], { cwd: fx.projectDir });
  const tamperedRevision = revisionOf(fx);
  const verdict = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.notEqual(verdict.state, "accepted", "存在来源不明的 revision 变化不得 accepted");
  assert.notEqual(verdict.state, "accepted_with_risk", "来源不明同样阻断风险接受终态（豁免只适用既有规则允许的事项）");
  assert.equal(verdict.missing.revisionProvenance.unknownCount, 1);
  assert.deepEqual(verdict.missing.revisionProvenance.unknowns[0], {
    fromRevision: revisionB,
    toRevision: tamperedRevision,
    source: "unknown",
    eventRef: null,
    actor: null,
    recordedAt: null,
  }, "unknown 区间从已解释基线指向直改后 revision");
  assert.match(verdict.missing.revisionProvenance.recovery, /record-repair-round/, "恢复动作一：补做合法修复登记");
  assert.match(verdict.missing.revisionProvenance.recovery, /confirm-baseline/, "恢复动作三：用户确认外部基线");
  const provenance = JSON.parse(parseStdout(runCore(["revision-provenance", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(provenance.unknownCount, 1, "core 子命令与 gate 同口径");
  assert.equal(provenance.explainedRevision, revisionB);
});

test("用户确认外部基线（confirm-baseline）接链：unknown 区间消除", (t) => {
  const { fx, revisionB } = driveToImplemented(t);
  driveAssurance(fx, revisionB);
  writeFileSync(join(fx.projectDir, "a.txt"), "external change\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "external baseline"], { cwd: fx.projectDir });
  const newBaseline = revisionOf(fx);
  const before = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(before.missing.revisionProvenance.unknownCount, 1, "确认前存在 unknown");
  ok(runGate(["confirm-baseline", "--task-dir", fx.taskDir, "--reason", "外部合法基线前进（依赖升级提交）", "--credential", fx.creds.user], fx.home), "用户确认外部基线");
  const after = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(after.missing.revisionProvenance ?? null, null, "确认后 unknown 消除（external-baseline 接链）");
  const provenance = JSON.parse(parseStdout(runCore(["revision-provenance", "--task-dir", fx.taskDir], fx.home)));
  assert.deepEqual(provenance.revisions.map((item) => item.source), ["implementation", "external-baseline"]);
});
