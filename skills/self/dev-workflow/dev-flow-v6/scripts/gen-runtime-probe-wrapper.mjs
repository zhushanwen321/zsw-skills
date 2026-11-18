#!/usr/bin/env node
// gen-runtime-probe-wrapper.mjs —— dev-flow-v6 D0 runtime probe wrapper 生成器
//（设计《V6 运行可用性与外部契约守门升级》§7.3 D0 末条 + §6.3 probe 要求）。
//
// 为什么有本脚本：runtime-probe 验收行（impl-plan acceptancePlan 的 additive 行类型）
// 必须编译成一个可被引擎直跑的 verify 节点 wrapper——引擎与脚本进程之间只有 script 路径
// 一个通道（node <script> 直跑、无参数、无 per-node env），probe 的 driver 启动命令与
// artifact 落点只能进 wrapper。本脚本把「命令与落点已声明」的行编译为确定性 wrapper：
// 同输入重生成字节一致、文件头带输入哈希、--check 比对防手改（与 gen-acceptance-wrapper
// 同一生成物纪律，设计 §4「确定性编译产物」）。
//
// 边界（设计 §6.3「wrapper 不猜测」）：wrapper 只做三件确定性事——按声明命令 spawn
// driver、把 driver stdout 的 JSON 落为 probe artifact、向引擎产物目录写 summary 行。
// driver 本体由任务实现提供（单文件、无动态 import、driverHash 覆盖全文的契约归 driver
// 与 evaluate 侧重算），wrapper 不推断 driver 语义、不注入 wrapper 自造字段。
//
// 用法：
//   node gen-runtime-probe-wrapper.mjs --assets <probe 资产清单.json> --out <输出目录> [--check]
//   node gen-runtime-probe-wrapper.mjs --help   # 完整清单契约 schema 与退出码约定
//
// 退出码：0 成功（含 --check 全部一致）；1 语义缺口 / 输入非法 / --check 不一致 / 写盘失败；2 用法错误。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_VERSION = 1;
// nodeId 既是输出文件名又嵌入生成代码的字符串字面量——限定安全字符集，防止清单值向
// 生成代码注入引号、反斜杠或路径穿越序列（与 gen-acceptance-wrapper 同款判据）
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// driver 启动命令 program 白名单（与 compile-exec-plan / check-exec-plan 的 TEST_WHITELIST
// 同源）——范围校验在编译期完成，生成器复核防手改清单
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"];
// 恒绿形态三式（与 check-exec-plan NOOP_CMD_* 逐字一致——driver 命令不构成真实探针证据时拒收）
const NOOP_CMD_STUB_RE = /^\s*(true|false|:)\s*$/;
const NOOP_CMD_ECHO_RE = /^\s*(echo|printf)\b/;
const NOOP_CMD_STUB_HEAD_RE = /^\s*(true|false|:|exit)(\s|$)/;
const SHELL_SAFE_ARG_RE = /^[A-Za-z0-9_/:.,@%^+=-]+$/;
// --check 用：从磁盘文件头提取生成时登记的输入哈希，用于区分「手改」与「输入已变化」
const INPUT_HASH_LINE_RE = /^\/\/ 输入哈希（sha256）：([0-9a-f]{64})$/m;

// 键集合白名单：未知字段若静默放行会随条目进输入哈希——改一个没人审的字段就能让 --check
// 报「输入已变化」，契约漂移被掩盖。逐层枚举允许键（与 gen-acceptance-wrapper 同纪律）
const MANIFEST_KEYS = new Set(["schemaVersion", "assets"]);
const ASSET_KEYS = new Set(["nodeId", "capabilityIds", "command", "artifact", "artifactsDir"]);
const COMMAND_KEYS = new Set(["program", "args"]);

const AUTHORITY_MANIFEST = "清单结构以本脚本 --help 输出的「清单契约 schema」为权威（由 compile-exec-plan.mjs acceptance 编译期组装，禁手改）";
const AUTHORITY_COMMAND =
  "driver 启动命令以 impl-plan acceptancePlan 该行 command 声明为权威（{program, args}；" +
  `program 须在白名单 ${TEST_WHITELIST.join("/")} 之内，禁恒绿形态命令——不构成真实探针证据）`;
const AUTHORITY_ARTIFACT =
  "probe artifact 落点以 impl-plan acceptancePlan 该行 artifact 声明为权威（相对交付任务目录的 " +
  "evidence 路径——driver stdout JSON 的落盘处，evaluate 与独立保证消费该文件）";

function usage() {
  return [
    "用法：node gen-runtime-probe-wrapper.mjs --assets <probe 资产清单.json> --out <输出目录> [--check]",
    "  --assets  probe 资产清单（纯 JSON，完整 schema 见 --help；由 D0 acceptance 编译期组装）",
    "  --out     wrapper 输出目录（<taskDir>/evidence/runtime-probes/；文件名 = <nodeId>.mjs）",
    "  --check   不写文件：按当前清单重新生成并与磁盘内容比对，不一致时输出恢复动作并退出非零",
  ].join("\n");
}

function printHelp() {
  console.log(
    [
      usage(),
      "",
      "清单契约 schema（schemaVersion 1，纯 JSON 不带注释）：",
      '  { "schemaVersion": 1,',
      '    "assets": [{',
      '      "nodeId": "<exec-plan acceptance.nodes[].id——字母或数字开头，仅含字母数字与 . _ ->",',
      '      "capabilityIds": ["<契约能力 id：裸能力 id 或 <contractId>:<capabilityId> 限定形态>"],',
      '      "command": { "program": "<driver 启动程序（白名单 pnpm/npm/node/git/bash）>", "args": ["<driver 参数>"] },',
      '      "artifact": "<probe artifact 绝对路径——driver stdout JSON 落盘处>",',
      '      "artifactsDir": "<节点产物目录绝对路径——wrapper 执行时创建，summary.jsonl 落此>" }]',
      "  }",
      "  driver 契约（任务实现侧）：单文件、无动态 import、无运行时生成代码；向 stdout 输出单一 JSON",
      "  （环境 / subject / cases / summary，设计 §6.3），日志一律走 stderr；退出码非 0 = probe 失败。",
      "",
      "退出码：0 成功（含 --check 全部一致）；1 语义缺口 / 输入非法 / --check 不一致 / 写盘失败；2 用法错误。",
    ].join("\n"),
  );
}

function failUsage(message) {
  console.error(`用法错误：${message}\n${usage()}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { assets: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--assets") opts.assets = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--check") opts.check = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else failUsage(`未知参数「${arg ?? ""}」（--help 查看完整用法）`);
  }
  if (!opts.assets || !opts.out) failUsage("缺必填参数：--assets 与 --out 均必填（--help 查看完整用法）");
  return { assetsAbs: resolve(opts.assets), outAbs: resolve(opts.out), check: opts.check };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// 规范 JSON：对象键递归排序后序列化——清单的键书写顺序不改变输入哈希（键序非语义）
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}`;
  }
  return JSON.stringify(value);
}

const isRec = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.trim() !== "";
const isStrArr = (x) => Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");

function shellQuoteArg(s) {
  return SHELL_SAFE_ARG_RE.test(s) ? s : "'" + s.split("'").join("'\\''") + "'";
}

/** 恒绿形态判定：命中返回拒收文案（含恢复动作），未命中返回 null */
function noopCommandError(label, program, args) {
  const full = [program, ...args].map(shellQuoteArg).join(" ");
  const cands = [full, ...args];
  if (program === "bash" || program === "sh") {
    const flagIdx = args.findIndex((a) => /^-[a-z]*c/i.test(a));
    if (flagIdx >= 0) {
      const raw = args[flagIdx + 1];
      if (typeof raw === "string" && raw.length > 0) {
        let cmd = raw;
        if (cmd.length > 1 && (cmd.charCodeAt(0) === 39 || cmd.charCodeAt(0) === 34) && cmd.charCodeAt(cmd.length - 1) === cmd.charCodeAt(0)) {
          cmd = cmd.slice(1, -1);
        }
        cands.push(cmd, ...cmd.split(/;|&&/));
      }
    }
  }
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (NOOP_CMD_STUB_RE.test(c) || (i > args.length && NOOP_CMD_STUB_HEAD_RE.test(c)) || NOOP_CMD_ECHO_RE.test(c)) {
      return `${label} 是恒绿形态命令（${full}）——不构成真实探针证据（恢复：改跑真实 driver；driver 命令形态权威 = impl-plan acceptancePlan 该行 command）`;
    }
  }
  return null;
}

function gap(where, input, authority) {
  return { where, input, authority };
}

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

// 语义缺口不短路：单条资产的多处缺口、多条资产的缺口一次性全部报出（与 gen-acceptance-wrapper
// 同一纪律——报一半等于逼出第二轮返工）
function validateAsset(asset, index, gaps) {
  const nodeId = typeof asset?.nodeId === "string" ? asset.nodeId : null;
  const where = `资产第 ${index + 1} 条${nodeId ? `「${nodeId}」` : ""}`;
  if (asset === null || typeof asset !== "object" || Array.isArray(asset)) {
    gaps.push(gap(where, "清单条目必须是对象", AUTHORITY_MANIFEST));
    return;
  }
  const unknownAssetKeys = extraKeys(asset, ASSET_KEYS);
  if (unknownAssetKeys.length > 0) {
    gaps.push(
      gap(
        where,
        `清单条目含未定义字段：${unknownAssetKeys.join("、")}——未知字段会被静默纳入输入哈希造成契约漂移；新增字段属清单 schema 变更，须随生成器版本升级登记，不在本版本静默放行`,
        AUTHORITY_MANIFEST,
      ),
    );
  }
  if (nodeId === null || nodeId === "" || !NODE_ID_RE.test(nodeId)) {
    gaps.push(
      gap(
        where,
        `nodeId 缺失或形态非法（实际：${JSON.stringify(asset.nodeId ?? null)}）——合法形态 ${NODE_ID_RE.source}（含路径分隔符一律拒绝：文件名 = <nodeId>.mjs，防路径穿越），须与 exec-plan acceptance.nodes[].id 逐字一致`,
        AUTHORITY_MANIFEST,
      ),
    );
  }
  if (!isStrArr(asset.capabilityIds) || asset.capabilityIds.length === 0) {
    gaps.push(
      gap(
        where,
        `capabilityIds 缺失或为空数组（实际：${JSON.stringify(asset.capabilityIds ?? null)}）——probe 观察的契约能力 id 必须显式声明（对账权威 = 验收包 externalContracts capabilities）`,
        AUTHORITY_MANIFEST,
      ),
    );
  }
  const cmd = asset.command;
  if (cmd === null || typeof cmd !== "object" || Array.isArray(cmd)) {
    gaps.push(gap(where, "command 必须是对象 { program, args }（driver 启动命令）", AUTHORITY_COMMAND));
  } else {
    const unknownCmdKeys = extraKeys(cmd, COMMAND_KEYS);
    if (unknownCmdKeys.length > 0) {
      gaps.push(gap(where, `command 含未定义字段：${unknownCmdKeys.join("、")}`, AUTHORITY_COMMAND));
    }
    if (typeof cmd.program !== "string" || cmd.program === "") {
      gaps.push(gap(where, `command.program 缺失或非字符串（实际：${JSON.stringify(cmd.program ?? null)}）`, AUTHORITY_COMMAND));
    } else if (!TEST_WHITELIST.includes(cmd.program)) {
      gaps.push(
        gap(
          where,
          `command.program「${cmd.program}」不在白名单（${TEST_WHITELIST.join("/")}）——driver 启动程序受引擎命令白名单约束（恢复：改用白名单内程序，或整体走 bash -c 封装）`,
          AUTHORITY_COMMAND,
        ),
      );
    }
    if (!Array.isArray(cmd.args) || !cmd.args.every((a) => typeof a === "string")) {
      gaps.push(gap(where, `command.args 必须是字符串数组（实际：${JSON.stringify(cmd.args ?? null)}）`, AUTHORITY_COMMAND));
    } else {
      const noopErr = noopCommandError(`${where} 的 driver 命令`, cmd.program, cmd.args);
      if (noopErr !== null) gaps.push(gap(where, noopErr, AUTHORITY_COMMAND));
    }
  }
  if (typeof asset.artifact !== "string" || asset.artifact === "" || !isAbsolute(asset.artifact)) {
    gaps.push(
      gap(
        where,
        `artifact 缺失或非绝对路径（实际：${JSON.stringify(asset.artifact ?? null)}）——probe artifact 落点由编译期按任务目录相对声明解析为绝对路径`,
        AUTHORITY_ARTIFACT,
      ),
    );
  }
  if (typeof asset.artifactsDir !== "string" || asset.artifactsDir === "" || !isAbsolute(asset.artifactsDir)) {
    gaps.push(
      gap(
        where,
        `artifactsDir 缺失或非绝对路径（实际：${JSON.stringify(asset.artifactsDir ?? null)}）——引擎对 verify 节点强制 exit 0 后该目录存在且从不自建，wrapper 执行时创建`,
        AUTHORITY_MANIFEST,
      ),
    );
  }
}

function loadManifest(assetsAbs, gaps) {
  let raw;
  try {
    raw = readFileSync(assetsAbs);
  } catch (e) {
    gaps.push(gap("清单本身", `probe 资产清单不可读：${assetsAbs}（${e.code ?? e.message}）`, "清单由 D0 acceptance 编译期组装，落 <taskDir>/evidence/runtime-probes/；核对 --assets 路径"));
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    gaps.push(gap("清单本身", `清单不是合法 JSON：${e.message}`, AUTHORITY_MANIFEST));
    return null;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    gaps.push(gap("清单本身", "清单顶层必须是对象", AUTHORITY_MANIFEST));
    return null;
  }
  const unknownManifestKeys = extraKeys(manifest, MANIFEST_KEYS);
  if (unknownManifestKeys.length > 0) {
    gaps.push(
      gap(
        "清单本身",
        `清单顶层含未定义字段：${unknownManifestKeys.join("、")}——未知字段会被静默纳入输入哈希造成契约漂移；新增字段属清单 schema 变更，须随生成器版本升级登记，不在本版本静默放行`,
        AUTHORITY_MANIFEST,
      ),
    );
  }
  if (manifest.schemaVersion !== 1) {
    gaps.push(
      gap(
        "清单本身",
        `schemaVersion 必须是 1（实际：${JSON.stringify(manifest.schemaVersion ?? null)}）——本生成器只实现清单 schemaVersion 1`,
        AUTHORITY_MANIFEST,
      ),
    );
    return null;
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    gaps.push(gap("清单本身", "assets 必须是非空数组——没有可生成的 probe 节点时不应调用本生成器", AUTHORITY_MANIFEST));
    return null;
  }
  return manifest;
}

function buildWrapperText(w) {
  const L = [];
  L.push("// 由 gen-runtime-probe-wrapper.mjs 生成——D3 runtime-probe 验收节点 wrapper（spawn driver 并把 stdout JSON 落为 probe artifact）。");
  L.push("// 仅用于 verify 节点——review 节点的 script 三态语义里 exit 2 = 分析能力不足（派 reviewer），勿配作 machine-check。");
  L.push("// 禁止手改：手改会被 --check 判不一致，且 D0 重编译时被覆盖；语义修订回 impl-plan acceptancePlan 的 runtime-probe 行后重新生成。");
  L.push(`// 输入清单：${w.assetsAbs}`);
  L.push(`// 输入哈希（sha256）：${w.inputHash}`);
  L.push(`// 生成器版本：${GENERATOR_VERSION}`);
  L.push(`// 重新生成：node ${w.generatorAbs} --assets ${w.assetsAbs} --out ${w.outAbs}`);
  L.push("");
  L.push('import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";');
  L.push('import { dirname, join } from "node:path";');
  L.push('import { spawnSync } from "node:child_process";');
  L.push("");
  L.push("// driver 启动命令与 artifact 落点来自 impl-plan 声明，生成期全部写死——引擎与脚本进程之间");
  L.push("// 只有 script 路径一个通道（node <script> 直跑、无参数、无 per-node env，cwd 随节点而变）。");
  L.push(`const artifactsDir = ${JSON.stringify(w.artifactsDir)};`);
  L.push(`const artifactPath = ${JSON.stringify(w.artifact)};`);
  L.push(`const command = ${JSON.stringify(w.command)};`);
  L.push(`const capabilityIds = ${JSON.stringify(w.capabilityIds)};`);
  L.push("");
  L.push("// 引擎对 verify 节点强制 exit 0 后 artifactsDir 存在且从不自建——wrapper 先建目录兜底；");
  L.push("// artifact 落点目录同建（driver 不负责建目录）。");
  L.push("mkdirSync(artifactsDir, { recursive: true });");
  L.push("mkdirSync(dirname(artifactPath), { recursive: true });");
  L.push("");
  L.push("// driver stdout 必须是单一 JSON（日志走 stderr）——探针结果要能被机器判定，");
  L.push("// 只有 passed 布尔或夹带日志文本的 stdout 一律按失败处理（设计 §6.3）。");
  L.push('const run = spawnSync(command.program, command.args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });');
  L.push("const fail = (reason) => {");
  L.push('  appendFileSync(join(artifactsDir, "summary.jsonl"), JSON.stringify({ node: ' + JSON.stringify(w.nodeId) + ', capabilityIds, exitCode: run.status ?? 1, passed: 0, failed: 1, skipped: 0, reason }) + "\\n");');
  L.push('  console.error("[probe wrapper] " + reason);');
  L.push("  process.exit(1);");
  L.push("};");
  L.push("if (run.error) fail(`driver 启动失败：${run.error.message}（命令：${command.program} ${command.args.join(' ')}）——恢复：核对 driver 文件存在与可执行`);");
  L.push("if (run.status !== 0) fail(`driver 退出码非 0（${run.status}）——probe 未跑成；恢复：按 driver stderr 归因后修复并重跑本节点`);");
  L.push("let artifact;");
  L.push("try {");
  L.push('  artifact = JSON.parse(String(run.stdout || ""));');
  L.push("} catch (e) {");
  L.push('  fail(`driver stdout 不是合法 JSON（${e.message}）——probe artifact 必须机器可读；恢复：driver 向 stdout 输出单一 JSON，日志改走 stderr`);');
  L.push("}");
  L.push("if (artifact === null || typeof artifact !== \"object\" || Array.isArray(artifact)) fail(\"driver stdout JSON 必须是对象（环境 / subject / cases / summary，设计 §6.3）——标量或数组形态不是 probe artifact\");");
  L.push("// probe artifact 骨架 = driver stdout 的规范化落盘（wrapper 不注入自造字段、不推断 driver 语义）");
  L.push("writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\\n`);");
  L.push("// summary.jsonl 供汇总 inspect 节点核对（计数取自 artifact.summary；缺 summary 时如实记 unknown，不编 0）");
  L.push("const s = artifact.summary !== null && typeof artifact.summary === \"object\" && !Array.isArray(artifact.summary) ? artifact.summary : null;");
  L.push('const count = (k) => (s !== null && typeof s[k] === "number" ? s[k] : "unknown");');
  L.push('appendFileSync(join(artifactsDir, "summary.jsonl"), JSON.stringify({ node: ' + JSON.stringify(w.nodeId) + ', capabilityIds, exitCode: 0, passed: count("passed"), failed: count("failed"), skipped: count("skipped") }) + "\\n");');
  L.push('console.log(`PASS probe ${capabilityIds.join(",")}`);');
  L.push("process.exit(0);");
  L.push("");
  return L.join("\n");
}

function buildWrapper(asset, assetsAbs, generatorAbs, outAbs) {
  const nodeId = asset.nodeId;
  // 输入哈希覆盖：清单结构（schemaVersion）+ 资产条目 + 生成器版本。命令与落点全在条目内，
  // 无外部引用文件（driver 存在性由编译期核，内容哈希归 driver 契约与 evaluate 侧重算）。
  const inputDescriptor = {
    schemaVersion: 1,
    generatorVersion: GENERATOR_VERSION,
    asset: { ...asset, capabilityIds: [...asset.capabilityIds].sort() },
  };
  const inputHash = sha256(canonicalJson(inputDescriptor));
  const file = join(outAbs, `${nodeId}.mjs`);
  const text = buildWrapperText({
    nodeId,
    capabilityIds: asset.capabilityIds,
    command: { program: asset.command.program, args: [...asset.command.args] },
    artifact: asset.artifact,
    artifactsDir: asset.artifactsDir,
    assetsAbs,
    generatorAbs,
    outAbs,
    inputHash,
  });
  return { wrapper: { nodeId, file, text, inputHash } };
}

function regenerationCommand(generatorAbs, assetsAbs, outAbs) {
  return `node ${generatorAbs} --assets ${assetsAbs} --out ${outAbs}`;
}

// 输出目录中不在清单内的 *.mjs = 陈旧 wrapper（节点已从清单移除但落点残留）。生成模式清掉；
// --check 列为不一致（磁盘状态 ≠ 重生成后的状态）。与 gen-acceptance-wrapper 同纪律
function listOrphanWrappers(outAbs, knownNodeIds) {
  if (!existsSync(outAbs)) return [];
  let entries;
  try {
    entries = readdirSync(outAbs);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".mjs") && !knownNodeIds.has(name.slice(0, -".mjs".length)))
    .sort()
    .map((name) => join(outAbs, name));
}

function printGaps(gaps, opts) {
  const regen = regenerationCommand(fileURLToPath(import.meta.url), opts.assetsAbs, opts.outAbs);
  const out = [
    `语义缺口报告：生成中止，未写任何文件（共 ${gaps.length} 条）——driver 命令、能力 id 或落点不明确时禁止猜（设计 §6.3「wrapper 不猜测」）`,
  ];
  gaps.forEach((g, i) => {
    out.push("", `缺口 ${i + 1}：${g.where}`, `  不合法输入：${g.input}`, `  权威源：${g.authority}`, `  恢复动作：修正输入后重新运行：${regen}`);
  });
  console.error(out.join("\n"));
}

function runGenerate(wrappers, orphans, opts) {
  const regen = regenerationCommand(fileURLToPath(import.meta.url), opts.assetsAbs, opts.outAbs);
  const failures = [];
  const written = [];
  let dirReady = false;
  try {
    mkdirSync(opts.outAbs, { recursive: true });
    dirReady = true;
  } catch (e) {
    failures.push({ file: opts.outAbs, reason: `输出目录创建失败：${e.code ?? e.message}` });
  }
  // 写盘逐个收集不短路：一次报完所有 IO 故障，主 agent 一轮处理完，不逼出多轮返工
  if (dirReady) {
    for (const w of wrappers) {
      try {
        writeFileSync(w.file, w.text);
        written.push(w.file);
      } catch (e) {
        failures.push({ file: w.file, reason: `写入失败：${e.code ?? e.message}` });
      }
    }
    for (const orphan of orphans) {
      try {
        rmSync(orphan);
      } catch (e) {
        failures.push({ file: orphan, reason: `陈旧 wrapper 清理失败：${e.code ?? e.message}` });
      }
    }
  }
  if (failures.length > 0) {
    const out = [`FAIL：${failures.length} 项写盘未完成（成功 ${written.length} 项）——校验已全部通过，属文件系统层故障`];
    failures.forEach((f, i) => {
      out.push("", `[${i + 1}] ${f.file}`, `  不合法输入：${f.reason}`, `  权威源：${opts.assetsAbs}（probe 资产清单——排除文件系统故障后重新运行，生成幂等覆盖）`, `  重新生成：${regen}`);
    });
    console.error(out.join("\n"));
    process.exit(1);
  }
  console.log(`已生成 ${wrappers.length} 个 D3 runtime-probe wrapper → ${opts.outAbs}`);
  for (const w of wrappers) console.log(`  ${w.nodeId} → ${w.file}`);
  const cleaned = orphans;
  if (cleaned.length > 0) console.log(`已清理 ${cleaned.length} 个陈旧 wrapper（清单已不含）：\n  ${cleaned.join("\n  ")}`);
  console.log(`防手改核对：${regen} --check`);
}

function runCheck(wrappers, orphans, opts) {
  const failures = [];
  for (const w of wrappers) {
    if (!existsSync(w.file)) {
      failures.push({ file: w.file, reason: "wrapper 文件缺失" });
      continue;
    }
    const disk = readFileSync(w.file, "utf8");
    if (disk === w.text) continue;
    const registered = disk.match(INPUT_HASH_LINE_RE)?.[1] ?? null;
    let reason;
    if (registered === null) {
      reason = "文件缺少输入哈希头——被整文件改写或不是本生成器的产物";
    } else if (registered !== w.inputHash) {
      reason = `输入已变化：文件头登记哈希 ${registered} ≠ 按当前输入重算的 ${w.inputHash}——清单条目或生成器版本在生成后发生过变化`;
    } else {
      reason = "文件被手改：输入哈希一致但内容与重新生成结果不一致";
    }
    failures.push({ file: w.file, reason });
  }
  for (const orphan of orphans) {
    failures.push({ file: orphan, reason: "孤立 wrapper：输出目录残留清单已不含的落点（重新生成会清理）" });
  }
  if (failures.length > 0) {
    const regen = regenerationCommand(fileURLToPath(import.meta.url), opts.assetsAbs, opts.outAbs);
    const out = [`FAIL：${failures.length}/${wrappers.length + orphans.length} 项与重新生成结果不一致`];
    failures.forEach((f, i) => {
      out.push("", `[${i + 1}] ${f.file}`, `  不合法输入：${f.reason}`, `  权威源：${opts.assetsAbs}（probe 资产清单——语义修订回上游 impl-plan 行，不手改生成文件）`, `  重新生成：${regen}`);
    });
    console.error(out.join("\n"));
    process.exit(1);
  }
  console.log(`PASS：${wrappers.length} 个 runtime-probe wrapper 与重新生成结果一致（清单 ${opts.assetsAbs}）`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gaps = [];
  const manifest = loadManifest(opts.assetsAbs, gaps);
  if (manifest !== null) {
    const seen = new Map();
    manifest.assets.forEach((asset, index) => {
      validateAsset(asset, index, gaps);
      if (typeof asset?.nodeId === "string" && NODE_ID_RE.test(asset.nodeId)) {
        // nodeId 即输出文件名，重复声明会互相覆盖——按契约含糊处理，不替清单消歧
        if (seen.has(asset.nodeId)) {
          gaps.push(gap(`资产第 ${index + 1} 条「${asset.nodeId}」`, `nodeId 与第 ${seen.get(asset.nodeId) + 1} 条重复——文件名 = <nodeId>.mjs，重复会互相覆盖`, AUTHORITY_MANIFEST));
        } else {
          seen.set(asset.nodeId, index);
        }
      }
    });
  }
  if (gaps.length > 0) {
    printGaps(gaps, opts);
    process.exit(1);
  }
  const generatorAbs = fileURLToPath(import.meta.url);
  const wrappers = [];
  for (const asset of manifest.assets) {
    wrappers.push(buildWrapper(asset, opts.assetsAbs, generatorAbs, opts.outAbs).wrapper);
  }
  const knownNodeIds = new Set(wrappers.map((w) => w.nodeId));
  const orphans = listOrphanWrappers(opts.outAbs, knownNodeIds);
  if (opts.check) runCheck(wrappers, orphans, opts);
  else runGenerate(wrappers, orphans, opts);
}

main();
