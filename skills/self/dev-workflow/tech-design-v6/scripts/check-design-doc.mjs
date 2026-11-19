#!/usr/bin/env node
// 设计包机器自检（flow/write.md 写作自检与 flow/review.md 进场门槛同一实现，
// 双轨语义等价由同一脚本保证）。设计文档权威源 = 设计目录内六个章节 JSON
// （schema 见 references/design-doc-schema.md）；本脚本按十条规则判定合法性，
// 机器可查问题在写作期拦截，不进审查轮次消耗人工。
//
// 十条规则：
//   1. 完整性：六文件存在；meta 必填字段非空；designType / priority / nature 枚举合法；
//      skillVersion 可选（有则查 semver 形态、无则放行——存量设计目录零影响）；
//      acceptanceBinding 有则核形态与子字段齐全（交付体系任务的验收绑定；无则 warning
//      提示——独立设计任务合法省略，子字段规格见 references/design-doc-schema.md §3）；
//      relatedDocs 为数组形态且元素有 path（不强制非空——纯语义登记，通用性不设 warning）
//   2. id 唯一：各数组内 id 不重复，全部 id 数组并集无重复（不同前缀 G/U/D 等各自编号）；
//      decisions[].guards[].id 同入全局并集（守护 id 与 gapTable 同为 G 前缀建议，编号须全局错开）；
//      guards.text 必须是叶子全文、不得内嵌 {{id}}——见规则 2 段校验
//   3. 导航对齐：meta.reviewNav[].decisionId 集合 == s3.decisions[].id 集合（A/B 级决策不得缺导航行）；
//      A 级导航行的 criteria 必填非空（命中判据编号；B 级可省——见 references/review-guide-rubric.md）
//   4. 引用存在：gapRefs / unitRefs / axiomRefs / goalRefs 引用的 id 在被引用数组中存在；
//      {{<id>}} 守护引用 token（递归扫描六章节全部字符串值）指向 decisions[].guards 登记的
//      id——{{...}} 是守护引用保留语法，正文不作字面量使用，凡 {{...}} 一律按引用校验；
//      conformance 绑定扩展段（可选字段，conformance schemaVersion 2，规格见
//      references/design-doc-schema.md §9b）：bindingId 锚定宿主条目（= 条目 id 或条目 id
//      + "-" + 后缀）且包内全局唯一、不与章节条目 id 撞名；violationKind / severity 在
//      词表内；evidenceInputs 元素非空、不重复、无守护引用语法——仅对带 conformance 字段
//      的条目生效，无绑定文档零失败零警告（向后兼容存量设计包）
//   5. 分型一致：terminal 必填 terminalForm 三字段与 migrationWaves；evolution 必须为空或缺失
//   6. 产物表与 e2e 影响面完备：verified 前提 evidence 非空；stateCopies 形态（空数组合法——
//      未触发即空数组、不补空表行，与另三张产物表同口径）、nature 枚举合法、excluded=false 行
//      sync 非空、excluded=true 行 exclusionNote 必填；s4 e2eImpact 必须存在且 items 非空与
//      noneReason 互斥（items 为空时 noneReason 必填，行内 name/action 非空）
//   7. 内容形态：typeRationale 不以分型名开头（渲染器已带「终态型（terminal）——」前缀，重复即冗余）；
//      s5 units files 条目全/半角括号配对（不配对的说明括号使条目与后续文件粘连）
//   8. warning（不阻塞）：穷举断言可复算——assumptions / assumptionExclusions / stateCopies
//      行声明 exhaustive=true 但 searchCmd 为空（缺检索命令的穷举断言审查无法重跑对账）。
//      warning 级是过渡分层：存量行未声明 exhaustive 字段，阻塞会使 T2 进场门槛批量
//      setup-failure；义务执行靠方向审按 must-fix 处置（模板 D2 规定动作），存量清偿后
//      可升级为阻塞
//   9. warning（不阻塞）：rendered.md 缺失或早于任一 json 修改时间
//   10. 单一登记（准则 14）：fail——guards[].text 两两精确重复（trim 后相等），同一守护全文
//       须全局只登记一处；warning（不阻塞）——非 guards.text 字符串值中「无空白 ≥30 字符、
//       且命令动词开头 / 正则元字符聚集 / 含 ASCII 左括号」的特征子串跨 ≥2 个字段逐字重复
//       （同字段路径内重复不计数；guards[].text 是登记处自身，不参与提取）；warning（不阻塞）
//       ——guards[].text 登记全文在正文其他字段的逐字残留（登记处是唯一权威副本，残留副本
//       不随登记更新，收敛为 {{<id>}} 引用）。warning 级是
//       过渡分层：存量设计包正则 / 命令多处逐字重复在途，阻塞会批量 setup-failure；收敛
//       方向 = decisions[].guards 单一登记 + {{<id>}} 引用，存量清偿后可升级为阻塞
//
// 用法：
//   node check-design-doc.mjs <设计目录>
// 输出：exit 0 = 十条规则全绿（stdout 一行确认；warning 只提示不改判定）；
//   exit 1 = stdout 逐项失败原因（每条指明哪个文件哪个字段缺什么 / 引用了不存在的
//   什么 id），或 md 输入的迁移指引；exit 2 = 用法错误

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── 规则 10 判据常量（判据经 2026-11-09 真实设计包探针实证：命中 1 组真实重复、零误报——
// 真实设计包 intraday-watch 的 httpx 守护正则 4 处逐字重复被恰好一组命中、中文正文零命中；
// 元字符聚集取正类，否定类会把中文标题 / 文件路径等普通长 token 全数放进候选） ──
const GUARD_TEXT_MIN_TOKEN_LEN = 30; // 短于 30 字符的路径片段等不构成逐字对账负担
const GUARD_COMMAND_VERBS = ["grep", "rg", "ripgrep", "node", "python", "python3", "pytest", "npm", "git", "curl", "sqlite3", "find", "awk", "sed"];
// 动词后须跟非单词字符（字母 / 数字 / 下划线都不算边界）——避免 github 式前缀误命中动词
// git，也避免 git_status_xxx 式标识符延续命中动词分支（真实命令动词后是空格 / 连字符 / 斜杠）
const GUARD_COMMAND_VERB_RE = new RegExp(`^(?:${GUARD_COMMAND_VERBS.join("|")})(?!\\w)`);
const GUARD_META_CLUSTER_RE = /[$\[\]{}|*+\\]{2,}/; // 正则元字符（$[]{}|*+\）2 个以上连续聚集
// {{<id>}} 守护引用完整 token（规则 2 段 guards.text 叶子禁令与规则 4 段引用校验共用；
// 顶层 const 按声明序执行，必须先于 guards 解析段声明，否则规则 2 段先引用会抛 ReferenceError）
const GUARD_REF_RE = /\{\{([^{}]+)\}\}/g;

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

// 递归收集 JSON 值中的全部字符串（路径形态与既有规则消息一致：字段.子字段[下标]；
// 供规则 4 守护引用扫描与规则 10 特征子串提取共用一次遍历）
function collectStrings(value, path, file, out) {
  if (typeof value === "string") {
    out.push({ file, path: path === "" ? "(顶层)" : path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, file, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, path === "" ? key : `${path}.${key}`, file, out);
    }
  }
}

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
  // skillVersion：可选字段（产物溯源——本设计包由哪个技能版本产出，值读技能 SKILL.md
  // frontmatter version），additive 校验：有则查 semver 形态、无则放行（存量设计目录零影响）
  if (meta.skillVersion !== undefined) {
    if (typeof meta.skillVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(meta.skillVersion.trim())) {
      failures.push(
        `[枚举] meta.json skillVersion 值「${String(meta.skillVersion)}」不是 semver 形态（MAJOR.MINOR.PATCH）——值读本技能 SKILL.md frontmatter version（唯一权威），不填可整字段删除（存量兼容形态）`,
      );
    }
  }
  // acceptanceBinding：交付体系任务的验收绑定（flow/write.md Step 0 入口门写入，子字段
  // 规格见 references/design-doc-schema.md §3；dev-flow-v6 入口门核对其与当前批准一致）。
  // additive 校验：有则核形态与子字段齐全（fail），无则 warning 提示——独立设计任务
  // （非交付体系）合法省略，缺失不阻塞（存量设计目录零影响）
  if (meta.acceptanceBinding !== undefined) {
    const ab = meta.acceptanceBinding;
    if (ab === null || typeof ab !== "object" || Array.isArray(ab)) {
      failures.push(
        "[验收绑定] meta.json acceptanceBinding 须为对象 { acceptanceVersion, acceptancePackageSha256, taskDir }——子字段规格见 references/design-doc-schema.md §3；独立设计任务整字段删除",
      );
    } else {
      if (typeof ab.acceptanceVersion !== "number" || !Number.isInteger(ab.acceptanceVersion) || ab.acceptanceVersion < 1) {
        failures.push(
          `[验收绑定] meta.json acceptanceBinding.acceptanceVersion 值「${String(ab.acceptanceVersion)}」须为 ≥1 的整数（delivery-v6 approve-acceptance 后的当前验收版本号）`,
        );
      }
      if (typeof ab.acceptancePackageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(ab.acceptancePackageSha256)) {
        failures.push(
          "[验收绑定] meta.json acceptanceBinding.acceptancePackageSha256 须为 64 位 sha256 十六进制字符串（绑定的验收包哈希）",
        );
      }
      if (!isFilled(ab.taskDir)) {
        failures.push(
          "[验收绑定] meta.json acceptanceBinding.taskDir 缺失或为空——填交付任务目录绝对路径（~/.agents/skill-data/delivery/<分组 slug>/<taskId>/）",
        );
      }
    }
  } else {
    warnings.push(
      "[验收绑定] meta.json 无 acceptanceBinding——交付体系任务须在 T1 入口门写入（flow/write.md Step 0：验收批准检查通过后写 { acceptanceVersion, acceptancePackageSha256, taskDir }）；独立设计任务（非交付体系）合法省略（不阻塞本判定）",
    );
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

// decisions[].guards：守护登记数组（可选；每条 { id, text, note? }）。id 并入上方全局
// 并集（与 gapTable 同为 G 前缀建议，编号须全局错开）；text 是守护全文的唯一登记处——
// 规则 4 的 {{<id>}} 引用与规则 10 的单一登记均以它为基准
const guardsIdSet = new Set();
const guardsTextLocations = new Map(); // trim 后守护全文 -> { locations: string[], ids: string[] }
const guardsTextPaths = new Set(); // 登记处字段路径（规则 10 特征子串提取时排除）
arr(s3?.decisions).forEach((d, i) => {
  const did = d?.id ?? "缺 id";
  const guards = d?.guards;
  if (guards === undefined) return;
  if (!Array.isArray(guards)) {
    failures.push(
      `[守护] s3-solution.json decisions[${i}]（${did}）guards 须为数组——每条守护一个条目（{ id, text, note? }，id 建议取 G 前缀（如 G1）、全局唯一），无守护时删除该字段`,
    );
    return;
  }
  const localSeen = new Map(); // id -> guards 下标[]
  guards.forEach((g, j) => {
    const where = `s3-solution.json decisions[${i}].guards[${j}]`;
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      failures.push(`[守护] ${where} 条目须为对象（{ id, text, note? }）——id 建议取 G 前缀（如 G1）、全局唯一，text 为守护全文`);
      return;
    }
    const id = g.id;
    const text = g.text;
    if (typeof id !== "string" || id.trim() === "") {
      failures.push(
        `[守护] ${where} id 缺失、非字符串或为空——每条守护须有全局唯一 id（建议取 G 前缀，如 G1），文本字段以 {{<id>}} token 引用本条`,
      );
    }
    if (typeof text !== "string" || text.trim() === "") {
      failures.push(
        `[守护] ${where} text 缺失、非字符串或为空——text 须登记守护全文，其余章节以 {{<id>}} 引用、不在正文逐字重复`,
      );
    }
    // 叶子禁令：guards.text 登记守护全文本身，必须是叶子内容——内嵌 {{...}} 即嵌套 / 自引用 /
    // 成环（{{...}} 在登记处 text 内也指其他守护或自身，语义上无法成立）
    if (typeof text === "string" && text.matchAll(GUARD_REF_RE).next().value !== undefined) {
      failures.push(
        `[守护] ${where} text 内嵌 {{...}} 引用——guards.text 登记的是守护全文本身，必须是叶子内容：不得引用其他守护、不得自引用、不得成环（嵌套一律禁止）；引用方在正文文本字段用 {{<id>}}，登记处只放全文`,
      );
    }
    if (typeof text === "string") guardsTextPaths.add(`${where}.text`);
    if (typeof id === "string" && id.trim() !== "") {
      guardsIdSet.add(id);
      if (!localSeen.has(id)) localSeen.set(id, []);
      localSeen.get(id).push(j);
    }
    if (typeof text === "string" && text.trim() !== "") {
      const key = text.trim();
      if (!guardsTextLocations.has(key)) guardsTextLocations.set(key, { locations: [], ids: [] });
      guardsTextLocations.get(key).locations.push(where);
      if (typeof id === "string" && id.trim() !== "") guardsTextLocations.get(key).ids.push(id);
    }
  });
  for (const [id, indexes] of localSeen) {
    if (indexes.length > 1) {
      failures.push(
        `[id] s3-solution.json decisions[${i}]（${did}）guards 内 id「${id}」重复出现（${indexes.map((j) => `guards[${j}]`).join(" 与 ")}）——同一数组内 id 不得重复`,
      );
    }
    if (!globalIdLocations.has(id)) globalIdLocations.set(id, []);
    globalIdLocations.get(id).push(`s3-solution.json decisions[${i}].guards[${indexes[0]}]`);
  }
});
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
  // A 级决策必须可人工逐条裁决：criteria 写命中判据编号（判据见 references/review-guide-rubric.md）。
  // B 级可省——review-guide-rubric 的 B 级定位是「无异议即过」，不要求逐条给判据编号
  if (r?.level === "A" && !isFilled(r?.criteria)) {
    failures.push(
      `[导航] meta.json reviewNav 中 A 级决策「${r.decisionId ?? "缺 decisionId"}」的 criteria 缺失或为空——A 级决策须写命中判据编号（如「命中判据 2：权威源归属变更」），使人工审核有裁决依据`,
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

// {{<id>}} 守护引用：完整 token 形态，内层 trim 后须命中 guards 登记的 id。{{...}} 是守护
// 引用保留语法——设计文档正文不出现双花括号字面量，凡 {{...}} 一律按引用校验（内容不在
// guards id 集 = 拼错 id 或误用保留语法，从严 fail）
const allStrings = []; // { file, path, text }——六章节全部字符串值（规则 4 引用扫描与规则 10 特征子串提取共用）
for (const file of CHAPTER_FILES) {
  collectStrings(docs[file], "", file, allStrings);
}
for (const { file, path, text } of allStrings) {
  const reported = new Set(); // 同一字符串内同一坏引用只报一次
  for (const m of text.matchAll(GUARD_REF_RE)) {
    const ref = m[1].trim();
    if (guardsIdSet.has(ref) || reported.has(ref)) continue;
    reported.add(ref);
    const hint =
      guardsIdSet.size > 0
        ? `decisions[].guards 现有 id：${[...guardsIdSet].join("、")}`
        : "本文档未登记任何守护（decisions[].guards 缺失或为空）";
    failures.push(
      `[引用] ${file} ${path} 引用了不存在的守护「${ref}」——{{...}} 是守护引用保留语法（守护在 s3-solution.json decisions[].guards 登记，${hint}）`,
    );
  }
}

// ── 规则 4 扩展段：conformance 绑定校验（可选字段，conformance schemaVersion 2）──
// 词表纪律：violationKind 词表的唯一权威在 conformance-plane/kernel/facts.mjs VIOLATION_KINDS，
// 本副本与权威源的一致性由 scripts/tests/obligation-identity.test.mjs 对账断言——扩词表必须
// 两处同步并升 conformance schema 版本（references/design-doc-schema.md §9b）

const CONFORMANCE_SCHEMA_VERSION = 2;
const CONFORMANCE_VIOLATION_KINDS = [
  "missing-implementation",
  "behavior-mismatch",
  "contract-mismatch",
  "documentation-mismatch",
  "test-evidence-missing",
  "overimplementation",
];
const CONFORMANCE_SEVERITY_KINDS = ["must-fix", "suggestion", "info"];

function checkConformanceBinding(binding, where, entryId, hostLoc, seenBindingIds) {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    failures.push(`[conformance] ${where} 绑定条目须为对象——字段规格见 references/design-doc-schema.md §9b（conformance schemaVersion ${CONFORMANCE_SCHEMA_VERSION}）`);
    return;
  }
  // bindingId：缺省 = 宿主条目 id；显式值必须锚定宿主条目（= 条目 id 或条目 id + "-" + 后缀）
  const bindingId = binding.bindingId ?? entryId;
  if (typeof bindingId !== "string" || bindingId.trim() === "") {
    failures.push(`[conformance] ${where} bindingId 为空——义务绑定 id 缺省取宿主条目 id，显式取值须为「${entryId}」或「${entryId}-后缀」形态`);
  } else if (bindingId !== entryId && !bindingId.startsWith(`${entryId}-`)) {
    failures.push(
      `[conformance] ${where} bindingId「${bindingId}」未锚定宿主条目「${entryId}」——差距地址绑定 id 须指向存在的章节条目：取条目 id 本身，或条目 id + "-" + 后缀（同条目多绑定形态）`,
    );
  } else {
    // 与其他章节条目 id 撞名：宿主自身 id 之外占用任何全局 id 会在状态仓绑定集里撞身份
    if (globalIdLocations.has(bindingId) && !globalIdLocations.get(bindingId).includes(hostLoc)) {
      failures.push(
        `[conformance] ${where} bindingId「${bindingId}」与章节条目 id 撞名（已定义于 ${globalIdLocations.get(bindingId).join("、")}）——绑定 id 须全局唯一，改用「${entryId}-后缀」形态`,
      );
    }
    if (seenBindingIds.has(bindingId)) {
      failures.push(
        `[conformance] ${where} bindingId「${bindingId}」重复出现于 ${seenBindingIds.get(bindingId)}——差距地址 (bindingId, repoId, violationKind) 的身份键须唯一`,
      );
    }
    seenBindingIds.set(bindingId, where);
  }
  for (const field of ["repoId", "targetSelector", "checkerId"]) {
    const v = binding[field];
    if (typeof v !== "string" || v.trim() === "") {
      failures.push(`[conformance] ${where} 字段 ${field} 缺失或为空——必填非空字符串（义务机器契约字段，规格见 §9b）`);
    }
  }
  if (!CONFORMANCE_VIOLATION_KINDS.includes(binding.violationKind)) {
    failures.push(
      `[conformance] ${where} violationKind 值「${String(binding.violationKind ?? "缺失")}」不在词表——合法取值：${CONFORMANCE_VIOLATION_KINDS.join(" / ")}；扩词表须升 conformance schema 版本（当前 ${CONFORMANCE_SCHEMA_VERSION}）`,
    );
  }
  if (!CONFORMANCE_SEVERITY_KINDS.includes(binding.severity)) {
    failures.push(
      `[conformance] ${where} severity 值「${String(binding.severity ?? "缺失")}」不在词表——合法取值：${CONFORMANCE_SEVERITY_KINDS.join(" / ")}；扩词表须升 conformance schema 版本（当前 ${CONFORMANCE_SCHEMA_VERSION}）`,
    );
  }
  const inputs = binding.evidenceInputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    failures.push(`[conformance] ${where} evidenceInputs 缺失或为空——义务检查依赖输入清单须为非空字符串数组（无输入的义务不可判定证据有效性）`);
  } else {
    const seen = new Set();
    inputs.forEach((input, k) => {
      if (typeof input !== "string" || input.trim() === "") {
        failures.push(`[conformance] ${where} evidenceInputs[${k}] 为空或非字符串——每个元素须是具体输入名（路径 / 符号 / 章节引用）`);
        return;
      }
      if (input.matchAll(GUARD_REF_RE).next().value !== undefined) {
        failures.push(`[conformance] ${where} evidenceInputs[${k}] 使用了 {{...}} 守护引用保留语法——输入名须写实义，不用引用标记`);
      }
      if (seen.has(input)) {
        failures.push(`[conformance] ${where} evidenceInputs[${k}]「${input}」组内重复——依赖输入清单不重复登记`);
      }
      seen.add(input);
    });
  }
  if (binding.bindingVersion !== undefined && (typeof binding.bindingVersion !== "number" || !Number.isInteger(binding.bindingVersion) || binding.bindingVersion < 1)) {
    failures.push(`[conformance] ${where} bindingVersion 须为 ≥1 的整数（缺省 1；绑定内容修订时 bump，旧证据按版本等值自动失效）`);
  }
}

const seenConformanceBindingIds = new Map(); // bindingId -> 首次登记位置（包内全局唯一，跨章节去重）
for (const [file, path, getItems] of ID_ARRAYS) {
  const doc = docs[file];
  if (doc === undefined) continue;
  arr(getItems(doc)).forEach((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.conformance === undefined) return;
    const where = `${file} ${path}[${i}]（${entry.id ?? "缺 id"}）.conformance`;
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      failures.push(`[conformance] ${file} ${path}[${i}] 条目缺稳定 id——绑定锚定章节条目 id，无 id 条目不得声明 conformance`);
      return;
    }
    if (Array.isArray(entry.conformance) && entry.conformance.length === 0) {
      failures.push(`[conformance] ${where} 为空数组——声明绑定至少登记一条绑定对象；无绑定时删除该字段（叙述性声明不进覆盖率分母）`);
      return;
    }
    const hostLoc = `${file} ${path}[${i}]`;
    const isMulti = Array.isArray(entry.conformance);
    const bindings = isMulti ? entry.conformance : [entry.conformance];
    bindings.forEach((binding, k) =>
      checkConformanceBinding(binding, isMulti ? `${where}[${k}]` : where, entry.id, hostLoc, seenConformanceBindingIds),
    );
  });
}

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
// 未触发的产物表为空数组（与 signalImplications / repairHistory / upstreamDeps 同口径，
// 写作指令见 flow/write.md「触发了才有行，未触发的表为空数组」）——空数组不补空表行，不拦
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

// e2e 影响面评估（s4-accept.json 固定子节，下游 T3 按标题继承）：字段本身必填——缺失 /
// 非对象 / items 非数组 / 空 items 无 noneReason 三者任一即 fail。此前由「渲染标题恒存在」
// 兜底，省略字段会在渲染视图显示「无受影响项（—）」而被静默继承为零验证节点（flow/write.md
// Step 4 的「禁止留空或省略」在机器层落位）
if (s4 !== undefined) {
  const e2e = s4.e2eImpact;
  const e2eWhere = "s4-accept.json e2eImpact";
  if (e2e === undefined || e2e === null || typeof e2e !== "object" || Array.isArray(e2e)) {
    failures.push(
      `[e2e 影响面] ${e2eWhere} 缺失或不是对象——§4 固定子节必填：{ items, noneReason }；无受影响项时 items 为空数组且 noneReason 填依据（禁止留空或省略字段，空集会被下游静默继承为零验证节点）`,
    );
  } else if (!Array.isArray(e2e.items)) {
    failures.push(
      `[e2e 影响面] ${e2eWhere}.items 须为数组（受影响测试资产清单，每项 { name, action }）——无受影响项时写空数组并在 noneReason 填依据`,
    );
  } else {
    e2e.items.forEach((item, i) => {
      const where = `${e2eWhere}.items[${i}]`;
      if (!isFilled(item?.name)) {
        failures.push(`[e2e 影响面] ${where} 缺 name——每项须写受影响测试资产名（e2e / 真实进程 / 真实 LLM 资产）`);
      }
      if (!isFilled(item?.action)) {
        failures.push(`[e2e 影响面] ${where} 缺 action——每项须写开发阶段需跑的子集与命令，或「不跑（理由）」`);
      }
    });
    if (e2e.items.length === 0 && !isFilled(e2e.noneReason)) {
      failures.push(
        `[e2e 影响面] ${e2eWhere}.items 为空数组但 noneReason 缺失或为空——无受影响项时必须填判定依据；有受影响项时 items 不可为空`,
      );
    }
  }
}

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
// 历次方向审打回的主形态即穷举断言被逐轮反例击穿（写者侧未穷举）；断言附检索命令后
// 审查从「重新发现」降为「重跑对账」。2026-11-04 字段化：声明义务 = exhaustive（布尔）
// + searchCmd（结构化字段），纯字段判定——旧的措辞扫描（唯一/全集/限于）与「整行任一
// 字段含 grep 字样即豁免」的整行匹配同时退役（后者有漏警面：无关字段偶然含检索字样
// 会豁免真穷举行）。exhaustive 缺省 false（存量设计包兼容：未声明 = 未声明穷举，语义
// 兜底在方向审的语义审查）；首次扫完无一处 exhaustive 字段时发一条存量提示引导补声明
const exhaustiveWarnings = (rows, label, anchorField, anchorNote) => {
  rows.forEach((r, i) => {
    if (r?.exhaustive === true && (typeof r?.searchCmd !== "string" || r.searchCmd.trim() === "")) {
      warnings.push(
        `[穷举可复算] s2-status.json ${label}[${i}]（${r?.[anchorField] ?? "缺 id"}）声明 exhaustive=true 但 searchCmd 空——登记取得该断言的检索命令（含路径范围）与命中清单（登记在 ${anchorNote}），使审查可重跑对账（不阻塞，方向审按 must-fix 处置）`,
      );
    }
  });
};
let anyExhaustiveDeclared = false;
const noteExhaustiveDeclared = (rows) => {
  if (rows.some((r) => r?.exhaustive !== undefined)) anyExhaustiveDeclared = true;
};
// 局部名带 ex 前缀：规则 6 已在同名作用域声明过 assumptions/stateCopies（行数校验用），避免重复声明
const exAssumptions = arr(s2?.assumptions);
noteExhaustiveDeclared(exAssumptions);
exhaustiveWarnings(exAssumptions, "assumptions", "id", "searchCmd/evidence 字段");
const exExclusions = arr(s2?.assumptionExclusions);
noteExhaustiveDeclared(exExclusions);
exhaustiveWarnings(exExclusions, "assumptionExclusions", "assertion", "searchCmd/exclusionEvidence 字段");
const exStateCopies = arr(s2?.artifactTables?.stateCopies);
noteExhaustiveDeclared(exStateCopies);
exhaustiveWarnings(exStateCopies, "artifactTables.stateCopies", "id", "searchCmd/exclusionNote 字段");
if (exAssumptions.length + exExclusions.length + exStateCopies.length > 0 && !anyExhaustiveDeclared) {
  warnings.push(
    `[穷举声明] s2-status.json 的 assumptions / assumptionExclusions / stateCopies 均未声明 exhaustive 字段（存量设计包兼容形态，缺省 = 未声明穷举）——断言含穷举前提（唯一 / 全集 / 限于式）时按 schema 声明 exhaustive=true 并登记 searchCmd 检索命令，使审查可重跑对账（不阻塞本判定）`,
  );
}

// ── 规则 9：渲染产物过期 warning（不阻塞） ──

// 产物名取自目录名 basename；目录参数为相对的「.」/「..」时 basename 取到点号，
// 拼出「..rendered.md」式畸形产物名。与 render-design-doc.mjs 入口检查对称：本侧只读
// 不写盘，不需要 exit 2 拦截——跳过产物时效对比，warning 直接指路绝对路径
const dirBase = basename(designDir);
if (dirBase === "." || dirBase === "..") {
  warnings.push(
    `[提示] 设计目录参数是相对的「${designDir}」——渲染产物名取自目录名，点号目录会推算错位（${dirBase}.rendered.md），无法判定渲染产物是否过期；请传设计目录的绝对路径重跑（不阻塞本判定）`,
  );
} else {
  const renderedName = `${dirBase}.rendered.md`;
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
}

// ── 规则 10：单一登记（准则 14）——C1 fail：guards[].text 全局唯一；C2 warning：跨字段特征子串逐字重复 ──

// C1：同一守护全文两两精确重复（trim 后相等）。逐字重复登记不是冗余备份——修复漏改一处
// 即自相矛盾（准则 14），全文只允许在 guards 一个条目登记
for (const { locations } of guardsTextLocations.values()) {
  if (locations.length > 1) {
    failures.push(
      `[单一登记] 守护文本重复登记于 ${locations.join(" 与 ")}——text 须全局唯一（准则 14 单一登记）：保留一处登记，其余位置改用 {{<守护 id>}} 引用`,
    );
  }
}

// C1b：登记全文在正文其他字段的逐字残留（warning 不阻塞——存量残留逐字重复在途清偿，
// 收敛方向 = 残留处改 {{<守护 id>}} 引用）。trim 后 < 6 字符的过短登记全文不构成对账
// 负担，跳过；登记处自身（guardsTextPaths）不参与扫描
for (const [key, { ids }] of guardsTextLocations) {
  if (key.length < 6) continue;
  const residual = [];
  for (const entry of allStrings) {
    if (guardsTextPaths.has(`${entry.file} ${entry.path}`)) continue;
    if (entry.text.includes(key)) residual.push(`${entry.file} ${entry.path}`);
  }
  if (residual.length > 0) {
    warnings.push(
      `[单一登记] 守护「${ids.join("、")}」的登记全文仍在正文逐字残留（${residual.join("；")}）——登记处是唯一权威副本，残留副本不随登记更新、修一处漏一处即自相矛盾（准则 14）；收敛为 {{<守护 id>}} 引用（不阻塞本判定）`,
    );
  }
}

// C2：跨字段特征子串逐字重复（warning 不阻塞——存量逐字重复在途清偿）。提取对象 = 非登记处
// 的全部字符串值按空白切 token；guards[].text 自身不参与提取（收敛为单一登记后登记处 +
// 引用侧并存是目标形态，登记处参与会反向误报）；同一字段路径内重复出现不计数，跨字段才算
const featureTokenLocations = new Map(); // token -> Set<`文件 字段路径`>
for (const { file, path, text } of allStrings) {
  if (guardsTextPaths.has(`${file} ${path}`)) continue;
  for (const token of text.split(/\s+/)) {
    if (token.length < GUARD_TEXT_MIN_TOKEN_LEN) continue;
    if (!GUARD_COMMAND_VERB_RE.test(token) && !GUARD_META_CLUSTER_RE.test(token) && !token.includes("(")) continue;
    const location = `${file} ${path}`;
    if (!featureTokenLocations.has(token)) featureTokenLocations.set(token, new Set());
    featureTokenLocations.get(token).add(location);
  }
}
for (const [token, locations] of featureTokenLocations) {
  if (locations.size < 2) continue;
  warnings.push(
    `[单一登记] 特征子串「${token}」跨 ${locations.size} 个字段逐字重复（${[...locations].join("；")}）——同一内容（正则 / 命令 / 断言句等）多处逐字重复，修复漏改一处即自相矛盾（准则 14）；收敛为 decisions[].guards 单一登记 + {{<守护 id>}} 引用，或按准则 14 在决策节登记全部登记点清单（不阻塞本判定）`,
  );
}

// ── V5 质量契约：断言与机制对账、反例场景测试绑定（schema 1 自动跳过） ──
if (failures.length === 0 && typeof meta?.acceptanceBinding?.taskDir === "string") {
  const checker = join(dirname(fileURLToPath(import.meta.url)), "../../delivery-v6/scripts/check-quality-contract.mjs");
  const checked = spawnSync(process.execPath, [checker, "--task-dir", meta.acceptanceBinding.taskDir, "--design-dir", designDir], { encoding: "utf8" });
  if (checked.status !== 0) {
    failures.push(`[质量契约] ${String(checked.stdout || checked.stderr).trim()}——按提示补齐 criterionMechanisms 与 verificationBindings 后重跑`);
  }
}

// ── 输出 ──

if (failures.length === 0) {
  process.stdout.write("六文件完整、meta 必填、id 唯一、导航对齐、跨章节引用与守护引用存在、分型一致、产物表完备、内容形态合法、守护单一登记——十条规则全绿\n");
  for (const w of warnings) process.stdout.write(w + "\n");
  process.exit(0);
}
for (const f of failures) process.stdout.write(f + "\n");
process.stdout.write(`\n共 ${failures.length} 项未过：按上述逐条修复对应章节 JSON 后重跑本脚本，至全绿才进审查（机器项全绿 = 审查进场门槛）\n`);
for (const w of warnings) process.stdout.write(w + "\n");
process.exit(1);
