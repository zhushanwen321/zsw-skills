#!/usr/bin/env node
// resolve-external-contracts.mjs —— 外部契约权威工件解析与环境契约快照（设计《V6 运行可用性与外部契约守门升级》§4.3/§4.4）
//
// 为什么有本脚本：外部契约（宿主 API、官方 SDK、CLI 插件接口）的权威工件此前没有机器
// 解析通道，「以 SDK 为准」式文字自我证明可以一路走到 accepted。本脚本按验收包
// externalContracts[].authorityRequest 独立解析权威工件，生成按哈希分文件、不覆盖旧
// 快照的环境契约快照；evaluate 前的权威重解析与 sourceHash 核对都以它为准。
//
// 信任规则（§4.4，实现要点）：
//   1. 项目外权威来源优先：全局 npm root、pnpm store 直接采信（登记版本与真实路径）；
//   2. 项目内 node_modules 只能作为线索：必须经 lockfile 完整性哈希 + 包缓存（npm cacache）
//      元数据互核后才作为只读快照复制进 taskDir，三者不一致拒绝；
//   3. local-path 与 executable 权威必须用 user 凭据登记的 ExternalAuthorityDeclared 事件
//      认可；local-path 按 git 仓库身份覆盖全部 worktree，路径位于同仓库可写范围内即拒绝；
//   4. resolver 只读文件与计算哈希，绝不执行外部包安装脚本；唯一的子进程执行是
//      `npm root -g` / `pnpm root -g` 查询、`which` 查询与 executable 的 `--version` 版本自报；
//   5. 离线 fail-closed：registry / 包缓存不可达时，不把项目内可变副本当 resolved——只能
//      使用 user 登记的本地权威，或把契约保持 declared-unavailable / unresolved。
//
// 用法：
//   node resolve-external-contracts.mjs --task-dir <绝对路径> --project-root <绝对路径>
//     [--acceptance-file <路径>] [--write] [--contract-id <id>]
//     stdout 输出 JSON 摘要（单一对象）；--write 时落盘快照与 surface 只读副本。
//
// 输出摘要（stdout，schemaVersion 1）：
//   {
//     "schemaVersion": 1,
//     "contracts": [
//       { "id": "EC-...", "status": "resolved|unresolved|declared-unavailable",
//         "authorityAggregateHash": "<契约级 surface 聚合哈希|null>",
//         "identity": { "name": "...", "version": "..." } | null,
//         "surfaces": [ { "surfaceRef": "...", "sha256": "..." } ] }
//     ],
//     "snapshotSha256": "<快照稳定身份哈希>",
//     "unresolvedContracts": [ { "contractId": "...", "reason": "..." } ]
//   }
//   契约级哈希字段名 authorityAggregateHash 是下游 gate 的固定消费名；顶层 snapshotSha256
//   是快照身份（只对 contracts 的稳定解析事实做规范哈希，resolvedAt / resolvedPath 不参与）。
//
// 快照产物（--write 时）：
//   taskDir/environment-contracts/<snapshotSha256>.json   按哈希分文件，不覆盖旧快照
//   taskDir/environment-contracts.current.json             派生指针（可重建），落任务目录根
//   taskDir/environment-contracts/surfaces/<snapshotSha256>/<contractId>/<surface 相对路径>
//                                                          权威 surface 文件的只读副本（chmod 0444）
//
// 指针布局：current 指针在任务目录根，快照文件在 environment-contracts/ 子目录——全部消费端
// （delivery-gate 指针回落、dev-flow D0 编译门、tech-design/tech-review/dev-consistency 各线）
// 都读根路径；升级前曾把指针写进子目录，readCurrentPointer 兼容读旧形态（见该函数注）。
//
// 事件读取通道：直接读 taskDir/events.jsonl，逐行 JSON 解析后过滤 type=ExternalAuthorityDeclared
// 且 actor=user 的记录（不 import delivery-gate，避免与内核线并行改动的耦合）。密码学验签由
// gate 的事件加载通道统一承担（parseEventRecords 对每条事件 ed25519 验签）；本脚本是只读
// 筛选消费者，做结构校验（type/actor/contractId/resolverKind/locator 存在）后采信登记内容。
//
// 退出码：0 成功（含契约为空或 unresolved——unresolved 是合法摘要内容，不是失败）；
// 2 用法错误；3 运行错误（路径缺失、输入文件损坏、外部查询命令失败等）。

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = { PASS: 0, USAGE: 2, ERROR: 3 };
const SCHEMA_VERSION = 1;
const SNAPSHOT_SCHEMA_VERSION = 1;
const CONTRACTS_DIRNAME = "environment-contracts";
const CURRENT_POINTER_FILENAME = "environment-contracts.current.json";
const SPAWN_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 20_000;
// executable 可哈希上限：超过该大小的动态 bundle 不读全量哈希，退化为「版本自报 +
// 路径与大小登记」（§4.4 规则 5 的降级形态，快照里 hash 记 null 并附理由）
const EXECUTABLE_MAX_HASH_BYTES = 256 * 1024 * 1024;

const RESOLVER_KINDS = new Set(["installed-npm-package", "executable", "local-path", "declared-unavailable"]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

/** 规范 JSON：键排序、无空白——与 delivery-gate canonicalJson 同口径（快照身份跨工具可比） */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function usage() {
  return [
    "用法：node resolve-external-contracts.mjs --task-dir <绝对路径> --project-root <绝对路径> [--acceptance-file <路径>] [--write] [--contract-id <id>]",
    "",
    "  --task-dir        任务目录绝对路径（events.jsonl 与缺省验收包所在目录）",
    "  --project-root    项目根（或 worktree 根）绝对路径；node_modules 与 lockfile 解析基准",
    "  --acceptance-file 验收包路径（缺省 = <task-dir>/acceptance.json）",
    "  --write           落盘：environment-contracts/<snapshotSha256>.json + current 指针（任务目录根 environment-contracts.current.json）+ surface 只读副本",
    "  --contract-id     只解析指定契约（缺省全部；可重复传入多个）",
    "",
    "stdout 输出 JSON 摘要（contracts / snapshotSha256 / unresolvedContracts）；",
    "进度与警告走 stderr。resolver 只读文件与计算哈希，不执行外部包安装脚本。",
    "",
    "退出码：0 成功（unresolved 是合法摘要内容）；2 用法错误；3 运行错误。",
  ].join("\n");
}

function failUsage(message) {
  console.error(`用法错误：${message}`);
  console.error("权威源：node resolve-external-contracts.mjs --help（信任规则、resolver 形态与快照结构）");
  console.error("恢复动作：node resolve-external-contracts.mjs --task-dir <绝对路径> --project-root <绝对路径> [--write]");
  process.exit(EXIT.USAGE);
}

function failRun(message, recover) {
  console.error(`运行错误：${message}`);
  console.error("权威源：node resolve-external-contracts.mjs --help");
  console.error(`恢复动作：${recover}`);
  process.exit(EXIT.ERROR);
}

function parseArgs(argv) {
  const opts = { taskDir: null, projectRoot: null, acceptanceFile: null, write: false, contractIds: [] };
  const readValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined) failUsage(`参数 ${flag} 缺取值（悬空 flag）；--help 查看完整用法`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--task-dir") { opts.taskDir = readValue("--task-dir", index); index += 1; }
    else if (arg === "--project-root") { opts.projectRoot = readValue("--project-root", index); index += 1; }
    else if (arg === "--acceptance-file") { opts.acceptanceFile = readValue("--acceptance-file", index); index += 1; }
    else if (arg === "--write") opts.write = true;
    else if (arg === "--contract-id") { opts.contractIds.push(readValue("--contract-id", index)); index += 1; }
    else if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(EXIT.PASS); }
    else failUsage(`未知参数「${arg ?? ""}」（--help 查看完整用法）`);
  }
  if (!opts.taskDir) failUsage("缺必填参数 --task-dir");
  if (!opts.projectRoot) failUsage("缺必填参数 --project-root");
  for (const [flag, value] of [["--task-dir", opts.taskDir], ["--project-root", opts.projectRoot]]) {
    if (!isAbsolute(value)) failUsage(`${flag} 须为绝对路径，收到「${value}」（相对路径随调用方 cwd 漂移，解析失去基准）`);
  }
  if (opts.acceptanceFile && !isAbsolute(opts.acceptanceFile)) failUsage(`--acceptance-file 须为绝对路径，收到「${opts.acceptanceFile}」`);
  for (const dir of [opts.taskDir, opts.projectRoot]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      failRun(`路径不存在或不是目录（${dir}）`, "核对路径拼写（含 worktree 是否已被删除）后重跑");
    }
  }
  if (opts.acceptanceFile && (!existsSync(opts.acceptanceFile) || !statSync(opts.acceptanceFile).isFile())) {
    failRun(`--acceptance-file 不存在或不是文件（${opts.acceptanceFile}）`, "核对验收包路径；缺省形态是 <task-dir>/acceptance.json");
  }
  return {
    taskDir: realpathSync(opts.taskDir),
    projectRoot: realpathSync(opts.projectRoot),
    acceptanceFile: opts.acceptanceFile ? realpathSync(opts.acceptanceFile) : join(realpathSync(opts.taskDir), "acceptance.json"),
    write: opts.write,
    contractIds: opts.contractIds,
  };
}

// ---------------------------------------------------------------------------
// 输入：验收包 externalContracts
// ---------------------------------------------------------------------------

function loadAcceptanceContracts(acceptanceFile) {
  if (!existsSync(acceptanceFile)) {
    failRun(`验收包不存在（${acceptanceFile}）`, "先由 acceptance-design-v6 生成 acceptance.json，或用 --acceptance-file 显式指定路径后重跑");
  }
  let acceptance;
  try {
    acceptance = JSON.parse(readFileSync(acceptanceFile, "utf8"));
  } catch (error) {
    failRun(`验收包不是合法 JSON（${acceptanceFile}，${error.message}）`, "修复验收包 JSON 语法后重跑");
  }
  const contracts = acceptance?.externalContracts;
  if (contracts === undefined || contracts === null) return [];
  if (!Array.isArray(contracts)) {
    failRun(`acceptance.externalContracts 存在但不是数组（${acceptanceFile}）`, "把 externalContracts 改为数组（无外部契约时缺省该字段或给空数组）后重跑");
  }
  return contracts;
}

// ---------------------------------------------------------------------------
// 输入：taskDir 事件流中 user 登记的 ExternalAuthorityDeclared（读取通道见文件头注）
// ---------------------------------------------------------------------------

function loadAuthorityDeclarations(taskDir) {
  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    failRun(`事件流不存在（${eventsPath}）`, "运行 delivery-gate init 创建任务目录结构（含空 events.jsonl）后重跑");
  }
  const text = readFileSync(eventsPath, "utf8");
  const declarations = new Map(); // contractId -> 最新一条登记
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // 坏行跳过并向 stderr 出声：事件流的完整性校验是 gate 的职责（parseEventRecords
      // 逐行验签），本脚本只读筛选；静默跳过会让登记无声消失
      console.error(`WARN: events.jsonl 第 ${index + 1} 行不是合法 JSON，已跳过（完整性校验以 delivery-gate 为准）`);
      continue;
    }
    if (record?.type !== "ExternalAuthorityDeclared") continue;
    if (record.actor !== "user") {
      console.error(`WARN: ExternalAuthorityDeclared 事件 seq=${record.seq ?? "?"} 的 actor=${JSON.stringify(record.actor)} 不是 user，不采信（local-path / executable 权威必须 user 凭据登记）`);
      continue;
    }
    const contractId = record.contractId;
    const resolverKind = record.resolverKind;
    const locator = record.locator;
    if (typeof contractId !== "string" || contractId.trim() === "" || typeof resolverKind !== "string" || typeof locator !== "string" || locator.trim() === "") {
      console.error(`WARN: ExternalAuthorityDeclared 事件 seq=${record.seq ?? "?"} 缺 contractId / resolverKind / locator 字段，不采信`);
      continue;
    }
    declarations.set(contractId, { contractId, resolverKind, locator, snapshotSha256: record.snapshotSha256 ?? null, summary: record.summary ?? null, seq: record.seq ?? null });
  }
  return declarations;
}

// ---------------------------------------------------------------------------
// lockfile 解析：包名 -> { version, integrity }
// ---------------------------------------------------------------------------

function findLockfile(projectRoot) {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return { name, path };
  }
  return null;
}

function readLockfileEntry(projectRoot, packageName) {
  const lockfile = findLockfile(projectRoot);
  if (!lockfile) return null;
  const text = readFileSync(lockfile.path, "utf8");
  if (lockfile.name === "package-lock.json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const key = `node_modules/${packageName}`;
    const entry = parsed?.packages?.[key];
    if (!entry || typeof entry.version !== "string") return null;
    return { version: entry.version, integrity: typeof entry.integrity === "string" ? entry.integrity : null, lockfile: lockfile.name };
  }
  // pnpm-lock.yaml / yarn.lock：文本级解析 `<name>@<version>:` 段落内的 integrity
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`^\\s*['"]?${escaped}@([^:'"\\s]+)['"]?:\\s*$`, "m");
  const match = text.match(blockRe);
  if (!match) return null;
  const tail = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 2000);
  const integrityMatch = tail.match(/integrity\s*[:=]\s*['"]?(sha512-[A-Za-z0-9+/=]+)['"]?/);
  return {
    version: match[1],
    integrity: integrityMatch ? integrityMatch[1] : null,
    lockfile: lockfile.name,
  };
}

// ---------------------------------------------------------------------------
// 包缓存互核：lockfile integrity -> npm cacache content 地址 -> 重算 sha512 比对
// ---------------------------------------------------------------------------

function npmCacheDir() {
  const run = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (run.status !== 0) return null;
  const dir = String(run.stdout).trim();
  return dir === "" ? null : dir;
}

function verifyCacheIntegrity(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) return { ok: false, reason: "lockfile integrity 不是 sha512 形态，无法互核" };
  const cacheDir = npmCacheDir();
  if (!cacheDir) return { ok: false, reason: "npm 缓存目录不可用（npm config get cache 失败）——离线 fail-closed，不把项目内副本当 resolved" };
  const hex = Buffer.from(match[1], "base64").toString("hex");
  // npm v7+ 的 `npm config get cache` 返回缓存根（如 ~/.npm），cacache 内容在其下
  // _cacache/ 子目录；旧版本或自定义配置也可能直接指向 _cacache，两个候选都试
  const candidates = [join(cacheDir, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2)), join(cacheDir, "content-v2", "sha512", hex.slice(0, 2), hex.slice(2))];
  const contentPath = candidates.find((candidate) => existsSync(candidate));
  if (!contentPath) {
    return { ok: false, reason: `包缓存未命中（${candidates[0]} 不存在）——registry / 缓存不可达，离线 fail-closed` };
  }
  const actual = createHash("sha512").update(readFileSync(contentPath)).digest("base64");
  if (actual !== match[1]) {
    return { ok: false, reason: "包缓存内容与 lockfile integrity 不一致" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// resolver：installed-npm-package
// ---------------------------------------------------------------------------

function readPackageIdentity(pkgDir) {
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      name: typeof manifest.name === "string" ? manifest.name : basename(pkgDir),
      version: typeof manifest.version === "string" ? manifest.version : null,
    };
  } catch {
    return null;
  }
}

function globalRootOf(program) {
  const run = spawnSync(program, ["root", "-g"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (run.status !== 0 || run.error) return null;
  const root = String(run.stdout).trim();
  return root === "" ? null : root;
}

function resolveInstalledNpmPackage(projectRoot, locator) {
  const attempts = [];
  // 候选 1：项目依赖（线索，必须互核）
  const projectCandidate = join(projectRoot, "node_modules", locator);
  if (existsSync(projectCandidate) && statSync(projectCandidate).isDirectory()) {
    const identity = readPackageIdentity(projectCandidate);
    if (!identity) {
      attempts.push(`项目内 ${projectCandidate} 的 package.json 不可读，不能作为权威工件`);
    } else {
      const lock = readLockfileEntry(projectRoot, locator);
      if (!lock) {
        attempts.push(`项目内副本无 lockfile 记录（${locator}）——项目内 node_modules 只能作为线索，无完整性依据即拒绝`);
      } else if (identity.version !== lock.version) {
        attempts.push(`项目内副本版本 ${identity.version} 与 lockfile ${lock.version} 不一致，拒绝`);
      } else if (!lock.integrity) {
        attempts.push("lockfile 记录缺 integrity 完整性哈希，无法互核，拒绝");
      } else {
        const cache = verifyCacheIntegrity(lock.integrity);
        if (!cache.ok) {
          attempts.push(`项目内副本互核失败：${cache.reason}`);
        } else {
          return { ok: true, resolvedPath: projectCandidate, resolution: "project-dependency", identity, version: identity.version };
        }
      }
    }
  }
  // 候选 2/3：项目外权威来源（全局 npm root、pnpm store）——直接采信，登记版本与真实路径
  for (const [program, resolution] of [["npm", "npm-root-global"], ["pnpm", "pnpm-store"]]) {
    const root = globalRootOf(program);
    if (!root) {
      attempts.push(`${program} root -g 查询失败（命令不可用或输出为空），跳过该来源`);
      continue;
    }
    const candidate = join(root, locator);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) continue;
    const identity = readPackageIdentity(candidate);
    if (!identity) continue;
    // pnpm 全局目录通常是指向 store 的符号链接：登记穿透后的真实路径，快照身份才对得上
    return { ok: true, resolvedPath: realpathSync(candidate), resolution, identity, version: identity.version };
  }
  return { ok: false, reason: attempts.join("；") || `未在项目依赖、全局 npm root、pnpm store 中定位到 ${locator}` };
}

// ---------------------------------------------------------------------------
// resolver：executable（user 登记的绝对路径 + which 辅助印证 + 版本自报 + 可哈希则哈希）
// ---------------------------------------------------------------------------

function which(command) {
  const run = spawnSync("which", [command], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (run.status !== 0) return null;
  const first = String(run.stdout).split("\n").map((line) => line.trim()).find((line) => line !== "");
  return first ?? null;
}

function resolveExecutable(declaration) {
  if (!declaration) {
    return { ok: false, reason: "executable 权威必须经 user 登记的 ExternalAuthorityDeclared 事件认可（事件缺失）——不能只依赖会话 PATH 上的 which 结果" };
  }
  const declaredPath = declaration.locator;
  if (!isAbsolute(declaredPath)) {
    return { ok: false, reason: `ExternalAuthorityDeclared 登记的 executable locator 不是绝对路径（${declaredPath}）` };
  }
  if (!existsSync(declaredPath) || !statSync(declaredPath).isFile()) {
    return { ok: false, reason: `登记的 executable 路径不存在或不是文件（${declaredPath}）` };
  }
  // which 辅助印证：登记绝对路径与 PATH 解析结果互相印证（不一致仍以登记路径为准，
  // 但把分歧写入摘要理由之外不进快照——设计要求登记绝对路径而非只依赖 which）
  const command = basename(declaredPath);
  const whichPath = which(command);
  const declaredReal = realpathSync(declaredPath);
  const whichReal = whichPath && existsSync(whichPath) ? realpathSync(whichPath) : null;
  const versionRun = spawnSync(declaredReal, ["--version"], { encoding: "utf8", timeout: VERSION_PROBE_TIMEOUT_MS });
  const versionLine = String(versionRun.stdout || versionRun.stderr || "").split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (versionRun.error || versionRun.status !== 0) {
    // 版本自报失败：不可哈希/不可自报的形态按 §4.4 规则 5 退化处理，仍算 resolved
    //（真实路径与存在性已核实），version 记 null 并在 surfaces 之外不伪造观察输出
    console.error(`WARN: executable 版本自报失败（${declaredReal} --version exit ${versionRun.status ?? "?"}）：${String(versionRun.stderr || versionRun.error?.message || "").trim()}`);
  }
  let sha = null;
  let hashNote = null;
  try {
    const size = statSync(declaredReal).size;
    if (size > EXECUTABLE_MAX_HASH_BYTES) {
      hashNote = `文件超过 ${EXECUTABLE_MAX_HASH_BYTES} 字节，不读全量哈希（动态 bundle 退化形态）`;
    } else {
      sha = sha256File(declaredReal);
    }
  } catch (error) {
    hashNote = `文件不可读，无法哈希：${error.message}`;
  }
  return {
    ok: true,
    resolvedPath: declaredReal,
    resolution: "executable",
    identity: { name: command, version: versionLine ?? null },
    executable: { sha256: sha, hashNote, whichPath: whichReal, whichMatchesDeclaration: whichReal === declaredReal },
    version: versionLine ?? null,
  };
}

// ---------------------------------------------------------------------------
// resolver：local-path（user 登记 + git 仓库身份覆盖 worktree + 同仓库可写范围拒绝）
// ---------------------------------------------------------------------------

function gitCommonDir(dir) {
  const run = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (run.status !== 0) return null;
  const raw = String(run.stdout).trim();
  if (raw === "") return null;
  return isAbsolute(raw) ? realpathSync(raw) : realpathSync(resolve(dir, raw));
}

function resolveLocalPath(declaration, projectRoot) {
  if (!declaration) {
    return { ok: false, reason: "local-path 权威必须经 user 登记的 ExternalAuthorityDeclared 事件认可（事件缺失）——designer / builder 填写的本地路径不生成 resolved" };
  }
  const declaredPath = declaration.locator;
  if (!isAbsolute(declaredPath)) {
    return { ok: false, reason: `ExternalAuthorityDeclared 登记的 local-path locator 不是绝对路径（${declaredPath}）` };
  }
  if (!existsSync(declaredPath) || !statSync(declaredPath).isDirectory()) {
    return { ok: false, reason: `登记的 local-path 目录不存在或不是目录（${declaredPath}）` };
  }
  const authorityRoot = realpathSync(declaredPath);
  // git 仓库身份覆盖全部 worktree：登记路径与项目根同属一个 git 仓库（common dir 相同）
  // 即拒绝——项目工作区（含其全部 worktree）是可写范围，不能充当权威工件
  const declaredGit = gitCommonDir(authorityRoot);
  const projectGit = gitCommonDir(projectRoot);
  if (declaredGit && projectGit && declaredGit === projectGit) {
    return { ok: false, reason: `登记路径与项目同属一个 git 仓库（common dir ${declaredGit}）——同仓库可写范围（含全部 worktree）内的路径不能作为权威工件` };
  }
  // 项目根非 git 仓时的兜底：路径落在项目目录内即拒绝（可写范围）
  if (!projectGit) {
    const rel = relative(projectRoot, authorityRoot);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return { ok: false, reason: `登记路径位于项目目录内（${authorityRoot}）——项目工作区可写范围不能作为权威工件` };
    }
  }
  const identity = readPackageIdentity(authorityRoot);
  return { ok: true, resolvedPath: authorityRoot, resolution: "local-path", identity: identity ?? { name: basename(authorityRoot), version: null }, version: identity?.version ?? null };
}

// ---------------------------------------------------------------------------
// surface 处理：集合 = 全部 capability surfaceRefs 并集；# 符号部分只登记不哈希
// ---------------------------------------------------------------------------

function collectSurfaceRefs(contract) {
  const refs = new Set();
  for (const capability of Array.isArray(contract?.capabilities) ? contract.capabilities : []) {
    for (const ref of Array.isArray(capability?.surfaceRefs) ? capability.surfaceRefs : []) {
      if (typeof ref === "string" && ref.trim() !== "") refs.add(ref.trim());
    }
  }
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function splitSurfaceRef(ref) {
  const hash = ref.indexOf("#");
  if (hash < 0) return { file: ref, symbol: null };
  return { file: ref.slice(0, hash), symbol: ref.slice(hash + 1) };
}

/** 解析全部 surface 文件内容哈希；任一缺失即失败（fail-closed，不伪造 resolved） */
function resolveSurfaces(contract, authorityRoot) {
  const surfaces = [];
  const fileCache = new Map();
  for (const ref of collectSurfaceRefs(contract)) {
    const { file } = splitSurfaceRef(ref);
    if (fileCache.has(file)) {
      surfaces.push({ surfaceRef: ref, sha256: fileCache.get(file) });
      continue;
    }
    // surfaceRef 是相对权威根的文件路径：绝对形态或以 .. 逃逸权威根的形态一律拒绝
    // （防借 surfaceRef 把权威快照引到项目内可写文件上）
    if (isAbsolute(file) || file.split(/[/\\]/).includes("..")) {
      return { ok: false, reason: `surfaceRef「${ref}」不是权威根内的相对文件路径` };
    }
    const absPath = resolve(authorityRoot, file);
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      return { ok: false, reason: `surface 文件不存在（${ref} -> ${absPath}）` };
    }
    const sha = sha256File(absPath);
    fileCache.set(file, sha);
    surfaces.push({ surfaceRef: ref, sha256: sha });
  }
  return { ok: true, surfaces };
}

// ---------------------------------------------------------------------------
// 单契约解析
// ---------------------------------------------------------------------------

function resolveContract(contract, declarations) {
  const id = contract?.id;
  if (typeof id !== "string" || id.trim() === "") {
    return { fatal: `externalContracts 条目缺非空 id（${JSON.stringify(contract)?.slice(0, 120)}）` };
  }
  const request = contract.authorityRequest;
  if (!request || typeof request !== "object" || typeof request.resolverKind !== "string") {
    return { unresolved: { contractId: id, reason: "authorityRequest 缺失或形态非法（需 resolverKind 与 locator）" } };
  }
  const kind = request.resolverKind;
  if (!RESOLVER_KINDS.has(kind)) {
    return { unresolved: { contractId: id, reason: `不支持的 resolverKind「${kind}」（词表：${[...RESOLVER_KINDS].join(" / ")}）——停回人工，不猜测` } };
  }
  if (kind === "declared-unavailable") {
    return {
      contract: {
        id,
        status: "declared-unavailable",
        resolver: { kind, locator: request.locator ?? null, resolvedPath: null, resolution: "declared-unavailable" },
        identity: null,
        surfaces: [],
        aggregateHash: null,
        resolvedAt: null,
      },
    };
  }
  const declaration = declarations.get(id) ?? null;
  if (declaration && declaration.resolverKind !== kind) {
    return { unresolved: { contractId: id, reason: `ExternalAuthorityDeclared 登记的 resolverKind（${declaration.resolverKind}）与 authorityRequest（${kind}）不一致` } };
  }
  let resolution;
  if (kind === "installed-npm-package") {
    if (typeof request.locator !== "string" || request.locator.trim() === "") {
      return { unresolved: { contractId: id, reason: "installed-npm-package 的 authorityRequest.locator 缺失" } };
    }
    resolution = resolveInstalledNpmPackage(PROJECT_ROOT, request.locator);
  } else if (kind === "executable") {
    resolution = resolveExecutable(declaration);
  } else {
    resolution = resolveLocalPath(declaration, PROJECT_ROOT);
  }
  if (!resolution.ok) {
    return { unresolved: { contractId: id, reason: resolution.reason } };
  }
  const surfaceResult = resolveSurfaces(contract, resolution.resolvedPath);
  if (!surfaceResult.ok) {
    return { unresolved: { contractId: id, reason: surfaceResult.reason } };
  }
  const aggregateHash = sha256(canonicalJson(surfaceResult.surfaces));
  return {
    contract: {
      id,
      status: "resolved",
      resolver: { kind, locator: request.locator ?? null, resolvedPath: resolution.resolvedPath, resolution: resolution.resolution },
      identity: resolution.identity ?? null,
      surfaces: surfaceResult.surfaces,
      aggregateHash,
      resolvedAt: new Date().toISOString(),
      executable: resolution.executable ?? null,
    },
  };
}

let PROJECT_ROOT = null;

// ---------------------------------------------------------------------------
// 快照组装与落盘
// ---------------------------------------------------------------------------

function stableContractFacts(contract) {
  // snapshotSha256 只对稳定解析事实做规范哈希：resolvedAt / resolvedPath 是本机观测信息，
  // 不参与快照身份（§4.3）；executable 的 which/哈希注记同理不进稳定事实
  return {
    id: contract.id,
    status: contract.status,
    resolver: { kind: contract.resolver.kind, locator: contract.resolver.locator, resolution: contract.resolver.resolution },
    identity: contract.identity,
    surfaces: contract.surfaces,
    aggregateHash: contract.aggregateHash,
  };
}

function copySurfacesToTaskDir(taskDir, snapshotSha256, contracts) {
  const base = join(taskDir, CONTRACTS_DIRNAME, "surfaces", snapshotSha256);
  for (const contract of contracts) {
    if (contract.status !== "resolved") continue;
    for (const surface of contract.surfaces) {
      const { file } = splitSurfaceRef(surface.surfaceRef);
      const source = resolve(contract.resolver.resolvedPath, file);
      const target = join(base, contract.id.replace(/[^\w.-]/g, "_"), file);
      if (existsSync(target)) {
        // 幂等：快照按哈希分文件，同内容必同路径；副本已存在且哈希一致即跳过
        //（副本是 chmod 0444 只读件，重复 copyFileSync 会因目标不可写而失败）
        if (sha256File(target) !== sha256File(source)) {
          rmSync(base, { recursive: true, force: true });
          failRun(`surface 副本与源不一致（${surface.surfaceRef}）`, "重新运行 resolve --write 重建快照；不要手工修改副本");
        }
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      // 复制完整性校验：副本与源哈希不一致即拒绝（「快照哈希、lockfile 完整性、registry
      // 元数据三者不一致时拒绝」的第三核对点）
      if (sha256File(target) !== sha256File(source)) {
        rmSync(base, { recursive: true, force: true });
        failRun(`surface 副本与源不一致（${surface.surfaceRef}）`, "重新运行 resolve --write 重建快照；不要手工修改副本");
      }
      chmodSync(target, 0o444); // taskDir 权威快照对 builder 只读（§4.4 规则 6）
    }
  }
}

/** current 指针读取（旧任务目录兼容）：先看任务目录根（现行落点），再看
 * environment-contracts/ 内的历史嵌套形态（升级前 resolver 的落点）。指针损坏与缺失
 * 同等对待（返回 null）——恢复动作是重跑 --write 重建，不手工修复。 */
function readCurrentPointer(taskDir) {
  for (const candidate of [
    join(taskDir, CURRENT_POINTER_FILENAME),
    join(taskDir, CONTRACTS_DIRNAME, CURRENT_POINTER_FILENAME),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.snapshotSha256 === "string") {
        return { path: candidate, snapshotSha256: parsed.snapshotSha256 };
      }
    } catch {
      // 指针损坏：按缺失处理
    }
  }
  return null;
}

function writeSnapshot(taskDir, snapshot) {
  const dir = join(taskDir, CONTRACTS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, `${snapshot.snapshotSha256}.json`);
  if (!existsSync(snapshotPath)) {
    // 按哈希分文件、不覆盖旧快照；同一权威内容重复解析得到同一哈希时不生成新文件
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.error(`OK: 环境契约快照已写入 ${snapshotPath}`);
  } else {
    console.error(`OK: 环境契约快照已存在（同哈希不重复生成）：${snapshotPath}`);
  }
  // current 指针落任务目录根（设计 §4.3：taskDir/environment-contracts.current.json）——
  // 全部消费端（gate 指针回落、dev-flow D0 编译门、tech-design/tech-review/dev-consistency）
  // 都读根路径；快照文件仍在子目录（按哈希分文件），只有指针回根
  const previous = readCurrentPointer(taskDir); // 新指针尚未落盘：读到的是迁移前的指针
  const pointerPath = join(taskDir, CURRENT_POINTER_FILENAME);
  const pointer = {
    schemaVersion: SCHEMA_VERSION,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotPath: `${CONTRACTS_DIRNAME}/${snapshot.snapshotSha256}.json`,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  const transition = previous !== null && previous.snapshotSha256 !== snapshot.snapshotSha256
    ? `（原 ${previous.snapshotSha256.slice(0, 12)}…${previous.path === pointerPath ? "" : "，历史嵌套指针"} → 新 ${snapshot.snapshotSha256.slice(0, 12)}…）`
    : "";
  console.error(`OK: current 指针已更新 ${pointerPath}${transition}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  PROJECT_ROOT = opts.projectRoot;
  const declarations = loadAuthorityDeclarations(opts.taskDir);
  const acceptanceContracts = loadAcceptanceContracts(opts.acceptanceFile);

  const availableIds = acceptanceContracts.map((contract) => contract?.id).filter((id) => typeof id === "string");
  for (const requested of opts.contractIds) {
    if (!availableIds.includes(requested)) {
      failUsage(`--contract-id「${requested}」不在验收包 externalContracts 中（可用：${availableIds.join(" / ") || "（空）"}）`);
    }
  }
  const selected = opts.contractIds.length > 0
    ? acceptanceContracts.filter((contract) => opts.contractIds.includes(contract?.id))
    : acceptanceContracts;

  const resolvedContracts = [];
  const unresolvedContracts = [];
  for (const contract of selected) {
    const outcome = resolveContract(contract, declarations);
    if (outcome.fatal) failRun(`验收包 externalContracts 条目损坏：${outcome.fatal}`, "修复 acceptance.json 的 externalContracts 条目（每条需非空 id 与 authorityRequest）后重跑");
    if (outcome.unresolved) {
      unresolvedContracts.push(outcome.unresolved);
      continue;
    }
    resolvedContracts.push(outcome.contract);
  }

  // 排序固定：同输入两次解析的稳定事实逐字节一致（快照身份稳定的前提）
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const contracts = resolvedContracts.sort(byId);
  unresolvedContracts.sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
  const snapshotSha256 = sha256(canonicalJson(contracts.map(stableContractFacts)));

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    contracts: contracts.map((contract) => ({
      id: contract.id,
      status: contract.status,
      resolver: contract.resolver,
      identity: contract.identity,
      surfaces: contract.surfaces,
      aggregateHash: contract.aggregateHash,
      resolvedAt: contract.resolvedAt,
    })),
    snapshotSha256,
  };

  if (opts.write) {
    copySurfacesToTaskDir(opts.taskDir, snapshotSha256, contracts);
    writeSnapshot(opts.taskDir, snapshot);
  }

  const summary = {
    schemaVersion: SCHEMA_VERSION,
    contracts: contracts.map((contract) => ({
      id: contract.id,
      status: contract.status,
      authorityAggregateHash: contract.aggregateHash,
      identity: contract.identity,
      surfaces: contract.surfaces,
    })),
    snapshotSha256,
    unresolvedContracts,
  };
  console.log(JSON.stringify(summary, null, 2));
  const resolvedCount = contracts.filter((contract) => contract.status === "resolved").length;
  console.error(
    `OK: 解析完成（契约 ${contracts.length}：resolved ${resolvedCount} / 其余 ${contracts.length - resolvedCount}；` +
      `unresolvedContracts ${unresolvedContracts.length}；snapshotSha256=${snapshotSha256.slice(0, 12)}…${opts.write ? "；已落盘" : "；未落盘（缺 --write）"}）`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

export { canonicalJson, loadAuthorityDeclarations, resolveContract, resolveInstalledNpmPackage, resolveLocalPath, resolveSurfaces };
