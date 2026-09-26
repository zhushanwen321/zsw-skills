/* @pi-meta
name: design-code-sync-loop
description: >-
  dev-flow-wf 技能 W4 终态同步循环：planner 规划后模块 reviewer 并行审差距，must-fix 级 contested 停回用户，分组并行双向修复收敛，伴生产物退役判定，矩阵与终态档案全由脚本落盘，不信任 agent 自报收敛
when: >-
  dev-flow-wf 技能 D5 终态同步段——交付后把代码实现与设计文档差距双向校准到 0 must-fix 时调用，审查对象是当前 HEAD 终态全量，必传 designDoc / implPlan / projectRoot
notFor: >-
  diff 区间代码评审（用 review-fix-loop）或设计文档审查（用 tech-review-loop）
phases: ['框架对照与模块规划', '机械信号扫描', '并行模块审查', '聚焦复审', '并行修复与复审', '伴生产物退役判定']
parameters:
  type: object
  properties:
    designDoc:
      type: string
      description: "设计文档绝对路径（.tmp/tech-design/<name>.md，code-right 条目的修复对象之一）"
    implPlan:
      type: string
      description: "实施计划 JSON 路径（.tmp/tech-design/<name>.impl-plan.json，planner ②③职责对照对象）"
    projectRoot:
      type: string
      description: "目标项目根绝对路径（git 操作基准 + .tmp/dev-flow 产物目录落点）"
    statusPath:
      type: string
      default: ""
      description: "status.json 绝对路径（可选；planner 职责②「现实↔impl-plan 进度核对」的数据源——D1/D2 终态事实；未传时②的进度核对降级为 impl-plan.json 单侧并在轨迹注明）"
    maxRounds:
      type: number
      default: 10
      description: "审查→修复循环轮次上限（含 R1 首轮全量审）"
    plannerTemplate:
      type: string
      default: "~/.agents/skills/dev-flow-wf/agents/sync-planner.md"
      description: "framework-scan planner agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-planner.md）"
    reviewerTemplate:
      type: string
      default: "~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md"
      description: "模块 reviewer agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md）"
    attempt:
      type: number
      default: 1
      description: "重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）"
  required: [designDoc, implPlan, projectRoot]
*/

// ===== zcode→pi 兼容 shim（两版差异区之一：另含 @pi-meta 头/schema 常量/TS 剥离/agent 调用层/续聊补丁）=====
const { spawnSync } = require("node:child_process");
const $WS = typeof $WORKSPACE === "string" ? $WORKSPACE : process.cwd();
// world.run：zcode facade 的命令执行（cwd=workspace、非零退出码为返回值非异常）
const world = {
  run: async (cmd, a, opts) => {
    const r = spawnSync(cmd, a ?? [], {
      cwd: $WS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      timeout: opts && opts.timeoutMs ? opts.timeoutMs : 300000,
    });
    // 执行器故障/超时 throw 对齐 zcode reject 语义（非零退出码仍是返回值不是异常）
    if (r.error) throw r.error;
    return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
};
// args：pi 的 $ARGS（--args k=v）；数字参数字符串归一
const args = {};
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  args[k] = typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
}
// report / artifact：zcode 专有通道，pi 无对应面，降级为 no-op（结果仍经 return 交付）
const report = () => {};
const artifact = { chart: () => {}, board: () => {}, markdown: async () => {}, file: async () => {} };

// ============================================================================
// design-code-sync-loop — dev-flow-wf 技能 W4 终态同步循环（pi workflow）
// 骨架镜像自 review-fix-loop 与 tech-review-loop（多脚本循环骨架
// = 镜像 + 头部差异登记，改动任一侧循环骨架时评估另一侧是否需要同步）。语义权威源 =
// dev-flow 流程优化设计文档 §7（两级拓扑 / 方向语义权威表 / 三向矩阵 / 越权三问三档 /
// 审查关系五条 / 修复纪律 / 退役判定 / 停机线），落点参照 dev-flow-wf/flow/sync.md。
// 与 rfl 的结构差异：
//  - 无 LLM 聚合层：矩阵行 = 脚本 concat（planner 框架行 + 各模块 reviewer 行结构化
//    返回），跨模块 findings 不去重（文件锚点唯一归属）
//  - 审查对象 = HEAD 终态全量（非 diff 区间）；两级拓扑 R1 一次，R2+ 聚焦复审只审
//    上轮修复影响面（pi 版：无续聊，R1 上下文经 prompt 前情补丁注入）
//  - 修复分组输入 = 模块 files 并集（脚本确定性构造候选组）+ reconcileGroups 机器校验
//    （照搬 rfl：无效组过滤 / 覆盖兜底 / 组间 files 相交传递闭包合并 / 重编 G1..Gn——
//    modules[].files 是 LLM 自报字段，并行 fixer 同文件冲突风险与分组来源无关）
//  - 双向修复（方向语义权威，勿反）：doc-right = 文档更合理 → 修代码（增量测试必须绿）；
//    code-right = 代码更合理 → 修文档（联动自检五处）；contested = must-fix 级停回用户，
//    suggestion/info 级默认 doc-right 并随终态汇报列出
//  - 机械信号步（R1，world.run 无 agent）：反引号标识符批量 git grep，悬空直接立项
//    （owner=mechanical；R2+ 引擎重跑机械步对账，不走 LLM 复审）
//  - 越权候选防线（§7.3 三档机器落点）：框架行 overdesign 过度/存疑入账即转候选卡；
//    fixer 遇删码类修复无论等级（含 must-fix）可申报 defer 不执行——两者都随终态
//    overdesignCandidates 呈报，用户裁决前不产生删码动作
//  - 修复全等级当轮修完不留尾巴（must-fix/suggestion/info）；组核验（改动 ⊆ 组文件并集
//    ∪ 如实申报的 affectedFiles）→ 引擎组级一笔 commit（gitignore 产物留盘不提交）
//  - converged 时伴生产物退役判定：agent 只产清单（零候选也显式返回），引擎按清单执行
//    git mv / 文件移动 + 完整文件名全仓引用验证（任一命中不退役）+ 移动后反向复验
//  - 一切失败 failed-as-return（沿 W1 T8 收紧：throw 的 errored run 不可 resume）——
//    含未知参数键白名单 fail-fast
// 数据传递 = 结构化返回总线（无聚合层故不落重型报告文件）：matrixRows / findings /
// reconciliation / fixes 经 ask<T> 返回，脚本侧归一入台账；每轮原始返回留档
// round-N[.attemptM]/ 下供断点恢复人读。agent 模板默认路径 = 本 skill 安装位
// （~/.agents/skills/dev-flow-wf/agents/，args 可覆盖），~ 前缀经 node -e 通道运行时展开。
// ============================================================================

// ── 结果 schema 常量（ask 结构化返回契约；原 TS interface 的 JSDoc 字段描述随迁） ──

// 三向功能对照矩阵行（模板输出 schema 对齐 sync-reviewer/sync-planner）
const SCHEMA_MatrixRowLite = {
  type: "object",
  properties: {
    claim: { type: "string", description: "设计声明锚点（§N）" },
    impl: { type: "string", description: "代码实现锚点（file:line 或 未找到）" },
    verdict: { type: "string", description: "一致 / 漏实现 / 越权实现" },
    note: { type: "string", description: "一句话说明" },
    overdesign: { type: "string", description: "越权实现三问初评档位（合理/过度/存疑），仅越权行有" },
  },
  required: ["claim", "impl", "verdict", "note"],
};

// planner 框架级发现（矩阵顶层行 + 台账条目）
const SCHEMA_PlannerFrameworkFinding = {
  type: "object",
  properties: {
    id: { type: "string", description: "展示用 id（FF1 形态；台账以脚本重编 id 为准）" },
    matrixRow: SCHEMA_MatrixRowLite,
    severity: { type: "string", enum: ["must-fix", "suggestion", "info"], description: "must-fix / suggestion / info" },
  },
  required: ["id", "matrixRow", "severity"],
};

// 模块计划（planner 产出，phase 2 fan-out 派发依据）
const SCHEMA_ModulePlanRec = {
  type: "object",
  properties: {
    id: { type: "string", description: "模块 id（m1 形态；agent 命名与条目归属键）" },
    module: { type: "string", description: "模块名/路径" },
    files: { type: "array", items: { type: "string" }, description: "核对文件集（projectRoot 绝对路径，供确定性分组校验）" },
    focus: { type: "string", description: "对照设计章节锚点 + 审查重点" },
  },
  required: ["id", "module", "files", "focus"],
};

// planner 结构化返回（sync-planner 模板输出节）
const SCHEMA_PlannerResult = {
  type: "object",
  properties: {
    frameworkFindings: { type: "array", items: SCHEMA_PlannerFrameworkFinding },
    modules: { type: "array", items: SCHEMA_ModulePlanRec },
  },
  required: ["frameworkFindings", "modules"],
};

// findings 八字段 schema（sync-reviewer 模板第 4 条，W4 台账载体）
const SCHEMA_Finding8 = {
  type: "object",
  properties: {
    id: { type: "string" },
    location: { type: "string", description: "file:line 或 文档§章节" },
    gap: { type: "string", description: "现实与文档各自怎么说" },
    direction: { type: "string", enum: ["doc-right", "code-right", "contested"], description: "doc-right（文档更合理→修代码）/ code-right（代码更合理→修文档）/ contested（不得自行裁决）" },
    severity: { type: "string", enum: ["must-fix", "suggestion", "info"], description: "must-fix = 过时登记/悬空符号/行为与文档矛盾；suggestion = 不同步但不误导；info = 知晓级" },
    impact: { type: "string", description: "误导了什么交付判断——写不出 = 不立项或降 info" },
    rationale: { type: "string", description: "方向裁决理由" },
    fixHint: { type: "string", description: "修复建议（执行方须重演验证）" },
  },
  required: ["id", "location", "gap", "direction", "severity", "impact", "rationale", "fixHint"],
};

// R2+ 聚焦复审对账条目
const SCHEMA_ReconEntry = {
  type: "object",
  properties: {
    prevId: { type: "string", description: "上轮条目 id（与注入清单一致原样引用）" },
    status: { type: "string", enum: ["fixed", "not-fixed", "regressed"], description: "fixed = 亲自核实已修复；not-fixed = 仍存在；regressed = 复发或修复引入新问题" },
    evidence: { type: "string", description: "读了什么、确认了什么（file + 改动事实）；修复方声称不算证据" },
  },
  required: ["prevId", "status", "evidence"],
};

// 模块 reviewer 结构化返回（sync-reviewer 模板输出节）
const SCHEMA_ModuleReview = {
  type: "object",
  properties: {
    matrixRows: { type: "array", items: SCHEMA_MatrixRowLite },
    findings: { type: "array", items: SCHEMA_Finding8 },
    moduleNoFinding: { type: "string", description: "本模块无发现时的显式声明（如「在 X 未发现」" },
    reconciliation: { type: "array", items: SCHEMA_ReconEntry, description: "R2+ 聚焦复审对账（R1 恒空数组）" },
  },
  required: ["matrixRows", "findings"],
};

// 修复组条目级记录
const SCHEMA_FixRecord = {
  type: "object",
  properties: {
    issueId: { type: "string", description: "条目 id（与任务条目一致原样引用）" },
    description: { type: "string", description: "一句修复描述（含组外波及标注）" },
    selfCheck: { type: "string", description: "自检：一条可复跑命令 + 预期结果" },
  },
  required: ["issueId", "description", "selfCheck"],
};

// 修复组 agent 结构化返回
const SCHEMA_FixOutcome = {
  type: "object",
  properties: {
    fixes: { type: "array", items: SCHEMA_FixRecord },
    affectedFiles: { type: "array", items: { type: "string" }, description: "实际改动文件（含新增文件与组外正当扩展——引擎据此做领地核验与组级 commit）" },
    deferred: {
      type: "array",
      description: "越权候选 defer 申报（§7.3 机器落点）：条目的修复动作将是删码而条目非 must-fix 级 → fixer 不执行删除，申报转呈报；引擎放行（不算漏修）并随终态 overdesignCandidates 呈报",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["issueId", "reason"],
      },
    },
  },
  required: ["fixes", "affectedFiles", "deferred"],
};

// 退役判定 agent 结构化返回（只判定，不执行）
const SCHEMA_RetirementVerdict = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      description: "退役候选清单（引擎执行引用验证 + 移动；零候选时显式返回空数组）",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "reason"],
      },
    },
    kept: {
      type: "array",
      description: "保留项及依据（含 .tmp 合规放置类）",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "reason"],
      },
    },
  },
  required: ["candidates", "kept"],
};

// zcAgent：zcode agent(name, persona).ask(prompt) 的 pi 等价——persona 拼 prompt 头
// （pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊——复用点靠 prompt 自包含，见转换检查）
// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  PlannerResult: SCHEMA_PlannerResult,
  ModuleReview: SCHEMA_ModuleReview,
  FixOutcome: SCHEMA_FixOutcome,
  RetirementVerdict: SCHEMA_RetirementVerdict,
};
function wfAgent(name, persona) {
  return {
    ask: async (typeKey, instructions) => {
      const schema = SCHEMA_BY_KEY[typeKey];
      if (!schema) throw new Error(`未知 ask 类型键 ${typeKey}（SCHEMA_BY_KEY 未登记）`);
      const desc = String(name).replace(/-r\d+$/i, "").replace(/-R\d+$/i, "");
      const prompt = persona ? persona + "\n\n=====\n\n" + instructions : instructions;
      const raw = await agent({ prompt, schema, description: desc });
      if (raw === null || raw === undefined) throw new Error("agent() 无返回");
      if (typeof raw === "object" && raw !== null && typeof raw.error === "string" && raw.error) throw new Error(raw.error);
      return raw;
    },
  };
}

// ── F 区平台钩子：R2+ 聚焦复审的 R1 上下文（pi 无续聊，复审 ask 前注入定位上下文） ──
function r2PrevContextBlock(owner, mm, projectRoot, designDoc, implPlan, headHash, plannerTplAbs, reviewerTplAbs, rel) {
  const lines = [
    "==== 前情（pi 版补：zcode 版由同 agent 续聊承载的 R1 上下文）====",
    owner === "planner"
      ? "你是终态同步的两级审查第一级（framework-scan planner），此前已做 R1 框架对照与模块分解。"
      : "你是终态同步的模块审查者，此前已做 R1 模块全量审查。",
    owner === "planner"
      ? `仓库 ${projectRoot}；设计文档 ${designDoc}；impl-plan ${implPlan}；审查基线 = 当前 HEAD（${headHash}）——审查对象是 HEAD 终态全量，不是 diff 区间。`
      : `仓库 ${projectRoot}；设计文档 ${designDoc}；审查基线 = 当前 HEAD（${headHash}）。`,
    `你的任务契约模板：${owner === "planner" ? plannerTplAbs : reviewerTplAbs}。`,
  ];
  if (owner !== "planner" && mm) {
    lines.push(`你负责的模块计划（planner 原文）：module=${mm.module}；files=${mm.files.map((p) => rel(p)).join("、")}；focus=${mm.focus}。`);
  }
  return lines.join("\n");
}

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）";
const HINT_PLANNER_INVALID = "修订脚本 prompt 后重跑";
const HINT_RETIRE_INVALID = "修订脚本退役 prompt 后重跑";

@@STITCH@@
