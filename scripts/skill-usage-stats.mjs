#!/usr/bin/env node
// skill-usage-stats.mjs — 九技能（tech-design/dev-flow/delivery 各 v1/v2/dev 三代 + dev-merge / pr-cr-fix）
// 统一耗时与 token 统计命令
//
// 数据来源（只读，不直连任何数据库 / 会话文件）：
//   1. `agent-session-reader usage --zcode --all --json`（zcode）与
//      `agent-session-reader usage --pi=<dir> --all --json`（pi）——workflow run 级
//      明细与 CLI 重算 token（tokensInput/Output/CacheRead/CacheWrite/Reasoning/
//      NoncacheInput/Total；不读 spent_tokens / tokensReported 自报值）。tokensXxx
//      为本 run 新生消息口径：zcode 换模型重发 run 并入的 seed 继承消息在
//      tokensXxxInherited 单列、不进 tokensXxx——跨 run 加总本脚本自然不双计，
//      汇总无需（也不得）把 Inherited 字段加回 token 合计
//   2. ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl
//      阶段事件（唯一允许直接读取的原始文件）
//
// 归因口径（attribution，两档恒分开、不得相加冒充同精度）：
//   observed = run 带 executionId 且观测 JSONL 精确匹配，阶段/步骤窗口来自事件 start/end 配对
//   estimated = 历史 run（无 executionId 关联），按 run 名 + args + actor 名称归类
//   认不出的 run 进 unclassified 计数与明细，不猜
//
// 用量口径（usageAttribution）：
//   observed / estimated = token 来自观测关联 / legacy 归类的 run（有 actor 会话用量证据）；
//   unknown = 无模型用量证据（如手工 D0/D4/D6 只有事件没有 actor 会话）——耗时照报、
//   token 记 unknown（JSON 里 null，不写 0 冒充无消耗）；
//   有继承（seed）用量但零新生的 run = 已知零新生消耗（重发后无新生成），不归 unknown；
//   unknown run 的 actor 全零记录不是证据，不置 tokensKnown（防整桶 unknown 被写成 0）
//
// 时间口径（并行两套分开报）：
//   elapsedMsUnion = 证据区间（actor 会话窗 + 节点窗，run 窗兜底）的并集 = 日历实际经过
//   durationSum    = run durationMs 直接相加（任务耗时累加，并行不去重）
//   actorDurationSum / nodeDurationSum = actor / 节点各自时长相加（工作量口径）
//
// 版本口径（--group skillVersion）：
//   observed  = 观测事件自带的 skill_version（事件回答「谁在执行」——执行存量产物时也记
//               引擎当前版本，不记 unknown）
//   estimated = run 参数指向产物（execPlan / designDoc 路径）内的 skillVersion（产物回答
//               「谁产出」）；产物缺失/不可解析/无该字段 → 归 unknown 桶并计入 dataQuality
//               （读失败与缺字段分开计数），不伪造版本、不中断统计
//   寻址口径：观测树按 task-id 顶层直读、产物只按 run args 记录的绝对路径读取——本脚本
//   不重算布局检测、无 slug 派生（新布局只改目录父级，run args 记录的仍是运行时绝对路径；
//   exec-plan 的 workspaceRoot/projectRoot 是执行坐标，统计侧不据此重排地址）
//
// 用法：
//   node scripts/skill-usage-stats.mjs [选项]
// 选项：
//   --skill <名>            tech-design-v1|v2|dev | dev-flow-v1|v2|dev | delivery-v1|v2|dev | dev-merge | pr-cr-fix | all，
//                           可重复；缺省 = all
//   --since <时间>          透传给 usage CLI（run 起始时间下界）
//   --until <时间>          透传给 usage CLI（run 起始时间上界）
//   --format table|json     输出形态，缺省 table
//   --group <维>            stage | step | role | model | status | skillVersion，可重复
//                           （表格透视维度；缺省 = stage）
//   --pi-agent-dir <路径>   pi 数据目录，可重复；给出即替换缺省 ~/.pi/agent；
//                           zcode 后端恒参与（无开关）
//   --include-selftest      计入自测样本（缺省只算 production；legacy 只按明确名称/
//                           临时路径特征识别自测并标记 sampleTypeSource）
//   --output <路径>         另存完整 JSON 报告到文件（table 模式下也可用）
//   --help / -h             打印本说明
// 退出码：0 = 成功；1 = 运行/数据错误；2 = 用法错误（stderr 含恢复动作）。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS = ["tech-design-v1", "dev-flow-v1", "delivery-v1", "tech-design-v2", "dev-flow-v2", "delivery-v2", "tech-design-dev", "dev-flow-dev", "delivery-dev", "dev-merge", "pr-cr-fix"];
// 观测事件 skill 字段历史上写过 workflow 引擎名（与 opts.skills 的技能名不同源）——
// 统计侧归一到 canonical 技能名；生产事件源已改 canonical，此处兼容存量事件
const SKILL_ALIASES = {
  // v1 代 workflow 名 → v1 技能（存量事件兼容）
  "tech-review-loop": "tech-design-v1",
  "wave-executor": "dev-flow-v1",
  "dev-consistency-loop": "dev-flow-v1",
  "design-code-sync-loop": "dev-flow-v1",
  "contract-design": "delivery-v1",
  "candidate-build": "delivery-v1",
  "independent-assurance": "delivery-v1",
  // v2 代 workflow 名 → v2 技能
  "tech-review-loop-v2": "tech-design-v2",
  "wave-executor-v2": "dev-flow-v2",
  "dev-consistency-loop-v2": "dev-flow-v2",
  "acceptance-design-v2": "delivery-v2",
  "candidate-build-v2": "delivery-v2",
  "independent-assurance-v2": "delivery-v2",
  // DEV 加固线 workflow 名 → dev 技能
  "tech-review-loop-dev": "tech-design-dev",
  "wave-executor-dev": "dev-flow-dev",
  "dev-consistency-loop-dev": "dev-flow-dev",
  "acceptance-design-dev": "delivery-dev",
  "candidate-build-dev": "delivery-dev",
  "independent-assurance-dev": "delivery-dev",
  "dev-merge-gates": "dev-merge",
  "pr-lifecycle": "pr-cr-fix",
};
const canonicalSkill = (s) => SKILL_ALIASES[s] ?? s;
const GROUP_DIMS = ["stage", "step", "role", "model", "status", "skillVersion"];
const USAGE_LINE =
  "node scripts/skill-usage-stats.mjs [--skill <名>]... [--since <时间>] [--until <时间>] [--format table|json] [--group <维>]... [--pi-agent-dir <路径>]... [--include-selftest] [--output <路径>]";
const MAX_QUALITY_DETAILS = 500;

function fail(message, code) {
  console.error(`${message}\n恢复动作：核对参数后重试；完整用法：${USAGE_LINE}`);
  process.exit(code);
}

// ── 参数解析（未知参数 fail-fast）──
function parseArgs(argv) {
  const opts = {
    skills: [],
    since: null,
    until: null,
    format: "table",
    groups: [],
    piAgentDirs: [],
    includeSelftest: false,
    output: null,
  };
  const flagNeedsValue = new Set(["--skill", "--since", "--until", "--format", "--group", "--pi-agent-dir", "--output"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "统一统计：tech-design / dev-flow / delivery 三代（v1 / v2 / dev）+ dev-merge + pr-cr-fix 的耗时与 token 汇总",
          "",
          "用法：",
          `  ${USAGE_LINE}`,
          "",
          "选项：",
          "  --skill <名>           tech-design-v1|v2|dev | dev-flow-v1|v2|dev | delivery-v1|v2|dev | dev-merge | pr-cr-fix | all，可重复；缺省 all",
          "  --since <时间>         透传 usage CLI（run 起始时间下界；YYYY-MM-DD 或 ISO 串）",
          "  --until <时间>         透传 usage CLI（run 起始时间上界）",
          "  --format table|json    输出形态（缺省 table；json 打印完整报告对象）",
          "  --group <维>           stage|step|role|model|status|skillVersion，可重复（table 透视维度，缺省 stage）",
          "  --pi-agent-dir <路径>  pi 数据目录，可重复；给出即替换缺省 ~/.pi/agent；zcode 恒参与",
          "  --include-selftest     计入自测样本（缺省只算 production）",
          "  --output <路径>        另存完整 JSON 报告",
          "",
          "示例：",
          "  node scripts/skill-usage-stats.mjs --skill dev-flow-dev --since 2026-10-01",
          "  node scripts/skill-usage-stats.mjs --format json --output /tmp/stats.json",
          "  node scripts/skill-usage-stats.mjs --pi-agent-dir ~/.taiji/agent --group stage --group model",
          "",
          "数据来源：agent-session-reader usage CLI（zcode --zcode / pi --pi=<目录>）+",
          "~/.agents/skill-data/workflow-observability/ 阶段事件；本命令不修改任何会话/workflow 数据，",
          "唯一写入是 --output 指定的报告文件。",
          "口径：token 用 CLI 重算值（不读自报值）；observed（executionId 精确关联观测）与",
          "estimated（legacy 分类器估算）恒分开报；无用量证据的段 token 记 unknown 不写 0。",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      fail(`未知参数 ${JSON.stringify(arg)}（本命令不接受位置参数；技能用 --skill 指定）`, 2);
    }
    if (!flagNeedsValue.has(arg)) {
      if (arg === "--include-selftest") {
        opts.includeSelftest = true;
        continue;
      }
      fail(`未知参数 ${arg}（合法：${[...flagNeedsValue].join(" ")} --include-selftest --help）——拼错的参数被静默忽略会让统计失真，故拒绝`, 2);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`参数 ${arg} 缺值（须为 ${arg} <值> 形态）`, 2);
    }
    i++;
    switch (arg) {
      case "--skill":
        if (value !== "all" && !SKILLS.includes(value)) {
          fail(`--skill 值非法：${JSON.stringify(value)}（合法：${SKILLS.join(" | ")} | all）`, 2);
        }
        if (value === "all") {
          opts.skills = [...SKILLS];
        } else if (!opts.skills.includes(value)) {
          opts.skills.push(value);
        }
        break;
      case "--since":
        if (value.trim() === "") fail("--since 值不能为空（示例：--since 2026-10-01）", 2);
        opts.since = value;
        break;
      case "--until":
        if (value.trim() === "") fail("--until 值不能为空（示例：--until 2026-10-31）", 2);
        opts.until = value;
        break;
      case "--format":
        if (value !== "table" && value !== "json") {
          fail(`--format 值非法：${JSON.stringify(value)}（合法：table | json）`, 2);
        }
        opts.format = value;
        break;
      case "--group":
        if (!GROUP_DIMS.includes(value)) {
          fail(`--group 值非法：${JSON.stringify(value)}（合法：${GROUP_DIMS.join(" | ")}）`, 2);
        }
        if (!opts.groups.includes(value)) opts.groups.push(value);
        break;
      case "--pi-agent-dir": {
        const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
        let real;
        try {
          real = realpathSync(expanded);
        } catch {
          fail(
            `--pi-agent-dir 路径不存在：${value}（展开为 ${expanded}）——先确认目录存在（pi 桌面端常在 ~/.taiji/agent，可用 agent-session-reader doctor 核对数据目录）`,
            2,
          );
        }
        if (!statSync(real).isDirectory()) {
          fail(`--pi-agent-dir 不是目录：${value}`, 2);
        }
        if (!opts.piAgentDirs.includes(real)) opts.piAgentDirs.push(real);
        break;
      }
      case "--output":
        if (value.trim() === "") fail("--output 值不能为空（示例：--output /tmp/stats.json）", 2);
        opts.output = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
        break;
    }
  }
  if (opts.skills.length === 0) opts.skills = [...SKILLS];
  if (opts.groups.length === 0) opts.groups = ["stage"];
  return opts;
}

// ── 小工具 ──
const toMs = (iso) => {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function mergeIntervals(intervals) {
  const clean = intervals
    .filter((iv) => Array.isArray(iv) && iv[1] > iv[0])
    .map((iv) => [iv[0], iv[1]])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of clean) {
    if (out.length && a <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

function unionMs(intervals) {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
}

function overlapMs(a, b) {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi > lo ? hi - lo : 0;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return "unknown";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function pushDetail(quality, text) {
  if (quality.details.length < MAX_QUALITY_DETAILS) {
    quality.details.push(text);
  } else if (quality.details.length === MAX_QUALITY_DETAILS) {
    quality.details.push(`（明细超 ${MAX_QUALITY_DETAILS} 条截断，计数仍完整）`);
  }
}

function dirnameOf(p) {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : ".";
}

function sumRunTokens(runs) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, noncacheInput: 0, total: 0 };
  for (const r of runs) {
    t.input += num(r.tokensInput);
    t.output += num(r.tokensOutput);
    t.cacheRead += num(r.tokensCacheRead);
    t.cacheWrite += num(r.tokensCacheWrite);
    t.reasoning += num(r.tokensReasoning);
    t.noncacheInput += num(r.tokensNoncacheInput);
    t.total += num(r.tokensTotal);
  }
  return t;
}

function isTempPath(cwd) {
  if (typeof cwd !== "string" || cwd === "") return false;
  return cwd.startsWith("/tmp/") || cwd.startsWith(`${tmpdir()}/`);
}

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// ── 技能版本归因（--group skillVersion 的数据来源）──
// 版本值定案（设计 D6/D7）：事件回答「谁在执行」、产物回答「谁产出」。observed 口径只读
// 事件自带 skill_version；estimated 口径读 run 参数指向的产物字段，读不到归 unknown 桶
// 显式计数，不伪造。
const VERSION_UNKNOWN = "unknown";

/** 读产物 JSON 的 skillVersion：ioError 非空 = 读不到文件或不是合法 JSON（产物已迁移/
 *  删除/损坏）；version null 且无 ioError = 文件可读但无该字段（老产物） */
function readArtifactSkillVersion(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    return { version: null, ioError: e && e.code ? e.code : "读取失败" };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { version: null, ioError: "不是合法 JSON" };
  }
  if (!obj || typeof obj !== "object") return { version: null, ioError: null };
  return { version: nonEmptyString(obj.skillVersion) ? obj.skillVersion.trim() : null, ioError: null };
}

/** estimated 口径的版本来源：execPlan → exec-plan.json 顶层 skillVersion；designDoc →
 *  设计包 meta.json（designDoc 是包内文档；.json 直接读自身）——meta.json 是设计包的
 *  版本载体（T1 生成时写入，见 tech-design-wf/flow/write.md）。两个候选按序尝试，
 *  首个读到版本即用；全失败 → unknown（io 失败 / 缺字段分别计数一次） */
function artifactSkillVersionFor(args, quality) {
  const candidates = [];
  if (nonEmptyString(args.execPlan)) {
    candidates.push({ source: "artifact:execPlan", file: args.execPlan.trim() });
  }
  if (nonEmptyString(args.designDoc)) {
    const doc = args.designDoc.trim();
    candidates.push({ source: "artifact:designDoc", file: /\.json$/i.test(doc) ? doc : join(dirnameOf(doc), "meta.json") });
  }
  if (candidates.length === 0) {
    return { version: null, source: "no-artifact", detail: "run 参数无 execPlan/designDoc（无产物版本来源）" };
  }
  let ioFailed = null;
  let missingField = null;
  for (const c of candidates) {
    const r = readArtifactSkillVersion(c.file);
    if (r.ioError !== null) {
      ioFailed = ioFailed ?? `${c.file}（${r.ioError}）`;
      continue;
    }
    if (r.version === null) {
      missingField = missingField ?? c.file;
      continue;
    }
    return { version: r.version, source: c.source, detail: null };
  }
  if (ioFailed !== null) quality.artifactVersionReadFailed++;
  if (missingField !== null) quality.artifactVersionMissingField++;
  return {
    version: null,
    source: ioFailed !== null ? "artifact-read-failed" : "artifact-missing-field",
    detail: ioFailed !== null ? `产物版本读取失败 ${ioFailed}` : `产物缺 skillVersion 字段（${missingField}）`,
  };
}

// ── usage CLI 采集 ──
function collectBackend(backend, since, until) {
  const args = ["usage", "--all", "--json"];
  if (backend.kind === "zcode") {
    args.push("--zcode");
  } else {
    args.push(`--pi=${backend.agentDir}`);
  }
  if (since) args.push("--since", since);
  if (until) args.push("--until", until);

  let res;
  try {
    // maxBuffer 放大到 512MB：--all 全量明细在大库上可达数十 MB，默认 1MB 直接 ENOBUFS
    res = spawnSync("agent-session-reader", args, { encoding: "utf8", timeout: 600_000, maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    fail(`调用 agent-session-reader 失败：${e && e.message ? e.message : String(e)}`, 1);
  }
  if (res.error && res.error.code === "ENOENT") {
    fail(
      "找不到 agent-session-reader 命令——本统计的唯一平台数据入口是它，不直连数据库。恢复动作：在 agent-session-reader 仓库执行 pnpm install && pnpm build && npm link 后重试；先跑 agent-session-reader --version 确认可用",
      1,
    );
  }
  if (res.error) {
    fail(
      `调用 agent-session-reader 失败（${res.error.code ?? "unknown"}）：${res.error.message ?? ""}——恢复动作：单独跑 agent-session-reader doctor 核对环境后重试`,
      1,
    );
  }
  if (res.status !== 0) {
    let detail = "";
    try {
      const errObj = JSON.parse(res.stdout);
      detail = errObj.error ? `${errObj.error}（code=${errObj.code ?? "?"}）` : res.stdout.slice(0, 400);
      if (Array.isArray(errObj.help) && errObj.help.length) detail += `；CLI 提示：${errObj.help.join("；")}`;
    } catch {
      detail = (res.stdout || res.stderr || "").slice(0, 400);
    }
    const probe = ["agent-session-reader", "usage", backend.kind === "zcode" ? "--zcode" : `--pi=${backend.agentDir}`, "--limit", "3"].join(" ");
    fail(`agent-session-reader usage 失败（exit ${res.status}，后端 ${backend.label}）：${detail}——恢复动作：先单独跑 ${probe} 确认 CLI 本身可用`, 1);
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch (e) {
    fail(`agent-session-reader usage 输出不是合法 JSON（后端 ${backend.label}）：${String(e).slice(0, 200)}——恢复动作：升级 agent-session-reader 后重试（usage --json 是本命令的硬依赖）`, 1);
  }
  if (payload && payload.details && Array.isArray(payload.details.runs) && !Array.isArray(payload.runs)) {
    payload = payload.details; // 兼容 {content, details} 包裹形态
  }
  if (!payload || !Array.isArray(payload.runs)) {
    fail(`agent-session-reader usage 输出缺少 runs 数组（后端 ${backend.label}）——恢复动作：升级 agent-session-reader（usage 契约要求 runs/totals/skipped 三段）后重试`, 1);
  }
  return payload;
}

// ── legacy 分类器（历史无 executionId 关联的 run）──
// 依据：run 名 + args（designDoc/execPlan/implPlan/statusPath/base 等）+ actor 名称。
// 只认明确特征；认不出的进 unclassified，不猜。
function matchDevFlowStage(name) {
  if (/D5|design-code-sync|终态同步/i.test(name)) return "D5";
  if (/D2|一致性|consistency/i.test(name)) return "D2";
  if (/D3|验收|acceptance/i.test(name)) return "D3";
  if (/D1|wave|开发执行|开发循环|开发/i.test(name)) return "D1";
  return null;
}

function classifyLegacy(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const reviewersStr = Array.isArray(a.reviewers) ? a.reviewers.join(" ") : "";
  const hasV = (k) => a[k] !== null && a[k] !== undefined && a[k] !== "";

  // 0. DEV 加固线 workflow 名 → dev 技能（estimated 兜底归类；带 executionId 的 run 走
  // observed 前分支，不经此处）。design-code-sync 两引擎跨代共用，不属 dev 技能
  if (/^(tech-review-loop-dev|wave-executor-dev|dev-consistency-loop-dev|acceptance-design-dev|candidate-build-dev|independent-assurance-dev)$/.test(name)) {
    const stage =
      /^acceptance-design-dev$/.test(name) ? "DESIGN" :
      /^candidate-build-dev$/.test(name) ? "BUILD" :
      /^independent-assurance-dev$/.test(name) ? "ASSURE" :
      /^tech-review-loop-dev$/.test(name) ? "T2" :
      matchDevFlowStage(name) ?? (/wave/i.test(name) ? "D1" : "D2");
    return {
      skill: /^(acceptance|candidate|independent)-/.test(name) ? "delivery-dev" : /^tech-review/.test(name) ? "tech-design-dev" : "dev-flow-dev",
      stage,
      reason: `DEV workflow 名(${name})`,
    };
  }
  // 1. delivery-wf：taskDir 是三个 workflow 的共同硬特征；阶段按 workflow 名判定
  if (hasV("taskDir") && /^(contract-design|candidate-build|independent-assurance)$/.test(name)) {
    const stage = name === "contract-design" ? "DESIGN" : name === "candidate-build" ? "BUILD" : "ASSURE";
    return { skill: "delivery-v1", stage, reason: `args.taskDir + workflow 名(${name})` };
  }
  // 2. dev-flow-wf：execPlan 是 D1/D2/D3 的硬特征（W2/W3 args）；designDoc+implPlan 是 D5
  if (hasV("execPlan")) {
    const stage =
      matchDevFlowStage(name) ?? (/wave/i.test(name) ? "D1" : /consistency/i.test(name) ? "D2" : null);
    if (stage) return { skill: "dev-flow-v1", stage, reason: `args.execPlan + 名称特征(${stage})` };
    return { skill: "dev-flow-v1", stage: null, reason: "args.execPlan 但名称无阶段特征" };
  }
  if (hasV("designDoc") && hasV("implPlan")) {
    return { skill: "dev-flow-v1", stage: "D5", reason: "args.designDoc + args.implPlan（design-code-sync-loop）" };
  }
  // 3. tech-design-wf T2：designDoc 无 implPlan（tech-review-loop），或名称明确设计审查/方向审（T2 四席词表）
  if (hasV("designDoc")) {
    return { skill: "tech-design-v1", stage: "T2", reason: "args.designDoc 无 implPlan（tech-review-loop）" };
  }
  if (/T2|设计审查|tech-review|方向审/i.test(name) || (/审查/.test(name) && /设计/.test(name) && !/修复|评审/.test(name))) {
    return { skill: "tech-design-v1", stage: "T2", reason: "名称含 T2/设计审查/方向审特征" };
  }
  // 4. dev-flow-wf 无 args 兜底：名称阶段编号/引擎名（历史起名惯例）
  const stageByName = matchDevFlowStage(name);
  if (stageByName) {
    return { skill: "dev-flow-v1", stage: stageByName, reason: `名称阶段特征(${stageByName})，无 args` };
  }
  // 5. pr-cr-fix：PR 编号 + 审查；reviewers 指向 pr-cr-fix 技能
  if (/PR\s*#?\s*\d+/i.test(name) && /审查|review/i.test(name)) {
    return { skill: "pr-cr-fix", stage: null, reason: "名称含 PR 编号 + 审查特征" };
  }
  if (reviewersStr.includes("pr-cr-fix")) {
    return { skill: "pr-cr-fix", stage: null, reason: "args.reviewers 指向 pr-cr-fix 技能" };
  }
  // 6. dev-merge：gates / branch-review
  if (/dev-merge/i.test(name)) {
    const isGates = /gates|门禁|质量门|前置检查/i.test(name);
    const isReview = /branch-review|横切审查|复验|审查/i.test(name);
    const stage = isGates && isReview ? "gates+branch-review" : isGates ? "gates" : isReview ? "branch-review" : null;
    return { skill: "dev-merge", stage, reason: "名称含 dev-merge" };
  }
  // 7. pr-cr-fix：PR 生命周期（九步）；base + reportDir/reviewers 组合特征
  if (/PR\s*生命周期|pr-lifecycle/i.test(name) || (hasV("base") && /lifecycle/i.test(name))) {
    return { skill: "pr-cr-fix", stage: "pr-lifecycle", reason: "名称 PR 生命周期（九步）+ args.base" };
  }
  if (hasV("base") && (hasV("reportDir") || hasV("reviewers")) && /审查|review/i.test(name)) {
    return { skill: "pr-cr-fix", stage: null, reason: "args.base + reportDir/reviewers + 名称审查特征" };
  }
  return null;
}

// legacy taskKey 词干：从 run 名剥离阶段/引擎/轮次修饰词（估算级标签，恒标 estimated 来源）
function legacyTaskStem(name) {
  let s = name;
  s = s.replace(/\s*[(（][^()（）]*[)）]\s*/g, " ");
  s = s.replace(/\bD[0-6]\b|\bT2\b|attempt\s*\d*|第\s*\d+\s*轮|[一二三四五六七八九十\d]+轮|\br\d+\b/gi, " ");
  s = s.replace(
    /wave-executor|dev-consistency-loop|design-code-sync-loop|tech-review-loop|design-code-sync|dev-consistency|acceptance|consistency/gi,
    " ",
  );
  s = s.replace(
    /开发循环|开发执行|一致性审查循环|一致性审查|端到端验收|终态同步|设计审查循环|设计审查|对抗式审查|审查循环|审查修复循环|方向审|八维|八席|审查/g,
    " ",
  );
  s = s.replace(/重发|重跑|续跑|收官|终段|对账|复验|修正后|批次|打回重写|修复|复审|走查|并行度/g, " ");
  s = s.replace(/[:：·\-—_/\\|+]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// ── actor 角色（沿用既有统计口径的 D1/D2/D3/D5 角色词表，五技能各自扩展）──
function roleFor(skill, stage, name) {
  const n = name || "";
  if (skill === "dev-flow-v1") {
    if (stage === "D1") {
      if (/fix|修复|返工/i.test(n)) return "开发修复";
      if (/verify|核验/i.test(n)) return "开发核验";
      if (/inspect|验收/i.test(n)) return "验收执行";
      return "开发实现";
    }
    if (stage === "D2") {
      if (/聚合|aggreg/i.test(n)) return "审查聚合";
      if (/文档/.test(n) && /修|fix/i.test(n)) return "文档修复";
      if (/fix|修复/i.test(n)) return "一致性修复";
      if (/复审|re-?review/i.test(n)) return "定向复审";
      return "全面一致性审查";
    }
    if (stage === "D3") {
      if (/heal|自愈|修复/i.test(n)) return "验收修复";
      if (/verify|脚本/i.test(n)) return "脚本验收";
      return "agent 验收";
    }
    if (stage === "D5") {
      if (/framework|框架|planner|规划/i.test(n)) return "框架扫描与模块计划";
      if (/fix|修复/i.test(n)) return "终态同步修复";
      if (/retire|清理|退役/i.test(n)) return "退役清理";
      return "模块审查";
    }
    return "其他";
  }
  if (skill === "tech-design-v1") {
    if (/方向审/.test(n)) return "方向审";
    if (/主审/.test(n)) return "主审";
    if (/影响面/.test(n)) return "影响面审";
    if (/简洁审|simplicity/i.test(n)) return "简洁审";
    if (/聚合|aggreg/i.test(n)) return "聚合裁决";
    if (/文档/.test(n) && /修|fix/i.test(n)) return "文档修复";
    if (/fix|修复/i.test(n)) return "审查修复";
    return "审查席位";
  }
  if (skill === "dev-merge") {
    if (/gate-fix/i.test(n)) return "门禁修复";
    if (/reviewer/i.test(n)) return "分支审查";
    if (/fixer|修复/i.test(n)) return "审查修复";
    if (/aggregat|聚合/i.test(n)) return "审查聚合";
    if (/changeset|变更集/i.test(n)) return "变更集起草";
    if (/simplify|简化/i.test(n)) return "简化应用";
    return "其他";
  }
  if (skill === "pr-cr-fix") {
    if (/aggregat|聚合/i.test(n)) return "审查聚合";
    if (/fixer|修复/i.test(n)) return "审查修复";
    if (/simplify|简化/i.test(n)) return "简化应用";
    if (/reviewer|审/i.test(n)) return "维度审查";
    return "其他";
  }
  return "其他";
}

// dev-merge/pr-cr-fix legacy 节点步骤：只认 world-run 命令里的门禁脚本特征，不造词
function legacyNodeStep(node) {
  if (node.kind !== "world-run" || typeof node.command !== "string") return null;
  if (/pr-pre-merge/.test(node.command)) return "pre-merge-gate";
  if (/coverage-gate/.test(node.command)) return "coverage-gate";
  if (/metrics-gate/.test(node.command)) return "metrics-gate";
  return null;
}

// ── 观测事件读取（唯一允许直接读取的原始文件）──
function loadObservations(obsRoot, quality) {
  const executions = new Map(); // executionId → 执行文件解析结果
  if (!existsSync(obsRoot)) return executions;
  let taskDirs;
  try {
    taskDirs = readdirSync(obsRoot, { withFileTypes: true });
  } catch (e) {
    quality.obsRootUnreadable++;
    pushDetail(quality, `观测根不可读 ${obsRoot}：${e.message}`);
    return executions;
  }
  for (const ent of taskDirs) {
    if (!ent.isDirectory()) continue;
    const taskDir = join(obsRoot, ent.name);
    let files;
    try {
      files = readdirSync(taskDir);
    } catch (e) {
      quality.obsRootUnreadable++;
      pushDetail(quality, `任务目录不可读 ${taskDir}：${e.message}`);
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const filePath = join(taskDir, f);
      const executionId = f.slice(0, -".jsonl".length);
      let lines;
      try {
        lines = readFileSync(filePath, "utf8").split("\n");
      } catch (e) {
        quality.badLines++;
        pushDetail(quality, `观测文件不可读 ${filePath}：${e.message}`);
        continue;
      }
      const events = [];
      for (let li = 0; li < lines.length; li++) {
        const raw = lines[li].trim();
        if (raw === "") continue;
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          quality.badLines++;
          pushDetail(quality, `坏 JSONL 行 ${filePath}:${li + 1}`);
          continue;
        }
        const required = ["execution_id", "task_id", "skill", "stage", "step", "event", "timestamp"];
        if (!rec || typeof rec !== "object" || required.some((k) => typeof rec[k] !== "string" || rec[k] === "")) {
          quality.malformedEvents++;
          pushDetail(quality, `缺契约字段的事件 ${filePath}:${li + 1}`);
          continue;
        }
        events.push(rec);
      }
      events.sort((x, y) => (toMs(x.timestamp) ?? 0) - (toMs(y.timestamp) ?? 0));
      // start/end 配对：同 (stage|step|round) 键栈式配对、取最近尚未配对的 start。
      // attempt 不参与身份匹配——观测契约允许 attempt 从 null 回填为 1（启动早期自动检测
      // 未完成时事件带 null，检测确定后其后的事件带值），setup start(null)/end(1) 是正常
      // 序列；start/end 各自的 attempt 原值保留（窗口 attempt 取 end 的回填值优先）
      const windows = [];
      const openByKey = new Map();
      let outcome = null;
      const pairKey = (ev) => [ev.stage, ev.step, ev.round].join("|");
      for (const ev of events) {
        const key = pairKey(ev);
        if (ev.event === "start") {
          const arr = openByKey.get(key) ?? [];
          if (arr.length > 0) {
            quality.unpairedStarts++;
            pushDetail(quality, `连续 start 未配对 ${filePath}（${key}）`);
          }
          arr.push(ev);
          openByKey.set(key, arr);
        } else if (ev.event === "end") {
          const arr = openByKey.get(key);
          const startEv = arr && arr.length ? arr.pop() : null;
          if (startEv) {
            const startMs = toMs(startEv.timestamp);
            const endMs = toMs(ev.timestamp);
            if (typeof ev.outcome === "string") outcome = ev.outcome;
            if (endMs === null) {
              quality.unpairedEnds++;
              pushDetail(quality, `end 时间戳不可解析 ${filePath}（${key}）`);
            }
            windows.push({
              stage: startEv.stage,
              step: startEv.step,
              round: startEv.round ?? null,
              attempt: ev.attempt ?? startEv.attempt ?? null,
              startMs,
              endMs: endMs ?? startMs,
              sampleType: typeof startEv.sample_type === "string" ? startEv.sample_type : "production",
              outcome: typeof ev.outcome === "string" ? ev.outcome : null,
              paired: endMs !== null,
            });
          } else {
            quality.unpairedEnds++;
            pushDetail(quality, `end 无配对 start ${filePath}（${key}）`);
          }
        } else {
          quality.unknownEvents++;
          pushDetail(quality, `未知 event 类型 ${filePath}（${String(ev.event)}）`);
        }
      }
      for (const [key, arr] of openByKey) {
        for (const startEv of arr) {
          quality.unpairedStarts++;
          pushDetail(quality, `未配对 start ${filePath}（${key}）`);
          // 未配对 start 显式计数；窗口按 [start, 文件末事件] 计入耗时（标 unpaired，end 待补）
          const startMs = toMs(startEv.timestamp);
          const lastMs = events.length ? toMs(events[events.length - 1].timestamp) : null;
          if (startMs !== null && lastMs !== null && lastMs > startMs) {
            windows.push({
              stage: startEv.stage,
              step: startEv.step,
              round: startEv.round ?? null,
              attempt: startEv.attempt ?? null,
              startMs,
              endMs: lastMs,
              sampleType: typeof startEv.sample_type === "string" ? startEv.sample_type : "production",
              outcome: null,
              paired: false,
            });
          }
        }
      }
      const stages = [...new Set(events.map((e) => e.stage))];
      const skills = [...new Set(events.map((e) => canonicalSkill(e.skill)))];
      const allSelftest = events.length > 0 && events.every((e) => e.sample_type === "selftest");
      const hasSelftest = events.some((e) => e.sample_type === "selftest");
      // 执行级技能版本 = 事件 skill_version 的多数派（合法事件恒记同一引擎版本）；
      // 老 JSONL（无该字段）→ null，由归因侧落 unknown 桶并显式计数
      const versionValues = events
        .map((e) => (nonEmptyString(e.skill_version) ? e.skill_version.trim() : null))
        .filter((v) => v !== null);
      const skillVersion = versionValues.length > 0 ? majorityOf(versionValues) : null;
      executions.set(executionId, {
        taskId: ent.name,
        file: filePath,
        executionId,
        events,
        windows,
        stages,
        skills,
        outcome,
        allSelftest,
        hasSelftest,
        skillVersion,
      });
    }
  }
  return executions;
}

// ── 证据 → 观测窗口归属（时间重叠优先取最大重叠，单一阶段兜底，显式计数）──
function assignWindow(intervals, windows, quality) {
  let best = null;
  let bestOverlap = 0;
  for (const w of windows) {
    const iv = [w.startMs, w.endMs];
    let ov = 0;
    for (const base of intervals) ov += overlapMs(base, iv);
    // 重叠并列时取更窄（更具体）的窗口；同宽取更早开始者
    const width = w.endMs - w.startMs;
    if (
      ov > bestOverlap ||
      (ov > 0 &&
        ov === bestOverlap &&
        best &&
        (width < best.endMs - best.startMs || (width === best.endMs - best.startMs && w.startMs < best.startMs)))
    ) {
      best = w;
      bestOverlap = ov;
    }
  }
  if (best) return { window: best, mode: "time-overlap" };
  const stages = [...new Set(windows.map((w) => w.stage))];
  if (stages.length === 1) {
    quality.singleStageFallbacks++;
    return { window: windows[0], mode: "single-stage" };
  }
  quality.noOverlap++;
  return { window: null, mode: "none" };
}

// 多阶段文件时 run 级阶段 = 与 run 窗重叠最大的窗口阶段
function majorityStage(windows, intervals) {
  let best = null;
  let bestOv = 0;
  for (const w of windows) {
    let ov = 0;
    for (const base of intervals) ov += overlapMs(base, [w.startMs, w.endMs]);
    if (ov > bestOv) {
      best = w.stage;
      bestOv = ov;
    }
  }
  return best;
}

// ── 聚合器 ──
function newMetrics() {
  return {
    runs: 0,
    manualExecs: 0,
    actorSessions: 0,
    elapsedMsUnion: null, // null = 该桶无任何时间证据（unknown，不写 0）
    durationSum: 0,
    actorDurationSum: 0,
    nodeDurationSum: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, noncacheInput: 0, total: 0 },
    tokensKnown: false,
    usageCoverage: { observed: 0, estimated: 0, unknown: 0 },
    attribution: { observed: 0, estimated: 0 },
  };
}

class Aggregator {
  constructor() {
    this.records = [];
  }

  add(rec) {
    this.records.push(rec);
  }

  _bucketize(records, dims) {
    const buckets = new Map();
    const keyOf = (rec) => dims.map((d) => rec[d] ?? "(未归)").join("\u0001");
    for (const rec of records) {
      const key = keyOf(rec);
      let b = buckets.get(key);
      if (!b) {
        b = { dims: Object.fromEntries(dims.map((d) => [d, rec[d] ?? null])), m: newMetrics(), evidence: [] };
        buckets.set(key, b);
      }
      const m = b.m;
      if (rec.kind === "run") {
        m.runs += 1;
        m.durationSum += rec.durationMs ?? 0;
        m.usageCoverage[rec.usageAttribution] = (m.usageCoverage[rec.usageAttribution] ?? 0) + 1;
        m.attribution[rec.attribution] = (m.attribution[rec.attribution] ?? 0) + 1;
      } else if (rec.kind === "manual") {
        m.manualExecs += 1;
        m.durationSum += rec.durationMs ?? 0;
        m.usageCoverage.unknown += 1;
        m.attribution.observed += 1;
      } else if (rec.kind === "actor") {
        if (!rec.dupSession) m.actorSessions += 1;
        m.actorDurationSum += rec.durationMs ?? 0;
        // 用量/归因覆盖恒按 run 级计数（actor 只贡献 token 与时长），避免两套基数混报
        if (rec.tokens) {
          m.tokensKnown = true;
          for (const k of Object.keys(rec.tokens)) m.tokens[k] += rec.tokens[k];
        }
      } else if (rec.kind === "reconcile") {
        // run 级差额补齐用量：只补 token，不计会话/时长/覆盖计数（run 级已计）
        if (rec.tokens) {
          m.tokensKnown = true;
          for (const k of Object.keys(rec.tokens)) m.tokens[k] += rec.tokens[k];
        }
      } else if (rec.kind === "node") {
        m.nodeDurationSum += rec.durationMs ?? 0;
      }
      if (Array.isArray(rec.evidence)) b.evidence.push(...rec.evidence);
    }
    for (const b of buckets.values()) {
      b.m.elapsedMsUnion = b.evidence.length ? unionMs(b.evidence) : null;
    }
    return buckets;
  }

  metrics(records) {
    const buckets = this._bucketize(records, ["__all__"]);
    if (!buckets.size) return newMetrics();
    return [...buckets.values()][0].m;
  }

  byDim(records, dim) {
    const out = {};
    for (const [, b] of this._bucketize(records, [dim])) {
      out[b.dims[dim] ?? "(未归)"] = b.m;
    }
    return out;
  }

  byDims(records, dims) {
    const out = {};
    for (const [, b] of this._bucketize(records, dims)) {
      const path = dims.map((d) => b.dims[d] ?? "(未归)");
      let node = out;
      for (let i = 0; i < path.length - 1; i++) {
        node[path[i]] = node[path[i]] ?? {};
        node = node[path[i]];
      }
      node[path[path.length - 1]] = b.m;
    }
    return out;
  }
}

function metricJson(m) {
  return { ...m, tokens: m.tokensKnown ? m.tokens : null }; // 无用量证据 → null（unknown），不写 0
}

function mapValue(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = fn(v);
  return out;
}

// taskKey：observed:taskId（跨技能/attempt 精确串联）| arg:taskId（run args 带了 taskId 但
// 无观测文件关联）| legacy-stem:词干（估算标签）| null（无任务可归，进 unlinked 计数）
function taskKeyFor(run, linked) {
  if (linked) return { key: `observed:${linked.taskId}`, source: "observed-taskid" };
  if (typeof run.taskId === "string" && run.taskId !== "") {
    return { key: `arg:${run.taskId}`, source: "run-args-taskid" };
  }
  const stem = legacyTaskStem(typeof run.name === "string" ? run.name : "");
  return stem ? { key: `legacy-stem:${stem}`, source: "legacy-stem(estimated)" } : { key: null, source: "unlinked" };
}

// ── 单个 run → 聚合记录 ──
function processRun(run, backend, opts, executions, aggregator, runSummaries, unclassified, quality, executionIdsSeen) {
  const name = typeof run.name === "string" ? run.name : "";
  const args = run.args && typeof run.args === "object" ? run.args : {};
  const actorRows = Array.isArray(run.actorRows) ? run.actorRows : [];
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const runWindow = [toMs(run.timeStart), toMs(run.timeEnd)];
  const runWindowOk = runWindow[0] !== null && runWindow[1] !== null && runWindow[1] > runWindow[0];

  // ── 归类：观测优先，legacy 兜底，认不出 → unclassified ──
  let attribution;
  let skill;
  let stage;
  let reason;
  let linked = null;
  if (typeof run.executionId === "string" && run.executionId !== "") {
    linked = executions.get(run.executionId) ?? null;
    if (!linked) {
      quality.runsWithoutObservation++;
      pushDetail(quality, `run 声明 executionId=${run.executionId} 但观测文件缺失（${backend.label} ${run.id}）`);
    } else {
      executionIdsSeen.add(run.executionId);
      if (typeof run.taskId === "string" && run.taskId !== "" && run.taskId !== linked.taskId) {
        quality.taskIdMismatches++;
        pushDetail(quality, `taskId 不一致：run args=${run.taskId} 观测目录=${linked.taskId}（${run.executionId}）`);
      }
    }
  }
  if (linked) {
    attribution = "observed";
    reason = "executionId 精确关联观测文件";
    skill = majorityOf(linked.skills) ?? "dev-flow-v1"; // 事件 skill 字段多数派
    stage = linked.stages.length === 1 ? linked.stages[0] : majorityStage(linked.windows, runWindowOk ? [runWindow] : []);
  } else {
    const legacy = classifyLegacy(name, args);
    if (!legacy) {
      quality.unclassifiedRuns++;
      unclassified.push({ backend: backend.label, id: run.id, name, reason: "名称与 args 均无技能特征" });
      return;
    }
    attribution = "estimated";
    skill = legacy.skill;
    stage = legacy.stage;
    reason = legacy.reason;
  }

  // ── 样本类型：run args sampleType > 观测事件 > legacy 明确名称/临时路径特征 ──
  let sampleType = "production";
  let sampleTypeSource = "default";
  if (run.sampleType === "selftest" || run.sampleType === "production") {
    sampleType = run.sampleType;
    sampleTypeSource = "run-args";
  } else if (linked && linked.hasSelftest) {
    sampleType = linked.allSelftest ? "selftest" : "production";
    sampleTypeSource = "events";
  } else if (/selftest|自测|冒烟/i.test(name)) {
    sampleType = "selftest";
    sampleTypeSource = "legacy-name";
  } else if (isTempPath(run.cwd)) {
    sampleType = "selftest";
    sampleTypeSource = "legacy-cwd";
  }
  const included = opts.includeSelftest || sampleType !== "selftest";
  if (!included) quality.selftestRunsExcluded++;

  // ── 技能版本归因（--group skillVersion）──
  // observed 口径读事件自带 skill_version（事件回答「谁在执行」）；estimated 口径读 run
  // 参数指向产物内的 skillVersion（产物回答「谁产出」）。读不到归 unknown 桶并显式计数
  //（不伪造）；本口径与 attribution 正交，同一版本桶可同时含 observed / estimated 两档。
  // 排除的自测 run 不做归因（其记录不进统计，也不该污染 dataQuality 计数）
  let skillVersion = null;
  let skillVersionSource = null;
  if (included) {
    if (linked) {
      if (linked.skillVersion !== null) {
        skillVersion = linked.skillVersion;
        skillVersionSource = "observed-event";
      } else {
        skillVersion = VERSION_UNKNOWN;
        skillVersionSource = "unknown-observed";
        quality.skillVersionUnknownObserved++;
        pushDetail(quality, `观测事件无 skill_version（老 JSONL ${linked.file}）——该 run 技能版本归 unknown（${backend.label} ${run.id}）`);
      }
    } else {
      const av = artifactSkillVersionFor(args, quality);
      if (av.version !== null) {
        skillVersion = av.version;
        skillVersionSource = av.source;
      } else {
        skillVersion = VERSION_UNKNOWN;
        skillVersionSource = av.source;
        quality.skillVersionUnknownEstimated++;
        pushDetail(quality, `${av.detail}——该 run 技能版本归 unknown（${backend.label} ${run.id}）`);
      }
    }
  }

  const status = typeof run.status === "string" && run.status !== "" ? run.status : "unknown";
  const runTokenTotal = num(run.tokensTotal);
  const runInheritedTotal = num(run.tokensTotalInherited);
  // 用量证据判定：run 级或 actor 重算 token 任一非零，或有继承（seed）消息用量——有继承零新生的
  // run = 已知零新生消耗（重发后未产生新生成），不归 unknown；真正 unknown = 无任何用量证据
  // （如手工 D0/D4/D6 只有事件没有 actor 会话），此时 actor 全零记录同样不是证据
  const hasUsageEvidence = runTokenTotal > 0 || runInheritedTotal > 0;
  const usageAttribution = hasUsageEvidence ? (attribution === "observed" ? "observed" : "estimated") : "unknown";
  const task = taskKeyFor(run, linked);

  // ── 观测窗口（observed run 才有）；selftest 窗口随 --include-selftest 过滤 ──
  let windows = [];
  if (linked) {
    windows = linked.windows.filter((w) => opts.includeSelftest || w.sampleType !== "selftest");
    quality.selftestWindowsExcluded += linked.windows.length - windows.length;
  }

  aggregator.add({
    kind: "run",
    included,
    skill,
    stage,
    step: null,
    role: null,
    model: null,
    status,
    skillVersion,
    taskKey: task.key,
    taskSource: task.source,
    attemptId: typeof run.executionId === "string" ? run.executionId : String(run.id ?? ""),
    attribution,
    usageAttribution,
    durationMs: num(run.durationMs),
    tokens: null,
    evidence: runWindowOk ? [runWindow] : [],
  });

  // actor 行按 run+session 去重：同一会话被重复引用时，重复行保留执行时长但 tokens=null、
  // 不重复计 actorSessions（token 只计一次，防止会话复用导致的重复累加）。
  // session 为空的行无法判重，按独立执行计
  const seenSessions = new Set();
  let uniqSessionCount = 0;
  const uniqTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, noncacheInput: 0, total: 0 };
  for (const a of actorRows) {
    const ts = toMs(a.timeStart);
    const te = toMs(a.timeEnd);
    const iv = ts !== null && te !== null && te > ts ? [[ts, te]] : [];
    let step = null;
    let evidenceStage = stage;
    if (windows.length) {
      const bases = iv.length ? iv : runWindowOk ? [runWindow] : [];
      const { window } = assignWindow(bases, windows, quality);
      if (window) {
        step = window.step;
        evidenceStage = window.stage;
      }
    }
    const sid = typeof a.session === "string" && a.session !== "" ? a.session : null;
    const dupSession = sid !== null && seenSessions.has(sid);
    if (sid !== null && !dupSession) seenSessions.add(sid);
    if (!dupSession) uniqSessionCount++;
    const tokens = dupSession || !hasUsageEvidence
      ? null // unknown run 的全零记录不是用量证据，不得把桶 tokensKnown 置真（seed-only 有继承时全零是真实值）
      : {
          input: num(a.tokensInput),
          output: num(a.tokensOutput),
          cacheRead: num(a.tokensCacheRead),
          cacheWrite: num(a.tokensCacheWrite),
          reasoning: num(a.tokensReasoning),
          noncacheInput: num(a.tokensNoncacheInput),
          total: num(a.tokensTotal),
        };
    if (!dupSession) {
      uniqTokens.input += num(a.tokensInput);
      uniqTokens.output += num(a.tokensOutput);
      uniqTokens.cacheRead += num(a.tokensCacheRead);
      uniqTokens.cacheWrite += num(a.tokensCacheWrite);
      uniqTokens.reasoning += num(a.tokensReasoning);
      uniqTokens.noncacheInput += num(a.tokensNoncacheInput);
      uniqTokens.total += num(a.tokensTotal);
    }
    aggregator.add({
      kind: "actor",
      included,
      skill,
      stage: evidenceStage,
      step,
      role: roleFor(skill, evidenceStage ?? stage, a.name),
      model: typeof a.model === "string" && a.model !== "" ? a.model : "unknown",
      status,
      skillVersion,
      taskKey: task.key,
      taskSource: task.source,
      attemptId: null,
      attribution,
      usageAttribution,
      durationMs: num(a.durationMs),
      tokens,
      evidence: iv,
      dupSession,
    });
  }

  // run 级 token 对账：总量以 CLI 重算的 run 级 token 为准。唯一 actor 合计不足且全部
  // 7 个分项差额均非负时，差额合成一条 role=未归 的用量记录补齐（actorsNoSession /
  // 会话缺失场景），保证不重不漏且恒满足 total=input+output；total 为负或任一分项
  // 差额为负（正负混合/数据异常）时不合成——保留 actor 合计、明确无法与 run 级对账，
  // 显式进 dataQuality
  const tokenDelta = {
    input: num(run.tokensInput) - uniqTokens.input,
    output: num(run.tokensOutput) - uniqTokens.output,
    cacheRead: num(run.tokensCacheRead) - uniqTokens.cacheRead,
    cacheWrite: num(run.tokensCacheWrite) - uniqTokens.cacheWrite,
    reasoning: num(run.tokensReasoning) - uniqTokens.reasoning,
    noncacheInput: num(run.tokensNoncacheInput) - uniqTokens.noncacheInput,
    total: runTokenTotal - uniqTokens.total,
  };
  const deltaFields = [
    tokenDelta.input,
    tokenDelta.output,
    tokenDelta.cacheRead,
    tokenDelta.cacheWrite,
    tokenDelta.reasoning,
    tokenDelta.noncacheInput,
  ];
  const canReconcile = tokenDelta.total > 0 && deltaFields.every((v) => v >= 0);
  const exactMatch = tokenDelta.total === 0 && deltaFields.every((v) => v === 0);
  if (canReconcile) {
    aggregator.add({
      kind: "reconcile",
      included,
      skill,
      stage,
      step: null,
      role: null, // 未归属到具体席位的差额用量（渲染为 (未归)）
      model: null,
      status,
      skillVersion,
      taskKey: task.key,
      taskSource: task.source,
      attemptId: null,
      attribution,
      usageAttribution,
      durationMs: 0,
      tokens: {
        input: tokenDelta.input,
        output: tokenDelta.output,
        cacheRead: tokenDelta.cacheRead,
        cacheWrite: tokenDelta.cacheWrite,
        reasoning: tokenDelta.reasoning,
        noncacheInput: tokenDelta.noncacheInput,
        total: tokenDelta.total,
      },
      evidence: [],
    });
  } else if (!exactMatch) {
    quality.tokenReconcileNegative++;
    pushDetail(
      quality,
      `token 不可对账：run 级重算值与唯一 actor 重算合计差额含负项（total 差 ${tokenDelta.total}，input 差 ${tokenDelta.input}，output 差 ${tokenDelta.output}）——保留 actor 合计计入，run 级差额未入账（${backend.label} ${run.id}）`,
    );
  }

  for (const nd of nodes) {
    const ts = toMs(nd.timeStart);
    const te = toMs(nd.timeEnd);
    if (ts === null || te === null || te <= ts) continue;
    let step = null;
    let evidenceStage = stage;
    if (windows.length) {
      const { window } = assignWindow([[ts, te]], windows, quality);
      if (window) {
        step = window.step;
        evidenceStage = window.stage;
      }
    }
    if (step === null) step = legacyNodeStep(nd);
    aggregator.add({
      kind: "node",
      included,
      skill,
      stage: evidenceStage,
      step,
      role: null,
      model: null,
      status,
      skillVersion,
      taskKey: task.key,
      taskSource: task.source,
      attemptId: null,
      attribution,
      usageAttribution,
      durationMs: num(nd.durationMs),
      tokens: null,
      evidence: [[ts, te]],
    });
  }

  runSummaries.push({
    included,
    backend: backend.label,
    id: run.id,
    name,
    skill,
    stage,
    attribution,
    usageAttribution,
    sampleType,
    sampleTypeSource,
    status,
    skillVersion,
    skillVersionSource,
    taskId: typeof run.taskId === "string" && run.taskId !== "" ? run.taskId : null,
    executionId: typeof run.executionId === "string" && run.executionId !== "" ? run.executionId : null,
    taskKey: task.key,
    timeStart: run.timeStart ?? null,
    timeEnd: run.timeEnd ?? null,
    durationMs: num(run.durationMs),
    actorSessions: uniqSessionCount, // 与聚合口径一致：唯一 session 数（空 session 行按独立执行计）
    tokens: sumRunTokens([run]),
    reason,
  });
}

function majorityOf(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// 手工执行（观测文件无 run 匹配：D0/D4/D6 手工段或孤儿执行）——耗时照报、token unknown
function addManualExecution(exec, opts, aggregator, quality) {
  // 全 selftest 文件在缺省口径下整文件跳过（计数照记）
  if (exec.allSelftest && !opts.includeSelftest) {
    quality.selftestWindowsExcluded += exec.windows.length;
    return;
  }
  const windows = exec.windows.filter((w) => opts.includeSelftest || w.sampleType !== "selftest");
  quality.selftestWindowsExcluded += exec.windows.length - windows.length;
  const skill = majorityOf(exec.skills) ?? "unknown-skill";
  const outcome = exec.outcome ?? "unknown";
  // 手工段的版本归因同 observed 口径（读事件自带 skill_version）；老 JSONL 归 unknown
  // 并显式计数——每次执行只计一次（下游按 stage 拆多条记录不再重复计数）
  const skillVersion = exec.skillVersion ?? VERSION_UNKNOWN;
  if (exec.skillVersion === null) {
    quality.skillVersionUnknownManualExecs++;
    pushDetail(quality, `观测事件无 skill_version（老 JSONL ${exec.file}）——该手工段技能版本归 unknown（task ${exec.taskId}）`);
  }
  const byStage = new Map();
  for (const w of windows) {
    const arr = byStage.get(w.stage) ?? [];
    arr.push(w);
    byStage.set(w.stage, arr);
  }
  if (byStage.size === 0) {
    // 全是未配对/不可估窗的事件：仍报手工段计数（无耗时证据）
    aggregator.add({
      kind: "manual",
      included: true,
      skill,
      stage: majorityOf(exec.stages) ?? "unknown",
      step: null,
      role: null,
      model: null,
      status: outcome,
      skillVersion,
      taskKey: `observed:${exec.taskId}`,
      taskSource: "observed-taskid",
      attemptId: exec.executionId,
      attribution: "observed",
      usageAttribution: "unknown",
      durationMs: 0,
      tokens: null,
      evidence: [],
    });
    return;
  }
  for (const [stage, ws] of byStage) {
    aggregator.add({
      kind: "manual",
      included: true,
      skill,
      stage,
      step: null,
      role: null,
      model: null,
      status: outcome,
      skillVersion,
      taskKey: `observed:${exec.taskId}`,
      taskSource: "observed-taskid",
      attemptId: exec.executionId,
      attribution: "observed",
      usageAttribution: "unknown",
      durationMs: ws.reduce((s, w) => s + Math.max(0, w.endMs - w.startMs), 0),
      tokens: null,
      evidence: ws.map((w) => [w.startMs, w.endMs]),
    });
  }
}

// taskId 跨技能汇总（attempts = 去重后的 executionId / run 数）
function buildTaskRollup(records) {
  const tasks = new Map();
  for (const rec of records) {
    if (!rec.taskKey) continue;
    let t = tasks.get(rec.taskKey);
    if (!t) {
      t = {
        source: rec.taskSource ?? (rec.taskKey.startsWith("observed:") ? "observed-taskid" : "legacy-stem(estimated)"),
        attributionNote:
          rec.taskKey.startsWith("observed:")
            ? "跨技能/attempt 按 taskId 精确串联"
            : rec.taskKey.startsWith("arg:")
              ? "run args 显式 taskId（无观测文件关联）"
              : "legacy 词干估算标签，精度低于 observed-taskid",
        skills: {},
        skillVersions: new Set(),
        runs: 0,
        manualExecs: 0,
        actorSessions: 0,
        attempts: new Set(),
        evidence: [],
        durationSum: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, noncacheInput: 0, total: 0 },
        tokensKnown: false,
        attribution: { observed: 0, estimated: 0 },
      };
      tasks.set(rec.taskKey, t);
    }
    if (rec.skill) t.skills[rec.skill] = (t.skills[rec.skill] ?? 0) + 1;
    if (nonEmptyString(rec.skillVersion)) t.skillVersions.add(rec.skillVersion);
    if (rec.kind === "run") {
      t.runs += 1;
      t.durationSum += rec.durationMs ?? 0;
      if (rec.attemptId) t.attempts.add(rec.attemptId);
      t.attribution[rec.attribution] = (t.attribution[rec.attribution] ?? 0) + 1;
    } else if (rec.kind === "manual") {
      t.manualExecs += 1;
      if (rec.attemptId) t.attempts.add(rec.attemptId);
    } else if (rec.kind === "actor") {
      if (!rec.dupSession) t.actorSessions += 1;
      if (rec.tokens) {
        t.tokensKnown = true;
        for (const k of Object.keys(rec.tokens)) t.tokens[k] += rec.tokens[k];
      }
    } else if (rec.kind === "reconcile") {
      // run 级差额补齐用量随任务入账（不计会话）
      if (rec.tokens) {
        t.tokensKnown = true;
        for (const k of Object.keys(rec.tokens)) t.tokens[k] += rec.tokens[k];
      }
    }
    if (Array.isArray(rec.evidence)) t.evidence.push(...rec.evidence);
  }
  const out = {};
  for (const [key, t] of tasks) {
    out[key] = {
      source: t.source,
      attributionNote: t.attributionNote,
      skills: t.skills,
      skillVersions: [...t.skillVersions].sort(),
      runs: t.runs,
      manualExecs: t.manualExecs,
      actorSessions: t.actorSessions,
      attempts: t.attempts.size,
      elapsedMsUnion: t.evidence.length ? unionMs(t.evidence) : null,
      durationSum: t.durationSum,
      tokens: t.tokensKnown ? t.tokens : null,
      attribution: t.attribution,
    };
  }
  return out;
}

function buildPivot(records, groups) {
  const buckets = new Map();
  for (const rec of records) {
    const key = groups.map((g) => rec[g] ?? "(未归)").join("\u0001");
    let b = buckets.get(key);
    if (!b) {
      b = { dims: Object.fromEntries(groups.map((g) => [g, rec[g] ?? null])), recs: [] };
      buckets.set(key, b);
    }
    b.recs.push(rec);
  }
  const agg = new Aggregator();
  const rows = [...buckets.values()]
    .sort((x, y) => groups.map((g) => x.dims[g]).join("|").localeCompare(groups.map((g) => y.dims[g]).join("|")))
    .map((b) => ({ dims: b.dims, metrics: metricJson(agg.metrics(b.recs)) }));
  return { groups, rows };
}

function serializeSkillTree(bySkillRaw) {
  const out = {};
  for (const [skill, node] of Object.entries(bySkillRaw)) {
    const stages = {};
    for (const [stage, s] of Object.entries(node.stages)) {
      stages[stage] = {
        metrics: metricJson(s.metrics),
        steps: mapValue(s.steps, metricJson),
        roles: mapValue(s.roles, metricJson),
        models: mapValue(s.models, metricJson),
        statuses: mapValue(s.statuses, metricJson),
      };
    }
    out[skill] = { metrics: metricJson(node.metrics), stages };
  }
  return out;
}

// ── table 渲染 ──
function renderTable(report, opts) {
  const lines = [];
  const { scope, totals, pivot } = report;
  lines.push(`技能统一统计（${scope.includeSelftest ? "production+selftest" : "production"} 样本）`);
  lines.push(
    `范围：${scope.backends.join(" + ")}；技能：${scope.skills.join("/")}；观测根：${scope.observabilityRoot}` +
      (scope.since ? `；since ${scope.since}` : "") +
      (scope.until ? `；until ${scope.until}` : ""),
  );
  lines.push("");
  const { groups, rows } = pivot;
  const cov = (m) => `${m.usageCoverage.observed}/${m.usageCoverage.estimated}/${m.usageCoverage.unknown}`;
  const rowCells = (dims, m, isTotal) =>
    [
      ...(isTotal ? groups.map(() => "合计") : groups.map((g) => dims[g] ?? "(未归)")),
      String(m.runs),
      String(m.manualExecs),
      String(m.actorSessions),
      fmtDuration(m.elapsedMsUnion),
      fmtDuration(m.durationSum || null),
      fmtNum(m.tokens ? m.tokens.input : null),
      fmtNum(m.tokens ? m.tokens.output : null),
      fmtNum(m.tokens ? m.tokens.cacheRead : null),
      fmtNum(m.tokens ? m.tokens.cacheWrite : null),
      fmtNum(m.tokens ? m.tokens.noncacheInput : null),
      fmtNum(m.tokens ? m.tokens.total : null),
      cov(m),
    ].join(" | ");
  lines.push(`按 ${groups.join("×")} 汇总（经历=区间并集；耗时相加=run duration 累加；token 单位 1:1 计数；用量列=observed/estimated/unknown run 数）：`);
  lines.push([...groups, "runs", "手工段", "会话", "经历(并集)", "耗时相加", "input", "output", "cache_read", "cache_write", "noncache", "total", "用量观/估/未知"].join(" | "));
  for (const row of rows) lines.push(rowCells(row.dims, row.metrics, false));
  lines.push(rowCells(null, totals, true));
  lines.push("");
  const q = report.dataQuality;
  lines.push(
    `数据质量：坏行 ${q.badLines} / 缺字段事件 ${q.malformedEvents} / 未配对 start ${q.unpairedStarts} / 未配对 end ${q.unpairedEnds} / 未知事件 ${q.unknownEvents} / 声明 executionId 但缺观测文件 ${q.runsWithoutObservation} / taskId 不一致 ${q.taskIdMismatches} / token 不可对账 ${q.tokenReconcileNegative} / 归属零重叠 ${q.noOverlap} / 单阶段兜底 ${q.singleStageFallbacks} / 去重丢弃 run ${q.duplicateRunsDropped} / 排除自测 run ${q.selftestRunsExcluded} / 排除自测窗口 ${q.selftestWindowsExcluded} / 技能版本 unknown（observed run ${q.skillVersionUnknownObserved} / estimated run ${q.skillVersionUnknownEstimated} / 手工段 ${q.skillVersionUnknownManualExecs}）/ 产物版本读失败 ${q.artifactVersionReadFailed} / 产物缺版本字段 ${q.artifactVersionMissingField}`,
  );
  if (q.details.length) {
    lines.push("质量明细（截取前 10 条，全部见 JSON 报告 dataQuality.details）：");
    for (const d of q.details.slice(0, 10)) lines.push(`  - ${d}`);
  }
  lines.push(`unclassified run：${report.unclassified.count} 个（明细见 JSON 报告 unclassified.runs）`);
  const unlinkedRuns = report.runs.filter((r) => !r.taskKey).length;
  lines.push(
    `taskId 汇总：${Object.keys(report.byTask).length} 个任务组（observed/arg/legacy 词干来源分开标注，见 JSON 报告 byTask）；无 taskKey 的 run ${unlinkedRuns} 个`,
  );
  if (opts.output) lines.push(`完整 JSON 报告已写入：${opts.output}`);
  console.log(lines.join("\n"));
}

// ── 主流程 ──
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const obsRoot = join(homedir(), ".agents", "skill-data", "workflow-observability");

  // pi agentDir：用户给定的替换缺省 ~/.pi/agent；realpath 去重
  let defaultPiDir;
  try {
    defaultPiDir = realpathSync(join(homedir(), ".pi", "agent"));
  } catch {
    defaultPiDir = null;
  }
  let piDirs;
  if (opts.piAgentDirs.length) {
    piDirs = opts.piAgentDirs;
  } else if (defaultPiDir) {
    piDirs = [defaultPiDir];
  } else {
    fail(
      "缺省 pi 数据目录 ~/.pi/agent 不存在且未给 --pi-agent-dir——恢复动作：用 --pi-agent-dir <路径> 显式指定 pi 数据目录（pi 桌面端常在 ~/.taiji/agent；多目录可重复该参数）",
      1,
    );
  }
  const backends = [
    { kind: "zcode", label: "zcode" },
    ...piDirs.map((d) => ({ kind: "pi", agentDir: d, label: `pi(${d})` })),
  ];

  const quality = {
    badLines: 0,
    malformedEvents: 0,
    unpairedStarts: 0,
    unpairedEnds: 0,
    unknownEvents: 0,
    obsRootUnreadable: 0,
    duplicateRunsDropped: 0,
    runsWithoutObservation: 0,
    taskIdMismatches: 0,
    tokenReconcileNegative: 0,
    singleStageFallbacks: 0,
    noOverlap: 0,
    selftestRunsExcluded: 0,
    selftestWindowsExcluded: 0,
    unclassifiedRuns: 0,
    // 技能版本归因（--group skillVersion）：unknown 三档计数 + 产物读取失败/缺字段细分
    skillVersionUnknownObserved: 0,
    skillVersionUnknownEstimated: 0,
    skillVersionUnknownManualExecs: 0,
    artifactVersionReadFailed: 0,
    artifactVersionMissingField: 0,
    details: [],
  };

  const executions = loadObservations(obsRoot, quality);
  const aggregator = new Aggregator();
  const runSummaries = [];
  const unclassified = [];
  const platformRaw = [];
  const executionIdsSeen = new Set();

  let anyRuns = false;
  for (const backend of backends) {
    const payload = collectBackend(backend, opts.since, opts.until);
    const seenIds = new Set();
    const usedRuns = [];
    for (const run of payload.runs) {
      const id = String(run.id ?? "");
      if (id === "" || seenIds.has(id)) {
        quality.duplicateRunsDropped++;
        continue;
      }
      seenIds.add(id);
      usedRuns.push(run);
    }
    platformRaw.push({
      backend: backend.label,
      cliCount: typeof payload.count === "string" ? payload.count : String(payload.runs.length),
      runsUsed: usedRuns.length,
      duplicateDropped: payload.runs.length - usedRuns.length,
      sumOfRunRows: sumRunTokens(usedRuns),
      cliTotals: payload.totals ?? null,
      cliSkipped: payload.skipped ?? null,
    });
    if (usedRuns.length > 0) anyRuns = true;
    for (const run of usedRuns) {
      processRun(run, backend, opts, executions, aggregator, runSummaries, unclassified, quality, executionIdsSeen);
    }
  }

  // 观测执行文件中未被任何 run 匹配的 = 手工段（D0/D4/D6 等）或孤儿执行
  let manualCount = 0;
  for (const [executionId, exec] of executions) {
    if (executionIdsSeen.has(executionId)) continue;
    manualCount++;
    addManualExecution(exec, opts, aggregator, quality);
  }

  if (!anyRuns && manualCount === 0) {
    fail(
      `没有任何数据：各后端都零匹配且观测根无事件（观测根 ${obsRoot}）。恢复动作：① 放宽 --since/--until（示例 --since 2026-01-01）② 多 agentDir 机器用 --pi-agent-dir 显式指定（agent-session-reader doctor --pi 可列数据目录）③ 确认 zcode 库存在（agent-session-reader doctor --zcode）`,
      1,
    );
  }

  // ── 汇总（--skill 选中的技能；platformRaw 例外：平台对账口径不过滤）──
  const includedRecords = aggregator.records.filter((r) => r.included && opts.skills.includes(r.skill));
  const totals = aggregator.metrics(includedRecords);
  const bySkillRaw = {};
  for (const skill of opts.skills) {
    const recs = includedRecords.filter((r) => r.skill === skill);
    if (!recs.length) continue;
    const stageMap = new Map();
    for (const rec of recs) {
      const key = rec.stage ?? "(未归)";
      if (!stageMap.has(key)) stageMap.set(key, []);
      stageMap.get(key).push(rec);
    }
    const stages = {};
    for (const [stageName, srecs] of stageMap) {
      stages[stageName] = {
        metrics: aggregator.metrics(srecs),
        steps: aggregator.byDim(srecs, "step"),
        roles: aggregator.byDim(srecs, "role"),
        models: aggregator.byDim(srecs, "model"),
        statuses: aggregator.byDim(srecs, "status"),
      };
    }
    bySkillRaw[skill] = { metrics: aggregator.metrics(recs), stages };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scope: {
      skills: opts.skills,
      backends: backends.map((b) => b.label),
      piAgentDirs: piDirs,
      since: opts.since,
      until: opts.until,
      includeSelftest: opts.includeSelftest,
      observabilityRoot: obsRoot,
    },
    notes: [
      "token 取 agent-session-reader usage 的重算字段（tokensInput 含缓存、tokensOutput 含 reasoning、tokensNoncacheInput=input−缓存、tokensTotal=input+output）；不读 spent_tokens / tokensReported 自报值",
      "zcode tokensXxx 为本 run 新生消息口径：换模型重发 run 并入的 seed 继承消息单列在 usage 的 tokensXxxInherited（本报告不加总该字段），跨 run 合计因此不双计继承历史",
      "token 总量对账以 run 级重算值为准：唯一 actor 会话（同 run 内 session 去重，空 session 行按独立执行计）合计不足且全部分项差额非负时，差额合成 role=未归 的用量记录补齐（actorsNoSession/会话缺失场景）；total 为负或任一分项差额为负则不合成，保留 actor 合计并进 dataQuality.tokenReconcileNegative",
      "elapsedMsUnion=证据区间（actor 会话窗+节点窗，run 窗兜底）并集=日历实际经过；durationSum=run durationMs 相加；actorDurationSum/nodeDurationSum=actor/节点时长相加——并行口径分开报",
      "attribution: observed=executionId 精确关联观测 JSONL；estimated=legacy 分类器（run 名+args+actor 名）估算，精度低于 observed，两者恒分开不得相加视为同精度",
      "usageCoverage: observed/estimated=有 actor 用量证据的 run 数（按归因档）；unknown=无用量证据（含手工 D0/D4/D6——耗时照报，token 记 unknown 不写 0）",
      "legacy 自测样本只按明确名称（selftest/自测/冒烟）或临时路径 cwd 识别并标记 sampleTypeSource；缺省排除，--include-selftest 计入",
      "skillVersion 归因：observed 读事件自带 skill_version（事件回答谁在执行）；estimated 读 run 参数指向产物（execPlan / designDoc 内的 meta.json）的 skillVersion（产物回答谁产出）；读不到归 unknown 桶并计入 dataQuality（读失败 / 缺字段分开计），不伪造版本",
      "byTask.skillVersions 列出该 taskId 下出现过的全部技能版本（跨版本对比用；空数组 = 无版本证据）",
      "skill/stage 汇总里 legacy 阶段为分类器估算；observed run 的 step 来自观测窗口（actor/node 时间归属），legacy step 仅认 world-run 门禁命令特征",
    ],
    totals: metricJson(totals),
    bySkill: serializeSkillTree(bySkillRaw),
    byTask: buildTaskRollup(includedRecords),
    pivot: buildPivot(includedRecords, opts.groups),
    platformRaw,
    unclassified: { count: unclassified.length, runs: unclassified },
    dataQuality: quality,
    runs: runSummaries.filter((r) => r.included && opts.skills.includes(r.skill)),
    runsExcludedSelftest: runSummaries.filter((r) => !r.included),
  };

  if (opts.output) {
    try {
      mkdirSync(dirnameOf(opts.output), { recursive: true });
      writeFileSync(opts.output, JSON.stringify(report, null, 2));
    } catch (e) {
      fail(`报告写入失败（${opts.output}）：${e.message}——恢复动作：确认父目录可写或换 --output 路径后重试`, 1);
    }
  }

  if (opts.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderTable(report, opts);
  }
}

main();
