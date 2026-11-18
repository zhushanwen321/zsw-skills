// ia-contract-negative-v6.test.mjs — 独立保证负路径与验收审查响应校验的执行探针
//
// 被测实现（workflow 单文件自包含产物，经 vm 载入磁盘当前版执行——与
// ia-contract-independence-v6.test.mjs 同通道）：
//   - workflows/independent-assurance-v6.dwf.ts：resolver CLI 缺失分支（exit 127）、
//     manual-handoff 观察结构校验（§5.2/§8.2 转人工登记纪律）；
//   - workflows/acceptance-design-v6.dwf.ts：审查响应 riskCoverage 十类机器校验
//     （设计 §5.4：缺一类 / 非法 state / 重复类别三条负路径）。
//
// 覆盖（测试审查报告结论的补执行断言）：
//   1. 审查发现 13a（P3）：resolver 脚本不在安装位 → essential 契约登记 authority-missing
//      must-fix（blocker，不降 info）——CLI 存在性检查分支（与「resolver 运行失败」分支
//      互为邻格，既有文件只覆盖后者）；
//   2. 审查发现 13b（P3）：manual-handoff 观察缺 manualHandoffReason → 审查响应结构校验
//      拒绝（转人工是登记不是静默跳过，缺理由不得通关）；
//   3. 审查发现 6（P2）：acceptance-design 审查响应 riskCoverage 三条负路径——缺一类 /
//      非法 state / 重复类别均被结构校验拒绝并进终态披露；合法十类放行（对照）。
//
// 注意：acceptance-design-v6.shared.ts 正被文档线改 prompt——vm 载入的是磁盘当前版，
// 本文件先跑再报（prompt 文案变化不影响结构校验断言）。
//
// fixture 纪律：mkdtempSync 临时目录、HOME 重定向（world.run 的 env 注入）、t.after 清理、
// 无固定文件名；桩 gate/core/resolver/角色全部自撰，不依赖真实技能安装。
//
// 运行：node --test scripts/tests/ia-contract-negative-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = join(ROOT, "skills", "self", "dev-workflow", "workflows");
const IA_DWF = join(WF, "independent-assurance-v6.dwf.ts");
const AD_DWF = join(WF, "acceptance-design-v6.dwf.ts");
const POLICY_FILE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "policies", "external-contract-classes.json");
const ts = require("typescript");

const transpile = (code) =>
  ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const REVISION = "rev-contract-1";
const AGGREGATE_HASH = "agg-hash-EC-test-0001";
const CONTRACT_ID = "EC-test";
const tmpHome = () => mkdtempSync(join(tmpdir(), "ia-neg-v6-"));

/** 权威工件目录：surface 文件内容与 resolver 快照登记哈希逐字节一致 */
function makeAuthority(root) {
  const dir = join(root, "authority");
  mkdirSync(join(dir, "dist/core/extensions"), { recursive: true });
  writeFileSync(join(dir, "dist/core/extensions/loader.js"), "// 权威 loader（桩）\nmodule.exports = {};\n");
  writeFileSync(join(dir, "dist/core/agent.js"), "// 权威 agent（桩）\nmodule.exports = {};\n");
  return dir;
}

const ACCEPTANCE = (projectRoot) => ({
  schemaVersion: 2,
  acceptanceVersion: 1,
  taskId: "ia-neg",
  projectRoot,
  riskLevel: "high",
  exploratoryReview: "required",
  reviewDimensions: ["外部契约", "故障形态", "状态机时序"],
  requirements: [
    {
      id: "R1", statement: "扩展经官方 runner 装载", required: true, riskAcceptable: false, evidenceKinds: ["command"],
      assertions: [{
        id: "A1", statement: "装载后得到注册清单", qualifiers: [], given: "已安装权威包", when: "official-runner 装载", then: "注册清单非空",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"], requiredEnvironment: { kind: "official-runner", capability: "load-extension" },
      }],
    },
    {
      id: "R2", statement: "斜杠命令经真实宿主分发", required: true, riskAcceptable: false, evidenceKinds: ["scenario"],
      assertions: [{
        id: "A2", statement: "用户输入命中注册命令", qualifiers: [], given: "命令已注册", when: "用户输入命令", then: "handler 执行",
        adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"], requiredEnvironment: { kind: "real-host", capability: "dispatch-slash-command" },
      }],
    },
  ],
  adversarialForms: [
    { id: "AF1", assertionId: "A1", qualifier: "装载", entryPoint: "runner", initialState: "未装载", operation: "装载扩展", timing: "同步", expected: "注册清单非空", testAssetRefs: ["test-A1"], rationale: "装载反例" },
    { id: "AF2", assertionId: "A2", qualifier: "分发", entryPoint: "host", initialState: "已注册", operation: "输入命令", timing: "同步", expected: "handler 执行", testAssetRefs: ["test-A2"], rationale: "分发反例" },
  ],
  externalContracts: [{
    id: CONTRACT_ID,
    essential: true,
    authorityRequest: { resolverKind: "installed-npm-package", locator: "test-authority" },
    capabilities: [
      { id: "load-extension", minEnvironment: "official-runner", observable: "官方 loader 装载扩展并得到注册清单", surfaceRefs: ["dist/core/extensions/loader.js"], detectionClasses: ["extension-entrypoint"] },
      { id: "dispatch-slash-command", minEnvironment: "real-host", observable: "用户输入经真实宿主命令解析命中注册命令", surfaceRefs: ["dist/core/agent.js#dispatch"], detectionClasses: ["register-command"] },
    ],
  }],
});

/** IA 任务脚手架：git 项目 + 任务目录 + 桩 gate/core/resolver（可选装）/角色 */
function makeIaScaffold(home, { verdictQueue, installResolver = true, deliveryProfile = null } = {}) {
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name", "t"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectRoot });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectRoot });

  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  writeFileSync(join(taskDir, "intent.md"), "# 原始意图\n扩展在真实宿主中装载并分发命令\n");
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    schemaVersion: 2, taskId: "ia-neg", projectRoot,
    ...(deliveryProfile === null ? {} : { deliveryProfile }),
  }));
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify(ACCEPTANCE(projectRoot)));
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify({
    schemaVersion: 2, acceptanceVersion: 1,
    items: [
      { id: "I1", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } },
      { id: "I2", title: "命令分发", requirementIds: ["R2"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } },
    ],
  }));
  writeFileSync(join(taskDir, "policy-snapshot.json"), JSON.stringify({ "revision.json": {} }));
  writeFileSync(join(taskDir, "events.jsonl"), "");

  const authorityDir = makeAuthority(home);
  const roles = join(home, ".agents/skills/delivery-v6/references/roles");
  const scripts = join(home, ".agents/skills/delivery-v6/scripts");
  mkdirSync(roles, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const r of ["coverage-reviewer", "explorer"]) writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);

  // 桩 delivery-gate：evaluate 出队 + 高层记录命令落 events.jsonl（形态照
  // ia-contract-independence-v6.test.mjs 的桩——保证事件结构与真实 gate 同口径）
  writeFileSync(join(scripts, "delivery-gate.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const cmd = process.argv[2];",
    "const argv = process.argv.slice(3);",
    "const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };",
    "const has = (n) => argv.includes('--' + n);",
    "if (cmd === 'evaluate') {",
    "  const p = path.join(path.dirname(process.argv[1]), 'gate-verdicts.json');",
    "  const list = JSON.parse(fs.readFileSync(p, 'utf8'));",
    "  const verdict = list.length > 1 ? list.shift() : list[0];",
    "  fs.writeFileSync(p, JSON.stringify(list));",
    "  process.stdout.write(JSON.stringify(verdict));",
    "  process.exit(0);",
    "}",
    "const RECORD = {",
    "  'record-finding': (a) => ({ type: 'FindingRaised', summary: opt('summary'), category: opt('category'), severity: opt('severity'), requirementIds: JSON.parse(opt('requirement-ids') || '[]'), findingId: opt('finding-id'), artifact: opt('artifact') }),",
    "  'resolve-finding': () => ({ type: 'FindingResolved' }),",
    "  'reaffirm-resolution': () => ({ type: 'ResolutionReaffirmed' }),",
    "  'record-evidence': (a) => ({ type: 'EvidenceRecorded', requirementId: opt('requirement-id'), kind: opt('kind'), result: opt('result'), summary: opt('summary'), artifact: opt('artifact'), ...(opt('artifact-sha256') !== undefined ? { artifactSha256: opt('artifact-sha256') } : {}), ...(opt('assertion-ids') !== undefined ? { assertionIds: JSON.parse(opt('assertion-ids')) } : {}), ...(opt('adversarial-form-ids') !== undefined ? { adversarialFormIds: JSON.parse(opt('adversarial-form-ids')) } : {}), ...(opt('contract-capability-ids') !== undefined ? { contractCapabilityIds: JSON.parse(opt('contract-capability-ids')) } : {}), ...(has('runtime-probe') ? { runtimeProbe: true } : {}) }),",
    "  'record-exploration': () => ({ type: 'ExplorationCompleted', dimensions: JSON.parse(opt('dimensions') || '[]'), summary: opt('summary') }),",
    "  'complete-assurance': () => ({ type: 'AssuranceCompleted', mode: opt('mode'), summary: opt('summary') }),",
    "  'record-assurance-drift': () => ({ type: 'AssuranceRevisionDrift' }),",
    "};",
    "if (Object.hasOwn(RECORD, cmd)) {",
    "  const credential = opt('credential');",
    "  if (typeof credential !== 'string' || credential === '') { process.stderr.write('缺少 --credential'); process.exit(2); }",
    "  const event = RECORD[cmd](argv);",
    "  const eventsPath = path.join(opt('task-dir'), 'events.jsonl');",
    "  const seq = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1;",
    "  const record = { seq, eventId: 'evt-' + seq, type: event.type, ...event };",
    "  fs.appendFileSync(eventsPath, JSON.stringify(record) + '\\n');",
    "  process.stdout.write(JSON.stringify({ eventId: record.eventId }));",
    "  process.exit(0);",
    "}",
    "if (cmd.startsWith('lease-')) { process.stdout.write('{}'); process.exit(0); }",
    "process.stderr.write('stub gate: 未知命令 ' + cmd);",
    "process.exit(2);",
  ].join("\n"));
  writeFileSync(join(scripts, "gate-verdicts.json"), JSON.stringify(verdictQueue));

  // 桩 delivery-core：IA v6 消费的内核判定
  writeFileSync(join(scripts, "delivery-core.mjs"), [
    "import fs from 'node:fs';",
    "const cmd = process.argv[2];",
    "const json = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };",
    "if (cmd === 'usable-explorations') json({ usable: [], latestUsableId: 'none' });",
    "if (cmd === 'exploration-due') json({ due: process.env.STUB_EXPLORATION_DUE === '1' });",
    "if (cmd === 'open-findings') json({ open: [] });",
    "if (cmd === 'full-qualification') json({ qualified: true, inspections: [] });",
    "if (cmd === 'revision-provenance') json({ unknownCount: 0 });",
    "if (cmd === 'loop-attempt') json({ ok: true });",
    "process.stderr.write('stub core: 未知命令 ' + cmd);",
    "process.exit(2);",
  ].join("\n"));

  if (installResolver) {
    // 桩 resolve-external-contracts.mjs：resolved 摘要 + --write 形态快照/指针
    writeFileSync(join(scripts, "resolve-external-contracts.mjs"), [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import crypto from 'node:crypto';",
      "const argv = process.argv.slice(2);",
      "const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };",
      "const taskDir = opt('task-dir');",
      "const configPath = path.join(taskDir, 'resolver-config.json');",
      "const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { mode: 'resolved' };",
      "if (config.mode === 'fail') { process.stderr.write('resolver 桩：解析失败'); process.exit(1); }",
      "const contractId = config.contractId || 'EC-test';",
      "const authorityDir = config.authorityDir;",
      "const surfaces = (config.surfaces || []).map((ref) => {",
      "  const file = ref.split('#')[0];",
      "  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(authorityDir, file))).digest('hex');",
      "  return { surfaceRef: ref, sha256: hash };",
      "});",
      "const snapshotSha256 = config.snapshotSha256 || 'snap-resolved';",
      "process.stdout.write(JSON.stringify({",
      "  schemaVersion: 1, snapshotSha256,",
      "  contracts: [{ id: contractId, status: 'resolved', authorityAggregateHash: 'agg-hash-EC-test-0001', identity: { name: 'test-authority', version: '1.0.0' }, surfaces }],",
      "  unresolvedContracts: [],",
      "}));",
      "const dir = path.join(taskDir, 'environment-contracts');",
      "fs.mkdirSync(dir, { recursive: true });",
      "const snapshot = { schemaVersion: 1, snapshotSha256, contracts: [{ id: contractId, status: 'resolved', resolver: { kind: 'installed-npm-package', locator: 'test-authority', resolvedPath: authorityDir, resolution: 'project-dependency' }, identity: { name: 'test-authority', version: '1.0.0' }, surfaces, aggregateHash: 'agg-hash-EC-test-0001', resolvedAt: '2026-01-01T00:00:00.000Z' }] };",
      "fs.writeFileSync(path.join(dir, `${snapshotSha256}.json`), JSON.stringify(snapshot, null, 2));",
      "fs.writeFileSync(path.join(dir, 'environment-contracts.current.json'), JSON.stringify({ schemaVersion: 1, snapshotSha256, snapshotPath: `environment-contracts/${snapshotSha256}.json`, updatedAt: '2026-01-01T00:00:00.000Z' }, null, 2));",
    ].join("\n"));
  }
  return { projectRoot, taskDir, authorityDir };
}

/** probe artifact（设计 §6.3 结构） */
function probeArtifact({ revision = REVISION, kind = "official-runner", capabilities = ["load-extension"], caseId = "load-basic" } = {}) {
  const cases = [{ capabilityId: capabilities[0], caseId, operation: "观察", observed: { ok: true }, passed: true }];
  return {
    environment: { kind, name: "test-authority", version: "1.0.0", source: "authority", sourceHash: AGGREGATE_HASH, driver: "probe.mjs", driverHash: sha256("driver"), capabilities },
    subject: { revision, entrypoint: "dist/core/extensions/loader.js" },
    cases,
    summary: { passed: 1, failed: 0, skipped: 0 },
  };
}

/** 可配置 agent 桩：按实例名分发，记录 prompt 供断言；「写入路径：X」行在 ask 内落盘。
 *  keyOf 把 agent 实例名映射到 handler 键（IA 侧名形如 coverage-review / explorer；
 *  acceptance-design 侧名形如 designer-r1 / acceptance-reviewer-r1）。 */
function agentStub(state, handlers, keyOf = (name) => name.replace(/-review$/, "")) {
  return (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const key = keyOf(name);
    const handler = handlers[key];
    assert.ok(handler !== undefined, `未预期的 agent 实例：${name}`);
    return {
      ask: async (...askArgs) => {
        const instructions = String(askArgs[askArgs.length - 1]);
        state.prompts[key] = (state.prompts[key] ?? []).concat(instructions);
        for (const m of instructions.matchAll(/写入路径：(\S+)/g)) {
          mkdirSync(join(m[1], ".."), { recursive: true });
          writeFileSync(m[1], `# 桩产物（${m[1]}）\n`);
        }
        return handler(instructions, state);
      },
    };
  };
}

/** acceptance-design 侧实例名 → handler 键（designer-r1 → designer；acceptance-reviewer-r1 → reviewer） */
const adKeyOf = (name) => (name.includes("reviewer") ? "reviewer" : name.replace(/-r\d+$/, ""));

async function runIaWorkflow(home, argsValue, agentImpl) {
  const js = transpile(readFileSync(IA_DWF, "utf8"));
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
  const logs = [];
  const result = await fn(
    argsValue, world, (m) => logs.push(String(m)), () => {}, () => {},
    { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
    agentImpl,
  );
  return { result, logs };
}

const readEvents = (taskDir) => readFileSync(join(taskDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const baseArgs = (s) => ({ projectRoot: s.projectRoot, taskDir: s.taskDir, assuranceCredentialId: "stub-assurance-cred" });

const implementingVerdict = { state: "implementing", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };
const candidateVerdict = { state: "candidate", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };
const acceptedVerdict = { state: "accepted", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };

/** 默认 coverage 处理器：两个能力各申报一条 IA 亲自观察（probe artifact 落 evidence/） */
function coverageHandler({ observations, parityRecords = [] } = {}) {
  return (instructions, state) => {
    const evidenceDir = join(state.taskDir, "evidence");
    const obs = observations ?? [
      { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(evidenceDir, "probeLoad.json"), executedBy: "assurance-agent" },
      { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(evidenceDir, "probeDispatch.json"), executedBy: "assurance-agent" },
    ];
    writeFileSync(join(evidenceDir, "probeLoad.json"), `${JSON.stringify(probeArtifact(), null, 2)}\n`);
    writeFileSync(join(evidenceDir, "probeDispatch.json"), `${JSON.stringify(probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], caseId: "dispatch-basic" }), null, 2)}\n`);
    const evidence = [
      { requirementId: "R1", kind: "command", result: "verified", assertionIds: ["A1"], adversarialFormIds: ["AF1"], artifact: join(evidenceDir, "probeLoad.json") },
      { requirementId: "R2", kind: "scenario", result: "verified", assertionIds: ["A2"], adversarialFormIds: ["AF2"], artifact: join(evidenceDir, "probeDispatch.json") },
    ];
    return { summary: "逐断言复核完成（桩）", evidence, findings: [], resolvedFindingIds: [], unresolvedFindingIds: [], contractObservations: obs, parityRecords };
  };
}

// ── 1. resolver 脚本不在安装位 → authority-missing must-fix（审查发现 13a）──

test("IA 负路径：resolver 脚本不在安装位 → essential 契约登记 authority-missing must-fix（blocker 不降 info）", async () => {
  const home = tmpHome();
  try {
    // installResolver=false：安装位没有 resolve-external-contracts.mjs（存在性检查分支）
    const s = makeIaScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict], installResolver: false });
    const state = { taskDir: s.taskDir, prompts: {} };
    const stub = agentStub(state, {
      coverage: coverageHandler(),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result, logs } = await runIaWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", `应走完保证（logs: ${logs.join(" | ")}）`);
    const events = readEvents(s.taskDir);
    const missing = events.filter((e) => e.type === "FindingRaised" && /authority-missing/.test(e.summary));
    assert.equal(missing.length, 1, "resolver CLI 缺失应登记 authority-missing finding");
    assert.equal(missing[0].severity, "blocker", "authority-missing 必须 must-fix（blocker），不得降 info");
    assert.match(missing[0].summary, /resolver CLI 不存在|resolver 运行失败/, "finding 须点名 resolver 缺失（存在性检查分支）");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 2. manual-handoff 观察缺 reason → 结构校验拒绝（审查发现 13b）──

test("IA 负路径：manual-handoff 观察缺 manualHandoffReason → 审查响应结构校验拒绝（转人工是登记不是静默跳过）", async () => {
  const home = tmpHome();
  try {
    const s = makeIaScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict], installResolver: true });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    // 观察申报 executedBy=manual-handoff 但缺 manualHandoffReason（非法结构）
    const badObservations = [
      { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
      { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "manual-handoff" },
    ];
    const stub = agentStub(state, {
      coverage: coverageHandler({ observations: badObservations }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runIaWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-failed", "非法观察结构（修正重问耗尽）应走失败出口");
    assert.match(result.message, /manualHandoffReason/, "终态披露须点名缺失的转人工理由字段");
    assert.match(result.message, /转人工是登记不是静默跳过/, "须体现转人工登记纪律");
    // 非法结构不得落成合法事件流里的观察登记
    const events = readEvents(s.taskDir);
    assert.ok(!events.some((e) => e.type === "EvidenceRecorded" && e.artifact?.endsWith("probeDispatch.json")), "结构非法的观察不得登记证据");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 3. acceptance-design 审查响应 riskCoverage 三条负路径（审查发现 6）──

const RISK_CATEGORIES = [
  "blocking", "injection-cost", "identity-alias", "control-state", "concurrent-rewrite",
  "failure-modes", "recovery", "observability", "input-validation", "contract-single-source",
];

/** acceptance-design 脚手架：临时 HOME 装桩 gate/core/detect/resolve/角色 + 任务目录 */
function makeAdScaffold(home) {
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ schemaVersion: 2, taskId: "ad-neg", projectRoot }));
  writeFileSync(join(taskDir, "intent.md"), "# 原始意图\n实现内部库改造\n");
  writeFileSync(join(taskDir, "events.jsonl"), "");
  const scripts = join(home, ".agents/skills/delivery-v6/scripts");
  const policies = join(home, ".agents/skills/delivery-v6/policies");
  const roles = join(home, ".agents/skills/delivery-v6/references/roles");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(policies, { recursive: true });
  mkdirSync(roles, { recursive: true });
  for (const r of ["designer", "acceptance-reviewer"]) writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);
  // 策略包用真文件复本（prompt 引用其路径；结构校验不依赖其内容）
  require("node:fs").copyFileSync(POLICY_FILE, join(policies, "external-contract-classes.json"));
  // 桩 gate：snapshot-policy / validate-acceptance / record-review 全部放行
  writeFileSync(join(scripts, "delivery-gate.mjs"), [
    "const cmd = process.argv[2];",
    "if (cmd === 'snapshot-policy') { process.stdout.write('{}'); process.exit(0); }",
    "if (cmd === 'validate-acceptance') { process.stdout.write('{}'); process.exit(0); }",
    "if (cmd === 'record-review') { process.stdout.write(JSON.stringify({ eventId: 'evt-review' })); process.exit(0); }",
    "process.stderr.write('stub gate: 未知命令 ' + cmd); process.exit(2);",
  ].join("\n"));
  // 桩 core：loop-budget / loop-attempt 放行
  writeFileSync(join(scripts, "delivery-core.mjs"), [
    "const cmd = process.argv[2];",
    "if (cmd === 'loop-budget') { process.stdout.write(JSON.stringify({ exceeded: false, started: 0, cap: 8 })); process.exit(0); }",
    "if (cmd === 'loop-attempt') { process.stdout.write('{}'); process.exit(0); }",
    "process.stderr.write('stub core: 未知命令 ' + cmd); process.exit(2);",
  ].join("\n"));
  // 桩 detect：空候选快照（本组用例不测探测）
  writeFileSync(join(scripts, "detect-external-contracts.mjs"), "process.stdout.write(JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }));\n");
  // 桩 resolve：空快照 + 稳定 snapshotSha256（ESM 形态——与真实 CLI 同模块类型）
  writeFileSync(join(scripts, "resolve-external-contracts.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "const taskDir = argv[argv.indexOf('--task-dir') + 1];",
    "process.stdout.write(JSON.stringify({ schemaVersion: 1, snapshotSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', contracts: [], unresolvedContracts: [] }));",
    "fs.mkdirSync(path.join(taskDir, 'environment-contracts'), { recursive: true });",
    "fs.writeFileSync(path.join(taskDir, 'environment-contracts', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.json'), JSON.stringify({ schemaVersion: 1, snapshotSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', contracts: [] }));",
  ].join("\n"));
  return { projectRoot, taskDir };
}

/** designer 桩：写最小合法验收包（无外部契约——本组只测 riskCoverage 校验） */
function designerHandler() {
  return () => {
    return { summary: "写入验收草稿（桩）" };
  };
}

/** 让 designer 桩真正落盘三件草稿（acceptance/solution/increments） */
function makeWritingDesigner(taskDir) {
  return () => {
    const acceptance = {
      schemaVersion: 2, acceptanceVersion: 1, taskId: "ad-neg", projectRoot: "PLACEHOLDER",
      objective: "内部库改造", nonGoals: [], riskLevel: "low", exploratoryReview: "not-required", reviewDimensions: ["smoke"],
      requirements: [{
        id: "R1", kind: "invariant", statement: "内部工具返回稳定结果", required: true, riskAcceptable: false, evidenceKinds: ["command"],
        assertions: [{ id: "A1", statement: "返回稳定结果", qualifiers: ["输入合法"], given: "合法输入", when: "调用", then: "返回结果", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"] }],
      }],
      adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "输入合法", entryPoint: "auto", initialState: "s", operation: "非法输入", timing: "调用期", expected: "拒绝", testAssetRefs: ["test-A1"], rationale: "r" }],
    };
    writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(join(taskDir, "solution.md"), "# 方案\n");
    writeFileSync(join(taskDir, "increments.json"), JSON.stringify({ schemaVersion: 1, acceptanceVersion: 1, items: [{ id: "I1", title: "实现", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }] }));
    return { summary: "写入验收草稿（桩）" };
  };
}

async function runAdWorkflow(home, argsValue, agentImpl) {
  const js = transpile(readFileSync(AD_DWF, "utf8"));
  const world = {
    run: async (cmd, a) => {
      const r = spawnSync(cmd, a ?? [], { encoding: "utf8", cwd: home, env: { ...process.env, HOME: home }, timeout: 30000 });
      return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
  const fn = new vm.Script(`(async function __main__(args, world, log, phase, report, artifact, agent) {\n${js}\n})`).runInNewContext({});
  const logs = [];
  const result = await fn(
    argsValue, world, (m) => logs.push(String(m)), () => {}, () => {},
    { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
    agentImpl,
  );
  return { result, logs };
}

const adArgs = (s) => ({ projectRoot: s.projectRoot, taskDir: s.taskDir, objective: "内部库改造", assuranceCredentialId: "stub-assurance-cred", maxRounds: 1 });

/** reviewer 响应工厂：riskCoverage 形态可控，其余字段合法 */
function reviewerOutcome(riskCoverage) {
  return {
    summary: "审查完成（桩）",
    problems: [],
    counterImplementations: [],
    riskCoverage,
  };
}

const validRiskCoverage = () => RISK_CATEGORIES.map((category) => ({ category, state: "not-applicable", detail: "本任务无此类风险（桩）" }));

for (const [label, build, expectedPattern] of [
  ["缺一类（九类齐一类缺失）", () => validRiskCoverage().slice(0, 9), /riskCoverage 缺类别/],
  ["非法 state（十类齐但 state 非法）", () => validRiskCoverage().map((entry, index) => (index === 0 ? { ...entry, state: "maybe" } : entry)), /riskCoverage\.state 须为 covered \/ not-applicable \/ needs-criteria 之一/],
  ["重复类别（同一类登记两次）", () => [...validRiskCoverage(), { category: "blocking", state: "covered", detail: "重复登记（桩）" }], /riskCoverage 类别 blocking 重复登记/],
]) {
  test(`验收审查响应校验：riskCoverage ${label} → 结构校验拒绝并进终态披露`, async (t) => {
    const home = tmpHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const s = makeAdScaffold(home);
    const state = { prompts: {} };
    // designer 落盘草稿时回填真实 projectRoot（loadWorld 式核对由桩 gate 放行，此处保机械后验可过）
    const designer = () => {
      makeWritingDesigner(s.taskDir)();
      const acceptance = JSON.parse(readFileSync(join(s.taskDir, "acceptance.json"), "utf8"));
      acceptance.projectRoot = s.projectRoot;
      writeFileSync(join(s.taskDir, "acceptance.json"), JSON.stringify(acceptance));
      return { summary: "写入验收草稿（桩）" };
    };
    const reviewer = () => reviewerOutcome(build());
    const stub = agentStub(state, { designer, reviewer }, adKeyOf);
    const { result, logs } = await runAdWorkflow(home, adArgs(s), stub);
    assert.equal(result.terminated, "design-failed", `非法 riskCoverage 应打回终态（logs: ${logs.join(" | ")}）`);
    assert.match(result.message, new RegExp(expectedPattern.source), `终态披露须点名：${expectedPattern.source}`);
    // 非法响应不得登记 AcceptanceReviewed
    const events = readFileSync(join(s.taskDir, "events.jsonl"), "utf8");
    assert.ok(!events.includes("AcceptanceReviewed"), "结构非法的审查响应不得进入登记");
  });
}

test("验收审查响应校验：riskCoverage 十类齐备且三值合法 → 放行（对照，防校验器全拒）", async (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const s = makeAdScaffold(home);
  const state = { prompts: {} };
  const designer = () => {
    makeWritingDesigner(s.taskDir)();
    const acceptance = JSON.parse(readFileSync(join(s.taskDir, "acceptance.json"), "utf8"));
    acceptance.projectRoot = s.projectRoot;
    writeFileSync(join(s.taskDir, "acceptance.json"), JSON.stringify(acceptance));
    return { summary: "写入验收草稿（桩）" };
  };
  const stub = agentStub(state, { designer, reviewer: () => reviewerOutcome(validRiskCoverage()) }, adKeyOf);
  const { result, logs } = await runAdWorkflow(home, adArgs(s), stub);
  assert.equal(result.terminated, "acceptance-ready", `合法响应应放行（logs: ${logs.join(" | ")}；message: ${result.message}）`);
  // 契约审查 artifact 落盘（riskCoverage 十类进 r1-contract-check.json）
  const artifactDir = join(s.taskDir, "evidence", "acceptance-review", "v1");
  const files = require("node:fs").readdirSync(artifactDir, { recursive: true }).filter((f) => String(f).endsWith("contract-check.json"));
  assert.ok(files.length >= 1, "应落盘契约审查 artifact");
  const artifact = JSON.parse(readFileSync(join(artifactDir, ...String(files[0]).split("/")), "utf8"));
  assert.equal(artifact.riskCoverage.length, 10, "artifact 应登记十类 riskCoverage");
});
