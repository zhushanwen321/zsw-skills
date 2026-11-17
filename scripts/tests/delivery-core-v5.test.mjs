// delivery-core-v5.test.mjs — 交付事务内核（delivery-core）测试
//
// 覆盖（设计文档 /tmp/delivery-core-state-machine-design.md 的验证体系落地）：
//   1. 转移表静态校验：合法表通过；六类建模错误（不可达/无标记环/重复转移/未知谓词/
//      未知角色/死端）逐一被抓——「顺序矛盾在定义期被机器检出」的回归
//   2. kernel-judgments 单源库：open 集（raise/resolve/reaffirm/版本过滤/继承发现）、
//      探索 due、修复轮预算（behavior/offLoop/跨 run）、定级改判统计
//   3. CLI 判定命令（真实任务夹具）：open-findings / repair-budget / pending 实体
//   4. next 编排链已知答案样例：
//      A. V4 实跑死锁场景——schema2 增量未登记时 explore-only 即合法（不要求
//         ImplementationRecorded 先行）
//      B. must-fix open 时 machineChecks.mustFixOpen>0（D4 登记 requires 不满足）
//      C. 跨 run 保证预算耗尽 → process-failed 停回
//   5. node-transition 对拍：pi 产物提取 computeNodeTransition 与内核 dry-run 同表同口径
//   6. 循环上限常量对拍：T/D/AD 源码内嵌常量 == kernel/rules.json budgets
//
// 运行：node --test scripts/tests/delivery-core-v5.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V5 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v5");
const CORE = join(V5, "scripts", "delivery-core.mjs");
const GATE = join(V5, "scripts", "delivery-gate.mjs");
const RULES = JSON.parse(readFileSync(join(V5, "scripts", "kernel", "rules.json"), "utf8"));
const KERNEL = await import(join(V5, "scripts", "lib", "kernel-judgments.mjs"));

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

// ── 静态校验器：合法表 + 六类建模错误逐一被抓 ──

test("validate：内置五域表通过；六类建模错误被逐条检出", () => {
  ok(runCore(["validate"]));
  const broken = (mutate) => {
    const rules = JSON.parse(JSON.stringify(RULES));
    mutate(rules);
    return validateTable(rules);
  };
  function validateTable(rules) {
    // 复用 core 的校验逻辑：临时改写 rules.json 后跑 CLI 再还原
    const backup = readFileSync(join(V5, "scripts", "kernel", "rules.json"), "utf8");
    try {
      writeFileSync(join(V5, "scripts", "kernel", "rules.json"), JSON.stringify(rules, null, 2));
      const result = runCore(["validate"]);
      return result;
    } finally {
      writeFileSync(join(V5, "scripts", "kernel", "rules.json"), backup);
    }
  }
  const expectError = (mutate, pattern, label) => {
    const result = broken(mutate);
    assert.notEqual(result.status, 0, `${label} 应被检出`);
    assert.match(result.stderr, pattern, `${label} 的报错应可定位`);
  };
  expectError((r) => { r.domains.task.states.push("ghost-island"); }, /不可达/, "无入边状态不可达");
  expectError((r) => { delete r.domains.node.transitions.find((t) => t.event === "reconcile-pending").backedge; }, /无 backedge 标记的环/, "撕掉回边标记后成环被检出");
  expectError((r) => {
    const t = r.domains.node.transitions.find((x) => x.event === "begin");
    r.domains.node.transitions.push({ ...t, event: "begin-dup", executor: "另一个执行器" });
  }, /重复定义同一 \(from,to\)/, "同一 (from,to) 双转移");
  expectError((r) => { r.domains.task.transitions[0].requires = ["不存在的谓词"]; }, /谓词 .* 不在词表/, "未知谓词");
  expectError((r) => { r.domains.task.transitions[0].actor = "hacker"; }, /actor .* 不在角色词表/, "未知角色");
  expectError((r) => {
    r.domains.task.states.push("orphan-mid");
    const t = { ...r.domains.task.transitions[0] };
    t.from = "orphan-mid"; t.to = "acceptance-drafting";
    r.domains.task.transitions.push(t);
  }, /不可达/, "新状态只出不入不可达");
  expectError((r) => {
    r.domains.node.states.push("dead-end-state");
    const t = { ...r.domains.node.transitions[0] };
    t.from = "pending"; t.to = "dead-end-state";
    r.domains.node.transitions.push(t);
  }, /死端/, "无出边死端");
  ok(runCore(["validate"]));
});

// ── kernel-judgments 单源库 ──

test("openFindingsFromEvents：raise/resolve/reaffirm/版本过滤/继承发现", () => {
  const v = 1;
  const records = [
    { type: "AcceptanceApproved", acceptanceVersion: v, seq: 1 },
    { type: "FindingRaised", acceptanceVersion: v, seq: 2, findingId: "F-1", summary: "缺陷一", category: "defect", severity: "blocker", requirementIds: ["R1"] },
    { type: "FindingRaised", acceptanceVersion: 0, seq: 3, findingId: "F-old", summary: "旧版本发现", category: "defect", severity: "blocker", requirementIds: [] },
    { type: "FindingResolved", acceptanceVersion: v, seq: 4, findingId: "F-1", revision: "rev-a" },
    { type: "ResolutionReaffirmed", acceptanceVersion: v, seq: 5, findingId: "F-1", revision: "rev-b" },
    { type: "FindingRaised", acceptanceVersion: v, seq: 6, findingId: "F-2", summary: "缺陷二", category: "boundary", severity: "non-blocker", requirementIds: ["R2"] },
  ];
  // rev-a 上 F-1 已解决；rev-b 上旧解决失效但 reaffirm 关闭
  let result = KERNEL.openFindingsFromEvents(records, { revision: "rev-b", acceptanceVersion: v });
  assert.deepEqual([...result.openIds], ["F-2"], "rev-b：F-1 被 reaffirm 关闭、F-2 open、F-old 被版本过滤");
  // rev-c 上 reaffirm 失效 → F-1 重新 open
  result = KERNEL.openFindingsFromEvents(records, { revision: "rev-c", acceptanceVersion: v });
  assert.deepEqual([...result.openIds].sort(), ["F-1", "F-2"], "rev-c：F-1 重开");
  // 继承发现（任务替换 prepare，任务级 acceptanceVersion=0 不做版本过滤）
  const withInherited = [
    ...records,
    { type: "TaskSuperseded", phase: "prepare", acceptanceVersion: 0, seq: 7, actor: "user", revision: "rev-c", inheritedFindings: [{ findingId: "F-KEEP", category: "defect", severity: "blocker", requirementIds: [] }] },
  ];
  result = KERNEL.openFindingsFromEvents(withInherited, { revision: "rev-c", acceptanceVersion: v });
  assert.ok(result.openIds.has("F-KEEP"), "继承发现参与 open 集");
});

test("explorationDue：无探索 due；判据变化晚于探索 due；探索新于判据不 due", () => {
  const approvals = [{ type: "AcceptanceApproved", seq: 2 }, { type: "DesignApproved", seq: 4 }];
  const none = KERNEL.explorationDue(approvals, []);
  assert.equal(none.due, true, "无可用探索 due");
  const stale = KERNEL.explorationDue(approvals, [{ type: "ExplorationCompleted", seq: 3, eventId: "e1" }]);
  assert.equal(stale.due, true, "判据变化（seq4）晚于探索（seq3）due");
  const fresh = KERNEL.explorationDue(approvals, [{ type: "ExplorationCompleted", seq: 5, eventId: "e1" }]);
  assert.equal(fresh.due, false, "探索新于判据不 due");
  const atSeq = KERNEL.explorationDue(approvals, [{ type: "ExplorationCompleted", seq: 5, eventId: "e1" }], { atSeq: 4 });
  assert.equal(atSeq.due, true, "历史时点（seq4 时）判定 due");
});

test("repairBudgetFromEvents：behavior 计轮 / environment 不计 / offLoop 修订 / 跨 run", () => {
  const base = [
    { type: "AssuranceCompleted", seq: 1 },
    { type: "RepairRoundRecorded", seq: 2, round: 1 },
    { type: "RepairRoundRecorded", seq: 3, round: 2, nature: "environment" },
    { type: "DesignApproved", seq: 4 },
    { type: "RepairRoundRecorded", seq: 5, round: 3 },
    { type: "AcceptanceApproved", seq: 6 },
    { type: "AssuranceCompleted", seq: 7 },
  ];
  const budget = KERNEL.repairBudgetFromEvents(base);
  assert.equal(budget.behaviorRepairRounds, 2, "environment 轮不计");
  assert.equal(budget.offLoopRevisions, 2, "首次保证后的方案与验收修订各计一轮");
  assert.equal(budget.perVersionUsed, 4, "合计 = 2 behavior + 2 off-loop");
  assert.equal(budget.perVersionCap, 3);
  assert.equal(budget.nextBehaviorRoundAllowed, false, "已超 3 轮上限，下一轮不允许");
  assert.equal(budget.assuranceRuns, 2);
  assert.equal(budget.crossRunUsed, 6, "跨 run = 保证 2 次 + 轮 4");
  assert.equal(budget.crossRunExceeded, false, "6 = 上限未超（>6 才耗尽）");
  const exceeded = KERNEL.repairBudgetFromEvents([...base, { type: "AssuranceCompleted", seq: 8 }]);
  assert.equal(exceeded.crossRunExceeded, true, "第 3 次保证 run 跨 run 预算耗尽");
});

test("findingRegrades：同根多组定级超上限被熔断；同组 reopen 不触发", () => {
  const records = [
    { type: "FindingRaised", seq: 1, findingId: "F-1", category: "defect", severity: "blocker" },
    { type: "FindingRaised", seq: 2, findingId: "F-1b", reopenOf: "F-1", category: "defect", severity: "non-blocker" },
    { type: "FindingRaised", seq: 3, findingId: "F-1c", reopenOf: "F-1", category: "boundary", severity: "non-blocker" },
  ];
  const halted = KERNEL.findingRegrades(records);
  assert.equal(halted.offenders.length, 1, "F-1 根三种定级组合触发熔断");
  assert.equal(halted.offenders[0].root, "F-1");
  const sameGrade = KERNEL.findingRegrades([
    records[0],
    { type: "FindingRaised", seq: 2, findingId: "F-1b", reopenOf: "F-1", category: "defect", severity: "blocker" },
  ]);
  assert.equal(sameGrade.offenders.length, 0, "同组重报（reopen 同定级）不触发");
});

// ── 真实任务夹具：next 样例 + CLI 判定 + pending 实体 ──

function makeFixture(t, { taskId = "core-next" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-core-v5-"));
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

/** schema 2 最小验收包（含断言与反例场景）——对齐 quality 测试夹具形态 */
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
function core(fx, ...args) {
  return runCore(args, fx.home);
}
function evidence(fx, name) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, `# ${name}\n`);
  return `evidence/${name}`;
}

/** 推进到「已批准 + 已确认方案」（implementing 前）——review/approve/design 三连 */
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

test("next 样例 A（V4 死锁场景回归）：schema2 增量未登记时 explore-only 即合法", (t) => {
  const fx = driveToImplementing(t);
  const next = JSON.parse(parseStdout(core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.flowState, "implementing", "增量未登记，任务处于实现段");
  assert.equal(next.machineChecks.schema2, true);
  assert.equal(next.machineChecks.explorationDue, true, "尚无探索，due");
  const exploreEdges = next.legalTransitions.filter((tr) => tr.event === "explore-only");
  assert.ok(exploreEdges.length > 0, "implementing 态必须给出 explore-only 合法转移（V4 死锁点：IA 门禁曾要求先登记实现）");
  assert.ok(exploreEdges.every((tr) => tr.executor.includes("independent-assurance-v5") && tr.executor.includes("explore-only")));
  // 转移的前置不含任何「实现已登记」条件——死锁在结构上不可再表达
  for (const edge of exploreEdges) {
    assert.ok(!edge.requires.includes("allIncrementsImplemented"), "explore-only 前置不得要求增量登记");
  }
});

test("next 样例 B：must-fix open 时 machineChecks 计数 > 0 且预算可见", (t) => {
  const fx = driveToImplementing(t);
  const revText = gate(fx, "revision", "--project-root", fx.projectDir).stdout.trim();
  ok(gate(fx, "append", "--task-dir", fx.taskDir, "--event", JSON.stringify({
    type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: revText, summary: "缺陷",
    findingId: "F-1", category: "defect", severity: "blocker", requirementIds: ["R1"], artifact: evidence(fx, "f-1.md"),
  }), "--credential", fx.creds.assurance), "登记 must-fix");
  const open = JSON.parse(parseStdout(core(fx, "open-findings", "--task-dir", fx.taskDir)));
  assert.deepEqual(open.openIds, ["F-1"]);
  const next = JSON.parse(parseStdout(core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.machineChecks.mustFixOpen, 1, "D4 登记前置（mustFixOpenZero）不满足应可见");
  assert.ok(next.budgets.repair.perVersionCap === 3 && next.budgets.repair.crossRunCap === 6, "预算随 next 报出");
});

test("next 样例 C：跨 run 保证预算耗尽 → evaluate 判 process-failed 且 next 停回", (t) => {
  const fx = driveToImplementing(t);
  // 制造 7 个保证 run（crossRun = runs 7 > 6）：exploration + 证据 + 保证事件 ×7
  const revisionText = (() => {
    const r = gate(fx, "revision", "--project-root", fx.projectDir);
    ok(r);
    return r.stdout.trim();
  })();
  const explorationArtifact = evidence(fx, "exploration-1.md");
  ok(gate(fx, "append", "--task-dir", fx.taskDir, "--event", JSON.stringify({
    type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: revisionText, summary: "探索",
    dimensions: ["smoke"], coverageManifestSha256: sha256("cov"), artifact: explorationArtifact,
  }), "--credential", fx.creds.assurance));
  const evidenceArtifact = evidence(fx, "ev-1.md");
  const evidenceAppend = gate(fx, "append", "--task-dir", fx.taskDir, "--event", JSON.stringify({
    type: "EvidenceRecorded", actor: "assurance", acceptanceVersion: 1, revision: revisionText, summary: "取证",
    requirementId: "R1", kind: "command", result: "verified", artifact: evidenceArtifact,
    artifactSha256: sha256(readFileSync(join(fx.taskDir, evidenceArtifact), "utf8")),
    assertionIds: ["A1"], adversarialFormIds: ["AF1"],
  }), "--credential", fx.creds.assurance);
  ok(evidenceAppend, "证据登记");
  const evidenceEvent = JSON.parse(parseStdout(evidenceAppend));
  const records = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const explorationId = records.find((e) => e.type === "ExplorationCompleted").eventId;
  for (let run = 1; run <= 7; run += 1) {
    const artifact = evidence(fx, `assurance-${run}.md`);
    const result = gate(fx, "append", "--task-dir", fx.taskDir, "--event", JSON.stringify({
      type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 1, revision: revisionText, summary: `保证 ${run}`,
      evidenceEventIds: [evidenceEvent.eventId], coverageManifestSha256: sha256("cov"), explorationEventId: explorationId,
      incrementReceipts: [{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256(`log-${run}`), cwd: fx.projectDir, artifactSha256: sha256(`receipt-${run}`) }],
      cleanBuild: { buildId: `build-${run}`, artifactSha256: sha256(`clean-${run}`) }, artifact,
    }), "--credential", fx.creds.assurance);
    ok(result, `第 ${run} 个保证 run 应可登记`);
  }
  const evaluateResult = gate(fx, "evaluate", "--task-dir", fx.taskDir);
  ok(evaluateResult);
  const verdict = JSON.parse(parseStdout(evaluateResult));
  assert.equal(verdict.state, "process-failed", "跨 run 预算（7>6）应判 process-failed");
  assert.equal(verdict.quality.budgets.assuranceCrossRun.used, 7);
  assert.match(verdict.nextAction, /预算耗尽停回用户/, "nextAction 应指向停回用户");
  const next = JSON.parse(parseStdout(core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.flowState, "process-failed");
  // 终态出边只余通配族（替换/漂移/预算），不得再出现常规推进边（登记实现/发起保证/接受交付）
  const forwardEvents = new Set(["register-implementation", "assurance-start", "explore-only", "accept-risk", "evaluate", "d3-passed", "route-build", "route-design", "acceptance-design-start"]);
  assert.ok(next.legalTransitions.every((tr) => !forwardEvents.has(tr.event)), "process-failed 不得给出常规推进转移");
});

test("pending 实体：add/list/resolve 往返；next 优先回答待办", (t) => {
  const fx = makeFixture(t);
  ok(core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "awaiting-restore", "--note", "额度中断，恢复后先补登记 increments"));
  ok(core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "cleanup", "--note", "善后：清理临时探针"));
  const list = JSON.parse(parseStdout(core(fx, "pending", "list", "--task-dir", fx.taskDir)));
  assert.equal(list.open.length, 2);
  const next = JSON.parse(parseStdout(core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.pendingActions.length, 2, "next 输出待办优先");
  assert.equal(next.pendingActions[0].kind, "awaiting-restore");
  ok(core(fx, "pending", "resolve", "--task-dir", fx.taskDir, "--id", "pa-1", "--outcome", "已补登记"));
  const after = JSON.parse(parseStdout(core(fx, "pending", "list", "--task-dir", fx.taskDir)));
  assert.equal(after.open.length, 1);
  assert.equal(after.resolved.length, 1);
  const badKind = core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "unknown", "--note", "x");
  assert.notEqual(badKind.status, 0, "非法 kind 应被拒");
});

// ── node-transition 对拍：pi 产物提取 vs 内核 dry-run ──

test("node-transition 对拍：wave-executor 本地表与内核同表同口径（随机序列差分）", () => {
  const piProduct = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/pi/wave-executor-v5.js"), "utf8");
  const tableMatch = /const NODE_TRANSITIONS[^;]+;/s.exec(piProduct);
  const fnMatch = /function computeNodeTransition\([\s\S]*?\n}/.exec(piProduct);
  assert.ok(tableMatch && fnMatch, "pi 产物应含 NODE_TRANSITIONS 与 computeNodeTransition（提取对拍前提）");
  const localCompute = new Function(`${tableMatch[0]}\n${fnMatch[0]}\nreturn computeNodeTransition;`)();
  const events = ["begin", "finish-done", "block", "fail", "reset", "suspend", "resume", "reconcile-done", "reconcile-pending", "manual-disposition"];
  const startStates = ["pending", "in-progress", "done", "blocked", "failed", "suspended"];
  let compared = 0;
  let seed = 42;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 60; i += 1) {
    let current = { status: startStates[rand(startStates.length)], attempts: rand(4) };
    for (let step = 0; step < 6; step += 1) {
      const eventName = events[rand(events.length)];
      const local = localCompute(current, eventName);
      const payloadArgs = [];
      if (eventName === "finish-done" || eventName === "reconcile-done") payloadArgs.push("--commit", "abc1234");
      if (eventName === "block" || eventName === "fail") payloadArgs.push("--reason", "测试原因");
      if (eventName === "manual-disposition") payloadArgs.push("--basis", "测试处置依据");
      const coreResult = spawnSync(process.execPath, [CORE, "node-transition", "--dry-run", "--status", "/dev/null", "--node", "n1", "--event", eventName, ...payloadArgs, "--current-json", JSON.stringify(current)], { encoding: "utf8", timeout: 30_000 });
      if (local.ok) {
        const coreDecision = JSON.parse(coreResult.stdout);
        assert.ok(coreDecision.ok, `内核应同样放行：${eventName} from ${current.status}`);
        assert.equal(coreDecision.to, local.to, `${eventName} from ${current.status} 目标态一致`);
        assert.equal(coreDecision.entry.attempts, local.entry.attempts, `${eventName} from ${current.status}(attempts=${current.attempts}) attempts 一致`);
        current = coreDecision.entry;
      } else {
        assert.notEqual(coreResult.status, 0, `内核应同样拒绝：${eventName} from ${current.status}`);
        assert.match(coreResult.stderr, /不接受事件/, "拒绝报错应指向转移表");
        current = { status: startStates[rand(startStates.length)], attempts: rand(4) };
      }
      compared += 1;
    }
  }
  assert.ok(compared >= 300, `对拍样本应足够（实际 ${compared}）`);
});

test("node-transition 落盘形态：manual-disposition 带 basis 留痕；非法转移拒绝写", (t) => {
  const root = mkdtempSync(join(tmpdir(), "node-trans-v5-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, "plan.status.json");
  writeFileSync(statusPath, `${JSON.stringify({ name: "p", baseline: "b", nodes: { n1: { status: "blocked", attempts: 2, reason: "依赖缺失" } }, events: [] })}\n`);
  const bad = spawnSync(process.execPath, [CORE, "node-transition", "--status", statusPath, "--node", "n1", "--event", "manual-disposition"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "manual-disposition 缺 basis 应被拒");
  assert.match(bad.stderr, /--basis/);
  const applied = spawnSync(process.execPath, [CORE, "node-transition", "--status", statusPath, "--node", "n1", "--event", "manual-disposition", "--basis", "阻塞原因已消除：依赖已合入（commit abc123）"], { encoding: "utf8" });
  ok(applied);
  const after = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(after.nodes.n1.status, "done");
  assert.equal(after.nodes.n1.attempts, 2, "人工处置保留 attempts");
  assert.match(after.nodes.n1.evidence, /人工处置：阻塞原因已消除/);
  assert.equal(after.events.at(-1).event, "manual-disposition");
  const illegal = spawnSync(process.execPath, [CORE, "node-transition", "--status", statusPath, "--node", "n1", "--event", "begin"], { encoding: "utf8" });
  assert.notEqual(illegal.status, 0, "done 态 begin 非法应被拒");
});

// ── 循环上限常量对拍：workflow 内嵌常量 == rules.json budgets ──

test("循环上限常量对拍：T/D/AD 源码内嵌常量与内核 rules.json 一致", () => {
  const src = (name) => readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/src", name), "utf8");
  const tSrc = src("tech-review-loop-v5.shared.ts");
  const dSrc = src("dev-consistency-loop-v5.shared.ts");
  const adSrc = src("acceptance-design-v5.shared.ts");
  assert.match(tSrc, /rewritesUsed >= (\d+)/);
  assert.equal(new RegExp(/rewritesUsed >= (\d+)/).exec(tSrc)[1], String(RULES.budgets.t2RewriteAttemptCap), "T2 重写上限与 rules.json 一致");
  assert.match(dSrc, /reflowsSoFar >= (\d+)/);
  assert.equal(new RegExp(/reflowsSoFar >= (\d+)/).exec(dSrc)[1], String(RULES.budgets.d2ItemReflowCap), "D2 回流上限与 rules.json 一致");
  assert.match(adSrc, /priorReviewRounds \+ round > (\d+)/);
  assert.equal(new RegExp(/priorReviewRounds \+ round > (\d+)/).exec(adSrc)[1], String(RULES.budgets.acceptanceReReviewRoundCap), "AD 复审预算与 rules.json 一致");
  // 单源验证：ARL 不再有本地轮上限复刻（预算走 delivery-core repair-budget）
  const arlSrc = src("assurance-repair-loop-v5.shared.ts");
  assert.ok(!/\+ 1 > 3/.test(arlSrc), "ARL 源码不得残留本地轮上限复刻");
  assert.ok(arrlUsesCore(arlSrc), "ARL 应经 coreRepairBudget 查询预算");
  function arrlUsesCore(text) {
    return /coreRepairBudget|repair-budget/.test(text);
  }
});
