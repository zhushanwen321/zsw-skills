#!/usr/bin/env node
// extract-backticks.mjs — T3 符号词表生成器第一步：提取设计文档反引号词（纯机械，零语义）
//
// 提取规则与 design-code-sync-loop 扫描器（NODE_BACKTICK_GREP）逐字同源：
// 反引号内容 /`([^`\n]{2,60})`/g → 纯 ASCII、无 "/" 无空格、词数 ≤4、非版本号，去重，
// 上限 300 防爆。两侧规则必须同步修改——规则漂移 = 词表与扫描器口径不一致，校验恒红。
//
// 输出（2026-11-04 结构化改造）：
//   { schemaVersion: 1,
//     sourceFingerprints: { <输入路径>: sha256 },   ← 词表甄别时原样抄进 watchlist，
//                                                      下游 W4 setup 按指纹校验「文档改了
//                                                      词表没重生成」（替代旧反引号等集）
//     words: [...],                                 ← 提取词（按首次出现排序，≤300）
//     dropped: [{ word, rule }] }                   ← 被过滤词与剔除规则——漏报可审计
//                                                      （旧静默过滤 = 下游扫描盲区无告警通道）
//
// 用法：node extract-backticks.mjs <设计文档路径> [impl-plan.md 路径 ...]
// 本脚本只产草稿——哪些词纳入扫描（scan）、哪些剔除（skip）由 T3 主 agent 对照设计文档
// 语义分析后写入 <basename>.symbol-watchlist.json（见 flow/plan.md「符号词表」节）。

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("用法：node extract-backticks.mjs <设计文档路径> [impl-plan.md ...]");
  process.exit(1);
}

const DROP_RULES = [
  ["非纯 ASCII", (v) => !/^[\x20-\x7e]+$/.test(v)],
  ["含斜杠或空格", (v) => v.includes("/") || v.includes(" ")],
  ["词数 > 4", (v) => v.split(/[^A-Za-z0-9_.\-]+/).length > 4],
  ["版本号形态", (v) => /v?\d+(\.\d+)+/i.test(v)],
];

const words = new Set();
const dropped = [];
const fingerprints = {};
for (const p of paths) {
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    console.error(`WARN: ${p} 不可读，跳过`);
    continue;
  }
  fingerprints[p] = createHash("sha256").update(text).digest("hex");
  const matches = text.match(/`([^`\n]{2,60})`/g) || [];
  for (const m of matches) {
    const v = m.slice(1, -1).trim();
    if (!v) continue;
    const rule = DROP_RULES.find(([, test]) => test(v));
    if (rule !== undefined) {
      dropped.push({ word: v, rule: rule[0] });
      continue;
    }
    words.add(v);
  }
}

const all = [...words];
if (all.length > 300) console.error(`WARN: 反引号符号 ${all.length} 个超上限，仅列前 300（其余以 dropped 不计——超限截断词不在 dropped 内复现）`);
console.log(JSON.stringify({ schemaVersion: 1, sourceFingerprints: fingerprints, words: all.slice(0, 300), dropped }));
