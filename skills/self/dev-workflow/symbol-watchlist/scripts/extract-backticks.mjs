#!/usr/bin/env node
// extract-backticks.mjs — T3 符号词表生成器第一步：提取设计文档反引号词（纯机械，零语义）
//
// 提取规则与 design-code-sync-loop 扫描器（NODE_BACKTICK_GREP）逐字同源：
// 反引号内容 /`([^`\n]{2,60})`/g → 纯 ASCII、无 "/" 无空格、词数 ≤4、非版本号，去重，
// 上限 300 防爆。两侧规则必须同步修改——规则漂移 = 词表与扫描器口径不一致，校验恒红。
//
// 输出（2026-11-04 结构化改造；2026-11-07 sourceFingerprints 键形态归一为绝对路径）：
//   { schemaVersion: 1,
//     sourceFingerprints: { 归一为绝对路径的输入路径: sha256 },   ← 词表甄别时抄进 watchlist，
//                                                      键形态不得改动；下游 W4 setup 按指纹
//                                                      校验「文档改了词表没重生成」（替代旧
//                                                      反引号等集）
//     words: [...],                                 ← 提取词（按首次出现排序，≤300）
//     dropped: [{ word, rule }] }                   ← 被过滤词与剔除规则——漏报可审计
//                                                      （旧静默过滤 = 下游扫描盲区无告警通道）
//
// 键形态归一：输入路径任意形态（相对 / ~/ 开头 / 绝对）均归一为绝对路径——~/ 前缀按
// HOME 展开，其余 path.resolve()。归一结果同时用作读取路径与指纹键。禁止原样透传入参
// 形态作键：下游 setup 引擎对键做 fs.readFileSync 直读，相对或 ~/ 形态的键 ENOENT。
//
// 任一输入不可读即 exit 1（不做跳过降级）——词表须覆盖全部输入，缺一份 = 指纹校验失真。
//
// 用法：
//   node extract-backticks.mjs <设计文档路径> [impl-plan.md 路径 ...]   （T3 产草稿）
//   node extract-backticks.mjs --check <watchlist.json 路径>           （design-code-sync 发起前自验）
//
// --check 自验模式：对落盘词表跑 8 类校验（词表不可读或非合法 JSON / 词表内容非 JSON
// 对象（顶层 null 或标量）/ 缺 scan 数组或 skip 数组 / skip 元素畸形 / 缺 sourceFingerprints /
// 指纹值形态畸形（须 64 位 sha256 hex）/ 指纹键不可读 / 指纹不等），全部通过 stdout
// 输出 PASS 并 exit 0；任一失败 stdout 输出 `FAIL: <分类名>: <明细>` 并 exit 1。
// 同源纪律：--check 的校验集与 design-code-sync-loop NODE_BACKTICK_GREP 探针同源——两侧必须
// 同步修改；scripts/tests/ 下的差分测试保证不漂移。指纹键判定与探针逐字一致：非 / 开头直接
// 判不可读（不尝试读），其余不展开波浪号、不拼接基目录、fs.readFileSync 原样直读。
//
// 本脚本只产草稿——哪些词纳入扫描（scan）、哪些剔除（skip）由 T3 主 agent 对照设计文档
// 语义分析后写入 <basename>.symbol-watchlist.json（见 tech-design-wf flow/plan.md「符号词表」节）。
// 本脚本现属 symbol-watchlist skill（词表协议的共享契约载体，生成流程在 tech-design-wf T3、
// 发起前自验在 dev-flow-wf D5）；传参形态不限——相对 / ~/ / 绝对均归一为绝对路径键。

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

// 输入路径归一：~/ 前缀按 HOME 展开 → path.resolve 为绝对路径。
// 归一结果同时用于读取与作键——只归一键不归一读取，~/ 输入仍会因相对读取失败被丢弃。
function normalizeInputPath(p) {
  if (p === "~") return resolve(homedir());
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

// ── --check 自验模式（校验集与 NODE_BACKTICK_GREP 探针同源，逐类对应其 ok:false 路径）──
function runCheck(wlPath) {
  const fail = (category, detail) => {
    console.log(`FAIL: ${category}: ${detail}`);
    process.exit(1);
  };
  let raw;
  try {
    raw = readFileSync(wlPath, "utf8");
  } catch (e) {
    return fail("词表不可读或非合法 JSON", `${wlPath}（读取失败${e && e.code ? " " + e.code : ""}）`);
  }
  let wl;
  try {
    wl = JSON.parse(raw);
  } catch (e) {
    return fail("词表不可读或非合法 JSON", `${wlPath}（JSON 解析失败: ${e.message}）`);
  }
  // 探针同款检查（判定两侧等价）：JSON.parse 成功 ≠ 拿到对象——顶层 null/标量在探针侧
  // 若直接取 wlRaw.scan，null 会抛 TypeError（探针崩溃 exit 1 空输出，上游只能看到空
  // stdout，与「node 不可用」混淆），故探针在 scan/skip 判定前先行拒收；本侧同判据同分类。
  // 数组顶层两侧同归「缺 scan 数组或 skip 数组」（属性访问取不到 scan）
  if (wl === null || typeof wl !== "object") {
    return fail(
      "词表内容非 JSON 对象",
      `${wlPath}（顶层为 null 或标量——词表须为含 scan/skip/sourceFingerprints 的对象；词表内容损坏手修不可靠，回 tech-design-wf T3 重新生成词表）`,
    );
  }
  const scanBad = !Array.isArray(wl.scan);
  const skipBad = !Array.isArray(wl.skip);
  if (scanBad || skipBad) {
    const parts = [scanBad ? "scan 非数组或缺失" : null, skipBad ? "skip 非数组或缺失" : null].filter(Boolean);
    return fail("缺 scan 数组或 skip 数组", `${wlPath}（${parts.join("；")}）`);
  }
  // scan 元素畸形探针侧是静默过滤（filter 非 string/空串）——与探针一致，此处不做校验
  const badSkipIdx = [];
  wl.skip.forEach((s, i) => {
    if (!s || typeof s.word !== "string" || s.word === "" || typeof s.reason !== "string" || s.reason.trim() === "") badSkipIdx.push(i);
  });
  if (badSkipIdx.length > 0) {
    // 明细构造须对非对象元素（JSON 侧可达形态：null / 数字 / 字符串）先检查再取值——直接解引用
    // .word 会在 exit 前抛 TypeError，stdout 空输出违反 FAIL 契约，sync.md 分类路由失据
    const items = badSkipIdx
      .map((i) => {
        const s = wl.skip[i];
        if (s === null) return `元素 #${i}: null`;
        if (typeof s !== "object" || typeof s.word !== "string" || s.word === "") return `元素 #${i}`;
        return `"${s.word}"`;
      })
      .join("、");
    return fail("skip 元素畸形", `共 ${badSkipIdx.length} 条（须 {word 非空, reason 非空}）：${items}`);
  }
  const fps = wl.sourceFingerprints;
  if (fps === null || typeof fps !== "object" || Array.isArray(fps) || Object.keys(fps).length === 0) {
    return fail("缺 sourceFingerprints", `${wlPath}（字段缺失或空对象——旧版生成器产物或手写词表，回 tech-design-wf T3 重新生成词表）`);
  }
  // 指纹键判定与探针逐字一致：键形态判定同步（非 / 开头的相对或 ~/ 形态键直接判不可读，
  // 不尝试读——否则相对键恰在运行 cwd 下存在且指纹正确时本侧会 PASS 而探针 ok:false，
  // 自验闭环断裂：探针指路「--check 必须 PASS」、照做通过但 workflow 照样拒启）；其余键
  // 不展开波浪号、不拼接基目录、fs.readFileSync 原样直读。FAIL 判定与探针 ok:false 等价。
  // 值形态判定与探针逐字一致：非 64 位 sha256 hex 字符串的值先归「指纹值形态畸形」（这种
  // 值直接进 sha256 比对恒不等，会被误归「指纹不等/源文档已改」引去重跑文档侧流程），
  // 不参与比对。
  const unreadable = [];
  const mismatched = [];
  const badShape = [];
  for (const key of Object.keys(fps)) {
    if (!key.startsWith("/")) {
      unreadable.push(key === "" ? '""' : key);
      continue;
    }
    const v = fps[key];
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) {
      badShape.push(key);
      continue;
    }
    try {
      const cur = createHash("sha256").update(readFileSync(key, "utf8")).digest("hex");
      if (cur !== v) mismatched.push(key);
    } catch {
      unreadable.push(key);
    }
  }
  // 三类可同时成立（探针侧合并为一个 ok:false，段序 = 畸形 → 不可读 → 过期），全部 FAIL
  // 行都要输出完再退出，不得在第一类就 process.exit 漏报其余类
  let hasFpFail = false;
  if (badShape.length > 0) {
    hasFpFail = true;
    console.log(`FAIL: 指纹值形态畸形: ${badShape.join("、")}（须 64 位 sha256 hex 字符串——词表内容损坏手修不可靠，回 tech-design-wf T3 重新生成词表）`);
  }
  if (unreadable.length > 0) {
    hasFpFail = true;
    console.log(`FAIL: 指纹键不可读: ${unreadable.join("、")}（键须为下游可直读的绝对路径——回 T3 重产词表，传参形态不限、键一律归一为绝对）`);
  }
  if (mismatched.length > 0) {
    hasFpFail = true;
    console.log(`FAIL: 指纹不等: ${mismatched.join("、")}——源文档已改而词表未重生成，回 tech-design-wf T3 重跑（脚本+甄别）`);
  }
  if (hasFpFail) process.exit(1);
  console.log("PASS");
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv[0] === "--check") {
  if (argv.length !== 2) {
    console.error("用法：node extract-backticks.mjs --check <watchlist.json 路径>");
    process.exit(1);
  }
  runCheck(argv[1]);
}

const paths = argv;
if (paths.length === 0) {
  console.error("用法：node extract-backticks.mjs <设计文档路径> [impl-plan.md ...]");
  console.error("自验：node extract-backticks.mjs --check <watchlist.json 路径>");
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
  const abs = normalizeInputPath(p);
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    console.error(`输入不可读: ${abs}（入参「${p}」归一后）——词表须覆盖全部输入，不跳过；请核对路径后重跑`);
    process.exit(1);
  }
  fingerprints[abs] = createHash("sha256").update(text).digest("hex");
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

// 输出前自验：键数 == 入参数（不同形态入参归一后同指一文件会撞键），且每个键可再复读
// ——键必须全部是下游可直接读取的绝对路径，任一不满足宁可不出结果，禁止带病输出。
const keys = Object.keys(fingerprints);
if (keys.length !== paths.length) {
  console.error(
    `自验失败: 入参 ${paths.length} 个，产出指纹键 ${keys.length} 个——存在归一后重复的入参` +
      `（相对 / ~/ / 绝对形态同指一文件会撞键），请去重后重跑`,
  );
  process.exit(1);
}
for (const k of keys) {
  try {
    readFileSync(k);
  } catch {
    console.error(`自验失败: 指纹键 ${k} 不可复读——键须为下游 setup 可直接读取的绝对路径`);
    process.exit(1);
  }
}

const all = [...words];
if (all.length > 300) console.error(`WARN: 反引号符号 ${all.length} 个超上限，仅列前 300（其余以 dropped 不计——超限截断词不在 dropped 内复现）`);
console.log(JSON.stringify({ schemaVersion: 1, sourceFingerprints: fingerprints, words: all.slice(0, 300), dropped }));
