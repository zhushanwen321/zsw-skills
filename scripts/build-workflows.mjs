#!/usr/bin/env node
// build-workflows.mjs — dev-workflow 双平台 workflow 脚本构建器（单源拼接路线）
//
// 源（workflows/src/）：
//   <name>.shared.ts     单源公共体（TS 写法；agent 调用保持 zcode 原生形态
//                        agent(name, persona).ask<T>(prompt)——zcode GUI 泳道的
//                        编译期静态分析依赖字面 agent( 调用点，禁止包函数遮蔽）
//   <name>.zcode.tpl.ts  zcode 壳（frontmatter + 类型段 + G 区平台常量 + @@STITCH@@）
//   <name>.pi.tpl.js     pi 壳（@pi-meta + shim + SCHEMA + wfAgent 适配 + G 区平台常量 + @@STITCH@@）
// 产物（入 git；zcode saved 同步与 pi 发现机制直接消费）：
//   workflows/<name>.dwf.ts
//   workflows/pi/<name>.js
//
// pi 管线（zcode 产物 = 壳 + shared 原文，零转换）：
//   ① 词法安全改写：代码区的 agent( → wfAgent(（字符串/模板/注释/正则内不动）。
//      pi worker 以同作用域 function 声明拼入平台 agent，壳内同名声明会静默覆盖它，
//      壳内调用将递归——改写后壳的 wfAgent 体内才能安全调用平台原生 agent
//   ② .ask<T>( → .ask("T", ：泛型参数转 typeKey 字符串，pi 壳据此查 SCHEMA_BY_KEY
//   ③ typescript.transpileModule 剥 TS（标注/as/非空!/类型谓词）
//
// 用法：node scripts/build-workflows.mjs [--check] [--only name[,name...]]
//   默认构建全部产物并同步 zcode saved 副本（~/.zcode/workflows/）；--check 校验产物
//   与重生成结果一致 + saved 副本未滞后（pre-commit 防改源忘构建 / 忘同步 saved）；
//   --only 只构建指定 workflow（验证场景避免重写其他产物——禁碰文件的保护通道），
//   默认（无 --only）恒为全部，不悄悄漏检任何 workflow
//
// saved 同步背景：zcode CreateWorkflow 的 saved 发现目录是 ~/.zcode/workflows/，与仓内
// 产物是两份文件——saved 滞后于仓内产物时实际执行的是旧版（曾因此 attempt 后缀逻辑
// 已修但 run 仍写旧版行为），故 build 一并同步、--check 一并拦截

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
const SRC = join(WF, "src");
const SAVED_DIR = join(homedir(), ".zcode", "workflows");
const NAMES = ["tech-review-loop", "wave-executor", "dev-consistency-loop", "design-code-sync-loop"];
// O 区观测层单一构建输入：已接入观测的 workflow（shared 正文含 initObservation 调用点）
// 构建时把该文件全文拼在业务正文之前（obsCtx 为 let，业务顶层赋值依赖声明在前）；
// 未接入的 workflow 不拼。观测层只此一份，业务 shared 禁止拷贝副本
const OBS_LAYER_PATH = join(SRC, "observability.shared.ts");

// ── 观测契约（O 区）：三源同步锚——workflows/src/observability.shared.ts（单一观测层）、
// 本文件的 OBS_EVENT_FIELDS / OBS_STAGES / OBS_STEPS、scripts/workflow-observe.mjs 的行
// 契约。改事件字段或阶段词表必须三处同步（构建器在每次构建时按下述规则核对）──
const OBS_EVENT_FIELDS = ["execution_id", "task_id", "skill", "stage", "step", "round", "attempt", "event", "timestamp", "sample_type"];
// stage 词表 = workflow 在所属流程的阶段编号（T2 = tech-design 审查；D1/D3 = dev-flow
// 开发/验收执行；D2 = dev-flow 一致性审查；D5 = dev-flow 终态同步）
const OBS_STAGES = new Set(["T2", "D1", "D3", "D2", "D5"]);
// stage 实参允许字面量三元（wave-executor 按 exec-plan mode 分叉 D1/D3）——三元比较
// 里的非 stage 字面量在此显式登记豁免（同 check-workflow-parity 的白名单模式：新值
// 先确认不属于 stage 再登记）
const OBS_STAGE_LITERALS_IGNORE = new Set(["dev", "acceptance"]);
// step 词表 = 阶段内的串行步骤名（execution = 执行级边界事件；其余为业务步骤）
const OBS_STEPS = new Set(["execution", "setup", "review", "aggregate", "fix", "execute", "finalize", "gate-a", "retire"]);
// canonical skill 词表 = 事件 skill 字段的合法值（所属技能名，不是 workflow 脚本名——
// 统计入口按技能过滤，曾因写成 workflow 名被过滤掉，2026-11-01 实测）
const OBS_SKILLS = new Set(["tech-design-wf", "dev-flow-wf"]);

/** 观测契约核对：shared 已接入观测（initObservation 在场）时校验——stage/step 词表、
 *  九字段在场（对照单一观测层 observability.shared.ts）、终态统一补记出口在场、两侧产物
 *  的步骤调用点集合与 shared 一致（pi 改写/TS 剥离不应丢失观测调用点）。
 *  未接入的 workflow 显式说明跳过（不静默漏检） */
function checkObservationContract(name, shared, obsLayer, zcOut, piOut, errors) {
  const stageHits = [...shared.matchAll(/initObservation\("([A-Za-z0-9-]+)"/g)];
  if (stageHits.length === 0) {
    console.log(`  观测契约：${name} 未接入观测（无 initObservation 调用点）——跳过观测维度（产物一致性检查照常）`);
    return;
  }
  // stage 实参允许字面量或字面量三元（wave-executor 按 exec-plan mode 分叉 D1/D3）——
  // 引号/括号感知地取 initObservation 的第二实参原文，抓其中全部字符串字面量过词表
  const stageSet = new Set();
  for (const m of stageHits) {
    const openParen = shared.indexOf("(", m.index);
    let i = openParen + 1;
    let depth = 0;
    let argIdx = 0;
    let cur = "";
    while (i < shared.length) {
      const c = shared[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < shared.length && shared[j] !== c) {
          if (shared[j] === "\\") j++;
          j++;
        }
        if (argIdx === 1) cur += shared.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (c === ")" && depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) {
        argIdx++;
      } else if (argIdx === 1) {
        cur += c;
      }
      i++;
    }
    for (const lit of cur.matchAll(/"([A-Za-z0-9]+)"/g)) {
      if (!OBS_STAGE_LITERALS_IGNORE.has(lit[1])) stageSet.add(lit[1]);
    }
  }
  for (const m of stageHits) {
    if (!OBS_SKILLS.has(m[1])) errors.push(`${name}: 观测 skill「${m[1]}」不在 canonical 词表（合法：${[...OBS_SKILLS].join("/")}）——skill 字段须为所属技能名，不是 workflow 脚本名`);
  }
  const stepExtractor = (text) =>
    [...text.matchAll(/\b(?:obsBegin|withStage)\("([A-Za-z0-9-]+)"/g)].map((m) => m[1]).sort();
  const sharedSteps = stepExtractor(shared);
  for (const st of stageSet) {
    if (!OBS_STAGES.has(st)) errors.push(`${name}: 观测 stage「${st}」不在词表（合法：${[...OBS_STAGES].join("/")}）——新阶段编号先登记 OBS_STAGES`);
  }
  for (const s of sharedSteps) {
    if (!OBS_STEPS.has(s)) errors.push(`${name}: 观测 step「${s}」不在词表（合法：${[...OBS_STEPS].join("/")}）——新步骤名先登记 OBS_STEPS`);
  }
  if (!sharedSteps.includes("execution") && !/obsEmit\("execution"/.test(shared)) {
    errors.push(`${name}: 观测已接入但无 execution 级边界事件（obsEmit("execution", ...)）——每次执行的 JSONL 须有执行级 start/end`);
  }
  if (!/obsCloseExecution\(/.test(shared)) {
    errors.push(`${name}: 观测已接入但无终态统一补记出口（obsCloseExecution 调用点）——异常/终态离开时打开中的 step 与 execution 缺 end 配对`);
  }
  for (const f of OBS_EVENT_FIELDS) {
    if (!obsLayer.includes(f)) errors.push(`${name}: 观测事件契约缺字段 ${f}（三源同步：observability.shared.ts / build-workflows OBS_EVENT_FIELDS / workflow-observe.mjs）`);
  }
  const zcSteps = stepExtractor(zcOut);
  const piSteps = stepExtractor(piOut);
  const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!sameSet(sharedSteps, zcSteps)) errors.push(`${name}: zcode 产物的观测步骤调用点（${zcSteps.join(",") || "无"}）与 shared（${sharedSteps.join(",") || "无"}）不一致`);
  if (!sameSet(sharedSteps, piSteps)) errors.push(`${name}: pi 产物的观测步骤调用点（${piSteps.join(",") || "无"}）与 shared（${sharedSteps.join(",") || "无"}）不一致——pi 改写/TS 剥离管线不应影响观测调用点`);
  if (errors.length === 0) {
    console.log(`  观测契约：${name} skill=${[...stageHits].map((m) => m[1]).join("/")} stage=${[...stageSet].join("/")} steps=${sharedSteps.join("/")}（两侧调用点一致，字段齐全）`);
  }
}

// typescript 从安装环境解析（zsw-skills devDependencies）
const ts = createRequire(import.meta.url)("typescript");

const STITCH = /^\s*@@STITCH@@\s*$/;

// ── 拼接：标记行替换为 shared 全文（保持标记行缩进） ──
function stitch(template, shared) {
  const out = [];
  let replaced = 0;
  for (const line of template.split("\n")) {
    if (STITCH.test(line)) {
      replaced++;
      const indent = line.match(/^\s*/)[0];
      out.push(shared.split("\n").map((l) => (l === "" ? "" : indent + l)).join("\n"));
    } else {
      out.push(line);
    }
  }
  if (replaced !== 1) throw new Error(`模板应有恰好 1 个 @@STITCH@@ 标记行，实际 ${replaced}`);
  return out.join("\n");
}

// ── 词法扫描（与 check-workflow-parity.mjs 的提取器同一套状态机设计；两处需同步维护）──
// 输出段列表：{ code, text }——code=true 的段是可改写区，其余原样透传
function lexSegments(src) {
  const segments = [];
  let i = 0;
  const n = src.length;
  let prevSig = "\n";
  const REGEX_PRECEDING = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
  const REGEX_KEYWORDS = new Set(["return", "case", "do", "else", "in", "of", "typeof", "void", "delete", "yield", "await"]);
  const codeStart = () => {
    const last = segments[segments.length - 1];
    if (last && last.code) return last;
    const seg = { code: true, text: "" };
    segments.push(seg);
    return seg;
  };
  const rawStart = () => {
    const last = segments[segments.length - 1];
    if (last && !last.code) return last;
    const seg = { code: false, text: "" };
    segments.push(seg);
    return seg;
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      rawStart().text += src.slice(i, j < 0 ? n : j);
      i = j < 0 ? n : j;
      prevSig = "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      rawStart().text += src.slice(i, end);
      i = end;
      prevSig = "\n";
    } else if (c === "/" && (REGEX_PRECEDING.has(prevSig) || (/[A-Za-z_$]/.test(prevSig) && REGEX_KEYWORDS.has(prevWord())))) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      rawStart().text += src.slice(start, j);
      i = j;
      prevSig = "/";
    } else if (c === '"' || c === "'") {
      const start = i;
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j += 2; else j++; }
      rawStart().text += src.slice(start, Math.min(j + 1, n));
      i = j + 1;
      prevSig = c;
    } else if (c === "`") {
      const start = i;
      let j = i + 1;
      let depth = 0;
      while (j < n && (src[j] !== "`" || depth > 0)) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (depth === 0) { j++; continue; }
        j++;
      }
      rawStart().text += src.slice(start, Math.min(j + 1, n));
      i = j + 1;
      prevSig = "`";
    } else {
      codeStart().text += c;
      if (!" \t\r".includes(c)) prevSig = c;
      i++;
    }
  }
  function prevWord() {
    let j = i;
    while (j > 0 && /[A-Za-z_$]/.test(src[j - 1])) j--;
    return src.slice(j, i);
  }
  return segments;
}

// ── pi 管线 ①：代码区 agent( → wfAgent(（词法安全，字符串/注释/正则内不动） ──
function rewriteAgentCalls(src) {
  const segments = lexSegments(src);
  let count = 0;
  for (const seg of segments) {
    if (!seg.code) continue;
    seg.text = seg.text.replace(/(?<![\w.$])agent\(/g, () => { count++; return "wfAgent("; });
  }
  return { text: segments.map((s) => s.text).join(""), count };
}

// ── pi 管线 ②③：ask 泛型转 typeKey + transpile 剥 TS ──
function stripTs(sharedTs) {
  const pre = sharedTs.replace(/\.\s*ask<([A-Za-z_$][\w$]*)>\(/g, '.ask("$1", ');
  const { outputText } = ts.transpileModule(pre, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return outputText;
}

const check = process.argv.includes("--check");

// --only：只构建指定 workflow（验证场景避免重写其他产物）；默认恒为全部，不悄悄漏检
const onlyIdx = process.argv.indexOf("--only");
let names = NAMES;
if (onlyIdx >= 0) {
  const raw = process.argv[onlyIdx + 1];
  if (raw === undefined || raw.trim() === "") {
    console.error("--only 须带逗号分隔的 workflow 名（合法：" + NAMES.join(" / ") + "）");
    process.exit(2);
  }
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((n) => !NAMES.includes(n));
  if (unknown.length > 0) {
    console.error(`--only 含未知 workflow 名：${unknown.join(" / ")}（合法：${NAMES.join(" / ")}）`);
    process.exit(2);
  }
  names = NAMES.filter((n) => wanted.includes(n));
  console.log(`--only 生效：本次只处理 ${names.join(" / ")}（其余 ${NAMES.filter((n) => !names.includes(n)).join(" / ") || "无"} 本次不构建、不校验）`);
}

let dirty = 0;

for (const name of names) {
  const sharedPath = join(SRC, `${name}.shared.ts`);
  try {
    readFileSync(sharedPath, "utf8");
  } catch {
    if (check) {
      console.error(`✗ ${name}: 缺 ${sharedPath.slice(ROOT.length + 1)}——四对应全部完成切分后不得再缺`);
      dirty++;
    } else {
      console.log(`跳过 ${name}（src 未迁移）`);
    }
    continue;
  }
  const shared = readFileSync(sharedPath, "utf8");
  const zcTpl = readFileSync(join(SRC, `${name}.zcode.tpl.ts`), "utf8");
  const piTpl = readFileSync(join(SRC, `${name}.pi.tpl.js`), "utf8");

  const rewritten = rewriteAgentCalls(shared);
  if (rewritten.count === 0) throw new Error(`${name}: 公共体未发现 agent( 调用点——切分错误`);
  // O 区观测层拼接：已接入观测（正文含 initObservation 调用点）→ 观测层全文前置；
  // 观测层文件缺失 = 构建失败（不允许静默退回无观测产物）
  const obsLayer = (() => {
    if (!/initObservation\(/.test(shared)) return "";
    try {
      return readFileSync(OBS_LAYER_PATH, "utf8");
    } catch {
      throw new Error(`${name}: 已接入观测但缺 ${OBS_LAYER_PATH.slice(ROOT.length + 1)}——观测层单一构建输入不可缺失`);
    }
  })();
  const sharedFull = obsLayer !== "" ? `${obsLayer}\n${shared}` : shared;
  const rewrittenFull = obsLayer !== "" ? rewriteAgentCalls(sharedFull) : rewritten;
  if (obsLayer !== "" && rewrittenFull.count !== rewritten.count) {
    throw new Error(`${name}: 观测层中出现 agent( 调用点（不应发生——观测层不派 agent）`);
  }
  const piShared = stripTs(rewrittenFull.text);
  const zcOut = stitch(zcTpl, sharedFull);
  const piOut = stitch(piTpl, piShared);

  // 观测契约核对（构建期门禁：stage/step 词表、事件字段、终态统一补记出口、两侧调用点一致）
  const obsErrors = [];
  checkObservationContract(name, shared, obsLayer, zcOut, piOut, obsErrors);
  if (obsErrors.length > 0) {
    for (const e of obsErrors) console.error(`✗ ${e}`);
    dirty += obsErrors.length;
  }

  const targets = [
    [join(WF, `${name}.dwf.ts`), zcOut],
    [join(WF, "pi", `${name}.js`), piOut],
    // zcode saved 副本与仓内产物同内容（CreateWorkflow 的 saved 发现目录）
    [join(SAVED_DIR, `${name}.dwf.ts`), zcOut],
  ];
  for (const [path, content] of targets) {
    const rel = path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path.replace(homedir(), "~");
    const existing = (() => { try { return readFileSync(path, "utf8"); } catch { return null; } })();
    if (existing === content) {
      console.log(`✓ ${rel}（一致）`);
    } else if (check) {
      console.error(`✗ ${rel} 与重生成结果不一致（产物过期或 saved 副本滞后）——重跑 node scripts/build-workflows.mjs`);
      dirty++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`已生成 ${rel}`);
    }
  }
}

if (check && dirty > 0) {
  console.error(`\n${dirty} 个产物过期。恢复动作：node scripts/build-workflows.mjs`);
  process.exit(1);
}
