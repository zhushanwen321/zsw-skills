// delivery-report-v6.test.mjs — 机器生成终态报告回归（设计《V5 交付完整性与语义可信性
// 改造》机制六 §10 + 路线 B 第 4 条）
//
// 覆盖：
//   1. 双通道统计分开：loop-attempts path=workflow 与 path=manual 的 started/runs/
//      byOutcome 在报告 JSON 里互不混算
//   2. unknown 纪律：观测目录缺失 → unknown 不冒充 0；self-repairs 缺失 → unknown；
//      status.json 缺失 → unknown（并给 --status-file 传入指引）
//   3. revision 分节：尾部缺口（手改项目内容后 evaluate）→ unknownCount ≥ 1 且
//      currentEvidenceProblems 非空、markdown 含「无登记来源」；历史登记痕迹表存在
//   4. 超限循环如实呈现：acceptance-review 登记 7 次 started（> cap 6）→ exceeded=true
//   5. D1 失败与恢复：status.json 含 fail→reconcile 序列 → 分节 4 呈现序列与终态
//   6. 观测目录存在时按 execution 文件计数（可选数据源的正路）
//
// 运行：node --test scripts/tests/delivery-report-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const REPORT = join(V6, "scripts", "generate-delivery-report.mjs");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function runCore(args, home) {
  return spawnSync(process.execPath, [CORE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function runReport(args, home) {
  return spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function makeFixture(t, { taskId = "report-v6" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-report-v6-"));
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

/** 推进到设计批准（有 verdict.json 可读的实现前形态）——比 loop-attempts 测试少走实现段 */
function driveToDesignApproved(t) {
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
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home), "验收包应合法");
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  const reviewArtifact = join(fx.taskDir, "evidence", "acceptance-review-v1.md");
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(reviewArtifact, "# 审查\n");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home));
  const solution = join(fx.taskDir, "evidence", "solution.md");
  writeFileSync(solution, "# 方案\n");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(solution, "utf8")) }])}\n`);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home));
  return fx;
}

function attempt(fx, { runId, round, event, outcome, path = "workflow", loop = "acceptance-review" }) {
  ok(runCore([
    "loop-attempt", "--task-dir", fx.taskDir, "--loop", loop, "--path", path,
    "--run-id", runId, "--round", String(round), "--event", event,
    ...(outcome !== undefined ? ["--outcome", outcome] : []),
  ], fx.home), `loop-attempt ${loop} ${runId}:${round} ${event} 应成功`);
}

function generate(fx, extraArgs = []) {
  const result = runReport(["--task-dir", fx.taskDir, ...extraArgs], fx.home);
  ok(result, "报告生成应成功");
  return result.stdout;
}

function reportJson(markdown) {
  const start = markdown.indexOf("```json\n") + "```json\n".length;
  const end = markdown.indexOf("\n```", start);
  return JSON.parse(markdown.slice(start, end));
}

test("双通道统计分开 + 缺观测与缺 status.json 时 unknown 不冒充 0", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home), "evaluate 应成功（生成 verdict.json）");
  // 双通道：workflow 2 次 started（1 passed + 1 rejected，同一 run 两轮）+ manual 1 次（failed）
  attempt(fx, { runId: "run-a", round: 1, event: "started" });
  attempt(fx, { runId: "run-a", round: 1, event: "finished", outcome: "passed" });
  attempt(fx, { runId: "run-a", round: 2, event: "started" });
  attempt(fx, { runId: "run-a", round: 2, event: "finished", outcome: "rejected" });
  attempt(fx, { runId: "m1", round: 1, event: "started", path: "manual" });
  attempt(fx, { runId: "m1", round: 1, event: "finished", outcome: "failed", path: "manual" });

  const markdown = generate(fx);
  const report = reportJson(markdown);

  // 分节 2：超限与否如实（2 次 < 6 未超限）
  const acceptanceLoop = report.loopAttempts.loops.find((entry) => entry.loop === "acceptance-review");
  assert.equal(acceptanceLoop.started, 3, "started 跨 run 与通道累计（2 workflow + 1 manual）");
  assert.equal(acceptanceLoop.cap, 6, "cap 与 rules.json 单源一致");
  assert.equal(acceptanceLoop.exceeded, false);

  // 分节 3：双通道互不混算
  const channel = report.channels.loops.find((entry) => entry.loop === "acceptance-review");
  assert.deepEqual(
    { started: channel.workflow.started, runs: channel.workflow.runs, byOutcome: channel.workflow.byOutcome },
    { started: 2, runs: 1, byOutcome: { passed: 1, rejected: 1 } },
    "workflow 通道：2 次 started、1 个 runId、结果分布不含 manual 的 failed",
  );
  assert.deepEqual(
    { started: channel.manual.started, runs: channel.manual.runs, byOutcome: channel.manual.byOutcome },
    { started: 1, runs: 1, byOutcome: { failed: 1 } },
    "manual 通道独立计数",
  );
  assert.equal(report.channels.assuranceEvents.total, 0, "保证事件数直读事件流（本任务无 AssuranceCompleted）");

  // unknown 纪律：观测目录不存在（HOME 指向空临时目录）→ unknown，不出现 0 次执行的假象
  assert.equal(report.channels.observability.status, "unknown");
  assert.match(report.channels.observability.reason, /观测目录不存在/);
  assert.match(markdown, /不等于零次执行/);
  // status.json 缺失（任务目录与 --status-file 均无）→ unknown + 指引
  assert.equal(report.nodeEvents.status, "unknown");
  assert.match(markdown, /--status-file/);
  // self-repairs.jsonl 缺失 → unknown（不是 0 条）
  assert.equal(report.selfRepairs.status, "unknown");
  assert.match(markdown, /self-repairs\.jsonl 缺失/);
  // 报告开头固定声明（LLM 只解释不决定数字）
  assert.match(markdown, /本报告由权威记录生成；叙事解释可由 agent 补充，数字与状态以本文件为准/);

  // 附带验证 --out 写文件通道
  const outPath = join(fx.root, "report.md");
  ok(runReport(["--task-dir", fx.taskDir, "--out", outPath], fx.home), "--out 应成功");
  assert.ok(existsSync(outPath), "报告文件应写入");
  assert.ok(readFileSync(outPath, "utf8").startsWith("# 交付终态报告"), "写入内容为 markdown 报告");
});

test("超限循环如实呈现：7 次 started > cap 6 → exceeded + markdown 超限标记", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  for (let round = 1; round <= 7; round += 1) {
    const outcome = round <= 4 ? "rejected" : "failed";
    attempt(fx, { runId: round <= 2 ? "w1" : round <= 4 ? "w2" : round <= 6 ? "w3" : "w4", round: round % 2 === 0 ? 2 : 1, event: "started" });
    attempt(fx, { runId: round <= 2 ? "w1" : round <= 4 ? "w2" : round <= 6 ? "w3" : "w4", round: round % 2 === 0 ? 2 : 1, event: "finished", outcome });
  }
  const markdown = generate(fx);
  const report = reportJson(markdown);
  const acceptanceLoop = report.loopAttempts.loops.find((entry) => entry.loop === "acceptance-review");
  assert.equal(acceptanceLoop.started, 7);
  assert.equal(acceptanceLoop.exceeded, true, "7 > 6 超限");
  assert.match(markdown, /\*\*超限\*\*/, "markdown 应含超限标记");
});

test("revision 分节：尾部缺口披露 unknown；历史登记痕迹与当前问题分开", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  // revision 命令输出纯文本指纹（非 JSON），直接取 stdout
  const revisionResult = runGate(["revision", "--project-root", fx.projectDir], fx.home);
  ok(revisionResult, "revision 查询应成功");
  const revision0 = revisionResult.stdout.trim();

  // 候选形成锚点：探索 + 实现（from==to 的实现回执，无 revision 变化）。
  // --artifact 相对 taskDir 解析（gate 拼接 taskDir 前缀），传相对路径
  writeFileSync(join(fx.taskDir, "evidence", "exploration.md"), "# 探索\n维度 smoke\n");
  ok(runGate([
    "record-exploration", "--task-dir", fx.taskDir, "--summary", "候选探索", "--dimensions", '["smoke"]',
    "--coverage-manifest-sha256", sha256("manifest"), "--artifact", "evidence/exploration.md", "--credential", fx.creds.assurance,
    "--revision", revision0,
  ], fx.home), "探索登记应成功");
  writeFileSync(join(fx.taskDir, "evidence", "impl.md"), "# 实现\n");
  ok(runGate([
    "record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", "evidence/impl.md", "--merge-receipt", JSON.stringify({ fromRevision: revision0, toRevision: revision0, patchSha256: sha256("patch") }),
    "--credential", fx.creds.builder, "--revision", revision0,
  ], fx.home), "实现登记应成功");

  // 尾部缺口：手改项目内容（无任何登记来源）→ evaluate 用新 revision → 对账出现 unknown
  writeFileSync(join(fx.projectDir, "a.txt"), "one\ntwo\n");
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home), "手改后 evaluate 应成功");

  const markdown = generate(fx);
  const report = reportJson(markdown);
  const provenance = report.revisionProvenance;
  assert.equal(provenance.status, "ok");
  assert.equal(provenance.enabled, true, "候选形成锚点存在，对账启用");
  assert.ok(provenance.unknownCount >= 1, "手改产生的尾部缺口应计 unknown");
  assert.ok(provenance.currentEvidenceProblems.length >= 1, "缺口指向当前 revision，属当前证据问题");
  assert.equal(provenance.currentRevisionExplained, false);
  assert.match(markdown, /当前内容无登记来源/, "markdown 应披露尾部缺口");
  assert.match(markdown, /历史 revision 登记痕迹/, "历史痕迹与当前问题分开呈现");

  // 无缺口的对照组：恢复项目内容后 unknownCount 归零（对账可判定，非 unknown 状态）
  writeFileSync(join(fx.projectDir, "a.txt"), "one\n");
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  const cleanReport = reportJson(generate(fx));
  assert.equal(cleanReport.revisionProvenance.unknownCount, 0);
  assert.equal(cleanReport.revisionProvenance.currentRevisionExplained, true);
});

test("D1 失败与恢复：status.json 的 fail→reconcile 序列按节点呈现，终态与中间失败并陈", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  // 手工构造 dev-flow 段 status.json（该文件是 dev-flow 产物，不经 gate 生成）。
  // 事件序列遵循 node 域转移表（rules.json）：fail 从 in-progress 出发；恢复走
  // reset(failed→pending) → begin；reconcile-pending 从 done 出发（已完成节点被重开）
  const statusPath = join(fx.root, "status.json");
  writeFileSync(statusPath, `${JSON.stringify({
    nodes: {},
    events: [
      { seq: 1, node: "U1", event: "begin", detail: "开始" },
      { seq: 2, node: "U1", event: "fail", detail: "测试红", payload: { reason: "断言失败" } },
      { seq: 3, node: "U1", event: "reset", detail: "重排队" },
      { seq: 4, node: "U1", event: "begin", detail: "重试" },
      { seq: 5, node: "U1", event: "finish-done", detail: "恢复完成", payload: { commit: "abc123" } },
      { seq: 6, node: "U2", event: "begin", detail: "开始" },
      { seq: 7, node: "U2", event: "finish-done", detail: "完成", payload: { commit: "def456" } },
      { seq: 8, node: "U3", event: "begin", detail: "开始" },
      { seq: 9, node: "U3", event: "finish-done", detail: "首完成", payload: { commit: "ggg789" } },
      { seq: 10, node: "U3", event: "reconcile-pending", detail: "上游变化重开" },
      { seq: 12, node: "U3", event: "reconcile-done", detail: "重开完成", payload: { commit: "hhh012" } },
    ],
  }, null, 2)}\n`);

  const markdown = generate(fx, ["--status-file", statusPath]);
  const report = reportJson(markdown);
  assert.equal(report.nodeEvents.status, "ok");
  assert.equal(report.nodeEvents.nodeCount, 3);
  assert.deepEqual(report.nodeEvents.byStatus, { done: 3 });
  // projectNodeEvents 单源重放：U1 两次 begin（fail 后 reset 重跑），attempts=2
  assert.equal(report.nodeEvents.nodes.U1.attempts, 2);
  assert.equal(report.nodeEvents.nodes.U1.status, "done");
  // U3 reconcile 路径（done → reconcile-pending → reconcile-done，无中间 begin）：
  // attempts = begin 1 + reconcile-done 补记 1 = 2
  assert.equal(report.nodeEvents.nodes.U3.attempts, 2);
  // 失败与恢复序列只落 U1/U3（U2 无失败事件）
  assert.deepEqual(report.nodeEvents.failureSequences.U1.map((item) => item.event), ["fail"]);
  assert.deepEqual(report.nodeEvents.failureSequences.U3.map((item) => item.event), ["reconcile-pending", "reconcile-done"]);
  assert.equal(report.nodeEvents.failureSequences.U2, undefined);
  assert.match(markdown, /U1：#2 fail（测试红）/, "失败序列按事件序呈现");
  assert.match(markdown, /U3：#10 reconcile-pending（上游变化重开） → #12 reconcile-done/, "重开序列成对呈现");
  assert.match(markdown, /终态 done/, "中间失败与最终恢复并陈");
  // 分节 7：DAG 节点数直读派生视图
  assert.equal(report.counts.dagNodes.dagNodeCount, 3);
});

test("观测目录存在时按 execution 文件计数（skill 分组）", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  const taskId = basename(fx.taskDir);
  const obsDir = join(fx.home, ".agents", "skill-data", "workflow-observability", taskId);
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, "exec-1.jsonl"), `${JSON.stringify({ execution_id: "exec-1", task_id: taskId, skill: "delivery-v6", stage: "DESIGN", step: null, round: null, attempt: null, event: "start", timestamp: new Date().toISOString(), sample_type: "production" })}\n`);
  writeFileSync(join(obsDir, "exec-2.jsonl"), `${JSON.stringify({ execution_id: "exec-2", task_id: taskId, skill: "delivery-v6", stage: "ASSURE", step: null, round: null, attempt: null, event: "start", timestamp: new Date().toISOString(), sample_type: "production" })}\n`);

  const markdown = generate(fx);
  const report = reportJson(markdown);
  assert.equal(report.channels.observability.status, "ok");
  assert.equal(report.channels.observability.executions, 2);
  assert.deepEqual(report.channels.observability.bySkill, { "delivery-v6": 2 });
  assert.match(markdown, /2 个执行文件/);
});

test("self-repairs.jsonl 存在时直读计数（byKind / byOutcome / byWorkflow）", (t) => {
  const fx = driveToDesignApproved(t);
  ok(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home));
  const rows = [
    { at: "2026-01-01T00:00:00Z", workflow: "independent-assurance-v6", step: "review", round: 1, kind: "agent-structure-retry", target: "coverage-review", trigger: "结构非法", outcome: "recovered" },
    { at: "2026-01-01T00:01:00Z", workflow: "independent-assurance-v6", step: "setup", round: null, kind: "cli-retry", target: "evaluate", trigger: "spawn 失败", outcome: "recovered" },
    { at: "2026-01-01T00:02:00Z", workflow: "acceptance-design-v6", step: "review", round: 2, kind: "agent-error-retry", target: "acceptance-reviewer-r2", trigger: "调用异常", outcome: "exhausted" },
  ];
  writeFileSync(join(fx.taskDir, "self-repairs.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const markdown = generate(fx);
  const report = reportJson(markdown);
  assert.equal(report.selfRepairs.status, "ok");
  assert.equal(report.selfRepairs.total, 3);
  assert.deepEqual(report.selfRepairs.byKind, { "agent-structure-retry": 1, "cli-retry": 1, "agent-error-retry": 1 });
  assert.deepEqual(report.selfRepairs.byOutcome, { recovered: 2, exhausted: 1 });
  assert.deepEqual(report.selfRepairs.byWorkflow, { "independent-assurance-v6": 2, "acceptance-design-v6": 1 });
});

test("参数校验：缺 --task-dir / 未知参数 / 目录不存在", () => {
  const missing = runReport([], "/tmp");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /缺少必填参数 --task-dir/);
  const unknown = runReport(["--task-dir", "/tmp", "--bogus", "1"], "/tmp");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /未知参数 --bogus/);
  const notDir = runReport(["--task-dir", "/nonexistent-xyz"], "/tmp");
  assert.notEqual(notDir.status, 0);
  assert.match(notDir.stderr, /任务目录不存在/);
  assert.match(notDir.stderr, /恢复动作/);
});
