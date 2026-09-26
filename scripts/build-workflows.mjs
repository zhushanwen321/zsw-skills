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
// 用法：node scripts/build-workflows.mjs [--check]
//   默认构建全部产物并同步 zcode saved 副本（~/.zcode/workflows/）；--check 校验产物
//   与重生成结果一致 + saved 副本未滞后（pre-commit 防改源忘构建 / 忘同步 saved）
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
let dirty = 0;

for (const name of NAMES) {
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
  const piShared = stripTs(rewritten.text);
  const zcOut = stitch(zcTpl, shared);
  const piOut = stitch(piTpl, piShared);

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
