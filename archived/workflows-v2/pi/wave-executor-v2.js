/* @pi-meta
name: wave-executor-v2
description: >-
  dev-flow-v2 W2 通用 DAG 调度引擎：读 exec-plan.json 启动校验后按依赖流式派发节点（≤5 并发），每节点确定性核验范围声明、工作区与测试后 commit 解锁后继，核验不过打回定向修（≤2 轮），verify/inspect 节点 failed 与 commit 门禁被拒入统一失败处理中心（失败池 → 聚合裁决 → 修复组 → 机器重验，≤3 轮不收敛按依赖可达性熔断），终态 completed、blocked 或 core-failed
when: >-
  dev-flow-v2 的 D1 开发循环与 D3 端到端验收发起本 workflow，传入 exec-plan.json 绝对路径（D0 编译产出），断点恢复按 status.json 人读恢复（git 为准）
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

// ============================================================================
// provenance.shared.ts — saved 副本启动校验层（单一构建输入）
// 构建器把本文件拼在观测层与业务正文之前，随产物部署；文件尾的顶层 await 即校验
// 入口——zcode 产物发起即执行，无从跳过。pi 产物拼入函数但不调用（构建器剥除调用
// 行）：pi 侧无 ~/.zcode saved 部署目录，无从校验，保留函数使两侧业务字符串同源。
//
// 机制：构建器写 saved 副本（~/.zcode/workflows/<name>.dwf.ts）时同步写来源登记
// 文件（<name>.manifest.json，记录生成该副本的仓检出根与仓内产物相对路径——本机
// 绝对路径是运行时反查检出根的唯一来源，属机器本地功能数据，不入仓）。启动时读
// 登记文件并逐字节比对 saved 副本与仓内产物：不一致 = 副本被仓外直接编辑或仓内
// 产物被手改（都意味着本次执行的脚本不是构建器产出的那一版），抛错终止，消息含
// 恢复动作；登记文件 / saved 副本 / 检出根任一缺失 = WARN 放行（本机无该仓检出时
// 不硬拦发起，降级可见）。
// 刻意只比「副本 vs 仓内产物」、不含 src/ 源：源的在途未构建改动归 pre-commit 的
// build --check 管辖，混进启动校验会误拦正常发起——误拦会逼出绕行，校验就废了。
// ============================================================================
const PROV_WF_NAME = "wave-executor-v2";
const PROV_PROBE = "try{" +
    "var fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');" +
    "var dir=path.join(os.homedir(),'.zcode','workflows');" +
    "var mf=path.join(dir,process.argv[1]+'.manifest.json');" +
    "var sp=path.join(dir,process.argv[1]+'.dwf.ts');" +
    "var out=function(o){process.stdout.write(JSON.stringify(o))};" +
    "var raw;try{raw=fs.readFileSync(mf,'utf8')}catch(e){out({skip:'no-manifest'});return}" +
    "var m;try{m=JSON.parse(raw)}catch(e){out({skip:'no-manifest',reason:'unparsable'});return}" +
    "if(!m||typeof m.sourceRoot!=='string'||m.sourceRoot.charAt(0)!=='/'||typeof m.productRelPath!=='string'||m.productRelPath.indexOf('..')>=0){out({skip:'no-manifest',reason:'fields'});return}" +
    "var pp=path.join(m.sourceRoot,m.productRelPath);" +
    "var a,b;try{a=fs.readFileSync(sp)}catch(e){out({skip:'no-saved'});return}" +
    "try{b=fs.readFileSync(pp)}catch(e){out({skip:'no-repo',product:pp});return}" +
    "var h=function(x){return crypto.createHash('sha256').update(x).digest('hex').slice(0,12)};" +
    "out({ok:a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)),savedH:h(a),productH:h(b)});" +
    "}catch(e){process.stdout.write(JSON.stringify({skip:'probe-error',reason:String(e&&e.message||e)}))}";
/** saved 副本启动校验（机制见文件头注）：读来源登记文件并逐字节比对 saved 副本与
 *  仓内产物；不一致抛错终止（恢复动作在消息内），登记文件/副本/检出根缺失 WARN 放行 */
async function provenanceCheck() {
    const r = await world.run("node", ["-e", PROV_PROBE, PROV_WF_NAME]);
    let v;
    try {
        v = JSON.parse(r.stdout.trim());
    }
    catch {
        log(`WARN: 启动校验探针输出不可解析（exit ${r.exitCode}：${(r.stderr !== "" ? r.stderr : r.stdout).trim().slice(0, 200)}）——跳过本次启动校验`);
        return;
    }
    if (v.skip !== undefined) {
        const detail = v.reason !== undefined ? `（${v.reason}）` : "";
        log(`WARN: 来源登记文件或检出根缺失（${v.skip}${detail}）——跳过启动校验，本次发起未验证部署副本一致性`);
        return;
    }
    if (v.ok === true) {
        log(`启动校验通过：saved 副本与仓内产物一致（${PROV_WF_NAME}）`);
        return;
    }
    throw new Error(`saved 副本漂移：${PROV_WF_NAME} 的部署副本与仓内产物不一致（副本 sha256 前 12 位 ${v.savedH}，仓内产物 ${v.productH}）——副本被仓外直接编辑或仓内产物被手改，本次发起的不是构建器产出版本。恢复动作：在仓检出根跑 node scripts/build-workflows.mjs 重建并同步三处产物后重新发起；修订续跑配方与禁止直改副本见 workflow-authoring 第 4 节`);
}
let obsCtx = null;
/** ID 路径安全窄化：task-id 是观测根下的目录名、execution-id 是文件名主干——仅放行
 *  字母数字开头、只含字母/数字/点/连字符/下划线、≤128 字符、无连续点与结尾点的值，
 *  路径穿越形态（..、分隔符、空白、引号）一律拒绝 */
function obsSafeId(v) {
    if (typeof v !== "string")
        return null;
    const s = v.trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..") && !s.endsWith(".") ? s : null;
}
/** 观测启用（形态层，纯同步，不依赖 home）：参数形态校验 + 上下文组装。先于业务参数
 *  窄化调用，保证已传合法观测 ID 的执行（含后续参数校验失败早退）都有 execution 边界。
 *  返回 null = 本次关闭（合法关闭不告警，告警关闭经 log 输出恢复动作——关闭本身不静默）。
 *  attempt 未知时传 null，检测确定后回填 obsCtx.attempt */
function initObservation(skill, stage, attempt) {
    const hasTask = typeof args.taskId === "string" && args.taskId.trim() !== "";
    const hasExec = typeof args.executionId === "string" && args.executionId.trim() !== "";
    if (!hasTask && !hasExec)
        return null;
    if (hasTask !== hasExec) {
        log(`WARN: 观测参数不完整（taskId=${hasTask ? "已传" : "缺"}、executionId=${hasExec ? "已传" : "缺"}）——两参须同时提供才记录观测，本次不写观测事件。恢复动作：同时传 taskId 与 executionId，或都不传`);
        return null;
    }
    const taskId = obsSafeId(args.taskId);
    const executionId = obsSafeId(args.executionId);
    if (taskId === null || executionId === null) {
        log(`WARN: 观测参数含路径不安全字符（taskId=${JSON.stringify(args.taskId)}、executionId=${JSON.stringify(args.executionId)}——合法形态：字母/数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」与结尾点）——本次不写观测事件。恢复动作：改用安全 ID 后重新发起`);
        return null;
    }
    const rawSampleType = typeof args.sampleType === "string" ? args.sampleType.trim() : "";
    if (rawSampleType !== "" && rawSampleType !== "production" && rawSampleType !== "selftest") {
        log(`WARN: 观测参数 sampleType=${JSON.stringify(args.sampleType)} 非法（合法值：production / selftest）——本次不写观测事件。恢复动作：修正 sampleType 后重新发起`);
        return null;
    }
    const sampleType = rawSampleType === "selftest" ? "selftest" : "production";
    return {
        executionId,
        taskId,
        skill,
        stage,
        attempt,
        sampleType,
        filePath: "",
        openStep: null,
        warnedWrite: false,
    };
}
/** 观测落盘路径装配（home 探针成功后调用一次）；obsCtx 关闭时无操作 */
function obsAttachHome(home) {
    const c = obsCtx;
    if (c === null)
        return;
    c.filePath = `${home}/.agents/skill-data/workflow-observability/${c.taskId}/${c.executionId}.jsonl`;
}
/** 写一条观测事件。时间戳经壳钩子取（zcode journal 语义下跨 resume 确定性回放）；
 *  时间戳探针失败、落盘路径未装配（home 未就绪）或写入失败只告警（写失败同文件一次），
 *  不改变业务终态 */
async function obsEmit(step, round, event, outcome) {
    const c = obsCtx;
    if (c === null)
        return;
    if (c.filePath === "") {
        log("WARN: 观测落盘路径未装配（home 探针未完成或失败）——本条观测事件未记录，业务不受影响。恢复动作：确认 node 可执行后重跑");
        return;
    }
    const timestamp = await obsNow();
    if (timestamp === null) {
        log("WARN: 观测时间戳探针失败（node 子进程无输出）——本条观测事件未记录，业务不受影响。恢复动作：确认 node 可执行后重跑");
        return;
    }
    const rec = {
        execution_id: c.executionId,
        task_id: c.taskId,
        skill: c.skill,
        stage: c.stage,
        step,
        round,
        attempt: c.attempt,
        event,
        timestamp,
        sample_type: c.sampleType,
        skill_version: SKILL_VERSION,
    };
    if (outcome !== null)
        rec.outcome = outcome;
    const err = await obsAppend(c.filePath, JSON.stringify(rec));
    if (err !== null && !c.warnedWrite) {
        c.warnedWrite = true;
        log(`WARN: 观测事件写入失败（${c.filePath}）：${err}——同类失败不再重复告警，业务不受影响。恢复动作：确认该路径父目录可写（或换 executionId）后重跑`);
    }
}
/** 阶段边界：串行阶段开始记 start（同一时刻至多一个打开 step）。上一阶段尚未结束即
 *  开新阶段 = 观测序列异常：显式告警并给前一阶段补记 end（outcome=abandoned），不静默
 *  覆盖——业务流程不受影响，事件序列仍完整可对账 */
async function obsBegin(step, round) {
    const c = obsCtx;
    if (c === null)
        return;
    if (c.openStep !== null) {
        const prev = c.openStep;
        c.openStep = null;
        log(`WARN: 观测阶段重叠：step「${prev.step}」尚未结束即开始「${step}」——已给前一阶段补记 end（outcome=abandoned），业务不受影响。恢复动作：检查前一阶段的 obsEnd 配对（提前离开的路径是否漏补记）`);
        await obsEmit(prev.step, prev.round, "end", "abandoned");
    }
    c.openStep = { step, round };
    await obsEmit(step, round, "start", null);
}
/** 阶段边界：自然完成记 end（无 outcome——outcome 只出现在终态统一补记或异常补记的
 *  end 上，值 = 本次执行的 terminated 词或 abandoned/script-error）。
 *  配对检查：step/round 与打开阶段不符，或当前无打开阶段时——显式告警（可操作恢复
 *  动作）；无打开阶段不写任何事件（无 start 不伪造 end），阶段错位给实际打开阶段补
 *  abandoned end（收到的错名 end 不落盘）。业务流程不受影响 */
async function obsEnd(step, round) {
    const c = obsCtx;
    if (c === null)
        return;
    if (c.openStep === null) {
        log(`WARN: 观测配对异常：收到 step「${step}」（round=${round}）的 obsEnd，但当前无打开中的阶段——未写 end 事件（无 start 不伪造 end），业务不受影响。恢复动作：检查该 step 的 obsBegin/obsEnd 配对（是否重复调用或 start 路径提前离开）`);
        return;
    }
    if (c.openStep.step !== step || c.openStep.round !== round) {
        const open = c.openStep;
        c.openStep = null;
        log(`WARN: 观测配对异常：收到 step「${step}」（round=${round}）的 obsEnd，但当前打开的是「${open.step}」（round=${open.round}）——已给实际打开阶段补记 end（outcome=abandoned），收到的 end 未写（无对应 start 不伪造），业务不受影响。恢复动作：检查两处调用的 step/round 实参是否写反或错位`);
        await obsEmit(open.step, open.round, "end", "abandoned");
        return;
    }
    c.openStep = null;
    await obsEmit(step, round, "end", null);
}
/** withStage：串行阶段包装器（obsBegin → fn → obsEnd）。fn 内经收尾出口提前离开时
 *  openStep 已被 obsCloseExecution 清空（end 已由终态统一补记），finally 不重复补
 *  end；fn 抛异常且 step 仍打开 = 脚本级中断，finally 补 end（outcome=script-error） */
async function withStage(step, round, fn) {
    await obsBegin(step, round);
    let didThrow = false;
    try {
        return await fn();
    }
    catch (e) {
        didThrow = true;
        throw e;
    }
    finally {
        const c = obsCtx;
        if (c !== null && c.openStep !== null && c.openStep.step === step) {
            c.openStep = null;
            await obsEmit(step, round, "end", didThrow ? "script-error" : null);
        }
    }
}
/** 终态统一补记：给打开中的 step 补记 end（带 outcome=本次执行终态）+ 写 execution
 *  end。由终态统一出口调用（各 workflow 的 finish / 收尾段 / 启动期失败离开点） */
async function obsCloseExecution(outcome) {
    const c = obsCtx;
    if (c === null)
        return;
    const open = c.openStep;
    c.openStep = null;
    if (open !== null)
        await obsEmit(open.step, open.round, "end", outcome);
    await obsEmit("execution", null, "end", outcome);
}
// ============================================================================
// skill-data.shared.ts — skill-data 目录寻址层（单一构建输入）
// 寻址算法唯一权威源，双形态输出（检测算法 = D1 裁决的兄弟计数，逐条落本文件）：
//   单仓形态 slug = basename(realpath(projectRoot)) + '-' + sha256(realpath(projectRoot))[:8]；
//   workspace 检测：projectRoot 父目录 P 下、与本仓同仓（git-common-dir 规范化后
//   相同）的直接子目录 worktree 集合 S——含 projectRoot 自身、.bare 主 worktree 计入、
//   游离临时 worktree（不在 P 下）天然排除；|S| ≥ 2 → 工作区形态（ws-slug =
//   basename(P) + '-' + sha256(realpath(P))[:8]，附 workspaceRoot/worktreeName）；
//   git 不可用（非 git 目录 / git 失败）或 |S| < 2 → 单仓形态兜底，输出与现行
//   算法逐字节相同（AX5：单仓项目寻址零变化）。projectRoot 不存在时第一步
//   realpath 抛错退出（设计内失败形态）。
// 消费方 = 各业务 workflow 的探针引用点（node -e 子进程通道，argv 传
// projectRoot；NODE_PROJECT_ADDRESS 输出 JSON 契约
// { form: "workspace"|"single", slug, workspaceRoot?, worktreeName? }）；
// 构建器（scripts/build-workflows.mjs）把本文件全文整层拼进全部产物（启动校验层
// 之后、观测层之后、业务正文之前），业务源不再内联探针串——改算法只改本文件，
// 产物重建即全量生效。
//
// 固定测试向量：SKILL_DATA_SLUG_VECTORS（slug 算法）+ SKILL_DATA_DETECT_VECTORS
//（workspace 检测算法，四类 fixture）；向量对账（实跑探针对期望值）在
// scripts/tests/skill-data.test.mjs，注入不变量（产物内探针串与本文件逐字节一致）
// 在 scripts/check-workflow-parity.mjs（NODE_PROBE_HOME / NODE_PROJECT_SLUG）。
//
// 文件形态约束（三个消费方依赖，破坏即构建/检查失败）：
//   ① 无 import/export——zcode 产物禁模块语法（产物编译进函数体）；
//   ② 纯 JS 声明、无 TS 专属语法——单测经 vm 执行本文件取向量与常量；
//   ③ 探针常量保持单行、串内无双引号与反斜杠——parity 注入不变量按行正则
//      提取常量值（探针串是单引号 Node 代码，双引号只作 JS 字面量定界符）。
// ============================================================================
// home 探针：stdout = os.homedir()（观测层与 skill-data 落盘根的 home 前缀来源）
const NODE_PROBE_HOME = "process.stdout.write(require('os').homedir())";
// project-slug 探针：argv=[projectRoot] → stdout = basename-realhash8
//（realpath + sha256 前 8 位十六进制小写；单仓形态算法，逐字节等于本文件接管前的
// 各业务源内联实现——见文件头注的固定向量与对账位置）
const NODE_PROJECT_SLUG = "const p=require('fs').realpathSync(process.argv[1]);const h=require('crypto').createHash('sha256').update(p).digest('hex').slice(0,8);process.stdout.write(p.split('/').filter(Boolean).pop()+'-'+h)";
// project 寻址探针：argv=[projectRoot] → stdout = JSON（双形态输出契约）
// { form: "workspace"|"single", slug, workspaceRoot?, worktreeName? }。
// 算法（D1 兄弟计数，头注全称）：git 可用时先取本仓 common-dir（rev-parse
// --git-common-dir，相对输出按 projectRoot 规范化——主 worktree 输出 '.git'、
// 裸仓输出 '.'）；worktree list --porcelain 枚举本仓全部 worktree，对每个候选以
// 其自身路径为基准规范化 common-dir（链接 worktree 的 .git 是指路文件、common-dir
// 是共享目录，两处 realpath 后同一物理目录），凡「dirname 位于 P 且 common-dir
// 与本仓相同」者进 S（porcelain 里 prunable 已删除条目因 realpath 失败保留原值、
// git -C 失败被排除）；|S| ≥ 2 → workspace，否则 / 任一步 git 失败 → single 兜底
//（slug 派生与 NODE_PROJECT_SLUG 逐表达式相同）。探针串形态约束见头注 ③：
// 无双引号无反斜杠——换行解析用 String.fromCharCode(10) 而非转义
const NODE_PROJECT_ADDRESS = "const fs=require('fs'),cp=require('child_process'),cr=require('crypto'),pt=require('path');const root=fs.realpathSync(process.argv[1]);const slugOf=x=>x.split('/').filter(Boolean).pop()+'-'+cr.createHash('sha256').update(x).digest('hex').slice(0,8);const norm=(x,b)=>{const a=pt.isAbsolute(x)?x:pt.join(b,x);try{return fs.realpathSync(a)}catch(e){return a}};const single=()=>JSON.stringify({form:'single',slug:slugOf(root)});const detect=()=>{const g=cp.spawnSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'});if(g.status!==0||!String(g.stdout||'').trim())return single();const cd=norm(String(g.stdout).trim(),root);const w=cp.spawnSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'});if(w.status!==0)return single();const parent=pt.dirname(root);const sibs=[];for(const line of String(w.stdout||'').split(String.fromCharCode(10))){if(line.indexOf('worktree ')!==0)continue;const wt=norm(line.slice(9),root);const gw=cp.spawnSync('git',['-C',wt,'rev-parse','--git-common-dir'],{encoding:'utf8'});if(gw.status!==0||norm(String(gw.stdout||'').trim(),wt)!==cd)continue;if(pt.dirname(wt)===parent)sibs.push(wt)}if(sibs.length>=2)return JSON.stringify({form:'workspace',slug:slugOf(norm(parent,parent)),workspaceRoot:parent,worktreeName:root.split('/').filter(Boolean).pop()});return single()};process.stdout.write(detect())";
// 固定测试向量（slug 算法）：fixture = 输入根的标识（单测按标识解析为真实路径——
// 绝对路径不入仓，本仓检出根在单测内动态派生），slug = 探针对该根输出的期望值
const SKILL_DATA_SLUG_VECTORS = [
    { fixture: "repo-root", label: "zsw-skills 检出根（本仓）", slug: "zsw-skills-4ca4846f" },
];
// 固定测试向量（workspace 检测算法，D1/RL5）：kind = fixture 构造形态（单测按 kind
// 在临时目录构造对应仓库拓扑——git init / git worktree add 在测试内完成、属被测
// 行为，fixture 用完即删；绝对路径不入仓），expectForm = 对探测根的主形态断言
const SKILL_DATA_DETECT_VECTORS = [
    { kind: "bare-siblings-stray", label: "tai-ji 实形：.bare 主仓 + 兄弟 worktree + 游离临时目录 worktree", expectForm: "workspace" },
    { kind: "plain-checkout", label: "单仓：普通检出（slug 与现行算法逐字节一致）", expectForm: "single" },
    { kind: "stray-worktree", label: "游离 worktree：临时目录内 worktree 的形态输出确定", expectForm: "single" },
    { kind: "non-git", label: "非 git 目录：退单仓兜底不抛错", expectForm: "single" },
];
const SKILL_VERSION = "2.3.0"; // 构建注入自 dev-flow-v2/SKILL.md frontmatter version（唯一权威）
// ── W2 wave-executor-v2 ──
// 语义权威：设计文档 §8.2（调度语义）/ §8.3（exec-plan schema）/ §6.2（D1/D3 时间线）。
// 调度只看依赖边：deps 全 done 即派发；wave 字段完全不参与调度（仅 D0 侧展示标签）。
// 并发 ≤5，逐节点 settle 即重算（设计 §8.2：单节点完成立即解锁后继补派，不等批内
//   其他节点——长尾不拖批；活跃声明范围并集随活跃集动态重建）。
// agent 会话异常 → 接替程序（新 agent 名 + 前任证据包 + 当前 diff，先核验现状再续作，
//   设计 §6.2 F15 第一等路径）；接替者再异常才 blocked。
// 一律 failed-as-return：throw 的 errored run 不可 resume 且丢结构化错误（参数校验除外
//   ——args 非法属启动期快失败，errored 形态可接受）。
// 边界声明（设计 §8.2，2026-09-29 裁决范围声明降级）：并行单元共享工作区时，单单元改动
//   归属无法由 git status 精确切分，核验采用对账语义——dev 自报 files_changed 超出
//   territory 声明范围不打回，登记对账事件随终态呈报；引擎收尾对全工作区清单外残留做
//   对账（residualFiles），启动前既有改动登记豁免集不拒启动（2026-09-26 裁决），终态
//   残留对账只对本次 run 产生的改动。territory 声明仅剩两职责：启动互斥断言（并行单元
//   防写冲突的最小机制——声明重叠且无依赖边拒绝启动）与 DAG 编排参考；运行时逐文件
//   核验与扩展通道已删（实测零命中真越权、反致扩展死锁），多开发/少开发的一致性由
//   D2 一致性审查承接。
// 边界声明（设计 §8.5）：worktree 单元的「合并回主分支才就绪」不做引擎侧自动检测——
//   由 D0 编译负责排布合并（合并节点或手工段）。
// ── args 窄化（未知键 fail-fast：拼错键静默忽略比报错危险） ──
const VALID_ARG_KEYS = new Set([
    "execPlan",
    // 观测（O 区，可选）：taskId+executionId 同时提供才启用（sampleType 默认 production）
    "taskId",
    "executionId",
    "sampleType",
]);
for (const key of Object.keys(args)) {
    // `_` 前缀 = 宿主运行时私有键（如 taiji/pi 宿主注入的 _runId），不属于脚本契约，跳过白名单（2026-10-03 实测缺陷修复）
    if (!VALID_ARG_KEYS.has(key) && !key.startsWith("_")) {
        throw new Error(`未知参数: ${key}（唯一合法参数: execPlan——exec-plan.json 绝对路径）`);
    }
}
if (typeof args.execPlan !== "string" || args.execPlan.trim() === "") {
    throw new Error("缺少必填参数 execPlan（exec-plan.json 绝对路径，由 D0 编译产出）。" +
        "若本次经 AmendWorkflow 重发：派生 run 不继承原 run 的 args，须改用 CreateWorkflow 携 args 重新发起");
}
const execPlanPath = args.execPlan.trim();
// ── 常量 ──
const MAX_CONCURRENCY = 5; // 用户指定的全局并发上限（批大小）
const MAX_REJECT_ROUNDS = 2; // 打回定向修上限（初始 1 次 + 打回 2 次 = 至多 3 次 ask）
const MAX_HEAL_ROUNDS = 10; // 验收自愈轮次上限（设计 §8.7：沿用现成 maxRounds=10；超限走依赖可达性判定）
const TAIL_LINES = 40; // 失败输出贴入打回 prompt 的行数上限
const TEST_TIMEOUT_MS = 1800000; // 节点测试命令兜底墙钟（单元级=数十分钟；world.run 默认 300s 会误杀大仓单测）
const VERIFY_SCRIPT_TIMEOUT_MS = 3600000; // 验收剧本兜底墙钟（任务级=小时级，按超时默认原则校准）
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"];
// 恒绿形态拒收（assertion-residue MF-1-1）：白名单放行 bash/node，恒绿命令借道白名单即可
// 让节点核验秒绿（bash -c "true" 的 stub 落在 arg 位，故判据按完整命令串 + 逐 arg 双粒度
// 应用）。-c 的 arg 是整段 shell 程序文本，逐 arg 只扫整段不扫段内组合；-c 还可并入短旗
// 标簇（bash -lc 'exit 0'，裸 '-c' 精确匹配拦不住）——判据按 /^-[a-z]*c/i 找首个短旗
// 标簇元素（单短横开头、簇尾为 c 时后随 arg 才是命令串；排除 -- 长选项形态），命中取该
// 元素后随 arg 为命令串，剥一层对称外引号，连同 ;/&& 切片并入候选，切片候选（下标 >
// args.length 的扩展候选）额外过 STUB_HEAD（stub 词头带参数形态）。echo/printf 开头的
// 候选一律拒收：echo 输出内容可为任意字样（如 runner 名），字样不构成真实测试证据、无
// 豁免。簇判据与三式正则字面量与 dev-consistency-loop-v2 NODE_PREP 侧 noopCmdErr
// 保持逐字一致（两侧改动须同步）
const NOOP_CMD_STUB_RE = /^\s*(true|false|:)\s*$/;
const NOOP_CMD_ECHO_RE = /^\s*(echo|printf)\b/;
const NOOP_CMD_STUB_HEAD_RE = /^\s*(true|false|:|exit)(\s|$)/;
const SHELL_SAFE_ARG_RE = /^[A-Za-z0-9_/:.,@%^+=-]+$/;
function shellQuoteArg(s) {
    return SHELL_SAFE_ARG_RE.test(s) ? s : "'" + s.split("'").join("'\\''") + "'";
}
/** dev 节点 testCommand 恒绿形态判定：命中返回拒收文案（含恢复动作），未命中返回 null */
function noopCommandError(label, program, args) {
    const full = [program, ...args].map(shellQuoteArg).join(" ");
    const cands = [full, ...args];
    if (program === "bash" || program === "sh") {
        const flagIdx = args.findIndex((a) => /^-[a-z]*c/i.test(a));
        if (flagIdx >= 0) {
            const raw = args[flagIdx + 1];
            if (typeof raw === "string" && raw.length > 0) {
                let cmd = raw;
                if (cmd.length > 1 && (cmd.charCodeAt(0) === 39 || cmd.charCodeAt(0) === 34) && cmd.charCodeAt(cmd.length - 1) === cmd.charCodeAt(0)) {
                    cmd = cmd.slice(1, -1);
                }
                cands.push(cmd, ...cmd.split(/;|&&/));
            }
        }
    }
    for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (NOOP_CMD_STUB_RE.test(c) || (i > args.length && NOOP_CMD_STUB_HEAD_RE.test(c)) || NOOP_CMD_ECHO_RE.test(c)) {
            return `${label} 是恒绿形态命令（${full}）——不构成真实测试证据（恢复：检查 testPlan.fullSuite / testPlan.artifacts[n].command / testPlan.incremental / 节点 testCommand 是否为真实测试命令）`;
        }
    }
    return null;
}
/** verify 剧本合法扩展名（启动 fail-fast；解释器分派判据 = .sh→bash、其余→node——
 *  调整本集合须同步核对 runVerifyScript 的分派） */
const VERIFY_SCRIPT_EXTS = new Set([".sh", ".mjs", ".js", ".cjs"]);
const VALID_ENTRY_STATUS = new Set(["pending", "in-progress", "done", "blocked", "failed", "suspended"]);
// T9（用户裁决 2026-09-26）：workflow 内无用户交互位，任何 agent 不得提问——无法自决的
// 按职责内默认规则处置 + 记录待裁决事项随终态呈报。随 persona 固化进全部 agent。
const NO_ASK_RULE = "禁止向用户提问（无 AskUserQuestion / ask-user / 任何等待用户输入的操作）——workflow 内没有用户交互位；" +
    "无法自决的事项按职责内默认规则处置，并在产出中记录待裁决事项（随终态呈报主 agent / 用户）。";
const DEV_PERSONA = "你是开发单元执行者：严格按任务书改码，优先改任务书声明范围内的文件；" +
    "确需改范围外的文件时直接做，并在 files_changed 如实申报、deviations 写明原因（引擎对账呈报不打回）；" +
    "禁止触碰其他并行单元声明范围内的文件（并行写冲突会互相覆盖丢改动）；" +
    "测试范围 = 任务书 testCommand 指定的命令及其触及的测试文件，跑通后再交付——禁止跑包级全量套件或跨包扫描" +
    "（全量回归由后续全量测试门统一承担，单元级全量是重复劳动）；testCommand 覆盖不了你的改动行为时在 " +
    "deviations 申报，不要自行扩跑；" +
    "不要自行 git add / git commit——引擎核验通过后统一提交，自行提交会破坏状态对账与并行调度；" +
    "引擎会确定性重跑测试并对改动做对账登记（范围外改动如实申报即可），伪造 files_changed 或测试证据必被抓住；" +
    "任务书与现实冲突、环境缺失时如实填报 blockers/deviations，不要硬编绕过。" +
    NO_ASK_RULE;
const INSPECT_PERSONA = "你是验收检查执行者：只读检查（可运行只读命令、读文件），不修改任何代码、不产生 commit；" +
    "按任务书逐项核对并如实返回结论；证据不足就如实说，不猜测、不夸大。" +
    NO_ASK_RULE;
// ── 验收自愈 persona（设计 §8.7）──
const DIAGNOSE_PERSONA = "你是验收失败归因员：只读分析（可读失败日志 / 产物文件，可跑只读命令），不修改任何文件；" +
    "判定失败根因类别并给证据——证据必须引用失败输出原文，不猜测；" +
    NO_ASK_RULE;
const HEAL_PERSONA = "你是验收资产修复者：只修改归因指定的验收资产文件（测试 spec / 验收剧本 / 断言），禁止修改任何产品代码；" +
    "修复必须以归因证据为依据（断言口径错→改对口径 / 等待时序错→改等待点 / 窗口失配→按实测校准），" +
    "禁止无证据地放宽断言、删除断言或跳过用例换绿灯；修完如实返回修改清单；" +
    NO_ASK_RULE;
// ── D3 验收失败修复循环 persona（review-fix-loop 形态：聚合裁决 → 修复组 → 机器重验）──
const ACCEPTANCE_AGG_PERSONA = "你是验收失败聚合裁决员：跨节点合并同根因、证据裁决从严（反证不成立不进修复队列）、" +
    "延续条目优先换思路不复述已失败修法、修复分组遵循组内相关/组间文件不相交；" +
    "只读归因记录与代码，不改任何文件；" +
    NO_ASK_RULE;
const ACCEPTANCE_FIXER_PERSONA = "你是验收缺陷修复者：按修复任务文档修复产品代码或验收资产（以归因证据与修复指导为依据，小步修改）；" +
    "重验由引擎机器执行（剧本原样重跑 / 判定书锚核对）——禁止靠放宽断言、删断言、跳过用例换绿灯；" +
    "确信条目是误报时不修，返回 disputed 并给反证（file:line + 归因漏了什么）；" +
    "git 全禁（提交由引擎统一执行）；" +
    NO_ASK_RULE;
// ── node -e 通道（脚本无 fs/process：写盘/读文件/git/带 cwd 的子进程全走 world.run node -e，
//    argv 传参无 shell 注入风险；代码串内可 require Node 内建） ──
const WRITE_FILE = "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const READ_FILE_QUIET = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch{}";
const EXISTS = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";
// skillDataDir 探针组（impl-spec §2.1：脚本无 import，路径解析走 node -e 子进程）：
// NODE_PROBE_HOME / NODE_PROJECT_ADDRESS 由构建器从 workflows/src/skill-data.shared.ts
// 整层注入（寻址算法唯一权威源——算法、固定向量与注入对账位置见该文件头注）
// run manifest 探针组（skill-data-redesign §5.1：终态在 skillDataDir 根写 run.json）：
// NODE_PROBE_NOW 取当前时刻（ISO8601）。startedAt 必须经 world.run 探针取而不能脚本内
// new Date()——脚本沙箱本就禁 Date.now（重放一致性），world.run 的 journal 回放让
// startedAt 跨 resume 构造性稳定，run.json 防覆盖判据（startedAt 相同 = 同一次 run）才成立
const NODE_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
// argv: [projectRoot] → stdout = JSON {branch, head}（当前分支名 + HEAD hash）；git 失败
// 输出 null 形态——manifest 是分析契约，探针 fail-soft 置 null，不改变终态
const NODE_GIT_REV = "try{var g=require('child_process').execFileSync;" +
    "var b=g('git',['-C',process.argv[1],'rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8'}).trim();" +
    "var h=g('git',['-C',process.argv[1],'rev-parse','HEAD'],{encoding:'utf8'}).trim();" +
    'process.stdout.write(JSON.stringify({branch:b,head:h}))}catch(e){process.stdout.write(JSON.stringify({branch:null,head:null}))}';
// argv: [runJsonPath, payloadJson, startedAt] → 写 run.json + 防覆盖轮转：已存在的
// run.json 其 startedAt 与本次不同 → 先 rename 为 run-<旧startedAt 冒号换连字符>.json
// 归档（新 run 不冲掉上一 run 的分析数据）；startedAt 相同（resume 重放）→ 直接覆写；
// 旧文件缺失/损坏/无 startedAt（无判据可归档）→ 覆盖
const NODE_WRITE_RUN_JSON = "var fs=require('fs'),pt=require('path');" +
    "try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true})}catch(e){}" +
    "try{var oldRun=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(oldRun&&typeof oldRun.startedAt==='string'&&oldRun.startedAt!==process.argv[3]){fs.renameSync(process.argv[1],pt.join(pt.dirname(process.argv[1]),'run-'+oldRun.startedAt.replace(/:/g,'-')+'.json'))}}catch(e){}" +
    "fs.writeFileSync(process.argv[1],process.argv[2])";
// argv: [statusPath, dataDir] → 派生平铺产物族路径并确保 runlog 目录存在（<name>.runlog/
// 与 status 同前缀、落 dataDir = skill-data dev-flow 段——SKILL「运行记录」节：任务书引用
// 的 agent 过程记录落点）
const ENSURE_RUNLOG = "const p=require('path'),fs=require('fs');const b=p.basename(process.argv[1]).replace(/\\.status\\.json$/,'');fs.mkdirSync(p.join(process.argv[2],b+'.runlog'),{recursive:true})";
// argv: [statusPath, dataDir, title, body] → dataDir/<name>.ledger.md 追加（未决事项与裁决
// 处置档案；best-effort 语义由调用方承载——失败告警不改变终态）
const APPEND_LEDGER = "const p=require('path'),fs=require('fs');const b=p.basename(process.argv[1]).replace(/\\.status\\.json$/,'');const f=p.join(process.argv[2],b+'.ledger.md');fs.mkdirSync(process.argv[2],{recursive:true});fs.appendFileSync(f,'## '+process.argv[3]+'\\n'+process.argv[4]+'\\n\\n')";
// argv: [cwd] → stdout = porcelain 原文；非 git 仓库/工具错误 exit 1
const GIT_PORCELAIN = "try{const o=require('child_process').execFileSync('git',['status','--porcelain'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";
// argv: [cwd] → stdout = rev-parse --show-toplevel（该 cwd 所在 git 仓库根，绝对路径）；非 git 仓库/工具错误 exit 1
const GIT_TOPLEVEL = "try{const o=require('child_process').execFileSync('git',['rev-parse','--show-toplevel'],{cwd:process.argv[1],encoding:'utf8'});process.stdout.write(o.trim())}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";
// argv: [cwd, message, ...files] → stdout = 新 commit hash；add 用绝对路径（pathspec 相对 cwd
// 解析，cwd 非 repo 根时相对路径会指错文件）；commit 用 --only 限定路径——共享工作区并行
// 调度时暂存区可能有其他单元的 staged 内容，普通 commit 会连带提交，破坏「每单元独立成笔」
// index.lock 竞争退避：并行节点在同轮核验通过后各自 settle 提交，两笔 commit 争同一仓
// 索引锁 → "Unable to create '…/.git/index.lock': File exists"。只对该形态退避重试；
// pre-commit 拒绝等其余失败立即抛（stderr 原样交回调用方判定）。退避总量 ≥30s：一次
// 提交要跑完整 pre-commit 链（build + parity + types + 契约，实测 10–20s），对端持锁
// 时长同量级，短退避（先例 6 次≈5.7s）不够用
const GIT_ADD_COMMIT = "try{const a=process.argv.slice(1);const c=a[0],m=a[1],f=a.slice(2);const p=require('path');const x=require('child_process').execFileSync;" +
    "const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);" +
    "const gr=(args,opts)=>{for(let i=0;;i++){try{return x('git',args,opts)}catch(e){const m=String((e&&(e.stderr||e.stdout))||e.message);" +
    "if(m.indexOf('index.lock')>=0&&i<10){sleep(1000+i*1000);continue}throw e}}};" +
    "const abs=f.map(t=>p.resolve(c,t));" +
    // 幂等分支：目标文件零改动（如节点产物已在恢复对账时提交过）→ 直接返回当前 HEAD，
    // 不走 add/commit（git commit 对空暂存区报 nothing to commit 非零退出，曾误判 commit 失败）
    "if(abs.length>0){const st=String(gr(['status','--porcelain','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432}));" +
    "if(st.trim()===''){const h0=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h0);process.exit(0)}}" +
    "if(abs.length>0)gr(['add','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
    "gr(['commit','--only','-m',m,'--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432,stdio:['ignore','pipe','pipe']});" +
    "const h=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h)}" +
    "catch(e){process.stderr.write(String((e&&(e.stderr||e.stdout))||e.message));process.exit(1)}";
// argv: [program, cwd, ...args] → 在指定 cwd 内执行 program；退出码/stdout/stderr 全量透传
//（spawnSync 而非 execFileSync：后者正常退出时 stderr 被丢弃，测试输出的诊断信息会失真）
const RUN_IN_CWD = "try{const a=process.argv.slice(1);const p=a[0],c=a[1],r=a.slice(2);" +
    "const s=require('child_process').spawnSync(p,r,{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
    "if(s.stdout)process.stdout.write(s.stdout);if(s.stderr)process.stderr.write(s.stderr);" +
    "process.exit(typeof s.status==='number'?s.status:1)}" +
    "catch(e){process.stderr.write(String((e&&e.message)||'spawn failed'));process.exit(1)}";
// argv: [cwd] → stdout = git diff --stat 原文（接替程序的前任证据包成分）；失败 exit 1 输出空
const GIT_DIFF_STAT = "try{const o=require('child_process').execFileSync('git',['diff','--stat'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stdout.write('(diff 不可用)')}";
// argv 双布局：status 已存在路径 = [statusPath, projectRoot, commitTemplate, runId, ...devEntries]
//   （布局与语义均不变）；初始态恢复路径 = [statusPath, projectRoot, commitTemplate, runId,
//   "claimAnyRunId", ...devEntries]（旗标在 runId 与条目之间，条目起点随之右移一位——
//   脚本按旗标有无选择 slice 起点，旧布局不受影响）→ 双向对账（§4.5 崩溃裁决，git 为准）：
//   devEntries 条目 = `<id>`（主仓节点）或 `<id>@<仓根绝对路径>`（跨仓节点，如子模块）——
//   commit 存在性校验与 git log 反查都必须在 commit 所在仓执行：单 projectRoot 口径曾把
//   子模块 commit 判「不在对象库」致已交付单元全部回 pending 重跑（实测 compute-asr
//   run 二次发起时 U1/U3/U6b 空重跑）。
//   claimAnyRunId = 字面量 "claimAnyRunId" 时反查不校验 Run-Id trailer（status.json 曾缺失
//   的初始态恢复路径专用——该路径先生成全新 runId 写入初始 status 再反查，旧交付 commit
//   带旧 Run-Id，trailer 精确匹配恒落空，已交付单元会被整节点重做）。认领语义 = subject
//   前缀 + 词边界命中即认领，同一单元多个候选 commit 取 baseline..HEAD 中最新可达的一个
//   （git log 新 commit 在前，find 首个命中即最新）。旗标缺省（status 已存在的双向对账
//   路径）保持 Run-Id trailer 精确匹配语义。
//   ①status=done 的节点：commit 不在其仓 git 对象库 → 回 pending；
//   ②status≠done 的 dev 节点：git log 反查补写 done（commit 哈希 + 证据）。反查命中条件
//     三重锚定：a) 时间窗 = baseline..HEAD——无 baseline 时反查禁用（不回退扫 HEAD 起
//     500 条：跨 run 同模板同单元编号的历史 commit 会撞名误配，正是 431b898 修复的事故
//     形态；禁用后未记录单元保持 pending 重跑，由引擎提交的幂等分支兜住，方向安全。
//     baseline 固化（status.json 初建必写）后该分支只对旧格式 status.json 可达；
//     b) Run-Id 锚定，三态：默认（旗标缺省）= commit trailer 的 Run-Id === 本 run 标识
//     （构造性唯一：引擎渲染 message 时统一追加，AI 自由文本经单行化净化无法伪造 trailer
//     段），本 run 的 commit 恒带 trailer，无 trailer 且前缀匹配的历史 commit 在 runId
//     在场时不认；claimAnyRunId 认领语义 = 跳过该锚（见上）；status 无 runId（旧格式引擎
//     写的）→ 兼容路径：只认无 trailer + 前缀 + 词边界（旧引擎 commit 恰好无 trailer，
//     自洽）；
//     c) subject 前缀锚定 = commitTemplate 按 {unitId} 切出的静态前段 + <id>，且 <id> 后继
//     字符非字母数字连字符（模板缺失时退化为 <id> 前缀 + 同一边界检查）——区分 run 内
//     不同单元。stdout = 对账后的完整 status.json
//     （保留 schema 外顶层字段；runId 缺失时以 argv 传入值补写，保证输出恒含）
const RECONCILE_STATUS = "try{const fs=require('fs');const sp=process.argv[1],root=process.argv[2],tpl=process.argv[3]||'',runIdArg=process.argv[4]||'',claimAny=process.argv[5]==='claimAnyRunId',ents=process.argv.slice(claimAny?6:5).map(function(s){var i=s.indexOf('@');return i<0?{id:s,cwd:root}:{id:s.slice(0,i),cwd:s.slice(i+1)};});" +
    "const x=require('child_process').execFileSync;const st=JSON.parse(fs.readFileSync(sp,'utf8'));const nodes={};" +
    "for(const k of Object.keys(st.nodes||{}))nodes[k]=st.nodes[k];const events=(st.events||[]).slice();" +
    "const range=typeof st.baseline==='string'&&st.baseline?st.baseline+'..HEAD':null;" +
    "if(!range)events.push({seq:events.length+1,node:'*',event:'reconcile-warn',detail:'status 无 baseline——反查禁用，未记录单元保持 pending 重跑（幂等核验兜底）。恢复动作：旧格式 status.json，重发起后引擎初建即固化 baseline'});" +
    "const logCache={};" +
    "const logOf=function(cwd){if(logCache[cwd]!==undefined)return logCache[cwd];var v='';if(range){try{v=String(x('git',['log','--format=%H%x1f%s%x1f%(trailers:key=Run-Id,valueonly)',range],{cwd:cwd,encoding:'utf8',maxBuffer:33554432}))}catch(err){}}logCache[cwd]=v;return v;};" +
    "const runId=typeof st.runId==='string'&&st.runId?st.runId:null;" +
    "const preOf=(id)=>(tpl.split('{unitId}')[0]||'')+id;" +
    "for(const ent of ents){const id=ent.id,cwd=ent.cwd;const e=nodes[id]||{status:'pending',attempts:0};" +
    "if(e.status==='done'){let ok=false;" +
    "if(typeof e.commit==='string'&&e.commit.length>=7){try{x('git',['cat-file','-e',e.commit+'^{commit}'],{cwd:cwd,encoding:'utf8'});ok=true}catch(err){}}" +
    "if(ok)continue;nodes[id]={status:'pending',attempts:0};" +
    "events.push({seq:events.length+1,node:id,event:'reconcile-reset',detail:'status done 但 commit 不在 git 对象库，按 git 为准回 pending'})}" +
    "else{const pre=preOf(id);" +
    "const hit=logOf(cwd).split('\\n').find((l)=>{const seg=l.split('\\x1f');if(seg.length<2)return false;const s=seg[1]||'';const t=(seg[2]||'').trim();" +
    "const subj=s.startsWith(pre)&&(s.length===pre.length||!/[A-Za-z0-9-]/.test(s.charAt(pre.length)));" +
    "if(!subj)return false;" +
    "return claimAny?true:(runId!==null?(t===runId):(t===''))});" +
    "if(hit){const h=hit.slice(0,hit.indexOf('\\x1f'));nodes[id]={status:'done',attempts:1,commit:h,evidence:'恢复对账：git log 反查命中本单元 commit（'+(claimAny?'前缀+词边界认领（status 曾缺失，不校验 Run-Id）':'Run-Id '+(runId!==null?'精确匹配':'兼容路径：前缀+词边界（status 无 runId）'))+'，status 未记，按 git 为准补写 done）'};" +
    "events.push({seq:events.length+1,node:id,event:'reconcile-done',detail:'status 未记但 git log 有本单元 commit，按 git 为准补写 done'})}}}" +
    "const out={};for(const k of Object.keys(st))if(k!=='nodes'&&k!=='events')out[k]=st[k];out.baseline=st.baseline||null;out.runId=st.runId||runIdArg||null;out.nodes=nodes;out.events=events;" +
    "process.stdout.write(JSON.stringify(out))}" +
    "catch(e){process.stderr.write(String((e&&e.message)||'reconcile failed'));process.exit(1)}";
// ── 纯工具函数 ──
function errText(e) {
    return e instanceof Error ? e.message : String(e);
}
/** 启动校验失败的 failed-as-return 载体（不 throw：errored run 不可 resume 且丢结构化错误） */
function invalidRet(message, statusFile) {
    return {
        terminated: "blocked",
        done: [],
        blocked: [],
        skipped: [],
        statusFile,
        coreFailure: null,
        validationError: message,
        deferredCommits: [],
        residualFiles: [],
        acceptanceFix: null,
    };
}
/** 观测启用后的启动校验失败出口：先补记观测执行结束事件（outcome=blocked）再走
 *  failed-as-return 载体——execution start 之后的所有 invalidRet 调用点经此离开 */
async function invalidObs(message, statusFile) {
    await obsCloseExecution("blocked");
    return invalidRet(message, statusFile);
}
function isRec(x) {
    return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStr(x) {
    return typeof x === "string" && x.trim() !== "";
}
function isStrArr(x) {
    return Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");
}
/** 相对路径挂在 projectRoot 下；绝对路径原样返回 */
function joinPath(base, rel) {
    if (rel.startsWith("/"))
        return rel;
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    return `${trimmed}/${rel}`;
}
/** 解析寻址探针输出；形态非法返回 null（由调用方按启动期失败处理，不猜默认值） */
function parseProjectAddress(raw) {
    try {
        const v = JSON.parse(raw);
        if (typeof v.slug !== "string" || v.slug === "")
            return null;
        if (v.form === "single")
            return { form: "single", slug: v.slug };
        if (v.form === "workspace" &&
            typeof v.workspaceRoot === "string" &&
            v.workspaceRoot !== "" &&
            typeof v.worktreeName === "string" &&
            v.worktreeName !== "") {
            return { form: "workspace", slug: v.slug, workspaceRoot: v.workspaceRoot, worktreeName: v.worktreeName };
        }
        return null;
    }
    catch {
        return null;
    }
}
/** dev-flow 段产物根：workspace 形态 = <ws-slug>/<worktreeName>（worktree 级隔离）；单仓
 *  形态退回现行平铺（AX5：路径与两级化前逐字节相同） */
function devFlowRoot(home, address) {
    const base = `${home}/.agents/skill-data/dev-flow/${address.slug}`;
    return address.form === "workspace" ? `${base}/${address.worktreeName}` : base;
}
function tailLines(text, n) {
    const s = String(text ?? "").trimEnd();
    const lines = s.split("\n");
    return lines.length <= n ? s : lines.slice(-n).join("\n");
}
/** 文件路径是否落在声明范围内（条目=文件或目录前缀） */
function pathInTerritory(file, territories) {
    for (const t of territories) {
        const prefix = t.endsWith("/") ? t : `${t}/`;
        if (file === t || file.startsWith(prefix))
            return true;
    }
    return false;
}
/**
 * territory 条目形态契约（启动校验唯一入口）：条目 = 相对该节点 cwd 所在 git 仓库根的
 * 纯路径（文件或目录前缀）——启动互斥断言的机器输入。绝对路径与空格/括号注释混合形态
 * （如「src/**（含测试）」）在 pathInTerritory 匹配上恒失败（口径契约：territory 与
 * files_changed/porcelain 同基准）——错误就地暴露，不做归一化宽容吸收（引擎猜作者
 * 意图比静默失效更危险）。返回错误清单，空数组 = 全部合法。
 */
function territoryFormatErrors(id, entries) {
    const errs = [];
    const abs = entries.filter((t) => t.startsWith("/"));
    if (abs.length > 0) {
        errs.push(`dev 节点 ${id} 的 territory 含绝对路径（${abs.join("、")}）——须为相对该节点 cwd 所在 git 仓库根的相对路径`);
    }
    const mixed = entries.filter((t) => /\s/.test(t) || /[()（）]/.test(t));
    if (mixed.length > 0) {
        errs.push(`dev 节点 ${id} 的 territory 含混合形态条目（空格/括号注释）：${mixed.join("、")}——territory 是启动互斥断言的机器输入，条目须为纯路径`);
    }
    return errs;
}
/** porcelain 输出 → 文件路径列表（R 行取新路径；与 pr-lifecycle 同构） */
function parsePorcelain(out) {
    return out
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .map((l) => {
        let p = l.slice(3).trim().replace(/^"|"$/g, "");
        const arrow = p.indexOf(" -> ");
        if (arrow >= 0)
            p = p.slice(arrow + 4).trim().replace(/^"|"$/g, "");
        return p;
    });
}
/** workflow 产物目录判定：porcelain 路径相对 cwd，projectRoot 级 .tmp/ 在 cwd=子目录时
 *  呈 ../.tmp/（或更深的 ../../.tmp/）形态——按「任意深度 ../ 前缀 + .tmp/」识别。
 *  工作流产物已迁 HOME 下 skill-data（porcelain 天然不可见），本过滤器退化为历史兼容
 *  （存量其他 .tmp 使用者仍在） */
const isTmpArtifact = (f) => /^(\.\.\/)*\.tmp\//.test(f);
/** commitTemplate 渲染：{unitId}/{summary} 全量替换（split/join 防 replace 只换首个） */
function renderCommit(template, unitId, summary) {
    return template.split("{unitId}").join(unitId).split("{summary}").join(summary);
}
/** summary 单行化（AI 自由文本进 message 的边界净化）：subject 锚定要求第一行 =
 * 静态前缀 + 单元 id 完整词，换行会把 message 撕成多段破坏锚定，且多行文本可构造
 * 伪 trailer 段伪造 Run-Id——单行化后 trailer 段只能由引擎追加，机器区构造性唯一 */
function sanitizeSummary(summary) {
    return summary.replace(/[\r\n]+/g, " ").trim();
}
/** 完整 commit message = subject（模板渲染，summary 单行化）+ 空行 + Run-Id trailer。
 *  Run-Id = 引擎初建 status.json 时生成的运行唯一标识，同模板同单元编号的历史 commit
 *  没有本 run 的 Run-Id，反查（RECONCILE_STATUS）按 trailer 精确匹配构造性排除撞名。
 *  trailer 是 git 标准惯例（同 Signed-off-by 的单独成行形态），git 原生
 *  %(trailers:key=Run-Id) 可解析，读侧不依赖手写字符串匹配 */
function buildCommitMessage(template, unitId, summary, runId) {
    return `${renderCommit(template, unitId, sanitizeSummary(summary))}\n\nRun-Id: ${runId}`;
}
/** 依赖环检测：DFS 三色标记，命中回边返回环上节点 id，无环返回 null */
function detectCycle(ids, depsOf) {
    const color = new Map(); // 0=未访 1=在当前路径 2=完成
    for (const id of ids)
        color.set(id, 0);
    let hit = null;
    const visit = (id) => {
        if (hit !== null)
            return;
        const c = color.get(id) ?? 0;
        if (c === 1) {
            hit = id;
            return;
        }
        if (c === 2)
            return;
        color.set(id, 1);
        for (const d of depsOf.get(id) ?? [])
            visit(d);
        color.set(id, 2);
    };
    for (const id of ids) {
        visit(id);
        if (hit !== null)
            break;
    }
    return hit;
}
// ── exec-plan schema 校验（§8.3；错误全量收集后一次 fail-fast） ──
function validatePlan(raw) {
    const errors = [];
    if (!isRec(raw))
        return { ok: false, errors: ["exec-plan 根必须是 JSON 对象"] };
    // version 不符时整体 schema 形态不可信，单独 return（混入 errors 会污染后续
    // 「本阶段错误收集完再停」的判据，吞掉节点级错误）
    if (raw.version !== 1)
        return { ok: false, errors: [`version 必须为 1，实际：${JSON.stringify(raw.version)}`] };
    // 三个致命字段走直线检查收窄（经 errors 间接 return 的写法 TS 无法收窄，unknown 会向下游传染）
    const mode = raw.mode === "dev" || raw.mode === "acceptance" ? raw.mode : null;
    if (mode === null) {
        errors.push(`mode 必须是 "dev" 或 "acceptance"，实际：${JSON.stringify(raw.mode)}`);
        return { ok: false, errors };
    }
    const projectRoot = isStr(raw.projectRoot) ? raw.projectRoot : null;
    if (projectRoot === null) {
        errors.push("projectRoot 必须是非空字符串（git/测试/commit 的缺省 cwd——引擎不从进程 cwd 推导）");
    }
    const statusPathRel = isStr(raw.statusPath) ? raw.statusPath : null;
    if (statusPathRel === null) {
        errors.push("statusPath 必须是非空字符串");
    }
    // workspaceRoot（增量可选字段，additive）：工作区形态的 exec-plan 记录工作区根绝对路径，
    // 供统计 / 迁移等外部消费者派生工作区级地址；缺省合法（单仓项目与存量 exec-plan 不因此
    // 被拒——执行裁决只认 version，字段缺失不构成拒绝理由）。提供了就按绝对路径校验，形态
    // 错误是作者笔误，静默忽略会让下游按错路径派生
    const workspaceRoot = raw.workspaceRoot === undefined ? null : isStr(raw.workspaceRoot) ? raw.workspaceRoot : null;
    if (raw.workspaceRoot !== undefined && workspaceRoot === null) {
        errors.push("workspaceRoot 若提供必须是非空字符串（工作区根绝对路径）");
    }
    else if (workspaceRoot !== null && !workspaceRoot.startsWith("/")) {
        errors.push(`workspaceRoot 必须是绝对路径（实际：${workspaceRoot}）`);
    }
    // projectRoot/statusPath 是节点构建的路径基准，缺失时节点级校验无从进行——
    // 两者错误收集齐后即返回（不带病进节点校验）；两者齐备则继续收集后续错误，
    // 一次报全（version/mode 因 schema 形态不可信保留单独 return）
    if (projectRoot === null || statusPathRel === null)
        return { ok: false, errors };
    // 节集：dev 模式=顶层 nodes；acceptance 模式=acceptance.nodes（两模式节点集分界）
    const rawNodes = [];
    let accRec = null;
    if (mode === "dev") {
        if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
            errors.push("mode=dev 时顶层 nodes 必须是非空数组");
        }
        else {
            rawNodes.push(...raw.nodes);
        }
    }
    else {
        if (!isRec(raw.acceptance)) {
            errors.push("mode=acceptance 时必须提供 acceptance 对象（nodes/groups；core/haltOnCoreFail 已退役被忽略）");
        }
        else {
            accRec = raw.acceptance;
            if (!Array.isArray(accRec.nodes) || accRec.nodes.length === 0) {
                errors.push("acceptance.nodes 必须是非空数组");
            }
            else {
                rawNodes.push(...accRec.nodes);
            }
        }
    }
    if (errors.length > 0)
        return { ok: false, errors };
    const nodes = [];
    const idSet = new Set();
    for (let i = 0; i < rawNodes.length; i += 1) {
        const rn = rawNodes[i];
        if (!isRec(rn)) {
            errors.push(`nodes[${i}] 必须是对象`);
            continue;
        }
        if (!isStr(rn.id)) {
            errors.push(`nodes[${i}] 缺少非空 id`);
            continue;
        }
        const id = rn.id;
        if (idSet.has(id))
            errors.push(`节点 id 重复：${id}`);
        idSet.add(id);
        const kind = rn.kind;
        if (kind !== "dev" && kind !== "verify" && kind !== "inspect") {
            errors.push(`节点 ${id} 的 kind 必须是 dev/verify/inspect，实际：${JSON.stringify(kind)}`);
            continue;
        }
        if (mode === "dev" && kind === "inspect") {
            errors.push(`mode=dev 但节点 ${id} kind=inspect（inspect 任务书属验收语义；dev 模式仅允许 dev 节点与开发期 e2e 的 verify 节点）`);
        }
        if (mode === "acceptance" && kind === "dev") {
            errors.push(`mode=acceptance 但节点 ${id} kind=dev（dev 节点属 D1 实例化）`);
        }
        if (!isStrArr(rn.deps)) {
            errors.push(`节点 ${id} 的 deps 必须是字符串数组`);
            continue;
        }
        const node = {
            id,
            kind,
            deps: rn.deps,
            designRef: isStr(rn.designRef) ? rn.designRef : "",
            territory: [],
            testCommand: null,
            promptFile: "",
            script: "",
            artifactsDir: "",
            artifactsRefs: [],
            cwd: isStr(rn.cwd) ? joinPath(projectRoot, rn.cwd) : projectRoot,
        };
        if (kind === "dev") {
            if (!isStrArr(rn.territory) || rn.territory.length === 0) {
                errors.push(`dev 节点 ${id} 的 territory 必须是非空字符串数组（范围声明）`);
            }
            else {
                const terrErrs = territoryFormatErrors(id, rn.territory);
                if (terrErrs.length === 0)
                    node.territory = rn.territory;
                else
                    errors.push(...terrErrs);
            }
            if (!isStr(rn.promptFile)) {
                errors.push(`dev 节点 ${id} 缺少 promptFile`);
            }
            else {
                node.promptFile = joinPath(projectRoot, rn.promptFile);
            }
            const tc = rn.testCommand;
            if (!isRec(tc) || !isStr(tc.program) || !isStrArr(tc.args)) {
                errors.push(`dev 节点 ${id} 的 testCommand 必须是 {program, args} 形态（program 字符串 + args 字符串数组）`);
            }
            else {
                if (!TEST_WHITELIST.includes(tc.program)) {
                    errors.push(`dev 节点 ${id} 的 testCommand.program "${tc.program}" 不在白名单（${TEST_WHITELIST.join("/")}）`);
                }
                const noopErr = noopCommandError(`dev 节点 ${id} 的 testCommand`, tc.program, tc.args);
                if (noopErr !== null)
                    errors.push(noopErr);
                node.testCommand = { program: tc.program, args: tc.args };
            }
        }
        else if (kind === "verify") {
            if (!isStr(rn.script)) {
                errors.push(`verify 节点 ${id} 缺少 script（L3 剧本路径）`);
            }
            else {
                node.script = joinPath(projectRoot, rn.script);
            }
            if (!isStr(rn.artifactsDir)) {
                errors.push(`verify 节点 ${id} 缺少 artifactsDir`);
            }
            else {
                node.artifactsDir = joinPath(projectRoot, rn.artifactsDir);
            }
        }
        else {
            if (!isStr(rn.promptFile)) {
                errors.push(`inspect 节点 ${id} 缺少 promptFile（L4 任务书）`);
            }
            else {
                node.promptFile = joinPath(projectRoot, rn.promptFile);
            }
            if (rn.artifactsRefs !== undefined) {
                if (!isStrArr(rn.artifactsRefs)) {
                    errors.push(`inspect 节点 ${id} 的 artifactsRefs 必须是字符串数组`);
                }
                else {
                    node.artifactsRefs = rn.artifactsRefs;
                }
            }
        }
        nodes.push(node);
    }
    if (errors.length > 0)
        return { ok: false, errors };
    // deps / artifactsRefs 引用存在性
    for (const n of nodes) {
        for (const d of n.deps) {
            if (!idSet.has(d))
                errors.push(`节点 ${n.id} 的 deps 引用了不存在的节点：${d}`);
        }
        for (const r of n.artifactsRefs) {
            if (!idSet.has(r))
                errors.push(`节点 ${n.id} 的 artifactsRefs 引用了不存在的节点：${r}`);
        }
    }
    // 依赖环检测（简单 DFS）
    const depsOf = new Map(nodes.map((n) => [n.id, n.deps]));
    const cycleHit = detectCycle(nodes.map((n) => n.id), depsOf);
    if (cycleHit !== null)
        errors.push(`依赖图存在环，环上节点：${cycleHit}`);
    // 范围声明互斥启动断言（T3 DAG 自检「任意两单元范围声明交集为空」的机器下限）：重叠条目
    // 必须有依赖路径（任一方向可达）——无边重叠对会同时就绪并行派发，同文件写冲突 +
    // 级二复核按活跃声明范围并集粗判会互相污染归属；写计划纪律仍取全互斥，依赖串行是逃生通道
    const terrOwners = new Map();
    for (const n of nodes) {
        if (n.kind !== "dev" || n.territory.length === 0)
            continue;
        for (const t of n.territory) {
            const owners = terrOwners.get(t) ?? [];
            owners.push(n.id);
            terrOwners.set(t, owners);
        }
    }
    if (terrOwners.size > 0) {
        const reaches = (from, to) => {
            const stack = [...(depsOf.get(from) ?? [])];
            const visited = new Set();
            while (stack.length > 0) {
                const cur = stack.pop();
                if (cur === to)
                    return true;
                if (visited.has(cur))
                    continue;
                visited.add(cur);
                stack.push(...(depsOf.get(cur) ?? []));
            }
            return false;
        };
        for (const [t, owners] of terrOwners) {
            for (let i = 0; i < owners.length; i += 1) {
                for (let j = i + 1; j < owners.length; j += 1) {
                    const a = owners[i];
                    const b = owners[j];
                    if (!reaches(a, b) && !reaches(b, a)) {
                        errors.push(`节点 ${a} 与 ${b} 范围声明重叠（${t}）且两方向均无依赖路径——两者会同时就绪并行派发（同文件写冲突、声明核验互污）。共同文件改动须合并为同一单元或以依赖边串行后重发 exec-plan`);
                    }
                }
            }
        }
    }
    // acceptance 分组：groups.core / haltOnCoreFail 已退役（2026-09-26 用户裁决——依赖可达性
    // 熔断统一判据后核心场景标注不再承载语义）。字段保留宽容解析（旧 exec-plan 不报错、直接忽略）
    if (mode === "acceptance" && accRec !== null) {
        const groups = accRec.groups;
        if (!isRec(groups)) {
            errors.push("acceptance.groups 必须是对象 {core, nonCore}（core/haltOnCoreFail 已退役，保留字段被忽略）");
        }
    }
    const commitTemplate = isStr(raw.commitTemplate) ? raw.commitTemplate : null;
    if (mode === "dev" && commitTemplate === null) {
        errors.push("mode=dev 时 commitTemplate 必须是非空字符串");
    }
    else if (mode === "dev" && commitTemplate !== null) {
        if (!commitTemplate.includes("{unitId}") || !commitTemplate.includes("{summary}")) {
            errors.push(`commitTemplate 须同时含 {unitId} 与 {summary} 占位符（当前：${commitTemplate}）`);
        }
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        plan: {
            version: 1,
            mode,
            projectRoot,
            workspaceRoot,
            statusPath: joinPath(projectRoot, statusPathRel),
            commitTemplate: commitTemplate ?? "{unitId} — {summary}",
            baseline: typeof raw.baseline === "string" ? raw.baseline : null,
            nodes,
        },
    };
}
// ── node -e 通道 helpers ──
async function readTextViaNode(path) {
    const r = await world.run("node", ["-e", READ_FILE_QUIET, path]);
    if (r.exitCode !== 0 || r.stdout.trim() === "")
        return null;
    return r.stdout;
}
async function writeTextViaNode(path, body) {
    const r = await world.run("node", ["-e", WRITE_FILE, path, body]);
    if (r.exitCode !== 0) {
        throw new Error(`写盘失败（${path}，exit ${r.exitCode}）：${r.stderr.trim() || r.stdout.trim()}`);
    }
}
async function existsViaNode(path) {
    const r = await world.run("node", ["-e", EXISTS, path]);
    return r.exitCode === 0;
}
/** run.json 终态落盘（best-effort：失败只告警——终态数据以 status.json 与返回值为准）；
 *  防覆盖轮转判定在 NODE_WRITE_RUN_JSON 内（旧文件 startedAt 不同 → rename 归档后覆写） */
async function writeRunManifest(m) {
    const w = await world.run("node", ["-e", NODE_WRITE_RUN_JSON, `${skillDataDir}/run.json`, JSON.stringify(m, null, 2), m.startedAt]);
    if (w.exitCode !== 0) {
        log(`WARN: run.json 落盘失败（exit ${w.exitCode}：${w.stderr.trim() || w.stdout.trim()}）——终态数据以 status.json 与返回值为准`);
    }
}
/** git 探针（NODE_GIT_REV）→ {branch, head}；输出形态非法全 null（fail-soft，不改变终态） */
async function gitRevProbe(root) {
    const r = await world.run("node", ["-e", NODE_GIT_REV, root]);
    try {
        const v = JSON.parse(r.stdout);
        return {
            branch: typeof v.branch === "string" && v.branch !== "" ? v.branch : null,
            head: typeof v.head === "string" && v.head !== "" ? v.head : null,
        };
    }
    catch {
        return { branch: null, head: null };
    }
}
/** null = git 命令本身失败（非 git 仓库/工具缺失），区别于「干净」 */
async function gitPorcelainViaNode(cwd) {
    const r = await world.run("node", ["-e", GIT_PORCELAIN, cwd]);
    if (r.exitCode !== 0)
        return null;
    return r.stdout;
}
/** cwd 必须等于其所在 git 仓库根（projectRoot 或 worktree 根）：porcelain 输出相对 cwd、
 * territory 相对仓库根——cwd 落在仓库子目录时两基准全链错位（声明恒判越界、提交被拒）。
 * null = git 命令失败；否则返回 toplevel 绝对路径，由调用方比对。 */
async function gitToplevelViaNode(cwd) {
    const r = await world.run("node", ["-e", GIT_TOPLEVEL, cwd]);
    if (r.exitCode !== 0)
        return null;
    return r.stdout.trim();
}
async function gitAddCommitViaNode(cwd, message, files) {
    const r = await world.run("node", ["-e", GIT_ADD_COMMIT, cwd, message, ...files]);
    if (r.exitCode !== 0)
        return { ok: false, hash: "", err: tailLines(`${r.stdout}\n${r.stderr}`, TAIL_LINES) };
    return { ok: true, hash: r.stdout.trim(), err: "" };
}
// ── 调度器内存态（崩溃恢复事实源是 status.json + git，不是这个 Map） ──
const state = new Map();
let plan; // 赋值点在「校验执行计划」段；其后所有函数才可能被调用
let coreFail = null;
// 顶层读取 coreFail 须过函数边界：赋值点在调度循环闭包内，顶层控制流分析会把
// 直接读取过度窄化为 null（if 收窄后成 never）——函数体内读取返回声明类型
function readCoreFail() {
    return coreFail;
}
/** 当前 in-flight 节点的声明范围并集（按 cwd 分组）——级二粗粒度复核的基线，逐节点 settle 后重建 */
let activeTerrByCwd = new Map();
/** 全部 dev 节点核验通过时自报的 files_changed 并集（终态残留对账的豁免集——静态声明范围
 *  不含运行中新建文件，自报并集补上这一段） */
const declaredFiles = new Set();
/** commit 被拒（多为仓库 pre-commit 钩子全仓检查 × 并行半成品）转待办的节点——节点核验
 *  已过、编码成果有效，不 blocked（2026-09-26 用户裁决：全部做完留给主 agent 处理，
 *  钩子在主会话代提交时照常执行）；收尾统一呈报 */
const deferredCommits = [];
// ── 统一失败处理中心（review-fix-loop 形态：失败池 → 聚合裁决 phase → 修复组 phase
//    → 机器重验回循环）。三类「本可轮内修却会跳出」的失败统一进池：
//    ① 验收失败（verify/inspect failed——acceptance 与 dev 模式一律，开发期 e2e 同获修复
//    循环）；② commit 门禁失败（dev 节点核验过但 commit 被仓库钩子拒——豁免标记/清单
//    登记类合规修复就轮内做，不再全量上抛主 agent）；③（W2 无产物类——Gate A 产物属 W3）。
//    fixer 可修产品代码（修订 2026-09-26「验收 fixer 不碰产品代码」裁决），防线 =
//    归因/修复分角色 + 重验走机器判定（剧本 exit code / 判定书锚 / commit exit code，
//    不采信自报）+ disputed 反证通道（误报呈报人工裁决，不占修复轮次）。blocked（环境/
//    任务书/结构化不合规）不进池——修复组解不了，维持立即熔断。dev 模式的 dev 节点打回
//    超限 blocked 同样不进池（数字阈值裁决保留）──
const MAX_FAILURE_FIX_ROUNDS = 3;
/** 失败池：节点 id → 逐轮失败记录（归因结果 + 失败输出 tail），聚合裁决的输入 */
const acceptanceFailures = new Map();
/** commit 门禁失败池（deferredCommits 的轮内修复通道）：节点核验已过、仅 commit 被钩子
 *  拒——条目修复成功即从两个数组同步移除，轮内耗尽仍拒才随终态呈报（兜底通道不变） */
const commitGateFailures = [];
let failureFixRounds = 0;
/** disputed 节点集（聚合级反证 + fixer 级拒修）：退出修复循环保持 failed，随终态呈报——
 *  重跑剧本仍会红（没人修它），不重置以免空占轮次 */
const acceptanceDisputedIds = new Set();
/** disputed 呈报清单（round / 聚合条目 id / 来源 / 反证），随终态带出 */
const acceptanceDisputed = [];
function nodeState(id) {
    return state.get(id)?.status ?? "pending";
}
// status.json 读改写串行链：批内多节点并发落地时防读改写交错丢更新
let statusChain = Promise.resolve();
function serializedStatus(fn) {
    const run = statusChain.then(fn, fn);
    statusChain = run.then(() => undefined, () => undefined);
    return run;
}
function normalizeEntry(e) {
    if (typeof e !== "object" || e === null)
        return { status: "pending", attempts: 0 };
    const r = e;
    const st = typeof r.status === "string" && VALID_ENTRY_STATUS.has(r.status) ? r.status : "pending";
    return {
        status: st,
        attempts: typeof r.attempts === "number" ? r.attempts : 0,
        commit: typeof r.commit === "string" ? r.commit : undefined,
        evidence: typeof r.evidence === "string" ? r.evidence : undefined,
    };
}
async function readStatusFile() {
    const text = await readTextViaNode(plan.statusPath);
    if (text === null)
        return null;
    try {
        const parsed = JSON.parse(text);
        if (!isRec(parsed))
            return null;
        const nodes = {};
        if (isRec(parsed.nodes)) {
            for (const k of Object.keys(parsed.nodes))
                nodes[k] = normalizeEntry(parsed.nodes[k]);
        }
        const events = Array.isArray(parsed.events)
            ? parsed.events.filter((e) => isRec(e) && typeof e.node === "string")
            : [];
        const baseline = typeof parsed.baseline === "string" ? parsed.baseline : null;
        const extra = {};
        for (const k of Object.keys(parsed)) {
            if (k !== "baseline" && k !== "nodes" && k !== "events")
                extra[k] = parsed[k];
        }
        return { baseline, nodes, events, extra };
    }
    catch {
        return null;
    }
}
async function statusUpdate(nodeId, entry, event, detail) {
    await serializedStatus(async () => {
        const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [], extra: {} };
        const nodes = { ...st.nodes, [nodeId]: entry };
        const events = [
            ...st.events,
            { seq: st.events.length + 1, node: nodeId, event, detail: detail ?? entry.evidence ?? "" },
        ];
        // schema 外顶层字段（name/updated 等 D0 产物）原样保留（§4.5）
        await writeTextViaNode(plan.statusPath, JSON.stringify({ ...st.extra, baseline: st.baseline, nodes, events }, null, 2));
    });
}
// ── 节点状态流转 helpers（终态即时回写 status.json + 上板） ──
async function beginNode(id) {
    state.set(id, { status: "in-progress", attempts: 0 });
    await statusUpdate(id, { status: "in-progress", attempts: 0 }, "dispatch");
    report({ id, state: "in-progress", detail: "" }, "nodes");
}
async function finishNodeDone(id, attempts, commit, evidence) {
    state.set(id, { status: "done", attempts, commit });
    await statusUpdate(id, { status: "done", attempts, commit, evidence }, "done", evidence + (commit !== undefined ? `；commit=${commit}` : ""));
    report({ id, state: "done", detail: commit !== undefined ? commit.slice(0, 8) : evidence.slice(0, 40) }, "nodes");
}
async function markNodeBlockedOrFailed(id, st, reason, detail, attempts) {
    state.set(id, { status: st, attempts, reason, detail });
    const evidence = detail !== "" ? `${reason}；输出：${tailLines(detail, TAIL_LINES)}` : reason;
    await statusUpdate(id, { status: st, attempts, evidence }, st);
    report({ id, state: "failed", detail: reason }, "nodes");
    log(`节点 ${id} ${st === "failed" ? "验收失败" : "blocked"}：${reason}`);
}
// ── 验收自愈（设计 §8.7）：verify fail → 归因 → 分流 → 修资产重验 / 依赖可达性判定 ──
// ── 结构化返回校验回喂（用户裁决 2026-09-26：全部 agent 结构化返回必备，回喂重试上限 3 次）──
// rawAsk 由调用方闭包提供（用各自具体类型调 ask——pi 构建管线按泛型名查 SCHEMA_BY_KEY，
// 帮手内不能出现平台 ask 的泛型调用）；回喂 prompt 自包含重发原指令（pi 侧每次新 agent）。
const STRUCTURED_RETRY_MAX = 3;
async function askValidated(validate, rawAsk, prompt) {
    let last = await rawAsk(prompt);
    for (let i = 1; i <= STRUCTURED_RETRY_MAX; i++) {
        const v = validate(last);
        if (v.ok)
            return v.value;
        last = await rawAsk([
            `你上一轮的结构化返回未通过机器校验，错误清单：`,
            ...v.errors.map((e) => `- ${e}`),
            ``,
            `重新返回完整 JSON（全量重新给出，不是增量补丁；除该 JSON 外不要改任何已落盘产物）。`,
            ``,
            `（同一子代理续写——完整任务上下文见前文对话，无需重述任务。你的任务开头摘录：${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}）`,
        ].join("\n"));
    }
    const fin = validate(last);
    return fin.ok ? fin.value : null;
}
function validateNodeResult(v) {
    const o = typeof v === "object" && v !== null ? v : {};
    const errors = [];
    if (o["status"] !== "done" && o["status"] !== "fail" && o["status"] !== "blocked")
        errors.push("status 须为 done|fail|blocked");
    if (!isStrArr(o["files_changed"]))
        errors.push("files_changed 须为字符串数组");
    if (typeof o["test_evidence"] !== "string")
        errors.push("test_evidence 须为字符串");
    if (!isStrArr(o["deviations"]))
        errors.push("deviations 须为字符串数组");
    if (!isStrArr(o["blockers"]))
        errors.push("blockers 须为字符串数组");
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
}
function validateInspectResult(v) {
    const o = typeof v === "object" && v !== null ? v : {};
    const errors = [];
    if (o["verdict"] !== "pass" && o["verdict"] !== "fail" && o["verdict"] !== "degraded")
        errors.push('verdict 须为 "pass"|"fail"|"degraded"');
    if (typeof o["test_evidence"] !== "string")
        errors.push("test_evidence 须为字符串");
    if (!isStrArr(o["deviations"]))
        errors.push("deviations 须为字符串数组");
    if (!isStrArr(o["blockers"]))
        errors.push("blockers 须为字符串数组");
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
}
/**
 * inspect done 的事实锚（等价 dev 节点的 commit 锚）：判定书固定落
 * `<artifactsDir>/verdict.json`，结论词（verdict|status 字段任一）与结构化返回一致才
 * 认通过——单靠结构化自报无第二证据时，「执行完成」语义会再次遮蔽「验收结论」
 * （本次修复的根因形态）。文件缺失 / 不可解析 / 结论不一致 = 锚不成立。
 * artifactsDir 为空按锚通过（exec-plan 校验已要求 inspect 带 artifactsDir，防御性宽容）。
 */
/** verdict.json 事实锚读取（严格 JSON.parse，2026-11-04 结构化改造——旧正则提值取文件里
 *  第一个 verdict/status 同名键，判定书含嵌套同名键时取错值、合法通过被误拒）。只认
 *  顶层 verdict 键（缺失回退顶层 status 键），解析失败/值非 pass|degraded = 锚不成立，
 *  fail 方向安全 */
async function readVerdictAnchorVerdict(artifactsDir) {
    const raw = await readTextViaNode(`${artifactsDir}/verdict.json`);
    if (raw === null)
        return null;
    try {
        const o = JSON.parse(raw);
        if (o === null || typeof o !== "object" || Array.isArray(o))
            return null;
        const rec = o;
        const v = typeof rec["verdict"] === "string" ? rec["verdict"] : typeof rec["status"] === "string" ? rec["status"] : "";
        const lower = v.toLowerCase();
        return lower === "pass" || lower === "degraded" ? lower : null;
    }
    catch {
        return null;
    }
}
async function inspectVerdictAnchorOk(node, expected) {
    if (node.artifactsDir === "")
        return true;
    return (await readVerdictAnchorVerdict(node.artifactsDir)) === expected;
}
function validateHealVerdict(v) {
    const o = typeof v === "object" && v !== null ? v : {};
    const errors = [];
    if (o["class"] !== "spec-bug" && o["class"] !== "product-bug" && o["class"] !== "environment")
        errors.push('class 须为 "spec-bug"|"product-bug"|"environment"');
    if (typeof o["evidence"] !== "string")
        errors.push("evidence 须为字符串");
    if (!isStrArr(o["failureFiles"]))
        errors.push("failureFiles 须为字符串数组");
    if (typeof o["fixHint"] !== "string")
        errors.push("fixHint 须为字符串（可空串）");
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
}
function validateHealFixReport(v) {
    const o = typeof v === "object" && v !== null ? v : {};
    const errors = [];
    if (!isStrArr(o["fixed"]))
        errors.push("fixed 须为字符串数组");
    if (typeof o["summary"] !== "string")
        errors.push("summary 须为字符串");
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
}
/** 修复自报摘要（自报仅供历史记录，重验由引擎机器判定；null = 3 次回喂重试仍不合规）。 */
function summarizeHealFix(v) {
    if (v === null)
        return `自报 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规（引擎仍会机器重验）`;
    return `${v.fixed.join("、") || "（无自报文件）"}${v.summary !== "" ? `——${v.summary}` : ""}`;
}
/** DAG 后继闭包（直接或传递依赖本节点的全部节点）——依赖可达性熔断的机器判据。 */
function successorsOf(id) {
    const out = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const n of plan.nodes) {
            if (n.deps.includes(cur) && !seen.has(n.id)) {
                seen.add(n.id);
                out.push(n.id);
                queue.push(n.id);
            }
        }
    }
    return out;
}
async function runVerifyScript(node) {
    // 解释器按扩展名分派：.sh → bash，其余（.mjs/.js/.cjs）→ node——node 剧本走 bash 必炸
    // （import 语句报 command not found，2026-09-26 W1 验收实测）
    const interpreter = node.script.endsWith(".sh") ? "bash" : "node";
    const r = await world.run("node", ["-e", RUN_IN_CWD, interpreter, node.cwd, node.script], {
        timeoutMs: VERIFY_SCRIPT_TIMEOUT_MS,
    });
    return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}` };
}
/** 归因 agent（§8.7 ①）：三分类 + 证据 + 失败相关文件集；自愈历史回喂（跨轮记忆）。
 *  返回 3 次回喂重试仍不合规时保守按 product-bug（不修验收资产，直接依赖判定）。 */
async function diagnoseVerifyFailure(node, run, history, round) {
    // 名字带轮次：自愈循环每轮调用本函数，run 内 agent 名唯一——同名二建直接杀 run；
    // 每轮新 agent + history 显式回喂，与 pi 侧（每次新 agent）行为对齐
    // 名字掺全局修复轮（failureFixRounds）：节点经修复环重置重派后本函数重入，run 内
    // agent 名必须唯一——同名二建直接杀 run（见 askValidated 注释块契约）
    const diag = wfAgent(`诊断-${node.id}-f${failureFixRounds}-r${round}`, DIAGNOSE_PERSONA);
    const prompt = [
        `验收节点 ${node.id} 的剧本执行失败，请归因（只读分析）。`,
        `- 剧本：${node.script}（cwd ${node.cwd}）；本次退出码 ${run.exitCode}`,
        `- 失败输出（tail）：\n${tailLines(run.output, TAIL_LINES)}`,
        `- 完整日志与产物在剧本同目录（*.log / RESULT* / diag JSON）与产物目录 ${node.artifactsDir}`,
        history.length > 0
            ? `- 本节点自愈历史（前几轮归因与修复，均已重验仍红——本轮归因必须解释为何未收敛）：\n${history.join("\n")}`
            : "",
        "",
        "归类三选一（class 字段）：",
        '- spec-bug：验收资产自身缺陷（断言口径错 / 等待时序错 / 窗口失配 / 剧本 bug）——failureFiles 填验收资产文件，fixHint 给修复要点',
        '- product-bug：被测产品实现缺陷——failureFiles 填产品文件（只读呈报，不会被修复）',
        "- environment：超时 / 资源 / 环境类失败（非断言红）",
        "",
        '返回 JSON：{ "class": "spec-bug"|"product-bug"|"environment", "evidence": "一句话证据（引用失败输出原文）", "failureFiles": ["文件路径"], "fixHint": "修复要点（可空串）" }',
    ]
        .filter((s) => s !== "")
        .join("\n");
    const validated = await askValidated(validateHealVerdict, (p) => diag.ask("HealVerdict", p), prompt);
    if (validated !== null)
        return validated;
    log(`WARN: 节点 ${node.id} 归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按 product-bug 处理`);
    return {
        class: "product-bug",
        evidence: `归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按产品缺陷处理（不修验收资产）`,
        failureFiles: [],
        fixHint: "",
    };
}
// ── 测试命令白名单通道（program 字面量分支——编译期命令集可见；cwd 经 node -e 参数传入） ──
async function runTestCommand(cmd, cwd) {
    switch (cmd.program) {
        case "pnpm":
            return world.run("node", ["-e", RUN_IN_CWD, "pnpm", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
        case "npm":
            return world.run("node", ["-e", RUN_IN_CWD, "npm", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
        case "node":
            return world.run("node", ["-e", RUN_IN_CWD, "node", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
        case "git":
            return world.run("node", ["-e", RUN_IN_CWD, "git", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
        case "bash":
            return world.run("node", ["-e", RUN_IN_CWD, "bash", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
        default:
            return null;
    }
}
// ── dev 节点确定性核验（三查） ──
async function verifyDevNode(node, result, attempts) {
    // 查三：blockers 自报非空 → blocked（环境/任务书问题，定向修不可解，不进打回）
    if (result.blockers.length > 0) {
        return { outcome: "blocked", reason: "任务书自报 blockers", detail: result.blockers.join("；") };
    }
    if (result.status !== "done") {
        return { outcome: "retry", reason: `自报 status=${result.status}`, detail: result.test_evidence || "（无自测证据）" };
    }
    // 查一级（对账语义，2026-09-29 裁决范围声明降级）：自报 files_changed 超出声明范围的
    // 路径不再打回——运行时逐文件拦截实测零命中真越权、反造成扩展死锁等损耗（u3 声明范围
    // 扩展死等 35.9min）；多开发/少开发的一致性由 D2 一致性审查与终态残留对账承接。
    // commit 照常按自报精确路径执行（与声明范围无关），此处只登记对账事件
    const outside = result.files_changed.filter((f) => !pathInTerritory(f, node.territory));
    if (outside.length > 0) {
        log(`WARN: 节点 ${node.id} 自报改动含声明范围外路径 ${outside.length} 项（${outside.slice(0, 5).join("、")}${outside.length > 5 ? " 等" : ""}）——不打回，登记对账随终态呈报`);
        await statusUpdate(node.id, { status: "in-progress", attempts }, "territory-outside", `第 ${attempts} 轮自报声明范围外改动（对账呈报，不打回；多轮重验按轮各登记一笔）：${outside.join("、")}`);
    }
    // 查二级（粗粒度）：引擎另跑全量 status，观察清单外残留——只登记不拦截（2026-09-26
    // 用户裁决：并行单元运行中新建的文件天然不在启动时载入的静态声明范围里，把「别人的
    // 改动」判为当前单元越界是连坐——曾致 d3 被兄弟单元 7 个残留文件卡死、u5/u2a 互卡
    // 成对 blocked。本节点只对自己的纪律负责（查一改动对账登记 + 查二测试绿）；全工作
    // 区残留统一由收尾对账呈报主 agent 处理，防漏报价值由终态呈报承接）
    const porcelain = await gitPorcelainViaNode(node.cwd);
    if (porcelain === null) {
        return { outcome: "blocked", reason: "git status --porcelain 执行失败（引擎层）", detail: `cwd=${node.cwd}` };
    }
    const activeTerr = activeTerrByCwd.get(node.cwd) ?? [];
    const strays = parsePorcelain(porcelain).filter((f) => !isTmpArtifact(f) && !pathInTerritory(f, activeTerr) && !declaredFiles.has(f));
    if (strays.length > 0) {
        log(`WARN: 工作区存在清单外未提交改动 ${strays.length} 项（${strays.slice(0, 5).join("、")}${strays.length > 5 ? " 等" : ""}）——多为并行单元新建文件，不阻塞本节点，收尾统一呈报`);
    }
    // 查二：节点测试命令重跑（program+args，cwd=节点 cwd），断言退出码 0
    const tr = node.testCommand === null ? null : await runTestCommand(node.testCommand, node.cwd);
    if (tr === null) {
        return {
            outcome: "blocked",
            reason: `测试命令 program 不在白名单（${TEST_WHITELIST.join("/")}）：${node.testCommand?.program ?? "(无)"}`,
            detail: "exec-plan 编译错误——启动校验已拦截，此处为防御分支",
        };
    }
    if (tr.exitCode !== 0) {
        return {
            outcome: "retry",
            reason: `节点测试命令退出码 ${tr.exitCode}`,
            detail: tailLines(`${tr.stdout}\n${tr.stderr}`, TAIL_LINES),
        };
    }
    return { outcome: "pass", reason: "核验通过", detail: "" };
}
// ── 三类节点执行体 ──
/** agent ask 的接替包装（设计 §6.2 F15 第一等路径）：结构化返回不合规（3 次回喂重试后）
 *  或会话异常 → 第二顺位 actor + 前任证据包 + 当前 git diff --stat，令其先核验现状再续作，禁止
 *  盲目重做；第二顺位仍不合规 / 再异常才返回 null（调用方 blocked）。两参只承载顺位语义：
 *  返回值 byBackup = 结果由第二顺位（接替路径）产出，调用方据此交换后续轮顺位（接替者持有
 *  本轮修复上下文，打回轮先回到它）。注意 actor 引用在 executeDevNode 开头一次性创建——
 *  同名续聊 = 单 actor 多次 ask，每次 ask 都调 agent(name) 会创建同名新 actor，run 直接炸
 *  （冒烟实测） */
async function askWithSuccession(lead, backup, prompt, node, lastResult) {
    let failReason = "";
    try {
        const r = await askValidated(validateNodeResult, (p) => lead.ask("NodeResult", p), prompt);
        if (r !== null)
            return { result: r, byBackup: false };
        failReason = `结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`;
    }
    catch (e) {
        failReason = errText(e);
    }
    const diff = await world.run("node", ["-e", GIT_DIFF_STAT, node.cwd]);
    const pack = [
        `前任 agent 会话异常或返回不合规（${failReason}）——你是接替者，先核验现状再续作，禁止盲目重做已完成的改动：`,
        `- 前任最后自报：files_changed = ${lastResult?.files_changed.join("、") ?? "（无）"}`,
        `  test_evidence = ${lastResult?.test_evidence ?? "（无）"}；deviations = ${lastResult?.deviations.join("；") || "无"}`,
        `- 当前 git diff --stat（工作区现状）：`,
        diff.stdout.trim() === "" ? "  （工作区无未提交改动——前任可能尚未落盘任何文件）" : diff.stdout.trim(),
        `- 任务书：${node.promptFile}`,
        ``,
        `先 read 任务书，再核对上述现状，判断前任已完成什么/缺什么，续作完成后返回任务书末尾定义的同一 JSON 契约。`,
        ``,
        `（前任本次收到的原始指令如下——含打回场景的核验失败原因与失败输出，按需定向处理：）`,
        prompt,
    ].join("\n");
    log(`节点 ${node.id} agent 会话异常或返回不合规（${failReason}），启动接替程序`);
    const r2 = await askValidated(validateNodeResult, (p) => backup.ask("NodeResult", p), pack);
    return r2 === null ? null : { result: r2, byBackup: true };
}
async function executeDevNode(node) {
    await beginNode(node.id);
    // 同名续聊承载打回：actor 一次性创建、多次 ask（同一 subagent 队列天然保持会话上下文）；
    // 接替 actor 预创建（仅异常时使用——创建即占名，名字唯一性由节点 id 保证）。
    // agent( 只在创建处调用、向下传引用——zcode GUI 泳道按字面 agent( 调用点做静态分析，
    // 包装函数会遮蔽调用点使泳道失明
    const primaryAgent = wfAgent(`node-${node.id}`, DEV_PERSONA);
    const succAgent = wfAgent(`接替-${node.id}`, DEV_PERSONA);
    // 当前活跃顺位：第一顺位初始 = 原名 agent；某轮结果由接替者产出后交换——接替者持有本轮
    // 修复上下文，后续打回轮先回到它，原 primary 退居接替路径（否则打回轮回到没有接替者
    // 上下文的原名 agent，上下文回退）
    let leadAgent = primaryAgent;
    let backupAgent = succAgent;
    // 首轮指令提为变量，供打回轮前情拼接（pi 侧 withPrevContext 消费——zcode 同名续聊天然承载）
    const initialPrompt = `读取任务书 ${node.promptFile}（绝对路径）并按其完整执行，返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers，可含 summary）。files_changed 用相对工作区 git 仓库根的路径（git status 风格）。`;
    let ask = await askWithSuccession(leadAgent, backupAgent, initialPrompt, node, null);
    if (ask === null) {
        await markNodeBlockedOrFailed(node.id, "blocked", `结构化返回经接替仍不合规（${STRUCTURED_RETRY_MAX} 次回喂重试 × 主/接替两路径）`, "任务书可读，接管前先核对 git status 盘点前任落盘", 1);
        return;
    }
    let result = ask.result;
    if (ask.byBackup) {
        const t = leadAgent;
        leadAgent = backupAgent;
        backupAgent = t;
        log(`节点 ${node.id} 本轮结果由接替者产出，后续轮以接替者为第一顺位（原 primary 退为接替路径）`);
    }
    let attempts = 1;
    let verdict = await verifyDevNode(node, result, attempts);
    while (verdict.outcome === "retry" && attempts <= MAX_REJECT_ROUNDS) {
        log(`节点 ${node.id} 核验未过（${verdict.reason}），打回定向修`);
        ask = await askWithSuccession(leadAgent, backupAgent, withPrevContext(initialPrompt, result, `引擎确定性核验未通过（原因：${verdict.reason}）。按以下失败输出定向修复；修复调试期只重跑失败的测试文件定位问题（禁止每轮全套复跑），全套复跑仅在最终交付前执行一次。完成并自证通过后重新返回同一 JSON 契约：\n${verdict.detail}`), node, result);
        if (ask === null) {
            await markNodeBlockedOrFailed(node.id, "blocked", `打回轮结构化返回经接替仍不合规（${STRUCTURED_RETRY_MAX} 次回喂重试 × 主/接替两路径）`, `上一轮核验未过原因：${verdict.reason}`, attempts);
            return;
        }
        result = ask.result;
        if (ask.byBackup) {
            const t = leadAgent;
            leadAgent = backupAgent;
            backupAgent = t;
            log(`节点 ${node.id} 本轮结果由接替者产出，后续轮以接替者为第一顺位（原 primary 退为接替路径）`);
        }
        attempts += 1;
        await statusUpdate(node.id, { status: "in-progress", attempts }, "reject-round", verdict.reason);
        verdict = await verifyDevNode(node, result, attempts);
    }
    if (verdict.outcome === "pass") {
        // commit 三要素保真（§8.3）：unitId（模板）+ designRef（章节锚前置，summary 已含则不重复
        // 前置——冒烟实测 dev 常在 summary 自带章节号）+ summary（promptFile 契约要求末行含「测试：<命令> 绿」）
        const summary = result.summary ?? "dev 单元交付";
        const summaryWithRef = node.designRef !== "" && !summary.includes(node.designRef) ? `${node.designRef} ${summary}` : summary;
        const message = buildCommitMessage(plan.commitTemplate, node.id, summaryWithRef, activeRunId);
        const cr = await gitAddCommitViaNode(node.cwd, message, result.files_changed);
        for (const f of result.files_changed)
            declaredFiles.add(f);
        if (!cr.ok) {
            // commit 被拒不 blocked：核验已过、编码成果有效；拒因多为仓库 pre-commit 钩子的
            // 全仓检查看到并行兄弟单元的半成品（钩子要求「当场修复」，而修那些文件超出本
            // 节点范围声明纪律——节点内无解）。双通道：统一失败处理中心轮内修（门禁合规类：
            // 豁免标记/清单登记/常量化——修复环重试 commit 机器重验）；轮内修不动仍留
            // deferredCommits 随终态呈报主 agent 代提交（钩子照常执行）
            deferredCommits.push({ id: node.id, message, files: result.files_changed, err: cr.err });
            commitGateFailures.push({ nodeIds: [node.id], message, files: result.files_changed, err: cr.err, round: failureFixRounds + 1 });
            const evidence = `${result.test_evidence}；deviations: ${result.deviations.join("；") || "无"}；commit 待主 agent 代提交（被拒输出见 event）`;
            state.set(node.id, { status: "done", attempts });
            await statusUpdate(node.id, { status: "done", attempts, evidence }, "commit-deferred", `核验通过但 commit 被拒（多为仓库钩子全仓检查 × 并行半成品，节点内无解）：${message}`);
            report({ id: node.id, state: "done", detail: "commit-deferred" }, "nodes");
            log(`节点 ${node.id} 核验通过，commit 被拒转待办（收尾由主 agent 代提交）`);
            return;
        }
        const evidence = `${result.test_evidence}；deviations: ${result.deviations.join("；") || "无"}`;
        await finishNodeDone(node.id, attempts, cr.hash, evidence);
        log(`节点 ${node.id} 核验通过，已提交（${cr.hash.slice(0, 8)}）`);
        return;
    }
    if (verdict.outcome === "blocked") {
        await markNodeBlockedOrFailed(node.id, "blocked", verdict.reason, verdict.detail, attempts);
        return;
    }
    await markNodeBlockedOrFailed(node.id, "blocked", `打回超限仍未通过：${verdict.reason}`, verdict.detail, attempts);
    log(`节点 ${node.id} 打回超限（共 ${attempts} 次尝试），标记 blocked，后继挂起`);
}
async function executeVerifyNode(node) {
    await beginNode(node.id);
    // 剧本由 D0 预编译，引擎只执行断言退出码；bash 白名单分支 + cwd 参数化。
    // fail → run 内自愈循环（§8.7）：归因 → spec-bug 修验收资产重验 / product-bug 不修 /
    // environment 重试一次；不收敛按依赖可达性判定（卡后继 = 熔断上报；不卡 = 跳过跑完上报）
    let run = await runVerifyScript(node);
    let attempt = 1;
    const healHistory = [];
    // 名字掺全局修复轮：修复环重置重派后重入须换名（同名二建杀 run）；节点内自愈多轮靠
    // 单引用多次 ask 续聊承载上下文（pi 侧靠 healHistory 回喂）
    const healer = wfAgent(`修复-${node.id}-f${failureFixRounds}`, HEAL_PERSONA);
    while (run.exitCode !== 0) {
        const verdict = await diagnoseVerifyFailure(node, run, healHistory, attempt);
        healHistory.push(`第 ${attempt} 轮归因 ${verdict.class}：${verdict.evidence}`);
        if (verdict.class === "spec-bug" && attempt < MAX_HEAL_ROUNDS) {
            const fix = await askValidated(validateHealFixReport, (p) => healer.ask("HealFixReport", p), [
                `验收节点 ${node.id} 的失败归因为 spec-bug（验收资产自身缺陷），请修复验收资产。`,
                `- 归因证据：${verdict.evidence}`,
                `- 归因指向的验收资产文件：${verdict.failureFiles.join("、") || node.script}`,
                `- 修复要点：${verdict.fixHint !== "" ? verdict.fixHint : "（归因未给——按证据自行判定）"}`,
                `- 失败输出（tail）：\n${tailLines(run.output, TAIL_LINES)}`,
                healHistory.length > 1 ? `- 历史修复（均已重验仍红——不要重复无效修复，换思路或修正归因未覆盖的口径）：\n${healHistory.join("\n")}` : "",
                `只改上述验收资产文件（禁止产品代码）；修复后引擎会原样重跑剧本（${node.script}）机器判定，不采信自报。`,
                '返回 JSON：{ "fixed": ["实际修改的文件"], "summary": "一句话修复说明" }',
            ]
                .filter((s) => s !== "")
                .join("\n"));
            healHistory.push(`  修复：${summarizeHealFix(fix)}`);
            attempt += 1;
            await statusUpdate(node.id, { status: "in-progress", attempts: attempt }, "heal-round", `spec-bug 修复后重验（第 ${attempt - 1} 轮自愈）：${verdict.evidence}`);
            run = await runVerifyScript(node);
            continue;
        }
        if (verdict.class === "environment" && attempt === 1) {
            attempt += 1;
            await statusUpdate(node.id, { status: "in-progress", attempts: attempt }, "heal-retry", `environment 类失败重试一次：${verdict.evidence}`);
            run = await runVerifyScript(node);
            continue;
        }
        // product-bug（fixer 可修产品代码——2026-10-31 修订 2026-09-26 裁决，防线 = 归因/修复
        // 分角色 + 重验机器判定 + disputed 反证）或 spec-bug 自愈不收敛 / environment 重试仍红
        // → 入失败池（acceptance 模式由修复循环聚合修复后重验；dev 模式维持依赖可达性熔断）
        recordAcceptanceFailure(node, "verify", verdict.class, verdict.evidence, verdict.failureFiles, verdict.fixHint, run.output);
        const mode = "入统一失败处理中心（聚合裁决 → 修复组 → 机器重验；同轮其他分支照跑，轮耗尽才按可达性判定）";
        await markNodeBlockedOrFailed(node.id, "failed", `验收失败（${verdict.class}，${attempt} 次尝试；${mode}）：${verdict.evidence}`, [
            tailLines(run.output, TAIL_LINES),
            verdict.failureFiles.length > 0 ? `归因指向：${verdict.failureFiles.join("、")}` : "",
            `自愈历史：\n${healHistory.join("\n")}`,
        ]
            .filter((s) => s !== "")
            .join("\n"), attempt);
        return;
    }
    if (healHistory.length > 0)
        log(`Verify 节点 ${node.id} 经 ${attempt - 1} 轮自愈后收敛`);
    const artOk = await existsViaNode(node.artifactsDir);
    if (!artOk) {
        await markNodeBlockedOrFailed(node.id, "failed", `产物目录不存在：${node.artifactsDir}`, "脚本 exit 0 但 artifactsDir 缺失", Math.max(attempt, 1));
        return;
    }
    await finishNodeDone(node.id, Math.max(attempt, 1), undefined, `verify exit 0；产物目录 ${node.artifactsDir}`);
    log(`Verify 节点 ${node.id} 脚本退出 0，产物目录存在，通过`);
}
async function executeInspectNode(node) {
    await beginNode(node.id);
    // 名字掺全局修复轮：修复环重置重派后重入须换名（同名二建杀 run）
    const nodeAgent = wfAgent(`验收-${node.id}-f${failureFixRounds}`, INSPECT_PERSONA);
    // artifactsRefs 校验过后必须进任务书——否则存在性校验成纯摆设，agent 不知可读哪些上游产物
    const refLines = node.artifactsRefs.length > 0
        ? [
            "",
            "上游产物引用（校验已就绪，可直接读取）：",
            ...node.artifactsRefs.flatMap((r) => {
                const vn = plan.nodes.find((x) => x.id === r);
                return vn !== undefined && vn.kind === "verify" && vn.artifactsDir !== "" ? [`- ${r} → ${vn.artifactsDir}`] : [];
            }),
        ]
        : [];
    const result = await askValidated(validateInspectResult, (p) => nodeAgent.ask("InspectResult", p), `读取验收任务书 ${node.promptFile}（绝对路径）并按其完整执行（只检查，不修改代码、不产生 commit），返回该文件末尾定义的 JSON 契约（verdict: "pass"|"fail"|"degraded" / test_evidence / deviations / blockers），并把判定书 JSON 写入 ${node.artifactsDir}/verdict.json（文件内 verdict 字段必须与结构化返回一致——引擎以此文件为 done 的事实锚）。${refLines.join("\n")}`);
    if (result === null) {
        await markNodeBlockedOrFailed(node.id, "blocked", `inspect 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`, "任务书可读，接管前先核对上游产物", 1);
        return;
    }
    if (result.blockers.length > 0) {
        await markNodeBlockedOrFailed(node.id, "blocked", "任务书自报 blockers", result.blockers.join("；"), 1);
        return;
    }
    if (result.verdict === "fail") {
        // inspect fail 先归因再入失败池（verify 同款三分类——无归因直接 failed 会让修复循环
        // 拿不到 failureFiles/fixHint，聚合修复失去输入）；归因不合规保守按 product-bug 进池
        const dv = await diagnoseInspectFailure(node, result.test_evidence);
        recordAcceptanceFailure(node, "inspect", dv.class, dv.evidence, dv.failureFiles, dv.fixHint, result.test_evidence);
        await markNodeBlockedOrFailed(node.id, "failed", `inspect 验收结论 fail（归因 ${dv.class}；入统一失败处理中心）：${dv.evidence}`, result.test_evidence, 1);
        return;
    }
    // pass/degraded 收 done 前核判定书锚：结构化自报与落盘判定文件一致才算数——
    // verdict 词表已与执行语义解耦，此锚再挡「agent 口头 pass、文件 FAIL」的残余假绿通道
    if (!(await inspectVerdictAnchorOk(node, result.verdict))) {
        await markNodeBlockedOrFailed(node.id, "failed", `inspect 结构化 verdict=${result.verdict} 但 ${node.artifactsDir}/verdict.json 缺失或结论不一致——事实锚不成立，按失败处理`, result.test_evidence, 1);
        return;
    }
    await finishNodeDone(node.id, 1, undefined, (result.verdict === "degraded" ? "[DEGRADED] " : "") + result.test_evidence);
    log(`Inspect 节点 ${node.id} 验收结论 ${result.verdict}${result.verdict === "degraded" ? "（降级通过，evidence 已标注）" : "（判定书锚核对一致）"}`);
}
// ── D3 验收失败修复循环（review-fix-loop 形态；仅 acceptance 模式）──
/** 失败入池（verify/inspect 的 failed 分支调用；round 用当前修复轮+1 标记首见轮） */
function recordAcceptanceFailure(node, kind, cls, evidence, failureFiles, fixHint, output) {
    const arr = acceptanceFailures.get(node.id) ?? [];
    arr.push({ round: failureFixRounds + 1, kind, cls, evidence, failureFiles, fixHint, tail: tailLines(output, TAIL_LINES) });
    acceptanceFailures.set(node.id, arr);
}
/** inspect fail 归因（与 verify 的 diagnoseVerifyFailure 同契约，输入 = 判定证据文本）。
 *  返回不合规保守按 product-bug（与 verify 归因的兜底一致）。 */
async function diagnoseInspectFailure(node, testEvidence) {
    const diag = wfAgent(`诊断-${node.id}-i${failureFixRounds + 1}`, DIAGNOSE_PERSONA);
    const prompt = [
        `验收节点 ${node.id}（inspect：按任务书真机判定）的验收结论为 fail，请归因（只读分析）。`,
        `- 任务书：${node.promptFile}；判定书（verdict.json）与产物在 ${node.artifactsDir}`,
        `- 验收 agent 给出的失败证据：\n${tailLines(testEvidence, TAIL_LINES)}`,
        "",
        "归类三选一（class 字段）：",
        '- spec-bug：验收资产自身缺陷（断言口径错 / 等待时序错 / 窗口失配 / 剧本 bug）——failureFiles 填验收资产文件，fixHint 给修复要点',
        "- product-bug：被测产品实现缺陷——failureFiles 填产品文件，fixHint 给修复要点",
        "- environment：超时 / 资源 / 环境类失败（非断言红）",
        "",
        '返回 JSON：{ "class": "spec-bug"|"product-bug"|"environment", "evidence": "一句话证据（引用失败证据原文）", "failureFiles": ["文件路径"], "fixHint": "修复要点（可空串）" }',
    ].join("\n");
    const validated = await askValidated(validateHealVerdict, (p) => diag.ask("HealVerdict", p), prompt);
    if (validated !== null)
        return validated;
    log(`WARN: inspect 节点 ${node.id} 归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按产品缺陷处理`);
    return {
        class: "product-bug",
        evidence: `归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按产品缺陷处理`,
        failureFiles: [],
        fixHint: "",
    };
}
/** 聚合裁决 fail-closed 校验器工厂（依赖失败节点集合，闭包捕获）：
 *  ① 每个失败节点至少被一条 item 覆盖（禁止静默丢弃）② fix 条目被 groups 恰好覆盖一次
 *  ③ 组间 files 不相交（并行修复禁改同一文件）④ disputed 须非空根因（反证留痕） */
function makeAcceptanceAggValidator(failedIds) {
    return (v) => {
        const o = typeof v === "object" && v !== null ? v : {};
        const errors = [];
        if (!Array.isArray(o["items"]))
            return { ok: false, errors: ["items 须为数组"] };
        if (!Array.isArray(o["groups"]))
            return { ok: false, errors: ["groups 须为数组"] };
        const items = o["items"];
        const groups = o["groups"];
        const seenIds = new Set();
        for (const it of items) {
            if (typeof it["id"] !== "string" || it["id"] === "")
                errors.push("item.id 须为非空字符串");
            else if (seenIds.has(it["id"]))
                errors.push(`item.id 重复：${it["id"]}`);
            else
                seenIds.add(it["id"]);
            if (!isStrArr(it["nodeIds"]) || it["nodeIds"].length === 0)
                errors.push(`item ${it["id"]}：nodeIds 须为非空字符串数组`);
            else
                for (const nid of it["nodeIds"])
                    if (!failedIds.includes(nid))
                        errors.push(`item ${it["id"]}：nodeIds 含未知/已 disputed 节点 ${nid}（幻觉 ref）`);
            if (it["action"] !== "fix" && it["action"] !== "disputed")
                errors.push(`item ${it["id"]}：action 须为 "fix"|"disputed"`);
            if (typeof it["title"] !== "string")
                errors.push(`item ${it["id"]}：title 须为字符串`);
            if (typeof it["rootCause"] !== "string" || it["rootCause"] === "")
                errors.push(`item ${it["id"]}：rootCause 须为非空字符串（disputed 时即反证）`);
            if (!isStrArr(it["files"]))
                errors.push(`item ${it["id"]}：files 须为字符串数组`);
            if (it["action"] === "fix" && Array.isArray(it["files"]) && it["files"].length === 0)
                errors.push(`item ${it["id"]}：action=fix 但 files 为空（修复组需要预期改动文件做判交）`);
            if (typeof it["guidance"] !== "string")
                errors.push(`item ${it["id"]}：guidance 须为字符串（fix 时为修复指导）`);
        }
        const covered = new Set(items.flatMap((it) => (isStrArr(it["nodeIds"]) ? it["nodeIds"] : [])));
        const missing = failedIds.filter((id) => !covered.has(id));
        if (missing.length > 0)
            errors.push(`以下失败节点未被任何聚合条目覆盖（禁止静默丢弃）：${missing.join("、")}`);
        // 同节点 action 冲突：disputed 与 fix 并存时该节点既被呈报人工又进修复组——修复落盘
        // 但重置被排除，终态错误（已修复未重验仍按 failed 呈报），回喂聚合重裁
        const fixCovered = new Set(items.filter((it) => it["action"] === "fix").flatMap((it) => (isStrArr(it["nodeIds"]) ? it["nodeIds"] : [])));
        const conflicted = [...covered].filter((id) => fixCovered.has(id) && items.some((it) => it["action"] === "disputed" && isStrArr(it["nodeIds"]) && it["nodeIds"].includes(id)));
        if (conflicted.length > 0)
            errors.push(`以下节点同时被 fix 与 disputed 条目覆盖（每节点只能一种裁决）：${conflicted.join("、")}`);
        const fixIds = new Set(items.filter((it) => it["action"] === "fix").map((it) => it["id"]));
        const groupedCount = new Map();
        const groupFiles = [];
        for (const g of groups) {
            if (typeof g["id"] !== "string" || g["id"] === "")
                errors.push("group.id 须为非空字符串");
            if (!isStrArr(g["itemIds"]) || g["itemIds"].length === 0)
                errors.push(`group ${g["id"]}：itemIds 须为非空字符串数组`);
            const ids = (isStrArr(g["itemIds"]) ? g["itemIds"] : []);
            for (const iid of ids) {
                if (!fixIds.has(iid))
                    errors.push(`group ${g["id"]}：itemIds 含非 fix 条目或幻觉 id ${iid}`);
                groupedCount.set(iid, (groupedCount.get(iid) ?? 0) + 1);
            }
            const files = items.filter((it) => ids.includes(it["id"])).flatMap((it) => (isStrArr(it["files"]) ? it["files"] : []));
            groupFiles.push(files);
        }
        for (const [iid, c] of groupedCount)
            if (c > 1)
                errors.push(`fix 条目 ${iid} 被多个组覆盖（恰好一次）`);
        for (const iid of fixIds)
            if (!groupedCount.has(iid))
                errors.push(`fix 条目 ${iid} 未被任何组覆盖（禁止静默丢弃）`);
        for (let i = 0; i < groupFiles.length; i++)
            for (let j = i + 1; j < groupFiles.length; j++) {
                const inter = groupFiles[i].filter((f) => groupFiles[j].includes(f));
                if (inter.length > 0)
                    errors.push(`组 ${i + 1} 与组 ${j + 1} 的 files 相交（${inter.slice(0, 3).join("、")}）——并行修复禁改同一文件，请重新分组`);
            }
        if (fixIds.size > 0 && groups.length === 0)
            errors.push("存在 fix 条目但 groups 为空");
        if (fixIds.size === 0 && groups.length > 0)
            errors.push("无 fix 条目但 groups 非空");
        return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
    };
}
/** fixer 自报校验器工厂（依赖本组条目 id 集）：itemId 归属查 + fixes∩disputed 互斥——
 *  幻觉/他组 itemId 的修复文件会绕过 commitItemIds 过滤混进本组组级 commit（破坏组间
 *  文件不相交）；同条目两边并报时 commit 条目被 disputed 移出池、文件又被组级 commit
 *  排除，修复文件失去全部提交通道静默滞留工作区 */
function makeAcceptanceFixValidator(allowedItemIds) {
    return (v) => {
        const o = typeof v === "object" && v !== null ? v : {};
        const errors = [];
        if (!Array.isArray(o["fixes"]))
            errors.push("fixes 须为数组");
        else
            for (const f of o["fixes"]) {
                if (typeof f["itemId"] !== "string")
                    errors.push("fixes[].itemId 须为字符串");
                else if (!allowedItemIds.has(f["itemId"]))
                    errors.push(`fixes ${f["itemId"]}：itemId 不在本组条目清单（幻觉/他组条目——只申报本组任务文档中的条目）`);
                if (!isStrArr(f["files"]) || f["files"].length === 0)
                    errors.push(`fixes ${f["itemId"]}：files 须为非空字符串数组（无改动走 disputed，不占 fixes）`);
            }
        if (!Array.isArray(o["disputed"]))
            errors.push("disputed 须为数组");
        else
            for (const d of o["disputed"]) {
                if (typeof d["itemId"] !== "string")
                    errors.push("disputed[].itemId 须为字符串");
                else if (!allowedItemIds.has(d["itemId"]))
                    errors.push(`disputed ${d["itemId"]}：itemId 不在本组条目清单（幻觉/他组条目）`);
                if (typeof d["evidence"] !== "string" || d["evidence"] === "")
                    errors.push(`disputed ${d["itemId"]}：evidence 须为非空反证（file:line + 归因漏了什么）`);
            }
        const fixIds = new Set((Array.isArray(o["fixes"]) ? o["fixes"] : []).map((f) => String(f["itemId"])));
        const dupIds = (Array.isArray(o["disputed"]) ? o["disputed"] : []).map((d) => String(d["itemId"])).filter((id) => fixIds.has(id));
        if (dupIds.length > 0)
            errors.push(`条目 ${dupIds.join("、")} 同时出现在 fixes 与 disputed（每条目二选一：修了报 fixes，误报报 disputed）`);
        if (typeof o["selfCheck"] !== "string")
            errors.push("selfCheck 须为字符串（命令: 结果）");
        return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v };
    };
}
/** 统一失败处理中心一轮：聚合裁决 phase → 修复组 phase → 引擎按组 commit + commit
 *  条目重试。ok=false 时调度循环按 fix-failure 语义熔断；resetIds = 本轮应重验（重置
 *  pending）的验收失败节点——修复是组级的，同组连带修复的节点一并重验，由机器判定
 *  裁决谁真正转绿。commit 条目修复成功即从 commitGateFailures 与 deferredCommits 同步
 *  移除（副作用），失败留池下轮（MAX_FAILURE_FIX_ROUNDS 兜底）。 */
async function runFailureFixCycle(round) {
    const failedNodes = plan.nodes.filter((n) => nodeState(n.id) === "failed" && (n.kind === "verify" || n.kind === "inspect") && !acceptanceDisputedIds.has(n.id));
    if (failedNodes.length === 0 && commitGateFailures.length === 0)
        return { ok: true, reason: "", resetIds: [] };
    phase("失败聚合裁决"); // 平台契约：phase 名为编译期字面量（轮次在 log 与产物目录承载）
    log(`第 ${round} 轮失败修复：验收失败 ${failedNodes.map((n) => n.id).join("、") || "无"}；commit 被拒 ${commitGateFailures.map((c) => c.nodeIds.join("、")).join("；") || "无"}${acceptanceDisputedIds.size > 0 ? `（disputed 已排除 ${acceptanceDisputedIds.size} 节点）` : ""}`);
    const failBlocks = [
        ...failedNodes.map((n) => {
            const hist = acceptanceFailures.get(n.id) ?? [];
            const last = hist[hist.length - 1];
            return [
                n.kind === "verify"
                    ? `- 节点 ${n.id}（verify）剧本 ${n.script}（产物目录 ${n.artifactsDir}）`
                    : `- 节点 ${n.id}（inspect）任务书 ${n.promptFile}`,
                `  最新归因：${last?.cls ?? "unknown"}——${last?.evidence ?? ""}`,
                `  归因指向文件：${last?.failureFiles.join("、") || "（未给——按任务书与产物自判）"}`,
                `  修复要点：${last?.fixHint || "（未给）"}`,
                `  失败输出（tail）：\n${String(last?.tail ?? "")
                    .split("\n")
                    .map((l) => `    ${l}`)
                    .join("\n")}`,
                hist.length > 1
                    ? `  历史轮归因（均已修复重验仍红——本轮须换思路，勿重复同款修法）：\n${hist.slice(0, -1).map((h) => `    第${h.round}轮 ${h.cls}：${h.evidence}`).join("\n")}`
                    : "",
            ]
                .filter(Boolean)
                .join("\n");
        }),
        ...commitGateFailures.map((cf) => [
            `- 节点 ${cf.nodeIds.join("、")} 的 commit 被仓库钩子拒绝（核验与测试已过、编码成果有效，仅 commit 未落）`,
            `  原 commit message：${cf.message}`,
            `  待提交文件：${cf.files.join("、")}`,
            cf.round > 1 ? `  （第 ${cf.round} 轮修复后重试仍被拒——换思路，勿重复同款修法）` : "",
            `  被拒输出（tail）：\n${String(cf.err)
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}`,
        ]
            .filter(Boolean)
            .join("\n")),
    ].join("\n\n");
    const aggPrompt = [
        `第 ${round} 轮失败聚合裁决（只读分析，不改任何文件）。失败池两类条目——验收失败节点（修产品代码或验收资产）与 commit 被拒节点（核验已过，只差过仓库钩子：按被拒输出做门禁合规修复——豁免标记 / 清单登记 / 常量化，钩子指出什么合规问题就修什么）。`,
        "",
        "失败条目记录（逐条）：",
        failBlocks,
        "",
        "任务：",
        "1. 跨节点合并同根因（一条聚合条目可覆盖多个节点——保留最强证据，修复指导合并为最具体的一句，将随任务文档直达修复者）；两类条目同根因时可合并为一条，但 guidance 须同时覆盖两类修复动作。",
        '2. 逐条裁决：真实缺陷/可修的钩子合规问题 → action="fix"（files 填预期改动文件，guidance 给具体可执行的修复指导——commit 类条目 guidance 以被拒输出为据）；归因误报/断言本就不该成立/钩子拦的是真代码问题（非合规登记类，超出本轮修复职责）→ action="disputed"（rootCause 写反证——file:line + 归因漏了什么）。',
        "3. 修复分组：fix 条目按文件相关性分组——同文件/同模块/同根因同组（一个修复者修一组）；不同组的 files 必须不相交（组间并行修复互不冲突）；单条独立成组即可，无关联不强行合并。",
        "4. 延续条目（历史轮已修过仍红/仍被拒）优先换思路：guidance 不得复述已失败的修法。",
        "",
        `返回 JSON：{ items: [{ id: "AF-${round}-<序>", nodeIds: ["节点id"], title, action: "fix"|"disputed", rootCause, files: ["文件"], guidance }], groups: [{ id: "AG-<序>", itemIds: ["AF-..."], note }] }——每个失败节点至少被一条 item 覆盖（两类条目都算）；action=fix 的条目恰好被一个 group 覆盖；无 fix 条目时 groups=[]。`,
    ].join("\n");
    // 构造外提（契约见 askValidated 注释块）：防校验重试再入同名二次创建
    const aggAgent = wfAgent(`验收聚合-r${round}`, ACCEPTANCE_AGG_PERSONA);
    // fail-closed 覆盖集 = 验收 failed 节点 ∪ commit 条目节点（两类都要被恰好覆盖）
    const poolNodeIds = [...failedNodes.map((n) => n.id), ...commitGateFailures.flatMap((cf) => cf.nodeIds)];
    const agg = await askValidated(makeAcceptanceAggValidator(poolNodeIds), (p) => aggAgent.ask("AcceptanceAggregation", p), aggPrompt);
    if (agg === null) {
        return { ok: false, reason: `聚合裁决返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规（失败池 ${poolNodeIds.join("、")}）`, resetIds: [] };
    }
    for (const it of agg.items) {
        if (it.action !== "disputed")
            continue;
        acceptanceDisputed.push({ round, itemId: it.id, by: "aggregator", evidence: it.rootCause });
        for (const nid of it.nodeIds)
            acceptanceDisputedIds.add(nid);
        // disputed 的 commit 条目出池（钩子拦的是真代码问题——主 agent 裁决；deferredCommits 保留呈报）
        for (let i = commitGateFailures.length - 1; i >= 0; i--) {
            if (commitGateFailures[i].nodeIds.some((nid) => it.nodeIds.includes(nid)))
                commitGateFailures.splice(i, 1);
        }
        log(`条目 ${it.id}（节点 ${it.nodeIds.join("、")}）聚合判 disputed：${it.rootCause}`);
    }
    const fixItems = agg.items.filter((it) => it.action === "fix");
    // 聚合清单落盘（机器渲染——追溯锚，修复轮次产物与 per-fixer 文档同目录）
    const fixDir = `${skillDataDir}/${String(plan.statusPath.split("/").pop() ?? "status")}.fixes/r${round}`;
    try {
        await writeTextViaNode(`${fixDir}/aggregated.md`, [
            `# 第 ${round} 轮失败聚合清单（验收失败 + commit 门禁）`,
            "",
            ...agg.items.map((it) => `- ${it.id} [${it.action}] ${it.title}（节点 ${it.nodeIds.join("、")}）——${it.rootCause}${it.action === "fix" ? `\n  files: ${it.files.join("、")}\n  guidance: ${it.guidance}` : ""}`),
            "",
            ...(agg.groups.length > 0 ? ["## 修复分组", ...agg.groups.map((g) => `- ${g.id}：${g.itemIds.join("、")}${g.note ? `——${g.note}` : ""}`)] : []),
        ].join("\n"));
    }
    catch (e) {
        log(`WARN: 聚合清单落盘失败（${errText(e)}）——聚合数据以日志与返回值为准`);
    }
    if (fixItems.length === 0) {
        log("聚合裁决全部 disputed——无可修项（验收节点保持 failed、commit 条目回 deferredCommits，均随终态呈报）");
        return { ok: true, reason: "", resetIds: [] };
    }
    phase("失败修复组并行");
    // per-fixer 任务文档确定性渲染（文档与组严格一致——LLM 自写文档会与派发组错位）
    const commitItemIds = new Set(fixItems.filter((it) => commitGateFailures.some((cf) => cf.nodeIds.some((nid) => it.nodeIds.includes(nid)))).map((it) => it.id));
    const fixerDocs = [];
    let docIdx = 0;
    for (const g of agg.groups) {
        docIdx += 1;
        const gItems = fixItems.filter((it) => g.itemIds.includes(it.id));
        if (gItems.length === 0)
            continue;
        const gNodes = plan.nodes.filter((n) => gItems.some((it) => it.nodeIds.includes(n.id)));
        const docPath = `${fixDir}/fixer-${docIdx}.md`;
        await writeTextViaNode(docPath, [
            `# 失败修复任务 ${g.id}${g.note ? `——${g.note}` : ""}`,
            "",
            "并行修复：其他组同时进行且文件与你不相交；只改本组条目涉及的文件。",
            "",
            ...gItems.flatMap((it) => [
                `- ${it.id} ${it.title}（节点 ${it.nodeIds.join("、")}）${commitItemIds.has(it.id) ? "〔commit 门禁类：按被拒输出做合规修复，禁改产品逻辑；真代码问题走 disputed〕" : ""}`,
                `  根因：${it.rootCause}`,
                it.files.length > 0 ? `  files: ${it.files.join(", ")}` : "",
                it.guidance !== "" ? `  guidance: ${it.guidance}` : "",
                ...(acceptanceFailures.get(it.nodeIds[0] ?? "") ?? []).slice(0, -1).map((h) => `  历史修法（已失败勿重复）：第${h.round}轮 ${h.cls}——${h.evidence}`),
            ]),
        ]
            .filter(Boolean)
            .join("\n"));
        fixerDocs.push({ path: docPath, group: g, items: gItems, cwd: gNodes[0]?.cwd ?? plan.projectRoot });
    }
    log(`第 ${round} 轮失败修复分 ${fixerDocs.length} 组并行`);
    const fixerResults = await Promise.all(fixerDocs.map(async (d, idx) => {
        const fixerAgent = wfAgent(`验收修复-r${round}-g${idx + 1}`, ACCEPTANCE_FIXER_PERSONA);
        const prompt = [
            `读取修复任务文档 ${d.path}（绝对路径）并完整执行（第 ${round} 轮失败修复：验收缺陷修产品代码/验收资产；commit 门禁类条目按钩子被拒输出做合规修复——豁免标记/清单登记/常量化，钩子指出什么修什么）。`,
            "",
            "约束：",
            "1. 以条目根因与 guidance 为依据修复；小步修改；只改本组条目涉及的文件与波及文件。",
            "2. 修完自跑改动相关的测试/类型检查（只重跑失败相关项，禁止全套复跑——重验由引擎机器执行，无需你跑全量）。",
            "3. 确信条目是误报（断言口径本就不该成立 / 钩子拦的是真代码问题而非合规登记类）：不要修，放 disputed 并给反证（file:line + 归因漏了什么），人工裁决——禁止靠修代码迎合错误断言、禁止为过门禁擅自改产品逻辑。",
            "4. git 禁令：禁止 git add / commit / push / stash——提交由引擎统一执行。",
            "5. 改动触发仓库门禁义务的（豁免标记 / 清单登记）按仓库规范就地处理，防引擎提交被钩子拦。",
            `6. 工作目录锚：${d.cwd}（files 申报相对该仓库根的路径）。`,
            "",
            '返回 JSON：{ fixes: [{ itemId, files: ["相对仓库根路径"] }], disputed: [{ itemId, evidence }], selfCheck: "命令: 结果" }——修了哪些条目如实申报，未修且非误报的条目不得静默丢弃（如实写进 selfCheck 说明）。',
        ].join("\n");
        const rep = await askValidated(makeAcceptanceFixValidator(new Set(d.items.map((it) => it.id))), (p) => fixerAgent.ask("AcceptanceFixReport", p), prompt);
        return { doc: d, rep };
    }));
    // 坏组不早退：先让合规组走完 disputed/commit/重试（有效修复成果落盘），仅坏组计入熔断
    // reason——Promise.all 已等全部 fixer 落定，早退会让其余组已落盘的修复无 commit 无重置
    const badGroups = fixerResults.filter((fr) => fr.rep === null).map((fr) => fr.doc.group.id);
    const badReason = badGroups.length > 0
        ? `修复组 ${badGroups.join("、")} 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规（改动可能已落盘）`
        : "";
    const okResults = fixerResults.filter((fr) => fr.rep !== null);
    for (const { doc, rep } of okResults) {
        for (const dsp of rep.disputed) {
            const it = doc.items.find((x) => x.id === dsp.itemId);
            acceptanceDisputed.push({ round, itemId: dsp.itemId, by: `fixer:${doc.group.id}`, evidence: dsp.evidence });
            if (it !== undefined)
                for (const nid of it.nodeIds)
                    acceptanceDisputedIds.add(nid);
            // fixer 级 disputed 的 commit 条目出池（钩子拦的是真代码问题——主 agent 裁决；deferredCommits 保留呈报）
            if (it !== undefined) {
                for (let i = commitGateFailures.length - 1; i >= 0; i--) {
                    if (commitGateFailures[i].nodeIds.some((nid) => it.nodeIds.includes(nid)))
                        commitGateFailures.splice(i, 1);
                }
            }
            log(`条目 ${dsp.itemId}（组 ${doc.group.id}）fixer 判 disputed：${dsp.evidence}`);
        }
    }
    // 组级一笔 commit（引擎执行；按组 cwd 分桶——跨仓组按首节点仓根提交，文件不在该仓时
    // git add 报错以 fix-failure 熔断呈报，不留半提交状态）。commit 门禁类条目的文件不走
    // 组级 commit——它们必须用原 message 重试（message 含 unitId，是崩溃恢复对账的反查锚）
    for (const { doc, rep } of okResults) {
        const files = [...new Set(rep.fixes.filter((f) => !commitItemIds.has(f.itemId)).flatMap((f) => f.files))];
        if (files.length === 0)
            continue;
        const c = await gitAddCommitViaNode(doc.cwd, `fix(acceptance): 第 ${round} 轮失败修复（${doc.group.id}，${files.length} 文件）`, files);
        if (!c.ok) {
            return { ok: false, reason: `修复组 ${doc.group.id} commit 失败（${doc.cwd}）：${c.err}——改动留工作区，接管前先 git status 盘点`, resetIds: [] };
        }
        log(`修复组 ${doc.group.id} 已提交（${c.hash.slice(0, 8)}）`);
    }
    if (badReason !== "") {
        return { ok: false, reason: `${badReason}；其余合规组已提交。接管前先 git status 盘点`, resetIds: [] };
    }
    // commit 门禁条目重验：用原 message + 原文件 ∪ fixer 合规修复文件重试提交（exit 0 = 恢复）
    for (const { rep } of okResults) {
        for (const cf of [...commitGateFailures]) {
            const node = plan.nodes.find((n) => cf.nodeIds.includes(n.id));
            if (node === undefined)
                continue;
            const fixFiles = rep.fixes.filter((f) => f.itemId !== "" && cf.nodeIds.some((nid) => (fixItems.find((it) => it.id === f.itemId)?.nodeIds.includes(nid) ?? false))).flatMap((f) => f.files);
            if (fixFiles.length === 0)
                continue; // 本组没有覆盖该 commit 条目的修复申报（他组管辖或未申报）
            const tryFiles = [...new Set([...cf.files, ...fixFiles])];
            const c2 = await gitAddCommitViaNode(node.cwd, cf.message, tryFiles);
            const cfIdx = commitGateFailures.indexOf(cf);
            const dcIdx = deferredCommits.findIndex((dc) => cf.nodeIds.includes(dc.id) && dc.message === cf.message);
            if (c2.ok) {
                if (cfIdx >= 0)
                    commitGateFailures.splice(cfIdx, 1);
                if (dcIdx >= 0)
                    deferredCommits.splice(dcIdx, 1);
                const prevAttempts = state.get(node.id)?.attempts ?? 0;
                await statusUpdate(node.id, { status: "done", attempts: prevAttempts, commit: c2.hash, evidence: `commit 门禁修复后恢复提交（第 ${round} 轮，${c2.hash.slice(0, 8)}）` }, "commit-recovered", `commit 被拒经第 ${round} 轮门禁合规修复后重试成功`);
                log(`commit 条目（节点 ${cf.nodeIds.join("、")}）已恢复提交（${c2.hash.slice(0, 8)}，原 message 保留对账锚）`);
            }
            else {
                if (cfIdx >= 0)
                    commitGateFailures[cfIdx] = { ...cf, err: c2.err, round };
                // 混合条目的验收修复文件随 tryFiles 重试失败时无 commit 落点——并入 deferredCommits
                // 对应条目的 files 随终态呈报（防「重验已绿但修复不在任何 commit 里」）
                if (dcIdx >= 0)
                    deferredCommits[dcIdx] = { ...deferredCommits[dcIdx], files: [...new Set([...deferredCommits[dcIdx].files, ...fixFiles])] };
                log(`WARN: commit 条目（节点 ${cf.nodeIds.join("、")}）重试仍被拒——留池下轮（${MAX_FAILURE_FIX_ROUNDS - round} 轮余量）`);
            }
        }
    }
    // 重置重验：非 disputed 失败节点全部重置（修复是组级的，连带修复的节点由机器判定裁决）
    const resetIds = failedNodes.filter((n) => !acceptanceDisputedIds.has(n.id)).map((n) => n.id);
    return { ok: true, reason: "", resetIds };
}
async function executeNode(node) {
    if (node.kind === "dev")
        return executeDevNode(node);
    if (node.kind === "verify")
        return executeVerifyNode(node);
    return executeInspectNode(node);
}
// ── 调度主循环（设计 §8.2 流式）：逐节点 settle 即重算——单节点完成立即解锁后继
//    在并发余量内补派，不等批内其他节点（长尾不拖批）；活跃声明范围并集随活跃集动态重建 ──
async function runSchedulingLoop() {
    // id → 完成后 resolve 回自身 id（race 的返回值即完成节点）
    const active = new Map();
    const launch = (n) => {
        const p = (async () => {
            try {
                await executeNode(n);
            }
            catch (e) {
                // rejected（接替程序也失败/写盘失败等引擎层异常）→ 节点 blocked，其他节点照常推进；
                // 兜底写 status 失败时只 log（内存态已置 blocked，调度不受影响）——二次异常不得击穿
                // race 造成顶层 throw（违反 failed-as-return）。attempts 取内存态当前值（曾恒传 0，
                // 恢复者无法从 status 判断已烧几轮）
                const burned = state.get(n.id)?.attempts ?? 0;
                try {
                    await markNodeBlockedOrFailed(n.id, "blocked", `节点执行异常：${errText(e)}`, "", burned);
                }
                catch (e2) {
                    state.set(n.id, { status: "blocked", attempts: burned, reason: `节点执行异常：${errText(e)}（status 回写失败：${errText(e2)}）` });
                    log(`WARN: 节点 ${n.id} 异常后的 status 回写失败（${errText(e2)}）——内存态已置 blocked`);
                }
            }
            return n.id;
        })();
        active.set(n.id, p);
    };
    while (true) {
        if (coreFail !== null)
            break;
        // （执行期授权连带生效通道已删，2026-09-29 裁决范围声明降级：运行时不再逐文件核验，
        // territory 无运行中扩容需求——原「每轮重读 exec-plan 吸收扩展」依赖节点落定触发，
        // parked 等扩展 + 长跑单元在场时扩展永不可达（实测 u3 死等 35.9min 后被手动停）。
        // 声明范围外的必要改动由 agent 直接做 + 自报 deviations，核验对账不打回）
        const ready = plan.nodes.filter((n) => nodeState(n.id) === "pending" &&
            n.deps.every((d) => nodeState(d) === "done"));
        // 游标防同轮重复派发（launch 后 state 同步变 in-progress，游标是双保险）
        let dispatched = 0;
        while (active.size < MAX_CONCURRENCY && dispatched < ready.length) {
            launch(ready[dispatched]);
            dispatched += 1;
        }
        if (active.size === 0) {
            // 统一失败处理中心：无活跃且失败池非空（验收 failed 未 disputed / commit 被拒未恢复）
            // → 聚合修复一轮（验收节点重置 pending 重验 = 机器判定走原路径；commit 条目修复后
            // 环内重试提交 = exit 0 重验）。轮耗尽收束：验收 failed 按可达性判定（卡后继 =
            // core-failed；不卡 = 保持 failed 由收尾呈报）；commit 残留留 deferredCommits 呈报
            // 主 agent 代提交（兜底通道不变）。blocked 不进（环境/任务书/结构化问题非修复组可解）
            {
                const failedAcc = plan.nodes.filter((n) => nodeState(n.id) === "failed" && (n.kind === "verify" || n.kind === "inspect") && !acceptanceDisputedIds.has(n.id));
                if ((failedAcc.length > 0 || commitGateFailures.length > 0) && failureFixRounds < MAX_FAILURE_FIX_ROUNDS) {
                    failureFixRounds += 1;
                    // failed-as-return 兜底（契约见文件头）：修复环的写盘/agent 会话异常不炸 run，
                    // 降级为熔断呈报（errored run 不可 resume 且丢结构化产出——节点级有 launch 内
                    // try/catch，修复环此前是唯一裸奔段）
                    let cyc;
                    try {
                        cyc = await runFailureFixCycle(failureFixRounds);
                    }
                    catch (e) {
                        cyc = { ok: false, reason: `修复环执行异常（${errText(e)}）——接管前先 git status 盘点工作区半成品`, resetIds: [] };
                    }
                    if (!cyc.ok) {
                        coreFail = { id: "failure-fix", detail: `第 ${failureFixRounds} 轮失败修复失败：${cyc.reason}` };
                        break;
                    }
                    for (const id of cyc.resetIds) {
                        const prev = state.get(id);
                        const attempts = (prev?.attempts ?? 0) + 1;
                        state.set(id, { status: "pending", attempts });
                        await statusUpdate(id, { status: "pending", attempts }, "fix-round", `第 ${failureFixRounds} 轮失败修复完成，重置重验（机器判定）`);
                    }
                    log(`第 ${failureFixRounds} 轮失败修复：重置重验 ${cyc.resetIds.length} 节点${commitGateFailures.length > 0 ? `，commit 待恢复 ${commitGateFailures.length} 条` : ""}`);
                    if (cyc.resetIds.length > 0 || commitGateFailures.length > 0)
                        continue;
                    // 池已清空（全恢复或全 disputed）——按可达性判定收束（同轮耗尽路径）
                }
                // 可达性判定按当前失败集重算（修复环可能刚把节点 disputed 掉——用环前快照会把
                // 已呈报人工裁决的节点误冠「未收敛」并错误触发 core-failed）
                const failedNow = plan.nodes.filter((n) => nodeState(n.id) === "failed" && (n.kind === "verify" || n.kind === "inspect") && !acceptanceDisputedIds.has(n.id));
                if (failedNow.length > 0 && failureFixRounds >= MAX_FAILURE_FIX_ROUNDS) {
                    const stuckN = failedNow.find((n) => successorsOf(n.id).some((s) => {
                        const sst = nodeState(s);
                        return sst === "pending" || sst === "in-progress";
                    }));
                    if (stuckN !== undefined) {
                        coreFail = {
                            id: stuckN.id,
                            detail: `验收失败经 ${MAX_FAILURE_FIX_ROUNDS} 轮修复循环仍未收敛——节点 ${stuckN.id} 卡住后继，熔断呈报；disputed 反证与聚合历史（${skillDataDir}/${String(plan.statusPath.split("/").pop() ?? "status")}.fixes/）随终态`,
                        };
                        break;
                    }
                    // 不卡后继：保持 failed，收尾按 blockedOut 呈报（终态 blocked）
                }
            }
            break; // 无可调度且无活跃 → 依赖挂起或全终态 → 终态判定
        }
        // 级二粗粒度复核的基线：**单调累积**（launch 时并入该节点范围声明，settle 后不移除）——
        // 粗粒度复核「只松不严」原则下，移除已落定节点的范围声明只会收紧：兄弟节点带残留改动
        // 落定（blocked/commit 失败）后，在途节点的核验会把残留判为越界 stray 而被误伤打回
        //（审查 P1 修正；launch 后并入保证新派发节点自身必在并集内）
        for (const id of active.keys()) {
            const n = plan.nodes.find((x) => x.id === id);
            if (!n)
                continue;
            const list = activeTerrByCwd.get(n.cwd) ?? [];
            for (const t of n.territory)
                if (!list.includes(t))
                    list.push(t);
            activeTerrByCwd.set(n.cwd, list);
        }
        const finishedId = await Promise.race(active.values());
        active.delete(finishedId);
        log(`节点 ${finishedId} 落定（活跃 ${active.size}），重算就绪集`);
        // 核心组熔断判定：任一核心节点 blocked/failed 且 haltOnCoreFail → 记归因、停止新派发。
        // 在途节点收尾不放弃（await allSettled——熔断只是不派新，已派节点的落盘/commit 照常完成）
        // §8.7 依赖可达性熔断（统一判据）：任一节点 blocked/failed 且卡住未终态后继
        // （dev 打回超限 / 自报 blockers / 引擎层失败）→ 立即停止派发（已派节点收尾不放弃）。
        // verify/inspect 的 failed 不立即熔断（acceptance 与 dev 模式一律）——统一失败处理
        // 中心承接（同轮其他分支照跑，修复轮耗尽后才按可达性判定，见循环头 active.size===0
        // 分支）。原静态 coreIds/haltOnCoreFail 短路已退役（依赖闭包是唯一判据）
        {
            const stuckBad = plan.nodes.find((n) => {
                const st = nodeState(n.id);
                if (st === "failed" && (n.kind === "verify" || n.kind === "inspect"))
                    return false;
                if (st !== "failed" && st !== "blocked")
                    return false;
                return successorsOf(n.id).some((s) => {
                    const sst = nodeState(s);
                    return sst === "pending" || sst === "in-progress";
                });
            });
            if (stuckBad !== undefined) {
                const rt = state.get(stuckBad.id);
                coreFail = {
                    id: stuckBad.id,
                    detail: `${rt?.reason ?? "节点失败卡住后继"}\n${rt?.detail ?? ""}`.trim(),
                };
                log(`节点 ${stuckBad.id} 失败/受阻且卡住后继（依赖可达性熔断 §8.7）：未派发节点不再派发，等待在途节点收尾`);
                await Promise.allSettled([...active.values()]);
                break;
            }
        }
    }
}
// ── 看板（运行观察：节点状态流转实时上板，终态也可从 status.json 人读） ──
artifact.board("nodes", {
    title: "执行节点状态",
    key: "id",
    status: "state",
    columns: ["pending", "in-progress", "done", "failed"],
    cardTitle: "id",
    detail: [{ field: "detail", label: "说明" }],
});
// ══════════════ 阶段 1：校验执行计划 ══════════════
phase("校验执行计划");
const rawPlanText = await readTextViaNode(execPlanPath);
if (rawPlanText === null) {
    return invalidRet(`exec-plan 文件不存在或不可读：${execPlanPath}`, "");
}
let rawPlan;
try {
    rawPlan = JSON.parse(rawPlanText);
}
catch (e) {
    return invalidRet(`exec-plan 不是合法 JSON：${errText(e)}`, "");
}
const validated = validatePlan(rawPlan);
if (!validated.ok) {
    return invalidRet(`exec-plan schema 校验失败（共 ${validated.errors.length} 条）：\n- ${validated.errors.join("\n- ")}\n` +
        `——恢复指引（按错误类型路由）：\n` +
        `① 单字段错误（路径层级、引用名拼写）可手修 exec-plan 后重发` +
        `（该字段值若转抄自 impl-plan——testCommand/deps/单元 id 等——需同步修 impl-plan 上游，否则 D0 重编译会复现）；\n` +
        `② 结构性缺漏（缺数组、缺必填字段）回 D0 重编译（flow/compile.md）后重发` +
        `（尚无节点执行过时；已有进度时手修+登记避免抹档案——D0 重初始化会重置 status.json / runlog / ledger）；\n` +
        `③ 依赖环 / territory 重叠冲突源自上游 impl-plan——回 tech-design-wf T3 修 impl-plan 后重走 D0，` +
        `手修 exec-plan 会确定性复现同类错误`, "");
}
plan = validated.plan;
if (!(await existsViaNode(plan.projectRoot))) {
    return invalidRet(`projectRoot 不存在：${plan.projectRoot}`, plan.statusPath);
}
// skillDataDir 组装（失败走 invalidRet，与其他启动校验同型）：runlog/ledger/run.json 等
// 过程记录落 skill-data dev-flow 段（status.json 本身落点由 exec-plan 决定）。布局随寻址
// 形态两级化：workspace 形态 = <ws-slug>/<worktreeName>/（worktree 级隔离），单仓形态退回
// 现行平铺（AX5 逐字节不变）。寻址只看 projectRoot（检测探针内部以工作区目录派生 ws-slug
// 与 worktreeName——单一权威源；exec-plan 的 workspaceRoot 供统计/迁移等外部消费者派生
// 工作区级地址，不在此重复换算）。注释不内联算法，约定见 skill-data-addressing.md
const homeRes = await world.run("node", ["-e", NODE_PROBE_HOME]);
if (homeRes.exitCode !== 0 || homeRes.stdout.trim() === "") {
    return invalidRet(`无法解析用户 home 目录（node 探针失败，exit ${homeRes.exitCode}）：${homeRes.stderr.trim()}`, plan.statusPath);
}
const addressRes = await world.run("node", ["-e", NODE_PROJECT_ADDRESS, plan.projectRoot]);
const address = addressRes.exitCode === 0 ? parseProjectAddress(addressRes.stdout) : null;
if (address === null) {
    return invalidRet(`projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit ${addressRes.exitCode}）：${addressRes.stderr.trim() || addressRes.stdout.trim()}——恢复动作：确认 exec-plan 的 projectRoot 目录存在且为 git 仓库内路径后重新发起`, plan.statusPath);
}
const skillDataDir = devFlowRoot(homeRes.stdout.trim(), address);
// ── 观测启用（O 区）：stage 按 exec-plan mode 区分——mode=dev 即 D1 开发执行，
// mode=acceptance 即 D3 端到端验收。attempt 无独立参数（run 级恒 1）。execution start
// 从 plan 校验通过后起记；此前失败的启动校验（文件/schema/依赖环）无观测覆盖，属已
// 声明边界。此后启动失败经 invalidObs 离开（先补记观测执行结束事件）──
obsCtx = initObservation("dev-flow-v2", plan.mode === "dev" ? "D1" : "D3", 1);
if (obsCtx !== null) {
    obsAttachHome(homeRes.stdout.trim());
    await obsEmit("execution", null, "start", null);
    await obsBegin("setup", null);
}
// run manifest startedAt（循环启动时记录；探针失败 = 防覆盖判据不可用，终态时放弃写
// run.json 只告警——终态数据以 status.json 与返回值为准）
const startedAtRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
const runStartedAt = startedAtRes.exitCode === 0 && startedAtRes.stdout.trim() !== "" ? startedAtRes.stdout.trim() : null;
for (const n of plan.nodes) {
    if (n.promptFile !== "" && !(await existsViaNode(n.promptFile))) {
        return await invalidObs(`节点 ${n.id} 的 promptFile 不存在：${n.promptFile}`, plan.statusPath);
    }
    if (n.kind === "verify" && !(await existsViaNode(n.script))) {
        return await invalidObs(`verify 节点 ${n.id} 的 script 不存在：${n.script}`, plan.statusPath);
    }
    if (n.kind === "verify" && !VERIFY_SCRIPT_EXTS.has(n.script.slice(n.script.lastIndexOf(".")))) {
        return await invalidObs(`verify 节点 ${n.id} 的 script 扩展名不受支持：${n.script}（合法：${[...VERIFY_SCRIPT_EXTS].join(" / ")}；解释器分派 = .sh→bash、其余→node）`, plan.statusPath);
    }
}
// 启动基线扫描（全部去重 cwd；工作流产物已迁 HOME 下 skill-data、porcelain 天然不可见，
// .tmp/ 过滤退化为历史兼容）——记录启动前既有改动
// 为豁免集，不拒绝启动（2026-09-26 用户裁决：启动前的工作区改动与本次节点无关，不该
// 卡死发起——续跑/恢复场景工作区常有上次残留，拒启动 = 强迫人工先清理再重发）。
// 该豁免集只服务终态对账口径：residualFiles 排除启动前既有项（它们不是本次 run 产生的，
// 是否处置由主 agent 按自身语境判断）
const preExistingByCwd = new Map();
const allCwds = [...new Set(plan.nodes.map((n) => n.cwd))];
for (const c of allCwds) {
    // 口径断言：cwd 须为其所在 git 仓库根（projectRoot / worktree 根均满足；仓库子目录拒绝）
    const top = await gitToplevelViaNode(c);
    if (top === null) {
        return await invalidObs(`git rev-parse 无法在 ${c} 执行（须为有效 git 仓库根）`, plan.statusPath);
    }
    if (top !== c) {
        const ids = plan.nodes.filter((n) => n.cwd === c).map((n) => n.id).join("、");
        return await invalidObs(`节点 ${ids} 的 cwd ${c} 不是其所在 git 仓库根（rev-parse --show-toplevel = ${top}）——cwd 只能为 projectRoot 或 worktree 绝对路径：porcelain 输出相对 cwd、territory 相对仓库根，子目录会使两基准全链错位（声明恒判越界、提交被拒）。恢复动作：exec-plan 中该节点 cwd 改为仓库根后重发`, plan.statusPath);
    }
    const st = await gitPorcelainViaNode(c);
    if (st === null) {
        return await invalidObs(`git status 无法在 ${c} 执行（须为有效 git 仓库）`, plan.statusPath);
    }
    const dirty = parsePorcelain(st).filter((f) => !isTmpArtifact(f));
    if (dirty.length > 0) {
        preExistingByCwd.set(c, new Set(dirty));
        log(`WARN: 启动时 ${c} 工作区已有 ${dirty.length} 项未提交改动（${dirty.slice(0, 5).join("、")}${dirty.length > 5 ? " 等" : ""}）——不阻塞启动，终态对账单独列示（启动前既有，非本次节点产生）`);
    }
}
// status.json：不存在 → 创建初始态（全 pending）；存在 → 只保留 done（dev done 须 commit 在 git，
// 不在则回 pending——§4.5 崩溃裁决以 git 为准），其余一律回 pending 重执行
const existingStatus = await readStatusFile();
// 运行唯一标识（本 run 新 commit 恒带的 trailer 锚）：初建时生成——初始态反查走 claimAny
// 认领语义不校验它（见 RECONCILE_STATUS 注释）；恢复时沿用磁盘值，status 已存在的双向
// 对账路径按它精确匹配（旧格式无 runId → 生成新值，旧 commit 因 trailer 不匹配不再被
// 反查认领，重跑由幂等核验兜住）
const genRunId = async () => {
    // workflow 沙箱禁 Date.now/Math.random（重放一致性——每次执行值不同会对不上账），
    // 随机量须经 world.run 在沙箱外的 node 子进程产生，结果作为值拿回
    const r = await world.run("node", ["-e", "process.stdout.write(Date.now().toString(16) + Math.random().toString(16).slice(2, 6))"]);
    const id = r.stdout.trim();
    if (id === "")
        throw new Error(`Run-Id 生成失败（node 子进程无输出，exit ${r.exitCode}）`);
    return id;
};
let activeRunId;
// 跨仓对账条目：cwd 非空（worktree/子模块仓根）的节点以 `<id>@<仓根>` 传递——
// RECONCILE 按条目仓根做 cat-file 与 log 反查（单 projectRoot 口径会误判子模块 commit）
const devEntry = (id) => {
    const n = plan.nodes.find((x) => x.id === id);
    return n && n.cwd ? `${id}@${n.cwd}` : id;
};
if (existingStatus === null) {
    // baseline 固化：优先 exec-plan 的 baseline（编译时点 HEAD，早于本 run 全部 commit——
    // status 被删但本 run commit 已在 git 的恢复场景，窗口完整覆盖），但 AI 抄写的值不可
    // 全信，git 对象库验证（rev-parse --verify）失败/缺失时弃用、当场取 HEAD 固化（此时
    // 历史 commit 无法归账，单元重跑由幂等核验兜住）。「无 baseline」态构造性消灭，
    // RECONCILE 的无窗口分支随之只对旧格式 status.json 可达
    let baselineVal = null;
    if (typeof plan.baseline === "string" && plan.baseline.trim() !== "") {
        const v = await world.run("git", ["-C", plan.projectRoot, "rev-parse", "--verify", `${plan.baseline}^{commit}`]);
        if (v.exitCode === 0 && v.stdout.trim() !== "")
            baselineVal = v.stdout.trim();
        else
            log(`WARN: exec-plan baseline「${plan.baseline}」不是仓库中的真实提交（rev-parse --verify exit ${v.exitCode}）——弃用，当场取 HEAD 固化`);
    }
    if (baselineVal === null) {
        const h = await world.run("git", ["-C", plan.projectRoot, "rev-parse", "HEAD"]);
        if (h.exitCode === 0 && h.stdout.trim() !== "")
            baselineVal = h.stdout.trim();
    }
    activeRunId = await genRunId();
    const initialNodes = {};
    for (const n of plan.nodes)
        initialNodes[n.id] = { status: "pending", attempts: 0 };
    try {
        await writeTextViaNode(plan.statusPath, 
        // skillVersion 盖初建（产物溯源字段 = SKILL_VERSION 构建注入常量，本引擎 =
        // dev-flow-v2 版本）：此后回写链构造性保留——readStatusFile 把 schema 外顶层字段
        // 收进 extra 原样回写、RECONCILE 探针保留全部 schema 外顶层字段，后续覆盖不丢
        JSON.stringify({ skillVersion: SKILL_VERSION, baseline: baselineVal, runId: activeRunId, nodes: initialNodes, events: [] }, null, 2));
    }
    catch (e) {
        return await invalidObs(`status.json 初始态创建失败（${plan.statusPath}）：${errText(e)}`, plan.statusPath);
    }
    log(`status.json 不存在，已创建初始态（${plan.nodes.length} 个节点全 pending，baseline 固化 ${baselineVal ?? "(HEAD 获取失败——反查将被禁用)"}，runId ${activeRunId}）：${plan.statusPath}`);
    for (const n of plan.nodes)
        state.set(n.id, { status: "pending", attempts: 0 });
    // 初始态反查走 claimAny 认领语义（§4.5 崩溃裁决不留人工方向）：status.json 曾被删但
    // commit 在 git——非 done 的 dev 节点按「前缀+词边界」反查补写 done，避免重跑已交付
    // 单元。此刻 status 里的 runId 是本 run 新生成的，旧交付 commit 带旧 Run-Id，trailer
    // 精确匹配恒落空，故此路径不校验 Run-Id；status 已存在的双向对账路径（else 分支）仍走
    // 精确匹配，语义不变
    const freshDevIds = plan.nodes.filter((n) => n.kind === "dev").map((n) => n.id);
    if (freshDevIds.length > 0) {
        const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, plan.commitTemplate, activeRunId, "claimAnyRunId", ...freshDevIds.map(devEntry)]);
        if (rec.exitCode === 0 && rec.stdout.trim() !== "") {
            try {
                const parsed = JSON.parse(rec.stdout);
                if (isRec(parsed) && isRec(parsed.nodes)) {
                    for (const id of freshDevIds) {
                        const e = normalizeEntry(parsed.nodes[id]);
                        if (e.status === "done")
                            state.set(id, { status: "done", attempts: e.attempts });
                    }
                    const recovered = freshDevIds.filter((id) => nodeState(id) === "done").length;
                    if (recovered > 0) {
                        // 对账结果写回磁盘（RECONCILE stdout 即完整 status.json）——只更新内存会造成
                        // 磁盘全 pending 与内存 done 漂移，重启后对账重复跑（曾实测：补 done 蒸发）
                        await writeTextViaNode(plan.statusPath, rec.stdout.trim());
                        log(`初始态对账：git log 反查补写 ${recovered} 个已提交单元为 done 并写回 status.json（status.json 曾缺失）`);
                    }
                }
            }
            catch {
                // 对账输出解析失败：保持全 pending 重跑（安全方向——重复执行有幂等核验兜底）
            }
        }
    }
}
else {
    // 双向对账（§4.5 崩溃裁决，git 为准）：done 验证 commit 存在性（不在回 pending）；
    // 非 done 的 dev 节点反查 git log（commitTemplate 渲染的单元锚）——有 commit 未记 → 补写 done
    const allDevIds = plan.nodes.filter((n) => n.kind === "dev").map((n) => n.id);
    let aligned = {};
    for (const n of plan.nodes)
        aligned[n.id] = existingStatus.nodes[n.id] ?? { status: "pending", attempts: 0 };
    // runId 恢复：沿用磁盘值保证跨重启 trailer 锚一致；旧格式无 runId → 换新值（本 run
    // 新 commit 带新 trailer，旧 commit 不被认领，兼容路径不再适用——重跑由幂等核验兜住）
    const prevRunId = existingStatus.extra["runId"];
    activeRunId = typeof prevRunId === "string" && prevRunId !== "" ? prevRunId : await genRunId();
    if (allDevIds.length > 0) {
        const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, plan.commitTemplate, activeRunId, ...allDevIds.map(devEntry)]);
        if (rec.exitCode === 0 && rec.stdout.trim() !== "") {
            try {
                const parsed = JSON.parse(rec.stdout);
                if (isRec(parsed) && isRec(parsed.nodes)) {
                    for (const id of allDevIds)
                        aligned[id] = normalizeEntry(parsed.nodes[id]);
                    log(`status.json 已存在，双向对账完成（dev 节点 ${allDevIds.length} 个：done 核验 commit 存在性 + git log 反查补写）`);
                }
            }
            catch {
                // 对账输出解析失败：保留原始记录，终态核验仍有 commit 证据可查
            }
        }
    }
    // 级联失效：dev 节点被对账回 pending（commit 不在 git 对象库）时，其已 done 的后继
    //（直接/传递依赖它的节点，含 verify/inspect）一并回 pending——后继的验证结论基于已
    // 消失的 commit，属陈旧验证（曾保持 done 被增量跳过，信任了不存在的历史）
    const resetIds = new Set();
    for (const n of plan.nodes) {
        if (n.kind === "dev" &&
            (existingStatus.nodes[n.id]?.status ?? "pending") === "done" &&
            aligned[n.id]?.status !== "done") {
            resetIds.add(n.id);
        }
    }
    if (resetIds.size > 0) {
        let grew = true;
        while (grew) {
            grew = false;
            for (const n of plan.nodes) {
                if (aligned[n.id]?.status === "done" && n.deps.some((d) => resetIds.has(d)) && !resetIds.has(n.id)) {
                    resetIds.add(n.id);
                    grew = true;
                }
            }
        }
        for (const id of resetIds) {
            if (aligned[id] !== undefined && aligned[id].status === "done") {
                aligned[id] = { status: "pending", attempts: 0 };
                log(`级联失效：${id} 依赖的单元被对账回 pending，其 done 结论基于已消失的 commit——一并回 pending`);
            }
        }
    }
    // inspect 节点的 done 无 commit 锚（上面的对账只核 dev 节点 git 存在性），单独核
    // verdict 判定文件——防上一 run 的假 done（结构化自报 pass、判定书实际 FAIL，或干脆
    // 未经真实检查）被「按 status.json 增量跳过」继承（2026-10-04 taiji D3 A10 实证形态）
    for (const n of plan.nodes) {
        if (n.kind !== "inspect" || n.artifactsDir === "")
            continue;
        if (aligned[n.id]?.status !== "done")
            continue;
        const v = await readVerdictAnchorVerdict(n.artifactsDir);
        if (v === null) {
            aligned[n.id] = { status: "pending", attempts: 0 };
            log(`inspect 锚核对：${n.id} 的 status.json 记 done，但 ${n.artifactsDir}/verdict.json 缺失、不可解析或结论非 pass/degraded——回 pending 重跑`);
        }
    }
    for (const n of plan.nodes) {
        const e = aligned[n.id] ?? { status: "pending", attempts: 0 };
        const st = e.status === "done" ? "done" : "pending";
        state.set(n.id, { status: st, attempts: e.attempts });
    }
    // 对账结果写回磁盘（含反查补 done 与级联失效的最终态）——只更新内存会在重启后
    // 重复对账且补 done 不落盘（RECONCILE 输出含 reconcile-done 事件，直接整文写回）。
    // nodes 必须以既有条目为底、aligned 只覆盖当前 plan 节点：dev/acceptance 两 plan 可共用
    // 同一 statusPath，aligned 只含当前 plan 节点集，整文替换会抹掉其他 plan 的条目
    // （2026-09-26 W1 实测：u8 dev run 启动抹掉验收 v-* 条目；增量/终局回写均保留外部条目）
    const alignedAny = allDevIds.some((id) => (aligned[id]?.status ?? "pending") !== (existingStatus.nodes[id]?.status ?? "pending")) ||
        resetIds.size > 0;
    if (alignedAny) {
        await writeTextViaNode(plan.statusPath, JSON.stringify({
            ...existingStatus.extra,
            baseline: existingStatus.baseline,
            nodes: { ...existingStatus.nodes, ...aligned },
            events: existingStatus.events,
        }, null, 2));
        log(`对账结果已写回 ${plan.statusPath}（补 done / 级联失效条目落盘，重启不再重复对账）`);
    }
}
const depEdgeCount = plan.nodes.reduce((s, n) => s + n.deps.length, 0);
const resumedDone = plan.nodes.filter((n) => nodeState(n.id) === "done").length;
log(`执行计划校验通过：${plan.nodes.length} 个节点（mode=${plan.mode}），依赖边 ${depEdgeCount} 条无环` +
    (resumedDone > 0 ? `，${resumedDone} 个节点按 status.json 增量跳过` : ""));
// runlog 目录确保（幂等；任务书引用的过程记录落点——skill-data dev-flow 段）
{
    const rl = await world.run("node", ["-e", ENSURE_RUNLOG, plan.statusPath, skillDataDir]);
    if (rl.exitCode !== 0)
        log(`WARN: runlog 目录创建失败（exit ${rl.exitCode}）——agent 过程记录将自行建目录`);
}
for (const n of plan.nodes) {
    report({ id: n.id, state: nodeState(n.id) === "done" ? "done" : "pending", detail: "" }, "nodes");
}
// ══════════════ 阶段 2：并行执行（循环体单 phase，不按轮拆） ══════════════
await obsEnd("setup", null);
if (plan.mode === "dev") {
    phase("并行执行开发节点");
}
else {
    phase("并行执行验收节点");
}
await withStage("execute", null, () => runSchedulingLoop());
// ══════════════ 阶段 3：收尾汇总 ══════════════
phase("收尾汇总");
await obsBegin("finalize", null);
const doneIds = plan.nodes.filter((n) => nodeState(n.id) === "done").map((n) => n.id);
const badNodes = plan.nodes.filter((n) => nodeState(n.id) === "blocked" || nodeState(n.id) === "failed");
const blockedOut = badNodes.map((n) => {
    const rt = state.get(n.id);
    const kindLabel = nodeState(n.id) === "failed" ? "验收失败" : "blocked";
    return { id: n.id, reason: `${kindLabel}：${rt?.reason ?? "未知"}`, attempts: rt?.attempts ?? 0 };
});
const skippedIds = plan.nodes.filter((n) => nodeState(n.id) === "pending").map((n) => n.id);
const terminated = coreFail !== null ? "core-failed" : badNodes.length === 0 && skippedIds.length === 0 ? "completed" : "blocked";
// 收尾残留对账（2026-09-26 用户裁决的承接面）：核验不再拦截清单外残留（多为并行单元
// 运行中新建的文件——静态声明范围天然不含），全部节点 settle 后统一盘点一次全工作区，
// 残留 = 全部改动 −（所有 dev 节点声明范围并集 ∪ 已核验节点自报 files_changed 并集）——
// 既呈报并行新文件，也承接原查二级的防漏报价值（漏报越界的文件会出现在这里被看见）
const allTerr = [];
for (const n of plan.nodes)
    if (n.kind === "dev")
        for (const t of n.territory)
            if (!allTerr.includes(t))
                allTerr.push(t);
const finalPorcelain = await gitPorcelainViaNode(plan.projectRoot);
const preExisting = preExistingByCwd.get(plan.projectRoot) ?? new Set();
const residualAll = finalPorcelain === null
    ? []
    : parsePorcelain(finalPorcelain).filter((f) => !isTmpArtifact(f) && !pathInTerritory(f, allTerr) && !declaredFiles.has(f));
const residualFiles = residualAll.filter((f) => !preExisting.has(f));
const preExistingLeft = residualAll.filter((f) => preExisting.has(f));
// 终局回写：挂起节点落 suspended + run-terminal 事件（status.json 即人读恢复入口）
// runManifestBase：顺带捕获固化 baseline（exec-plan 声明或初建时点 HEAD，经 rev-parse
// 验证）——run manifest 的 baseCommit 数据源（本 run 全部 commit 的基线分界）
let runManifestBase = null;
await serializedStatus(async () => {
    const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [], extra: {} };
    runManifestBase = st.baseline;
    const nodes = { ...st.nodes };
    for (const n of plan.nodes) {
        if (nodeState(n.id) === "pending")
            nodes[n.id] = { status: "suspended", attempts: 0 };
    }
    const residualNote = residualFiles.length > 0
        ? `; residual=${residualFiles.length}（清单外残留，判归属后处置：${residualFiles.slice(0, 5).join("、")}${residualFiles.length > 5 ? " 等" : ""}）`
        : "";
    const deferredNote = deferredCommits.length > 0 ? `; commit-deferred=${deferredCommits.map((d) => d.id).join("、")}（主 agent 代提交）` : "";
    const events = [
        ...st.events,
        {
            seq: st.events.length + 1,
            node: "-",
            event: "run-terminal",
            detail: `terminated=${terminated}; done=${doneIds.length}; blocked=${blockedOut.length}; skipped=${skippedIds.length}${deferredNote}${residualNote}`,
        },
    ];
    if (deferredCommits.length > 0) {
        events.push({
            seq: events.length + 1,
            node: "-",
            event: "commit-deferred-list",
            detail: deferredCommits.map((d) => `${d.id}：${d.message}`).join("\n"),
        });
    }
    if (residualFiles.length > 0) {
        events.push({
            seq: events.length + 1,
            node: "-",
            event: "residual-files",
            detail: residualFiles.join("\n"),
        });
    }
    if (preExistingLeft.length > 0) {
        events.push({
            seq: events.length + 1,
            node: "-",
            event: "pre-existing-files",
            detail: `启动前既有未提交改动 ${preExistingLeft.length} 项（非本次 run 产生，是否处置按主 agent 语境判断）：\n${preExistingLeft.join("\n")}`,
        });
    }
    await writeTextViaNode(plan.statusPath, JSON.stringify({ ...st.extra, baseline: st.baseline, nodes, events }, null, 2));
});
log(`调度终态：${terminated}（done ${doneIds.length} / 未竟 ${blockedOut.length} / 挂起 ${skippedIds.length}${deferredCommits.length > 0 ? ` / commit 待办 ${deferredCommits.length}` : ""}${residualFiles.length > 0 ? ` / 清单外残留 ${residualFiles.length}` : ""}）——状态文件 ${plan.statusPath}`);
// 终态写入 ledger（未决事项与裁决处置档案——SKILL「运行记录」节）：主会话中断后
// 未决事项与终局计数仍可从盘上恢复；converged 形态同样入账（复盘轨迹）。best-effort。
try {
    const lgLines = [
        `终态 ${terminated}（runId ${activeRunId}）：done ${doneIds.length} / blocked ${blockedOut.length} / skipped ${skippedIds.length}`,
    ];
    const coreFailureInfo = readCoreFail();
    if (coreFailureInfo)
        lgLines.push(`- [裁决] coreFailure：${coreFailureInfo.id}——${coreFailureInfo.detail.replace(/\n+/g, " ")}`);
    for (const b of blockedOut)
        lgLines.push(`- [裁决] ${b.id}（${b.reason}，attempts ${b.attempts}）——升级用户：采纳修复方案 / 放弃该单元`);
    for (const dc of deferredCommits)
        lgLines.push(`- [待办] 代提交 ${dc.id}：${dc.message}`);
    if (residualFiles.length > 0)
        lgLines.push(`- [待办] 清单外残留 ${residualFiles.length} 项（判归属后处置，禁静默丢弃）：${residualFiles.join("、")}`);
    lgLines.push(`状态指针：${plan.statusPath}（nodes/events 全量）`);
    const lgw = await world.run("node", ["-e", APPEND_LEDGER, plan.statusPath, skillDataDir, `W2 wave-executor-v2 终态 ${terminated}（mode=${plan.mode}）`, lgLines.join("\n")]);
    if (lgw.exitCode !== 0)
        log(`WARN: ledger 终态追加失败（exit ${lgw.exitCode}）——终态数据以 status.json 与本次返回值为准`);
}
catch (e) {
    log(`WARN: ledger 终态追加异常：${errText(e)}`);
}
// run.json（分析契约，skill-data-redesign §5.1）：落 skillDataDir 根（D2 一致性审查
// 同目录先后写，防覆盖轮转由 startedAt 判据归档）。mustFixTrajectory = null（无审查轮）
if (runStartedAt !== null) {
    const endRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
    const gitRev = await gitRevProbe(plan.projectRoot);
    await writeRunManifest({
        workflow: "wave-executor-v2",
        segment: "dev-flow",
        skillVersion: SKILL_VERSION,
        host: HOST_PLATFORM,
        projectRoot: plan.projectRoot,
        worktreePath: plan.projectRoot,
        branch: gitRev.branch,
        baseCommit: runManifestBase,
        headCommit: gitRev.head,
        attempt: 1,
        model: null,
        startedAt: runStartedAt,
        endedAt: endRes.exitCode === 0 && endRes.stdout.trim() !== "" ? endRes.stdout.trim() : null,
        terminated,
        rounds: 1, // 单轮流式并行调度（打回/自愈是节点内重试，不产生新调度轮）
        mustFixTrajectory: null,
    });
}
else {
    log("WARN: run.json 未落盘（startedAt 探针失败，防覆盖判据不可用）——终态数据以 status.json 与返回值为准");
}
// 观测终态统一补记（O 区）：给 finalize 补记 end + execution end（outcome=本次终态词）
await obsCloseExecution(terminated);
return {
    terminated,
    done: doneIds,
    blocked: blockedOut,
    skipped: skippedIds,
    statusFile: plan.statusPath,
    coreFailure: coreFail,
    validationError: null,
    deferredCommits,
    residualFiles,
    acceptanceFix: failureFixRounds > 0 || acceptanceDisputed.length > 0
        ? { rounds: failureFixRounds, disputed: acceptanceDisputed, fixesDir: `${skillDataDir}/${String(plan.statusPath.split("/").pop() ?? "status")}.fixes` }
        : null,
};

