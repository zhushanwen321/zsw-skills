#!/usr/bin/env node
// gen-evidence-bundle.mjs — 证据内容索引（three-skill-v5 结构化优化设计 §5.3，迁移第四步）
//
// 作为 EvidenceRecorded 所引用的 artifact：统一索引一次验证的原始记录（summary.jsonl /
// inspect verdict.json / 命令回执）与附属内容（日志 / 截图 / 轨迹），保留路径与内容哈希。
//
// 红线（§5.3 / §7.6）：事件中的 revision、assertionIds、adversarialFormIds 等绑定字段不复制
// 进索引（事件保存断言与 revision 绑定，summary/verdict 保存执行事实，bundle 只保存引用与
// 附属 artifact 哈希——三处单一职责，双写会制造第二事实源）。--check 对 bundle 中的禁字段
// 报不一致。
//
// 观测与证据产物的生成规则（设计 §4 第 2 类）：不要求同输入字节级重生成，只要求结构合法、
// 来源清楚、引用文件存在、内容哈希可重算。原始步骤的 pass/fail/skipped 不自动升格为
// verified——独立保证阅读后登记 EvidenceRecorded，delivery-gate 继续按事件判定。
//
// 用法：
//   node gen-evidence-bundle.mjs --artifacts-dir <dir> [--summary <path>] [--verdict <path>] [--out <bundle>] [--check]
//
//   生成（缺 --check）：缺省 out = <artifacts-dir>/evidence-bundle.json。
//     sourceRecords：--summary / --verdict 给定路径存在才登记（D3 对每节点统一传参，inspect
//     verdict 不存在属正常路径，不算错误）；kind = summary / inspect-verdict。
//     纯命令场景（--summary 与 --verdict 都未指定）：登记 artifacts-dir 根下 receipt.jsonl
//     （约定名）为 kind=command-receipt——bundle 直接承载一次原始命令回执，它是原始记录，
//     不再生成第二份同语义回执（§5.3）。
//     artifacts：artifacts-dir 内其余文件（递归）逐个登记 id/kind/path/sha256；kind 按扩展名
//     归类 screenshot（png/jpg/jpeg/gif/webp）/ trace（har/trace/prof）/ log（log/txt/jsonl）/
//     other；已登记进 sourceRecords 的文件与 bundle 自身不重复登记。
//     path 形态：目录内文件 = 相对 artifacts-dir（bundle 随目录走，路径自包含）；目录外文件
//     （显式给定的 summary/verdict）= 绝对路径；顶层 artifactsDir 字段登记定位基准。
//   校验（--check）：白名单 schema 校验（顶层 / generator / sourceRecords 条目 / artifacts
//     条目的键集限定死，多余键含嵌套藏字段逐条 FAIL，事件绑定字段命中给专门消息）+ 对已生成
//     bundle 重算全部引用文件的 sha256——文件缺失或哈希漂移逐条报不一致；问题清单走 stderr
//     （三段式消息），一致输出 PASS。
//
// 输出契约：成功 / 一致 → stdout 结果，exit 0；不一致 → stderr 逐条 FAIL + exit 1；用法错误 exit 2。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const GENERATOR = { name: "gen-evidence-bundle", version: "1.0.0" };
const BUNDLE_NAME = "evidence-bundle.json";
const RECEIPT_NAME = "receipt.jsonl";
// §5.3 红线：事件绑定字段（revision / 断言 / 反例绑定）不得进内容索引——双写制造第二事实源。
// --check 用白名单 schema 校验兜住：顶层与条目键集限定死（多余键 FAIL），禁字段命中给专门
// 消息（比通用「多余键」更可操作），嵌套藏字段由条目白名单拦截
const FORBIDDEN_FIELDS = ["revision", "assertionIds", "adversarialFormIds", "unitIds", "steps", "skipped", "verdict"];
const TOP_LEVEL_KEYS = ["schemaVersion", "generator", "artifactsDir", "sourceRecords", "artifacts"];
const GENERATOR_KEYS = ["name", "version"];
const SOURCE_RECORD_KEYS = ["kind", "path", "sha256"];
const ARTIFACT_KEYS = ["id", "kind", "path", "sha256"];
const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TRACE_EXTS = new Set([".har", ".trace", ".prof"]);
const LOG_EXTS = new Set([".log", ".txt", ".jsonl"]);
const USAGE =
  "用法：node gen-evidence-bundle.mjs --artifacts-dir <dir> [--summary <path>] [--verdict <path>] [--out <bundle>] [--check]";

// ── 纯工具 ──

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 三段式消息：哪个输入不合法 → 权威源在哪里 → 修改后运行哪个命令（设计 §7 统一形态） */
function failLine(headline, source, recovery) {
  return `FAIL: evidence-bundle: ${headline}\n  权威源：${source}\n  恢复：${recovery}`;
}

/** 白名单 schema 校验单层：键集必须与白名单完全一致（缺键 / 多余键都 FAIL）；
 *  禁字段命中给专门消息（事件绑定不进内容索引，§5.3 / §7.6 红线） */
function whitelistKeyProblems(label, keys, whitelist, source, recovery) {
  const problems = [];
  const forbidden = keys.filter((k) => FORBIDDEN_FIELDS.includes(k));
  if (forbidden.length > 0) {
    problems.push(failLine(`${label} 含禁字段（事件绑定 / 执行事实不进内容索引）：${forbidden.join("、")}`, source, recovery));
    return problems;
  }
  const extra = keys.filter((k) => !whitelist.includes(k));
  const missing = whitelist.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    const detail = [missing.length > 0 ? `缺键 ${missing.join("、")}` : null, extra.length > 0 ? `多余键 ${extra.join("、")}` : null].filter(Boolean).join("；");
    problems.push(failLine(`${label} 键集与白名单不一致（${detail}；白名单 = ${whitelist.join(" / ")}）`, source, recovery));
  }
  return problems;
}

function fatal(headline, source, recovery, code = 1) {
  process.stderr.write(failLine(headline, source, recovery) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  const valued = ["--artifacts-dir", "--summary", "--verdict", "--out"];
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (valued.includes(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fatal(`参数 ${key} 缺值`, "用法见脚本头注释", USAGE, 2);
      out[key] = value;
      i += 1;
    } else if (key === "--check") {
      out["--check"] = true;
    } else {
      fatal(`未知参数 ${key}`, "用法见脚本头注释", USAGE, 2);
    }
  }
  return out;
}

function kindByExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (SCREENSHOT_EXTS.has(ext)) return "screenshot";
  if (TRACE_EXTS.has(ext)) return "trace";
  if (LOG_EXTS.has(ext)) return "log";
  return "other";
}

/** 递归收集目录内全部文件，返回相对 dir 的路径清单（排序保证 id 序稳定） */
function listFilesRecursive(dir) {
  const out = [];
  const walk = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

// ── 生成 ──

function buildBundle(args) {
  if (!args["--artifacts-dir"]) fatal("缺 --artifacts-dir 参数", "用法见脚本头注释", USAGE, 2);
  const artifactsDir = resolve(args["--artifacts-dir"]);
  if (!existsSync(artifactsDir) || !statSync(artifactsDir).isDirectory()) {
    fatal(`artifacts 目录不存在或不是目录：${artifactsDir}`, "artifacts 目录是 D3 verify 剧本产物落点（<taskDir>/evidence/<node-id>-artifacts，compile.md「每步汇总落盘」）", "核对目录路径；目录尚未产生则先执行验证，再运行本命令生成 bundle");
  }
  const outPath = args["--out"] ? resolve(args["--out"]) : join(artifactsDir, BUNDLE_NAME);

  const sourceRecords = [];
  const recordedAbs = new Set();
  const registerSource = (kind, path) => {
    const abs = resolve(path);
    if (!existsSync(abs)) return false; // 「存在才登记」：inspect verdict 缺失属正常路径
    sourceRecords.push({ kind, path: abs.startsWith(artifactsDir) ? relative(artifactsDir, abs) : abs, sha256: sha256File(abs) });
    recordedAbs.add(abs);
    return true;
  };
  const hasSummaryArg = Boolean(args["--summary"]);
  const hasVerdictArg = Boolean(args["--verdict"]);
  if (hasSummaryArg) registerSource("summary", args["--summary"]);
  if (hasVerdictArg) registerSource("inspect-verdict", args["--verdict"]);
  if (!hasSummaryArg && !hasVerdictArg) {
    // 纯命令场景：bundle 直接承载原始命令回执（约定名 receipt.jsonl），不生成第二份同语义回执
    registerSource("command-receipt", join(artifactsDir, RECEIPT_NAME));
  }

  // 附属 artifact：目录内其余文件逐个内容寻址；已登记为原始记录的文件与 bundle 产物（含目录内
  // 残留的旧 bundle——bundle 是索引产物不是内容，重建后不应作为附属内容留在索引里）不重复登记
  const kinds = { screenshot: 0, trace: 0, log: 0, other: 0 };
  const artifacts = listFilesRecursive(artifactsDir)
    .filter((rel) => basename(rel) !== BUNDLE_NAME && rel !== basename(outPath) && !recordedAbs.has(resolve(artifactsDir, rel)))
    .map((rel) => {
      const kind = kindByExt(rel);
      kinds[kind] += 1;
      const id = `${kind}-${kinds[kind]}`;
      return { id, kind, path: rel, sha256: sha256File(join(artifactsDir, rel)) };
    });

  const bundle = { schemaVersion: 1, generator: GENERATOR, artifactsDir, sourceRecords, artifacts };
  writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n");
  process.stdout.write(
    `PASS: evidence-bundle 写入 ${outPath}（原始记录 ${sourceRecords.length} 条、附属 artifact ${artifacts.length} 个）\n`,
  );
}

// ── 校验（--check）──

function checkBundle(bundlePath) {
  if (!existsSync(bundlePath)) {
    fatal(`bundle 文件不存在：${bundlePath}`, "evidence-bundle.json 由本工具生成（禁止手改）", `运行 node ~/.agents/skills/dev-flow-v6/scripts/gen-evidence-bundle.mjs --artifacts-dir <dir> 生成 bundle`);
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (error) {
    fatal(`bundle 不可读或不是合法 JSON：${bundlePath}（${error.message}）`, "evidence-bundle.json 由本工具生成（禁止手改）", `运行 node ~/.agents/skills/dev-flow-v6/scripts/gen-evidence-bundle.mjs --artifacts-dir <dir> 重新生成 bundle`);
  }
  const problems = [];
  const recover = `运行 node ~/.agents/skills/dev-flow-v6/scripts/gen-evidence-bundle.mjs --artifacts-dir ${bundle.artifactsDir ?? "<artifacts-dir>"} 重新生成 bundle`;
  const source = "evidence-bundle.json 是证据内容索引（观测产物，设计 §4 第 2 类）：引用文件与哈希必须可重算，事件绑定归事件流";

  if (bundle.schemaVersion !== 1) problems.push(failLine(`schemaVersion 必须为 1，实际：${JSON.stringify(bundle.schemaVersion)}`, source, recover));
  // 白名单 schema 校验：顶层 / generator / sourceRecords 条目 / artifacts 条目键集全部限定死
  problems.push(...whitelistKeyProblems("bundle 顶层", Object.keys(bundle), TOP_LEVEL_KEYS, source, recover));
  if (typeof bundle.generator === "object" && bundle.generator !== null && !Array.isArray(bundle.generator)) {
    problems.push(...whitelistKeyProblems("generator", Object.keys(bundle.generator), GENERATOR_KEYS, source, recover));
  }
  if (!bundle.artifactsDir || typeof bundle.artifactsDir !== "string") {
    problems.push(failLine(`缺 artifactsDir 定位基准字段`, source, recover));
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
  }
  if (!Array.isArray(bundle.sourceRecords) || !Array.isArray(bundle.artifacts)) {
    problems.push(failLine("sourceRecords / artifacts 必须是数组", source, recover));
  }
  const entries = [
    ...(Array.isArray(bundle.sourceRecords) ? bundle.sourceRecords : []),
    ...(Array.isArray(bundle.artifacts) ? bundle.artifacts : []),
  ];
  // 条目白名单：键集限定死——嵌套藏字段（条目内塞 revision / assertionIds 等）在此拦截
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const isArtifactList = Array.isArray(bundle.artifacts) && bundle.artifacts.includes(entry);
    const label = `条目（id/path=${entry.id ?? entry.path ?? "?"}，${isArtifactList ? "artifacts" : "sourceRecords"}）`;
    problems.push(...whitelistKeyProblems(label, Object.keys(entry), isArtifactList ? ARTIFACT_KEYS : SOURCE_RECORD_KEYS, source, recover));
  }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const role = Array.isArray(bundle.artifacts) && bundle.artifacts.includes(entry) ? "artifacts" : "sourceRecords";
    const abs = typeof entry.path === "string" && entry.path.startsWith("/") ? entry.path : join(bundle.artifactsDir, entry.path ?? "");
    if (typeof entry.path !== "string") {
      problems.push(failLine(`${role} 条目缺 path（id=${entry.id ?? "?"}）`, source, recover));
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(failLine(`${role} 条目 ${entry.id ?? entry.path} 引用的文件已缺失：${abs}`, `原始记录与附属内容所在目录：${bundle.artifactsDir}`, recover));
      continue;
    }
    const actual = sha256File(abs);
    if (actual !== entry.sha256) {
      problems.push(failLine(`${role} 条目 ${entry.id ?? entry.path} 内容哈希漂移（登记 ${entry.sha256} ≠ 实算 ${actual}）：${abs}`, `内容被改动后索引失效；原始内容以哈希登记时所在的目录：${bundle.artifactsDir}`, recover));
    }
  }
  if (problems.length > 0) {
    // 与 fatal 同通道：校验问题清单走 stderr（stdout 只承载 PASS）
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(`PASS: evidence-bundle 一致（原始记录 ${bundle.sourceRecords?.length ?? 0} 条、附属 artifact ${bundle.artifacts?.length ?? 0} 个，哈希全部可重算）\n`);
}

// ── 入口 ──

const args = parseArgs(process.argv.slice(2));
if (args["--check"]) {
  checkBundle(args["--out"] ? resolve(args["--out"]) : join(resolve(args["--artifacts-dir"] ?? "."), BUNDLE_NAME));
} else {
  buildBundle(args);
}
