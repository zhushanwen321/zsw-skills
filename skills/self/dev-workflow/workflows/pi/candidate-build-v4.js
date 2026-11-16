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
const PROV_WF_NAME = "candidate-build-v4";
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
const SKILL_VERSION = "4.1.4"; // 构建注入自 delivery-v4/SKILL.md frontmatter version（唯一权威）
let repairsJournalPath = "";
const repairCounts = {};
let repairsWarnedWrite = false;
function resilienceErrorText(e) {
    return e instanceof Error ? e.message : String(e);
}
/** 当前 ISO 时间（经 world.run 探针；失败返回空串——登记不因此中断） */
async function repairTimestamp() {
    try {
        const r = await world.run("node", ["-e", "process.stdout.write(new Date().toISOString())"]);
        return r.exitCode === 0 ? r.stdout.trim() : "";
    }
    catch {
        return "";
    }
}
/** 韧性登记启用：taskDir 为空（setup 早期失败）时不落盘，仅内存计数 */
function initResilience(taskDir) {
    repairsJournalPath = taskDir === "" ? "" : `${taskDir}/self-repairs.jsonl`;
}
/** 登记一条韧性事件（JSONL 追加 + 内存计数；写失败只告警一次） */
async function recordRepair(core, outcome) {
    repairCounts[core.kind] = (repairCounts[core.kind] ?? 0) + 1;
    if (repairsJournalPath === "")
        return;
    try {
        const at = await repairTimestamp();
        const line = JSON.stringify({ at, ...core, outcome });
        const r = await world.run("node", [
            "-e",
            "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')",
            repairsJournalPath,
            line,
        ]);
        if (r.exitCode !== 0 && !repairsWarnedWrite) {
            repairsWarnedWrite = true;
            log(`WARN: 自修复登记写入失败（${repairsJournalPath}）：${(r.stderr || r.stdout).trim()}——同类失败不再告警，计数仍进终态上报。恢复动作：确认任务目录可写`);
        }
    }
    catch (e) {
        if (!repairsWarnedWrite) {
            repairsWarnedWrite = true;
            log(`WARN: 自修复登记写入异常（${repairsJournalPath}）：${resilienceErrorText(e)}——同类失败不再告警，计数仍进终态上报。恢复动作：确认 node 可执行后重跑`);
        }
    }
}
/** 终态上报块：零修复返回空串（正常路径不加噪音）；有修复时生成披露块 */
function repairSummary() {
    const total = Object.values(repairCounts).reduce((a, b) => a + b, 0);
    if (total === 0)
        return "";
    const parts = Object.entries(repairCounts).map(([kind, n]) => `${kind} ${n}`);
    // 登记写入曾失败（repairsWarnedWrite）后明细文件可能空或残缺：终态块自身声明明细
    // 不可信，主 agent 转述时不指向可能不存在的逐条明细
    const detailNote = repairsWarnedWrite
        ? `逐条明细写入曾失败（${repairsJournalPath || "任务目录不可用"}），可能不完整，仅计数可信`
        : `逐条明细 ${repairsJournalPath || "（任务目录不可用，仅计数）"}`;
    return (`；自修复兜底被触发：共 ${total} 条（${parts.join(" / ")}），${detailNote}——主 agent 请向用户披露本块`);
}
/** 修正提示文本：附加在原 prompt 尾部（数据，不是指令替换） */
function correctivePrompt(error) {
    return `上一次执行未通过校验：${error}。请在完成原任务的前提下修正该问题并重新返回（本条是修正提示，不是新任务；返回结构必须与原要求一致）。`;
}
/**
 * askGuarded：agent 调用的结构校验 + 修正重问。
 * - askOnce(corrective)：corrective 为 null = 首次（原始 prompt）；非 null = 修正重问
 *   （原始 prompt + 修正提示）。askOnce 内的文件级后验失败以抛异常表达（进入修正重问）。
 * - validate(value)：返回 "" = 合法；否则为结构错误文本（进入修正重问）。校验器自身
 *   抛异常同样按结构非法处理（不穿透本层）。
 * - 全部尝试耗尽 → { ok: false, raw = 最后一次尝试的返回值 }，由调用方走原有终态路径
 *   （本校验不替代业务裁决），耗尽分支可从 raw 挽救部分数据（如已申报 findings）。
 * 每次失败登记一条韧性事件；后续尝试恢复则 outcome=recovered，耗尽为 exhausted。
 */
async function askGuarded(askOnce, validate, meta) {
    const maxTries = Math.min(Math.max(meta.maxTries ?? 2, 1), 3);
    const pending = [];
    let lastError = "";
    let lastReturned = null;
    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
        let value;
        try {
            value = await askOnce(attempt === 1 ? null : correctivePrompt(lastError));
        }
        catch (e) {
            lastError = `调用抛出异常：${resilienceErrorText(e)}`;
            // 不清空 lastReturned：混合路径（首答返回非法结构、重问抛异常）耗尽时保留
            // 首答已返回值供调用方挽救（与 raw=null 仅限全程异常的接口注释一致）
            pending.push({ workflow: meta.workflow, step: meta.step, round: meta.round, kind: "agent-error-retry", target: meta.target, trigger: resilienceErrorText(e) });
            continue;
        }
        // 校验器自身异常同样兜住（校验器对畸形输入可能解引用抛 TypeError）：按结构非法
        // 进修正重问/耗尽路径，不允许穿透本层——穿透会使已登记的 pending 不落 JSONL、
        // workflow 崩溃无终态 message、fail 出口的租约释放全部被绕过
        let structureError = "";
        let validatorCrashed = false;
        try {
            structureError = validate(value);
        }
        catch (e) {
            validatorCrashed = true;
            structureError = `校验器异常：${resilienceErrorText(e)}`;
        }
        if (structureError === "") {
            for (const entry of pending)
                await recordRepair(entry, "recovered");
            return { ok: true, value, raw: value, error: "" };
        }
        lastError = validatorCrashed ? `返回结构非法（${structureError}）` : `返回结构非法：${structureError}`;
        lastReturned = value;
        pending.push({ workflow: meta.workflow, step: meta.step, round: meta.round, kind: "agent-structure-retry", target: meta.target, trigger: structureError });
    }
    for (const entry of pending)
        await recordRepair(entry, "exhausted");
    return { ok: false, value: null, raw: lastReturned, error: `${lastError}（含修正重问共 ${maxTries} 次尝试后耗尽）` };
}
/** CLI spawn 级失败重试（仅只读/幂等命令；变更类命令见文件头注释）。exitCode -1 重试一次 */
async function retryOnSpawnFailure(runOnce, meta) {
    const first = await runOnce();
    if (first.exitCode !== -1)
        return first;
    const second = await runOnce();
    const outcome = second.exitCode === 0 ? "recovered" : "exhausted";
    await recordRepair({
        workflow: meta.workflow,
        step: meta.step,
        round: meta.round,
        kind: "cli-retry",
        target: meta.command,
        trigger: `spawn 级失败（exit -1）：${first.stderr.trim() || first.stdout.trim() || "无输出"}`,
    }, outcome);
    return second;
}
const VALID_ARG_KEYS = new Set([
    // 事件写入凭据：delivery-gate init 输出的 builder 凭据 id（credentialId；
    // 私钥本体不进参数与 prompt，CLI 按凭据文件定位。user/assurance 等
    // 其他角色凭据不得注入本 workflow）
    "builderCredentialId",
    "assuranceCredentialId",
    // 写事务租约（可选）：传入 runId 时 acquire/heartbeat/release 全程配对，append 带 --run-id 复核
    "runId",
    // 观测（O 区，可选）：taskId+executionId 同时提供才启用（sampleType 默认 production）
    "projectRoot",
    "taskDir",
    "taskId",
    "executionId",
    "sampleType",
]);
// NODE_PROBE_HOME 由构建器从 workflows/src/skill-data.shared.ts 寻址层注入，此处不再声明
const NODE_CHECK_EXISTS = "const fs=require('fs');const missing=process.argv.slice(1).filter(p=>!fs.existsSync(p));if(missing.length){process.stdout.write(missing.join(' | '));process.exit(1)}";
const NODE_READ_FILE = "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))";
// 排他创建（与 independent-assurance / assurance-repair-loop 对齐，合并稿 §10.3 证据不可覆盖）：
// 已存在路径拒绝覆盖写并给出含路径与递增序号建议的恢复指引
const NODE_WRITE_FILE = "const fs=require('fs'),pt=require('path');const p=process.argv[1];fs.mkdirSync(pt.dirname(p),{recursive:true});" +
    "try{fs.writeFileSync(p,process.argv[2],{flag:'wx'})}catch(e){if(e.code==='EEXIST'){" +
    "process.stderr.write('文件已存在（排他创建拒绝覆盖）：'+p+'；恢复动作：换新文件名（递增序号，如 '+p.replace(/(\\.[^.]*)?$/,m=>'-2'+m)+'）后重试');process.exit(1)}throw e}";
const NODE_APPEND_FILE = "require('fs').appendFileSync(process.argv[1],process.argv[2])";
// 超时入参（第 5 参）来自 increments 契约的 testCommand.timeoutMs（CLI validate-acceptance
// 已校验 1000..3600000 整数）；非法或缺省回退 300000，与 CLI 缺省值一致——防长测试任务
// 在 300s 被截断后回执 exitCode=-1、被登记为 blocker 伪发现而永停 build-failed
const NODE_RUN_TEST = "const fs=require('fs'),cp=require('child_process'),pt=require('path');" +
    "const cwd=process.argv[1],logPath=process.argv[2],program=process.argv[3],args=JSON.parse(process.argv[4]);" +
    "const rawTimeout=parseInt(process.argv[5],10);" +
    "const timeoutMs=Number.isInteger(rawTimeout)&&rawTimeout>=1000&&rawTimeout<=3600000?rawTimeout:300000;" +
    "fs.mkdirSync(pt.dirname(logPath),{recursive:true});" +
    "const r=cp.spawnSync(program,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024,timeout:timeoutMs});" +
    "const code=r.error?127:(r.status===null?-1:r.status);" +
    "fs.writeFileSync(logPath,'command: '+JSON.stringify({program,args,cwd,timeoutMs})+'\\nexitCode: '+code+'\\n--- stdout ---\\n'+(r.stdout||'')+'\\n--- stderr ---\\n'+(r.stderr||'')+'\\n--- spawn error ---\\n'+String(r.error&&r.error.message||''));" +
    "process.stdout.write(JSON.stringify({exitCode:code,spawnError:r.error?String(r.error.code||r.error.message):null,artifact:logPath}))";
async function runNode(argv, timeoutMs = 330000) {
    try {
        return await world.run("node", ["-e", ...argv], { timeoutMs });
    }
    catch (e) {
        return { exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
}
async function runGate(gatePath, gateArgs) {
    try {
        return await world.run("node", [gatePath, ...gateArgs]);
    }
    catch (e) {
        return { exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
}
function absolutePath(value) {
    if (typeof value !== "string" || !value.trim().startsWith("/"))
        return "";
    const trimmed = value.trim();
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}
function errorText(e) {
    return e instanceof Error ? e.message : String(e);
}
function revisionHash(revision) {
    let hash = 2166136261;
    for (let i = 0; i < revision.length; i += 1)
        hash = Math.imul(hash ^ revision.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
}
function parseObject(raw) {
    try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
obsCtx = initObservation("delivery-v4", "BUILD", null);
const homeRes = await runNode([NODE_PROBE_HOME]);
if (homeRes.exitCode !== 0 || homeRes.stdout.trim() === "") {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir: "", revision: "", implementedIncrementIds: [], findingIds: [], verdict: null,
        message: `HOME 探针失败（exit ${homeRes.exitCode}）：${homeRes.stderr.trim()}。恢复动作：确认 node 可执行后重新发起`,
    };
    return result;
}
const homeDir = homeRes.stdout.trim();
obsAttachHome(homeDir);
await obsEmit("execution", null, "start", null);
await obsBegin("setup", null);
const inputProblems = [];
for (const key of Object.keys(args)) {
    if (!VALID_ARG_KEYS.has(key) && !key.startsWith("_"))
        inputProblems.push(`未知参数 ${key}`);
}
const projectRoot = absolutePath(args.projectRoot);
const taskDir = absolutePath(args.taskDir);
const builderCredentialId = typeof args.builderCredentialId === "string" ? args.builderCredentialId.trim() : "";
const assuranceCredentialId = typeof args.assuranceCredentialId === "string" ? args.assuranceCredentialId.trim() : "";
const leaseRunId = typeof args.runId === "string" ? args.runId.trim() : "";
if (projectRoot === "")
    inputProblems.push("projectRoot 须为项目根绝对路径");
if (taskDir === "")
    inputProblems.push("taskDir 须为 delivery-gate init 创建的任务目录绝对路径");
if (builderCredentialId === "")
    inputProblems.push("builderCredentialId 须为 init 输出的 builder 凭据 id（形态 <分组>/<任务id>/builder）");
if (assuranceCredentialId === "")
    inputProblems.push("assuranceCredentialId 须为 init 输出的 assurance 凭据 id；候选反例审查只能由 assurance 角色登记");
for (const foreignKey of ["userKey", "assuranceKey", "writerKey"]) {
    if (Object.hasOwn(args, foreignKey)) {
        inputProblems.push(`${foreignKey} 属其他角色凭据，禁止注入 candidate-build-v4；本 workflow 只接收 builderCredentialId`);
    }
}
if (inputProblems.length > 0) {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision: "", implementedIncrementIds: [], findingIds: [], verdict: null,
        message: `参数校验失败：${inputProblems.join("；")}。恢复动作：修正参数后重新发起`,
    };
    return result;
}
const gatePath = `${homeDir}/.agents/skills/delivery-v4/scripts/delivery-gate.mjs`;
const builderRolePath = `${homeDir}/.agents/skills/delivery-v4/references/roles/builder.md`;
const explorerRolePath = `${homeDir}/.agents/skills/delivery-v4/references/roles/explorer.md`;
// 韧性登记启用（taskDir 已校验）：self-repairs.jsonl 落任务目录，终态 message 携带汇总
initResilience(taskDir);
const acceptancePath = `${taskDir}/acceptance.json`;
const incrementsPath = `${taskDir}/increments.json`;
const eventsPath = `${taskDir}/events.jsonl`;
const verdictPath = `${taskDir}/verdict.json`;
const taskJsonPath = `${taskDir}/task.json`;
const requiredRes = await runNode([NODE_CHECK_EXISTS, projectRoot, taskDir, taskJsonPath, acceptancePath, incrementsPath, eventsPath, gatePath, builderRolePath, explorerRolePath]);
if (requiredRes.exitCode !== 0) {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision: "", implementedIncrementIds: [], findingIds: [], verdict: null,
        message: `构建环境缺少必读路径：${requiredRes.stdout.trim()}。恢复动作：先完成 acceptance-design-v4 与用户批准，再确认 delivery-v4 安装和任务目录后重新发起`,
    };
    return result;
}
const builderRoleRes = await runNode([NODE_READ_FILE, builderRolePath]);
const explorerRoleRes = await runNode([NODE_READ_FILE, explorerRolePath]);
const taskRes = await runNode([NODE_READ_FILE, taskJsonPath]);
const taskRecord = parseObject(taskRes.stdout);
// evaluate 只读：spawn 级失败可安全重试一次（下同——全部 evaluate 调用点）
const initialEvaluation = await retryOnSpawnFailure(() => runGate(gatePath, ["evaluate", "--task-dir", taskDir]), { workflow: "candidate-build-v4", step: "setup", round: null, command: "evaluate" });
const initialVerdict = parseObject(initialEvaluation.stdout);
if (builderRoleRes.exitCode !== 0 || explorerRoleRes.exitCode !== 0 || taskRecord === null || taskRecord.projectRoot !== projectRoot ||
    initialEvaluation.exitCode !== 0 || initialVerdict === null ||
    typeof initialVerdict.revision !== "string" || initialVerdict.revision === "" ||
    typeof initialVerdict.acceptanceVersion !== "number" ||
    typeof initialVerdict.state !== "string" ||
    !Array.isArray(initialVerdict.implementedIncrementIds) ||
    !Array.isArray(initialVerdict.openFindings) ||
    !Array.isArray(initialVerdict.requirements)) {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision: "", implementedIncrementIds: [], findingIds: [], verdict: initialVerdict,
        message: `构建前置校验失败：${initialEvaluation.stderr.trim() || initialEvaluation.stdout.trim() || "task.json、角色提示词或 verdict 非法"}。恢复动作：按 delivery-gate 错误修复契约/增量/事件，并核对 task.json 后重跑 evaluate${repairSummary()}`,
    };
    return result;
}
const revision = initialVerdict.revision;
const acceptanceVersion = initialVerdict.acceptanceVersion;
// 只核验任务（init --verification-only 纳管体系外已有实现）：豁免方案包与 DesignApproved 门
const verificationOnlyTask = taskRecord.verificationOnly === true;
if (initialVerdict.state === "draft") {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision, implementedIncrementIds: [], findingIds: [], verdict: initialVerdict,
        message: `前置状态门禁拒绝：当前 verdict state=draft，契约尚未获用户批准，不进入实现。恢复动作：先运行 acceptance-design-v4，由主会话在用户批准后执行 delivery-gate approve-acceptance（带 --credential <user credentialId>），再重新发起 candidate-build-v4${repairSummary()}`,
    };
    return result;
}
if (initialVerdict.state === "design" && !verificationOnlyTask) {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision, implementedIncrementIds: [], findingIds: [], verdict: initialVerdict,
        message: `前置状态门禁拒绝：当前 verdict state=design，验收已批准但方案包未经确认（无 DesignApproved），不进入实现。恢复动作：先运行 tech-design-v4 产出完整方案包，由主会话在用户确认后执行 delivery-gate record-design-approved（带 --credential <user credentialId>），再重新发起 candidate-build-v4（--verification-only 任务豁免本门）${repairSummary()}`,
    };
    return result;
}
const acceptanceRes = await runNode([NODE_READ_FILE, acceptancePath]);
const incrementsRes = await runNode([NODE_READ_FILE, incrementsPath]);
const eventsRes = await runNode([NODE_READ_FILE, eventsPath]);
const acceptanceDoc = parseObject(acceptanceRes.stdout);
const incrementsDoc = parseObject(incrementsRes.stdout);
const requirements = Array.isArray(acceptanceDoc?.requirements) ? acceptanceDoc.requirements : [];
const increments = Array.isArray(incrementsDoc?.items) ? incrementsDoc.items : [];
const events = [];
let eventsError = "";
for (const line of eventsRes.stdout.split("\n").filter((l) => l.trim() !== "")) {
    try {
        events.push(JSON.parse(line));
    }
    catch (e) {
        eventsError = errorText(e);
        break;
    }
}
if (acceptanceRes.exitCode !== 0 || incrementsRes.exitCode !== 0 || eventsRes.exitCode !== 0 || eventsError !== "" ||
    acceptanceDoc === null || incrementsDoc === null || requirements.length === 0 || increments.length === 0 ||
    acceptanceDoc.acceptanceVersion !== acceptanceVersion || incrementsDoc.acceptanceVersion !== acceptanceVersion) {
    await obsCloseExecution("setup-failure");
    const result = {
        terminated: "setup-failure", taskDir, revision, implementedIncrementIds: [], findingIds: [], verdict: initialVerdict,
        message: `契约、增量或事件不可读（${eventsError || "版本或数组结构不匹配"}）。恢复动作：先运行 delivery-gate validate-acceptance 与 evaluate，按输出修复后重新发起${repairSummary()}`,
    };
    return result;
}
const requirementIds = new Set(requirements.map((r) => r.id));
const incrementIds = new Set(increments.map((item) => item.id));
// 已实现增量按 acceptanceVersion 判定（与 gate 折叠同口径）：revision 变化不触发全量重做
const implemented = new Set(initialVerdict.implementedIncrementIds.filter((id) => typeof id === "string" && incrementIds.has(id)));
const raisedSummaries = new Map();
for (const event of events) {
    if (event.type === "FindingRaised" && event.acceptanceVersion === acceptanceVersion && typeof event.findingId === "string") {
        raisedSummaries.set(event.findingId, event.summary);
    }
}
const openFindingEntries = [];
for (const raw of initialVerdict.openFindings) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        continue;
    const finding = raw;
    if (typeof finding.findingId !== "string")
        continue;
    openFindingEntries.push({
        findingId: finding.findingId,
        severity: typeof finding.severity === "string" ? finding.severity : "",
        requirementIds: Array.isArray(finding.requirementIds)
            ? finding.requirementIds.filter((id) => typeof id === "string")
            : [],
        summary: raisedSummaries.get(finding.findingId) ?? "",
    });
}
// 修复轮信号 = 未决发现关联需求 ∪ 当前失败证据需求；无关联需求的发现（不区分
// severity——被选择修复的无关联 non-blocker 同样需要增量承接，否则静默跳过=假修复）
// 令全部增量进入修复轮
const reworkRequirementIds = new Set();
let findingWithoutRequirement = false;
for (const finding of openFindingEntries) {
    for (const id of finding.requirementIds)
        reworkRequirementIds.add(id);
    if (finding.requirementIds.length === 0)
        findingWithoutRequirement = true;
}
for (const raw of initialVerdict.requirements) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        continue;
    const requirement = raw;
    if (typeof requirement.id === "string" && requirement.status === "failed")
        reworkRequirementIds.add(requirement.id);
}
const builderPersona = builderRoleRes.stdout;
const findingIds = [];
const completedThisRun = [];
let findingSequence = 0;
// 写事务租约（可选）：传入 runId 时 setup 获取 projectRoot 级租约，长循环逐增量
// 心跳，append 全程带 --run-id 做代次复核，任何出口 release——保证期写入互斥
let leaseHeld = false;
async function releaseLease() {
    if (leaseHeld && leaseRunId !== "") {
        leaseHeld = false;
        await runGate(gatePath, ["lease-release", "--project-root", projectRoot, "--run-id", leaseRunId]).catch(() => undefined);
    }
}
if (leaseRunId !== "") {
    const leaseRes = await runGate(gatePath, ["lease-acquire", "--project-root", projectRoot, "--run-id", leaseRunId]);
    if (leaseRes.exitCode !== 0) {
        await obsCloseExecution("setup-failure");
        const result = {
            terminated: "setup-failure", taskDir, revision, implementedIncrementIds: [], findingIds: [], verdict: initialVerdict,
            message: `写事务租约获取失败：${(leaseRes.stderr || leaseRes.stdout).trim()}。恢复动作：按输出处理占用租约的运行（等待或由主会话接管）后重新发起${repairSummary()}`,
        };
        return result;
    }
    leaseHeld = true;
}
async function appendEvent(event) {
    const appendArgs = ["append", "--task-dir", taskDir, "--event", JSON.stringify(event), "--credential", builderCredentialId];
    if (leaseRunId !== "")
        appendArgs.push("--run-id", leaseRunId);
    const appended = await runGate(gatePath, appendArgs);
    if (appended.exitCode !== 0)
        return appended.stderr.trim() || appended.stdout.trim() || `append exit ${appended.exitCode}`;
    events.push(event);
    return null;
}
function validateBuilderOutcome(value) {
    if (typeof value.summary !== "string" || value.summary.trim() === "")
        return "summary 须为非空字符串";
    if (!Array.isArray(value.findings))
        return "findings 须为数组";
    for (const finding of value.findings) {
        if (typeof finding.summary !== "string" || finding.summary.trim() === "")
            return "finding.summary 须为非空字符串";
        if (finding.severity !== "blocker" && finding.severity !== "non-blocker")
            return "finding.severity 非法";
        if (finding.origin !== undefined && !["acceptance", "design", "planning", "implementation", "testing", "evidence", "environment"].includes(finding.origin))
            return "finding.origin 非法";
        if (acceptanceDoc?.schemaVersion === 2 && finding.severity === "non-blocker") {
            if (typeof finding.consequenceRefutation !== "string" || finding.consequenceRefutation.trim() === "") {
                return "schema 2 非 blocker 必须附 consequenceRefutation";
            }
            if (finding.consequenceRefutationType !== "will-not-occur" && finding.consequenceRefutationType !== "not-observable" && finding.consequenceRefutationType !== "accepted-by-acceptance") {
                return "schema 2 非 blocker 必须声明 consequenceRefutationType（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许）";
            }
        }
        if (!Array.isArray(finding.requirementIds) || finding.requirementIds.some((id) => typeof id !== "string" || !requirementIds.has(id))) {
            return "finding.requirementIds 必须引用契约条目或为空数组";
        }
    }
    return "";
}
async function appendFinding(draft, artifact) {
    let findingId = "";
    do {
        findingSequence += 1;
        findingId = `F-B${findingSequence}`;
    } while (events.some((e) => e.findingId === findingId));
    const event = {
        type: "FindingRaised",
        actor: "builder",
        acceptanceVersion,
        revision,
        summary: draft.summary,
        findingId,
        category: draft.category === "boundary" ? "boundary" : "defect",
        requirementIds: draft.requirementIds,
        severity: draft.severity,
        artifact,
    };
    const error = await appendEvent(event);
    if (error !== null)
        throw new Error(`FindingRaised 追加失败：${error}。恢复动作：修复 delivery-gate 报告的问题后重跑`);
    findingIds.push(findingId);
    return findingId;
}
/** 终态附加行：观测启用时给主 agent 统计入口指引（耗时与 token 的查询路径） */
function statsTailNote() {
    return obsCtx !== null && obsCtx.filePath !== ""
        ? `；耗时与 token 统计：node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill delivery-v4（阶段窗口来自观测文件 ${obsCtx.filePath}）`
        : "";
}
/** 排他写证据文件：路径已存在（EEXIST）时按 -2/-3 递增文件名重试，全部失败返回空串
 * （调用方把写入失败并入 message——failBuild 的发现登记失败已有包装，不静默吞） */
async function writeEvidenceExclusive(path, content) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const candidate = attempt === 1 ? path : path.replace(/(\.[^.]*)?$/, (ext) => `-${attempt}${ext}`);
        const res = await runNode([NODE_WRITE_FILE, candidate, content]);
        if (res.exitCode === 0)
            return candidate;
        if (!res.stderr.includes("EEXIST") && !res.stdout.includes("EEXIST"))
            return "";
    }
    return "";
}
/** 证据文件内容哈希（evidence/ 内绝对路径） */
async function artifactSha256Of(artifactPath) {
    const script = "const c=require('crypto'),f=process.argv[1];process.stdout.write(c.createHash('sha256').update(require('fs').readFileSync(f)).digest('hex'))";
    const res = await runNode([script, artifactPath]);
    if (res.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(res.stdout.trim())) {
        throw new Error(`证据文件哈希计算失败：${artifactPath}（${res.stderr.trim() || res.stdout.trim()}）`);
    }
    return res.stdout.trim();
}
/** 基础设施失败出口：不登记 FindingRaised（builder 已申报的产品发现除外），
 * 落 failure 产物、返回前重新 evaluate 取当前裁决（evaluate 失败则 verdict=null） */
async function failBuild(message, artifact, drafts = []) {
    let fullMessage = message;
    for (const draft of drafts) {
        try {
            await appendFinding(draft, artifact);
        }
        catch (e) {
            fullMessage += `；builder 发现登记失败：${errorText(e)}`;
        }
    }
    // 失败出口同样释放租约（append 已全部完成后再释放——append 依赖租约代次复核）
    await releaseLease();
    const reEvaluation = await retryOnSpawnFailure(() => runGate(gatePath, ["evaluate", "--task-dir", taskDir]), { workflow: "candidate-build-v4", step: "finalize", round: null, command: "evaluate" });
    const reVerdict = parseObject(reEvaluation.stdout);
    if (reEvaluation.exitCode !== 0 || reVerdict === null) {
        fullMessage += `；build-failed 后重新 evaluate 失败：${reEvaluation.stderr.trim() || reEvaluation.stdout.trim()}，verdict 置空`;
    }
    await obsCloseExecution("build-failed");
    return {
        terminated: "build-failed",
        taskDir,
        revision,
        implementedIncrementIds: completedThisRun,
        findingIds,
        verdict: reVerdict,
        message: `${fullMessage}。恢复动作：修复对应增量与未决发现后重新发起 candidate-build-v4${repairSummary()}${statsTailNote()}`,
    };
}
await obsEnd("setup", null);
phase("逐增量形成候选实现");
// 回执链衔接：每增量 fromRevision = 上一已完成增量的 postRevision（初始为 setup 基线），
// 多增量时逐条衔接而非全部挂 setup 基线
let lastCompletedRevision = revision;
for (let index = 0; index < increments.length; index += 1) {
    const item = increments[index];
    // 长循环期间逐增量心跳续租（失败不中断：租约被接管时后续 append --run-id 会被拒并走失败出口）
    if (leaseHeld) {
        await runGate(gatePath, ["lease-heartbeat", "--project-root", projectRoot, "--run-id", leaseRunId]).catch(() => undefined);
    }
    const itemRequirementIdSet = new Set(item.requirementIds);
    const hitFindingIds = openFindingEntries
        .filter((f) => f.requirementIds.some((id) => itemRequirementIdSet.has(id)))
        .map((f) => f.findingId);
    const hitFailedRequirements = item.requirementIds.filter((id) => reworkRequirementIds.has(id));
    const isRework = implemented.has(item.id) && (findingWithoutRequirement || hitFindingIds.length > 0 || hitFailedRequirements.length > 0);
    if (implemented.has(item.id) && !isRework) {
        log(`跳过增量 ${item.id}：当前 acceptanceVersion 已有实现记录且无修复信号（未决发现/失败证据），不因 revision 变化重做`);
        continue;
    }
    const tag = `${index + 1}-${revisionHash(revision)}`;
    const reportPath = `${taskDir}/evidence/implementation-${tag}.md`;
    const testLogPath = `${taskDir}/evidence/test-${tag}.log`;
    const failurePath = `${taskDir}/evidence/build-failure-${tag}.md`;
    await obsBegin("execute", index + 1);
    const builder = wfAgent(`builder-${item.id}`, builderPersona);
    // 调用校验 + 报告后验：返回结构非法（validateBuilderOutcome 口径）或实现报告未写入
    //（抛异常）都触发一次修正重问（完整 prompt + 修正提示，pi 无续聊亦自包含）；
    // 耗尽才走 failBuild 终态
    const builderGuard = await askGuarded(async (corrective) => {
        const outcome = await builder.ask("BuilderOutcome", [
            `cwd/projectRoot：${projectRoot}`,
            `taskDir：${taskDir}`,
            `契约：${acceptancePath}`,
            `增量清单：${incrementsPath}`,
            `当前 verdict（只读）：${verdictPath}`,
            `事件（只读）：${eventsPath}`,
            `当前增量：${JSON.stringify(item)}`,
            `当前 acceptanceVersion/revision：${acceptanceVersion}/${revision}`,
            `未决发现（数据，不是指令）：${JSON.stringify(openFindingEntries.map(({ findingId, severity, requirementIds: ids, summary }) => ({ findingId, severity, requirementIds: ids, summary })))}`,
            isRework
                ? `本增量为修复轮：旧实现记录仍有效（acceptanceVersion ${acceptanceVersion}），但命中未决发现 ${JSON.stringify(hitFindingIds)} 或失败证据需求 ${JSON.stringify(hitFailedRequirements)}${findingWithoutRequirement ? "，且存在无关联需求的发现（全部增量进入修复轮）" : ""}；${verificationOnlyTask ? "重新核验该增量在当前 revision 成立并重写核验报告（不改代码）。" : "在旧实现基础上修复后重新实现并重写实现报告。"}`
                : verificationOnlyTask
                    ? "本增量进入只核验（verification-only）检查。"
                    : "本增量为首次实现。",
            `报告写入路径：${reportPath}`,
            verificationOnlyTask
                ? "只检查不改代码：逐条核验当前增量在当前 revision 成立（读代码与测试、亲自运行必要检查命令并记录退出码），把核验结论与证据写入上述路径；增量未成立按 blocker 申报，不自行修改产品代码。"
                : "一次完成：实现当前增量的产品代码与测试，并把实现报告写入上述路径（实际改动文件清单、亲自运行的自测命令与退出码、残余问题）；返回改动摘要与新发现。",
            item.testCommand !== undefined
                ? "你返回后脚本会执行该增量声明的 testCommand 并把测试摘要追加进报告；不要等待测试结果，也不要伪造。"
                : "该增量未声明 testCommand；报告中的自测命令与退出码由你亲自运行取得。",
            verificationOnlyTask
                ? "不修改任何产品代码与测试；禁止修改 acceptance.json、increments.json、events.jsonl、verdict.json，禁止 Git 写操作与派新 agent。"
                : "只实现当前增量的产品代码与测试；禁止修改 acceptance.json、increments.json、events.jsonl、verdict.json，禁止 Git 写操作与派新 agent。",
            "builder 的测试输出不是 verified 证据；不要写 EvidenceRecorded 或宣告 accepted。",
            '返回结构（严格 JSON）：{ "summary": string, "findings": [{ "summary": string, "requirementIds": string[], "severity": "blocker"|"non-blocker", "category"?: "defect"|"boundary", "consequenceRefutation": string|null, "consequenceRefutationType": "will-not-occur"|"not-observable"|"accepted-by-acceptance"|null, "origin": string|null, "expectedStage": string|null, "regressionTestRef": string|null }] }——无发现也须返回空 findings 数组；schema 2 非 blocker 必须先标 consequenceRefutationType（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许）再给 consequenceRefutation 依据。',
            ...(corrective === null ? [] : [corrective]),
        ].join("\n"));
        const reportCheck = await runNode([NODE_CHECK_EXISTS, reportPath]);
        if (reportCheck.exitCode !== 0) {
            throw new Error(`实现报告未写入 ${reportPath}——报告与结构化返回同为完成判据，须在同一次任务内完成`);
        }
        return outcome;
    }, validateBuilderOutcome, { workflow: "candidate-build-v4", step: "execute", round: index + 1, target: `builder-${item.id}` });
    if (!builderGuard.ok || builderGuard.value === null) {
        const message = `builder 实现增量 ${item.id} 时调用失败：${builderGuard.error}`;
        const writtenFailurePath = await writeEvidenceExclusive(failurePath, `# 构建失败\n\n${message}\n`);
        // 耗尽不丢弃已申报发现：最后一次尝试返回的 findings 按 validateBuilderOutcome 单条
        // 口径过滤出可挽救条目，随 failure 产物经 failBuild 登记（防真实缺陷静默蒸发）
        const rawFindings = builderGuard.raw !== null && Array.isArray(builderGuard.raw.findings) ? builderGuard.raw.findings : [];
        const salvageable = rawFindings.filter((d) => typeof d?.summary === "string" && d.summary.trim() !== "" &&
            (d.severity === "blocker" || d.severity === "non-blocker") &&
            Array.isArray(d.requirementIds) && d.requirementIds.every((id) => typeof id === "string" && requirementIds.has(id)));
        return failBuild(message, writtenFailurePath === "" ? failurePath : writtenFailurePath, salvageable);
    }
    const outcome = builderGuard.value;
    // builder 与 explorer 是同一增量内的两个顺序长调用：循环头心跳只覆盖增量边界，此处
    // 补中间点（与 ia/arl 同口径——把常见租约窗口缩到单次调用；残余窗口后果有界：接管后
    // append 被代次复核拒之门外，响亮失败不双写）
    if (leaseHeld) {
        await runGate(gatePath, ["lease-heartbeat", "--project-root", projectRoot, "--run-id", leaseRunId]).catch(() => undefined);
    }
    let testExitCode = 0;
    let testSummary = "当前增量未声明 testCommand";
    if (item.testCommand !== undefined) {
        // 外层 wrapper 超时 = clamp 后生效值 +30s 缓冲（缺省 300000 时恰为原默认 330000），
        // 防 world.run 先于内层 spawnSync 截断长测试；第 5 参原样传声明值，clamp 在脚本内做
        const declaredTimeout = item.testCommand.timeoutMs;
        const effectiveTimeout = typeof declaredTimeout === "number" && Number.isInteger(declaredTimeout) && declaredTimeout >= 1000 && declaredTimeout <= 3600000
            ? declaredTimeout
            : 300000;
        const testRes = await runNode([
            NODE_RUN_TEST,
            projectRoot,
            testLogPath,
            item.testCommand.program,
            JSON.stringify(item.testCommand.args),
            String(item.testCommand.timeoutMs ?? 300000),
        ], effectiveTimeout + 30000);
        const testMeta = parseObject(testRes.stdout);
        if (testRes.exitCode !== 0 || testMeta === null || typeof testMeta.exitCode !== "number" ||
            (typeof testMeta.spawnError === "string" && testMeta.spawnError !== "")) {
            const message = `增量 ${item.id} 的 testCommand 无法执行或日志不可读：${testRes.stderr.trim() || testRes.stdout.trim()}`;
            const cmdFailurePath = await writeEvidenceExclusive(failurePath, `# 构建失败\n\n${message}\n`);
            return failBuild(message, cmdFailurePath === "" ? failurePath : cmdFailurePath, outcome.findings);
        }
        testExitCode = testMeta.exitCode;
        testSummary = `testCommand exit=${testExitCode}，原始日志=${testLogPath}`;
    }
    await runNode([NODE_APPEND_FILE, reportPath, `\n\n## 引擎测试摘要（脚本追加，builder 返回后生成）\n\n${testSummary}\n`]);
    if (testExitCode !== 0) {
        const message = `增量 ${item.id} 的 testCommand 失败（exit ${testExitCode}），原始日志 ${testLogPath}`;
        try {
            await appendFinding({ summary: message, requirementIds: item.requirementIds, severity: "blocker" }, testLogPath);
        }
        catch (e) {
            const redFailurePath = await writeEvidenceExclusive(failurePath, `# 构建失败\n\n${message}\n${errorText(e)}\n`);
            return failBuild(`${message}；失败发现登记失败：${errorText(e)}`, redFailurePath === "" ? testLogPath : redFailurePath, outcome.findings);
        }
        return failBuild(message, testLogPath, outcome.findings);
    }
    if (outcome.findings.some((d) => d.severity === "blocker")) {
        return failBuild(`增量 ${item.id} 申报 blocker，未记录为已完成`, reportPath, outcome.findings);
    }
    // 合并回执：起始指纹 = 上一已完成增量的 postRevision（setup 基线起链）；合并后指纹
    // = builder 完成后重算的当前 revision；补丁哈希 = 工作树相对 HEAD 的 diff 内容哈希
    // （写入代理语义由引擎承担——它执行测试并核对产物）。revision 只读，spawn 级失败重试一次
    const postRevisionRes = await retryOnSpawnFailure(() => runGate(gatePath, ["revision", "--project-root", projectRoot]), { workflow: "candidate-build-v4", step: "execute", round: index + 1, command: "revision" });
    let postRevision = revision;
    if (postRevisionRes.exitCode === 0)
        postRevision = postRevisionRes.stdout.trim();
    // 补丁哈希：工作树相对 HEAD 的 diff 经 shasum（拿不到时退化为全零并在摘要与实现
    // 报告注明——事件仍成立，回执的 from/to 指纹是防伪主绑定）
    const patchRes = await world.run("sh", [
        "-c",
        `git -C ${projectRoot} diff --binary --full-index HEAD -- | shasum -a 256 | cut -d' ' -f1`,
    ]).catch(() => null);
    const patchSha256 = patchRes && patchRes.exitCode === 0 && /^[0-9a-f]{64}$/.test(patchRes.stdout.trim())
        ? patchRes.stdout.trim()
        : "0".repeat(64);
    const patchShaUnavailable = patchSha256 === "0".repeat(64);
    const mergeReceipt = {
        fromRevision: lastCompletedRevision,
        toRevision: postRevision,
        patchSha256,
    };
    // 候选反例审查对全部 schema 2 任务执行（合并稿 §2.1/§5.3：D3 后 D4 前无风险门控；
    // 探索维度按验收包 reviewDimensions 派生，可为空数组）
    if (acceptanceDoc?.schemaVersion === 2) {
        const explorationReportPath = `${taskDir}/evidence/candidate-exploration-${item.id}-${revisionHash(postRevision)}.md`;
        const dimensions = Array.isArray(acceptanceDoc.reviewDimensions) ? acceptanceDoc.reviewDimensions : [];
        const explorer = wfAgent(`candidate-explorer-${item.id}`, explorerRoleRes.stdout);
        const history = events.filter((event) => event.type === "ExplorationCompleted").map((event) => ({ eventId: event.eventId, revision: event.revision, artifact: event.artifact }));
        const explorationGuard = await askGuarded(async (corrective) => {
            const exploration = await explorer.ask("ExplorationOutcome", [
                `cwd/projectRoot：${projectRoot}`,
                `taskDir：${taskDir}；原始意图与验收：${acceptancePath}`,
                `候选增量：${item.id}；实现报告：${reportPath}`,
                `历史探索索引（不得重复已排除方向）：${JSON.stringify(history)}`,
                `探索报告写入路径：${explorationReportPath}`,
                `必须覆盖维度：${JSON.stringify(dimensions)}`,
                "从原始意图、验收与真实实现构造反例并亲自运行实验。每条 must-fix 给 origin/expectedStage/regressionTestRef；非 blocker 必须先标 consequenceRefutationType（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许）再给 consequenceRefutation 依据。",
                '返回结构（严格 JSON）：{ "summary": string, "dimensions": string[], "findings": [{ "summary": string, "requirementIds": string[], "severity": "blocker"|"non-blocker", "category"?: "defect"|"boundary", "consequenceRefutation": string|null, "consequenceRefutationType": "will-not-occur"|"not-observable"|"accepted-by-acceptance"|null, "origin": string|null, "expectedStage": string|null, "regressionTestRef": string|null }] }',
                ...(corrective === null ? [] : [corrective]),
            ].join("\n"));
            const reportCheck = await runNode([NODE_CHECK_EXISTS, explorationReportPath]);
            if (reportCheck.exitCode !== 0)
                throw new Error(`候选探索报告未写入 ${explorationReportPath}`);
            return exploration;
        }, (value) => {
            if (!value || typeof value.summary !== "string" || value.summary.trim() === "")
                return "summary 必填";
            if (!Array.isArray(value.dimensions))
                return "dimensions 必须为数组";
            for (const dimension of dimensions)
                if (!value.dimensions.includes(dimension))
                    return `缺探索维度 ${dimension}`;
            return validateBuilderOutcome(value);
        }, { workflow: "candidate-build-v4", step: "execute", round: index + 1, target: `candidate-explorer-${item.id}` });
        if (!explorationGuard.ok || explorationGuard.value === null)
            return failBuild(`候选反例审查失败：${explorationGuard.error}`, explorationReportPath);
        const exploration = explorationGuard.value;
        for (const draft of exploration.findings) {
            const event = {
                type: "FindingRaised", actor: "assurance", acceptanceVersion, revision: postRevision,
                summary: draft.summary, findingId: `F-X${findingSequence + 1}`, category: draft.category ?? "defect",
                severity: draft.severity, requirementIds: draft.requirementIds,
                ...(draft.consequenceRefutation === undefined ? {} : { consequenceRefutation: draft.consequenceRefutation }),
                ...(draft.consequenceRefutationType === undefined ? {} : { consequenceRefutationType: draft.consequenceRefutationType }),
                ...(draft.origin === undefined ? {} : { origin: draft.origin }),
                ...(draft.expectedStage === undefined ? {} : { expectedStage: draft.expectedStage }),
                ...(draft.regressionTestRef === undefined ? {} : { regressionTestRef: draft.regressionTestRef }),
                artifact: explorationReportPath,
            };
            while (events.some((item) => item.findingId === event.findingId)) {
                findingSequence += 1;
                event.findingId = `F-X${findingSequence + 1}`;
            }
            findingSequence += 1;
            const appended = await runGate(gatePath, ["append", "--task-dir", taskDir, "--event", JSON.stringify(event), "--credential", assuranceCredentialId]);
            if (appended.exitCode !== 0)
                return failBuild(`候选探索发现登记失败：${appended.stderr.trim()}`, explorationReportPath);
            events.push(event);
            findingIds.push(event.findingId);
        }
        // 探索报告哈希（coverageManifestSha256 与 artifactSha256 同源同值：同一文件的内容寻址）
        let explorationReportSha = "";
        try {
            explorationReportSha = await artifactSha256Of(explorationReportPath);
        }
        catch (e) {
            return failBuild(`候选探索证据哈希失败：${errorText(e)}`, explorationReportPath);
        }
        const explorationEvent = {
            type: "ExplorationCompleted", actor: "assurance", acceptanceVersion, revision: postRevision,
            summary: exploration.summary, dimensions: exploration.dimensions,
            coverageManifestSha256: explorationReportSha, artifactSha256: explorationReportSha, artifact: explorationReportPath,
        };
        const explorationAppended = await runGate(gatePath, ["append", "--task-dir", taskDir, "--event", JSON.stringify(explorationEvent), "--credential", assuranceCredentialId]);
        if (explorationAppended.exitCode !== 0)
            return failBuild(`ExplorationCompleted 登记失败：${explorationAppended.stderr.trim()}`, explorationReportPath);
        events.push(explorationEvent);
        if (exploration.findings.some((finding) => finding.severity === "blocker")) {
            return failBuild(`候选反例审查发现 blocker；先让 builder 按未决发现修复并重新探索，再登记实现`, explorationReportPath);
        }
    }
    const implementationEvent = {
        type: "ImplementationRecorded",
        actor: "builder",
        acceptanceVersion,
        revision: postRevision,
        summary: `${verificationOnlyTask ? "[verification-only] " : ""}${outcome.summary}${patchShaUnavailable ? "（patchSha256 不可得，已置全零占位）" : ""}`,
        incrementId: item.id,
        artifact: reportPath,
        mergeReceipt,
    };
    if (patchShaUnavailable) {
        await runNode([NODE_APPEND_FILE, reportPath, `\n\n> 注：本增量 patchSha256 不可得（git diff 不可用），已置全零占位；回执防伪主绑定为 from/to revision 指纹。\n`]);
    }
    // 实现报告内容哈希（追加测试摘要之后计算，事件与磁盘同哈希绑定）
    let implementationReportSha = "";
    try {
        implementationReportSha = await artifactSha256Of(reportPath);
    }
    catch (e) {
        return failBuild(`实现报告哈希计算失败：${errorText(e)}`, reportPath);
    }
    implementationEvent.artifactSha256 = implementationReportSha;
    const appendError = await appendEvent(implementationEvent);
    if (appendError !== null) {
        return failBuild(`增量 ${item.id} 的 ImplementationRecorded 追加失败：${appendError}`, reportPath);
    }
    try {
        for (const draft of outcome.findings)
            await appendFinding(draft, reportPath);
    }
    catch (e) {
        return failBuild(errorText(e), reportPath);
    }
    implemented.add(item.id);
    completedThisRun.push(item.id);
    lastCompletedRevision = postRevision;
    await obsEnd("execute", index + 1);
}
await obsBegin("finalize", null);
const finalEvaluation = await retryOnSpawnFailure(() => runGate(gatePath, ["evaluate", "--task-dir", taskDir]), { workflow: "candidate-build-v4", step: "finalize", round: null, command: "evaluate" });
const finalVerdict = parseObject(finalEvaluation.stdout);
if (finalEvaluation.exitCode !== 0 || finalVerdict === null) {
    const failurePath = `${taskDir}/evidence/build-evaluate-${revisionHash(revision)}.md`;
    const message = `全部增量处理后 evaluate 失败：${finalEvaluation.stderr.trim() || finalEvaluation.stdout.trim()}`;
    const evalFailurePath = await writeEvidenceExclusive(failurePath, `# 构建裁决失败\n\n${message}\n`);
    return failBuild(message, evalFailurePath === "" ? failurePath : evalFailurePath);
}
await obsEnd("finalize", null);
await releaseLease();
await obsCloseExecution("implemented");
const result = {
    terminated: "implemented",
    taskDir,
    revision,
    implementedIncrementIds: increments.filter((item) => implemented.has(item.id)).map((item) => item.id),
    findingIds,
    verdict: finalVerdict,
    message: `全部增量已形成候选实现并交由 delivery-gate 重新裁决；builder 测试不是 verified 证据，下一步运行 independent-assurance-v4${repairSummary()}${statsTailNote()}`,
};
return result;
