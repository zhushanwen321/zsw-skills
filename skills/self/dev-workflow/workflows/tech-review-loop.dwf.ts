/* zcode-workflow
description: tech-design-wf 技能 W1 设计文档审查循环：四席并行审查（方向审席 +
  主审/影响面审/简洁审，R1 全面审、R2+ 聚焦复审逐条对账——方向审 patch 档发现随当轮
  问题清单进入聚合）→ 聚合裁决独立 phase（四席发现按同根因合并为去重权威清单
  aggregated.md，refs 精确划分脚本 fail-closed 校验）→ 文档修复者单 agent 据聚合
  清单修复 + 处置表产出（dispositions.json/md）→ 循环至
  converged / escalated / stuck / max-rounds；
  方向审 rewrite 档（问题定义/方案主干/分型被击穿）整循环立即终止回 T1。审查读设计目录内章节 JSON 渲染出的
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
    description: 审查-修复循环轮次上限（含首轮全面审；四席同轮并行）
    default: 10
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

// ============================================================================
// provenance.shared.ts — saved 副本启动校验层（单一构建输入）
// 构建器把本文件拼在观测层与业务正文之前，随产物部署；文件尾的顶层 await 即校验
// 入口——zcode 产物发起即执行，无从跳过。pi 产物拼入函数但不调用（构建器剥除调用
// 行）：pi 侧无 ~/.zcode saved 部署目录，无从校验，保留函数使两侧业务字符串同源。
//
// 机制：构建器写 saved 副本（~/.zcode/workflows/<name>.dwf.ts）时同步写来源登记
// 文件（<name>.manifest.json，记录生成该副本的仓检出根与仓内产物相对路径——本机
// 绝对路径是运行时反查检出根的唯一来源，属机器本地功能数据，不入仓）。启动时读
// 登记文件并逐字节比对 saved 副本与仓内产物：不一致 = 副本被仓外直接编辑或仓内
// 产物被手改（都意味着本次执行的脚本不是构建器产出的那一版），抛错终止，消息含
// 恢复动作；登记文件 / saved 副本 / 检出根任一缺失 = WARN 放行（本机无该仓检出时
// 不硬拦发起，降级可见）。
// 刻意只比「副本 vs 仓内产物」、不含 src/ 源：源的在途未构建改动归 pre-commit 的
// build --check 管辖，混进启动校验会误拦正常发起——误拦会逼出绕行，校验就废了。
// ============================================================================
const PROV_WF_NAME = "tech-review-loop";
const PROV_PROBE =
  "try{" +
  "var fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');" +
  "var dir=path.join(os.homedir(),'.zcode','workflows');" +
  "var mf=path.join(dir,process.argv[1]+'.manifest.json');" +
  "var sp=path.join(dir,process.argv[1]+'.dwf.ts');" +
  "var out=function(o){process.stdout.write(JSON.stringify(o))};" +
  "var raw;try{raw=fs.readFileSync(mf,'utf8')}catch(e){out({skip:'no-manifest'});return}" +
  "var m;try{m=JSON.parse(raw)}catch(e){out({skip:'no-manifest',reason:'unparsable'});return}" +
  "if(!m||typeof m.sourceRoot!=='string'||m.sourceRoot.charAt(0)!=='/'||typeof m.productRelPath!=='string'||m.productRelPath.indexOf('..')>=0){out({skip:'no-manifest',reason:'fields'});return}" +
  "var pp=path.join(m.sourceRoot,m.productRelPath);" +
  "var a,b;try{a=fs.readFileSync(sp)}catch(e){out({skip:'no-saved'});return}" +
  "try{b=fs.readFileSync(pp)}catch(e){out({skip:'no-repo',product:pp});return}" +
  "var h=function(x){return crypto.createHash('sha256').update(x).digest('hex').slice(0,12)};" +
  "out({ok:a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)),savedH:h(a),productH:h(b)});" +
  "}catch(e){process.stdout.write(JSON.stringify({skip:'probe-error',reason:String(e&&e.message||e)}))}";

/** saved 副本启动校验（机制见文件头注）：读来源登记文件并逐字节比对 saved 副本与
 *  仓内产物；不一致抛错终止（恢复动作在消息内），登记文件/副本/检出根缺失 WARN 放行 */
async function provenanceCheck(): Promise<void> {
  const r = await world.run("node", ["-e", PROV_PROBE, PROV_WF_NAME]);
  let v: { skip?: string; reason?: string; ok?: boolean; savedH?: string; productH?: string };
  try {
    v = JSON.parse(r.stdout.trim()) as typeof v;
  } catch {
    log(`WARN: 启动校验探针输出不可解析（exit ${r.exitCode}：${(r.stderr !== "" ? r.stderr : r.stdout).trim().slice(0, 200)}）——跳过本次启动校验`);
    return;
  }
  if (v.skip !== undefined) {
    const detail = v.reason !== undefined ? `（${v.reason}）` : "";
    log(`WARN: 来源登记文件或检出根缺失（${v.skip}${detail}）——跳过启动校验，本次发起未验证部署副本一致性`);
    return;
  }
  if (v.ok === true) {
    log(`启动校验通过：saved 副本与仓内产物一致（${PROV_WF_NAME}）`);
    return;
  }
  throw new Error(
    `saved 副本漂移：${PROV_WF_NAME} 的部署副本与仓内产物不一致（副本 sha256 前 12 位 ${v.savedH}，仓内产物 ${v.productH}）——副本被仓外直接编辑或仓内产物被手改，本次发起的不是构建器产出版本。恢复动作：在仓检出根跑 node scripts/build-workflows.mjs 重建并同步三处产物后重新发起；修订续跑配方与禁止直改副本见 workflow-authoring 第 4 节`,
  );
}
await provenanceCheck();

// ============================================================================
// observability.shared.ts — workflow 阶段事件观测层（单一构建输入）
// 已接入观测的 workflow（正文含 initObservation 调用点）由 scripts/build-workflows.mjs
// 把本文件全文拼进其两侧产物（先于业务正文——obsCtx 为 let，业务顶层赋值依赖声明在前）；
// 未接入的 workflow 不拼。本文件与业务 shared 一起过词法改写与 TS 剥离管线，无 import。
//
// 事件契约（改字段须同步 scripts/build-workflows.mjs 的 OBS_EVENT_FIELDS 与
// scripts/workflow-observe.mjs）：
//   {execution_id, task_id, skill, stage, step, round, attempt, event, timestamp,
//    sample_type[, skill_version][, outcome]}
// skill_version（增量可选字段，D6）：恒取构建器注入的 SKILL_VERSION 常量——事件回答
// 「谁在执行」，执行存量产物（产物无版本字段）时也记引擎当前版本，不记 unknown
//（unknown 仅用于 stats 的 estimated 口径归因桶）；本层只经构建器拼接消费，单独执行
// 时无该常量属拼接契约破坏（失败出声，不做静默兜底）。
// 落点 ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl——
// 每次执行独立文件，并发执行互不干扰。
// 启用条件 = args.taskId 与 args.executionId 同时提供；都不传 = 观测关闭（可选兼容，
// 业务照常）；只传其一 / ID 含路径不安全字符 / sampleType 非法 → 告警并关闭（错误可
// 操作，不静默吞）；写失败 → 告警（同文件只告警一次）不改业务终态——观测是辅助功能，
// 故障不拖垮主流程。观测只记归属与边界，不采集 token。
// IO 通道经壳的 obsNow/obsAppend 平台钩子（zcode = world.run journal 语义，resume 重放
// 回放首次记录值；pi = world.run，其 shim 内为 spawnSync，无 journal 重放语义，每次
// run 实写）。
// attempt 字段语义 = 事件发生时点的重发起序号：启动早期（自动检测未完成）为 null，
// 检测确定后由调用方回填 obsCtx.attempt，其后的事件带值。
// ============================================================================

interface ObsCtx {
  executionId: string;
  taskId: string;
  skill: string;
  stage: string;
  attempt: number | null;
  sampleType: "production" | "selftest";
  /** JSONL 落盘绝对路径；home 探针完成前为空串（obsEmit 遇空串告警并跳过该条） */
  filePath: string;
  /** 已开始未结束的 step（obsBegin 与 obsEnd/obsCloseExecution 之间的打开窗口） */
  openStep: { step: string; round: number | null } | null;
  /** 同一文件的写失败只告警一次（多轮循环不刷屏） */
  warnedWrite: boolean;
}
let obsCtx: ObsCtx | null = null;

/** ID 路径安全窄化：task-id 是观测根下的目录名、execution-id 是文件名主干——仅放行
 *  字母数字开头、只含字母/数字/点/连字符/下划线、≤128 字符、无连续点与结尾点的值，
 *  路径穿越形态（..、分隔符、空白、引号）一律拒绝 */
function obsSafeId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..") && !s.endsWith(".") ? s : null;
}

/** 观测启用（形态层，纯同步，不依赖 home）：参数形态校验 + 上下文组装。先于业务参数
 *  窄化调用，保证已传合法观测 ID 的执行（含后续参数校验失败早退）都有 execution 边界。
 *  返回 null = 本次关闭（合法关闭不告警，告警关闭经 log 输出恢复动作——关闭本身不静默）。
 *  attempt 未知时传 null，检测确定后回填 obsCtx.attempt */
function initObservation(skill: string, stage: string, attempt: number | null): ObsCtx | null {
  const hasTask = typeof args.taskId === "string" && args.taskId.trim() !== "";
  const hasExec = typeof args.executionId === "string" && args.executionId.trim() !== "";
  if (!hasTask && !hasExec) return null;
  if (hasTask !== hasExec) {
    log(
      `WARN: 观测参数不完整（taskId=${hasTask ? "已传" : "缺"}、executionId=${hasExec ? "已传" : "缺"}）——两参须同时提供才记录观测，本次不写观测事件。恢复动作：同时传 taskId 与 executionId，或都不传`,
    );
    return null;
  }
  const taskId = obsSafeId(args.taskId);
  const executionId = obsSafeId(args.executionId);
  if (taskId === null || executionId === null) {
    log(
      `WARN: 观测参数含路径不安全字符（taskId=${JSON.stringify(args.taskId)}、executionId=${JSON.stringify(args.executionId)}——合法形态：字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」与结尾点）——本次不写观测事件。恢复动作：改用安全 ID 后重新发起`,
    );
    return null;
  }
  const rawSampleType = typeof args.sampleType === "string" ? args.sampleType.trim() : "";
  if (rawSampleType !== "" && rawSampleType !== "production" && rawSampleType !== "selftest") {
    log(
      `WARN: 观测参数 sampleType=${JSON.stringify(args.sampleType)} 非法（合法值：production / selftest）——本次不写观测事件。恢复动作：修正 sampleType 后重新发起`,
    );
    return null;
  }
  const sampleType: "production" | "selftest" = rawSampleType === "selftest" ? "selftest" : "production";
  return {
    executionId,
    taskId,
    skill,
    stage,
    attempt,
    sampleType,
    filePath: "",
    openStep: null,
    warnedWrite: false,
  };
}

/** 观测落盘路径装配（home 探针成功后调用一次）；obsCtx 关闭时无操作 */
function obsAttachHome(home: string): void {
  const c = obsCtx;
  if (c === null) return;
  c.filePath = `${home}/.agents/skill-data/workflow-observability/${c.taskId}/${c.executionId}.jsonl`;
}

/** 写一条观测事件。时间戳经壳钩子取（zcode journal 语义下跨 resume 确定性回放）；
 *  时间戳探针失败、落盘路径未装配（home 未就绪）或写入失败只告警（写失败同文件一次），
 *  不改变业务终态 */
async function obsEmit(step: string, round: number | null, event: "start" | "end", outcome: string | null): Promise<void> {
  const c = obsCtx;
  if (c === null) return;
  if (c.filePath === "") {
    log("WARN: 观测落盘路径未装配（home 探针未完成或失败）——本条观测事件未记录，业务不受影响。恢复动作：确认 node 可执行后重跑");
    return;
  }
  const timestamp = await obsNow();
  if (timestamp === null) {
    log("WARN: 观测时间戳探针失败（node 子进程无输出）——本条观测事件未记录，业务不受影响。恢复动作：确认 node 可执行后重跑");
    return;
  }
  const rec: Record<string, unknown> = {
    execution_id: c.executionId,
    task_id: c.taskId,
    skill: c.skill,
    stage: c.stage,
    step,
    round,
    attempt: c.attempt,
    event,
    timestamp,
    sample_type: c.sampleType,
    skill_version: SKILL_VERSION,
  };
  if (outcome !== null) rec.outcome = outcome;
  const err = await obsAppend(c.filePath, JSON.stringify(rec));
  if (err !== null && !c.warnedWrite) {
    c.warnedWrite = true;
    log(`WARN: 观测事件写入失败（${c.filePath}）：${err}——同类失败不再重复告警，业务不受影响。恢复动作：确认该路径父目录可写（或换 executionId）后重跑`);
  }
}

/** 阶段边界：串行阶段开始记 start（同一时刻至多一个打开 step）。上一阶段尚未结束即
 *  开新阶段 = 观测序列异常：显式告警并给前一阶段补记 end（outcome=abandoned），不静默
 *  覆盖——业务流程不受影响，事件序列仍完整可对账 */
async function obsBegin(step: string, round: number | null): Promise<void> {
  const c = obsCtx;
  if (c === null) return;
  if (c.openStep !== null) {
    const prev = c.openStep;
    c.openStep = null;
    log(
      `WARN: 观测阶段重叠：step「${prev.step}」尚未结束即开始「${step}」——已给前一阶段补记 end（outcome=abandoned），业务不受影响。恢复动作：检查前一阶段的 obsEnd 配对（提前离开的路径是否漏补记）`,
    );
    await obsEmit(prev.step, prev.round, "end", "abandoned");
  }
  c.openStep = { step, round };
  await obsEmit(step, round, "start", null);
}

/** 阶段边界：自然完成记 end（无 outcome——outcome 只出现在终态统一补记或异常补记的
 *  end 上，值 = 本次执行的 terminated 词或 abandoned/script-error）。
 *  配对检查：step/round 与打开阶段不符，或当前无打开阶段时——显式告警（可操作恢复
 *  动作）；无打开阶段不写任何事件（无 start 不伪造 end），阶段错位给实际打开阶段补
 *  abandoned end（收到的错名 end 不落盘）。业务流程不受影响 */
async function obsEnd(step: string, round: number | null): Promise<void> {
  const c = obsCtx;
  if (c === null) return;
  if (c.openStep === null) {
    log(
      `WARN: 观测配对异常：收到 step「${step}」（round=${round}）的 obsEnd，但当前无打开中的阶段——未写 end 事件（无 start 不伪造 end），业务不受影响。恢复动作：检查该 step 的 obsBegin/obsEnd 配对（是否重复调用或 start 路径提前离开）`,
    );
    return;
  }
  if (c.openStep.step !== step || c.openStep.round !== round) {
    const open = c.openStep;
    c.openStep = null;
    log(
      `WARN: 观测配对异常：收到 step「${step}」（round=${round}）的 obsEnd，但当前打开的是「${open.step}」（round=${open.round}）——已给实际打开阶段补记 end（outcome=abandoned），收到的 end 未写（无对应 start 不伪造），业务不受影响。恢复动作：检查两处调用的 step/round 实参是否写反或错位`,
    );
    await obsEmit(open.step, open.round, "end", "abandoned");
    return;
  }
  c.openStep = null;
  await obsEmit(step, round, "end", null);
}

/** withStage：串行阶段包装器（obsBegin → fn → obsEnd）。fn 内经收尾出口提前离开时
 *  openStep 已被 obsCloseExecution 清空（end 已由终态统一补记），finally 不重复补
 *  end；fn 抛异常且 step 仍打开 = 脚本级中断，finally 补 end（outcome=script-error） */
async function withStage<T>(step: string, round: number | null, fn: () => Promise<T>): Promise<T> {
  await obsBegin(step, round);
  let didThrow = false;
  try {
    return await fn();
  } catch (e) {
    didThrow = true;
    throw e;
  } finally {
    const c = obsCtx;
    if (c !== null && c.openStep !== null && c.openStep.step === step) {
      c.openStep = null;
      await obsEmit(step, round, "end", didThrow ? "script-error" : null);
    }
  }
}

/** 终态统一补记：给打开中的 step 补记 end（带 outcome=本次执行终态）+ 写 execution
 *  end。由终态统一出口调用（各 workflow 的 finish / 收尾段 / 启动期失败离开点） */
async function obsCloseExecution(outcome: string): Promise<void> {
  const c = obsCtx;
  if (c === null) return;
  const open = c.openStep;
  c.openStep = null;
  if (open !== null) await obsEmit(open.step, open.round, "end", outcome);
  await obsEmit("execution", null, "end", outcome);
}

// ============================================================================
// skill-data.shared.ts — skill-data 目录寻址层（单一构建输入）
// 寻址算法唯一权威源，双形态输出（检测算法 = D1 裁决的兄弟计数，逐条落本文件）：
//   单仓形态 slug = basename(realpath(projectRoot)) + '-' + sha256(realpath(projectRoot))[:8]；
//   workspace 检测：projectRoot 父目录 P 下、与本仓同仓（git-common-dir 规范化后
//   相同）的直接子目录 worktree 集合 S——含 projectRoot 自身、.bare 主 worktree 计入、
//   游离临时 worktree（不在 P 下）天然排除；|S| ≥ 2 → 工作区形态（ws-slug =
//   basename(P) + '-' + sha256(realpath(P))[:8]，附 workspaceRoot/worktreeName）；
//   git 不可用（非 git 目录 / git 失败）或 |S| < 2 → 单仓形态兜底，输出与现行
//   算法逐字节相同（AX5：单仓项目寻址零变化）。projectRoot 不存在时第一步
//   realpath 抛错退出（设计内失败形态）。
// 消费方 = 四个业务 workflow 的探针引用点（node -e 子进程通道，argv 传
// projectRoot；NODE_PROJECT_ADDRESS 输出 JSON 契约
// { form: "workspace"|"single", slug, workspaceRoot?, worktreeName? }）；
// 构建器（scripts/build-workflows.mjs）把本文件全文整层拼进四个产物（启动校验层
// 之后、观测层之后、业务正文之前），业务源不再内联探针串——改算法只改本文件，
// 产物重建即全量生效。
//
// 固定测试向量：SKILL_DATA_SLUG_VECTORS（slug 算法）+ SKILL_DATA_DETECT_VECTORS
//（workspace 检测算法，四类 fixture）；向量对账（实跑探针对期望值）在
// scripts/tests/skill-data.test.mjs，注入不变量（产物内探针串与本文件逐字节一致）
// 在 scripts/check-workflow-parity.mjs（NODE_PROBE_HOME / NODE_PROJECT_SLUG）。
//
// 文件形态约束（三个消费方依赖，破坏即构建/检查失败）：
//   ① 无 import/export——zcode 产物禁模块语法（产物编译进函数体）；
//   ② 纯 JS 声明、无 TS 专属语法——单测经 vm 执行本文件取向量与常量；
//   ③ 探针常量保持单行、串内无双引号与反斜杠——parity 注入不变量按行正则
//      提取常量值（探针串是单引号 Node 代码，双引号只作 JS 字面量定界符）。
// ============================================================================

// home 探针：stdout = os.homedir()（观测层与 skill-data 落盘根的 home 前缀来源）
const NODE_PROBE_HOME = "process.stdout.write(require('os').homedir())";

// project-slug 探针：argv=[projectRoot] → stdout = basename-realhash8
//（realpath + sha256 前 8 位十六进制小写；单仓形态算法，逐字节等于本文件接管前的
// 各业务源内联实现——见文件头注的固定向量与对账位置）
const NODE_PROJECT_SLUG = "const p=require('fs').realpathSync(process.argv[1]);const h=require('crypto').createHash('sha256').update(p).digest('hex').slice(0,8);process.stdout.write(p.split('/').filter(Boolean).pop()+'-'+h)";

// project 寻址探针：argv=[projectRoot] → stdout = JSON（双形态输出契约）
// { form: "workspace"|"single", slug, workspaceRoot?, worktreeName? }。
// 算法（D1 兄弟计数，头注全称）：git 可用时先取本仓 common-dir（rev-parse
// --git-common-dir，相对输出按 projectRoot 规范化——主 worktree 输出 '.git'、
// 裸仓输出 '.'）；worktree list --porcelain 枚举本仓全部 worktree，对每个候选以
// 其自身路径为基准规范化 common-dir（链接 worktree 的 .git 是指路文件、common-dir
// 是共享目录，两处 realpath 后同一物理目录），凡「dirname 位于 P 且 common-dir
// 与本仓相同」者进 S（porcelain 里 prunable 已删除条目因 realpath 失败保留原值、
// git -C 失败被排除）；|S| ≥ 2 → workspace，否则 / 任一步 git 失败 → single 兜底
//（slug 派生与 NODE_PROJECT_SLUG 逐表达式相同）。探针串形态约束见头注 ③：
// 无双引号无反斜杠——换行解析用 String.fromCharCode(10) 而非转义
const NODE_PROJECT_ADDRESS = "const fs=require('fs'),cp=require('child_process'),cr=require('crypto'),pt=require('path');const root=fs.realpathSync(process.argv[1]);const slugOf=x=>x.split('/').filter(Boolean).pop()+'-'+cr.createHash('sha256').update(x).digest('hex').slice(0,8);const norm=(x,b)=>{const a=pt.isAbsolute(x)?x:pt.join(b,x);try{return fs.realpathSync(a)}catch(e){return a}};const single=()=>JSON.stringify({form:'single',slug:slugOf(root)});const detect=()=>{const g=cp.spawnSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'});if(g.status!==0||!String(g.stdout||'').trim())return single();const cd=norm(String(g.stdout).trim(),root);const w=cp.spawnSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'});if(w.status!==0)return single();const parent=pt.dirname(root);const sibs=[];for(const line of String(w.stdout||'').split(String.fromCharCode(10))){if(line.indexOf('worktree ')!==0)continue;const wt=norm(line.slice(9),root);const gw=cp.spawnSync('git',['-C',wt,'rev-parse','--git-common-dir'],{encoding:'utf8'});if(gw.status!==0||norm(String(gw.stdout||'').trim(),wt)!==cd)continue;if(pt.dirname(wt)===parent)sibs.push(wt)}if(sibs.length>=2)return JSON.stringify({form:'workspace',slug:slugOf(norm(parent,parent)),workspaceRoot:parent,worktreeName:root.split('/').filter(Boolean).pop()});return single()};process.stdout.write(detect())";

// 固定测试向量（slug 算法）：fixture = 输入根的标识（单测按标识解析为真实路径——
// 绝对路径不入仓，本仓检出根在单测内动态派生），slug = 探针对该根输出的期望值
const SKILL_DATA_SLUG_VECTORS = [
  { fixture: "repo-root", label: "zsw-skills 检出根（本仓）", slug: "zsw-skills-4ca4846f" },
];

// 固定测试向量（workspace 检测算法，D1/RL5）：kind = fixture 构造形态（单测按 kind
// 在临时目录构造对应仓库拓扑——git init / git worktree add 在测试内完成、属被测
// 行为，fixture 用完即删；绝对路径不入仓），expectForm = 对探测根的主形态断言
const SKILL_DATA_DETECT_VECTORS = [
  { kind: "bare-siblings-stray", label: "tai-ji 实形：.bare 主仓 + 兄弟 worktree + 游离临时目录 worktree", expectForm: "workspace" },
  { kind: "plain-checkout", label: "单仓：普通检出（slug 与现行算法逐字节一致）", expectForm: "single" },
  { kind: "stray-worktree", label: "游离 worktree：临时目录内 worktree 的形态输出确定", expectForm: "single" },
  { kind: "non-git", label: "非 git 目录：退单仓兜底不抛错", expectForm: "single" },
];

const SKILL_VERSION = "0.3.2"; // 构建注入自 tech-design-wf/SKILL.md frontmatter version（唯一权威）
// ============================================================================
// tech-review-loop — tech-design-wf 技能 W1 审查循环（zcode 动态工作流）
// 骨架镜像自 saved review-fix-loop.dwf.ts（多脚本循环骨架 = 镜像 + 头部差异登记，
// 改动任一侧循环骨架时评估另一侧是否需要同步）。语义权威源 = tech-design-wf
// 设计文档 §5（轮次形态唯一定义 / 停机线 / 终态与停回通道）。与 rfl 的结构差异：
//  - 维度固定四席（方向审席 + 三审同轮并行、同一对账契约——方向审 patch 档发现进
//    当轮问题清单由文档修复者处置，审查-修改闭环收在 workflow 内），无 rfl 的批内
//    慢快池调度（四席恒定并行，无分批收益）
//  - 聚合裁决是独立 phase（对齐 rfl 框架）：四席发现先经聚合裁决员合并为去重权威
//    清单 aggregated.md（refs 对原始清单的精确划分由脚本 fail-closed 校验——漏报 /
//    重叠 / 幻觉 ref 均打回重试）；修复保持单 agent（同一设计目录六个章节 JSON，
//    并行写者互相覆盖——C2 单写者约束保留，语义去重已上收独立 phase）
//  - 对账对象 = 上轮处置表（dispositions），非 rfl 的 issue 台账；deferred/archived
//    条目的唯一复活入口 = reviewer reconciliation status="escalate" 结构化申报
//  - 终态枚举按设计 §5.3：direction-rejected / converged / escalated / stuck /
//    max-rounds（+ 环节失败三态）；escalated 一律停回用户裁决，不轮内自行重跑
//    方案对比（F18：方向裁决权上收）；direction-rejected 只在方向审席判 rewrite 档
//    （问题定义/方案主干/分型被击穿）时到达——patch 档常规发现走轮内修复闭环，不外溢
//  - runDir 命名按 F22：tech-design 段工作区级共享（workspace 形态 = <ws-slug>/<设计目录
//    basename>/，无 worktree 段；单仓形态为现行平铺）。寻址算法与双形态约定见
//    skill-data-addressing.md（本文件只消费检测探针输出，不内联算法），重发起轮次目录
//    带 attempt 后缀（round-3.attempt2），不覆盖历史
//  - designDoc 语义 = 设计目录（六个章节 JSON 权威源所在）或其渲染 md 路径（以
//    .rendered.md 结尾时取其目录归一）；setup 对设计目录跑 check-design-doc.mjs
//    （exit 0 = 进场门槛，非 0 = setup-failure 且 message 透传校验脚本 stdout——含
//    md 输入的迁移指引），随后跑 render-design-doc.mjs 刷新阅读视图（幂等）——方向审 /
//    三审读渲染视图（需核对结构化字段时提示读章节 JSON）；修复者直接编辑章节 JSON
//    （逐文件小步修改）、修改后重渲染并同步跨章节引用字段
//  - 一切失败 failed-as-return（T8：throw 的 errored run 不可 resume）——含未知
//    参数键白名单 fail-fast 也走 return（rfl 此处用 throw，本脚本按 T8 收紧）
// 数据传递 = 文件总线（沿 rfl 惯例）：报告 / 处置表落盘于 runDir，ask 只传路径；
// 结构化返回值只承载控制数据（计数 / 对账 / 处置）。
// ============================================================================

// ── 常量（控制流专用，不内插进任何 ask 文本） ──
const DEFAULT_MAX_ROUNDS = 10;
const STUCK_THRESHOLD = 3;
const FIX_RETRY_MAX = 3; // 修复者结构化返回校验失败的重试上限（初始 1 次 + 回喂重试 3 次，与其他 agent 的 STRUCTURED_RETRY_MAX 对齐）
// T9（用户裁决 2026-09-26）：workflow 内无用户交互位，任何 agent 不得提问——随 persona 固化
//（定义置于文件顶部常量区：方向审的顶层 await 调用早于 persona 常量区，晚定义会 TDZ）
const NO_ASK_RULE =
  "禁止向用户提问（无 AskUserQuestion / ask-user / 任何等待用户输入的操作）——workflow 内没有用户交互位；" +
  "无法自决的事项按职责内默认规则处置，并在产出中记录待裁决事项（随终态呈报主 agent / 用户）。";
const VALID_ARG_KEYS = new Set([
  "designDoc",
  "projectRoot",
  "maxRounds",
  "reviewers",
  "attempt",
  // 观测（O 区，可选）：taskId+executionId 同时提供才启用（sampleType 默认 production）
  "taskId",
  "executionId",
  "sampleType",
]);

// node -e 通道（argv 传参，无 shell 注入面；node 代码不受脚本 facade 限制）
const NODE_WRITE_FILE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const NODE_CHECK_EXISTS =
  "const fs=require('fs');const missing=process.argv.slice(1).filter(p=>!fs.existsSync(p));if(missing.length>0){process.stdout.write(missing.join(' | '));process.exit(1)}";
const NODE_EXISTS_ONE = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";
// 寻址探针：NODE_PROJECT_ADDRESS 由构建器从 workflows/src/skill-data.shared.ts
// 整层注入（寻址算法唯一权威源——算法、固定向量与注入对账位置见该文件头注）

/** NODE_PROJECT_ADDRESS 输出契约：workspace 形态携带 workspaceRoot / worktreeName，
 *  single 形态只有 slug。tech-design 段是工作区级共享（设计包是仓库级资产），两级化只
 *  换父目录（per-worktree slug → ws-slug），不加 worktree 段 */
type ProjectAddress = { form: "single" | "workspace"; slug: string };

/** 解析寻址探针输出；形态非法返回 null（调用方按 setup-failure 处理，不猜默认值） */
function parseProjectAddress(raw: string): ProjectAddress | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.slug !== "string" || v.slug === "") return null;
    if (v.form === "single" || v.form === "workspace") return { form: v.form, slug: v.slug };
    return null;
  } catch {
    return null;
  }
}

// run manifest 探针组（skill-data-redesign §5.1：终态在 runDir 根写 run.json）：
// NODE_PROBE_NOW 取当前时刻（ISO8601）。startedAt 必须经 world.run 探针取而不能脚本内
// new Date()——world.run 是 journal 语义（resume 重放回放首次记录值），startedAt 因此跨
// resume 构造性稳定，run.json 防覆盖判据（startedAt 相同 = 同一次 run）才成立
const NODE_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
// argv: [projectRoot] → stdout = JSON {branch, head}（当前分支名 + HEAD hash）；git 失败
// 输出 null 形态——manifest 是分析契约，探针 fail-soft 置 null，不改变终态
const NODE_GIT_REV =
  "try{var g=require('child_process').execFileSync;" +
  "var b=g('git',['-C',process.argv[1],'rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8'}).trim();" +
  "var h=g('git',['-C',process.argv[1],'rev-parse','HEAD'],{encoding:'utf8'}).trim();" +
  'process.stdout.write(JSON.stringify({branch:b,head:h}))}catch(e){process.stdout.write(JSON.stringify({branch:null,head:null}))}';
// argv: [runJsonPath, payloadJson, startedAt] → 写 run.json + 防覆盖轮转：已存在的
// run.json 其 startedAt 与本次不同 → 先 rename 为 run-<旧startedAt 冒号换连字符>.json
// 归档（新 run 不冲掉上一 run 的分析数据）；startedAt 相同（resume 重放）→ 直接覆写；
// 旧文件缺失/损坏/无 startedAt（无判据可归档）→ 覆盖
const NODE_WRITE_RUN_JSON =
  "var fs=require('fs'),pt=require('path');" +
  "try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true})}catch(e){}" +
  "try{var oldRun=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(oldRun&&typeof oldRun.startedAt==='string'&&oldRun.startedAt!==process.argv[3]){fs.renameSync(process.argv[1],pt.join(pt.dirname(process.argv[1]),'run-'+oldRun.startedAt.replace(/:/g,'-')+'.json'))}}catch(e){}" +
  "fs.writeFileSync(process.argv[1],process.argv[2])";

// ── run manifest（skill-data-redesign §5.1 统一 schema）：终态收尾在 runDir 根写
// run.json（分析契约）；terminated 沿用本循环终态词表，分析侧按 workflow 字段分组解读。
// host 由壳平台常量 HOST_PLATFORM 注入（shared 不留 host 硬编码）；model 置 null——
// facade 不暴露本次 run 的模型标识，不为此扩 agent 调用契约
interface RunManifest {
  workflow: string;
  segment: "tech-design" | "dev-flow";
  /** 产物溯源字段：构建注入常量（所属技能 SKILL.md frontmatter version，唯一权威——
   *  本循环 = tech-design-wf）。只读溯源，不参与任何执行裁决（路由只看 schemaVersion） */
  skillVersion: string;
  host: string;
  projectRoot: string;
  /** 无独立 worktree 概念的循环 = projectRoot */
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  attempt: number;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  terminated: string;
  rounds: number;
  /** tech-review-loop = must-fix 计数序列（与 final.json 同名字段同源，不二次计算）；
   *  无审查轮的循环置 null */
  mustFixTrajectory: number[] | null;
}

// ── 参数窄化（纯函数，便于片段级验证） ──

/** designDoc 归一：设计目录直接用；渲染 md 路径（.rendered.md 结尾）取其目录。
 *  其余 .md 输入原样透传——由 setup 的 check 脚本输出迁移指引 */
function normalizeDesignDoc(p: string): string {
  if (!p.endsWith(".rendered.md")) return p;
  const stem = p.slice(0, -".rendered.md".length);
  const slash = stem.lastIndexOf("/");
  return slash > 0 ? stem.slice(0, slash) : slash === 0 ? "/" : stem;
}

function deriveInputs(raw: Record<string, unknown>): NarrowedInputs {
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    // `_` 前缀 = 宿主运行时私有键（如 taiji/pi 宿主注入的 _runId），不属于脚本契约，跳过白名单（2026-10-03 实测缺陷修复）
    if (!VALID_ARG_KEYS.has(key) && !key.startsWith("_")) {
      problems.push(
        `未知参数: ${key}（合法参数: ${[...VALID_ARG_KEYS].join("/")}）——拼错的参数会被静默忽略并回落默认值，故 fail-fast`,
      );
    }
  }
  const isAbs = (v: unknown): v is string => typeof v === "string" && v.trim().startsWith("/");
  const designDoc = normalizeDesignDoc(isAbs(raw.designDoc) ? raw.designDoc.trim().replace(/\/+$/, "") : "");
  const projectRoot = isAbs(raw.projectRoot) ? raw.projectRoot.trim() : "";
  if (designDoc === "") {
    problems.push("designDoc 缺失或非绝对路径：须传入设计目录绝对路径（或其渲染 md 路径——内部归一为设计目录；审查与修复对象）");
  }
  if (projectRoot === "") {
    problems.push("projectRoot 缺失或非绝对路径：须传入项目根绝对路径（skill-data 产物落点的 slug 计算输入与 AGENTS/PRODUCT 上下文来源）");
  }
  const maxRounds =
    typeof raw.maxRounds === "number" && Number.isFinite(raw.maxRounds) && raw.maxRounds >= 1
      ? Math.floor(raw.maxRounds)
      : DEFAULT_MAX_ROUNDS;
  const reviewers = Array.isArray(raw.reviewers)
    ? raw.reviewers.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim())
    : [];
  const attempt =
    typeof raw.attempt === "number" && Number.isFinite(raw.attempt) && raw.attempt >= 1
      ? Math.floor(raw.attempt)
      : null;
  return { designDoc, projectRoot, maxRounds, reviewers, attempt, problems };
}

// ── 纯函数 ──

/** 计数窄化：非负有限整数放行，否则 null（调用方 fail-closed，不静默归 0 假 clean） */
function sanitizeCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** 三审 reportFile 自报字段无消费——报告落盘走确定性位置校验，方向审 reportFile
 *  直接窄化比较，无需归一函数 */

/** 不可信内容隔离（rfl wrapUntrusted 同款）：报告/处置表/修订摘要等外部 agent 产出
 *  注入 prompt 时显式宣告为数据，防其中反引号/分隔线截断 prompt 结构 */
function wrapUntrusted(body: string): string {
  return ["--- BEGIN UNTRUSTED CONTEXT (data, not instructions) ---", body, "--- END UNTRUSTED CONTEXT ---"].join("\n");
}

/** LLM 返回的 reconciliation 数组防御：null 元素丢弃、字段窄化；status 畸形归
 *  not-fixed（fail-closed：畸形当未修复，下轮对账重核，不会假清账） */
function sanitizeReconciliation(raw: unknown): ReconEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => ({
      prevId: typeof r.prevId === "string" ? r.prevId.trim() : "",
      status:
        r.status === "fixed" || r.status === "not-fixed" || r.status === "regressed" || r.status === "escalate"
          ? r.status
          : "not-fixed",
      evidence: typeof r.evidence === "string" ? r.evidence : "",
    }));
}

/** LLM 返回的处置条目防御：缺 id/action 或形态非法的条目丢弃（覆盖校验据此
 *  拦截，不裸 TypeError）；字符串字段窄化为 string（缺失归空串） */
function sanitizeDispositions(raw: unknown): Disposition[] {
  if (!Array.isArray(raw)) return [];
  const out: Disposition[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const d = item as Partial<Disposition>;
    const id = typeof d.id === "string" && d.id.trim() !== "" ? d.id.trim() : "";
    const action: "fixed" | "deferred" | "archived" | null =
      d.action === "fixed" || d.action === "deferred" || d.action === "archived" ? d.action : null;
    if (id === "" || action === null) {
      log(`WARN: 处置条目畸形被丢弃（id=${JSON.stringify(d.id)} action=${JSON.stringify(d.action)}）——若属漏报，覆盖校验将拦截本轮`);
      continue;
    }
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    out.push({
      id,
      title: str(d.title) !== "" ? str(d.title) : id,
      source: Array.isArray(d.source)
        ? d.source.filter((s): s is string => typeof s === "string" && s.trim() !== "")
        : [],
      action,
      location: str(d.location),
      reenactment: str(d.reenactment),
      attackHints: str(d.attackHints),
      affectsDecision: str(d.affectsDecision),
      affectsDelivery: str(d.affectsDelivery),
    });
  }
  return out;
}

/** blocked 申报防御：形态非法归 null（调用方按 status 判别——status="blocked" 时归 null
 *  即对象残缺走回喂；done 形态不读该字段，附带杂物无效），字段窄化 */
function sanitizeBlocked(raw: unknown): { items: string[]; reason: string } | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const b = raw as { items?: unknown; reason?: unknown };
  const items = Array.isArray(b.items)
    ? b.items.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : [];
  const reason = typeof b.reason === "string" ? b.reason : "";
  if (items.length === 0 && reason === "") return null;
  return { items, reason };
}

/** reviewer 返回的问题清单防御：ref 形态非法的条目丢弃；当轮计数以清单派生为准
 *  （自报 mustFix 仅做交叉校验——单一事实源，防「计数对、清单漏」的对账失配） */
function sanitizeProblems(raw: unknown): { ref: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { ref: string; title: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const p = item as Partial<{ ref: string; title: string }>;
    const ref = typeof p.ref === "string" ? p.ref.trim() : "";
    if (ref === "") {
      log(`WARN: 问题清单条目畸形被丢弃（ref=${JSON.stringify(p.ref)}）——丢弃后计数以剩余清单派生`);
      continue;
    }
    out.push({ ref, title: typeof p.title === "string" ? p.title.trim() : "" });
  }
  return out;
}

// ── 结构化返回校验回喂（用户裁决 2026-09-26：全部 agent 结构化返回必备，回喂重试上限 3 次）──
// rawAsk 由调用方闭包提供（用各自具体类型调 ask——pi 构建管线按泛型名查 SCHEMA_BY_KEY，
// 帮手内不能出现平台 ask 的泛型调用）；回喂 prompt 自包含重发原指令（pi 侧每次新 agent）。
const STRUCTURED_RETRY_MAX = 3;

type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

async function askValidated<T>(
  validate: (v: unknown) => Validated<T>,
  rawAsk: (prompt: string) => PromiseLike<T>,
  prompt: string,
): Promise<T | null> {
  let last = await rawAsk(prompt);
  for (let i = 1; i <= STRUCTURED_RETRY_MAX; i++) {
    const v = validate(last);
    if (v.ok) return v.value;
    last = await rawAsk(
      [
        `你上一轮的结构化返回未通过机器校验，错误清单：`,
        ...v.errors.map((e) => `- ${e}`),
        ``,
        `重新返回完整 JSON（全量重新给出，不是增量补丁；除该 JSON 外不要改任何已落盘产物）。`,
        ``,
        `（同一子代理续写——完整任务上下文见前文对话，无需重述任务。你的任务开头摘录：${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}）`,
      ].join("\n"),
    );
  }
  const fin = validate(last);
  return fin.ok ? fin.value : null;
}

/** 方向审席返回校验：三审同构（计数 / problems / reconciliation）+ 打回档位枚举 + oneliner */
function validateDirectionVerdict(v: unknown): Validated<DirectionVerdict> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (sanitizeCount(o["mustFix"]) === null) errors.push("mustFix 须为非负整数（与报告一致）");
  if (o["fixScope"] !== "patch" && o["fixScope"] !== "rewrite") {
    errors.push('fixScope 须为 "patch"（全部发现属前提层/产物表/措辞级，问题定义与方案主干不动）或 "rewrite"（问题定义/方案主干/分型被击穿）；mustFix=0 时填 "patch"');
  }
  if (typeof o["oneliner"] !== "string") errors.push("oneliner 须为字符串");
  if (!Array.isArray(o["reconciliation"])) errors.push("reconciliation 须为数组（R1 为空数组）");
  const rawProblems = o["problems"];
  if (!Array.isArray(rawProblems)) errors.push("problems 须为数组（逐条 {ref, title}）");
  else {
    const badIdx: string[] = [];
    rawProblems.forEach((item, i) => {
      if (item === null || typeof item !== "object") {
        badIdx.push(String(i + 1));
        return;
      }
      const p = item as Partial<{ ref: string }>;
      if (typeof p.ref !== "string" || p.ref.trim() === "") badIdx.push(String(i + 1));
    });
    if (badIdx.length > 0) errors.push(`problems 第 ${badIdx.join("、")} 条畸形（ref 须非空字符串）`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as DirectionVerdict };
}

/** 三审返回校验：计数非负整数 + problems 清单逐条形态合法（ref/title）+ reconciliation 数组 */
function validateReviewerVerdict(v: unknown): Validated<ReviewerVerdict> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (sanitizeCount(o["mustFix"]) === null) errors.push("mustFix 须为非负整数（与报告一致）");
  const rawProblems = o["problems"];
  if (!Array.isArray(rawProblems)) errors.push("problems 须为数组（逐条 {ref, title}）");
  else {
    const badIdx: string[] = [];
    rawProblems.forEach((item, i) => {
      if (item === null || typeof item !== "object") {
        badIdx.push(String(i + 1));
        return;
      }
      const p = item as Partial<{ ref: string }>;
      if (typeof p.ref !== "string" || p.ref.trim() === "") badIdx.push(String(i + 1));
    });
    if (badIdx.length > 0) errors.push(`problems 第 ${badIdx.join("、")} 条畸形（ref 须非空字符串）`);
  }
  if (!Array.isArray(o["reconciliation"])) errors.push("reconciliation 须为数组（R1 为空数组）");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as ReviewerVerdict };
}


/** 聚合裁决返回校验（工厂形态——划分校验需要闭包原始 ref 集）：items 形态合法 +
 *  refs 全体构成原始清单的精确划分（漏报 = 静默丢失、重叠 = 二次去重失准、
 *  幻觉 ref = 无中生有，三者均 fail-closed 回喂重试，不静默修补） */
function makeAggregationValidator(rawRefs: string[]): (v: unknown) => Validated<AggregationOutcome> {
  const rawRefSet = new Set(rawRefs);
  return (v: unknown): Validated<AggregationOutcome> => {
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    const errors: string[] = [];
    if (!Array.isArray(o["items"])) {
      return { ok: false, errors: ["items 须为数组（每条 { refs, title, guidance }）"] };
    }
    const seen = new Map<string, number>(); // ref -> 首次出现的聚合项序号
    (o["items"] as unknown[]).forEach((item, i) => {
      if (item === null || typeof item !== "object") {
        errors.push(`items[${i}] 须为对象`);
        return;
      }
      const it = item as Partial<AggregatedItem>;
      if (!Array.isArray(it.refs) || it.refs.length === 0) {
        errors.push(`items[${i}] refs 须为非空数组`);
        return;
      }
      for (const r of it.refs) {
        if (typeof r !== "string" || r.trim() === "") {
          errors.push(`items[${i}] refs 含空串`);
        } else if (!rawRefSet.has(r)) {
          errors.push(`items[${i}] refs 含原始清单不存在的「${r}」（幻觉 ref——只能引用四席报告的既有锚点）`);
        } else if (seen.has(r)) {
          errors.push(`ref「${r}」同时出现在 items[${seen.get(r)}] 与 items[${i}]（每条原始 ref 恰好归属一条聚合项）`);
        } else {
          seen.set(r, i);
        }
      }
      if (typeof it.title !== "string" || it.title.trim() === "") errors.push(`items[${i}] title 须非空`);
      if (typeof it.guidance !== "string" || it.guidance.trim() === "") errors.push(`items[${i}] guidance 须非空（合并后的可执行修复操作清单）`);
    });
    const missing = rawRefs.filter((r) => !seen.has(r));
    if (missing.length > 0) {
      errors.push(`以下原始 ref 未被任何聚合项覆盖（禁止静默丢弃）：${missing.join("、")}`);
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as AggregationOutcome };
  };
}

/** 聚合清单 markdown 人读版（脚本从结构化数据确定性渲染，保证 json 与 md 一致；AG 序号脚本按序分配） */
function renderAggregatedMd(round: number, items: AggregatedItem[]): string {
  const lines: string[] = [`# 聚合清单（第 ${round} 轮）`, ""];
  items.forEach((it, i) => {
    lines.push(
      `## AG-${i + 1} ${it.title}`,
      `- 原始 ref：${it.refs.join("、")}`,
      `- 修复指导：${it.guidance}`,
      "",
    );
  });
  return lines.join("\n");
}

/** 处置表台账合并：延续条目（id 命中）原位更新并按 action 重置复核状态；新条目入账 */
function mergeRound(disps: Disposition[], round: number, ledger: LedgerEntry[]): void {
  for (const d of disps) {
    const prev = ledger.find((e) => e.id === d.id);
    if (prev !== undefined) {
      prev.title = d.title;
      prev.source = d.source;
      prev.action = d.action;
      prev.location = d.location;
      prev.reenactment = d.reenactment;
      prev.attackHints = d.attackHints;
      prev.affectsDecision = d.affectsDecision;
      prev.affectsDelivery = d.affectsDelivery;
      prev.lastRound = round;
      prev.status = d.action === "fixed" ? "pending" : "parked";
    } else {
      ledger.push({
        ...d,
        status: d.action === "fixed" ? "pending" : "parked",
        firstRound: round,
        lastRound: round,
      });
    }
  }
}

/** 处置表 markdown 人读版（脚本从结构化数据确定性渲染，保证 json 与 md 一致） */
function renderDispositionsMd(round: number, disps: Disposition[], revisionSummary: string): string {
  const lines: string[] = [
    `# 处置表（第 ${round} 轮）`,
    "",
    `修订摘要：${revisionSummary}`,
    "",
  ];
  for (const d of disps) {
    lines.push(
      `## ${d.id} → ${d.action}`,
      `- 标题：${d.title}`,
      `- 来源：${d.source.length > 0 ? d.source.join("；") : "(无)"}`,
      `- 修订位置：${d.location}`,
      `- 反例重演：${d.reenactment}`,
      `- 攻击点建议：${d.attackHints}`,
      `- 影响决策：${d.affectsDecision}`,
      `- 影响交付：${d.affectsDelivery}`,
      "",
    );
  }
  return lines.join("\n");
}

/** 终态 markdown（artifact 发布用，与 final.json 同源数据） */
function renderFinalMd(r: LoopResult): string {
  const lines: string[] = [
    `# 设计审查终态：${r.terminated}`,
    "",
    `- 设计文档：${r.designDoc}`,
    `- 产物目录：${r.runDir}`,
    `- 审查轮数：${r.rounds}${r.mustFixTrajectory.length > 0 ? `（must-fix 轨迹：${r.mustFixTrajectory.join(" → ")}）` : ""}`,
    `- 方向判定：${r.directionOneliner !== "" ? r.directionOneliner : "（未到达）"}`,
    `- 终态说明：${r.message}`,
  ];
  if (r.blocked !== null) {
    lines.push("", "## 方案性卡点（待用户裁决）", `- 原因：${r.blocked.reason}`);
    for (const it of r.blocked.items) lines.push(`- ${it}`);
  }
  if (r.remaining.length > 0) {
    lines.push("", "## 残余条目（未收敛/未复核）");
    for (const d of r.remaining) lines.push(`- ${d.id} [${d.status}] ${d.title} — ${d.attackHints}`);
  }
  return lines.join("\n");
}

// ── 观测启用（O 区形态层）：先于参数窄化——已传合法观测 ID 的执行（含参数校验失败
// 早退）都有 execution 边界；attempt 自动检测未完成时为 null，检测确定后回填。落盘
// 路径依赖 home，探针通过后装配 ──
obsCtx = initObservation("tech-design-wf", "T2", null);

// home 探针（先于参数窄化：观测落盘路径装配与模板 ~ 展开共同依赖）
const homeRes = await world.run("node", ["-e", "process.stdout.write(require('os').homedir())"]);
if (homeRes.exitCode !== 0 || homeRes.stdout.trim() === "") {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc: "",
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `无法解析用户 home 目录（node os.homedir 探针失败，exit ${homeRes.exitCode}）：${homeRes.stderr.trim()}。恢复动作：确认 node 可执行后重新发起`,
  };
}
const home = homeRes.stdout.trim();
const expandTilde = (p: string): string => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);

if (obsCtx !== null) {
  obsAttachHome(home);
  await obsEmit("execution", null, "start", null);
  await obsBegin("setup", null);
}

// ── 参数窄化执行 + 早期失败（failed-as-return，不 throw） ──
const inputs = deriveInputs(args);
if (inputs.problems.length > 0) {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc: inputs.designDoc,
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `参数校验失败：${inputs.problems.join("；")}。恢复动作：${HINT_RELAUNCH_WITH_ARGS}`,
  };
}
const { designDoc, projectRoot, maxRounds } = inputs;

// ── 环境准备（runDir / attempt / 模板探针） ──
phase("校验审查环境并做方向审");

// runDir 命名（F22）：tech-design 段 = 工作区级共享（无 worktree 段——设计包是仓库级资产，
// 任何 worktree 的入口门都发现同一设计包）。两级化只换父目录：workspace 形态 slug = ws-slug，
// 单仓形态退回现行平铺（AX5 逐字节不变）；<ws-slug>/ 目录内部排布与现行 slug 目录完全一致。
// designDoc 已归一为设计目录，basename 即设计名；约定见 skill-data-addressing.md
const docBase = designDoc.split("/").pop() ?? designDoc;
const docName = docBase.replace(/\.[^.]+$/, "");
// 寻址检测探针：realpath / git 失败 = projectRoot 不存在或不可寻址，setup-failure
const addressRes = await world.run("node", ["-e", NODE_PROJECT_ADDRESS, projectRoot]);
const address = addressRes.exitCode === 0 ? parseProjectAddress(addressRes.stdout) : null;
if (address === null) {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit ${addressRes.exitCode}）：${addressRes.stderr.trim() || addressRes.stdout.trim()}。恢复动作：确认 projectRoot 目录存在后重新发起`,
  };
}
const runDir = `${home}/.agents/skill-data/tech-design/${address.slug}/${docName !== "" ? docName : "design"}`;
const finalJsonPath = `${runDir}/final.json`;

// run manifest startedAt（循环启动时记录；探针失败 = 防覆盖判据不可用，终态时放弃写
// run.json 只告警——终态数据以 final.json 与返回值为准）
const startedAtRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
const runStartedAt =
  startedAtRes.exitCode === 0 && startedAtRes.stdout.trim() !== "" ? startedAtRes.stdout.trim() : null;

/** run.json 终态落盘（best-effort：失败只告警——终态数据以返回值为准）；防覆盖轮转
 *  判定在 NODE_WRITE_RUN_JSON 内（旧文件 startedAt 不同 → rename 归档后覆写） */
async function writeRunManifest(m: RunManifest): Promise<void> {
  const w = await world.run("node", ["-e", NODE_WRITE_RUN_JSON, `${runDir}/run.json`, JSON.stringify(m, null, 2), m.startedAt]);
  if (w.exitCode !== 0) {
    log(`WARN: run.json 落盘失败（exit ${w.exitCode}：${w.stderr.trim() || w.stdout.trim()}）——终态数据以 final.json 与返回值为准`);
  }
}

/** git 探针（NODE_GIT_REV）→ {branch, head}；输出形态非法全 null（fail-soft，不改变终态） */
async function gitRevProbe(): Promise<{ branch: string | null; head: string | null }> {
  const r = await world.run("node", ["-e", NODE_GIT_REV, projectRoot]);
  try {
    const v = JSON.parse(r.stdout) as { branch: unknown; head: unknown };
    return {
      branch: typeof v.branch === "string" && v.branch !== "" ? v.branch : null,
      head: typeof v.head === "string" && v.head !== "" ? v.head : null,
    };
  } catch {
    return { branch: null, head: null };
  }
}

// 重发起检测：扫描 runDir 内已有 attempt 后缀的最大序号（round-*.attemptM），未显式传
// attempt → 取 max+1（多次重发起不覆盖历史——固定取 2 会覆盖第三次及以后的 attempt2 产物）；
// 无 attempt 后缀时 runDir 已有任何轮次产物（无后缀 round-* 或 final.json）→ 取 1
//（缺省 attempt=2），防首次重发起覆盖首轮产物
const ATTEMPT_SCAN =
  "try{var fs=require('fs');var names=[];try{names=fs.readdirSync(process.argv[1])}catch(e){}var mx=0;" +
  "for(var n of names){var m=/^round-\\d+\\.attempt(\\d+)$/.exec(n);if(m){var v=Number(m[1]);if(v>mx)mx=v}}" +
  "if(mx===0&&(names.some(n=>/^round-\\d+$/.test(n))||names.indexOf('final.json')>=0))mx=1;" +
  "if(mx>0)process.stdout.write(String(mx))}catch(e){}";
const attemptProbe = await world.run("node", ["-e", ATTEMPT_SCAN, runDir]);
const prevAttemptMax =
  attemptProbe.exitCode === 0 && /^\d+$/.test(attemptProbe.stdout.trim()) ? Number(attemptProbe.stdout.trim()) : 0;
const attempt = inputs.attempt !== null ? inputs.attempt : prevAttemptMax > 0 ? prevAttemptMax + 1 : 1;
const roundDirName = (n: number): string => (attempt > 1 ? `round-${n}.attempt${attempt}` : `round-${n}`);

// attempt 检测确定后回填观测上下文（execution/setup start 事件时点尚未检测，记 null；
// 其后的事件带值——attempt 字段语义见观测层头注）
if (obsCtx !== null) obsCtx.attempt = attempt;

// 默认 reviewer 模板（脚本内字面量，~ 运行时展开）；args.reviewers 按 basename 覆盖同名维度
const TEMPLATE_BASENAMES: { dim: string; file: string }[] = [
  { dim: "direction", file: "tech-design-direction-review.md" },
  { dim: "main", file: "tech-design-review.md" },
  { dim: "impact", file: "tech-design-impact-review.md" },
  { dim: "simplicity", file: "tech-design-simplicity-review.md" },
];
const TILDE_ROOT = "~/.agents/skills/tech-design-wf/agents";
const RUBRIC_TILDE = "~/.agents/skills/tech-design-wf/review/rubric-design-doc.md";
// 原则层（D 系列方向审攻击的产物表规格与触发条件来源，flow/review.md Step 2 同源）
const PRINCIPLES_TILDE = "~/.agents/skills/tech-design-wf/references/principles.md";
// 章节 JSON 字段规格（修复者编辑章节 JSON 的字段权威定义；渲染产物的命名 = 目录 basename
// + .rendered.md，与渲染脚本一致）
const SCHEMA_TILDE = "~/.agents/skills/tech-design-wf/references/design-doc-schema.md";
// 设计文档机器校验 CLI（T2 进场门槛——flow/review.md 手工路径同一实现；对 md 输入输出迁移指引）
const CHECK_DESIGN_TILDE = "~/.agents/skills/tech-design-wf/scripts/check-design-doc.mjs";
// 渲染 CLI（阅读视图刷新：setup 刷新一次保证审查者读到的视图与章节 JSON 一致；修复者每轮
// 修改章节 JSON 后由 prompt 指令重跑）
const RENDER_TILDE = "~/.agents/skills/tech-design-wf/scripts/render-design-doc.mjs";
// 处置表业务级校验 CLI（覆盖完整性 + 条目一致性；workflow 与 flow/review.md 手工路径
// 双轨共用同一实现——校验器单一来源，双轨语义等价由同一脚本保证）
const CHECK_CLI_TILDE = "~/.agents/skills/tech-design-wf/scripts/check-dispositions.mjs";
const overrides = new Map<string, string>();
for (const p of inputs.reviewers) {
  const base = p.split("/").pop() ?? p;
  const hit = TEMPLATE_BASENAMES.find((t) => t.file === base);
  if (hit !== undefined) {
    overrides.set(hit.dim, p);
  } else {
    log(`WARN: reviewers 条目 ${p} 的 basename（${base}）不匹配任何默认维度模板（${TEMPLATE_BASENAMES.map((t) => t.file).join("/")}），已忽略`);
  }
}
const templates = new Map<string, string>();
for (const t of TEMPLATE_BASENAMES) {
  templates.set(t.dim, overrides.get(t.dim) ?? expandTilde(`${TILDE_ROOT}/${t.file}`));
}
const rubricPath = expandTilde(RUBRIC_TILDE);
const principlesPath = expandTilde(PRINCIPLES_TILDE);
const schemaPath = expandTilde(SCHEMA_TILDE);
const checkDesignCliAbs = expandTilde(CHECK_DESIGN_TILDE);
const renderCliAbs = expandTilde(RENDER_TILDE);
const checkCliAbs = expandTilde(CHECK_CLI_TILDE);
// 渲染视图路径（方向审 / 三审的审查对象；渲染脚本按目录 basename + .rendered.md 命名）
const renderedMd = `${designDoc}/${docBase}.rendered.md`;

// 审查维度（固定四席并行 = 方向审席 + 三审；报告名确定性，落当轮轮次目录）
const TRIALS: { dim: "direction" | "main" | "impact" | "simplicity"; label: string; reportName: string }[] = [
  { dim: "direction", label: "方向审", reportName: "review-direction.md" },
  { dim: "main", label: "主审", reportName: "review-main.md" },
  { dim: "impact", label: "影响面审", reportName: "review-impact.md" },
  { dim: "simplicity", label: "简洁审", reportName: "review-simplicity.md" },
];

// 必读文件存在性探针：设计目录 + 四模板 + 校验/渲染 CLI（rubric 与 schema 是提示性路径，不挡启动）
const requiredPaths = [designDoc, checkCliAbs, checkDesignCliAbs, renderCliAbs, ...TEMPLATE_BASENAMES.map((t) => templates.get(t.dim) ?? "")].filter((p) => p !== "");
const probe = await world.run("node", ["-e", NODE_CHECK_EXISTS, ...requiredPaths]);
if (probe.exitCode !== 0) {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `必读文件缺失：${probe.stdout.trim()}。恢复动作：确认 tech-design-wf skill 已安装（四模板位于 ~/.agents/skills/tech-design-wf/agents/，校验与渲染脚本位于 ~/.agents/skills/tech-design-wf/scripts/）或经 args.reviewers 传入自定义模板绝对路径覆盖同名维度；designDoc 应为设计目录（内含六个章节 JSON），路径笔误则修正后重新发起`,
  };
}

// ── T2 进场门槛 + 渲染视图刷新（与 flow/review.md 手工路径同一实现） ──
// check：对设计目录跑七条规则校验，exit 0 = 机器项全绿才派审；非 0 时 stdout 是逐项失败
// 原因（md 输入则是迁移指引原文）——原样透传进 message，恢复动作可循
const designChk = await world.run("node", [checkDesignCliAbs, designDoc]);
if (designChk.exitCode !== 0) {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `设计文档机器项未全绿（check-design-doc.mjs exit ${designChk.exitCode}）：${designChk.stdout.trim() || designChk.stderr.trim()}。恢复动作：回 T1 按上述校验报告修复对应章节 JSON 后重跑脚本至 exit 0 再发起；输入为 md 文件时按校验输出中的指引处理`,
  };
}
// render：幂等刷新阅读视图——check 对渲染过期只告警不阻塞，这里主动重渲染消除告警，
// 保证方向审 / 三审读到的 rendered.md 与章节 JSON 一致（缺失则生成）
const designRender = await world.run("node", [renderCliAbs, designDoc]);
if (designRender.exitCode !== 0) {
  await obsCloseExecution("setup-failure");
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    directionOneliner: "",
    mustFixTrajectory: [],
    remaining: [],
    blocked: null,
    message: `渲染产物刷新失败（render-design-doc.mjs exit ${designRender.exitCode}）：${designRender.stderr.trim() || designRender.stdout.trim()}。恢复动作：确认 ${RENDER_TILDE} 存在且设计目录内六个章节 JSON 完整可解析后重新发起（审查者读渲染视图，视图缺失即无法审查）`,
  };
}
if (designRender.stdout.trim() !== "") log(designRender.stdout.trim());

// ── 终态收尾（写 final.json + 发布终态 markdown；run 级状态在闭包中） ──
const trajectory: number[] = [];
const ledger: LedgerEntry[] = [];
let directionOneliner = "";
let directionReportFile = "";

async function finish(
  terminated: LoopResult["terminated"],
  rounds: number,
  message: string,
  blocked: { items: string[]; reason: string } | null = null,
): Promise<LoopResult> {
  const remaining = ledger
    .filter((e) => e.status === "open" || e.status === "pending")
    .map((e) => ({ id: e.id, title: e.title, status: e.status, attackHints: e.attackHints }));
  const result: LoopResult = {
    terminated,
    rounds,
    runDir,
    designDoc,
    directionOneliner,
    mustFixTrajectory: [...trajectory],
    remaining,
    blocked,
    message,
  };
  // final.json（对外字段名 = oneliner，skill 文本契约同此——设计 §5.2 双形态契约权威表）
  const finalDoc = {
    terminated: result.terminated,
    rounds: result.rounds,
    // 产物溯源字段：SKILL_VERSION = 构建注入常量（tech-design-wf frontmatter version，
    // 注入点见 build-workflows.mjs）——只读溯源，不参与执行裁决
    skillVersion: SKILL_VERSION,
    runDir,
    designDoc,
    oneliner: result.directionOneliner,
    reportFile: directionReportFile,
    mustFixTrajectory: result.mustFixTrajectory,
    remaining: result.remaining,
    blocked: result.blocked,
    message: result.message,
  };
  const w = await world.run("node", ["-e", NODE_WRITE_FILE, finalJsonPath, JSON.stringify(finalDoc, null, 2)]);
  if (w.exitCode !== 0) {
    log(`WARN: final.json 落盘失败（exit ${w.exitCode}：${w.stderr.trim() || w.stdout.trim()}）——终态数据以本次返回值为准`);
    result.message += `；（注：final.json 落盘失败 exit ${w.exitCode}）`;
  }
  // run.json（分析契约，skill-data-redesign §5.1）与 final.json 同批终态写出；固定名
  // final.json 是 dev-flow-wf 入口门契约保持不动，run.json 承载跨 run 分析字段
  if (runStartedAt !== null) {
    const endRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
    const gitRev = await gitRevProbe();
    await writeRunManifest({
      workflow: "tech-review-loop",
      segment: "tech-design",
      skillVersion: SKILL_VERSION,
      host: HOST_PLATFORM,
      projectRoot,
      worktreePath: projectRoot,
      branch: gitRev.branch,
      // 审查对象是设计文档，无 git 基线分界——baseCommit 恒 null
      baseCommit: null,
      headCommit: gitRev.head,
      attempt,
      model: null,
      startedAt: runStartedAt,
      endedAt: endRes.exitCode === 0 && endRes.stdout.trim() !== "" ? endRes.stdout.trim() : null,
      terminated: result.terminated,
      rounds: result.rounds,
      mustFixTrajectory: result.mustFixTrajectory,
    });
  } else {
    log("WARN: run.json 未落盘（startedAt 探针失败，防覆盖判据不可用）——终态数据以 final.json 与返回值为准");
  }
  try {
    await artifact.markdown("final-report", renderFinalMd(result), {
      title: "设计审查终态报告",
      description: `终态 ${terminated}，共 ${rounds} 轮审查`,
      primary: true,
    });
  } catch {
    log("WARN: 终态 markdown 发布失败（内容超限或发布通道异常）——终态详情见 final.json 与返回值");
  }
  // 观测终态统一补记（O 区）：给打开中的 step 补记 end + execution end（outcome=本次终态词）
  await obsCloseExecution(terminated);
  return result;
}

// 每轮 must-fix 轨迹看板（多轮循环值得中途观看；report 双投 Results）
artifact.chart("trajectory", {
  title: "每轮 must-fix 总和轨迹",
  x: { field: "round", label: "轮次" },
  y: { field: "mustFix", label: "must-fix 总和" },
});

// ── 方向审席（四席之一） ──
// 方向审与三审同轮并行、同一对账契约：patch 档发现（前提层/产物表/措辞级——问题定义
// 与方案主干不动）进当轮问题清单，由文档修复者随全部发现一并处置；rewrite 档（问题
// 定义/方案主干/分型被击穿）整循环立即终止回 T1（gate 语义保留在真正需要外溢的形态）
// attempt 自动递增 = 轮次目录全部改名 → AmendWorkflow 按 agent 名 + 节点输入匹配的
// 缓存零命中、从头重跑（2026-11-04 实例：amend 续跑未固化 attempt，白烧 43M token）——
// 递增发生时当场提示应固化原值，防操作方不知情
const attemptAutoBumped = inputs.attempt === null && prevAttemptMax > 0;
log(
  `审查环境就绪：产物目录 ${runDir}（attempt=${attempt}${prevAttemptMax > 0 ? `（检测到历史 attempt 后缀至 ${prevAttemptMax}，历史产物不覆盖）` : ""}${attemptAutoBumped ? `；注意：自动递增使轮次目录改名、AmendWorkflow 缓存会零命中从头重跑——修订续跑应在脚本内固化 attempt=${prevAttemptMax}` : ""}）；四席并行（方向审 + 三审）`,
);

// ── 审查-修复主循环 ──
// T9（用户裁决 2026-09-26）：workflow 内无用户交互位，任何 agent 不得提问——随 persona 固化
//（NO_ASK_RULE 定义在文件顶部常量区）
if (obsCtx !== null) await obsEnd("setup", null);
const AGGREGATOR_PERSONA =
  "你是审查聚合裁决员：把四席评审报告的发现合并为去重后的权威问题清单——同根因跨席位的发现合为一条（保留全部原始 ref，禁止静默丢弃任何一条），不同根因绝不合并；只读裁决，绝不修改任何文件；同根因判定依据是报告原文与设计文档原文，不是表面措辞相似；指令无法执行或有矛盾时如实说明，不伪造结论。" +
  NO_ASK_RULE;
const DIRECTION_PERSONA =
  "你是方向审评审员：攻击设计的前提层与终态层——分型是否正确、前提清单能否被写者侧反例击穿、公理是真不变量还是实现细节、产物表是否完整且真实、问题定义是否忠于真问题；只读评审，绝不修改任何文件；每个判定都要有你亲自读到的文档原文或源码依据；指令无法执行或有矛盾时如实说明，不伪造结论。" +
  NO_ASK_RULE;
const REVIEWER_PERSONA =
  "你是资深设计文档评审员：只读评审，绝不修改任何文件；每个发现都要有你亲自读到的文档原文依据；报告与返回计数一致；指令无法执行或有矛盾时如实说明，不伪造结论。" +
  NO_ASK_RULE;
const FIXER_PERSONA =
  "你是设计文档修复者：直接编辑设计目录内的章节 JSON（六个 json 是权威源，渲染视图由脚本生成、不手改）；先核实再修改、反例重演验证修复、联动同步关联章节与跨章节引用字段、修改后重跑渲染脚本；写入文档的每个断言必须标核实状态——能静态核实的（读源码/API 查询/文档核对）本会话核实后才写 ✅，不能核实的写 ⏳ 前提并指向实施期探针，禁止把推断、未尝试的查询、平台通用知识写成事实或 ✅；方案性意见修不动时如实置 status=\"blocked\" 并申报卡点，不硬改、不静默跳过。" +
  NO_ASK_RULE;

let prevDispositions: Disposition[] = [];
let prevRevisionSummary = "";
let prevRoundMustFix = 0;
let streak = 0;

for (let round = 1; round <= maxRounds; round++) {
  phase("四席并行聚焦复审");
  const roundAbs = `${runDir}/${roundDirName(round)}`;
  await obsBegin("review", round);

  // 必对账集 = 上轮处置表全部条目（fixed 的核修复成立性；deferred/archived 的核登记
  // 是否仍成立）；登记监视集 = action≠fixed（escalate 唯一复活通道的申报对象面，
  // 漏报即维持，不算未确认）。
  const mustReconcile = prevDispositions;
  const parkedWatch = prevDispositions.filter((d) => d.action !== "fixed");
  const dispProjection = (d: Disposition) => ({
    id: d.id,
    action: d.action,
    title: d.title,
    location: d.location,
    attackHints: d.attackHints,
  });

  const focusBlock =
    round === 1
      ? ""
      : [
          "",
          "本轮为聚焦复审，不做全面重扫。审查范围：",
          "(a) 上轮处置表必对账集——全部条目（reconciliation 每条必填，prevId 用下表 id；action=fixed 的核修复是否成立，action=deferred/archived 的核登记/归档是否仍成立）：",
          mustReconcile.length > 0 ? wrapUntrusted(JSON.stringify(mustReconcile.map(dispProjection))) : "- (空)",
          "(b) 登记/归档监视清单（action≠fixed；仅当本轮修复改变了其相关上下文才申报 escalate——结构化申报，唯一复活通道；无变化不重报、不升级）：",
          parkedWatch.length > 0 ? wrapUntrusted(JSON.stringify(parkedWatch.map(dispProjection))) : "- (空)",
          `(c) 上轮修订摘要（修复者声称，不算证据，必须亲自读文档核实）：${wrapUntrusted(prevRevisionSummary !== "" ? prevRevisionSummary : "(无)")}`,
          "对账规则：亲自读设计文档核实——确认已修复/登记仍成立（evidence 写你读到的原文事实）→ fixed；仍存在或登记不再成立 → not-fixed 并计入 mustFix；修复复发或引入新问题 → regressed 并计入 mustFix（只扫修复触及的章节）；监视清单条目上下文已变 → escalate。",
          "(d) 除对账外：只审上轮修复触及章节是否引入新问题；处置条目的攻击点建议（attackHints）是优先检查方向。",
        ].join("\n");

  log(`第 ${round} 轮审查：四席并行（${TRIALS.map((t) => t.label).join("、")}），产物目录 ${roundAbs}`);

  // 三审拆显式调用点：agent 名字须以静态字面前缀开头（zcode GUI 泳道按编译期静态分析
  // 预建，`${t.label}-r${round}` 这类变量开头的名字整条泳道显示「未命名子代理」）；
  // prompt 构造共享本函数保持单一来源，TRIALS[i] ↔ raw[i] 顺序对应由调用点顺序保证
  const reviewerPrompt = (t: (typeof TRIALS)[number]): string =>
    [
      `第 ${round} 轮评审（维度：${t.label}；产物目录 ${roundAbs}）。`,
      "",
      `第一步：Read 评审模板 ${templates.get(t.dim) ?? ""}——其中是你的完整审查 checklist，按它执行评审。`,
      `评审 rubric（分级依据，先读）：${rubricPath}`,
      "意见形态约束（防止审查-修复螺旋）：发现的问题按其事实性质分两类处置——①断言失实：文档把推断/未核实/未尝试的查询写成了事实或 ✅（核实状态标注错误）——正常打 must-fix；②前提登记缺口：影响决策的信息缺失——正常打 must-fix。但「文档没有给出设计期无法知道的运行时结论」本身不是问题：对 CI 运行行为、构建产物、真机表现这类实施期才能核实的事实，唯一合格的登记形态就是 ⏳ 前提 + 实施期探针；文档已按此形态登记完备时，不得因「还能挖更深」或「该结论实施期才见分晓」继续打 must-fix——前提登记完备即该域已修复。你的修复方向同样受此约束：对实施期事实，方向只能是「登记/修正为 ⏳ 前提 + 探针」，不得要求修复者给出设计期无法知道的运行时结论。",
      `审查对象（渲染视图——读它）：${renderedMd}`,
      `章节 JSON（需核对断言-红灯表等结构化字段原文时读，如 s4-accept.json 的 assertionRedlights）：设计目录 ${designDoc}（字段规格见 ${schemaPath}）。`,
      `项目上下文（存在则读，作产品与规范基准）：${projectRoot}/AGENTS.md、${projectRoot}/docs/PRODUCT.md。`,
      "只读评审：禁止修改设计文档与项目内任何文件。",
      round === 1 ? "本轮为首轮全面审：按模板 checklist 全项覆盖。" : "",
      focusBlock,
      t.dim === "direction"
        ? [
            "你是方向审席（四席之一，与三审同轮并行）：判据 D1-D5（攻击方法与完整评审基准见模板）。R1 = 全面攻击（分型 / 前提可击穿 / 终态有效 / 产物表完整且真实 / 问题定义忠于真问题，含穷举断言检索命令对账）；R2+ 按上方聚焦范围复审——上轮处置表逐条对账 + 重跑穷举断言已登记的检索命令对账（清单外写者即反例）+ 只审修复触及章节是否引入前提层 / 终态层新问题。",
            "返回 JSON 在三审字段（mustFix / problems / reconciliation）之外增加 fixScope（patch = 全部发现属前提层/产物表/措辞级、问题定义与方案主干不动；rewrite = 问题定义/方案主干/分型被击穿——任一 finding 击穿这三者即整份判 rewrite；mustFix=0 时填 patch）与 oneliner（一句话方向判定）。",
          ].join("\n")
        : "",
      t.dim === "simplicity"
        ? "（简洁审一律执行——设计 B8 裁决无跳过通道）若本设计属纯文案/参数调整类记录（无结构、方案主干、验收形态变化），照常逐项过 checklist，在报告开头说明该分类并给出简洁面结论（零发现就写「简洁面零发现」）。"
        : "",
      "",
      `报告落盘：${roundAbs}/${t.reportName}（绝对路径；需要时先创建目录）。每条问题一节：锚点编号（${t.reportName.replace(".md", "")}#<序>，如 ${t.reportName.replace(".md", "")}#2，报告小节标题必须带此锚点）+ 所在章节 + 描述 + 原文依据（你读到的原句）+ 修复方向（可执行——指明改哪个章节 JSON 的哪个条目、补什么内容；它是修复者的操作清单）。唯一报告级别是 must-fix（无 suggestion 级——不影响决策的表述偏好不报）。报告是修复者的唯一输入。`,
      `完成后返回 JSON：mustFix（must-fix 条数，与报告一致）、problems（逐条问题清单，每条 {ref, title}——ref 即报告小节锚点（${t.reportName.replace(".md", "")}#<序>）、title 一句话；条目无 level 字段；条数合计须等于 mustFix）、reconciliation（${round === 1 ? "本轮返回空数组 []" : "对上方必对账集逐条申报"}）。`,
    ]
      .filter(Boolean)
      .join("\n");

  let verdicts: (ReviewerVerdict & { dim: string })[];
  // 注：经 map 闭包赋值，显式 string 宽型防 TS 控制流窄化误判比较无交集
  let dirFixScope: string = "patch";
  let dirOneliner = "";
  // agent(名字) 全 run 只允许注册一次（引擎约束：具名 subagent 名字 run 内唯一）——
  // 先取引用，回喂重试经同一引用续聊（与下方修复者同款模式；闭包内重复 agent(同名)
  // 在重试时二次注册同名被引擎拒绝，实测崩于 r2 聚合回喂）
  const directionAgent = agent(`方向审-r${round}`, DIRECTION_PERSONA);
  const mainAgent = agent(`主审-r${round}`, REVIEWER_PERSONA);
  const impactAgent = agent(`影响面审-r${round}`, REVIEWER_PERSONA);
  const simplicityAgent = agent(`简洁审-r${round}`, REVIEWER_PERSONA);
  try {
    const raw = await Promise.all([
      askValidated(
        validateDirectionVerdict,
        (p) => directionAgent.ask<DirectionVerdict>(p),
        reviewerPrompt(TRIALS[0]),
      ),
      askValidated(
        validateReviewerVerdict,
        (p) => mainAgent.ask<ReviewerVerdict>(p),
        reviewerPrompt(TRIALS[1]),
      ),
      askValidated(
        validateReviewerVerdict,
        (p) => impactAgent.ask<ReviewerVerdict>(p),
        reviewerPrompt(TRIALS[2]),
      ),
      askValidated(
        validateReviewerVerdict,
        (p) => simplicityAgent.ask<ReviewerVerdict>(p),
        reviewerPrompt(TRIALS[3]),
      ),
    ]);
    const badNull = raw.findIndex((v) => v === null);
    if (badNull >= 0) {
      return await finish(
        "review-failure",
        round,
        `维度 ${TRIALS[badNull].label} 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规。恢复动作：报告已落盘可读 ${roundAbs} 人工核对；${HINT_REVIEW_BAD_COUNT}`,
      );
    }
    verdicts = (raw as ReviewerVerdict[]).map((v, i) => {
      const problems = sanitizeProblems(v.problems);
      const selfMf = sanitizeCount(v.mustFix) ?? 0;
      // 防线：自报计数非零但清单缺失/全畸形 → 派生计数归零会假 converged，fail-fast
      if (selfMf > 0 && problems.length === 0) {
        throw new Error(
          `维度 ${TRIALS[i].label} 自报计数（must-fix ${selfMf}）非零但 problems 清单缺失或全畸形——覆盖校验无对账锚点，报告可读 ${roundAbs}/${TRIALS[i].reportName} 人工核对`,
        );
      }
      if (problems.length !== selfMf) {
        log(`WARN: ${TRIALS[i].label} 自报计数（${selfMf}）与 problems 清单派生（${problems.length}）不一致，以清单为准`);
      }
      if (i === 0) {
        const dv = v as DirectionVerdict;
        dirFixScope = dv.fixScope === "rewrite" ? "rewrite" : "patch";
        dirOneliner = typeof dv.oneliner === "string" ? dv.oneliner : "";
      }
      return { mustFix: problems.length, problems, reconciliation: sanitizeReconciliation(v.reconciliation), dim: TRIALS[i].dim };
    });
  } catch (e) {
    return await finish("review-failure", round, `四席调用或归并失败：${String(e)}。恢复动作：引擎层已含瞬态重试（走到这里多为逻辑失败——上下文超限则拆分投喂 / 结构化校验不过见当轮报告）；args.attempt 递增重新发起`);
  }

  // rewrite 档 gate：方向审席判问题定义/方案主干/分型被击穿 → 整循环立即终止回 T1
  //（patch 档发现不触发——进当轮问题清单由文档修复者处置，循环继续）
  if (dirFixScope === "rewrite" && verdicts[0].problems.length > 0) {
    return await finish(
      "direction-rejected",
      round,
      `方向审席打回（rewrite 档，must-fix ${verdicts[0].problems.length} 条——问题定义/方案主干/分型被击穿）：${dirOneliner}。停回通道：回 T1 对话重写（含 Step D 诊断期重做），修完 attempt+1 重新发起（重过四席）；报告见 ${roundAbs}/review-direction.md`,
    );
  }
  directionOneliner = dirOneliner;
  directionReportFile = `${roundAbs}/review-direction.md`;

  const rChk = await world.run("node", ["-e", NODE_CHECK_EXISTS, ...TRIALS.map((t) => `${roundAbs}/${t.reportName}`)]);
  if (rChk.exitCode !== 0) {
    return await finish("review-failure", round, `评审报告未落盘：${rChk.stdout.trim()}——报告是修复者的唯一输入，缺失即失败。恢复动作：args.attempt 递增重新发起`);
  }

  // 问题清单落盘（覆盖校验的输入 + 修复者 source 引用锚点 + 断点恢复人读）
  const roundProblems = verdicts.flatMap((v) => v.problems);
  const probWrite = await world.run("node", ["-e", NODE_WRITE_FILE, `${roundAbs}/problems.json`, JSON.stringify({ round, problems: roundProblems }, null, 2)]);
  if (probWrite.exitCode !== 0) {
    return await finish("review-failure", round, `问题清单落盘失败（${roundAbs}/problems.json，exit ${probWrite.exitCode}）：${probWrite.stderr.trim() || probWrite.stdout.trim()}。恢复动作：args.attempt 递增重新发起`);
  }
  await obsEnd("review", round);

  // ── phase 2：聚合裁决（独立 phase——四席发现合并为去重权威清单；修复者据聚合清单处置） ──
  let aggregatedItems: AggregatedItem[] | null = null;
  if (roundProblems.length > 0) {
    phase("聚合裁决");
    await obsBegin("aggregate", round);
    const rawRefs = roundProblems.map((pp) => pp.ref);
    let aggregation: AggregationOutcome | null;
    // 同四席：agent(名字) 先注册一次，回喂重试经同一引用续聊（闭包内重复 agent(同名) 会被引擎拒绝）
    const aggregator = agent(`聚合裁决-r${round}`, AGGREGATOR_PERSONA);
    try {
      aggregation = await askValidated(
        makeAggregationValidator(rawRefs),
        (p2) => aggregator.ask<AggregationOutcome>(p2),
        [
          `聚合裁决（第 ${round} 轮，产物目录 ${roundAbs}）——四席评审已并行完成，把它们的发现合并为一份去重权威清单。`,
          "",
          "第一步：Read 四份评审报告（证据与完整上下文）：",
          ...TRIALS.map((tt) => `- ${roundAbs}/${tt.reportName}`),
          `设计文档（判断同根因时的对照，渲染视图）：${renderedMd}`,
          "",
          "本轮原始问题清单（合并对象——聚合结果的 refs 全体必须与之精确划分相等）：",
          wrapUntrusted(JSON.stringify(roundProblems)),
          "",
          "合并规则：",
          "- 同根因 = 两条发现指向设计文档同一处失实 / 同一缺失 / 同一矛盾（不同席位对同一问题的不同视角表述）→ 合并为一条：refs 取并集，title 一句话根因，guidance 合并为一份可执行操作清单（保留各自的可执行细节——改哪个章节 JSON 哪个条目、补什么内容、跑什么检索）。",
          "- 不同根因绝不合并；拿不准是否同根因 → 不合并（宁多勿并——错误合并会让修复漏掉一半）。",
          "",
          "完成后返回 JSON：items（聚合项数组，每条 { refs: string[]（该条覆盖的原始 ref，至少一个）, title, guidance }）。refs 全体构成原始清单的精确划分——每条原始 ref 恰好出现在一条聚合项里，不丢、不重、不造。",
        ].join("\n"),
      );
    } catch (e) {
      return await finish("aggregator-failure", round, `聚合裁决调用失败：${String(e)}。恢复动作：引擎层已含瞬态重试（走到这里多为逻辑失败——上下文超限则拆分投喂）；args.attempt 递增重新发起`);
    }
    if (aggregation === null) {
      return await finish(
        "aggregator-failure",
        round,
        `聚合裁决结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规（refs 须构成原始清单的精确划分）。恢复动作：四份报告可读 ${roundAbs}，人工合并后把聚合清单落 ${roundAbs}/aggregated.md 再续；或 args.attempt 递增重新发起`,
      );
    }
    aggregatedItems = aggregation.items;
    const aggWrite = await world.run("node", ["-e", NODE_WRITE_FILE, `${roundAbs}/aggregated.md`, renderAggregatedMd(round, aggregatedItems)]);
    if (aggWrite.exitCode !== 0) {
      return await finish("aggregator-failure", round, `聚合清单落盘失败（${roundAbs}/aggregated.md，exit ${aggWrite.exitCode}）：${aggWrite.stderr.trim() || aggWrite.stdout.trim()}。恢复动作：args.attempt 递增重新发起`);
    }
    log(`第 ${round} 轮聚合完成：${rawRefs.length} 条原始发现 → ${aggregatedItems.length} 条聚合项（${roundAbs}/aggregated.md）`);
    await obsEnd("aggregate", round);
  }

  // 轨迹与对账以聚合后计数为准（去重后的真实工作负载；原始计数仅校验用）
  const roundMustFix = aggregatedItems !== null ? aggregatedItems.length : 0;
  trajectory.push(roundMustFix);
  report({ round, mustFix: roundMustFix }, "trajectory");

  // 对账套用（verify-first：fixed 必须带非空 evidence 才采信）
  const confirmedIds = new Set<string>();
  const escalateIds = new Set<string>();
  for (const v of verdicts) {
    for (const r of v.reconciliation) {
      const entry = ledger.find((e) => e.id === r.prevId);
      if (entry === undefined) continue; // 幻觉 prevId / 台账外条目：忽略
      if (r.status === "fixed" && r.evidence.trim() !== "") {
        entry.status = "confirmed";
        confirmedIds.add(entry.id);
      } else if (r.status === "not-fixed" || r.status === "regressed") {
        entry.status = "open";
      } else if (r.status === "escalate") {
        if (entry.status === "parked") {
          entry.status = "open";
          escalateIds.add(entry.id);
          log(`escalate 复活：${entry.id}（${entry.title}）——reviewer 申报上下文已变，重回修复队列`);
        }
      }
    }
  }
  // 未确认条目（回流本轮修复者）= 必对账集中未被实证确认的（含 not-fixed/regressed
  // 申报与完全漏报，fail-closed：漏报不视为已确认）+ escalate 复活的登记/归档条目；
  // 同一条目可能两源都命中（must-fix 级 deferred/archived 被 escalate 复活）——按 id 去重，
  // 否则注入修复者的 outstanding 同 id 两遍
  const outstandingCore = mustReconcile.filter((d) => !confirmedIds.has(d.id));
  const coreIds = new Set(outstandingCore.map((d) => d.id));
  const outstanding = [...outstandingCore, ...parkedWatch.filter((d) => escalateIds.has(d.id) && !coreIds.has(d.id))];

  // converged 判定（设计 §5.2 唯一权威公式）：must-fix==0 且上轮处置表全处置即终止。
  // R1 全 0 → 直接 converged（不派修复者）。
  if (roundMustFix === 0 && outstanding.length === 0) {
    return await finish(
      "converged",
      round,
      `第 ${round} 轮收敛：四报告 must-fix 均 0${round > 1 ? "，上轮处置条目全部经实证复核确认" : "（首轮即净，未派修复者）"}。下游：T2 确认点`,
    );
  }

  // stuck 熔断（连续多轮 must-fix 总和不降；计数判定归脚本）
  if (roundMustFix > 0 && roundMustFix >= prevRoundMustFix) streak += 1;
  else streak = 0;
  prevRoundMustFix = roundMustFix;
  if (streak >= STUCK_THRESHOLD) {
    return await finish(
      "stuck",
      round,
      `must-fix 总和连续 ${STUCK_THRESHOLD} 轮未下降（当前 ${roundMustFix}，轨迹 ${trajectory.join(" → ")}）。停回通道：呈报残余风险矩阵（见 remaining），由用户裁决——修复已不再收敛，续跑只烧轮次`,
    );
  }

  // ── phase 3：文档修复者（据聚合清单修复 + 处置表——语义去重已在聚合裁决 phase 完成） ──
  phase("修复设计文档并产出处置表");
  await obsBegin("fix", round);
  const outstandingBlock =
    outstanding.length > 0
      ? [
          "",
          "上轮处置表中未被复核确认的条目（含申报 not-fixed/regressed 的、escalate 复活的、漏报的）——本轮必须全部重新处置（延续条目复用原 id）：",
          wrapUntrusted(JSON.stringify(outstanding)),
        ].join("\n")
      : "";

  // 本轮问题清单内联：处置表 source 引用的唯一合法锚点集（覆盖校验按此集合判定）
  const problemsBlock =
    roundProblems.length > 0
      ? [
          "",
          "本轮问题清单（四份报告的逐条问题锚点，ref 形如 review-main#2 / 方向审 review-direction#2）：",
          wrapUntrusted(JSON.stringify(roundProblems)),
        ].join("\n")
      : "";

  const fixer = agent(`文档修复者-r${round}`, FIXER_PERSONA);
  const baseFixInstructions = [
    `第 ${round} 轮设计文档修复（产物目录 ${roundAbs}）。`,
    "",
    `第一步：Read 聚合清单 ${roundAbs}/aggregated.md（聚合裁决产物——四席发现按同根因合并的权威清单，每条 AG 项含全部原始 ref 与合并修复指导，是你的操作清单）；需要完整证据时按 ref 回读对应席位的报告：`,
    ...TRIALS.map((t) => `- ${roundAbs}/${t.reportName}`),
    `审查对象：设计目录 ${designDoc}——权威源是目录内六个章节 JSON（meta / s1-context / s2-status / s3-solution / s4-accept / s5-breakdown），${renderedMd} 是渲染出的阅读视图（非权威，禁止手改）。直接编辑章节 JSON 文件完成修复（你有文件工具，逐文件小步修改）；字段规格见 ${schemaPath}。`,
    "",
    "任务：",
    "1. 按聚合清单逐条处置：每条 AG 项至少对应一条处置，source 填该 AG 项覆盖的全部原始 ref（聚合裁决已去重——跨 AG 项不再二次合并；发现两条 AG 项实为同根因时在 revisionSummary 登记提示，不自行吞并）。",
    "2. 逐条三选一处置全部问题：fixed（修复——默认处置，直接编辑章节 JSON 落实）/ deferred（登记不修，理由必须具体：涉及章节/机制/代价）/ archived（归档——已过时或不适用，理由必须具体）。判定存疑按 fixed 处理（滑坡防护）。",
    "3. 方案性意见（需要用户裁决的方向变化，如推翻问题定义、方案主干、最小形态）修不动 → 不要硬改：status 取 \"blocked\"，并在 blocked 里申报（items=卡住的问题清单，reason=为什么需要用户裁决）；其余可修的照常完成并产出处置表。无方案性卡点时 status 取 \"done\"，返回体不得含 blocked 字段——不要在 blocked 里填「无卡点」之类的说明（引擎只认 status，blocked 不是表态字段）。",
    outstandingBlock,
    problemsBlock,
    "",
    "修复纪律：",
    "- 反例重演：每条处置的 reenactment 写清该问题如何被发现，且修复后在修订稿上重演验证问题已消除。",
    "- 事实标注：你写入或触及的运行时、环境、宿主行为断言必须带核实状态——✅ 仅用于本会话亲自核实（读码/实测/静态查询）过的陈述，能静态核实的不许标 ⏳（先核实再写），设计期无法核实的写 ⏳ 前提并指向实施期探针。把推断或未尝试的查询写成事实/✅ 是下轮 must-fix 的头号来源（历次实测：连续 6 轮 must-fix 不降全部由此而来）。联动修改触及的每处既有断言同步重核实，防止标注在多次联动中丢失或失实。",
    "- 否决记录：方案对比中被否决的候选，修复时把否决理由写进「不采用」栏（decisions 的 rejected 字段），不删除候选项。",
    "- 联动同步：修复触及的陈述须同步设计文档内关联章节 JSON（问题定义、方案对比、验收标准、风险登记、实施计划五处及其他关联处），不留前后矛盾；跨章节引用字段（decisions 的 gapRefs / unitRefs / axiomRefs、scenarios 的 goalRefs、meta.json reviewNav 的 decisionId）与被引用数组的 id 同步更新——改 id 必须同步全部引用处。",
    `- 渲染刷新：章节 JSON 每次修改后运行 node ${renderCliAbs} ${designDoc} 刷新渲染视图（rendered.md 由脚本生成、禁止手改；全部处置完成后确保已重渲染——下轮审查读渲染视图，视图过期会误判为未修复）。`,
    "- 方向审席的穷举断言类问题（「唯一 / 限于 / 全集」措辞）：修复 = 亲自跑检索（grep / ripgrep，含路径范围），把命令与命中清单登记进对应行的 evidence / exclusionEvidence / exclusionNote——登记后断言可复算，下轮对账重跑同一命令；需要动问题定义 / 方案主干 / 分型才能修的 → status 置 \"blocked\" 申报，不硬改。",
    "- 语言回归：修订语言与原稿一致（中文），术语沿用文档既有词表，不引入未解释的新术语。",
    "",
    "返回 JSON：status / dispositions / revisionSummary，仅当 status=\"blocked\" 时再加第四个字段 blocked。",
    "status（必填，二选一）：\"done\" = 修复与处置完成、无方案性卡点（返回体不得含 blocked 字段）；\"blocked\" = 存在修不动、需用户裁决的方案性分歧（必须携带 blocked 字段）。",
    `dispositions 每条字段：id（新条目格式 D-${round}-<序>；延续上轮的条目复用原 id）、title（一句话标题）、source（数组：该条覆盖的问题 ref 清单——每条必须取自上方「本轮问题清单」，合并处置时把覆盖的 ref 全部列入同一条；上轮延续条目的历史 ref 保留并列）、action（fixed|deferred|archived）、location（修订位置）、reenactment（反例重演）、attackHints（给下轮聚焦复审的攻击点建议）、affectsDecision（影响决策，必填，无影响也显式写「无」）、affectsDelivery（影响交付，必填，同前）。`,
    "硬约束：清单中每条问题都必须被至少一条处置的 source 覆盖——登记不修/归档也算处置；脚本按 source 引用集合机器校验，漏引用会整轮打回。",
  ]
    .filter(Boolean)
    .join("\n");

  // 修复者结构化返回的业务校验与回喂重试：覆盖完整性/条目一致性经 check-dispositions
  // CLI 判定（与 flow/review.md 手工路径同一实现——双轨语义等价由同一校验器保证）；
  // 失败不直接终态，先带校验报告回喂重试（夜间托管场景 fix-failure = 停机等人，
  // 而结构化缺失多数可由修复者自查补正）；outstanding（上轮遗留）按 id 校验——漏处置
  // 的遗留条目不进任何对账集，会以 open 状态滞留台账直到假 converged
  let fix: FixOutcome | null = null;
  let dispositions: Disposition[] = [];
  let revisionSummary = "";
  let lastCheckReport = "";
  let checkPassed = false;
  // 机器预检失败布尔态：与最后一次 lastCheckReport 赋值同步更新（blocked 残缺路径重置），
  // 终态分支用它判定，不回查自产文本里的 "[precheck]" 字面量
  let isPrecheckFailure = false;
  for (let fixAttempt = 1; fixAttempt <= FIX_RETRY_MAX && !checkPassed; fixAttempt++) {
    const instructions: string =
      fixAttempt === 1
        ? baseFixInstructions
        : [
            withRetryContext(baseFixInstructions, fix, lastCheckReport),
            "你此前对设计文档的修订都保留在磁盘上，本轮按校验报告分类处理，不重复未指出的修改：",
            "- [precheck] 类（渲染/机器校验红）：修复报告指出的章节 JSON 问题，修完重跑 node " + renderCliAbs + " " + designDoc + " 刷新渲染视图；",
            "- 其余类：处置表结构化返回问题——补齐缺失的 source 引用、修正字段形态，不动文档。",
            "重新返回完整 JSON（status / dispositions / revisionSummary，仅卡点时加 blocked——全量重新给出，不是增量补丁）。",
            `校验报告（每条 error 都必须在本轮修正）：\n${lastCheckReport}`,
          ].join("\n\n");
    try {
      fix = await fixer.ask<FixOutcome>(instructions);
    } catch (e) {
      return await finish("fix-failure", round, `修复者调用失败：${String(e)}。恢复动作：引擎层已含瞬态重试（走到这里多为逻辑失败——上下文超限则拆分投喂）；args.attempt 递增重新发起（在途编辑已留磁盘，接管前先盘点 ${designDoc}）`);
    }
    dispositions = sanitizeDispositions(fix.dispositions);
    revisionSummary = typeof fix.revisionSummary === "string" ? fix.revisionSummary : "";

    // 结论判别唯一键 = status 枚举；blocked 对象不是停回开关——done 形态附带的 blocked
    // 杂物一律忽略（防「无卡点声明」误触发 escalated）。status="blocked" 但 blocked 对象
    // 残缺 = 结构化返回残缺，走回喂重试（与处置表校验失败同通道），不停回、不吞卡点
    const fixStatus: "done" | "blocked" = fix.status === "blocked" ? "blocked" : "done";
    const blocked = fixStatus === "blocked" ? sanitizeBlocked(fix.blocked) : null;
    if (fixStatus === "blocked" && blocked === null) {
      lastCheckReport =
        'status="blocked" 但 blocked 字段缺失或全空。二选一修正：有卡点 → 补全 blocked { items: 至少一条卡住的问题, reason: 为什么需要用户裁决 }；无卡点 → status 改为 "done" 且返回体不含 blocked 字段。';
      isPrecheckFailure = false;
      continue;
    }
    if (blocked !== null) {
      // 部分修复照常入账（escalated 带出已完成的处置），停回用户裁决（卡点是「修不动」
      // 的方向问题而非结构化格式，不进重试）
      mergeRound(dispositions, round, ledger);
      prevDispositions = dispositions;
      prevRevisionSummary = revisionSummary;
      return await finish(
        "escalated",
        round,
        `方案性意见修不动，停回用户裁决：${blocked.reason}。停回通道：用户裁决新候选后重写设计文档再重新发起 W1（方向审必送）；本轮已完成的部分处置见处置表`,
        blocked,
      );
    }

    const checkInput = `${roundAbs}/.dispositions-check.json`;
    const wIn = await world.run("node", ["-e", NODE_WRITE_FILE, checkInput, JSON.stringify({ dispositions })]);
    const chk =
      wIn.exitCode === 0 ? await world.run("node", [checkCliAbs, checkInput, "--problems", `${roundAbs}/problems.json`]) : null;
    if (chk === null || chk.exitCode >= 2) {
      return await finish(
        "fix-failure",
        round,
        `校验器调用失败（写输入 exit ${wIn.exitCode}${chk !== null ? ` / 校验器 exit ${chk.exitCode}` : ""}）：${(chk !== null ? chk.stderr : wIn.stderr).trim()}。恢复动作：确认 skill 安装位的 ${CHECK_CLI_TILDE} 存在且 node 可执行后 args.attempt 递增重新发起`,
      );
    }
    let check: { ok: boolean; errors: { kind: string; detail: string }[]; warnings: string[] } | null = null;
    try {
      check = JSON.parse(chk.stdout);
    } catch {
      check = null;
    }
    if (check === null) {
      return await finish(
        "fix-failure",
        round,
        `校验器输出无法解析（stdout 前 200 字符：${JSON.stringify(chk.stdout.slice(0, 200))}）。恢复动作：人工跑 ${CHECK_CLI_TILDE} ${checkInput} --problems ${roundAbs}/problems.json 核对后 args.attempt 递增重新发起`,
      );
    }
    for (const w of check.warnings) log(`WARN: ${w}`);

    const coveredIds = new Set(dispositions.map((d) => d.id));
    const missedOutstanding = outstanding.filter((d) => !coveredIds.has(d.id));
    // 机器预检（处置表过校验后追加）：引擎复跑渲染 + check-design-doc——章节 JSON 的
    // 语法/结构/渲染红当场回喂修复者，免烧一整轮审查才暴露 rendered.md 损坏；warning
    // 档不进 exit code（与 setup 进场门槛同口径）
    let precheckErr = "";
    if (check.ok && missedOutstanding.length === 0) {
      const mRender = await world.run("node", [renderCliAbs, designDoc]);
      if (mRender.exitCode !== 0) {
        precheckErr = `渲染失败（render-design-doc.mjs exit ${mRender.exitCode}）：${mRender.stderr.trim() || mRender.stdout.trim()}——章节 JSON 存在语法/结构错误，按报错定位修复对应 JSON`;
      } else {
        if (mRender.stdout.trim() !== "") log(mRender.stdout.trim());
        const mChk = await world.run("node", [checkDesignCliAbs, designDoc]);
        if (mChk.exitCode !== 0) {
          precheckErr = `设计文档机器校验未过（check-design-doc.mjs exit ${mChk.exitCode}）：${mChk.stdout.trim() || mChk.stderr.trim()}——按校验报告修复对应章节 JSON`;
        }
      }
      if (precheckErr === "") {
        checkPassed = true;
        break;
      }
    }
    const errLines = check.errors.map((e) => `- [${e.kind}] ${e.detail}`);
    if (missedOutstanding.length > 0) {
      errLines.push(`- [outstanding] 上轮遗留条目 ${missedOutstanding.map((d) => `${d.id}（${d.title}）`).join("、")} 未出现在本轮处置表（延续条目必须复用原 id 处置——含登记不修/归档形态）`);
    }
    if (precheckErr !== "") {
      errLines.push(`- [precheck] ${precheckErr}`);
      isPrecheckFailure = true;
    }
    lastCheckReport = errLines.join("\n");
    // 失败留档：原始返回 + 校验报告（终态后接管者可对账——修复者的原始 dispositions
    // 只存在于返回值里，不落盘即无处可寻）
    const rawArchive = { attempt: fixAttempt, round, returned: fix, sanitized: dispositions, checkReport: lastCheckReport };
    await world.run("node", ["-e", NODE_WRITE_FILE, `${roundAbs}/raw-fix-return-${fixAttempt}.json`, JSON.stringify(rawArchive, null, 2)]);
    log(`WARN: 修复者处置表第 ${fixAttempt} 次未过校验（${errLines.length} 项）${fixAttempt < FIX_RETRY_MAX ? "，回喂校验报告重试" : "，重试预算耗尽"}`);
  }
  if (!checkPassed) {
    return await finish(
      "fix-failure",
      round,
      isPrecheckFailure
        ? `机器预检 ${FIX_RETRY_MAX} 次未通过（章节 JSON/渲染红——非处置表问题）：\n${lastCheckReport}\n原始返回与校验报告已留档 ${roundAbs}/raw-fix-return-*.json；按报告修复对应章节 JSON 后重跑 node ${renderCliAbs} ${designDoc} 再校验。恢复动作：人工修 JSON 后 args.attempt 递增重新发起（在途修订已留磁盘，接管前先盘点 ${designDoc}）`
        : `处置表校验 ${FIX_RETRY_MAX} 次未通过（初始 1 次 + 回喂重试）：\n${lastCheckReport}\n原始返回与校验报告已留档 ${roundAbs}/raw-fix-return-*.json；文档修订已留磁盘（修复内容通常有效，仅结构化返回不合规），接管前先盘点 ${designDoc}。恢复动作：人工按校验报告补正后落 ${roundAbs}/dispositions.json 续下轮，或 args.attempt 递增重新发起`,
    );
  }

  // 处置表落盘（json + md 由脚本从结构化数据确定性渲染，两版严格一致）
  const dispJson = JSON.stringify({ round, designDoc, revisionSummary, dispositions }, null, 2);
  const wj = await world.run("node", ["-e", NODE_WRITE_FILE, `${roundAbs}/dispositions.json`, dispJson]);
  const wm = await world.run("node", ["-e", NODE_WRITE_FILE, `${roundAbs}/dispositions.md`, renderDispositionsMd(round, dispositions, revisionSummary)]);
  if (wj.exitCode !== 0 || wm.exitCode !== 0) {
    return await finish(
      "fix-failure",
      round,
      `处置表落盘失败（json exit ${wj.exitCode} / md exit ${wm.exitCode}）：${wj.stderr.trim() || wm.stderr.trim()}。文档修复本身已留在 ${designDoc}，恢复动作：args.attempt 递增重新发起（下轮聚焦复审会重新对账）`,
    );
  }

  mergeRound(dispositions, round, ledger);
  prevDispositions = dispositions;
  prevRevisionSummary = revisionSummary;
  const fixedCount = dispositions.filter((d) => d.action === "fixed").length;
  const deferredCount = dispositions.filter((d) => d.action === "deferred").length;
  const archivedCount = dispositions.filter((d) => d.action === "archived").length;
  log(`第 ${round} 轮修复完成：处置 ${dispositions.length} 条（修复 ${fixedCount} / 登记 ${deferredCount} / 归档 ${archivedCount}），处置表 ${roundAbs}/dispositions.md`);
  await obsEnd("fix", round);
}

// ── 轮次耗尽收尾 ──
phase("落盘终态档案");
await obsBegin("finalize", null);
return await finish(
  "max-rounds",
  maxRounds,
  `轮次上限耗尽仍有未收敛条目（must-fix 轨迹：${trajectory.join(" → ")}）。停回通道：呈报残余风险矩阵（见 remaining），由用户裁决——继续循环或人工接管`,
);

