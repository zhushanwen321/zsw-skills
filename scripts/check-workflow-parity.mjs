#!/usr/bin/env node
// check-workflow-parity.mjs — zcode/pi 双平台 workflow 脚本对账守卫
//
// 用法：
//   node scripts/check-workflow-parity.mjs            对账四对脚本，违规 exit 1
//   node scripts/check-workflow-parity.mjs --update   打印当前真实差集（人工核对后回填 WHITELIST）
//
// 对账域 = 两侧「正文段」的字符串字面量静态文本（词法扫描提取；模板串 ${} 表达式
// 归一为占位——两侧表达式形态有合法差异（TS 标注 vs 纯 JS），对账目标是静态文本）。
// 结构性差异段整段跳过，不进对比域（两版唯一允许差异区）：
//   - zcode frontmatter（/* zcode-workflow … */）
//   - pi @pi-meta 头（/* @pi-meta … */）
//   - pi shim prologue（@pi-meta 之后到 zcAgent adapter 定义结束——pi 专属运行环境适配）
//   - pi SCHEMA_* 常量段（结构化返回机制不同源：zcode 靠 TS 泛型标注编译期合成，
//     pi 靠显式 JSON Schema 常量——字段描述串机制性不成对，不构成漂移信号）
// 强信号单列（零容忍，无白名单）：
//   - phase 名集合必须两侧相等
//   - agent 名模板静态文本序列（按出现顺序）必须两侧相等

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "skills/self/dev-workflow/workflows";
const PAIRS = [
  "tech-review-loop",
  "wave-executor",
  "dev-consistency-loop",
  "design-code-sync-loop",
];

// 已审差异白名单：差集中的串若逐条在此登记即放行。每条必须标注来源差异区
// （B shim / E agent 调用层 / F 续聊补丁 / G 机制词 pi 语境化）。新增条目前先确认
// 它属于登记差异区，而不是业务逻辑漂移——拿不准就人工 diff 两侧核对。
const WHITELIST = new Set([
  // —— F 续聊前情补丁（pi 版无续聊，prompt 注入前情） ——
  "==== 前情（pi 版补：zcode 版由同 agent 续聊承载的 R1 上下文）====",
  "【前情】此前任务指令：n␘nn上次返回结果：n␘nn",
  "你是终态同步的两级审查第一级（framework-scan planner），此前已做 R1 框架对照与模块分解。",
  "你是终态同步的模块审查者，此前已做 R1 模块全量审查。",
  "仓库 ␘；设计文档 ␘；审查基线 = 当前 HEAD（␘）。",
  "你的任务契约模板：␘。",
  "你负责的模块计划（planner 原文）：module=␘；files=␘；focus=␘。",

  // —— G 机制词 pi 语境化（恢复指引措辞两侧平台化） ——
  "R1 审查失败：␘——恢复动作：读 run 日志定位失败分区，AmendWorkflow 修订后重发",
  "R1 审查失败：␘——恢复动作：读 run 日志定位失败分区，修订脚本后重发",
  "planner 返回无效（␘）。恢复动作：检查模板 ␘ 与设计文档可达性、AmendWorkflow 修订 prompt 后重跑",
  "planner 返回无效（␘）。恢复动作：检查模板 ␘ 与设计文档可达性，修订脚本 prompt 后重跑",
  "参数校验失败：␘。恢复动作：修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）",
  "参数校验失败：␘。恢复动作：修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）",
  "恢复动作：经 CreateWorkflow 重新发起并传 execPlan。注意 AmendWorkflow 不透传 args——",
  "恢复动作：重新 workflow run 发起并传 execPlan（--args execPlan=<路径>）；",
  "修订脚本时 args 恒空，请把 execPlan 路径直接写进脚本 const 后再发起。",
  "runs 一次性无续跑通道，修订脚本后重跑即可。",
  "维度 ␘ 返回畸形计数（mustFix=␘ suggestion=␘，须为非负整数且与报告一致）。恢复动作：报告已落盘可读 ␘ 人工核对；修 prompt 后 AmendWorkflow，或 args.attempt 递增重新发起",
  "维度 ␘ 返回畸形计数（mustFix=␘ suggestion=␘，须为非负整数且与报告一致）。恢复动作：报告已落盘可读 ␘ 人工核对；修订脚本 prompt 后重新 run，或 args.attempt 递增重新发起",
  "退役判定 agent 返回无效（␘）。恢复动作：同步修复成果已在工作区/commit 中，AmendWorkflow 修订退役 prompt 后重跑",
  "退役判定 agent 返回无效（␘）。恢复动作：同步修复成果已在工作区/commit 中，修订脚本退役 prompt 后重跑",

  // —— E/C TS 形态（属性键/枚举字符串仅一侧以字符串形式出现） ——
  "artifacts",
  "deferredLedger",
  "fail",
  "status",
  "terminated",

  // —— B shim（pi 专属运行环境） ——
  "node:child_process",
  "utf8",
]);

// ── 分段 ──

function sliceOut(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return src;
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j < 0) throw new Error(`分段锚不完整：${startMarker} 后找不到 ${endMarker}`);
  return src.slice(0, i) + src.slice(j + endMarker.length);
}

function zcodeBody(src) {
  return sliceOut(src, "/* zcode-workflow", "*/");
}

// pi 正文 = 剥 @pi-meta 头 → 剥 shim prologue（到 zcAgent 定义结束的顶格 }）→ 剥 SCHEMA 常量段
function piBody(src) {
  let s = sliceOut(src, "/* @pi-meta", "*/");
  const adapterStart = s.indexOf("function zcAgent(");
  if (adapterStart < 0) throw new Error("找不到 zcAgent adapter 定义（shim prologue 锚失效）");
  const afterAdapter = s.indexOf("\n}", adapterStart);
  if (afterAdapter < 0) throw new Error("找不到 zcAgent adapter 结束锚");
  s = s.slice(0, adapterStart) + s.slice(afterAdapter + 2);
  s = s.replace(/^const SCHEMA_\w+ = [\s\S]*?^\};$/gm, "");
  return s;
}

// ── 词法扫描提取（单遍；注释/正则字面量剥离；模板串 ${} 表达式归一为 ␘ 占位）──

const REGEX_PRECEDING = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
const REGEX_KEYWORDS = new Set(["return", "case", "do", "else", "in", "of", "typeof", "void", "delete", "yield", "await"]);

function extractStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prevSig = "\n"; // 真正的「前一个有效字符」——分支判定用，分支处理完后才更新
  const prevWord = () => {
    let j = i;
    while (j > 0 && /[A-Za-z_$]/.test(src[j - 1])) j--;
    return src.slice(j, i);
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      prevSig = "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      prevSig = "\n";
    } else if (c === "/" && (REGEX_PRECEDING.has(prevSig) || (/[A-Za-z_$]/.test(prevSig) && REGEX_KEYWORDS.has(prevWord())))) {
      // 正则字面量：跳到非转义闭合 /（[class] 内的 / 不终止；行内终止防跨行错位）
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      prevSig = "/";
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") { buf += src.slice(j + 1, j + 2); j += 2; }
        else { buf += src[j]; j++; }
      }
      out.push(buf);
      i = j + 1;
      prevSig = c;
    } else if (c === "`") {
      let j = i + 1;
      let buf = "";
      let depth = 0;
      while (j < n && (src[j] !== "`" || depth > 0)) {
        if (src[j] === "\\") { buf += src.slice(j + 1, j + 2); j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; buf += "\u2418"; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (depth === 0) buf += src[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
      prevSig = "`";
    } else {
      if (!" \t\r".includes(c)) prevSig = c;
      i++;
    }
  }
  return out.filter((s) => s.trim().length >= 4);
}

function extractPhases(src) {
  return [...src.matchAll(/\bphase\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
}

function extractAgentNames(src, isPi) {
  const call = isPi ? /\bzcAgent\(\s*(`[^`]*`|"[^"]*")/g : /(?<![\w.])agent\(\s*(`[^`]*`|"[^"]*")/g;
  return [...src.matchAll(call)]
    .map((m) => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "\u2418"));
}

// ── 对账 ──

let failed = false;
const updateDump = [];

for (const name of PAIRS) {
  const zcBody = zcodeBody(readFileSync(join(ROOT, DIR, `${name}.dwf.ts`), "utf8"));
  const piText = piBody(readFileSync(join(ROOT, DIR, "pi", `${name}.js`), "utf8"));
  const problems = [];

  // 1. phase 名集合（零容忍）
  const zcPhases = extractPhases(zcBody);
  const piPhases = extractPhases(piText);
  const phaseOnlyZc = zcPhases.filter((p) => !piPhases.includes(p));
  const phaseOnlyPi = piPhases.filter((p) => !zcPhases.includes(p));
  if (phaseOnlyZc.length || phaseOnlyPi.length) {
    failed = true;
    if (phaseOnlyZc.length) problems.push(`  phase 仅 zcode 有：${JSON.stringify(phaseOnlyZc)}`);
    if (phaseOnlyPi.length) problems.push(`  phase 仅 pi 有：${JSON.stringify(phaseOnlyPi)}`);
  }

  // 2. agent 名模板静态文本序列（零容忍）
  const zcAgents = extractAgentNames(zcBody, false);
  const piAgents = extractAgentNames(piText, true);
  if (JSON.stringify(zcAgents) !== JSON.stringify(piAgents)) {
    failed = true;
    problems.push(`  agent 名序列不一致：\n    zcode: ${JSON.stringify(zcAgents)}\n    pi:    ${JSON.stringify(piAgents)}`);
  }

  // 3. 业务字符串差集 ⊆ 白名单
  const zcStrings = new Set(extractStrings(zcBody));
  const piStrings = new Set(extractStrings(piText));
  const onlyZc = [...zcStrings].filter((s) => !piStrings.has(s) && !WHITELIST.has(s));
  const onlyPi = [...piStrings].filter((s) => !zcStrings.has(s) && !WHITELIST.has(s));
  if (onlyZc.length || onlyPi.length) {
    failed = true;
    if (onlyZc.length) problems.push(`  串仅 zcode 有（${onlyZc.length}）：\n${onlyZc.map((s) => `    - ${JSON.stringify(s.slice(0, 140))}`).join("\n")}`);
    if (onlyPi.length) problems.push(`  串仅 pi 有（${onlyPi.length}）：\n${onlyPi.map((s) => `    - ${JSON.stringify(s.slice(0, 140))}`).join("\n")}`);
  }
  for (const s of [...onlyZc, ...onlyPi]) updateDump.push(s);

  if (problems.length) {
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(p);
  } else {
    console.log(`✓ ${name}`);
  }
}

if (process.argv.includes("--update")) {
  console.log(`\n=== 当前真实差集（${[...new Set(updateDump)].length} 条，人工核对后回填 WHITELIST）===`);
  for (const s of [...new Set(updateDump)].sort()) console.log(JSON.stringify(s));
}

process.exit(failed ? 1 : 0);
