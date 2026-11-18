// external-contract-resolve-v6.test.mjs —— 外部契约权威解析与环境快照独立局部测试
//
// 被测实现：skills/self/dev-workflow/delivery-v6/scripts/resolve-external-contracts.mjs
//（设计《V6 运行可用性与外部契约守门升级》§4.3/§4.4：四类 resolver、信任规则、
// 按哈希分文件快照与 current 指针）。
//
// 覆盖：
//   1. installed-npm-package：lockfile 完整性 + npm 包缓存互核通过 → resolved + surfaces 哈希
//      （surface 哈希来自缓存 tarball 内容，§4.4 规则 2：node_modules 只作定位线索）
//   2. 信任规则拒绝路径：lockfile 版本不一致 / 缓存缺失（离线 fail-closed）/ 项目内自造包无
//      lockfile 记录 / 篡改 node_modules surface 文件（与 tarball 内容对账拒绝）/ tarball 内
//      找不到 surfaceRef（fail-closed，恢复动作含重装依赖或修正 surfaceRef）
//   3. local-path：user 登记 + 独立目录 → resolved；无登记事件 → 拒绝；同 git 仓库（含 worktree）→ 拒绝
//   4. executable：user 登记绝对路径 + which 印证 + 版本自报 + 内容哈希；登记路径不存在 → 拒绝；
//      超哈希上限的降级形态 → observedOutput（可复现观察输出，§4.4 规则 5）随快照落盘，
//      版本自报失败 → observedOutput 记 null 并在 hashNote 说明
//   5. declared-unavailable：不伪造 resolved，authorityAggregateHash 为 null
//   6. 不支持的 resolverKind → unresolved（停回，不猜测）
//   7. --contract-id 过滤与未知 id 用法错误
//   8. actor 非 user 的 ExternalAuthorityDeclared 不采信
//   9. 空 externalContracts → 空快照有稳定身份
//  10. 快照稳定性：同内容二次解析同 snapshotSha256、快照文件不重复生成、current 指针更新；
//      权威 tarball 升级（tarball + lockfile + node_modules 同步更新）→ snapshot 哈希变化
//  11. 输出摘要字段名对账：契约级 authorityAggregateHash + 顶层 snapshotSha256
//  12. 快照防篡改：落盘快照 0444 只读；在盘快照内容与文件名哈希不一致 → 报错退出非零，
//      恢复动作「删除该文件后重跑 resolve --write」（§4.4 规则 7）
//
// fixture 一律临时目录构造、用完即删（npm 缓存 / 假包 / 事件文件全部自造，不依赖真实全局安装）；
// HOME 重定向到临时目录隔离 npm 缓存读取。npm 缓存种真实形态的 gzipped ustar tarball
//（实测 npm registry 包 tarball 形态：gzip 魔数 + ustar magic + package/ 根前缀），resolver 的
// 权威内容源就是缓存 tarball 本体，fixture 不用真实 tar 就进不了解析路径。
// git fixture 参照 commit-scope-v6.test.mjs 的 git init 最小构造模式。
//
// 运行：node --test scripts/tests/external-contract-resolve-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "resolve-external-contracts.mjs");

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** 手写最小 ustar 头（512 字节）：fixture 不引第三方 tar 依赖，字段布局照 POSIX ustar */
function ustarHeader(entryName, size) {
  const header = Buffer.alloc(512);
  header.write(entryName, 0, 100, "utf8"); // name
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size（八进制）
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write("        ", 148, "utf8"); // chksum 占位 8 空格
  header.write("0", 156, "utf8"); // typeflag：普通文件
  header.write("ustar\0", 257, "utf8"); // magic
  header.write("00", 263, "utf8"); // version
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8"); // chksum：6 位八进制 + \0 + 空格
  return header;
}

/** 构造 npm registry 同形态的包 tarball（gzipped ustar，条目带 package/ 根前缀；
 * manifest + files 即包内容） */
function buildPackageTarball(name, version, files) {
  const manifest = `${JSON.stringify({ name, version, main: "dist/index.js" }, null, 2)}\n`;
  const entries = [
    { name: "package/package.json", content: Buffer.from(manifest) },
    ...Object.entries(files).map(([rel, content]) => ({ name: `package/${rel}`, content: Buffer.from(content) })),
  ];
  const blocks = [];
  for (const entry of entries) {
    blocks.push(ustarHeader(entry.name, entry.content.length), entry.content, Buffer.alloc((512 - (entry.content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // tar 结束双零块
  return gzipSync(Buffer.concat(blocks));
}

/** 把 tarball 字节写进 HOME 下的 npm cacache（与真实缓存同形态：内容文件 = tarball 本体），
 * 返回 lockfile 用的 integrity 串 */
function plantNpmCache(home, tarball) {
  const digest = createHash("sha512").update(tarball).digest();
  const hex = digest.toString("hex");
  const dir = join(home, ".npm", "_cacache", "content-v2", "sha512", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex.slice(2)), tarball);
  return `sha512-${digest.toString("base64")}`;
}

function runResolve(home, args) {
  // 夹具隔离：剥掉 npm 上下文注入的 npm_*（同 external-contract-resolve-integrity-v6 的坑）
  const env = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("npm_")) delete env[key];
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function parseSummary(run) {
  assert.equal(run.status, 0, `解析应成功：${run.stderr}`);
  return JSON.parse(run.stdout);
}

// 正常安装形态的包内容：node_modules 解包副本与缓存 tarball 条目共用这一份事实源
//（两者不一致 = 缺陷用例的篡改/损坏形态）
const SURFACE_FILES = {
  "dist/types.d.ts": "export interface ToolDefinition { name: string }\n",
  "dist/index.js": "module.exports = {};\n",
};

function makeNpmProject(base, { name = "fake-host-sdk", version = "1.0.0", files = SURFACE_FILES } = {}) {
  const proj = join(base, "proj");
  write(join(proj, "package.json"), `${JSON.stringify({ name: "fixture-proj", version: "1.0.0", dependencies: { [name]: "^1.0.0" } }, null, 2)}\n`);
  const manifest = `${JSON.stringify({ name, version, main: "dist/index.js" }, null, 2)}\n`;
  write(join(proj, "node_modules", name, "package.json"), manifest);
  for (const [rel, content] of Object.entries(files)) {
    write(join(proj, "node_modules", name, rel), content);
  }
  const integrity = plantNpmCache(join(base, "home"), buildPackageTarball(name, version, files));
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

// git 仓模板（同仓库拒绝用例的 worktree 身份覆盖 fixture）：每测试进程只构建一次，
// fixture 经 cpSync 复制实例化，省掉每 fixture 的 git init spawn
let repoTemplateDir = null;
function materializeRepoTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "ec-resolve-tpl-"));
  mkdirSync(join(dir, "sub-sdk"), { recursive: true });
  write(join(dir, "sub-sdk", "package.json"), `${JSON.stringify({ name: "sub-sdk", version: "1.0.0" }, null, 2)}\n`);
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(gitInit.status, 0, "git init 失败");
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
  if (repoTemplateDir === null) repoTemplateDir = materializeRepoTemplate();
  cpSync(repoTemplateDir, gitProj, { recursive: true });
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
  // surface 哈希来源对账：必须等于缓存 tarball 内条目的内容哈希（§4.4 规则 2 权威内容源）
  assert.equal(
    contract.surfaces.find((surface) => surface.surfaceRef === "dist/types.d.ts#ToolDefinition").sha256,
    createHash("sha256").update(SURFACE_FILES["dist/types.d.ts"]).digest("hex"),
    "surface 哈希必须来自缓存 tarball 内容",
  );
  // 落盘：按哈希分文件快照 + current 指针 + surface 只读副本
  const contractsDir = join(fx.taskDir, "environment-contracts");
  const snapshotPath = join(contractsDir, `${summary.snapshotSha256}.json`);
  assert.ok(existsSync(snapshotPath), "快照文件应按 snapshotSha256 命名落盘");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.snapshotSha256, summary.snapshotSha256);
  assert.equal(snapshot.contracts[0].resolver.resolution, "project-dependency");
  // 快照文件本身也是只读件（§4.4 规则 6：taskDir 权威快照对 builder 只读）
  assert.equal(statSync(snapshotPath).mode & 0o777, 0o444, "快照文件应为只读形态（0444）");
  // current 指针落 taskDir 根（2026-11-18 审查修复 P0-1：resolver 与全部消费端对齐设计 §4.3 的根路径；
  // 旧嵌套布局仅由 readCurrentPointer 兼容读，不产生新文件）
  const pointer = JSON.parse(readFileSync(join(fx.taskDir, "environment-contracts.current.json"), "utf8"));
  assert.equal(pointer.snapshotSha256, summary.snapshotSha256);
  const copy = join(contractsDir, "surfaces", summary.snapshotSha256, "EC-npm", "dist", "types.d.ts");
  assert.ok(existsSync(copy), "surface 只读副本应复制进 taskDir");
  assert.equal((statSync(copy).mode & 0o444) === 0o444, true, "副本应为只读形态（0444）");
  assert.equal(
    createHash("sha256").update(readFileSync(copy)).digest("hex"),
    createHash("sha256").update(Buffer.from(SURFACE_FILES["dist/types.d.ts"])).digest("hex"),
    "副本内容应与权威 tarball 条目一致",
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

test("信任规则：安装后篡改 node_modules surface 文件 → unresolved（integrity 只证 tarball 未变）", (t) => {
  const fx = makeBase(t);
  // 缓存与 lockfile 保持一致，只改 node_modules 解包文件：对照修复前行为（篡改内容被
  // 哈希进权威快照闭环通过），修复后必须在对账处拒绝
  write(join(fx.proj, "node_modules", "fake-host-sdk", "dist", "types.d.ts"), "export interface ToolDefinition { name: string; evil: true }\n");
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0, "篡改件不得进入权威快照");
  assert.equal(summary.unresolvedContracts.length, 1);
  assert.match(summary.unresolvedContracts[0].reason, /与官方 tarball 内容不一致/);
  assert.match(summary.unresolvedContracts[0].reason, /重装依赖/, "恢复动作必须指向重装依赖");
});

test("信任规则：tarball 内找不到 surfaceRef → fail-closed（恢复动作含修正 surfaceRef）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [
    {
      ...NPM_CONTRACT,
      capabilities: [{ id: "c1", minEnvironment: "official-runner", observable: "x", surfaceRefs: ["dist/no-such-file.d.ts"], detectionClasses: ["register-tool"] }],
    },
  ]);
  writeEvents(fx.taskDir, []);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj]));
  assert.equal(summary.contracts.length, 0);
  assert.match(summary.unresolvedContracts[0].reason, /找不到 surface 文件/);
  assert.match(summary.unresolvedContracts[0].reason, /修正 acceptance 的 surfaceRef/, "恢复动作必须含修正 surfaceRef 选项");
});

test("快照防篡改：在盘快照内容与文件名哈希不一致 → 报错退出非零（恢复动作删除后重跑）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  const first = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const snapshotPath = join(fx.taskDir, "environment-contracts", `${first.snapshotSha256}.json`);
  // 篡改者先解除只读（有 taskDir 写权限的进程可做到），改稳定事实后原样留回——
  // 修复前：同哈希文件名下篡改件被静默跳过采信；修复后：对账失败退出非零
  chmodSync(snapshotPath, 0o644);
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  onDisk.contracts[0].surfaces[0].sha256 = "f".repeat(64);
  writeFileSync(snapshotPath, `${JSON.stringify(onDisk, null, 2)}\n`);
  const rerun = runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]);
  assert.equal(rerun.status, 3, "篡改件必须报错退出非零，不得静默采信");
  assert.match(rerun.stderr, /内容与文件名哈希不一致/);
  assert.match(rerun.stderr, /删除该文件后重跑 resolve --write/);
});

test("快照防篡改：在盘快照只改 resolvedAt（非稳定事实）→ 对账通过不误报", (t) => {
  // resolvedAt 是本机观测信息、不参与快照身份（§4.3）；对账口径排除它，否则重复解析
  // 时间戳漂移会被误判成篡改
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [NPM_CONTRACT]);
  writeEvents(fx.taskDir, []);
  parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const snapshotPath = join(fx.taskDir, "environment-contracts", `${parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj])).snapshotSha256}.json`);
  chmodSync(snapshotPath, 0o644);
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  onDisk.contracts[0].resolvedAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(snapshotPath, `${JSON.stringify(onDisk, null, 2)}\n`);
  const rerun = runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]);
  assert.equal(rerun.status, 0, `仅观测信息变化不应对账失败：${rerun.stderr}`);
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

test("executable：user 登记绝对路径 → resolved（版本自报 + 内容哈希 + 观察输出）", (t) => {
  const fx = makeBase(t);
  writeAcceptance(fx.taskDir, [substitute(EXEC_CONTRACT, null, fx.fakebin)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-bin", resolverKind: "executable", locator: fx.fakebin, snapshotSha256: null, summary: "厂商提供的官方二进制" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const contract = summary.contracts.find((entry) => entry.id === "EC-bin");
  assert.equal(contract.status, "resolved");
  assert.equal(contract.identity.name, "fakebin");
  assert.match(contract.identity.version, /9\.9\.9/);
  // 可哈希形态：内容哈希在场 + 观察输出随快照落盘（§4.4 规则 5）
  const snapshotPath = join(fx.taskDir, "environment-contracts", `${summary.snapshotSha256}.json`);
  const recorded = JSON.parse(readFileSync(snapshotPath, "utf8")).contracts.find((entry) => entry.id === "EC-bin").executable;
  assert.match(recorded.sha256, /^[0-9a-f]{64}$/);
  assert.equal(recorded.observedOutput, "fakebin 9.9.9", "观察输出 = --version 的一行 stdout");
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

test("executable 降级：超过哈希上限 → sha 记 null，observedOutput 随快照落盘", (t) => {
  const fx = makeBase(t);
  // 名义大小超过 EXECUTABLE_MAX_HASH_BYTES（256MB）的动态 bundle：truncate 造 sparse 文件
  //（名义 300MB、实际磁盘占用数 KB）；脚本头保持可执行，sh 对尾部填充零字节仍正常解析
  const bigbin = join(fx.base, "sdk", "bigbin");
  write(bigbin, "#!/bin/sh\necho \"fakebin 9.9.9\"\n");
  spawnSync("chmod", ["+x", bigbin]);
  truncateSync(bigbin, 300 * 1024 * 1024);
  assert.ok(statSync(bigbin).size > 256 * 1024 * 1024, "fixture 前提：名义大小超过哈希上限");
  writeAcceptance(fx.taskDir, [substitute(EXEC_CONTRACT, null, bigbin)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-bin", resolverKind: "executable", locator: bigbin, snapshotSha256: null, summary: "x" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const snapshotPath = join(fx.taskDir, "environment-contracts", `${summary.snapshotSha256}.json`);
  const recorded = JSON.parse(readFileSync(snapshotPath, "utf8")).contracts.find((entry) => entry.id === "EC-bin").executable;
  assert.equal(recorded.sha256, null, "超过上限不读全量哈希（降级形态）");
  assert.match(recorded.hashNote, /字节/);
  assert.equal(recorded.observedOutput, "fakebin 9.9.9", "降级形态必须登记一个可复现观察输出（§4.4 规则 5）");
});

test("executable 降级：版本自报失败 → observedOutput 记 null 并在 hashNote 说明", (t) => {
  const fx = makeBase(t);
  const broken = join(fx.base, "sdk", "brokenbin");
  write(broken, "#!/bin/sh\necho boom >&2\nexit 3\n");
  spawnSync("chmod", ["+x", broken]);
  truncateSync(broken, 300 * 1024 * 1024); // 同时处于降级形态（超哈希上限）
  writeAcceptance(fx.taskDir, [substitute(EXEC_CONTRACT, null, broken)]);
  writeEvents(fx.taskDir, [
    { type: "ExternalAuthorityDeclared", actor: "user", contractId: "EC-bin", resolverKind: "executable", locator: broken, snapshotSha256: null, summary: "x" },
  ]);
  const summary = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  const snapshotPath = join(fx.taskDir, "environment-contracts", `${summary.snapshotSha256}.json`);
  const recorded = JSON.parse(readFileSync(snapshotPath, "utf8")).contracts.find((entry) => entry.id === "EC-bin").executable;
  assert.equal(recorded.observedOutput, null, "版本自报失败不得伪造观察输出");
  assert.match(recorded.hashNote, /无可复现观察输出/, "执行失败必须在 hashNote 说明");
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

test("快照稳定性：同内容二次解析同 snapshotSha256、快照文件不重复生成；权威升级 → 哈希变化", (t) => {
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
  // 权威变化：模拟官方发布新内容（缓存 tarball、lockfile integrity、node_modules 解包副本
  // 三者同步更新——只改 node_modules 是篡改形态，由专门用例覆盖为 unresolved）
  const upgradedFiles = { ...SURFACE_FILES, "dist/types.d.ts": "export interface ToolDefinition { name: string; extra: boolean }\n" };
  write(join(fx.proj, "node_modules", "fake-host-sdk", "dist", "types.d.ts"), upgradedFiles["dist/types.d.ts"]);
  const lock = JSON.parse(readFileSync(join(fx.proj, "package-lock.json"), "utf8"));
  lock.packages["node_modules/fake-host-sdk"].integrity = plantNpmCache(fx.home, buildPackageTarball("fake-host-sdk", "1.0.0", upgradedFiles));
  write(join(fx.proj, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const third = parseSummary(runResolve(fx.home, ["--task-dir", fx.taskDir, "--project-root", fx.proj, "--write"]));
  assert.notEqual(third.snapshotSha256, first.snapshotSha256, "权威 surface 内容变化必须产生新快照哈希");
  const contract = third.contracts.find((entry) => entry.id === "EC-npm");
  const firstContract = first.contracts.find((entry) => entry.id === "EC-npm");
  assert.notEqual(contract.authorityAggregateHash, firstContract.authorityAggregateHash);
  assert.equal(
    contract.surfaces.find((surface) => surface.surfaceRef === "dist/types.d.ts#ToolDefinition").sha256,
    createHash("sha256").update(upgradedFiles["dist/types.d.ts"]).digest("hex"),
    "新快照的 surface 哈希来自新 tarball 内容",
  );
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
