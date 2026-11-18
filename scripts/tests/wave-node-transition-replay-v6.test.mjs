// wave-node-transition-replay-v6.test.mjs — wave-executor-v6 节点状态翻转的注册边与重放一致性
//
// 覆盖（交付事务状态机设计 §3.1/§3.2：转移唯一入口、事件由引擎按注册名构造、
// status.json nodes 是 status.events 的派生视图）：
//   1. 恢复对账核验器（RECONCILE_VERIFY）只读行为：git 查证输出判定（keep /
//      reset-pending / restore-done / claimAny 认领 / 无 baseline 警示），不写 status、
//      不产事件——F4 收敛回归锚（旧版内联改 nodes 并写词表外事件 reconcile-reset）
//   2. 对账判定 → 注册边映射（applyReconcileVerdicts）：reset-pending → reconcile-pending
//      （done→pending 既有边）；restore-done → 前置归 pending 的注册边 + reconcile-done
//      （pending→done 既有边，commit 进 payload 供重放恢复）
//   3. 引擎形态事件流可被 delivery-core node-project 重放一致：reconcile-pending /
//      reconcile-done / cascade-reset（attempts 保留）/ suspend 重放重建 = 在盘 nodes；
//      node-project --write 只重写 nodes，顶层 terminal 字段原样保留（F7 投影一致性）
//   4. cascade-reset 内核对拍：done/in-progress/blocked/failed → pending 且 attempts 保留
//      （F5 回归锚——旧版级联失效/inspect 锚核对直改内存并归零 attempts，V4 缺陷复辟）
//   5. 产物级词表守卫：wave-executor-v6 产物不得再出现 node:"-" 事件写、词表外事件名
//      （run-terminal / commit-deferred-list / residual-files / pre-existing-files /
//      reconcile-reset）；终局事实改存顶层 terminal 字段；D1 尝试账接线（--loop d1）
//   6. D1 尝试账键形：loop-attempt --loop d1 落账（attemptKey = runId:round）、
//      loop-budget 对未接入判定上限的循环如实返回 cap=null（只登记不判定，§8.2 已知缺口）
//
// 运行：node --test scripts/tests/wave-node-transition-replay-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const PI = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/pi/wave-executor-v6.js"), "utf8");

function runCore(args) {
  return spawnSync(process.execPath, [CORE, ...args], { encoding: "utf8", timeout: 60_000 });
}
function runGateCli(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home },
  });
}

// ── 产物提取（TS 已剥除，名字保留；与 delivery-core-v6 对拍测试同法）──

function extractConst(name) {
  const match = new RegExp(`const ${name} =([\\s\\S]*?");\\n`).exec(PI);
  assert.ok(match, `pi 产物应含 const ${name}（提取前提）`);
  return new Function(`${match[0]}\n  return ${name};`)();
}
const RECONCILE_VERIFY = extractConst("RECONCILE_VERIFY");

const tableMatch = /const NODE_TRANSITIONS[^;]+;/s.exec(PI);
const fnMatch = /function computeNodeTransition\([\s\S]*?\n}/.exec(PI);
assert.ok(tableMatch && fnMatch, "pi 产物应含 NODE_TRANSITIONS 与 computeNodeTransition（提取前提）");
const computeNodeTransition = new Function(`${tableMatch[0]}\n${fnMatch[0]}\nreturn computeNodeTransition;`)();

// applyReconcileVerdicts 依赖 isRec / nodeState / applyNodeTransition / log——eval 环境注入
// 测试替身（记录每次转移的事件名序列；isRec 用与引擎同形的实现）
const verdictFnMatch = /async function applyReconcileVerdicts\([\s\S]*?\n}\n/.exec(PI);
assert.ok(verdictFnMatch, "pi 产物应含 applyReconcileVerdicts（对账翻转走转移通道的提取前提）");
const isRecSrc = "function isRec(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }";

// ── git 夹具：baseline + 带 Run-Id trailer 的单元 commit ──

function git(dir, args) {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} 应成功：${r.stderr}`);
  return r.stdout.trim();
}

function makeGitRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "wave-replay-v6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "baseline"]);
  // baseline 取 sha 用 rev-parse（commit -q 无 stdout，引擎 status 初建同口径）
  const baseline = git(dir, ["rev-parse", "HEAD"]);
  return { dir, baseline };
}

function commitUnit(repo, unitId, runId, message = "实现") {
  // commitTemplate 形态：subject = 静态前段 + <unitId> + 后继非词字符（词边界锚）；
  // trailer = Run-Id（引擎渲染同款：subject + 空行 + trailer 段）。sha 用 rev-parse 取
  //（commit -q 无 stdout）
  writeFileSync(join(repo.dir, `${unitId}.txt`), `${unitId}\n`);
  git(repo.dir, ["add", "."]);
  git(repo.dir, ["commit", "-qm", `feat: unit ${unitId} ${message}`, "-m", `Run-Id: ${runId}`]);
  return git(repo.dir, ["rev-parse", "HEAD"]);
}

function makeStatus(repo, nodes, extra = {}) {
  const statusPath = join(repo.dir, "plan.status.json");
  writeFileSync(statusPath, `${JSON.stringify({ baseline: repo.baseline, runId: "rid1", nodes, events: [], ...extra }, null, 2)}\n`);
  return statusPath;
}

function runVerify(statusPath, projectRoot, template, runId, entries, claimAny = false) {
  const argv = [RECONCILE_VERIFY, statusPath, projectRoot, template, runId, ...(claimAny ? ["claimAnyRunId"] : []), ...entries];
  return spawnSync(process.execPath, ["-e", ...argv], { encoding: "utf8", timeout: 60_000 });
}

const TEMPLATE = "feat: unit {unitId} {summary}";

// ── 1. RECONCILE_VERIFY 只读核验 ──

test("RECONCILE_VERIFY：keep / reset-pending / restore-done 判定正确且只读（不写 status 不产事件）", (t) => {
  const repo = makeGitRepo(t);
  const c1 = commitUnit(repo, "U1", "rid1");
  const statusPath = makeStatus(repo, {
    U1: { status: "done", attempts: 2, commit: c1 },
    U2: { status: "done", attempts: 1, commit: "0123456789abcdef0123456789abcdef01234567" },
    U3: { status: "pending", attempts: 3 },
  });
  const before = readFileSync(statusPath, "utf8");
  const run = runVerify(statusPath, repo.dir, TEMPLATE, "rid1", ["U1", "U2", "U3"]);
  assert.equal(run.status, 0, `核验器应成功：${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.warn, null, "baseline 在场时无警示");
  const byId = Object.fromEntries(out.verdicts.map((v) => [v.id, v]));
  assert.equal(byId.U1.verdict, "keep", "commit 在对象库的 done 节点判 keep");
  assert.equal(byId.U2.verdict, "reset-pending", "status done 但 commit 不在对象库判 reset-pending");
  assert.equal(byId.U2.commit, "0123456789abcdef0123456789abcdef01234567", "reset-pending 带陈旧 commit 供日志");
  assert.equal(byId.U3.verdict, "keep", "pending 且无反查命中判 keep");
  assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), JSON.parse(before), "核验器只读：status 字节不变");
});

test("RECONCILE_VERIFY：restore-done 反查命中（Run-Id 精确匹配 / claimAny 认领 / 无 baseline 警示）", (t) => {
  const repo = makeGitRepo(t);
  const c1 = commitUnit(repo, "U1", "rid1");
  // 精确匹配路径：status 记 runId=rid1，pending 节点 U1 有带同 Run-Id trailer 的 commit
  const statusPath = makeStatus(repo, { U1: { status: "pending", attempts: 0 } });
  let out = JSON.parse(runVerify(statusPath, repo.dir, TEMPLATE, "rid1", ["U1"]).stdout);
  assert.deepEqual(out.verdicts, [{ id: "U1", verdict: "restore-done", commit: c1 }], "反查命中补 restore-done 并带 commit");
  // Run-Id 不匹配不认领：锚 = status.runId（沿用磁盘值口径，引擎重启不换锚）——
  // status.runId=rid-other 与 commit trailer rid1 精确匹配落空即 keep
  const statusOtherRun = makeStatus(repo, { U1: { status: "pending", attempts: 0 } }, { runId: "rid-other" });
  out = JSON.parse(runVerify(statusOtherRun, repo.dir, TEMPLATE, "rid-other", ["U1"]).stdout);
  assert.deepEqual(out.verdicts, [{ id: "U1", verdict: "keep" }], "Run-Id 精确匹配不命中即 keep");
  // claimAny 认领路径：status 曾缺失（初始态恢复），旧 commit 带旧 Run-Id 也认领
  const freshStatus = makeStatus(repo, { U1: { status: "pending", attempts: 0 } }, { runId: "fresh-run" });
  out = JSON.parse(runVerify(freshStatus, repo.dir, TEMPLATE, "fresh-run", ["U1"], true).stdout);
  assert.deepEqual(out.verdicts, [{ id: "U1", verdict: "restore-done", commit: c1 }], "claimAny 跳过 Run-Id 锚");
  // 无 baseline：反查禁用 + warn（旧版此处写 node:'*' 的 reconcile-warn 事件——收敛后走引擎日志）
  const noBaseline = join(repo.dir, "legacy.status.json");
  writeFileSync(noBaseline, `${JSON.stringify({ nodes: { U1: { status: "pending", attempts: 0 } } }, null, 2)}\n`);
  const run = runVerify(noBaseline, repo.dir, TEMPLATE, "rid1", ["U1"]);
  out = JSON.parse(run.stdout);
  assert.match(out.warn, /无 baseline/, "无 baseline 给警示文本（引擎日志用，不入事件流）");
  assert.deepEqual(out.verdicts, [{ id: "U1", verdict: "keep" }], "无 baseline 反查禁用，一律 keep");
});

// ── 2. 对账判定 → 注册边映射 ──

function loadApplyReconcileVerdicts(stateMap, applied) {
  const stubs = [
    isRecSrc,
    `const state = new Map(${JSON.stringify([...stateMap])});`,
    "function nodeState(id) { const e = state.get(id); return e && e.status ? e.status : 'pending'; }",
    "async function applyNodeTransition(id, eventName, extra) { applied.push({ id, event: eventName, extra }); return true; }",
    "function log(_) {}",
    "let applied = undefined;",
    verdictFnMatch[0],
  ].join("\n");
  return new Function(`${stubs}\n  applied = arguments[0];\n  return applyReconcileVerdicts;`)(applied);
}

test("applyReconcileVerdicts：reset-pending 走 reconcile-pending；restore-done 先归 pending 再 reconcile-done", async () => {
  const cases = [
    {
      // F4 规格：reset 判定用 reconcile-pending（done→pending 既有边）
      state: [["U1", { status: "done", attempts: 2 }]],
      verdicts: [{ id: "U1", verdict: "reset-pending", commit: "deadbeef" }],
      events: ["reconcile-pending"],
    },
    {
      // pending 态 restore：直接 reconcile-done（pending→done 既有边）
      state: [["U2", { status: "pending", attempts: 0 }]],
      verdicts: [{ id: "U2", verdict: "restore-done", commit: "abc1234" }],
      events: ["reconcile-done"],
    },
    {
      // blocked 态 restore：先 reset（blocked→pending）再 reconcile-done——全注册边等价复位
      state: [["U3", { status: "blocked", attempts: 1 }]],
      verdicts: [{ id: "U3", verdict: "restore-done", commit: "abc1234" }],
      events: ["reset", "reconcile-done"],
    },
    {
      // in-progress 态 restore：前置边 cascade-reset；suspended 态：resume
      state: [
        ["U4", { status: "in-progress", attempts: 1 }],
        ["U5", { status: "suspended", attempts: 1 }],
      ],
      verdicts: [
        { id: "U4", verdict: "restore-done", commit: "abc1234" },
        { id: "U5", verdict: "restore-done", commit: "abc1234" },
      ],
      events: ["cascade-reset", "reconcile-done", "resume", "reconcile-done"],
    },
    {
      // keep 不产转移；restore-done 缺 commit 不翻转
      state: [["U6", { status: "pending", attempts: 0 }]],
      verdicts: [
        { id: "U6", verdict: "keep" },
        { id: "U7", verdict: "restore-done" },
      ],
      events: [],
    },
  ];
  for (const c of cases) {
    const applied = [];
    const fn = loadApplyReconcileVerdicts(c.state, applied);
    const scopeIds = c.state.map(([id]) => id).concat(c.verdicts.map((v) => v.id));
    await fn(c.verdicts, false, [...new Set(scopeIds)]);
    assert.deepEqual(applied.map((a) => a.event), c.events, `判定序列 ${JSON.stringify(c.verdicts)} 的注册边序列应一致`);
  }
  // reconcile-done 的事件 extras 必须带 commit（node-project 重放恢复 commit 依赖 payload）
  const applied = [];
  const fn = loadApplyReconcileVerdicts([["U2", { status: "pending", attempts: 0 }]], applied);
  await fn([{ id: "U2", verdict: "restore-done", commit: "abc1234" }], false, ["U2"]);
  const doneCall = applied.find((a) => a.event === "reconcile-done");
  assert.equal(doneCall.extra.commit, "abc1234", "reconcile-done 携带 commit 进 payload");
});

// ── 3. 引擎形态事件流 → node-project 重放一致 ──

test("node-project 重放：reconcile/cascade/suspend 事件重建 = 在盘 nodes（attempts 保留）；--write 保留顶层 terminal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wave-replay-proj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusPath = join(dir, "plan.status.json");
  // 事件流 = 引擎收敛后每笔翻转的落盘形态（statusUpdate 构造：注册事件名 + payload 结构化字段）；
  // nodes = 引擎翻转后的在盘形态。attempts 语义是本测试的核心断言（F5：级联失效不归零）
  const events = [
    { seq: 1, node: "U1", event: "begin", detail: "" },
    { seq: 2, node: "U1", event: "finish-done", detail: "核验通过；commit=aaa1111", payload: { commit: "aaa1111", evidence: "核验通过" } },
    { seq: 3, node: "U2", event: "begin", detail: "" },
    { seq: 4, node: "U2", event: "finish-done", detail: "核验通过；commit=bbb2222", payload: { commit: "bbb2222", evidence: "核验通过" } },
    { seq: 5, node: "U2", event: "cascade-reset", detail: "级联失效：依赖的单元被对账回 pending——回 pending（attempts 保留，修复环计数不丢）" },
    { seq: 6, node: "U3", event: "reconcile-done", detail: "恢复对账：git log 反查命中本单元 commit，按 git 为准补写 done", payload: { commit: "ccc3333", evidence: "恢复对账：命中" } },
    // U4 前置历史（重放从零起算——在盘 attempts=1 的 done 必有 begin/finish-done 事件背书）
    { seq: 7, node: "U4", event: "begin", detail: "" },
    { seq: 8, node: "U4", event: "finish-done", detail: "核验通过；commit=ddd4444", payload: { commit: "ddd4444", evidence: "核验通过" } },
    { seq: 9, node: "U4", event: "reconcile-pending", detail: "恢复对账：status done 但 commit 不在 git 对象库，按 git 为准回 pending（attempts 保留）" },
    { seq: 10, node: "U4", event: "suspend", detail: "终局挂起：本 run 未派发的节点落 suspended（attempts 保留）" },
    { seq: 11, node: "U5", event: "suspend", detail: "终局挂起：本 run 未派发的节点落 suspended（attempts 保留）" },
  ];
  const nodes = {
    U1: { status: "done", attempts: 1, commit: "aaa1111" },
    U2: { status: "pending", attempts: 1 },
    U3: { status: "done", attempts: 1, commit: "ccc3333" },
    U4: { status: "suspended", attempts: 1 },
    U5: { status: "suspended", attempts: 0 },
  };
  writeFileSync(
    statusPath,
    `${JSON.stringify({ baseline: "b0", runId: "rid1", terminal: { terminated: "blocked", done: 1, blocked: 0, skipped: 2, residualFiles: ["x.txt"] }, nodes, events }, null, 2)}\n`,
  );
  const replay = runCore(["node-project", "--status", statusPath]);
  assert.equal(replay.status, 0, `node-project 应成功：${replay.stderr}`);
  const report = JSON.parse(replay.stdout.slice(replay.stdout.indexOf("{")));
  assert.equal(report.consistent, true, `重放应与在盘 nodes 一致：${JSON.stringify(report.mismatches)}`);
  assert.deepEqual(report.mismatches, []);
  // --write 重写 nodes 后顶层 terminal 原样保留（F7 选顶层字段的投影一致性依据）
  const writeRes = runCore(["node-project", "--status", statusPath, "--write"]);
  assert.equal(writeRes.status, 0, `node-project --write 应成功：${writeRes.stderr}`);
  const after = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.deepEqual(after.terminal, { terminated: "blocked", done: 1, blocked: 0, skipped: 2, residualFiles: ["x.txt"] }, "顶层 terminal 字段不被重投影抹除");
  assert.deepEqual(after.nodes.U2, { status: "pending", attempts: 1 }, "重放重建：cascade-reset 后 attempts 保留（不归零）");
  assert.deepEqual(after.nodes.U4, { status: "suspended", attempts: 1 }, "重放重建：reconcile-pending + suspend 后 attempts 保留");
});

// ── 4. cascade-reset 内核对拍 ──

test("cascade-reset 对拍：四种来源态经内核 dry-run 与本地表同判（attempts 保留）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wave-replay-cascade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusPath = join(dir, "plan.status.json");
  for (const from of ["done", "in-progress", "blocked", "failed"]) {
    const current = { status: from, attempts: 3 };
    const local = computeNodeTransition(current, "cascade-reset");
    assert.ok(local.ok, `本地表应放行 cascade-reset from ${from}`);
    assert.equal(local.to, "pending", `cascade-reset from ${from} 目标态 pending`);
    assert.equal(local.entry.attempts, 3, `cascade-reset from ${from} attempts 保留（F5：归零即 V4 缺陷复辟）`);
    writeFileSync(statusPath, `${JSON.stringify({ baseline: "b", nodes: { n1: current }, events: [] }, null, 2)}\n`);
    const dry = runCore(["node-transition", "--dry-run", "--status", statusPath, "--node", "n1", "--event", "cascade-reset"]);
    assert.equal(dry.status, 0, `内核应放行 cascade-reset from ${from}：${dry.stderr}`);
    const decision = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("{")));
    assert.equal(decision.to, "pending");
    assert.equal(decision.entry.attempts, 3, `内核 cascade-reset from ${from} attempts 保留`);
  }
  // pending 态不接受 cascade-reset（无此边——pending 本就是待派发态）
  const localPending = computeNodeTransition({ status: "pending", attempts: 1 }, "cascade-reset");
  assert.equal(localPending.ok, false, "pending 态不接受 cascade-reset");
});

// ── 5. 产物级词表守卫 ──

test("wave-executor-v6 产物词表：无 node:\"-\" 事件写、无词表外事件名；终局事实走顶层 terminal；D1 尝试账接线在位", () => {
  // 钉「事件发射形态」（event: '<名>' / event: "<名>"）而非裸词名——注释里解释收敛背景的
  // 历史名不构成发射；本守卫防的是有人把词表外事件加回事件流
  const forbidden = ["reconcile-reset", "reconcile-warn", "run-terminal", "commit-deferred-list", "residual-files", "pre-existing-files"];
  for (const name of forbidden) {
    assert.ok(!PI.includes(`event:'${name}'`) && !PI.includes(`event: '${name}'`) && !PI.includes(`event: "${name}"`), `产物不得再发射词表外事件 ${name}（F4/F7 收敛回归锚）`);
  }
  assert.ok(!PI.includes("node: '-'") && !PI.includes('node: "-"'), "产物不得再以 node:\"-\" 写事件（F7）");
  assert.ok(PI.includes('event: "suspend"'), "终局挂起必须追加 suspend 注册事件（F6）");
  assert.ok(PI.includes(", terminal }") || PI.includes("terminal,"), "终局事实改存顶层 terminal 字段（F7）");
  assert.ok(PI.includes('"--loop"') && PI.includes('"d1"'), "D1 wave 尝试账接线（loop-attempt --loop d1）应在位");
  assert.ok(PI.includes("RECONCILE_VERIFY"), "恢复对账走只读核验器（F4）");
});

// ── 6. D1 尝试账键形（CLI 侧）──

test("loop-attempt --loop d1 落账 + loop-budget 对 d1 如实返回未接入判定（cap=null）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wave-replay-d1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(home);
  git(projectDir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: projectDir });
  git(projectDir, ["commit", "-qm", "init"]);
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "D1 尝试账键形测试\n");
  const init = runGateCli(["init", "--project-root", projectDir, "--task-id", "d1-attempt", "--intent-file", intentPath], home);
  assert.equal(init.status, 0, `gate init 应成功：${init.stderr}`);
  const taskDir = JSON.parse(init.stdout.slice(init.stdout.indexOf("{"))).taskDir;
  const attempt = (args) => runCore(["loop-attempt", "--task-dir", taskDir, "--loop", "d1", "--path", "workflow", "--run-id", "r1", "--round", "1", ...args]);
  const started = attempt(["--event", "started"]);
  assert.equal(started.status, 0, `loop-attempt --loop d1 started 应成功：${started.stderr}`);
  const finished = attempt(["--event", "finished", "--outcome", "failed"]);
  assert.equal(finished.status, 0, `loop-attempt --loop d1 finished 应成功：${finished.stderr}`);
  const rows = readFileSync(join(taskDir, "loop-attempts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.loop), ["d1", "d1"], "落账 loop 名 = d1（键名与账本词表一致）");
  assert.deepEqual(rows.map((r) => r.event), ["started", "finished"]);
  assert.deepEqual(rows.map((r) => r.attemptKey), ["r1:1", "r1:1"], "attemptKey = runId:round（重放幂等键）");
  assert.equal(rows[1].outcome, "failed", "finished 携带结果（D1 失败轮 = failed）");
  const budget = runCore(["loop-budget", "--task-dir", taskDir, "--loop", "d1"]);
  assert.equal(budget.status, 0, `loop-budget --loop d1 应成功：${budget.stderr}`);
  const budgetOut = JSON.parse(budget.stdout.slice(budget.stdout.indexOf("{")));
  assert.equal(budgetOut.cap, null, "d1 未接入判定上限：如实返回 cap=null（只登记不判定，§8.2 已知缺口）");
  assert.equal(budgetOut.exceeded, false, "未接入上限的循环不判超限");
  assert.equal(budgetOut.started, 1, "预算按 started 计数");
});
