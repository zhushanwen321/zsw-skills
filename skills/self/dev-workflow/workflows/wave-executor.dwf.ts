/* zcode-workflow
description: dev-flow-wf W2 通用 DAG 调度引擎（wave-executor）：读 exec-plan.json 做启动校验
  （schema/依赖环/文件存在性/工作区干净基线），依赖就绪节点流式派发（≤5 并发，wave 字段
  仅展示不参与调度），每节点确定性核验（files_changed ⊆ 领地 + 全量 status 粗粒度复核 +
  节点测试命令重跑）→ commit → 解锁后继；核验不过打回同名 agent 定向修（≤2 轮，超限
  blocked 且后继挂起）；acceptance 模式承载 verify/inspect 节点 + 核心组 haltOnCoreFail
  熔断；终态 completed / blocked / core-failed，全程 failed-as-return 不 throw。
whenToUse: dev-flow-wf 的 D1 开发循环与 D3 端到端验收发起本 workflow（CreateWorkflow path
  指向本文件 + args.execPlan）。exec-plan.json 由 D0 从设计包编译产出；断点恢复走
  ResumeWorkflowRun（node-<unitId> 命名保缓存）或按 status.json 人读恢复（git 为准）。
args:
  execPlan:
    type: string
    required: true
    description: exec-plan.json 绝对路径（D0 编译产出：nodes/依赖/领地/testCommand/promptFile/statusPath/commitTemplate/acceptance 分组）
*/

// ── W2 wave-executor ──
// 语义权威：设计文档 §8.2（调度语义）/ §8.3（exec-plan schema）/ §6.2（D1/D3 时间线）。
// 调度只看依赖边：deps 全 done 即派发；wave 字段完全不参与调度（仅 D0 侧展示标签）。
// 并发 ≤5：批内 Promise.allSettled 全落地后才重算就绪集（join 屏障即批边界）。
// 一律 failed-as-return：throw 的 errored run 不可 resume 且丢结构化错误。
// 边界声明（设计 §8.2）：并行单元共享工作区时，单单元改动归属无法由 git status 精确切分，
//   核验采用两级判定——dev 自报 files_changed 为精确集（级一：⊆ 领地），引擎另跑全量
//   status 对活跃单元领地并集做粗粒度复核（级二）；启动前工作区必须干净（级二成立前提）。
// 边界声明（设计 §8.5 未实现项）：worktree 单元 commit 后「合并回主分支才就绪」不做引擎侧
//   自动检测——集成单元依赖 worktree 单元时，由 D0 编译负责排布合并次序（串行边或手工段）。

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

// ── 类型契约 ──

/** 节点任务书末尾定义的 JSON 契约（dev 与 inspect 节点共用） */
interface NodeResult {
  /** done = 本单元工作完成且自测通过；fail = 有未解决问题；blocked = 无法继续 */
  status: "done" | "fail" | "blocked";
  /** 改动文件路径（相对节点工作区 git 仓库根的 git 风格路径，须 ⊆ 任务书领地） */
  files_changed: string[];
  /** 自测证据：跑了什么命令、结果如何 */
  test_evidence: string;
  /** 与任务书的偏离说明（无偏离为空数组） */
  deviations: string[];
  /** 阻塞项（环境缺失/任务书矛盾等；非空则节点判 blocked，不进入打回） */
  blockers: string[];
  /** commit message {summary} 占位符的一句话摘要（缺省用固定短语） */
  summary?: string;
}

/** 确定性核验结论：pass=过 / retry=可打回修 / blocked=引擎层或环境问题（打回修不了） */
interface VerifyVerdict {
  outcome: "pass" | "retry" | "blocked";
  reason: string;
  detail: string;
}

interface TestCommand {
  program: string;
  args: string[];
}

/** 校验归一后的执行计划节点（路径全部绝对化；按 kind 只填对应字段） */
interface PlanNode {
  id: string;
  kind: "dev" | "verify" | "inspect";
  deps: string[];
  territory: string[];
  testCommand: TestCommand | null;
  promptFile: string;
  script: string;
  artifactsDir: string;
  artifactsRefs: string[];
  cwd: string;
}

interface ParsedPlan {
  version: number;
  mode: "dev" | "acceptance";
  projectRoot: string;
  statusPath: string;
  commitTemplate: string;
  baseline: string | null;
  nodes: PlanNode[];
  coreIds: Set<string>;
  haltOnCoreFail: boolean;
}

type ValidateResult = { ok: true; plan: ParsedPlan } | { ok: false; errors: string[] };

/** status.json 单节点条目 */
interface StatusEntry {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed" | "suspended";
  attempts: number;
  commit?: string;
  evidence?: string;
}

interface StatusEvent {
  seq: number;
  node: string;
  event: string;
  detail?: string;
}

interface StatusFileData {
  baseline: string | null;
  nodes: Record<string, StatusEntry>;
  events: StatusEvent[];
}

/** 调度器内存态（崩溃恢复事实源是 status.json + git，不是这个 Map） */
interface NodeRt {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed";
  attempts: number;
  reason?: string;
  detail?: string;
  commit?: string;
}

/** workflow 终态（failed-as-return 的结构化载体） */
interface WaveExecutorOutcome {
  /** completed=全 done；blocked=存在 blocked/failed/挂起；core-failed=核心组熔断 */
  terminated: "completed" | "blocked" | "core-failed";
  done: string[];
  /** blocked（打回超限/自报 blockers/引擎层失败）与 failed（验收负结果）合记，reason 注明类型 */
  blocked: { id: string; reason: string; attempts: number }[];
  /** 因上游 blocked 或熔断而从未派发（依赖挂起）的节点 */
  skipped: string[];
  /** status.json 绝对路径（人读恢复入口；启动校验失败时为空串） */
  statusFile: string;
  /** core-failed 归因（哪个节点/什么输出）；非 core-failed 为 null */
  coreFailure: { id: string; detail: string } | null;
  /** 启动校验失败详情（terminated=blocked 且未派发任何节点时非 null） */
  validationError: string | null;
}

interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ── 常量 ──

const MAX_CONCURRENCY = 5; // 用户指定的全局并发上限（批大小）
const MAX_REJECT_ROUNDS = 2; // 打回定向修上限（初始 1 次 + 打回 2 次 = 至多 3 次 ask）
const TAIL_LINES = 40; // 失败输出贴入打回 prompt 的行数上限
const TEST_TIMEOUT_MS = 1800000; // 节点测试命令兜底墙钟（单元级=数十分钟；world.run 默认 300s 会误杀大仓单测）
const VERIFY_SCRIPT_TIMEOUT_MS = 3600000; // 验收剧本兜底墙钟（任务级=小时级，按超时默认原则校准）
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"] as const;
const VALID_ENTRY_STATUS = new Set(["pending", "in-progress", "done", "blocked", "failed", "suspended"]);

const DEV_PERSONA =
  "你是开发单元执行者：严格按任务书改码，只改任务书领地内的文件；自己跑通任务书定义的单元测试后再交付；" +
  "不要自行 git add / git commit——引擎核验通过后统一提交，自行提交会破坏状态对账与并行调度；" +
  "引擎会确定性核验领地与测试，伪造 files_changed 或测试证据必被抓住；任务书与现实冲突、环境缺失时如实填报 " +
  "blockers/deviations，不要硬编绕过。";

const INSPECT_PERSONA =
  "你是验收检查执行者：只读检查（可运行只读命令、读文件），不修改任何代码、不产生 commit；" +
  "按任务书逐项核对并如实返回结论；证据不足就如实说，不猜测、不夸大。";

// ── node -e 通道（脚本无 fs/process：写盘/读文件/git/带 cwd 的子进程全走 world.run node -e，
//    argv 传参无 shell 注入面；代码串内可 require Node 内建） ──

const WRITE_FILE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const READ_FILE_QUIET = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch{}";
const EXISTS = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";

// argv: [cwd] → stdout = porcelain 原文；非 git 仓库/工具错误 exit 1
const GIT_PORCELAIN =
  "try{const o=require('child_process').execFileSync('git',['status','--porcelain'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";

// argv: [cwd, message, ...files] → stdout = 新 commit hash；add 用绝对路径（pathspec 相对 cwd
// 解析，cwd 非 repo 根时相对路径会指错文件）；commit 用 --only 限定路径——共享工作区并行
// 调度时暂存区可能有其他单元的 staged 内容，普通 commit 会连带提交，破坏「每单元独立成笔」
const GIT_ADD_COMMIT =
  "try{const a=process.argv.slice(1);const c=a[0],m=a[1],f=a.slice(2);const p=require('path');const x=require('child_process').execFileSync;" +
  "const abs=f.map(t=>p.resolve(c,t));" +
  "if(abs.length>0)x('git',['add','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
  "x('git',['commit','--only','-m',m,'--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432,stdio:['ignore','pipe','pipe']});" +
  "const h=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h)}" +
  "catch(e){process.stderr.write(String((e&&(e.stderr||e.stdout))||e.message));process.exit(1)}";

// argv: [program, cwd, ...args] → 在指定 cwd 内执行 program；退出码/stdout/stderr 全量透传
//（spawnSync 而非 execFileSync：后者正常退出时 stderr 被丢弃，测试输出的诊断信息会失真）
const RUN_IN_CWD =
  "try{const a=process.argv.slice(1);const p=a[0],c=a[1],r=a.slice(2);" +
  "const s=require('child_process').spawnSync(p,r,{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
  "if(s.stdout)process.stdout.write(s.stdout);if(s.stderr)process.stderr.write(s.stderr);" +
  "process.exit(typeof s.status==='number'?s.status:1)}" +
  "catch(e){process.stderr.write(String((e&&e.message)||'spawn failed'));process.exit(1)}";

// argv: [statusPath, projectRoot, ...devDoneIds] → 对 dev done 节点核对 commit 是否在 git 对象库，
// 不在则回 pending（§4.5 崩溃裁决：status 与 git 冲突以 git 为准）；stdout = 对账后的完整 status.json
const RECONCILE_STATUS =
  "try{const fs=require('fs');const sp=process.argv[1],root=process.argv[2],ids=process.argv.slice(3);" +
  "const x=require('child_process').execFileSync;const st=JSON.parse(fs.readFileSync(sp,'utf8'));const nodes={};" +
  "for(const k of Object.keys(st.nodes||{}))nodes[k]=st.nodes[k];const events=(st.events||[]).slice();" +
  "for(const id of ids){const e=nodes[id];if(!e||e.status!=='done')continue;let ok=false;" +
  "if(typeof e.commit==='string'&&e.commit.length>=7){try{x('git',['cat-file','-e',e.commit+'^{commit}'],{cwd:root,encoding:'utf8'});ok=true}catch(err){}}" +
  "if(ok)continue;nodes[id]={status:'pending',attempts:0};" +
  "events.push({seq:events.length+1,node:id,event:'reconcile-reset',detail:'status done 但 commit 不在 git 对象库，按 git 为准回 pending'})}" +
  "process.stdout.write(JSON.stringify({baseline:st.baseline||null,nodes:nodes,events:events}))}" +
  "catch(e){process.stderr.write(String((e&&e.message)||'reconcile failed'));process.exit(1)}";

// ── 纯工具函数 ──

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 启动校验失败的 failed-as-return 载体（不 throw：errored run 不可 resume 且丢结构化错误） */
function invalidRet(message: string, statusFile: string): WaveExecutorOutcome {
  return {
    terminated: "blocked",
    done: [],
    blocked: [],
    skipped: [],
    statusFile,
    coreFailure: null,
    validationError: message,
  };
}

function isRec(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStr(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}
function isStrArr(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");
}

/** 相对路径挂在 projectRoot 下；绝对路径原样返回 */
function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${rel}`;
}

function tailLines(text: string, n: number): string {
  const s = String(text ?? "").trimEnd();
  const lines = s.split("\n");
  return lines.length <= n ? s : lines.slice(-n).join("\n");
}

/** 文件路径是否落在领地内（领地条目=文件或目录前缀） */
function pathInTerritory(file: string, territories: string[]): boolean {
  for (const t of territories) {
    const prefix = t.endsWith("/") ? t : `${t}/`;
    if (file === t || file.startsWith(prefix)) return true;
  }
  return false;
}

/** porcelain 输出 → 文件路径列表（R 行取新路径；与 pr-lifecycle 同构） */
function parsePorcelain(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      let p = l.slice(3).trim().replace(/^"|"$/g, "");
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4).trim().replace(/^"|"$/g, "");
      return p;
    });
}

/** commitTemplate 渲染：{unitId}/{summary} 全量替换（split/join 防 replace 只换首个） */
function renderCommit(template: string, unitId: string, summary: string): string {
  return template.split("{unitId}").join(unitId).split("{summary}").join(summary);
}

/** 依赖环检测：DFS 三色标记，命中回边返回环上节点 id，无环返回 null */
function detectCycle(ids: string[], depsOf: Map<string, string[]>): string | null {
  const color = new Map<string, number>(); // 0=未访 1=在当前路径 2=完成
  for (const id of ids) color.set(id, 0);
  let hit: string | null = null;
  const visit = (id: string): void => {
    if (hit !== null) return;
    const c = color.get(id) ?? 0;
    if (c === 1) {
      hit = id;
      return;
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const d of depsOf.get(id) ?? []) visit(d);
    color.set(id, 2);
  };
  for (const id of ids) {
    visit(id);
    if (hit !== null) break;
  }
  return hit;
}

// ── exec-plan schema 校验（§8.3；错误全量收集后一次 fail-fast） ──

function validatePlan(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isRec(raw)) return { ok: false, errors: ["exec-plan 根必须是 JSON 对象"] };
  // version 不符时整体 schema 形态不可信，单独 return（混入 errors 会污染后续
  // 「本阶段错误收集完再停」的判据，吞掉节点级错误）
  if (raw.version !== 1) return { ok: false, errors: [`version 必须为 1，实际：${JSON.stringify(raw.version)}`] };
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
  const rawNodes: unknown[] = [];
  let accRec: Record<string, unknown> | null = null;
  if (mode === "dev") {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
      errors.push("mode=dev 时顶层 nodes 必须是非空数组");
    } else {
      rawNodes.push(...raw.nodes);
    }
  } else {
    if (!isRec(raw.acceptance)) {
      errors.push("mode=acceptance 时必须提供 acceptance 对象（nodes/groups/haltOnCoreFail）");
    } else {
      accRec = raw.acceptance;
      if (!Array.isArray(accRec.nodes) || accRec.nodes.length === 0) {
        errors.push("acceptance.nodes 必须是非空数组");
      } else {
        rawNodes.push(...(accRec.nodes as unknown[]));
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const nodes: PlanNode[] = [];
  const idSet = new Set<string>();
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
    if (idSet.has(id)) errors.push(`节点 id 重复：${id}`);
    idSet.add(id);
    const kind = rn.kind;
    if (kind !== "dev" && kind !== "verify" && kind !== "inspect") {
      errors.push(`节点 ${id} 的 kind 必须是 dev/verify/inspect，实际：${JSON.stringify(kind)}`);
      continue;
    }
    if (mode === "dev" && kind !== "dev") {
      errors.push(`mode=dev 但节点 ${id} kind=${kind}（dev 模式只承载 dev 节点）`);
    }
    if (mode === "acceptance" && kind === "dev") {
      errors.push(`mode=acceptance 但节点 ${id} kind=dev（dev 节点属 D1 实例化）`);
    }
    if (!isStrArr(rn.deps)) {
      errors.push(`节点 ${id} 的 deps 必须是字符串数组`);
      continue;
    }
    const node: PlanNode = {
      id,
      kind,
      deps: rn.deps,
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
      } else {
        node.territory = rn.territory;
      }
      if (!isStr(rn.promptFile)) {
        errors.push(`dev 节点 ${id} 缺少 promptFile`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      const tc = rn.testCommand;
      if (!isRec(tc) || !isStr(tc.program) || !isStrArr(tc.args)) {
        errors.push(`dev 节点 ${id} 的 testCommand 必须是 {program, args} 形态（program 字符串 + args 字符串数组）`);
      } else {
        if (!(TEST_WHITELIST as readonly string[]).includes(tc.program)) {
          errors.push(`dev 节点 ${id} 的 testCommand.program "${tc.program}" 不在白名单（${TEST_WHITELIST.join("/")}）`);
        }
        node.testCommand = { program: tc.program, args: tc.args };
      }
    } else if (kind === "verify") {
      if (!isStr(rn.script)) {
        errors.push(`verify 节点 ${id} 缺少 script（L3 剧本路径）`);
      } else {
        node.script = joinPath(projectRoot, rn.script);
      }
      if (!isStr(rn.artifactsDir)) {
        errors.push(`verify 节点 ${id} 缺少 artifactsDir`);
      } else {
        node.artifactsDir = joinPath(projectRoot, rn.artifactsDir);
      }
    } else {
      if (!isStr(rn.promptFile)) {
        errors.push(`inspect 节点 ${id} 缺少 promptFile（L4 任务书）`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      if (rn.artifactsRefs !== undefined) {
        if (!isStrArr(rn.artifactsRefs)) {
          errors.push(`inspect 节点 ${id} 的 artifactsRefs 必须是字符串数组`);
        } else {
          node.artifactsRefs = rn.artifactsRefs;
        }
      }
    }
    nodes.push(node);
  }
  if (errors.length > 0) return { ok: false, errors };

  // deps / artifactsRefs 引用存在性
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!idSet.has(d)) errors.push(`节点 ${n.id} 的 deps 引用了不存在的节点：${d}`);
    }
    for (const r of n.artifactsRefs) {
      if (!idSet.has(r)) errors.push(`节点 ${n.id} 的 artifactsRefs 引用了不存在的节点：${r}`);
    }
  }
  // 依赖环检测（简单 DFS）
  const depsOf = new Map<string, string[]>(nodes.map((n) => [n.id, n.deps]));
  const cycleHit = detectCycle(nodes.map((n) => n.id), depsOf);
  if (cycleHit !== null) errors.push(`依赖图存在环，环上节点：${cycleHit}`);

  // acceptance 分组
  let coreIds = new Set<string>();
  let haltOnCoreFail = false;
  if (mode === "acceptance" && accRec !== null) {
    const groups = accRec.groups;
    if (!isRec(groups)) {
      errors.push("acceptance.groups 必须是对象 {core, nonCore}");
    } else {
      if (!isStrArr(groups.core)) {
        errors.push("acceptance.groups.core 必须是字符串数组");
      } else {
        coreIds = new Set(groups.core);
        for (const c of groups.core) {
          if (!idSet.has(c)) errors.push(`groups.core 引用了不存在的节点：${c}`);
        }
      }
      if (groups.nonCore !== undefined) {
        if (!isStrArr(groups.nonCore)) {
          errors.push("acceptance.groups.nonCore 必须是字符串数组");
        } else {
          for (const c of groups.nonCore) {
            if (!idSet.has(c)) errors.push(`groups.nonCore 引用了不存在的节点：${c}`);
          }
        }
      }
    }
    if (typeof accRec.haltOnCoreFail !== "boolean") {
      errors.push("acceptance.haltOnCoreFail 必须是布尔值");
    } else {
      haltOnCoreFail = accRec.haltOnCoreFail;
    }
  }

  const commitTemplate = isStr(raw.commitTemplate) ? raw.commitTemplate : null;
  if (mode === "dev" && commitTemplate === null) {
    errors.push("mode=dev 时 commitTemplate 必须是非空字符串（含 {unitId}/{summary} 占位符）");
  }
  if (errors.length > 0) return { ok: false, errors };

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

async function readTextViaNode(path: string): Promise<string | null> {
  const r = await world.run("node", ["-e", READ_FILE_QUIET, path]);
  if (r.exitCode !== 0 || r.stdout.trim() === "") return null;
  return r.stdout;
}

async function writeTextViaNode(path: string, body: string): Promise<void> {
  const r = await world.run("node", ["-e", WRITE_FILE, path, body]);
  if (r.exitCode !== 0) {
    throw new Error(`写盘失败（${path}，exit ${r.exitCode}）：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

async function existsViaNode(path: string): Promise<boolean> {
  const r = await world.run("node", ["-e", EXISTS, path]);
  return r.exitCode === 0;
}

/** null = git 命令本身失败（非 git 仓库/工具缺失），区别于「干净」 */
async function gitPorcelainViaNode(cwd: string): Promise<string | null> {
  const r = await world.run("node", ["-e", GIT_PORCELAIN, cwd]);
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

async function gitAddCommitViaNode(
  cwd: string,
  message: string,
  files: string[],
): Promise<{ ok: boolean; hash: string; err: string }> {
  const r = await world.run("node", ["-e", GIT_ADD_COMMIT, cwd, message, ...files]);
  if (r.exitCode !== 0) return { ok: false, hash: "", err: tailLines(`${r.stdout}\n${r.stderr}`, TAIL_LINES) };
  return { ok: true, hash: r.stdout.trim(), err: "" };
}

// ── 状态（校验通过后填充；函数在运行时才读取，定义顺序无碍） ──

const state = new Map<string, NodeRt>();
let plan: ParsedPlan; // 赋值点在「校验执行计划」段；其后所有函数才可能被调用
let coreFail: { id: string; detail: string } | null = null;

function nodeState(id: string): NodeRt["status"] {
  return state.get(id)?.status ?? "pending";
}

// status.json 读改写串行链：批内多节点并发落地时防读改写交错丢更新
let statusChain: Promise<unknown> = Promise.resolve();
function serializedStatus<T>(fn: () => Promise<T>): Promise<T> {
  const run = statusChain.then(fn, fn);
  statusChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeEntry(e: unknown): StatusEntry {
  if (typeof e !== "object" || e === null) return { status: "pending", attempts: 0 };
  const r = e as Record<string, unknown>;
  const st =
    typeof r.status === "string" && VALID_ENTRY_STATUS.has(r.status) ? (r.status as StatusEntry["status"]) : "pending";
  return {
    status: st,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    commit: typeof r.commit === "string" ? r.commit : undefined,
    evidence: typeof r.evidence === "string" ? r.evidence : undefined,
  };
}

async function readStatusFile(): Promise<StatusFileData | null> {
  const text = await readTextViaNode(plan.statusPath);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRec(parsed)) return null;
    const nodes: Record<string, StatusEntry> = {};
    if (isRec(parsed.nodes)) {
      for (const k of Object.keys(parsed.nodes)) nodes[k] = normalizeEntry(parsed.nodes[k]);
    }
    const events: StatusEvent[] = Array.isArray(parsed.events)
      ? parsed.events.filter((e): e is StatusEvent => isRec(e) && typeof (e as Record<string, unknown>).node === "string")
      : [];
    const baseline = typeof parsed.baseline === "string" ? parsed.baseline : null;
    return { baseline, nodes, events };
  } catch {
    return null;
  }
}

async function statusUpdate(nodeId: string, entry: StatusEntry, event: string, detail?: string): Promise<void> {
  await serializedStatus(async () => {
    const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [] };
    const nodes: Record<string, StatusEntry> = { ...st.nodes, [nodeId]: entry };
    const events: StatusEvent[] = [
      ...st.events,
      { seq: st.events.length + 1, node: nodeId, event, detail: detail ?? entry.evidence ?? "" },
    ];
    await writeTextViaNode(
      plan.statusPath,
      JSON.stringify({ baseline: st.baseline, nodes, events }, null, 2),
    );
  });
}

// ── 节点状态流转 helpers（终态即时回写 status.json + 上板） ──

async function beginNode(id: string): Promise<void> {
  state.set(id, { status: "in-progress", attempts: 0 });
  await statusUpdate(id, { status: "in-progress", attempts: 0 }, "dispatch");
  report({ id, state: "in-progress", detail: "" }, "nodes");
}

async function finishNodeDone(id: string, attempts: number, commit: string | undefined, evidence: string): Promise<void> {
  state.set(id, { status: "done", attempts, commit });
  await statusUpdate(
    id,
    { status: "done", attempts, commit, evidence },
    "done",
    evidence + (commit !== undefined ? `；commit=${commit}` : ""),
  );
  report({ id, state: "done", detail: commit !== undefined ? commit.slice(0, 8) : evidence.slice(0, 40) }, "nodes");
}

async function markNodeBlockedOrFailed(
  id: string,
  st: "blocked" | "failed",
  reason: string,
  detail: string,
  attempts: number,
): Promise<void> {
  state.set(id, { status: st, attempts, reason, detail });
  const evidence = detail !== "" ? `${reason}；输出：${tailLines(detail, TAIL_LINES)}` : reason;
  await statusUpdate(id, { status: st, attempts, evidence }, st);
  report({ id, state: "failed", detail: reason }, "nodes");
  log(`节点 ${id} ${st === "failed" ? "验收失败" : "blocked"}：${reason}`);
}

// ── 测试命令白名单通道（program 字面量分支——编译期命令集可见；cwd 经 node -e 参数传入） ──

async function runTestCommand(cmd: TestCommand, cwd: string): Promise<RunOutcome | null> {
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

async function verifyDevNode(
  node: PlanNode,
  result: NodeResult,
  activeByCwd: Map<string, string[]>,
): Promise<VerifyVerdict> {
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
  // 查二级（粗粒度）：引擎另跑全量 status——改动集须 ⊆ 同 cwd 活跃单元领地并集
  //（并行共享工作区无法按单元切分 status，故只做并集级复核——设计 §8.2 边界声明）
  const porcelain = await gitPorcelainViaNode(node.cwd);
  if (porcelain === null) {
    return { outcome: "blocked", reason: "git status --porcelain 执行失败（引擎层）", detail: `cwd=${node.cwd}` };
  }
  const activeTerr = activeByCwd.get(node.cwd) ?? [];
  const strays = parsePorcelain(porcelain).filter(
    (f) => !f.startsWith(".tmp/") && !pathInTerritory(f, activeTerr),
  );
  if (strays.length > 0) {
    return {
      outcome: "retry",
      reason: "工作区存在不属于任何活跃单元领地的未提交改动",
      detail: `越界路径：\n${strays.join("\n")}\n（领地并集核对——共享工作区并行改动的归属边界）`,
    };
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

async function executeDevNode(node: PlanNode, activeByCwd: Map<string, string[]>): Promise<void> {
  await beginNode(node.id);
  // 同名 agent 续聊承载打回：同一 subagent 队列天然保持会话上下文（打回不另起会话）
  const nodeAgent = agent(`node-${node.id}`, DEV_PERSONA);
  let result = await nodeAgent.ask<NodeResult>(
    `读取任务书 ${node.promptFile}（绝对路径）并按其完整执行，返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers，可含 summary）。files_changed 用相对工作区 git 仓库根的路径（git status 风格）。`,
  );
  let attempts = 1;
  let verdict = await verifyDevNode(node, result, activeByCwd);
  while (verdict.outcome === "retry" && attempts <= MAX_REJECT_ROUNDS) {
    log(`节点 ${node.id} 核验未过（${verdict.reason}），打回定向修`);
    result = await nodeAgent.ask<NodeResult>(
      `引擎确定性核验未通过（原因：${verdict.reason}）。按以下失败输出定向修复，然后重新返回同一 JSON 契约：\n${verdict.detail}`,
    );
    attempts += 1;
    await statusUpdate(node.id, { status: "in-progress", attempts }, "reject-round", verdict.reason);
    verdict = await verifyDevNode(node, result, activeByCwd);
  }
  if (verdict.outcome === "pass") {
    const message = renderCommit(plan.commitTemplate, node.id, result.summary ?? "dev 单元交付");
    const cr = await gitAddCommitViaNode(node.cwd, message, result.files_changed);
    if (!cr.ok) {
      await markNodeBlockedOrFailed(node.id, "blocked", `commit 执行失败：${cr.err}`, "", attempts);
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

async function executeVerifyNode(node: PlanNode): Promise<void> {
  await beginNode(node.id);
  // 剧本由 D0 预编译，引擎只执行断言退出码；bash 白名单分支 + cwd 参数化
  const r = await world.run("node", ["-e", RUN_IN_CWD, "bash", node.cwd, node.script], {
    timeoutMs: VERIFY_SCRIPT_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    await markNodeBlockedOrFailed(
      node.id,
      "failed",
      `验收脚本退出码 ${r.exitCode}`,
      tailLines(`${r.stdout}\n${r.stderr}`, TAIL_LINES),
      1,
    );
    return;
  }
  const artOk = await existsViaNode(node.artifactsDir);
  if (!artOk) {
    await markNodeBlockedOrFailed(
      node.id,
      "failed",
      `产物目录不存在：${node.artifactsDir}`,
      "脚本 exit 0 但 artifactsDir 缺失",
      1,
    );
    return;
  }
  await finishNodeDone(node.id, 1, undefined, `verify exit 0；产物目录 ${node.artifactsDir}`);
  log(`Verify 节点 ${node.id} 脚本退出 0，产物目录存在，通过`);
}

async function executeInspectNode(node: PlanNode): Promise<void> {
  await beginNode(node.id);
  const nodeAgent = agent(`node-${node.id}`, INSPECT_PERSONA);
  const result = await nodeAgent.ask<NodeResult>(
    `读取验收任务书 ${node.promptFile}（绝对路径）并按其完整执行（只检查，不修改代码、不产生 commit），返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers）。`,
  );
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

async function executeNode(node: PlanNode, activeByCwd: Map<string, string[]>): Promise<void> {
  if (node.kind === "dev") return executeDevNode(node, activeByCwd);
  if (node.kind === "verify") return executeVerifyNode(node);
  return executeInspectNode(node);
}

// ── 调度主循环：就绪集 = deps 全 done 且自身 pending；批 ≤5，批内 allSettled 全落地后重算 ──

async function runSchedulingLoop(): Promise<void> {
  while (true) {
    if (coreFail !== null) break;
    const pendingNodes = plan.nodes.filter((n) => nodeState(n.id) === "pending");
    if (pendingNodes.length === 0) break;
    // 非核心组在核心全绿后解锁（设计 §6.2 D3）；dev 模式核心集为空 → 空条件恒真，不引入额外门
    const coreAllDone = plan.nodes
      .filter((n) => plan.coreIds.has(n.id))
      .every((n) => nodeState(n.id) === "done");
    const ready = pendingNodes.filter(
      (n) => n.deps.every((d) => nodeState(d) === "done") && (plan.coreIds.has(n.id) || coreAllDone),
    );
    if (ready.length === 0) break; // 无可调度但存在 pending → 依赖挂起 → 终态 blocked
    const batch = ready.slice(0, MAX_CONCURRENCY);
    log(`就绪 ${ready.length} 个节点，派发 ${batch.length} 个：${batch.map((n) => n.id).join("、")}`);
    // 级二粗粒度复核的基线：本批（活跃）节点领地按 cwd 分组求并集
    const activeByCwd = new Map<string, string[]>();
    for (const n of batch) {
      const list = activeByCwd.get(n.cwd) ?? [];
      for (const t of n.territory) list.push(t);
      activeByCwd.set(n.cwd, list);
    }
    const outcomes = await Promise.allSettled(batch.map((n) => executeNode(n, activeByCwd)));
    // rejected（agent 会话异常/写盘失败等）→ 节点 blocked，其他节点照常
    for (let i = 0; i < outcomes.length; i += 1) {
      const o = outcomes[i];
      if (o.status === "rejected") {
        const n = batch[i];
        await markNodeBlockedOrFailed(n.id, "blocked", `节点执行异常：${errText(o.reason)}`, "", 0);
      }
    }
    // 核心组熔断判定：本批任一核心节点 blocked/failed 且 haltOnCoreFail → 记归因、停止派发
    if (plan.haltOnCoreFail) {
      const bad = batch.find((n) => plan.coreIds.has(n.id) && (nodeState(n.id) === "blocked" || nodeState(n.id) === "failed"));
      if (bad !== undefined) {
        const rt = state.get(bad.id);
        coreFail = {
          id: bad.id,
          detail: `${rt?.reason ?? "未知原因"}\n${rt?.detail ?? ""}`.trim(),
        };
        log(`核心组节点 ${bad.id} 失败，haltOnCoreFail 熔断：未派发节点不再派发`);
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
let rawPlan: unknown;
try {
  rawPlan = JSON.parse(rawPlanText);
} catch (e) {
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

// 工作区干净基线（全部去重 cwd；.tmp/ 为 workflow 产物目录不计）——
// 这是级二「领地并集复核」成立的必要前提：历史脏文件会让粗粒度归属判定产生假阳性
const allCwds = [...new Set(plan.nodes.map((n) => n.cwd))];
for (const c of allCwds) {
  const st = await gitPorcelainViaNode(c);
  if (st === null) {
    return invalidRet(`git status 无法在 ${c} 执行（须为有效 git 仓库）`, plan.statusPath);
  }
  const dirty = parsePorcelain(st).filter((f) => !f.startsWith(".tmp/"));
  if (dirty.length > 0) {
    return invalidRet(
      `工作区不干净（${c}）：\n${dirty.join("\n")}\n引擎按活跃单元领地并集复核改动归属，启动前须为干净基线——请先提交或清理上述改动`,
      plan.statusPath,
    );
  }
}

// status.json：不存在 → 创建初始态（全 pending）；存在 → 只保留 done（dev done 须 commit 在 git，
// 不在则回 pending——§4.5 崩溃裁决以 git 为准），其余一律回 pending 重执行
const existingStatus = await readStatusFile();
if (existingStatus === null) {
  const initialNodes: Record<string, StatusEntry> = {};
  for (const n of plan.nodes) initialNodes[n.id] = { status: "pending", attempts: 0 };
  try {
    await writeTextViaNode(
      plan.statusPath,
      JSON.stringify({ baseline: plan.baseline, nodes: initialNodes, events: [] }, null, 2),
    );
  } catch (e) {
    return invalidRet(`status.json 初始态创建失败（${plan.statusPath}）：${errText(e)}`, plan.statusPath);
  }
  log(`status.json 不存在，已创建初始态（${plan.nodes.length} 个节点全 pending）：${plan.statusPath}`);
  for (const n of plan.nodes) state.set(n.id, { status: "pending", attempts: 0 });
} else {
  const devDoneIds = plan.nodes
    .filter((n) => n.kind === "dev" && existingStatus.nodes[n.id]?.status === "done")
    .map((n) => n.id);
  let aligned: Record<string, StatusEntry> = {};
  for (const n of plan.nodes) aligned[n.id] = existingStatus.nodes[n.id] ?? { status: "pending", attempts: 0 };
  if (devDoneIds.length > 0) {
    const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, ...devDoneIds]);
    if (rec.exitCode === 0 && rec.stdout.trim() !== "") {
      try {
        const parsed = JSON.parse(rec.stdout) as unknown;
        if (isRec(parsed) && isRec(parsed.nodes)) {
          for (const id of devDoneIds) aligned[id] = normalizeEntry(parsed.nodes[id]);
          log(`status.json 已存在，按 git 对账完成（dev done ${devDoneIds.length} 个核验 commit 存在性）`);
        }
      } catch {
        // 对账输出解析失败：保留原始 done 记录，终态核验仍有 commit 证据可查
      }
    }
  }
  for (const n of plan.nodes) {
    const e = aligned[n.id] ?? { status: "pending", attempts: 0 };
    const st: NodeRt["status"] = e.status === "done" ? "done" : "pending";
    state.set(n.id, { status: st, attempts: e.attempts });
  }
}

const depEdgeCount = plan.nodes.reduce((s, n) => s + n.deps.length, 0);
const resumedDone = plan.nodes.filter((n) => nodeState(n.id) === "done").length;
log(
  `执行计划校验通过：${plan.nodes.length} 个节点（mode=${plan.mode}），依赖边 ${depEdgeCount} 条无环` +
    (resumedDone > 0 ? `，${resumedDone} 个节点按 status.json 增量跳过` : ""),
);
for (const n of plan.nodes) {
  report({ id: n.id, state: nodeState(n.id) === "done" ? "done" : "pending", detail: "" }, "nodes");
}

// ══════════════ 阶段 2：并行执行（循环体单 phase，不按轮拆） ══════════════

if (plan.mode === "dev") {
  phase("并行执行开发节点");
  await runSchedulingLoop();
} else {
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
const terminated: WaveExecutorOutcome["terminated"] =
  coreFail !== null ? "core-failed" : badNodes.length === 0 && skippedIds.length === 0 ? "completed" : "blocked";

// 终局回写：挂起节点落 suspended + run-terminal 事件（status.json 即人读恢复入口）
await serializedStatus(async () => {
  const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [] };
  const nodes: Record<string, StatusEntry> = { ...st.nodes };
  for (const n of plan.nodes) {
    if (nodeState(n.id) === "pending") nodes[n.id] = { status: "suspended", attempts: 0 };
  }
  const events: StatusEvent[] = [
    ...st.events,
    {
      seq: st.events.length + 1,
      node: "-",
      event: "run-terminal",
      detail: `terminated=${terminated}; done=${doneIds.length}; blocked=${blockedOut.length}; skipped=${skippedIds.length}`,
    },
  ];
  await writeTextViaNode(plan.statusPath, JSON.stringify({ baseline: st.baseline, nodes, events }, null, 2));
});

log(
  `调度终态：${terminated}（done ${doneIds.length} / 未竟 ${blockedOut.length} / 挂起 ${skippedIds.length}）——状态文件 ${plan.statusPath}`,
);

return {
  terminated,
  done: doneIds,
  blocked: blockedOut,
  skipped: skippedIds,
  statusFile: plan.statusPath,
  coreFailure: coreFail,
  validationError: null,
};
