/* zcode-workflow
description: tech-design-v6 技能 W1 设计文档审查循环：缺省四席并行审查（方向审席 +
  主审/影响面审/简洁审，R1 全面审、R2+ 聚焦复审逐条对账——方向审 patch 档发现随当轮
  问题清单进入聚合）；task.json deliveryProfile=a 时固定两席（方向审 + 主审兼契约主审，
  跳过影响面审/简洁审；读不到字段缺省 b 不降档）→ 外部契约任务的能力清单与权威快照
  摘要进方向审与主审输入（核对自建接口 / vendored 类型 / mock 契约与 authority surface
  的一致性）→ 聚合裁决独立 phase（各审查席发现按同根因合并为去重权威清单
  aggregated.md，refs 精确划分脚本 fail-closed 校验）→ 文档修复者单 agent 据聚合
  清单修复 + 处置表产出（dispositions.json/md）→ 循环至
  converged / escalated / stuck / max-rounds；
  方向审 rewrite 档（问题定义/方案主干/分型被击穿）整循环立即终止回 T1。审查读设计目录内章节 JSON 渲染出的
  rendered.md（setup 跑 check-design-doc.mjs 进场校验 + render-design-doc.mjs 刷新视图），
  修复者直接编辑章节 JSON 并在修改后重渲染。产物落
  ~/.agents/skill-data/tech-design/<project-slug>/<设计名>/（round-N[.attemptM]/ 子目录），
  终态档案 final.json。终态判定 / 覆盖校验 / stuck 计数全部脚本侧完成，不信任 agent 自报收敛
whenToUse: tech-design-v6 技能 W1 阶段——技术设计文档（tech-design 产物，分章节 JSON 形态）
  需要对抗式审查修复循环时调用；必传 designDoc（设计目录绝对路径，或其渲染 md 路径——内部
  归一为设计目录；修复者直接编辑章节 JSON）与 projectRoot（项目根绝对路径）。不用于代码
  review-fix 循环（用 saved review-fix-loop）
args:
  designDoc:
    type: string
    description: 设计目录绝对路径（内含六个章节 JSON 权威源；修复者直接编辑章节 JSON 完成
      修复）或其渲染 md 路径（以 .rendered.md 结尾时内部归一为设计目录）；存量 md 单文件
      设计包不受支持——进场校验（check-design-doc.mjs）会输出迁移指引
    required: true
  projectRoot:
    type: string
    description: 项目根绝对路径（AGENTS/PRODUCT 上下文提示来源 + skill-data 审查产物目录的 project-slug 计算输入）
    required: true
  maxRounds:
    type: number
    description: 审查-修复循环轮次上限（含首轮全面审；四席同轮并行）
    default: 10
  reviewers:
    type: json
    description: 自定义 reviewer 模板绝对路径数组，按文件 basename 覆盖同名维度
      （tech-design-direction-review.md / tech-design-review-v6.md /
      tech-design-impact-review.md / tech-design-simplicity-review.md）；
      未匹配任何维度的条目忽略并告警
  attempt:
    type: number
    description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；
      缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取
      已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）。不得设 default——
      default 数值会被引擎物化成显式值、吞掉「未传」形态，自动检测失效，重发起时
      轮次目录无 attempt 后缀、覆盖首轮产物（实测：省略参数 → 引擎填 1）
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其
      一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，只含字母、数字、点、
      连字符、下划线，≤128 字符，禁「..」
  executionId:
    type: string
    description: 本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测
      JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId
  sampleType:
    type: string
    description: 观测样本类型（可选）——production = 真实执行（缺省）／selftest = 测试执行
*/

// ── 结果与中间类型（JSDoc 作为字段描述注入子 agent） ──

interface DirectionVerdict {
  /** must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验） */
  mustFix: number;
  /** 打回档位：patch = 全部发现属前提层/产物表/措辞级（进当轮问题清单，由文档修复者处置）；
   *  rewrite = 问题定义/方案主干/分型被击穿（整循环立即终止回 T1）。mustFix = 0 时不消费 */
  fixScope: "patch" | "rewrite";
  /** 逐条问题清单（打回判定与计数派生的唯一事实源；条目无 level 字段——唯一级别是
   *  must-fix；条数合计须等于 mustFix） */
  problems: ProblemRef[];
  /** R1 恒空数组；R2+ 对上轮处置表必对账集逐条申报（与三审同契约） */
  reconciliation: ReconEntry[];
  /** 一句话方向判定（终态档案 oneliner 字段来源） */
  oneliner: string;
}

interface ReconEntry {
  /** 上轮处置表条目 id（R1 恒返回空数组；R2+ 对注入的必对账集逐条申报） */
  prevId: string;
  /** fixed = 亲自读文档核实已修复；not-fixed = 仍存在（计入 mustFix）；regressed =
   *  修复复发或引入新问题（计入 mustFix）；escalate = 登记/归档条目上下文被本轮
   *  修复改变，申报复活（唯一复活通道，报告正文里的文字申报不处理） */
  status: "fixed" | "not-fixed" | "regressed" | "escalate";
  /** 读了文档哪里、确认了什么（原文事实）；fixed 申报不带实证不采信 */
  evidence: string;
}

interface ProblemRef {
  /** 报告内问题锚点，格式 review-<维度>#<序>（如 review-main#2 / 方向审 review-direction#<序>），与报告小节标题/表格行一致 */
  ref: string;
  /** 一句话问题标题 */
  title: string;
}

interface ReviewerVerdict {
  /** must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验） */
  mustFix: number;
  /** 逐条问题清单（处置表覆盖校验的对账锚点；条目无 level 字段——唯一级别是 must-fix；
   *  条数须与 mustFix 计数一致） */
  problems: ProblemRef[];
  /** R1 恒空数组；R2+ 对上轮处置表必对账集逐条申报 */
  reconciliation: ReconEntry[];
}

interface Disposition {
  /** 处置条目 id（新条目 D-<轮>-<序>；延续条目复用上轮原 id） */
  id: string;
  /** 一句话问题标题（跨轮对账锚点） */
  title: string;
  /** 该条合并覆盖的原始问题引用（如 review-main#2；同根因跨维度合并时多个来源并列） */
  source: string[];
  /** fixed = 已修复 / deferred = 登记不修 / archived = 归档 */
  action: "fixed" | "deferred" | "archived";
  /** 修订位置（设计文档章节/锚点） */
  location: string;
  /** 反例重演：该问题如何被发现，修复后在修订稿上重演验证已消除 */
  reenactment: string;
  /** 攻击点建议：给下轮聚焦复审的优先检查方向 */
  attackHints: string;
  /** 影响决策：该问题影响哪些设计决策（必填，无影响也显式写「无」） */
  affectsDecision: string;
  /** 影响交付：该问题影响哪些交付物/验收（必填，无影响也显式写「无」） */
  affectsDelivery: string;
}

interface FixOutcome {
  /** 本轮结论声明（必填，二选一，判别键）：
   *  "done" = 修复与处置完成、无方案性卡点——返回体不得携带 blocked 字段
   *  "blocked" = 存在修不动、需用户裁决的方案性分歧——必须携带 blocked 字段 */
  status: "done" | "blocked";
  /** 本轮处置表全部条目（含延续与新增） */
  dispositions: Disposition[];
  /** 一段修订摘要：本轮改了设计文档哪些地方（注入下轮 reviewer，不算证据） */
  revisionSummary: string;
  /** 仅 status="blocked" 时携带：items=卡住的问题清单，reason=为什么需要用户裁决。
   *  不是表态字段——引擎只认 status，done 形态下附带该字段一律无效 */
  blocked?: { items: string[]; reason: string };
}


interface AggregatedItem {
  /** 该聚合项覆盖的原始问题 ref（四席报告锚点，至少一个；全体聚合项的 refs 构成原始清单的精确划分） */
  refs: string[];
  /** 一句话根因标题 */
  title: string;
  /** 合并后的可执行修复操作清单（改哪个章节 JSON 哪个条目、补什么内容、跑什么检索） */
  guidance: string;
  /** V6 代关键决策分级（裁决规则 2026-11-15）：critical=影响关键 ADR/关键设计决策（分型、
   *  公理/不变量、问题定义、方案主干、关键决策的前提失实或矛盾、影响决策走向的事实错误），
   *  进修复循环参与收敛计数；minor=不影响关键决策（登记缺口、产物表完备性、非关键措辞、
   *  实施期探针补登记），不进循环，跨轮收集至 minor-findings.json 最后一波统一处理 */
  impact: "critical" | "minor";
  /** minor 必须给出行为后果否决论证：不会发生 / 用户不可观察 / 验收明确允许，三择一 */
  consequenceRefutation?: string;
  /** minor 必填：论证类型三择一（合并稿 §9：先标类型再给依据，缺类型即结构校验失败） */
  consequenceRefutationType?: "will-not-occur" | "not-observable" | "accepted-by-acceptance";
  /** 改判理由（护栏：聚合项覆盖的任一 ref 分级与上轮不同时必填——连续改判不附理由即结构校验失败） */
  regradeReason?: string;
}

interface AggregationOutcome {
  /** 聚合项清单（去重后权威问题清单，脚本渲染为 aggregated.md） */
  items: AggregatedItem[];
}

interface LoopResult {
  /** converged = 收敛；direction-rejected = 方向审 rewrite 档打回；escalated = 方案性卡点停回用户；
   *  stuck = must-fix 连续多轮不降；max-rounds = 轮次上限耗尽；
   *  setup-failure / review-failure / aggregator-failure / fix-failure = 环节失败（message 含恢复动作） */
  terminated: "converged" | "direction-rejected" | "escalated" | "stuck" | "max-rounds" | "setup-failure" | "review-failure" | "aggregator-failure" | "fix-failure";
  /** 实际执行的审查轮数（四席同轮并行，均计入轮次；converged 记收敛轮） */
  rounds: number;
  /** 审查产物根目录（绝对路径；setup-failure 早期可能为空串） */
  runDir: string;
  /** 审查对象设计目录（绝对路径；渲染 md 输入已归一——目录内章节 JSON 为权威源） */
  designDoc: string;
  /** 方向审一句话判定（final.json 对外字段名 = oneliner；未跑到方向审时为空串） */
  directionOneliner: string;
  /** 每轮三报告 must-fix 总和轨迹（下标 0 = 第 1 轮） */
  mustFixTrajectory: number[];
  /** 终态仍未收敛/未复核的条目（stuck/max-rounds 残余风险矩阵的输入）；
   *  V6 代加 guidance/reportRefs（最后一次聚合的可执行处方与报告锚点——主 agent
   *  按清单直接处置，不必再派复审 run 回读报告） */
  remaining: { id: string; title: string; status: string; attackHints: string; guidance: string; reportRefs: string[] }[];
  /** V6 代关键决策分级：跨轮收集的 minor 项（不影响关键决策，不进循环）；
   *  空数组 = 无 minor 项或未进入聚合阶段 */
  minorFindings: { round: number; refs: string[]; title: string; guidance: string }[];
  /** escalated 时的方案性卡点（其余终态为 null） */
  blocked: { items: string[]; reason: string } | null;
  /** 一句话终态说明；失败态与停回态含恢复动作/停回通道 */
  message: string;
}

interface LedgerEntry extends Disposition {
  /** open = 待修复（含 not-fixed/regressed/escalate 复活）；
   *  pending = 已处置待下轮复核；confirmed = 复核实证确认；
   *  parked = 登记不修/归档（退出修复队列，escalate 可复活） */
  status: "open" | "pending" | "confirmed" | "parked";
  /** 首次入账轮次 */
  firstRound: number;
  /** 最近一次处置轮次 */
  lastRound: number;
}

interface NarrowedInputs {
  designDoc: string;
  projectRoot: string;
  maxRounds: number;
  reviewers: string[];
  /** 用户显式传入的 attempt；null = 未传（启动时按 final.json 存在性自动判定） */
  attempt: number | null;
  /** 非空 = 参数非法（fail-fast，含恢复指引素材） */
  problems: string[];
}


// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起；若修订续跑（AmendWorkflow）：args 不透传、attempt 留空会自动递增使节点缓存零命中从头重跑——参数值与 attempt 原值一并固化进脚本常量再 amend";
const HINT_REVIEW_BAD_COUNT = "修 prompt 后 AmendWorkflow，或 args.attempt 递增重新发起";

// ── 修复者重试前情补丁（F 区钩子）：zcode 同 actor 续 ask，上下文天然可见，重试指令
// 只需说明「上一轮返回未过校验」；pi 侧 ask 每次新 agent，钩子返回自包含前情 ──
function withRetryContext(firstInstructions: string, firstReturn: { dispositions: unknown } | null, checkReport: string): string {
  void firstInstructions;
  void firstReturn;
  void checkReport;
  return "你上一轮返回的处置表未通过脚本校验（同会话续聊，此前的任务指令与你的返回仍可见）。";
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
