// ia-contract-independence-v6.test.mjs — independent-assurance-v6 外部契约假设源独立回归
//（设计《V6 运行可用性与外部契约守门升级》§8.2 假设源独立六条 / §8.3 fake-host parity /
// §5.2 证据来源矩阵 / §5.3 negative case 亲自执行 / §13 deliveryProfile=a 探索降档）
//
// 覆盖（实现：workflows/src/independent-assurance-v6.shared.ts）：
//   1. 结构断言：机器侧六条硬责任的落点标记（resolver 亲自运行 / authority-missing /
//      iaExecuted / manual-handoff / parity 校验 / probe 时鲜 / 降档维度 / runtime 绑定参数）
//   2. 亲自运行 resolver：spawn 记录（无 --write）+ 权威 surface 哈希核对 + essential
//      契约 resolved 时不登记 authority-missing，逐能力 IA 观察通过时 iaExecuted=true
//   3. authority 不可得（resolver 失败 / declared-unavailable）→ authority-missing must-fix
//      （severity=blocker，不降 info）
//   4. essential 能力零 IA 亲自执行观察 → must-fix（builder 自报不能替代）
//   5. real-host 转人工通道：manual-handoff 登记 + obligation open + 披露，不静默跳过
//   6. probe 时鲜：subject.revision 与当前 revision 不一致 → must-fix（早期 spike 不替代 final）
//   7. runtime 绑定：仅 IA 亲自执行的 probe 证据带 contractCapabilityIds/runtimeProbe；
//      gate 拒收 additive 参数时退化为无绑定登记并披露（义务保持 open）
//   8. fake-host parity：same=false 只披露不失败；realObserved.caseId 不存在 → must-fix
//   9. deliveryProfile=a 探索降档：explorer 只收到契约与故障两类维度
//  10. recheck：coverage prompt 注入 probe 重跑义务，resolver 仍亲自运行
//  11. 反例 artifact 双形态：*-counter-implementations.json（旧）与
//      *-contract-check.json（验收线现行）都能收集并对账；有引用零执行 → must-fix
//  12. 环境漂移披露：--write 快照的 aggregateHash 与本轮 stdout 不一致时披露且不静默
//  13. 无外部契约任务：契约机器侧段整体跳过（resolver 不 spawn、不写契约记录）——回归保护
//
// 运行：node --test scripts/tests/ia-contract-independence-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMjsScript } from "./helpers/mjs-runner.mjs";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
const SRC = join(WF, "src/independent-assurance-v6.shared.ts");
const PI_TPL = join(WF, "src/independent-assurance-v6.pi.tpl.js");
const DWF = join(WF, "independent-assurance-v6.dwf.ts");
const ts = require("typescript");

const transpile = (code) =>
  ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const REVISION = "rev-contract-1";
const AGGREGATE_HASH = "agg-hash-EC-test-0001";
const CONTRACT_ID = "EC-test";

const tmpHome = () => mkdtempSync(join(tmpdir(), "ia-contract-v6-"));

/** 权威工件目录：surface 文件内容与 resolver 快照登记哈希逐字节一致（NODE_VERIFY_SURFACES 核对） */
function makeAuthority(root) {
  const dir = join(root, "authority");
  mkdirSync(join(dir, "dist/core/extensions"), { recursive: true });
  writeFileSync(join(dir, "dist/core/extensions/loader.js"), "// 权威 loader（桩）\nmodule.exports = {};\n");
  writeFileSync(join(dir, "dist/core/agent.js"), "// 权威 agent（桩）\nmodule.exports = {};\n");
  return dir;
}

/** 任务脚手架：git 项目 + 任务目录 + 外部契约验收包 + 桩 gate/core/resolver/角色 */
function makeScaffold(home, { verdictQueue, resolverMode = "resolved", deliveryProfile = null, reviewDimensions = ["外部契约", "故障形态", "状态机时序"], counterImplementations = null, counterArtifactForm = "contract-check" } = {}) {
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
    schemaVersion: 2, taskId: "ia-contract", projectRoot,
    ...(deliveryProfile === null ? {} : { deliveryProfile }),
  }));
  const acceptance = {
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: "ia-contract",
    projectRoot,
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions,
    requirements: [
      {
        id: "R1", statement: "扩展经官方 runner 装载", required: true, riskAcceptable: false,
        evidenceKinds: ["command"],
        assertions: [{
          id: "A1", statement: "装载后得到注册清单", qualifiers: [], given: "已安装权威包", when: "official-runner 装载", then: "注册清单非空",
          adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
          requiredEnvironment: { kind: "official-runner", capability: "load-extension" },
        }],
      },
      {
        id: "R2", statement: "斜杠命令经真实宿主分发", required: true, riskAcceptable: false,
        evidenceKinds: ["scenario"],
        assertions: [{
          id: "A2", statement: "用户输入命中注册命令", qualifiers: [], given: "命令已注册", when: "用户输入命令", then: "handler 执行",
          adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"],
          requiredEnvironment: { kind: "real-host", capability: "dispatch-slash-command" },
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
  };
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify(acceptance));
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify({
    schemaVersion: 2, acceptanceVersion: 1,
    items: [
      { id: "I1", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } },
      { id: "I2", title: "命令分发", requirementIds: ["R2"], testCommand: { program: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30000 } },
    ],
  }));
  writeFileSync(join(taskDir, "policy-snapshot.json"), JSON.stringify({ "revision.json": {} }));
  writeFileSync(join(taskDir, "events.jsonl"), "");
  if (counterImplementations !== null) {
    const counterDir = join(taskDir, "evidence/acceptance-review/v1/run1");
    mkdirSync(counterDir, { recursive: true });
    if (counterArtifactForm === "legacy") {
      // 旧形态：顶层为 CounterImplementation 数组
      writeFileSync(join(counterDir, "r1-counter-implementations.json"), JSON.stringify(counterImplementations, null, 2));
    } else {
      // 新形态（验收线现行）：r<round>-contract-check.json 对象，counterImplementations 为字段
      writeFileSync(join(counterDir, "r1-contract-check.json"), JSON.stringify({
        acceptanceVersion: 1, runId: "run1", round: 1, essentialContractIds: [CONTRACT_ID],
        counterImplementations, riskCoverage: [], contractDiscrimination: undefined,
      }, null, 2));
    }
  }

  const authorityDir = makeAuthority(home);
  const roles = join(home, ".agents/skills/delivery-v6/references/roles");
  const scripts = join(home, ".agents/skills/delivery-v6/scripts");
  mkdirSync(roles, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const r of ["coverage-reviewer", "explorer"]) writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);

  // 桩 delivery-gate：evaluate 出队 + 高层记录命令落 events.jsonl。
  // rejectAdditive=true 模拟内核线未落地时的参数拒收（parseOptions 语义：未知参数 exit 2）
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
    // record-evidence 复刻真实 gate 语义：缺 --artifact-sha256 时按 join(taskDir, artifact)
    // 自算内容哈希——绝对路径 artifact 拼出双段路径必失败（IA 的 evidenceRoot 约定是绝对
    // 路径，故必须显式透传 artifact-sha256；相对路径则自算成功）
    "  'record-evidence': (a) => {",
    "    const artifact = opt('artifact') || '';",
    "    if (opt('artifact-sha256') === undefined && artifact.startsWith('/')) { process.stderr.write('无法读取 --artifact ' + artifact + '：' + require('path').join(opt('task-dir'), artifact) + '（ENOENT）'); process.exit(1); }",
    "    return { type: 'EvidenceRecorded', requirementId: opt('requirement-id'), kind: opt('kind'), result: opt('result'), summary: opt('summary'), artifact, ...(opt('artifact-sha256') !== undefined ? { artifactSha256: opt('artifact-sha256') } : {}), ...(opt('assertion-ids') !== undefined ? { assertionIds: JSON.parse(opt('assertion-ids')) } : {}), ...(opt('adversarial-form-ids') !== undefined ? { adversarialFormIds: JSON.parse(opt('adversarial-form-ids')) } : {}), ...(opt('contract-capability-ids') !== undefined ? { contractCapabilityIds: JSON.parse(opt('contract-capability-ids')) } : {}), ...(has('runtime-probe') ? { runtimeProbe: true } : {}) };",
    "  },",
    "  'record-exploration': () => ({ type: 'ExplorationCompleted', dimensions: JSON.parse(opt('dimensions') || '[]'), summary: opt('summary') }),",
    "  'complete-assurance': () => ({ type: 'AssuranceCompleted', mode: opt('mode'), summary: opt('summary') }),",
    "  'record-assurance-drift': () => ({ type: 'AssuranceRevisionDrift' }),",
    "};",
    "if (Object.hasOwn(RECORD, cmd)) {",
    "  const credential = opt('credential');",
    "  if (typeof credential !== 'string' || credential === '') { process.stderr.write('缺少 --credential'); process.exit(2); }",
    "  const reject = process.env.STUB_GATE_REJECT_ADDITIVE === '1';",
    "  if (reject && (has('contract-capability-ids') || has('runtime-probe'))) { process.stderr.write('命令含未知参数 --contract-capability-ids 或 --runtime-probe'); process.exit(2); }",
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

  // 桩 delivery-core：IA v6 消费的内核判定（usable-explorations / exploration-due /
  // open-findings / full-qualification / revision-provenance / loop-attempt）
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

  // 桩 resolve-external-contracts.mjs：对齐真实 CLI 契约（schemaVersion 1 stdout 摘要：
  // contracts[].{id,status,authorityAggregateHash,identity,surfaces} + snapshotSha256 +
  // unresolvedContracts；stdout 不含 resolvedPath）。同时按 --write 产物形态落
  // environment-contracts.current.json 指针与快照文件（resolver.resolvedPath +
  // aggregateHash 键）——IA 的 surface 核对从快照取路径、从 stdout 取哈希
  writeFileSync(join(scripts, "resolve-external-contracts.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import crypto from 'node:crypto';",
    "const argv = process.argv.slice(2);",
    "const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };",
    "const taskDir = opt('task-dir');",
    "const configPath = path.join(taskDir, 'resolver-config.json');",
    "const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { mode: 'resolved' };",
    "const invocation = { argv: process.argv.slice(2), write: argv.includes('--write'), mode: config.mode };",
    "fs.writeFileSync(path.join(taskDir, 'resolver-invoked.json'), JSON.stringify(invocation));",
    "if (config.mode === 'fail') { process.stderr.write('resolver 桩：解析失败'); process.exit(1); }",
    "if (config.mode === 'bad-json') { process.stdout.write('not-json'); process.exit(0); }",
    "if (config.mode === 'unavailable') {",
    "  process.stdout.write(JSON.stringify({ schemaVersion: 1, snapshotSha256: 'snap-unavail', contracts: [{ id: config.contractId || 'EC-test', status: 'declared-unavailable', authorityAggregateHash: null, identity: null, surfaces: [] }], unresolvedContracts: [{ contractId: config.contractId || 'EC-test', reason: '权威包不可解析（桩）' }] }));",
    "  process.exit(0);",
    "}",
    "const contractId = config.contractId || 'EC-test';",
    "const authorityDir = config.authorityDir;",
    "const aggregateHash = config.authorityAggregateHash || 'agg-hash-EC-test-0001';",
    "const surfaces = (config.surfaces || []).map((ref) => {",
    "  const file = ref.split('#')[0];",
    "  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(authorityDir, file))).digest('hex');",
    "  return { surfaceRef: ref, sha256: hash };",
    "});",
    "const snapshotSha256 = config.snapshotSha256 || 'snap-resolved';",
    "// stdout 摘要（IA 无 --write 亲自运行的输出）",
    "process.stdout.write(JSON.stringify({",
    "  schemaVersion: 1,",
    "  snapshotSha256,",
    "  contracts: [{ id: contractId, status: 'resolved', authorityAggregateHash: aggregateHash, identity: { name: 'test-authority', version: '1.0.0' }, surfaces }],",
    "  unresolvedContracts: [],",
    "}));",
    "// --write 产物形态：current 指针 + 按哈希分文件快照（含 resolver.resolvedPath 与 aggregateHash 键）",
    "if (config.writeSnapshot !== false) {",
    "  const dir = path.join(taskDir, 'environment-contracts');",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  const snapshot = { schemaVersion: 1, snapshotSha256, contracts: [{ id: contractId, status: 'resolved', resolver: { kind: 'installed-npm-package', locator: 'test-authority', resolvedPath: authorityDir, resolution: 'project-dependency' }, identity: { name: 'test-authority', version: '1.0.0' }, surfaces, aggregateHash: config.snapshotAggregateHash || aggregateHash, resolvedAt: '2026-01-01T00:00:00.000Z' }] };",
    "  fs.writeFileSync(path.join(dir, `${snapshotSha256}.json`), JSON.stringify(snapshot, null, 2));",
    "  fs.writeFileSync(path.join(dir, 'environment-contracts.current.json'), JSON.stringify({ schemaVersion: 1, snapshotSha256, snapshotPath: `environment-contracts/${snapshotSha256}.json`, updatedAt: '2026-01-01T00:00:00.000Z' }, null, 2));",
    "}",
  ].join("\n"));

  return { projectRoot, taskDir, authorityDir };
}

/** probe artifact（设计 §6.3 结构）；observedValues 可注入失败样本 */
function probeArtifact({ revision = REVISION, sourceHash = AGGREGATE_HASH, capabilities = ["load-extension"], cases = null, kind = "official-runner", name = "test-authority" } = {}) {
  const caseList = cases ?? [{ capabilityId: "load-extension", caseId: "load-basic", operation: "装载扩展", observed: { registered: true }, passed: true }];
  const passed = caseList.filter((c) => c.passed).length;
  return {
    environment: { kind, name, version: "1.0.0", source: "authority", sourceHash, driver: "probe.mjs", driverHash: sha256("driver"), capabilities },
    subject: { revision, entrypoint: "dist/core/extensions/loader.js" },
    cases: caseList,
    summary: { passed, failed: caseList.length - passed, skipped: 0 },
  };
}

/** 可配置 agent 桩：按实例名分发，记录 prompt 供断言；「写入路径：X」行在 ask 内落盘 */
function agentStub(state, handlers) {
  const impl = (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const key = name.replace(/-review$/, "");
    const handler = handlers[key];
    assert.ok(handler !== undefined, `未预期的 agent 实例：${name}`);
    return {
      ask: async (...askArgs) => {
        const instructions = String(askArgs[askArgs.length - 1]);
        state.prompts[key] = (state.prompts[key] ?? []).concat(instructions);
        const value = handler(instructions, state);
        for (const m of instructions.matchAll(/写入路径：(\S+)/g)) writeFileSync(m[1], `# 桩产物（${m[1]}）\n`);
        return value;
      },
    };
  };
  return impl;
}

// node -e 探针进程内执行：与 helpers/mjs-runner.mjs 的 runNodeProbe 同语义，另加
// os.homedir() 读 $HOME 包装——NODE_PROBE_HOME 探针（require('os').homedir()）经真实
// spawn 时 homedir() 读注入 HOME，主进程直接求值会漏回用户真实 home
class ProbeExitSignal {}
const PROBE_EXIT = new ProbeExitSignal();
const probeCache = new Map();
function runProbe(script, restArgs, { env, cwd }) {
  let stdout = "";
  let stderr = "";
  let status = 0;
  const baseRequire = createRequire(pathToFileURL(join(cwd, "x")).href);
  const osMod = baseRequire("os");
  const osWrapped = Object.create(osMod);
  osWrapped.homedir = () => env.HOME ?? osMod.homedir();
  const ctxRequire = (id) => (id === "os" || id === "node:os" ? osWrapped : baseRequire(id));
  const ctx = {
    require: ctxRequire,
    console: {
      log: (...m) => { stdout += m.map(String).join(" ") + "\n"; },
      error: (...m) => { stderr += m.map(String).join(" ") + "\n"; },
    },
    process: {
      argv: [process.execPath, ...restArgs],
      env,
      platform: process.platform,
      cwd: () => cwd,
      stdout: { write: (s) => { stdout += String(s); return true; } },
      stderr: { write: (s) => { stderr += String(s); return true; } },
      exit: (c) => {
        status = typeof c === "number" ? c : 0;
        throw PROBE_EXIT;
      },
    },
    Buffer,
  };
  ctx.globalThis = ctx;
  let fn = probeCache.get(script);
  if (fn === undefined) {
    fn = new vm.Script(`(function(){\n${script}\n})`);
    probeCache.set(script, fn);
  }
  try {
    fn.runInNewContext(ctx)();
  } catch (e) {
    if (!(e instanceof PROBE_EXIT)) {
      stderr += String(e && e.stack ? e.stack : e) + "\n";
      status = 1;
    }
  }
  return { status, stdout, stderr, error: undefined };
}

// world.run 提速通道：IA 桩脚本（gate/core/resolver，HOME 安装位自建桩）零改动转译进
// 沙箱执行，node -e 探针进程内求值（os.homedir() 按 $HOME 语义包装），git/sh 等回退
// 真实 spawn。CLI spawn 通道仅存于防漂移对拍锚（进程内 == spawn 逐字节一致）
function makeWorldSpawn({ home, env }) {
  const scriptsDir = join(home, ".agents", "skills", "delivery-v6", "scripts");
  const mjsSet = new Set([
    join(scriptsDir, "delivery-gate.mjs"),
    join(scriptsDir, "delivery-core.mjs"),
    join(scriptsDir, "resolve-external-contracts.mjs"),
  ]);
  return (cmd, args, opts = {}) => {
    const a = args ?? [];
    if (cmd === "node" || cmd === process.execPath) {
      if (a[0] === "-e" && typeof a[1] === "string") return runProbe(a[1], a.slice(2), { env, cwd: home });
      const target = a[0];
      if (typeof target === "string" && target.endsWith(".mjs") && mjsSet.has(target)) {
        return runMjsScript(target, a.slice(1), { env, cwd: home });
      }
    }
    const r = spawnSync(cmd, a, { encoding: "utf8", cwd: home, ...opts, env: { ...env, ...(opts.env ?? {}) } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

async function runWorkflow(home, argsValue, agentImpl, { rejectAdditive = false } = {}) {
  const raw = readFileSync(DWF, "utf8");
  const js = transpile(raw);
  const logs = [];
  const env = { ...process.env, HOME: home, ...(rejectAdditive ? { STUB_GATE_REJECT_ADDITIVE: "1" } : {}) };
  const spawn = makeWorldSpawn({ home, env });
  const world = {
    run: async (cmd, a, opts) => {
      const r = spawn(cmd, a ?? [], { timeout: opts && opts.timeoutMs ? opts.timeoutMs : 30000 });
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

const baseArgs = (s, extra = {}) => ({ projectRoot: s.projectRoot, taskDir: s.taskDir, assuranceCredentialId: "stub-assurance-cred", ...extra });
const readEvents = (taskDir) => readFileSync(join(taskDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const readEvidenceJson = (taskDir, prefix) => {
  const dir = join(taskDir, "evidence");
  const name = readFileSync === null ? "" : (existsSync(dir) ? require("node:fs").readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".json")) : undefined);
  return name === undefined ? null : JSON.parse(readFileSync(join(dir, name), "utf8"));
};

const implementingVerdict = { state: "implementing", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };
const candidateVerdict = { state: "candidate", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };
const acceptedVerdict = { state: "accepted", revision: REVISION, acceptanceVersion: 1, missing: { incrementIds: [] }, openFindings: [] };

/** 默认 coverage 处理器工厂：observations/parity 由用例注入 */
function coverageHandler({ observations = [], parityRecords = [], probeFiles = {} } = {}) {
  return (instructions, state) => {
    const evidenceDir = join(state.taskDir, "evidence");
    // 宿主类断言的证据 artifact 即 probe artifact（提示词要求；机器据此登记 runtime 绑定）
    const probePaths = {};
    for (const [key, doc] of Object.entries(probeFiles)) {
      const p = join(evidenceDir, `${key}.json`);
      writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
      probePaths[key] = p;
    }
    const evidence = [
      { requirementId: "R1", kind: "command", result: "verified", assertionIds: ["A1"], adversarialFormIds: ["AF1"], artifact: probePaths.probeLoad ?? join(evidenceDir, "builder-test.log") },
      { requirementId: "R2", kind: "scenario", result: "verified", assertionIds: ["A2"], adversarialFormIds: ["AF2"], artifact: probePaths.probeDispatch ?? join(evidenceDir, "builder-test.log") },
    ];
    if (!existsSync(join(evidenceDir, "builder-test.log"))) writeFileSync(join(evidenceDir, "builder-test.log"), "builder 测试日志（桩）\n");
    return { summary: "逐断言复核完成（桩）", evidence, findings: [], resolvedFindingIds: [], unresolvedFindingIds: [], contractObservations: observations, parityRecords };
  };
}

// ── 1. 结构断言：六条硬责任的机器侧落点 ──

test("结构断言：IA v6 机器侧六条硬责任与 parity/降档/runtime 绑定落点", () => {
  const src = readFileSync(SRC, "utf8");
  const markers = [
    ["resolver 亲自运行（无 --write）", /resolve-external-contracts\.mjs[\s\S]*?"--task-dir", taskDir, "--project-root", projectRoot/],
    ["resolver CLI 缺失按失败处理", /resolver CLI 不存在/],
    ["authority-missing must-fix（blocker 不降 info）", /authority-missing[\s\S]*?tier: "must-fix"/],
    ["权威 surface 完整性核对", /NODE_VERIFY_SURFACES/],
    ["逐能力亲自观察义务（essential）", /无 IA 亲自执行观察/],
    ["转人工通道（unknown 纪律：登记不静默跳过）", /manual-handoff/],
    ["probe 时鲜对账（早期 spike 不替代 final）", /早期 spike 不能替代 final/],
    ["runtime 绑定参数", /--contract-capability-ids/],
    ["runtimeProbe 仅 IA 亲自执行证据", /runtimeProbe/],
    ["recheck 重跑 probe 义务", /recheck 重跑 probe|重跑 runtime probe/],
    ["fake-host parity 校验", /realObserved\.caseId/],
    ["parity 差异处置（升级真实断言或修 mock）", /升级为真实环境断言或修 mock/],
    ["证据来源矩阵三态", /fakeHost[\s\S]*?officialRunner[\s\S]*?realHost/],
    ["deliveryProfile=a 探索降档维度", /PROFILE_A_DIMENSIONS/],
    ["iaExecuted 汇总字段（gate 线消费）", /iaExecuted/],
    ["反例 artifact 双形态收集（counter-implementations + contract-check）", /counter-implementations\|contract-check/],
    ["EvidenceRecorded 显式透传 artifact-sha256（gate 绝对路径自算不兼容）", /--artifact-sha256", String\(event\.artifactSha256\)/],
  ];
  for (const [label, pattern] of markers) {
    assert.match(src, pattern, `shared.ts 缺落点：${label}`);
  }
  const pi = readFileSync(PI_TPL, "utf8");
  assert.match(pi, /contractObservations/, "pi 壳 SCHEMA 镜像缺 contractObservations");
  assert.match(pi, /parityRecords/, "pi 壳 SCHEMA 镜像缺 parityRecords");
});

// ── 2. 主路径：resolver 亲自运行 + 逐能力 IA 观察通过 + runtime 绑定 ──

test("主路径：IA 亲自运行 resolver 并核对权威 surface，逐能力观察通过时 iaExecuted=true 且证据带 runtime 绑定", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict],
      counterImplementations: [{
        obligationId: "R1", contractId: CONTRACT_ID, counterImplementation: "fake-host 完全替代真实宿主", violatesIntent: "装载语义未经真实环境验证",
        discriminatingScenarioRef: "neg-load-fake-host", wouldPassCurrentCriteria: false,
      }],
    });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({
      mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH,
      surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"],
    }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({
      kind: "real-host", capabilities: ["dispatch-slash-command"],
      cases: [{ capabilityId: "dispatch-slash-command", caseId: "dispatch-basic", operation: "输入 /memory off", observed: { resolvedCommand: "memory", registered: true }, passed: true }],
    });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent", negativeCaseRefs: ["neg-load-fake-host"] },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "开放探索完成（桩）", dimensions: ["外部契约", "故障形态", "状态机时序"], findings: [] }),
    });
    const { result, logs } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", `主路径应走通（logs: ${logs.join(" | ")}；message: ${result.message}）`);

    // resolver 由 IA 亲自运行且无 --write
    const invocation = JSON.parse(readFileSync(join(s.taskDir, "resolver-invoked.json"), "utf8"));
    assert.equal(invocation.write, false, "IA 运行 resolver 不得带 --write（只解析不落盘）");
    assert.ok(invocation.argv.includes("--task-dir") && invocation.argv.includes("--project-root"), "resolver 调用须带 task-dir/project-root");

    // 权威 surface 全部命中（存在 + 哈希一致）
    const record = readEvidenceJson(s.taskDir, "contract-independence-");
    assert.ok(record !== null, "应生成契约独立性机器记录");
    const loadCheck = record.contracts[0].surfaceChecks.find((c) => c.surfaceRef === "dist/core/extensions/loader.js");
    assert.equal(loadCheck.found, true, "权威 surface 文件应在 resolvedPath 存在");
    assert.equal(loadCheck.sha256Match, true, "权威 surface 哈希应与快照登记一致");
    const dispatchCheck = record.contracts[0].surfaceChecks.find((c) => c.surfaceRef === "dist/core/agent.js#dispatch");
    assert.equal(dispatchCheck.found === true && dispatchCheck.sha256Match, true, "带 #符号 的 surfaceRef 应按文件部分核对");

    // 逐能力 iaExecuted=true；negative case 执行对账
    const loadCap = record.capabilities.find((c) => c.capabilityId === "load-extension");
    const dispatchCap = record.capabilities.find((c) => c.capabilityId === "dispatch-slash-command");
    assert.equal(loadCap.iaExecuted, true, "IA 亲自执行的观察应汇总 iaExecuted=true");
    assert.equal(loadCap.obligationOpen, false, "观察通过的 essential 能力义务应完成");
    assert.deepEqual(loadCap.negativeCaseRefs, ["neg-load-fake-host"], "negative case 亲自执行引用应登记");
    assert.equal(dispatchCap.iaExecuted, true);
    assert.equal(record.negativeCases[0].executed, true, "negative case 执行状态应进机器记录");

    // 证据来源矩阵：probe 证据按 environment.kind 计入三态
    const matrixLoad = record.evidenceMatrix.find((r) => r.capabilityId === "load-extension");
    assert.equal(matrixLoad.officialRunner, 1, "official-runner probe 证据应计入矩阵");
    assert.equal(matrixLoad.fakeHost, 0);
    const matrixDispatch = record.evidenceMatrix.find((r) => r.capabilityId === "dispatch-slash-command");
    assert.equal(matrixDispatch.realHost, 1, "real-host probe 证据应计入矩阵");

    // runtime 绑定：仅 probe 证据带 contractCapabilityIds/runtimeProbe
    const events = readEvents(s.taskDir);
    const evidenceEvents = events.filter((e) => e.type === "EvidenceRecorded");
    const probeEvidence = evidenceEvents.find((e) => e.artifact.endsWith("probeLoad.json"));
    assert.ok(probeEvidence !== undefined, "probe 证据应登记 EvidenceRecorded");
    assert.match(probeEvidence.artifactSha256 ?? "", /^[0-9a-f]{64}$/, "证据事件必须显式带 artifactSha256（gate 对绝对路径 artifact 的缺省自算不兼容，桩复刻该语义——缺了这条全部证据登记都会失败）");
    assert.deepEqual(probeEvidence.contractCapabilityIds, ["EC-test:load-extension"], "probe 证据应带「契约id:能力id」限定形式的能力绑定（gate 固定消费形态）");
    assert.equal(probeEvidence.runtimeProbe, true, "IA 亲自执行的 probe 证据应标 runtimeProbe");
    assert.ok(!evidenceEvents.some((e) => e.type === "EvidenceRecorded" && e.artifact.endsWith("builder-test.log")), "主路径不应有无 probe 的兜底证据");

    // 无 authority-missing / 无未完成义务披露
    assert.ok(!events.some((e) => e.type === "FindingRaised"), "主路径不应登记任何 finding");
    assert.ok(!/义务保持 open|未登记/.test(result.message), "主路径终态不应带未完成义务披露");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 3. authority 不可得 → authority-missing must-fix ──

test("authority 不可得：resolver 失败时 essential 契约登记 authority-missing must-fix（blocker，不降 info）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "fail", authorityDir: s.authorityDir }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const stub = agentStub(state, { coverage: coverageHandler(), explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }) });
    const { result, logs } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", `应走完保证（logs: ${logs.join(" | ")}）`);
    const events = readEvents(s.taskDir);
    const finding = events.find((e) => e.type === "FindingRaised" && /authority-missing/.test(e.summary));
    assert.ok(finding !== undefined, "resolver 失败应登记 authority-missing finding");
    assert.equal(finding.severity, "blocker", "authority-missing 必须 must-fix（blocker），不得降 info");
    assert.equal(finding.category, "defect");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("authority 不可得：declared-unavailable 快照同样登记 authority-missing must-fix", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "unavailable" }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const stub = agentStub(state, { coverage: coverageHandler(), explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }) });
    await runWorkflow(home, baseArgs(s), stub);
    const events = readEvents(s.taskDir);
    assert.ok(events.some((e) => e.type === "FindingRaised" && /authority-missing/.test(e.summary) && e.severity === "blocker"), "declared-unavailable 应登记 authority-missing must-fix");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 4. essential 能力零 IA 亲自执行观察 → must-fix ──

test("逐能力亲自观察：essential 能力零 IA 观察（只跑 builder driver）→ must-fix", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    // reviewer 未申报任何 contractObservations（等价于只运行 builder driver）
    const stub = agentStub(state, { coverage: coverageHandler({ observations: [] }), explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }) });
    const { result } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed");
    const events = readEvents(s.taskDir);
    const missing = events.filter((e) => e.type === "FindingRaised" && /无 IA 亲自执行观察/.test(e.summary));
    assert.equal(missing.length, 2, "两个 essential 能力都应因零 IA 观察登记 must-fix");
    for (const f of missing) assert.equal(f.severity, "blocker", "缺 IA 亲自执行观察必须 must-fix");
    const record = readEvidenceJson(s.taskDir, "contract-independence-");
    assert.equal(record.capabilities.every((c) => c.iaExecuted === false && c.obligationOpen === true), true, "零观察的能力 iaExecuted=false 且义务 open");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 5. real-host 转人工通道 ──

test("转人工通道：real-host 能力 manual-handoff 显式登记 + 义务 open 披露，不静默跳过也不误报 must-fix", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({
      kind: "real-host", capabilities: ["dispatch-slash-command"],
      cases: [{ capabilityId: "dispatch-slash-command", caseId: "dispatch-manual", operation: "人工输入命令", observed: { resolvedCommand: "memory", registered: true }, passed: true }],
    });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "manual-handoff", manualHandoffReason: "完整用户交互无法安全自动化，由人工执行并回传" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed");
    const events = readEvents(s.taskDir);
    assert.ok(!events.some((e) => e.type === "FindingRaised"), "转人工通道本身不产生 must-fix（义务 open 由 gate 终判）");
    const record = readEvidenceJson(s.taskDir, "contract-independence-");
    const dispatchCap = record.capabilities.find((c) => c.capabilityId === "dispatch-slash-command");
    assert.equal(dispatchCap.manualHandoff, true, "转人工必须机器登记");
    assert.equal(dispatchCap.iaExecuted, false, "转人工不等于 IA 亲自执行");
    assert.equal(dispatchCap.obligationOpen, true, "转人工能力义务保持 open");
    assert.match(result.message, /转人工执行/, "终态 message 应披露转人工通道");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 6. probe 时鲜 ──

test("probe 时鲜：subject.revision 与当前 revision 不一致 → must-fix（早期 spike 不替代 final）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const staleProbe = probeArtifact({ revision: "spike-rev-old" });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: staleProbe },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    await runWorkflow(home, baseArgs(s), stub);
    const events = readEvents(s.taskDir);
    const stale = events.filter((e) => e.type === "FindingRaised" && /IA 亲自观察不合法/.test(e.summary));
    assert.ok(stale.length >= 1, "过期 revision 的 probe 应判观察不合法");
    assert.match(stale.map((f) => f.summary).join("；"), /subject\.revision 与当前 revision 不一致/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("probe 未通过：essential 能力真实环境观察失败 → must-fix（失败 case 是发现入口）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const failedProbe = probeArtifact({
      cases: [{ capabilityId: "load-extension", caseId: "load-basic", operation: "装载扩展", observed: { registered: false }, passed: false }],
    });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: failedProbe },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    await runWorkflow(home, baseArgs(s), stub);
    const events = readEvents(s.taskDir);
    const failed = events.filter((e) => e.type === "FindingRaised" && /真实环境观察未通过/.test(e.summary));
    assert.ok(failed.length >= 1, "能力观察失败应登记 must-fix");
    assert.equal(failed[0].severity, "blocker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 7. runtime 绑定降级路径 ──

test("runtime 绑定：gate 拒收 additive 参数时证据仍登记、绑定缺失披露且义务保持 open", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s), stub, { rejectAdditive: true });
    assert.equal(result.terminated, "assurance-completed", "绑定被拒不应中断保证主流程");
    const events = readEvents(s.taskDir);
    const probeEvidence = events.filter((e) => e.type === "EvidenceRecorded").find((e) => e.artifact.endsWith("probeLoad.json"));
    assert.ok(probeEvidence !== undefined, "证据事件应照常登记");
    assert.equal(probeEvidence.contractCapabilityIds, undefined, "绑定被拒后事件不得伪造 capability 绑定");
    assert.equal(probeEvidence.runtimeProbe, undefined, "绑定被拒后事件不得伪造 runtimeProbe");
    assert.match(result.message, /runtime 绑定未登记/, "终态应披露绑定缺失");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 8. fake-host parity ──

test("fake-host parity：same=false 只披露不失败；真实 case 引用不存在 → must-fix", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "dispatch-basic", operation: "分发", observed: { resolvedCommand: "memory" }, passed: true }] });
    const mockLog = join(s.taskDir, "evidence", "mock-host.test.log");
    writeFileSync(mockLog, "mock 宿主测试日志（桩）\n");
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
        parityRecords: [{
          mockAssetId: "mock-host-context",
          realProbeArtifact: join(s.taskDir, "evidence", "probeDispatch.json"),
          sampleIds: ["context-basic", "command-dispatch"],
          parity: [
            { sampleId: "context-basic", mockObserved: { artifact: mockLog, caseId: "context-basic", value: "message-appended" }, realObserved: { artifact: join(s.taskDir, "evidence", "probeDispatch.json"), caseId: "dispatch-basic", value: "message-appended" }, same: true },
            { sampleId: "command-dispatch", mockObserved: { artifact: mockLog, caseId: "command-dispatch", value: "full-name-match" }, realObserved: { artifact: join(s.taskDir, "evidence", "probeDispatch.json"), caseId: "dispatch-basic", value: "first-space-truncate" }, same: false },
          ],
        }],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", "parity 语义差异不是立即失败");
    assert.match(result.message, /不得继续作为该语义的证明/, "same=false 差异应披露且给出处置");
    const parityDoc = readEvidenceJson(s.taskDir, "fake-host-parity-");
    assert.ok(parityDoc !== null, "应落盘 parity 记录");
    assert.equal(parityDoc.records.length, 1, "合法 parity 记录应保留");
    assert.equal(parityDoc.mismatches.length, 1, "same=false 样本应记入 mismatches");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fake-host parity：realObserved.caseId 在 probe 中不存在 → must-fix（引用必须真实存在）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "dispatch-basic", operation: "分发", observed: { ok: true }, passed: true }] });
    const mockLog = join(s.taskDir, "evidence", "mock-host.test.log");
    writeFileSync(mockLog, "mock 日志（桩）\n");
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
        parityRecords: [{
          mockAssetId: "mock-host-context",
          realProbeArtifact: join(s.taskDir, "evidence", "probeDispatch.json"),
          sampleIds: ["ghost-sample"],
          parity: [
            { sampleId: "ghost-sample", mockObserved: { artifact: mockLog, caseId: "ghost-sample", value: "x" }, realObserved: { artifact: join(s.taskDir, "evidence", "probeDispatch.json"), caseId: "ghost-case", value: "y" }, same: true },
          ],
        }],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    await runWorkflow(home, baseArgs(s), stub);
    const events = readEvents(s.taskDir);
    const parityFinding = events.find((e) => e.type === "FindingRaised" && /parity 记录机器校验失败/.test(e.summary));
    assert.ok(parityFinding !== undefined, "非法 case 引用应登记 must-fix");
    assert.match(parityFinding.summary, /ghost-case/);
    assert.equal(parityFinding.severity, "blocker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 9. deliveryProfile=a 探索降档 ──

test("探索降档：deliveryProfile=a 时 explorer 只收到契约与故障两类维度", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict],
      deliveryProfile: "a",
      reviewDimensions: ["外部契约", "故障形态", "状态机时序"],
    });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "开放探索完成（桩）", dimensions: ["外部契约", "故障形态"], findings: [] }),
    });
    const prevDue = process.env.STUB_EXPLORATION_DUE;
    process.env.STUB_EXPLORATION_DUE = "1";
    let run;
    try {
      run = await runWorkflow(home, baseArgs(s), stub);
    } finally {
      if (prevDue === undefined) delete process.env.STUB_EXPLORATION_DUE; else process.env.STUB_EXPLORATION_DUE = prevDue;
    }
    assert.equal(run.result.terminated, "assurance-completed", `降档路径应走通（message: ${run.result.message}）`);
    assert.ok(state.prompts.explorer !== undefined, "探索 due 时应派 explorer");
    const explorerPrompt = state.prompts.explorer[0];
    assert.match(explorerPrompt, /必须覆盖的探索维度：\["外部契约","故障形态"\]/, "profile=a 降档后 explorer 只应看到契约与故障两类维度");
    assert.match(explorerPrompt, /deliveryProfile=a 机器降档/, "降档事实应在 prompt 明示");
    const record = readEvidenceJson(s.taskDir, "contract-independence-");
    assert.equal(record.deliveryProfile, "a", "机器记录应登记生效的 deliveryProfile");
    assert.match(run.result.message, /探索维度按 deliveryProfile=a 降档/, "保证总结/终态应披露降档");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 10. recheck ──

test("recheck：coverage prompt 注入 probe 重跑义务，resolver 仍由 IA 亲自运行", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s, { mode: "recheck" }), stub);
    assert.equal(result.terminated, "assurance-completed", `recheck 应走通（message: ${result.message}）`);
    assert.match(state.prompts.coverage[0], /recheck 重跑 probe/, "recheck prompt 必须含 probe 重跑义务");
    assert.match(state.prompts.coverage[0], /不得引用早期 spike/, "recheck prompt 必须禁止早期 spike 替代");
    const invocation = JSON.parse(readFileSync(join(s.taskDir, "resolver-invoked.json"), "utf8"));
    assert.equal(invocation.write, false, "recheck 同样亲自运行 resolver 且无 --write");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("negative case 对账：essential 契约有反例引用而零亲自执行 → must-fix（不能只运行 builder driver）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict],
      counterImplementations: [{
        obligationId: "R1", contractId: CONTRACT_ID, counterImplementation: "fake-host 完全替代真实宿主", violatesIntent: "装载语义未经真实环境验证",
        discriminatingScenarioRef: "neg-load-fake-host", wouldPassCurrentCriteria: false,
      }],
    });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        // 观察申报了但 negativeCaseRefs 为空（等价于只运行 builder driver）
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    await runWorkflow(home, baseArgs(s), stub);
    const events = readEvents(s.taskDir);
    const negFinding = events.find((e) => e.type === "FindingRaised" && /negative case 未经 IA 亲自执行/.test(e.summary));
    assert.ok(negFinding !== undefined, "有反例引用而零执行应登记 must-fix");
    assert.equal(negFinding.severity, "blocker");
    assert.match(negFinding.summary, /neg-load-fake-host/, "finding 应列出未执行的反例引用");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 11. 无外部契约：机器侧段整体跳过（回归保护） ──

test("反例 artifact 双形态：旧 *-counter-implementations.json（顶层数组）同样可收集并对账", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, {
      verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict],
      counterArtifactForm: "legacy",
      counterImplementations: [{
        obligationId: "R1", counterImplementation: "fake-host 替代真实宿主", violatesIntent: "装载语义未验证",
        discriminatingScenarioRef: "neg-legacy-form", wouldPassCurrentCriteria: false,
      }],
    });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({ mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH, surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"] }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent", negativeCaseRefs: ["neg-legacy-form"] },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", `旧形态应可收集（message: ${result.message}）`);
    const record = readEvidenceJson(s.taskDir, "contract-independence-");
    const negCase = record.negativeCases.find((n) => n.discriminatingScenarioRef === "neg-legacy-form");
    assert.ok(negCase !== undefined, "旧形态反例引用应被收集");
    assert.equal(negCase.executed, true, "旧形态引用被亲自执行后应对账为已执行");
    assert.ok(!/negative case 未经 IA 亲自执行/.test(result.message), "有执行记录不得登记未执行 must-fix");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("环境漂移披露：--write 快照的 aggregateHash 与本轮 stdout 不一致时披露且不静默", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    writeFileSync(join(s.taskDir, "resolver-config.json"), JSON.stringify({
      mode: "resolved", authorityDir: s.authorityDir, authorityAggregateHash: AGGREGATE_HASH,
      snapshotAggregateHash: "agg-hash-stale-from-last-write",
      surfaces: ["dist/core/extensions/loader.js", "dist/core/agent.js#dispatch"],
    }));
    const state = { taskDir: s.taskDir, prompts: {} };
    const probeDispatch = probeArtifact({ kind: "real-host", capabilities: ["dispatch-slash-command"], cases: [{ capabilityId: "dispatch-slash-command", caseId: "d1", operation: "分发", observed: { ok: true }, passed: true }] });
    const stub = agentStub(state, {
      coverage: coverageHandler({
        probeFiles: { probeLoad: probeArtifact(), probeDispatch },
        observations: [
          { contractId: CONTRACT_ID, capabilityId: "load-extension", artifact: join(s.taskDir, "evidence", "probeLoad.json"), executedBy: "assurance-agent" },
          { contractId: CONTRACT_ID, capabilityId: "dispatch-slash-command", artifact: join(s.taskDir, "evidence", "probeDispatch.json"), executedBy: "assurance-agent" },
        ],
      }),
      explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }),
    });
    const { result } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", "漂移披露不中断保证主流程");
    assert.match(result.message, /环境漂移/, "终态应披露环境漂移");
    const record = readEvidenceJson(s.taskDir, "contract-resolver-");
    assert.equal(record.contracts[0].snapshotAggregateHashMatch, false, "机器记录应登记快照哈希不符");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("无外部契约：契约机器侧段整体跳过（resolver 不 spawn、不写契约记录、不加披露）", async () => {
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [implementingVerdict, candidateVerdict, acceptedVerdict] });
    // 摘掉 externalContracts 与宿主类环境要求
    const acceptance = JSON.parse(readFileSync(join(s.taskDir, "acceptance.json"), "utf8"));
    delete acceptance.externalContracts;
    for (const requirement of acceptance.requirements) for (const assertion of requirement.assertions) delete assertion.requiredEnvironment;
    writeFileSync(join(s.taskDir, "acceptance.json"), JSON.stringify(acceptance));
    const state = { taskDir: s.taskDir, prompts: {} };
    const stub = agentStub(state, { coverage: coverageHandler(), explorer: () => ({ summary: "探索（桩）", dimensions: ["外部契约"], findings: [] }) });
    const { result, logs } = await runWorkflow(home, baseArgs(s), stub);
    assert.equal(result.terminated, "assurance-completed", `非契约任务应照常走通（logs: ${logs.join(" | ")}）`);
    assert.equal(existsSync(join(s.taskDir, "resolver-invoked.json")), false, "无外部契约时不得 spawn resolver");
    assert.equal(readEvidenceJson(s.taskDir, "contract-independence-"), null, "无外部契约时不得写契约记录");
    assert.equal(readEvidenceJson(s.taskDir, "contract-resolver-"), null, "无外部契约时不得写 resolver 复核记录");
    assert.ok(!/外部契约：resolver/.test(result.message), "非契约任务终态不应带契约披露");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 12. 防漂移锚：门桩进程内执行 == CLI spawn（本文件唯一保留的桩 spawn 点）──

test("防漂移锚：门桩进程内执行 == CLI spawn（gate evaluate 双跑逐字节对拍）", () => {
  // world.run 提速通道的防漂移约束：自建门桩零改动转译进沙箱执行，语义一致性由本锚钉住。
  // verdictQueue 取单元素时 evaluate 取队首不 shift（桩语义）——进程内跑完后队列未变，
  // CLI 侧从同一起点出发，双跑输出确定性成立
  const home = tmpHome();
  try {
    const s = makeScaffold(home, { verdictQueue: [candidateVerdict] });
    const gate = join(home, ".agents", "skills", "delivery-v6", "scripts", "delivery-gate.mjs");
    const env = { ...process.env, HOME: home };
    const inProc = runMjsScript(gate, ["evaluate", "--task-dir", s.taskDir], { env, cwd: home });
    const cli = spawnSync(process.execPath, [gate, "evaluate", "--task-dir", s.taskDir], { encoding: "utf8", env, cwd: home });
    assert.equal(inProc.status, cli.status);
    assert.equal(inProc.stdout, cli.stdout);
    assert.equal(inProc.stderr, cli.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
