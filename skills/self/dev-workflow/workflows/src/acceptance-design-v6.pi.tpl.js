/* @pi-meta
name: acceptance-design-v6
description: >-
  delivery-v6 技能 DESIGN 段产品契约设计循环：setup 先跑外部契约候选探测
  （detect-external-contracts，stdout 落盘按验收版本隔离的候选快照并计算
  detectionSha256）与策略快照固定；designer 按候选快照填 externalContractReview
  处置表并声明 externalContracts 与契约冒烟增量，产契约/解决方案/增量草稿；草稿过
  版本门后跑 authority resolve 落环境权威快照（essential 契约未 resolved 即停回）；
  contract reviewer 独立复查目标降级、可证伪性、证据类型、风险级别、增量划分与外部
  契约守门（候选低报/能力遗漏/mock-only/riskCoverage 十类/契约反例最低记录）；机器
  校验通过才 contract-ready；AcceptanceApproved 留给主会话在用户批准后追加
  （approve-acceptance 带 --authority-snapshot-sha256）
  agent 调用结构校验与修正重问、CLI spawn 级失败重试（只读/幂等命令）、自修复
  记录（taskDir/self-repairs.jsonl）随终态 message 上报主 agent（DEV 韧性层）
when: >-
  delivery-v6 技能契约设计段——任务目录已由 delivery-gate init 创建、需要把用户原始意图
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

// contract reviewer（contract-reviewer.md 角色）结构化返回：独立审查问题清单 + 反例实现检查记录
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
    // 反例实现检查记录（V5 完整性设计 §5.1 判别力检查；无强反例也须返回空数组）
    counterImplementations: {
      type: "array",
      description: "每条核心目标的反例实现检查记录（wouldPassCurrentCriteria=true 是独立打回理由；essential 契约的 mock 替代反例须带 contractId）",
      items: {
        type: "object",
        properties: {
          obligationId: { type: "string", description: "被检查的核心目标（需求/断言 id）" },
          counterImplementation: { type: "string", description: "反例实现：明显不符合用户目标却可能通过当前全部断言的实现形态" },
          violatesIntent: { type: "string", description: "为什么违反用户意图（对照 intent 原文）" },
          discriminatingScenarioRef: { type: "string", description: "能区分正误实现的场景或测试资产引用（契约反例须指向契约冒烟 negative case id）" },
          wouldPassCurrentCriteria: { type: "boolean", description: "true = 该反例能通过当前判据（判别力不足）" },
          contractId: { type: "string", description: "该反例针对的外部契约 id（essential 契约的「mock 替代真实宿主」反例必填；非契约反例缺省）" },
        },
        required: ["obligationId", "counterImplementation", "violatesIntent", "discriminatingScenarioRef", "wouldPassCurrentCriteria"],
      },
    },
    // 语义风险清单（V6 运行可用性设计 §5.4：十类逐类三值，不得静默略过未回答类别）
    riskCoverage: {
      type: "array",
      description: "十类语义风险逐类处置（blocking/injection-cost/identity-alias/control-state/concurrent-rewrite/failure-modes/recovery/observability/input-validation/contract-single-source）",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "风险类别 id（十类词表之一）",
            enum: ["blocking", "injection-cost", "identity-alias", "control-state", "concurrent-rewrite", "failure-modes", "recovery", "observability", "input-validation", "contract-single-source"],
          },
          state: {
            type: "string",
            description: "covered = 指向断言/反例/测试资产；not-applicable = 给理由；needs-criteria = 缺判据打回",
            enum: ["covered", "not-applicable", "needs-criteria"],
          },
          detail: { type: "string", description: "covered：指向的断言/反例/测试资产引用；not-applicable / needs-criteria：理由或缺失判据说明" },
        },
        required: ["category", "state", "detail"],
      },
    },
    // 契约判别力显式申报（V6 运行可用性设计 §5.3：完全无反例时须为 none-possible 并给理由）
    contractDiscrimination: {
      type: "string",
      description: "完全无反例时的显式申报（仅允许 none-possible；essential 契约无 mock 替代反例时必填）",
      enum: ["none-possible"],
    },
    contractDiscriminationRationale: {
      type: "string",
      description: "contractDiscrimination=none-possible 的理由（为什么权威工件与能力观察让该反例不可构造）",
    },
  },
  required: ["summary", "problems", "counterImplementations", "riskCoverage"],
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
