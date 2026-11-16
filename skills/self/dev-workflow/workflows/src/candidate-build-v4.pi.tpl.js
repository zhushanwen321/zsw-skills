/* @pi-meta
name: candidate-build-v4
description: >-
  delivery-v4 技能 BUILD 段候选实现引擎：前置 evaluate 拒绝 state=draft；已实现增量
  按 acceptanceVersion 判定，仅命中未决发现/失败证据的增量进入修复轮；每增量 builder
  只 ask 一次（实现并写实现报告），脚本执行 testCommand、把测试摘要追加进报告并以
  append --credential 追加事件；基础设施失败不登记 FindingRaised，build-failed
  前重新 evaluate。builder 不改契约/事件/verdict、不做 Git 写操作
  agent 调用结构校验与修正重问、CLI spawn 级失败重试（只读/幂等命令）、自修复
  记录（taskDir/self-repairs.jsonl）随终态 message 上报主 agent（DEV 韧性层）
when: >-
  delivery-v4 技能候选实现段——契约已获用户批准（state 非 draft）、需要形成候选
  实现或修复增量，必传 projectRoot / taskDir / builderCredentialId /
  assuranceCredentialId（builder 与 assurance 凭据分离，user 凭据不接收）
notFor: >-
  契约设计（acceptance-design-v4）、覆盖核对与探索审查（independent-assurance-v4）、
  用户风险接受（主会话 delivery-gate accept-risk）
phases: ['逐增量形成候选实现']
parameters:
  type: object
  properties:
    projectRoot:
      type: string
      description: "项目根绝对路径（builder 改产品代码与测试的工作目录；testCommand 的执行 cwd）"
    taskDir:
      type: string
      description: "任务目录绝对路径（delivery-gate init 创建；读契约/增量/事件/verdict，写实现报告与测试日志）"
    builderCredentialId:
      type: string
      description: "builder 角色凭据 id（init 输出，形态 <分组>/<任务id>/builder）——append --credential 以 builder 身份签名追加实现与发现事件；凭据私钥本体不进参数与 prompt"
    assuranceCredentialId:
      type: string
      description: "assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——候选反例审查与探索事件只能由 assurance 签署；凭据私钥本体不进参数与 prompt"
    runId:
      type: string
      description: "可选写事务租约 run id（acquire/heartbeat/release 全程配对）"
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）"
    executionId:
      type: string
      description: "本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
  required: [projectRoot, taskDir, builderCredentialId, assuranceCredentialId]
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
// 变成 number，违反 shared 的「objective 须为字符串」校验。匹配用正则字面量而非
// 字符串字面量——双平台对账的业务串差集不含正则字面量内的文本
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

// FindingDraft（builder 侧发现申报）——BuilderOutcome/ExplorationOutcome 的 findings
// 条目一律复用本常量，不内联副本（内联副本会与 FindingDraft 契约分叉漏字段——pi 平台
// schema 校验按本常量执行，漏字段会让合法返回被结构化校验拒收）
const SCHEMA_FindingDraft = {
  type: "object",
  properties: {
    summary: { type: "string", description: "缺陷现象与影响" },
    requirementIds: { type: "array", items: { type: "string" }, description: "关联契约条目 id；契约外发现为空数组" },
    severity: { type: "string", enum: ["blocker", "non-blocker"], description: "blocker = 阻断该增量完成；non-blocker = 可继续" },
    category: { type: "string", enum: ["defect", "boundary"], description: "defect=违反判据；boundary=设计边界申报（争议按 defect）" },
    consequenceRefutation: { type: "string", description: "非 blocker 必填：否定其用户可观察后果的依据；禁止只按字面合规降级" },
    consequenceRefutationType: { type: "string", enum: ["will-not-occur", "not-observable", "accepted-by-acceptance"], description: "非 blocker 必填：论证类型三择一（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许），先标类型再给依据" },
    origin: { type: "string", enum: ["acceptance", "design", "planning", "implementation", "testing", "evidence", "environment"], description: "来源阶段" },
    expectedStage: { type: "string", description: "该问题本应在哪个阶段被拦截" },
    regressionTestRef: { type: "string", description: "回归测试标识" },
  },
  required: ["summary", "requirementIds", "severity"],
};

// builder（builder.md 角色）结构化返回：实现摘要与新发现（不分配 findingId，由引擎
// 统一生成；不申报 verified——builder 的测试输出不是 verified 证据）
const SCHEMA_BuilderOutcome = {
  type: "object",
  properties: {
    summary: { type: "string", description: "实际改动、自测命令与退出码、残余问题的证据摘要" },
    findings: {
      type: "array",
      description: "新发现清单（无则空数组；findingId 由引擎统一分配，不在此申报）",
      items: SCHEMA_FindingDraft,
    },
  },
  required: ["summary", "findings"],
};

const SCHEMA_ExplorationOutcome = {
  type: "object",
  properties: {
    summary: { type: "string" },
    dimensions: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: SCHEMA_FindingDraft,
    },
  },
  required: ["summary", "dimensions", "findings"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  BuilderOutcome: SCHEMA_BuilderOutcome,
  ExplorationOutcome: SCHEMA_ExplorationOutcome,
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
