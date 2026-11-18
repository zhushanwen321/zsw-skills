// external-contracts-v6.test.mjs — 外部契约登记、静态门与用户命令回归
// （设计《V6 运行可用性与外部契约守门升级》§4.1/§4.2/§4.4/§5.1/§9/§10/§13 gate/core 侧）
//
// 覆盖：
//   1. 验收包 additive 顶层字段 externalContracts / externalContractReview：未声明外部契约时
//      不受任何新检查约束（升级兼容：无外部依赖的普通任务照常通过）
//   2. validate-acceptance 静态检查（§5.1 九条）：结构 / 候选处置表 / essential resolved 快照 /
//      capability 结构与调用类环境底线 / essential 能力断言绑定 / capability 可回溯 /
//      mock-only given 拒绝 / contract-smoke 增量 / minEnvironment 词表
//   3. 调用类蕴含观察义务：register-command 必须同时覆盖 dispatch-command
//   4. 新事件与命令：ExternalAuthorityDeclared / EnvironmentBaselineConfirmed /
//      set-delivery-profile / init --delivery-profile
//   5. EvidenceRecorded 与 FindingRaised 的 additive 字段与 authority 反驳护栏（§9）
//
// 探测/解析脚本（detect/resolve）由并行线交付；本文件对需要控制输出的场景注入桩脚本
// （环境变量 DELIVERY_EXTERNAL_CONTRACT_RESOLVER / _DETECTOR），不依赖并行线进度。
//
// 运行：node --test scripts/tests/external-contracts-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const CORE = join(V6, "scripts", "delivery-core.mjs");
const CLASS_POLICY = JSON.parse(readFileSync(join(V6, "policies", "external-contract-classes.json"), "utf8"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
const GATE_MODULE = await import(pathToFileURL(GATE).href);
const CORE_MODULE = await import(pathToFileURL(CORE).href);

function runGate(args, home, env) {
  return GATE_MODULE.runGateCommand(args, home, env);
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function denied(result, pattern, label = "命令应被拒绝") {
  assert.notEqual(result.status, 0, `${label}\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /恢复动作：/, "每个错误都必须给出恢复动作");
  if (pattern !== undefined) assert.match(result.stderr, pattern);
}

// ── 桩脚本（控制探测/解析输出，隔离并行线进度）──
const STUB_RESOLVER = `#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const path = process.env.STUB_RESOLVER_SNAPSHOT;
if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
else process.stdout.write(JSON.stringify({ schemaVersion: 1, contracts: [], snapshotSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
`;
const STUB_DETECTOR = `#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const path = process.env.STUB_DETECTOR_CANDIDATES;
if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
else process.stdout.write(JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }));
`;

/** 任务 fixture：init + git 项目 + 桩脚本目录；acceptance/increments 由调用方写入。 */
function makeFixture(t, { taskId = "ext-contract" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ext-contract-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  const stubDir = join(root, "stubs");
  mkdirSync(projectDir);
  mkdirSync(home);
  mkdirSync(stubDir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  appendFileSync(join(projectDir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectDir });
  writeFileSync(join(stubDir, "resolve-external-contracts.mjs"), STUB_RESOLVER);
  writeFileSync(join(stubDir, "detect-external-contracts.mjs"), STUB_DETECTOR);
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册工具与命令\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  const env = {
    DELIVERY_EXTERNAL_CONTRACT_RESOLVER: join(stubDir, "resolve-external-contracts.mjs"),
    DELIVERY_EXTERNAL_CONTRACT_DETECTOR: join(stubDir, "detect-external-contracts.mjs"),
  };
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials, env, stubDir };
}

const AUTHORITY_HASH = sha256("authority-v1");
const EMPTY_SNAPSHOT_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 权威解析快照（桩脚本读它后原样输出）。 */
function writeSnapshot(fx, contracts, snapshotSha256 = sha256(`snap-${contracts.map((c) => c.id).join(",")}`)) {
  const path = join(fx.root, "snapshot.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, contracts, snapshotSha256 }, null, 2)}\n`);
  fx.env.STUB_RESOLVER_SNAPSHOT = path;
  return { snapshotSha256, path };
}

function resolvedContract(id, authorityAggregateHash = AUTHORITY_HASH) {
  return {
    id,
    status: "resolved",
    resolver: { kind: "installed-npm-package", locator: "@scope/host", resolution: "project-dependency" },
    identity: { name: "host", version: "1.1.0" },
    surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256(`surface-${id}`) }],
    authorityAggregateHash,
    snapshotSha256: sha256(`snap-${id}`),
  };
}

/** 候选快照（按验收版本隔离）。 */
function writeCandidates(fx, { acceptanceVersion = 1, candidates = [], unresolved = [] } = {}) {
  const dir = join(fx.taskDir, "evidence", `acceptance-v${acceptanceVersion}`);
  mkdirSync(dir, { recursive: true });
  const document = { schemaVersion: 1, inputHashes: { intent: sha256("intent") }, candidates, unresolved };
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return sha256(readFileSync(path, "utf8"));
}

/** 单契约 + 单能力 + 单断言的验收包骨架（调用方覆盖字段）。 */
function acceptanceSkeleton(fx, { capabilities, essential = true, contractId = "EC-host", detectionSha256, extraAssertion = null } = {}) {
  const assertion = {
    id: "A1", statement: "工具在真实宿主注册并可调用", qualifiers: ["真实宿主"], given: "真实宿主装载扩展", when: "调用工具", then: "返回宿主可消费的结果对象",
    adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
    requiredEnvironment: { kind: "official-runner", capability: capabilities[0].id },
  };
  return {
    schemaVersion: 2, acceptanceVersion: 1, taskId: basename(fx.taskDir), projectRoot: realpathSync(fx.projectDir),
    objective: "扩展装载并注册工具", nonGoals: [], riskLevel: "high", exploratoryReview: "required", reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "工具在真实宿主注册并可调用", required: true, riskAcceptable: false,
      evidenceKinds: ["command", "inspection"], assertions: extraAssertion === null ? [assertion] : [assertion, extraAssertion],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "带错签名调用", timing: "命令期", expected: "被真实宿主拒绝", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: contractId, essential, authorityRequest: { resolverKind: "installed-npm-package", locator: "@scope/host" },
      capabilities,
    }],
    externalContractReview: { detectionSha256, dispositions: [{ candidateId: "candidate-host", disposition: "bound", contractId }] },
  };
}

function capability(id, overrides = {}) {
  return {
    id, minEnvironment: "official-runner", observable: "可观察能力点", surfaceRefs: ["dist/types.d.ts"],
    detectionClasses: ["register-tool"], ...overrides,
  };
}

function writePackage(fx, acceptance, increments) {
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify(increments ?? {
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
}

/** 合法基线包：essential 契约 + resolved 快照 + 已处置 strong 候选。 */
function legalPackage(fx, overrides = {}) {
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  const { snapshotSha256 } = writeSnapshot(fx, [resolvedContract("EC-host")]);
  const acceptance = acceptanceSkeleton(fx, { capabilities: overrides.capabilities ?? [capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })], detectionSha256, ...overrides.acceptance });
  writePackage(fx, acceptance, overrides.increments);
  return { acceptance, detectionSha256, snapshotSha256 };
}

// ── 1. 升级兼容：无外部契约的验收包不受新检查约束 ──

test("未声明 externalContracts 的验收包照常通过（升级兼容；无外部依赖的普通任务不受影响）", async (t) => {
  const fx = makeFixture(t);
  const acceptance = acceptanceSkeleton(fx, { capabilities: [capability("register-tool-and-invoke")] });
  delete acceptance.externalContracts;
  delete acceptance.externalContractReview;
  writePackage(fx, acceptance, {
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", title: "普通增量", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  });
  // 任务由升级后 init 创建（task.json 带 deliveryProfile），但验收包未声明外部契约——
  // 缺候选快照、缺 externalContractReview 都不被拦
  const result = runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env);
  ok(result, "无外部契约的验收包应通过");
  const task = JSON.parse(readFileSync(join(fx.taskDir, "task.json"), "utf8"));
  assert.equal(task.deliveryProfile, "b", "init 缺省写入 deliveryProfile=b");
});

test("未知顶层字段与空 externalContracts 均被拒（检查 1）", async (t) => {
  const fx = makeFixture(t);
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const unknown = acceptanceSkeleton(fx, { capabilities: [capability("register-tool-and-invoke")], detectionSha256 });
  unknown.consumedBy = [{ capability: "register-tool-and-invoke" }];
  writePackage(fx, unknown);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /含未知字段 consumedBy/, "验收包不得自建 consumedBy 映射表");
  const empty = acceptanceSkeleton(fx, { capabilities: [capability("register-tool-and-invoke")], detectionSha256 });
  empty.externalContracts = [];
  writePackage(fx, empty);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /externalContracts.*必须是非空数组|不能为空/, "空 externalContracts 应被拒");
});

// ── 2. 候选处置表（检查 2）──

test("候选处置表：缺失 / detectionSha256 不一致 / 未处置候选 / strong 候选 not-external / 契约无可回溯处置均被拒", async (t) => {
  const fx = makeFixture(t);
  const candidates = [
    { id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] },
    { id: "candidate-lib", strength: "weak", signals: ["intent:plugin"] },
  ];
  const detectionSha256 = writeCandidates(fx, { candidates });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const caps = [capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })];
  // ① 缺 externalContractReview
  const withoutReview = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  delete withoutReview.externalContractReview;
  writePackage(fx, withoutReview);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /externalContractReview/, "缺候选处置表应被拒");
  // ② detectionSha256 与候选快照不一致
  const staleHash = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256: sha256("stale") });
  writePackage(fx, staleHash);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /detectionSha256 与候选快照不一致/, "探测输入变化后必须重新冻结处置表");
  // ③ 候选未处置
  const partial = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  partial.externalContractReview.dispositions = [{ candidateId: "candidate-host", disposition: "bound", contractId: "EC-host" }];
  writePackage(fx, partial);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /candidate-lib 未处置/, "全部候选必须已处置");
  // ④ strong 候选被处置为 not-external（无效处置）
  const fakeDisposition = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  fakeDisposition.externalContractReview.dispositions = [
    { candidateId: "candidate-host", disposition: "bound", contractId: "EC-host" },
    { candidateId: "candidate-lib", disposition: "not-external", rationale: "纯进程内库" },
  ];
  fakeDisposition.externalContractReview.dispositions[0].disposition = "not-external";
  fakeDisposition.externalContractReview.dispositions[0].rationale = "不是外部契约";
  writePackage(fx, fakeDisposition);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /strong 候选 candidate-host 被处置为 not-external/, "strong 候选不能用自由文本放行");
  // ⑤ 契约无可回溯处置
  const unbound = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  unbound.externalContractReview.dispositions = [
    { candidateId: "candidate-host", disposition: "unresolved" },
    { candidateId: "candidate-lib", disposition: "not-external", rationale: "纯进程内库" },
  ];
  writePackage(fx, unbound);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /EC-host 没有可回溯的候选处置/, "每个契约必须有 bound 或带 rationale 的 manual 处置");
  // 合法形态放行
  const legal = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  legal.externalContractReview.dispositions = [
    { candidateId: "candidate-host", disposition: "bound", contractId: "EC-host" },
    { candidateId: "candidate-lib", disposition: "not-external", rationale: "纯进程内库，无宿主生命周期" },
  ];
  writePackage(fx, legal);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "合法处置表应通过");
});

// ── 3. essential 权威快照与 capability 结构（检查 3/4/9）──

test("essential 契约必须有 resolved 权威快照；declared-unavailable 不得伪造 resolved（检查 3）", async (t) => {
  const fx = makeFixture(t);
  const caps = [capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })];
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  // 快照里该契约 declared-unavailable
  writeSnapshot(fx, [{ ...resolvedContract("EC-host"), status: "declared-unavailable", authorityAggregateHash: null }]);
  writePackage(fx, acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 }));
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /权威状态为 declared-unavailable/, "declared-unavailable 不能伪造 resolved");
  // 快照里根本没有该契约
  writeSnapshot(fx, [resolvedContract("EC-other")]);
  writePackage(fx, acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 }));
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /无权威解析结果/, "缺契约解析结果应被拒");
  // resolver 不可用（无快照文件、无 current 指针）→ 可操作错误而非静默通过
  delete fx.env.STUB_RESOLVER_SNAPSHOT;
  fx.env.DELIVERY_EXTERNAL_CONTRACT_RESOLVER = join(fx.stubDir, "missing.mjs");
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /无权威解析结果/, "resolver 不可用必须给出可操作错误");
});

test("capability 结构、调用类环境底线与 minEnvironment 词表（检查 4/9）", async (t) => {
  const fx = makeFixture(t);
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const run = (capabilities) => {
    writePackage(fx, acceptanceSkeleton(fx, { capabilities, detectionSha256 }));
    return runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env);
  };
  // 合法：official-runner 底线满足 register-tool/invoke-tool 的 official-runner 底线
  ok(run([capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })]), "合法 capability 应通过");
  // detectionClasses 为空
  denied(run([capability("register-tool-and-invoke", { detectionClasses: [] })]), /detectionClasses/, "必须声明调用类");
  // surfaceRefs 为空
  denied(run([capability("register-tool-and-invoke", { surfaceRefs: [] })]), /surfaceRefs/, "必须声明权威 surface 引用");
  // minEnvironment = fake-host（自写模拟宿主不是底线档位）
  denied(run([capability("register-tool-and-invoke", { minEnvironment: "fake-host" })]), /minEnvironment/, "fake-host 不得作为能力底线");
  // 自造环境等级
  denied(run([capability("register-tool-and-invoke", { minEnvironment: "staging-host" })]), /minEnvironment/, "环境等级必须用策略词表");
  // 档位低于调用类底线：dispatch-command 底线 real-host，能力只声明 official-runner
  denied(run([capability("dispatch-slash-command", { minEnvironment: "official-runner", detectionClasses: ["dispatch-command"] })]), /低于调用类 dispatch-command 的环境底线 real-host/, "designer 不能把已识别调用类降到更低环境档");
  // 未登记调用类
  denied(run([capability("register-tool-and-invoke", { detectionClasses: ["teleport-api"] })]), /含未登记调用类 teleport-api/, "只能用策略包登记的调用类");
});

test("蕴含观察义务：声明 register-command 必须同时覆盖 dispatch-command", async (t) => {
  const fx = makeFixture(t);
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-command"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const dispatch = capability("dispatch-slash-command", { minEnvironment: "real-host", detectionClasses: ["dispatch-command"] });
  // register-command 蕴含 dispatch-command（real-host 底线），故注册能力本身也须 real-host
  const register = capability("register-slash-command", { minEnvironment: "real-host", detectionClasses: ["register-command"] });
  // 只登记注册、不登记分发
  writePackage(fx, acceptanceSkeleton(fx, { capabilities: [register], detectionSha256 }));
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /蕴含 dispatch-command 观察义务/, "只登记注册不登记分发 = 漏掉真实命令解析观察");
  // 同时覆盖两者放行（两个能力各自有断言引用）
  const both = acceptanceSkeleton(fx, { capabilities: [register, dispatch], detectionSha256 });
  both.requirements[0].assertions[0].requiredEnvironment = { kind: "real-host", capability: "dispatch-slash-command" };
  both.requirements[0].assertions.push({
    id: "A2", statement: "命令按真实宿主规则注册", qualifiers: ["真实宿主"], given: "真实宿主装载扩展", when: "调用 registerCommand", then: "命令进入注册表",
    adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"], requiredEnvironment: { kind: "real-host", capability: "register-slash-command" },
  });
  both.adversarialForms.push({ id: "AF2", assertionId: "A2", qualifier: "真实宿主", entryPoint: "auto", initialState: "已装载", operation: "用单对象调用注册", timing: "命令期", expected: "注册失败被观察", testAssetRefs: ["test-A2"], rationale: "签名差异" });
  writePackage(fx, both);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "注册 + 分发同时覆盖应通过");
});

// ── 4. essential 能力绑定与可回溯（检查 5/6）──

test("essential 能力必须被断言引用且档位满足；requiredEnvironment.capability 必须可回溯（检查 5/6）", async (t) => {
  const fx = makeFixture(t);
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const caps = [
    capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] }),
    capability("context-rewrite", { detectionClasses: ["context-event"] }),
  ];
  // 第二个能力无任何断言引用
  writePackage(fx, acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 }));
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /EC-host:context-rewrite 未被任何断言的 requiredEnvironment.capability 引用/, "essential 能力必须有断言绑定");
  // 断言引用了不存在的 capability（另一条断言仍合法引用 caps[0]，使检查 5 不先触发）
  const dangling = acceptanceSkeleton(fx, { capabilities: [caps[0]], detectionSha256 });
  dangling.requirements[0].assertions.push({
    id: "A2", statement: "事件改写被官方 runner 消费", qualifiers: ["官方 runner"], given: "官方 runner 装载扩展", when: "发出 context 事件", then: "消息流被消费",
    adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"], requiredEnvironment: { kind: "official-runner", capability: "register-tool-and-invoke" },
  });
  dangling.adversarialForms.push({ id: "AF2", assertionId: "A2", qualifier: "官方 runner", entryPoint: "auto", initialState: "已装载", operation: "返回错误形态", timing: "事件期", expected: "被 runner 拒绝", testAssetRefs: ["test-A2"], rationale: "返回形态差异" });
  dangling.requirements[0].assertions[0].requiredEnvironment = { kind: "official-runner", capability: "no-such-capability" };
  writePackage(fx, dangling);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /无法回溯到 acceptance.externalContracts/, "capability 引用必须可回溯");
  // 断言档位低于能力底线（能力 real-host，断言 official-runner）
  const lowKind = acceptanceSkeleton(fx, { capabilities: [capability("dispatch-slash-command", { minEnvironment: "real-host", detectionClasses: ["dispatch-command"] })], detectionSha256 });
  lowKind.requirements[0].assertions[0].requiredEnvironment = { kind: "official-runner", capability: "dispatch-slash-command" };
  writePackage(fx, lowKind);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /无满足档位的断言引用/, "断言环境要求不得低于能力底线");
});

// ── 5. mock-only given 与 contract-smoke 增量（检查 7/8）──

test("mock-only given 被拒；缺 contract-smoke 增量被拒（检查 7/8）", async (t) => {
  const fx = makeFixture(t);
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  const caps = [capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })];
  // mock 作为唯一装载环境
  const mockOnly = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  mockOnly.requirements[0].assertions[0].given = "mock 宿主按平台契约调用扩展工厂函数";
  mockOnly.requirements[0].assertions[0].when = "在 mock 宿主中调用 registerTool";
  writePackage(fx, mockOnly);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /只把 mock\/fake\/自写 harness 作为装载或分发环境/, "mock 不能是能力绑定的唯一声明来源");
  // mock 作补充 + 真实观察点 → 放行
  const mockSupplement = acceptanceSkeleton(fx, { capabilities: caps, detectionSha256 });
  mockSupplement.requirements[0].assertions[0].given = "mock 宿主作补充场景，真实 official-runner 装载扩展";
  writePackage(fx, mockSupplement);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "mock 作补充场景应通过");
  // 缺 contract-smoke 增量
  writePackage(fx, mockSupplement, {
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", title: "业务增量", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  });
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /无 kind=contract-smoke 的契约冒烟增量/, "essential 契约必须有契约冒烟增量");
  // 未知 kind 值
  writePackage(fx, mockSupplement, {
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "business", title: "业务增量", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  });
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /kind/, "未登记的增量类型应被拒");
});

test("非 essential 契约被源码 strong 信号强制按 essential 处理（能力清单低报的主机器门）", async (t) => {
  const fx = makeFixture(t);
  // 候选快照的 strong 信号命中 register-command 调用类，但验收把契约标成非 essential
  const detectionSha256 = writeCandidates(fx, { candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-command"] }] });
  writeSnapshot(fx, [resolvedContract("EC-host")]);
  // register-command 蕴含 dispatch-command（real-host 底线），故注册能力本身也须 real-host
  const register = capability("register-slash-command", { minEnvironment: "real-host", detectionClasses: ["register-command"] });
  const dispatch = capability("dispatch-slash-command", { minEnvironment: "real-host", detectionClasses: ["dispatch-command"] });
  const optional = acceptanceSkeleton(fx, { capabilities: [register, dispatch], essential: false, detectionSha256 });
  optional.requirements[0].assertions[0].requiredEnvironment = { kind: "real-host", capability: "dispatch-slash-command" };
  optional.requirements[0].assertions.push({
    id: "A2", statement: "命令按真实宿主规则注册", qualifiers: ["真实宿主"], given: "真实宿主装载扩展", when: "调用 registerCommand", then: "命令进入注册表",
    adversarialFormRefs: ["AF2"], testAssetRefs: ["test-A2"], requiredEnvironment: { kind: "real-host", capability: "register-slash-command" },
  });
  optional.adversarialForms.push({ id: "AF2", assertionId: "A2", qualifier: "真实宿主", entryPoint: "auto", initialState: "已装载", operation: "用单对象调用注册", timing: "命令期", expected: "注册失败被观察", testAssetRefs: ["test-A2"], rationale: "签名差异" });
  // 非 essential 且无 strong 信号时应放行（对照）
  writePackage(fx, optional);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "非 essential 且信号未命中时按原声明处理");
  // strong 信号命中 register-command → 该能力被强制 essential → 必须有断言绑定。
  // 移除断言绑定后应被拒（若仍按非 essential 处理则不会拦）
  const forced = acceptanceSkeleton(fx, { capabilities: [register, dispatch], essential: false, detectionSha256 });
  forced.requirements[0].assertions[0].requiredEnvironment = { kind: "official-runner" };
  writePackage(fx, forced);
  denied(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), /EC-host:register-slash-command 未被任何断言的 requiredEnvironment.capability 引用/, "strong 信号命中时机器强制按 essential 处理");
});

// ── 6. 调用类策略文件（词表与底线的唯一权威）──

test("调用类策略文件：词表、环境底线与蕴含关系落盘且随策略快照受冻结保护", async (t) => {
  const ids = CLASS_POLICY.classes.map((entry) => entry.id);
  assert.deepEqual(
    ids,
    ["extension-entrypoint", "register-tool", "invoke-tool", "register-command", "dispatch-command", "context-event", "model-call"],
    "初始调用类目录应与设计一致",
  );
  const floors = Object.fromEntries(CLASS_POLICY.classes.map((entry) => [entry.id, entry.minEnvironment]));
  assert.equal(floors["dispatch-command"], "real-host", "dispatch-command 与完整用户交互类底线 real-host");
  assert.equal(floors["register-tool"], "official-runner", "其余调用类底线 official-runner");
  assert.ok(!Object.values(floors).includes("fake-host"), "调用类底线不得是 fake-host");
  const register = CLASS_POLICY.classes.find((entry) => entry.id === "register-command");
  assert.deepEqual(register.impliesObservationClasses, ["dispatch-command"], "register-command 蕴含 dispatch-command 观察义务");
  // 策略文件进入任务快照（改词表 = 策略升级通道）
  const fx = makeFixture(t);
  legalPackage(fx);
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env), "snapshot-policy 应成功");
  const snapshot = JSON.parse(readFileSync(join(fx.taskDir, "policy-snapshot.json"), "utf8"));
  assert.ok(Array.isArray(snapshot["external-contract-classes.json"].classes), "调用类目录应进策略快照");
});

// ── 7. 任务分级（§13）──

test("deliveryProfile：init 缺省 b、--delivery-profile 写入、set-delivery-profile 唯一写通道、非法值拒绝", async (t) => {
  const fx = makeFixture(t);
  const taskPath = join(fx.taskDir, "task.json");
  assert.equal(JSON.parse(readFileSync(taskPath, "utf8")).deliveryProfile, "b", "init 缺省 b");
  const setA = runGate(["set-delivery-profile", "--task-dir", fx.taskDir, "--profile", "a", "--credential", fx.creds.user], fx.home);
  ok(setA, "user 可改分级");
  assert.equal(JSON.parse(parseStdout(setA)).deliveryProfile, "a");
  assert.equal(JSON.parse(readFileSync(taskPath, "utf8")).deliveryProfile, "a");
  const noop = runGate(["set-delivery-profile", "--task-dir", fx.taskDir, "--profile", "a", "--credential", fx.creds.user], fx.home);
  ok(noop, "重复设置同值放行");
  assert.equal(JSON.parse(parseStdout(noop)).changed, false);
  denied(runGate(["set-delivery-profile", "--task-dir", fx.taskDir, "--profile", "d", "--credential", fx.creds.user], fx.home), /--profile/, "非法分级值应被拒");
  denied(runGate(["set-delivery-profile", "--task-dir", fx.taskDir, "--profile", "a", "--credential", fx.creds.builder], fx.home), /actor/, "builder 凭据不得改分级");
  // init 显式分级
  const root = mkdtempSync(join(tmpdir(), "ext-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  appendFileSync(join(projectDir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectDir });
  const initC = runGate(["init", "--project-root", projectDir, "--task-id", "profile-c", "--delivery-profile", "c"], join(root, "home"));
  ok(initC, "init --delivery-profile c 应成功");
  const taskDirC = JSON.parse(parseStdout(initC)).taskDir;
  assert.equal(JSON.parse(readFileSync(join(taskDirC, "task.json"), "utf8")).deliveryProfile, "c");
  // 直改 task.json 成非法值 → loadWorld 拒绝（禁直改的机器侧）
  const tampered = JSON.parse(readFileSync(join(taskDirC, "task.json"), "utf8"));
  tampered.deliveryProfile = "z";
  writeFileSync(join(taskDirC, "task.json"), `${JSON.stringify(tampered, null, 2)}\n`);
  denied(runGate(["validate-acceptance", "--task-dir", taskDirC], join(root, "home")), /task.json.deliveryProfile/, "直改 task.json 成非法值被拒");
});

// ── 8. 新事件与命令（§4.4/§10）──

test("ExternalAuthorityDeclared：user 凭据登记本地/可执行权威；越权凭据与未知契约被拒", async (t) => {
  const fx = makeFixture(t);
  const snapshotSha = sha256("authority-local");
  ok(runGate(["declare-external-authority", "--task-dir", fx.taskDir, "--contract-id", "EC-host",
    "--resolver-kind", "local-path", "--locator", "/opt/host-sdk", "--snapshot-sha256", snapshotSha,
    "--summary", "用户登记本地 SDK", "--credential", fx.creds.user], fx.home), "user 可登记外部权威");
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const declared = events.find((event) => event.type === "ExternalAuthorityDeclared");
  assert.equal(declared.contractId, "EC-host");
  assert.equal(declared.resolverKind, "local-path");
  assert.equal(declared.snapshotSha256, snapshotSha);
  assert.equal(declared.acceptanceVersion, 0, "验收包就位前亦可登记（任务级事件）");
  denied(runGate(["declare-external-authority", "--task-dir", fx.taskDir, "--contract-id", "EC-host",
    "--resolver-kind", "local-path", "--locator", "/opt/host-sdk", "--snapshot-sha256", snapshotSha,
    "--summary", "越权登记", "--credential", fx.creds.builder], fx.home), /actor/, "builder 不得登记外部权威");
  denied(runGate(["declare-external-authority", "--task-dir", fx.taskDir, "--contract-id", "EC-host",
    "--resolver-kind", "local-path", "--locator", "/opt/host-sdk", "--snapshot-sha256", "not-a-sha",
    "--summary", "坏哈希", "--credential", fx.creds.user], fx.home), /snapshot-sha256/, "快照哈希必须是 sha256");
  // 验收包在场时契约 id 必须已声明
  legalPackage(fx);
  denied(runGate(["declare-external-authority", "--task-dir", fx.taskDir, "--contract-id", "EC-unknown",
    "--resolver-kind", "local-path", "--locator", "/opt/host-sdk", "--snapshot-sha256", snapshotSha,
    "--summary", "未知契约", "--credential", fx.creds.user], fx.home, fx.env), /不是当前验收包已声明的 externalContracts id/, "契约 id 必须与验收包一致");
});

test("EnvironmentBaselineConfirmed：未知契约拒绝；同一 acceptanceVersion 最多一次（命令层 + evaluate 层）", async (t) => {
  const fx = makeFixture(t);
  const { acceptance, detectionSha256, snapshotSha256 } = legalPackage(fx);
  writePackage(fx, acceptance);
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env), "snapshot-policy");
  writeFileSync(join(fx.taskDir, "evidence", "acceptance-review-v1.md"), "# review\n");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home, fx.env), "record-review");
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home, fx.env), "approve-acceptance");
  const approved = JSON.parse(parseStdout(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env)));
  const approvalEvent = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "AcceptanceApproved");
  // F15 修复（测试审查发现 11）：原断言是自指式（actual 与 expected 同表达式，恒真）——
  // 改为实值断言：批准事件绑定的快照哈希必须等于 resolver 输出的 snapshotSha256
  assert.equal(approvalEvent.authoritySnapshotSha256, snapshotSha256, "批准事件绑定权威快照哈希（审计事实：值 = resolver 摘要的 snapshotSha256）");
  assert.match(approvalEvent.authoritySnapshotSha256 ?? "", /^[0-9a-f]{64}$/, "声明外部契约时批准自动绑定快照哈希");
  // 未知契约
  denied(runGate(["confirm-environment-baseline", "--task-dir", fx.taskDir, "--contract-ids", JSON.stringify(["EC-unknown"]),
    "--new-authority-snapshot-sha256", sha256("new-snap"), "--credential", fx.creds.user], fx.home, fx.env), /含未声明契约 EC-unknown/, "只能确认已登记契约");
  // F13（审查修复）：确认的新快照哈希必须对应盘上快照文件——先落盘再确认（否则拒绝）
  const newSnapshotSha = sha256("new-snap");
  mkdirSync(join(fx.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(join(fx.taskDir, "environment-contracts", `${newSnapshotSha}.json`), `${JSON.stringify({ schemaVersion: 1, contracts: [resolvedContract("EC-host")], snapshotSha256: newSnapshotSha }, null, 2)}\n`);
  // 第一次确认成功
  ok(runGate(["confirm-environment-baseline", "--task-dir", fx.taskDir, "--contract-ids", JSON.stringify(["EC-host"]),
    "--new-authority-snapshot-sha256", newSnapshotSha, "--credential", fx.creds.user], fx.home, fx.env), "首次基线确认应成功");
  // 第二次（同版本）被命令层拒绝（快照文件先落盘，确保走到的是预算拒绝而非存在校验——
  // F13 的存在校验在未知契约与预算校验之前，fixture 必须满足它才测得到目标分支）
  const secondSnapshotSha = sha256("new-snap-2");
  writeFileSync(join(fx.taskDir, "environment-contracts", `${secondSnapshotSha}.json`), `${JSON.stringify({ schemaVersion: 1, contracts: [resolvedContract("EC-host")], snapshotSha256: secondSnapshotSha }, null, 2)}\n`);
  denied(runGate(["confirm-environment-baseline", "--task-dir", fx.taskDir, "--contract-ids", JSON.stringify(["EC-host"]),
    "--new-authority-snapshot-sha256", secondSnapshotSha, "--credential", fx.creds.user], fx.home, fx.env), /已登记过 EnvironmentBaselineConfirmed/, "同一 acceptanceVersion 最多一次");
  // 新事件进事件流后，next / replay / events 仍可正常消费（转移表联动）
  const next = await CORE_MODULE.runCoreCommandInProcess(["next", "--task-dir", fx.taskDir]);
  assert.equal(next.status, 0, `next 应成功\n${next.stderr}`);
  const replay = await CORE_MODULE.runCoreCommandInProcess(["replay", "--task-dir", fx.taskDir]);
  assert.equal(replay.status, 0, `replay 应成功\n${replay.stderr}`);
  assert.equal(JSON.parse(replay.stdout.slice(replay.stdout.indexOf("{"))).verdict, "全序列可表达", "新事件须可被任务域转移表表达");
});

// ── 9. EvidenceRecorded / FindingRaised additive 字段与护栏 ─●

test("record-evidence：contractCapabilityIds 必须存在于当前验收包；runtimeProbe 标记可登记", async (t) => {
  const fx = makeFixture(t);
  const { acceptance, detectionSha256 } = legalPackage(fx);
  writePackage(fx, acceptance);
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env));
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(fx.taskDir, "evidence", "ev.md"), "# 证据\n");
  denied(runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "command",
    "--result", "verified", "--summary", "取证", "--artifact", "evidence/ev.md",
    "--assertion-ids", JSON.stringify(["A1"]),
    "--contract-capability-ids", JSON.stringify(["EC-host:no-such-capability"]), "--credential", fx.creds.assurance], fx.home, fx.env),
    /含当前验收包未声明的能力/, "自造能力名被拒");
  const appended = runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "command",
    "--result", "verified", "--summary", "契约冒烟取证", "--artifact", "evidence/ev.md",
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--contract-capability-ids", JSON.stringify(["EC-host:register-tool-and-invoke"]), "--runtime-probe",
    "--credential", fx.creds.assurance], fx.home, fx.env);
  ok(appended, "合法能力绑定 + runtimeProbe 应登记");
  const event = JSON.parse(parseStdout(appended));
  assert.deepEqual(event.contractCapabilityIds, ["EC-host:register-tool-and-invoke"]);
  assert.equal(event.runtimeProbe, true);
});

test("FindingRaised authority 反驳组：结构命中外部契约时三段必填（护栏④）", async (t) => {
  const fx = makeFixture(t);
  const { acceptance, detectionSha256 } = legalPackage(fx);
  writePackage(fx, acceptance);
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env));
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(fx.taskDir, "evidence", "finding.md"), "# 发现\n");
  const base = ["record-finding", "--task-dir", fx.taskDir, "--summary", "工具签名与权威 surface 不一致",
    "--category", "defect", "--severity", "blocker", "--requirement-ids", JSON.stringify(["R1"]),
    "--artifact", "evidence/finding.md", "--credential", fx.creds.assurance];
  // 结构命中（关联需求断言带 requiredEnvironment.capability）但 authority 组缺失
  denied(runGate(base, fx.home, fx.env), /结构命中外部契约.*authority 反驳组缺失或不完整/, "弱关闭通道被封住");
  // 补齐 authority 组后放行
  ok(runGate([...base, "--contract-capability-ids", JSON.stringify(["EC-host:register-tool-and-invoke"]),
    "--authority-backed", "true", "--authority-hash", AUTHORITY_HASH,
    "--authority-observation-ref", "environment-contracts/" + sha256("snap") + ".json#dist/types.d.ts#ToolDefinition"], fx.home, fx.env),
    "authority 组完整时应登记");
  // 未结构命中（断言不带 requiredEnvironment.capability）不要求 authority 组
  const plainDetectionSha = writeCandidates(fx, { candidates: [{ id: "candidate-lib", strength: "weak", signals: ["intent:plugin"] }] });
  const plain = acceptanceSkeleton(fx, { capabilities: [capability("register-tool-and-invoke", { detectionClasses: ["register-tool", "invoke-tool"] })], essential: false, detectionSha256: plainDetectionSha });
  delete plain.requirements[0].assertions[0].requiredEnvironment;
  plain.externalContractReview.dispositions = [
    { candidateId: "candidate-lib", disposition: "manual", contractId: "EC-host", rationale: "intent 明示外部宿主，项目尚无源码与 manifest 信号，由 reviewer 依语义补充登记" },
  ];
  writePackage(fx, plain);
  const other = ["record-finding", "--task-dir", fx.taskDir, "--summary", "普通发现",
    "--category", "defect", "--severity", "non-blocker", "--requirement-ids", JSON.stringify([]),
    "--artifact", "evidence/finding.md", "--credential", fx.creds.assurance, "--empty-scope-refutation", "不影响任何需求",
    "--consequence-refutation", "该发现不改变任何用户可观察行为", "--consequence-refutation-type", "not-observable"];
  ok(runGate(other, fx.home, fx.env), "未结构命中外部契约的发现不要求 authority 组");
});
