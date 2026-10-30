#!/usr/bin/env node
// 设计文档机器自检（T1 flow/write.md Step 6.1 与 T2 flow/review.md 进场门槛同一实现，
// 双轨语义等价由同一脚本保证）。机器项全绿 = T2 进场门槛：骨架完整、锚点对齐、
// e2e 子节、分型声明这类机器可查问题在 T1 拦截，不进 T2 消耗审查轮次。
//
// 四项判定：
//   1. 骨架：五段骨架二级章节存在（背景目标 / 现状与问题 / 解决方案 / 验收 /
//      下一层拆分——标题剥编号前缀后按核心词前缀匹配，骨架定义见
//      references/doc-structure.md 五段骨架）
//   2. e2e：「e2e 影响面评估」子节存在于验收节内（标题逐字含该词；无受影响项时
//      保留子节写「无受影响项（依据）」也算过——下游 T3 按标题检索继承）
//   3. 导航：文档头部「人工审核导航」表锚点集 = 关键决策标题集（A/B 分级双向对账；
//      格式刚性约定见 references/review-guide-rubric.md「文档落法」节）
//   4. 分型：文档头部出现设计分型声明（「终态型」或「演进型」任一；判定规则见
//      flow/write.md Step D）
//
// 用法：
//   node check-design-doc.mjs <设计文档绝对路径>
// 输出：exit 0 = 四项全绿（stdout 一行确认）；exit 1 = stdout 逐项失败原因
//（每条指向缺什么、预期形态、权威规则出处）；exit 2 = 用法/文件错误

import { readFileSync } from "node:fs";

function failUsage(msg) {
  process.stderr.write(`用法错误：${msg}\n用法：node check-design-doc.mjs <设计文档绝对路径>\n`);
  process.exit(2);
}

const docPath = process.argv[2];
if (!docPath) failUsage("缺少设计文档路径参数");
let md;
try {
  md = readFileSync(docPath, "utf8");
} catch (e) {
  failUsage(`读取设计文档失败（${docPath}）：${e.message}`);
}

// ── 通用解析 ──

/** 剥标题文本的编号前缀（「1.」「3.2 」「4.1.」等数字编号形态），返回裸标题 */
function stripHeadingNumber(text) {
  return text.replace(/^\s*\d+(?:\.\d+)*[.、:：]?\s*/, "").trim();
}

/** 标题行扫描：{level, text, line}[]（level = # 个数；跳过代码块内的伪标题） */
function scanHeadings(source) {
  const out = [];
  const lines = source.split("\n");
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (m !== null) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return out;
}

const headings = scanHeadings(md);
const failures = [];

// ── 判定 1：五段骨架 ──

const SKELETON_SECTIONS = [
  { key: "背景目标", hint: "## 1. 背景目标" },
  { key: "现状与问题", hint: "## 2. 现状与问题分析" },
  { key: "解决方案", hint: "## 3. 解决方案" },
  { key: "验收", hint: "## 4. 验收" },
  { key: "下一层拆分", hint: "## 5. 下一层拆分" },
];
const h2 = headings.filter((h) => h.level === 2);
/** 各骨架节的命中标题（供判定 2 定位验收节范围、判定 4 划头部范围） */
const sectionHits = new Map();
for (const s of SKELETON_SECTIONS) {
  const hit = h2.find((h) => stripHeadingNumber(h.text).startsWith(s.key));
  if (hit === undefined) {
    failures.push(
      `[骨架] 缺二级章节「${s.key}」——预期标题形如「${s.hint}」（编号前缀可有可无，标题以「${s.key}」开头）；五段骨架定义见 references/doc-structure.md`,
    );
  } else {
    sectionHits.set(s.key, hit);
  }
}

// ── 判定 2：「e2e 影响面评估」子节（验收节内） ──

const E2E_TITLE = "e2e 影响面评估";
const acceptHeading = sectionHits.get("验收");
if (acceptHeading !== undefined) {
  const startIdx = headings.indexOf(acceptHeading);
  const subHeadings = [];
  for (const h of headings.slice(startIdx + 1)) {
    if (h.level <= 2) break; // 下一个二级章节 = 验收节结束
    subHeadings.push(h);
  }
  const hit = subHeadings.find((h) => stripHeadingNumber(h.text).startsWith(E2E_TITLE));
  if (hit === undefined) {
    failures.push(
      `[e2e] 验收节内未找到子节「${E2E_TITLE}」——标题须逐字含该词（容许编号前缀，如「### 4.1 ${E2E_TITLE}」；下游 T3 按标题检索继承，措辞漂移会检索失败）；无受影响项时保留该子节并写「无受影响项（依据）」也算过，禁止省略子节`,
    );
  }
}

// ── 判定 3：导航表锚点集 = 关键决策标题集 ──

/** 关键决策标题：形如「### 6.1 <标题>（A 级）」（A/B 级别词逐字如此，rubric 文档落法
 *  第 1 条）；级别标记后允许尾注（存量形态「（A 级，走查缺口 xx#1 反哺）」同样认） */
const DECISION_TITLE_RE = /^(\d+(?:\.\d+)+)\s*(.*?)\s*[（(]\s*([AB])\s*级\s*(?:[）)]|[，,])/;
const decisionTitles = { A: [], B: [] };
for (const h of headings) {
  const m = DECISION_TITLE_RE.exec(h.text);
  if (m !== null) decisionTitles[m[3]].push({ num: m[1], title: m[2], line: h.line });
}

const navHeading = headings.find((h) => h.text.includes("人工审核导航"));
if (navHeading === undefined) {
  failures.push(
    "[导航] 未找到「人工审核导航」节——预期位于文档头部（一句话结论之后、正文之前）；固定结构见 references/review-guide-rubric.md「文档落法」节",
  );
} else {
  // 导航节范围：节标题行到下一个同级或更高级标题；取原文行区间解析表格
  const navIdx = headings.indexOf(navHeading);
  const lines = md.split("\n");
  let endLine = lines.length;
  for (const h of headings.slice(navIdx + 1)) {
    if (h.level <= navHeading.level) {
      endLine = h.line - 1;
      break;
    }
  }
  const navLines = lines.slice(navHeading.line, endLine);
  // 表格解析：表头含「锚点」判定为导航表；含「命中判据」= A 级表，含「主要影响」不含「命中判据」= B 级表
  const anchorRe = /^\s*\|?\s*§?\s*(\d+(?:\.\d+)+)\s*\|/;
  const tables = { A: new Set(), B: new Set() };
  let currentKind = null;
  let sawNavTable = false;
  for (const raw of navLines) {
    if (!/^\s*\|/.test(raw)) {
      currentKind = null;
      continue;
    }
    const cells = raw.split("|").map((c) => c.trim());
    const first = cells[1] ?? "";
    const joined = cells.join(" ");
    if (joined.includes("锚点") && joined.includes("决策")) {
      // 表头行：按列名判 A/B
      currentKind = joined.includes("命中判据") ? "A" : joined.includes("主要影响") ? "B" : null;
      if (currentKind !== null) sawNavTable = true;
      continue;
    }
    if (/^\s*[:\-\|\s]+\|?\s*$/.test(raw) || first === "") continue; // 分隔行 / 空行
    if (currentKind === null) continue;
    const m = anchorRe.exec(raw);
    if (m !== null) tables[currentKind].add(m[1]);
    else if (first !== "") tables[currentKind].add(first.replace(/^§/, "").trim());
  }
  if (!sawNavTable) {
    failures.push(
      "[导航] 「人工审核导航」节内未找到 A 级/B 级表——预期 A 级表表头「| 锚点 | 决策 | 命中判据 | 关键影响 |」、B 级表表头「| 锚点 | 决策 | 主要影响 |」（结构见 references/review-guide-rubric.md「文档落法」节）",
    );
  } else {
    for (const kind of ["A", "B"]) {
      const anchors = tables[kind];
      const titles = decisionTitles[kind];
      const titleNums = new Set(titles.map((t) => t.num));
      const kindLabel = kind === "A" ? "A 级（必须逐条裁决）" : "B 级（无异议即过）";
      for (const t of titles) {
        if (!anchors.has(t.num)) {
          failures.push(
            `[导航] ${kind} 级决策标题「${t.num} ${t.title}（${kind} 级）」（第 ${t.line} 行）未出现在导航表 ${kindLabel}的锚点列——导航表须补「§${t.num}」行`,
          );
        }
      }
      for (const a of [...anchors].sort()) {
        if (!titleNums.has(a)) {
          failures.push(
            `[导航] 导航表 ${kindLabel}锚点「§${a}」没有对应的 ${kind} 级决策标题——正文须有形如「### ${a} <标题>（${kind} 级）」的标题，或从导航表删除该行`,
          );
        }
      }
    }
  }
}

// ── 判定 4：分型声明（头部出现「终态型」或「演进型」） ──

/** 头部 = 第一个骨架二级章节之前的内容（含文档标题、一句话结论、导航表）；
 *  骨架节缺失时退化到第一个二级标题之前 */
const headBoundary =
  SKELETON_SECTIONS.map((s) => sectionHits.get(s.key)).find((h) => h !== undefined) ?? h2[0] ?? null;
const headText =
  headBoundary === null ? md : md.split("\n").slice(0, headBoundary.line - 1).join("\n");
if (!headText.includes("终态型") && !headText.includes("演进型")) {
  failures.push(
    "[分型] 文档头部未见设计分型声明——预期出现「终态型」或「演进型」字样（与功能分级 P 级、风险分并列于头部；判定规则见 flow/write.md Step D：终态型须登记触发依据，演进型须登记「为什么不需要终态视角」辩护）",
  );
}

// ── 输出 ──

if (failures.length === 0) {
  process.stdout.write("骨架 5/5、e2e 影响面评估子节、导航表锚点对齐、分型声明——四项全绿\n");
  process.exit(0);
}
for (const f of failures) process.stdout.write(f + "\n");
process.stdout.write(`\n共 ${failures.length} 项未过：按上述逐条修复文档后重跑本脚本，至全绿才进 T2（机器项全绿 = T2 进场门槛）\n`);
process.exit(1);
