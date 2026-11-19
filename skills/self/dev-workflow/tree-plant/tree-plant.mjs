#!/usr/bin/env node
// tree-plant CLI：六道阶段 gate，全部确定性检查。在任务仓库根目录运行。
// 产物约定：docs/{design,acceptance,api,fact-check}.md + .run/<阶段>.json（内嵌内容哈希）。
// 设计原则：gate 只核事实（引用存在且非空、case 真跑绿、改动在声明范围内、记录自洽），
// 不裁质量、不产生打回循环。语义级核对（行号内容是否与登记形态相符）由扎根核实者与
// 修剪 card-07 攻击者承担，主 agent 每簇抽样亲核。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DOCS = {
  design: "docs/design.md",
  acceptance: "docs/acceptance.md",
  api: "docs/api.md",
  factCheck: "docs/fact-check.md",
};
const RUN_DIR = ".run";
const CASE_TIMEOUT_MS = 300_000;
// 验收 case 命令禁止单测 runner / mock 形态（黑名单方向：宁可误拦让人改直跑探针，不可漏拦让假宿主冒充实机）
const RUNNER_BLACKLIST =
  /(^|[\s'"&;])(node\s+--test|vitest|jest|mocha|pytest|go\s+test|deno\s+test|bun\s+test|rspec|cargo\s+test|npm\s+test|npm\s+run|yarn\s+test|yarn\s+run|pnpm\s+test|pnpm\s+run|karma|jasmine)(\s|$)|\bmock|fake-host/i;

// ---------- 基础工具 ----------

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function readDoc(rel) {
  const p = path.resolve(process.cwd(), rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function fail(msg, hint) {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  修复：${hint}`);
  process.exit(1);
}

function parseMdTables(md) {
  const tables = [];
  const lines = md.split(/\r?\n/);
  let rows = [];
  const flush = () => {
    if (rows.length >= 2) {
      const header = rows[0];
      const body = rows[1].every((c) => /^[-: ]*$/.test(c)) ? rows.slice(2) : rows.slice(1);
      tables.push({ header, rows: body });
    }
    rows = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("|") && t.endsWith("|") && t.length > 2) {
      rows.push(t.slice(1, -1).split("|").map((c) => c.trim()));
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

function findTable(tables, requiredCols) {
  for (const t of tables) {
    const norm = t.header.map((h) => h.replace(/\s+/g, "").toLowerCase());
    if (requiredCols.every((c) => norm.includes(c))) return t;
  }
  return null;
}

function col(table, name) {
  return table.header.findIndex((h) => h.replace(/\s+/g, "").toLowerCase() === name);
}

/** 引用形态：含路径分隔符的 文件:行号，或带已知扩展名的 文件名:行号；亦接受纯文件路径 */
function extractRefs(cell) {
  const refs = [];
  const re = /([^\s|:：]+(?:[\/\\][^\s|:：]+|\.(?:ts|js|mjs|cjs|json|md|py|sh))):(\d+)/g;
  let m;
  while ((m = re.exec(cell)) !== null) refs.push({ file: m[1], line: Number(m[2]) });
  if (refs.length === 0) {
    const paths = cell.match(/[^\s|，,；;]+/g) || [];
    for (const p of paths) {
      if (/\.(ts|js|mjs|cjs|json|md|py|sh)$/.test(p) || p.startsWith(".run/")) refs.push({ file: p, line: null });
    }
  }
  return refs;
}

function verifyRefs(cell) {
  const refs = extractRefs(cell);
  if (refs.length === 0) return ["证据列没有可解析的 文件:行号 或探针输出引用"];
  const problems = [];
  for (const ref of refs) {
    const p = path.resolve(process.cwd(), ref.file);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      problems.push(`${ref.file} 不存在`);
      continue;
    }
    if (ref.line !== null) {
      const n = fs.readFileSync(p, "utf8").split(/\r?\n/).length;
      if (ref.line < 1 || ref.line > n) problems.push(`${ref.file}:${ref.line} 超出范围（共 ${n} 行）`);
    }
  }
  return problems;
}

function docsHash() {
  return sha256(Object.values(DOCS).map((rel) => `${rel}:${sha256(readDoc(rel) ?? "")}`).join("\n"));
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", cwd: process.cwd() });
}

function gitHead() {
  const r = git(["rev-parse", "HEAD"]);
  if (r.status !== 0) fail("任务仓没有 git 提交（rev-parse HEAD 失败）", "四文档与实现须入库提交后再过 gate");
  return r.stdout.trim();
}

/** base 提交以来（含工作区未提交改动）的全部改动路径 */
function changedPaths(baseCommit) {
  const paths = new Set();
  const diff = git(["diff", "--name-only", `${baseCommit}..HEAD`]);
  if (diff.status === 0) for (const l of diff.stdout.split(/\r?\n/)) if (l.trim()) paths.add(l.trim());
  const st = git(["status", "--porcelain", "--untracked-files=all"]);
  if (st.status === 0) {
    for (const line of st.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const body = line.slice(3).trim();
      const arrow = body.indexOf(" -> ");
      const p = arrow >= 0 ? body.slice(arrow + 4) : body;
      if (p) paths.add(p.replace(/^"|"$/g, ""));
    }
  }
  return [...paths];
}

/** allowed 项以 / 结尾按目录前缀匹配，否则精确匹配 */
function pathsWithin(changed, allowed) {
  return changed.filter((p) => !allowed.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a)));
}

function writeRun(name, payload) {
  fs.mkdirSync(path.resolve(process.cwd(), RUN_DIR), { recursive: true });
  const body = { phase: name, generatedAt: new Date().toISOString(), ...payload };
  body.hash = sha256(JSON.stringify({ ...body, hash: undefined }));
  fs.writeFileSync(path.resolve(process.cwd(), RUN_DIR, `${name}.json`), JSON.stringify(body, null, 2));
  return body;
}

function loadRun(name) {
  const file = path.resolve(process.cwd(), RUN_DIR, `${name}.json`);
  if (!fs.existsSync(file)) fail(`.run/${name}.json 不存在`, `先运行 tree-plant.mjs ${name}`);
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  const expect = sha256(JSON.stringify({ ...body, hash: undefined }));
  if (expect !== body.hash) fail(`.run/${name}.json 哈希不符，记录被手改`, `重跑 tree-plant.mjs ${name}`);
  if (!body.pass) fail(`.run/${name}.json 记录为未通过`, `查看该文件 checks 字段定位红项后重跑`);
  return body;
}

// ---------- acceptance case ----------

function parseAcceptance() {
  const md = readDoc(DOCS.acceptance);
  if (!md) fail("docs/acceptance.md 不存在", "按 templates/acceptance.md 建立");
  const table = findTable(parseMdTables(md), ["命令", "预期", "关联"]);
  if (!table) fail("acceptance.md 里找不到「编号|场景|命令|预期|关联」表", "对照 templates/acceptance.md 的表头");
  const iId = col(table, "编号"), iCmd = col(table, "命令"), iExp = col(table, "预期"), iTag = col(table, "关联");
  const cases = table.rows.map((r) => ({
    id: r[iId], cmd: r[iCmd], expect: r[iExp], tag: (r[iTag] || "").toLowerCase(),
  }));
  const bad = cases.filter((c) => !c.id || !c.cmd || !c.expect || !c.tag);
  if (bad.length) fail(`acceptance 表存在空字段行（首个：${bad[0].id || "?"}）`, "编号/命令/预期/关联四列均必填");
  const mockish = cases.filter((c) => RUNNER_BLACKLIST.test(c.cmd));
  if (mockish.length) {
    fail(`case ${mockish.map((c) => c.id).join(", ")} 的命令是单测 runner/mock 形态`, "验收 case 必须直跑真实宿主探针/真实二进制；单测属长叶阶段（testCommand）");
  }
  return cases;
}

function runCase(c) {
  const res = spawnSync("sh", ["-c", c.cmd], { encoding: "utf8", timeout: CASE_TIMEOUT_MS, cwd: process.cwd() });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const verdicts = [];
  let pass = true;
  for (const raw of c.expect.split(/[;；]/)) {
    const t = raw.trim();
    if (!t) continue;
    let ok = false;
    let note = "";
    if (t.startsWith("exit:")) {
      ok = res.status === Number(t.slice(5));
    } else if (t.startsWith("contains:")) {
      ok = out.includes(t.slice("contains:".length));
    } else if (t.startsWith("not-contains:")) {
      ok = !out.includes(t.slice("not-contains:".length));
    } else {
      note = "无法解析的预期判据（合法形态：exit:N / contains:S / not-contains:S）";
    }
    verdicts.push({ check: t, ok, note });
    if (!ok) pass = false;
  }
  return { id: c.id, cmd: c.cmd, tag: c.tag, pass, exit: res.status, verdicts, outputTail: out.slice(-500) };
}

function runCases(cases) {
  console.log(`— 执行 ${cases.length} 条实机 case…`);
  const results = cases.map(runCase);
  return { results, ok: results.every((r) => r.pass) };
}

// ---------- 树形拆分声明 ----------

function parseTrunkAllowlist() {
  const md = readDoc(DOCS.design);
  const sec = md ? md.split(/(^|\n)#{1,3}\s.*(?:树形|拆分)/)[2] || "" : "";
  const hit = sec.match(/主干文件清单[^\n]*\n([\s\S]*?)(\n\s*\||\n#{1,3}\s|$)/);
  return hit ? (hit[1].match(/^\s*-\s+(\S+)/gm) || []).map((s) => s.replace(/^\s*-\s+/, "").trim()) : [];
}

function parseBranchAllowlist(name) {
  const md = readDoc(DOCS.design);
  if (!md) return null;
  const table = findTable(parseMdTables(md), ["枝名", "文件"]);
  if (!table) return null;
  const iName = col(table, "枝名"), iFiles = col(table, "文件");
  const row = table.rows.find((r) => (r[iName] || "").trim().toLowerCase() === name.toLowerCase());
  if (!row) return null;
  return (row[iFiles] || "").split(/[,，;；\s]+/).filter(Boolean);
}

// ---------- root 静态检查（root 与 harvest 复用） ----------

function rootStaticChecks() {
  const checks = [];
  const push = (name, pass, detail = "") => checks.push({ name, pass, detail });

  for (const rel of Object.values(DOCS)) {
    push(`文档在场 ${rel}`, readDoc(rel) !== null);
  }
  let cases = [];
  const design = readDoc(DOCS.design);
  if (design) {
    const secs = {
      背景与目标: /(^|\n)#{1,3}\s.*背景/.test(design),
      验收: /(^|\n)#{1,3}\s.*验收/.test(design),
      树形拆分: /(^|\n)#{1,3}\s.*(树形|拆分)/.test(design),
      非功能: /(^|\n)#{1,3}\s.*非功能/.test(design),
    };
    for (const [k, ok] of Object.entries(secs)) push(`设计文档章节「${k}」`, ok);
    const secAcc = design.split(/(^|\n)#{1,3}\s.*验收/)[2] || "";
    push("验收节含特点与指针", /acceptance\.md/.test(secAcc) && secAcc.trim().length > 20, "验收节需 1–2 行本次验收重点并指向 acceptance.md");
    push("主干文件清单存在（≥1 项）", parseTrunkAllowlist().length >= 1, "树形拆分节需「主干文件清单：」加 `- 路径` 列表（目录以 / 结尾）");
    push("枝表含「文件」列（枝改动范围声明）", !!findTable(parseMdTables(design), ["枝名", "文件"]), "枝叶功能表需含文件列，供 branch gate 核对改动范围");
  }

  try {
    cases = parseAcceptance();
    push("acceptance case ≥ 1", cases.length >= 1);
  } catch (e) {
    push("acceptance 表可解析", false, e.message.split("\n")[0]);
    cases = [];
  }

  const fc = readDoc(DOCS.factCheck);
  if (fc) {
    const tables = parseMdTables(fc);
    const tri = findTable(tables, ["论据", "分类", "证据"]);
    push("论据三分类表在场", !!tri);
    const riskSection = fc.split(/(^|\n)#{1,3}\s.*(?:未核实风险)/)[2] || "";
    if (tri) {
      const iCls = col(tri, "分类"), iEv = col(tri, "证据"), iNote = col(tri, "说明");
      const invalid = tri.rows.filter((r) => !["事实", "推断", "虚构"].includes(r[iCls]));
      push("分类值合法（事实/推断/虚构）", invalid.length === 0, invalid.map((r) => r.join("|")).slice(0, 2).join(" ; "));
      for (const r of tri.rows) {
        const id = r[0] || "?";
        if (r[iCls] === "事实") {
          const probs = verifyRefs(r[iEv]);
          if (probs.length) push(`事实论据证据可解析（${id}）`, false, probs.join("; "));
        }
        if (r[iCls] === "虚构" && !/作废/.test(iNote >= 0 ? `${r[iEv]}${r[iNote] || ""}` : r[iEv])) {
          push(`虚构论据已标作废（${id}）`, false, "虚构行须在证据或说明列含「作废」并删除依赖它的方案分支");
        }
        if (r[iCls] === "推断" && !riskSection.includes(id)) {
          push(`推断论据已登记未核实风险（${id}）`, false, "推断行的编号须出现在「未核实风险」节，否则升级为事实");
        }
      }
    }
    const iface = findTable(tables, ["接口", "依据", "case"]);
    push("外部接口核实表在场", !!iface);
    if (iface) {
      const iEv = col(iface, "依据"), iCase = col(iface, "case");
      const ids = new Set(cases.map((c) => c.id));
      for (const r of iface.rows) {
        const probs = verifyRefs(r[iEv]);
        if (probs.length) push(`接口依据可解析（${r[0] || "?"}）`, false, probs.join("; "));
        const refs = (r[iCase] || "").split(/[,，/、\s]+/).filter(Boolean);
        const missing = refs.filter((x) => !ids.has(x));
        if (missing.length) push(`接口行 case 覆盖（${r[0] || "?"}）`, false, `引用了不存在的 case：${missing.join(",")}`);
        if (refs.length === 0) push(`接口行 case 覆盖（${r[0] || "?"}）`, false, "该接口没有任何 case 覆盖——没有 case 的接口=没验证过的接口");
      }
    }
  }

  const api = readDoc(DOCS.api);
  if (api) {
    const need = ["命令", "工具", "配置", "存储", "挂点"];
    const hit = need.filter((k) => api.includes(k));
    push(`API 文档覆盖 ≥3 类表面（现 ${hit.length}/5：${hit.join("/")}）`, hit.length >= 3, "不适用的类目保留小节标题并写「不适用：理由」");
  }

  return { checks, cases, pass: checks.every((c) => c.pass) };
}

// ---------- testCommand ----------

function testCommand() {
  const cfg = path.resolve(process.cwd(), ".tree-plant.json");
  if (fs.existsSync(cfg)) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
      if (j.testCommand) return j.testCommand;
    } catch (e) {
      fail(".tree-plant.json 解析失败", `${e.message}（支持字段：testCommand、typecheckCommand）`);
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    return pkg.scripts && pkg.scripts.test ? "npm test" : null;
  } catch {
    return null;
  }
}

function runTestSuite(label) {
  const cmd = testCommand();
  if (!cmd) fail(`${label}：找不到单测入口`, `package.json 配 scripts.test，或建 .tree-plant.json {"testCommand":"..."}（非 Node 项目）`);
  const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: CASE_TIMEOUT_MS, cwd: process.cwd() });
  return { cmd, pass: res.status === 0, exit: res.status, tail: `${res.stdout || ""}${res.stderr || ""}`.slice(-400) };
}

// ---------- 类型检查（交付面含 TypeScript 时生效；typecheckCommand 显式配置则恒生效） ----------

const TYPECHECK_DEFAULT = "npx --no-install tsc --noEmit";

/** 交付面是否含 .ts/.tsx（跳过依赖、产物与工具目录） */
function hasTypeScript(dir = process.cwd()) {
  const skip = new Set(["node_modules", ".git", ".run", ".sdk", "dist", "build", "coverage", ".zcode"]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      if (e.isDirectory()) {
        if (walk(path.join(d, e.name))) return true;
      } else if (/\.tsx?$/.test(e.name)) return true;
    }
    return false;
  };
  try {
    return walk(dir);
  } catch {
    return false;
  }
}

function typecheckCommand() {
  const cfg = path.resolve(process.cwd(), ".tree-plant.json");
  if (fs.existsSync(cfg)) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
      if (j.typecheckCommand) return j.typecheckCommand;
    } catch {
      // 解析失败已在 testCommand() 路径报过错；此处不重复拦截
    }
  }
  return hasTypeScript() ? TYPECHECK_DEFAULT : null;
}

function runTypecheck() {
  const cmd = typecheckCommand();
  if (!cmd) return { cmd: null, pass: true, skipped: true };
  const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: CASE_TIMEOUT_MS, cwd: process.cwd() });
  return { cmd, pass: res.status === 0, exit: res.status, tail: `${res.stdout || ""}${res.stderr || ""}`.slice(-300) };
}

function typecheckCheck(types) {
  return {
    name: "类型检查绿",
    pass: types.pass,
    detail: types.skipped
      ? "交付面无 .ts，跳过"
      : types.pass
        ? types.cmd
        : `${types.cmd}（exit ${types.exit}）${types.tail ? " — " + types.tail : ""}；修复：建 tsconfig.json、安装 typescript，或在 .tree-plant.json 配 typecheckCommand`,
  };
}

// ---------- 六道 gate ----------

function gateRoot() {
  const { checks, cases, pass } = rootStaticChecks();
  const commit = gitHead();
  writeRun("root", { pass, checks, caseCount: cases.length, docsHash: docsHash(), commit });
  for (const c of checks) if (!c.pass) console.error(`  ✗ ${c.name}${c.detail ? " — " + c.detail : ""}`);
  console.log(pass ? `✓ root 通过（case ${cases.length} 条，基线 ${commit.slice(0, 8)}）` : "✗ root 未通过");
  if (!pass) process.exitCode = 1;
}

function gateTrunk() {
  const root = loadRun("root");
  const cases = parseAcceptance().filter((c) => c.tag === "trunk");
  if (cases.length === 0) fail("没有标记 trunk 的 case", "主干 = 第一条端到端路径，acceptance.md 至少一条 trunk case");
  const { results, ok } = runCases(cases);
  const suite = runTestSuite("trunk");
  const types = runTypecheck();
  console.log(`— 测试套件：${suite.cmd}（exit ${suite.exit}）`);
  if (types.cmd) console.log(`— 类型检查：${types.cmd}（exit ${types.exit}）`);
  const allow = parseTrunkAllowlist();
  if (allow.length === 0) fail("设计文档缺主干文件清单", "树形拆分节补「主干文件清单：」列表");
  const out = pathsWithin(changedPaths(root.commit), allow);
  const checks = [
    { name: "trunk case 全绿", pass: ok },
    { name: "TDD 测试套件绿", pass: suite.pass, detail: suite.cmd },
    typecheckCheck(types),
    { name: "改动 ⊆ 主干文件清单", pass: out.length === 0, detail: out.join(", ") },
  ];
  const pass = checks.every((c) => c.pass);
  writeRun("trunk", { pass, results, suite, commit: gitHead(), checks });
  for (const c of checks) if (!c.pass) console.error(`  ✗ ${c.name}${c.detail ? " — " + c.detail : ""}`);
  console.log(pass ? "✓ trunk 通过" : "✗ trunk 未通过");
  if (!pass) process.exitCode = 1;
}

function gateBranch(name) {
  const trunk = loadRun("trunk");
  if (!name) fail("branch 需要 --name 枝名", "tree-plant.mjs branch --name <枝名>");
  const cases = parseAcceptance().filter((c) => c.tag === name.toLowerCase());
  if (cases.length === 0) fail(`枝「${name}」没有关联 case`, "每枝至少一条实机 case（acceptance.md 关联列 = 枝名）");
  const allow = parseBranchAllowlist(name);
  if (!allow) fail(`设计文档枝表找不到枝「${name}」的文件声明`, "树形拆分枝表补该枝行（枝名/目标/依赖/风险级/文件/case）");
  const out = pathsWithin(changedPaths(trunk.commit), allow);
  const { results, ok } = runCases(cases);
  const checks = [
    { name: "枝 case 绿", pass: ok },
    { name: "改动 ⊆ 枝声明文件", pass: out.length === 0, detail: out.join(", ") },
  ];
  const pass = checks.every((c) => c.pass);
  writeRun(`branch-${name}`, { pass, branch: name, results, checks });
  for (const c of checks) if (!c.pass) console.error(`  ✗ ${c.name}${c.detail ? " — " + c.detail : ""}`);
  console.log(pass ? `✓ branch ${name} 通过` : "✗ branch 未通过");
  if (!pass) process.exitCode = 1;
}

function gateLeaf() {
  loadRun("trunk");
  const suite = runTestSuite("leaf");
  const types = runTypecheck();
  console.log(`— 测试套件：${suite.cmd}（exit ${suite.exit}）`);
  if (types.cmd) console.log(`— 类型检查：${types.cmd}（exit ${types.exit}）`);
  const { results, ok } = runCases(parseAcceptance());
  const pass = suite.pass && types.pass && ok;
  writeRun("leaf", { pass, suite, types: types.skipped ? null : types, results });
  console.log(pass ? "✓ leaf 通过" : "✗ leaf 未通过");
  if (!pass) process.exitCode = 1;
}

function loadFindings() {
  const file = path.resolve(process.cwd(), RUN_DIR, "prune-findings.json");
  if (!fs.existsSync(file)) fail(".run/prune-findings.json 不存在", "修剪阶段须产出该文件（零发现时写 []）");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("prune-findings.json 解析失败", e.message);
  }
}

function gatePrune() {
  loadRun("leaf");
  const findings = loadFindings();
  if (!Array.isArray(findings)) fail("prune-findings.json 顶层必须是数组", "每条发现一个对象");
  const problems = [];
  for (const f of findings) {
    if (!f.id || !f.category || !f.finding || !f.status) problems.push(`${f.id || "?"}: 缺 id/category/finding/status`);
    if (!["fixed", "refuted", "registered"].includes(f.status)) problems.push(`${f.id}: 非法 status ${f.status}`);
    if (["fixed", "refuted"].includes(f.status) && !f.reproCmd) problems.push(`${f.id}: ${f.status} 须附 reproCmd（复现命令）`);
    if (f.status === "fixed" && !f.mutationEvidence) problems.push(`${f.id}: fixed 须附变异验证记录（撤掉修复测试必红）`);
    if (f.status === "refuted" && !f.evidence) problems.push(`${f.id}: refuted 须附复现不成立的证据`);
    if (f.status === "registered" && !f.reason) problems.push(`${f.id}: registered 须附登记理由`);
  }
  const pass = problems.length === 0;
  const counts = { fixed: 0, refuted: 0, registered: 0 };
  for (const f of findings) if (counts[f.status] !== undefined) counts[f.status]++;
  writeRun("prune", { pass, findings, counts, checks: problems.map((p) => ({ name: p, pass: false })) });
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.log(pass ? `✓ prune 通过（fixed ${counts.fixed} / refuted ${counts.refuted} / registered ${counts.registered}）` : "✗ prune 未通过");
  if (!pass) process.exitCode = 1;
}

function gateHarvest() {
  const root = loadRun("root");
  loadRun("trunk"); loadRun("leaf"); loadRun("prune");
  const runFiles = fs.existsSync(path.resolve(process.cwd(), RUN_DIR)) ? fs.readdirSync(path.resolve(process.cwd(), RUN_DIR)) : [];
  for (const f of runFiles.filter((x) => x.startsWith("branch-") && x.endsWith(".json"))) {
    loadRun(f.replace(/\.json$/, ""));
  }
  const nowHash = docsHash();
  if (nowHash !== root.docsHash) {
    fail("四文档在 root 通过后被修改", "重跑 tree-plant.mjs root 更新基线（合法修订通道），再继续受影响阶段");
  }
  const re = rootStaticChecks();
  for (const c of re.checks) if (!c.pass) console.error(`  ✗ [复检] ${c.name}${c.detail ? " — " + c.detail : ""}`);
  if (!re.pass) fail("root 静态检查复检未通过", "按上方红项修复后重跑 root 及受影响阶段");

  const findings = loadFindings();
  const { results, ok } = runCases(parseAcceptance());
  const gitStatus = git(["status", "--porcelain"]);
  if (gitStatus.status !== 0) fail("任务仓不是 git 仓库（git status 失败）", "tree-plant 收获要求交付物入库（git init 并提交）");
  const clean = gitStatus.stdout.trim() === "";
  const log = git(["log", "--oneline", "-15"]);
  const ls = git(["ls-files"]);
  const pass = ok && clean;
  const residual = [];
  const fc = readDoc(DOCS.factCheck);
  if (fc) {
    const m = fc.split(/(^|\n)#{1,3}\s.*(?:未核实风险)/)[2];
    if (m) {
      for (const l of m.split(/\r?\n/)) {
        if (/^#{1,3}\s/.test(l)) break;
        if (l.trim().startsWith("-") || /^\|/.test(l.trim())) residual.push(l.trim());
      }
    }
  }
  const registered = findings.filter((f) => f.status === "registered");
  const report = [
    "# tree-plant 终态报告", ``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 终态：${pass ? "delivered" : "blocked-needs-user"}`, ``,
    `## 实机 case（${results.length} 条，${results.filter((r) => r.pass).length} 绿）`, ``,
    ...results.map((r) => `- ${r.pass ? "✓" : "✗"} ${r.id}（${r.tag}）exit=${r.exit}`), ``,
    `## 修剪发现（fixed/refuted/registered）`, ``,
    ...findings.map((f) => `- [${f.status}] ${f.id}（${f.category}）${f.finding}`), ``,
    `## 残余风险`, ``,
    ...(residual.length ? residual : ["- （无未核实风险登记）"]),
    ...registered.map((f) => `- [修剪登记] ${f.id}：${f.reason || ""}`), ``,
    `## 交付文件清单`, ``,
    ...(ls.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, 100).map((l) => `- ${l}`), ``,
    `## case 输出索引（尾部）`, ``,
    ...results.map((r) => `- ${r.id}: ${String(r.outputTail).replace(/\n/g, "⏎").slice(0, 160)}`), ``,
    `## 提交记录`, ``,
    ...(log.stdout || "").split(/\r?\n/).map((l) => `- ${l}`), "",
  ].join("\n");
  fs.writeFileSync(path.resolve(process.cwd(), RUN_DIR, "report.md"), report);
  writeRun("harvest", { pass, results, clean, terminal: pass ? "delivered" : "blocked-needs-user" });
  if (!ok) console.error("  ✗ 终态 case 重跑存在红项");
  if (!clean) console.error("  ✗ git 工作区不干净——按「完成即提交」处理后再收获");
  console.log(pass ? "✓ harvest 通过 — 终态 delivered（报告：.run/report.md）" : "✗ harvest 未通过 — 终态 blocked-needs-user");
  if (!pass) process.exitCode = 1;
}

// ---------- 入口 ----------

const [cmd, ...rest] = process.argv.slice(2);
const nameArg = (() => {
  const i = rest.indexOf("--name");
  return i >= 0 ? rest[i + 1] : null;
})();

switch (cmd) {
  case "root": gateRoot(); break;
  case "trunk": gateTrunk(); break;
  case "branch": gateBranch(nameArg); break;
  case "leaf": gateLeaf(); break;
  case "prune": gatePrune(); break;
  case "harvest": gateHarvest(); break;
  default:
    console.error("用法：tree-plant.mjs <root|trunk|branch|leaf|prune|harvest> [--name 枝名]");
    console.error("阶段顺序：root → trunk → branch×N → leaf → prune → harvest（在任务仓库根目录运行）");
    process.exit(2);
}
