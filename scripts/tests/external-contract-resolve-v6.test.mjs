// external-contract-resolve-v6.test.mjs —— 外部契约权威解析与环境快照独立局部测试
//
// 被测实现：skills/self/dev-workflow/delivery-v6/scripts/resolve-external-contracts.mjs
//（设计《V6 运行可用性与外部契约守门升级》§4.3/§4.4：四类 resolver、信任规则、
// 按哈希分文件快照与 current 指针）。
//
// 覆盖：
//   1. installed-npm-package：lockfile 完整性 + npm 包缓存互核通过 → resolved + surfaces 哈希
//   2. 信任规则拒绝路径：lockfile 版本不一致 / 缓存缺失（离线 fail-closed）/ 项目内自造包无 lockfile 记录
//   3. local-path：user 登记 + 独立目录 → resolved；无登记事件 → 拒绝；同 git 仓库（含 worktree）→ 拒绝
//   4. executable：user 登记绝对路径 + which 印证 + 版本自报 + 内容哈希；登记路径不存在 → 拒绝
//   5. declared-unavailable：不伪造 resolved，authorityAggregateHash 为 null
//   6. 不支持的 resolverKind → unresolved（停回，不猜测）
//   7. --contract-id 过滤与未知 id 用法错误
//   8. actor 非 user 的 ExternalAuthorityDeclared 不采信
//   9. 空 externalContracts → 空快照有稳定身份
//  10. 快照稳定性：同内容二次解析同 snapshotSha256、快照文件不重复生成、current 指针更新；
//      surface 内容变化 → snapshot 哈希变化
//  11. 输出摘要字段名对账：契约级 authorityAggregateHash + 顶层 snapshotSha256
//
// fixture 一律临时目录构造、用完即删（npm 缓存 / 假包 / 事件文件全部自造，不依赖真实全局安装）；
// HOME 重定向到临时目录隔离 npm 缓存读取。git fixture 参照 commit-scope-v6.test.mjs 的
// git init 最小构造模式。
//
// 运行：node --test scripts/tests/external-contract-resolve-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "resolve-external-contracts.mjs");

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
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

function runResolve(home, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function parseSummary(run) {
  assert.equal(run.status, 0, `解析应成功：${run.stderr}`);
  return JSON.parse(run.stdout);
}

function makeNpmProject(base, { name = "fake-host-sdk", version = "1.0.0" } = {}) {
  const proj = join(base, "proj");
  write(join(proj, "package.json"), `${JSON.stringify({ name: "fixture-proj", version: "1.0.0", dependencies: { [name]: "^1.0.0" } }, null, 2)}\n`);
  write(join(proj, "node_modules", name, "package.json"), `${JSON.stringify({ name, version, main: "dist/index.js" }, null, 2)}\n`);
  write(join(proj, "node_modules", name, "dist", "types.d.ts"), "export interface ToolDefinition { name: string }\n");
  write(join(proj, "node_modules", name, "dist", "index.js"), "module.exports = {};\n");
  const integrity = plantNpmCache(join(base, "home"), `TARBALL:${name}@${version}`);
  write(join(proj, "package-lock.json"), `${JSON.stringify({
    name: "fixture-proj",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture-proj", dependencies: { [name]: "^1.0.0" } },
      [`node_modules/${name}`]: { version, integrity },
    },
  }, null, 2)}\n`);
  return { proj, integrity };
}

const NPM_CONTRACT = {
  id: "EC-npm",
  essential: true,
  authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
  capabilities: [
    { id: "register-tool-and-invoke", minEnvironment: "official-runner", observable: "x", surfaceRefs: ["dist/types.d.ts#ToolDefinition", "dist/index.js"], detectionClasses: ["register-tool"] },
  ],
};

const LOCAL_CONTRACT = {
  id: "EC-local",
  essential: true,
  authorityRequest: { resolverKind: "local-path", locator: "LOCAL_SDK" },
  capabilities: [
    { id: "dispatch-slash-command", minEnvironment: "real-host", observable: "x", surfaceRefs: ["dist/host.d.ts#registerCommand"], detectionClasses: ["register-command"] },
  ],
};

const EXEC_CONTRACT = {
  id: "EC-bin",
  essential: false,
  authorityRequest: { resolverKind: "executable", locator: "FAKEBIN" },
  capabilities: [],
};

function makeBase(t) {
  const base = mkdtempSync(join(tmpdir(), "ec-resolve-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const { proj } = makeNpmProject(base);
  const sdkDir = join(base, "sdk");
  const localSdk = join(sdkDir, "local-sdk");
  write(join(localSdk, "package.json"), `${JSON.stringify({ name: "local-host-sdk", version: "2.3.4" }, null, 2)}\n`);
  write(join(localSdk, "dist", "host.d.ts"), "export declare function registerCommand(name: string, options: object): void;\n");
  const fakebin = join(sdkDir, "fakebin");
  write(fakebin, "#!/bin/sh\necho \"fakebin 9.9.9\"\n");
  spawnSync("chmod", ["+x", fakebin]);
  const taskDir = join(base, "task");
  mkdirSync(taskDir, { recursive: true });
  // git 仓 fixture：同仓库拒绝用例（worktree 身份覆盖）
  const gitProj = join(base, "git-proj");
  mkdirSync(join(gitProj, "sub-sdk"), { recursive: true });
  write(join(gitProj, "sub-sdk", "package.json"), `${JSON.stringify({ name: "sub-sdk", version: "1.0.0" }, null, 2)}\n`);
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: gitProj, encoding: "utf8" });
  assert.equal(gitInit.status, 0, "git init 失败");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, home, proj, localSdk, fakebin, taskDir, gitProj };
}

function writeAcceptance(taskDir, contracts) {
  write(join(taskDir, "acceptance.json"), `${JSON.stringify({ schemaVersion: 2, externalContracts: contracts }, null, 2)}\n`);
}

function writeEvents(taskDir, lines) {
  writeFileSync(join(taskDir, "events.jsonl"), lines.map((line, index) => JSON.stringify({ seq: index + 1, ...line })).join("\n") + "\n");
}

/** 契约模板占位符替换（LOCAL_SDK / FAKEBIN → fixture 实际路径） */
function substitute(contract, localSdkPath, fakebinPath) {
  return JSON.parse(JSON.stringify(contract).replaceAll("LOCAL_SDK", localSdkPath ?? "").replaceAll("FAKEBIN", fakebinPath ?? ""));
}

test("installed-npm-package：lockfile 完整性 + 包缓存互核通过 → resolved 并落盘只读副本", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const run = runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]);
  const summary = parseSummary(run);
  const contract = summary.contracts.find((entry) => entry.id === "EC-npm");
  assert.equal(contract.status, "resolved");
  assert.equal(contract.identity.name, "fake-host-sdk");
  assert.equal(contract.identity.version, "1.0.0");
  assert.equal(contract.surfaces.length, 2);
  assert.match(contract.authorityAggregateHash, /^[0-9a-f]{64}$/);
  // 落盘：按哈希分文件快照 + current 指针 + surface 只读副本
  const contractsDir = join(fx.taskDir, "environment-contracts");
  const snapshotPath = join(contractsDir, `${summary.snapshotSha256}.json`);
  assert.ok(existsSync(snapshotPath), "快照文件应按 snapshotSha256 命名落盘");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.snapshotSha256, summary.snapshotSha256);
  assert.equal(snapshot.contracts[0].resolver.resolution, "project-dependency");
  const pointer = JSON.parse(readFileSync(join(contractsDir, "environment-contracts.current.json"), "utf8"));
  assert.equal(pointer.snapshotSha256, summary.snapshotSha256);
  const copy = join(contractsDir, "surfaces", summary.snapshotSha256, "EC-npm", "dist", "types.d.ts");
  assert.ok(existsSync(copy), "surface 只读副本应复制进 taskDir");
  assert.equal((statSync(copy).mode & 0o444) === 0o444, true, "副本应为只读形态（0444）");
  assert.equal(
    createHash("sha256").update(readFileSync(copy)).digest("hex"),
    createHash("sha256").update(readFileSync(join(fx.proj, "node_modules", "fake-host-sdk", "dist", "types.d.ts"))).digest("hex"),
    "副本内容应与权威源一致",
  );
});

test("信任规则：lockfile 版本不一致 → 拒绝（项目内副本只能作为线索）", (t) => {
  const fx = makeBase(t);
  const lock = JSON.parse(readFileSync(join(fx.proj, "package-lock.json"), "utf8"));
  lock.packages["node_modules/fake-host-sdk"].version = "9.9.9";
  write(join(fx.proj, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.equal(summary.unresolvedContracts.length, 1);
  assert.match(summary.unresolvedContracts[0].reason, /与 lockfile 9\.9\.9 不一致/);
});

test("信任规则：包缓存缺失（离线）→ fail-closed 拒绝项目内副本", (t) => {
  const fx = makeBase(t);
  rmSync(join(fx.home, ".npm"), { recursive: true, force: true });
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /离线 fail-closed/);
});

test("信任规则：项目内自造包无 lockfile 记录 → 拒绝", (t) => {
  const fx = makeBase(t);
  rmSync(join(fx.proj, "package-lock.json"));
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /无 lockfile 记录/);
});

test("local-path：user 登记 + 独立目录 → resolved（identity 与 surfaces 哈希）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(LOCAL_CONTRACT, fx.localSdk)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-local", resolverKind: "local-path", locator: fx.localSdk, snapshotSha256: null, summary: "用户提供本地宿主 SDK 源码目录" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  const contract = summary.contracts.find((entry) => entry.id === "EC-local");
  assert.equal(contract.status, "resolved");
  assert.equal(contract.identity.name, "local-host-sdk");
  assert.equal(contract.identity.version, "2.3.4");
  assert.equal(contract.surfaces[0].surfaceRef, "dist/host.d.ts#registerCommand");
});

test("local-path：无 user 登记事件 → 拒绝（designer/builder 填写的路径不生成 resolved）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(LOCAL_CONTRACT, fx.localSdk)]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /必须经 user 登记/);
});

test("local-path：登记路径与项目同属一个 git 仓库 → 拒绝（仓库身份覆盖全部 worktree）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(LOCAL_CONTRACT, join(fx.gitProj, "sub-sdk"))]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-local", resolverKind: "local-path", locator: join(fx.gitProj, "sub-sdk"), snapshotSha256: null, summary: "x" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.gitProj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /同属一个 git 仓库/);
});

test("local-path：actor 非 user 的登记事件不采信", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(LOCAL_CONTRACT, fx.localSdk)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "builder", contractId: "EC-local", resolverKind: "local-path", locator: fx.localSdk, snapshotSha256: null, summary: "builder 自填" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /必须经 user 登记/);
});

test("executable：user 登记绝对路径 → resolved（版本自报 + 内容哈希）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(EXEC_CONTRACT, null, fx.fakebin)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-bin", resolverKind: "executable", locator: fx.fakebin, snapshotSha256: null, summary: "厂商提供的官方二进制" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  const contract = summary.contracts.find((entry) => entry.id === "EC-bin");
  assert.equal(contract.status, "resolved");
  assert.equal(contract.identity.name, "fakebin");
  assert.match(contract.identity.version, /9\.9\.9/);
});

test("executable：登记路径不存在 → 拒绝", (t) => {
  const fx = makeBase(t);
  const missing = join(fx.base, "sdk", "no-such-bin");
  writeAcceptance(fx.taskDir, [substitute(EXEC_CONTRACT, null, missing)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-bin", resolverKind: "executable", locator: missing, snapshotSha256: null, summary: "x" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /不存在或不是文件/);
});

test("declared-unavailable：只生成 open 基础事实，不伪造 resolved", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [{ id: "EC-none", essential: false, authorityRequest: { resolverKind: "declared-unavailable", locator: null }, capabilities: [] }]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  const contract = summary.contracts.find((entry) => entry.id === "EC-none");
  assert.equal(contract.status, "declared-unavailable");
  assert.equal(contract.authorityAggregateHash, null);
  assert.deepEqual(contract.surfaces, []);
  assert.equal(contract.identity, null);
});

test("不支持的 resolverKind → unresolved（停回人工，不猜测）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [{ id: "EC-odd", essential: true, authorityRequest: { resolverKind: "magic-resolver", locator: "x" }, capabilities: [] }]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.match(summary.unresolvedContracts[0].reason, /不支持的 resolverKind/);
});

test("空 externalContracts → 空快照有稳定身份", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, []);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.deepEqual(summary.contracts, []);
  const expected = createHash("sha256").update("[]").digest("hex");
  assert.equal(summary.snapshotSha256, expected, "空快照身份 = 规范空数组的 sha256");
});

test("--contract-id：过滤生效；未知 id → 用法错误 exit 2", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT, substitute(LOCAL_CONTRACT, fx.localSdk)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-local", resolverKind: "local-path", locator: fx.localSdk, snapshotSha256: null, summary: "x" },
  ]);
  const filtered = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--contract-id", "EC-local"]));
  assert.deepEqual(filtered.contracts.map((entry) => entry.id), ["EC-local"]);
  const unknown = runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--contract-id", "EC-missing"]);
  assert.equal(unknown.status, 2, "未知 contract-id = 用法错误");
  assert.match(unknown.stderr, /不在验收包 externalContracts 中/);
});

test("快照稳定性：同内容二次解析同 snapshotSha256、快照文件不重复生成；surface 变化 → 哈希变化", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const first = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const contractsDir = join(fx.taskDir, "environment-contracts");
  const snapshotsAfterFirst = readdirSync(contractsDir).filter((name) => name.endsWith(".json") && name !== "environment-contracts.current.json").sort();
  assert.equal(snapshotsAfterFirst.length, 1);
  const second = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  assert.equal(second.snapshotSha256, first.snapshotSha256, "同一权威内容重复解析应得同一快照哈希");
  const snapshotsAfterSecond = readdirSync(contractsDir).filter((name) => name.endsWith(".json") && name !== "environment-contracts.current.json").sort();
  assert.deepEqual(snapshotsAfterSecond, snapshotsAfterFirst, "同哈希不生成新快照文件");
  // surface 内容变化：聚合哈希与快照哈希都必须变化（环境身份不虚报）
  write(join(fx.proj, "node_modules", "fake-host-sdk", "dist", "types.d.ts"), "export interface ToolDefinition { name: string; extra: boolean }\n");
  const third = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  assert.notEqual(third.snapshotSha256, first.snapshotSha256, "surface 内容变化必须产生新快照哈希");
  const contract = third.contracts.find((entry) => entry.id === "EC-npm");
  const firstContract = first.contracts.find((entry) => entry.id === "EC-npm");
  assert.notEqual(contract.authorityAggregateHash, firstContract.authorityAggregateHash);
  const snapshotsAfterThird = readdirSync(contractsDir).filter((name) => name.endsWith(".json") && name !== "environment-contracts.current.json").sort();
  assert.equal(snapshotsAfterThird.length, 2, "新环境生成新哈希文件，旧快照不覆盖");
});

test("输出摘要字段名对账：契约级 authorityAggregateHash + 顶层 snapshotSha256", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const run = runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]);
  assert.equal(run.status, 0);
  const summary = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(summary).sort(), ["contracts", "schemaVersion", "snapshotSha256", "unresolvedContracts"]);
  const contract = summary.contracts[0];
  assert.ok(Object.hasOwn(contract, "authorityAggregateHash"), "契约级哈希字段名必须是 authorityAggregateHash（下游 gate 消费名）");
  assert.ok(Object.hasOwn(contract, "identity"));
  assert.ok(Object.hasOwn(contract, "surfaces"));
  assert.ok(Object.hasOwn(contract, "status"));
  assert.ok(!Object.hasOwn(contract, "snapshotSha256"), "契约级不带顶层快照哈希");
  assert.match(summary.snapshotSha256, /^[0-9a-f]{64}$/);
  // 退出码与错误三段式
  const bad = runResolve(fx.home, ["--task-dir", join(fx.base, "no-task"), "--project-root", fx.proj]);
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /运行错误/);
  assert.match(bad.stderr, /权威源/);
  assert.match(bad.stderr, /恢复动作/);
});
