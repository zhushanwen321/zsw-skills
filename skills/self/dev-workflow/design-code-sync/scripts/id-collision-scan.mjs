#!/usr/bin/env node
/**
 * id-collision-scan.mjs —— 跨设计包编号撞号消歧扫描
 *
 * 归属：design-code-sync Step 0 验证矩阵（L0 直跑）；dev-flow-wf W4 sync-planner 开审前置。
 * 解决的问题：多设计包并存（历史包未退役）时，仓库文档/注释里裸写的编号 token
 * （如 V1、RL3）可能同号不同义——上一代设计包的 V1 与本轮设计包的 V1 是两个东西。
 * 开审前用本脚本确定性找出全部裸引用，分钟级替代 LLM 审查逐条发现；
 * 退出码 2 = 命中，须先完成消歧登记（域前缀标注）再开审。
 *
 * 形态常量（判定依据）：
 * - TOKEN_RE = /\b[A-Z]{1,4}\d{1,3}[a-z]?\b/
 *     设计包条目编号形态：1-4 个大写字母 + 1-3 位数字 + 可选单个小写字母后缀。
 *     依据：两代设计包条目编号实测均落此形态（V1-V11、RL1-RL10、U1-U12、D1-D10、
 *     AS1-AS20、GL1、SI1、PR2、AX3 等）。
 * - ANNOTATED_CHAR = '·'（U+00B7）
 *     已消歧标注形态：token 紧邻「·」（前一字符或后一字符）视为已域标注，不计。
 *     依据：存量权威标注形态为「V1·RL3」——域前缀 token 后紧跟「·」，被限定编号
 *     token 前紧邻「·」，两侧都排除才能识别完整标注引用（main 仓 commit b9cedb1 /
 *     23a46e4 落盘形态核实）。
 * - DEFAULT_STOP = P0-P3 + R0-R9 + MP4 + A3，DEFAULT_STOP_PATTERNS = /^L\d{1,3}$/
 *     默认停扫表：P0-P3 在设计包文档里是优先级语义不是条目编号；R0-R9 是单数字
 *     轮次标签；L+数字 是「原文行号引用」惯用形态（两代设计包文档大量
 *     「原文 L110-119」式引用，实测零条目编号语义）；MP4 / A3 是媒体格式与纸张
 *     尺寸等恰好撞上编号形态的通用词。--stop 追加，--no-default-stop 关闭默认表。
 * - QUALIFIER_ANNOTATION = '本轮'
 *     已声明的标注形态：token 前面（仅隔空白）紧邻「本轮」视为已域标注，不计。
 *     依据：fixtures README 明文声明「本轮 X」式引用 = 当前设计域场景编号
 *     （commit 23a46e4 落盘的「本轮 V9 / V1·RL7」双域标注同形态）。
 *     其余半标注形态（「X 设计包」「dev-flow D3」等非紧邻限定词）不排除，
 *     照常命中、进消歧登记由人核实归属。
 *
 * 用法：
 *   node id-collision-scan.mjs --package <当前设计包目录> --project <项目根>
 *     [--docs <文件路径>...] [--tech-design-root <目录>] [--json]
 *     [--stop <逗号分隔token>] [--no-default-stop]
 *
 * - 其他包 = --tech-design-root（缺省取 --package 的父目录）下除当前包外的全部
 *   子目录；子目录含设计包产物（章节阶段 JSON / final.json / *.rendered.md 任一）
 *   才认定为设计包，其余跳过
 * - 目标文档缺省 = git -C <projectRoot> ls-files '*.md'；--docs 显式给出时以给出的
 *   文件为准（允许代码文件）；--docs 相对路径按执行时 cwd 解析
 * - 分类逐行扫描、不解析语法：裸 token 命中其他包词表 = FOREIGN（他包编号裸引用）；
 *   同时命中当前包词表 = COLLISION（同号撞号，歧义风险最高）
 * - 退出码：0 = 零命中；2 = 有 COLLISION 或 FOREIGN（开审前先完成消歧登记）；
 *   1 = 参数/环境错误
 *
 * 零依赖：仅 node 内置模块（fs / path / child_process）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOKEN_RE = /\b[A-Z]{1,4}\d{1,3}[a-z]?\b/g;
const ANNOTATED_CHAR = '·';
const QUALIFIER_ANNOTATION = '本轮';
const DEFAULT_STOP = ['P0', 'P1', 'P2', 'P3', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'MP4', 'A3'];
const DEFAULT_STOP_PATTERNS = [/^L\d{1,3}$/];
const CHAPTER_JSON_RE = /^s\d+-[a-z-]+\.json$/; // 章节阶段 JSON（s1-context.json…s5-breakdown.json）
const RENDERED_MD_RE = /\.rendered\.md$/;

function usage() {
  console.error(`用法：node id-collision-scan.mjs --package <当前设计包目录> --project <项目根>
  [--docs <文件路径>...] [--tech-design-root <目录>] [--json]
  [--stop <逗号分隔token>] [--no-default-stop]`);
}

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { docs: [], stop: [], noDefaultStop: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package') opts.packageDir = argv[++i];
    else if (a === '--project') opts.projectRoot = argv[++i];
    else if (a === '--tech-design-root') opts.techDesignRoot = argv[++i];
    else if (a === '--docs') {
      // 变参：吞到下一个 -- 开头的旗标为止
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.docs.push(argv[++i]);
    } else if (a === '--stop') {
      const raw = argv[++i];
      if (raw === undefined) fail('--stop 需要逗号分隔 token 参数');
      opts.stop.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--no-default-stop') opts.noDefaultStop = true;
    else if (a === '--json') opts.json = true;
    else fail(`未知参数 ${a}（见上方用法）`);
  }
  if (!opts.packageDir) fail('缺少 --package <当前设计包目录>');
  if (!opts.projectRoot) fail('缺少 --project <项目根>');
  return opts;
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** 设计包词表：token → 出现计数 */
function extractVocab(dir) {
  const counts = new Map();
  for (const f of walkFiles(dir)) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // 读不了的文件（权限/二进制怪形态）跳过，不中断扫描
    }
    for (const m of text.matchAll(TOKEN_RE)) {
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }
  return counts;
}

function isDesignPackage(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return (
    names.some((n) => CHAPTER_JSON_RE.test(n)) ||
    names.includes('final.json') ||
    names.some((n) => RENDERED_MD_RE.test(n))
  );
}

function relTo(root, file) {
  const rel = path.relative(root, file);
  return rel.startsWith('..') ? file : rel;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const packageDir = path.resolve(opts.packageDir);
  const projectRoot = path.resolve(opts.projectRoot);
  if (!fs.statSync(packageDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`--package 目录不存在：${packageDir}（须为设计包目录）`);
  }
  if (!fs.statSync(projectRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`--project 目录不存在：${projectRoot}（须为项目根）`);
  }

  const techDesignRoot = path.resolve(opts.techDesignRoot ?? path.dirname(packageDir));
  if (!fs.statSync(techDesignRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`--tech-design-root 目录不存在：${techDesignRoot}`);
  }

  // 其他设计包：tech-design 根下除当前包外的合格子目录
  const otherPackages = [];
  for (const name of fs.readdirSync(techDesignRoot, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.')) continue;
    const full = path.join(techDesignRoot, name.name);
    if (path.resolve(full) === path.resolve(packageDir)) continue;
    if (!isDesignPackage(full)) continue;
    otherPackages.push({ name: name.name, dir: full, vocab: extractVocab(full) });
  }

  const curVocab = extractVocab(packageDir);

  // 他包词表合并：token → [包名…]（按包内出现次数降序排包名）
  const tokenOwners = new Map();
  for (const pkg of otherPackages) {
    for (const [tok, count] of pkg.vocab) {
      if (!tokenOwners.has(tok)) tokenOwners.set(tok, []);
      tokenOwners.get(tok).push({ name: pkg.name, count });
    }
  }
  for (const owners of tokenOwners.values()) owners.sort((a, b) => b.count - a.count);

  const stopSet = new Set();
  if (!opts.noDefaultStop) for (const t of DEFAULT_STOP) stopSet.add(t);
  for (const t of opts.stop) {
    stopSet.add(t);
    stopSet.add(t.toUpperCase()); // 用户给小写也能命中（token 本身全大写形态）
  }
  const isStopped = (tok) =>
    stopSet.has(tok) || (!opts.noDefaultStop && DEFAULT_STOP_PATTERNS.some((re) => re.test(tok)));
  // 已域标注判定：token 紧邻「·」两侧，或前面（仅隔空白）紧邻「本轮」
  const isAnnotated = (line, index, length) => {
    if (line[index - 1] === ANNOTATED_CHAR || line[index + length] === ANNOTATED_CHAR) return true;
    const before = line.slice(0, index).replace(/\s+$/, '');
    return before.endsWith(QUALIFIER_ANNOTATION);
  };

  // 目标文档
  const missing = [];
  let docSource;
  let files;
  if (opts.docs.length) {
    docSource = '--docs 显式给出';
    files = opts.docs.map((d) => path.resolve(d));
  } else {
    docSource = "git ls-files '*.md'";
    let out;
    try {
      out = execFileSync('git', ['-C', projectRoot, 'ls-files', '*.md'], { encoding: 'utf8' });
    } catch {
      fail(`git ls-files 失败：${projectRoot} 不是可用的 git 仓库？用 --docs <文件路径>... 显式给目标文件`);
    }
    files = out.split('\n').filter(Boolean).map((p) => path.resolve(projectRoot, p));
  }
  files = files.filter((f) => {
    if (fs.statSync(f, { throwIfNoEntry: false })?.isFile()) return true;
    missing.push(f);
    return false;
  });
  if (opts.docs.length && missing.length) {
    fail(`--docs 给出的文件不存在：\n${missing.map((f) => `  ${f}`).join('\n')}`);
  }

  // 逐行扫描
  const hits = { COLLISION: new Map(), FOREIGN: new Map() }; // token → [{file, line}]
  const seen = new Set(); // token|file|line 去重
  let annotatedSkipped = 0;
  let stopSkipped = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      for (const m of line.matchAll(TOKEN_RE)) {
        const tok = m[0];
        if (isAnnotated(line, m.index, tok.length)) {
          annotatedSkipped++;
          continue;
        }
        if (isStopped(tok)) {
          stopSkipped++;
          continue;
        }
        const owners = tokenOwners.get(tok);
        if (!owners) continue; // 他包词表都没有 = 无撞号歧义
        const cat = curVocab.has(tok) ? 'COLLISION' : 'FOREIGN';
        const key = `${tok}|${file}|${li + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!hits[cat].has(tok)) hits[cat].set(tok, []);
        hits[cat].get(tok).push({ file: relTo(projectRoot, file), line: li + 1 });
      }
    }
  }

  const stat = (m) => [m.size, [...m.values()].reduce((n, v) => n + v.length, 0)];
  const [colTokens, colHits] = stat(hits.COLLISION);
  const [forTokens, forHits] = stat(hits.FOREIGN);
  const hasHits = colTokens + forTokens > 0;

  const ownerLabel = (tok) => {
    const parts = [];
    if (curVocab.has(tok)) parts.push(`当前包 ×${curVocab.get(tok)}`);
    for (const o of tokenOwners.get(tok) ?? []) parts.push(`${o.name} ×${o.count}`);
    return parts.join(' / ');
  };

  const json = {
    package: packageDir,
    techDesignRoot,
    otherPackages: otherPackages.map((p) => p.name),
    targetDocs: { source: docSource, scanned: files.length, missing },
    stop: { defaultDisabled: opts.noDefaultStop, extra: opts.stop },
    collisions: [...hits.COLLISION.entries()].map(([token, occurrences]) => ({
      token,
      packages: ownerLabel(token),
      occurrences,
    })),
    foreign: [...hits.FOREIGN.entries()].map(([token, occurrences]) => ({
      token,
      packages: ownerLabel(token),
      occurrences,
    })),
    stats: {
      collisionTokens: colTokens,
      collisionHits: colHits,
      foreignTokens: forTokens,
      foreignHits: forHits,
      annotatedSkipped,
      stopSkipped,
      exitCode: hasHits ? 2 : 0,
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('跨包编号撞号消歧扫描');
    console.log(`当前包: ${packageDir}`);
    console.log(`其他包(${otherPackages.length}): ${otherPackages.map((p) => p.name).join(', ') || '无'}`);
    console.log(`技术设计根: ${techDesignRoot}`);
    console.log(`目标文档: ${files.length} 个（来源: ${docSource}）${missing.length ? `，跳过缺失 ${missing.length} 个` : ''}`);
    console.log('');
    const section = (title, entries) => {
      console.log(`== ${title} ==`);
      if (!entries.length) {
        console.log('（零命中）');
        return;
      }
      for (const [tok, occ] of entries) {
        console.log(`${tok}  [${ownerLabel(tok)}]`);
        for (const o of occ) console.log(`  - ${o.file}:${o.line}`);
      }
    };
    section('COLLISION（同号撞号：当前包与其他包同号不同义，歧义风险最高）', [...hits.COLLISION.entries()]);
    console.log('');
    section('FOREIGN（他包编号裸引用：当前包词表无此号）', [...hits.FOREIGN.entries()]);
    console.log('');
    console.log(
      `统计: COLLISION ${colTokens} 个 token / ${colHits} 处，FOREIGN ${forTokens} 个 token / ${forHits} 处；` +
        `已标注（·）跳过 ${annotatedSkipped}，停扫表跳过 ${stopSkipped}`
    );
    console.log(
      hasHits
        ? '退出码 2 = 开审前先完成消歧登记（域前缀标注，形态同存量「V1·RL3」），登记清单随审查任务书下发'
        : '退出码 0 = 零命中，无撞号，可直接开审'
    );
  }

  process.exit(hasHits ? 2 : 0);
}

main();
