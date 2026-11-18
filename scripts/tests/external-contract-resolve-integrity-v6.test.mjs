// external-contract-resolve-integrity-v6.test.mjs — 权威解析信任规则互核与字段名端到端
//
// 被测实现：skills/self/dev-workflow/delivery-v6/scripts/resolve-external-contracts.mjs
//   + delivery-gate.mjs 的 evaluate 侧权威消费（runtimeReadiness 契约级哈希）。
//（设计《V6 运行可用性与外部契约守门升级》§4.3 信任规则 / §4.4 / §12.1；测试审查
//  发现 7「lockfile integrity 互核无承重」+ 接缝缺口「resolve stdout → gate 终判字段名」。）
//
// 覆盖：
//   1. lockfile integrity 互核承重（审查发现 7，P2）：plantNpmCache 造合法缓存 →
//      resolve 放行（对照，证明互核通过路径本身被断言）；篡改缓存内容字节 →
//      resolve 拒绝（离线 fail-closed 的第三核对点：lockfile / 快照 / registry 元数据互核）。
//   2. 字段名端到端（接缝缺口 4）：真实 resolver stdout 的 contracts[].authorityAggregateHash
//      被真实 gate evaluate 终判消费——verdict.runtimeReadiness.contracts[0].authorityHash
//      必须等于 resolver 直接输出的契约级哈希（同一字段名、同一值，禁下游另起键名）。
//
// fixture 纪律：mkdtempSync 临时目录、HOME 重定向（npm 缓存与凭据全部隔离）、t.after 清理、
// 无固定文件名；npm 缓存形态照 external-contract-resolve-v6.test.mjs 的 plantNpmCache。
//
// 运行：node --test scripts/tests/external-contract-resolve-integrity-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const RESOLVER = join(V6, "scripts", "resolve-external-contracts.mjs");
const DETECTOR = join(V6, "scripts", "detect-external-contracts.mjs");
const GATE_MODULE = await import(pathToFileURL(GATE).href);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
const ok = (result, label = "命令应成功") => {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
};

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 把假 tarball 内容写进 HOME 下的 npm cacache，返回 lockfile 用的 integrity 串 */
function plantNpmCache(home, content) {
  const digest = createHash("sha512").update(content).digest();
  const hex = digest.toString("hex");
  const dir = join(home, ".npm", "_cacache", "content-v2", "sha512", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex.slice(2)), content);
  return `sha512-${digest.toString("base64")}`;
}

/** npm 项目 fixture：package.json + node_modules 副本 + lockfile（integrity 指向 planted 缓存） */
function makeNpmProject(base, { name = "fake-host-sdk", version = "1.0.0", content = "TARBALL:fake-host-sdk@1.0.0" } = {}) {
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const proj = join(base, "proj");
  write(join(proj, "package.json"), `${JSON.stringify({ name: "fixture-proj", version: "1.0.0", dependencies: { [name]: "^1.0.0" } }, null, 2)}\n`);
  write(join(proj, "node_modules", name, "package.json"), `${JSON.stringify({ name, version, main: "dist/index.js" }, null, 2)}\n`);
  write(join(proj, "node_modules", name, "dist", "types.d.ts"), "export interface ToolDefinition { name: string }\n");
  write(join(proj, "node_modules", name, "dist", "index.js"), "module.exports = {};\n");
  const integrity = plantNpmCache(home, content);
  write(join(proj, "package-lock.json"), `${JSON.stringify({
    name: "fixture-proj",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture-proj", dependencies: { [name]: "^1.0.0" } },
      [`node_modules/${name}`]: { version, integrity },
    },
  }, null, 2)}\n`);
  return { home, proj, integrity };
}

function runResolve(home, args) {
  // 夹具隔离：剥掉 npm 上下文（npm test / npm run）注入的 npm_* 环境变量——
  // npm_config_cache 会把 resolver 内部 npm 子命令（config get cache）的缓存定位
  // 从 fixture HOME 引到真实用户缓存，互核读到隔离外内容（曾让篡改用例被放行）
  const env = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("npm_")) delete env[key];
  return spawnSync(process.execPath, [RESOLVER, ...args], { encoding: "utf8", env });
}

const NPM_CONTRACT = {
  id: "EC-npm",
  essential: true,
  authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
  capabilities: [
    { id: "register-tool-and-invoke", minEnvironment: "official-runner", observable: "工具在官方 runner 注册并可调用", surfaceRefs: ["dist/types.d.ts#ToolDefinition", "dist/index.js"], detectionClasses: ["register-tool"] },
  ],
};

function writeAcceptance(taskDir, contracts) {
  write(join(taskDir, "acceptance.json"), `${JSON.stringify({
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: "ec-integrity",
    projectRoot: "PLACEHOLDER",
    objective: "扩展装载并注册工具",
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["外部契约"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "工具在真实宿主注册并可调用", required: true, riskAcceptable: false,
      evidenceKinds: ["command", "inspection"],
      assertions: [{
        id: "A1", statement: "工具按宿主签名执行并返回宿主可消费的结果对象", qualifiers: ["真实宿主"], given: "真实 official-runner 装载扩展", when: "调用工具", then: "返回结果对象",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
        requiredEnvironment: { kind: "official-runner", capability: "register-tool-and-invoke" },
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "按错误签名调用", timing: "命令期", expected: "被真实宿主拒绝", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: contracts,
  }, null, 2)}\n`);
}

// ── 1. lockfile integrity 互核（审查发现 7）──

test("lockfile integrity 互核：合法缓存放行（对照）——互核通过路径本身被断言", (t) => {
  const base = mkdtempSync(join(tmpdir(), "ec-integrity-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { home, proj } = makeNpmProject(base);
  const taskDir = join(base, "task");
  mkdirSync(taskDir, { recursive: true });
  writeAcceptance(taskDir, [NPM_CONTRACT]);
  writeFileSync(join(taskDir, "events.jsonl"), "");
  const run = runResolve(home, ["--task-dir", taskDir, "--project-root", proj]);
  assert.equal(run.status, 0, `解析应成功：${run.stderr}`);
  const summary = JSON.parse(run.stdout);
  const contract = summary.contracts.find((entry) => entry.id === "EC-npm");
  assert.equal(contract.status, "resolved", "缓存与 lockfile 互核通过时应 resolved");
  assert.match(contract.authorityAggregateHash, /^[0-9a-f]{64}$/);
});

test("lockfile integrity 互核：篡改缓存内容 → resolve 拒绝（离线 fail-closed 第三核对点承重）", (t) => {
  const base = mkdtempSync(join(tmpdir(), "ec-integrity-tamper-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { home, proj } = makeNpmProject(base);
  const taskDir = join(base, "task");
  mkdirSync(taskDir, { recursive: true });
  writeAcceptance(taskDir, [NPM_CONTRACT]);
  writeFileSync(join(taskDir, "events.jsonl"), "");
  // 篡改：缓存内容字节改写（路径不变——地址仍命中，内容哈希不再匹配 lockfile integrity）
  const digest = createHash("sha512").update("TARBALL:fake-host-sdk@1.0.0").digest();
  const hex = digest.toString("hex");
  const cacheFile = join(home, ".npm", "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2));
  assert.ok(existsSync(cacheFile), "fixture 前提：缓存内容已落盘");
  writeFileSync(cacheFile, "TARBALL:TAMPERED-EVIL-PAYLOAD");
  const run = runResolve(home, ["--task-dir", taskDir, "--project-root", proj]);
  assert.equal(run.status, 0, "resolve 对单个契约不可解析不整体失败（stdout 摘要照常输出）");
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.contracts.length, 0, "缓存被篡改的契约不得判 resolved");
  assert.equal(summary.unresolvedContracts.length, 1);
  assert.match(summary.unresolvedContracts[0].reason, /包缓存内容与 lockfile integrity 不一致/, "必须点名互核失败（lockfile / 快照 / registry 元数据互核，设计 §4.3 信任规则）");
});

// ── 2. 字段名端到端：resolve stdout → gate evaluate 终判（接缝缺口 4）──

test("字段名端到端：真实 resolver stdout 的 authorityAggregateHash 被 evaluate 终判原样消费", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ec-integrity-gate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { home, proj } = makeNpmProject(base);
  const projReal = realpathSync(proj);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projReal });
  appendFileSync(join(projReal, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  spawnSync("git", ["add", "."], { cwd: projReal });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projReal });
  const intentPath = join(base, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册工具\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", projReal, "--task-id", "ec-integrity", "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const taskDir = JSON.parse(parseStdout(init)).taskDir;
  // 验收包：projectRoot / taskId 回填 fixture 实际值（loadWorld 核对 task.json 一致）
  writeAcceptance(taskDir, [NPM_CONTRACT]);
  const acceptancePath = join(taskDir, "acceptance.json");
  const acceptance = JSON.parse(readFileSync(acceptancePath, "utf8"));
  acceptance.projectRoot = projReal;
  acceptance.taskId = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")).taskId;
  writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
  write(join(taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(GATE_MODULE.runGateCommand(["snapshot-policy", "--task-dir", taskDir], home), "snapshot-policy 应成功");
  // 候选快照（真实探测器输出落盘，与验收线同形态）+ externalContractReview 对账
  // （evaluate 前置复扫要求 externalContracts 声明时处置表在场）
  const detectRun = spawnSync(process.execPath, [DETECTOR, "--project-root", projReal, "--intent-file", intentPath], { encoding: "utf8" });
  assert.equal(detectRun.status, 0, `探测器应成功：${detectRun.stderr}`);
  const candidateDir = join(taskDir, "evidence", "acceptance-v1");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, "external-contract-candidates.json"), detectRun.stdout);
  const detectionSha256 = sha256(detectRun.stdout);
  acceptance.externalContractReview = { detectionSha256, dispositions: [] };
  writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
  // 真实 resolver 直跑一遍，取契约级哈希字段名与值（端到端对拍——对照验证（differential testing）的期望源）
  const direct = runResolve(home, ["--task-dir", taskDir, "--project-root", projReal]);
  assert.equal(direct.status, 0, `resolver 直跑应成功：${direct.stderr}`);
  const directContract = JSON.parse(direct.stdout).contracts.find((entry) => entry.id === "EC-npm");
  assert.ok(Object.hasOwn(directContract, "authorityAggregateHash"), "resolver stdout 契约级字段名必须是 authorityAggregateHash");
  const env = {
    DELIVERY_EXTERNAL_CONTRACT_RESOLVER: RESOLVER,
    DELIVERY_EXTERNAL_CONTRACT_DETECTOR: DETECTOR,
  };
  // evaluate 终判：复扫前置（真实探测器扫 fixture 项目——无 strong 信号）+ 权威现场重解析
  const verdict = JSON.parse(parseStdout(GATE_MODULE.runGateCommand(["evaluate", "--task-dir", taskDir], home, env)));
  const readiness = verdict.runtimeReadiness;
  assert.equal(readiness.authorityAvailable, true, "evaluate 应经 resolver 现场重解析拿到权威");
  assert.equal(readiness.contracts.length, 1);
  assert.equal(readiness.contracts[0].contractId, "EC-npm");
  assert.match(readiness.contracts[0].authorityHash ?? "", /^[0-9a-f]{64}$/, "终判消费的契约级哈希必须是 64 位十六进制");
  assert.equal(
    readiness.contracts[0].authorityHash,
    directContract.authorityAggregateHash,
    "端到端字段名对账：gate 终判的 authorityHash 必须等于 resolver stdout 的 authorityAggregateHash（同一值，禁下游另起键名或静默改名）",
  );
});
