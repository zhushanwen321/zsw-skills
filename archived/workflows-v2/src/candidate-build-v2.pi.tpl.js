/* @pi-meta
name: candidate-build-v2
description: >-
  delivery-v2 技能 BUILD 段候选实现引擎：前置 evaluate 拒绝 state=draft；已实现增量
  按 acceptanceVersion 判定，仅命中未决发现/失败证据的增量进入修复轮；每增量 builder
  只 ask 一次（实现并写实现报告），脚本执行 testCommand、把测试摘要追加进报告并以
  append --credential 追加事件；基础设施失败不登记 FindingRaised，build-failed
  前重新 evaluate。builder 不改契约/事件/verdict、不做 Git 写操作
when: >-
  delivery-v2 技能候选实现段——契约已获用户批准（state 非 draft）、需要形成候选
  实现或修复增量，必传 projectRoot / taskDir / builderCredentialId（builder 角色
  专用，不接收 user/assurance 等其他角色凭据）
notFor: >-
  契约设计（acceptance-design-v2）、覆盖核对与探索审查（independent-assurance-v2）、
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
      description: "builder 角色凭据 id（init 输出，形态 <分组>/<任务id>/builder）——append --credential 以 builder 身份签名追加实现与发现事件。只接收本角色凭据 id——user/assurance 凭据不得注入；凭据私钥本体不进参数与 prompt"
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）"
    executionId:
      type: string
      description: "本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
  required: [projectRoot, taskDir, builderCredentialId]
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

// builder（builder.md 角色）结构化返回：实现摘要与新发现（不分配 findingId，由引擎
// 统一生成；不申报 verified——builder 的测试输出不是 verified 证据）
const SCHEMA_BuilderOutcome = {
  type: "object",
  properties: {
    summary: { type: "string", description: "实际改动、自测命令与退出码、残余问题的证据摘要" },
    findings: {
      type: "array",
      description: "新发现清单（无则空数组；findingId 由引擎统一分配，不在此申报）",
      items: {
        type: "object",
        properties: {
          summary: { type: "string", description: "缺陷现象与影响" },
          requirementIds: { type: "array", items: { type: "string" }, description: "关联契约条目 id；契约外发现为空数组" },
          severity: { type: "string", enum: ["blocker", "non-blocker"], description: "blocker = 阻断该增量完成；non-blocker = 可继续" },
        },
        required: ["summary", "requirementIds", "severity"],
      },
    },
  },
  required: ["summary", "findings"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  BuilderOutcome: SCHEMA_BuilderOutcome,
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
