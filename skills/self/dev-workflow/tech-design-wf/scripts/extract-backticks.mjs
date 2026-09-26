#!/usr/bin/env node
// extract-backticks.mjs — T3 符号词表生成器第一步：提取设计文档反引号词（纯机械，零语义）
//
// 提取规则与 design-code-sync-loop 扫描器（NODE_BACKTICK_GREP）逐字同源：
// 反引号内容 /`([^`\n]{2,60})`/g → 纯 ASCII、无 "/" 无空格、词数 ≤4、非版本号，去重，
// 上限 300 防爆。两侧规则必须同步修改——规则漂移 = 词表与扫描器口径不一致，校验恒红。
//
// 用法：node extract-backticks.mjs <设计文档路径> [impl-plan.md 路径 ...]
// 输出：stdout = JSON 字符串数组（去重后的词，按首次出现排序）。
// 本脚本只产草稿——哪些词纳入扫描（scan）、哪些剔除（skip）由 T3 主 agent 对照设计文档
// 语义分析后写入 <basename>.symbol-watchlist.json（见 flow/plan.md「符号词表」节）。

import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("用法：node extract-backticks.mjs <设计文档路径> [impl-plan.md ...]");
  process.exit(1);
}

const words = new Set();
for (const p of paths) {
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    console.error(`WARN: ${p} 不可读，跳过`);
    continue;
  }
  const matches = text.match(/`([^`\n]{2,60})`/g) || [];
  for (const m of matches) {
    const v = m.slice(1, -1).trim();
    if (!v || !/^[\x20-\x7e]+$/.test(v)) continue;
    if (v.includes("/") || v.includes(" ")) continue;
    if (v.split(/[^A-Za-z0-9_.\-]+/).length > 4) continue;
    if (/v?\d+(\.\d+)+/i.test(v)) continue;
    words.add(v);
  }
}

const all = [...words];
if (all.length > 300) console.error(`WARN: 反引号符号 ${all.length} 个超上限，仅列前 300`);
console.log(JSON.stringify(all.slice(0, 300)));
