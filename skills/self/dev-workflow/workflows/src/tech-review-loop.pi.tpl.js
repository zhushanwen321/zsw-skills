/* @pi-meta
name: tech-review-loop
description: >-
  tech-design-v1 技能 W1 设计文档审查循环：方向审席与主审/影响面审/简洁审四席同轮并行（方向审 patch 档发现随当轮问题清单进入聚合；rewrite 档整循环终止回 T1），聚合裁决独立 phase 把四席发现按同根因合并为去重权威清单 aggregated.md（refs 精确划分脚本 fail-closed 校验），文档修复者据聚合清单修复并产出处置表，循环至 converged、escalated、stuck 或 max-rounds，终态判定与覆盖校验全由脚本完成，不信任 agent 自报收敛
when: >-
  tech-design-v1 技能 W1 阶段——技术设计文档（tech-design 产物）需要对抗式审查修复循环时调用，必传设计文档与项目根绝对路径
notFor: 代码 review-fix 循环（用内置 review-fix-loop workflow）
phases: ['校验审查环境并做方向审', '四席并行聚焦复审', '聚合裁决', '修复设计文档并产出处置表', '落盘终态档案']
parameters:
  type: object
  properties:
    designDoc:
      type: string
      description: 设计目录绝对路径（内含六个章节 JSON 权威源；修复者直接编辑章节 JSON 完成修复）或其渲染 md 路径（以 .rendered.md 结尾时内部归一为设计目录）；存量 md 单文件设计包不受支持——进场校验会输出迁移指引
    projectRoot:
      type: string
      description: 项目根绝对路径（AGENTS/PRODUCT 上下文提示来源 + skill-data 审查产物目录的 project-slug 计算输入）
    maxRounds:
      type: number
      default: 10
      description: 审查-修复循环轮次上限（含首轮全面审；四席同轮并行）
    reviewers:
      type: array
      items: { type: string }
      description: 自定义 reviewer 模板绝对路径数组，按文件 basename 覆盖同名维度（tech-design-direction-review.md / tech-design-review.md / tech-design-impact-review.md / tech-design-simplicity-review.md）；未匹配任何维度的条目忽略并告警
    attempt:
      type: number
      description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）。不得设 default——default 数值会被引擎物化成显式值、吞掉「未传」形态，自动检测失效，重发起时轮次目录无 attempt 后缀、覆盖首轮产物（实测：省略参数 → 引擎填 1）
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」"
    executionId:
      type: string
      description: "本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测 JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
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
// args：pi 的 $ARGS（--args k=v）由宿主以 `const args = $ARGS` 注入——产物重声明
// args 会炸 SyntaxError，故就地归一化 $ARGS（宿主别名同指此对象）
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    $ARGS[k] = Number(v);
  }
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
    ref: { type: "string", description: "报告内问题锚点，格式 review-<维度>#<序>（如 review-main#2 / 方向审 review-direction#<序>），与报告小节标题/表格行一致" },
    title: { type: "string", description: "一句话问题标题" },
  },
  required: ["ref", "title"],
};

const SCHEMA_DirectionVerdict = {
  type: "object",
  properties: {
    mustFix: { type: "number", description: "must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验）" },
    fixScope: { type: "string", enum: ["patch", "rewrite"], description: "打回档位：patch = 全部发现属前提层/产物表/措辞级（进当轮问题清单由文档修复者处置）；rewrite = 问题定义/方案主干/分型被击穿（整循环立即终止回 T1）。mustFix = 0 时不消费" },
    problems: {
      type: "array",
      items: SCHEMA_ProblemRef,
      description: "逐条问题清单（打回判定与计数派生的唯一事实源；条目无 level 字段——唯一级别是 must-fix；条数合计须等于 mustFix）",
    },
    reconciliation: {
      type: "array",
      items: SCHEMA_ReconEntry,
      description: "R1 恒空数组；R2+ 对上轮处置表必对账集逐条申报（与三审同契约）",
    },
    oneliner: { type: "string", description: "一句话方向判定（终态档案 oneliner 字段来源）" },
  },
  required: ["mustFix", "fixScope", "problems", "reconciliation", "oneliner"],
};

const SCHEMA_ReviewerVerdict = {
  type: "object",
  properties: {
    mustFix: { type: "number", description: "must-fix 条数（与报告一致；脚本以 problems 清单派生计数为准，此字段做交叉校验）" },
    problems: {
      type: "array",
      items: SCHEMA_ProblemRef,
      description: "逐条问题清单（处置表覆盖校验的对账锚点；条目无 level 字段——唯一级别是 must-fix；条数须与 mustFix 计数一致）",
    },
    reconciliation: {
      type: "array",
      items: SCHEMA_ReconEntry,
      description: "R1 恒空数组；R2+ 对上轮处置表必对账集逐条申报",
    },
  },
  required: ["mustFix", "problems", "reconciliation"],
};

const SCHEMA_Disposition = {
  type: "object",
  properties: {
    id: { type: "string", description: "处置条目 id（新条目 D-<轮>-<序>；延续条目复用上轮原 id）" },
    title: { type: "string", description: "一句话问题标题（跨轮对账锚点）" },
    source: { type: "array", items: { type: "string" }, description: "该条合并覆盖的原始问题引用（如 review-main#2；同根因跨维度合并时多个来源并列）" },
    action: { type: "string", enum: ["fixed", "deferred", "archived"], description: "fixed = 已修复 / deferred = 登记不修 / archived = 归档" },
    location: { type: "string", description: "修订位置（设计文档章节/锚点）" },
    reenactment: { type: "string", description: "反例重演：该问题如何被发现，修复后在修订稿上重演验证已消除" },
    attackHints: { type: "string", description: "攻击点建议：给下轮聚焦复审的优先检查方向" },
    affectsDecision: { type: "string", description: "影响决策：该问题影响哪些设计决策（必填，无影响也显式写「无」）" },
    affectsDelivery: { type: "string", description: "影响交付：该问题影响哪些交付物/验收（必填，无影响也显式写「无」）" },
  },
  required: ["id", "title", "source", "action", "location", "reenactment", "attackHints", "affectsDecision", "affectsDelivery"],
};

const SCHEMA_FixOutcome = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["done", "blocked"],
      description:
        '本轮结论声明（必填，二选一，判别键）："done" = 修复与处置完成、无方案性卡点（返回体不得携带 blocked 字段）；"blocked" = 存在修不动、需用户裁决的方案性分歧（必须携带 blocked 字段）',
    },
    dispositions: { type: "array", items: SCHEMA_Disposition, description: "本轮处置表全部条目（含延续与新增）" },
    revisionSummary: { type: "string", description: "一段修订摘要：本轮改了设计文档哪些地方（注入下轮 reviewer，不算证据）" },
    blocked: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["items", "reason"],
      description:
        '仅 status="blocked" 时携带：items=卡住的问题清单，reason=为什么需要用户裁决。不是表态字段——引擎只认 status，done 形态下附带该字段无效',
    },
  },
  required: ["status", "dispositions", "revisionSummary"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊——
// 复用点靠 prompt 自包含，见 F 区前情补丁）。
const SCHEMA_AggregatedItem = {
  type: "object",
  properties: {
    refs: { type: "array", items: { type: "string" }, description: "该聚合项覆盖的原始问题 ref（四席报告锚点，至少一个；全体聚合项的 refs 构成原始清单的精确划分）" },
    title: { type: "string", description: "一句话根因标题" },
    guidance: { type: "string", description: "合并后的可执行修复操作清单（改哪个章节 JSON 哪个条目、补什么内容、跑什么检索）" },
  },
  required: ["refs", "title", "guidance"],
};

const SCHEMA_AggregationOutcome = {
  type: "object",
  properties: {
    items: { type: "array", items: SCHEMA_AggregatedItem, description: "聚合项清单（去重后权威问题清单，脚本渲染为 aggregated.md）" },
  },
  required: ["items"],
};

const SCHEMA_BY_KEY = {
  DirectionVerdict: SCHEMA_DirectionVerdict,
  ReviewerVerdict: SCHEMA_ReviewerVerdict,
  FixOutcome: SCHEMA_FixOutcome,
  AggregationOutcome: SCHEMA_AggregationOutcome,
};
function wfAgent(name, persona) {
  return {
    ask: async (typeKey, instructions) => {
      const schema = SCHEMA_BY_KEY[typeKey];
      if (!schema) throw new Error(`未知 ask 类型键 ${typeKey}（SCHEMA_BY_KEY 未登记）`);
      // desc 直取 name 原文（不做 -rN/-RN 后缀剥离）：pi 实例名须与静态第一实参一致——
      // workflow DAG 静态派生模板按调用点第一实参提取，剥离会让带轮次后缀的名字
      // （主审-r2 等）匹配不上实例；且 zcode 侧同名即续聊，后缀是轮次新 agent 的身份语义，
      // 两平台显示名本就应当对齐。
      const desc = String(name);
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

// ── host 标识（run manifest host 字段，skill-data-redesign §5.1：shared 不留 host
// 硬编码，两壳各持常量）──
const HOST_PLATFORM = "pi";

// ── O 区观测平台钩子：写通道 = world.run（shim 内 spawnSync；无 journal 重放语义，每次 run 实写）。
// shared 观测层调用 obsNow/obsAppend；换平台只换钩子实现，事件契约在 shared ──
const OBS_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
const OBS_APPEND_LINE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
async function obsNow() {
  try {
    const r = await world.run("node", ["-e", OBS_PROBE_NOW]);
    const t = r.exitCode === 0 ? r.stdout.trim() : "";
    return t !== "" ? t : null;
  } catch (e) {
    // 执行器故障（spawn 失败/超时）：观测降级为不记录该事件，业务不受影响
    return null;
  }
}
async function obsAppend(filePath, line) {
  try {
    const r = await world.run("node", ["-e", OBS_APPEND_LINE, filePath, line]);
    return r.exitCode === 0 ? null : `exit ${r.exitCode}：${r.stderr.trim() || r.stdout.trim()}`;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

@@STITCH@@
