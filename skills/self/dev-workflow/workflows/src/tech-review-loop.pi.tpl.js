/* @pi-meta
name: tech-review-loop
description: >-
  tech-design-wf 技能 W1 设计文档审查循环：价值审 gate（否决即停回 T1）后主审/影响面审/简洁审三维并行审查，文档修复者合并修复并产出处置表，循环至 converged、escalated、stuck 或 max-rounds，终态判定与覆盖校验全由脚本完成，不信任 agent 自报收敛
when: >-
  tech-design-wf 技能 W1 阶段——技术设计文档（tech-design 产物）需要对抗式审查修复循环时调用，必传设计文档与项目根绝对路径
notFor: 代码 review-fix 循环（用内置 review-fix-loop workflow）
phases: ['校验审查环境并做价值评审', '三审并行聚焦复审', '修复设计文档并产出处置表', '落盘终态档案']
parameters:
  type: object
  properties:
    designDoc:
      type: string
      description: 审查对象设计文档绝对路径（修复者会直接编辑该文件完成修复）
    projectRoot:
      type: string
      description: 项目根绝对路径（AGENTS/PRODUCT 上下文提示来源 + .tmp/tech-design 产物目录落点）
    maxRounds:
      type: number
      default: 10
      description: 审查-修复循环轮次上限（含首轮全面审）
    reviewers:
      type: array
      items: { type: string }
      description: 自定义 reviewer 模板绝对路径数组，按文件 basename 覆盖同名维度（tech-design-value-review.md / tech-design-review.md / tech-design-impact-review.md / tech-design-simplicity-review.md）；未匹配任何维度的条目忽略并告警
    attempt:
      type: number
      default: 1
      description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）
  required: [designDoc, projectRoot]
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

// ===== zcode ask<T> 的 schema 常量（zcode 版由 harness 从 TS interface 合成，pi 显式传 JSON Schema）=====
// 映射自被 ask<...> 使用的 interface（含嵌套 ReconEntry/Disposition）；interface 的 JSDoc 字段注释 → schema 字段 description
const SCHEMA_ReconEntry = {
  type: "object",
  properties: {
    prevId: { type: "string", description: "上轮处置表条目 id（R1 恒返回空数组；R2+ 对注入的必对账集逐条申报）" },
    status: {
      type: "string",
      enum: ["fixed", "not-fixed", "regressed", "escalate"],
      description:
        "fixed = 亲自读文档核实已修复；not-fixed = 仍存在（计入 mustFix）；regressed = 修复复发或引入新问题（计入 mustFix）；escalate = 登记/归档条目上下文被本轮修复改变，申报复活（唯一复活通道，报告正文里的文字申报不处理）",
    },
    evidence: { type: "string", description: "读了文档哪里、确认了什么（原文事实）；fixed 申报不带实证不采信" },
  },
  required: ["prevId", "status", "evidence"],
};

const SCHEMA_ProblemRef = {
  type: "object",
  properties: {
    ref: { type: "string", description: "报告内问题锚点，格式 review-<维度>#<序>（如 review-main#2 / 价值审 review-value#<序>），与报告小节标题/表格行一致" },
    level: { type: "string", enum: ["must-fix", "suggestion"], description: "must-fix 级或 suggestion 级（与报告小节分级一致）" },
    title: { type: "string", description: "一句话问题标题" },
  },
  required: ["ref", "level", "title"],
};

const SCHEMA_ValueVerdict = {
  type: "object",
  properties: {
    reportFile: { type: "string", description: "价值审报告文件路径（脚本按确定性位置校验，不以自报为准）" },
    mustFix: { type: "number", description: "must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验）" },
    suggestion: { type: "number", description: "suggestion 条数（与报告一致；同上做交叉校验）" },
    problems: {
      type: "array",
      items: SCHEMA_ProblemRef,
      description: "逐条问题清单（否决判定与计数派生的唯一事实源；条数合计须等于 mustFix+suggestion）",
    },
    oneliner: { type: "string", description: "一句话价值判定（终态档案 valueOneliner/oneliner 字段来源）" },
  },
  required: ["reportFile", "mustFix", "suggestion", "problems", "oneliner"],
};

const SCHEMA_ReviewerVerdict = {
  type: "object",
  properties: {
    mustFix: { type: "number", description: "must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验）" },
    suggestion: { type: "number", description: "suggestion 条数（与报告一致；同上做交叉校验）" },
    problems: {
      type: "array",
      items: SCHEMA_ProblemRef,
      description: "逐条问题清单（处置表覆盖校验的对账锚点；条数须与 mustFix/suggestion 计数一致）",
    },
    reconciliation: {
      type: "array",
      items: SCHEMA_ReconEntry,
      description: "R1 恒空数组；R2+ 对上轮处置表必对账集逐条申报",
    },
  },
  required: ["mustFix", "suggestion", "problems", "reconciliation"],
};

const SCHEMA_Disposition = {
  type: "object",
  properties: {
    id: { type: "string", description: "处置条目 id（新条目 D-<轮>-<序>；延续条目复用上轮原 id）" },
    title: { type: "string", description: "一句话问题标题（跨轮对账锚点）" },
    source: { type: "array", items: { type: "string" }, description: "该条合并覆盖的原始问题引用（如 review-main#2；同根因跨维度合并时多个来源并列）" },
    level: { type: "string", enum: ["must-fix", "suggestion"], description: "must-fix 级或 suggestion 级" },
    action: { type: "string", enum: ["fixed", "deferred", "archived"], description: "fixed = 已修复 / deferred = 登记不修 / archived = 归档" },
    location: { type: "string", description: "修订位置（设计文档章节/锚点）" },
    reenactment: { type: "string", description: "反例重演：该问题如何被发现，修复后在修订稿上重演验证已消除" },
    attackHints: { type: "string", description: "攻击点建议：给下轮聚焦复审的优先检查方向" },
    affectsDecision: { type: "string", description: "影响决策：该问题影响哪些设计决策（必填，无影响也显式写「无」）" },
    affectsDelivery: { type: "string", description: "影响交付：该问题影响哪些交付物/验收（必填，无影响也显式写「无」）" },
  },
  required: ["id", "title", "source", "level", "action", "location", "reenactment", "attackHints", "affectsDecision", "affectsDelivery"],
};

const SCHEMA_FixOutcome = {
  type: "object",
  properties: {
    dispositions: { type: "array", items: SCHEMA_Disposition, description: "本轮处置表全部条目（含延续与新增）" },
    revisionSummary: { type: "string", description: "一段修订摘要：本轮改了设计文档哪些地方（注入下轮 reviewer，不算证据）" },
    blocked: {
      type: ["object", "null"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["items", "reason"],
      description: "方案性意见修不动（需用户裁决的方向变化）时非空；为空表示无卡点",
    },
  },
  required: ["dispositions", "revisionSummary", "blocked"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊——
// 复用点靠 prompt 自包含，见 F 区前情补丁）。
const SCHEMA_BY_KEY = {
  ValueVerdict: SCHEMA_ValueVerdict,
  ReviewerVerdict: SCHEMA_ReviewerVerdict,
  FixOutcome: SCHEMA_FixOutcome,
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

// ── 修复者重试前情补丁（F 区钩子）：pi 侧 ask 每次新 agent（无续聊），重试指令必须
// 自包含前情（首次指令 + 上次返回 + 校验报告）；zcode 侧同 actor 续聊上下文天然可见 ──
function withRetryContext(firstInstructions, firstReturn, checkReport) {
  return [
    "【前情】你此前收到过修复任务指令并已返回结果，但处置表未通过脚本校验，本轮是重试。",
    "=====",
    "此前任务指令：",
    String(firstInstructions),
    "上次返回的 dispositions（JSON）：",
    JSON.stringify((firstReturn && firstReturn.dispositions) || []),
    "=====",
    "",
  ].join("\n");
}

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）";
const HINT_REVIEW_BAD_COUNT = "修订脚本 prompt 后重新 run，或 args.attempt 递增重新发起";

@@STITCH@@
