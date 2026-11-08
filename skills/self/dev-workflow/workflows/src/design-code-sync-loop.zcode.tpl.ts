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
  watchlist:
    type: string
    description: 符号词表绝对路径（<basename>.symbol-watchlist.json，tech-design-wf T3 产出）；
      终态同步必备前置——setup 词表指纹校验（词表 sourceFingerprints 与源文档当前 sha256
      比对，文档已改而词表未重生成即拒启）不过即拒启，机械悬空引用防线由它供词；须为
      绝对路径（~/ 与相对形态不可读，引擎对词表与指纹键一律直读）
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
      已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）。不得设 default——
      default 数值会被引擎物化成显式值、吞掉「未传」形态，自动检测失效且防覆盖校验
      将把缺省值当显式值拒启（实测：runDir 已有 attempt1 产物时省略参数 → 引擎填 1 → 拒启）
  rulings:
    type: string
    description: "已裁决记录 json 绝对路径（可选；顶层数组，元素 {id, direction: doc-right 或 code-right, anchor, quote, source}）——设计决策与开发期裁决的机器可读清单，注入全部 reviewer（已答问题不得标 contested）；断点续跑（resumeFrom）时按它把冻结条目重绑定方向"
    default: ""
  resumeFrom:
    type: string
    description: 断点续跑（可选）：先前一次运行的 runDir 绝对路径（终态 message 中有指针）。
      终态停回（典型 contested）后携用户裁决续跑：跳过 R1 全量重审（实测每轮 30-45M
      token），载入先前 final.json 全量条目清单、按 rulings 把冻结条目重绑定方向后直接
      进修复轮。前置 = 先前 run.json 记录的终态文档指纹与当前一致（设计/计划在先前终态后未被
      外部改动）；不一致或无法验证时自动放弃续跑、降级常规全量模式并在 log 说明
    default: ""
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

/** 三向功能对照矩阵行（模板输出 schema 对齐 sync-reviewer/sync-planner） */
interface MatrixRowLite {
  /** 设计声明锚点（§N） */
  claim: string;
  /** 代码实现锚点（file:line 或 未找到） */
  impl: string;
  /** 功能对照结论（结构化枚举，2026-11-04 替代旧中文措辞 verdict——措辞出枚举即修错侧）：
   *  match = 一致；gap = 有差距（gapDirection 必填）；unevaluated = 未评 */
  align: "match" | "gap" | "unevaluated";
  /** 差距方向（仅 align=gap 必填）：doc-right = 设计有代码漏；code-right = 代码有设计漏 */
  gapDirection?: "doc-right" | "code-right";
  /** 一句话说明 */
  note: string;
  /** 越权实现三问初评档位（结构化枚举）：over = 过度；suspect = 存疑；fine = 合理；缺省 = 未评 */
  overdesign?: "over" | "suspect" | "fine";
}

/** planner 框架级发现（矩阵顶层行 + 清单条目） */
interface PlannerFrameworkFinding {
  /** 展示用 id（FF1 形态；清单以脚本重编 id 为准） */
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

/** findings 八字段 schema（sync-reviewer 模板第 4 条，W4 条目清单载体） */
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
  /** 升级三要件①（must-fix 级 contested 必填，validateModuleReview 机器校验）：实际查过的
   *  设计/裁决记录锚点清单（章节号或裁决 id）——与 pi SCHEMA_Finding8 对齐（parity 维度 4） */
  consultedAnchors?: string;
  /** 三要件②：已查锚点为何不构成答案（一句话论证） */
  whyInsufficient?: string;
  /** 三要件③：裁错方向会误导什么交付判断（可证伪场景） */
  misleadScenario?: string;
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
  /** 结构化自检（2026-11-04 字段化，替代自由文本）：kind ∈ machine-check（适用一致性
   *  检查）| existence-check（旧表述零残留检索，预期零命中）；引擎复跑 command 做
   *  输出等值比对（expected/actual 全等，非模式命中） */
  selfCheck: { kind: "machine-check" | "existence-check"; command: string; expected: string; actual: string };
}

/** 修复组 agent 结构化返回 */
interface FixOutcome {
  fixes: FixRecord[];
  /** 实际改动文件（含新增文件与组外正当扩展——引擎据此做范围声明核验与组级 commit） */
  affectedFiles: string[];
  /** 越权候选 defer 申报（§7.3 机器落点）：条目的修复动作将是删码而条目非 must-fix 级 →
   *  fixer 不执行删除，申报转呈报；引擎放行（不算漏修）并随终态 overdesignCandidates 呈报 */
  deferred: { issueId: string; reason: string }[];
  /** 符号豁免申报（2026-09-27 用户裁决）：fixer 核实某机械条目指向的词不该被扫描（典型 =
   *  外部/上游包符号）→ 申报豁免；引擎转 exempt 终态、落豁免登记、随终态 exemptList 呈报
   *  主 agent 终审——豁免是 fixer 的语义判断，主 agent 可推翻 */
  exempt: { issueId: string; reason: string }[];
  /** 职责外申报（2026-09-29 裁决，F8-1 类死锁防线）：条目属实但修复动作属其他职责域
   *  （如 e2e 测试资产修复落在生产代码组）→ 申报转交；引擎置 delegated 终态不再计活跃，
   *  随终态 delegatedList 呈报主 agent 重派或立项——禁止留在本组空转到 stuck */
  delegated: { issueId: string; reason: string }[];
}

/** 门禁合规修复自报（commit 被仓库钩子拒后的轮内修复；fixed 为空 = 判定真代码问题转人工） */
interface CommitGateFix {
  /** 实际修复的文件（相对 projectRoot 路径） */
  fixed: string[];
  /** 一句话修复说明（fixed 为空时写问题与建议处置） */
  summary: string;
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

/** 清单条目（脚本侧全生命周期状态） */
interface FindingRecord {
  id: string;
  /** 归属（"planner" | 模块 id）——R2+ 聚焦复审的续聊对象键 */
  owner: string;
  location: string;
  gap: string;
  /** 机械信号条目专属：词表符号（owner=mechanical 立项时直写字段，对账/豁免按字段读——
   *  旧从 gap 文本回提取的正则随字段化退役，gap 改写不再导致条目永不清） */
  symbol?: string;
  direction: "doc-right" | "code-right" | "contested";
  severity: "must-fix" | "suggestion" | "info";
  impact: string;
  rationale: string;
  fixHint: string;
  firstSeen: number;
  /** open=待修 / fixed=已清（复审实证）/ deferred=越权候选（用户裁决前不删码）/ frozen=must-fix 级方向争议冻结（待用户裁决方向，不修不计数，随终态 contestedList 呈报）/ frozen-blocked=争议连坐冻结（2026-11-03 授权修订 2026-09-26 语义：条目本身方向已定但与争议条目同文件，随争议一并冻结，终态 contestedBlockedList 呈报）/ exempt=符号豁免（fixer 核实不该扫的词，主 agent 终审，随终态 exemptList 呈报）/ delegated=职责外（修复动作属其他职责域，不计活跃，随终态 delegatedList 呈报主 agent 重派） */
  status: "open" | "fixed" | "deferred" | "frozen" | "frozen-blocked" | "exempt" | "delegated";
  fixedRound?: number;
  /** 修复史（紧凑一行式：第N轮复审判 not-fixed/regressed + 证据摘要，一句一条）——
   *  下轮 fixer 注入防重复已失败的修法；fixed 清零不留史，未断言处缺省 */
  fixHistory?: string[];
  /** 升级三要件（2026-11-03 授权，must-fix 级 contested 必填，validateModuleReview 机器校验）：
   *  实际查过的设计/裁决记录锚点清单（章节号或裁决 id） */
  consultedAnchors?: string;
  /** 三要件②：已查锚点为何不构成答案（一句话论证） */
  whyInsufficient?: string;
  /** 三要件③：裁错方向会误导什么交付判断（可证伪场景） */
  misleadScenario?: string;
  /** 争议仲裁步改判记录（2026-11-03 授权新增）：verdict=settled-doc-right/settled-code-right；
   *  quote ≥12 字原文引文（脚本逐字校验存在于设计文档/裁决记录，防幻觉）；anchorRef=锚点章节；
   *  reasoning=引文→结论推理链。聚焦复审每轮复跑引文断言，失 existence 即回退 contested */
  arbiter?: { verdict: string; quote: string; quoteLocation?: { source: "design-doc" | "impl-plan"; lineStart: number; lineEnd: number }; anchorRef: string; reasoning: string };
  /** suggestion 级 contested 被引擎按方向语义表默认改判 doc-right 的标记（终态列出备查） */
  contestedDefaulted?: boolean;
}

/** 矩阵行记录（拼接历史） */
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

/** 争议仲裁步结构化返回（2026-11-03 授权新增：R1 聚合后、contested 分流前消解伪争议） */
interface ArbiterQuoteLocation {
  /** 引文来源：design-doc = 设计文档人读版 / impl-plan = impl-plan 人读版（裁决记录不作为
   *  引文来源——json 形态文本含转义，逐字引不可靠；已裁决事项的原文落到两文件对应行段） */
  source: "design-doc" | "impl-plan";
  /** 引文起始行（1-based，含） */
  lineStart: number;
  /** 引文结束行（1-based，含） */
  lineEnd: number;
}

/** 争议仲裁步结构化返回（2026-11-03 授权新增：R1 聚合后、contested 分流前消解伪争议） */
interface ArbiterVerdict {
  /** settled = 设计原文已答（quote + quoteLocation + anchorRef + reasoning 必填，引擎按
   *  quoteLocation 行段读原文与 quote 归一化比对）；genuinely-open = 默认态——引用不出或
   *  推理不成立一律回此值（宁停勿错） */
  verdict: "settled-doc-right" | "settled-code-right" | "genuinely-open";
  /** 设计文档/impl-plan 人读版原文引文（≥12 字逐字，防幻觉） */
  quote?: string;
  /** 引文位置锚（引擎行段等值校验与聚焦复审复核的机器锚点）——settled 必填 */
  quoteLocation?: ArbiterQuoteLocation;
  /** 引文所在锚点（设计章节号或裁决 id） */
  anchorRef?: string;
  /** 引文→结论的推理链 */
  reasoning?: string;
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
  /** 全量三向功能对照矩阵（markdown，含 findings 条目清单与方向分布） */
  matrixFile: string;
  /** 机械信号步终态观测：`ran: 零命中 N 条` / `skipped: <原因>`（含未传 watchlist 词表的
   *  整步跳过——主 agent 据此可判词表参数是否遗漏）/ `failed: <原因>`；字段缺省 = 该步未
   *  被执行到（如 planner 阶段即失败），与「执行了但被跳过」区分。记录最后一次执行
   *  （R1 立项扫描或 R2+ 对账复扫）的结果 */
  mechanicalScan?: string;
  /** findings 方向分布（按清单全量计） */
  directionStats: { docRight: number; codeRight: number; contested: number };
  /** 退役执行结果（仅 converged 填实；其余终态为空） */
  retirement: { retired: { from: string; to: string }[]; kept: { path: string; reason: string }[] };
  /** 方向争议记录（contested 终态 = 待用户裁决清单；converged = 非 must-fix 级默认 doc-right 的已处理记录） */
  contestedList: { id: string; location: string; gap: string; severity: string; rationale: string }[];
  /** 符号豁免清单（fixer 申报「不该被扫描的词」的机械条目——豁免登记文件 + 本清单双落点，
   *  交主 agent 终审：认可则无动作，推翻则改词表后 attempt 递增重发） */
  exemptList: { id: string; word: string; reason: string }[];
  /** 越权候选卡清单（§7.3「过度/存疑只报告不删码，用户裁决后才动」的结构化呈报——
   *  矩阵 overdesign 行 + fixer defer 申报条目；用户裁决前不产生任何删码动作） */
  overdesignCandidates: { id: string; location: string; gap: string; reason: string }[];
  /** 职责外申报条目（fixer delegated 申报累积；status=delegated 不计活跃，随终态呈报
   *  主 agent 重派或立项——F8-1 类跨职责条目空转死锁的防线，2026-09-29） */
  delegatedList: { id: string; location: string; reason: string }[];
  /** 争议连坐冻结清单（2026-11-03 授权修订阻断半径：条目方向已定但与 must-fix 争议条目
   *  同文件被一并冻结；blockedBy = 连坐到的争议条目 id 清单——用户裁决争议后随其一并处置） */
  contestedBlockedList: { id: string; location: string; blockedBy: string[] }[];
  /** 争议仲裁步改判清单（2026-11-03 授权新增：arbiter 按设计原文消解的伪争议——非用户
   *  裁决，是「先修后审」：全部列出供用户抽查翻案，翻案即按新方向 attempt 递增重发） */
  arbiterSettledList: { id: string; direction: string; quote: string; quoteLocation?: { source: "design-doc" | "impl-plan"; lineStart: number; lineEnd: number }; anchorRef: string; reasoning: string }[];
  /** suggestion 级 contested 被方向语义表默认改判 doc-right 的条目（终态备查） */
  contestedDefaultedList: { id: string; location: string }[];
  /** 残余活跃条目（stuck / *-failure 随终态呈报；设计 §7 停机线：清单随终态） */
  remaining: { id: string; severity: string; direction: string; location: string; gap: string }[];
  /** 工作区无人认领/多组冲突的残留改动（各组只对自己的改动负责，无人认领的不提交
   *  不作废留盘）——主 agent 判归属后处置（补提交/人工合并/清理/呈报用户，禁静默丢弃） */
  residualFiles: string[];
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
  /** 可选：符号词表绝对路径（<basename>.symbol-watchlist.json，tech-design-wf T3 产出）；
   *  空串 = 未传或传了非绝对形态（后者在 watchlistNonAbs 留痕），机械信号步跳过
   *  （不回退文档反引号抓取——抓取依赖「反引号 = 本项目符号」的隐式约定，
   *  2026-09-27 起词表是唯一扫描词源） */
  watchlist: string;
  /** 非空 = watchlist 传了但非绝对路径形态（~/ / 相对等原始值留痕）——setup 报错两分用：
   *  区分「未传」（指路产词表）与「传了但形态不可读」（指路修正为绝对路径），避免把
   *  后者误归因为缺失 */
  watchlistNonAbs: string;
  /** 可选：已裁决记录 json 绝对路径（元素 {id, direction, anchor, quote, source, commit?}）；
   *  空串 = 未传，无裁决注入（2026-11-03 授权新增） */
  rulings: string;
  /** 可选：断点续跑先前 runDir 绝对路径（终态档案 final.json 所在）；空串 = 常规全量模式。
   *  载入先前全量 ledger 按裁决重绑定、跳过 R1 全量重审直接进修复轮；指纹不一致或数据源
   *  缺陷时降级/拒启（见 shared ④ 前置判定） */
  resumeFrom: string;
  maxRounds: number;
  plannerTemplate: string;
  reviewerTemplate: string;
  attempt: number | null;
  /** 非空 = 参数非法（fail-fast，含恢复指引素材） */
  problems: string[];
}

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起；若修订续跑（AmendWorkflow）：args 不透传、attempt 留空会自动递增使节点缓存零命中从头重跑——参数值与 attempt 原值一并固化进脚本常量再 amend";
const HINT_PLANNER_INVALID = "AmendWorkflow 修订 prompt 后重跑";
const HINT_RETIRE_INVALID = "AmendWorkflow 修订退役 prompt 后重跑";

// ── host 标识（run manifest host 字段，skill-data-redesign §5.1：shared 不留 host
// 硬编码，两壳各持常量）──
const HOST_PLATFORM = "zcode";

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
