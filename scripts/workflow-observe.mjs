#!/usr/bin/env node
// workflow-observe.mjs — workflow 观测事件记录命令（主 agent 与手工路径共用）
//
// 用途：给没有内建观测的 workflow 外步骤（dev-flow 的 D0 编译 / D4 收尾交付 / D6 交付后
// 守护等主 agent 直接执行的阶段）补同一套阶段事件，落点与 workflow 内建观测一致——
//   ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl
// 每次执行一个 JSONL 文件、逐行追加；行契约与 workflow 内建观测完全相同（改字段须同步
// workflows/src/observability.shared.ts 与 scripts/build-workflows.mjs 的 OBS_EVENT_FIELDS）：
//   {execution_id, task_id, skill, stage, step, round, attempt, event, timestamp,
//    sample_type[, skill_version][, outcome]}
// skill_version（增量可选字段，D6）：--skill-version <v> 传入时落该字段（D0/D4/D6 外部
// 步骤填所属技能 SKILL.md frontmatter version）；未传时不写字段——additive 契约，老调用
// 与老 JSONL（无该字段的行）不受影响。值语义 = 事件回答「谁在执行」：恒记本次执行的
// 引擎/技能当前版本，不因执行的产物缺版本字段改记 unknown（unknown 仅用于 stats 的
// estimated 口径归因桶）。
//
// 用法：
//   node scripts/workflow-observe.mjs start --task-id T --execution-id E --skill S \
//        --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] \
//        [--skill-version V]
//   node scripts/workflow-observe.mjs end   --task-id T --execution-id E --skill S \
//        --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] \
//        [--skill-version V] [--outcome R]
// 用法（统一运行入口 = 安装 symlink，dev-flow-dev 在任意项目运行都指向它）：
//   node ~/.agents/scripts/workflow-observe.mjs start --task-id T --execution-id E --skill S \
//        --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] \
//        [--skill-version V]
//   node ~/.agents/scripts/workflow-observe.mjs end   --task-id T --execution-id E --skill S \
//        --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] \
//        [--skill-version V] [--outcome R]
//   start = 阶段开始；end = 阶段结束。step=execution 的 end 是执行结束记录（--outcome 带
//   本次终态词，如 completed / converged / blocked）；中间 step 的自然结束不带 --outcome，
//   --outcome 只用于「终态统一补记的 end」（中间步骤自然结束不带 outcome）。
//
// 退出码：0 = 已写入；2 = 用法/参数错误（stderr 含恢复动作）；1 = 落盘失败。
// 本命令自身就是观测通道，写失败如实报错退出（不存在「拖垮业务」问题——调用方决定
// 如何处置；workflow 内建观测的降级语义见 workflows/src/observability.shared.ts 头注）。
// 安装：~/.agents/scripts/workflow-observe.mjs 为本文件的 symlink；同目录
// workflow-observability.shared.ts → workflows/src/observability.shared.ts 供其他构建器复用。

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `用法（~ 由 shell 展开；任意项目运行同一入口）：
  node ~/.agents/scripts/workflow-observe.mjs start --task-id T --execution-id E --skill S --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] [--skill-version V]
  node ~/.agents/scripts/workflow-observe.mjs end   --task-id T --execution-id E --skill S --stage G --step P [--round N] [--attempt N] [--sample-type production|selftest] [--skill-version V] [--outcome R]`;

// 必填契约字段（每条事件必须齐备，构造后机器核对）；可选字段见 OBS_EVENT_OPTIONAL_FIELDS。
// build-workflows.mjs 的 OBS_EVENT_FIELDS 为契约全集（必填 + 可选），三源同步锚之一
const OBS_EVENT_FIELDS = [
  "execution_id",
  "task_id",
  "skill",
  "stage",
  "step",
  "round",
  "attempt",
  "event",
  "timestamp",
  "sample_type",
];
// 可选契约字段（增量可选，additive）：仅调用方传对应旗标时写入，缺省不落字段——
// 老 JSONL（无该字段的行）与不带旗标的存量调用都合法；skill_version 由 --skill-version 提供
const OBS_EVENT_OPTIONAL_FIELDS = ["skill_version"];

// 进程内退出信号：main 内的 fail 以异常模拟 process.exit（进程内调用方不能被真的杀掉）；
// CLI 壳在进程外按返回码 process.exit——两通道退出码契约一致（0/1/2，见文件头）
class ObserveExit extends Error {
  constructor(code) {
    super(`observe-exit-${code}`);
    this.exitCode = code;
  }
}

/**
 * 进程内入口（最小导出垫片；CLI 与测试对拍共用同一份参数解析与落盘逻辑）。
 * @param {string[]} argv 子命令与旗标（不含 node 路径与脚本路径，即 process.argv.slice(2)）
 * @param {{home?: string}} opts home = 落盘根；缺省取 homedir()（与 CLI 的 $HOME 语义一致）
 * @returns {{code: number, stdout: string, stderr: string}} code = 退出码（0 已写入 / 2 用法错 / 1 落盘失败）
 */
export function main(argv = process.argv.slice(2), { home } = {}) {
  let stdout = "";
  let stderr = "";
  const fail = (message, code) => {
    stderr += `${message}\n恢复动作：${USAGE}\n`;
    throw new ObserveExit(code);
  };

  try {
    // 帮助入口先于子命令校验（裸 --help / -h 直接打印用法 exit 0）
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout += `${USAGE}\n`;
      return { code: 0, stdout, stderr };
    }

    const event = argv[0];
    if (event !== "start" && event !== "end") {
      fail(`未知子命令 ${JSON.stringify(argv[0] ?? "")}（合法：start / end）`, 2);
    }

    // 选项白名单：未知 flag 拒绝（拼错的参数被静默忽略会让事件字段失真）
    const KNOWN_FLAGS = new Set(["task-id", "execution-id", "skill", "stage", "step", "round", "attempt", "sample-type", "skill-version", "outcome"]);

    const opts = {};
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i];
      if (!key.startsWith("--") || i + 1 >= argv.length) {
        fail(`参数形态非法：${JSON.stringify(key)}（须为 --key value 成对出现）`, 2);
      }
      const k = key.slice(2);
      if (!KNOWN_FLAGS.has(k)) fail(`未知参数 ${key}（合法：${[...KNOWN_FLAGS].map((f) => `--${f}`).join(" ")}）——拼错的参数会被静默忽略，故拒绝`, 2);
      if (k in opts) fail(`参数 ${key} 重复出现`, 2);
      opts[k] = argv[i + 1];
    }

    // ID 命名规则与 workflows/src/*.shared.ts 的 obsSafeId 同一契约：task-id 是观测根下
    // 的目录名、execution-id 是文件名主干——仅放行字母数字开头、只含字母/数字/点/连字符/
    // 下划线、≤128 字符、无连续点与结尾点的值，路径穿越形态一律拒绝
    const safeId = (v) =>
      typeof v === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) &&
      !v.includes("..") &&
      !v.endsWith(".")
        ? v
        : null;

    const taskId = safeId(opts["task-id"]);
    const executionId = safeId(opts["execution-id"]);
    if (taskId === null) fail("--task-id 缺失或含路径不安全字符（合法形态：字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」与结尾点）", 2);
    if (executionId === null) fail("--execution-id 缺失或含路径不安全字符（命名规则同 --task-id）", 2);

    const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
    for (const k of ["skill", "stage", "step"]) {
      if (!nonEmpty(opts[k])) fail(`--${k} 必填且须为非空字符串（记录事件归属；workflow 外步骤填所属技能 canonical 名，如 skill=dev-flow-dev stage=D0 step=compile）`, 2);
    }

    const intOpt = (name) => {
      const raw = opts[name];
      if (raw === undefined) return null;
      if (!/^\d+$/.test(raw.trim())) fail(`--${name} 须为非负整数（收到 ${JSON.stringify(raw)}）`, 2);
      const n = Number(raw.trim());
      if (!Number.isSafeInteger(n)) fail(`--${name} 超出安全整数范围（收到 ${JSON.stringify(raw)}）——轮次与序号不会这么大，核对是否抄错`, 2);
      return n;
    };
    const round = intOpt("round");
    const attempt = intOpt("attempt");

    let sampleType = "production";
    if (opts["sample-type"] !== undefined) {
      if (opts["sample-type"] !== "production" && opts["sample-type"] !== "selftest") {
        fail(`--sample-type 非法（合法值：production / selftest；收到 ${JSON.stringify(opts["sample-type"])}）`, 2);
      }
      sampleType = opts["sample-type"];
    }

    let outcome = null;
    if (opts.outcome !== undefined) {
      if (event !== "end") fail("--outcome 只在 end 子命令有意义（附在事件上标记本次执行终态）；start 不接受该参数", 2);
      if (!nonEmpty(opts.outcome)) fail("--outcome 须为非空字符串（本次执行的终态词，如 completed / converged / blocked）", 2);
      outcome = opts.outcome.trim();
    }

    // 可选字段 skill_version（OBS_EVENT_OPTIONAL_FIELDS 唯一成员）：传了就写、没传不写
    // 字段（additive）；start/end 都可携带（外部步骤的 begin 与终态补记 end 各自声明版本）
    let skillVersion = null;
    if (opts["skill-version"] !== undefined) {
      if (!nonEmpty(opts["skill-version"])) {
        fail("--skill-version 须为非空字符串（本次执行的技能版本，取所属技能 SKILL.md frontmatter version；不传 = 不写 skill_version 字段）", 2);
      }
      skillVersion = opts["skill-version"].trim();
    }

    // ── 构造事件并落盘 ──
    const rec = {
      execution_id: executionId,
      task_id: taskId,
      skill: opts.skill.trim(),
      stage: opts.stage.trim(),
      step: opts.step.trim(),
      round,
      attempt,
      event,
      timestamp: new Date().toISOString(),
      sample_type: sampleType,
    };
    if (outcome !== null) rec.outcome = outcome;
    if (skillVersion !== null) rec.skill_version = skillVersion;
    for (const f of OBS_EVENT_FIELDS) {
      if (!(f in rec)) fail(`内部错误：事件缺契约字段 ${f}（OBS_EVENT_FIELDS 与构造不一致——修本脚本）`, 1);
    }
    for (const f of OBS_EVENT_OPTIONAL_FIELDS) {
      if (f in rec && typeof rec[f] !== "string") fail(`内部错误：可选契约字段 ${f} 非字符串（OBS_EVENT_OPTIONAL_FIELDS 与构造不一致——修本脚本）`, 1);
    }

    const jsonlPath = join(
      home ?? homedir(),
      ".agents",
      "skill-data",
      "workflow-observability",
      taskId,
      `${executionId}.jsonl`,
    );
    try {
      mkdirSync(dirname(jsonlPath), { recursive: true });
      appendFileSync(jsonlPath, `${JSON.stringify(rec)}\n`);
    } catch (e) {
      stderr += `观测事件写入失败（${jsonlPath}）：${e && e.message ? e.message : String(e)}。恢复动作：确认该路径父目录可写（或换 --execution-id）后重试\n`;
      throw new ObserveExit(1);
    }
    stdout += `已记录 ${event} 事件 → ${jsonlPath}\n`;
    return { code: 0, stdout, stderr };
    } catch (e) {
      if (e instanceof ObserveExit) return { code: e.exitCode, stdout, stderr };
      throw e;
    }
}

// CLI 壳：仅作为主模块直接运行时执行（被 import 时跳过——进程内调用方走 main，不能被
// 壳的 process.exit 杀掉）。argv[1] 与模块路径经 realpath 归一，兼容统一运行入口 symlink
//（~/.agents/scripts/workflow-observe.mjs → 本文件）
const isMainModule =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMainModule) {
  const cliResult = main();
  if (cliResult.stdout !== "") process.stdout.write(cliResult.stdout);
  if (cliResult.stderr !== "") process.stderr.write(cliResult.stderr);
  process.exit(cliResult.code);
}

