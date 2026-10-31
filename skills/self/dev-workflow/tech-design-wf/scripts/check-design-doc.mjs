#!/usr/bin/env node
// 设计包机器自检（flow/write.md 写作自检与 flow/review.md 进场门槛同一实现，
// 双轨语义等价由同一脚本保证）。设计文档权威源 = 设计目录内六个章节 JSON
// （schema 见 references/design-doc-schema.md）；本脚本按八条规则判定合法性，
// 机器可查问题在写作期拦截，不进审查轮次消耗人工。
//
// 八条规则：
//   1. 完整性：六文件存在；meta 必填字段非空；designType / priority / nature 枚举合法；
//      relatedDocs 为数组形态且元素有 path（不强制非空——纯语义登记，通用性不设 warning）
//   2. id 唯一：各数组内 id 不重复，全部 id 数组并集无重复（不同前缀 G/U/D 等各自编号，天然共存）
//   3. 导航对齐：meta.reviewNav[].decisionId 集合 == s3.decisions[].id 集合（A/B 级决策不得缺导航行）
//   4. 引用存在：gapRefs / unitRefs / axiomRefs / goalRefs 引用的 id 在被引用数组中存在
//   5. 分型一致：terminal 必填 terminalForm 三字段与 migrationWaves；evolution 必须为空或缺失
//   6. 产物表完备：verified 前提 evidence 非空；stateCopies 至少一行、nature 枚举合法、
//      excluded=false 行 sync 非空、excluded=true 行 exclusionNote 必填
//   7. 内容形态：typeRationale 不以分型名开头（渲染器已带「终态型（terminal）——」前缀，重复即冗余）；
//      s5 units files 条目全/半角括号配对（不配对的说明括号使条目与后续文件粘连）
//   8. warning（不阻塞）：穷举断言可复算——assumptions.statement / assumptionExclusions /
//      stateCopies.exclusionNote 含「唯一 / 全集 / 限于」措辞的行同行无检索命令标记
//      （grep / rg / 检索式）。warning 级是过渡分层：在途设计存量行未带检索命令，
//      阻塞会使 T2 进场门槛批量 setup-failure；义务执行靠方向审按 must-fix 处置（模板
//      D2 规定动作），存量清偿后可升级为阻塞
//   9. warning（不阻塞）：rendered.md 缺失或早于任一 json 修改时间
//
// 用法：
//   node check-design-doc.mjs <设计目录>
// 输出：exit 0 = 八条规则全绿（stdout 一行确认；渲染过期 warning 只提示不改判定）；
//   exit 1 = stdout 逐项失败原因（每条指明哪个文件哪个字段缺什么 / 引用了不存在的
//   什么 id），或 md 输入的迁移指引；exit 2 = 用法错误

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const CHAPTER_FILES = [
  "meta.json",
  "s1-context.json",
  "s2-status.json",
  "s3-solution.json",
  "s4-accept.json",
  "s5-breakdown.json",
];

const MIGRATION_HINT =
  "本工具只接受分章节 JSON 设计目录（<name>/meta.json … s5-breakdown.json）；md 文件不是有效输入。存量 md 设计包继续处理请用技能 git 历史版本；新设计按 references/design-doc-schema.md 产出。";

function failUsage(msg) {
  process.stderr.write(`用法错误：${msg}\n用法：node check-design-doc.mjs <设计目录>\n`);
  process.exit(2);
}

// ── 输入判定：目录 → 校验；.md 文件 → 迁移指引；其余 → 用法错误 ──

const designDir = process.argv[2];
if (!designDir) failUsage("缺少设计目录参数");
let dirStat;
try {
  dirStat = statSync(designDir);
} catch {
  failUsage(`设计目录不存在（${designDir}）`);
}
if (dirStat.isFile()) {
  if (designDir.endsWith(".md")) {
    process.stdout.write(MIGRATION_HINT + "\n");
    process.exit(1);
  }
  failUsage("参数须是设计包目录（含六个章节 JSON），不是单个文件");
}

// ── 读取六章节 JSON（失败指明文件名；文件级失败不阻断其余规则对已读文件的判定） ──

const docs = {};
const failures = [];
const warnings = [];

for (const file of CHAPTER_FILES) {
  let raw;
  try {
    raw = readFileSync(join(designDir, file), "utf8");
  } catch {
    failures.push(
      `[文件] 缺少 ${file}——设计目录须含六个章节 JSON（meta / s1-context / s2-status / s3-solution / s4-accept / s5-breakdown），字段规格见 references/design-doc-schema.md`,
    );
    continue;
  }
  try {
    docs[file] = JSON.parse(raw);
  } catch (e) {
    failures.push(`[文件] ${file} 解析失败：${e.message}——修复 JSON 语法后重跑本脚本`);
  }
}

// ── 通用 helper ──

const arr = (v) => (Array.isArray(v) ? v : []);
const isFilled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const meta = docs["meta.json"];
const s1 = docs["s1-context.json"];
const s2 = docs["s2-status.json"];
const s3 = docs["s3-solution.json"];
const s4 = docs["s4-accept.json"];
const s5 = docs["s5-breakdown.json"];

// ── 规则 1：完整性 + 枚举 ──

if (meta !== undefined) {
  const META_FIELDS = [
    ["name", "设计名（kebab-case，与目录名一致）"],
    ["designType", "设计分型：terminal（终态型）/ evolution（演进型）"],
    ["typeRationale", "分型依据"],
    ["priority", "功能分级（P0/P1/P2/P3）"],
    ["riskScore", "风险分"],
    ["riskRationale", "风险依据"],
    ["reviewNav", "人工审核导航（数组，每条 A/B 级决策一行）"],
  ];
  for (const [field, expect] of META_FIELDS) {
    if (!isFilled(meta[field])) {
      failures.push(`[完整性] meta.json 字段 ${field} 缺失或为空——必填，应填：${expect}`);
    }
  }
  if (isFilled(meta.designType) && !["terminal", "evolution"].includes(meta.designType)) {
    failures.push(`[枚举] meta.json designType 值「${meta.designType}」不合法——合法取值：terminal（终态型）/ evolution（演进型）`);
  }
  if (isFilled(meta.priority) && !["P0", "P1", "P2", "P3"].includes(meta.priority)) {
    failures.push(`[枚举] meta.json priority 值「${meta.priority}」不合法——合法取值：P0 / P1 / P2 / P3`);
  }
  // relatedDocs：仅形态校验（数组、元素须有 path），可空——无关联时空数组，不强制非空也不加 warning
  if (meta.relatedDocs !== undefined) {
    if (!Array.isArray(meta.relatedDocs)) {
      failures.push(
        "[关联登记] meta.json relatedDocs 须为数组——每条登记一个关联文档（{ path, relation }），无关联时留空数组",
      );
    } else {
      meta.relatedDocs.forEach((r, i) => {
        if (!isFilled(r?.path)) {
          failures.push(
            `[关联登记] meta.json relatedDocs[${i}] 缺 path——每条须填关联文档的项目内相对路径`,
          );
        }
      });
    }
  }
}
if (s2 !== undefined) {
  arr(s2.artifactTables?.upstreamDeps).forEach((row, i) => {
    if (!["contract", "observed", "bet"].includes(row?.nature)) {
      failures.push(
        `[枚举] s2-status.json artifactTables.upstreamDeps[${i}]（${row?.id ?? "缺 id"}）nature 值「${row?.nature ?? "缺失"}」不合法——合法取值：contract（契约级）/ observed（观察级）/ bet（押注）`,
      );
    }
  });
}

// ── 规则 2：id 唯一（数组内 + 全局并集） ──

const ID_ARRAYS = [
  ["s1-context.json", "goals", (d) => d.goals],
  ["s2-status.json", "problems", (d) => d.problems],
  ["s2-status.json", "assumptions", (d) => d.assumptions],
  ["s2-status.json", "artifactTables.stateCopies", (d) => d.artifactTables?.stateCopies],
  ["s2-status.json", "artifactTables.signalImplications", (d) => d.artifactTables?.signalImplications],
  ["s2-status.json", "artifactTables.repairHistory", (d) => d.artifactTables?.repairHistory],
  ["s2-status.json", "artifactTables.upstreamDeps", (d) => d.artifactTables?.upstreamDeps],
  ["s3-solution.json", "terminalForm.axioms", (d) => d.terminalForm?.axioms],
  ["s3-solution.json", "terminalForm.gapTable", (d) => d.terminalForm?.gapTable],
  ["s3-solution.json", "options", (d) => d.options],
  ["s3-solution.json", "decisions", (d) => d.decisions],
  ["s3-solution.json", "migrationWaves", (d) => d.migrationWaves],
  ["s4-accept.json", "scenarios", (d) => d.scenarios],
  ["s4-accept.json", "assertionRedlights", (d) => d.assertionRedlights],
  ["s5-breakdown.json", "units", (d) => d.units],
];
const globalIdLocations = new Map(); // id -> `${file} ${path}[i]`[]
for (const [file, path, getItems] of ID_ARRAYS) {
  const doc = docs[file];
  if (doc === undefined) continue;
  const localSeen = new Map(); // id -> index[]
  arr(getItems(doc)).forEach((item, i) => {
    const id = item?.id;
    if (!isFilled(id)) return;
    if (!localSeen.has(id)) localSeen.set(id, []);
    localSeen.get(id).push(i);
  });
  for (const [id, indexes] of localSeen) {
    if (indexes.length > 1) {
      failures.push(
        `[id] ${file} ${path} 内 id「${id}」重复出现（${indexes.map((i) => `${path}[${i}]`).join(" 与 ")}）——同一数组内 id 不得重复`,
      );
    }
    if (!globalIdLocations.has(id)) globalIdLocations.set(id, []);
    globalIdLocations.get(id).push(`${file} ${path}[${indexes[0]}]`);
  }
}
for (const [id, locations] of globalIdLocations) {
  if (locations.length > 1) {
    failures.push(`[id] id「${id}」重复定义于 ${locations.join(" 与 ")}——全部章节 JSON 的 id 须全局唯一`);
  }
}

// ── 规则 3：导航对齐（reviewNav.decisionId 集合 == decisions.id 集合） ──

const navRows = arr(meta?.reviewNav);
const decisionRows = arr(s3?.decisions);
const decisionIdSet = new Set(decisionRows.map((d) => d?.id).filter(isFilled));
for (const r of navRows) {
  if (isFilled(r?.decisionId) && !decisionIdSet.has(r.decisionId)) {
    failures.push(
      `[导航] meta.json reviewNav 引用的 decisionId「${r.decisionId}」在 s3-solution.json decisions 中不存在——核对 id 拼写，或删除该多余导航行`,
    );
  }
}
const navIdSet = new Set(navRows.map((r) => r?.decisionId).filter(isFilled));
for (const d of decisionRows) {
  if (isFilled(d?.id) && !navIdSet.has(d.id)) {
    const level = isFilled(d.level) ? `${d.level} 级` : "A/B 级";
    failures.push(
      `[导航] s3-solution.json 决策「${d.id}（${d.title ?? "无标题"}）」未出现在 meta.json reviewNav——${level}决策必须逐条有人工审核导航行`,
    );
  }
}

// ── 规则 4：引用存在（引用 id ⊆ 被引用数组 id 集） ──

const gapIds = new Set(arr(s3?.terminalForm?.gapTable).map((g) => g?.id).filter(isFilled));
const unitIds = new Set(arr(s5?.units).map((u) => u?.id).filter(isFilled));
const axiomIds = new Set(arr(s3?.terminalForm?.axioms).map((a) => a?.id).filter(isFilled));
const goalIds = new Set(arr(s1?.goals).map((g) => g?.id).filter(isFilled));

function checkRefs(where, refs, idSet, targetLabel) {
  const hint = idSet.size > 0 ? `现有 id：${[...idSet].join("、")}` : "该数组当前为空（或字段缺失）";
  for (const ref of arr(refs)) {
    if (!idSet.has(ref)) {
      failures.push(`[引用] ${where} 引用了不存在的「${ref}」——${targetLabel}${hint}`);
    }
  }
}

decisionRows.forEach((d, i) => {
  const where = `s3-solution.json decisions[${i}]（${d?.id ?? "缺 id"}）`;
  checkRefs(`${where} gapRefs`, d?.gapRefs, gapIds, "终态-现状差距表（terminalForm.gapTable）");
  checkRefs(`${where} unitRefs`, d?.unitRefs, unitIds, "下一层拆分单元（s5-breakdown.json units）");
  checkRefs(`${where} axiomRefs`, d?.axiomRefs, axiomIds, "公理清单（terminalForm.axioms）");
});
arr(s3?.migrationWaves).forEach((w, i) => {
  checkRefs(
    `s3-solution.json migrationWaves[${i}]（${w?.id ?? "缺 id"}）gapRefs`,
    w?.gapRefs,
    gapIds,
    "终态-现状差距表（terminalForm.gapTable）",
  );
});
arr(s4?.scenarios).forEach((v, i) => {
  checkRefs(
    `s4-accept.json scenarios[${i}]（${v?.id ?? "缺 id"}）goalRefs`,
    v?.goalRefs,
    goalIds,
    "设计目标（s1-context.json goals）",
  );
});

// ── 规则 5：分型一致 ──

const designType = meta?.designType;
if (designType === "terminal") {
  const tf = s3?.terminalForm;
  if (tf === null || tf === undefined || typeof tf !== "object" || Array.isArray(tf)) {
    failures.push("[分型] meta.json designType=terminal 但 s3-solution.json 缺 terminalForm——终态型必填（axioms / targetForm / gapTable）");
  } else {
    if (arr(tf.axioms).length === 0) {
      failures.push("[分型] s3-solution.json terminalForm.axioms 缺失或为空——终态型须先立公理清单（每条为不变量陈述）");
    }
    if (!isFilled(tf.targetForm)) {
      failures.push("[分型] s3-solution.json terminalForm.targetForm 缺失或为空——终态型须写终态形态描述");
    }
    if (arr(tf.gapTable).length === 0) {
      failures.push("[分型] s3-solution.json terminalForm.gapTable 缺失或为空——终态型须写终态-现状差距表");
    }
  }
  if (arr(s3?.migrationWaves).length === 0) {
    failures.push("[分型] s3-solution.json migrationWaves 缺失或为空——终态型须有差距-波次映射（每条差距有归属波次）");
  }
} else if (designType === "evolution") {
  const tf = s3?.terminalForm;
  if (tf !== null && tf !== undefined && typeof tf === "object" && !Array.isArray(tf) && Object.keys(tf).length > 0) {
    failures.push("[分型] meta.json designType=evolution 但 s3-solution.json 带非空 terminalForm——演进型不得有终态形态登记（如需终态视角，把 designType 改为 terminal 并补全三字段）");
  }
  if (arr(s3?.migrationWaves).length > 0) {
    failures.push("[分型] meta.json designType=evolution 但 s3-solution.json 带非空 migrationWaves——演进型不得有迁移波次（如需分波迁移，把 designType 改为 terminal）");
  }
}

// ── 规则 6：产物表触发完备 ──

arr(s2?.assumptions).forEach((a, i) => {
  if (a?.status === "verified" && !isFilled(a.evidence)) {
    failures.push(
      `[前提] s2-status.json assumptions[${i}]（${a.id ?? "缺 id"}）status=verified 但 evidence 为空——已核实的前提必须附核实动作（file:line / 探针 / 排除记录）`,
    );
  }
});
const stateCopies = arr(s2?.artifactTables?.stateCopies);
if (stateCopies.length === 0) {
  failures.push(
    "[产物表] s2-status.json artifactTables.stateCopies 至少一行——状态副本清单不可为空（候选位置不存在副本时，登记为 excluded=true 的排除行）",
  );
}
stateCopies.forEach((row, i) => {
  const where = `s2-status.json artifactTables.stateCopies[${i}]（${row?.id ?? "缺 id"}）`;
  if (!["authority", "projection", "cache"].includes(row?.nature)) {
    failures.push(
      `[产物表] ${where} nature 值「${row?.nature ?? "缺失"}」不合法——合法取值：authority（权威）/ projection（派生视图）/ cache（缓存）`,
    );
  }
  if (row?.excluded === true) {
    if (!isFilled(row.exclusionNote)) {
      failures.push(`[产物表] ${where} excluded=true 但 exclusionNote 缺失——排除行必须附一句排除依据`);
    }
  } else if (!isFilled(row?.sync)) {
    failures.push(`[产物表] ${where} excluded=false 但 sync 为空——非排除行须写明与权威副本的同步机制`);
  }
});

// ── 规则 7：内容形态（渲染层可呈现性） ──

const typeLabel = designType === "terminal" ? "终态型" : designType === "evolution" ? "演进型" : null;
if (typeLabel !== null && isFilled(meta?.typeRationale) && String(meta.typeRationale).trimStart().startsWith(typeLabel)) {
  failures.push(
    `[内容形态] meta.json typeRationale 以分型名「${typeLabel}」开头——渲染器在「设计分型」行已带「${typeLabel}（${designType}）——」前缀，理由再以分型名开头会在渲染产物中重复；删去理由开头的分型名后重跑`,
  );
}
arr(s5?.units).forEach((u, i) => {
  const uid = u?.id ?? "缺 id";
  arr(u?.files).forEach((entry, j) => {
    if (typeof entry !== "string") return;
    for (const [open, close] of [
      ["（", "）"],
      ["(", ")"],
    ]) {
      const openCount = entry.split(open).length - 1;
      const closeCount = entry.split(close).length - 1;
      if (openCount !== closeCount) {
        failures.push(
          `[内容形态] s5-breakdown.json units[${i}]（${uid}）files[${j}] 的「${open}」${openCount} 个、「${close}」${closeCount} 个不配对——补齐说明括号，否则该文件的说明与后续文件条目粘连`,
        );
      }
    }
  });
});

// ── 规则 8：穷举断言可复算 warning（不阻塞；义务执行靠方向审 D2 按 must-fix 处置） ──
// 历次方向审打回的主形态即「唯一 / 限于 / 全集」断言被逐轮反例击穿（写者侧未穷举）；
// 断言附检索命令后审查从「重新发现」降为「重跑对账」
const EXHAUSTIVE_RE = /唯一|全集|限于/;
const SEARCH_CMD_RE = /\bgrep\b|\brg\b|ripgrep|检索命令|检索式/;
const rowText = (o) =>
  Object.values(o ?? {})
    .filter((v) => typeof v === "string")
    .join(" ");
arr(s2?.assumptions).forEach((a, i) => {
  if (EXHAUSTIVE_RE.test(String(a?.statement ?? "")) && !SEARCH_CMD_RE.test(rowText(a))) {
    warnings.push(
      `[穷举可复算] s2-status.json assumptions[${i}]（${a?.id ?? "缺 id"}）statement 含「唯一 / 全集 / 限于」穷举措辞但整行无检索命令——在 evidence 登记取得该断言的检索命令（含路径范围）与命中清单，使审查可重跑对账（不阻塞，方向审按 must-fix 处置）`,
    );
  }
});
arr(s2?.assumptionExclusions).forEach((x, i) => {
  const text = rowText(x);
  if (EXHAUSTIVE_RE.test(text) && !SEARCH_CMD_RE.test(text)) {
    warnings.push(
      `[穷举可复算] s2-status.json assumptionExclusions[${i}] 含穷举措辞但整行无检索命令——在 exclusionEvidence 登记检索命令（含路径范围）与命中清单（不阻塞，方向审按 must-fix 处置）`,
    );
  }
});
arr(s2?.artifactTables?.stateCopies).forEach((row, i) => {
  if (EXHAUSTIVE_RE.test(String(row?.exclusionNote ?? "")) && !SEARCH_CMD_RE.test(rowText(row))) {
    warnings.push(
      `[穷举可复算] s2-status.json artifactTables.stateCopies[${i}]（${row?.id ?? "缺 id"}）exclusionNote 含穷举措辞但整行无检索命令——在 exclusionNote 登记检索命令与命中清单（不阻塞，方向审按 must-fix 处置）`,
    );
  }
});

// ── 规则 9：渲染产物过期 warning（不阻塞） ──

const renderedName = `${basename(designDir)}.rendered.md`;
try {
  const renderedStat = statSync(join(designDir, renderedName));
  for (const file of CHAPTER_FILES) {
    let jsonStat;
    try {
      jsonStat = statSync(join(designDir, file));
    } catch {
      continue;
    }
    if (renderedStat.mtimeMs < jsonStat.mtimeMs) {
      warnings.push(
        `[提示] 渲染产物 ${renderedName} 早于 ${file} 的修改时间——重跑 node scripts/render-design-doc.mjs <设计目录> 刷新阅读视图（不阻塞本判定）`,
      );
      break;
    }
  }
} catch {
  warnings.push(
    `[提示] 渲染产物 ${renderedName} 缺失——运行 node scripts/render-design-doc.mjs <设计目录> 生成阅读视图（不阻塞本判定）`,
  );
}

// ── 输出 ──

if (failures.length === 0) {
  process.stdout.write("六文件完整、meta 必填、id 唯一、导航对齐、跨章节引用存在、分型一致、产物表完备、内容形态合法——八条规则全绿\n");
  for (const w of warnings) process.stdout.write(w + "\n");
  process.exit(0);
}
for (const f of failures) process.stdout.write(f + "\n");
process.stdout.write(`\n共 ${failures.length} 项未过：按上述逐条修复对应章节 JSON 后重跑本脚本，至全绿才进审查（机器项全绿 = 审查进场门槛）\n`);
for (const w of warnings) process.stdout.write(w + "\n");
process.exit(1);
