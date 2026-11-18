// workflow-v4-independent-assurance.test.mjs — independent-assurance-v4 执行级冒烟
//
// 覆盖（对应实现：workflows/src/independent-assurance-v4.shared.ts）：
//   1. process-failed 早停（合并稿 §7.2）：coverage 发现登记落盘后 evaluate 判
//      process-failed → 不再派探索 agent、不重跑测试、不登记 AssuranceCompleted，
//      以 assurance-failed 终态停回（message 指向归因，不指引「重新发起」）
//   2. 探索 due 主路径（合并稿 §6）：无候选探索证据 → full 派开放探索并登记
//      ExplorationCompleted（带 artifactSha256）与 AssuranceCompleted（带 artifactSha256）
//   3. 探索未 due：已有候选探索证据时不派 explorer，AssuranceCompleted 引用既有探索
//      事件而非 "none"（none 会被裁决器判无效，任务停 candidate 无可达终态）
//
// 运行：node --test scripts/tests/workflow-v4-independent-assurance.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

const tmpHome = () => mkdtempSync(join(tmpdir(), "v4-ia-"));

// 模板仓：每测试进程只构建一次「初始提交仓」，makeScaffold 经 cpSync 复制实例化——
// git 对象是内容寻址的只读数据，复制保真，省掉每 scaffold 的 init/config/add/commit spawn
let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "v4-ia-tpl-"));
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

/** 独立保证脚手架：真实 git 项目 + 任务目录 + 桩 delivery-gate（evaluate 按 verdicts
 *  队列出参；append 校验凭据后落盘返回递增 eventId）+ 技能角色文件 */
function makeScaffold(home, { verdictQueue }) {
  const projectRoot = join(home, "proj");
  cpSync(ensureGitTemplate(), projectRoot, { recursive: true });

  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ schemaVersion: 2, taskId: "ia-test", projectRoot }));
  writeFileSync(join(taskDir, "intent.md"), "# 原始意图\n");
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: "ia-test",
    projectRoot,
    riskLevel: "medium",
    exploratoryReview: "not-required",
    reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1",
      statement: "外部可观察行为",
      required: true,
      riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{ id: "A1", statement: "行为断言", qualifiers: ["含在途"], given: "初始", when: "操作", then: "预期", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"] }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "含在途", entryPoint: "auto", initialState: "开启", operation: "等待中关闭", timing: "等待窗口", expected: "不写", testAssetRefs: ["test-A1"], rationale: "在途反例" }],
  }));
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    items: [{ id: "I1", title: "首个增量", requirementIds: ["R1"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } }],
  }));
  writeFileSync(join(taskDir, "policy-snapshot.json"), JSON.stringify({ "revision.json": {} }));
  writeFileSync(join(taskDir, "events.jsonl"), "");

  const roles = join(home, ".agents/skills/delivery-v4/references/roles");
  const scripts = join(home, ".agents/skills/delivery-v4/scripts");
  mkdirSync(roles, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const r of ["coverage-reviewer", "explorer"]) writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);

  writeFileSync(join(scripts, "delivery-gate.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
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
    "if (cmd === 'revision') { process.stdout.write('rev-1'); process.exit(0); }",
    "if (cmd === 'append') {",
    "  const credential = opt('credential');",
    "  if (typeof credential !== 'string' || credential === '') { process.stderr.write('append 需要 --credential'); process.exit(2); }",
    "  const event = JSON.parse(opt('event'));",
    "  if (event.actor === 'assurance' && credential !== 'stub-assurance-cred') { process.stderr.write('凭据角色与 actor 不匹配'); process.exit(2); }",
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

/** 桩 agent 表（zcode 形态）：按实例名分发；「写入路径：X」行自动落盘桩产物；
 *  explorer 调用计数暴露给断言（process-failed 早停时必须为 0） */
function assuranceAgentStub(s) {
  const state = { explorerCalls: 0 };
  const apply = (hit, instructions) => {
    const value = typeof hit === "function" ? hit(instructions) : hit;
    for (const m of instructions.matchAll(/写入路径：(\S+)/g)) writeFileSync(m[1], `# 桩产物（${m[1]}）\n`);
    return value;
  };
  const impl = (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const hit = {
      coverage: () => {
        const artifact = join(s.taskDir, "evidence", "cov-A1-command.md");
        writeFileSync(artifact, "原始核对记录（桩）\n");
        return {
          summary: "逐断言复核完成",
          evidence: [{ requirementId: "R1", kind: "command", result: "verified", assertionIds: ["A1"], adversarialFormIds: ["AF1"], artifact }],
          findings: [], resolvedFindingIds: [], unresolvedFindingIds: [],
        };
      },
      explorer: () => {
        state.explorerCalls += 1;
        return { summary: "开放探索完成", dimensions: ["smoke"], findings: [] };
      },
      "candidate-explorer": () => {
        state.explorerCalls += 1;
        return { summary: "候选探索完成", dimensions: ["smoke"], findings: [] };
      },
    }[name.replace(/-review$/, "")];
    assert.ok(hit !== undefined, `未预期的 agent 实例：${name}`);
    if (typeof a[0] === "string") return { ask: async (...askArgs) => apply(hit, String(askArgs[askArgs.length - 1])) };
    return Promise.resolve(apply(hit, String(a[0].prompt)));
  };
  return { impl, state };
}

async function runZcode(home, argsValue, agentImpl) {
  const raw = readFileSync(join(WF, "independent-assurance-v4.dwf.ts"), "utf8");
  const js = transpile(raw);
  const logs = [];
  const world = {
    run: async (cmd, a, opts) => {
      const r = spawnSync(cmd, a ?? [], {
        encoding: "utf8", cwd: home, env: { ...process.env, HOME: home },
        timeout: opts && opts.timeoutMs ? opts.timeoutMs : 30000,
      });
      return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
  const fn = new vm.Script(`(async function __main__(args, world, log, phase, report, artifact, agent) {\n${js}\n})`).runInNewContext({});
  const result = await fn(
    argsValue, world, (m) => logs.push(String(m)), () => {}, () => {},
    { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
    agentImpl,
  );
  return { result, logs };
}

const baseArgs = (s) => ({
  projectRoot: s.projectRoot,
  taskDir: s.taskDir,
  assuranceCredentialId: "stub-assurance-cred",
});

const readEvents = (taskDir) =>
  readFileSync(join(taskDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const implementingVerdict = {
  state: "implementing", revision: "rev-1", acceptanceVersion: 1,
  missing: { incrementIds: [] },
  openFindings: [],
};

test("process-failed 早停：coverage 登记后第 11 条 must-fix 已超限 → 不再派探索 agent、不登记 AssuranceCompleted", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [
        implementingVerdict,
        // coverage 发现登记落盘后的早停检查：evaluate 判 process-failed（第 11 条不同 must-fix）
        { state: "process-failed", revision: "rev-1", acceptanceVersion: 1, quality: { uniqueMustFix: 11, repairRounds: 0 }, missing: { incrementIds: [] }, openFindings: [] },
      ],
    });
    const stub = assuranceAgentStub(s);
    const { result, logs } = await runZcode(home, baseArgs(s), stub.impl);
    assert.equal(result.terminated, "assurance-failed", `应停回 assurance-failed（logs: ${logs.join(" | ")}）`);
    assert.match(result.message, /process-failed/, "message 应指向 process-failed 归因");
    assert.match(result.message, /不要重发本 workflow/, "process-failed 指引应停止派发而非重新发起");
    assert.equal(stub.state.explorerCalls, 0, "process-failed 后不得再派探索 agent");
    const events = readEvents(s.taskDir);
    assert.ok(events.some((e) => e.type === "EvidenceRecorded"), "coverage 证据应已登记");
    assert.ok(!events.some((e) => e.type === "ExplorationCompleted"), "不得登记探索事件");
    assert.ok(!events.some((e) => e.type === "AssuranceCompleted"), "不得登记 AssuranceCompleted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("full 探索未 due：已有候选探索证据时不派 explorer，AssuranceCompleted 引用既有探索事件（MF-1-20 死锁回归）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [
        implementingVerdict,
        // coverage 发现登记后的早停检查：正常态
        { state: "candidate", revision: "rev-1", acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] },
        // finalize evaluate
        { state: "accepted", revision: "rev-1", acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] },
      ],
    });
    // 候选反例审查阶段的探索（晚于批准登记、artifact 在盘且哈希一致）：full 的
    // explorationDue=false——不得重新开放探索，且必须引用该事件而非 "none"
    const explorationArtifact = join(s.taskDir, "evidence", "candidate-exploration.md");
    writeFileSync(explorationArtifact, "# 候选探索报告（桩）\n");
    const explorationSha = createHash("sha256").update(readFileSync(explorationArtifact, "utf8")).digest("hex");
    writeFileSync(join(s.taskDir, "events.jsonl"), [
      JSON.stringify({ seq: 1, eventId: "evt-approval", recordedAt: "2026-01-01T00:00:00.000Z", signature: "stub", type: "AcceptanceApproved", actor: "user", acceptanceVersion: 1, revision: "rev-1", summary: "批准" }),
      JSON.stringify({ seq: 2, eventId: "evt-design", recordedAt: "2026-01-01T00:00:00.000Z", signature: "stub", type: "DesignApproved", actor: "user", acceptanceVersion: 1, revision: "rev-1", summary: "方案" }),
      JSON.stringify({ seq: 3, eventId: "evt-candidate-exploration", recordedAt: "2026-01-01T00:00:00.000Z", signature: "stub", type: "ExplorationCompleted", actor: "assurance", acceptanceVersion: 1, revision: "rev-1", summary: "候选探索", dimensions: ["smoke"], coverageManifestSha256: explorationSha, artifactSha256: explorationSha, artifact: explorationArtifact }),
      "",
    ].join("\n"));
    const stub = assuranceAgentStub(s);
    const { result, logs } = await runZcode(home, baseArgs(s), stub.impl);
    assert.equal(result.terminated, "assurance-completed", `主路径应走通（logs: ${logs.join(" | ")}，message: ${result.message}）`);
    assert.equal(stub.state.explorerCalls, 0, "已有候选探索证据且验收/设计未变化时不得重新派 explorer");
    const events = readEvents(s.taskDir);
    assert.ok(!events.some((e) => e.type === "ExplorationCompleted" && e.eventId !== "evt-candidate-exploration"), "不得新增开放探索事件");
    const assurance = events.find((e) => e.type === "AssuranceCompleted");
    assert.ok(assurance !== undefined, "应登记 AssuranceCompleted");
    assert.equal(assurance.explorationEventId, "evt-candidate-exploration", "full 未派探索时必须引用既有探索事件（none 会被裁决器判无效）");
    assert.equal(assurance.mode, "full");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("探索 due 主路径：无候选探索证据时 full 派开放探索，探索与保证事件带 artifactSha256", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [
        implementingVerdict,
        // 探索发现登记后的第二次早停检查：正常态（非 process-failed）
        { state: "candidate", revision: "rev-1", acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] },
        // finalize evaluate
        { state: "candidate", revision: "rev-1", acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] },
      ],
    });
    const stub = assuranceAgentStub(s);
    const { result, logs } = await runZcode(home, baseArgs(s), stub.impl);
    assert.equal(result.terminated, "assurance-completed", `主路径应走通（logs: ${logs.join(" | ")}，message: ${result.message}）`);
    assert.ok(stub.state.explorerCalls >= 1, "无候选探索证据时 full 应派开放探索");
    const events = readEvents(s.taskDir);
    const exploration = events.find((e) => e.type === "ExplorationCompleted");
    assert.ok(exploration !== undefined, "应登记 ExplorationCompleted");
    assert.match(exploration.artifactSha256, /^[0-9a-f]{64}$/, "ExplorationCompleted 应带 artifactSha256 哈希绑定");
    const assurance = events.find((e) => e.type === "AssuranceCompleted");
    assert.ok(assurance !== undefined, "应登记 AssuranceCompleted");
    assert.match(assurance.artifactSha256, /^[0-9a-f]{64}$/, "AssuranceCompleted 应带 artifactSha256 哈希绑定");
    assert.equal(assurance.mode, "full");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
