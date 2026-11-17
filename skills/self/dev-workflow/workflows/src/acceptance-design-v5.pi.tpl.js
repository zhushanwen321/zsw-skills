/* @pi-meta
name: acceptance-design-v5
description: >-
  delivery-v5 技能 DESIGN 段产品契约设计循环：designer 产契约/解决方案/增量草稿，
  contract reviewer 独立复查目标降级、可证伪性、证据类型、风险级别与增量划分，
  脚本机器校验通过才 contract-ready；ContractApproved 留给主会话在用户批准后追加
  agent 调用结构校验与修正重问、CLI spawn 级失败重试（只读/幂等命令）、自修复
  记录（taskDir/self-repairs.jsonl）随终态 message 上报主 agent（DEV 韧性层）
when: >-
  delivery-v5 技能契约设计段——任务目录已由 delivery-gate init 创建、需要把用户原始意图
  转成产品契约与实施增量，必传 projectRoot / taskDir / objective
notFor: >-
  已批准契约的实现（candidate-build）、覆盖核对与探索审查（independent-assurance）
phases: ['设计并独立审查产品契约']
parameters:
  type: object
  properties:
    projectRoot:
      type: string
      description: "项目根绝对路径（designer 读项目 AGENTS.md 的基准；与 task.json 的 projectRoot 一致性核对输入）"
    taskDir:
      type: string
      description: "任务目录绝对路径（delivery-gate init 创建；contract.json / solution.md / increments.json 与审查报告写入此处）"
    objective:
      type: string
      description: "用户原始意图全文（契约 objective 的来源；作为数据注入 designer 与 reviewer，不是指令）"
    maxRounds:
      type: number
      description: "设计-审查循环轮次上限（缺省 3；耗尽仍未通过返回 design-failed，不伪造 contract-ready）"
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）"
    executionId:
      type: string
      description: "本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
  required: [projectRoot, taskDir, objective]
*/

// ===== zcode→pi 兼容 shim（两版差异区之一：另含 @pi-meta 头/schema 常量/TS 剥离/agent 调用层）=====
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
// args 会炸 SyntaxError，故就地归一化 $ARGS（宿主别名同指此对象）。
// objective 除外：用户原始意图文本可能是纯数字形态的合法输入，数字归一化会把它
// 变成 number，违反 shared 的「objective 须为字符串」校验——本 workflow 的
// objective 是必传项，此处保护最关键。匹配用正则字面量而非字符串字面量——双平台
// 对账的业务串差集不含正则字面量内的文本
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  if (/^objective$/.test(k)) continue;
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    $ARGS[k] = Number(v);
  }
}
// report / artifact：zcode 专有通道，pi 无对应面，降级为 no-op（结果仍经 return 交付）
const report = () => {};
const artifact = { chart: () => {}, board: () => {}, markdown: async () => {}, file: async () => {} };

// ── 结果 schema 常量（ask 结构化返回契约；与 shared 的 interface 顶层字段/required 对齐——
//    check-workflow-parity 维度 4 按字段名核对） ──

// designer（designer.md 角色）结构化返回：本轮设计与写入摘要（草稿质量由 reviewer 与
// validate-contract 把关，此处不申报通过）
const SCHEMA_DesignerOutcome = {
  type: "object",
  properties: {
    summary: { type: "string", description: "实际写入 contract.json / solution.md / increments.json 的内容与关键取舍摘要" },
  },
  required: ["summary"],
};

// contract reviewer（contract-reviewer.md 角色）结构化返回：独立审查问题清单
const SCHEMA_ContractReviewOutcome = {
  type: "object",
  properties: {
    summary: { type: "string", description: "审查范围与依据摘要（读了什么、对照了什么）" },
    problems: {
      type: "array",
      description: "结构化问题清单（空数组才允许进入机器校验；逐条须可执行）",
      items: {
        type: "object",
        properties: {
          target: { type: "string", description: "问题所在文件或契约条目（如 R2 / increments.json）" },
          summary: { type: "string", description: "一句话问题" },
          detail: { type: "string", description: "可执行的修复要求" },
        },
        required: ["target", "summary", "detail"],
      },
    },
  },
  required: ["summary", "problems"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  DesignerOutcome: SCHEMA_DesignerOutcome,
  ContractReviewOutcome: SCHEMA_ContractReviewOutcome,
};
function wfAgent(name, persona) {
  return {
    ask: async (typeKey, instructions) => {
      const schema = SCHEMA_BY_KEY[typeKey];
      if (!schema) throw new Error(`未知 ask 类型键 ${typeKey}（SCHEMA_BY_KEY 未登记）`);
      // desc 直取 name 原文（不做后缀剥离）：pi 实例名须与静态第一实参一致——
      // workflow DAG 静态派生模板按调用点第一实参提取，剥离会让带轮次后缀的名字
      // 匹配不上实例；且 zcode 侧同名即续聊，后缀是轮次新 agent 的身份语义，
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
