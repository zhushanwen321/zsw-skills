/* zcode-workflow
description: dev-flow-wf W2 通用 DAG 调度引擎（wave-executor）：读 exec-plan.json 做启动校验
  （schema/依赖环/文件存在性/工作区干净基线），依赖就绪节点流式派发（≤5 并发，wave 字段
  仅展示不参与调度），每节点确定性核验（files_changed ⊆ 声明范围 + 全量 status 粗粒度复核 +
  节点测试命令重跑）→ commit → 解锁后继；核验不过打回同名 agent 定向修（≤2 轮，超限
  blocked 且后继挂起）；acceptance 模式承载 verify/inspect 节点 + 验收失败修复循环
  （review-fix-loop 形态：failed 入失败池 → 聚合裁决 phase（跨节点同根因合并 + disputed
  反证 + 文件不相交分组）→ 修复组 phase（fixer 修产品代码与验收资产，引擎按组 commit）→
  节点重置重验回调度循环，≤3 轮不收敛按依赖可达性熔断；blocked 仍立即熔断）；终态
  completed / blocked / core-failed，全程 failed-as-return 不 throw。
whenToUse: dev-flow-wf 的 D1 开发循环与 D3 端到端验收发起本 workflow（CreateWorkflow path
  指向本文件 + args.execPlan）。exec-plan.json 由 D0 从设计包编译产出；断点恢复走
  ResumeWorkflowRun（node-<unitId> 命名保缓存）或按 status.json 人读恢复（git 为准）。
args:
  execPlan:
    type: string
    required: true
    description: exec-plan.json 绝对路径（D0 编译产出：nodes/依赖/范围声明/testCommand/promptFile/statusPath/commitTemplate/acceptance 分组）
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」
  executionId:
    type: string
    description: 本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测 JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId
  sampleType:
    type: string
    description: 观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行
*/

// ── 类型契约 ──

/** 节点任务书末尾定义的 JSON 契约（dev 与 inspect 节点共用） */
interface NodeResult {
  /** done = 本单元工作完成且自测通过；fail = 有未解决问题；blocked = 无法继续 */
  status: "done" | "fail" | "blocked";
  /** 改动文件路径（相对节点工作区 git 仓库根的 git 风格路径，须 ⊆ 任务书范围声明） */
  files_changed: string[];
  /** 自测证据：跑了什么命令、结果如何 */
  test_evidence: string;
  /** 与任务书的偏离说明（无偏离为空数组） */
  deviations: string[];
  /** 阻塞项（环境缺失/任务书矛盾等；非空则节点判 blocked，不进入打回） */
  blockers: string[];
  /** commit message {summary} 占位符的一句话摘要（缺省用固定短语） */
  summary?: string;
}

/** 确定性核验结论：pass=过 / retry=可打回修 / blocked=引擎层或环境问题（打回修不了） */
interface VerifyVerdict {
  outcome: "pass" | "retry" | "blocked";
  reason: string;
  detail: string;
}

/** 验收自愈归因结论（设计 §8.7）：三分类 + 证据 + 失败面文件集 */
interface HealVerdict {
  /** spec-bug=验收资产自身缺陷（可修复重验）/ product-bug=被测产品缺陷（不修，依赖判定）/ environment=超时资源类（重试一次） */
  class: "spec-bug" | "product-bug" | "environment";
  /** 一句话证据（引用失败输出原文） */
  evidence: string;
  /** 归因指向的文件（spec-bug 时为验收资产文件；product-bug 时为产品文件——只读呈报不修复） */
  failureFiles: string[];
  /** spec-bug 修复要点（可空串） */
  fixHint: string;
}

/** 验收资产修复自报（自报仅供历史记录，重验由引擎机器判定） */
interface HealFixReport {
  /** 实际修改的验收资产文件 */
  fixed: string[];
  /** 一句话修复说明 */
  summary: string;
}

/** 验收失败聚合条目（D3 修复循环：聚合裁决 agent 的输出单元） */
interface AcceptanceAggItem {
  /** AF-<round>-<序> */
  id: string;
  /** 覆盖的失败节点（fail-closed：失败池节点必须被恰好覆盖） */
  nodeIds: string[];
  title: string;
  /** fix=真实缺陷进修复组；disputed=归因误报反证（不修，随终态呈报人工裁决） */
  action: "fix" | "disputed";
  /** 根因一句话（disputed 时即反证：file:line + 归因漏了什么） */
  rootCause: string;
  /** 预期改动文件（组间判交依据；fix 时非空） */
  files: string[];
  /** 修复指导（随 per-fixer 任务文档直达修复者） */
  guidance: string;
}

/** 验收失败聚合裁决输出（修复分组：组间文件不相交，组内一个修复者） */
interface AcceptanceAggregation {
  items: AcceptanceAggItem[];
  groups: { id: string; itemIds: string[]; note: string }[];
}

/** 验收修复组自报（重验由引擎机器执行——节点重置重跑，不采信自报） */
interface AcceptanceFixReport {
  fixes: { itemId: string; files: string[] }[];
  disputed: { itemId: string; evidence: string }[];
  selfCheck: string;
}

interface TestCommand {
  program: string;
  args: string[];
}

/** 校验归一后的执行计划节点（路径全部绝对化；按 kind 只填对应字段） */
interface PlanNode {
  id: string;
  kind: "dev" | "verify" | "inspect";
  deps: string[];
  /** 设计章节锚（D0 从 impl-plan 章节映射提取；commit 渲染时前置于 summary——老三要素保真） */
  designRef: string;
  territory: string[];
  testCommand: TestCommand | null;
  promptFile: string;
  script: string;
  artifactsDir: string;
  artifactsRefs: string[];
  cwd: string;
}

interface ParsedPlan {
  version: number;
  mode: "dev" | "acceptance";
  projectRoot: string;
  statusPath: string;
  commitTemplate: string;
  baseline: string | null;
  nodes: PlanNode[];
}

type ValidateResult = { ok: true; plan: ParsedPlan } | { ok: false; errors: string[] };

/** status.json 单节点条目 */
interface StatusEntry {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed" | "suspended";
  attempts: number;
  commit?: string;
  evidence?: string;
}

interface StatusEvent {
  seq: number;
  node: string;
  event: string;
  detail?: string;
}

interface StatusFileData {
  baseline: string | null;
  nodes: Record<string, StatusEntry>;
  events: StatusEvent[];
  /** schema 外的顶层字段（name/updated 等 D0 产物）——回写时原样保留不抹除（§4.5） */
  extra: Record<string, unknown>;
}

/** 调度器内存态（崩溃恢复事实源是 status.json + git，不是这个 Map） */
interface NodeRt {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed";
  attempts: number;
  reason?: string;
  detail?: string;
  commit?: string;
}

/** workflow 终态（failed-as-return 的结构化载体） */
interface WaveExecutorOutcome {
  /** completed=全 done；blocked=存在 blocked/failed/挂起；core-failed=核心组熔断 */
  terminated: "completed" | "blocked" | "core-failed";
  done: string[];
  /** blocked（打回超限/自报 blockers/引擎层失败）与 failed（验收负结果）合记，reason 注明类型 */
  blocked: { id: string; reason: string; attempts: number }[];
  /** 因上游 blocked 或熔断而从未派发（依赖挂起）的节点 */
  skipped: string[];
  /** status.json 绝对路径（人读恢复入口；启动校验失败时为空串） */
  statusFile: string;
  /** core-failed 归因（哪个节点/什么输出）；非 core-failed 为 null */
  coreFailure: { id: string; detail: string } | null;
  /** 启动校验失败详情（terminated=blocked 且未派发任何节点时非 null） */
  validationError: string | null;
  /** 核验通过但 commit 被拒（多为仓库钩子全仓检查 × 并行半成品）转待办的节点——
   *  主 agent 收尾代提交（git commit <message> -- <files>，钩子照常执行） */
  deferredCommits: { id: string; message: string; files: string[]; err: string }[];
  /** 收尾全工作区对账后的清单外残留（不属于任何节点范围声明 ∪ 自报 files_changed 并集，
   *  含并行单元新建文件与未申报改动）——主 agent 判归属后处置（提交/清理/登记新范围声明） */
  residualFiles: string[];
  /** D3 验收失败修复循环记录（acceptance 模式且发生过失败聚合时非 null）：
   *  rounds = 实际执行的修复轮数；disputed = 聚合级与 fixer 级反证清单（人工裁决，
   *  对应节点保持 failed 不重置）；fixesDir = 聚合清单与 per-fixer 任务文档目录 */
  acceptanceFix: {
    rounds: number;
    disputed: { round: number; itemId: string; by: string; evidence: string }[];
    fixesDir: string;
  } | null;
}

interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}


// ── F 区平台钩子：zcode 同名续聊天然承载打回上下文，钩子原样返回打回指令 ──
function withPrevContext(initialPrompt: string, lastResult: NodeResult | null, retryPrompt: string): string {
  void initialPrompt;
  void lastResult;
  return retryPrompt;
}

// ── host 标识（run manifest host 字段，skill-data-redesign §5.1：shared 不留 host
// 硬编码，两壳各持常量）──
const HOST_PLATFORM = "zcode";

// ── O 区观测平台钩子：写通道 = world.run journal 语义（resume 重放回放首次记录值，
// 时间戳与事件序列跨 resume 稳定）。shared 观测层调用 obsNow/obsAppend；换平台只换
// 钩子实现，事件契约在 shared ──
const OBS_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
const OBS_APPEND_LINE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
async function obsNow(): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_PROBE_NOW]);
    const t = r.exitCode === 0 ? r.stdout.trim() : "";
    return t !== "" ? t : null;
  } catch {
    // 执行器故障（spawn 失败/超时）：观测降级为不记录该事件，业务不受影响
    return null;
  }
}
async function obsAppend(filePath: string, line: string): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_APPEND_LINE, filePath, line]);
    return r.exitCode === 0 ? null : `exit ${r.exitCode}：${r.stderr.trim() || r.stdout.trim()}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

@@STITCH@@
