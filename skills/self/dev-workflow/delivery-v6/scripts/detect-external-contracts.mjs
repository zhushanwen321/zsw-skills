#!/usr/bin/env node
// detect-external-contracts.mjs —— 外部契约候选探测（只读，设计《V6 运行可用性与外部契约守门升级》§4.2）
//
// 为什么有本脚本：交付物运行时依赖的外部系统（宿主、插件 API、SDK、CLI 插件接口、操作系统
// 原语）此前只在 reviewer 自觉里出现，漏判直接导致「代码存在但真实环境不可用」被 accepted。
// 本脚本把 intent、项目清单、源码、测试与项目文档五类信号一次探测成结构化候选快照，
// 供验收处置表（externalContractReview）冻结、D0/D3/evaluate 复扫与 IA 输入消费。
// 本脚本只读文件系统，不执行项目代码、不联网、不写任何文件（含快照——落盘由调用方负责）。
//
// 用法：
//   node detect-external-contracts.mjs --project-root <绝对路径> --intent-file <路径>
//     stdout 输出候选快照 JSON（单一对象，本行以上无其他 stdout 内容；进度与警告走 stderr）。
//
// 输出契约（schemaVersion 1）：
//   {
//     "schemaVersion": 1,
//     "inputHashes": {
//       "intent": "<intent 文件 sha256>",
//       "packageManifest": "<package.json sha256 或 \"absent\">",
//       "sourceScanInputs": ["<相对路径>:<sha256>", ...]   // 全部被扫描的代码与文档输入
//     },
//     "detectionScope": { "source": "intent", "patterns": ["docs/**", ...] } | null,
//     "candidates": [
//       { "id": "candidate-...", "strength": "strong|weak", "signals": ["manifest:...", "source:...", ...],
//         "suggestedResolver": "installed-npm-package|executable|null", "suggestedLocator": "<定位符|null>" }
//     ],
//     "unresolved": [ { "signal": "<形态+定位>", "reason": "<为什么无法静态归因>" } ]
//   }
//
// 扫描范围两层过滤：①git 仓内只扫 tracked + untracked-not-ignored（gitignored 路径
// 是项目自己声明的外部参考/产物，进候选只是噪声）；②intent 文件可携带交付面声明块
// <!-- delivery-detection-scope … -->（块内每行一个 glob，** 跨目录 / * 段内通配，
// 不含通配符的行同时匹配自身与递归子路径），声明在场时只扫命中 glob 的文件——外部
// 契约的判定域是任务交付面，仓内非交付面（如 agent 工具目录）不进本任务候选。
// detectionScope 字段显形当前生效的范围声明（无声明为 null），随 inputHashes.intent 可审计。
//
// 信号强度（§4.2）：strong = 外部系统 manifest 字段（pi.extensions）、真实 SDK import、
// 外部注册/分发/生命周期调用类、测试中真实 SDK import；weak = intent 词、普通依赖声明、
// 项目文档 URL、自写 harness-only、包自身形态（type/bin）。strong 候选只能绑定契约或
// 保持 unresolved 停回；weak 候选可由 reviewer 论证不构成外部契约。
//
// 调用类识别形态：词表来自策略文件 policies/external-contract-classes.json（七初始类，
// 字段 classes[].staticSignals 为 {kind: regex|manifest-field} 信号数组），按正则逐文件
// 文本匹配（无 AST 依赖）。已知盲区（如实声明）：多行调用断行、字符串拼接/模板方法名、
// 别名再导出跨两层以上、minify/vendor bundle 内的调用、以及「计算式外部成员访问」只能对
// 「文件内 import 的外部包绑定」报警（本地对象的计算式访问无法与外部访问区分，不猜）。
// 计算式外部成员访问、动态 import、eval/Function/vm 运行时代码生成、本地模块 re-export
// 穿透一层后无法归因 → 记 unresolved（§4.2 规则，不做字面白名单放行）。
//
// 退出码：0 成功（含候选为空）；2 用法错误；3 运行错误（路径不存在、策略文件损坏等）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname as pathExtname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = { PASS: 0, USAGE: 2, ERROR: 3 };
const SCHEMA_VERSION = 1;
const POLICY_RELATIVE_PATH = join("..", "policies", "external-contract-classes.json");
// 单文件扫描上限：超大文件（vendor bundle / 生成物）逐行正则可把探测拖到分钟级，
// 跳过并向 stderr 出声——候选探测漏读的风险由 D0/D3/evaluate 三处复扫与 reviewer 分担
const MAX_SCAN_BYTES = 1024 * 1024;
const WALK_DEPTH_LIMIT = 6;
// 目录排除表：这些位置不是「项目源码信号」的权威来源（node_modules 由 resolver 的信任
// 规则单独处理；dist/build 是产物可能含陈旧调用形态，作为信号会误导强度判定）
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".tmp", ".agents", ".next", ".turbo", ".venv"]);
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const DOC_EXTS = new Set([".md", ".mdx"]);
const DOC_SIGNAL_DIRS = ["", "docs", "doc", "documentation"];

// intent 词表：通用宿主/插件/SDK 词（中英）+ package.json 的平台名（name 与 keywords）。
// 不内置任何特定外部系统的名称或路径——特定平台信号只能从项目事实（manifest 字段、
// 依赖名、import 说明符）来。
const INTENT_GENERIC_WORDS = [
  "host", "plugin", "sdk", "extension", "runner", "cli", "addon",
  "宿主", "插件", "扩展", "运行器",
];
// 项目文档「平台说明路径」行内需同时出现 URL 与平台词才记 weak 信号——只含 URL 的
// 普通链接（CI badge、图标）不是外部平台说明
const DOC_PLATFORM_WORDS = ["sdk", "extension", "plugin", "host", "runner", "addon", "api", "宿主", "插件", "扩展", "运行器"];
const URL_RE = /https?:\/\/[^\s)"'`]+/gi;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function usage() {
  return [
    "用法：node detect-external-contracts.mjs --project-root <绝对路径> --intent-file <路径>",
    "",
    "  --project-root  项目根（或 worktree 根）绝对路径；探测目标",
    "  --intent-file   意图文件（taskDir/intent.md）路径；intent 词信号来源，内容哈希进 inputHashes",
    "",
    "stdout 输出候选快照 JSON（单一对象）；进度/警告走 stderr。",
    "退出码：0 成功（候选可空）；2 用法错误；3 运行错误。",
  ].join("\n");
}

function failUsage(message) {
  console.error(`用法错误：${message}`);
  console.error("权威源：node detect-external-contracts.mjs --help（输出契约、信号强度与 unresolved 规则）");
  console.error("恢复动作：node detect-external-contracts.mjs --project-root <绝对路径> --intent-file <路径>");
  process.exit(EXIT.USAGE);
}

function failRun(message, recover) {
  console.error(`运行错误：${message}`);
  console.error("权威源：node detect-external-contracts.mjs --help");
  console.error(`恢复动作：${recover}`);
  process.exit(EXIT.ERROR);
}

function parseArgs(argv) {
  const opts = { projectRoot: null, intentFile: null };
  const readValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined) failUsage(`参数 ${flag} 缺取值（悬空 flag）；--help 查看完整用法`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") opts.projectRoot = readValue("--project-root", index), index += 1;
    else if (arg === "--intent-file") opts.intentFile = readValue("--intent-file", index), index += 1;
    else if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(EXIT.PASS); }
    else failUsage(`未知参数「${arg ?? ""}」（--help 查看完整用法）`);
  }
  if (!opts.projectRoot) failUsage("缺必填参数 --project-root");
  if (!opts.intentFile) failUsage("缺必填参数 --intent-file");
  if (!isAbsolute(opts.projectRoot)) failUsage(`--project-root 须为绝对路径，收到「${opts.projectRoot}」（相对路径随调用方 cwd 漂移，探测失去基准）`);
  if (!isAbsolute(opts.intentFile)) failUsage(`--intent-file 须为绝对路径，收到「${opts.intentFile}」`);
  if (!existsSync(opts.projectRoot) || !statSync(opts.projectRoot).isDirectory()) {
    failRun(`--project-root 不存在或不是目录（${opts.projectRoot}）`, "核对路径拼写（含 worktree 是否已被删除）后重跑");
  }
  if (!existsSync(opts.intentFile) || !statSync(opts.intentFile).isFile()) {
    failRun(`--intent-file 不存在或不是文件（${opts.intentFile}）`, "核对意图文件路径；intent 缺失时先由 init/set-intent 建立后重跑");
  }
  return { projectRoot: realpathSync(opts.projectRoot), intentFile: realpathSync(opts.intentFile) };
}

// ---------------------------------------------------------------------------
// 策略文件：调用类词表（七初始类）。字段 classes[].id / staticSignals /
// minEnvironment / impliesObservationClasses 与内核线（snapshot-policy /
// world.policy / validatePolicySources）的消费契约对账。
// ---------------------------------------------------------------------------

function readFieldPath(root, field) {
  let current = root;
  for (const segment of field.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function loadPolicyClasses() {
  const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), POLICY_RELATIVE_PATH);
  if (!existsSync(policyPath)) {
    failRun(`策略文件缺失（${policyPath}）——调用类词表是探测的唯一权威来源`, "恢复策略文件 external-contract-classes.json（随 delivery-v6 技能分发）后重跑");
  }
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    failRun(`策略文件不是合法 JSON（${policyPath}，${error.message}）`, "修复策略文件 JSON 语法后重跑");
  }
  if (!Array.isArray(policy?.classes) || policy.classes.length === 0) {
    failRun(`策略文件缺少非空 classes 数组（${policyPath}）`, "按 external-contract-classes.json schema（classes[].id/staticSignals/minEnvironment/impliesObservationClasses）补齐后重跑");
  }
  return policy.classes.map((entry) => {
    if (typeof entry?.id !== "string" || entry.id.trim() === "") {
      failRun(`策略文件存在缺 id 的调用类（${policyPath}）`, "给每个 classes 条目补非空 id 后重跑");
    }
    const signals = Array.isArray(entry.staticSignals) ? entry.staticSignals : [];
    const regexSignals = signals
      .filter((signal) => signal && signal.kind === "regex" && typeof signal.pattern === "string")
      .map((signal) => {
        try {
          return { re: new RegExp(signal.pattern), appliesTo: signal.appliesTo === "test" ? "test" : "code" };
        } catch (error) {
          failRun(`策略文件调用类 ${entry.id} 的正则无法编译（${signal.pattern}，${error.message}）`, "修正 staticSignals 正则语法后重跑");
        }
      });
    const manifestFields = signals
      .filter((signal) => signal && signal.kind === "manifest-field" && typeof signal.field === "string")
      .map((signal) => signal.field);
    return {
      id: entry.id,
      minEnvironment: entry.minEnvironment,
      impliesObservationClasses: Array.isArray(entry.impliesObservationClasses) ? entry.impliesObservationClasses : [],
      regexSignals,
      manifestFields,
    };
  });
}

// ---------------------------------------------------------------------------
// 输入读取
// ---------------------------------------------------------------------------

function readIntent(intentFile) {
  let text;
  try {
    text = readFileSync(intentFile, "utf8");
  } catch (error) {
    failRun(`无法读取 intent 文件（${intentFile}，${error.message}）`, "确认文件可读后重跑");
  }
  return { text, sha256: sha256(text) };
}

function readManifest(projectRoot) {
  const manifestPath = join(projectRoot, "package.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return { manifest: null, sha256: "absent" };
  const raw = readFileSync(manifestPath);
  let manifest = null;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    // package.json 存在但不可解析：来源已坏——manifest 信号整体作废并向 stderr 出声，
    // 不静默跳过（静默跳过会让「外部系统 manifest」类信号无声消失）
    console.error(`WARN: package.json 存在但不是合法 JSON（${manifestPath}），manifest 信号全部作废；恢复动作：修复 package.json 语法后重跑探测`);
  }
  return { manifest: manifest && typeof manifest === "object" ? manifest : null, sha256: sha256(raw) };
}

// ---------------------------------------------------------------------------
// 文件收集：代码（.js/.mjs/.cjs/.ts/.tsx/.jsx）与文档（.md/.mdx），排除产物目录
//
// 两层范围过滤（2026-11-19 裁决：探测范围随任务交付面定，不随仓库全集定）：
//   1. git 过滤：git 仓内只扫 tracked + untracked-not-ignored（git ls-files
//      --cached --others --exclude-standard）。gitignored 路径（外部参考项目、
//      产物目录）被项目自己声明为非项目面，进候选只会制造验收线无权放行的
//      强信号噪声。非 git 仓（git 不可用/无 .git）退化为全量扫描并向 stderr 告警。
//   2. 交付面声明：intent 文件可携带机器可读范围块（HTML 注释形态，markdown
//      渲染不可见），块内每行一个 glob（** 跨目录 / * 段内通配；不含通配符的
//      行同时匹配自身与其递归子路径）。声明在场时只扫命中 glob 的文件——外部
//      契约的判定域是任务交付面，仓内非交付面（如 agent 工具目录）的真实 SDK
//      import 不由本任务背负。范围块随 intent 内容哈希进 inputHashes，可审计。
// ---------------------------------------------------------------------------

const SCOPE_BLOCK_RE = /<!--\s*delivery-detection-scope\s*\r?\n([^]*?)-->/;

/** git 可扫描文件集合（POSIX 相对路径）：tracked + untracked-not-ignored；非 git 仓返回 null。 */
function gitScannableFiles(projectRoot) {
  const result = spawnSync("git", ["-C", projectRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const set = new Set();
  const out = result.stdout;
  let start = 0;
  for (let index = 0; index < out.length; index += 1) {
    if (out[index] !== 0) continue;
    if (index > start) set.add(out.toString("utf8", start, index));
    start = index + 1;
  }
  return set;
}

/** intent 交付面声明块 → glob 行数组；无块或块内无有效行返回 null。 */
function parseDetectionScope(intentText) {
  const match = intentText.match(SCOPE_BLOCK_RE);
  if (!match) return null;
  const patterns = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return patterns.length > 0 ? patterns : null;
}

/** 简单 glob → 正则：** 跨目录、* 段内通配、其余字符按字面转义；行首 / 规格化为相对。 */
function globToRegExp(pattern) {
  const normalized = pattern.replace(/^\/+/, "");
  const source = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

/** glob 行集合 → 匹配器数组。不含通配符的行（如 docs）同时匹配自身与递归子路径（docs/**）。 */
function compileScopeMatchers(patterns) {
  return patterns.flatMap((pattern) => (pattern.includes("*") ? [pattern] : [pattern, `${pattern}/**`])).map(globToRegExp);
}

function collectFiles(projectRoot, excludeAbs, fileFilter) {
  const code = [];
  const docs = [];
  const walk = (dir, depth) => {
    if (depth > WALK_DEPTH_LIMIT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录：跳过（探测是尽力初筛，权限问题交调用方处置）
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        // symlink 一律不穿透：仓内符号链接可能指向仓外大目录或循环结构，
        // 穿透会把探测范围与耗时失控；这是已知边界（信号遗漏由复扫与 reviewer 分担）
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        if (excludeAbs.has(path)) continue; // intent 等独立输入有自己的哈希键，不进扫描输入
        const rel = relative(projectRoot, path).split(sep).join("/");
        if (fileFilter && !fileFilter(path, rel)) continue;
        const ext = pathExtname(path).toLowerCase();
        if (CODE_EXTS.has(ext)) code.push(path);
        else if (DOC_EXTS.has(ext)) docs.push(path);
      }
    }
  };
  walk(projectRoot, 1);
  return { code, docs };
}

// ---------------------------------------------------------------------------
// 源码静态形态抽取（正则级，无 AST）：
//   - import/require 的外部包说明符与绑定名（namespace/default/CJS require）
//   - re-export 源（本地模块或外部包）
//   - 动态 import / eval / Function / vm 运行时代码生成
//   - import 外部包绑定上的计算式成员访问 X[...]
// ---------------------------------------------------------------------------

const IMPORT_FROM_RE = /import\s+([^;"']*?)\s+from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /import\s+["']([^"']+)["']/g;
const REQUIRE_RE = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXPORT_FROM_RE = /export\s+(?:\*|\{[^}]*\})\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*["']([^"']+)["']/g;
// 动态 import / require：调用参数不是字符串字面量即无法静态归因（§4.2 unresolved 规则）
const DYNAMIC_IMPORT_RE = /(?:^|[^.\w$])import\s*\(\s*(?!["'])/g;
const DYNAMIC_REQUIRE_RE = /(?:^|[^.\w$])require\s*\(\s*(?!["'])/g;
// __dirname 锚定的计算式调用一层归因：参数是 (path.)resolve/join(__dirname, "字面量"…)
// 且解析目标在仓内存在时视为本地模块 require（与 re-export 穿透一层归因同款语义）；
// 目标仓外、不存在或参数含非字面量 → 维持 unresolved，不做字面白名单放行
const DIR_ANCHORED_CALL_RE = /^\s*(?:path\s*\.\s*)?(?:resolve|join)\s*\(\s*__dirname\s*((?:,\s*["'][^"']*["']\s*)*)\)/;
const RUNTIME_GEN_RES = [
  { re: /\beval\s*\(/g, label: "eval 调用" },
  { re: /new\s+Function\s*\(/g, label: "new Function 构造" },
  { re: /(?:from\s+["']vm["']|require\s*\(\s*["']vm["']\s*\))/g, label: "vm 模块使用" },
];

/** 从 import 子句提取 namespace/default 绑定名（命名导入不纳入计算式访问监控，降误报） */
function importBindings(clause) {
  const names = [];
  const starMatch = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (starMatch) names.push(starMatch[1]);
  // `import X from`（默认导入）：子句以标识符开头且不是 { / * 形态
  const defaultMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  if (defaultMatch && !clause.trimStart().startsWith("{") && !clause.trimStart().startsWith("*")) names.push(defaultMatch[1]);
  return names;
}

function isExternalSpecifier(spec, selfName) {
  if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) return false;
  if (builtinModules.includes(spec)) return false;
  if (selfName && (spec === selfName || spec.startsWith(`${selfName}/`))) return false;
  // 子路径导入归并到包根名：pkg/sub -> pkg；@scope/pkg/sub -> @scope/pkg
  const segments = spec.split("/");
  const pkgName = spec.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkgName)) return false;
  return true;
}

function packageRootOf(spec) {
  const segments = spec.split("/");
  return spec.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function isRelativeSpecifier(spec) {
  return spec.startsWith("./") || spec.startsWith("../");
}

/** 解析项目内相对 import 到文件路径（带扩展名与 index 尝试）；定位不到返回 null */
function resolveLocalModule(fromFile, spec, codeFileSet) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, join(base, "index.js"), join(base, "index.mjs"), join(base, "index.cjs"), join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((candidate) => codeFileSet.has(candidate)) ?? null;
}

function scanCodeFile(absPath, relPath, text, policyClasses) {
  const result = { imports: [], reexports: [], callClasses: [], dynamicImports: 0, runtimeGen: [], computedAccess: [] };
  for (const match of text.matchAll(IMPORT_FROM_RE)) {
    result.imports.push({ spec: match[2], bindings: importBindings(match[1]) });
  }
  for (const match of text.matchAll(BARE_IMPORT_RE)) {
    result.imports.push({ spec: match[1], bindings: [] });
  }
  for (const match of text.matchAll(REQUIRE_RE)) {
    const target = match[1];
    if (/^[A-Za-z_$][\w$]*$/.test(target)) result.imports.push({ spec: match[2], bindings: [target] });
    else result.imports.push({ spec: match[2], bindings: [] });
  }
  for (const match of text.matchAll(EXPORT_FROM_RE)) {
    result.reexports.push({ spec: match[1] });
  }
  const dynamicImport = text.match(DYNAMIC_IMPORT_RE);
  const dynamicRequire = text.match(DYNAMIC_REQUIRE_RE);
  const dynamicCallCount = (dynamicImport ? dynamicImport.length : 0) + (dynamicRequire ? dynamicRequire.length : 0);
  if (dynamicCallCount > 0) {
    // 逐调用一层归因：__dirname 锚定且目标为仓内存在文件的动态调用不是外部访问
    let attributed = 0;
    for (const re of [DYNAMIC_IMPORT_RE, DYNAMIC_REQUIRE_RE]) {
      for (const match of text.matchAll(new RegExp(re.source, "g"))) {
        const argStart = match.index + match[0].length;
        const argWindow = text.slice(argStart, argStart + 300);
        if (dirAnchoredLocalTarget(absPath, argWindow) !== null) attributed += 1;
      }
    }
    result.dynamicImports += dynamicCallCount - attributed;
  }
  for (const { re, label } of RUNTIME_GEN_RES) {
    if (re.test(text)) result.runtimeGen.push(label);
  }
  for (const entry of policyClasses) {
    for (const signal of entry.regexSignals) {
      if (signal.appliesTo !== "code") continue;
      signal.re.lastIndex = 0;
      if (signal.re.test(text)) result.callClasses.push(entry.id);
    }
  }
  // 计算式外部成员访问：仅监控「本文件 import 的外部包绑定」上的 X[...]（方括号内非
  // 字符串字面量）——本地对象的计算式访问（arr[i]）无法与外部访问区分，不猜（§4.2）
  const externalBindings = result.imports
    .filter((entry) => isExternalSpecifier(entry.spec, SELF_NAME))
    .flatMap((entry) => entry.bindings);
  for (const binding of externalBindings) {
    const computed = new RegExp(`\\b${binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\[(?!["'])`, "g");
    if (computed.test(text)) result.computedAccess.push(binding);
  }
  return result;
}

// SELF_NAME / PROJECT_ROOT 在 main 内赋值（manifest 读取后）；扫描函数经闭包外的模块级变量读取
let SELF_NAME = null;
let PROJECT_ROOT = null;

/** __dirname 锚定计算式调用的本地目标：参数全字面量、解析目标在仓内且存在 → 绝对路径；否则 null。 */
function dirAnchoredLocalTarget(fromFile, argWindow) {
  const match = argWindow.match(DIR_ANCHORED_CALL_RE);
  if (!match) return null;
  const literals = [...match[1].matchAll(/["']([^"']*)["']/g)].map((literal) => literal[1]);
  if (literals.length === 0) return null;
  const resolved = resolve(dirname(fromFile), ...literals);
  if (PROJECT_ROOT !== null) {
    const rel = relative(PROJECT_ROOT, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) return null; // 仓外目标不归因（可能是外部访问）
  }
  return existsSync(resolved) ? resolved : null;
}

// ---------------------------------------------------------------------------
// 候选聚合
// ---------------------------------------------------------------------------

function slugify(key) {
  return `candidate-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function addSignal(store, key, signal, strength, resolver, locator) {
  let entry = store.get(key);
  if (!entry) {
    entry = { key, signals: new Set(), strength: "weak", suggestedResolver: null, suggestedLocator: null };
    store.set(key, entry);
  }
  entry.signals.add(signal);
  if (strength === "strong") entry.strength = "strong";
  // resolver/locator 先到先得（pkg 候选的定位符唯一；intent 词的 executable 建议唯一）
  if (resolver && !entry.suggestedResolver) entry.suggestedResolver = resolver;
  if (locator && !entry.suggestedLocator) entry.suggestedLocator = locator;
  return entry;
}

const EXECUTABLE_INTENT_WORDS = ["cli", "command", "executable", "binary", "shell", "命令行", "可执行"];

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const policyClasses = loadPolicyClasses();
  const intent = readIntent(opts.intentFile);
  const { manifest, sha256: manifestSha } = readManifest(opts.projectRoot);
  SELF_NAME = typeof manifest?.name === "string" ? manifest.name : null;
  PROJECT_ROOT = opts.projectRoot;

  console.error(`OK: 输入就绪（intent=${opts.intentFile}，packageManifest=${manifestSha === "absent" ? "absent" : manifestSha.slice(0, 12) + "…"}）`);

  const gitSet = gitScannableFiles(opts.projectRoot);
  if (gitSet === null) {
    console.error("WARN: git 不可用或非 git 仓：探测退化为全量目录扫描，gitignored 路径可能进入候选（处置时按 weak 语义人工核）；恢复动作：在 git 仓内运行或安装 git 后重跑");
  }
  const scopePatterns = parseDetectionScope(intent.text);
  const scopeMatchers = scopePatterns ? compileScopeMatchers(scopePatterns) : null;
  if (scopePatterns) {
    console.error(`OK: intent 交付面声明在场，探测范围收窄为 ${scopePatterns.length} 个 glob（${scopePatterns.join("、")}）`);
  }
  const fileFilter = (absPath, rel) => {
    if (gitSet !== null && !gitSet.has(rel)) return false;
    if (scopeMatchers !== null && !scopeMatchers.some((matcher) => matcher.test(rel))) return false;
    return true;
  };

  const { code, docs } = collectFiles(opts.projectRoot, new Set([opts.intentFile]), fileFilter);
  const codeFileSet = new Set(code);
  const sourceScanInputs = [];
  const scanned = new Map(); // absPath -> {rel, sha, text}
  const skipFile = (absPath, reason) => console.error(`WARN: 跳过扫描输入 ${relative(opts.projectRoot, absPath)}：${reason}`);
  for (const absPath of [...code, ...docs].sort()) {
    let raw;
    try {
      const stat = statSync(absPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SCAN_BYTES) { skipFile(absPath, `超过单文件扫描上限 ${MAX_SCAN_BYTES} 字节`); continue; }
      raw = readFileSync(absPath);
    } catch (error) {
      skipFile(absPath, error.message);
      continue;
    }
    const rel = relative(opts.projectRoot, absPath).split(sep).join("/");
    const sha = sha256(raw);
    sourceScanInputs.push(`${rel}:${sha}`);
    scanned.set(absPath, { rel, sha, text: raw.toString("utf8") });
  }

  const store = new Map();
  const unresolved = [];
  const unresolvedKeys = new Set();
  const addUnresolved = (signal, reason) => {
    const key = `${signal}||${reason}`;
    if (unresolvedKeys.has(key)) return;
    unresolvedKeys.add(key);
    unresolved.push({ signal, reason });
  };

  // ── 信号源 1：intent 词（weak；合并为单一候选，signals 保留逐词粒度）──
  const intentLower = intent.text.toLowerCase();
  const intentHits = [];
  for (const word of INTENT_GENERIC_WORDS) {
    if (intentLower.includes(word.toLowerCase())) intentHits.push(`intent:${word}`);
  }
  const manifestPlatformNames = new Set();
  if (manifest) {
    if (typeof manifest.name === "string" && manifest.name.trim() !== "") manifestPlatformNames.add(manifest.name);
    if (Array.isArray(manifest.keywords)) {
      for (const keyword of manifest.keywords) if (typeof keyword === "string" && keyword.trim() !== "") manifestPlatformNames.add(keyword);
    }
  }
  for (const name of [...manifestPlatformNames].sort()) {
    if (intentLower.includes(name.toLowerCase())) intentHits.push(`intent:${name}`);
  }
  if (intentHits.length > 0) {
    // executable 建议只在「intent 实际命中了可执行类词」时给出（查命中词，不查词表全集）
    const resolver = intentHits.some((hit) => EXECUTABLE_INTENT_WORDS.includes(hit.slice("intent:".length).toLowerCase()))
      ? "executable"
      : null;
    addSignal(store, "intent:external-terms", "intent 文件命中外部系统词", "weak", resolver, null);
    for (const hit of [...intentHits].sort()) store.get("intent:external-terms").signals.add(hit);
  }

  // ── 信号源 2：package.json 清单 ──
  // manifest 入口文件集合：词表 manifest-field 信号指向的宿主清单字段（如 pi.extensions，
  // 点路径形态——按路径逐层取值，字段缺失即无信号）
  const manifestEntryFiles = new Set();
  const manifestFieldKeys = new Map(); // field -> 聚合 key（manifest:<field>）
  if (manifest) {
    for (const entry of policyClasses) {
      for (const field of entry.manifestFields) {
        const fieldValue = readFieldPath(manifest, field);
        if (fieldValue === undefined) continue;
        addSignal(store, `manifest:${field}`, `manifest:${field}`, "strong", null, null);
        manifestFieldKeys.set(field, `manifest:${field}`);
        const entryRef = typeof fieldValue === "string"
          ? fieldValue
          : Array.isArray(fieldValue)
            ? fieldValue.find((item) => typeof item === "string")
            : null;
        if (typeof entryRef === "string" && entryRef.trim() !== "") manifestEntryFiles.add(join(opts.projectRoot, entryRef));
      }
    }
    // 普通依赖 / peerDependency（weak 线索；真实 import 时升级为 strong）
    for (const field of ["dependencies", "peerDependencies"]) {
      const deps = manifest[field];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const name of Object.keys(deps).sort()) {
          if (!isExternalSpecifier(name, SELF_NAME)) continue;
          addSignal(store, `pkg:${packageRootOf(name)}`, `manifest:${field}:${name}`, "weak", "installed-npm-package", packageRootOf(name));
        }
      }
    }
    // 包自身形态（weak）：type: module 与 bin 声明本包是 ESM/可执行包——外部宿主
    // （CLI 插件场景）据此消费，作为信号交给 reviewer 处置
    const selfShapeSignals = [];
    if (manifest.type === "module") selfShapeSignals.push("manifest:type-module");
    if (manifest.bin !== undefined) {
      const bins = typeof manifest.bin === "string" ? [manifest.name ?? "bin"] : Array.isArray(manifest.bin) ? [] : Object.keys(manifest.bin);
      for (const bin of bins.sort()) selfShapeSignals.push(`manifest:bin:${bin}`);
    }
    if (selfShapeSignals.length > 0) {
      addSignal(store, "manifest:self-shape", "manifest 包自身形态", "weak", null, null);
      for (const signal of selfShapeSignals) store.get("manifest:self-shape").signals.add(signal);
    }
  }

  // ── 信号源 3/4：源码与测试的导入、调用类、re-export 穿透 ──
  const manifestEntrySet = new Set([...manifestEntryFiles].filter((path) => codeFileSet.has(path)));
  // 本地 re-export 边（文件级）：absPath -> 直接 re-export 的外部包名 | 本地模块 absPath 列表
  const reexportExternal = new Map();
  const reexportLocal = new Map();
  const reexportUnlocatable = new Map(); // absPath -> 无法定位的本地 re-export 说明符列表
  for (const absPath of code) {
    const entry = scanned.get(absPath);
    if (!entry) continue;
    const externalPkgs = new Set();
    const localTargets = [];
    const unlocatable = [];
    for (const reexport of scanReexportsOnly(entry.text)) {
      if (isRelativeSpecifier(reexport.spec)) {
        const target = resolveLocalModule(absPath, reexport.spec, codeFileSet);
        if (target) localTargets.push(target);
        else unlocatable.push(reexport.spec);
      } else if (isExternalSpecifier(reexport.spec, SELF_NAME)) {
        externalPkgs.add(packageRootOf(reexport.spec));
      }
    }
    if (externalPkgs.size > 0) reexportExternal.set(absPath, externalPkgs);
    else if (localTargets.length > 0) reexportLocal.set(absPath, localTargets);
    else if (unlocatable.length > 0) reexportUnlocatable.set(absPath, unlocatable);
  }

  for (const absPath of [...code].sort()) {
    const entry = scanned.get(absPath);
    if (!entry) continue;
    const isTest = isTestFile(entry.rel);
    const scan = scanCodeFile(absPath, entry.rel, entry.text, policyClasses);
    const fileExternalPkgs = new Set();
    for (const imp of scan.imports) {
      if (isExternalSpecifier(imp.spec, SELF_NAME)) fileExternalPkgs.add(packageRootOf(imp.spec));
    }
    // 本地模块 re-export 穿透一层：import / 转发 re-export 本地模块 L，L 直接 re-export
    // 外部包 P → 归因 P；L 只 re-export 另一本地模块（链式）→ 穿透超过一层，unresolved（不猜）
    const localConsumptions = [
      ...scan.imports.filter((imp) => isRelativeSpecifier(imp.spec)).map((imp) => imp.spec),
      ...scan.reexports.filter((reexport) => isRelativeSpecifier(reexport.spec)).map((reexport) => reexport.spec),
    ];
    for (const spec of localConsumptions) {
      const target = resolveLocalModule(absPath, spec, codeFileSet);
      if (!target) {
        addUnresolved(`本地模块无法定位（${entry.rel} 引用 ${spec}）`, "import / re-export 的本地模块在项目源码集合中定位不到，无法判断其是否 re-export 外部包");
        continue;
      }
      if (reexportExternal.has(target)) {
        for (const pkg of [...reexportExternal.get(target)].sort()) {
          fileExternalPkgs.add(pkg);
          addSignal(store, `pkg:${pkg}`, `source:${entry.rel}:reexport-via:${relative(opts.projectRoot, target).split(sep).join("/")}`, "strong", "installed-npm-package", pkg);
        }
      } else if (reexportLocal.has(target)) {
        addUnresolved(`本地模块 re-export 链超过一层（${entry.rel} -> ${relative(opts.projectRoot, target).split(sep).join("/")} -> 本地模块）`, "re-export 只穿透一层；链式本地 re-export 无法静态归因外部源，停回人工");
      } else if (reexportUnlocatable.has(target)) {
        addUnresolved(`本地模块 re-export 目标无法定位（${entry.rel} -> ${relative(opts.projectRoot, target).split(sep).join("/")} -> ${reexportUnlocatable.get(target).join("、")}）`, "被穿透的本地模块 re-export 的目标在项目源码集合中定位不到，无法归因外部源，停回人工");
      }
    }
    // 真实 SDK import（源码 strong / 测试 strong）
    for (const pkg of [...fileExternalPkgs].sort()) {
      addSignal(store, `pkg:${pkg}`, `${isTest ? "test" : "source"}:${entry.rel}:import:${pkg}`, "strong", "installed-npm-package", pkg);
    }
    // manifest 入口文件获得 extension-entrypoint 类信号，归入对应 manifest 字段候选
    if (manifestEntrySet.has(absPath)) {
      for (const field of manifestFieldKeys.keys()) {
        addSignal(store, manifestFieldKeys.get(field), `source:${entry.rel}:call-class:extension-entrypoint`, "strong", null, null);
      }
    }
    // 调用类信号：归因到文件 import 的外部包候选；无外部包 import 时独立成调用类候选
    for (const classId of [...new Set(scan.callClasses)].sort()) {
      const signal = `source:${entry.rel}:call-class:${classId}`;
      if (fileExternalPkgs.size > 0) {
        for (const pkg of [...fileExternalPkgs].sort()) addSignal(store, `pkg:${pkg}`, signal, "strong", "installed-npm-package", pkg);
      } else {
        addSignal(store, `callclass:${classId}`, signal, "strong", null, null);
      }
    }
    // 测试 harness-only（weak）：测试文件无任何外部包 import 时登记自写 harness 形态
    if (isTest && fileExternalPkgs.size === 0) {
      addSignal(store, "test:harness-only", `test:${entry.rel}:harness-only`, "weak", null, null);
    }
    // unresolved 形态：动态 import / 运行时代码生成 / 计算式外部成员访问
    if (scan.dynamicImports > 0) {
      addUnresolved(`动态 import（${entry.rel}）`, "动态 import 目标不是字符串字面量，无法静态归因外部契约");
    }
    for (const label of scan.runtimeGen) {
      addUnresolved(`运行时代码生成（${entry.rel}：${label}）`, "eval / Function / vm 在运行时生成调用，静态扫描无法归类外部契约");
    }
    for (const binding of scan.computedAccess) {
      addUnresolved(`计算式外部成员访问（${entry.rel} 的绑定 ${binding}）`, "外部包绑定上的方括号访问目标不是字面量，无法静态判定外部 API 调用类");
    }
  }

  // ── 信号源 5：项目文档平台说明路径（weak）──
  for (const absPath of docs.sort()) {
    const entry = scanned.get(absPath);
    if (!entry) continue;
    if (!isDocSignalPath(entry.rel)) continue;
    for (const line of entry.text.split("\n")) {
      const lower = line.toLowerCase();
      if (!DOC_PLATFORM_WORDS.some((word) => lower.includes(word))) continue;
      for (const match of line.matchAll(URL_RE)) {
        let host;
        try {
          host = new URL(match[0]).host;
        } catch {
          continue;
        }
        if (!host) continue;
        addSignal(store, `doc:${host}`, `doc:${entry.rel}:url:${host}`, "weak", null, null);
      }
    }
  }

  // ── 组装输出（排序固定：同输入两次运行逐字节一致）──
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const candidates = [...store.values()]
    .map((entry) => ({
      id: slugify(entry.key),
      strength: entry.strength,
      signals: [...entry.signals].sort(byCodeUnit),
      suggestedResolver: entry.suggestedResolver,
      suggestedLocator: entry.suggestedLocator,
    }))
    .sort((a, b) => byCodeUnit(a.id, b.id));

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    inputHashes: {
      intent: intent.sha256,
      packageManifest: manifestSha,
      sourceScanInputs: sourceScanInputs.sort(byCodeUnit),
    },
    detectionScope: scopePatterns ? { source: "intent", patterns: scopePatterns } : null,
    candidates,
    unresolved: unresolved.sort((a, b) => byCodeUnit(a.signal, b.signal) || byCodeUnit(a.reason, b.reason)),
  };

  console.log(JSON.stringify(snapshot, null, 2));
  const strongCount = candidates.filter((candidate) => candidate.strength === "strong").length;
  console.error(
    `OK: 候选探测完成（候选 ${candidates.length}：strong ${strongCount} / weak ${candidates.length - strongCount}；` +
      `unresolved ${unresolved.length}；扫描输入 ${sourceScanInputs.length} 个文件）`,
  );
}

function scanReexportsOnly(text) {
  const specs = [];
  for (const match of text.matchAll(EXPORT_FROM_RE)) specs.push({ spec: match[1] });
  return specs;
}

function isTestFile(rel) {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.[cm]?[jt]sx?\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

function isDocSignalPath(rel) {
  const top = rel.split("/")[0];
  return DOC_SIGNAL_DIRS.includes(top) || !rel.includes("/");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

export { compileScopeMatchers, dirAnchoredLocalTarget, globToRegExp, loadPolicyClasses, parseDetectionScope, scanCodeFile, slugify };
