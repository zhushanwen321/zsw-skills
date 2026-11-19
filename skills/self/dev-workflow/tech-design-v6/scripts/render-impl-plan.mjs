#!/usr/bin/env node
// impl-plan 渲染脚本：把实施计划唯一权威 .impl-plan.json 确定性渲染为阅读视图 .impl-plan.md。
// JSON 是权威源，md 是生成视图（禁手改）；「哪个 md 元素由哪个 JSON 字段渲染」的终态对照见
// references/impl-plan-mapping.md——本脚本与映射表一字对一字，改字段先改映射表。
//
// 用法：
//   node render-impl-plan.mjs <路径>/<name>.impl-plan.json           # 生成/覆盖同目录 <name>.impl-plan.md
//   node render-impl-plan.mjs <路径>/<name>.impl-plan.json --check   # 重新渲染与盘上视图比对，不写盘
//
// 设计规则（设计稿 §4/§7）：
//   - 渲染幂等：同输入逐字节同输出（固定字段顺序、无时间戳；运行时值不入生成文本）
//   - 文件头一行生成器元数据注释（生成器版本 + 输入 sha256 + 重新生成命令）——观测性元数据，
//     --check 比较时剔除，不参与内容等价（JSON 重排版会改哈希但不改内容，不得误报）
//   - 语义缺口：必填字段缺失时列出全部缺失路径并拒绝渲染（不猜测）；语义完备性判据
//     （提速结论、验收完整性等）归 T3 自检与下游专门门，渲染器只做字段→视图映射
//   - 错误消息 = 哪个输入不合法 → 权威源在哪里 → 修改后运行哪个生成命令
//
// 退出码：0 成功；1 输入不合法 / 语义缺口 / 渲染不一致；2 用法错误

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 渲染器版本（观测性元数据，写入生成视图头部注释）：MINOR = 渲染行为新增——1.1.0 加
// units[].kind=contract-spike 的 Unit 列后缀标注（additive，无 kind 字段的存量计划
// 渲染结果逐字节不变，映射表 §1.2 登记该字段）。cwd 弱一致性校验属输入校验加固，不改变
// 合法计划的渲染输出（不升渲染器版本——版本号只标记渲染行为变化）
const RENDERER_VERSION = "1.1.0";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MAPPING_DOC = "skills/self/dev-workflow/tech-design-v6/references/impl-plan-mapping.md";
const META_PREFIX = "<!-- 生成视图：";

function failUsage(msg) {
  process.stderr.write(
    `用法错误：${msg}\n用法：node render-impl-plan.mjs <路径>/<name>.impl-plan.json> [--check]\n`,
  );
  process.exit(2);
}

/** 语义缺口 / 渲染不一致的统一错误出口：哪个输入不合法 → 权威源 → 恢复命令（设计稿 §7 形态） */
function fail(planPath, lines) {
  process.stderr.write(
    [
      ...lines,
      `权威源：${planPath} 是唯一计划权威（md 元素 ↔ JSON 字段对照见 ${MAPPING_DOC}）。`,
      `恢复：node ${SCRIPT_PATH} ${planPath}`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// ── 参数解析 ──

const args = process.argv.slice(2);
const check = args.includes("--check");
const positional = args.filter((a) => a !== "--check");
if (positional.length !== 1) failUsage("缺少 impl-plan.json 路径参数（或多传了参数）");
const planPath = positional[0];
if (!basename(planPath).endsWith(".impl-plan.json")) {
  failUsage(`参数须是 .impl-plan.json 文件（渲染视图输出路径由它同目录推导），收到：${planPath}`);
}
const planPathAbs = resolve(planPath);
const mdPath = join(
  dirname(planPathAbs),
  basename(planPathAbs).replace(/\.impl-plan\.json$/, ".impl-plan.md"),
);

// ── 读取与必填校验（语义缺口在渲染前拦截，全部列完再退出） ──

let raw;
try {
  raw = readFileSync(planPathAbs, "utf8");
} catch {
  // 文件不存在时「运行渲染命令」不可操作（命令仍指向不存在的文件）——恢复动作改为
  // 路径核对 + 回 T3 重新产出，不走带通用恢复命令的 fail() 出口
  process.stderr.write(
    [
      `FAIL: 输入不合法——${planPathAbs} 不存在或不可读（--check 与渲染共用该输入）。`,
      `权威源：impl-plan.json 由 tech-design-v6 T3 产出（flow/plan.md「JSON 单源产出」节；字段落点见 ${MAPPING_DOC}）。`,
      "恢复：先核对路径（渲染视图与计划 JSON 同目录、命名 <name>.impl-plan.json）；路径无误说明计划尚未产出或已移动——回 tech-design-v6 T3 重新产出 impl-plan.json 后再运行本命令。",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
let plan;
try {
  plan = JSON.parse(raw);
} catch (e) {
  fail(planPathAbs, [`FAIL: 输入不合法——${planPathAbs} JSON 解析失败：${e.message}`]);
}

const missing = [];
/** 必填判据：字段存在且非 null（空串/空数组算存在——语义完备性归专门门，渲染器只管「有无权威落点」） */
const req = (v, path) => {
  if (v === undefined || v === null) missing.push(path);
  return v;
};
req(plan.name, "name");
req(plan.designDoc, "designDoc");
req(plan.baseline, "baseline");
req(plan.skillVersion, "skillVersion");
const sectionMap = req(plan.sectionMap, "sectionMap");
if (sectionMap !== undefined && sectionMap !== null) {
  if (typeof sectionMap !== "object" || Array.isArray(sectionMap)) {
    missing.push("sectionMap（须是对象）");
  } else {
    for (const k of ["goal", "mechanism", "acceptance", "breakdown"]) req(sectionMap[k], `sectionMap.${k}`);
  }
}
const units = req(plan.units, "units");
const unitList = Array.isArray(units) ? units : null;
if (units !== undefined && units !== null && unitList === null) missing.push("units（须是数组）");
if (unitList) {
  unitList.forEach((u, i) => {
    for (const k of ["id", "responsibility", "territory", "deps", "isolation", "acceptance", "decisionTier"]) {
      req(u?.[k], `units[${i}].${k}`);
    }
  });
}
const testPlan = req(plan.testPlan, "testPlan");
if (testPlan !== undefined && testPlan !== null) {
  if (typeof testPlan !== "object" || Array.isArray(testPlan)) missing.push("testPlan（须是对象）");
  else {
    req(testPlan.fullSuite, "testPlan.fullSuite");
    // artifacts 可省略整个字段；条目存在时 id/command 逐条必填（缺失进语义缺口，不猜测渲染）
    if (testPlan.artifacts !== undefined && testPlan.artifacts !== null) {
      if (!Array.isArray(testPlan.artifacts)) missing.push("testPlan.artifacts（须是数组）");
      else {
        testPlan.artifacts.forEach((a, i) => {
          req(a?.id, `testPlan.artifacts[${i}].id`);
          req(a?.command, `testPlan.artifacts[${i}].command`);
        });
      }
    }
  }
}
const acceptancePlan = req(plan.acceptancePlan, "acceptancePlan");
const acceptanceList = Array.isArray(acceptancePlan) ? acceptancePlan : null;
if (acceptancePlan !== undefined && acceptancePlan !== null && acceptanceList === null) {
  missing.push("acceptancePlan（须是数组）");
}
if (acceptanceList) {
  acceptanceList.forEach((a, i) => {
    for (const k of ["id", "item", "level", "group", "deps", "optimization"]) req(a?.[k], `acceptancePlan[${i}].${k}`);
  });
}
if (missing.length > 0) {
  fail(
    planPathAbs,
    [
      `FAIL: 语义缺口——${planPathAbs} 缺渲染必填字段（共 ${missing.length} 处，不猜测渲染）：`,
      ...missing.map((p) => `  - ${p}`),
    ],
  );
}

// ── 渲染基础函数（与 render-design-doc.mjs 同约定：cell 转义、缺失显示 —） ──

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";
const arr = (v) => (Array.isArray(v) ? v : []);
/** 表格单元格：竖线转义、换行压成空格；缺失值显示 — */
const cell = (v) =>
  isEmpty(v) ? "—" : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
/** 普通行内文本（不经表格）：换行压成空格 */
const line = (v) => (isEmpty(v) ? "—" : String(v).replace(/\r?\n/g, " ").trim());
/** 顿号连接列表；空 → — */
const joinList = (v) => {
  const items = arr(v).map((x) => line(x)).filter((x) => x !== "—");
  return items.length === 0 ? "—" : items.join("、");
};
/** 命令展示串：string 原样；{program,args} 展平（含空格的参数加引号）。展示串不是转抄源，
 * 下游转抄一律以 JSON 字段为准（映射表 §2 说明） */
function cmdStr(v) {
  if (isEmpty(v)) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.program === "string") {
    const argsPart = arr(v.args)
      .map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a)))
      .join(" ");
    return argsPart ? `${v.program} ${argsPart}` : v.program;
  }
  return line(v);
}
/** 命令 code span 原始文本：内部反引号替换为撇号防破坏 code 标记；不在此预转义——
 * 表格列交给 table 的 cell() 统一转义一次（预转义后再过出口会造成双转义），行内用 line() 压换行 */
const cmdRaw = (v) => cmdStr(v).replace(/`/g, "'");
const table = (headers, rows) => {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const r of rows) lines.push(`| ${r.map((c) => cell(c)).join(" | ")} |`);
  return lines.join("\n");
};

const out = [];
const push = (...lines) => out.push(...lines);
const blank = () => out.push("");
const section = (h) => {
  blank();
  push(h);
  blank();
};

// ── units[].cwd 与 headerNote 的 cwd 声明弱一致性校验 ──
// 弱校验边界：只核「headerNote 点名的绝对路径根」与 units[].cwd 的包含关系，不解读自然语言
// 其余语义（声明未点名路径的注记无从机器对照，跳过）。历史实跑形态：headerNote 写「全部单元
// cwd 统一 Stock 根」而 units 写 plugins 仓根——两侧矛盾没有任何门拦截；此检查把该形态
// 在渲染期暴露（渲染器是 T3 落盘必经步，比 D0 编译更早）
{
  const cwdNotes = (Array.isArray(plan.headerNote) ? plan.headerNote : []).filter(
    (note) => typeof note === "string" && /\bcwd\b|工作树|worktree|检出根/i.test(note),
  );
  const declaredCwdUnits = unitList.filter((u) => typeof u?.cwd === "string" && u.cwd.trim() !== "");
  const absPathTokens = (text) =>
    (text.match(/\/[^\s，。；、"'`）)】]+/g) ?? []).map((token) => token.replace(/[，。；、）)】]+$/g, ""));
  const conflicts = [];
  for (const note of cwdNotes) {
    const roots = absPathTokens(note);
    if (roots.length === 0) continue;
    if (declaredCwdUnits.length === 0) {
      conflicts.push(
        `headerNote 的 cwd 声明点名了路径根（${roots.join("、")}），但没有任何单元声明 units[].cwd——plain 单元固定在工作仓库根运行、cwd 不随声明生效；若存在跨仓/隔离单元，须逐单元声明 isolation=worktree 与 cwd`,
      );
      continue;
    }
    for (const u of declaredCwdUnits) {
      const cwd = u.cwd.trim();
      if (!roots.some((root) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`))) {
        conflicts.push(
          `headerNote 声称单元 cwd 落在 ${roots.join("、")}，但单元 ${u.id} 的 units[].cwd = ${cwd}——不在声明的路径根之内（检查 headerNote 与 units[].cwd 哪一侧是权威事实，改 JSON 后重渲染）`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    fail(planPathAbs, [
      `FAIL: 语义缺口——units[].cwd 与 headerNote 的 cwd 声明不一致（共 ${conflicts.length} 处）：`,
      ...conflicts.map((c) => `  - ${c}`),
    ]);
  }
}

// ── 头部 ──

push(`# ${line(plan.name)} 实施计划`);
blank();
push(
  `基线: ${line(plan.baseline)} | 来源设计: ${line(plan.designDoc)} | 日期: ${line(plan.date)} | 版本: ${line(plan.skillVersion)}`,
);
blank();
// 基线 / 版本含义说明是视图固定文案（映射表「头部」节）；计划特有说明走 headerNote[]
push(
  "> 基线 = 开始实施前的代码 HEAD，供一致性审查的 git diff <基线>..HEAD；版本 = 产出本计划的技能版本（与 .impl-plan.json 的 skillVersion 同源同值）。",
);
for (const note of arr(plan.headerNote)) {
  const t = line(note);
  if (t !== "—") push(`> ${t}`);
}

// ── 0 章节映射 ──

section("## 0 章节映射");
const canonicalKeys = [
  ["goal", "背景 / 目标"],
  ["mechanism", "终态 / 机制"],
  ["acceptance", "验收场景表"],
  ["breakdown", "下一层拆分"],
];
const extraKeys = Object.keys(sectionMap).filter((k) => !canonicalKeys.some(([c]) => c === k));
push(
  table(
    ["内容类", "设计文档实际节（渲染视图固定编号）"],
    [
      ...canonicalKeys.map(([k, label]) => [label, sectionMap[k]]),
      ...extraKeys.map((k) => [k, sectionMap[k]]),
    ],
  ),
);

// ── 1 目标快照 ──

section("## 1 目标快照");
const snap = (plan.goalSnapshot ?? {});
push(`**问题一句话**：${line(snap.problem)}`);
blank();
const goals = arr(snap.goals).map((g) => line(g)).filter((g) => g !== "—");
push("**设计目标（逐字摘录，禁止改写）**：");
blank();
if (goals.length === 0) push("—");
else for (const g of goals) push(`- ${g}`);
blank();
push(`**范围外（逐字摘录）**：${line(snap.outOfScope)}`);

// ── 2 单元列表 ──

section("## 2 单元列表");
push(
  table(
    ["Unit", "职责", "范围声明（精确文件路径）", "依赖", "隔离", "验收条款", "决策分级", "增量归属"],
    unitList.map((u) => {
      const depReasons = (u.depReasons ?? {});
      const deps = arr(u.deps)
        .map((d) => {
          const reason = depReasons[d];
          const idText = line(d);
          return isEmpty(reason) ? idText : `${idText}（${line(reason)}）`;
        })
        .join("、");
      return [
        // 契约 spike 单元（kind=contract-spike）在 Unit 列加后缀标注——DAG 根与业务
        // 单元依赖关系由 deps 承载，标注只是让人读视图一眼看出哪个是契约 spike
        // （additive：无 kind 或非该值的单元渲染逐字节不变；转义交给 table 的 cell
        // 统一做一次，不在此预转义）
        u.kind === "contract-spike" ? `${u.id}（契约 spike）` : u.id,
        u.responsibility,
        joinList(u.territory),
        isEmpty(deps) ? "—" : deps,
        u.isolation,
        joinList(u.acceptance),
        u.decisionTier,
        isEmpty(u.incrementId) ? "—（不归属增量）" : u.incrementId,
      ];
    }),
  ),
);
for (const note of arr(plan.unitsNotes)) {
  const t = line(note);
  if (t === "—") continue;
  blank();
  push(t);
}

// ── 3 DAG 图（mermaid 本体从 units+deps 确定性推导；dagNote 只承载人读附注） ──

section("## 3 DAG 图");
const labels = (plan.dagNote?.nodeLabels ?? {});
/** mermaid 节点标识只留安全字符（字母数字下划线连字符）；标注压掉会截断标签语法的字符 */
const safeId = (id) => String(id).replace(/[^\w-]/g, "-");
const safeLabel = (t) => String(t).replace(/[[\]{}|"`\r\n]/g, " ").replace(/\s+/g, " ").trim();
push("```mermaid", "graph TD");
for (const u of unitList) {
  const id = safeId(u.id);
  const override = labels[u.id];
  const defaultLabel = isEmpty(override)
    ? isEmpty(u.incrementId)
      ? String(u.id)
      : `${u.id}<br/>${u.incrementId}`
    : safeLabel(override);
  push(`  ${id}[${safeLabel(defaultLabel)}]`);
}
for (const u of unitList) {
  for (const d of arr(u.deps)) push(`  ${safeId(d)} --> ${safeId(u.id)}`);
}
push("```");
const dagNote = plan.dagNote ?? {};
if (!isEmpty(dagNote.criticalPath)) {
  blank();
  push(`**关键路径**：${line(dagNote.criticalPath)}`);
}
if (arr(dagNote.parallelWindows).length > 0) {
  blank();
  push("**并行窗口**：");
  for (const w of dagNote.parallelWindows) {
    const t = line(w);
    if (t !== "—") push(`- ${t}`);
  }
}
if (arr(dagNote.edgeReasons).length > 0) {
  blank();
  push("**边因标注**：");
  blank();
  push(
    table(
      ["边", "理由"],
      dagNote.edgeReasons.map((e) => [e?.edge, e?.reason]),
    ),
  );
}

// ── 4 测试与验收计划 ──

section("## 4 测试与验收计划");
const tp = plan.testPlan;
const incCmds = arr(tp.incrementalCommands);
section("### 4.1 增量测试命令");
if (incCmds.length > 0) {
  push(
    table(
      ["增量", "归属单元", "testCommand（逐字）", "超时"],
      incCmds.map((c) => [
        c?.incrementId,
        joinList(c?.unitIds),
        `\`${cmdRaw(c?.command)}\``,
        isEmpty(c?.timeoutMs) ? "—" : `${c.timeoutMs} ms`,
      ]),
    ),
  );
} else if (!isEmpty(tp.incremental)) {
  push(line(tp.incremental));
} else {
  push("—");
}
section("### 4.2 全量套件");
push(`- 全量命令：\`${line(cmdRaw(tp.fullSuite))}\``);
const checks = arr(tp.fullSuiteChecks);
if (checks.length > 0) {
  // fullSuiteChecks 是 §4.2 渲染权威（产物类/验证类逐条标注，恢复 md 逐条检查清单形态）；
  // artifacts 是 Gate A / exec-plan 消费的产物类子集（结构化承载），在场时不重复渲染，
  // 避免同一事实两个视图来源——两字段关系见映射表 §1.2
  for (const c of checks) {
    const kind = line(c?.kind);
    const note = isEmpty(c?.note) ? "" : `（${line(c?.note)}）`;
    push(`- [${kind}] ${line(c?.id)}：\`${line(cmdRaw(c?.command))}\`${note}`);
  }
} else {
  for (const a of arr(tp.artifacts)) {
    push(`- 产物类条目 ${line(a?.id)}：\`${line(cmdRaw(a?.command))}\``);
  }
}
for (const n of arr(tp.fullSuiteNote)) {
  const t = line(n);
  if (t !== "—") push(`- ${t}`);
}
section("### 4.3 验收计划表");
if (!isEmpty(plan.acceptancePlanIntro)) {
  push(line(plan.acceptancePlanIntro));
  blank();
}
push(
  table(
    ["#", "验收项（场景表行）", "方式", "组", "依赖", "优化判定", "验证资产"],
    acceptanceList.map((a) => [
      a.id,
      a.item,
      a.level,
      a.group,
      joinList(a.deps),
      a.optimization,
      isEmpty(a.verifyAsset) ? "-" : a.verifyAsset,
    ]),
  ),
);
if (!isEmpty(plan.adversarialClaim)) {
  blank();
  push(line(plan.adversarialClaim));
}
section("### 4.4 e2e 影响面圈定");
const e2e = arr(plan.e2eImpactScreening).map((x) => line(x)).filter((x) => x !== "—");
if (e2e.length === 0) push("—");
else for (const x of e2e) push(`- ${x}`);
section("### 4.5 提速结论");
const speedup = arr(plan.speedupNote).map((x) => line(x)).filter((x) => x !== "—");
if (speedup.length === 0) push("—");
else for (const x of speedup) push(`- ${x}`);

// ── 5 合理偏差登记表 ──

section("## 5 合理偏差登记表");
const deviations = arr(plan.reasonableDeviations);
if (deviations.length === 0) {
  push("（暂无登记）");
} else {
  push(
    table(
      ["偏差", "内容与理由", "影响面", "处置"],
      deviations.map((d) => [`${line(d?.id)}. ${line(d?.title)}`, d?.content, d?.impact, d?.disposition]),
    ),
  );
}

// ── 6 残留风险与变更历史 ──

section("## 6 残留风险与变更历史");
const risks = arr(plan.residualRisks);
if (risks.length === 0) {
  push("（暂无登记）");
} else {
  push(
    table(
      ["残留风险", "触发条件", "影响", "处置", "重审触发条件"],
      risks.map((r) => [
        `${line(r?.id)}. ${line(r?.title)}`,
        r?.trigger,
        r?.impact,
        r?.disposition,
        r?.reexamine,
      ]),
    ),
  );
}
blank();
push("变更历史：");
const history = arr(plan.changeHistory);
if (history.length === 0) {
  push("（暂无登记）");
} else {
  for (const h of history) push(`- ${line(h?.id)}（${line(h?.note)}）：${line(h?.summary)}`);
}

// ── 写盘 / --check 比对 ──

const body = `${out.join("\n")}\n`;
const inputHash = createHash("sha256").update(raw, "utf8").digest("hex");
const metaLine = `${META_PREFIX}由 tech-design-v6 render-impl-plan.mjs v${RENDERER_VERSION} 从 .impl-plan.json 生成（输入 sha256: ${inputHash}）。权威源 = 同目录 .impl-plan.json，本文件禁手改；重新生成：node ${SCRIPT_PATH} ${planPathAbs} -->`;
const fileContent = `${metaLine}\n${body}`;

if (!check) {
  writeFileSync(mdPath, fileContent);
  process.stdout.write(`已生成 ${mdPath}（输入 sha256: ${inputHash}）\n`);
  process.exit(0);
}

// --check：剔除盘上文件头部元数据注释后逐字节比较（元数据含输入哈希与生成器版本，
// JSON 重排版会改哈希但不改内容——元数据不参与内容等价，防止良性重排版误报）
let onDisk;
try {
  onDisk = readFileSync(mdPath, "utf8");
} catch {
  fail(planPathAbs, [
    `FAIL: 渲染视图缺失——${mdPath} 不存在（--check 需要盘上视图作比对对象）。`,
  ]);
}
const diskBody = onDisk.startsWith(META_PREFIX) ? onDisk.slice(onDisk.indexOf("\n") + 1) : onDisk;
if (diskBody === body) {
  process.stdout.write(`CHECK PASS：${mdPath} 与 ${planPathAbs} 重新渲染结果一致\n`);
  process.exit(0);
}
const genLines = body.split("\n");
const diskLines = diskBody.split("\n");
let diffLine = 0;
while (
  diffLine < genLines.length &&
  diffLine < diskLines.length &&
  genLines[diffLine] === diskLines[diffLine]
) {
  diffLine += 1;
}
fail(planPathAbs, [
  `FAIL: 渲染不一致——${mdPath} 与 ${planPathAbs} 重新渲染结果不一致（首处差异：第 ${diffLine + 1} 行）。`,
  "原因二选一：渲染视图被手改；或 .impl-plan.json 修改后未重渲染。语义改动必须回 .impl-plan.json 修改，禁止手改渲染视图迁就现状。",
]);
