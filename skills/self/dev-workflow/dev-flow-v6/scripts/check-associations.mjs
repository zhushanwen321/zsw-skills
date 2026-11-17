#!/usr/bin/env node
// check-associations.mjs — exec-plan 关联声明（associations）的过程层机器检查
// （V5 渐进式 review 改造：过程层确定性检查，消费 exec-plan.json 的可选顶层字段
// associations——contract / registry / build-artifact 三类「改生产方必须同步消费方」声明）
//
// 两个子命令：
//   check    关联同步检查：改动集中出现某条 action=co-change 关联的 trigger，而其
//            related 未同步改动 → 报差异（生产方改了、另一侧没同步）。trigger 未改的
//            条目与 exempt 条目跳过。
//   recheck  反向对账：对改动集内 .js/.mjs/.cjs/.ts 文件做 base ↔ 工作区的静态 import
//            边差分，报告「声明外跨单元依赖边」——A 单元文件新增了对 B 单元 territory
//            文件的依赖，且该 A→B 文件对未被任何 associations 条目覆盖。
//
// 用法：
//   node check-associations.mjs check   --plan <exec-plan.json> [--base <gitRev>]
//   node check-associations.mjs recheck --plan <exec-plan.json> [--base <gitRev>]
//   base 缺省取 plan.baseline，再为空则报错退出（exit 3）。
//
// 输出契约：stdout 恒为单份 JSON（机器消费）；人读修复指引只走 stderr（dirty / error 时）。
//   check   → { status: "clean"|"dirty", diffs: [{ id, kind, trigger, missing }] }
//   recheck → { status: "clean"|"dirty"|"unknown",
//               diffs: [{ from, to, fromNode, toNode }], unknowns: [{ file, reason }] }
//   exit code：clean=0，dirty=1，unknown=2，运行错误=3。三态是硬契约：diffs 非空恒
//   dirty，unknown 只在 diffs 为空时成立，unknown 不得当 clean 通过。
//
// 口径取舍（为什么是这些限制）：
//   - 改动集 = `git diff --name-only <base>`：工作树相对 base 的全部改动（含已暂存）。
//     未 add 的 untracked 文件 git 不可见、不进改动集——初筛以 git 可见为准，不另行
//     glob 工作区（glob 会把临时脚本、构建产物卷进改动集造成噪声）。
//   - import 边是正则静态扫描，不解析 AST：只认四种字面量形态（import..from /
//     export..from / import("字面量") / require("字面量")）；静态 import/export 锚定
//     行首，压低字符串与注释内形似文本的误报。副作用导入 `import "x"` 未列入口径，
//     属漏报方向的可接受缺口。命中非字面量动态引用时不猜目标，整文件记 unknown——
//     unknown 方向宁可暴露也不放行。
//   - worktree 节点（cwd 与 projectRoot 不同）的 territory 命中文件不做边解析：改动集
//     路径相对 projectRoot 仓库根，与 worktree 检出的实际文件对不上，解析是猜测。
//   - 边解析统一以当前磁盘解析 spec（base 侧内容也用当前磁盘解析目标文件）：两侧对称，
//     被引用文件的增删不会单向制造假新增边。
//   - 文件命中多个 dev 节点 territory（编译期允许带依赖路径的重叠）时取声明序第一个，
//     保证 fromNode/toNode 判定确定。

import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { spawnSync } from "node:child_process";

const EXIT = { CLEAN: 0, DIRTY: 1, UNKNOWN: 2, ERROR: 3 };
const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const ASSOC_KINDS = new Set(["contract", "registry", "build-artifact"]);
const ASSOC_ACTIONS = new Set(["co-change", "exempt"]);
const USAGE = "用法：node check-associations.mjs <check|recheck> --plan <exec-plan.json 绝对路径> [--base <gitRev>]";

function fail(msg) {
  console.error(msg);
  process.exit(EXIT.ERROR);
}

// 相对路径统一口径：反斜杠转正斜杠 + posix 规范化（消 ./ 前缀、重复分隔符），再去掉
// 尾斜杠——posix.normalize 不消尾斜杠（"src/a/" 原样保留），territory 目录形态声明带
// 尾斜杠时不剥掉会让前缀拼接多出一层 "/" 而恒不命中；改动集（git 输出）与
// associations/territory（人写声明）两侧比较前都过这里
function normRel(p) {
  return posix.normalize(String(p).trim().replace(/\\/g, "/")).replace(/\/+$/, "");
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function nonEmptyStr(s) {
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

// ── 参数解析 ──

const argv = process.argv.slice(2);
const sub = argv[0];
if (sub !== "check" && sub !== "recheck") {
  fail(`未知子命令「${String(sub)}」。恢复动作：${USAGE}`);
}
const opts = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a !== "--plan" && a !== "--base") {
    fail(`未知参数「${a}」。恢复动作：${USAGE}`);
  }
  if (i + 1 >= argv.length) {
    const valHint = a === "--plan" ? "--plan <exec-plan.json 路径>" : "--base <gitRev>";
    fail(`参数 ${a} 缺值。恢复动作：${valHint}。完整形态：${USAGE}`);
  }
  opts[a.slice(2)] = argv[++i];
}
if (!opts.plan) {
  fail(`缺 --plan。恢复动作：${USAGE}`);
}

// ── exec-plan 读取与 associations 校验（结构非法 = 运行错误，fail-fast） ──

let plan;
try {
  plan = JSON.parse(readFileSync(opts.plan, "utf8"));
} catch (e) {
  fail(`exec-plan 不可读（${opts.plan}）：${e.message}。恢复动作：核对路径与 JSON 语法后重跑。`);
}
if (!nonEmptyStr(plan.projectRoot)) {
  fail("exec-plan 缺 projectRoot。恢复动作：在 exec-plan.json 填项目根绝对路径后重跑。");
}

const associations = plan.associations ?? [];
if (!Array.isArray(associations)) {
  fail("exec-plan 的 associations 必须是数组（字段可省略 = 无关联声明）。恢复动作：修 exec-plan.json 后重跑。");
}
for (const e of associations) {
  if (typeof e !== "object" || e === null || Array.isArray(e)) {
    fail("associations 含非对象条目。恢复动作：每条关联改为 { id, kind, trigger, related, action, rationale } 对象后重跑。");
  }
  const at = `associations[${nonEmptyStr(e.id) ?? "?"}]`;
  if (!nonEmptyStr(e.id)) {
    fail(`${at}: 缺非空 id。恢复动作：给该条目补 id 后重跑。`);
  }
  if (!ASSOC_KINDS.has(e.kind)) {
    fail(`${at}: kind 非法（${String(e.kind)}），合法值 contract / registry / build-artifact。恢复动作：改 kind 为合法值后重跑。`);
  }
  if (typeof e.trigger !== "string" || e.trigger.trim() === "" || posix.isAbsolute(e.trigger)) {
    fail(`${at}: trigger 必须是相对仓库根的单文件路径。恢复动作：把 trigger 改为相对 projectRoot 的路径后重跑。`);
  }
  if (!Array.isArray(e.related) || e.related.length === 0) {
    fail(`${at}: related 必须是非空数组。恢复动作：登记至少一个关联文件路径后重跑。`);
  }
  if (e.related.some((r) => typeof r !== "string" || r.trim() === "" || posix.isAbsolute(r))) {
    fail(`${at}: related 含非法条目（须为非空的相对仓库根路径）。恢复动作：把 related 全部改为相对路径后重跑。`);
  }
  if (!ASSOC_ACTIONS.has(e.action)) {
    fail(`${at}: action 非法（${String(e.action)}），合法值 co-change / exempt。恢复动作：改 action 为合法值后重跑。`);
  }
  if (e.action === "exempt" && !nonEmptyStr(e.rationale)) {
    fail(`${at}: action=exempt 必须带非空 rationale（豁免理由）。恢复动作：补写 rationale，或改回 co-change 后重跑。`);
  }
}

// ── 基线与改动集 ──

const base = nonEmptyStr(opts.base) ?? nonEmptyStr(plan.baseline);
if (!base) {
  fail("缺少比较基线：--base 未传且 exec-plan.json 的 baseline 为空。恢复动作：传 --base <gitRev>（典型 = 单元开工时的 git rev-parse HEAD）后重跑。");
}

function gitRun(gitArgs) {
  const r = spawnSync("git", gitArgs, { cwd: plan.projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { err: `${r.error.message}（确认 projectRoot = ${plan.projectRoot} 存在且为 git 工作树）` };
  if (r.status !== 0) return { err: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() };
  return { out: r.stdout };
}

const diffRes = gitRun(["diff", "--name-only", base]);
if ("err" in diffRes) {
  fail(`git diff --name-only ${base} 失败（cwd = ${plan.projectRoot}）：${diffRes.err}。恢复动作：确认 projectRoot 是 git 工作树、基线 ${base} 是有效提交（git cat-file -e ${base}）后重跑；工作树重建过则改传 --base <新基线 rev>。`);
}
const changedSet = new Set(diffRes.out.split("\n").filter(Boolean).map(normRel));

// ── check：关联同步检查 ──

if (sub === "check") {
  const diffs = [];
  for (const e of associations) {
    if (e.action !== "co-change") continue; // exempt 条目跳过（校验层已保证 action 合法）
    const trigger = normRel(e.trigger);
    if (!changedSet.has(trigger)) continue; // 生产方（trigger）未改 → 无同步义务
    const missing = e.related.map(normRel).filter((r) => !changedSet.has(r));
    if (missing.length > 0) {
      diffs.push({ id: e.id, kind: e.kind, trigger, missing });
    }
  }
  diffs.sort((x, y) => cmpStr(x.id, y.id));
  const status = diffs.length > 0 ? "dirty" : "clean";
  console.log(JSON.stringify({ status, diffs }, null, 2));
  if (status === "dirty") {
    for (const d of diffs) {
      console.error(`[${d.id}]（${d.kind}）trigger 已改动但 related 未同步：${d.trigger} ↔ ${d.missing.join("、")}`);
      console.error("  若确需同步请补改上述 related 文件；若刻意不同步，把该关联 action 改为 exempt 并写 rationale。");
    }
    process.exit(EXIT.DIRTY);
  }
  process.exit(EXIT.CLEAN);
}

// ── recheck：声明外跨单元依赖边对账 ──

const devNodes = (Array.isArray(plan.nodes) ? plan.nodes : [])
  .filter((n) => typeof n === "object" && n !== null && n.kind === "dev");

function inTerritory(relPath, prefix) {
  const t = normRel(prefix);
  return t !== "" && (relPath === t || relPath.startsWith(`${t}/`));
}

function nodeOf(relPath) {
  return devNodes.find(
    (n) => Array.isArray(n.territory) && n.territory.some((t) => inTerritory(relPath, t)),
  ) ?? null;
}

// cwd 与 projectRoot 不同 = 另一检出（worktree）。字符串直比：引擎启动已断言 cwd 是
// 仓库根绝对路径，符号链接别名形态不做 realpath 归一（不在本脚本口径内）
const worktreeNodes = devNodes.filter(
  (n) => typeof n.cwd === "string" && n.cwd.trim() !== "" && n.cwd !== plan.projectRoot,
);

const unknowns = [];
const unknownFiles = new Set();
function addUnknown(file, reason) {
  if (unknownFiles.has(file)) return;
  unknownFiles.add(file);
  unknowns.push({ file, reason });
}

const candidateFiles = [];
for (const f of changedSet) {
  if (!JS_EXTS.has(posix.extname(f))) continue;
  const wt = worktreeNodes.find(
    (n) => Array.isArray(n.territory) && n.territory.some((t) => inTerritory(f, t)),
  );
  if (wt) {
    addUnknown(f, "worktree 节点暂不支持静态分析");
    continue;
  }
  candidateFiles.push(f);
}

// 动态引用调用点（排除 obj.import( / obj.require( 成员调用形态，避免把方法调用误判 unknown）
const RE_DYNAMIC_CALL = /(?<![\w$.])(?:import|require)\s*\(/g;
// 字面量边提取：静态 import/export 锚行首（压低字符串/注释内形似文本误报）；动态调用
// 可出现在表达式任意位置，不锚行首
const RE_IMPORT_FROM = /^[ \t]*import\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const RE_EXPORT_FROM = /^[ \t]*export\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const RE_IMPORT_LIT = /(?<![\w$.])import\s*\(\s*(['"])([^'"]+)\1/g;
const RE_REQUIRE_LIT = /(?<![\w$.])require\s*\(\s*(['"])([^'"]+)\1/g;

// 返回 { specs, reason: null } 或 { specs: null, reason }——reason 非空即整文件记 unknown，
// 其边不参与判定（部分解析会产生「看似干净」的假阴性，宁可整体弃判）
function parseModule(text) {
  let m;
  RE_DYNAMIC_CALL.lastIndex = 0;
  while ((m = RE_DYNAMIC_CALL.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length).replace(/^\s+/, "");
    if (after.startsWith('"') || after.startsWith("'")) continue; // 字面量动态引用，正常边
    const line = text.slice(0, m.index).split("\n").length;
    const call = m[0].replace(/\s+\(/, "(");
    return { specs: null, reason: `第 ${line} 行附近的 ${call} 参数不是字符串字面量（动态引用无法静态判定目标）` };
  }
  const specs = [];
  for (const re of [RE_IMPORT_FROM, RE_EXPORT_FROM, RE_IMPORT_LIT, RE_REQUIRE_LIT]) {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(text)) !== null) specs.push(mm[2]);
  }
  return { specs, reason: null };
}

// 相对 spec → 仓库内文件（相对 projectRoot 的 POSIX 路径）；解析不到返回 null（边忽略）。
// 候选扩展顺序按契约：原样、加 .js/.mjs/.ts、加 /index.js
function resolveSpec(fromRel, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // 包名 / node: / 别名不追踪
  const target = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  if (target.startsWith("../") || posix.isAbsolute(target)) return null; // 逃出仓库根
  for (const cand of [target, `${target}.js`, `${target}.mjs`, `${target}.ts`, posix.join(target, "index.js")]) {
    try {
      if (statSync(join(plan.projectRoot, cand)).isFile()) return normRel(cand);
    } catch {
      // 不存在 → 试下一个候选
    }
  }
  return null;
}

function edgeSetOf(file, getText) {
  const parsed = parseModule(getText());
  if (parsed.reason !== null) {
    addUnknown(file, parsed.reason);
    return null;
  }
  const set = new Set();
  for (const spec of parsed.specs) {
    const to = resolveSpec(file, spec);
    if (to !== null) set.add(to);
  }
  return set;
}

function workspaceText(file) {
  try {
    return readFileSync(join(plan.projectRoot, file), "utf8");
  } catch {
    return ""; // 工作区已删除 → 当前版本无内容、无边
  }
}

function baseText(file) {
  const r = spawnSync("git", ["show", `${base}:${file}`], { cwd: plan.projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : ""; // base 无此文件（新增）→ 按空 base 处理
}

const currentEdges = new Map();
const baseEdges = new Map();
for (const f of candidateFiles) {
  const cur = edgeSetOf(f, () => workspaceText(f));
  if (cur === null) continue; // 已记 unknown
  const old = edgeSetOf(f, () => baseText(f));
  if (old === null) continue; // base 版本就有非字面量动态引用 → base 边集不可判定
  currentEdges.set(f, cur);
  baseEdges.set(f, old);
}

// 覆盖判定按契约超集：两文件都在同一条目的 trigger+related 并集内即已声明
// （已涵盖 trigger→related 与 related→trigger 两方向），exempt 条目同样算已声明——
// 声明过「这对不同步」就是对这条依赖边的登记
function isCovered(from, to) {
  return associations.some((e) => {
    const union = [normRel(e.trigger), ...e.related.map(normRel)];
    return union.includes(from) && union.includes(to);
  });
}

const diffs = [];
for (const [from, tos] of currentEdges) {
  const fromNode = nodeOf(from);
  if (!fromNode) continue; // 引用方不属于任何 dev 节点 → 不报告（避免既有工具文件全成误报）
  for (const to of tos) {
    if (baseEdges.get(from)?.has(to)) continue; // base 已有 → 非新增
    const toNode = nodeOf(to);
    if (!toNode) continue; // 被引用方不属于任何 dev 节点 → 不报告
    if (toNode.id === fromNode.id) continue; // 同单元内部边
    if (isCovered(from, to)) continue;
    diffs.push({ from, to, fromNode: fromNode.id, toNode: toNode.id });
  }
}
diffs.sort((x, y) => cmpStr(`${x.from}\u0000${x.to}`, `${y.from}\u0000${y.to}`));
unknowns.sort((x, y) => cmpStr(x.file, y.file));

const status = diffs.length > 0 ? "dirty" : unknowns.length > 0 ? "unknown" : "clean";
console.log(JSON.stringify({ status, diffs, unknowns }, null, 2));
if (status === "dirty") {
  for (const d of diffs) {
    console.error(`${d.from}（${d.fromNode}）新增了对 ${d.to}（${d.toNode}）的依赖，且该文件对未经 associations 声明。`);
    console.error("  若属预期跨单元协作：在 exec-plan.json 的 associations 登记该文件对（trigger/related）；若不该依赖：移除该 import 或回设计侧调整单元边界。");
  }
} else if (status === "unknown") {
  console.error(`${unknowns.length} 个改动文件含静态解析无法判定的引用（详见 unknowns 的 reason），依赖是否越单元需人工确认；确认后在 associations 登记文件对，或改为字面量引用/移除动态调用后重跑。`);
}
process.exit(status === "dirty" ? EXIT.DIRTY : status === "unknown" ? EXIT.UNKNOWN : EXIT.CLEAN);
