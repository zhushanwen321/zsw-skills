#!/usr/bin/env node
// gen-acceptance-wrapper.mjs —— dev-flow-v6 D0 验收 wrapper 生成器
//（设计《V5 三技能结构化交付优化》首切片：已有资产的 D3 wrapper 生成器）。
//
// 为什么有本脚本：compile.md §7 的 verify 节点 wrapper（L3 剧本经项目 verification skill
// runner 加载的桥接文件）现行由主 agent 在 D0 逐节点手写——同一调用契约被反复手工转抄，
// 且无防手改与输入失效手段。本脚本把「已存在、runner 调用契约可机器读取」的资产编译为
// 确定性 wrapper：同输入重生成字节一致、文件头带输入哈希、--check 比对防手改
//（设计 §4「确定性编译产物」/ §7.3「D0 已知答案样例」/ §7.4「生成物防手改检查」）。
//
// 边界（设计 §6.3 第 3 条）：wrapper 只处理已知 runner 契约（compile.md §7 点名的四旗）。
// runner 程序、参数或支持 flags 不明确时输出「语义缺口」报告并退出非零——禁止猜参数，
// 也不建立通用 runner 描述语言。生成器只核资产存在性与契约形态，「当次跑通」凭据仍由
// compile.md §7 剧本实装硬门槛（D0 前实跑 exit 0）承载，不在清单中登记 provenance。
//
// 用法：
//   node gen-acceptance-wrapper.mjs --assets <验收资产清单.json> --out <输出目录> [--check]
//   node gen-acceptance-wrapper.mjs --help   # 完整清单契约 schema 与退出码约定
//
// 退出码：0 成功（含 --check 全部一致）；1 语义缺口 / 输入非法 / --check 不一致；2 用法错误。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_VERSION = 1;
// compile.md §7 wrapper 形态点名的四旗——本生成器只建模这一组；清单声明其余 flag 即语义缺口
//（不建通用 runner 描述语言，设计 §6.3 第 3 条）。
const KNOWN_FLAGS = ["--repo", "--artifacts-dir", "--name", "--run-id"];
// 四旗输出顺序固定为 compile.md §7 点名顺序——生成文本与清单内 flags 书写顺序无关，比对更稳。
const FLAG_EMIT_ORDER = KNOWN_FLAGS;
// nodeId 既是输出文件名又嵌入 --name / --run-id 的字符串字面量——限定安全字符集，
// 防止清单值向生成代码注入引号、反斜杠或路径穿越序列。
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// wrapper 以 process.execPath（node）spawn runner，runner 必须是 node 脚本；.sh 等其他
// 解释器形态不经 wrapper（引擎按扩展名分派，bash 通道走 compile.md 既有路径）。
const RUNNER_EXTS = new Set([".mjs", ".js", ".cjs"]);
// --check 用：从磁盘文件头提取生成时登记的输入哈希，用于区分「手改」与「输入已变化」。
const INPUT_HASH_LINE_RE = /^\/\/ 输入哈希（sha256）：([0-9a-f]{64})$/m;

// 键集合白名单：未知字段若静默放行会随条目进输入哈希——改一个没人审的字段就能让 --check
// 报「输入已变化」，契约漂移被掩盖。逐层枚举允许键；新增字段属 schema 变更，须随生成器版本走。
const MANIFEST_KEYS = new Set(["schemaVersion", "projectRoot", "assets"]);
const ASSET_KEYS = new Set(["nodeId", "runner", "scenario", "artifactsDir"]);
const RUNNER_KEYS = new Set(["path", "flags"]);
const SCENARIO_KEYS = new Set(["path"]);

const AUTHORITY_MANIFEST = "清单结构以本脚本 --help 输出的「清单契约 schema」为权威";
const AUTHORITY_RUNNER_CONTRACT =
  "runner 调用契约以项目 verification skill 的 API 契约文档 / 项目 AGENTS.md 为权威——" +
  `把实际支持的 flags 显式写进清单（仅四旗之内：${KNOWN_FLAGS.join(" ")}；` +
  "runner 除剧本位置参数外不收 flag 则写空数组）";
// wrapper 全参数写死绝对路径的原因：引擎以 node <script> 直跑 wrapper（无参数、无 per-node
// env），cwd 随节点而变（worktree 单元 cwd ≠ projectRoot），相对路径会在别的 cwd 下失效。
const AUTHORITY_PATH =
  "路径形态以 exec-plan 契约为权威（compile.md §7：wrapper 参数全部写死绝对路径——" +
  "引擎以 node <script> 直跑 wrapper，cwd 随节点而变，相对路径会失效）";

function usage() {
  return [
    "用法：node gen-acceptance-wrapper.mjs --assets <验收资产清单.json> --out <输出目录> [--check]",
    "  --assets  验收资产清单（纯 JSON，完整 schema 见 --help）；清单与其引用的 runner / 剧本文件须已存在",
    "  --out     wrapper 输出目录（exec-plan 同目录 <name>.verify/；文件名 = <nodeId>.mjs）",
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
      '    "projectRoot": "<项目根绝对路径>",',
      '    "assets": [{',
      '      "nodeId": "<exec-plan acceptance.nodes[].id——字母或数字开头，仅含字母数字与 . _ ->",',
      '      "runner": { "path": "<runner 绝对路径（.mjs / .js / .cjs）>", "flags": ["--repo", "--artifacts-dir", "--name", "--run-id"] },',
      '      "scenario": { "path": "<剧本绝对路径>" },',
      '      "artifactsDir": "<节点产物目录绝对路径——wrapper 执行时创建>" }]',
      "  }",
      "  flags 为显式声明、逐字为准：空数组 = runner 除剧本位置参数外不收 flag；缺失或含",
      "  四旗之外的 flag = 语义缺口不生成（禁止猜参数）。输出文件名 = <nodeId>.mjs。",
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

function fileSha256(path) {
  return sha256(readFileSync(path));
}

// 读取内容哈希；校验通过后文件仍可能被并发删除 / 权限变化（TOCTOU）——包一层落结构化
// 缺口报告，不裸抛栈轨迹（错误消息必须可操作）。
function tryFileSha256(path) {
  try {
    return { hash: fileSha256(path) };
  } catch (e) {
    return { error: `${path}（${e.code ?? e.message}）` };
  }
}

// 规范 JSON：对象键递归排序后序列化——清单的键书写顺序不改变输入哈希（键序非语义）；
// 数组保留书写序（flags 的顺序归一在构造 descriptor 时单独做：输出顺序固定，书写序非语义）。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isReadableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isReadableDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function gap(where, input, authority) {
  return { where, input, authority };
}

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

// 语义缺口不短路：单条资产的多处缺口、多条资产的缺口一次性全部报出——
// 主 agent 按设计 §6.3 第 4 条只处理一轮编译器报告，报一半等于逼出第二轮返工。
function validateAsset(asset, index, manifest, gaps) {
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
        `清单条目含未定义字段：${unknownAssetKeys.join("、")}——未知字段会被静默纳入输入哈希造成契约漂移；` +
          "新增字段属清单 schema 变更，须随生成器版本升级登记，不在本版本静默放行",
        AUTHORITY_MANIFEST,
      ),
    );
  }
  if (nodeId === null || nodeId === "" || !NODE_ID_RE.test(nodeId)) {
    gaps.push(
      gap(
        where,
        `nodeId 缺失或形态非法（实际：${JSON.stringify(asset.nodeId ?? null)}）——` +
          `合法形态 ${NODE_ID_RE.source}（含路径分隔符一律拒绝：文件名 = <nodeId>.mjs，防路径穿越），` +
          "须与 exec-plan acceptance.nodes[].id 逐字一致",
        AUTHORITY_MANIFEST,
      ),
    );
  }

  const runner = asset.runner;
  if (runner === null || typeof runner !== "object" || Array.isArray(runner)) {
    gaps.push(gap(where, "runner 必须是对象 { path, flags }", AUTHORITY_RUNNER_CONTRACT));
  } else {
    const unknownRunnerKeys = extraKeys(runner, RUNNER_KEYS);
    if (unknownRunnerKeys.length > 0) {
      gaps.push(gap(where, `runner 含未定义字段：${unknownRunnerKeys.join("、")}`, AUTHORITY_MANIFEST));
    }
    if (typeof runner.path !== "string" || runner.path === "" || !isAbsolute(runner.path)) {
      gaps.push(gap(where, `runner.path 缺失或非绝对路径（实际：${JSON.stringify(runner.path ?? null)}）`, AUTHORITY_PATH));
    } else {
      if (!isReadableFile(runner.path)) {
        gaps.push(
          gap(
            where,
            `runner.path 指向的文件不存在或不可读：${runner.path}` +
              "（只生成已存在且当次可用的资产——设计 §6.3 第 2 条；新资产由开发单元完成后才生成验收产物）",
            "runner 以项目 verification skill 的安装形态为权威（T3 verifyAsset=reuse 已核其真实存在）；核对路径拼写，或等 runner 所在能力就绪后再生成",
          ),
        );
      } else if (!RUNNER_EXTS.has(extname(runner.path))) {
        gaps.push(
          gap(
            where,
            `runner 必须是 node 脚本（.mjs / .js / .cjs），实际扩展名不受支持：${runner.path}` +
              "——wrapper 以 node 直跑 runner；bash 等其他解释器形态不经 wrapper，走 compile.md 既有通道",
            AUTHORITY_RUNNER_CONTRACT,
          ),
        );
      }
    }
    if (!("flags" in runner) || runner.flags === undefined || runner.flags === null) {
      gaps.push(
        gap(
          where,
          "runner.flags 未显式声明——runner 支持哪些 flags 不明确，禁止猜参数（设计 §6.3 第 3 条）",
          AUTHORITY_RUNNER_CONTRACT,
        ),
      );
    } else if (!Array.isArray(runner.flags)) {
      gaps.push(gap(where, `runner.flags 必须是数组（实际：${JSON.stringify(runner.flags)}）`, AUTHORITY_RUNNER_CONTRACT));
    } else {
      for (const flag of runner.flags) {
        if (typeof flag !== "string" || flag === "") {
          gaps.push(gap(where, `runner.flags 含非字符串条目（实际：${JSON.stringify(flag)}）`, AUTHORITY_RUNNER_CONTRACT));
        } else if (!KNOWN_FLAGS.includes(flag)) {
          gaps.push(
            gap(
              where,
              `runner.flags 声明了本生成器未建模的 flag「${flag}」——生成器只实现 compile.md §7 点名的四旗` +
                `（${KNOWN_FLAGS.join(" ")}），不建通用 runner 描述语言，禁止猜参数`,
              AUTHORITY_RUNNER_CONTRACT,
            ),
          );
        }
      }
      const dups = runner.flags.filter((f, i) => runner.flags.indexOf(f) !== i);
      if (dups.length > 0) {
        gaps.push(gap(where, `runner.flags 含重复声明：${[...new Set(dups)].join(" ")}——重复即契约含糊`, AUTHORITY_RUNNER_CONTRACT));
      }
    }
  }

  const scenario = asset.scenario;
  const scenarioPath = scenario?.path;
  if (scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)) {
    const unknownScenarioKeys = extraKeys(scenario, SCENARIO_KEYS);
    if (unknownScenarioKeys.length > 0) {
      gaps.push(gap(where, `scenario 含未定义字段：${unknownScenarioKeys.join("、")}`, AUTHORITY_MANIFEST));
    }
  }
  if (typeof scenarioPath !== "string" || scenarioPath === "" || !isAbsolute(scenarioPath)) {
    gaps.push(gap(where, `scenario.path 缺失或非绝对路径（实际：${JSON.stringify(scenarioPath ?? null)}）`, AUTHORITY_PATH));
  } else if (!isReadableFile(scenarioPath)) {
    gaps.push(
      gap(
        where,
        `scenario.path 指向的剧本不存在或不可读：${scenarioPath}` +
          "（剧本本体须已在 D0 前实装并对样本数据实跑通过——compile.md §7「剧本实装硬门槛」）",
        "剧本以项目 verification skill 场景库 / impl-plan verifyAsset 登记为权威；先完成剧本实装再生成 wrapper",
      ),
    );
  }

  // artifactsDir 无条件必填：引擎对 verify 节点强制「exit 0 后 artifactsDir 存在」且从不自建
  //（wave-executor-v6 executeVerifyNode）——wrapper 在 spawn 前兜底创建它，与 flags 声明无关
  //（flags 未声明 --artifacts-dir 时 runner 收不到该路径，目录只能由 wrapper 创建）。
  const artifactsDir = asset.artifactsDir;
  if (typeof artifactsDir !== "string" || artifactsDir === "" || !isAbsolute(artifactsDir)) {
    gaps.push(
      gap(
        where,
        `artifactsDir 缺失或非绝对路径（实际：${JSON.stringify(artifactsDir ?? null)}；` +
          "产物目录在执行期由 wrapper 创建，生成期只核形态）",
        AUTHORITY_PATH,
      ),
    );
  }
}

function loadManifest(assetsAbs, gaps) {
  let raw;
  try {
    raw = readFileSync(assetsAbs);
  } catch (e) {
    gaps.push(
      gap(
        "清单本身",
        `验收资产清单不可读：${assetsAbs}（${e.code ?? e.message}）`,
        "清单由 D0 编译期准备，落 dev-flow 段产物根；核对 --assets 路径",
      ),
    );
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
        `清单顶层含未定义字段：${unknownManifestKeys.join("、")}——未知字段会被静默纳入输入哈希造成契约漂移；` +
          "新增字段属清单 schema 变更，须随生成器版本升级登记，不在本版本静默放行",
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
    // schemaVersion 不认识就不再往下读——用未知结构继续生成会产出误导性产物。
    return null;
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    gaps.push(gap("清单本身", "assets 必须是非空数组——没有可生成的资产时不应调用本生成器", AUTHORITY_MANIFEST));
    return null;
  }
  return manifest;
}

function buildWrapperText(w) {
  const L = [];
  L.push("// 由 gen-acceptance-wrapper.mjs 生成——D3 verify 节点 wrapper（L3 预编译剧本 runner 脚本）。");
  // 使用边界随产物走：引擎对 review 节点 script 的三态语义里 exit 2 = 分析能力不足（派
  // reviewer），verify 剧本把 exit 2 当普通失败透传——同一文件两种节点语义不同，勿混配。
  L.push("// 仅用于 verify 节点——review 节点的 script 三态语义里 exit 2 = 分析能力不足（派 reviewer），勿配作 machine-check。");
  L.push("// 禁止手改：手改会被 --check 判不一致，且 D0 重编译时被覆盖；语义修订回上游验收清单后重新生成。");
  L.push(`// 输入清单：${w.assetsAbs}`);
  L.push(`// 输入哈希（sha256）：${w.inputHash}`);
  L.push(`// 生成器版本：${GENERATOR_VERSION}`);
  L.push(`// 重新生成：node ${w.generatorAbs} --assets ${w.assetsAbs} --out ${w.outAbs}`);
  L.push("");
  L.push('import { mkdirSync } from "node:fs";');
  L.push('import { spawnSync } from "node:child_process";');
  L.push("");
  L.push("// runner 调用契约来自验收清单的显式声明，参数生成期全部写死——引擎与剧本进程之间只有 script 路径一个通道");
  L.push("//（node <script> 直跑、无参数、无 per-node env），runner 参数只能进本文件（compile.md §7）。");
  L.push(`const artifactsDir = ${JSON.stringify(w.artifactsDir)};`);
  L.push("const args = [");
  L.push(`  ${JSON.stringify(w.runnerPath)},`);
  L.push(`  ${JSON.stringify(w.scenarioPath)},`);
  L.push("];");
  for (const flag of FLAG_EMIT_ORDER) {
    if (!w.flags.includes(flag)) continue;
    if (flag === "--repo") {
      L.push(`args.push("--repo", ${JSON.stringify(w.projectRoot)});`);
    } else if (flag === "--artifacts-dir") {
      L.push('args.push("--artifacts-dir", artifactsDir);');
    } else if (flag === "--name") {
      L.push(`args.push("--name", ${JSON.stringify(`verify-${w.nodeId}`)});`);
    } else if (flag === "--run-id") {
      // 下面两行注释进生成文本（不是生成器源码注释）：告诉读 wrapper 的人为什么 run-id 要现算。
      L.push("// --run-id 隔离值在 wrapper 执行时现算——runner 默认 runId 是秒级时间戳，同秒并发会共享");
      L.push("// 数据目录；时间戳属运行时值，不写进生成文本（同输入重新生成须字节一致，设计 §4 第 1 条）。");
      L.push(`args.push("--run-id", ${JSON.stringify(w.nodeId)} + "-" + Date.now().toString(10));`);
    }
  }
  L.push("");
  // 引擎对 verify 节点强制「exit 0 后 artifactsDir 存在」且从不自建——flags 未声明
  // --artifacts-dir 时 runner 收不到该路径，目录只能由 wrapper 兜底创建（已存在时幂等无害）。
  L.push("// 引擎对 verify 节点强制 exit 0 后 artifactsDir 存在且从不自建——wrapper 先建目录兜底：");
  L.push("// flags 未声明 --artifacts-dir 时 runner 收不到该路径，目录只能由 wrapper 创建（已存在时幂等无害）。");
  L.push("mkdirSync(artifactsDir, { recursive: true });");
  L.push("");
  L.push('const run = spawnSync(process.execPath, args, { stdio: "inherit" });');
  L.push("if (run.error) {");
  // runner 路径以独立字符串字面量拼接（不能嵌进外层字符串字面量内部——内嵌引号会产出非法 JS）。
  L.push(`  console.error("[verify wrapper] runner 启动失败：" + run.error.message + "（runner：" + ${JSON.stringify(w.runnerPath)} + "）");`);
  L.push("}");
  L.push("process.exit(run.status ?? 1);");
  L.push("");
  return L.join("\n");
}

function buildWrapper(manifest, asset, assetsAbs, generatorAbs, outAbs) {
  const nodeId = asset.nodeId;
  // 输入哈希覆盖：清单结构（schemaVersion + projectRoot）+ 资产条目 + runner / 剧本内容哈希
  // + 生成器版本。引用文件内容纳入哈希 = 按「输入」失效而非按「产物」失效：剧本或 runner
  // 变了，--check 即报输入已变化并给出重新生成命令（设计 §2.1 目标 3：按输入失效）。
  // 生成器版本纳入哈希：版本升级（模板语义变化）后 --check 报「输入已变化」引导重新生成，
  // 不把版本行差异误标为「手改」。
  // flags 书写顺序非语义：输出顺序固定为 compile.md §7 点名顺序，仅调换清单书写顺序不得
  // 造成重生成差异——哈希前对 flags 排序，与对象键序归一保持同一原则。
  const runnerHash = tryFileSha256(asset.runner.path);
  const scenarioHash = tryFileSha256(asset.scenario.path);
  if (runnerHash.error !== undefined || scenarioHash.error !== undefined) {
    const detail = [runnerHash.error, scenarioHash.error].filter(Boolean).join("；");
    return {
      gap: gap(
        `资产「${nodeId}」`,
        `生成期无法读取内容哈希：${detail}——校验通过后文件被并发删除或权限变化`,
        "清单引用的文件以项目 verification skill 场景库为权威；恢复文件可读后重新运行本命令",
      ),
    };
  }
  const inputDescriptor = {
    schemaVersion: manifest.schemaVersion,
    generatorVersion: GENERATOR_VERSION,
    projectRoot: manifest.projectRoot ?? null,
    asset: {
      ...asset,
      runner: { ...asset.runner, flags: [...asset.runner.flags].sort() },
    },
    runnerSha256: runnerHash.hash,
    scenarioSha256: scenarioHash.hash,
  };
  const inputHash = sha256(canonicalJson(inputDescriptor));
  const file = join(outAbs, `${nodeId}.mjs`);
  const text = buildWrapperText({
    nodeId,
    flags: asset.runner.flags,
    runnerPath: asset.runner.path,
    scenarioPath: asset.scenario.path,
    projectRoot: manifest.projectRoot ?? null,
    artifactsDir: asset.artifactsDir ?? null,
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

// 输出目录中不在清单内的 *.mjs = 陈旧 wrapper（节点已从清单移除但落点残留）。生成模式清掉
//（重新生成的语义 = 落点与清单一致）；--check 列为不一致（磁盘状态 ≠ 重生成后的状态）。
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
    `语义缺口报告：生成中止，未写任何文件（共 ${gaps.length} 条）` +
      "——runner 程序、参数或支持 flags 不明确时禁止猜参数（设计 §6.3 第 3 条）",
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
  // 写盘逐个收集不短路：一次报完所有 IO 故障，主 agent 一轮处理完，不逼出多轮返工。
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
    const out = [
      `FAIL：${failures.length} 项写盘未完成（成功 ${written.length} 项）——校验已全部通过，属文件系统层故障`,
    ];
    failures.forEach((f, i) => {
      out.push("", `[${i + 1}] ${f.file}`, `  不合法输入：${f.reason}`, `  权威源：${opts.assetsAbs}（验收资产清单——排除文件系统故障后重新运行，生成幂等覆盖）`, `  重新生成：${regen}`);
    });
    console.error(out.join("\n"));
    process.exit(1);
  }
  console.log(`已生成 ${wrappers.length} 个 D3 verify wrapper → ${opts.outAbs}`);
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
      // 输入哈希不同的来源：清单 / runner / 剧本文件变化（合法演进）或生成器版本升级
      //（模板语义变化），也可能有人连哈希行一起手改（非法）。恢复动作相同：重新生成。
      reason = `输入已变化：文件头登记哈希 ${registered} ≠ 按当前输入重算的 ${w.inputHash}——清单、其引用的 runner / 剧本文件或生成器版本在生成后发生过变化`;
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
      out.push("", `[${i + 1}] ${f.file}`, `  不合法输入：${f.reason}`, `  权威源：${opts.assetsAbs}（验收资产清单——语义修订回上游清单与 runner 契约文档，不手改生成文件）`, `  重新生成：${regen}`);
    });
    console.error(out.join("\n"));
    process.exit(1);
  }
  console.log(`PASS：${wrappers.length} 个 wrapper 与重新生成结果一致（清单 ${opts.assetsAbs}）`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gaps = [];
  const manifest = loadManifest(opts.assetsAbs, gaps);
  if (manifest !== null) {
    const seen = new Map();
    manifest.assets.forEach((asset, index) => {
      validateAsset(asset, index, manifest, gaps);
      if (typeof asset?.nodeId === "string" && NODE_ID_RE.test(asset.nodeId)) {
        // nodeId 即输出文件名，重复声明会互相覆盖——按契约含糊处理，不替清单消歧。
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
  // 内容哈希读取阶段的缺口（TOCTOU：校验通过后文件不可读）与校验缺口同通道结构化输出。
  const buildGaps = [];
  const wrappers = [];
  for (const asset of manifest.assets) {
    const built = buildWrapper(manifest, asset, opts.assetsAbs, generatorAbs, opts.outAbs);
    if (built.gap !== undefined) buildGaps.push(built.gap);
    else wrappers.push(built.wrapper);
  }
  if (buildGaps.length > 0) {
    printGaps(buildGaps, opts);
    process.exit(1);
  }
  const knownNodeIds = new Set(wrappers.map((w) => w.nodeId));
  const orphans = listOrphanWrappers(opts.outAbs, knownNodeIds);
  if (opts.check) runCheck(wrappers, orphans, opts);
  else runGenerate(wrappers, orphans, opts);
}

main();
