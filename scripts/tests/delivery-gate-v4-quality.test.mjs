// V4 断言级裁决、recheck 历史探索引用与有限修复测试。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v4", "scripts", "delivery-gate.mjs");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));

function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function ok(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function rejected(result) {
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /恢复动作：/);
}
function evidenceFile(fx, name, content = `# ${name}\n`) {
  const path = join(fx.taskDir, "evidence", name);
  writeFileSync(path, content);
  return { artifact: `evidence/${name}`, artifactSha256: sha256(readFileSync(path, "utf8")) };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "delivery-v4-quality-"));
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
  const init = runGate(["init", "--project-root", projectDir, "--task-id", "v4-quality", "--intent-file", intentPath], home);
  ok(init);
  const output = JSON.parse(parseStdout(init));
  const fx = { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
  writeJson(join(fx.taskDir, "acceptance.json"), {
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: "v4-quality",
    projectRoot: realpathSync(projectDir),
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
  return fx;
}

function append(fx, event, role) {
  return runGate(["append", "--task-dir", fx.taskDir, "--event", JSON.stringify(event), "--credential", fx.creds[role]], fx.home);
}
function revision(fx) {
  const result = runGate(["revision", "--project-root", fx.projectDir], fx.home);
  ok(result);
  return result.stdout.trim();
}
function evaluate(fx) {
  const result = runGate(["evaluate", "--task-dir", fx.taskDir], fx.home);
  ok(result);
  return JSON.parse(parseStdout(result));
}
function driveToAssurance(fx) {
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  evidenceFile(fx, "acceptance-review-v1.md");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const manifest = evidenceFile(fx, "solution.md");
  writeJson(join(fx.taskDir, "evidence", "package.json"), [{ name: "solution.md", sha256: manifest.artifactSha256 }]);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  const rev = revision(fx);
  fx.explorationEventId = explore(fx, rev);
  const artifact = evidenceFile(fx, "implementation.md");
  ok(append(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
    summary: "实现", incrementId: "I1", artifact: artifact.artifact,
    mergeReceipt: { fromRevision: rev, toRevision: rev, patchSha256: sha256("patch") },
  }, "builder"));
  return rev;
}
function appendEvidence(fx, rev, assertionId, kind, formId) {
  const requirementId = assertionId === "A3" ? "R2" : "R1";
  const artifact = evidenceFile(fx, `${assertionId}-${kind}.md`);
  ok(append(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: `${assertionId}/${kind}`, requirementId, kind, result: "verified",
    assertionIds: [assertionId], adversarialFormIds: [formId], artifact: artifact.artifact, artifactSha256: artifact.artifactSha256,
  }, "assurance"));
}
function appendAllEvidence(fx, rev) {
  appendEvidence(fx, rev, "A1", "command", "AF1");
  appendEvidence(fx, rev, "A1", "inspection", "AF1");
  appendEvidence(fx, rev, "A2", "command", "AF2");
  appendEvidence(fx, rev, "A2", "inspection", "AF2");
  appendEvidence(fx, rev, "A3", "command", "AF3");
}
function completeAssurance(fx, rev, mode, explorationEventId) {
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const evidenceEventIds = events.filter((event) => event.type === "EvidenceRecorded" && event.revision === rev).map((event) => event.eventId);
  const receipt = evidenceFile(fx, `receipt-${mode}.md`);
  const final = evidenceFile(fx, `assurance-${mode}.md`);
  ok(append(fx, {
    type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 1, revision: rev, mode,
    summary: `${mode} 完成`, evidenceEventIds, coverageManifestSha256: receipt.artifactSha256,
    explorationEventId,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("ok"), cwd: fx.projectDir, artifactSha256: receipt.artifactSha256 }],
    cleanBuild: null, artifact: final.artifact,
  }, "assurance"));
}
function explore(fx, rev) {
  const artifact = evidenceFile(fx, "exploration.md");
  const result = append(fx, {
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "探索", dimensions: ["smoke"], coverageManifestSha256: artifact.artifactSha256, artifact: artifact.artifact,
  }, "assurance");
  ok(result);
  return JSON.parse(parseStdout(result)).eventId;
}
function raise(fx, rev, id, { reopenOf, severity = "blocker", consequenceRefutation } = {}) {
  const artifact = evidenceFile(fx, `finding-${id}.md`);
  const event = {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: id, findingId: id, category: "defect", severity, requirementIds: ["R1"], artifact: artifact.artifact,
  };
  if (reopenOf) event.reopenOf = reopenOf;
  if (consequenceRefutation) event.consequenceRefutation = consequenceRefutation;
  return append(fx, event, "assurance");
}

test("schema 2 必须逐断言取证；recheck 可引用历史探索且不重新开放探索", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  const explorationEventId = fx.explorationEventId;
  appendEvidence(fx, rev, "A1", "command", "AF1");
  appendEvidence(fx, rev, "A1", "inspection", "AF1");
  appendEvidence(fx, rev, "A3", "command", "AF3");
  completeAssurance(fx, rev, "full", explorationEventId);
  let verdict = evaluate(fx);
  assert.equal(verdict.state, "candidate");
  assert.equal(verdict.missing.assertions.length, 2, "A2 两种证据都缺");
  appendEvidence(fx, rev, "A2", "command", "AF2");
  appendEvidence(fx, rev, "A2", "inspection", "AF2");
  completeAssurance(fx, rev, "full", explorationEventId);
  verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted");

  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "a.txt"], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "change"], { cwd: fx.projectDir });
  const nextRevision = revision(fx);
  assert.notEqual(nextRevision, rev);
  appendAllEvidence(fx, nextRevision);
  completeAssurance(fx, nextRevision, "recheck", explorationEventId);
  verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "recheck 引用同验收版本历史探索即可");
  assert.equal(readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter((line) => line.includes("ExplorationCompleted")).length, 1, "不得新增开放探索事件");
});

test("不同 must-fix 超过 10 条进入 process-failed；reopenOf 不重复计数", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  for (let index = 1; index <= 10; index += 1) ok(raise(fx, rev, `F-B${index}`));
  assert.equal(evaluate(fx).quality.uniqueMustFix, 10);
  ok(raise(fx, rev, "F-B11", { reopenOf: "F-B1" }));
  assert.equal(evaluate(fx).quality.uniqueMustFix, 10);
  ok(raise(fx, rev, "F-B12"));
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "process-failed");
  assert.equal(verdict.quality.uniqueMustFix, 11);
});

test("第四轮实现性修复进入 process-failed", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  ok(raise(fx, rev, "F-R1"));
  for (let round = 1; round <= 4; round += 1) {
    const artifact = evidenceFile(fx, `repair-${round}.md`);
    ok(append(fx, {
      type: "RepairRoundRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
      summary: `第 ${round} 轮`, round, triggerFindingIds: ["F-R1"], affectedAssertionIds: ["A1"], artifact: artifact.artifact,
    }, "builder"));
  }
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "process-failed");
  assert.equal(verdict.quality.repairRounds, 4);
});

test("schema 2 非 blocker 必须给行为后果否决论证", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  rejected(raise(fx, rev, "F-S1", { severity: "non-blocker" }));
  ok(raise(fx, rev, "F-S1", { severity: "non-blocker", consequenceRefutation: "该行为用户不可观察：仅内部计数变化，无消息流与存储变化" }));
});

test("recheck 不能替代首次 full（full-first 门禁）", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  // 绕过形态：explore-only 产生历史探索后直接 recheck 取证，全程无 full
  const explorationEventId = explore(fx, rev);
  appendAllEvidence(fx, rev);
  completeAssurance(fx, rev, "recheck", explorationEventId);
  let verdict = evaluate(fx);
  assert.equal(verdict.state, "candidate", "无先前 full 时 recheck 不构成有效保证");
  assert.ok(verdict.missing.assuranceCompleted, "保证完成应缺失");
  assert.ok(verdict.missing.assuranceFullFirst !== null, "应披露 full-first 缺口与恢复动作");
  assert.ok(verdict.missing.assuranceFullFirst.note.includes("full"), "恢复动作应指向先跑 full");
  // 补 full 后 accepted：后补 full 自身成为当前 revision 的有效保证（时点序上它无法
  // 追溯背书先前的 recheck——hasPriorValidFull 要求 full.seq < recheck.seq）
  completeAssurance(fx, rev, "full", explorationEventId);
  verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "补 full 后由 full 自身承重，整体可达 accepted");
});

test("循环外实现性修复呈报：revision 无登记通道前进时披露，登记修复轮后消除", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  ok(raise(fx, rev, "F-O1"));
  appendAllEvidence(fx, rev);
  completeAssurance(fx, rev, "full", fx.explorationEventId);
  // 旁路形态：直接 commit 改实现——无 RepairRoundRecorded / 无新增实现登记 / 无漂移登记
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "a.txt"], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "bypass"], { cwd: fx.projectDir });
  const nextRevision = revision(fx);
  assert.notEqual(nextRevision, rev);
  let verdict = evaluate(fx);
  assert.ok(verdict.quality.offLoopRepair !== null, "应显式呈报疑似循环外修复");
  assert.equal(verdict.quality.offLoopRepair.lastAssuranceRevision, rev);
  assert.equal(verdict.quality.offLoopRepair.currentRevision, nextRevision);
  // 走受控通道补登记修复轮后呈报消除
  const artifact = evidenceFile(fx, "repair-1.md");
  ok(append(fx, {
    type: "RepairRoundRecorded", actor: "builder", acceptanceVersion: 1, revision: nextRevision,
    summary: "第 1 轮实现性修复", round: 1, triggerFindingIds: ["F-O1"], affectedAssertionIds: ["A1"],
    fromRevision: rev, toRevision: nextRevision, artifact: artifact.artifact,
  }, "builder"));
  verdict = evaluate(fx);
  assert.equal(verdict.quality.offLoopRepair, null, "登记修复轮后不再呈报");
});

test("限定条件缺反例场景时验收校验拒绝", (t) => {
  const fx = fixture(t);
  const acceptance = readJson(join(fx.taskDir, "acceptance.json"));
  acceptance.requirements[0].assertions[0].qualifiers.push("并发期间");
  writeJson(join(fx.taskDir, "acceptance.json"), acceptance);
  const result = runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home);
  rejected(result);
  assert.match(result.stderr, /限定条件/);
});
