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
// args：pi 的 $ARGS（--args k=v）；数字参数字符串归一
const args = {};
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  args[k] = typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
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
const SCHEMA_BY_KEY = {
  NodeResult: SCHEMA_NodeResult,
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

// ── F 区平台钩子：pi 无续聊，打回 prompt 拼入首轮指令与上次返回结果使其自包含 ──
function withPrevContext(initialPrompt, lastResult, retryPrompt) {
  return `【前情】此前任务指令：\n${initialPrompt}\n\n上次返回结果：\n${JSON.stringify(lastResult)}\n\n` + retryPrompt;
}

// ── W2 wave-executor ──
// 语义权威：设计文档 §8.2（调度语义）/ §8.3（exec-plan schema）/ §6.2（D1/D3 时间线）。
// 调度只看依赖边：deps 全 done 即派发；wave 字段完全不参与调度（仅 D0 侧展示标签）。
// 并发 ≤5，逐节点 settle 即重算（设计 §8.2：单节点完成立即解锁后继补派，不等批内
//   其他节点——长尾不拖批；活跃领地并集随活跃集动态重建）。
// agent 会话异常 → 接替程序（新 agent 名 + 前任证据包 + 当前 diff，先核验现状再续作，
//   设计 §6.2 F15 第一等路径）；接替者再异常才 blocked。
// 一律 failed-as-return：throw 的 errored run 不可 resume 且丢结构化错误（参数校验除外
//   ——args 非法属启动期快失败，errored 形态可接受）。
// 边界声明（设计 §8.2）：并行单元共享工作区时，单单元改动归属无法由 git status 精确切分，
//   核验采用两级判定——dev 自报 files_changed 为精确集（级一：⊆ 领地），引擎另跑全量
//   status 对活跃单元领地并集做粗粒度复核（级二）；启动前工作区必须干净（级二成立前提）。
// 边界声明（设计 §8.5）：worktree 单元的「合并回主分支才就绪」不做引擎侧自动检测——
//   由 D0 编译负责排布合并（合并节点或手工段）。
// ── args 窄化（未知键 fail-fast：拼错键静默忽略比报错危险） ──
const VALID_ARG_KEYS = new Set(["execPlan"]);
for (const key of Object.keys(args)) {
    if (!VALID_ARG_KEYS.has(key)) {
        throw new Error(`未知参数: ${key}（唯一合法参数: execPlan——exec-plan.json 绝对路径）`);
    }
}
if (typeof args.execPlan !== "string" || args.execPlan.trim() === "") {
    throw new Error("缺少必填参数 execPlan（exec-plan.json 绝对路径，由 D0 编译产出）");
}
const execPlanPath = args.execPlan.trim();
// ── 常量 ──
const MAX_CONCURRENCY = 5; // 用户指定的全局并发上限（批大小）
const MAX_REJECT_ROUNDS = 2; // 打回定向修上限（初始 1 次 + 打回 2 次 = 至多 3 次 ask）
const TAIL_LINES = 40; // 失败输出贴入打回 prompt 的行数上限
const TEST_TIMEOUT_MS = 1800000; // 节点测试命令兜底墙钟（单元级=数十分钟；world.run 默认 300s 会误杀大仓单测）
const VERIFY_SCRIPT_TIMEOUT_MS = 3600000; // 验收剧本兜底墙钟（任务级=小时级，按超时默认原则校准）
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"];
const VALID_ENTRY_STATUS = new Set(["pending", "in-progress", "done", "blocked", "failed", "suspended"]);
const DEV_PERSONA = "你是开发单元执行者：严格按任务书改码，只改任务书领地内的文件；自己跑通任务书定义的单元测试后再交付；" +
    "不要自行 git add / git commit——引擎核验通过后统一提交，自行提交会破坏状态对账与并行调度；" +
    "引擎会确定性核验领地与测试，伪造 files_changed 或测试证据必被抓住；任务书与现实冲突、环境缺失时如实填报 " +
    "blockers/deviations，不要硬编绕过。";
const INSPECT_PERSONA = "你是验收检查执行者：只读检查（可运行只读命令、读文件），不修改任何代码、不产生 commit；" +
    "按任务书逐项核对并如实返回结论；证据不足就如实说，不猜测、不夸大。";
// ── node -e 通道（脚本无 fs/process：写盘/读文件/git/带 cwd 的子进程全走 world.run node -e，
//    argv 传参无 shell 注入面；代码串内可 require Node 内建） ──
const WRITE_FILE = "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const READ_FILE_QUIET = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch{}";
const EXISTS = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";
// argv: [cwd] → stdout = porcelain 原文；非 git 仓库/工具错误 exit 1
const GIT_PORCELAIN = "try{const o=require('child_process').execFileSync('git',['status','--porcelain'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";
// argv: [cwd, message, ...files] → stdout = 新 commit hash；add 用绝对路径（pathspec 相对 cwd
// 解析，cwd 非 repo 根时相对路径会指错文件）；commit 用 --only 限定路径——共享工作区并行
// 调度时暂存区可能有其他单元的 staged 内容，普通 commit 会连带提交，破坏「每单元独立成笔」
const GIT_ADD_COMMIT = "try{const a=process.argv.slice(1);const c=a[0],m=a[1],f=a.slice(2);const p=require('path');const x=require('child_process').execFileSync;" +
    "const abs=f.map(t=>p.resolve(c,t));" +
    // 幂等分支：目标文件零改动（如节点产物已在恢复对账时提交过）→ 直接返回当前 HEAD，
    // 不走 add/commit（git commit 对空暂存区报 nothing to commit 非零退出，曾误判 commit 失败）
    "if(abs.length>0){const st=String(x('git',['status','--porcelain','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432}));" +
    "if(st.trim()===''){const h0=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h0);process.exit(0)}}" +
    "if(abs.length>0)x('git',['add','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
    "x('git',['commit','--only','-m',m,'--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432,stdio:['ignore','pipe','pipe']});" +
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
// argv: [statusPath, projectRoot, ...devIds] → 双向对账（§4.5 崩溃裁决，git 为准）：
//   ①status=done 的节点：commit 不在 git 对象库 → 回 pending；
//   ②status≠done 的 dev 节点：git log（HEAD 起 500 条）subject 含完整词 <id>（commitTemplate 渲染
//     的单元锚）→ 补写 done（commit 哈希 + 证据）；双向都是引擎行为，不留人工方向。
//   stdout = 对账后的完整 status.json（保留 schema 外顶层字段）
const RECONCILE_STATUS = "try{const fs=require('fs');const sp=process.argv[1],root=process.argv[2],ids=process.argv.slice(3);" +
    "const x=require('child_process').execFileSync;const st=JSON.parse(fs.readFileSync(sp,'utf8'));const nodes={};" +
    "for(const k of Object.keys(st.nodes||{}))nodes[k]=st.nodes[k];const events=(st.events||[]).slice();" +
    "let logLines='';try{logLines=String(x('git',['log','--format=%H%x1f%s','-n','500'],{cwd:root,encoding:'utf8',maxBuffer:33554432}))}catch(err){}" +
    "for(const id of ids){const e=nodes[id]||{status:'pending',attempts:0};" +
    "if(e.status==='done'){let ok=false;" +
    "if(typeof e.commit==='string'&&e.commit.length>=7){try{x('git',['cat-file','-e',e.commit+'^{commit}'],{cwd:root,encoding:'utf8'});ok=true}catch(err){}}" +
    "if(ok)continue;nodes[id]={status:'pending',attempts:0};" +
    "events.push({seq:events.length+1,node:id,event:'reconcile-reset',detail:'status done 但 commit 不在 git 对象库，按 git 为准回 pending'})}" +
    "else{const edge='(?:^|[^A-Za-z0-9-])';const re=new RegExp(edge+id.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')+edge);" +
    "const hit=logLines.split('\\n').find((l)=>{const i=l.indexOf('\\x1f');return i>0&&re.test(l.slice(i+1))});" +
    "if(hit){const h=hit.slice(0,hit.indexOf('\\x1f'));nodes[id]={status:'done',attempts:1,commit:h,evidence:'恢复对账：git log 发现本单元 commit（status 未记，按 git 为准补写 done）'};" +
    "events.push({seq:events.length+1,node:id,event:'reconcile-done',detail:'status 未记但 git log 有本单元 commit，按 git 为准补写 done'})}}}" +
    "const out={};for(const k of Object.keys(st))if(k!=='nodes'&&k!=='events')out[k]=st[k];out.baseline=st.baseline||null;out.nodes=nodes;out.events=events;" +
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
    };
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
function tailLines(text, n) {
    const s = String(text ?? "").trimEnd();
    const lines = s.split("\n");
    return lines.length <= n ? s : lines.slice(-n).join("\n");
}
/** 文件路径是否落在领地内（领地条目=文件或目录前缀） */
function pathInTerritory(file, territories) {
    for (const t of territories) {
        const prefix = t.endsWith("/") ? t : `${t}/`;
        if (file === t || file.startsWith(prefix))
            return true;
    }
    return false;
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
 *  呈 ../.tmp/（或更深的 ../../.tmp/）形态——按「任意深度 ../ 前缀 + .tmp/」识别 */
const isTmpArtifact = (f) => /^(\.\.\/)*\.tmp\//.test(f);
/** commitTemplate 渲染：{unitId}/{summary} 全量替换（split/join 防 replace 只换首个） */
function renderCommit(template, unitId, summary) {
    return template.split("{unitId}").join(unitId).split("{summary}").join(summary);
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
    // 三个致命字段走直线守卫收窄（经 errors 间接 return 的写法 TS 无法收窄，unknown 会向下游传染）
    const mode = raw.mode === "dev" || raw.mode === "acceptance" ? raw.mode : null;
    if (mode === null) {
        errors.push(`mode 必须是 "dev" 或 "acceptance"，实际：${JSON.stringify(raw.mode)}`);
        return { ok: false, errors };
    }
    const projectRoot = isStr(raw.projectRoot) ? raw.projectRoot : null;
    if (projectRoot === null) {
        errors.push("projectRoot 必须是非空字符串（git/测试/commit 的缺省 cwd——引擎不从进程 cwd 推导）");
        return { ok: false, errors };
    }
    const statusPathRel = isStr(raw.statusPath) ? raw.statusPath : null;
    if (statusPathRel === null) {
        errors.push("statusPath 必须是非空字符串");
        return { ok: false, errors };
    }
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
            errors.push("mode=acceptance 时必须提供 acceptance 对象（nodes/groups/haltOnCoreFail）");
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
                errors.push(`dev 节点 ${id} 的 territory 必须是非空字符串数组（领地）`);
            }
            else if (rn.territory.some((t) => t.startsWith("/"))) {
                // 口径契约：territory 与 files_changed/porcelain 同基准 = 相对该节点 cwd 所在 git
                // 仓库根的相对路径——绝对路径永不匹配相对路径核验，恒判越界，启动即拦
                errors.push(`dev 节点 ${id} 的 territory 含绝对路径（${rn.territory.filter((t) => t.startsWith("/")).join("、")}）——须为相对该节点 cwd 所在 git 仓库根的相对路径`);
            }
            else {
                node.territory = rn.territory;
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
    // acceptance 分组
    let coreIds = new Set();
    let haltOnCoreFail = false;
    if (mode === "acceptance" && accRec !== null) {
        const groups = accRec.groups;
        if (!isRec(groups)) {
            errors.push("acceptance.groups 必须是对象 {core, nonCore}");
        }
        else {
            if (!isStrArr(groups.core)) {
                errors.push("acceptance.groups.core 必须是字符串数组");
            }
            else {
                coreIds = new Set(groups.core);
                for (const c of groups.core) {
                    if (!idSet.has(c))
                        errors.push(`groups.core 引用了不存在的节点：${c}`);
                }
            }
            if (groups.nonCore !== undefined) {
                if (!isStrArr(groups.nonCore)) {
                    errors.push("acceptance.groups.nonCore 必须是字符串数组");
                }
                else {
                    for (const c of groups.nonCore) {
                        if (!idSet.has(c))
                            errors.push(`groups.nonCore 引用了不存在的节点：${c}`);
                    }
                }
            }
        }
        if (typeof accRec.haltOnCoreFail !== "boolean") {
            errors.push("acceptance.haltOnCoreFail 必须是布尔值");
        }
        else {
            haltOnCoreFail = accRec.haltOnCoreFail;
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
            statusPath: joinPath(projectRoot, statusPathRel),
            commitTemplate: commitTemplate ?? "{unitId} — {summary}",
            baseline: typeof raw.baseline === "string" ? raw.baseline : null,
            nodes,
            coreIds,
            haltOnCoreFail,
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
/** null = git 命令本身失败（非 git 仓库/工具缺失），区别于「干净」 */
async function gitPorcelainViaNode(cwd) {
    const r = await world.run("node", ["-e", GIT_PORCELAIN, cwd]);
    if (r.exitCode !== 0)
        return null;
    return r.stdout;
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
/** 当前 in-flight 节点的领地并集（按 cwd 分组）——级二粗粒度复核的基线，逐节点 settle 后重建 */
let activeTerrByCwd = new Map();
/** 全部 dev 节点核验通过时自报的 files_changed 并集（终态残留对账的豁免集——静态领地
 *  不含运行中新建文件，自报并集补上这一段） */
const declaredFiles = new Set();
/** commit 被拒（多为仓库 pre-commit 钩子全仓检查 × 并行半成品）转待办的节点——节点核验
 *  已过、编码成果有效，不 blocked（2026-09-26 用户裁决：全部做完留给主 agent 处理，
 *  钩子在主会话代提交时照常执行）；收尾统一呈报 */
const deferredCommits = [];
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
async function verifyDevNode(node, result) {
    // 查三：blockers 自报非空 → blocked（环境/任务书问题，定向修不可解，不进打回）
    if (result.blockers.length > 0) {
        return { outcome: "blocked", reason: "任务书自报 blockers", detail: result.blockers.join("；") };
    }
    if (result.status !== "done") {
        return { outcome: "retry", reason: `自报 status=${result.status}`, detail: result.test_evidence || "（无自测证据）" };
    }
    // 查一级（精确）：dev 自报 files_changed 为精确集，逐路径 ⊆ 本节点领地
    const outside = result.files_changed.filter((f) => !pathInTerritory(f, node.territory));
    if (outside.length > 0) {
        return {
            outcome: "retry",
            reason: "files_changed 超出领地",
            detail: `超界路径：\n${outside.join("\n")}\n领地：\n${node.territory.join("\n")}`,
        };
    }
    // 查二级（粗粒度）：引擎另跑全量 status，观察清单外残留——只登记不拦截（2026-09-26
    // 用户裁决：并行单元运行中新建的文件天然不在启动时载入的静态领地里，把「别人的
    // 改动」判为当前单元越界是连坐——曾致 d3 被兄弟单元 7 个残留文件卡死、u5/u2a 互卡
    // 成对 blocked。本节点只对自己的纪律负责（查一级自报 ⊆ 领地 + 查二测试绿）；全工作
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
/** agent ask 的接替包装（设计 §6.2 F15 第一等路径）：会话异常 → 接替 actor + 前任证据包
 *  + 当前 git diff --stat，令其先核验现状再续作，禁止盲目重做；接替者再异常才向上抛（→ blocked）。
 *  注意 actor 引用在 executeDevNode 开头一次性创建——同名续聊 = 单 actor 多次 ask，
 *  每次 ask 都调 agent(name) 会创建同名新 actor，run 直接炸（冒烟实测） */
async function askWithSuccession(primary, successor, prompt, node, lastResult) {
    try {
        return await primary.ask("NodeResult", prompt);
    }
    catch (e) {
        const diff = await world.run("node", ["-e", GIT_DIFF_STAT, node.cwd]);
        const pack = [
            `前任 agent 会话异常（${errText(e)}）——你是接替者，先核验现状再续作，禁止盲目重做已完成的改动：`,
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
        log(`节点 ${node.id} agent 会话异常（${errText(e)}），启动接替程序`);
        return await successor.ask("NodeResult", pack);
    }
}
async function executeDevNode(node) {
    await beginNode(node.id);
    // 同名续聊承载打回：actor 一次性创建、多次 ask（同一 subagent 队列天然保持会话上下文）；
    // 接替 actor 预创建（仅异常时使用——创建即占名，名字唯一性由节点 id 保证）
    const primaryAgent = wfAgent(`node-${node.id}`, DEV_PERSONA);
    const succAgent = wfAgent(`接替-${node.id}`, DEV_PERSONA);
    // 首轮指令提为变量，供打回轮前情拼接（pi 侧 withPrevContext 消费——zcode 同名续聊天然承载）
    const initialPrompt = `读取任务书 ${node.promptFile}（绝对路径）并按其完整执行，返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers，可含 summary）。files_changed 用相对工作区 git 仓库根的路径（git status 风格）。`;
    let result = await askWithSuccession(primaryAgent, succAgent, initialPrompt, node, null);
    let attempts = 1;
    let verdict = await verifyDevNode(node, result);
    while (verdict.outcome === "retry" && attempts <= MAX_REJECT_ROUNDS) {
        log(`节点 ${node.id} 核验未过（${verdict.reason}），打回定向修`);
        result = await askWithSuccession(primaryAgent, succAgent, withPrevContext(initialPrompt, result, `引擎确定性核验未通过（原因：${verdict.reason}）。按以下失败输出定向修复，然后重新返回同一 JSON 契约：\n${verdict.detail}`), node, result);
        attempts += 1;
        await statusUpdate(node.id, { status: "in-progress", attempts }, "reject-round", verdict.reason);
        verdict = await verifyDevNode(node, result);
    }
    if (verdict.outcome === "pass") {
        // commit 三要素保真（§8.3）：unitId（模板）+ designRef（章节锚前置，summary 已含则不重复
        // 前置——冒烟实测 dev 常在 summary 自带章节号）+ summary（promptFile 契约要求末行含「测试：<命令> 绿」）
        const summary = result.summary ?? "dev 单元交付";
        const summaryWithRef = node.designRef !== "" && !summary.includes(node.designRef) ? `${node.designRef} ${summary}` : summary;
        const message = renderCommit(plan.commitTemplate, node.id, summaryWithRef);
        const cr = await gitAddCommitViaNode(node.cwd, message, result.files_changed);
        for (const f of result.files_changed)
            declaredFiles.add(f);
        if (!cr.ok) {
            // commit 被拒不 blocked：核验已过、编码成果有效；拒因多为仓库 pre-commit 钩子的
            // 全仓检查看到并行兄弟单元的半成品（钩子要求「当场修复」，而修那些文件超出本
            // 节点领地纪律——节点内无解）。转待办，收尾呈报主 agent 代提交（钩子照常执行）
            deferredCommits.push({ id: node.id, message, files: result.files_changed, err: cr.err });
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
    // 剧本由 D0 预编译，引擎只执行断言退出码；bash 白名单分支 + cwd 参数化
    const r = await world.run("node", ["-e", RUN_IN_CWD, "bash", node.cwd, node.script], {
        timeoutMs: VERIFY_SCRIPT_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
        await markNodeBlockedOrFailed(node.id, "failed", `验收脚本退出码 ${r.exitCode}`, tailLines(`${r.stdout}\n${r.stderr}`, TAIL_LINES), 1);
        return;
    }
    const artOk = await existsViaNode(node.artifactsDir);
    if (!artOk) {
        await markNodeBlockedOrFailed(node.id, "failed", `产物目录不存在：${node.artifactsDir}`, "脚本 exit 0 但 artifactsDir 缺失", 1);
        return;
    }
    await finishNodeDone(node.id, 1, undefined, `verify exit 0；产物目录 ${node.artifactsDir}`);
    log(`Verify 节点 ${node.id} 脚本退出 0，产物目录存在，通过`);
}
async function executeInspectNode(node) {
    await beginNode(node.id);
    const nodeAgent = wfAgent(`node-${node.id}`, INSPECT_PERSONA);
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
    const result = await nodeAgent.ask("NodeResult", `读取验收任务书 ${node.promptFile}（绝对路径）并按其完整执行（只检查，不修改代码、不产生 commit），返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers）。${refLines.join("\n")}`);
    if (result.blockers.length > 0) {
        await markNodeBlockedOrFailed(node.id, "blocked", "任务书自报 blockers", result.blockers.join("；"), 1);
        return;
    }
    if (result.status !== "done") {
        await markNodeBlockedOrFailed(node.id, "failed", `inspect 自报 status=${result.status}`, result.test_evidence, 1);
        return;
    }
    await finishNodeDone(node.id, 1, undefined, result.test_evidence);
    log(`Inspect 节点 ${node.id} 检查通过`);
}
async function executeNode(node) {
    if (node.kind === "dev")
        return executeDevNode(node);
    if (node.kind === "verify")
        return executeVerifyNode(node);
    return executeInspectNode(node);
}
// ── 调度主循环（设计 §8.2 流式）：逐节点 settle 即重算——单节点完成立即解锁后继
//    在并发余量内补派，不等批内其他节点（长尾不拖批）；活跃领地并集随活跃集动态重建 ──
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
        // 非核心组在核心全绿后解锁（设计 §6.2 D3）；dev 模式核心集为空 → 空条件恒真，不引入额外门
        const coreAllDone = plan.nodes
            .filter((n) => plan.coreIds.has(n.id))
            .every((n) => nodeState(n.id) === "done");
        const ready = plan.nodes.filter((n) => nodeState(n.id) === "pending" &&
            n.deps.every((d) => nodeState(d) === "done") &&
            (plan.coreIds.has(n.id) || coreAllDone));
        // 游标防同轮重复派发（launch 后 state 同步变 in-progress，游标是双保险）
        let dispatched = 0;
        while (active.size < MAX_CONCURRENCY && dispatched < ready.length) {
            launch(ready[dispatched]);
            dispatched += 1;
        }
        if (active.size === 0)
            break; // 无可调度且无活跃 → 依赖挂起或全终态 → 终态判定
        // 级二粗粒度复核的基线：**单调累积**（launch 时并入该节点领地，settle 后不移除）——
        // 粗粒度复核「只松不严」原则下，移除已落定节点的领地只会收紧：兄弟节点带残留改动
        // 落定（blocked/commit 失败）后，在飞节点的核验会把残留判为越界 stray 而被误伤打回
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
        // 在飞节点收尾不放弃（await allSettled——熔断只是不派新，已派节点的落盘/commit 照常完成）
        if (plan.haltOnCoreFail) {
            const bad = plan.nodes.find((n) => plan.coreIds.has(n.id) && (nodeState(n.id) === "blocked" || nodeState(n.id) === "failed"));
            if (bad !== undefined) {
                const rt = state.get(bad.id);
                coreFail = {
                    id: bad.id,
                    detail: `${rt?.reason ?? "未知原因"}\n${rt?.detail ?? ""}`.trim(),
                };
                log(`核心组节点 ${bad.id} 失败，haltOnCoreFail 熔断：未派发节点不再派发，等待在飞节点收尾`);
                await Promise.allSettled([...active.values()]);
                break;
            }
        }
    }
}
// ── 看板（运行观察面：节点状态流转实时上板，终态也可从 status.json 人读） ──
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
    return invalidRet(`exec-plan schema 校验失败（共 ${validated.errors.length} 条）：\n- ${validated.errors.join("\n- ")}`, "");
}
plan = validated.plan;
if (!(await existsViaNode(plan.projectRoot))) {
    return invalidRet(`projectRoot 不存在：${plan.projectRoot}`, plan.statusPath);
}
for (const n of plan.nodes) {
    if (n.promptFile !== "" && !(await existsViaNode(n.promptFile))) {
        return invalidRet(`节点 ${n.id} 的 promptFile 不存在：${n.promptFile}`, plan.statusPath);
    }
    if (n.kind === "verify" && !(await existsViaNode(n.script))) {
        return invalidRet(`verify 节点 ${n.id} 的 script 不存在：${n.script}`, plan.statusPath);
    }
}
// 启动基线扫描（全部去重 cwd；.tmp/ 为 workflow 产物目录不计）——记录启动前既有改动
// 为豁免集，不拒绝启动（2026-09-26 用户裁决：启动前的工作区改动与本次节点无关，不该
// 卡死发起——续跑/恢复场景工作区常有上次残留，拒启动 = 强迫人工先清理再重发）。
// 该豁免集只服务终态对账口径：residualFiles 排除启动前既有项（它们不是本次 run 产生的，
// 是否处置由主 agent 按自身语境判断）
const preExistingByCwd = new Map();
const allCwds = [...new Set(plan.nodes.map((n) => n.cwd))];
for (const c of allCwds) {
    const st = await gitPorcelainViaNode(c);
    if (st === null) {
        return invalidRet(`git status 无法在 ${c} 执行（须为有效 git 仓库）`, plan.statusPath);
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
if (existingStatus === null) {
    const initialNodes = {};
    for (const n of plan.nodes)
        initialNodes[n.id] = { status: "pending", attempts: 0 };
    try {
        await writeTextViaNode(plan.statusPath, JSON.stringify({ baseline: plan.baseline, nodes: initialNodes, events: [] }, null, 2));
    }
    catch (e) {
        return invalidRet(`status.json 初始态创建失败（${plan.statusPath}）：${errText(e)}`, plan.statusPath);
    }
    log(`status.json 不存在，已创建初始态（${plan.nodes.length} 个节点全 pending）：${plan.statusPath}`);
    for (const n of plan.nodes)
        state.set(n.id, { status: "pending", attempts: 0 });
    // 初始态同样走双向对账（§4.5 崩溃裁决不留人工方向）：status.json 曾被删但 commit 在 git——
    // 非 done 的 dev 节点按 git log 反查补写 done，避免重跑已交付单元
    const freshDevIds = plan.nodes.filter((n) => n.kind === "dev").map((n) => n.id);
    if (freshDevIds.length > 0) {
        const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, ...freshDevIds]);
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
    if (allDevIds.length > 0) {
        const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, ...allDevIds]);
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
    for (const n of plan.nodes) {
        const e = aligned[n.id] ?? { status: "pending", attempts: 0 };
        const st = e.status === "done" ? "done" : "pending";
        state.set(n.id, { status: st, attempts: e.attempts });
    }
    // 对账结果写回磁盘（含反查补 done 与级联失效的最终态）——只更新内存会在重启后
    // 重复对账且补 done 不落盘（RECONCILE 输出含 reconcile-done 事件，直接整文写回）
    const alignedAny = allDevIds.some((id) => (aligned[id]?.status ?? "pending") !== (existingStatus.nodes[id]?.status ?? "pending")) ||
        resetIds.size > 0;
    if (alignedAny) {
        await writeTextViaNode(plan.statusPath, JSON.stringify({ ...existingStatus.extra, baseline: existingStatus.baseline, nodes: aligned, events: existingStatus.events }, null, 2));
        log(`对账结果已写回 ${plan.statusPath}（补 done / 级联失效条目落盘，重启不再重复对账）`);
    }
}
const depEdgeCount = plan.nodes.reduce((s, n) => s + n.deps.length, 0);
const resumedDone = plan.nodes.filter((n) => nodeState(n.id) === "done").length;
log(`执行计划校验通过：${plan.nodes.length} 个节点（mode=${plan.mode}），依赖边 ${depEdgeCount} 条无环` +
    (resumedDone > 0 ? `，${resumedDone} 个节点按 status.json 增量跳过` : ""));
for (const n of plan.nodes) {
    report({ id: n.id, state: nodeState(n.id) === "done" ? "done" : "pending", detail: "" }, "nodes");
}
// ══════════════ 阶段 2：并行执行（循环体单 phase，不按轮拆） ══════════════
if (plan.mode === "dev") {
    phase("并行执行开发节点");
    await runSchedulingLoop();
}
else {
    phase("并行执行验收节点");
    await runSchedulingLoop();
}
// ══════════════ 阶段 3：收尾汇总 ══════════════
phase("收尾汇总");
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
// 运行中新建的文件——静态领地天然不含），全部节点 settle 后统一盘点一次全工作区，
// 残留 = 全部改动 −（所有 dev 节点领地并集 ∪ 已核验节点自报 files_changed 并集）——
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
await serializedStatus(async () => {
    const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [], extra: {} };
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
};

