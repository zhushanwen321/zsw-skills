// ============================================================================
// resilience.shared.ts — DEV 加固线韧性层（单一构建输入；仅拼进三个 delivery-dev
// workflow，构建器按 RESILIENCE_WORKFLOWS 登记，业务 shared 禁止拷贝副本）。
// 三条职责：
//   1. askGuarded：agent 调用的结构校验 + 修正重问。首次返回非法或抛异常时，携修正
//      提示（失败原因 + 期望结构）以完整自包含 prompt 重问（pi 无续聊，重问不依赖
//      上一轮上下文——修正提示附加在原 prompt 尾部，不是新任务）。正常路径 = 首答即
//      合法（业务 prompt 已写明返回结构）；重问是兜底，预算 maxTries（缺省 2 =
//      首发 + 1 次修正重问，上限 3）。askOnce 内可做文件级后验（如「报告已写入」），
//      不满足时抛异常同样进入修正重问。
//   2. retryOnSpawnFailure：CLI 只读/幂等命令（evaluate、revision、snapshot-policy、
//      validate-acceptance）的 spawn 级失败（world.run 抛出被包装为 exitCode -1）重试
//      一次。语义性失败（exit N>0）不自动重试——gate 报错自带恢复动作，由调用方回喂
//      或终态。**变更类命令（append / lease-*）不套用**：append 按 eventId 判重幂等
//      （同事件重放安全，见 delivery-gate appendEvent）、lease-release 对无租约幂等，
//      但 lease-acquire 重试会递增代次并终止旧持有者（非幂等）；且超时被杀时无法确认
//      命令是否已写入，不重试保持保守正确。
//   3. recordRepair：自修复登记。逐条追加 <taskDir>/self-repairs.jsonl 并内存计数，
//      repairSummary() 生成终态上报块（由 workflow 终态 message 携带给主 agent，
//      转述用户）。兜底被触发这件事本身必须可见，不允许静默修复。写通道与观测层
//      obsAppend 同款 world.run——zcode journal 语义下 resume 重放回放首次记录值、
//      不重复写行；pi spawnSync 每次实写、无 resume 重放场景（见 observability.shared.ts
//      平台注释）。
// 层自身不派 agent、不抛异常：登记失败只告警（同文件一次），不拖垮业务。
// 与观测层（observability.shared.ts）的分工：观测记「阶段边界」（谁在何时跑到哪），
// 本层记「执行韧性事件」（哪次调用失败、如何修正、是否恢复）——字段独立，互不代读。
// ============================================================================

/** 修正动作类型（值词表：见 RepairKind 各值的注释语义） */
type RepairKind = "agent-structure-retry" | "agent-error-retry" | "cli-retry";
/** recovered = 重问/重试后恢复；exhausted = 预算耗尽仍失败（调用方按终态处理） */
type RepairOutcome = "recovered" | "exhausted";

/** 韧性事件核心字段（at 与 outcome 在登记时补齐）：
 *   kind 语义——agent-structure-retry = 返回结构非法后的修正重问；agent-error-retry =
 *   调用抛异常（含 askOnce 内文件后验失败）后的重问；cli-retry = CLI spawn 级失败重试。
 *   workflow = 名（acceptance-design-dev 等）；step = 阶段内步骤名（execute / review /
 *   finalize…，与观测 step 词表同源）；round = 循环轮次（非循环环节 null）；
 *   target = 被修正对象（agent 名或 CLI 命令名）；trigger = 一句话失败原因 */
interface RepairCore {
  workflow: string;
  step: string;
  round: number | null;
  kind: RepairKind;
  target: string;
  trigger: string;
}

/** 韧性事件登记条目（self-repairs.jsonl 每行一个该形状对象） */
interface RepairEntry extends RepairCore {
  /** ISO 时间戳（时间探针失败时为空串，条目仍登记） */
  at: string;
  outcome: RepairOutcome;
}

/** CLI 命令结果（与各业务 shared 的 CommandResult 结构兼容的最小形态） */
interface ResilientCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let repairsJournalPath = "";
const repairCounts: Record<string, number> = {};
let repairsWarnedWrite = false;

function resilienceErrorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 当前 ISO 时间（经 world.run 探针；失败返回空串——登记不因此中断） */
async function repairTimestamp(): Promise<string> {
  try {
    const r = await world.run("node", ["-e", "process.stdout.write(new Date().toISOString())"]);
    return r.exitCode === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** 韧性登记启用：taskDir 为空（setup 早期失败）时不落盘，仅内存计数 */
function initResilience(taskDir: string): void {
  repairsJournalPath = taskDir === "" ? "" : `${taskDir}/self-repairs.jsonl`;
}

/** 登记一条韧性事件（JSONL 追加 + 内存计数；写失败只告警一次） */
async function recordRepair(core: RepairCore, outcome: RepairOutcome): Promise<void> {
  repairCounts[core.kind] = (repairCounts[core.kind] ?? 0) + 1;
  if (repairsJournalPath === "") return;
  try {
    const at = await repairTimestamp();
    const line = JSON.stringify({ at, ...core, outcome });
    const r = await world.run("node", [
      "-e",
      "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')",
      repairsJournalPath,
      line,
    ]);
    if (r.exitCode !== 0 && !repairsWarnedWrite) {
      repairsWarnedWrite = true;
      log(`WARN: 自修复登记写入失败（${repairsJournalPath}）：${(r.stderr || r.stdout).trim()}——同类失败不再告警，计数仍进终态上报。恢复动作：确认任务目录可写`);
    }
  } catch (e) {
    if (!repairsWarnedWrite) {
      repairsWarnedWrite = true;
      log(`WARN: 自修复登记写入异常（${repairsJournalPath}）：${resilienceErrorText(e)}——同类失败不再告警，计数仍进终态上报。恢复动作：确认 node 可执行后重跑`);
    }
  }
}

/** 终态上报块：零修复返回空串（正常路径不加噪音）；有修复时生成披露块 */
function repairSummary(): string {
  const total = Object.values(repairCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return "";
  const parts = Object.entries(repairCounts).map(([kind, n]) => `${kind} ${n}`);
  // 登记写入曾失败（repairsWarnedWrite）后明细文件可能空或残缺：终态块自身声明明细
  // 不可信，主 agent 转述时不指向可能不存在的逐条明细
  const detailNote = repairsWarnedWrite
    ? `逐条明细写入曾失败（${repairsJournalPath || "任务目录不可用"}），可能不完整，仅计数可信`
    : `逐条明细 ${repairsJournalPath || "（任务目录不可用，仅计数）"}`;
  return (
    `；自修复兜底被触发：共 ${total} 条（${parts.join(" / ")}），${detailNote}——主 agent 请向用户披露本块`
  );
}

/** 修正提示文本：附加在原 prompt 尾部（数据，不是指令替换） */
function correctivePrompt(error: string): string {
  return `上一次执行未通过校验：${error}。请在完成原任务的前提下修正该问题并重新返回（本条是修正提示，不是新任务；返回结构必须与原要求一致）。`;
}

interface AskGuardMeta {
  workflow: string;
  step: string;
  round: number | null;
  /** agent 名（登记 target 用） */
  target: string;
  /** 总尝试次数：缺省 2（首发 + 1 次修正重问），钳位 1..3 */
  maxTries?: number;
}

interface AskGuardResult<T> {
  ok: boolean;
  value: T | null;
  /** 最后一次实际返回的原始值（未通过校验也保留——耗尽分支可从中挽救部分数据，
   *  如已申报 findings；末次尝试抛异常时保留此前返回值）；全程异常（从未成功
   *  返回）时为 null */
  raw: T | null;
  /** ok=false 时的一句话终因（已含重问耗尽说明） */
  error: string;
}

/**
 * askGuarded：agent 调用的结构校验 + 修正重问。
 * - askOnce(corrective)：corrective 为 null = 首次（原始 prompt）；非 null = 修正重问
 *   （原始 prompt + 修正提示）。askOnce 内的文件级后验失败以抛异常表达（进入修正重问）。
 * - validate(value)：返回 "" = 合法；否则为结构错误文本（进入修正重问）。校验器自身
 *   抛异常同样按结构非法处理（不穿透本层）。
 * - 全部尝试耗尽 → { ok: false, raw = 最后一次尝试的返回值 }，由调用方走原有终态路径
 *   （本校验不替代业务裁决），耗尽分支可从 raw 挽救部分数据（如已申报 findings）。
 * 每次失败登记一条韧性事件；后续尝试恢复则 outcome=recovered，耗尽为 exhausted。
 */
async function askGuarded<T>(
  askOnce: (corrective: string | null) => Promise<T>,
  validate: (value: T) => string,
  meta: AskGuardMeta,
): Promise<AskGuardResult<T>> {
  const maxTries = Math.min(Math.max(meta.maxTries ?? 2, 1), 3);
  const pending: RepairCore[] = [];
  let lastError = "";
  let lastReturned: T | null = null;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    let value: T;
    try {
      value = await askOnce(attempt === 1 ? null : correctivePrompt(lastError));
    } catch (e) {
      lastError = `调用抛出异常：${resilienceErrorText(e)}`;
      // 不清空 lastReturned：混合路径（首答返回非法结构、重问抛异常）耗尽时保留
      // 首答已返回值供调用方挽救（与 raw=null 仅限全程异常的接口注释一致）
      pending.push({ workflow: meta.workflow, step: meta.step, round: meta.round, kind: "agent-error-retry", target: meta.target, trigger: resilienceErrorText(e) });
      continue;
    }
    // 校验器自身异常同样兜住（校验器对畸形输入可能解引用抛 TypeError）：按结构非法
    // 进修正重问/耗尽路径，不允许穿透本层——穿透会使已登记的 pending 不落 JSONL、
    // workflow 崩溃无终态 message、fail 出口的租约释放全部被绕过
    let structureError = "";
    let validatorCrashed = false;
    try {
      structureError = validate(value);
    } catch (e) {
      validatorCrashed = true;
      structureError = `校验器异常：${resilienceErrorText(e)}`;
    }
    if (structureError === "") {
      for (const entry of pending) await recordRepair(entry, "recovered");
      return { ok: true, value, raw: value, error: "" };
    }
    lastError = validatorCrashed ? `返回结构非法（${structureError}）` : `返回结构非法：${structureError}`;
    lastReturned = value;
    pending.push({ workflow: meta.workflow, step: meta.step, round: meta.round, kind: "agent-structure-retry", target: meta.target, trigger: structureError });
  }
  for (const entry of pending) await recordRepair(entry, "exhausted");
  return { ok: false, value: null, raw: lastReturned, error: `${lastError}（含修正重问共 ${maxTries} 次尝试后耗尽）` };
}

/** CLI spawn 级失败重试（仅只读/幂等命令；变更类命令见文件头注释）。exitCode -1 重试一次 */
async function retryOnSpawnFailure(
  runOnce: () => Promise<ResilientCommandResult>,
  meta: { workflow: string; step: string; round: number | null; command: string },
): Promise<ResilientCommandResult> {
  const first = await runOnce();
  if (first.exitCode !== -1) return first;
  const second = await runOnce();
  const outcome: RepairOutcome = second.exitCode === 0 ? "recovered" : "exhausted";
  await recordRepair({
    workflow: meta.workflow,
    step: meta.step,
    round: meta.round,
    kind: "cli-retry",
    target: meta.command,
    trigger: `spawn 级失败（exit -1）：${first.stderr.trim() || first.stdout.trim() || "无输出"}`,
  }, outcome);
  return second;
}
