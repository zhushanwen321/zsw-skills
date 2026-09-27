/* @pi-meta
name: dev-consistency-loop
description: >-
  dev-flow-wf W3 一致性审查循环：R1 分区全面审后修复组并行修复并定向复审，Gate A 全量测试零容忍绕过，循环至 converged 或 stuck，终态判定与顽固条目追踪全由脚本完成，不信任 agent 自报收敛
when: >-
  dev-flow-wf 主流程 D2 阶段——W2 开发循环终态后由主 agent 发起，输入 exec-plan（D0 编译产物），终态 converged/stuck/gate-a-failed/环节失败由主 agent 接力处理
phases: ['生成分区并全面审查', '并行修复与定向复审', '产物类并行预备', '跑全量测试 Gate A']
parameters:
  type: object
  properties:
    execPlan:
      type: string
      description: "exec-plan.json 路径（绝对或 workspace 相对；D0 编译产物，须含 baseline/planPath/designDocPath/statusPath/projectRoot/testPlan.fullSuite）"
    maxRounds:
      type: number
      default: 10
      description: "修复→定向复审循环轮次上限（R1 全面审不计入）"
    reviewerTemplate:
      type: string
      default: "~/.agents/skills/dev-flow-wf/agents/consistency-reviewer.md"
      description: "一致性审查 agent 模板路径（缺省用 dev-flow-wf skill 内置模板）"
    attempt:
      type: number
      default: 1
      description: "重发起序号（status.json events 追加保留历史不覆盖；attempt > 1 时 Gate A 日志命名带 .attemptM 后缀防覆盖上轮日志）"
  required: [execPlan]
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
// ── 结果 schema 常量（ask 结构化返回契约；原 TS interface 的 JSDoc 字段描述随迁）──

const SCHEMA_ReasonableEntry = {
  type: "object",
  properties: {
    location: { type: "string", description: "位置 file:line 或文件路径" },
    summary: { type: "string", description: "一句话：为何属合理演化（实现优于设计 / 不破坏设计目标）" },
    docSyncSuggestion: { type: "string", description: "文档同步建议（终态回流主 agent，D5 终态同步消费）" },
  },
  required: ["location", "summary", "docSyncSuggestion"],
};

const SCHEMA_GapEntry = {
  type: "object",
  properties: {
    location: { type: "string", description: "问题位置 file:line（或文件路径）" },
    gap: { type: "string", description: "一句话差距：违背设计 / 遗漏未做 / 越权多做 / 文档自身错误" },
    affectsDecision: { type: "string", description: "影响决策（模板两必填字段之一）：「是——<违背哪条机制决策，不修则落空>」或「否——<半句理由>」" },
    affectsDelivery: { type: "string", description: "影响交付（模板两必填字段之二）：「<环节>——<什么会出错>」，环节 = 开发/测试/验收/文档登记/无" },
    severity: { type: "string", enum: ["high", "medium", "low"], description: "严重度：high 预留给破坏数据/崩溃级" },
    fixHint: { type: "string", description: "一句可执行修复建议" },
    prevId: { type: "string", description: "R2+ 复审专属：延续上批条目时原样填其 U 编号（引擎按它刷新条目描述，不按文字匹配）；新问题不填" },
  },
  required: ["location", "gap", "affectsDecision", "affectsDelivery", "severity", "fixHint"],
};

const SCHEMA_ReconEntry = {
  type: "object",
  properties: {
    prevId: { type: "string", description: "上批条目 id（原样引用注入清单中的 U 编号）" },
    status: {
      type: "string",
      enum: ["fixed", "not-fixed"],
      description: "fixed = 亲自读代码到行级核实修复成立；not-fixed = 仍存在（条目保持活跃并计数）",
    },
    evidence: { type: "string", description: "读了哪里、确认了什么（file:line 事实）；fixed 申报不带证据不采信" },
  },
  required: ["prevId", "status", "evidence"],
};

const SCHEMA_ReviewResult = {
  type: "object",
  properties: {
    reasonable: {
      type: "array",
      description: "实现优于设计 / 合理演化且不破坏设计目标——不进修复循环，随终态回流",
      items: SCHEMA_ReasonableEntry,
    },
    unreasonable: {
      type: "array",
      description: "违背设计 / 遗漏未做 / 越权多做——进修复循环（按 location 归属分区成组）；延续上批条目时带 prevId",
      items: SCHEMA_GapEntry,
    },
    docErrors: {
      type: "array",
      description: "文档自身错了（实现是对的）——不进修复循环，随终态回流主 agent",
      items: SCHEMA_GapEntry,
    },
    reconciliation: {
      type: "array",
      description: "R1 恒 []；R2+ 对上批本组逐条申报裁决（fixed+证据才清零，not-fixed/漏报保持活跃）",
      items: SCHEMA_ReconEntry,
    },
  },
  required: ["reasonable", "unreasonable", "docErrors", "reconciliation"],
};

const SCHEMA_FixRecord = {
  type: "object",
  properties: {
    id: { type: "string", description: "条目 id（原样引用任务清单中的 U 编号）" },
    description: { type: "string", description: "一句修复描述" },
    affectedFiles: { type: "array", items: { type: "string" }, description: "改动文件 + 波及文件（相对仓库根路径）——引擎按它核验改动归属并精确 add" },
  },
  required: ["id", "description", "affectedFiles"],
};

const SCHEMA_FixReport = {
  type: "object",
  properties: {
    fixes: { type: "array", description: "已修复条目", items: SCHEMA_FixRecord },
    skipped: {
      type: "array",
      description: "未修条目如实申报（id + 具体原因）；确信设计文档自身有错的条目走这里（转 doc_errors 流回）",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
      },
    },
  },
  required: ["fixes", "skipped"],
};
// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  ReviewResult: SCHEMA_ReviewResult,
  FixReport: SCHEMA_FixReport,
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

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_MISSING_EXECPLAN = "恢复动作：重新 workflow run 发起并传 execPlan（--args execPlan=<路径>）；runs 一次性无续跑通道，修订脚本后重跑即可。";
const HINT_R1_FAILED = "读 run 日志定位失败分区，修订脚本后重发";

@@STITCH@@
