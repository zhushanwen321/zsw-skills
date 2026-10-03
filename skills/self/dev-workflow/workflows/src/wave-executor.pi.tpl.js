/* @pi-meta
name: wave-executor
description: >-
  dev-flow-wf W2 通用 DAG 调度引擎：读 exec-plan.json 启动校验后按依赖流式派发节点（≤5 并发），每节点确定性核验领地、工作区与测试后 commit 解锁后继，核验不过打回定向修（≤2 轮），acceptance 模式承载 verify/inspect 节点与核心组熔断，终态 completed、blocked 或 core-failed
when: >-
  dev-flow-wf 的 D1 开发循环与 D3 端到端验收发起本 workflow，传入 exec-plan.json 绝对路径（D0 编译产出），断点恢复按 status.json 人读恢复（git 为准）
phases: ['校验执行计划', '并行执行开发节点', '并行执行验收节点', '收尾汇总']
parameters:
  type: object
  properties:
    execPlan:
      type: string
      description: exec-plan.json 绝对路径（D0 编译产出：nodes/依赖/领地/testCommand/promptFile/statusPath/commitTemplate/acceptance 分组）
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
    files_changed: { type: "array", items: { type: "string" }, description: "改动文件路径（相对节点工作区 git 仓库根的 git 风格路径，须 ⊆ 任务书领地）" },
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
const SCHEMA_BY_KEY = {
  NodeResult: SCHEMA_NodeResult,
  HealVerdict: SCHEMA_HealVerdict,
  HealFixReport: SCHEMA_HealFixReport,
};
function wfAgent(name, persona) {
  return {
    ask: async (typeKey, instructions) => {
      const schema = SCHEMA_BY_KEY[typeKey];
      if (!schema) throw new Error(`未知 ask 类型键 ${typeKey}（SCHEMA_BY_KEY 未登记）`);
      // desc 直取 name 原文（不做 -rN/-RN 后缀剥离）：pi 实例名须与静态第一实参一致——
      // workflow DAG 静态投影模板按调用点第一实参提取，剥离会让带轮次后缀的名字
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

@@STITCH@@
