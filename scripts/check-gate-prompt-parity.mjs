#!/usr/bin/env node
// check-gate-prompt-parity.mjs —「有 gate 无前置提示」结构性护栏（五对账）
//
// 目标：把「机器拒绝点存在、消费方材料缺判据/缺供给通道/缺字段表达面」的高危形态
// 变成提交期红灯。起源事故（2026-11-18 双轨 v6 实跑）：candidate-build-v6 把一条发现
// 标为 boundary，delivery-gate 护栏拒绝（关联需求已有断言级判据覆盖的行为不得申报为
// 边界），登记中断致整 run 终态 build-failed；探索器 prompt 与角色文件均未写该判据。
//
// 五对账：
//   对账 1（旗标通道 + 字段三面）：从 delivery-gate.mjs 的 INTENT_SPECS 提取意图命令
//     旗标全集，并从 guardrailStrict 分支与硬拒分支提取「条件必查旗标」；与 7 个 v6
//     workflow 单源（workflows/src/*-v6.shared.ts）的 intentArgsFor 实传集对账。条件必查
//     旗标未供给 = 红灯；差集可登记 FLAG_SUPPLY_EXEMPTIONS（内联、带理由与到期日）。
//     三面扩展（R1-11）：intentArgsFor 实传的结构字段（kebab→camel）须在三个表达面同时
//     存在——FindingDraft/EvidenceConclusion interface（zcode 通道）、prompt 返回结构
//     声明（agent 表达面）、pi 壳 SCHEMA 条目（pi 平台表达面）；任一面缺失 = 红灯
//     （R1-03/R1-04 形态：字段在某平台无法表达，agent 返回被结构化校验拒收）。
//     prompt 声明中的 "|null" 形态单独红灯（R1-26 形态：缺省通道按省略键语义，
//     声明允许 null 会经 String() 变 "null" 字符串被 gate 拒）；校验器选择归一 null
//     侧时可登记 PROMPT_NULL_EXEMPTIONS（带理由）。
//   对账 2（护栏判据前置）：delivery-v6/scripts/kernel/rules.json 的 guardrails 每条
//     须登记 documentation 块（keywords 判据核心词 + requiredIn 消费方文件清单）；
//     脚本逐文件检查任一关键词命中，零命中 = 红灯。
//   对账 3（引用有效性）：技能文档与 agents/*.md 中的 P0-N / P0-V-N 编号须在同代 rubric
//     有定义；P0-V 系列引用须存在对应 rubric；引用的 scripts/*.mjs 与 rubric-*.md 路径
//     须在仓库存在。不存在的引用 = 红灯。value-review agent（源与运行时副本）的
//     P0-V-N 引用额外锁定 rubric-value-review.md（R1-20：按引用 agent 锁定目标 rubric）。
//   对账 4（agent 源/副本一致性，R1-10/R1-19）：skills/self/dev-workflow/*/agents/*.md
//     与 `.zcode/agents/`（仓库内运行时副本）及全局 `~/.zcode/agents/` 同名文件逐行
//     对账；frontmatter 的 model/color 行差异放行（副本可能特化模型），其余不一致 =
//     红灯。全局副本目录可用 --global-agents-dir 覆盖（fixture 测试用）。
//   对账 5（策略键消费方存在性）：登记表驱动（POLICY_KEY_CONSUMERS）——每个策略键登记
//     「声明出处（文件+token）+ 预期消费方（文件+token 清单）」，脚本 grep 核对；消费方
//     零命中 = 红灯（死键形态：声明了没人读）。确认不接线的键登记
//     POLICY_KEY_REGISTRY_EXEMPTIONS（带理由）。evidenceKinds 词表另做策略文件与
//     gate 常量的值对拍（策略扩展通道的死路形态，C-01）。
//
// 边界（机器能判与不能判，如实声明）：
//   - 只做结构性与词面检查：旗标映射是否齐全、字段名是否在三个表达面出现、关键词是否
//     出现、引用路径是否存在。字段命中只证明表达通道存在；类型/必填性/语义等价不判
//     （prompt 声明 |null 的 null 合法性冲突属语义层，只按 R1-26 形态词面红灯），
//     靠审计流程兜底。判据修订时须同步维护关键词表与登记表。
//   - 对账 1 只覆盖意图命令组（INTENT_SPECS）的消费方；直接用非意图命令的 workflow
//     （如 acceptance-design-v6 的 record-review）不在该对账范围，输出中标注不适用。
//   - 对账 4 只对「源 agents 目录有同名文件」的副本核对；副本目录中无源对应的文件
//     （其他工具的 agent）不核。逐行一致性是严格口径：正文任何一行差异都红——
//     同步义务属发布流程，不做语义等价放行。
//   - 对账 5 的消费方命中是词面 grep：命中只证明消费 token 在场，不证明语义正确
//     消费（如把策略词表读进来但判定仍用硬编码词表——C-01 的双源形态由词表值
//     对拍补抓）。豁免表是「确认不接线」的显式登记，不是红灯垃圾桶。
//   - 引用解析的「目标 rubric」按引用文件所在技能收敛；跨技能或目标项目侧脚本引用
//     无法机器定向，登记在 REFERENCE_EXEMPTIONS（带理由）。
//
// 用法：node scripts/check-gate-prompt-parity.mjs [--root <仓库根>] [--verbose]
//   [--global-agents-dir <目录>]
//   缺省仓库根 = 本脚本所在仓库根；--root 供 fixture 测试指向临时仓库；
//   缺省全局副本目录 = ~/.zcode/agents（zcode 全局 agent 发现目录）。
// 退出码：0 = 全绿；1 = 有红灯（逐条给 file:line 与修复动作）；2 = 脚本自身错误
//   （gate 源码/rules.json 无法解析、提取形态变化——需要维护本脚本，不是被测内容的问题）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "用法：node scripts/check-gate-prompt-parity.mjs [--root <仓库根>] [--verbose]";

function fatal(message) {
  console.error(`[gate-prompt-parity][脚本错误] ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let root = SCRIPT_ROOT;
  let verbose = false;
  let globalAgentsDir = join(homedir(), ".zcode", "agents");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) fatal(`--root 缺参数值。${USAGE}`);
      root = resolve(value);
      i += 1;
    } else if (arg === "--global-agents-dir") {
      const value = argv[i + 1];
      if (!value) fatal(`--global-agents-dir 缺参数值。${USAGE}`);
      globalAgentsDir = resolve(value);
      i += 1;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fatal(`未知参数 ${arg}。${USAGE}`);
    }
  }
  return { root, verbose, globalAgentsDir };
}

const { root: ROOT, verbose: VERBOSE, globalAgentsDir: GLOBAL_AGENTS_DIR } = parseArgs(process.argv.slice(2));

const DEV_WORKFLOW = "skills/self/dev-workflow";
const V6_SKILLS = ["delivery-v6", "tech-design-v6", "dev-flow-v6"];
const WORKFLOW_SRC = `${DEV_WORKFLOW}/workflows/src`;
const GATE_SOURCE = `${DEV_WORKFLOW}/delivery-v6/scripts/delivery-gate.mjs`;
const KERNEL_RULES = `${DEV_WORKFLOW}/delivery-v6/scripts/kernel/rules.json`;
// 7 个 v6 workflow 单源：意图命令消费方需逐个核对；无 intentArgsFor 的记为不适用
const V6_WORKFLOWS = [
  "acceptance-design-v6.shared.ts",
  "candidate-build-v6.shared.ts",
  "independent-assurance-v6.shared.ts",
  "assurance-repair-loop-v6.shared.ts",
  "wave-executor-v6.shared.ts",
  "dev-consistency-loop-v6.shared.ts",
  "tech-review-loop-v6.shared.ts",
];

// ── 对账 1 补充登记：gate 里以硬拒（非 guardrailStrict 分支）执行的「条件必查」旗标。
// guardrailStrict 分支内的旗标由源码自动提取；硬拒分支没有统一标记形态，在此显式登记
// （旗标必须仍在 INTENT_SPECS 中存在，否则本脚本以退出码 2 报「登记已过期」）。
const HARD_FAIL_STRICT_FLAGS = [
  {
    command: "record-finding",
    flag: "consequence-refutation",
    reason: "schema 2 非 blocker 发现必须附行为后果否证（FindingRaised 硬拒，rules.json consequenceRefutationRequired）",
  },
  {
    command: "record-finding",
    flag: "consequence-refutation-type",
    reason: "同一硬拒分支要求声明三类之一（不会发生 / 用户不可观察 / 验收明确允许）",
  },
  {
    command: "record-finding",
    flag: "contract-capability-ids",
    reason: "外部契约发现的能力绑定通道：护栏④结构命中判定依赖该字段，缺通道则契约任务的发现无法正常关联",
  },
  {
    command: "record-evidence",
    flag: "contract-capability-ids",
    reason: "runtime 义务唯一满足形态要求证据绑定能力 id（delivery-gate evaluate 判定）",
  },
  {
    command: "record-evidence",
    flag: "runtime-probe",
    reason: "runtime 义务唯一满足形态要求 runtime probe 标记（缺则证据不计入 runtime 覆盖）",
  },
];

// ── 对账 1 旗标供给豁免：条件必查旗标未在某 workflow 供给时的放行登记。
// 新增条目前先确认「该 workflow 的业务路径确实不会触发该必须形态」——不是把所有红灯都
// 塞进来。到期日之后豁免失效（变红灯），强制复审。
const FLAG_SUPPLY_EXEMPTIONS = [
  // {
  //   workflow: "independent-assurance-v6.shared.ts",
  //   command: "record-finding",
  //   flag: "authority-hash",
  //   reason: "该 workflow 不登记契约发现（业务上不可能）",
  //   expiresOn: "2027-06-30",
  // },
];

// ── 对账 3 引用豁免：目标项目侧脚本引用（不是本仓脚本）无法用仓库路径存在性判定。
const REFERENCE_EXEMPTIONS = [
  {
    file: `${DEV_WORKFLOW}/tech-design-v6/flow/plan.md`,
    token: "scripts/select-affected-e2e.mjs",
    reason: "目标项目侧脚本引用：与目标项目 docs/testing/e2e-map.json 对账用，本仓不提供该文件",
  },
  {
    file: `${DEV_WORKFLOW}/dev-flow-v6/flow/post-delivery.md`,
    token: "scripts/check-doc-symbol-drift.mjs",
    reason: "行文举例目标项目（xyz-agent）的符号漂移守护脚本，不是本仓脚本",
  },
];

// ── 对账 1 三面化（R1-11）：命令层参数排除表 ──
// intentArgsFor case 实传旗标中，这些是命令信封参数（taskDir/凭据/摘要/工件指针等），
// 不是 FindingDraft/EvidenceConclusion 结构字段，不做三面核对。新增结构旗标时不要
// 加进这里——加了就等于绕过三面对账。
const FINDING_FLAG_ENVELOPE = new Set([
  "task-dir", "channel", "revision", "run-id", "credential", "summary", "artifact", "finding-id",
]);
const EVIDENCE_FLAG_ENVELOPE = new Set([
  "task-dir", "channel", "revision", "run-id", "credential", "summary",
]);

// ── 对账 1 三面化：机器注入字段豁免 ──
// 这些字段由 workflow 映射层/机器侧生成（不是 agent 返回结构的一部分），在三个表达面
// 天然缺席是设计使然。逐条登记 workflow + 事件通道 + 字段 + 理由；误登会放行真实的
// 表达面断裂，删除前先核对注入点。
const CHANNEL_FIELD_EXEMPTIONS = [
  {
    workflow: "independent-assurance-v6.shared.ts",
    channel: "FindingRaised",
    field: "severity",
    reason: "tier→severity 由映射层折算（tierToEvent），FindingDraft 只暴露 tier；category 在 FindingDraft 有显式申报通道不豁免",
  },
  {
    workflow: "assurance-repair-loop-v6.shared.ts",
    channel: "FindingRaised",
    field: "severity",
    reason: "同 IA：tier→severity 由映射层折算，FindingDraft 只暴露 tier",
  },
  {
    workflow: "independent-assurance-v6.shared.ts",
    channel: "EvidenceRecorded",
    field: "contractCapabilityIds",
    reason: "IA 的 runtime 绑定由 contractObservations 折算机器登记（agent 不申报），三面均无是设计使然",
  },
  {
    workflow: "independent-assurance-v6.shared.ts",
    channel: "EvidenceRecorded",
    field: "runtimeProbe",
    reason: "同上：runtimeProbe 仅对 IA 亲自执行且通过的 probe 证据由机器侧登记",
  },
  {
    workflow: "independent-assurance-v6.shared.ts",
    channel: "EvidenceRecorded",
    field: "artifactSha256",
    reason: "哈希由 workflow 按盘上文件计算后显式透传（EvidenceConclusion 不含哈希字段）",
  },
  {
    workflow: "assurance-repair-loop-v6.shared.ts",
    channel: "EvidenceRecorded",
    field: "artifactSha256",
    reason: "同 IA：哈希机器计算，agent 返回结构不含",
  },
];

// ── 对账 1 三面化：prompt "|null" 声明豁免 ──
// R1-26 形态：缺省通道按「省略键」语义（opt() 只判 undefined），prompt 声明允许 null
// 会被 String() 变 "null" 字符串传给 gate 被拒。修复方向 = 声明改「缺省时省略该键」；
// 若某 workflow 的校验器选择「把 null 归一 undefined」侧自洽，在此按文件+行内子串登记豁免
// （带理由与到期日），不要直接删检查。
const PROMPT_NULL_EXEMPTIONS = [
  // {
  //   workflow: "candidate-build-v6.shared.ts",
  //   lineContains: "\"emptyScopeRefutation\": string|null",
  //   reason: "validateBuilderOutcome 已把 null 归一 undefined 后再判（全链自洽）",
  //   expiresOn: "2027-06-30",
  // },
];

// ── 对账 5：策略键消费方登记表 ──
// 每键登记「声明出处（文件+token）+ 预期消费方（文件+token 清单）」。消费方零命中 =
// 红灯（死键：声明了没人读，C-01/C-12/C-17 形态）。确认不接线的登记性键进
// POLICY_KEY_REGISTRY_EXEMPTIONS（带理由），不要从声明文件删键了事——键本身是
// 领域词表的登记位。
const DELIVERY = `${DEV_WORKFLOW}/delivery-v6`;
const DELIVERY_CORE = `${DELIVERY}/scripts/delivery-core.mjs`;
const POLICY_KEY_CONSUMERS = [
  {
    key: "evidenceKinds（策略词表）",
    declaredIn: { file: `${DELIVERY}/policies/evidence-kinds.json`, token: '"evidenceKinds"' },
    consumers: [
      { file: GATE_SOURCE, token: "EVIDENCE_KINDS" },
    ],
    note: "gate 判定词表（EVIDENCE_KINDS）须与策略词表同值——值对拍另在 checkPolicyWordlistParity 做",
  },
  {
    key: "guardrails.boundaryBanOnAssertedRequirements",
    declaredIn: { file: KERNEL_RULES, token: '"boundaryBanOnAssertedRequirements"' },
    consumers: [{ file: GATE_SOURCE, token: "boundaryBanOnAssertedRequirements" }],
  },
  {
    key: "guardrails.regradeHaltEnabled",
    declaredIn: { file: KERNEL_RULES, token: '"regradeHaltEnabled"' },
    consumers: [{ file: GATE_SOURCE, token: "regradeHaltEnabled" }],
  },
  {
    key: "guardrails.emptyScopeBoundaryRequiresRefutation",
    declaredIn: { file: KERNEL_RULES, token: '"emptyScopeBoundaryRequiresRefutation"' },
    consumers: [{ file: GATE_SOURCE, token: "emptyScopeBoundaryRequiresRefutation" }],
  },
  {
    key: "predicates.*.decider（谓词裁决方词表）",
    declaredIn: { file: KERNEL_RULES, token: '"decider"' },
    consumers: [{ file: DELIVERY_CORE, token: "decider" }],
    note: "delivery-core ADJUDICATION_PREDICATES 与 predicates.decider 同概念，新增 decider 值须被分类判定读到（C-17）",
  },
];

// ── 对账 5：登记性键豁免（确认不接线，带理由）──
const POLICY_KEY_REGISTRY_EXEMPTIONS = [
  {
    key: "budgets.t2RewriteAttemptCap / budgets.d2ItemReflowCap",
    declaredIn: { file: KERNEL_RULES, token: '"t2RewriteAttemptCap"' },
    reason: "登记性参考键：当前判定实装在 tech-review-loop / dev-consistency-loop workflow 内嵌常量，delivery-core 不消费（C-12）；两份 flow 文档已按此改如实（调整上限需改 workflow 源后重建产物）",
  },
  {
    key: "categories[].exits（发现出口枚举）",
    declaredIn: { file: `${DELIVERY}/policies/finding-categories.json`, token: '"exits"' },
    reason: "登记性字段：出口枚举只登记语义词汇表，当前零判定消费（关闭出口判定在 verdict-rules 与硬编码转移）；C-03 已按此在文件内登记",
  },
  {
    key: "schemaVersion（external-contract-classes）",
    declaredIn: { file: `${DELIVERY}/policies/external-contract-classes.json`, token: '"schemaVersion"' },
    reason: "登记性字段：文件格式版本标记，无判定消费（C-05）",
  },
  {
    key: "known-answer-samples.expectedStageAccuracy",
    declaredIn: { file: `${DELIVERY}/policies/known-answer-samples.json`, token: '"expectedStageAccuracy"' },
    reason: "人工标注样例集：expectedStageAccuracy 指标从事件流现算，不读本文件（C-13 已按此把 _comment 改如实）",
  },
  {
    key: "guardrails.consequenceRefutationRequired",
    declaredIn: { file: KERNEL_RULES, token: '"consequenceRefutationRequired"' },
    reason: "登记位：语义由 record-finding 硬拒分支实现（schema 2 非 blocker 必附 consequence-refutation），不经此键开关（C-15）；接线后移入 POLICY_KEY_CONSUMERS",
  },
  {
    key: "domains（五域转移表）",
    declaredIn: { file: KERNEL_RULES, token: '"domains"' },
    reason: "静态对账参考：finding 域运行时判定在 findingLifecycleStateOf 等硬编码函数，表内三域（finding/exploration/acceptance-package）当前零运行时消费（C-16 已按此把注释改诚实）",
  },
];

// ── 对账 3（R1-20）：value-review agent 锁定目标 rubric ──
const VALUE_REVIEW_RUBRIC = "rubric-value-review.md";
// 文件名含此子串的被扫文件，其 P0-V-N 引用须在该 rubric 有定义（源 + 运行时副本同规则）
const VALUE_REVIEW_FILE_PATTERN = /value-review/;

const reds = [];
function red(area, message) {
  reds.push({ area, message });
}
function info(message) {
  if (VERBOSE) console.log(`[gate-prompt-parity][信息] ${message}`);
}
function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}
function readText(relPath, label) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) fatal(`缺少${label}：${relPath}（仓库根 ${ROOT}）`);
  return readFileSync(abs, "utf8");
}

// ── 代码切片工具：按括号配对截取对象/函数体（跳过字符串、注释、模板串与模板内插值）──

function skipQuoted(src, index) {
  const quote = src[index];
  let i = index + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error(`字符串未结束（缺收尾引号，起始位置 ${index}）`);
}

function skipLineComment(src, index) {
  const end = src.indexOf("\n", index + 2);
  return end < 0 ? src.length : end + 1;
}

function skipBlockComment(src, index) {
  const end = src.indexOf("*/", index + 2);
  if (end < 0) throw new Error(`块注释未结束（缺收尾 */，起始位置 ${index}）`);
  return end + 2;
}

function skipTemplate(src, index) {
  let i = index + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") {
      i = findMatchingBrace(src, i + 1) + 1;
      continue;
    }
    i += 1;
  }
  throw new Error(`模板字符串未结束（缺收尾反引号，起始位置 ${index}）`);
}

function findMatchingBrace(src, openIndex) {
  if (src[openIndex] !== "{") throw new Error(`findMatchingBrace 起点不是 {（位置 ${openIndex}）`);
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`花括号未配对（起始位置 ${openIndex}）`);
}

// ── 对账 1：旗标通道 ────────────────────────────────────────────────────────────

function extractStringArray(block, key) {
  const match = block.match(new RegExp(`${key}: \\[([^\\]]*)\\]`));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

/** 解析 delivery-gate.mjs 的 INTENT_SPECS：命令 → { type, required, optional, flags } */
function parseIntentSpecs(gateSource) {
  const marker = "const INTENT_SPECS = {";
  const markerIndex = gateSource.indexOf(marker);
  if (markerIndex < 0) fatal(`gate 源码缺 ${marker}——意图命令组形态变化，需维护本脚本的提取器`);
  const braceIndex = gateSource.indexOf("{", markerIndex);
  const endIndex = findMatchingBrace(gateSource, braceIndex);
  const objectText = gateSource.slice(braceIndex, endIndex + 1);
  const spec = new Map();
  const entryPattern = /\n {2}"([a-z][a-z0-9-]+)": \{/g;
  const starts = [];
  for (const match of objectText.matchAll(entryPattern)) starts.push({ name: match[1], index: match.index + 1 });
  if (starts.length < 5) fatal(`INTENT_SPECS 只提取到 ${starts.length} 个命令（预期 ≥5）——提取器与源码形态不再匹配`);
  for (let i = 0; i < starts.length; i += 1) {
    const begin = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : objectText.length;
    const block = objectText.slice(begin, end);
    const typeMatch = block.match(/type: "([A-Za-z]+)"/);
    if (!typeMatch) fatal(`INTENT_SPECS 的 ${starts[i].name} 缺 type 字段——提取器失效`);
    spec.set(starts[i].name, {
      required: extractStringArray(block, "required"),
      optional: extractStringArray(block, "optional"),
      flags: extractStringArray(block, "flags"),
    });
  }
  return spec;
}

/** 从 guardrailStrict 分支与硬拒登记表提取「条件必查旗标」→ 命令集合 */
function extractStrictFlags(gateSource, spec) {
  const knownFlags = new Set();
  for (const entry of spec.values()) {
    for (const flag of [...entry.required, ...entry.optional, ...entry.flags]) knownFlags.add(flag);
  }
  const byCommand = new Map();
  const add = (command, flag, source) => {
    if (!byCommand.has(command)) byCommand.set(command, new Map());
    byCommand.get(command).set(flag, source);
  };
  let blockCount = 0;
  const marker = "if (guardrailStrict) {";
  let searchFrom = 0;
  while (true) {
    const index = gateSource.indexOf(marker, searchFrom);
    if (index < 0) break;
    blockCount += 1;
    const openIndex = gateSource.indexOf("{", index);
    const endIndex = findMatchingBrace(gateSource, openIndex);
    const blockText = gateSource.slice(openIndex, endIndex + 1);
    for (const match of blockText.matchAll(/--([a-z][a-z0-9-]+)/g)) {
      const flag = match[1];
      if (!knownFlags.has(flag)) continue;
      // 该旗标属于哪个命令：INTENT_SPECS 中登记了它的命令（当前每旗标唯一归属）。
      // 条件必查只针对 optional/flags 型旗标——required 旗标每条命令必传，恢复文案
      // 提及（如「核对 --task-dir」）不构成「可能未供给」的必查形态
      for (const [command, entry] of spec) {
        if ([...entry.optional, ...entry.flags].includes(flag)) {
          add(command, flag, `guardrailStrict 分支恢复文案（gate:${lineOf(gateSource, index)}）`);
        }
      }
    }
    searchFrom = endIndex + 1;
  }
  if (blockCount === 0) fatal("gate 源码未找到 guardrailStrict 分支——形态变化，需维护本脚本的提取器");
  for (const entry of HARD_FAIL_STRICT_FLAGS) {
    const commandSpec = spec.get(entry.command);
    if (!commandSpec) fatal(`HARD_FAIL_STRICT_FLAGS 引用了不存在的命令 ${entry.command}——登记已过期`);
    if (![...commandSpec.required, ...commandSpec.optional, ...commandSpec.flags].includes(entry.flag)) {
      fatal(`HARD_FAIL_STRICT_FLAGS 引用的旗标 --${entry.flag} 已不在 ${entry.command} 的 INTENT_SPECS 中——登记已过期`);
    }
    add(entry.command, entry.flag, entry.reason);
  }
  if (byCommand.size === 0) fatal("未提取到任何条件必查旗标——提取器失效");
  return byCommand;
}

/** 解析单个 workflow 的 intentArgsFor：事件类型 → { command, flags, line } */
function parseWorkflowFlagMap(relPath) {
  const source = readText(relPath, " workflow 单源");
  const fnMarker = "function intentArgsFor(";
  const fnIndex = source.indexOf(fnMarker);
  if (fnIndex < 0) return null;
  const bodyOpen = source.indexOf("{", source.indexOf(")", fnIndex));
  const bodyEnd = findMatchingBrace(source, bodyOpen);
  const body = source.slice(bodyOpen, bodyEnd + 1);
  const caseStarts = [];
  for (const match of body.matchAll(/\n\s{2,6}case "([A-Za-z]+)":/g)) {
    // index + 1：跳过换行，让行号落在 case 行本身（否则报上一行）
    caseStarts.push({ eventType: match[1], index: match.index + 1 });
  }
  if (caseStarts.length === 0) fatal(`${relPath} 的 intentArgsFor 未提取到任何 case 分支——形态变化，需维护本脚本`);
  const map = new Map();
  for (let i = 0; i < caseStarts.length; i += 1) {
    const begin = caseStarts[i].index;
    const end = i + 1 < caseStarts.length ? caseStarts[i + 1].index : body.length;
    const block = body.slice(begin, end);
    const commandMatch = block.match(/return\s*\[\s*"([a-z][a-z0-9-]+)"/);
    if (!commandMatch) fatal(`${relPath} 的 case "${caseStarts[i].eventType}" 未提取到意图命令——形态变化`);
    const flags = new Set();
    for (const match of block.matchAll(/--([a-z][a-z0-9-]+)/g)) flags.add(match[1]);
    map.set(caseStarts[i].eventType, {
      command: commandMatch[1],
      flags,
      line: lineOf(source, bodyOpen + begin),
    });
  }
  return map;
}

function checkFlagChannels() {
  const gateSource = readText(GATE_SOURCE, " delivery-gate 源码");
  const spec = parseIntentSpecs(gateSource);
  const strictByCommand = extractStrictFlags(gateSource, spec);
  const applicable = [];
  const notApplicable = [];
  for (const name of V6_WORKFLOWS) {
    const relPath = `${WORKFLOW_SRC}/${name}`;
    if (!existsSync(join(ROOT, relPath))) fatal(`缺少 v6 workflow 单源：${relPath}（仓库结构变化，需维护本脚本的清单）`);
    const map = parseWorkflowFlagMap(relPath);
    if (map === null) {
      notApplicable.push(name);
      continue;
    }
    applicable.push(name);
    for (const [eventType, entry] of map) {
      const commandSpec = spec.get(entry.command);
      if (!commandSpec) {
        red("1", `${relPath}:${entry.line} → 事件 ${eventType} 路由到未知意图命令 ${entry.command}（gate INTENT_SPECS 无此命令）｜修复动作：改为 gate 已登记的命令名，或先在 gate 登记命令`);
        continue;
      }
      const allowedFlags = new Set([...commandSpec.required, ...commandSpec.optional, ...commandSpec.flags, "channel"]);
      for (const flag of entry.flags) {
        if (!allowedFlags.has(flag)) {
          red("1", `${relPath}:${entry.line} → 事件 ${eventType} 传了 gate 未登记的旗标 --${flag}｜修复动作：核对 gate ${entry.command} 的 INTENT_SPECS 后修正旗标名（拼写漂移会在运行时被 gate 拒）`);
        }
      }
      const strictFlags = strictByCommand.get(entry.command);
      if (!strictFlags) continue;
      for (const [flag, source] of strictFlags) {
        if (entry.flags.has(flag)) continue;
        const exemption = FLAG_SUPPLY_EXEMPTIONS.find((item) =>
          item.workflow === name && item.command === entry.command && item.flag === flag);
        if (exemption) {
          const today = new Date().toISOString().slice(0, 10);
          if (exemption.expiresOn < today) {
            red("1", `${relPath}:${entry.line} → 豁免已到期：事件 ${eventType} 的 --${flag} 仍未供给（豁免日 ${exemption.expiresOn}）｜修复动作：接通供给通道，或复审后更新 FLAG_SUPPLY_EXEMPTIONS 的到期日与理由`);
          } else {
            info(`${name} 事件 ${eventType} 的 --${flag} 由豁免放行（到期 ${exemption.expiresOn}：${exemption.reason}）`);
          }
          continue;
        }
        red("1", `${relPath}:${entry.line} → 事件 ${eventType}（gate 命令 ${entry.command}）未供给条件必查旗标 --${flag}｜依据：${source}｜修复动作：在 FindingDraft/EvidenceDraft 与 intentArgsFor 接通该字段，或登记 FLAG_SUPPLY_EXEMPTIONS（带理由与到期日）`);
      }
    }
  }
  info(`对账 1 覆盖 ${applicable.length} 个有意图命令映射的 workflow：${applicable.join("、")}`);
  if (notApplicable.length > 0) {
    info(`对账 1 不适用 ${notApplicable.length} 个（无 intentArgsFor，不消费意图命令组）：${notApplicable.join("、")}`);
  }
}

// ── 对账 1 三面化（R1-11）：实传结构字段须在 interface / prompt 声明 / pi 壳 SCHEMA 三面齐备 ──

function kebabToCamel(flag) {
  return flag.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

/** 提取 TS interface 的直接字段名集合（含可选 ?；不含嵌套 interface） */
function extractInterfaceFields(tsSource, interfaceName, relPath) {
  const marker = `interface ${interfaceName} {`;
  const index = tsSource.indexOf(marker);
  if (index < 0) return null;
  const openIndex = tsSource.indexOf("{", index);
  const endIndex = findMatchingBrace(tsSource, openIndex);
  const block = tsSource.slice(openIndex, endIndex + 1);
  const fields = new Set();
  for (const match of block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)(\?)?:/gm)) fields.add(match[1]);
  if (fields.size === 0) fatal(`${relPath} 的 ${marker} 未提取到任何字段——形态变化，需维护本脚本`);
  return fields;
}

/** 收集 prompt 返回结构声明行（含 `"findings": [{` / `"evidence": [{` 的行） */
function collectDeclarationLines(tsSource, containerKey) {
  const needle = `"${containerKey}": [{`;
  const lines = [];
  let offset = 0;
  while (true) {
    const index = tsSource.indexOf(needle, offset);
    if (index < 0) break;
    const lineStart = tsSource.lastIndexOf("\n", index) + 1;
    const lineEnd = tsSource.indexOf("\n", index);
    lines.push({ text: tsSource.slice(lineStart, lineEnd < 0 ? tsSource.length : lineEnd), line: lineOf(tsSource, index) });
    offset = index + needle.length;
  }
  return lines;
}

/** 提取 pi 壳内数组条目 SCHEMA 的 properties 键集（多份：独立常量 + 内联 items） */
function extractPropertiesOfObjectBlock(source, openIndex) {
  const endIndex = findMatchingBrace(source, openIndex);
  const block = source.slice(openIndex, endIndex + 1);
  const propsMarker = "properties: {";
  const propsIndex = block.indexOf(propsMarker);
  if (propsIndex < 0) return null;
  const propsOpen = openIndex + propsIndex + propsMarker.length - 1;
  const propsEnd = findMatchingBrace(source, propsOpen);
  const propsBlock = source.slice(propsOpen, propsEnd + 1);
  const keys = new Set();
  for (const match of propsBlock.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*): \{/gm)) keys.add(match[1]);
  return { keys, line: lineOf(source, openIndex) };
}

function collectPiItemSchemas(piSource, piRel, containerKey) {
  const schemas = [];
  // 形态 1：独立条目常量 const SCHEMA_FindingDraft = { ... }（findings 通道专用命名）
  const constantName = containerKey === "findings" ? "SCHEMA_FindingDraft" : null;
  const seenConstants = new Set();
  if (constantName) {
    seenConstants.add(constantName);
    const marker = `const ${constantName} = {`;
    const index = piSource.indexOf(marker);
    if (index >= 0) {
      const openIndex = piSource.indexOf("{", index);
      const props = extractPropertiesOfObjectBlock(piSource, openIndex);
      if (props) schemas.push({ keys: props.keys, line: props.line, via: constantName });
    }
  }
  // 形态 2：容器块 `<containerKey>: { ... items: {...} | items: SCHEMA_X ... }`
  const containerRe = new RegExp(`\\n\\s*${containerKey}: \\{`, "g");
  for (const match of piSource.matchAll(containerRe)) {
    const openIndex = piSource.indexOf("{", match.index);
    const endIndex = findMatchingBrace(piSource, openIndex);
    const block = piSource.slice(openIndex, endIndex + 1);
    const itemsIndex = block.indexOf("items:");
    if (itemsIndex < 0) continue;
    const afterItems = block.slice(itemsIndex, itemsIndex + 40);
    const inline = afterItems.match(/^items: \{/);
    const ref = afterItems.match(/^items: (SCHEMA_[A-Za-z]+)/);
    if (inline) {
      const itemsOpen = openIndex + itemsIndex + "items: ".length;
      const props = extractPropertiesOfObjectBlock(piSource, itemsOpen);
      if (props) schemas.push({ keys: props.keys, line: props.line, via: `${containerKey} 内联 items` });
    } else if (ref) {
      if (seenConstants.has(ref[1])) continue;
      seenConstants.add(ref[1]);
      const defIndex = piSource.indexOf(`const ${ref[1]} = {`);
      if (defIndex >= 0) {
        const props = extractPropertiesOfObjectBlock(piSource, piSource.indexOf("{", defIndex));
        if (props) schemas.push({ keys: props.keys, line: props.line, via: ref[1] });
      }
    }
  }
  return schemas;
}

function structuralFieldsFromFlags(flags, envelope, channel, workflow) {
  const fields = [];
  for (const flag of flags) {
    if (envelope.has(flag)) continue;
    const field = kebabToCamel(flag);
    const exempt = CHANNEL_FIELD_EXEMPTIONS.find((item) =>
      item.workflow === workflow && item.channel === channel && item.field === field);
    if (exempt) {
      info(`${workflow} 事件 ${channel} 的字段 ${field} 豁免三面核对（${exempt.reason}）`);
      continue;
    }
    fields.push({ flag, field });
  }
  return fields;
}

function checkChannelFieldParity() {
  const CHANNELS = [
    { eventType: "FindingRaised", command: "record-finding", container: "findings", interfaceName: "FindingDraft", envelope: FINDING_FLAG_ENVELOPE },
    { eventType: "EvidenceRecorded", command: "record-evidence", container: "evidence", interfaceName: "EvidenceConclusion", envelope: EVIDENCE_FLAG_ENVELOPE },
  ];
  for (const name of V6_WORKFLOWS) {
    const relPath = `${WORKFLOW_SRC}/${name}`;
    const piRel = relPath.replace(".shared.ts", ".pi.tpl.js");
    const map = parseWorkflowFlagMap(relPath);
    if (map === null) continue;
    const tsSource = readText(relPath, " workflow 单源");
    const piExists = existsSync(join(ROOT, piRel));
    const piSource = piExists ? readText(piRel, " pi 壳产物") : null;
    for (const channel of CHANNELS) {
      const entry = map.get(channel.eventType);
      if (!entry || entry.command !== channel.command) continue;
      const fields = structuralFieldsFromFlags([...entry.flags], channel.envelope, channel.eventType, name);
      if (fields.length === 0) continue;

      // 面 1：zcode interface（agent 返回结构 → 机器映射的字段通道）
      const interfaceFields = extractInterfaceFields(tsSource, channel.interfaceName, relPath);
      if (interfaceFields === null) {
        red("1", `${relPath} → 事件 ${channel.eventType} 实传结构字段但 interface ${channel.interfaceName} 缺定义（zcode 通道无返回结构）｜修复动作：补 interface 定义并把 prompt 声明/校验器接通，或核对事件通道是否应存在`);
      } else {
        const missing = fields.filter((item) => !interfaceFields.has(item.field));
        for (const item of missing) {
          red("1", `${relPath} → 事件 ${channel.eventType} 实传 --${item.flag} 的字段 ${item.field} 在 interface ${channel.interfaceName} 缺定义——该字段在 zcode 侧无供给来源（R1-03 同族）｜修复动作：在 ${channel.interfaceName} 补字段并接通校验器/映射层；确认属机器注入字段时登记 CHANNEL_FIELD_EXEMPTIONS（带理由）`);
        }
      }

      // 面 2：prompt 返回结构声明行（agent 表达面）
      const declarationLines = collectDeclarationLines(tsSource, channel.container);
      if (declarationLines.length === 0) {
        red("1", `${relPath} → 事件 ${channel.eventType} 有实传通道但 prompt 无 "${channel.container}": [{ 返回结构声明行——agent 不知道要返回该结构｜修复动作：在对应 prompt 的「返回结构（严格 JSON）」串补 ${channel.container} 条目声明`);
      } else {
        for (const item of fields) {
          const missingLines = declarationLines.filter((line) => !line.text.includes(`"${item.field}"`));
          if (missingLines.length > 0) {
            const at = missingLines.map((line) => line.line).join("/");
            red("1", `${relPath}:${at} → 事件 ${channel.eventType} 实传字段 ${item.field} 未进 prompt 返回结构声明（${missingLines.length} 处 "${channel.container}": [{ 声明行缺 "${item.field}"）——agent 被声明约束无法返回该字段｜修复动作：在各声明行补 "${item.field}" 类型声明；确认属机器注入字段时登记 CHANNEL_FIELD_EXEMPTIONS（带理由）`);
          }
        }
      }

      // 面 3：pi 壳 SCHEMA 条目（pi 平台表达面）
      if (!piExists) {
        red("1", `${piRel} → 文件不存在：事件 ${channel.eventType} 的字段在 pi 平台无表达面（单源 ${relPath} 有实传通道）｜修复动作：跑 node scripts/build-workflows.mjs 生成 pi 壳，或确认该 workflow 已退役 pi 平台并登记`);
        continue;
      }
      const itemSchemas = collectPiItemSchemas(piSource, piRel, channel.container);
      if (itemSchemas.length === 0) {
        red("1", `${piRel} → 未找到 ${channel.container} 条目 SCHEMA（既无内联 items 也无常量）——pi 平台结构化校验无法表达事件 ${channel.eventType} 的字段｜修复动作：在 pi 壳的 ${channel.container} 容器补 items schema（对齐 shared.ts 的 ${channel.interfaceName}）`);
        continue;
      }
      for (const item of fields) {
        const missing = itemSchemas.filter((schema) => !schema.keys.has(item.field));
        if (missing.length === 0) continue;
        const at = missing.map((schema) => `${schema.line}(${schema.via})`).join("/");
        red("1", `${piRel}:${at} → pi 壳 ${channel.container} 条目 SCHEMA 缺字段 ${item.field}（${missing.length} 份条目 schema 未声明）——pi 平台同一 prompt 两套语义，agent 合法返回会被结构化校验拒收（R1-03/R1-04 形态）｜修复动作：在 pi 壳 ${channel.container} 条目 properties 补 ${item.field}（与 shared.ts prompt 声明逐字段对齐）`);
      }
    }
    // R1-26 词面检查：两通道声明行并集按行去重（CoverageOutcome 类声明 evidence 与
    // findings 在同一行，逐通道扫会双报）
    const seenNullLines = new Set();
    for (const channel of CHANNELS) {
      for (const item of collectDeclarationLines(tsSource, channel.container)) {
        if (seenNullLines.has(item.line) || !item.text.includes("|null")) continue;
        seenNullLines.add(item.line);
        const exemption = PROMPT_NULL_EXEMPTIONS.find((entry) =>
          entry.workflow === name && item.text.includes(entry.lineContains));
        if (exemption) {
          const today = new Date().toISOString().slice(0, 10);
          if (exemption.expiresOn < today) {
            red("1", `${relPath}:${item.line} → 豁免已到期：声明行仍含 "|null"（豁免日 ${exemption.expiresOn}）｜修复动作：改声明为「缺省时省略该键」，或复审后更新 PROMPT_NULL_EXEMPTIONS`);
          } else {
            info(`${relPath}:${item.line} 的 "|null" 声明由豁免放行（${exemption.reason}）`);
          }
          continue;
        }
        red("1", `${relPath}:${item.line} → prompt 声明行含 "|null"（R1-26 形态：缺省通道按省略键语义，null 经 String() 会变 "null" 字符串被校验器/gate 拒）｜修复动作：声明改「缺省时省略该键，不要写 null」；若校验器已归一 null 侧自洽，登记 PROMPT_NULL_EXEMPTIONS（带理由与到期日）`);
      }
    }
  }
}

// ── 对账 2：护栏判据前置 ────────────────────────────────────────────────────────

function checkGuardrailDocumentation() {
  if (!existsSync(join(ROOT, KERNEL_RULES))) fatal(`缺少内核规则：${KERNEL_RULES}`);
  let rules;
  try {
    rules = JSON.parse(readFileSync(join(ROOT, KERNEL_RULES), "utf8"));
  } catch (error) {
    fatal(`rules.json 不是合法 JSON（${error.message}）——先修 JSON 语法再跑本检查`);
  }
  const guardrails = rules.guardrails;
  if (!guardrails || typeof guardrails !== "object") fatal("rules.json 缺 guardrails 对象——内核规则形态变化，需维护本脚本");
  const documentation = guardrails.documentation;
  if (!documentation || typeof documentation !== "object") {
    red("2", `${KERNEL_RULES} → guardrails 缺 documentation 块｜修复动作：按护栏逐条登记 keywords 与 requiredIn（本脚本对账 2 的输入源），见审计报告第九节`);
    return;
  }
  const guardrailKeys = Object.keys(guardrails).filter((key) => key !== "//" && key !== "documentation");
  for (const key of guardrailKeys) {
    if (!Object.hasOwn(documentation, key)) {
      red("2", `${KERNEL_RULES} → 护栏 ${key} 未登记 documentation 块｜修复动作：在 guardrails.documentation 下补 keywords（判据核心词）与 requiredIn（消费方文件清单）`);
    }
  }
  let entries = 0;
  for (const [key, doc] of Object.entries(documentation)) {
    if (key.startsWith("//")) continue;
    entries += 1;
    if (!doc || typeof doc !== "object") {
      red("2", `${KERNEL_RULES} → 护栏 ${key} 的 documentation 不是对象｜修复动作：改为 { keywords: [...], requiredIn: [...] } 形态`);
      continue;
    }
    const keywords = doc.keywords;
    const requiredIn = doc.requiredIn;
    if (!Array.isArray(keywords) || keywords.length === 0 || keywords.some((item) => typeof item !== "string" || item.trim() === "")) {
      red("2", `${KERNEL_RULES} → 护栏 ${key} 的 keywords 缺失或为空｜修复动作：登记判据核心词（任一命中即算在场；关键词随判据表述同步维护）`);
      continue;
    }
    if (!Array.isArray(requiredIn) || requiredIn.length === 0 || requiredIn.some((item) => typeof item !== "string" || item.trim() === "")) {
      red("2", `${KERNEL_RULES} → 护栏 ${key} 的 requiredIn 缺失或为空｜修复动作：登记必须写明该判据的消费方文件清单（仓库相对路径）`);
      continue;
    }
    for (const relPath of requiredIn) {
      const abs = join(ROOT, relPath);
      if (!existsSync(abs)) {
        red("2", `${relPath}（护栏 ${key} 登记）→ 文件不存在｜修复动作：核对 requiredIn 路径（仓库相对路径），或删除已退役文件后改登记现行文件`);
        continue;
      }
      const content = readFileSync(abs, "utf8");
      if (!keywords.some((keyword) => content.includes(keyword))) {
        red("2", `${relPath}（护栏 ${key}）→ 关键词零命中（候选：${keywords.join(" / ")}）｜修复动作：在该文件补写判据（任一关键词命中即可）；只证明核心词在场，语义等价由审计复核`);
      }
    }
  }
  info(`对账 2 覆盖 ${entries} 条护栏 documentation 登记（${guardrailKeys.length} 个 rules.json 开关键 + 硬编码护栏）`);
}

// ── 对账 3：引用有效性 ─────────────────────────────────────────────────────────

function walkMarkdown(absDir) {
  const files = [];
  if (!existsSync(absDir)) return files;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".archived") continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(abs));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(abs);
  }
  return files;
}

function collectScanFiles() {
  const files = [];
  for (const skill of V6_SKILLS) {
    files.push(...walkMarkdown(join(ROOT, DEV_WORKFLOW, skill)));
  }
  const zcodeAgents = join(ROOT, ".zcode", "agents");
  for (const file of walkMarkdown(zcodeAgents)) {
    const name = basename(file);
    if (name.endsWith("-v4.md") || name.endsWith("-v5.md")) continue;
    files.push(file);
  }
  files.push(...walkMarkdown(join(ROOT, "agents")).filter((file) => !file.includes(`${join("agents", "external")}`)));
  return files;
}

function collectScriptBasenames() {
  const index = new Set();
  const walkScripts = (absDir) => {
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".archived") continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) walkScripts(abs);
      else if (entry.name.endsWith(".mjs")) index.add(entry.name);
    }
  };
  walkScripts(join(ROOT, "scripts"));
  walkScripts(join(ROOT, "skills"));
  return index;
}

function collectRubricBasenames() {
  const index = new Set();
  const walkSkills = (absDir) => {
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".archived") continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) walkSkills(abs);
      else if (entry.name.endsWith(".md") && /^rubric-/.test(entry.name)) index.add(entry.name);
    }
  };
  walkSkills(join(ROOT, "skills"));
  return index;
}

const ITEM_TOKEN_RE = /P0-V-?\d+|P0-\d+/g;
const SERIES_TOKEN_RE = /P0-V(?![-\d])/g;

/** 收集 rubric 定义编号：表行首列 + 标题行。返回 Map(normalized → [{file, line}]) */
function collectRubricDefinitions(scanFiles) {
  const definitions = new Map();
  for (const absFile of scanFiles) {
    const name = basename(absFile);
    if (!/rubric/i.test(name)) continue;
    const content = readFileSync(absFile, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const tableMatch = line.match(/^\s*\|\s*(P0-V-?\d+|P0-\d+|P1-\d+)\s*\|/);
      const headingMatch = line.match(/^#{1,6}\s*(P0-V-?\d+|P0-\d+|P1-\d+)\b/);
      const token = tableMatch?.[1] ?? headingMatch?.[1];
      if (!token) continue;
      const normalized = normalizeItemToken(token);
      if (!definitions.has(normalized)) definitions.set(normalized, []);
      definitions.get(normalized).push({ file: relative(ROOT, absFile), line: i + 1 });
    }
  }
  return definitions;
}

function normalizeItemToken(token) {
  const match = token.match(/^P0-V-?(\d+)$/);
  if (match) return `P0-V-${Number(match[1])}`;
  return token;
}

function fileSkillDir(absFile) {
  const relFile = relative(ROOT, absFile);
  for (const skill of V6_SKILLS) {
    const prefix = `${DEV_WORKFLOW}/${skill}/`;
    if (relFile.startsWith(prefix)) return join(ROOT, DEV_WORKFLOW, skill);
  }
  return null;
}

function checkReferenceValidity() {
  const scanFiles = collectScanFiles();
  const definitions = collectRubricDefinitions(scanFiles);
  const scriptBasenames = collectScriptBasenames();
  const rubricBasenames = collectRubricBasenames();
  const seriesDefined = [...definitions.keys()].some((key) => key.startsWith("P0-V-"));
  const exemptionFiles = new Map();
  for (const item of REFERENCE_EXEMPTIONS) {
    const key = item.file;
    if (!exemptionFiles.has(key)) exemptionFiles.set(key, new Set());
    exemptionFiles.get(key).add(item.token);
  }
  const rubricHint = (absFile) => {
    const skillDir = fileSkillDir(absFile);
    if (skillDir) return `${relative(ROOT, skillDir)}/review/ 下的 rubric`;
    return "对应代际技能的 review/ rubric";
  };

  for (const absFile of scanFiles) {
    const relFile = relative(ROOT, absFile);
    const content = readFileSync(absFile, "utf8");
    const isValueReviewFile = VALUE_REVIEW_FILE_PATTERN.test(basename(absFile));
    // P0 编号引用：逐条检查定义存在性（不按编号去重——同一死引用出现多次时每处都要清理）
    for (const match of content.matchAll(ITEM_TOKEN_RE)) {
      const token = match[0];
      const normalized = normalizeItemToken(token);
      if (isValueReviewFile && normalized.startsWith("P0-V-")) {
        // R1-20：value-review agent（源与运行时副本）的 P0-V-N 引用锁定 rubric-value-review.md——
        // 只证明「任意 rubric 有定义」会让 agent 索取到错误判据文件也算绿
        const defFiles = definitions.get(normalized) ?? [];
        if (!defFiles.some((def) => basename(def.file) === VALUE_REVIEW_RUBRIC)) {
          red("3", `${relFile}:${lineOf(content, match.index)} → value-review agent 引用的 ${token} 未在 ${VALUE_REVIEW_RUBRIC} 定义（该 agent 的判据唯一来源；现有定义文件：${defFiles.map((def) => def.file).join("、") || "无"}）｜修复动作：把 ${token} 条目补进 ${VALUE_REVIEW_RUBRIC}，或修正引用编号`);
        }
        continue;
      }
      if (definitions.has(normalized)) continue;
      const line = lineOf(content, match.index);
      if (normalized.startsWith("P0-V-")) {
        red("3", `${relFile}:${line} → 引用的 ${token} 在任何 rubric 都无定义｜修复动作：补 ${rubricHint(absFile)} 的价值审条目（P0-V 系列），或把引用改为已存在的编号（T4 形态：agent 索取不存在的 rubric）`);
      } else {
        const defined = [...definitions.keys()].filter((key) => /^P0-\d+$/.test(key)).join(" / ") || "无";
        red("3", `${relFile}:${line} → 引用的 ${token} 在 rubric 无定义（现有编号：${defined}）｜修复动作：核对 ${rubricHint(absFile)} 的编号，删除死引用或补登对应审查项（T3 形态：P0-26 / P0-13 死引用）`);
      }
    }
    // P0-V 系列引用：要求存在 P0-V 条目定义
    if (!seriesDefined) {
      const seriesMatch = content.match(SERIES_TOKEN_RE);
      if (seriesMatch) {
        red("3", `${relFile}:${lineOf(content, seriesMatch.index)} → 引用了 P0-V 系列判据，但全仓 rubric 无任何 P0-V 条目定义｜修复动作：补 ${rubricHint(absFile)} 的 P0-V 系列 rubric 文件（含 P0-V-1 起的条目），或改引已存在的 rubric`);
      }
    }
    // 脚本路径引用
    for (const match of content.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)) {
      const token = `scripts/${match[1]}`;
      const exempt = exemptionFiles.get(relFile)?.has(token);
      if (exempt) continue;
      if (scriptBasenames.has(match[1])) continue;
      red("3", `${relFile}:${lineOf(content, match.index)} → 引用的 ${token} 在仓库不存在｜修复动作：确认目标项目侧脚本并登记 REFERENCE_EXEMPTIONS（带理由），或修正为本仓已存在的脚本路径`);
    }
    // rubric 文件引用
    for (const match of content.matchAll(/rubric-[A-Za-z0-9_-]+\.md/g)) {
      if (rubricBasenames.has(match[0])) continue;
      red("3", `${relFile}:${lineOf(content, match.index)} → 引用的 rubric 文件 ${match[0]} 在仓库不存在｜修复动作：改为已存在的 rubric 文件名，或补齐缺失文件`);
    }
  }
  info(`对账 3 扫描 ${scanFiles.length} 个文档（三技能 v6 + .zcode/agents 现行代）；rubric 定义 ${definitions.size} 个编号`);
}

// ── 对账 4：agent 源/副本一致性（R1-10/R1-19/R1-02）────────────────────────────

// ── 对账 4 豁免：确认不装运行时副本的 agent（带理由）──
// 源 agent 文件默认要求两个副本目录都有同名文件且正文一致；确认有意不装副本的在此登记
// （按文件名），不要删源文件或删检查。
const AGENT_COPY_EXEMPTIONS = [
  {
    file: "changeset-fixer.md",
    reason: "design-code-sync 引擎按模板路径直读（TILDE_FIXER_TEMPLATE），内嵌 persona；frontmatter 自述按路径直读消费，无按名派发通道",
  },
  {
    file: "conformance-reviewer.md",
    reason: "同 changeset-fixer：design-code-sync 引擎 semantic checker 按模板路径直读（TILDE_REVIEWER_TEMPLATE），不作为 zcode 独立 agent 派发",
  },
  {
    file: "sync-planner.md",
    reason: "design-code-sync-loop 引擎按模板路径直读（TILDE_PLANNER_TEMPLATE），内嵌 persona，无按名派发通道",
  },
  {
    file: "sync-reviewer.md",
    reason: "同 sync-planner：design-code-sync-loop 引擎按模板路径直读（TILDE_REVIEWER_TEMPLATE），不作为 zcode 独立 agent 派发",
  },
];

/** 剥掉 frontmatter 的 model/color 行（副本可能特化模型/颜色，其余须逐行一致） */
function agentLinesWithoutModelColor(content) {
  const lines = content.split("\n");
  const out = [];
  let inFrontmatter = lines.length > 0 && lines[0].trim() === "---";
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (inFrontmatter) {
      if (i > 0 && text.trim() === "---") {
        inFrontmatter = false;
      } else if (/^(model|color):/.test(text.trim())) {
        continue;
      }
    }
    out.push({ text, line: i + 1 });
  }
  return out;
}

function firstAgentLineDiff(srcLines, copyLines) {
  const maxLen = Math.max(srcLines.length, copyLines.length);
  for (let k = 0; k < maxLen; k += 1) {
    const srcLine = srcLines[k];
    const copyLine = copyLines[k];
    if (srcLine && copyLine && srcLine.text === copyLine.text) continue;
    return {
      line: srcLine ? srcLine.line : copyLine.line,
      srcText: srcLine ? srcLine.text : "＜源已结束＞",
      copyText: copyLine ? copyLine.text : "＜副本已结束＞",
    };
  }
  return null;
}

function checkAgentCopyParity() {
  const copyDirs = [
    { dir: join(ROOT, ".zcode", "agents"), label: `${join(".zcode", "agents")}（仓库内运行时副本）` },
    { dir: GLOBAL_AGENTS_DIR, label: `${GLOBAL_AGENTS_DIR}（全局运行时副本）` },
  ];
  const sourceFiles = walkMarkdown(join(ROOT, DEV_WORKFLOW))
    .filter((absFile) => {
      const rel = relative(ROOT, absFile).replace(/\\/g, "/");
      if (!/(^|\/)agents\//.test(rel)) return false;
      // 冻结代（v4/v5）不装运行时副本——对齐对账 3 的现行代扫描口径
      return !/-v[45]\//.test(rel);
    });
  if (sourceFiles.length === 0) fatal(`未找到源 agents 目录（${DEV_WORKFLOW}/*/agents/*.md）——仓库结构变化，需维护本脚本`);
  let checked = 0;
  for (const absSource of sourceFiles) {
    const relSource = relative(ROOT, absSource);
    const fileName = basename(absSource);
    const copyExempt = AGENT_COPY_EXEMPTIONS.find((item) => item.file === fileName);
    const sourceContent = readFileSync(absSource, "utf8");
    const srcLines = agentLinesWithoutModelColor(sourceContent);
    for (const copyDir of copyDirs) {
      const absCopy = join(copyDir.dir, fileName);
      if (!existsSync(absCopy)) {
        if (copyExempt) {
          info(`${relSource} 的副本缺失由豁免放行（${copyDir.label}：${copyExempt.reason}）`);
          continue;
        }
        red("4", `${relSource} → 运行时副本缺失：${copyDir.label} 无同名文件——zcode 实际加载不到该 agent（R1-02 形态）｜修复动作：复制源文件到 ${copyDir.dir}（保留副本 frontmatter 的 model 特化行、只同步正文）；确认有意不装副本时登记 AGENT_COPY_EXEMPTIONS（带理由）`);
        continue;
      }
      checked += 1;
      const copyContent = readFileSync(absCopy, "utf8");
      const diff = firstAgentLineDiff(srcLines, agentLinesWithoutModelColor(copyContent));
      if (diff) {
        red("4", `${relSource}:${diff.line} → 与运行时副本不一致（${copyDir.label}）｜源行：${diff.srcText.trim().slice(0, 120)}｜副本行：${diff.copyText.trim().slice(0, 120)}｜修复动作：把技能源 ${relSource} 的正文同步到副本（保留副本 frontmatter 的 model/color 行）`);
      }
    }
  }
  info(`对账 4 覆盖 ${sourceFiles.length} 个源 agent 文件 × ${copyDirs.length} 个副本目录（核对 ${checked} 份现存副本；frontmatter 的 model/color 行差异放行）`);
}

// ── 对账 5：策略键消费方存在性（C-01/C-03/C-05/C-12/C-13/C-15/C-16/C-17 形态）──

function checkPolicyWordlistParity() {
  const policyRel = `${DELIVERY}/policies/evidence-kinds.json`;
  const policyAbs = join(ROOT, policyRel);
  if (!existsSync(policyAbs)) fatal(`缺少策略词表：${policyRel}`);
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyAbs, "utf8"));
  } catch (error) {
    fatal(`${policyRel} 不是合法 JSON（${error.message}）——先修 JSON 语法再跑本检查`);
  }
  if (!Array.isArray(policy.evidenceKinds)) fatal(`${policyRel} 缺 evidenceKinds 数组——策略形态变化，需维护本脚本`);
  const gateSource = readText(GATE_SOURCE, " delivery-gate 源码");
  const gateMatch = gateSource.match(/const EVIDENCE_KINDS = \[([^\]]*)\]/);
  if (!gateMatch) fatal("gate 源码缺 const EVIDENCE_KINDS 常量——判定词表形态变化，需维护本脚本的提取器");
  const gateKinds = [...gateMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const onlyInPolicy = policy.evidenceKinds.filter((kind) => !gateKinds.includes(kind));
  const onlyInGate = gateKinds.filter((kind) => !policy.evidenceKinds.includes(kind));
  if (onlyInPolicy.length > 0 || onlyInGate.length > 0) {
    red("5", `evidenceKinds 策略词表与 gate 判定常量不同值（C-01 扩展死路形态）｜策略多：${JSON.stringify(onlyInPolicy)}；gate 常量多：${JSON.stringify(onlyInGate)}｜修复动作：gate 改读策略词表（单一数据源，策略升级通道才成立），或回退策略文件变更——策略新增 kind 而 gate 常量未跟时，validate-acceptance/record-evidence 仍按常量拒收`);
  } else {
    info(`对账 5 词表对拍：evidenceKinds 策略与 gate 常量同值（${gateKinds.join("、")}）`);
  }
}

function checkPolicyKeyConsumers() {
  for (const item of POLICY_KEY_REGISTRY_EXEMPTIONS) {
    const abs = join(ROOT, item.declaredIn.file);
    if (!existsSync(abs)) {
      red("5", `${item.declaredIn.file}（豁免键 ${item.key} 的声明文件）→ 文件不存在｜修复动作：核对声明路径；文件退役时同步删除豁免登记`);
      continue;
    }
    const content = readFileSync(abs, "utf8");
    if (!content.includes(item.declaredIn.token)) {
      red("5", `${item.declaredIn.file} → 豁免键 ${item.key} 的声明 token ${item.declaredIn.token} 零命中——豁免登记已过期（键已从策略文件移除）｜修复动作：删除该豁免登记（POLICY_KEY_REGISTRY_EXEMPTIONS）`);
    }
  }
  for (const item of POLICY_KEY_CONSUMERS) {
    const abs = join(ROOT, item.declaredIn.file);
    if (!existsSync(abs)) {
      red("5", `${item.declaredIn.file}（登记键 ${item.key} 的声明文件）→ 文件不存在｜修复动作：核对声明路径，或该键已退役时同步删除登记`);
      continue;
    }
    const content = readFileSync(abs, "utf8");
    if (!content.includes(item.declaredIn.token)) {
      red("5", `${item.declaredIn.file} → 登记键 ${item.key} 的声明 token ${item.declaredIn.token} 零命中——登记已过期（策略文件形态变化）｜修复动作：核对键名后更新 POLICY_KEY_CONSUMERS`);
      continue;
    }
    for (const consumer of item.consumers) {
      const consumerAbs = join(ROOT, consumer.file);
      if (!existsSync(consumerAbs)) {
        red("5", `${consumer.file}（登记键 ${item.key} 的消费方）→ 文件不存在｜修复动作：核对消费方登记，或该消费方退役时更新 POLICY_KEY_CONSUMERS`);
        continue;
      }
      const consumerContent = readFileSync(consumerAbs, "utf8");
      if (!consumerContent.includes(consumer.token)) {
        red("5", `${consumer.file} → 策略键 ${item.key} 的消费 token ${consumer.token} 零命中——键在 ${item.declaredIn.file} 声明但预期消费方不读它（死键形态 C-01/C-12/C-17：改键零生效）${item.note ? `｜登记备注：${item.note}` : ""}｜修复动作：把消费方接通该键（读取并参与判定或对拍），或确认属登记性字段后移入 POLICY_KEY_REGISTRY_EXEMPTIONS（带理由）`);
      }
    }
  }
  checkPolicyWordlistParity();
}

// ── 执行与输出 ─────────────────────────────────────────────────────────────────

checkFlagChannels();
checkChannelFieldParity();
checkGuardrailDocumentation();
checkReferenceValidity();
checkAgentCopyParity();
checkPolicyKeyConsumers();

const areaTitles = {
  1: "对账 1 旗标通道+字段三面",
  2: "对账 2 护栏判据前置",
  3: "对账 3 引用有效性",
  4: "对账 4 agent 源/副本一致性",
  5: "对账 5 策略键消费方存在性",
};
if (reds.length === 0) {
  console.log("[gate-prompt-parity] 全绿：五对账无红灯");
  process.exit(0);
}
const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
for (const item of reds) counts[item.area] += 1;
for (const area of ["1", "2", "3", "4", "5"]) {
  console.log(`[gate-prompt-parity][${areaTitles[area]}] 红灯 ${counts[area]} 条`);
  for (const item of reds.filter((entry) => entry.area === area)) console.log(`  - ${item.message}`);
}
console.log(`[gate-prompt-parity] 结果：红灯 ${reds.length} 条（对账 1: ${counts[1]} / 对账 2: ${counts[2]} / 对账 3: ${counts[3]}）——按上方逐条修复动作处理后重跑`);
process.exit(1);
