#!/usr/bin/env node
// tree-plant CLI：六道阶段 gate，全部确定性检查。在任务仓库根目录运行。
// 产物约定：docs/{design,acceptance,api,fact-check}.md + .run/<阶段>.json（内嵌内容哈希）。
// 设计原则：gate 只核事实（行号存在、case 真跑绿、记录自洽），不裁质量、不产生打回循环。

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
  const i = table.header.findIndex((h) => h.replace(/\s+/g, "").toLowerCase() === name);
  return i;
}

/** 从单元格提取全部 文件:行号 引用；也接受纯文件路径 */
function extractRefs(cell) {
  const refs = [];
  const re = /([^\s|:：]+):(\d+)/g;
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
  const problems = [];
  for (const ref of extractRefs(cell)) {
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

function writeRun(name, payload) {
  fs.mkdirSync(path.resolve(process.cwd(), RUN_DIR), { recursive: true });
  const body = { phase: name, generatedAt: new Date().toISOString(), ...payload };
  body.hash = sha256(JSON.stringify({ ...body, hash: undefined }));
  const file = path.resolve(process.cwd(), RUN_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return body;
}

function loadRun(name, { required = true } = {}) {
  const file = path.resolve(process.cwd(), RUN_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    if (required) fail(`.run/${name}.json 不存在`, `先运行 tree-plant.mjs ${name}`);
    return null;
  }
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
  const mockish = cases.filter((c) => /(^|[\s'"])node\s+--test|\bvitest\b|\bmock|fake-host/i.test(c.cmd));
  if (mockish.length) {
    fail(`case ${mockish.map((c) => c.id).join(", ")} 的命令是单测/mock 形态`, "验收 case 必须真实宿主执行；单测属长叶阶段（package.json scripts.test）");
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
    if (t.startsWith("exit:")) {
      const want = Number(t.slice(5));
      const ok = res.status === want;
      verdicts.push({ check: t, ok });
    } else if (t.startsWith("contains:")) {
      const ok = out.includes(t.slice("contains:".length));
      verdicts.push({ check: t, ok });
    } else if (t.startsWith("not-contains:")) {
      const ok = !out.includes(t.slice("not-contains:".length));
      verdicts.push({ check: t, ok });
    } else {
      verdicts.push({ check: t, ok: false, note: "无法解析的预期判据（合法形态：exit:N / contains:S / not-contains:S）" });
    }
    const v = verdicts[verdicts.length - 1];
    if (!v.ok) pass = false;
  }
  return { id: c.id, cmd: c.cmd, tag: c.tag, pass, exit: res.status, verdicts, outputTail: out.slice(-500) };
}

function runCases(cases) {
  console.log(`— 执行 ${cases.length} 条实机 case…`);
  const results = cases.map(runCase);
  const red = results.filter((r) => !r.pass);
  return { results, ok: red.length === 0, red };
}

// ---------- root gate ----------

function gateRoot() {
  const checks = [];
  const push = (name, pass, detail = "") => checks.push({ name, pass, detail });

  for (const rel of Object.values(DOCS)) {
    push(`文档在场 ${rel}`, readDoc(rel) !== null);
  }
  const design = readDoc(DOCS.design);
  if (design) {
    const secs = {
      背景与目标: /(^|\n)#{1,3}\s.*背景/.test(design),
      验收: /(^|\n)#{1,3}\s.*验收/.test(design),
      树形拆分: /(^|\n)#{1,3}\s.*(树形|拆分)/.test(design),
      非功能: /(^|\n)#{1,3}\s.*非功能/.test(design),
    };
    for (const [k2, ok] of Object.entries(secs)) push(`设计文档章节「${k2}」`, ok);
    const secAcc = design.split(/(^|\n)#{1,3}\s.*验收/)[2] || "";
    push("验收节含特点与指针", /acceptance\.md/.test(secAcc) && secAcc.trim().length > 20, "验收节需 1–2 行本次验收重点并指向 acceptance.md");
  }

  const cases = parseAcceptance();
  push("acceptance case ≥ 1", cases.length >= 1);
  const fc = readDoc(DOCS.factCheck);
  if (fc) {
    const tables = parseMdTables(fc);
    const tri = findTable(tables, ["论据", "分类", "证据"]);
    push("论据三分类表在场", !!tri);
    if (tri) {
      const iCls = col(tri, "分类"), iEv = col(tri, "证据"), iNote = col(tri, "说明");
      const invalid = tri.rows.filter((r) => !["事实", "推断", "虚构"].includes(r[iCls]));
      push("分类值合法（事实/推断/虚构）", invalid.length === 0, invalid.map((r) => r.join("|")).slice(0, 2).join(" ; "));
      for (const r of tri.rows) {
        if (r[iCls] === "事实") {
          const probs = verifyRefs(r[iEv]);
          if (probs.length) push(`事实论据证据可解析（${r[0] || "?"}）`, false, probs.join("; "));
        }
        if (r[iCls] === "虚构" && !/作废/.test(iNote >= 0 ? `${r[iEv]}${r[iNote] || ""}` : r[iEv])) {
          push(`虚构论据已标作废（${r[0] || "?"}）`, false, "虚构行须在证据或说明列含「作废」并删除依赖它的方案分支");
        }
      }
      const infCount = tri.rows.filter((r) => r[iCls] === "推断").length;
      if (infCount > 0) console.log(`  （登记推断 ${infCount} 条：须进「未核实风险」节或在扎根期升级为事实）`);
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
    const hit = need.filter((k2) => api.includes(k2));
    push(`API 文档覆盖 ≥3 类表面（现 ${hit.length}/5：${hit.join("/")}）`, hit.length >= 3);
  }

  const pass = checks.every((c) => c.pass);
  for (const c of checks) if (!c.pass) console.error(`  ✗ ${c.name}${c.detail ? " — " + c.detail : ""}`);
  writeRun("root", { pass, checks, caseCount: cases.length });
  console.log(pass ? `✓ root 通过（case ${cases.length} 条）` : "✗ root 未通过");
  if (!pass) process.exitCode = 1;
  return pass;
}

// ---------- testCommand ----------

function testCommand() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    return pkg.scripts && pkg.scripts.test ? "npm test" : null;
  } catch {
    return null;
  }
}

function runTestSuite(label) {
  const cmd = testCommand();
  if (!cmd) fail(`${label}：package.json 无 scripts.test`, "长叶阶段要求单测存在（scripts.test）");
  const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: CASE_TIMEOUT_MS, cwd: process.cwd() });
  return { cmd, pass: res.status === 0, exit: res.status, tail: `${res.stdout || ""}${res.stderr || ""}`.slice(-400) };
}

// ---------- 其余 gate ----------

function gateTrunk() {
  loadRun("root");
  const cases = parseAcceptance().filter((c) => c.tag === "trunk");
  if (cases.length === 0) fail("没有标记 trunk 的 case", "主干 = 第一条端到端路径，acceptance.md 至少一条 trunk case");
  const { results, ok } = runCases(cases);
  const suite = testCommand() ? runTestSuite("trunk") : { cmd: null, pass: true, note: "无 scripts.test（长叶前可缺省）" };
  const pass = ok && suite.pass;
  writeRun("trunk", { pass, results, suite, checks: [{ name: "trunk case 全绿", pass: ok }, { name: "测试套件（如有）", pass: suite.pass }] });
  console.log(pass ? `✓ trunk 通过` : "✗ trunk 未通过");
  if (!pass) process.exitCode = 1;
}

function gateBranch(name) {
  loadRun("trunk");
  if (!name) fail("branch 需要 --name 枝名", "tree-plant.mjs branch --name <枝名>");
  const cases = parseAcceptance().filter((c) => c.tag === name.toLowerCase());
  if (cases.length === 0) fail(`枝「${name}」没有关联 case`, "每枝至少一条实机 case（acceptance.md 关联列 = 枝名）");
  const { results, ok } = runCases(cases);
  writeRun(`branch-${name}`, { pass: ok, branch: name, results });
  console.log(ok ? `✓ branch ${name} 通过` : "✗ branch 未通过");
  if (!ok) process.exitCode = 1;
}

function gateLeaf() {
  loadRun("trunk");
  const suite = runTestSuite("leaf");
  console.log(`— 测试套件：${suite.cmd}（exit ${suite.exit}）`);
  const all = parseAcceptance();
  const { results, ok } = runCases(all);
  const pass = suite.pass && ok;
  writeRun("leaf", { pass, suite, results });
  console.log(pass ? "✓ leaf 通过" : "✗ leaf 未通过");
  if (!pass) process.exitCode = 1;
}

function gatePrune() {
  loadRun("leaf");
  const file = path.resolve(process.cwd(), RUN_DIR, "prune-findings.json");
  if (!fs.existsSync(file)) fail(".run/prune-findings.json 不存在", "修剪阶段须由攻击者产出该文件（零发现时写 []）");
  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("prune-findings.json 解析失败", e.message);
  }
  if (!Array.isArray(findings)) fail("prune-findings.json 顶层必须是数组", "每条发现一个对象");
  const problems = [];
  for (const f of findings) {
    if (!f.id || !f.category || !f.finding || !f.status) problems.push(`${f.id || "?"}: 缺 id/category/finding/status`);
    if (!["fixed", "refuted", "registered"].includes(f.status)) problems.push(`${f.id}: 非法 status ${f.status}`);
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
  loadRun("root"); loadRun("trunk"); loadRun("leaf"); loadRun("prune");
  const runFiles = fs.existsSync(path.resolve(process.cwd(), RUN_DIR)) ? fs.readdirSync(path.resolve(process.cwd(), RUN_DIR)) : [];
  for (const f of runFiles.filter((x) => x.startsWith("branch-") && x.endsWith(".json"))) {
    loadRun(f.replace(/\.json$/, ""));
  }
  const all = parseAcceptance();
  const { results, ok } = runCases(all);
  const git = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: process.cwd() });
  const clean = git.status === 0 && git.stdout.trim() === "";
  const log = spawnSync("git", ["log", "--oneline", "-15"], { encoding: "utf8", cwd: process.cwd() });
  const pass = ok && clean;
  const residual = [];
  const fc = readDoc(DOCS.factCheck);
  if (fc) {
    const m = fc.split(/(^|\n)#{1,3}\s.*(?:未核实风险)/)[2];
    if (m) for (const l of m.split(/\r?\n/)) if (l.trim().startsWith("-") || /^\|/.test(l.trim())) residual.push(l.trim());
  }
  const findings = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), RUN_DIR, "prune-findings.json"), "utf8"));
  const registered = findings.filter((f) => f.status === "registered");
  const report = [
    `# tree-plant 终态报告`, ``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 终态：${pass ? "delivered" : "blocked-needs-user"}`, ``,
    `## 实机 case（${all.length} 条，${results.filter((r) => r.pass).length} 绿）`, ``,
    ...results.map((r) => `- ${r.pass ? "✓" : "✗"} ${r.id}（${r.tag}）exit=${r.exit}`), ``,
    `## 修剪发现（fixed/refuted/registered）`, ``,
    ...findings.map((f) => `- [${f.status}] ${f.id}（${f.category}）${f.finding}`), ``,
    `## 残余风险`, ``,
    ...(residual.length ? residual : ["- （无未核实风险登记）"]),
    ...registered.map((f) => `- [修剪登记] ${f.id}：${f.reason || ""}`), ``,
    `## 提交记录`, ``,
    ...(log.stdout || "").split(/\r?\n/).map((l) => `- ${l}`), "",
  ].join("\n");
  fs.writeFileSync(path.resolve(process.cwd(), RUN_DIR, "report.md"), report);
  writeRun("harvest", { pass, results, clean, terminal: pass ? "delivered" : "blocked-needs-user" });
  if (!ok) console.error("  ✗ 终态 case 重跑存在红项");
  if (!clean) console.error("  ✗ git 工作区不干净（git status --porcelain 非空）——按「完成即提交」处理后再收获");
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
