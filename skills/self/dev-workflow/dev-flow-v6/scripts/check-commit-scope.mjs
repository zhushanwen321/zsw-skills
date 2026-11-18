#!/usr/bin/env node
// check-commit-scope.mjs — 提交前仓外路径检查器（V5 交付完整性改造设计 §11 路线 A 第 4 条
// 「提交前仓外路径检查」；背景：同一仓外提交故障连续发生三次（设计 §2.5）——commit 前无
// 机器门，相对路径 `..`、仓外绝对路径、symlink、不同 cwd 解析歧义四类入口全靠人眼）。
//
// 用法：node check-commit-scope.mjs --repo-root <仓库根绝对路径> [--staged] [--paths <路径...>]
//   --repo-root  仓库根绝对路径（必填；本身是 symlink 时自动 realpath 归一；相对形态拒绝——
//                repo-root 随调用方 cwd 漂移会让全部判定失去基准）
//   --staged     检查 git 暂存区全部文件路径（在 repo-root 下跑 git diff --cached --name-only -z）
//   --paths      显式检查给定路径列表（空格分隔可多个；供调用方检查未暂存或任意路径集）
//   两者都不给 = 用法错误 exit 2；都给 = 并集检查（按解析后落点去重）。
//
// 输出契约：干净 → stdout 单行 `PASS: ...`，exit 0；违例 → stdout 逐行
//   `FAIL: <路径> -> <违例类型>: <说明>` + 末尾恢复动作段，exit 1；
//   用法错误 → stderr 三段式（什么不合法 → 权威源 → 恢复动作），exit 2；
//   运行错误（git 不可用 / 非 git 仓）→ stderr 三段式，exit 3。
//
// 违例判定四规则（设计 §9.2 仓外提交样例覆盖：相对路径、绝对路径、`..`、symlink、不同 cwd）：
//   ① 相对路径逃逸：相对路径一律按 --repo-root 词法解析（path.resolve 消 `..`/`.`/重复
//      分隔符），落点在 repo-root 外 → FAIL。含 `..` 但规范化后仍在仓内（如 src/../a.txt）
//      不违例——判据是规范化后落点，不是字面含 `..`。
//   ② 仓外绝对路径：输入本身是绝对路径且落点在 repo-root 外。
//   ③ symlink 逃逸：词法落点在仓内，磁盘真实落点（逐级 realpath）在仓外。覆盖「路径本身
//      是 symlink」与「祖先组件是 symlink」两种；末段不存在时解析最长存在祖先（祖先里的
//      symlink 同样偏移真实落点，整段放弃解析会把该形态漏判成仓内）。
//   ④ cwd 无关性：所有相对路径只按 --repo-root 解析，脚本不读 process.cwd() 参与解析
//      （同一串相对路径在不同 cwd 下解析结果不同，歧义本身即风险源；测试断言不同 cwd
//      调用结果一致）。
//
// 判定顺序与大小写一致性：路径在盘上存在 → 以磁盘真实落点为唯一权威（真实落点在仓内即
// 无仓外写入事实，放行）；不存在（未创建 / staged 已删除）→ 只做词法判定（无真实落点可
// 解析；symlink 逃逸在此形态不可判，属已知边界而非漏报——不存在的路径自身无 symlink 可逃）。
// 大小写不敏感文件系统（darwin APFS 默认）需显式拼写归一：实测 realpath 保留输入拼写、
// 不返回磁盘真实大小写（realpath(/tmp/X 与 /tmp/x 返回各自拼法、指向同一 inode），独立拼
// 写来源的两个绝对路径会被字符串前缀比较误判成仓外。做法：对 repo-root 探测一次文件系统
// 是否区分大小写（翻转 basename 某字符后 stat 比对 inode），不敏感 FS 上用 readdir 逐组件
// 重建磁盘真实拼写（目录项缓存按 dev+ino 键，同一目录多路径只读一次）；敏感 FS（linux
// ext4 等）输入拼写即真实拼写，直通零开销。归一覆盖大小写维度；Unicode 规范化差异（NFC/NFD
// 文件名拼法）未覆盖——目录项比对未命中时保持输入拼写回落，行为不劣于不归一。
//
// --staged 口径：`git diff --cached --name-only -z`（-z 模式下 git 不做 quotePath 转义、
// NUL 分隔，路径含空格/换行不裂项）。rename 默认检测下只输出新路径一条（实测；旧路径是
// 删除侧，已不在待提交集内，无检查缺口；旧路径需显式检查时调用方走 --paths）。无 HEAD 的
// 初始仓（首提前暂存，恰是最该拦的场景）diff 无基准，回退基准为 git 内建空树对象 hash。
// git 输出按 UTF-8 解码，非 UTF-8 字节路径（linux 可造）解码成 U+FFFD 后 realpath 必失败、
// 回落词法判定，行为安全。
// 已知盲区（如实声明，不伪装穷尽）：本检查对每个暂存路径复核其磁盘 real 落点，是提交前
// 初筛；「暂存后在仓外重建同名真文件」等 TOCTOU 窗口不在射程内——那是沙箱职责，不是
// 路径检查器职责。

import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readdirSync, realpathSync, statSync } from "node:fs";

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, ERROR: 3 };
// git 内建空树对象 hash：任何仓库可作 diff 基准（无 HEAD 初始仓的首提前暂存检查）
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const USAGE_LINE =
  "node check-commit-scope.mjs --repo-root <仓库根绝对路径> [--staged] [--paths <路径...>]";

function usage() {
  return [
    `用法：${USAGE_LINE}`,
    "  --repo-root  仓库根绝对路径（必填；本身是 symlink 时自动 realpath 归一；相对形态拒绝）",
    "  --staged     检查 git 暂存区全部文件路径（git diff --cached --name-only -z；无 HEAD 的",
    "               初始仓以空树为基准；rename 输出新路径）",
    "  --paths      显式检查给定路径列表（空格分隔可多个；相对路径一律按 --repo-root 解析，",
    "               不参考调用方 cwd；不要求文件存在——staged 删除的路径也能查）",
    "  --staged 与 --paths 都不给 = 用法错误 exit 2；都给 = 并集检查（按解析后落点去重）。",
    "",
    "用途：提交前机器初筛「待提交路径是否全部落在仓库内」，拦四类仓外入口——`..` 相对路径",
    "逃逸、仓外绝对路径、symlink 解析逃逸、不同 cwd 下相对路径解析歧义（一律按 --repo-root",
    "解析消歧）。设计出处：V5 交付完整性改造设计 §11 路线 A 第 4 条、§9.2 仓外提交样例。",
    "",
    "退出码：0 干净（stdout 单行 PASS）；1 有违例（stdout 逐行 FAIL: <路径> -> <违例类型>:",
    "<说明> + 末尾恢复动作段）；2 用法错误（stderr 三段式：什么不合法 → 权威源 → 恢复动作）；",
    "3 运行错误（git 不可用 / --repo-root 不是 git 仓等，stderr 三段式）。",
    "",
    "判定顺序：路径在盘上存在 → 以磁盘真实落点（逐级 realpath + 大小写不敏感 FS 上的磁盘",
    "拼写归一）为唯一权威，书写大小写与磁盘不一致不误判；不存在（未创建 / staged 已删除）",
    "→ 词法判定。",
    "",
    "示例：",
    "  # workflow 侧：提交门检查暂存区全部已暂存路径",
    `  ${USAGE_LINE.replace("--repo-root <仓库根绝对路径>", "--repo-root <项目根绝对路径>")}`,
    "  node check-commit-scope.mjs --repo-root /path/to/proj --staged",
    "  # 检查显式路径集（未暂存 / 任意路径，相对与绝对可混）",
    '  node check-commit-scope.mjs --repo-root /path/to/proj --paths src/a.ts "../outside.txt" /etc/hosts',
    "  # 并集：暂存区 + 显式路径",
    "  node check-commit-scope.mjs --repo-root /path/to/proj --staged --paths build/out.json",
  ].join("\n");
}

function failUsage(msg) {
  console.error(`用法错误：${msg}`);
  console.error(`权威源：node check-commit-scope.mjs --help（用法、判定规则、退出码与示例）`);
  console.error(`恢复动作：${USAGE_LINE}`);
  process.exit(EXIT.USAGE);
}

function failRun(msg, recover) {
  console.error(`运行错误：${msg}`);
  console.error(`权威源：node check-commit-scope.mjs --help`);
  console.error(`恢复动作：${recover}`);
  process.exit(EXIT.ERROR);
}

// ── 参数解析 ──

const argv = process.argv.slice(2);
const opts = { repoRoot: null, staged: false, paths: [] };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--repo-root") {
    if (i + 1 >= argv.length) failUsage("--repo-root 后未跟路径值");
    opts.repoRoot = argv[++i];
  } else if (arg === "--staged") {
    opts.staged = true;
  } else if (arg === "--paths") {
    // 贪婪收集到下一个旗标为止：路径数量不定（调用方一次塞任意个）
    const rest = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) rest.push(argv[++i]);
    if (rest.length === 0) failUsage("--paths 后未跟任何路径");
    opts.paths.push(...rest);
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else {
    failUsage(`未知参数「${arg ?? ""}」`);
  }
}
if (!opts.repoRoot) failUsage("缺必填参数 --repo-root");
if (!opts.staged && opts.paths.length === 0) {
  failUsage("--staged 与 --paths 至少给一个（两者都不给 = 无检查对象）");
}
if (!isAbsolute(opts.repoRoot)) {
  failUsage(`--repo-root 须为绝对路径，收到「${opts.repoRoot}」（相对 repo-root 随调用方 cwd 漂移，判定失去基准）`);
}
let root;
try {
  // repo-root 先 realpath 一次：root 本身是 symlink（darwin 的 /tmp → /private/tmp 等）
  // 时，后续词法与真实落点判定统一以磁盘真实形态为基准，避免两侧基准失配
  root = realpathSync(opts.repoRoot);
} catch {
  failUsage(`--repo-root 不存在或不可解析：「${opts.repoRoot}」`);
}
try {
  if (!statSync(root).isDirectory()) failUsage(`--repo-root 不是目录：「${opts.repoRoot}」`);
} catch {
  failUsage(`--repo-root 校验失败（stat 不可读）：「${opts.repoRoot}」`);
}

// ── 大小写不敏感文件系统的拼写归一 ──

// 探测 repo-root 所在文件系统是否区分大小写：翻转 basename 中第一个大小写可变字符后
// stat，同一 inode = 不敏感 FS（darwin APFS 默认）——需要 readdir 归一；翻转形态不存在
// = 敏感 FS（linux ext4 等），拼写即真实拼写，归一直通
function probeCaseSensitive() {
  const base = basename(root);
  const i = [...base].findIndex((ch) => ch.toLowerCase() !== ch.toUpperCase());
  if (i < 0) return true; // 无可翻转字符（数字/符号名、根）：按敏感处理，安全方向
  const flipped =
    base.slice(0, i) +
    (base[i] === base[i].toUpperCase() ? base[i].toLowerCase() : base[i].toUpperCase()) +
    base.slice(i + 1);
  try {
    const a = statSync(root);
    const b = statSync(join(dirname(root), flipped));
    return a.dev !== b.dev || a.ino !== b.ino;
  } catch {
    return true; // 翻转形态 stat 失败：敏感 FS
  }
}

const dirEntriesCache = new Map(); // key "dev:ino" → 目录项数组：同一目录多路径只 readdir 一次
function dirEntries(dir) {
  const st = statSync(dir);
  const key = `${st.dev}:${st.ino}`;
  let entries = dirEntriesCache.get(key);
  if (!entries) {
    entries = readdirSync(dir);
    dirEntriesCache.set(key, entries);
  }
  return entries;
}

// 逐组件用磁盘目录项的真实拼写重建路径。组件不存在（目录项未命中 / 目录不可读）时，
// 该组件起保持输入拼写——残余段不含 `..`，不影响前缀包含关系判定（判定只取决于已归一
// 前缀与 repo-root 的关系）；Unicode 规范化差异（NFC/NFD 拼法）未命中时同样回落输入拼写。
function canonicalCase(p) {
  let cur = p;
  const parts = [];
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) break; // 已到文件系统根
    parts.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let hit = null;
    try {
      const lower = part.toLowerCase();
      hit = dirEntries(real).find((e) => e.toLowerCase() === lower) ?? null;
    } catch {
      hit = null; // 目录不可读：该组件起保持输入拼写
    }
    if (hit === null) return join(real, ...parts.slice(i));
    real = join(real, hit);
  }
  return real;
}

const caseSensitive = probeCaseSensitive();
const norm = (p) => (caseSensitive ? p : canonicalCase(p));
const rootN = norm(root);

// ── 暂存区路径收集 ──

function stagedPaths() {
  // 基准探测：有 HEAD 用 HEAD；无 HEAD（首提前暂存）diff --cached 无基准，用空树对象。
  // rev-parse 失败不在此处报错——非 git 仓时它必失败，随后 diff 也失败，统一在 diff 处报。
  let base = "HEAD";
  const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root });
  if (probe.status !== 0) base = EMPTY_TREE;
  // encoding buffer + 手工 NUL 切分：-z 输出不做 quotePath 转义，含空格/换行路径不裂项
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "-z", base], {
    cwd: root,
    encoding: "buffer",
  });
  if (r.error) {
    failRun(`git 命令不可用（${r.error.message}）`, "核对 git 已安装且在 PATH 中后重跑。");
  }
  if (r.status !== 0) {
    failRun(
      `--staged 检查失败：git diff --cached 在 ${root} 下退出码 ${r.status}（${String(r.stderr).trim()}）`,
      `核对 --repo-root 指向 git 仓库根（cd ${root} && git rev-parse --show-toplevel 可验证）后重跑。`,
    );
  }
  return r.stdout.toString("utf8").split("\0").filter((s) => s !== "");
}

// ── 路径判定 ──

// 落点 p 是否在 root 内（p === root 视为仓内：目录本身无逃逸事实）。
// isAbsolute(rel) 分支防 Windows 盘符形态（当前不支持 Windows，纯防御性写法）。
function inRoot(rootP, p) {
  const rel = relative(rootP, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// 磁盘真实落点：末段存在时整段 realpath；不存在时向上找最长存在祖先做部分解析
// （祖先里的 symlink 仍会偏移真实落点，整段放弃解析会把「祖先 symlink 指仓外 + 末段
// 不存在」漏判成仓内）。残余段来自已词法规范化的 abs，不含 `..`，词法拼接安全。
function resolveReal(abs) {
  try {
    return { path: realpathSync(abs), exists: true };
  } catch {
    // 末段不存在，走逐级向上
  }
  let cur = abs;
  const tail = [];
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return { path: abs, exists: false }; // 已到文件系统根仍无存在祖先：全词法
    tail.unshift(basename(cur));
    cur = parent;
    try {
      return { path: join(realpathSync(cur), ...tail), exists: false };
    } catch {
      // 该级祖先也不存在，继续向上
    }
  }
}

// FAIL 行输出含路径时保行结构：路径含换行/回车时 JSON 转义（一行恒一条 FAIL，机器逐行
// 解析不裂），其余原样输出保持人读自然
function fmtPath(p) {
  return /[\n\r]/.test(p) ? JSON.stringify(p) : p;
}

const failures = [];
const seen = new Set(); // 按词法落点去重：并集模式下同一落点只报一次

function checkOne(input) {
  // 词法规范化基准：相对路径只按 repo-root 解析，不读 process.cwd()（判定规则④）
  const abs = isAbsolute(input) ? resolve(input) : resolve(rootN, input);
  if (seen.has(abs)) return;
  seen.add(abs);
  const real = resolveReal(abs);
  // 判定用归一拼写（不敏感 FS 上把独立拼写来源的路径归到磁盘真实形态，防字符串前缀误判）
  const absN = norm(abs);
  const realN = norm(real.path);
  const absIn = inRoot(rootN, absN);
  const realIn = inRoot(rootN, realN);
  if (absIn && realIn) return;
  if (!absIn && realIn) return; // 存在且真实落点在仓内：以真实落点为权威（大小写误写不误判）
  if (absIn && !realIn) {
    failures.push({
      input,
      type: "symlink 逃逸",
      detail: `磁盘真实落点 ${fmtPath(realN)} 在 repo-root（${fmtPath(rootN)}）之外（路径或其祖先为 symlink）`,
    });
    return;
  }
  // 词法与真实落点都在仓外：类型按输入形态分（相对/绝对），真实落点若与词法不同则附佐证
  const type = isAbsolute(input) ? "仓外绝对路径" : "相对路径逃逸";
  let detail = isAbsolute(input)
    ? `${fmtPath(absN)} 不在 repo-root（${fmtPath(rootN)}）之内`
    : `按 --repo-root 解析为 ${fmtPath(absN)}，落点在 repo-root（${fmtPath(rootN)}）之外（解析不参考调用方 cwd）`;
  if (realN !== absN) detail += `；磁盘真实落点 ${fmtPath(realN)} 同样在仓外`;
  failures.push({ input, type, detail });
}

// ── 主流程 ──

const inputs = [];
let stagedCount = 0;
if (opts.staged) {
  const staged = stagedPaths();
  stagedCount = staged.length;
  inputs.push(...staged);
}
inputs.push(...opts.paths);
for (const p of inputs) checkOne(p);

if (failures.length === 0) {
  console.log(
    `PASS: 共检查 ${inputs.length} 条路径（暂存区 ${stagedCount} + 显式 ${opts.paths.length}，去重后 ${seen.size}），全部在仓内；repo-root=${fmtPath(rootN)}`,
  );
  process.exit(EXIT.PASS);
}

for (const f of failures) {
  console.log(`FAIL: ${fmtPath(f.input)} -> ${f.type}: ${f.detail}`);
}
console.log(
  "恢复动作：① 路径写错（笔误 / 多了 `../` / 指到仓外）→ 修正路径后重新 git add 或重跑本检查；" +
    "② 文件确属本仓 → 移入 repo-root 内再提交（仓外文件不进版本库，git 无法追踪其内容变化）；" +
    "③ 确有依赖仓外路径的真实需求 → 用户确认外部基线通道尚未建立（本检查当前无任何豁免机制），" +
    "停下交用户裁决，不得绕过本检查继续提交。",
);
process.exit(EXIT.FAIL);
