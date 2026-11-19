#!/usr/bin/env node
// check-gate-prompt-parity.mjs —「有 gate 无前置提示」结构性护栏（三对账）
//
// 目标：把「机器拒绝点存在、消费方材料缺判据/缺供给通道」的高危形态变成提交期红灯。
// 起源事故（2026-11-18 双轨 v6 实跑）：candidate-build-v6 把一条发现标为 boundary，
// delivery-gate 护栏拒绝（关联需求已有断言级判据覆盖的行为不得申报为边界），登记中断
// 致整 run 终态 build-failed；探索器 prompt 与角色文件均未写该判据。
//
// 三对账：
//   对账 1（旗标通道）：从 delivery-gate.mjs 的 INTENT_SPECS 提取意图命令旗标全集，并
//     从 guardrailStrict 分支与硬拒分支提取「条件必查旗标」；与 7 个 v6 workflow
//     单源（workflows/src/*-v6.shared.ts）的 intentArgsFor 实传集对账。条件必查旗标
//     未供给 = 红灯；差集可登记 FLAG_SUPPLY_EXEMPTIONS（内联、带理由与到期日）。
//   对账 2（护栏判据前置）：delivery-v6/scripts/kernel/rules.json 的 guardrails 每条
//     须登记 documentation 块（keywords 判据核心词 + requiredIn 消费方文件清单）；
//     脚本逐文件检查任一关键词命中，零命中 = 红灯。
//   对账 3（引用有效性）：技能文档与 agents/*.md 中的 P0-N / P0-V-N 编号须在同代 rubric
//     有定义；P0-V 系列引用须存在对应 rubric；引用的 scripts/*.mjs 与 rubric-*.md 路径
//     须在仓库存在。不存在的引用 = 红灯。
//
// 边界（机器能判与不能判，如实声明）：
//   - 只做结构性与词面检查：旗标映射是否齐全、关键词是否出现、引用路径是否存在。
//   - 语义等价不判：文档换了措辞但表达了同一判据、或关键词在场但判据未真正写清——机器
//     不可判，靠审计流程兜底。关键词命中只证明核心词在场；判据修订时须同步维护关键词表。
//   - 对账 1 只覆盖意图命令组（INTENT_SPECS）的消费方；直接用非意图命令的 workflow
//     （如 acceptance-design-v6 的 record-review）不在该对账范围，输出中标注不适用。
//   - 引用解析的「目标 rubric」按引用文件所在技能收敛；跨技能或目标项目侧脚本引用
//     无法机器定向，登记在 REFERENCE_EXEMPTIONS（带理由）。
//
// 用法：node scripts/check-gate-prompt-parity.mjs [--root <仓库根>] [--verbose]
//   缺省仓库根 = 本脚本所在仓库根；--root 供 fixture 测试指向临时仓库。
// 退出码：0 = 全绿；1 = 有红灯（逐条给 file:line 与修复动作）；2 = 脚本自身错误
//   （gate 源码/rules.json 无法解析、提取形态变化——需要维护本脚本，不是被测内容的问题）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) fatal(`--root 缺参数值。${USAGE}`);
      root = resolve(value);
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
  return { root, verbose };
}

const { root: ROOT, verbose: VERBOSE } = parseArgs(process.argv.slice(2));

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
      // 该旗标属于哪个命令：INTENT_SPECS 中登记了它的命令（当前每旗标唯一归属）
      for (const [command, entry] of spec) {
        if ([...entry.required, ...entry.optional, ...entry.flags].includes(flag)) {
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
    // P0 编号引用：逐条检查定义存在性（不按编号去重——同一死引用出现多次时每处都要清理）
    for (const match of content.matchAll(ITEM_TOKEN_RE)) {
      const token = match[0];
      const normalized = normalizeItemToken(token);
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

// ── 执行与输出 ─────────────────────────────────────────────────────────────────

checkFlagChannels();
checkGuardrailDocumentation();
checkReferenceValidity();

const areaTitles = { 1: "对账 1 旗标通道", 2: "对账 2 护栏判据前置", 3: "对账 3 引用有效性" };
if (reds.length === 0) {
  console.log("[gate-prompt-parity] 全绿：三对账无红灯");
  process.exit(0);
}
const counts = { 1: 0, 2: 0, 3: 0 };
for (const item of reds) counts[item.area] += 1;
for (const area of ["1", "2", "3"]) {
  console.log(`[gate-prompt-parity][${areaTitles[area]}] 红灯 ${counts[area]} 条`);
  for (const item of reds.filter((entry) => entry.area === area)) console.log(`  - ${item.message}`);
}
console.log(`[gate-prompt-parity] 结果：红灯 ${reds.length} 条（对账 1: ${counts[1]} / 对账 2: ${counts[2]} / 对账 3: ${counts[3]}）——按上方逐条修复动作处理后重跑`);
process.exit(1);
