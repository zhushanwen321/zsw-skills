// workflow-v4-repair-loop.test.mjs — assurance-repair-loop-v4 主路径执行级冒烟
//
// 覆盖（对应实现：workflows/src/assurance-repair-loop-v4.shared.ts）：
//   1. 修复轮主链真实执行：planner 聚合 → builder 修复并按精确路径提交（真实 git 仓库）
//      → RepairRoundRecorded 登记（含 fromRevision/toRevision）→ reviewer 复核 →
//      FindingResolved → 退出循环；regression 锚点 = explorationHistory TDZ（修复前
//      planner prompt 构造抛 ReferenceError，整轮 assurance-failed）
//   2. 最终取证链：coverage 逐断言结论 → EvidenceRecorded → 增量测试回执（真实执行
//      testCommand）→ AssuranceCompleted(mode=recheck) 引用历史 ExplorationCompleted
//      （引用落在 gate「可用探索集」内：同版本 + artifact 在盘 + 哈希一致；同版本最后
//      一条探索 artifact 失效时 recheck 引用最后一条可用探索，不取原始事件流 .at(-1)）
//   3. full-first 前置门禁：事件流无 full 保证时 setup-failure（先跑 full 才可修复）
//   4. 双平台对拍：zcode 产物（transpile + vm）与 pi 产物（vm + require 注入）主路径
//      终态一致
//
// 运行：node --test scripts/tests/workflow-v4-repair-loop.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
const ts = require("typescript");

const transpile = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

// 产物 transpile 结果按文件路径缓存（同一产物在多个用例中重复执行，源码只读不变）
const transpileCache = new Map();
const transpileFile = (file) => {
  let js = transpileCache.get(file);
  if (js === undefined) {
    js = transpile(readFileSync(file, "utf8"));
    transpileCache.set(file, js);
  }
  return js;
};

const tmpHome = () => mkdtempSync(join(tmpdir(), "v4-repair-loop-"));

// ── 提速通道：产物引擎的 node -e 探针与 node <桩CLI> 进程内等价执行（vm + mock process，
// 与真实 spawn 子进程语义逐字段对齐，见 helper 头注）；sh -c 复合命令与 git 仍走真实
// spawnSync（git 行为是被测语义的一部分）──
import { runNodeScript } from "../helpers/node-stub.mjs";

const fastWorldRun = (home, cmd, a, opts) => {
  const args = a ?? [];
  if (cmd === "node" || cmd === process.execPath) {
    if (args[0] === "-e" && typeof args[1] === "string") {
      const r = runNodeScript(args[1], args.slice(2), { env: { ...process.env, HOME: home }, cwd: home });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    const f = args[0];
    // 桩 CLI（.mjs，CJS 语法）进程内执行；其余 .mjs 回退 spawn
    if (typeof f === "string" && f.endsWith(".mjs") && existsSync(f)) {
      const r = runNodeScript(readFileSync(f, "utf8"), args.slice(1), {
        env: { ...process.env, HOME: home },
        cwd: home,
        scriptPath: f,
      });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    }
  }
  const r = spawnSync(cmd, args, {
    encoding: "utf8", cwd: home, env: { ...process.env, HOME: home },
    timeout: opts && opts.timeoutMs ? opts.timeoutMs : 30000,
  });
  return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** 修复循环脚手架：真实 git 项目 + 任务目录 + 预置事件（full 保证 + 历史探索 + blocker）
 *  + 桩 delivery-gate（evaluate 按 verdicts 队列出参；append 校验凭据与 actor 匹配后
 *  落盘并返回递增 eventId；revision 返回修复后 revision）+ 技能角色文件 */
/** git 模板仓（init + config + a.txt commit 只做一次）：每用例复制副本替代逐用例
 *  6 次 git spawn；withStagedNoise 变体在副本上追加暂存改动（语义与逐用例全新 init 等价） */
let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "v4-repair-loop-tpl-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tpl });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: tpl });
    spawnSync("git", ["config", "user.name", "t"], { cwd: tpl });
    writeFileSync(join(tpl, "a.txt"), "one\n");
    spawnSync("git", ["add", "."], { cwd: tpl });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: tpl });
    process.on("exit", () => rmSync(tpl, { recursive: true, force: true }));
    gitTemplate = tpl;
  }
  return gitTemplate;
}

function makeScaffold(home, { withFull = true, withForeignVersionFull = false, withStagedNoise = false, withUnresolvableEvidenceFull = false, withBrokenLatestExploration = false } = {}) {
  const projectRoot = join(home, "proj");
  cpSync(ensureGitTemplate(), projectRoot, { recursive: true });
  if (withStagedNoise) {
    // 预置一笔与修复无关的暂存改动：修复提交必须排除它（commit --only 鉴别锚点）
    writeFileSync(join(projectRoot, "unrelated.txt"), "noise\n");
    spawnSync("git", ["add", "unrelated.txt"], { cwd: projectRoot });
  }

  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ schemaVersion: 2, taskId: "repair-loop-test", projectRoot }));
  writeFileSync(join(taskDir, "intent.md"), "# 原始意图\n");
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: "repair-loop-test",
    projectRoot,
    requirements: [{
      id: "R1",
      statement: "外部可观察行为",
      required: true,
      riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{ id: "A1", statement: "行为断言", qualifiers: ["含在途"], given: "初始", when: "操作", then: "预期", adversarialFormRefs: ["AF1"], testAssetRefs: [] }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "含在途", entryPoint: "auto", initialState: "开启", operation: "等待中关闭", timing: "等待窗口", expected: "不写", testAssetRefs: [], rationale: "在途反例" }],
    exploratoryReview: "required",
    reviewDimensions: ["smoke"],
  }));
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "首个增量", requirementIds: ["R1"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } }],
  }));
  writeFileSync(join(taskDir, "policy-snapshot.json"), JSON.stringify({ "revision.json": {} }));

  const preEvents = [];
  if (withForeignVersionFull) {
    // 旧验收版本的 full：不能给当前版本的 recheck 背书（裁决器 fold.assurances 只收
    // 当前版本；workflow 前置门禁必须同口径过滤，否则白跑全程）
    preEvents.push({ type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 0, revision: "rev-old", mode: "full", summary: "旧版本 full", eventId: "evt-pre-full-v0" });
  }
  if (withFull) {
    // full 自身 artifact 可用性是前置门禁的一臂（workflow 侧与 gate fold 同口径）——预置文件
    const preFullArtifact = join(taskDir, "evidence", "pre-full-summary.md");
    writeFileSync(preFullArtifact, "# 首次完整保证总结（预置）\n");
    // 预置探索事件带 artifact + 哈希绑定（可用探索集三条件：同版本 + artifact 在盘 +
    // 哈希一致）——不带 artifact 的探索不进可用集，full-first 预检会拒绝
    const preExplorationArtifact = join(taskDir, "evidence", "pre-exploration.md");
    writeFileSync(preExplorationArtifact, "# 历史探索报告（预置）\n");
    const preExplorationSha = createHash("sha256").update(readFileSync(preExplorationArtifact, "utf8")).digest("hex");
    preEvents.push(
      { type: "AssuranceCompleted", actor: "assurance", acceptanceVersion: 1, revision: "rev-initial", mode: "full", summary: "首次完整保证", evidenceEventIds: withUnresolvableEvidenceFull ? ["evt-unknown-evidence"] : ["none"], explorationEventId: "evt-pre-exp", incrementReceipts: [{ incrementId: "I1", program: "node", args: ["-e", "process.exit(0)"], exitCode: 1, logSha256: "x", cwd: projectRoot, artifactSha256: "y" }], artifact: preFullArtifact, eventId: "evt-pre-full" },
      { type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: "rev-initial", summary: "历史探索", dimensions: ["smoke"], coverageManifestSha256: preExplorationSha, artifact: preExplorationArtifact, artifactSha256: preExplorationSha, eventId: "evt-pre-exp" },
      { type: "FindingRaised", actor: "assurance", acceptanceVersion: 1, revision: "rev-initial", summary: "blocker：反例场景未拦截", findingId: "F-A1", category: "defect", severity: "blocker", requirementIds: ["R1"], eventId: "evt-pre-finding" },
    );
    if (withBrokenLatestExploration) {
      // 同版本最后一条探索 artifact 失效（文件从未落盘）：原始事件流 .at(-1) 会引用它，
      // 裁决器判无效 → 任务停 candidate；可用探索集口径下 recheck 必须改引用 evt-pre-exp
      const brokenExplorationArtifact = join(taskDir, "evidence", "missing-exploration.md");
      preEvents.push(
        { type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: "rev-initial", summary: "失效探索（artifact 缺失）", dimensions: ["smoke"], coverageManifestSha256: preExplorationSha, artifact: brokenExplorationArtifact, artifactSha256: preExplorationSha, eventId: "evt-pre-exp-broken" },
      );
    }
  }
  writeFileSync(join(taskDir, "events.jsonl"), preEvents.map((e) => JSON.stringify(e)).join("\n") + (preEvents.length ? "\n" : ""));

  const roles = join(home, ".agents/skills/delivery-v4/references/roles");
  const scripts = join(home, ".agents/skills/delivery-v4/scripts");
  mkdirSync(roles, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const r of ["coverage-reviewer", "repair-builder"]) writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);

  const verdictQueue = [
    {
      state: "implementing", revision: "rev-initial", acceptanceVersion: 1,
      missing: { incrementIds: [] },
      openFindings: [{ findingId: "F-A1", category: "defect", severity: "blocker", requirementIds: ["R1"], riskAccepted: false }],
    },
    { state: "candidate", revision: "rev-after-fix", acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] },
  ];
  // 桩 CLI 用 CJS 语法：测试提速通道以 vm 进程内执行 node 桩调用（vm.Script 不认 ESM
  // import 语句）；被测产物只消费退出码与 stdout，语法形态不影响语义
  writeFileSync(join(scripts, "delivery-gate.mjs"), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cmd = process.argv[2];",
    "const argv = process.argv.slice(3);",
    "const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };",
    "if (cmd === 'evaluate') {",
    "  const p = path.join(path.dirname(process.argv[1]), 'gate-verdicts.json');",
    "  const list = JSON.parse(fs.readFileSync(p, 'utf8'));",
    "  const verdict = list.length > 1 ? list.shift() : list[0];",
    "  fs.writeFileSync(p, JSON.stringify(list));",
    "  process.stdout.write(JSON.stringify(verdict));",
    "  process.exit(0);",
    "}",
    "if (cmd === 'revision') { process.stdout.write('rev-after-fix'); process.exit(0); }",
    "if (cmd === 'append') {",
    "  const credential = opt('credential');",
    "  if (typeof credential !== 'string' || credential === '') { process.stderr.write('append 需要 --credential'); process.exit(2); }",
    "  const event = JSON.parse(opt('event'));",
    "  const expected = { builder: 'stub-builder-cred', assurance: 'stub-assurance-cred' }[event.actor];",
    "  if (expected && credential !== expected) { process.stderr.write('凭据角色与 actor 不匹配：' + event.actor); process.exit(2); }",
    "  const eventsPath = path.join(opt('task-dir'), 'events.jsonl');",
    "  const seq = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1;",
    "  const record = { seq, recordedAt: '2026-01-01T00:00:00.000Z', eventId: 'evt-' + seq, signature: 'stub', ...event };",
    "  fs.appendFileSync(eventsPath, JSON.stringify(record) + '\\n');",
    "  process.stdout.write(JSON.stringify({ eventId: record.eventId }));",
    "  process.exit(0);",
    "}",
    "process.stderr.write('stub gate: 未知命令 ' + cmd);",
    "process.exit(2);",
  ].join("\n"));
  writeFileSync(join(scripts, "gate-verdicts.json"), JSON.stringify(verdictQueue));

  return { projectRoot, taskDir };
}

/** 桩 agent 表（zcode 形态）：按实例名前缀分发；「写入路径：X」行自动落盘桩产物；
 *  builder 桩同时改 proj/a.txt（让 git commit 有真实改动可提交） */
function repairAgentStub(s) {
  const apply = (hit, instructions) => {
    const value = typeof hit === "function" ? hit(instructions) : hit;
    for (const m of instructions.matchAll(/写入路径：(\S+)/g)) writeFileSync(m[1], `# 桩产物（${m[1]}）\n`);
    return value;
  };
  return (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const hit = {
      "repair-planner": () => ({
        summary: "聚合完成：1 条实现级缺陷",
        affectedAssertionIds: ["A1"],
        items: [{ findingId: "F-A1", guidance: "修 a.txt", origin: "implementation", expectedStage: "D2", regressionTestRef: "test-A1" }],
      }),
      "repair-builder": () => {
        writeFileSync(join(s.projectRoot, "a.txt"), "fixed\n");
        return { summary: "已修复", filesChanged: ["a.txt"], testEvidence: "node -e exit 0", affectedAssertionIds: ["A1"] };
      },
      "repair-reviewer": () => ({ summary: "复核通过", testEvidence: "全绿", resolvedFindingIds: ["F-A1"], unresolvedFindingIds: [], findings: [] }),
      "coverage-review": () => {
        const artifact = join(s.taskDir, "evidence", "cov-A1-command.md");
        writeFileSync(artifact, "原始核对记录（桩）\n");
        return {
          summary: "逐断言复核完成",
          evidence: [{ requirementId: "R1", kind: "command", result: "verified", assertionIds: ["A1"], adversarialFormIds: ["AF1"], artifact }],
          findings: [], resolvedFindingIds: [], unresolvedFindingIds: [],
        };
      },
    }[name.replace(/-r\d+$/, "")];
    assert.ok(hit !== undefined, `未预期的 agent 实例：${name}`);
    if (typeof a[0] === "string") return { ask: async (...askArgs) => apply(hit, String(askArgs[askArgs.length - 1])) };
    return Promise.resolve(apply(hit, String(a[0].prompt)));
  };
}

async function runZcode(home, argsValue, agentImpl) {
  const js = transpileFile(join(WF, "assurance-repair-loop-v4.dwf.ts"));
  const logs = [];
  const world = {
    run: async (cmd, a, opts) => fastWorldRun(home, cmd, a, opts),
  };
  const fn = new vm.Script(`(async function __main__(args, world, log, phase, report, artifact, agent) {\n${js}\n})`).runInNewContext({});
  const result = await fn(
    argsValue, world, (m) => logs.push(String(m)), () => {}, () => {},
    { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
    agentImpl,
  );
  return { result, logs };
}

async function runPi(home, argsValue, agentImpl) {
  const raw = readFileSync(join(WF, "pi", "assurance-repair-loop-v4.js"), "utf8");
  const logs = [];
  const world = {
    run: async (cmd, a, opts) => fastWorldRun(home, cmd, a, opts),
  };
  const context = {
    // pi 壳 shim 经 require("node:child_process") 自建 world（spawnSync 形态）——注入层
    // 拦截换快速通道（node -e 探针 / node <桩CLI> 进程内执行；git / sh -c 真实 spawn），
    // 其余模块原样放行
    require: (id) => {
      if (id === "node:child_process" || id === "child_process") {
        const mod = require(id);
        const wrapped = Object.create(mod);
        wrapped.spawnSync = (cmd, args, opts) => {
          const r = fastWorldRun(home, cmd, args, opts);
          return { status: r.exitCode === -1 ? null : r.exitCode, stdout: r.stdout, stderr: r.stderr };
        };
        return wrapped;
      }
      return require(id);
    },
    console: { log: (...m) => logs.push(m.map(String).join(" ")), error: () => {}, warn: () => {} },
    process: { ...process, env: { ...process.env, HOME: home }, cwd: () => home },
    $ARGS: { ...argsValue },
    $WORKSPACE: home,
    world,
    agent: agentImpl,
    log: (m) => logs.push(String(m)),
    phase: () => {},
    report: () => {},
    artifact: { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
  };
  context.globalThis = context;
  const fn = new vm.Script(`(async function __main__() {\nconst args = $ARGS;\n${raw}\n})`).runInNewContext(context);
  return { result: await fn(), logs };
}

const baseArgs = (s) => ({
  projectRoot: s.projectRoot,
  taskDir: s.taskDir,
  assuranceCredentialId: "stub-assurance-cred",
  builderCredentialId: "stub-builder-cred",
  allowCommit: true,
});

const readEvents = (taskDir) =>
  readFileSync(join(taskDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("zcode 主路径：修复轮提交 + RepairRoundRecorded 溯源 + recheck 最终取证（TDZ 回归）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { withStagedNoise: true });
    const { result, logs } = await runZcode(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "assurance-completed", `主路径应走通（logs: ${logs.join(" | ")}, message: ${result.message}）`);
    const events = readEvents(s.taskDir);
    const repair = events.find((e) => e.type === "RepairRoundRecorded");
    assert.ok(repair !== undefined, "应登记 RepairRoundRecorded");
    assert.equal(repair.round, 1);
    assert.equal(repair.fromRevision, "rev-initial");
    assert.equal(repair.toRevision, "rev-after-fix");
    assert.ok(Array.isArray(repair.incrementReceipts) && repair.incrementReceipts.length > 0, "受控修复轮必须随事件附带全量确定性测试回执（合并稿 §11.1；缺回执会被 gate 拒收）");
    const resolved = events.find((e) => e.type === "FindingResolved");
    assert.ok(resolved !== undefined, "复核确认后应登记 FindingResolved");
    const assurance = events.filter((e) => e.type === "AssuranceCompleted").at(-1);
    assert.equal(assurance.mode, "recheck");
    assert.equal(assurance.explorationEventId, "evt-pre-exp", "recheck 引用历史 ExplorationCompleted");
    assert.ok(events.some((e) => e.type === "EvidenceRecorded" && e.assertionIds?.includes("A1")), "应有断言级证据事件");
    const commitLog = spawnSync("git", ["log", "--name-only", "--format=%s"], { cwd: s.projectRoot, encoding: "utf8" }).stdout;
    assert.ok(commitLog.includes("fix(delivery): repair round 1"), "修复应产生提交");
    assert.ok(commitLog.slice(commitLog.indexOf("fix(delivery)")).includes("a.txt"), "提交只含 builder 申报文件");
    const repairCommitFiles = commitLog.slice(commitLog.indexOf("fix(delivery)"), commitLog.indexOf("fix(delivery)") + 200);
    assert.ok(!repairCommitFiles.includes("unrelated.txt"), "修复提交必须排除预先存在的无关暂存改动（--only 鉴别）");
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: s.projectRoot, encoding: "utf8" }).stdout.trim();
    assert.equal(staged, "unrelated.txt", "无关暂存改动应保持 staged 不被消费");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 主路径：与 zcode 终态一致（双平台对拍）", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home; // pi 壳探针与 spawnSync 继承进程 env
  try {
    const s = makeScaffold(home);
    const { result } = await runPi(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "assurance-completed", `pi 主路径应走通（message: ${result.message}）`);
    const events = readEvents(s.taskDir);
    assert.ok(events.some((e) => e.type === "RepairRoundRecorded" && e.fromRevision === "rev-initial" && e.toRevision === "rev-after-fix"));
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("full-first 前置：事件流无 full 保证时 setup-failure", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { withFull: false });
    const { result } = await runZcode(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "setup-failure");
    assert.ok(result.message.includes("full"), "失败消息应指向先跑 full 的恢复动作");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("full-first 前置：旧验收版本的 full 不能给当前版本背书（版本过滤）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { withFull: false, withForeignVersionFull: true });
    const { result } = await runZcode(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "setup-failure");
    assert.ok(result.message.includes("full"), "失败消息应指向先跑当前版本 full 的恢复动作");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("full-first 前置：full 引用不可解析证据事件时登记时点不完整（两臂之一）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { withUnresolvableEvidenceFull: true });
    const { result } = await runZcode(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "setup-failure");
    assert.ok(result.message.includes("登记时点不完整") || result.message.includes("full"), "失败消息应指向 full 完整性缺口");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("同版本最后一条探索 artifact 失效时 recheck 引用最后一条可用探索（可用探索集口径）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { withBrokenLatestExploration: true });
    const { result, logs } = await runZcode(home, baseArgs(s), repairAgentStub(s));
    assert.equal(result.terminated, "assurance-completed", `主路径应走通（logs: ${logs.join(" | ")}，message: ${result.message}）`);
    const events = readEvents(s.taskDir);
    const assurance = events.filter((e) => e.type === "AssuranceCompleted").at(-1);
    assert.equal(assurance.mode, "recheck");
    // 原始事件流最后一条探索是 evt-pre-exp-broken（artifact 缺失）：引用它会被裁决器判
    // 无效（missingExplorationIds）→ 任务停 candidate；必须改引用最后一条可用探索
    assert.equal(assurance.explorationEventId, "evt-pre-exp", "recheck 须引用最后一条可用探索，而非原始事件流最后一条");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
