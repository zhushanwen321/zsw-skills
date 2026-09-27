#!/usr/bin/env node
// check-workflow-parity.mjs — zcode/pi 双平台 workflow 脚本对账守卫
//
// 用法：
//   node scripts/check-workflow-parity.mjs            对账四对脚本，违规 exit 1
//   node scripts/check-workflow-parity.mjs --update   打印当前真实差集（人工核对后回填 WHITELIST）
//
// 对账域 = 两侧「正文段」的字符串字面量静态文本（词法扫描提取；模板串 ${} 表达式
// 归一为占位——两侧表达式形态有合法差异（TS 标注 vs 纯 JS），对账目标是静态文本）。
// 结构性差异段整段跳过，不进字符串比对域（差异段各自有专属核对维度）：
//   - zcode frontmatter（/* zcode-workflow … */）
//   - pi @pi-meta 头（/* @pi-meta … */）
//   - pi shim prologue（@pi-meta 之后到 zcAgent adapter 定义结束——pi 专属运行环境适配）
//   - pi SCHEMA_* 常量段（结构化返回机制不同源：zcode 靠 TS 泛型标注编译期合成，
//     pi 靠显式 JSON Schema 常量——描述串机制性不成对，不构成漂移信号；但契约粒度
//     = 顶层字段名 + required 集，由维度 4 按字段名核对，豁免段不是盲区）
// 强信号单列（零容忍，无白名单）：
//   - phase 名集合必须两侧相等
//   - agent 名模板静态文本序列（按出现顺序）必须两侧相等
//   - SCHEMA_* ↔ interface 顶层字段名 + required 集必须相等（维度 4）

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
  "恢复动作：经 CreateWorkflow 重新发起并传 execPlan。注意 AmendWorkflow 不透传 args——",
  "恢复动作：重新 workflow run 发起并传 execPlan（--args execPlan=<路径>）；",
  "修订脚本时 args 恒空，请把 execPlan 路径直接写进脚本 const 后再发起。",
  "runs 一次性无续跑通道，修订脚本后重跑即可。",
  "退役判定 agent 返回无效（␘）。恢复动作：同步修复成果已在工作区/commit 中，AmendWorkflow 修订退役 prompt 后重跑",
  "退役判定 agent 返回无效（␘）。恢复动作：同步修复成果已在工作区/commit 中，修订脚本退役 prompt 后重跑",
  // —— 迁移期活条目（W3/W4 未切分，整句 G 措辞仍在产物中；四对全迁完后删除） ——
  "参数校验失败：␘。恢复动作：修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）",
  "参数校验失败：␘。恢复动作：修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）",
  // —— 拼接壳 G 常量（恢复指引拆为壳常量后两侧措辞各自成串；W1 已迁移） ——
  "修 prompt 后 AmendWorkflow，或 args.attempt 递增重新发起",
  "修订脚本 prompt 后重新 run，或 args.attempt 递增重新发起",
  "修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）",
  "修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）",

  // —— 拼接壳 W1 修复者重试钩子（F 区：zcode 同 actor 续聊只需说明，pi 新 agent 须自包含前情） ——
  "你上一轮返回的处置表未通过脚本校验（同会话续聊，此前的任务指令与你的返回仍可见）。",
  "【前情】你此前收到过修复任务指令并已返回结果，但处置表未通过脚本校验，本轮是重试。",
  "=====",
  "此前任务指令：",
  "上次返回的 dispositions（JSON）：",

  // —— E/C TS 形态（属性键/枚举字符串仅一侧以字符串形式出现） ——
  "artifacts",
  "deferredLedger",
  "fail",
  "status",
  "terminated",

  // —— B shim（pi 专属运行环境） ——
  "node:child_process",
  "utf8",
  // —— 拼接壳 W3（HINT 常量两侧措辞；W3 已迁移。原 SCHEMA_BY_KEY 键串条目已清：
  //    .ask("TypeKey" 归一进 piBody 后不再进字符串比对域，typeKey 契约改由维度 4
  //    按字段名核对——2026-09-27） ——
  "恢复动作：经 CreateWorkflow 重新发起并传 execPlan。注意 AmendWorkflow 不透传 args——修订脚本时 args 恒空，请把 execPlan 路径直接写进脚本 const 后再发起。",
  "恢复动作：重新 workflow run 发起并传 execPlan（--args execPlan=<路径>）；runs 一次性无续跑通道，修订脚本后重跑即可。",
  "读 run 日志定位失败分区，AmendWorkflow 修订后重发",
  "读 run 日志定位失败分区，修订脚本后重发",
  // —— 拼接壳 W4 G 常量（planner/退役恢复指引两侧措辞；W4 已迁移） ——
  "AmendWorkflow 修订 prompt 后重跑",
  "AmendWorkflow 修订退役 prompt 后重跑",
  "修订脚本 prompt 后重跑",
  "修订脚本退役 prompt 后重跑",
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
// → 归一 .ask("TypeKey", 调用（与 zcode 侧 .ask<T>( 泛型同为非字符串表达——typeKey 串是
//   构建管线的机制产物，其契约由「结构化返回契约核对」维度按字段名核对，不进字符串比对域）
function piBody(src) {
  let s = sliceOut(src, "/* @pi-meta", "*/");
  // 拼接产物适配名为 wfAgent；迁移期旧手写产物为 zcAgent——兼容双形态
  const adapterStart = ["function wfAgent(", "function zcAgent("].map((m) => s.indexOf(m)).filter((x) => x >= 0);
  if (adapterStart.length === 0) throw new Error("找不到 wfAgent/zcAgent 适配定义（shim prologue 锚失效）");
  const afterAdapter = s.indexOf("\n}", Math.min(...adapterStart));
  if (afterAdapter < 0) throw new Error("找不到 adapter 结束锚");
  s = s.slice(0, Math.min(...adapterStart)) + s.slice(afterAdapter + 2);
  s = s.replace(/^const SCHEMA_\w+ = [\s\S]*?^\};$/gm, "");
  s = s.replace(/\.ask\("[A-Za-z_$][\w$]*",\s*/g, ".ask(");
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

// ── 结构化返回契约核对（粒度 = 顶层字段名 + required 集）──
// SCHEMA 段从字符串比对域整段豁免的原因是描述串机制性不成对（两侧合法分叉，不比）；
// 但字段名层是真正的契约粒度——加字段忘同步 pi 壳的漂移由此维度拦截，豁免段不再盲区

/** zcode 产物 interface 提取：name → { keys, required }（required = 无 ? 的顶层键） */
function extractInterfaces(tsSrc) {
  const out = new Map();
  const re = /^interface ([A-Za-z_$][\w$]*) \{$/gm;
  let m;
  while ((m = re.exec(tsSrc))) {
    const start = m.index + m[0].length;
    const end = tsSrc.indexOf("\n}", start);
    if (end < 0) continue;
    const keys = new Set();
    const required = new Set();
    for (const line of tsSrc.slice(start, end).split("\n")) {
      const km = line.match(/^  ([A-Za-z_$][\w$]*)(\?)?\s*:/);
      if (km) {
        keys.add(km[1]);
        if (!km[2]) required.add(km[1]);
      }
    }
    out.set(m[1], { keys, required });
  }
  return out;
}

/** pi 产物 SCHEMA_* 提取：name → { keys, required }（顶层 properties 键 = 4 空格缩进） */
function extractSchemas(jsSrc) {
  const out = new Map();
  // 负向前瞻排除 SCHEMA_BY_KEY 注册表（它是键→常量的映射，不是 schema 本体）
  const re = /^const SCHEMA_(?!BY_KEY\b)([A-Za-z_$][\w$]*) = \{$/gm;
  let m;
  while ((m = re.exec(jsSrc))) {
    const start = m.index + m[0].length;
    const end = jsSrc.indexOf("\n};", start);
    if (end < 0) continue;
    const body = jsSrc.slice(start, end);
    const keys = new Set();
    for (const line of body.split("\n")) {
      const km = line.match(/^    ([A-Za-z_$][\w$]*):/);
      if (km) keys.add(km[1]);
    }
    const req = body.match(/^  required: \[([^\]]*)\]/m);
    const required = new Set(
      req ? req[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [],
    );
    out.set(m[1], { keys, required });
  }
  return out;
}

/** pi 产物 .ask("TypeKey", 调用的 typeKey 集（构建管线由 .ask<T>( 转换而来） */
function extractAskKeys(jsSrc) {
  return new Set([...jsSrc.matchAll(/\.ask\("([A-Za-z_$][\w$]*)",/g)].map((m) => m[1]));
}

function schemaContractProblems(zcFull, piFull) {
  const problems = [];
  const ifaces = extractInterfaces(zcFull);
  const schemas = extractSchemas(piFull);
  for (const [name, schema] of schemas) {
    const iface = ifaces.get(name);
    if (!iface) {
      problems.push(`  SCHEMA_${name} 无对应 interface ${name}（pi 壳独有形态 = 契约漂移）`);
      continue;
    }
    const missKeys = [...schema.keys].filter((k) => !iface.keys.has(k));
    const extraKeys = [...iface.keys].filter((k) => !schema.keys.has(k));
    if (missKeys.length || extraKeys.length) {
      if (missKeys.length) problems.push(`  ${name}: 字段仅 pi SCHEMA 有：${JSON.stringify(missKeys)}`);
      if (extraKeys.length) problems.push(`  ${name}: 字段仅 zcode interface 有（加字段漏同步 pi 壳）：${JSON.stringify(extraKeys)}`);
    }
    const missReq = [...schema.required].filter((k) => !iface.required.has(k));
    const extraReq = [...iface.required].filter((k) => !schema.required.has(k));
    if (missReq.length || extraReq.length) {
      if (missReq.length) problems.push(`  ${name}: required 仅 pi 有：${JSON.stringify(missReq)}`);
      if (extraReq.length) problems.push(`  ${name}: required 仅 zcode 有（interface 必填但 SCHEMA 未列）：${JSON.stringify(extraReq)}`);
    }
  }
  // .ask 消费的 typeKey 必须有登记的 SCHEMA（pi 侧运行时按 SCHEMA_BY_KEY 查表，
  // 缺登记 = 运行时「未知 ask 类型键」——此处静态前置拦截）
  for (const key of extractAskKeys(piFull)) {
    if (!schemas.has(key)) problems.push(`  ask 类型键 ${key} 无 SCHEMA_${key} 常量（pi 运行时将报未知键）`);
  }
  return problems;
}

function extractAgentNames(src, isPi) {
  const call = isPi ? /(?<![\w.$])(?:wf|zc)Agent\(\s*(`[^`]*`|"[^"]*")/g : /(?<![\w.$])agent\(\s*(`[^`]*`|"[^"]*")/g;
  return [...src.matchAll(call)]
    .map((m) => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "\u2418"));
}

// ── 对账 ──

let failed = false;
const updateDump = [];

for (const name of PAIRS) {
  const zcFull = readFileSync(join(ROOT, DIR, `${name}.dwf.ts`), "utf8");
  const piFull = readFileSync(join(ROOT, DIR, "pi", `${name}.js`), "utf8");
  const zcBody = zcodeBody(zcFull);
  const piText = piBody(piFull);
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

  // 4. 结构化返回契约：SCHEMA_* ↔ interface 顶层字段名 + required 集（零容忍）
  const schemaProblems = schemaContractProblems(zcFull, piFull);
  if (schemaProblems.length) {
    failed = true;
    problems.push(...schemaProblems);
  }

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
