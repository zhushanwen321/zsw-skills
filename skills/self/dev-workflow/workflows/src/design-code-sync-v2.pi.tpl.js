/* @pi-meta
name: design-code-sync-v2
description: >-
  dev-flow-v1 技能 W4 v2 一致性对账引擎：设计义务表 → checker 派发（机械优先/语义缓存）→
  差距地址聚合 → sandbox 隔离变更集 → 集成器唯一写入门径 → 四层结论；状态唯一权威 =
  conformance-state 事件流，agent 无状态。带 cutover 标记的包旧引擎拒启、由本引擎管辖
when: >-
  dev-flow-v1 技能 D5 终态同步段——设计包已具备 conformance 绑定（章节 JSON §9b）时的义务对账，
  必传 designPkg / projectRoot / declaredRepos
notFor: >-
  未做 conformance 绑定的 legacy 包收尾（用 design-code-sync-loop 旧引擎只读期形态）
phases: ['装载义务表与对账平面', '义务检查与修复集成']
parameters:
  type: object
  properties:
    designPkg:
      type: string
      description: "设计包目录绝对路径（含 meta.json / s1-context.json … s5-breakdown.json——义务提取数据源；tech-design 段 <name>/）"
    projectRoot:
      type: string
      description: "目标项目根绝对路径（workspace 清单扫描基准 + evidenceInputs 相对路径基准）"
    declaredRepos:
      type: string
      description: "workspace 登记清单 JSON（数组 [{repoId, path, editableRoot?}]）——传参即主 agent 确认（M4 形态）；绑定 repoId 必须全部在确认清单内（AX9）"
    confirmedRepoIds:
      type: string
      description: "已确认 repoId 集 JSON（数组；缺省 = 提案全部确认）"
    sandboxRoot:
      type: string
      description: "sandbox 子段根绝对路径（缺省 = dev-flow 段产物根/sandbox）"
    stateRoot:
      type: string
      description: "conformance-state 状态仓根绝对路径（缺省 = tech-design 段 <name>/conformance-state）；续跑 = 同根重发"
    confRoot:
      type: string
      description: "conformance-plane 模块根绝对路径（缺省 <projectRoot>/skills/self/dev-workflow/conformance-plane——仓库内模块直读）"
    reviewerTemplate:
      type: string
      description: "语义检查 agent 模板路径（默认 ~/.agents/skills/dev-flow-v1/agents/conformance-reviewer.md）"
    fixerTemplate:
      type: string
      description: "补丁生成 agent 模板路径（默认 ~/.agents/skills/dev-flow-v1/agents/changeset-fixer.md）"
    maxRounds:
      type: number
      description: "对账轮次上限（缺省 8；耗尽仍有 open = engineOutcome stopped）"
    rulingsFile:
      type: string
      description: "用户裁决记录 json 绝对路径（续跑通道；元素 {address, direction: code-right|doc-right|waived, respondsTo}）"
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）"
    executionId:
      type: string
      description: "本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
  required: [designPkg, projectRoot, declaredRepos]
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
// args 会炸 SyntaxError，故就地归一化 $ARGS（宿主别名同指此对象）
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    $ARGS[k] = Number(v);
  }
}
// report / artifact：zcode 专有通道，pi 无对应面，降级为 no-op（结果仍经 return 交付）
const report = () => {};
const artifact = { chart: () => {}, board: () => {}, markdown: async () => {}, file: async () => {} };

// ── 结果 schema 常量（ask 结构化返回契约；与 shared 的 interface 顶层字段/required 对齐——
//    check-workflow-parity 维度 4 按字段名核对） ──

// 语义 checker（conformance-review 模板）结构化返回：只产观察判断，不产身份与状态
const SCHEMA_ReviewVerdict = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["pass", "fail"], description: "pass = 义务在当前内容上成立；fail = 存在差距（差距地址由引擎按绑定派生）" },
    summary: { type: "string", description: "一句话判断依据（读了什么、确认了什么）" },
    observations: { type: "array", items: { type: "string" }, description: "非义务观察（映射不到当前覆盖率分母的差距候选）——引擎转 backlog 提案，无则 []" },
  },
  required: ["result", "summary", "observations"],
};

// 补丁生成 agent（changeset-fixer 模板）结构化返回：sandbox 工作树编辑申报 或 文档提案
const SCHEMA_FixerPlan = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      description: "逐义务修复申报（bindingId 原样引用注入清单——引擎按绑定对账，agent 不产地址）",
      items: {
        type: "object",
        properties: {
          bindingId: { type: "string", description: "义务绑定 id（原样引用）" },
          description: { type: "string", description: "一句修复描述" },
        },
        required: ["bindingId", "description"],
      },
    },
    affectedFiles: { type: "array", items: { type: "string" }, description: "sandbox 内实际改动文件（相对 sandbox 根路径；文档提案通道恒 []）" },
    deferred: {
      type: "array",
      description: "越权候选 defer 申报（删码类修复只申报不执行，呈报用户裁决）；无申报显式 []",
      items: {
        type: "object",
        properties: {
          bindingId: { type: "string", description: "义务绑定 id（原样引用）" },
          reason: { type: "string", description: "候选卡论证" },
        },
        required: ["bindingId", "reason"],
      },
    },
    docProposal: {
      type: "object",
      description: "文档侧通道（documentation-mismatch 类义务）：结构化提案对象，不落正式仓；代码侧修复不带此字段",
      properties: {
        sectionFile: { type: "string", description: "章节文件名（s3-solution.json 等）" },
        jsonPointer: { type: "string", description: "RFC 6901 JSON 指针（条目内指向被提议字段）" },
        proposedValue: { type: "string", description: "提议新值（结构化值的 JSON 形态）" },
        expectedCurrentValue: { type: "string", description: "提案基线当前值（引擎对账，漂移即拒绝应用）" },
        reason: { type: "string", description: "提案理由（裁决 question 载体）" },
      },
      required: ["sectionFile", "jsonPointer", "proposedValue", "reason"],
    },
  },
  required: ["fixes", "affectedFiles", "deferred"],
};

// zcAgent：zcode agent(name, persona).ask(prompt) 的 pi 等价——persona 拼 prompt 头
// （pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊——复用点靠 prompt 自包含）
// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  ReviewVerdict: SCHEMA_ReviewVerdict,
  FixerPlan: SCHEMA_FixerPlan,
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

// ── G 区平台恢复指引（机制词 pi 语境化；措辞沿 W4 旧引擎同款——parity 白名单已登记同文） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后重新 workflow run 发起（pi runs 一次性：修订脚本后重跑即可，防产物覆盖用 attempt 递增）";

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
