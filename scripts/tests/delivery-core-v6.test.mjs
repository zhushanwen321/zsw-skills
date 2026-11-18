// delivery-core-v6.test.mjs — 交付事务内核（delivery-core）测试
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
// 运行：node --test scripts/tests/delivery-core-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const RULES = JSON.parse(readFileSync(join(V6, "scripts", "kernel", "rules.json"), "utf8"));
const KERNEL = await import(join(V6, "scripts", "lib", "kernel-judgments.mjs"));

// 进程内调用（模块只加载一次，逐用例毫秒级）：core/gate 垫片与 CLI 走同一分发，
// 返回 { status, stdout, stderr } 与 spawnSync 同口径。core 读 task-dir 定位、不依赖
// HOME；gate 的 HOME 隔离由垫片按调用切换。CLI 进程级语义由文末对拍用例经 spawn 钉住
const GATE_MODULE = await import(pathToFileURL(GATE).href);
const CORE_MODULE = await import(pathToFileURL(CORE).href);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
async function runCore(args) {
  return CORE_MODULE.runCoreCommandInProcess(args);
}
function runGate(args, home) {
  return GATE_MODULE.runGateCommand(args, home);
}
/** spawn 直跑 CLI：仅供防漂移对拍（进程内 vs CLI 一致性），常规用例走 runCore */
function runCoreSpawn(args) {
  return spawnSync(process.execPath, [CORE, ...args], { encoding: "utf8", timeout: 60_000 });
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// ── 静态校验器：合法表 + 六类建模错误逐一被抓 ──

test("validate：内置五域表通过；六类建模错误被逐条检出", async () => {
  ok(await runCore(["validate"]));
  const broken = (mutate) => {
    const rules = JSON.parse(JSON.stringify(RULES));
    mutate(rules);
    return validateTable(rules);
  };
  async function validateTable(rules) {
    // 复用 core 的校验逻辑：临时改写 rules.json 后跑校验再还原。
    // 必须走 spawn：KERNEL_RULES 在 core.mjs 模块顶层读盘固化，进程内改盘不影响已加载
    // 常量，「改坏表被检出」只有在全新进程重新读盘才成立（进程边界语义）
    const backup = readFileSync(join(V6, "scripts", "kernel", "rules.json"), "utf8");
    try {
      writeFileSync(join(V6, "scripts", "kernel", "rules.json"), JSON.stringify(rules, null, 2));
      const result = runCoreSpawn(["validate"]);
      return result;
    } finally {
      writeFileSync(join(V6, "scripts", "kernel", "rules.json"), backup);
    }
  }
  const expectError = async (mutate, pattern, label) => {
    const result = await broken(mutate);
    assert.notEqual(result.status, 0, `${label} 应被检出`);
    assert.match(result.stderr, pattern, `${label} 的报错应可定位`);
  };
  await expectError((r) => { r.domains.task.states.push("ghost-island"); }, /不可达/, "无入边状态不可达");
  // 环标记断言撕「唯一标记边」的环：{pending,in-progress} 环只靠 in-progress 的
  // cascade-reset 一条 backedge 合法（begin 无标记）；done↔pending 环有 reconcile-pending
  // 与 cascade-reset 两条标记边，撕掉任一条环仍合法（检出不了，不是检查失效）
  await expectError((r) => { delete r.domains.node.transitions.find((t) => t.event === "cascade-reset" && t.from === "in-progress").backedge; }, /无 backedge 标记的环/, "撕掉回边标记后成环被检出");
  // 判定唯一性按 (from,event)：同状态同事件两条边 = 查表歧义；同 (from,to) 不同事件
  // （reconcile-pending 与 cascade-reset 共享 done→pending）是合法形态——内置表 validate
  // 绿（本用例末行）即覆盖该正向断言
  await expectError((r) => {
    const t = r.domains.node.transitions.find((x) => x.event === "begin");
    r.domains.node.transitions.push({ ...t, executor: "另一个执行器" });
  }, /重复定义同一 \(from,event\)/, "同一 (from,event) 双转移");
  await expectError((r) => { r.domains.task.transitions[0].requires = ["不存在的谓词"]; }, /谓词 .* 不在词表/, "未知谓词");
  await expectError((r) => { r.domains.task.transitions[0].actor = "hacker"; }, /actor .* 不在角色词表/, "未知角色");
  await expectError((r) => {
    r.domains.task.states.push("orphan-mid");
    const t = { ...r.domains.task.transitions[0] };
    t.from = "orphan-mid"; t.to = "acceptance-drafting";
    r.domains.task.transitions.push(t);
  }, /不可达/, "新状态只出不入不可达");
  await expectError((r) => {
    r.domains.node.states.push("dead-end-state");
    const t = { ...r.domains.node.transitions[0] };
    t.from = "pending"; t.to = "dead-end-state";
    r.domains.node.transitions.push(t);
  }, /死端/, "无出边死端");
  ok(await runCore(["validate"]));
});

// ── kernel-judgments 单源库 ──

test("openFindingsFromEvents：raise/resolve/reaffirm/版本过滤/继承发现", async () => {
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

test("explorationDue：无探索 due；判据变化晚于探索 due；探索新于判据不 due", async () => {
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

test("repairBudgetFromEvents：behavior 计轮 / environment 不计 / offLoop 修订 / 跨 run", async () => {
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

test("findingRegrades：同根多组定级超上限被熔断；同组 reopen 不触发", async () => {
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

test("criterionChangedSinceResolution：解决时验收版本 ≠ 当前 → true；同版本/无解决 → false", async () => {
  const records = [
    { type: "AcceptanceApproved", acceptanceVersion: 1, seq: 1 },
    { type: "FindingRaised", acceptanceVersion: 1, seq: 2, findingId: "F-1" },
    { type: "FindingResolved", acceptanceVersion: 1, seq: 3, findingId: "F-1", revision: "r1" },
    { type: "AcceptanceApproved", acceptanceVersion: 2, seq: 4 },
    { type: "ResolutionReaffirmed", acceptanceVersion: 2, seq: 5, findingId: "F-1", revision: "r2" },
  ];
  assert.equal(
    KERNEL.criterionChangedSinceResolution(records, { findingId: "F-1", currentAcceptanceVersion: 1 }),
    true,
    "最近解决侧事件（v2 重认领）≠ 当前 v1 → 判据已变化（reopen 合法）",
  );
  assert.equal(
    KERNEL.criterionChangedSinceResolution(records, { findingId: "F-1", currentAcceptanceVersion: 2 }),
    false,
    "最近解决发生在当前版本 → 无判据变化依据",
  );
  assert.equal(
    KERNEL.criterionChangedSinceResolution(records.filter((record) => record.type === "FindingResolved"), { findingId: "F-1", currentAcceptanceVersion: 2 }),
    true,
    "仅旧版本（v1）解决、当前 v2 → true",
  );
  assert.equal(
    KERNEL.criterionChangedSinceResolution(records, { findingId: "F-none", currentAcceptanceVersion: 2 }),
    false,
    "无解决侧事件 → false（无解决时点可比，不能凭空宣称判据变化）",
  );
});

// ── 真实任务夹具：next 样例 + CLI 判定 + pending 实体 ──

// 模板仓：每测试进程只构建一次「初始提交仓」，fixture 经 cpSync 复制实例化——git 对象是
// 内容寻址的只读数据，复制保真（实测复制仓 commit/rev-parse 与全新 init 仓行为一致），
// 省掉每 fixture 的 init/add/commit 三连 spawn
let repoTemplateDir = null;
function materializeRepoTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-core-v6-tpl-"));
  mkdirSync(dir, { recursive: true });
  // git 身份经 commit 的 -c 内联（省两次 spawn：模板是全部用例的公共前缀成本）
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFixture(t, { taskId = "core-next" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-core-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
  cpSync(repoTemplateDir, projectDir, { recursive: true });
  mkdirSync(home);
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "关闭后任何路径零写入；开启时行为正常\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

/** 空候选快照（gate §5.1 检查 2：V6 世代新任务无外部契约也必须带 externalContractReview 键，
 * detectionSha256 绑定候选快照内容；无外部候选时生成空候选快照）。形态对齐
 * delivery-gate-v6.test.mjs 同名 helper。返回文件内容 sha256。 */
function writeEmptyCandidateSnapshot(fx, acceptanceVersion) {
  const dir = join(fx.taskDir, "evidence", `acceptance-v${acceptanceVersion}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }, null, 2)}\n`);
  return sha256(readFileSync(path, "utf8"));
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

test("next 样例 A（V4 死锁场景回归）：schema2 增量未登记时 explore-only 即合法", async (t) => {
  const fx = driveToImplementing(t);
  const next = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.flowState, "implementing", "增量未登记，任务处于实现段");
  assert.equal(next.machineChecks.schema2, true);
  assert.equal(next.machineChecks.explorationDue, true, "尚无探索，due");
  const exploreEdges = next.legalTransitions.filter((tr) => tr.event === "explore-only");
  assert.ok(exploreEdges.length > 0, "implementing 态必须给出 explore-only 合法转移（V4 死锁点：IA 门禁曾要求先登记实现）");
  assert.ok(exploreEdges.every((tr) => tr.executor.includes("independent-assurance-v6") && tr.executor.includes("explore-only")));
  // 转移的前置不含任何「实现已登记」条件——死锁在结构上不可再表达
  for (const edge of exploreEdges) {
    assert.ok(!edge.requires.includes("allIncrementsImplemented"), "explore-only 前置不得要求增量登记");
  }
});

test("next 样例 B：must-fix open 时 machineChecks 计数 > 0 且预算可见", async (t) => {
  const fx = driveToImplementing(t);
  const revText = gate(fx, "revision", "--project-root", fx.projectDir).stdout.trim();
  ok(gate(fx, "record-finding", "--task-dir", fx.taskDir,
    "--summary", "缺陷", "--category", "defect", "--severity", "blocker",
    "--requirement-ids", JSON.stringify(["R1"]), "--finding-id", "F-1",
    "--artifact", evidence(fx, "f-1.md"), "--revision", revText,
    "--credential", fx.creds.assurance), "登记 must-fix");
  const open = JSON.parse(parseStdout(await core(fx, "open-findings", "--task-dir", fx.taskDir)));
  assert.deepEqual(open.openIds, ["F-1"]);
  const next = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.machineChecks.mustFixOpen, 1, "D4 登记前置（mustFixOpenZero）不满足应可见");
  assert.ok(next.budgets.repair.perVersionCap === 3 && next.budgets.repair.crossRunCap === 6, "预算随 next 报出");
});

test("next 样例 C：跨 run 保证预算耗尽 → evaluate 判 process-failed 且 next 停回", async (t) => {
  const fx = driveToImplementing(t);
  // 制造 7 个保证 run（crossRun = runs 7 > 6）：exploration + 证据 + 保证事件 ×7
  const revisionText = (() => {
    const r = gate(fx, "revision", "--project-root", fx.projectDir);
    ok(r);
    return r.stdout.trim();
  })();
  const explorationArtifact = evidence(fx, "exploration-1.md");
  ok(gate(fx, "record-exploration", "--task-dir", fx.taskDir,
    "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", explorationArtifact, "--revision", revisionText,
    "--credential", fx.creds.assurance));
  const evidenceArtifact = evidence(fx, "ev-1.md");
  const evidenceAppend = gate(fx, "record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified", "--summary", "取证",
    "--artifact", evidenceArtifact, "--revision", revisionText,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--credential", fx.creds.assurance);
  ok(evidenceAppend, "证据登记");
  const evidenceEvent = JSON.parse(parseStdout(evidenceAppend));
  const records = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const explorationId = records.find((e) => e.type === "ExplorationCompleted").eventId;
  for (let run = 1; run <= 7; run += 1) {
    const artifact = evidence(fx, `assurance-${run}.md`);
    const result = gate(fx, "complete-assurance", "--task-dir", fx.taskDir,
      "--summary", `保证 ${run}`,
      "--evidence-event-ids", JSON.stringify([evidenceEvent.eventId]),
      "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
      "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256(`log-${run}`), cwd: fx.projectDir, artifactSha256: sha256(`receipt-${run}`) }]),
      "--clean-build", JSON.stringify({ buildId: `build-${run}`, artifactSha256: sha256(`clean-${run}`) }),
      "--artifact", artifact, "--revision", revisionText,
      "--credential", fx.creds.assurance);
    ok(result, `第 ${run} 个保证 run 应可登记`);
  }
  const evaluateResult = gate(fx, "evaluate", "--task-dir", fx.taskDir);
  ok(evaluateResult);
  const verdict = JSON.parse(parseStdout(evaluateResult));
  assert.equal(verdict.state, "process-failed", "跨 run 预算（7>6）应判 process-failed");
  assert.equal(verdict.quality.budgets.assuranceCrossRun.used, 7);
  assert.match(verdict.nextAction, /预算耗尽停回用户/, "nextAction 应指向停回用户");
  const next = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.flowState, "process-failed");
  // 终态出边只余通配族（替换/漂移/预算），不得再出现常规推进边（登记实现/发起保证/接受交付）
  const forwardEvents = new Set(["register-implementation", "assurance-start", "explore-only", "accept-risk", "evaluate", "d3-passed", "route-build", "route-design", "acceptance-design-start"]);
  assert.ok(next.legalTransitions.every((tr) => !forwardEvents.has(tr.event)), "process-failed 不得给出常规推进转移");
});

test("next 样例 D（断点①②修复回归）：探索完成未登记 → candidate-explored 可登记；登记后 → implementation-recorded 可保证", async (t) => {
  const fx = driveToImplementing(t);
  const revText = (() => {
    const r = gate(fx, "revision", "--project-root", fx.projectDir);
    ok(r);
    return r.stdout.trim();
  })();
  // 断点①：schema2 探索已完成（due=false）、增量未全登记 → candidate-explored（D4 登记窗口），
  // register-implementation 边在该态输出可达——旧口径恒落 implementing，candidate-explored 永不产出
  ok(gate(fx, "record-exploration", "--task-dir", fx.taskDir,
    "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", evidence(fx, "exploration-d.md"), "--revision", revText,
    "--credential", fx.creds.assurance), "探索登记");
  const nextExplored = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(nextExplored.flowState, "candidate-explored", "探索完成、增量未全登记 = candidate-explored（20 态词表成员恢复产出）");
  assert.equal(nextExplored.machineChecks.explorationDue, false);
  const register = nextExplored.legalTransitions.find((tr) => tr.event === "register-implementation");
  assert.ok(register, "candidate-explored 态必须给出 register-implementation 合法转移");
  assert.equal(register.to, "implementation-recorded");
  assert.match(register.executor, /dev-flow-v6/, "executor 应为 D4 登记（dev-flow-v6）");
  assert.equal(register.actor, "builder");
  assert.deepEqual(register.requires, ["mustFixOpenZero"], "登记边前置 = 无 open must-fix（探索后可登记语义，不挡登记）");
  // 断点②：增量登记后（verdict=candidate 证据缺口常态）→ implementation-recorded 主链态，
  // assurance-start 边可达——旧口径直落 candidate，主链态与该边均不可达
  ok(gate(fx, "record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", evidence(fx, "impl-d.md"),
    "--merge-receipt", JSON.stringify({ fromRevision: revText, toRevision: revText, patchSha256: sha256("p") }),
    "--credential", fx.creds.builder),
    "实现登记");
  const nextRecorded = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(nextRecorded.flowState, "implementation-recorded", "增量全登记、无 open finding、无保证 = implementation-recorded（verdict=candidate 不再短路跳过主链）");
  const assuranceStart = nextRecorded.legalTransitions.find((tr) => tr.event === "assurance-start");
  assert.ok(assuranceStart, "implementation-recorded 态必须给出 assurance-start 合法转移（主链不再只剩 evaluate）");
  assert.equal(assuranceStart.to, "assuring");
  assert.match(assuranceStart.executor, /independent-assurance-v6/);
});

test("pending 实体：add/list/resolve 往返；next 优先回答待办", async (t) => {
  const fx = makeFixture(t);
  ok(await core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "awaiting-restore", "--note", "额度中断，恢复后先补登记 increments"));
  ok(await core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "cleanup", "--note", "善后：清理临时探针"));
  const list = JSON.parse(parseStdout(await core(fx, "pending", "list", "--task-dir", fx.taskDir)));
  assert.equal(list.open.length, 2);
  const next = JSON.parse(parseStdout(await core(fx, "next", "--task-dir", fx.taskDir)));
  assert.equal(next.pendingActions.length, 2, "next 输出待办优先");
  assert.equal(next.pendingActions[0].kind, "awaiting-restore");
  ok(await core(fx, "pending", "resolve", "--task-dir", fx.taskDir, "--id", "pa-1", "--outcome", "已补登记"));
  const after = JSON.parse(parseStdout(await core(fx, "pending", "list", "--task-dir", fx.taskDir)));
  assert.equal(after.open.length, 1);
  assert.equal(after.resolved.length, 1);
  const badKind = await core(fx, "pending", "add", "--task-dir", fx.taskDir, "--kind", "unknown", "--note", "x");
  assert.notEqual(badKind.status, 0, "非法 kind 应被拒");
});

// ── node-transition 对拍：pi 产物提取 vs 内核 dry-run ──

test("node-transition 对拍：wave-executor 本地表与内核同表同口径（随机序列差分）", async () => {
  const piProduct = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/pi/wave-executor-v6.js"), "utf8");
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
      // --dry-run 只读判定（不写盘、无 HOME 依赖），进程内垫片与 CLI 同口径
      const coreResult = await runCore(["node-transition", "--dry-run", "--status", "/dev/null", "--node", "n1", "--event", eventName, ...payloadArgs, "--current-json", JSON.stringify(current)]);
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

test("node-transition 落盘形态：manual-disposition 带 basis 留痕；非法转移拒绝写", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "node-trans-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, "plan.status.json");
  writeFileSync(statusPath, `${JSON.stringify({ name: "p", baseline: "b", nodes: { n1: { status: "blocked", attempts: 2, reason: "依赖缺失" } }, events: [] })}\n`);
  const bad = await runCore(["node-transition", "--status", statusPath, "--node", "n1", "--event", "manual-disposition"]);
  assert.notEqual(bad.status, 0, "manual-disposition 缺 basis 应被拒");
  assert.match(bad.stderr, /--basis/);
  const applied = await runCore(["node-transition", "--status", statusPath, "--node", "n1", "--event", "manual-disposition", "--basis", "阻塞原因已消除：依赖已合入（commit abc123）"]);
  ok(applied);
  const after = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(after.nodes.n1.status, "done");
  assert.equal(after.nodes.n1.attempts, 2, "人工处置保留 attempts");
  assert.match(after.nodes.n1.evidence, /人工处置：阻塞原因已消除/);
  assert.equal(after.events.at(-1).event, "manual-disposition");
  const illegal = await runCore(["node-transition", "--status", statusPath, "--node", "n1", "--event", "begin"]);
  assert.notEqual(illegal.status, 0, "done 态 begin 非法应被拒");
});

test("cascade-reset：done/in-progress/blocked/failed 退回 pending 且 attempts 保留；pending 不接受；重放视图一致", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cascade-reset-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, "plan.status.json");
  writeFileSync(statusPath, `${JSON.stringify({ name: "p", baseline: "b", nodes: {}, events: [] })}\n`);
  const apply = async (node, event, extra = []) => runCore(["node-transition", "--status", statusPath, "--node", node, "--event", event, ...extra]);
  // n2 造出 attempts=2 的 in-progress（begin→block→reset→begin），级联重置后计数不得归零
  ok(await apply("n1", "begin"));
  ok(await apply("n1", "finish-done", ["--commit", "abc123"]));
  ok(await apply("n2", "begin"));
  ok(await apply("n2", "block", ["--reason", "依赖缺失"]));
  ok(await apply("n2", "reset"));
  ok(await apply("n2", "begin"));
  ok(await apply("n3", "begin"));
  ok(await apply("n3", "block", ["--reason", "依赖缺失"]));
  ok(await apply("n4", "begin"));
  ok(await apply("n4", "fail", ["--reason", "断言红"]));
  for (const [node, fromStatus] of [["n1", "done"], ["n2", "in-progress"], ["n3", "blocked"], ["n4", "failed"]]) {
    const reset = await apply(node, "cascade-reset");
    ok(reset, `${fromStatus} 态 cascade-reset 应放行`);
    const decision = JSON.parse(parseStdout(reset));
    assert.equal(decision.to, "pending", `${fromStatus} 态级联重置应退回 pending`);
    assert.equal(decision.entry.attempts, node === "n2" ? 2 : 1, `${fromStatus} 态级联重置 attempts 保留（级联失效不归零）`);
  }
  const fromPending = await apply("n5", "cascade-reset");
  assert.notEqual(fromPending.status, 0, "pending 态不接受 cascade-reset（无该出发边）");
  // 事件重放视图一致：cascade-reset 在派生视图重建中与转移入口同口径（projectNodeEvents 分支）
  const projection = JSON.parse(parseStdout(await runCore(["node-project", "--status", statusPath])));
  assert.equal(projection.consistent, true, "含 cascade-reset 的事件流重放视图应与在盘 nodes 一致");
  assert.equal(projection.partialEvents, 0, "cascade-reset 无 payload（不产生 partial 事件）");
});

// ── 循环上限常量对拍：workflow 内嵌常量 == rules.json budgets ──

test("循环上限常量对拍：T/D/AD 源码内嵌常量与内核 rules.json 一致", async () => {
  const src = (name) => readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/src", name), "utf8");
  const tSrc = src("tech-review-loop-v6.shared.ts");
  const dSrc = src("dev-consistency-loop-v6.shared.ts");
  const adSrc = src("acceptance-design-v6.shared.ts");
  assert.match(tSrc, /rewritesUsed >= (\d+)/);
  assert.equal(new RegExp(/rewritesUsed >= (\d+)/).exec(tSrc)[1], String(RULES.budgets.t2RewriteAttemptCap), "T2 重写上限与 rules.json 一致");
  assert.match(dSrc, /reflowsSoFar >= (\d+)/);
  assert.equal(new RegExp(/reflowsSoFar >= (\d+)/).exec(dSrc)[1], String(RULES.budgets.d2ItemReflowCap), "D2 回流上限与 rules.json 一致");
  // AD 复审预算语义升级（设计 §8.1）：不再内嵌轮上限常量按成功事件数预判——改经
  // delivery-core loop-budget 按 started 尝试记录判定（打回/校验失败/中断均计入），
  // 上限键映射在 kernel-judgments.LOOP_BUDGET_CAP_KEYS 单源对拍本表
  assert.ok(!/priorReviewRounds \+ round > \d+/.test(adSrc), "AD 源码不得残留本地轮上限复刻");
  assert.ok(/loop-budget/.test(adSrc) && /loop-attempt/.test(adSrc), "AD 复审预算应经 core loop-budget 判定、尝试经 loop-attempt 登记");
  assert.equal(KERNEL.LOOP_BUDGET_CAP_KEYS["acceptance-review"], "acceptanceReReviewRoundCap", "验收复审预算键映射与 rules.json 一致");
  assert.equal(RULES.budgets.acceptanceReReviewRoundCap, 6, "验收复审尝试上限取值保持内核登记值");
  // 改判熔断上限（T2 分级改判 / D2 定性改判共用一档）
  assert.match(tSrc, /AGGREGATE_REGRADE_HALT = (\d+)/);
  assert.equal(new RegExp(/AGGREGATE_REGRADE_HALT = (\d+)/).exec(tSrc)[1], String(RULES.budgets.aggregateRegradeHalt), "T2 改判熔断上限与 rules.json 一致");
  assert.match(dSrc, /AGGREGATE_REGRADE_HALT = (\d+)/);
  assert.equal(new RegExp(/AGGREGATE_REGRADE_HALT = (\d+)/).exec(dSrc)[1], String(RULES.budgets.aggregateRegradeHalt), "D2 改判熔断上限与 rules.json 一致");
  // 单源验证：ARL 不再有本地轮上限复刻（预算走 delivery-core repair-budget）
  const arlSrc = src("assurance-repair-loop-v6.shared.ts");
  assert.ok(!/\+ 1 > 3/.test(arlSrc), "ARL 源码不得残留本地轮上限复刻");
  assert.ok(arrlUsesCore(arlSrc), "ARL 应经 coreRepairBudget 查询预算");
  function arrlUsesCore(text) {
    return /coreRepairBudget|repair-budget/.test(text);
  }
});

// ── eventDomains ↔ gate EVENT_SCHEMAS 词表对账（双源防漂移：gate 事件词表全覆盖）──

test("eventDomains 对账：gate 全部事件类型都有目标域；意图命令组覆盖全部执行器事件类型", async () => {
  const gateSrc = readFileSync(GATE, "utf8");
  const schemaBlock = gateSrc.slice(gateSrc.indexOf("const EVENT_SCHEMAS = {"), gateSrc.indexOf("};", gateSrc.indexOf("const EVENT_SCHEMAS = {")));
  const gateTypes = [...schemaBlock.matchAll(/^  ([A-Za-z]+): \{$/gm)].map((m) => m[1]);
  assert.ok(gateTypes.length >= 19, `应提取到至少 19 个事件类型（实际 ${gateTypes.length}——提取失败须修测试正则）`);
  const domainTypes = new Set(Object.values(RULES.eventDomains).flat());
  const uncovered = gateTypes.filter((t) => !domainTypes.has(t));
  assert.deepEqual(uncovered, [], "gate 每个事件类型必须登记在 eventDomains（未覆盖即写入矩阵盲区）");
  // 事件词表文档对拍（设计 §3 事实事件唯一权威）：state-and-events.md 声明的计数与
  // 表行必须与 gate EVENT_SCHEMAS 键集一致——文档漏登记新事件即在此红灯
  const docText = readFileSync(join(V6, "references", "state-and-events.md"), "utf8");
  const docCount = /## 事件词表（(\d+) 类）/.exec(docText);
  assert.ok(docCount, "state-and-events.md 应有「事件词表（N 类）」标题");
  assert.equal(Number(docCount[1]), gateTypes.length, `文档事件词表计数（${docCount[1]}）应与 gate EVENT_SCHEMAS 键数（${gateTypes.length}）一致`);
  const vocabSection = docText.slice(docText.indexOf("## 事件词表"), docText.indexOf("## 失效范围"));
  const docRows = [...vocabSection.matchAll(/^\| ([A-Za-z]+) \|/gm)].map((m) => m[1]);
  assert.deepEqual([...docRows].sort(), [...gateTypes].sort(), "文档事件词表表行应与 EVENT_SCHEMAS 键集一一对应");
  // 意图命令组（执行器事件）与 workflow 迁移后零 append 残留
  const intentTypes = [...gateSrc.matchAll(/type: "([A-Za-z]+)",\n\s+role:/g)].map((m) => m[1]);
  const executorEventTypes = ["ImplementationRecorded", "RepairRoundRecorded", "FindingRaised", "FindingResolved", "ResolutionReaffirmed", "EvidenceRecorded", "ExplorationCompleted", "AssuranceCompleted", "AssuranceRevisionDrift"];
  assert.deepEqual([...intentTypes].sort(), [...executorEventTypes].sort(), "意图命令组应恰好覆盖 9 类执行器事件");
  for (const name of ["candidate-build-v6", "independent-assurance-v6", "assurance-repair-loop-v6"]) {
    const workflowSrc = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/src", `${name}.shared.ts`), "utf8");
    assert.ok(!/\["append",/.test(workflowSrc), `${name} 不得残留手工 append 通道（意图提交唯一）`);
  }
});

// ── guardrails 键集对拍：gate 源码读取的护栏键必须在 rules.json 显式登记 ──

test("guardrails 对拍：gate 源码读取的 guardrails 键在 rules.json 均已登记", async () => {
  const gateSrc = readFileSync(GATE, "utf8");
  const readKeys = [...new Set([...gateSrc.matchAll(/KERNEL_RULES\.guardrails\.([A-Za-z]+)/g)].map((m) => m[1]))];
  assert.ok(readKeys.length >= 3, `gate 源码应读取多个 guardrails 键（实际 ${readKeys.length}：${readKeys.join("、")}——提取失败须修测试正则）`);
  const registered = new Set(Object.keys(RULES.guardrails).filter((key) => key !== "//"));
  const missing = readKeys.filter((key) => !registered.has(key));
  assert.deepEqual(missing, [], "gate 读取的 guardrails 键必须在 rules.json 显式登记——未登记的键靠「缺省启用」兜底，失去显式管理");
});

// ── 写入矩阵：角色 × 目标域拒绝清单（意图命令经 appendEvent 统一执行）──

test("写入矩阵：builder 写 evidence 域被拒；非法阶段留给矩阵收紧后验证（初始 states=*）", async (t) => {
  const fx = driveToImplementing(t);
  const artifact = join("evidence", "matrix-ev.md");
  writeFileSync(join(fx.taskDir, artifact), "矩阵测试证据\n");
  const denied = runGate(["record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified",
    "--summary", "越权写入", "--artifact", artifact, "--credential", fx.creds.builder], fx.home);
  assert.notEqual(denied.status, 0, "builder 凭据不可写 evidence 域");
  assert.match(denied.stderr, /不可写 evidence 域|必须出示 assurance 凭据/);
  const allowed = runGate(["record-evidence", "--task-dir", fx.taskDir,
    "--requirement-id", "R1", "--kind", "command", "--result", "verified",
    "--summary", "合法写入", "--artifact", artifact,
    "--assertion-ids", JSON.stringify(["A1"]), "--credential", fx.creds.assurance], fx.home);
  ok(allowed, "assurance 凭据写 evidence 域应放行");
  // 事件带 domain 章（写入时盖）
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stamped = events.filter((e) => e.type === "EvidenceRecorded");
  assert.ok(stamped.length > 0 && stamped.every((e) => e.domain === "evidence"), "新写入事件应带 domain=evidence 章");
});

// ── status.json 派生视图：node-project 按事件重算视图 / 篡改检测 / --write 恢复 ──

test("node-project：事件重算视图与在盘一致；篡改被检出；--write 按事件恢复", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "node-project-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, "plan.status.json");
  const apply = async (node, event, extra = []) => runCore(["node-transition", "--status", statusPath, "--node", node, "--event", event, ...extra]);
  writeFileSync(statusPath, `${JSON.stringify({ name: "p", baseline: "b", nodes: {}, events: [] })}\n`);
  ok(await apply("n1", "begin"));
  ok(await apply("n1", "finish-done", ["--commit", "abc123", "--evidence", "单测绿"]));
  ok(await apply("n2", "begin"));
  ok(await apply("n2", "block", ["--reason", "依赖缺失"]));
  ok(await apply("n2", "manual-disposition", ["--basis", "依赖已合入（commit abc123）"]));
  const consistent = JSON.parse(parseStdout(await runCore(["node-project", "--status", statusPath])));
  assert.equal(consistent.consistent, true, "合法写入后派生视图与在盘一致");
  assert.equal(consistent.partialEvents, 0, "node-transition 写的事件带 payload（重算视图零损失）");
  // 篡改：绕过转移入口手改节点状态
  const tampered = JSON.parse(readFileSync(statusPath, "utf8"));
  tampered.nodes.n1.status = "pending";
  tampered.nodes.n1.attempts = 9;
  writeFileSync(statusPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const detected = JSON.parse(parseStdout(await runCore(["node-project", "--status", statusPath])));
  assert.equal(detected.consistent, false, "手工改写 nodes 应被派生视图检出");
  assert.ok(detected.mismatches.some((m) => m.node === "n1"), "n1 的差异应列入 mismatches");
  assert.match(detected.recovery, /node-project.*--write/s, "恢复动作应指向 --write");
  const restored = JSON.parse(parseStdout(await runCore(["node-project", "--status", statusPath, "--write"])));
  assert.equal(restored.written, true);
  const after = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(after.nodes.n1.status, "done", "--write 后以事件为准恢复 done");
  assert.equal(after.nodes.n1.attempts, 1);
  assert.equal(after.nodes.n1.commit, "abc123", "payload 结构化字段随派生视图恢复");
});

// ── 事件时间线读侧合流：交付事件 domain 章 + 过程记录 process 域 ──

test("events 时间线：交付事件与过程记录按 domain 合流输出", async (t) => {
  const fx = driveToImplementing(t);
  writeFileSync(join(fx.taskDir, "process-review.jsonl"), [
    JSON.stringify({ domain: "process", id: "pr-1-u1", ts: "2026-11-17T10:00:00Z", nodeId: "u1", mechanism: "machine-check", verdict: "pass", summary: "机器检查通过", attempts: 1 }),
    JSON.stringify({ domain: "process", id: "pr-2-r1", ts: "2026-11-17T10:05:00Z", nodeId: "r1", mechanism: "behavioral-evidence", verdict: "fail", summary: "机器检查红灯", attempts: 1 }),
  ].join("\n") + "\n");
  const timeline = JSON.parse(parseStdout(await runCore(["events", "--task-dir", fx.taskDir])));
  assert.ok(timeline.counts.acceptance >= 1, "交付事件按 acceptance 域计数");
  assert.equal(timeline.counts.process, 2, "过程记录按 process 域计数");
  assert.ok(timeline.timeline.some((item) => item.source === "process-review" && item.domain === "process"), "时间线应含过程记录条目");
  const onlyProcess = JSON.parse(parseStdout(await runCore(["events", "--task-dir", fx.taskDir, "--domain", "process"])));
  assert.equal(onlyProcess.timeline.length, 2, "--domain 过滤生效");
});

// ── 历史任务回放：真实事件序列 vs 转移表可表达性 ──

test("replay：合成事件序列全可表达；词表外事件被列为不可表达", async (t) => {
  const fx = driveToImplementing(t);
  const revText = runGate(["revision", "--project-root", fx.projectDir]).stdout.trim();
  ok(runGate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", "[\"smoke\"]",
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", evidence(fx, "exp.md"), "--revision", revText, "--credential", fx.creds.assurance], fx.home));
  ok(runGate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", evidence(fx, "impl.md"), "--merge-receipt", JSON.stringify({ fromRevision: revText, toRevision: revText, patchSha256: sha256("p") }), "--credential", fx.creds.builder], fx.home));
  const report = JSON.parse(parseStdout(await runCore(["replay", "--task-dir", fx.taskDir])));
  assert.equal(report.unroutable.length, 0, `合法序列应全可表达（实际：${JSON.stringify(report.unroutable)}）`);
  assert.ok(report.stats.routed + report.stats.decision + report.stats.content > 0);
});

// ── manual-disposition 登记 pending 复盘项（人工通道 = 逃生口不是后门）──

test("manual-disposition 带 --task-dir 时登记待复盘待办", async (t) => {
  const fx = makeFixture(t, { taskId: "md-review" });
  const statusPath = join(fx.taskDir, "plan.status.json");
  writeFileSync(statusPath, `${JSON.stringify({ name: "p", baseline: "b", nodes: { n1: { status: "blocked", attempts: 2, reason: "依赖缺失" } }, events: [] })}\n`);
  const applied = await runCore(["node-transition", "--status", statusPath, "--node", "n1", "--event", "manual-disposition",
    "--basis", "阻塞原因已消除", "--task-dir", fx.taskDir]);
  ok(applied);
  const result = JSON.parse(parseStdout(applied));
  assert.equal(result.reviewRegistered, true, "应登记待复盘待办");
  const pending = JSON.parse(parseStdout(await runCore(["pending", "list", "--task-dir", fx.taskDir])));
  const review = pending.open.find((item) => item.kind === "awaiting-review");
  assert.ok(review, "pending 清单应含 awaiting-review 条目");
  assert.match(review.note, /人工处置复盘：节点 n1/);
  ok(await runCore(["pending", "resolve", "--task-dir", fx.taskDir, "--id", review.id, "--outcome", "复盘完成"]));
});

// ── next 转移分类：裁决点停回 / workflow 预填发起 / --auto 执行 evaluate ──

test("next 转移分类与 launch 预填：workflow 转移带可照抄发起规格", async (t) => {
  const fx = driveToImplementing(t, { taskId: "next-kind" });
  const next = JSON.parse(parseStdout(await runCore(["next", "--task-dir", fx.taskDir])));
  assert.ok(next.legalTransitions.every((tr) => ["adjudication", "gate-command", "workflow", "skill", "engine"].includes(tr.kind)), "每个合法转移都应带 kind 分类");
  const explore = next.legalTransitions.find((tr) => tr.event === "explore-only");
  if (explore !== undefined) {
    assert.equal(explore.kind, "workflow");
    assert.ok(explore.launch, "workflow 转移应带 launch 预填规格");
    assert.equal(explore.launch.args.taskDir, fx.taskDir, "launch args 预填 taskDir");
    assert.equal(explore.launch.args.mode, "explore-only", "mode 从 executor 解析");
  }
});

// ── 防漂移对拍：进程内垫片与 CLI spawn 同输入必须同结果（钉住垫片与 CLI 的一致性）──

test("垫片对拍：rules/validate/未知命令三命令进程内与 CLI spawn 结果逐字段一致", async () => {
  // 三条命令均为只读或纯拒绝路径（无副作用、输出不含路径），同一输入双通道可重放
  const cases = [
    { args: ["rules"], expectStatus: 0 },
    { args: ["validate"], expectStatus: 0 },
    { args: ["no-such-command"], expectStatus: 2 },
  ];
  for (const { args, expectStatus } of cases) {
    const inProcess = await runCore(args);
    const viaCli = runCoreSpawn(args);
    assert.equal(inProcess.status, expectStatus, `预期退出码：${args.join(" ")}\nstderr：${inProcess.stderr}`);
    assert.equal(inProcess.status, viaCli.status, `status 应一致：${args.join(" ")}`);
    assert.equal(inProcess.stdout, viaCli.stdout, `stdout 应逐字节一致：${args.join(" ")}`);
    assert.equal(inProcess.stderr, viaCli.stderr, `stderr 应逐字节一致：${args.join(" ")}`);
  }
});

