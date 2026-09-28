#!/usr/bin/env node
// 处置表校验器（tech-review-loop W1 的业务级结构化校验，单一实现双轨复用）：
//   - workflow 脚本：覆盖校验失败回喂重试前调用，stdout JSON 即回喂原料
//   - 手工路径（flow/review.md Step 4）：主会话对 subagent 产出的处置表跑同一校验
// 与 schema 级校验（zcode agent() 合成 schema / pi structured-output 门禁）分层：
// 本脚本管 schema 表达不了的业务约束——覆盖完整性与条目内部一致性。
//
// 用法：
//   node check-dispositions.mjs <dispositions.json> [--problems <problems.json>]
//     dispositions.json：{dispositions:[...]} 或裸数组（tech-review-loop 落盘格式）
//     problems.json：{problems:[{ref,level,title},...]} 或裸数组（本轮问题清单，
//       ref 形如 review-main#2；不传则只做内部一致性校验，不做覆盖校验）
// 输出（stdout 一行 JSON）：
//   {ok, counts, errors:[{kind, detail}], warnings:[...], coverage?}
// 退出码：0 = 通过；1 = 校验失败（errors 非空）；2 = 用法/文件错误

import { readFileSync } from "node:fs";

function failUsage(msg) {
  process.stderr.write(`用法错误：${msg}\n用法：node check-dispositions.mjs <dispositions.json> [--problems <problems.json>]\n`);
  process.exit(2);
}

function readJsonArg(path, what) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    failUsage(`读取${what}失败（${path}）：${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    failUsage(`${what}不是合法 JSON（${path}）：${e.message}`);
  }
}

const argv = process.argv.slice(2);
const dispPath = argv[0];
if (!dispPath) failUsage("缺少 dispositions.json 参数");
const probIdx = argv.indexOf("--problems");
const probPath = probIdx >= 0 ? argv[probIdx + 1] : null;
if (probIdx >= 0 && !probPath) failUsage("--problems 后缺少路径参数");

const dispRoot = readJsonArg(dispPath, "dispositions 文件");
const dispArr = Array.isArray(dispRoot) ? dispRoot : Array.isArray(dispRoot?.dispositions) ? dispRoot.dispositions : null;
if (dispArr === null) failUsage("dispositions 文件既不是数组也不含 dispositions 数组字段");

let probArr = null;
if (probPath !== null) {
  const probRoot = readJsonArg(probPath, "problems 文件");
  probArr = Array.isArray(probRoot) ? probRoot : Array.isArray(probRoot?.problems) ? probRoot.problems : null;
  if (probArr === null) failUsage("problems 文件既不是数组也不含 problems 数组字段");
}

const errors = [];
const warnings = [];
const LEVELS = new Set(["must-fix", "suggestion"]);
const ACTIONS = new Set(["fixed", "deferred", "archived"]);

if (dispArr.length === 0) {
  errors.push({ kind: "empty", detail: "dispositions 为空数组——修复者必须显式返回处置表（零问题轮不会派修复者，收到空表即异常）" });
}

const seenIds = new Map();
dispArr.forEach((d, i) => {
  const at = `dispositions[${i}]`;
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    errors.push({ kind: "shape", detail: `${at} 不是对象` });
    return;
  }
  if (typeof d.id !== "string" || d.id.trim() === "") {
    errors.push({ kind: "field", detail: `${at} 缺 id 或非字符串（新条目格式 D-<轮>-<序>；延续上轮的条目复用原 id）` });
  } else if (seenIds.has(d.id)) {
    errors.push({ kind: "dup", detail: `${at} id「${d.id}」与第 ${seenIds.get(d.id)} 条重复` });
  } else {
    seenIds.set(d.id, at);
    if (!/^D-\d+-\d+$/.test(d.id.trim())) {
      warnings.push(`${at} id「${d.id}」不符合 D-<轮>-<序> 形态（延续条目应复用上轮原 id，新造形态会导致下轮对账失配）`);
    }
  }
  if (!LEVELS.has(d.level)) errors.push({ kind: "field", detail: `${at}（${d.id ?? "?"}）level 非法：${JSON.stringify(d.level)}（须 must-fix|suggestion）` });
  if (!ACTIONS.has(d.action)) errors.push({ kind: "field", detail: `${at}（${d.id ?? "?"}）action 非法：${JSON.stringify(d.action)}（须 fixed|deferred|archived）` });
  if (!Array.isArray(d.source) || d.source.length === 0 || d.source.some((s) => typeof s !== "string" || s.trim() === "")) {
    errors.push({ kind: "field", detail: `${at}（${d.id ?? "?"}）source 须为非空字符串数组（该条覆盖的原始问题引用，合并几条列几条）` });
  }
  for (const f of ["title", "location", "affectsDecision", "affectsDelivery"]) {
    if (typeof d[f] !== "string" || d[f].trim() === "") {
      errors.push({ kind: "field", detail: `${at}（${d.id ?? "?"}）${f} 缺失或为空（affects* 无影响也须显式写「无」）` });
    }
  }
  for (const f of ["reenactment", "attackHints"]) {
    if (typeof d[f] !== "string" || d[f].trim() === "") {
      warnings.push(`${at}（${d.id ?? "?"}）${f} 为空——修复纪律要求逐条填写（登记/归档条目可写「不适用」但不应留空）`);
    }
  }
});

let coverage = null;
if (probArr !== null && errors.filter((e) => e.kind === "shape" || e.kind === "empty").length === 0) {
  const cited = new Set(dispArr.flatMap((d) => (Array.isArray(d.source) ? d.source.filter((s) => typeof s === "string") : [])));
  const probs = probArr
    .map((p, i) => ({ ...p, _at: `problems[${i}]` }))
    .filter((p) => p && typeof p === "object");
  for (const p of probs) {
    if (typeof p.ref !== "string" || p.ref.trim() === "" || !LEVELS.has(p.level)) {
      errors.push({ kind: "problem-shape", detail: `${p._at} 缺 ref/level 或形态非法（ref 如 review-main#2；level 须 must-fix|suggestion）` });
    }
  }
  const coverageInner = {};
  for (const lv of LEVELS) {
    const ofLevel = probs.filter((p) => p.level === lv && typeof p.ref === "string" && p.ref.trim() !== "");
    const missing = ofLevel.filter((p) => !cited.has(p.ref)).map((p) => `${p.ref}（${typeof p.title === "string" ? p.title : ""}）`);
    coverageInner[lv] = { total: ofLevel.length, missing };
    for (const m of missing) {
      errors.push({ kind: "coverage", detail: `${lv} 问题 ${m} 未被任何处置条目的 source 引用——处置表必须覆盖本轮全部问题（含登记不修/归档形态）` });
    }
  }
  coverage = coverageInner;
  const knownRefs = new Set(probs.map((p) => p.ref));
  for (const ref of cited) {
    if (!knownRefs.has(ref)) {
      warnings.push(`source 引用「${ref}」不在本轮问题清单内——跨轮延续条目的历史引用属合法，请人工确认非编造`);
    }
  }
}

const out = {
  ok: errors.length === 0,
  counts: { dispositions: dispArr.length, problems: probArr === null ? null : probArr.length },
  errors,
  warnings,
};
if (coverage !== null) out.coverage = coverage;
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(errors.length === 0 ? 0 : 1);
