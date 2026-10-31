/* zcode-workflow
description: tech-design-wf 技能 W1 设计文档审查循环：方向审循环（patch 档打回在
  循环内派方向修复者改章节 JSON 后重审；rewrite 档 / 预算耗尽 / must-fix 连续不降
  才停回 T1）→ 三维并行审查（主审/影响面审/简洁审，R1 全面审、R2+ 聚焦复审逐条对账）→
  文档修复者单 agent 兼语义去重合并 + 修复 + 处置表产出（dispositions.json/md）→ 循环至
  converged / escalated / stuck / max-rounds。审查读设计目录内章节 JSON 渲染出的
  rendered.md（setup 跑 check-design-doc.mjs 进场校验 + render-design-doc.mjs 刷新视图），
  修复者直接编辑章节 JSON 并在修改后重渲染。产物落
  ~/.agents/skill-data/tech-design/<project-slug>/<设计名>/（round-N[.attemptM]/ 子目录），
  终态档案 final.json。终态判定 / 覆盖校验 / stuck 计数全部脚本侧完成，不信任 agent 自报收敛
whenToUse: tech-design-wf 技能 W1 阶段——技术设计文档（tech-design 产物，分章节 JSON 形态）
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
    description: 审查-修复循环轮次上限（含首轮全面审）
    default: 10
  maxDirectionRounds:
    type: number
    description: 方向审循环轮次上限（每轮 = 方向审 + patch 档修复；rewrite 档打回 /
      must-fix 连续不降提前停回 T1）
    default: 6
  reviewers:
    type: json
    description: 自定义 reviewer 模板绝对路径数组，按文件 basename 覆盖同名维度
      （tech-design-direction-review.md / tech-design-review.md /
      tech-design-impact-review.md / tech-design-simplicity-review.md）；
      未匹配任何维度的条目忽略并告警
  attempt:
    type: number
    description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；
      缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取
      已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）
    default: 1
*/

// ── 结果与中间类型（JSDoc 作为字段描述注入子 agent） ──

interface DirectionVerdict {
  /** 方向审报告文件路径（脚本按确定性位置校验，不以自报为准） */
  reportFile: string;
  /** must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验） */
  mustFix: number;
  /** 打回档位：patch = 全部发现属前提层/产物表/措辞级（循环内派修复者改章节 JSON 后重审）；
   *  rewrite = 问题定义/方案主干/分型被击穿（停回 T1 重做）。mustFix = 0 时不消费 */
  fixScope: "patch" | "rewrite";
  /** 逐条问题清单（打回判定与计数派生的唯一事实源；条目无 level 字段——唯一级别是
   *  must-fix；条数合计须等于 mustFix） */
  problems: ProblemRef[];
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

interface DirectionFixOutcome {
  /** 本轮结论声明（必填，二选一，判别键）：
   *  "done" = 方向审 patch 档修复完成（返回体不得携带 blocked 字段）
   *  "blocked" = 修复需动问题定义/方案主干/分型（超出 patch 档边界）——必须携带 blocked 字段 */
  status: "done" | "blocked";
  /** 本轮已处置的问题 ref 清单（必须覆盖方向审 problems 全部 ref，脚本按集合机器校验） */
  fixedRefs: string[];
  /** 一段修订摘要：本轮改了设计文档哪些地方（注入下轮方向审，不算证据） */
  revisionSummary: string;
  /** 仅 status="blocked" 时携带：items=卡住的问题 ref 清单，reason=为什么需要用户裁决 */
  blocked?: { items: string[]; reason: string };
}

interface LoopResult {
  /** converged = 收敛；direction-rejected = 方向审打回；escalated = 方案性卡点停回用户；
   *  stuck = must-fix 连续多轮不降；max-rounds = 轮次上限耗尽；
   *  setup-failure / review-failure / fix-failure = 环节失败（message 含恢复动作） */
  terminated: "converged" | "direction-rejected" | "escalated" | "stuck" | "max-rounds" | "setup-failure" | "review-failure" | "fix-failure";
  /** 实际执行的审查轮数（方向审不计轮；converged 记收敛轮） */
  rounds: number;
  /** 审查产物根目录（绝对路径；setup-failure 早期可能为空串） */
  runDir: string;
  /** 审查对象设计目录（绝对路径；渲染 md 输入已归一——目录内章节 JSON 为权威源） */
  designDoc: string;
  /** 方向审一句话判定（final.json 对外字段名 = oneliner；未跑到方向审时为空串） */
  directionOneliner: string;
  /** 每轮三报告 must-fix 总和轨迹（下标 0 = 第 1 轮） */
  mustFixTrajectory: number[];
  /** 终态仍未收敛/未复核的条目（stuck/max-rounds 残余风险矩阵的输入） */
  remaining: { id: string; title: string; status: string; attackHints: string }[];
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
  /** 方向审循环轮次上限（每轮 = 方向审 + patch 档修复） */
  maxDirectionRounds: number;
  reviewers: string[];
  /** 用户显式传入的 attempt；null = 未传（启动时按 final.json 存在性自动判定） */
  attempt: number | null;
  /** 非空 = 参数非法（fail-fast，含恢复指引素材） */
  problems: string[];
}


// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）";
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

@@STITCH@@
