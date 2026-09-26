/* zcode-workflow
description: dev-flow-wf 技能 W4 终态同步循环（design-code-sync 的 workflow 化 + 升级语义）：
  两级审查拓扑（R1 framework-scan planner 单 agent → 模块 fan-out 并行 reviewer；R2+ 同
  agent 聚焦复审只审上轮修复影响面）→ 矩阵脚本 concat（无 LLM 聚合层，跨模块不去重）→
  must-fix 级 contested 拦截停回用户 → reconcileGroups 机器分组并行双向修复（doc-right
  修代码跑增量测试 / code-right 修文档过联动自检五处，组级一笔 commit）→ 聚焦复审收敛 →
  伴生产物退役判定（agent 只判定清单，引擎执行移动 + 引用验证）。矩阵 + 收敛轨迹落盘
  <projectRoot>/.tmp/dev-flow/<设计文档名>.sync/（round-N[.attemptM]/ 子目录），终态档案
  final.json。终态 converged / contested / stuck / *-failure
whenToUse: dev-flow-wf 技能 D5 终态同步段——交付后把「代码实现 vs 设计文档」差距双向校准
  到 0 must-fix 时调用（审查对象 = 当前 HEAD 终态全量，不是 diff 区间）；必传 designDoc /
  implPlan / projectRoot。不用于 diff 区间代码评审（用 saved review-fix-loop）或设计文档
  审查（用 saved tech-review-loop）
args:
  designDoc:
    type: string
    description: 设计文档绝对路径（.tmp/tech-design/<name>.md，code-right 条目的修复对象之一）
    required: true
  implPlan:
    type: string
    description: 实施计划 JSON 路径（.tmp/tech-design/<name>.impl-plan.json，planner ②③职责对照对象）
    required: true
  projectRoot:
    type: string
    description: 目标项目根绝对路径（git 操作基准 + .tmp/dev-flow 产物目录落点）
    required: true
  statusPath:
    type: string
    description: status.json 绝对路径（可选；planner 职责②「现实↔impl-plan 进度核对」的数据源——
      D1/D2 终态事实；未传时②的进度核对降级为 impl-plan.json 单侧并在轨迹注明）
    default: ""
  maxRounds:
    type: number
    description: 审查→修复循环轮次上限（含 R1 首轮全量审）
    default: 10
  plannerTemplate:
    type: string
    description: framework-scan planner agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-planner.md）
    default: ~/.agents/skills/dev-flow-wf/agents/sync-planner.md
  reviewerTemplate:
    type: string
    description: 模块 reviewer agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md）
    default: ~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md
  attempt:
    type: number
    description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；
      缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取
      已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）
    default: 1
*/

// ── 结果与中间类型（JSDoc 作为字段描述注入子 agent） ──

/** 三向功能对照矩阵行（模板输出 schema 对齐 sync-reviewer/sync-planner） */
interface MatrixRowLite {
  /** 设计声明锚点（§N） */
  claim: string;
  /** 代码实现锚点（file:line 或 未找到） */
  impl: string;
  /** 一致 / 漏实现 / 越权实现 */
  verdict: string;
  /** 一句话说明 */
  note: string;
  /** 越权实现三问初评档位（合理/过度/存疑），仅越权行有 */
  overdesign?: string;
}

/** planner 框架级发现（矩阵顶层行 + 台账条目） */
interface PlannerFrameworkFinding {
  /** 展示用 id（FF1 形态；台账以脚本重编 id 为准） */
  id: string;
  matrixRow: MatrixRowLite;
  /** must-fix / suggestion / info */
  severity: "must-fix" | "suggestion" | "info";
}

/** 模块计划（planner 产出，phase 2 fan-out 派发依据） */
interface ModulePlanRec {
  /** 模块 id（m1 形态；agent 命名与条目归属键） */
  id: string;
  /** 模块名/路径 */
  module: string;
  /** 核对文件集（projectRoot 绝对路径，供确定性分组校验） */
  files: string[];
  /** 对照设计章节锚点 + 审查重点 */
  focus: string;
}

/** planner 结构化返回（sync-planner 模板输出节） */
interface PlannerResult {
  frameworkFindings: PlannerFrameworkFinding[];
  modules: ModulePlanRec[];
}

/** findings 八字段 schema（sync-reviewer 模板第 4 条，W4 台账载体） */
interface Finding8 {
  id: string;
  /** file:line 或 文档§章节 */
  location: string;
  /** 现实与文档各自怎么说 */
  gap: string;
  /** doc-right（文档更合理→修代码）/ code-right（代码更合理→修文档）/ contested（不得自行裁决） */
  direction: "doc-right" | "code-right" | "contested";
  /** must-fix = 过时登记/悬空符号/行为与文档矛盾；suggestion = 不同步但不误导；info = 知晓级 */
  severity: "must-fix" | "suggestion" | "info";
  /** 误导了什么交付判断——写不出 = 不立项或降 info */
  impact: string;
  /** 方向裁决理由 */
  rationale: string;
  /** 修复建议（执行方须重演验证） */
  fixHint: string;
}

/** 模块 reviewer 结构化返回（sync-reviewer 模板输出节） */
interface ModuleReview {
  matrixRows: MatrixRowLite[];
  findings: Finding8[];
  /** 本模块无发现时的显式声明（如「在 X 未发现」） */
  moduleNoFinding?: string;
  /** R2+ 聚焦复审对账（R1 恒空数组） */
  reconciliation?: ReconEntry[];
}

/** R2+ 聚焦复审对账条目 */
interface ReconEntry {
  /** 上轮条目 id（与注入清单一致原样引用） */
  prevId: string;
  /** fixed = 亲自核实已修复；not-fixed = 仍存在；regressed = 复发或修复引入新问题 */
  status: "fixed" | "not-fixed" | "regressed";
  /** 读了什么、确认了什么（file + 改动事实）；修复方声称不算证据 */
  evidence: string;
}

/** 修复组条目级记录 */
interface FixRecord {
  /** 条目 id（与任务条目一致原样引用） */
  issueId: string;
  /** 一句修复描述（含组外波及标注） */
  description: string;
  /** 自检：一条可复跑命令 + 预期结果 */
  selfCheck: string;
}

/** 修复组 agent 结构化返回 */
interface FixOutcome {
  fixes: FixRecord[];
  /** 实际改动文件（含新增文件与组外正当扩展——引擎据此做领地核验与组级 commit） */
  affectedFiles: string[];
  /** 越权候选 defer 申报（§7.3 机器落点）：条目的修复动作将是删码而条目非 must-fix 级 →
   *  fixer 不执行删除，申报转呈报；引擎放行（不算漏修）并随终态 overdesignCandidates 呈报 */
  deferred: { issueId: string; reason: string }[];
}

/** 修复分组（reconcileGroups 输出） */
interface FixGroup {
  /** 组标识（G1、G2…） */
  id: string;
  /** 组内条目 id */
  issueIds: string[];
  /** 组涉及文件（组间不相交，闭包合并保证） */
  files: string[];
  /** 一句话分组依据 */
  note: string;
}

/** 退役判定 agent 结构化返回（只判定，不执行） */
interface RetirementVerdict {
  /** 退役候选清单（引擎执行引用验证 + 移动；零候选时显式返回空数组） */
  candidates: { path: string; reason: string }[];
  /** 保留项及依据（含 .tmp 合规放置类） */
  kept: { path: string; reason: string }[];
}

/** 台账条目（脚本侧全生命周期状态） */
interface FindingRecord {
  id: string;
  /** 归属（"planner" | 模块 id）——R2+ 聚焦复审的续聊对象键 */
  owner: string;
  location: string;
  gap: string;
  direction: "doc-right" | "code-right" | "contested";
  severity: "must-fix" | "suggestion" | "info";
  impact: string;
  rationale: string;
  fixHint: string;
  firstSeen: number;
  status: "open" | "fixed" | "deferred";
  fixedRound?: number;
}

/** 矩阵行台账（拼接历史） */
interface MatrixRowRecord extends MatrixRowLite {
  source: string;
  round: number;
}

/** 每轮收敛轨迹点 */
interface RoundStat {
  round: number;
  rowsNew: number;
  findingsNew: number;
  mustActive: number;
  sugActive: number;
  infoActive: number;
  contestedActive: number;
  fixGroups: number;
}

/** 终态返回（引擎→主 agent 契约） */
interface SyncResult {
  /** converged = 收敛；contested = must-fix 级方向争议停回用户；stuck = 停机线（含轮次耗尽）；
   *  setup/planner/review/fix/retire/io-failure = 环节失败（恢复动作见 message） */
  terminated: "converged" | "contested" | "stuck" | "setup-failure" | "planner-failure" | "review-failure" | "fix-failure" | "retire-failure" | "io-failure";
  rounds: number;
  /** 同步产物根（矩阵/轨迹/各轮留档所在） */
  runDir: string;
  designDoc: string;
  /** 全量三向功能对照矩阵（markdown，含 findings 台账与方向分布） */
  matrixFile: string;
  /** findings 方向分布（按台账全量计） */
  directionStats: { docRight: number; codeRight: number; contested: number };
  /** 退役执行结果（仅 converged 填实；其余终态为空） */
  retirement: { retired: { from: string; to: string }[]; kept: { path: string; reason: string }[] };
  /** 方向争议记录（contested 终态 = 待用户裁决清单；converged = 非 must-fix 级默认 doc-right 的已处理记录） */
  contestedList: { id: string; location: string; gap: string; severity: string; rationale: string }[];
  /** 越权候选卡清单（§7.3「过度/存疑只报告不删码，用户裁决后才动」的结构化呈报——
   *  矩阵 overdesign 行 + fixer defer 申报条目；用户裁决前不产生任何删码动作） */
  overdesignCandidates: { id: string; location: string; gap: string; reason: string }[];
  /** 残余活跃条目（stuck / *-failure 随终态呈报；设计 §7 停机线：清单随终态） */
  remaining: { id: string; severity: string; direction: string; location: string; gap: string }[];
  /** 一句话终态说明（含恢复动作） */
  message: string;
}

// ── 参数窄化（纯函数，便于片段级验证） ──

interface NarrowedInputs {
  designDoc: string;
  implPlan: string;
  projectRoot: string;
  /** 可选：status.json 绝对路径（planner 职责②进度核对数据源；空串 = 未传，降级单侧核对） */
  statusPath: string;
  maxRounds: number;
  plannerTemplate: string;
  reviewerTemplate: string;
  attempt: number | null;
  /** 非空 = 参数非法（fail-fast，含恢复指引素材） */
  problems: string[];
}

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）";
const HINT_PLANNER_INVALID = "AmendWorkflow 修订 prompt 后重跑";
const HINT_RETIRE_INVALID = "AmendWorkflow 修订退役 prompt 后重跑";

// ── F 区平台钩子：R2+ 聚焦复审的 R1 上下文——zcode 同名续聊天然承载，返回空 ──
function r2PrevContextBlock(
  owner: string,
  mm: ModulePlanRec | undefined,
  projectRoot: string,
  designDoc: string,
  implPlan: string,
  headHash: string,
  plannerTplAbs: string,
  reviewerTplAbs: string,
  rel: (p: string) => string,
): string {
  void owner; void mm; void projectRoot; void designDoc; void implPlan; void headHash; void plannerTplAbs; void reviewerTplAbs; void rel;
  return "";
}

@@STITCH@@
