/* @pi-meta
name: wave-executor
description: >-
  dev-flow-wf W2 通用 DAG 调度引擎：读 exec-plan.json 启动校验后按依赖流式派发节点（≤5 并发），每节点确定性核验范围声明、工作区与测试后 commit 解锁后继，核验不过打回定向修（≤2 轮），verify/inspect 节点 failed 与 commit 门禁被拒入统一失败处理中心（失败池 → 聚合裁决 → 修复组 → 机器重验，≤3 轮不收敛按依赖可达性熔断），终态 completed、blocked 或 core-failed
when: >-
  dev-flow-wf 的 D1 开发循环与 D3 端到端验收发起本 workflow，传入 exec-plan.json 绝对路径（D0 编译产出），断点恢复按 status.json 人读恢复（git 为准）
phases: ['校验执行计划', '并行执行开发节点', '并行执行验收节点', '失败聚合裁决', '失败修复组并行', '收尾汇总']
parameters:
  type: object
  properties:
    execPlan:
      type: string
      description: exec-plan.json 绝对路径（D0 编译产出：nodes/依赖/范围声明/testCommand/promptFile/statusPath/commitTemplate/acceptance 分组）
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」"
    executionId:
      type: string
      description: "本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测 JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
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
// args：pi 的 $ARGS（--args k=v）由宿主以 `const args = $ARGS` 注入——产物重声明
// args 会炸 SyntaxError（曾因此 pi 侧首跑即崩），故就地归一化 $ARGS（宿主别名同指此对象）
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    $ARGS[k] = Number(v);
  }
}
// report / artifact：zcode 专有通道，pi 无对应面，降级为 no-op（结果仍经 return 交付）
const report = () => {};
const artifact = { chart: () => {}, board: () => {}, markdown: async () => {}, file: async () => {} };

// ===== zcode ask<T> 的 schema 常量（zcode 版由 harness 从 TS interface 合成，pi 显式传 JSON Schema）=====
// 映射自被 ask<...> 使用的 interface NodeResult；interface 的 JSDoc 字段注释 → schema 字段 description
const SCHEMA_NodeResult = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["done", "fail", "blocked"],
      description: "done = 本单元工作完成且自测通过；fail = 有未解决问题；blocked = 无法继续",
    },
    files_changed: { type: "array", items: { type: "string" }, description: "改动文件路径（相对节点工作区 git 仓库根的 git 风格路径，须 ⊆ 任务书范围声明）" },
    test_evidence: { type: "string", description: "自测证据：跑了什么命令、结果如何" },
    deviations: { type: "array", items: { type: "string" }, description: "与任务书的偏离说明（无偏离为空数组）" },
    blockers: { type: "array", items: { type: "string" }, description: "阻塞项（环境缺失/任务书矛盾等；非空则节点判 blocked，不进入打回）" },
    summary: { type: "string", description: "commit message {summary} 占位符的一句话摘要（缺省用固定短语）" },
  },
  required: ["status", "files_changed", "test_evidence", "deviations", "blockers"],
};

// zcAgent：zcode agent(name, persona).ask(prompt) 的 pi 等价——persona 拼 prompt 头
// （pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊——复用点靠 prompt 自包含，见转换检查）
// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_HealVerdict = {
  type: "object",
  properties: {
    class: {
      type: "string",
      enum: ["spec-bug", "product-bug", "environment"],
      description: "spec-bug=验收资产自身缺陷（可修复重验）/ product-bug=被测产品缺陷（不修，依赖判定）/ environment=超时资源类（重试一次）",
    },
    evidence: { type: "string", description: "一句话证据（引用失败输出原文）" },
    failureFiles: { type: "array", items: { type: "string" }, description: "归因指向的文件（spec-bug 时为验收资产文件；product-bug 时为产品文件——只读呈报不修复）" },
    fixHint: { type: "string", description: "spec-bug 修复要点（可空串）" },
  },
  required: ["class", "evidence", "failureFiles", "fixHint"],
};
const SCHEMA_HealFixReport = {
  type: "object",
  properties: {
    fixed: { type: "array", items: { type: "string" }, description: "实际修改的验收资产文件" },
    summary: { type: "string", description: "一句话修复说明" },
  },
  required: ["fixed", "summary"],
};
const SCHEMA_AcceptanceAggItem = {
  type: "object",
  properties: {
    id: { type: "string", description: "AF-<round>-<序>" },
    nodeIds: { type: "array", items: { type: "string" }, description: "覆盖的失败节点（fail-closed：失败池节点必须被恰好覆盖）" },
    title: { type: "string", description: "一句话标题" },
    action: { type: "string", enum: ["fix", "disputed"], description: "fix=真实缺陷进修复组；disputed=归因误报反证（不修，随终态呈报人工裁决）" },
    rootCause: { type: "string", description: "根因一句话（disputed 时即反证：file:line + 归因漏了什么）" },
    files: { type: "array", items: { type: "string" }, description: "预期改动文件（组间判交依据；fix 时非空）" },
    guidance: { type: "string", description: "修复指导（随 per-fixer 任务文档直达修复者）" },
  },
  required: ["id", "nodeIds", "title", "action", "rootCause", "files", "guidance"],
};
const SCHEMA_AcceptanceAggregation = {
  type: "object",
  properties: {
    items: { type: "array", items: SCHEMA_AcceptanceAggItem, description: "聚合条目（跨节点合并同根因）" },
    groups: {
      type: "array",
      description: "修复分组（组间文件不相交，组内一个修复者；无 fix 条目时为空）",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "AG-<序>" },
          itemIds: { type: "array", items: { type: "string" }, description: "组内 fix 条目 id（每条恰好属一组）" },
          note: { type: "string", description: "分组依据（可空串）" },
        },
        required: ["id", "itemIds", "note"],
      },
    },
  },
  required: ["items", "groups"],
};
const SCHEMA_AcceptanceFixReport = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      description: "实际修复的条目（无改动的条目走 disputed，不占 fixes）",
      items: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "聚合条目 id（AF-...）" },
          files: { type: "array", items: { type: "string" }, description: "实际改动文件（相对仓库根路径）" },
        },
        required: ["itemId", "files"],
      },
    },
    disputed: {
      type: "array",
      description: "误报反证（不修——人工裁决，对应节点保持 failed）",
      items: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "聚合条目 id" },
          evidence: { type: "string", description: "反证（file:line + 归因漏了什么；空泛证据=ES3 违规）" },
        },
        required: ["itemId", "evidence"],
      },
    },
    selfCheck: { type: "string", description: "自检（命令: 结果）" },
  },
  required: ["fixes", "disputed", "selfCheck"],
};
const SCHEMA_InspectResult = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail", "degraded"],
      description: "验收结论：pass = 通过标准全部达成；fail = 有未达成项；degraded = 场景不可构造但替代构造已证判定成立（任务书契约词表，勿用 status 字段）",
    },
    test_evidence: { type: "string", description: "验收证据：逐条核对结果与关键观测" },
    deviations: { type: "array", items: { type: "string" }, description: "与任务书的偏离说明（无偏离为空数组）" },
    blockers: { type: "array", items: { type: "string" }, description: "阻塞项（非空则节点判 blocked，不进入打回）" },
  },
  required: ["verdict", "test_evidence", "deviations", "blockers"],
};
const SCHEMA_BY_KEY = {
  NodeResult: SCHEMA_NodeResult,
  InspectResult: SCHEMA_InspectResult,
  HealVerdict: SCHEMA_HealVerdict,
  HealFixReport: SCHEMA_HealFixReport,
  AcceptanceAggregation: SCHEMA_AcceptanceAggregation,
  AcceptanceFixReport: SCHEMA_AcceptanceFixReport,
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

// ── F 区平台钩子：pi 无续聊，打回 prompt 拼入首轮指令与上次返回结果使其自包含 ──
function withPrevContext(initialPrompt, lastResult, retryPrompt) {
  return `【前情】此前任务指令：\n${initialPrompt}\n\n上次返回结果：\n${JSON.stringify(lastResult)}\n\n` + retryPrompt;
}

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
