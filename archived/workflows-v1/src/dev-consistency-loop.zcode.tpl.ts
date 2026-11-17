/* zcode-workflow
description: dev-flow-v1 W3 一致性审查循环（D2）：R1 分区全面审（分区互斥契约，
  git diff 基线..HEAD 文件清单按顶层段不相交划分）→ 每轮修复前聚合定性独立 phase
  （跨区同根因去重 / 定性复核改判 doc_errors / expectedFiles 无交集分组 / 跨职责路由）→
  修复组并行（组级一笔 commit）→
  R2+ 每组定向复审（只审三条 + reconciliation 逐条对账申报——清零判定唯一证据通道，
  条目身份按引擎分配的 U 编号，不按文本匹配）→ Gate A 全量测试（零容忍绕过：无任何
  SKIP 逻辑，脚本不传环境变量；红后归因分诊独立 phase ≤2 轮——本批回归条目回注修复轮
  再修、瞬态重跑、存量红/测试基建缺陷带分诊报告终态；产物构建失败先引擎重跑自愈，
  仍败回注修复轮）→ 终态回流 doc_errors/reasonable 给主 agent。
  停止线（合并语义）：审查轮累计 3 轮不收敛（或 unreasonable 活跃数不减反增）→
  stuck；顽固条目（连续 ≥2 轮修复未清，按 reconciliation not-fixed 申报追踪）随 stuck
  终态 escalated 清单呈报——单条独立停机线与时序互斥（到点必晚于计数线），已并入
whenToUse: dev-flow-v1 主流程 D2 阶段——W2 开发循环终态（blocked 已升级处理）后由
  主 agent 发起；输入 exec-plan（D0 编译产物），终态 converged/stuck/gate-a-failed/
  环节失败由主 agent 接力（gate-a-failed 终态自带分诊报告——存量红/基建缺陷按报告
  裁决，分诊轮耗尽才需主 agent 从日志归因）
args:
  execPlan:
    type: string
    description: exec-plan.json 路径（绝对或 workspace 相对；D0 编译产物，须含
      baseline/planPath/designDocPath/statusPath/projectRoot/testPlan.fullSuite）
    required: true
  maxRounds:
    type: number
    description: 修复→定向复审循环轮次上限（R1 全面审不计入）
    default: 10
  reviewerTemplate:
    type: string
    description: 一致性审查 agent 模板路径（缺省用 dev-flow-v1 skill 内置模板）
    default: ~/.agents/skills/dev-flow-v1/agents/consistency-reviewer.md
  attempt:
    type: number
    description: 重发起序号（status.json events 追加保留历史不覆盖；attempt > 1 时
      Gate A 日志命名带 .attemptM 后缀防覆盖上轮日志）。不得设 default——引擎会把
      default 物化成显式值、吞掉「未传」形态（本参数未传时 shared 自带归 1 兜底）
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

// ── 结果与中间类型（JSDoc 会作为字段描述注入子 agent）──

interface ReasonableEntry {
  /** 位置 file:line 或文件路径 */
  location: string;
  /** 一句话：为何属合理演化（实现优于设计 / 不破坏设计目标） */
  summary: string;
  /** 条目类别（2026-11-04 字段化，替代旧 `[process]` 前缀约定——前缀靠措辞自觉、
   *  漏打即误入停机线）：process = 提交完整性/流程类发现（不计停机线不派修复组）；
   *  content = 内容类（缺省） */
  kind?: "content" | "process";
  /** 文档同步建议（终态回流主 agent，D5 终态同步消费） */
  docSyncSuggestion: string;
}

interface GapEntry {
  /** 问题位置 file:line（或文件路径） */
  location: string;
  /** 一句话差距：违背设计 / 遗漏未做 / 越权多做 / 文档自身错误 */
  gap: string;
  /** 影响决策（布尔判据，2026-11-04 字段化——引擎按它分流双无降级，中文措辞不再参与判定）：
   *  true = 违背机制决策（不修则落空） */
  decisionAffecting: boolean;
  /** 影响交付（布尔判据之二）：true = 任一环节（开发/测试/验收/文档登记）会出错 */
  deliveryAffecting: boolean;
  /** 影响说明（人读）：决策违背哪条（D几/§几）/ 交付哪个环节会出错——只作展示，不参与分流 */
  impactNote: string;
  /** 条目类别（可选，引擎归一对缺失恒产 content）：process = 流程类（提交完整性等，
   *  不计停机线）；content = 内容类。流程类发现应走 reasonable，出现于此 = reviewer
   *  违规申报，引擎按它排除停机线计数 */
  kind?: "content" | "process";
  /** 严重度：high 预留给破坏数据/崩溃级 */
  severity: "high" | "medium" | "low";
  /** 一句可执行修复建议 */
  fixHint: string;
  /** R2+ 复审专属：延续上批条目时原样填其 U 编号（引擎按它刷新条目描述，不按文字匹配）；新问题不填 */
  prevId?: string;
  /** 引擎内部字段（reviewer 不产不填）：fixer 申报留回流理由（skipped 申报的 reason），随 prompt 渲染给下轮修复组 */
  returnNote?: string;
}

/** R2+ 定向复审的对账申报（清零判定唯一证据通道——学 W1 reconciliation：fail-closed，漏报不视为已修） */
interface ReconEntry {
  /** 上批条目 id（原样引用注入清单中的 U 编号） */
  prevId: string;
  /** fixed = 亲自读代码到行级核实修复成立；not-fixed = 仍存在（条目保持活跃并计数） */
  status: "fixed" | "not-fixed";
  /** 读了哪里、确认了什么（file:line 事实）；fixed 申报不带证据不采信 */
  evidence: string;
}

interface ReviewResult {
  /** 实现优于设计 / 合理演化且不破坏设计目标——不进修复循环，随终态回流 */
  reasonable: ReasonableEntry[];
  /** 违背设计 / 遗漏未做 / 越权多做——进修复循环（按 location 归属分区成组）；延续上批条目时带 prevId */
  unreasonable: GapEntry[];
  /** 文档自身错了（实现是对的）——不进修复循环，随终态回流主 agent */
  docErrors: GapEntry[];
  /** R1 恒 []；R2+ 对上批本组逐条申报裁决（fixed+证据才清零，not-fixed/漏报保持活跃） */
  reconciliation: ReconEntry[];
}

interface FixRecord {
  /** 条目 id（原样引用任务清单中的 U 编号） */
  id: string;
  /** 一句修复描述 */
  description: string;
  /** 改动文件 + 波及文件（相对仓库根路径）——引擎按它核验改动归属并精确 add */
  affectedFiles: string[];
}

interface FixReport {
  /** 已修复条目 */
  fixes: FixRecord[];
  /** 未修条目如实申报（id + 具体原因）；确信设计文档自身有错的条目走这里（转 doc_errors 流回） */
  skipped: { id: string; reason: string }[];
  /** 职责外申报——条目属实但修复动作属其他职责域，转升级呈报，不算漏修 */
  delegated?: { id: string; reason: string }[];
  /** 自检硬门声明（fixes 非空时必填且 typecheck 须 "pass"——带红返回不入账） */
  selfCheck?: { typecheck: string; tests?: string };
}

/** 聚合定性条目裁决（2026-09-29 裁决：修复前判断型环节——去重/定性复核/无交集分组/跨职责路由） */
interface AggregateItem {
  /** 条目 id（原样引用清单中的 U 编号） */
  id: string;
  action: "keep" | "merge-into" | "reclassify-doc-error" | "escalate";
  /** action=merge-into 时必填：并入的主条目 id */
  mergeInto?: string;
  /** merge-into / reclassify-doc-error / escalate 必填：裁决理由 */
  reason?: string;
  /** action=keep 时必填：修复组名（语义化、可跨分区——跨职责路由的载体） */
  group?: string;
  /** action=keep 时必填：预期改动文件（相对仓库根，供组间无交集硬校验） */
  expectedFiles?: string[];
}

interface AggregateReport {
  items: AggregateItem[];
}

/** Gate A 失败归因分诊条目（Gate A 红后的「该谁修」裁决：本批回归回注修复轮，其余豁免呈报） */
interface GateATriageItem {
  /** GT-<序> */
  id: string;
  /** batch-regression=本批改动引入的回归（回注修复轮）/ legacy=存量红（与本批 diff 零交集，豁免呈报）/ script-defect=测试基建自身缺陷（段退出码累计假红、清单配置错等）/ flaky=瞬态失败（直接重跑 Gate A） */
  kind: "batch-regression" | "legacy" | "script-defect" | "flaky";
  /** 失败段/用例标识 */
  testRef: string;
  /** 判定依据（基线对照结论或文件交集证据） */
  evidence: string;
  /** 本批侧改动文件（batch-regression 时非空） */
  files: string[];
  /** 修复要点（可空串） */
  fixHint: string;
}

/** Gate A 归因分诊输出（日志中每个失败段恰好一条，禁止静默跳过） */
interface GateATriage {
  items: GateATriageItem[];
}

interface ItemRecord {
  id: string;
  /** 建档去重键 = location + 归一 gap（仅用于同轮跨区双报与无 prevId 新报的建档去重——
   *  误合并低害：条目保持活跃不丢；跨轮清零判定按 id 走 reconciliation 申报，不经此键） */
  key: string;
  location: string;
  gap: string;
  /** 影响决策布尔判据（2026-11-04 字段化——引擎按它分流双无降级，不再解析中文措辞前缀） */
  decisionAffecting: boolean;
  /** 影响交付布尔判据之二 */
  deliveryAffecting: boolean;
  /** 影响说明（人读，只作展示不参与分流） */
  impactNote: string;
  /** 条目类别（2026-11-04 字段化）：process = 流程类（提交完整性等——不计停机线）；
   *  content = 内容类（缺省）。reviewer 违规把流程类写进 unreasonable 时引擎按它排除停机线计数 */
  kind: "content" | "process";
  severity: string;
  fixHint: string;
  /** 所属修复组（入池时 = 分区边界；聚合定性路由后可被覆盖为跨分区组名） */
  group: string;
  /** 首次出现的审查轮（R1 = 1） */
  firstRound: number;
  /** 连续「修复后复审仍报」次数；≥2 = 顽固条目（stuck 终态随 escalated 呈报——独立单条停机线已并入计数线，§8.6） */
  uncleanRounds: number;
  active: boolean;
  /** 修复史（每轮一句，供后续轮修复 agent 与终态诊断） */
  fixHistory: string[];
}

interface GroupRun {
  name: string;
  /** 本轮开轮时该组活跃条目（快照，清零判定以此为准） */
  items: ItemRecord[];
  /** 组允许触碰的文件集 = 条目指向文件 ∪ 修复申报文件（轮级并集核验的组份额） */
  own: string[];
  fix: FixReport | null;
  changedFiles: string[];
  testFailed: boolean;
  testTail: string;
  committed: boolean;
  commitNote: string;
  /** 定向复审结果；未派复审（无改动且无活跃条目的组）= null——该组条目保持原状（fail-closed） */
  review: ReviewResult | null;
  /** 辅助组（文档修复组专用）：不跑增量测试、不派定向复审——纯文档改动无编译/回归环节 */
  auxiliary?: boolean;
}

interface PrepInfo {
  projectRoot: string;
  baseline: string;
  designDocPath: string;
  planPath: string;
  planMdPath: string | null;
  /** statusPath 绝对路径（终态 events 回写目标——§4.5 W3 回写义务） */
  statusPath: string;
  /** agent 过程记录目录（statusPath 同目录 <name>.runlog/——任务 prompt 注入的防丢失记录落点） */
  runlogDir: string;
  /** 未决事项与裁决处置档案（statusPath 同目录 <name>.ledger.md——终态未决清单写入 + 主 agent 处置记录） */
  ledgerPath: string;
  gateALog: string;
  reviewerTemplate: string;
  partitions: { name: string; files: string[] }[];
  diffChurn: number;
  diffFileCount: number;
  unitCount: number;
  incremental: { program: string; args: string[] } | null;
  fullSuite: { program: string; args: string[] };
  /** 产物类条目（§6.1 条目 3——Gate A 起始第一波并行预备；空数组 = 无） */
  artifacts: { id: string; command: { program: string; args: string[] } }[];
  /** 启动前已存在的已跟踪改动（porcelain 非 ?? 条目，流程外资产）——settle 收编的排除集：
   *  这些改动的归属判断在主 agent/用户，引擎收编曾把用户的在途诊断代码卷进 fix 笔（实测） */
  preExistingTracked: string[];
}

interface FinalResult {
  /** converged = 清零且 Gate A 绿；stuck = 双停机线或轮次耗尽；gate-a-failed = 全量测试红（不自动归因）；review-failure / fix-failure = 环节失败 */
  terminated: "converged" | "stuck" | "gate-a-failed" | "review-failure" | "fix-failure";
  /** 审查轮数（R1 计 1，每轮修复+定向复审 +1） */
  rounds: number;
  /** 全轮累计 doc_errors（去重；终态回流主 agent → D5 终态同步消费） */
  docErrors: GapEntry[];
  /** 全轮累计 reasonable（去重；终态回流主 agent） */
  reasonable: ReasonableEntry[];
  /** Gate A 日志绝对路径（未执行到 Gate A = null） */
  gateALog: string | null;
  /** 单条停机线升级清单（1+2 次 fixer 后复审仍报，设计 §8.6 ③） */
  escalated: { id: string; location: string; gap: string; uncleanRounds: number }[];
  /** 必填字段分流降级条目（影响决策=否 且 影响交付=无——不进修复批次，随终态回流主 agent 登记残留风险）；kind = escalated（聚合升级/职责外申报，终态单列升级呈报行）| deferred（普通降级登记）——分流判据字段，gap 前缀文本仅人读展示 */
  deferredLedger: { id: string; location: string; gap: string; impactNote: string; kind: "escalated" | "deferred" }[];
  /** 终态仍活跃条目（stuck / fix-failure 在场） */
  remaining: { id: string; location: string; gap: string; severity: string; group: string }[];
  /** 分区概览（诊断） */
  partitions: { name: string; files: number }[];
  /** 终态工作区无人申报的残留改动（历轮留盘待认领未被认领的）——主 agent 判归属后
   *  处置（属修复成果 → 补提交；无主/临时 → 清理；判不了 → 呈报用户，禁静默丢弃） */
  residualFiles: string[];
  /** 一句话终态说明（含恢复动作） */
  message: string;
}


// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_MISSING_EXECPLAN = "恢复动作：经 CreateWorkflow 重新发起并传 execPlan。注意 AmendWorkflow 不透传 args——修订脚本时 args 恒空，请把 execPlan 路径直接写进脚本 const 后再发起。";
const HINT_R1_FAILED = "读 run 日志定位失败分区，AmendWorkflow 修订后重发";

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
