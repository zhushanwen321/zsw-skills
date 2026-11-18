// loop-attempts-v6.test.mjs — 循环尝试记录与预算回归（设计《V5 交付完整性与语义可信性改造》机制四 §8.1）
//
// 覆盖：
//   1. 登记：loop-attempt started/finished 往返，行 schema 与 attemptKey 拼装（<runId>:<round>）
//   2. 幂等：同 (attemptKey, event) 重复提交跳过（崩溃恢复安全，不重复计数）
//   3. 参数校验：started 禁带 outcome、finished 必带 outcome、path/event/outcome 词表、round 正整数
//   4. 预算读取：loop-budget 按 started 计数（跨 run 聚合）、byOutcome、cap 对拍 rules.json；
//      未接入循环 cap=null 并披露已知缺口
//   5. 纯函数：parseLoopAttemptsText 半行容错；loopAttemptsBudget 按 (attemptKey, event) 去重
//   6. 验收复审预算语义升级端到端：started 计数超 cap → evaluate 判 process-failed
//      （含打回形态的 outcome= rejected 也计入）；未超限的尝试不误伤 accepted
//
// 运行：node --test scripts/tests/loop-attempts-v6.test.mjs

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
const RULES = JSON.parse(readFileSync(join(V6, "scripts", "kernel", "rules.json"), "utf8"));
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
function readRows(taskDir) {
  return readFileSync(join(taskDir, "loop-attempts.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function makeFixture(t, { taskId = "loop-attempt" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "loop-attempts-v6-"));
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

/** schema 2 最小验收包 + review/approve/design 三连（推进到实现段，形态同 delivery-core-v6 夹具） */
function driveToImplementing(t) {
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

function attempt(fx, { runId, round, event, outcome, inputHash, path = "workflow", loop = "acceptance-review" }) {
  return runCore([
    "loop-attempt", "--task-dir", fx.taskDir, "--loop", loop, "--path", path,
    "--run-id", runId, "--round", String(round), "--event", event,
    ...(outcome !== undefined ? ["--outcome", outcome] : []),
    ...(inputHash !== undefined ? ["--input-hash", inputHash] : []),
  ], fx.home);
}

// ── 1-3. 登记、幂等与参数校验 ──

test("loop-attempt 登记：started/finished 往返，行 schema 与 attemptKey 拼装", (t) => {
  const fx = makeFixture(t);
  const started = attempt(fx, { runId: "run-abc", round: 1, event: "started", inputHash: sha256("review-input") });
  ok(started, "started 应登记成功");
  assert.deepEqual(JSON.parse(parseStdout(started)), { recorded: true, attemptKey: "run-abc:1", event: "started", loop: "acceptance-review" });
  ok(attempt(fx, { runId: "run-abc", round: 1, event: "finished", outcome: "rejected" }), "打回的 finished 应登记成功");
  const rows = readRows(fx.taskDir);
  assert.equal(rows.length, 2, "只追加不回写：两行记录");
  assert.deepEqual(rows[0], {
    taskId: basename(fx.taskDir),
    loop: "acceptance-review",
    path: "workflow",
    runId: "run-abc",
    attemptKey: "run-abc:1",
    event: "started",
    inputHash: sha256("review-input"),
    at: rows[0].at,
  }, "started 行不含 outcome、含 inputHash");
  assert.equal(rows[0].outcome, undefined, "started 不携带结果");
  assert.deepEqual({ ...rows[1], at: rows[1].at }, {
    taskId: basename(fx.taskDir),
    loop: "acceptance-review",
    path: "workflow",
    runId: "run-abc",
    attemptKey: "run-abc:1",
    event: "finished",
    at: rows[1].at,
    outcome: "rejected",
  }, "finished 行携带 outcome");
  assert.ok(rows[1].inputHash === undefined, "finished 未传 inputHash 时不含该字段");
});

test("loop-attempt 幂等：同 (attemptKey, event) 重复提交跳过；同 key 不同 event 放行", (t) => {
  const fx = makeFixture(t);
  ok(attempt(fx, { runId: "r1", round: 2, event: "started" }));
  const replay = attempt(fx, { runId: "r1", round: 2, event: "started" });
  ok(replay, "重复提交不报错");
  assert.deepEqual(JSON.parse(parseStdout(replay)), { recorded: false, duplicate: true, attemptKey: "r1:2", event: "started", loop: "acceptance-review" });
  ok(attempt(fx, { runId: "r1", round: 2, event: "finished", outcome: "passed" }), "同 key 的 finished 是另一事件，放行");
  assert.equal(readRows(fx.taskDir).length, 2, "重复 started 未落第二行");
  // 跨 run 同轮次是不同尝试（attemptKey 含 runId）：不互相去重
  ok(attempt(fx, { runId: "r2", round: 2, event: "started" }));
  assert.equal(readRows(fx.taskDir).length, 3);
});

test("loop-attempt 参数校验：started 禁 outcome、finished 必 outcome、词表与 round", (t) => {
  const fx = makeFixture(t);
  const cases = [
    { args: ["--event", "started", "--outcome", "passed"], pattern: /started 不携带结果/, label: "started 带 outcome 应被拒" },
    { args: ["--event", "finished"], pattern: /finished 必须带 --outcome/, label: "finished 缺 outcome 应被拒" },
    { args: ["--event", "finished", "--outcome", "ok"], pattern: /passed.*rejected.*failed.*interrupted/, label: "非法 outcome 词表应被拒" },
    { args: ["--event", "pending"], pattern: /--event 必须是/, label: "非法 event 应被拒" },
    { args: ["--event", "started", "--path", "agent"], pattern: /--path 必须是 workflow \/ manual/, label: "非法 path 应被拒" },
    { args: ["--event", "started", "--round", "0"], pattern: /--round 必须是正整数/, label: "round=0 应被拒" },
    { args: ["--event", "started", "--round", "abc"], pattern: /--round 必须是正整数/, label: "round 非整数应被拒" },
    { args: ["--event", "started", "--input-hash", " "], pattern: /--input-hash 为空字符串/, label: "空 input-hash 应被拒" },
  ];
  for (const item of cases) {
    const result = runCore(["loop-attempt", "--task-dir", fx.taskDir, "--loop", "acceptance-review", "--path", "workflow", "--run-id", "r1", "--round", "1", ...item.args], fx.home);
    assert.notEqual(result.status, 0, item.label);
    assert.match(result.stderr, item.pattern, `${item.label} 的报错应可定位`);
    assert.match(result.stderr, /恢复动作/, "错误消息必须给恢复动作");
  }
  // 手工路径同表记录
  ok(attempt(fx, { runId: "m1", round: 1, event: "started", path: "manual" }), "manual 路径应放行");
  assert.equal(readRows(fx.taskDir).at(-1).path, "manual");
});

// ── 4-5. 预算读取与纯函数 ──

test("loop-budget：started 跨 run 累计、byOutcome、cap 对拍 rules.json、未接入循环披露缺口", (t) => {
  const fx = makeFixture(t);
  // 三个 run 共 5 次尝试：passed/rejected/failed/interrupted/未完成（无 finished）
  attempt(fx, { runId: "a", round: 1, event: "started" });
  attempt(fx, { runId: "a", round: 1, event: "finished", outcome: "passed" });
  attempt(fx, { runId: "a", round: 2, event: "started" });
  attempt(fx, { runId: "a", round: 2, event: "finished", outcome: "rejected" });
  attempt(fx, { runId: "b", round: 1, event: "started" });
  attempt(fx, { runId: "b", round: 1, event: "finished", outcome: "failed" });
  attempt(fx, { runId: "c", round: 1, event: "started" });
  attempt(fx, { runId: "c", round: 1, event: "finished", outcome: "interrupted" });
  attempt(fx, { runId: "d", round: 1, event: "started" });
  const budget = JSON.parse(parseStdout(runCore(["loop-budget", "--task-dir", fx.taskDir, "--loop", "acceptance-review"], fx.home)));
  assert.equal(budget.started, 5, "started 按任务累计（跨 run），不是成功事件数");
  assert.deepEqual(budget.byOutcome, { passed: 1, rejected: 1, failed: 1, interrupted: 1 });
  assert.equal(budget.cap, RULES.budgets.acceptanceReReviewRoundCap, "cap 与 rules.json 单源一致");
  assert.equal(budget.exceeded, false, "5 ≤ 6 未超限");
  // 未接入循环：cap=null + 缺口披露（§8.2），不猜上限
  const unconnected = JSON.parse(parseStdout(runCore(["loop-budget", "--task-dir", fx.taskDir, "--loop", "d2-consistency"], fx.home)));
  assert.equal(unconnected.cap, null, "未接入循环 cap=null");
  assert.equal(unconnected.exceeded, false);
  assert.match(unconnected.note, /未接入尝试预算（已知缺口）/);
});

test("loopAttemptsBudget 纯函数：半行容错与 (attemptKey, event) 去重", () => {
  const text = [
    JSON.stringify({ loop: "acceptance-review", attemptKey: "r:1", event: "started" }),
    "{\"loop\": \"acceptance-review\", \"attemptKey\": \"r:1\", \"ev", // 崩溃半行
    JSON.stringify({ loop: "acceptance-review", attemptKey: "r:1", event: "started" }), // 崩溃重放重复
    JSON.stringify({ loop: "acceptance-review", attemptKey: "r:1", event: "finished", outcome: "rejected" }),
    JSON.stringify({ loop: "other-loop", attemptKey: "r:1", event: "started" }), // 其他循环不计
  ].join("\n");
  const rows = KERNEL.parseLoopAttemptsText(text);
  assert.equal(rows.length, 4, "半行被跳过");
  const budget = KERNEL.loopAttemptsBudget(rows, { loop: "acceptance-review", cap: 6 });
  assert.equal(budget.started, 1, "同 (attemptKey, event) 的重复行不重复计数");
  assert.deepEqual(budget.byOutcome, { rejected: 1 });
});

// ── 6. 验收复审预算端到端：超限 process-failed；未超限不误伤 ──

test("验收复审预算超限：started（含打回）超 cap → evaluate 判 process-failed 并给出停回指引", (t) => {
  const fx = driveToImplementing(t);
  // 7 次尝试跨 4 个 run（打回 4 + 失败 2 + 中断 1）> cap 6——按结果成功事件数是 0，旧口径完全漏计
  let round = 0;
  for (const runId of ["w1", "w2", "w3", "w4"]) {
    const roundsInRun = runId === "w4" ? 1 : 2;
    for (let local = 1; local <= roundsInRun; local += 1) {
      round += 1;
      const outcome = round <= 4 ? "rejected" : round <= 6 ? "failed" : "interrupted";
      ok(attempt(fx, { runId, round: local, event: "started" }));
      ok(attempt(fx, { runId, round: local, event: "finished", outcome }));
    }
  }
  const verdict = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(verdict.state, "process-failed", "尝试预算超限应判 process-failed（打回与中断均计数）");
  assert.deepEqual(verdict.missing.loopAttempts, {
    loop: "acceptance-review",
    started: 7,
    cap: 6,
    recovery: verdict.missing.loopAttempts.recovery,
  }, "missing.loopAttempts 披露计数与上限");
  assert.equal(verdict.quality.budgets.acceptanceReReviewLoop.used, 7);
  assert.equal(verdict.quality.budgets.acceptanceReReviewLoop.exceeded, true);
  assert.match(verdict.nextAction, /验收复审尝试 7\/6/, "nextAction 应追加尝试预算成因段");
});

test("验收复审预算未超限：正常尝试次数不误伤（interrupted 也只按次数计）", (t) => {
  const fx = driveToImplementing(t);
  for (let round = 1; round <= 6; round += 1) {
    ok(attempt(fx, { runId: "w1", round, event: "started" }));
    ok(attempt(fx, { runId: "w1", round, event: "finished", outcome: round < 6 ? "rejected" : "interrupted" }));
  }
  const budget = JSON.parse(parseStdout(runCore(["loop-budget", "--task-dir", fx.taskDir, "--loop", "acceptance-review"], fx.home)));
  assert.equal(budget.started, 6);
  assert.equal(budget.exceeded, false, "6 = cap 未超（判定式为 >cap）");
  const verdict = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home)));
  assert.notEqual(verdict.state, "process-failed", "未超限不得 process-failed");
  assert.equal(verdict.missing.loopAttempts ?? null, null, "未超限时 missing.loopAttempts 为空");
});

// ── 7. 源码结构断言：版本打回与 designer 失败均消耗预算（防回归形态锚定）──

test("acceptance-design 源码结构：started 在轮内退出路径之前，designer 失败与版本打回均有 finished 配对", () => {
  // workflow 内部逻辑（agent 调用）难以单测，按仓内既有防复刻断言模式锚定源码形态：
  // 预算按 started 计数——started 必须先于全部轮内退出路径登记，退出路径必须有
  // finished 配对，否则该路径不消耗预算（文档宣称「designer 失败、打回全部计入」）
  const source = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "acceptance-design-v6.shared.ts"), "utf8");
  const startedAt = source.indexOf('await recordLoopAttempt("started"');
  const designerFailAt = source.indexOf("if (!designedGuard.ok || designedGuard.value === null)");
  const versionGateAt = source.indexOf("if (draftContractVersion <= approvedMaxVersion)");
  const reviewerAt = source.indexOf("const reviewer = agent(");
  assert.ok(startedAt !== -1, "存在 started 登记调用");
  assert.ok(designerFailAt !== -1 && versionGateAt !== -1 && reviewerAt !== -1, "锚点路径齐全");
  assert.ok(startedAt < designerFailAt, "started 登记在 designer 调用之前（designer 失败消耗预算）");
  assert.ok(startedAt < versionGateAt, "started 登记在版本门禁之前（版本打回消耗预算）");
  const designerFailBlock = source.slice(designerFailAt, source.indexOf("const designed = designedGuard.value;"));
  assert.match(designerFailBlock, /recordLoopAttempt\("finished", round, \{ outcome: "failed" \}\)/, "designer 失败路径登记 finished(failed)");
  const versionGateBlock = source.slice(versionGateAt, reviewerAt);
  assert.match(versionGateBlock, /recordLoopAttempt\("finished", round, \{ outcome: "rejected" \}\)/, "版本未递增打回路径登记 finished(rejected)");
});
