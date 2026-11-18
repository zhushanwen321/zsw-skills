// runtime-obligations-v6.test.mjs — runtime 义务派生、accepted 前置与 readiness 回归
// （设计《V6 运行可用性与外部契约守门升级》§6.1/§6.2/§6.3/§8.1/§12.1 gate/core 侧）
//
// 覆盖：
//   1. deriveRuntimeObligations 纯函数：§6.1 六条件逐条（有效证据 / 环境档位 / 能力声明 /
//      sourceHash 核对 / probe 观察通过 / subject.revision 一致），unknown/partial/mismatch/
//      skipped 全 open
//   2. runtime 义务不可豁免：无 explicitly-waived，不被 accept-risk / preauthorize-risk 消化
//   3. verdict.runtimeReadiness（§12.1）：overall 词表、essential 才进 overall、非增强缺口披露
//   4. accepted 前置（§6.2）：无 probe / 环境档位不足 / sourceHash 不符 → 不得 accepted；
//      probe 齐备 → established 且 accepted
//   5. 证据环境真实性（§8.1）：sourceHash/driver/driverHash 缺失或不一致 → 证据最多 partial
//   6. 环境历史链（§4.3/§10）：权威变化无 EnvironmentBaselineConfirmed 接链 → 阻断；
//      用户确认基线后接链（仍须重跑 probe）
//   7. 候选复扫（§8.1 第 1 条）：未映射 strong 候选 / unresolved 外部访问 → 拒绝 evaluate
//   8. delivery-core obligations 子命令输出含 kind=runtime 义务
//
// 运行：node --test scripts/tests/runtime-obligations-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const CORE = join(V6, "scripts", "delivery-core.mjs");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
const GATE_MODULE = await import(pathToFileURL(GATE).href);
const CORE_MODULE = await import(pathToFileURL(CORE).href);
const KERNEL = await import(pathToFileURL(join(V6, "scripts", "lib", "kernel-judgments.mjs")).href);

function runGate(args, home, env) {
  return GATE_MODULE.runGateCommand(args, home, env);
}
async function runCore(args, home, env) {
  return CORE_MODULE.runCoreCommandInProcess(args, env);
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function denied(result, pattern, label = "命令应被拒绝") {
  assert.notEqual(result.status, 0, `${label}\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /恢复动作：/, "每个错误都必须给出恢复动作");
  if (pattern !== undefined) assert.match(result.stderr, pattern);
}

const STUB_RESOLVER = `#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const path = process.env.STUB_RESOLVER_SNAPSHOT;
const args = process.argv.slice(2);
const taskDirIndex = args.indexOf("--task-dir");
const taskDir = taskDirIndex >= 0 ? args[taskDirIndex + 1] : null;
if (path && existsSync(path)) {
  const text = readFileSync(path, "utf8");
  process.stdout.write(text);
  // 模拟 resolve --write 的落盘产物：按哈希分文件的快照 + current 指针（批准基线对账的输入）
  if (taskDir) {
    try {
      const doc = JSON.parse(text);
      const dir = join(taskDir, "environment-contracts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, doc.snapshotSha256 + ".json"), text);
      writeFileSync(join(dir, "environment-contracts.current.json"), JSON.stringify({ snapshotSha256: doc.snapshotSha256 }, null, 2));
    } catch {}
  }
} else {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, contracts: [], snapshotSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
}
`;
const STUB_DETECTOR = `#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const path = process.env.STUB_DETECTOR_CANDIDATES;
if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
else process.stdout.write(JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }));
`;

const CONTRACT_ID = "EC-host";
const CAPABILITY_ID = "register-tool-and-invoke";
const AUTHORITY_HASH = sha256("authority-v1");

function makeFixture(t, { taskId = "runtime-ob" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "runtime-ob-v6-"));
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
  writeFileSync(intentPath, "扩展在真实宿主装载并注册工具\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return {
    root, projectDir, home, taskDir: output.taskDir, creds: output.credentials, stubDir,
    env: {
      DELIVERY_EXTERNAL_CONTRACT_RESOLVER: join(stubDir, "resolve-external-contracts.mjs"),
      DELIVERY_EXTERNAL_CONTRACT_DETECTOR: join(stubDir, "detect-external-contracts.mjs"),
    },
  };
}

function writeSnapshot(fx, contracts, snapshotSha256 = null) {
  const sha = snapshotSha256 ?? sha256(`snap-${contracts.map((c) => c.id).join(",")}`);
  const path = join(fx.root, "snapshot.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, contracts, snapshotSha256: sha }, null, 2)}\n`);
  fx.env.STUB_RESOLVER_SNAPSHOT = path;
  return sha;
}

function writeCandidates(fx, candidates) {
  const dir = join(fx.taskDir, "evidence", "acceptance-v1");
  mkdirSync(dir, { recursive: true });
  const document = { schemaVersion: 1, inputHashes: { intent: sha256("intent") }, candidates, unresolved: [] };
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return sha256(readFileSync(path, "utf8"));
}

function writePackage(fx, { capabilities, essential = true, weakCandidate = false, bindCapability = true }) {
  const detectionSha256 = weakCandidate
    ? (() => {
        const dir = join(fx.taskDir, "evidence", "acceptance-v1");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "external-contract-candidates.json"), `${JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [{ id: "candidate-lib", strength: "weak", signals: ["intent:plugin"] }], unresolved: [] }, null, 2)}\n`);
        return sha256(readFileSync(join(dir, "external-contract-candidates.json"), "utf8"));
      })()
    : writeCandidates(fx, [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }]);
  const acceptance = {
    schemaVersion: 2, acceptanceVersion: 1, taskId: basename(fx.taskDir), projectRoot: realpathSync(fx.projectDir),
    objective: "扩展装载并注册工具", nonGoals: [], riskLevel: "high", exploratoryReview: "required", reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "工具在真实宿主注册并可调用", required: true, riskAcceptable: false,
      evidenceKinds: ["command", "inspection"],
      assertions: [{
        id: "A1", statement: "工具按宿主签名执行并返回宿主可消费的结果对象", qualifiers: ["真实宿主"], given: "真实 official-runner 装载扩展", when: "调用工具", then: "返回结果对象",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
        ...(bindCapability ? { requiredEnvironment: { kind: "official-runner", capability: CAPABILITY_ID } } : { requiredEnvironment: { kind: "official-runner" } }),
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "按错误签名调用", timing: "命令期", expected: "被真实宿主拒绝", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: CONTRACT_ID, essential, authorityRequest: { resolverKind: "installed-npm-package", locator: "@scope/host" },
      capabilities,
    }],
    externalContractReview: weakCandidate
      ? { detectionSha256, dispositions: [{ candidateId: "candidate-lib", disposition: "manual", contractId: CONTRACT_ID, rationale: "intent 明示外部宿主，项目尚无源码与 manifest 信号" }] }
      : { detectionSha256, dispositions: [{ candidateId: "candidate-host", disposition: "bound", contractId: CONTRACT_ID }] },
  };
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  return acceptance;
}

function capability(overrides = {}) {
  return {
    id: CAPABILITY_ID, minEnvironment: "official-runner", observable: "真实工具按宿主调用签名执行，返回宿主可消费的结果对象",
    surfaceRefs: ["dist/types.d.ts#ToolDefinition"], detectionClasses: ["register-tool", "invoke-tool"], ...overrides,
  };
}

/** 推进到「已批准 + 方案确认 + 实现 + 探索 + 保证」；probe 证据由调用方决定是否登记。 */
function driveToAssured(t, fx, { authorityHash = AUTHORITY_HASH, snapshotSha256 = null, essential = true, weakCandidate = false, bindCapability = true } = {}) {
  writeSnapshot(fx, [{ id: CONTRACT_ID, status: "resolved", authorityAggregateHash: authorityHash, identity: { name: "host", version: "1.1.0" }, surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256("t") }], snapshotSha256: sha256("s") }], snapshotSha256);
  // probe driver 属项目内容：必须在计算 revision 之前落盘，否则 evaluate 的 revision 与证据登记 revision 不一致
  mkdirSync(join(fx.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(fx.projectDir, "scripts", "runtime-probe.mjs"), "// runtime probe driver\n");
  if (weakCandidate) {
    // 候选快照只有 weak 信号：不触发「strong 信号命中即强制 essential」
    const dir = join(fx.taskDir, "evidence", "acceptance-v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "external-contract-candidates.json"), `${JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [{ id: "candidate-lib", strength: "weak", signals: ["intent:plugin"] }], unresolved: [] }, null, 2)}\n`);
  }
  writePackage(fx, { capabilities: [capability()], essential, weakCandidate, bindCapability });
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "验收包应合法");
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env));
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(fx.taskDir, "evidence", "acceptance-review-v1.md"), "# review\n");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance], fx.home, fx.env));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home, fx.env));
  const solution = "evidence/solution.md";
  writeFileSync(join(fx.taskDir, solution), "# 方案\n");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, solution), "utf8")) }])}\n`);
  ok(runGate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user], fx.home, fx.env));
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "impl I1"], { cwd: fx.projectDir });
  const revision = runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim();
  writeFileSync(join(fx.taskDir, "evidence", "explore.md"), "# 探索\n");
  ok(runGate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", "evidence/explore.md", "--revision", revision,
    "--credential", fx.creds.assurance], fx.home, fx.env));
  writeFileSync(join(fx.taskDir, "evidence", "impl-I1.md"), "# 实现\n");
  ok(runGate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", "evidence/impl-I1.md", "--merge-receipt", JSON.stringify({ fromRevision: runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim(), toRevision: revision, patchSha256: sha256("patch") }),
    "--revision", revision, "--credential", fx.creds.builder], fx.home, fx.env));
  return revision;
}

/** 登记 runtime probe 证据 + full 保证，返回 evidence eventId。 */
function recordProbeEvidence(fx, revision, overrides = {}) {
  const {
    kind = "official-runner", capabilities = [CAPABILITY_ID], sourceHash = AUTHORITY_HASH,
    driver = "scripts/runtime-probe.mjs", driverHash = "auto", artifactName = "runtime-probe.json", subjectRevision = revision,
    cases = [{ capabilityId: CAPABILITY_ID, operation: "按真实宿主签名调用工具", observed: { called: true, resultAccepted: true }, passed: true }],
    driverMissing = false,
  } = overrides;
  if (driverMissing) rmSync(join(fx.projectDir, driver), { force: true });
  const driverFile = join(fx.projectDir, driver);
  const resolvedDriverHash = driverHash === "auto"
    ? (existsSync(driverFile) ? sha256(readFileSync(driverFile, "utf8")) : null)
    : driverHash;
  const document = {
    environment: {
      kind, name: "host", version: "1.1.0", source: "@scope/host dist/types.d.ts",
      sourceHash, driver, ...(resolvedDriverHash !== null ? { driverHash: resolvedDriverHash } : {}), capabilities,
    },
    subject: { revision: subjectRevision, entrypoint: "dist/index.js" },
    cases,
    summary: { passed: cases.filter((item) => item.passed === true).length, failed: cases.filter((item) => item.passed === false).length, skipped: cases.filter((item) => item.skipped === true).length },
  };
  writeFileSync(join(fx.taskDir, "evidence", artifactName), `${JSON.stringify(document, null, 2)}\n`);
  const appended = runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "command",
    "--result", "verified", "--summary", "runtime probe 观察", "--artifact", `evidence/${artifactName}`,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--contract-capability-ids", JSON.stringify([`${CONTRACT_ID}:${CAPABILITY_ID}`]), "--runtime-probe",
    "--revision", revision, "--credential", fx.creds.assurance], fx.home, fx.env);
  ok(appended, "runtime probe 证据应登记");
  const eventId = JSON.parse(parseStdout(appended)).eventId;
  // 第二条 inspection 证据（普通断言证据，不参与 runtime 判定）
  const inspectionArtifact = `ev-inspection-${artifactName}`;
  writeFileSync(join(fx.taskDir, "evidence", inspectionArtifact), `${JSON.stringify({ summary: "审查证据", environment: { kind, name: "host", version: "1.1.0", source: "@scope/host", sourceHash, driver, capabilities } }, null, 2)}\n`);
  const inspection = runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "inspection",
    "--result", "verified", "--summary", "审查取证", "--artifact", `evidence/${inspectionArtifact}`,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--revision", revision, "--credential", fx.creds.assurance], fx.home, fx.env);
  ok(inspection, "审查证据应登记");
  const explorationId = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "ExplorationCompleted").eventId;
  writeFileSync(join(fx.taskDir, "evidence", "assurance-full.md"), "# 保证\n");
  ok(runGate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify([eventId, JSON.parse(parseStdout(inspection)).eventId]),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--artifact", "evidence/assurance-full.md", "--revision", revision,
    "--credential", fx.creds.assurance], fx.home, fx.env), "full 保证登记");
  return eventId;
}

function evaluate(fx) {
  const result = runGate(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env);
  ok(result, "evaluate 应成功");
  return JSON.parse(parseStdout(result));
}

const probeRecord = (overrides = {}) => ({
  eventId: "EV-1", actor: "assurance", revision: "rev-final", runtimeProbe: true,
  contractCapabilityIds: [`${CONTRACT_ID}:${CAPABILITY_ID}`], artifactReadable: true,
  environment: { kind: "official-runner", sourceHash: AUTHORITY_HASH, driver: "probe.mjs", driverHash: sha256("driver"), capabilities: [CAPABILITY_ID] },
  cases: [{ capabilityId: CAPABILITY_ID, operation: "调用", observed: { ok: true }, passed: true }],
  subject: { revision: "rev-final" },
  driverHashOk: true,
  ...overrides,
});

const ACCEPTANCE_VIEW = {
  externalContracts: [{
    id: CONTRACT_ID, essential: true,
    capabilities: [{ id: CAPABILITY_ID, minEnvironment: "official-runner", detectionClasses: ["register-tool"], surfaceRefs: ["dist/types.d.ts"] }],
  }],
};

// ── 1. 纯函数：§6.1 六条件 ──

test("deriveRuntimeObligations：六条件全满足才 satisfied；任一不满足保持 open", () => {
  const facts = (evidence) => ({
    acceptance: ACCEPTANCE_VIEW,
    environmentSnapshot: { available: true, contracts: [{ id: CONTRACT_ID, status: "resolved", authorityAggregateHash: AUTHORITY_HASH }] },
    evidence,
    currentRevision: "rev-final",
    chainOkContracts: new Set([CONTRACT_ID]),
  });
  const satisfied = KERNEL.deriveRuntimeObligations(facts([probeRecord()]));
  assert.equal(satisfied.length, 1);
  assert.equal(satisfied[0].id, `runtime-${CONTRACT_ID}-${CAPABILITY_ID}`);
  assert.equal(satisfied[0].kind, "runtime");
  assert.equal(satisfied[0].state, "satisfied");
  assert.equal(satisfied[0].readiness, "established");
  assert.equal(satisfied[0].required, true);
  assert.deepEqual(satisfied[0].requiredEnvironment, { kind: "official-runner", capability: CAPABILITY_ID });
  assert.deepEqual(satisfied[0].evidenceRefs, ["EV-1"]);

  // ① 无证据 / 非 assurance / 非 runtimeProbe / revision 不符
  for (const evidence of [
    [],
    [probeRecord({ actor: "builder" })],
    [probeRecord({ runtimeProbe: false })],
    [probeRecord({ revision: "rev-spike" })],
  ]) {
    const result = KERNEL.deriveRuntimeObligations(facts(evidence));
    assert.equal(result[0].state, "open", `证据形态不符合应保持 open：${JSON.stringify(evidence[0] ?? null)}`);
    assert.equal(result[0].readiness, "not-established");
  }
  // ② 环境档位不足（fake-host / official-runner 证据 vs real-host 能力）
  const realHostAcceptance = { externalContracts: [{ id: CONTRACT_ID, essential: true, capabilities: [{ id: CAPABILITY_ID, minEnvironment: "real-host", detectionClasses: ["dispatch-command"], surfaceRefs: ["x"] }] }] };
  const lowKind = KERNEL.deriveRuntimeObligations({
    ...facts([probeRecord()]),
    acceptance: realHostAcceptance,
  });
  assert.equal(lowKind[0].state, "open");
  assert.match(lowKind[0].reason, /环境档位 official-runner 不满足能力底线 real-host/);
  // ③ 环境未声明能力覆盖
  const noCapability = KERNEL.deriveRuntimeObligations(facts([probeRecord({ environment: { kind: "official-runner", sourceHash: AUTHORITY_HASH, driver: "probe.mjs", driverHash: sha256("driver"), capabilities: ["other"] } })]));
  assert.equal(noCapability[0].state, "open");
  assert.match(noCapability[0].reason, /未声明能力覆盖/);
  // ④ sourceHash 与当前权威不一致
  const mismatch = KERNEL.deriveRuntimeObligations(facts([probeRecord({ environment: { kind: "official-runner", sourceHash: sha256("old-authority"), driver: "probe.mjs", driverHash: sha256("driver"), capabilities: [CAPABILITY_ID] } })]));
  assert.equal(mismatch[0].state, "open");
  assert.match(mismatch[0].reason, /sourceHash 与当前权威 aggregateHash 不一致/);
  // ⑤ probe case 未通过 / 被 skipped / 缺 case
  const failed = KERNEL.deriveRuntimeObligations(facts([probeRecord({ cases: [{ capabilityId: CAPABILITY_ID, operation: "输入 /memory off", observed: { registered: false }, passed: false }] })]));
  assert.equal(failed[0].state, "open");
  assert.match(failed[0].reason, /probe case 未通过/);
  const skipped = KERNEL.deriveRuntimeObligations(facts([probeRecord({ cases: [{ capabilityId: CAPABILITY_ID, skipped: true, skipReason: "真实宿主不可用" }] })]));
  assert.equal(skipped[0].state, "open");
  assert.match(skipped[0].reason, /skipped/);
  const noCase = KERNEL.deriveRuntimeObligations(facts([probeRecord({ cases: [] })]));
  assert.equal(noCase[0].state, "open");
  assert.match(noCase[0].reason, /无能力.*的观察 case/);
  // ⑥ probe subject.revision 与事件 revision 不一致（早期 spike 不能替代 final）
  const spike = KERNEL.deriveRuntimeObligations(facts([probeRecord({ subject: { revision: "rev-spike" } })]));
  assert.equal(spike[0].state, "open");
  assert.match(spike[0].reason, /subject.revision.*不一致/);
  // driver / driverHash
  const noDriver = KERNEL.deriveRuntimeObligations(facts([probeRecord({ driverHashOk: false })]));
  assert.equal(noDriver[0].state, "open");
  assert.match(noDriver[0].reason, /driver/);
  // 权威不可解析 → unknown（无法判定，不是观察失败）
  const unresolved = KERNEL.deriveRuntimeObligations({
    ...facts([probeRecord()]),
    environmentSnapshot: { available: true, contracts: [{ id: CONTRACT_ID, status: "declared-unavailable", authorityAggregateHash: null }] },
  });
  assert.equal(unresolved[0].state, "open");
  assert.equal(unresolved[0].readiness, "unknown");
  // 环境历史链断裂 → unknown
  const broken = KERNEL.deriveRuntimeObligations({ ...facts([probeRecord()]), chainOkContracts: new Set() });
  assert.equal(broken[0].state, "open");
  assert.equal(broken[0].readiness, "unknown");
  assert.match(broken[0].reason, /环境历史链断裂/);
  // 无 externalContracts → 空数组（普通任务零开销）
  assert.deepEqual(KERNEL.deriveRuntimeObligations({ acceptance: {}, evidence: [probeRecord()] }), []);
});

test("runtime 义务不可豁免：deriveObligations 不产生 explicitly-waived 的 runtime 条目", () => {
  const runtime = KERNEL.deriveRuntimeObligations({
    acceptance: ACCEPTANCE_VIEW,
    environmentSnapshot: { available: true, contracts: [{ id: CONTRACT_ID, status: "resolved", authorityAggregateHash: AUTHORITY_HASH }] },
    evidence: [],
    currentRevision: "rev-final",
    chainOkContracts: new Set([CONTRACT_ID]),
  });
  const merged = KERNEL.deriveObligations({
    verdict: { requirements: [], missing: {} },
    acceptance: { schemaVersion: 2 },
    runtimeObligations: runtime,
  });
  const runtimeEntries = merged.obligations.filter((item) => item.kind === "runtime");
  assert.equal(runtimeEntries.length, 1);
  assert.equal(runtimeEntries[0].state, "open");
  assert.ok(merged.openRequired.some((item) => item.id === runtimeEntries[0].id), "open runtime 义务进 accepted 前置");
  // 上游误传 explicitly-waived 也按 open 收敛（防御性）
  const coerced = KERNEL.deriveObligations({
    verdict: { requirements: [], missing: {} },
    acceptance: { schemaVersion: 2 },
    runtimeObligations: [{ ...runtime[0], state: "explicitly-waived" }],
  });
  assert.equal(coerced.obligations.find((item) => item.kind === "runtime").state, "open");
});

// ── 2. 端到端：无 probe 不得 accepted ──

test("无 runtime probe 证据：readiness=not-established，不得 accepted，恢复动作指向重跑 probe", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  writeFileSync(join(fx.taskDir, "evidence", "ev-command.md"), "# 命令证据（无 probe 元数据）\n");
  ok(runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "command",
    "--result", "verified", "--summary", "命令取证", "--artifact", "evidence/ev-command.md",
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--revision", revision, "--credential", fx.creds.assurance], fx.home, fx.env), "普通证据登记");
  writeFileSync(join(fx.taskDir, "evidence", "ev-inspection.md"), "# 审查证据\n");
  ok(runGate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "inspection",
    "--result", "verified", "--summary", "审查取证", "--artifact", "evidence/ev-inspection.md",
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--revision", revision, "--credential", fx.creds.assurance], fx.home, fx.env), "审查证据登记");
  const events = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const explorationId = events.find((event) => event.type === "ExplorationCompleted").eventId;
  const evidenceIds = events.filter((event) => event.type === "EvidenceRecorded").map((event) => event.eventId);
  writeFileSync(join(fx.taskDir, "evidence", "assurance-full.md"), "# 保证\n");
  ok(runGate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify(evidenceIds),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--artifact", "evidence/assurance-full.md", "--revision", revision,
    "--credential", fx.creds.assurance], fx.home, fx.env), "full 保证登记");
  const verdict = evaluate(fx);
  assert.equal(verdict.runtimeReadiness.overall, "not-established", "无 probe 证据不得判 established");
  const contract = verdict.runtimeReadiness.contracts[0];
  assert.equal(contract.contractId, CONTRACT_ID);
  assert.equal(contract.capabilities[0].state, "not-established");
  assert.notEqual(verdict.state, "accepted", "mock/普通证据不能建立运行可用性");
  assert.notEqual(verdict.state, "accepted_with_risk");
  const open = verdict.missing.openObligations.find((item) => item.kind === "runtime");
  assert.ok(open, "runtime 义务进 missing.openObligations");
  assert.equal(open.contractId, CONTRACT_ID);
  assert.match(open.recovery, /record-evidence --runtime-probe/, "恢复动作指向真实环境重跑 probe");
  assert.match(open.recovery, /runtime 义务没有豁免通道/, "明确不可豁免");
});

// ── 3. probe 齐备 → established 且 accepted ──

test("runtime probe 齐备：readiness=established，任务 accepted", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision);
  const verdict = evaluate(fx);
  assert.equal(verdict.runtimeReadiness.overall, "established");
  assert.equal(verdict.runtimeReadiness.contracts[0].capabilities[0].state, "established");
  assert.equal(verdict.runtimeReadiness.contracts[0].capabilities[0].evidenceEventId !== null, true, "established 能力绑证据事件");
  assert.equal(verdict.state, "accepted", "probe 齐备且其余条件满足时应 accepted");
});

test("core obligations 子命令输出含 kind=runtime 义务（判定单源复用）", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision);
  const result = await runCore(["obligations", "--task-dir", fx.taskDir], fx.home, fx.env);
  assert.equal(result.status, 0, `obligations 应成功\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  const runtime = payload.obligations.filter((item) => item.kind === "runtime");
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].state, "satisfied");
  assert.equal(runtime[0].id, `runtime-${CONTRACT_ID}-${CAPABILITY_ID}`);
  assert.equal(payload.openRequired.some((item) => item.kind === "runtime"), false, "satisfied 的 runtime 义务不进 openRequired");
});

// ── 4. 证据环境真实性（§8.1）──

test("sourceHash 与当前权威不一致：证据最多 partial，runtime 义务 open，不得 accepted", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision, { sourceHash: sha256("stale-authority") });
  const verdict = evaluate(fx);
  const assertion = verdict.requirements.find((item) => item.id === "R1").assertions[0];
  const entry = assertion.evidence.find((item) => item.kind === "command");
  assert.equal(entry.result, "partial", "sourceHash 不符的证据最多 partial");
  assert.match(entry.runtimeEvidenceGap.reason, /sourceHash 与契约.*当前权威 aggregateHash 不一致/);
  assert.equal(verdict.runtimeReadiness.overall, "not-established");
  assert.notEqual(verdict.state, "accepted");
});

test("driver 缺失 / driverHash 不一致：证据不得 verified，runtime 义务 open", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  // driver 指向不存在的文件 → 驱动不可核（不删项目文件：删除会推进 revision）
  recordProbeEvidence(fx, revision, { driver: "scripts/no-such-driver.mjs" });
  const verdict = evaluate(fx);
  const entry = verdict.requirements.find((item) => item.id === "R1").assertions[0].evidence.find((item) => item.kind === "command");
  assert.equal(entry.result, "partial");
  assert.match(entry.runtimeEvidenceGap.reason, /driver/);
  assert.equal(verdict.runtimeReadiness.overall, "not-established");
  // driverHash 与文件内容不一致
  const fx2 = makeFixture(t, { taskId: "runtime-ob-2" });
  const revision2 = driveToAssured(t, fx2);
  recordProbeEvidence(fx2, revision2, { driverHash: sha256("wrong-driver-hash") });
  const verdict2 = evaluate(fx2);
  const entry2 = verdict2.requirements.find((item) => item.id === "R1").assertions[0].evidence.find((item) => item.kind === "command");
  assert.equal(entry2.result, "partial");
  assert.match(entry2.runtimeEvidenceGap.reason, /driverHash 与驱动文件内容不一致/);
});

test("probe 在早期 spike revision 上执行：subject.revision 不符 → 义务 open", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision, { subjectRevision: "rev-spike" });
  const verdict = evaluate(fx);
  const entry = verdict.requirements.find((item) => item.id === "R1").assertions[0].evidence.find((item) => item.kind === "command");
  assert.equal(entry.result, "partial");
  assert.match(entry.runtimeEvidenceGap.reason, /subject.revision/);
  const capability = verdict.runtimeReadiness.contracts[0].capabilities[0];
  assert.equal(capability.state, "not-established");
  assert.match(capability.reason, /早期 spike 不能替代 final/);
});

// ── 5. 环境历史链（§4.3/§10）──

test("权威变化无基线确认：环境历史链断裂阻断 accepted；用户确认后接链（仍须重跑 probe）", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision);
  // 外部环境升级：当前权威哈希变化（approve 时绑定的是 AUTHORITY_HASH）
  const newHash = sha256("authority-v2");
  // 落盘当前（漂移后）环境快照并取其真实 snapshotSha256——confirm-environment-baseline 的
  // F13 校验要求该 sha 对应 environment-contracts/<sha>.json 存在，故此处同步落盘
  const driftedSnapshotSha = writeSnapshot(fx, [{ id: CONTRACT_ID, status: "resolved", authorityAggregateHash: newHash, identity: { name: "host", version: "2.0.0" }, surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256("t2") }], snapshotSha256: sha256("s2") }], sha256("snap-v2"));
  mkdirSync(join(fx.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(join(fx.taskDir, "environment-contracts", `${driftedSnapshotSha}.json`), JSON.stringify({ schemaVersion: 1, snapshotSha256: driftedSnapshotSha }));
  const drifted = evaluate(fx);
  assert.notEqual(drifted.state, "accepted", "环境漂移未经用户确认不得 accepted");
  assert.equal(drifted.runtimeReadiness.overall, "unknown", "环境变化未经确认 = 无法判定");
  assert.ok(drifted.missing.environmentChain !== null, "链条断裂进 missing.environmentChain");
  assert.match(drifted.missing.environmentChain.recovery, /confirm-environment-baseline/, "恢复动作指向用户确认基线");
  // 用户确认新基线 → 接链；但 probe 证据的 sourceHash 仍是旧权威 → 仍须重跑 probe
  ok(runGate(["confirm-environment-baseline", "--task-dir", fx.taskDir, "--contract-ids", JSON.stringify([CONTRACT_ID]),
    "--new-authority-snapshot-sha256", driftedSnapshotSha, "--credential", fx.creds.user], fx.home, fx.env), "确认新基线");
  const confirmed = evaluate(fx);
  assert.equal(confirmed.missing.environmentChain, null, "确认后环境历史链接上");
  assert.notEqual(confirmed.state, "accepted", "接链不等于满足——仍须在当前环境重跑 probe");
  // 用新权威重跑 probe → established
  recordProbeEvidence(fx, revision, { sourceHash: newHash, artifactName: "runtime-probe-2.json" });
  const reProbed = evaluate(fx);
  assert.equal(reProbed.runtimeReadiness.overall, "established");
  assert.equal(reProbed.state, "accepted");
});

// ── 6. 候选复扫（§8.1 第 1 条）──

test("候选复扫：未映射 strong 候选与 unresolved 外部访问直接拒绝 evaluate", async (t) => {
  const fx = makeFixture(t);
  const revision = driveToAssured(t, fx);
  recordProbeEvidence(fx, revision);
  // 绿地后引入外部调用：源码出现 registerCommand，但能力清单只声明 register-tool/invoke-tool
  writeFileSync(join(fx.root, "candidates.json"), `${JSON.stringify({
    schemaVersion: 1, inputHashes: {},
    candidates: [{ id: "candidate-command", strength: "strong", signals: ["call-class:register-command"] }],
    unresolved: [],
  }, null, 2)}\n`);
  fx.env.STUB_DETECTOR_CANDIDATES = join(fx.root, "candidates.json");
  denied(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env), /未登记 strong 信号/, "能力清单低报在 evaluate 被拒");
  // unresolved 外部访问
  writeFileSync(join(fx.root, "candidates.json"), `${JSON.stringify({
    schemaVersion: 1, inputHashes: {}, candidates: [],
    unresolved: [{ signal: "dynamic import(moduleName)", reason: "调用参数不是字符串字面量，无法静态归因" }],
  }, null, 2)}\n`);
  denied(runGate(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env), /未解外部访问/, "动态外部访问必须停回");
  // 复扫不可用：不伪造「无信号」结论——fail-closed 阻断 accepted 并披露
  fx.env.DELIVERY_EXTERNAL_CONTRACT_DETECTOR = join(fx.stubDir, "missing.mjs");
  const result = runGate(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env);
  ok(result, "复扫不可用不崩溃 evaluate");
  const verdict = JSON.parse(parseStdout(result));
  assert.notEqual(verdict.state, "accepted", "复扫不可用按 fail-closed 处理");
});

// ── 7. 非 essential 契约与 overall 口径（§12.1）──

test("非 essential 契约能力缺失不进 overall，但逐条披露在 nonEssentialGaps", async (t) => {
  const fx = makeFixture(t);
  // 契约非 essential + 候选只有 weak 信号 + 断言不绑定能力 → 无强制 essential、无检查 5 触发
  const revision = driveToAssured(t, fx, { essential: false, weakCandidate: true, bindCapability: false });
  const verdict = evaluate(fx);
  assert.equal(verdict.runtimeReadiness.overall, "established", "非增强契约能力缺失不进 overall");
  assert.equal(verdict.runtimeReadiness.contracts[0].essential, false);
  assert.ok(Array.isArray(verdict.runtimeReadiness.nonEssentialGaps), "非增强缺口逐条披露");
  assert.equal(verdict.runtimeReadiness.nonEssentialGaps[0].capabilityId, CAPABILITY_ID);
  assert.equal(verdict.runtimeReadiness.nonEssentialGaps[0].state, "not-established");
});

test("externalContracts 为空时 overall=not-applicable（普通任务零开销、事件形态不变）", async (t) => {
  const fx = makeFixture(t, { taskId: "runtime-ob-plain" });
  writeSnapshot(fx, []);
  const acceptance = {
    schemaVersion: 2, acceptanceVersion: 1, taskId: basename(fx.taskDir), projectRoot: realpathSync(fx.projectDir),
    objective: "普通内部库改造", nonGoals: [], riskLevel: "low", exploratoryReview: "not-required", reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "内部工具返回稳定结果", required: true, riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{ id: "A1", statement: "返回稳定结果", qualifiers: ["输入合法"], given: "合法输入", when: "调用", then: "返回结果", adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"] }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "输入合法", entryPoint: "auto", initialState: "s", operation: "非法输入", timing: "调用期", expected: "拒绝", testAssetRefs: ["test-A1"], rationale: "r" }],
  };
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({ schemaVersion: 1, acceptanceVersion: 1, items: [{ id: "I1", title: "实现", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }] }, null, 2)}\n`);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home, fx.env), "无外部契约的验收包应通过");
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home, fx.env));
  writeFileSync(join(fx.taskDir, "evidence", "review.md"), "# review\n");
  ok(runGate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance, "--artifact", "evidence/review.md"], fx.home, fx.env));
  ok(runGate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user], fx.home, fx.env));
  const verdict = evaluate(fx);
  assert.equal(verdict.runtimeReadiness.overall, "not-applicable");
  assert.deepEqual(verdict.runtimeReadiness.contracts, []);
  const approval = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "AcceptanceApproved");
  assert.equal(approval.authoritySnapshotSha256, undefined, "无外部契约时不在批准事件上塞快照哈希（事件形态不变）");
});
