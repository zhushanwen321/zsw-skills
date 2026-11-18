// V4 断言级裁决、recheck 历史探索引用与有限修复测试。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMjsScript } from "../helpers/mjs-runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v4", "scripts", "delivery-gate.mjs");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));

// 门进程内执行：v4 gate 为同步脚本、失败路径走整包 catch + process.exitCode 赋值，
// runner 的 exitCode 桩语义覆盖（无失真区）；git 内部 spawn（revision 计算）走真实 spawnSync。
function runGate(args, home) {
  return runMjsScript(GATE, args, { env: { HOME: home } });
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

// 模板仓：每测试进程只构建一次「初始提交仓」，fixture 经 cpSync 复制实例化——git 对象是
// 内容寻址的只读数据，复制保真（实测复制仓 commit/rev-parse 与全新 init 仓行为一致），
// 省掉每 fixture 的 init/add/commit 三连 spawn（实测 27ms → 4ms）
let repoTemplateDir = null;
function materializeRepoTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-v4-quality-tpl-"));
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // repo 级身份经追加 .git/config 写入（后续 commit 依赖 repo config）
  appendFileSync(join(dir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "delivery-v4-quality-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(home);
  if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
  cpSync(repoTemplateDir, projectDir, { recursive: true });
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
function driveToApproval(fx, version = 1) {
  if (version === 1) {
    ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
    ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  } else {
    const acceptance = readJson(join(fx.taskDir, "acceptance.json"));
    acceptance.acceptanceVersion = version;
    writeJson(join(fx.taskDir, "acceptance.json"), acceptance);
    const increments = readJson(join(fx.taskDir, "increments.json"));
    increments.acceptanceVersion = version;
    writeJson(join(fx.taskDir, "increments.json"), increments);
    ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  }
  evidenceFile(fx, `acceptance-review-v${version}.md`);
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const manifest = evidenceFile(fx, "solution.md");
  writeJson(join(fx.taskDir, "evidence", "package.json"), [{ name: "solution.md", sha256: manifest.artifactSha256 }]);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  return revision(fx);
}
function driveToAssurance(fx) {
  const rev = driveToApproval(fx);
  fx.explorationEventId = explore(fx, rev);
  const artifact = evidenceFile(fx, "implementation.md");
  ok(append(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
    summary: "实现", incrementId: "I1", artifact: artifact.artifact,
    mergeReceipt: { fromRevision: rev, toRevision: rev, patchSha256: sha256("patch") },
  }, "builder"));
  return rev;
}
function appendEvidence(fx, rev, assertionId, kind, formId, version = 1) {
  const requirementId = assertionId === "A3" ? "R2" : "R1";
  const artifact = evidenceFile(fx, `${assertionId}-${kind}-v${version}.md`);
  ok(append(fx, {
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: version, revision: rev,
    summary: `${assertionId}/${kind}`, requirementId, kind, result: "verified",
    assertionIds: [assertionId], adversarialFormIds: [formId], artifact: artifact.artifact, artifactSha256: artifact.artifactSha256,
  }, "assurance"));
}
function appendAllEvidence(fx, rev, version = 1) {
  appendEvidence(fx, rev, "A1", "command", "AF1", version);
  appendEvidence(fx, rev, "A1", "inspection", "AF1", version);
  appendEvidence(fx, rev, "A2", "command", "AF2", version);
  appendEvidence(fx, rev, "A2", "inspection", "AF2", version);
  appendEvidence(fx, rev, "A3", "command", "AF3", version);
}
function completeAssurance(fx, rev, mode, explorationEventId, version = 1) {
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const evidenceEventIds = events.filter((event) => event.type === "EvidenceRecorded" && event.revision === rev && event.acceptanceVersion === version).map((event) => event.eventId);
  const receipt = evidenceFile(fx, `receipt-${mode}-v${version}.md`);
  const final = evidenceFile(fx, `assurance-${mode}-v${version}.md`);
  ok(append(fx, {
    type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: version, revision: rev, mode,
    summary: `${mode} 完成`, evidenceEventIds, coverageManifestSha256: receipt.artifactSha256,
    explorationEventId,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256(`ok-${mode}-${version}`), cwd: fx.projectDir, artifactSha256: receipt.artifactSha256 }],
    cleanBuild: null, artifact: final.artifact,
  }, "assurance"));
}
function explore(fx, rev, version = 1) {
  const artifact = evidenceFile(fx, `exploration-v${version}.md`);
  const result = append(fx, {
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: version, revision: rev,
    summary: "探索", dimensions: ["smoke"], coverageManifestSha256: artifact.artifactSha256, artifact: artifact.artifact,
  }, "assurance");
  ok(result);
  return JSON.parse(parseStdout(result)).eventId;
}
function repairRound(fx, rev, round, { nature, version = 1 } = {}) {
  const artifact = evidenceFile(fx, `repair-round-${round}.md`);
  const event = {
    type: "RepairRoundRecorded", actor: "builder", acceptanceVersion: version, revision: rev,
    summary: `第 ${round} 轮`, round, triggerFindingIds: ["F-A1"], affectedAssertionIds: ["A1"],
    fromRevision: rev, toRevision: rev,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256(`repair-log-${round}`), cwd: fx.projectDir, artifactSha256: artifact.artifactSha256 }],
    artifact: artifact.artifact,
  };
  if (nature) event.nature = nature;
  return append(fx, event, "builder");
}
function raise(fx, rev, id, { reopenOf, severity = "blocker", consequenceRefutation, origin, firstDetectedStage, expectedStage, regressionTestRef } = {}) {
  const artifact = evidenceFile(fx, `finding-${id}.md`);
  const event = {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: id, findingId: id, category: "defect", severity, requirementIds: ["R1"], artifact: artifact.artifact,
  };
  if (reopenOf) event.reopenOf = reopenOf;
  if (consequenceRefutation) {
    event.consequenceRefutation = consequenceRefutation;
    event.consequenceRefutationType = "not-observable";
  }
  if (origin) event.origin = origin;
  if (firstDetectedStage) event.firstDetectedStage = firstDetectedStage;
  if (expectedStage) event.expectedStage = expectedStage;
  if (regressionTestRef) event.regressionTestRef = regressionTestRef;
  return append(fx, event, "assurance");
}

test("防漂移锚：门进程内执行 == CLI spawn（同 fixture 双跑逐字节对拍）", (t) => {
  const fx = fixture(t);
  // validate-acceptance 只读：同一 task-dir 上两种执行形态结果必须逐字节一致
  const inProc = runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home);
  const cli = spawnSync(process.execPath, [GATE, "validate-acceptance", "--task-dir", fx.taskDir], {
    encoding: "utf8", env: { ...process.env, HOME: fx.home },
  });
  assert.equal(inProc.status, cli.status);
  assert.equal(inProc.stdout, cli.stdout);
  assert.equal(inProc.stderr, cli.stderr);
});

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

test("full 探索未 due 时不得以 none 登记：引用既有探索才构成有效保证（MF-1-20 死锁回归）", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  appendAllEvidence(fx, rev);
  // 探索未 due（探索晚于批准登记）：full 未派新探索时若以 "none" 登记，与裁决器
  // 「full 须引用既有探索」互斥——保证永无效，任务停 candidate 无可达终态
  completeAssurance(fx, rev, "full", "none");
  let verdict = evaluate(fx);
  assert.equal(verdict.state, "candidate", "full 未引用既有探索不构成有效保证");
  assert.equal(verdict.missing.assuranceCompleted, true, "缺口应呈报为 assuranceCompleted 缺失");
  // 对照组：同 fixture 唯一差异是 explorationEventId 改指既有探索事件
  completeAssurance(fx, rev, "full", fx.explorationEventId);
  verdict = evaluate(fx);
  assert.equal(verdict.state, "accepted", "full 引用既有探索即构成有效保证");
});

test("schema 2 recheck 不得以 none 登记：必须引用既有探索（合并稿 §6 定向复核依据）", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  appendAllEvidence(fx, rev);
  completeAssurance(fx, rev, "full", fx.explorationEventId);
  assert.equal(evaluate(fx).state, "accepted");
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "a.txt"], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "change"], { cwd: fx.projectDir });
  const nextRevision = revision(fx);
  appendAllEvidence(fx, nextRevision);
  completeAssurance(fx, nextRevision, "recheck", "none");
  const verdict = evaluate(fx);
  assert.equal(verdict.state, "candidate", "recheck 无探索引用不构成有效保证");
  assert.equal(verdict.missing.assuranceCompleted, true);
});

test("受控修复轮回执红路径：缺 incrementReceipts 或未覆盖全部增量即拒收", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  ok(raise(fx, rev, "F-RC1"));
  const artifact = evidenceFile(fx, "repair-rc.md");
  const base = {
    type: "RepairRoundRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
    summary: "受控修复轮", round: 1, triggerFindingIds: ["F-RC1"], affectedAssertionIds: ["A1"],
    fromRevision: rev, toRevision: rev, artifact: artifact.artifact,
  };
  // 缺回执字段：整个字段省略才走到受控轮检查——空数组会先被事件 shape 层拦下
  const noReceipts = append(fx, { ...base }, "builder");
  rejected(noReceipts);
  assert.match(noReceipts.stderr, /缺少 incrementReceipts/);
  // 回执只覆盖部分增量（fixture 追加第二增量 I2 后只交 I1 的回执）
  const increments = readJson(join(fx.taskDir, "increments.json"));
  increments.items.push({ id: "I2", title: "第二增量", requirementIds: ["R1", "R2"], testCommand: { program: "true", args: [] } });
  writeJson(join(fx.taskDir, "increments.json"), increments);
  const receipt = { incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("rc-log"), cwd: fx.projectDir, artifactSha256: artifact.artifactSha256 };
  const partial = append(fx, { ...base, incrementReceipts: [receipt] }, "builder");
  rejected(partial);
  assert.match(partial.stderr, /未覆盖全部增量（缺 I2）/);
});

test("第十条不同 must-fix 不触发失败（边界显式断言，防 >=10 回退）", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  for (let index = 1; index <= 10; index += 1) ok(raise(fx, rev, `F-C${index}`));
  const tenth = evaluate(fx);
  assert.equal(tenth.quality.uniqueMustFix, 10);
  assert.notEqual(tenth.state, "process-failed", "第十条不同 must-fix 不得触发过程失败（判定式为 >10）");
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
  // 走受控通道补登记修复轮后呈报消除（受控轮带 from/toRevision，须附全量回执）
  const artifact = evidenceFile(fx, "repair-1.md");
  ok(append(fx, {
    type: "RepairRoundRecorded", actor: "builder", acceptanceVersion: 1, revision: nextRevision,
    summary: "第 1 轮实现性修复", round: 1, triggerFindingIds: ["F-O1"], affectedAssertionIds: ["A1"],
    fromRevision: rev, toRevision: nextRevision,
    incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("ok"), cwd: fx.projectDir, artifactSha256: artifact.artifactSha256 }],
    artifact: artifact.artifact,
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

test("限定条件带不适用理由（qualifierNotApplicable）时豁免反例场景要求；空理由被拒", (t) => {
  const fx = fixture(t);
  const acceptance = readJson(join(fx.taskDir, "acceptance.json"));
  const assertion = acceptance.requirements[0].assertions[0];
  assertion.qualifiers.push("并发期间");
  assertion.qualifierNotApplicable = [{ qualifier: "并发期间", rationale: "本任务单线程执行，无并发入口" }];
  writeJson(join(fx.taskDir, "acceptance.json"), acceptance);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  // 空理由 / 未知限定条件 / 不在本断言 qualifiers 内 → 拒
  const emptyReason = readJson(join(fx.taskDir, "acceptance.json"));
  emptyReason.requirements[0].assertions[0].qualifierNotApplicable = [{ qualifier: "并发期间", rationale: "" }];
  writeJson(join(fx.taskDir, "acceptance.json"), emptyReason);
  rejected(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  const unknownQualifier = readJson(join(fx.taskDir, "acceptance.json"));
  unknownQualifier.requirements[0].assertions[0].qualifierNotApplicable = [{ qualifier: "不存在的限定", rationale: "理由" }];
  writeJson(join(fx.taskDir, "acceptance.json"), unknownQualifier);
  rejected(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
});

test("断言 dependsOn 依赖声明：非法增量引用被拒，合法形态通过", (t) => {
  const fx = fixture(t);
  const acceptance = readJson(join(fx.taskDir, "acceptance.json"));
  acceptance.requirements[1].assertions[0].dependsOn = { incrementIds: ["I-UNKNOWN"], mechanismRefs: [], testAssetRefs: [] };
  writeJson(join(fx.taskDir, "acceptance.json"), acceptance);
  rejected(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
  const valid = readJson(join(fx.taskDir, "acceptance.json"));
  valid.requirements[1].assertions[0].dependsOn = { incrementIds: ["I1"], mechanismRefs: ["D1.choice"], testAssetRefs: ["test-A3"] };
  writeJson(join(fx.taskDir, "acceptance.json"), valid);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home));
});

test("场景未认领时 verdict.missing.adversarialForms 披露未覆盖反例场景", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  appendEvidence(fx, rev, "A1", "command", "AF1");
  const verdict = evaluate(fx);
  assert.deepEqual(verdict.missing.adversarialForms.sort(), ["AF2", "AF3"], "AF1 已认领，AF2/AF3 未认领应披露");
  appendAllEvidence(fx, rev);
  const covered = evaluate(fx);
  assert.deepEqual(covered.missing.adversarialForms, [], "全部场景认领后清单清空");
});

test("schema 2 非 blocker 必须声明 consequenceRefutationType 三类之一", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  // 缺 type：gate fold 层拒绝（shape 层只验枚举，语义层要求 non-blocker 带 type）
  const artifact = evidenceFile(fx, "finding-notype.md");
  rejected(append(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "无类型论证", findingId: "F-NT1", category: "defect", severity: "non-blocker",
    requirementIds: ["R1"], consequenceRefutation: "该行为用户不可观察", artifact: artifact.artifact,
  }, "assurance"));
  // 非法枚举值：shape 层拒绝
  const artifact2 = evidenceFile(fx, "finding-badtype.md");
  rejected(append(fx, {
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "非法类型", findingId: "F-NT2", category: "defect", severity: "non-blocker",
    requirementIds: ["R1"], consequenceRefutation: "x", consequenceRefutationType: "vibes", artifact: artifact2.artifact,
  }, "assurance"));
  // 合法类型：通过（raise() helper 带 not-observable）
  ok(raise(fx, rev, "F-NT3", { severity: "non-blocker", consequenceRefutation: "仅内部计数变化" }));
});

test("保证后方案/验收修订并入计轮：nature=environment 不计，合计超 3 进 process-failed", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  ok(raise(fx, rev, "F-A1"));
  appendAllEvidence(fx, rev);
  completeAssurance(fx, rev, "full", fx.explorationEventId);
  // 首次保证后递增验收版本并重新批准/确认方案：AcceptanceApproved 与 DesignApproved
  // 各按一轮 off-loop 计轮（driveToApproval(v2) 重新登记两者）
  const rev2 = driveToApproval(fx, 2);
  ok(repairRound(fx, rev2, 1, { version: 2 }));
  ok(repairRound(fx, rev2, 2, { version: 2, nature: "environment" }));
  let verdict = evaluate(fx);
  assert.equal(verdict.quality.repairRounds, 3, "behavior 1 轮 + 验收递增 1 + 方案确认 1，environment 轮不计");
  assert.equal(verdict.quality.repairRoundsBreakdown.behaviorRepairRounds, 1);
  assert.equal(verdict.quality.repairRoundsBreakdown.acceptanceRevisionsAfterAssurance, 1);
  assert.equal(verdict.quality.repairRoundsBreakdown.designRevisionsAfterAssurance, 1);
  assert.notEqual(verdict.state, "process-failed");
  ok(repairRound(fx, rev2, 3, { version: 2 }));
  verdict = evaluate(fx);
  assert.equal(verdict.state, "process-failed");
  assert.equal(verdict.quality.repairRounds, 4);
  assert.match(verdict.nextAction, /含修复轮与保证后的方案\/验收修订/);
});

test("防覆盖对账覆盖非 EvidenceRecorded 事件：ExplorationCompleted 同路径改哈希重登记被拒", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  ok(raise(fx, rev, "F-HR0"));
  // 换新路径做带哈希登记
  const artifact = evidenceFile(fx, "exploration-hash.md", "# v1 探索\n");
  ok(append(fx, {
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "带哈希探索", dimensions: ["smoke"], coverageManifestSha256: artifact.artifactSha256,
    artifactSha256: artifact.artifactSha256, artifact: artifact.artifact,
  }, "assurance"));
  // 磁盘改写后以新哈希重登记同一路径 → 不同内容哈希登记，拒绝
  writeFileSync(join(fx.taskDir, "evidence", "exploration-hash.md"), "# 被覆盖的探索\n");
  const overwrittenSha = sha256("# 被覆盖的探索\n");
  rejected(append(fx, {
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "改哈希重登记", dimensions: ["smoke"], coverageManifestSha256: overwrittenSha,
    artifactSha256: overwrittenSha, artifact: artifact.artifact,
  }, "assurance"));
  // 已登记路径的不带哈希再引用 → 拒绝（防绕过哈希绑定）
  rejected(append(fx, {
    type: "FindingResolved", actor: "assurance", acceptanceVersion: 1, revision: rev,
    summary: "无哈希引用已登记路径", findingId: "F-HR0", artifact: artifact.artifact,
  }, "assurance"));
});

test("中低风险 schema 2 任务的候选探索不可跳过（exploratoryReview=not-required 不再豁免探索门控）", (t) => {
  const fx = fixture(t);
  const acceptance = readJson(join(fx.taskDir, "acceptance.json"));
  acceptance.riskLevel = "medium";
  acceptance.exploratoryReview = "not-required";
  writeJson(join(fx.taskDir, "acceptance.json"), acceptance);
  const rev = driveToApproval(fx);
  const artifact = evidenceFile(fx, "implementation.md");
  // 无当前 revision 探索 → ImplementationRecorded 被拒（原 not-required 豁免已被移除）
  rejected(append(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
    summary: "实现", incrementId: "I1", artifact: artifact.artifact,
    mergeReceipt: { fromRevision: rev, toRevision: rev, patchSha256: sha256("patch") },
  }, "builder"));
  fx.explorationEventId = explore(fx, rev);
  ok(append(fx, {
    type: "ImplementationRecorded", actor: "builder", acceptanceVersion: 1, revision: rev,
    summary: "实现", incrementId: "I1", artifact: artifact.artifact,
    mergeReceipt: { fromRevision: rev, toRevision: rev, patchSha256: sha256("patch") },
  }, "builder"));
});

test("验收版本递增后 full 引用旧探索无效，重新探索后有效（full 探索 due 判定）", (t) => {
  const fx = fixture(t);
  const rev = driveToAssurance(fx);
  appendAllEvidence(fx, rev);
  completeAssurance(fx, rev, "full", fx.explorationEventId);
  let verdict = evaluate(fx);
  assert.ok(!verdict.missing.assuranceCompleted, "版本递增前 full 有效");
  // 递增验收版本并重新批准 → 验收变化，旧探索不再覆盖新判据
  const rev2 = driveToApproval(fx, 2);
  appendAllEvidence(fx, rev2, 2);
  completeAssurance(fx, rev2, "full", fx.explorationEventId, 2);
  verdict = evaluate(fx);
  assert.ok(verdict.missing.assuranceCompleted, "验收变化后引用旧探索（同 revision）的 full 应无效");
  const newExploration = explore(fx, rev2, 2);
  completeAssurance(fx, rev2, "full", newExploration, 2);
  verdict = evaluate(fx);
  assert.ok(!verdict.missing.assuranceCompleted, "变化后重新探索的 full 有效");
});
