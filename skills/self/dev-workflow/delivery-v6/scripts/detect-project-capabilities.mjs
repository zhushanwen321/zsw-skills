#!/usr/bin/env node
// detect-project-capabilities.mjs —— 项目静态能力快照（只读探测，设计《V5 三技能结构化交付优化》第二步）
//
// 为什么有本脚本：验收起草、tech-design-v6 T3、dev-flow-v6 D0 三个阶段各自理解项目验证能力
// （设计 §1.2）——同一 package.json 脚本被反复现场辨认，已批准的命令到执行期才发现不可用。
// 本脚本把「项目声明了什么能力」一次探测成结构化快照（design §5.1 schemaVersion 1），
// 三个阶段读同一份派生缓存；输入哈希变化后重建，不缓存跨 revision 的「执行通过」结论
//（§2.2 非目标：快照里没有 probe.status，没有执行证据——实际执行只走现有 smoke / dry-run / 回执）。
//
// 用法：
//   node detect-project-capabilities.mjs --project-root <root> [--out <path>] [--skills-root <dir>]
//     探测并把快照写入 --out（缺省 = skill-data 寻址段 dev-flow 段 <slug>/project-capabilities.json，
//     工作区形态带 <worktreeName> 层；寻址算法与 dev-flow 家族一致，见运行注释）。
//     stdout 输出快照 JSON；unknown 非空时向 stderr 输出警示（退出码仍 0——unknown 是快照的合法内容）。
//   node detect-project-capabilities.mjs --project-root <root> [--out <path>] --check
//     重探测并与盘上快照比对：inputHashes 变化报「输入已变化」；值漂移报「不一致（疑似手改）」。
//   node detect-project-capabilities.mjs --validate <snapshot>
//     结构校验已有快照：命令必有来源、资产路径存在且 sha256 一致、unknown 不得当可用、
//     不得出现执行证据字段（design §7.1）。校验不依赖重探测。
//   node detect-project-capabilities.mjs --help
//
// 退出码：0 成功（含 --check / --validate 通过）；1 输入不合法 / 校验失败 / --check 不通过；2 用法错误。
//
// 探测源（全部只读，design §5.1）：
//   1. package.json scripts → 命令来源 kind=package-script（经包管理器 run 通道，程序名由 lockfile 判定）；
//   2. 测试配置文件存在性 → 命令来源 kind=test-config（只认文件名，不解析配置语义；
//      runner 调用形态 = 该 runner 的标准无.watch 调用，属候选命令，可用性由实际执行检验）；
//   3. 项目 AGENTS.md 的 verification skill 声明 → 场景清单定位（声明制：AGENTS.md 只用于定位权威来源，
//      手写命令不当作已执行事实；定位不到记 unknowns，不猜路径）。
//
// 纠错口径（design §8 第二步）：快照有问题 → 修项目来源或本探测适配层后重跑，禁止手改快照。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const GENERATOR = { name: "delivery-v6/detect-project-capabilities.mjs", version: 1 };
const SCHEMA_VERSION = 1;
const SNAPSHOT_FILENAME = "project-capabilities.json";

// ---------------------------------------------------------------------------
// skill-data 寻址探针（内嵌同款最小探针，注明来源）
// 算法唯一权威源 = <zsw-skills 检出根>/skills/self/dev-workflow/workflows/src/skill-data.shared.ts
// 的 NODE_PROJECT_ADDRESS（本串与其逐字节一致；scripts/tests/project-capabilities-v6.test.mjs
// 有 parity 断言防漂移）。为什么内嵌而不是 import：单源文件为 workflow 构建输入、无模块导出
//（其头注形态约束 ①），本脚本是独立技能脚本、不经 build-workflows.mjs 构建注入——两个「并入」
// 法定通道（构建期注入 / 显式 import）都不可用，按 skill-data-addressing.md 并入约定取内嵌 +
// 注明来源 + parity 断言。双形态输出 { form, slug, workspaceRoot?, worktreeName? }。
// ---------------------------------------------------------------------------
const NODE_PROJECT_ADDRESS = "const fs=require('fs'),cp=require('child_process'),cr=require('crypto'),pt=require('path');const root=fs.realpathSync(process.argv[1]);const slugOf=x=>x.split('/').filter(Boolean).pop()+'-'+cr.createHash('sha256').update(x).digest('hex').slice(0,8);const norm=(x,b)=>{const a=pt.isAbsolute(x)?x:pt.join(b,x);try{return fs.realpathSync(a)}catch(e){return a}};const single=()=>JSON.stringify({form:'single',slug:slugOf(root)});const detect=()=>{const g=cp.spawnSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'});if(g.status!==0||!String(g.stdout||'').trim())return single();const cd=norm(String(g.stdout).trim(),root);const w=cp.spawnSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'});if(w.status!==0)return single();const parent=pt.dirname(root);const sibs=[];for(const line of String(w.stdout||'').split(String.fromCharCode(10))){if(line.indexOf('worktree ')!==0)continue;const wt=norm(line.slice(9),root);const gw=cp.spawnSync('git',['-C',wt,'rev-parse','--git-common-dir'],{encoding:'utf8'});if(gw.status!==0||norm(String(gw.stdout||'').trim(),wt)!==cd)continue;if(pt.dirname(wt)===parent)sibs.push(wt)}if(sibs.length>=2)return JSON.stringify({form:'workspace',slug:slugOf(norm(parent,parent)),workspaceRoot:parent,worktreeName:root.split('/').filter(Boolean).pop()});return single()};process.stdout.write(detect())";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

/** 跑寻址探针取双形态寻址结果（dev-flow 段落点判定）；探针失败按输入不合法处理 */
function detectAddressForm(projectRoot) {
  const run = spawnSync(process.execPath, ["-e", NODE_PROJECT_ADDRESS, projectRoot], { encoding: "utf8" });
  if (run.status !== 0) {
    console.error(
      `FAIL: input: projectRoot 无法解析为 skill-data 寻址（寻址探针失败，exit ${run.status}）：${String(run.stderr).trim()}` +
        `；权威源：入参 --project-root（寻址算法 = workflows/src/skill-data.shared.ts）；` +
        `恢复动作：确认 --project-root 目录存在且可读后重跑本命令`,
    );
    process.exit(1);
  }
  return JSON.parse(run.stdout);
}

/**
 * 缺省输出路径 = skill-data 寻址段 dev-flow 段 + project-capabilities.json
 *（寻址约定见 skills/self/dev-workflow/references/skill-data-addressing.md §2：
 * dev-flow 段 worktree 级隔离——快照探测的是本检出点的文件，工作区形态带 <worktreeName> 层）
 */
function resolveDefaultSnapshotPath(projectRoot) {
  const address = detectAddressForm(projectRoot);
  const segment = address.form === "workspace"
    ? join(homedir(), ".agents", "skill-data", "dev-flow", address.slug, address.worktreeName)
    : join(homedir(), ".agents", "skill-data", "dev-flow", address.slug);
  return join(segment, SNAPSHOT_FILENAME);
}

/** inputHashes 键：projectRoot 内用相对路径（快照可随 projectRoot 携带），段外文件用绝对路径 */
function inputHashKey(projectRoot, absPath) {
  const rel = relative(projectRoot, absPath);
  return rel.startsWith("..") ? absPath : rel;
}

// ---------------------------------------------------------------------------
// 探测源 1：package.json scripts（kind=package-script）
// 命令形态 = 包管理器 run 通道（program 由 lockfile 判定，缺省 npm——node 生态缺省通道）；
// 不解析脚本值里的 shell 串：脚本本体才是项目声明，run 通道只是标准调用形态。
// ---------------------------------------------------------------------------

const PACKAGE_MANAGER_LOCKFILES = [
  { program: "pnpm", lockfile: "pnpm-lock.yaml" },
  { program: "yarn", lockfile: "yarn.lock" },
  { program: "bun", lockfile: "bun.lockb" },
  { program: "bun", lockfile: "bun.lock" },
  { program: "npm", lockfile: "package-lock.json" },
  { program: "npm", lockfile: "npm-shrinkwrap.json" },
];

/** 返回 { commands, unknown }：package.json 不可解析等来源损坏走 unknown 披露，不静默跳过 */
function probePackageCommands(projectRoot, inputHashes) {
  const manifestPath = join(projectRoot, "package.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return { commands: [], unknown: null };
  inputHashes.set(inputHashKey(projectRoot, manifestPath), fileSha256(manifestPath));
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts;
  } catch {
    // package.json 存在但不可解析：来源已坏，按 unknown 披露而不是静默跳过
    return { commands: [], unknown: `package.json 存在但不是合法 JSON（${manifestPath}）；恢复动作：修复 package.json 语法后重跑探测` };
  }
  if (!scripts || typeof scripts !== "object") return { commands: [], unknown: null };
  const pm = PACKAGE_MANAGER_LOCKFILES.find((entry) => existsSync(join(projectRoot, entry.lockfile))) ?? { program: "npm" };
  const commands = Object.keys(scripts)
    .sort()
    .filter((name) => typeof scripts[name] === "string" && scripts[name].trim() !== "")
    .map((name) => ({
      id: `script.${name}`,
      command: { program: pm.program, args: ["run", name] },
      source: { kind: "package-script", ref: `scripts.${name}` },
    }));
  return { commands, unknown: null };
}

// ---------------------------------------------------------------------------
// 探测源 2：测试配置文件存在性（kind=test-config）
// 只认固定候选表里的文件名（存在性事实），不解析配置语义（§5.1：快照只保存声明）；
// 每个 runner 取其候选序中第一个存在的文件登记一条候选命令。
// ---------------------------------------------------------------------------

const TEST_CONFIG_CANDIDATES = [
  { runner: "vitest", args: ["vitest", "run"], files: ["vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vitest.workspace.ts", "vitest.workspace.mts", "vitest.workspace.js"] },
  { runner: "jest", args: ["jest"], files: ["jest.config.ts", "jest.config.mts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"] },
  { runner: "playwright", args: ["playwright", "test"], files: ["playwright.config.ts", "playwright.config.mts", "playwright.config.js", "playwright.config.mjs"] },
  { runner: "mocha", args: ["mocha"], files: [".mocharc.js", ".mocharc.cjs", ".mocharc.mjs", ".mocharc.yaml", ".mocharc.yml", ".mocharc.json"] },
  { runner: "cypress", args: ["cypress", "run"], files: ["cypress.config.js", "cypress.config.ts", "cypress.config.mjs"] },
  { runner: "karma", args: ["karma", "start", "--single-run"], files: ["karma.conf.js", "karma.conf.cjs", "karma.conf.ts"] },
];

// code-unit 比较（a < b ? -1 : a > b ? 1 : 0）：localeCompare 依赖 ICU 环境，跨机器排序不保证
// 一致——快照要求同输入逐字节可比（--check 值比对的前提），所有排序一律用码元比较
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function probeTestConfigCommands(projectRoot, inputHashes) {
  const commands = [];
  for (const candidate of TEST_CONFIG_CANDIDATES) {
    const matched = candidate.files.map((file) => join(projectRoot, file)).find((path) => existsSync(path) && statSync(path).isFile());
    if (!matched) continue;
    inputHashes.set(inputHashKey(projectRoot, matched), fileSha256(matched));
    commands.push({
      id: `test.${candidate.runner}`,
      command: { program: "npx", args: [...candidate.args] },
      source: { kind: "test-config", ref: inputHashKey(projectRoot, matched) },
    });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// 探测源 3：AGENTS.md 的 verification skill 声明 → 场景清单定位（声明制，定位不到记 unknown）
// ---------------------------------------------------------------------------

const DECLARATION_LINE_RE = /verification[ _-]skill/i;
// 显式「未声明」行 = 该项目没有 verification skill（与 tech-design-v6 T3 声明制口径一致），
// 不记 unknown——「没有」是项目事实，不是探测失败
const NEGATIVE_DECLARATION_RE = /未声明|不使用|未配置|不存在|not\s+declared|no\s+verification/i;
const SKILL_NAME_STOPWORDS = new Set(["verification", "skill", "skills", "verify", "runner", "wrapper", "scenario", "scenarios", "api", "verification-skill"]);
// 场景清单文件名特征（已安装技能目录内的定位特征；定位不到走 unknown，不向项目内猜路径）
const MANIFEST_NAME_RE = /scenario|feature-?map|场景|覆盖矩阵/i;
const MANIFEST_EXTS = new Set([".json", ".md"]);
const MANIFEST_WALK_DEPTH = 3;

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 从 AGENTS.md 提取 verification skill 声明：技能名 + 反引号内显式清单路径。
 * 负向判定只在「整行无任何反引号 token」时成立：行内带 token 但含负向词（如
 * 「`fake-verify`（不使用 watch 模式）」）不得静默丢声明——token 照常处理；处理完
 * 无可定位名称/路径时由 probeVerificationAssets 记 unknown（声明存在但不可用）。
 */
function extractDeclaration(text) {
  const lines = text.split("\n").filter((line) => DECLARATION_LINE_RE.test(line));
  const names = [];
  const manifestPaths = [];
  let declared = false;
  let negative = false;
  for (const line of lines) {
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter((token) => token !== "");
    if (tokens.length === 0 && NEGATIVE_DECLARATION_RE.test(line)) {
      negative = true;
      continue;
    }
    declared = true;
    for (const token of tokens) {
      const pathLike = token.includes("/") || token.startsWith("~") || /\.(json|ya?ml|md)$/i.test(token);
      if (pathLike) {
        manifestPaths.push(token);
      } else if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(token) && !SKILL_NAME_STOPWORDS.has(token.toLowerCase()) && !names.includes(token)) {
        names.push(token);
      }
    }
  }
  return { declared, negative, names, manifestPaths };
}

/** 已安装技能目录内定位场景清单候选（深度 ≤3；候选唯一才采纳，多个 = 声明未指明唯一入口） */
function findManifestCandidates(skillDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MANIFEST_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile() && MANIFEST_EXTS.has(extname(entry.name)) && MANIFEST_NAME_RE.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(skillDir, 1);
  return found;
}

/** 场景清单 → 验证资产登记：JSON 清单逐条目登记，md 清单整体登记为清单资产 */
function assetsFromManifest(projectRoot, manifestPath, sourceRef, inputHashes, unknowns) {
  // 清单是被消费的来源文件（失效口径 §5.1）：条目增删 / 指向变化必须让快照失效重建
  inputHashes.set(inputHashKey(projectRoot, manifestPath), fileSha256(manifestPath));
  if (extname(manifestPath) !== ".json") {
    return {
      assets: [{ id: basename(manifestPath).replace(/\.[^.]+$/, ""), kind: "scenario-manifest", path: manifestPath, sha256: fileSha256(manifestPath), source: { kind: "verification-skill-declaration", ref: sourceRef } }],
      consumed: true,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    unknowns.push(`场景清单不是合法 JSON（${manifestPath}）；恢复动作：修复清单语法后重跑探测`);
    return { assets: [], consumed: true };
  }
  // 逐条目登记：数组成员对象带 path 类字段才算场景条目（清单结构以项目 verification skill 为权威，
  // 这里只消费「指向文件」的最小字段）；条目指向的文件不存在 = 能力缺口，记 unknown 不登记假资产
  const PATH_KEYS = ["path", "scenario", "file", "script"];
  const ID_KEYS = ["id", "nodeId", "name"];
  const arrays = Object.values(manifest).filter((value) => Array.isArray(value));
  const entries = arrays.flat().filter((item) => item !== null && typeof item === "object" && !Array.isArray(item));
  const assets = [];
  const usedIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const pathKey = PATH_KEYS.find((key) => typeof entry[key] === "string" && entry[key].trim() !== "");
    if (!pathKey) continue;
    const rawPath = expandHome(entry[pathKey].trim());
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(dirname(manifestPath), rawPath);
    const idSource = ID_KEYS.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim() !== "") ?? basename(absPath).replace(/\.[^.]+$/, "");
    let id = String(idSource);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${idSource}-${suffix}`;
    usedIds.add(id);
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      unknowns.push(`场景清单 ${manifestPath} 条目「${id}」指向的文件不存在（${absPath}）；恢复动作：修复清单条目或补建场景文件后重跑探测`);
      continue;
    }
    // 场景文件同为被消费的来源文件（§5.1「所有被消费的路由与来源文件」）：内容变化必须让
    // 快照失效重建，--check 以「输入已变化」报告（资产 sha256 校验仍保留作第二道核对）
    inputHashes.set(inputHashKey(projectRoot, absPath), fileSha256(absPath));
    assets.push({ id, kind: "scenario", path: absPath, sha256: fileSha256(absPath), source: { kind: "scenario-manifest", ref: `${basename(manifestPath)}#${id}` } });
  }
  return { assets, consumed: true };
}

/** 探测源 3 总入口：AGENTS.md 消费 + 声明定位 + unknown 登记 */
function probeVerificationAssets(projectRoot, skillsRoot, inputHashes, unknowns) {
  const agentsPath = join(projectRoot, "AGENTS.md");
  if (!existsSync(agentsPath) || !statSync(agentsPath).isFile()) return [];
  inputHashes.set(inputHashKey(projectRoot, agentsPath), fileSha256(agentsPath));
  const declaration = extractDeclaration(readFileSync(agentsPath, "utf8"));
  if (!declaration.declared && !declaration.negative) return [];
  // 命中了声明行但提取不出可定位的技能名/清单路径（无 token 的非负向行、或 token 全
  // 不合形态）：声明存在但不可用——记 unknown 交设计者处置，不静默丢声明
  if (declaration.declared && declaration.names.length === 0 && declaration.manifestPaths.length === 0) {
    unknowns.push(`AGENTS.md 声明了 verification skill 但声明行无可定位的技能名或清单路径；恢复动作：在 AGENTS.md 声明行用反引号写明技能名或清单路径（如 \`<skill-name>\` 或 \`<清单路径>\`）后重跑探测`);
    return [];
  }

  const assets = [];
  // 声明行内反引号路径 = 项目显式指明的清单位置（声明制优先），存在即采纳
  for (const token of declaration.manifestPaths) {
    const absPath = resolve(projectRoot, expandHome(token));
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      const result = assetsFromManifest(projectRoot, absPath, `AGENTS.md:${token}`, inputHashes, unknowns);
      assets.push(...result.assets);
    } else {
      unknowns.push(`AGENTS.md 声明的场景清单不存在（${absPath}）；恢复动作：核对 AGENTS.md 声明行路径拼写后重跑探测`);
    }
  }
  // 技能名 → 按安装规范定位 ~/.agents/skills/<name>/（安装位置是技能安装规范事实，不是路径猜测），
  // 目录内按名称特征找清单；找不到 / 多个候选 = unknown，不猜
  for (const name of declaration.names) {
    const skillDir = join(skillsRoot, name);
    if (!existsSync(skillDir)) {
      unknowns.push(`verification skill「${name}」已声明但安装目录不存在（${skillDir}）；恢复动作：核对 AGENTS.md 声明拼写、安装该技能，或在声明行用反引号补写清单路径后重跑探测`);
      continue;
    }
    const candidates = findManifestCandidates(skillDir);
    if (candidates.length === 1) {
      const result = assetsFromManifest(projectRoot, candidates[0], `AGENTS.md:${name}`, inputHashes, unknowns);
      assets.push(...result.assets);
    } else if (candidates.length === 0) {
      unknowns.push(`verification skill「${name}」安装目录内未定位到场景清单（${skillDir} 下名称含 scenario / feature-map / 场景 / 覆盖矩阵 的 .json/.md，深度 ≤${MANIFEST_WALK_DEPTH}）；恢复动作：在 AGENTS.md 声明行用反引号补写清单路径，或整理场景库后重跑探测`);
    } else {
      unknowns.push(`verification skill「${name}」定位到 ${candidates.length} 个候选场景清单，唯一入口未声明（${candidates.join("、")}）；恢复动作：在 AGENTS.md 声明行用反引号写明唯一清单路径后重跑探测`);
    }
  }
  return assets;
}

// ---------------------------------------------------------------------------
// 快照组装：字段序固定、集合排序固定——同输入重探测逐字节可比（--check 值比对的前提）
// ---------------------------------------------------------------------------

function buildSnapshot(projectRoot, skillsRoot) {
  const inputHashes = new Map();
  const unknowns = [];
  const packageProbe = probePackageCommands(projectRoot, inputHashes);
  const commands = [...packageProbe.commands, ...probeTestConfigCommands(projectRoot, inputHashes)];
  const verificationAssets = probeVerificationAssets(projectRoot, skillsRoot, inputHashes, unknowns);
  if (packageProbe.unknown) unknowns.push(packageProbe.unknown);
  const sortedHashes = Object.fromEntries([...inputHashes.entries()].sort(([a], [b]) => byCodeUnit(a, b)));
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { ...GENERATOR },
    projectRoot,
    observedAt: new Date().toISOString(),
    inputHashes: sortedHashes,
    commands: commands.sort((a, b) => byCodeUnit(a.id, b.id)),
    verificationAssets: verificationAssets.sort((a, b) => byCodeUnit(a.id, b.id)),
    unknowns: unknowns.sort(byCodeUnit),
  };
}

// ---------------------------------------------------------------------------
// 快照校验（design §7.1：命令有来源；资产路径存在且 sha256 一致；unknown 不被当可用；
// 不含执行通过状态）。执行证据禁入的机器形态 = 白名单 schema 校验：快照结构是封闭集合，
// 键不在已知结构集合内一律拒绝（黑名单词形扫描会被 didPass / success / outcome 等
// 执行语义键绕过——白名单不存在绕过面）
// ---------------------------------------------------------------------------

const SNAPSHOT_KEYS = new Set(["schemaVersion", "generator", "projectRoot", "observedAt", "inputHashes", "commands", "verificationAssets", "unknowns"]);
const GENERATOR_KEYS = new Set(["name", "version"]);
const COMMAND_KEYS = new Set(["id", "command", "source"]);
const COMMAND_INNER_KEYS = new Set(["program", "args"]);
const SOURCE_KEYS = new Set(["kind", "ref"]);
const ASSET_KEYS = new Set(["id", "kind", "path", "sha256", "source"]);
const COMMAND_SOURCE_KINDS = new Set(["package-script", "test-config"]);
const ASSET_KINDS = new Set(["scenario", "scenario-manifest"]);
const ASSET_SOURCE_KINDS = new Set(["scenario-manifest", "verification-skill-declaration"]);

function validateSnapshot(snapshot) {
  const errors = [];
  // 白名单键校验：任一层级的对象出现未知键即拒绝——快照只保存声明与来源，执行语义字段
  //（无论叫 probe.status、didPass 还是 outcome）混入就会被消费方误当执行结论跨 revision 复用（§10 风险 2）
  const rejectUnknownKeys = (node, allowed, label) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      if (!allowed.has(key)) errors.push(`${label}出现未知键「${key}」——快照结构是封闭集合（允许键：${[...allowed].join(" / ")}），执行语义字段（probe / status / didPass / outcome 等）一律禁入；权威源：detect-project-capabilities.mjs 输出契约（--help）；恢复动作：重跑探测命令重建快照，不手改快照`);
    }
  };

  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return ["快照不是 JSON 对象；权威源：detect-project-capabilities.mjs 输出契约（--help）；恢复动作：重跑探测命令重建快照"];
  }
  rejectUnknownKeys(snapshot, SNAPSHOT_KEYS, "快照顶层");
  if (snapshot.generator === null || typeof snapshot.generator !== "object" || Array.isArray(snapshot.generator)) {
    errors.push("generator 缺失或不是对象（溯源元数据：生成器名与版本）；权威源：design §4 生成规则 1；恢复动作：重跑探测命令重建快照");
  } else {
    rejectUnknownKeys(snapshot.generator, GENERATOR_KEYS, "generator");
    if (typeof snapshot.generator.name !== "string" || snapshot.generator.name.trim() === "") errors.push("generator.name 缺失或为空；恢复动作：重跑探测命令重建快照");
    if (typeof snapshot.generator.version !== "number") errors.push("generator.version 缺失或不是数字；恢复动作：重跑探测命令重建快照");
  }
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}（当前 ${JSON.stringify(snapshot.schemaVersion ?? null)}）；权威源：design §5.1 schemaVersion 1；恢复动作：重跑探测命令重建快照`);
  }
  for (const [field, label] of [["projectRoot", "项目根"], ["observedAt", "观测时间"]]) {
    if (typeof snapshot[field] !== "string" || snapshot[field].trim() === "") errors.push(`${label} ${field} 缺失或为空；权威源：design §5.1 快照结构；恢复动作：重跑探测命令重建快照`);
  }
  const hashes = snapshot.inputHashes;
  if (hashes === null || typeof hashes !== "object" || Array.isArray(hashes)) {
    errors.push("inputHashes 缺失或不是对象；权威源：design §5.1（被消费的来源文件全部入哈希）；恢复动作：重跑探测命令重建快照");
  } else {
    for (const [key, value] of Object.entries(hashes)) {
      if (typeof key !== "string" || key.trim() === "") errors.push("inputHashes 出现空键；恢复动作：重跑探测命令重建快照");
      if (!/^[0-9a-f]{64}$/.test(String(value))) errors.push(`inputHashes[${key}] 不是 sha256 十六进制值；恢复动作：重跑探测命令重建快照`);
    }
  }

  const ids = new Set();
  const commands = Array.isArray(snapshot.commands) ? snapshot.commands : null;
  if (!commands) errors.push("commands 缺失或不是数组；权威源：design §5.1；恢复动作：重跑探测命令重建快照");
  else {
    for (const command of commands) {
      if (!command || typeof command !== "object" || Array.isArray(command)) { errors.push("commands 存在非对象条目；恢复动作：重跑探测命令重建快照"); continue; }
      rejectUnknownKeys(command, COMMAND_KEYS, "commands 条目");
      rejectUnknownKeys(command.command, COMMAND_INNER_KEYS, `命令 ${command.id ?? "?"} 的 command`);
      rejectUnknownKeys(command.source, SOURCE_KEYS, `命令 ${command.id ?? "?"} 的 source`);
      if (!command || typeof command.id !== "string" || command.id.trim() === "") { errors.push("commands 存在缺 id 的条目；恢复动作：重跑探测命令重建快照"); continue; }
      if (ids.has(command.id)) errors.push(`命令 id 重复：${command.id}；恢复动作：重跑探测命令重建快照`);
      ids.add(command.id);
      if (!command.command || typeof command.command.program !== "string" || command.command.program.trim() === "") errors.push(`命令 ${command.id} 缺 command.program；权威源：design §5.1 命令结构；恢复动作：重跑探测命令重建快照`);
      if (!Array.isArray(command.command?.args) || !command.command.args.every((arg) => typeof arg === "string")) errors.push(`命令 ${command.id} 的 command.args 缺失或含非字符串；恢复动作：重跑探测命令重建快照`);
      if (!command.source || !COMMAND_SOURCE_KINDS.has(command.source.kind)) errors.push(`命令 ${command.id} 的 source.kind 非法（${JSON.stringify(command.source?.kind ?? null)}，词表：package-script / test-config）——命令必须有来源；权威源：design §7.1 第 1 条；恢复动作：重跑探测命令重建快照`);
      if (typeof command.source?.ref !== "string" || command.source.ref.trim() === "") errors.push(`命令 ${command.id} 缺 source.ref（来源定位）；权威源：design §7.1 第 1 条；恢复动作：重跑探测命令重建快照`);
    }
  }

  const assets = Array.isArray(snapshot.verificationAssets) ? snapshot.verificationAssets : null;
  if (!assets) errors.push("verificationAssets 缺失或不是数组；权威源：design §5.1；恢复动作：重跑探测命令重建快照");
  else {
    for (const asset of assets) {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) { errors.push("verificationAssets 存在非对象条目；恢复动作：重跑探测命令重建快照"); continue; }
      rejectUnknownKeys(asset, ASSET_KEYS, "verificationAssets 条目");
      rejectUnknownKeys(asset.source, SOURCE_KEYS, `资产 ${asset.id ?? "?"} 的 source`);
      if (!asset || typeof asset.id !== "string" || asset.id.trim() === "") { errors.push("verificationAssets 存在缺 id 的条目；恢复动作：重跑探测命令重建快照"); continue; }
      if (ids.has(asset.id)) errors.push(`资产 id 与命令 id 冲突：${asset.id}；恢复动作：重跑探测命令重建快照`);
      ids.add(asset.id);
      if (!ASSET_KINDS.has(asset.kind)) errors.push(`资产 ${asset.id} 的 kind 非法（${JSON.stringify(asset.kind ?? null)}，词表：scenario / scenario-manifest）；恢复动作：重跑探测命令重建快照`);
      if (typeof asset.path !== "string" || !isAbsolute(asset.path)) errors.push(`资产 ${asset.id} 的 path 缺失或不是绝对路径；权威源：design §5.1 资产结构；恢复动作：重跑探测命令重建快照`);
      else if (!existsSync(asset.path) || !statSync(asset.path).isFile()) errors.push(`资产 ${asset.id} 路径不存在或不是文件（${asset.path}）；权威源：快照 verificationAssets 登记；恢复动作：修复资产来源（清单或场景文件）后重跑探测`);
      else if (typeof asset.sha256 !== "string" || asset.sha256 !== fileSha256(asset.path)) errors.push(`资产 ${asset.id} 内容哈希与当前文件不一致（${asset.path}）——资产在探测后已变化；权威源：快照 sha256 字段；恢复动作：重跑探测命令重建快照`);
      if (!asset.source || !ASSET_SOURCE_KINDS.has(asset.source.kind)) errors.push(`资产 ${asset.id} 的 source.kind 非法（${JSON.stringify(asset.source?.kind ?? null)}，词表：scenario-manifest / verification-skill-declaration）——资产必须有来源；权威源：design §7.1 第 1 条；恢复动作：重跑探测命令重建快照`);
      if (typeof asset.source?.ref !== "string" || asset.source.ref.trim() === "") errors.push(`资产 ${asset.id} 缺 source.ref；恢复动作：重跑探测命令重建快照`);
    }
  }

  const unknowns = Array.isArray(snapshot.unknowns) ? snapshot.unknowns : null;
  if (!unknowns || !unknowns.every((item) => typeof item === "string" && item.trim() !== "")) {
    errors.push("unknowns 缺失、不是数组或含空条目；权威源：design §5.1（无法确定的能力显式记 unknown）；恢复动作：重跑探测命令重建快照");
  } else {
    // unknown 不得被当可用（§7.1 第 1 条）：同一 id 既登记为可用命令/资产又挂在 unknown 清单 = 自相矛盾。
    // 注：探测自产的 unknown 是带恢复动作的长句、不会与 id 撞型；该校验面向手造输入做尽力近似
    for (const item of unknowns) {
      if (ids.has(item)) errors.push(`「${item}」同时出现在 unknowns 与可用命令/资产清单——unknown 不得被当可用；恢复动作：核对探测结果后重跑探测命令`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// --check：重探测与盘上快照比对（观测元数据 observedAt 与 generator 溯源字段不参与内容等价比较）
// ---------------------------------------------------------------------------

function comparablePart(snapshot) {
  return JSON.stringify({ inputHashes: snapshot.inputHashes, commands: snapshot.commands, verificationAssets: snapshot.verificationAssets, unknowns: snapshot.unknowns });
}

function checkSnapshot(snapshotPath, projectRoot, skillsRoot) {
  let disk;
  try {
    disk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    console.error(`FAIL: input: 盘上快照不可读或不是合法 JSON（${snapshotPath}，${error.message}）；权威源：detect-project-capabilities.mjs 探测输出；恢复动作：先跑 node ~/.agents/skills/delivery-v6/scripts/detect-project-capabilities.mjs --project-root <root> 生成快照，再执行 --check`);
    process.exit(1);
  }
  // 判序：输入哈希比对先于完整结构校验——输入已变化时漂移是预期结果，先报「输入已变化」
  //（结构校验的资产哈希核对会把同一事实误报成结构问题）；结构非法但输入未变时才报结构问题
  if (disk === null || typeof disk !== "object" || Array.isArray(disk) || disk.inputHashes === null || typeof disk.inputHashes !== "object" || Array.isArray(disk.inputHashes) || typeof disk.projectRoot !== "string") {
    console.error(`FAIL: input: 盘上快照缺少比对所需的基本结构（projectRoot / inputHashes）；权威源：detect-project-capabilities.mjs 输出契约（--help）；恢复动作：重跑探测命令重建快照`);
    process.exit(1);
  }
  if (disk.projectRoot !== projectRoot) {
    console.error(`FAIL: input: 盘上快照的 projectRoot（${disk.projectRoot}）与入参 --project-root（${projectRoot}）不一致——这是另一个项目的快照；权威源：快照 projectRoot 字段；恢复动作：核对 --project-root，或为当前项目重跑探测生成新快照`);
    process.exit(1);
  }
  const fresh = buildSnapshot(projectRoot, skillsRoot);
  const oldHashes = disk.inputHashes;
  const newHashes = fresh.inputHashes;
  const changed = [];
  for (const key of Object.keys(newHashes)) {
    if (!(key in oldHashes)) changed.push(`新增：${key}`);
    else if (oldHashes[key] !== newHashes[key]) changed.push(`内容已变化：${key}`);
  }
  for (const key of Object.keys(oldHashes)) {
    if (!(key in newHashes)) changed.push(`已消失：${key}`);
  }
  if (changed.length > 0) {
    for (const line of changed) console.log(`FAIL: input: 输入已变化——${line}`);
    console.log(`权威源：项目来源文件（package.json / 测试配置 / AGENTS.md / 场景清单，见快照 inputHashes）；恢复动作：node ~/.agents/skills/delivery-v6/scripts/detect-project-capabilities.mjs --project-root <projectRoot> 重新探测重建快照（失效口径 = 输入哈希，不含产品代码）`);
    process.exit(1);
  }
  // 输入未变才做完整结构校验与值比对：结构问题在此刻意味着手改（而非来源变化）
  const structuralErrors = validateSnapshot(disk);
  if (structuralErrors.length > 0) {
    for (const message of structuralErrors) console.log(`FAIL: snapshot: ${message}`);
    console.log(`共 ${structuralErrors.length} 条结构问题；恢复动作：重跑探测命令重建快照（纠错修项目来源或探测适配层，不手改快照）`);
    process.exit(1);
  }
  if (comparablePart(disk) !== comparablePart(fresh)) {
    console.log("FAIL: drift: 输入未变但快照与重新探测结果不一致（疑似手改，或探测实现已变化）；权威源：探测命令的当前输出；恢复动作：重跑探测命令重建快照（纠错修项目来源或探测适配层，禁止手改快照）");
    process.exit(1);
  }
  console.log(`PASS: 快照与重新探测一致（命令 ${fresh.commands.length}、验证资产 ${fresh.verificationAssets.length}、unknown ${fresh.unknowns.length}）`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "用法：node detect-project-capabilities.mjs --project-root <root> [--out <path>] [--skills-root <dir>] [--check]",
    "  node detect-project-capabilities.mjs --validate <snapshot>",
    "",
    "  --project-root  项目根（或 worktree 根）绝对路径；探测目标",
    "  --out           快照输出路径（缺省 = skill-data 寻址段 dev-flow 段 <slug>/project-capabilities.json）",
    "  --skills-root   技能安装根（缺省 ~/.agents/skills；verification skill 场景清单在此定位）",
    "  --check         不写文件：重探测并与盘上快照比对（输入已变化 / 值不一致分别报告）",
    "  --validate      结构校验已有快照（命令有来源、资产存在且哈希一致、无执行证据字段、unknown 不当可用）",
    "",
    "退出码：0 成功（含 --check / --validate 通过）；1 输入不合法 / 校验失败 / --check 不通过；2 用法错误。",
  ].join("\n");
}

function failUsage(message) {
  console.error(`用法错误：${message}\n${usage()}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { projectRoot: null, out: null, skillsRoot: join(homedir(), ".agents", "skills"), check: false, validate: null };
  let index = 0;
  // flag 取值悬空（如 `--out` 在行尾无值）= 用法错误：静默落缺省路径会把产物写到非预期位置
  const readValue = (flag) => {
    const value = argv[index + 1];
    if (value === undefined) failUsage(`参数 ${flag} 缺取值（悬空 flag）；--help 查看完整用法`);
    index += 1;
    return value;
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") opts.projectRoot = readValue("--project-root");
    else if (arg === "--out") opts.out = readValue("--out");
    else if (arg === "--skills-root") opts.skillsRoot = readValue("--skills-root");
    else if (arg === "--check") opts.check = true;
    else if (arg === "--validate") opts.validate = readValue("--validate");
    else if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    else failUsage(`未知参数「${arg ?? ""}」（--help 查看完整用法）`);
  }
  if (opts.validate && (opts.projectRoot || opts.check)) failUsage("--validate 单独使用（结构校验不重探测）");
  if (!opts.validate && !opts.projectRoot) failUsage("缺必填参数 --project-root（--validate 模式除外；--help 查看完整用法）");
  if (opts.projectRoot) {
    if (!existsSync(opts.projectRoot)) {
      console.error(`FAIL: input: --project-root 路径不存在（${opts.projectRoot}）；权威源：入参 --project-root；恢复动作：核对路径拼写（含 worktree 是否已被删除）后重跑`);
      process.exit(1);
    }
    opts.projectRoot = realpathSync(opts.projectRoot);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.validate) {
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(resolve(opts.validate), "utf8"));
    } catch (error) {
      console.error(`FAIL: input: 快照不可读或不是合法 JSON（${opts.validate}，${error.message}）；权威源：detect-project-capabilities.mjs 探测输出；恢复动作：先跑探测命令生成快照`);
      process.exit(1);
    }
    const errors = validateSnapshot(snapshot);
    if (errors.length > 0) {
      for (const message of errors) console.log(`FAIL: snapshot: ${message}`);
      console.log(`共 ${errors.length} 条结构问题；权威源：detect-project-capabilities.mjs 输出契约（--help）；恢复动作：重跑探测命令重建快照（纠错修项目来源或探测适配层，不手改快照）`);
      process.exit(1);
    }
    console.log(`PASS: 快照结构合法（命令 ${snapshot.commands.length}、验证资产 ${snapshot.verificationAssets.length}、unknown ${snapshot.unknowns.length}）`);
    return;
  }

  const outPath = opts.out ? resolve(opts.out) : resolveDefaultSnapshotPath(opts.projectRoot);
  if (opts.check) {
    checkSnapshot(outPath, opts.projectRoot, opts.skillsRoot);
    return;
  }

  const snapshot = buildSnapshot(opts.projectRoot, opts.skillsRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify(snapshot, null, 2));
  if (snapshot.unknowns.length > 0) {
    // unknown 是快照的合法内容（不是失败）：探测照常完成，缺口由设计者处置（§5.1 规则）
    console.error(`WARN: ${snapshot.unknowns.length} 项能力无法从项目事实确定（已登记进快照 unknowns）：`);
    for (const item of snapshot.unknowns) console.error(`  - ${item}`);
  }
  console.error(`OK: 快照已写入 ${outPath}`);
}

/** 直接运行判定：经 symlink（~/.agents/skills/delivery-v6）调用也要命中，两侧都按 realpath 比较 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();

export { GENERATOR, NODE_PROJECT_ADDRESS, SNAPSHOT_FILENAME, buildSnapshot, resolveDefaultSnapshotPath, validateSnapshot };
