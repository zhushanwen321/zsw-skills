// workflow-observability.test.mjs — 观测机制独立局部测试
//
// 覆盖（对应实现：workflows/src/observability.shared.ts 单一观测层 + 两壳 O 区钩子 +
// scripts/workflow-observe.mjs + scripts/build-workflows.mjs 观测契约检查与观测层拼接）：
//   1. 双平台真实产物执行：zcode（transpile 后 vm 执行）与 pi（vm + require 注入）
//      跑 tech-review-loop，断言 JSONL 事件序列（start/end、异常终态 outcome、字段契约）
//   2. 可选观测兼容：不传观测参数不落盘；只传其一带可操作告警且不落盘；观测 ID 合法但
//      业务参数缺失仍完整记录 execution 边界
//   3. JSONL 路径安全：../ 形态 taskId 拒绝落盘
//   4. 并发执行：不同 executionId 各写各文件互不串扰
//   5. 观测层单元行为（单一源 + 壳钩子拼接执行）：正常 end / fn 抛异常补 script-error /
//      阶段重叠披露 abandoned / obsCloseExecution 终态统一补记 / skill_version 记注入常量
//   6. workflow-observe.mjs：start/end 契约、参数校验（含未知 flag 与超大整数）、
//      --help 入口、outcome 约束、selftest、--skill-version 旗标（传入落字段 / 缺省不写）、
//      老 JSONL（无 skill_version 字段）追加兼容（RL6）
//   7. 构建器：全量 --check 不漏检、--only 过滤
//
// 运行：node --test scripts/tests/workflow-observability.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
// V1 代 workflow 产物归档位（.archived/ 不入版本库，仅本机保留；第 1-5 节与第 10 节以
// 归档产物为载体测通用观测机制——产物字节未变，仅路径迁移）。载体缺失时相关节跳过
const WF_V1 = join(ROOT, ".archived/workflows-v1");
// 归档载体在盘判定：.archived/ 不入版本库，其他检出上无这些文件——相关用例跳过
//（跳过不是静默的，node --test 输出逐条打印 skip 原因）
const V1_CARRIER_READY = existsSync(join(WF_V1, "tech-review-loop.dwf.ts")) && existsSync(join(WF_V1, "pi", "tech-review-loop.js"));
const V1_SKIP = V1_CARRIER_READY ? false : "归档载体不在盘（.archived/ 不入版本库，仅本机保留）——本组用例跳过";
const ts = require("typescript");

const transpile = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

// ── 提速机制（只作用于测试执行通道，不改被测产物与断言语义）──
// 产物 transpile 结果按文件路径缓存：同一产物在几十个用例中重复执行，源码在测试进程
// 生命周期内只读不变（测试不写产物文件），重复 transpile 纯属浪费（单次 6-64ms × 40+ 次）
const transpileCache = new Map();
const transpileFile = (file) => {
  let js = transpileCache.get(file);
  if (js === undefined) {
    js = transpile(readFileSync(file, "utf8"));
    transpileCache.set(file, js);
  }
  return js;
};

// 产物引擎的文件/时间戳/git 探针全部以 `node -e <script>`、桩 CLI 以 `node <file.mjs>`
// 形态经 world.run 执行，单次 spawn 17-32ms、单次产物执行 14-51 个探针——把 node 形态
// 改为进程内等价执行（vm 沙箱 + mock process），git 与其余命令仍走真实 spawnSync。被测
// 产物只消费 {exitCode, stdout, stderr}，进程内执行与之逐字段等价（产物源码零改动）。
class NodeExitSignal {}
const NODE_EXIT = new NodeExitSignal();
// 探针脚本常量在产物内高度复用，编译结果按源码串缓存
const nodeScriptCache = new Map();

/**
 * 进程内等价执行一段 node -e / node <file> 脚本。
 * @param {string} script 脚本源码
 * @param {string[]} restArgs 附加参数（node 命令行里脚本之后的参数）
 * @param {{cwd?: string, scriptPath?: string}} opts cwd = 探针工作目录（world.run 的 cwd）；
 *   scriptPath 给出时为文件形态（argv[1] = 脚本路径），否则为 -e 形态（argv[1] = 首个参数）
 */
function runNodeInProcess(script, restArgs, { cwd = process.cwd(), scriptPath } = {}) {
  const argv = [process.execPath, ...(scriptPath !== undefined ? [scriptPath] : []), ...restArgs];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  // env 与 os.homedir 对齐真实 spawn 语义：子进程 env 注入 HOME=home（world.run 的 env），
  // os.homedir() 在 POSIX 上读 $HOME——进程内版本两者都要指向测试 home，否则产物经
  // NODE_PROBE_HOME 探测到的 skill 安装位会指向真实用户目录（fixture 全部落测试 home）
  const env = { ...process.env, HOME: cwd };
  const ctx = {
    require: (id) => {
      if (id === "os" || id === "node:os") {
        const mod = require(id);
        const wrapped = Object.create(mod);
        wrapped.homedir = () => cwd;
        return wrapped;
      }
      return require(id);
    },
    console: {
      log: (...m) => { stdout += m.map(String).join(" ") + "\n"; },
      error: (...m) => { stderr += m.map(String).join(" ") + "\n"; },
    },
    process: {
      argv,
      env,
      platform: process.platform,
      cwd: () => cwd,
      stdout: { write: (s) => { stdout += String(s); return true; } },
      stderr: { write: (s) => { stderr += String(s); return true; } },
      exit: (c) => {
        exitCode = typeof c === "number" ? c : 0;
        throw NODE_EXIT;
      },
    },
    module: { exports: {} },
    exports: {},
    __filename: scriptPath ?? "",
    __dirname: scriptPath !== undefined ? dirname(scriptPath) : cwd,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  };
  ctx.globalThis = ctx;
  let fn = nodeScriptCache.get(script);
  if (fn === undefined) {
    // node -e 允许顶层 return——包一层函数使其在 vm 中同样合法（语义 = 从模块 wrapper 返回）
    fn = new vm.Script(`(function(){\n${script}\n})`);
    nodeScriptCache.set(script, fn);
  }
  try {
    fn.runInNewContext(ctx)();
  } catch (e) {
    if (e instanceof NodeExitSignal) {
      // process.exit 模拟：退出码已在 ctx.process.exit 记录
    } else {
      // 未捕获异常对齐真实 node 语义：退出码 1、堆栈进 stderr（探针脚本对缺路径的
      // realpathSync 等会这样失败；产物按 exitCode 判失败，不逃逸异常进测试进程）
      stderr += String(e && e.stack ? e.stack : e) + "\n";
      exitCode = 1;
    }
  }
  return { exitCode, stdout, stderr };
}

/**
 * spawnSync 形态的快速通道（zcode world.run 与 pi 壳 require 注入共用）：
 * node 探针形态进程内执行，其余（git 等）真实 spawnSync。返回 {status, stdout, stderr}。
 */
function fastSpawnSync(cmd, args, opts, cwd = process.cwd()) {
  const a = args ?? [];
  if (cmd === "node" || cmd === process.execPath) {
    if (a[0] === "-e" && typeof a[1] === "string") {
      const r = runNodeInProcess(a[1], a.slice(2), { cwd });
      return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
    // 文件形态（测试自写桩 CLI，CJS 语法）：读源码进程内执行；非 .mjs 或文件缺失回退 spawn
    const f = a[0];
    if (typeof f === "string" && f.endsWith(".mjs") && existsSync(f)) {
      const r = runNodeInProcess(readFileSync(f, "utf8"), a.slice(1), { cwd, scriptPath: f });
      return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
  }
  const r = spawnSync(cmd, a, {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HOME: cwd },
    timeout: opts && opts.timeoutMs ? opts.timeoutMs : 30000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

/** zcode 执行器的 world.run 快速版（返回形态与原实现逐字段一致） */
const makeFastWorld = (home) => ({
  run: async (cmd, a, opts) => {
    const r = fastSpawnSync(cmd, a, opts, home);
    return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
});

const tmpHome = () => mkdtempSync(join(tmpdir(), "wf-obs-test-"));

/** 构造 tech-review-loop 走到「必读文件探针失败」（setup-failure）或更远所需的最小环境 */
function makeSkillScaffold(home, withFakeSkill) {
  const designDoc = join(home, "design");
  const projectRoot = join(home, "proj");
  mkdirSync(designDoc, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  if (withFakeSkill) {
    const agents = join(home, ".agents/skills/tech-design-v1/agents");
    const refs = join(home, ".agents/skills/tech-design-v1/references");
    const review = join(home, ".agents/skills/tech-design-v1/review");
    const scripts = join(home, ".agents/skills/tech-design-v1/scripts");
    for (const d of [agents, refs, review, scripts]) mkdirSync(d, { recursive: true });
    for (const f of [
      "tech-design-direction-review.md",
      "tech-design-review.md",
      "tech-design-impact-review.md",
      "tech-design-simplicity-review.md",
    ]) {
      writeFileSync(join(agents, f), "# template\n");
    }
    writeFileSync(join(review, "rubric-design-doc.md"), "# rubric\n");
    writeFileSync(join(refs, "principles.md"), "# principles\n");
    writeFileSync(join(refs, "design-doc-schema.md"), "# schema\n");
    // 假 CLI：exit 0 / 空输出（check-design-doc / render-design-doc / check-dispositions）
    for (const f of ["check-design-doc.mjs", "render-design-doc.mjs", "check-dispositions.mjs"]) {
      writeFileSync(join(scripts, f), "process.exit(0);\n");
    }
  }
  return { designDoc, projectRoot };
}

const obsArgs = (taskId, executionId, extra = {}) => ({
  taskId,
  executionId,
  ...(extra.sampleType !== undefined ? { sampleType: extra.sampleType } : {}),
});

/** zcode 产物执行器：transpile（缓存）+ vm，facade 全部由参数注入；world.run 走快速通道
 *  （node 探针进程内执行，git 等真实 spawn，HOME 指向 home）。
 *  dir 默认归档 v1 目录（与默认 name=tech-review-loop 配套）；测现行 workflow 时显式传 WF */
async function runZcodeArtifact(home, argsValue, agentImpl, name = "tech-review-loop", dir = WF_V1) {
  const js = transpileFile(join(dir, `${name}.dwf.ts`));
  const logs = [];
  const world = makeFastWorld(home);
  const agent = agentImpl ?? (() => { throw new Error("测试场景不应派发 agent"); });
  const fn = new vm.Script(`(async function __main__(args, world, log, phase, report, artifact, agent) {\n${js}\n})`)
    .runInNewContext({});
  const result = await fn(
    argsValue,
    world,
    (m) => logs.push(String(m)),
    () => {},
    () => {},
    { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
    agent,
  );
  return { result, logs };
}

/** pi 产物执行器：vm + require/$ARGS/$WORKSPACE 注入（pi 宿主注入形态）；dir 语义同 zcode 执行器。
 *  require 注入层拦截 child_process：pi 壳自带的 spawnSync world.run 换成快速通道（node 探针
 *  进程内执行、git 等真实 spawn），其余模块与函数原样放行 */
async function runPiArtifact(home, argsValue, agentImpl, name = "tech-review-loop", dir = WF_V1) {
  const raw = readFileSync(join(dir, "pi", `${name}.js`), "utf8");
  const logs = [];
  const context = {
    require: (id) => {
      if (id === "node:child_process" || id === "child_process") {
        const mod = require(id);
        const wrapped = Object.create(mod);
        wrapped.spawnSync = (cmd, args, opts) => fastSpawnSync(cmd, args, opts, home);
        return wrapped;
      }
      return require(id);
    },
    console,
    process: { env: { ...process.env, HOME: home }, cwd: () => home, stdout: process.stdout, stderr: process.stderr },
    $ARGS: { ...argsValue },
    $WORKSPACE: home,
    agent: agentImpl ?? (() => { throw new Error("测试场景不应派发 agent"); }),
    log: (m) => logs.push(String(m)),
    phase: () => {},
    report: () => {},
    artifact: { chart: () => {}, board: () => {}, markdown: async () => ({}), file: async () => ({}) },
  };
  context.globalThis = context;
  // pi 宿主以 `const args = $ARGS` 注入（产物不声明 args）——wrapper 里补该声明
  const fn = new vm.Script(
    `(async function __main__() {\nconst args = $ARGS;\n${raw}\n})`,
  ).runInNewContext(context);
  const result = await fn();
  return { result, logs };
}

const readJsonl = (home, taskId, executionId) =>
  readFileSync(join(home, ".agents/skill-data/workflow-observability", taskId, `${executionId}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

const obsFileExists = (home, taskId, executionId) =>
  existsSync(join(home, ".agents/skill-data/workflow-observability", taskId, `${executionId}.jsonl`));

const NINE_FIELDS = [
  "execution_id", "task_id", "skill", "stage", "step", "round", "attempt", "event", "timestamp", "sample_type",
];

function assertContract(rec, overrides = {}) {
  for (const f of NINE_FIELDS) assert.ok(f in rec, `事件缺契约字段 ${f}: ${JSON.stringify(rec)}`);
  assert.ok(rec.event === "start" || rec.event === "end");
  assert.ok(!Number.isNaN(Date.parse(rec.timestamp)), `timestamp 非 ISO8601: ${rec.timestamp}`);
  assert.ok(rec.sample_type === "production" || rec.sample_type === "selftest");
  for (const [k, v] of Object.entries(overrides)) assert.equal(rec[k], v, `字段 ${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(rec[k])}`);
}

// ── 1. 双平台真实产物：setup-failure 异常终态（必读文件缺失）──

const setupFailureExpect = (taskId) => [
  { event: "start", step: "execution" },
  { event: "start", step: "setup" },
  { event: "end", step: "setup", outcome: "setup-failure" },
  { event: "end", step: "execution", outcome: "setup-failure" },
];

test("zcode 产物：setup-failure 终态的观测事件序列与字段契约", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { result } = await runZcodeArtifact(home, {
      designDoc, projectRoot, ...obsArgs("t-zc", "e-sf", { sampleType: "selftest" }),
    });
    assert.equal(result.terminated, "setup-failure");
    const lines = readJsonl(home, "t-zc", "e-sf");
    assert.equal(lines.length, 4);
    lines.forEach((rec, i) => {
      const want = setupFailureExpect()[i];
      assert.equal(rec.event, want.event, `行 ${i} event`);
      assert.equal(rec.step, want.step, `行 ${i} step`);
      if (want.outcome !== undefined) assert.equal(rec.outcome, want.outcome, `行 ${i} outcome`);
      else assert.ok(!("outcome" in rec), `行 ${i} 不应带 outcome`);
      assertContract(rec, {
        task_id: "t-zc", execution_id: "e-sf", skill: "tech-design-v1", stage: "T2",
        sample_type: "selftest",
        round: want.step === "review" ? 1 : null,
      });
      // attempt 字段语义 = 事件时点的重发起序号：start 事件先于 attempt 自动检测（null），
      // end 事件由终态统一补记（attempt 已回填 = 1）
      assert.equal(rec.attempt, want.event === "end" ? 1 : null, `行 ${i} attempt`);
    });
    assert.ok(!("outcome" in lines[0] || "outcome" in lines[1]), "start 事件不带 outcome");
    // skill_version 恒记执行引擎注入的当前版本（D6/V5 定案：事件回答「谁在执行」——
    // 本用例是 setup-failure 的老式场景、无任何产物版本字段参与，事件照记引擎版本不记 unknown）
    const embedded = readFileSync(join(WF_V1, "tech-review-loop.dwf.ts"), "utf8").match(/const SKILL_VERSION = "([^"]*)";/)?.[1] ?? null;
    assert.ok(embedded, "产物应内嵌 SKILL_VERSION 版本戳");
    lines.forEach((l) => assert.equal(l.skill_version, embedded, "事件 skill_version 应等于产物内嵌的引擎版本"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 产物：setup-failure 终态的观测事件序列与 zcode 对拍一致", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home; // pi 壳 world.run 走 spawnSync 继承进程 env
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { result } = await runPiArtifact(home, {
      designDoc, projectRoot, ...obsArgs("t-pi", "e-sf"),
    });
    assert.equal(result.terminated, "setup-failure");
    const zcHome = tmpHome();
    try {
      const scaffold = makeSkillScaffold(zcHome, false);
      await runZcodeArtifact(zcHome, { designDoc: scaffold.designDoc, projectRoot: scaffold.projectRoot, ...obsArgs("t-pi", "e-sf") });
      const piLines = readJsonl(home, "t-pi", "e-sf").map(({ timestamp, ...rest }) => rest);
      const zcLines = readJsonl(zcHome, "t-pi", "e-sf").map(({ timestamp, ...rest }) => rest);
      assert.deepEqual(piLines, zcLines, "双平台事件（除 timestamp）应逐字段一致");
    } finally {
      rmSync(zcHome, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 2. 自然 end 与中断 end 并存：假 skill 走到四席审查（stub agent 不写报告 → review-failure）──

test("zcode 产物：setup 自然 end（无 outcome）+ review 由终态统一补记（outcome=review-failure）", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, true);
    const reviewerReturn = { mustFix: 0, fixScope: "patch", problems: [], reconciliation: [], oneliner: "smoke" };
    const agent = (name) => ({ ask: async () => ({ ...reviewerReturn }) });
    const { result } = await runZcodeArtifact(home, {
      designDoc, projectRoot, ...obsArgs("t-zc", "e-rv"),
    }, agent);
    assert.equal(result.terminated, "review-failure");
    const lines = readJsonl(home, "t-zc", "e-rv");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
      [
        { event: "start", step: "execution", round: null, outcome: undefined },
        { event: "start", step: "setup", round: null, outcome: undefined },
        { event: "end", step: "setup", round: null, outcome: undefined },
        { event: "start", step: "review", round: 1, outcome: undefined },
        { event: "end", step: "review", round: 1, outcome: "review-failure" },
        { event: "end", step: "execution", round: null, outcome: "review-failure" },
      ],
    );
    assert.ok(lines[2].outcome === undefined, "自然完成的 setup end 不带 outcome");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 3. 可选观测兼容 ──

test("观测 ID 合法但业务参数缺失：execution 边界完整（参数失败早退不漏记）", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { projectRoot } = makeSkillScaffold(home, false);
    // designDoc 缺失 → deriveInputs 参数校验失败早退（早于常规业务阶段）；
    // 观测形态层先于参数窄化启用——仍须有完整 execution start/end
    const { result, logs } = await runZcodeArtifact(home, {
      projectRoot, ...obsArgs("t-parm", "e-parm"),
    });
    assert.equal(result.terminated, "setup-failure");
    assert.ok(result.message.includes("参数校验失败"), "业务终态应保留参数校验失败原因");
    const lines = readJsonl(home, "t-parm", "e-parm");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome })),
      [
        { event: "start", step: "execution", outcome: undefined },
        { event: "start", step: "setup", outcome: undefined },
        { event: "end", step: "setup", outcome: "setup-failure" },
        { event: "end", step: "execution", outcome: "setup-failure" },
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("projectRoot 不存在：slug 探针失败早退仍有 4 行完整事件（真实 run dwfrun-e3741b98 漏记回归）", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc } = makeSkillScaffold(home, false);
    const missingRoot = join(home, "no-such-root");
    const { result } = await runZcodeArtifact(home, {
      designDoc, projectRoot: missingRoot, ...obsArgs("t-slug", "e-slug"),
    });
    assert.equal(result.terminated, "setup-failure");
    // 措辞随寻址层演进（"slug 探针" → "skill-data 寻址检测探针"），本用例只锚定失败语义
    // 与恢复动作在场——观测边界完整性才是被测行为
    assert.ok(result.message.includes("projectRoot 无法解析为") && result.message.includes("恢复动作"), result.message);
    const lines = readJsonl(home, "t-slug", "e-slug");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome })),
      [
        { event: "start", step: "execution", outcome: undefined },
        { event: "start", step: "setup", outcome: undefined },
        { event: "end", step: "setup", outcome: "setup-failure" },
        { event: "end", step: "execution", outcome: "setup-failure" },
      ],
    );
    // slug 探针先于 attempt 自动检测——全部事件 attempt=null（字段语义 = 事件时点值）
    assert.ok(lines.every((l) => l.attempt === null), `attempt 应全为 null：${JSON.stringify(lines.map((l) => l.attempt))}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("不传观测参数：业务照常（setup-failure）且不产生观测文件", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { result, logs } = await runZcodeArtifact(home, { designDoc, projectRoot });
    assert.equal(result.terminated, "setup-failure");
    const obsRoot = join(home, ".agents/skill-data/workflow-observability");
    assert.ok(!existsSync(obsRoot), "不应创建观测根目录");
    assert.ok(!logs.some((l) => l.includes("WARN: 观测")), "合法关闭不告警");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("只传 taskId：可操作告警且不落盘", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { result, logs } = await runZcodeArtifact(home, {
      designDoc, projectRoot, taskId: "t-only",
    });
    assert.equal(result.terminated, "setup-failure", "观测参数缺失不改变业务终态");
    assert.ok(logs.some((l) => l.includes("观测参数不完整") && l.includes("恢复动作")), `告警应含原因与恢复动作：${logs.join("\n")}`);
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("路径穿越形态 taskId（../evil）：拒绝落盘且观测根外无写入", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { result, logs } = await runZcodeArtifact(home, {
      designDoc, projectRoot, ...obsArgs("../evil", "e-x"),
    });
    assert.equal(result.terminated, "setup-failure");
    assert.ok(logs.some((l) => l.includes("路径不安全字符") && l.includes("恢复动作")));
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")));
    assert.ok(!existsSync(join(home, "evil")), "穿越目标目录不得被创建");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sampleType 非法：告警并关闭观测", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const { logs } = await runZcodeArtifact(home, {
      designDoc, projectRoot, ...obsArgs("t-bad", "e-bad", { sampleType: "staging" }),
    });
    assert.ok(logs.some((l) => l.includes("sampleType") && l.includes("恢复动作")));
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 4. 并发执行不同文件 ──

test("并发两次执行（不同 executionId）：各自 JSONL 完整互不串扰", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const { designDoc, projectRoot } = makeSkillScaffold(home, false);
    const run = (exec) => runZcodeArtifact(home, { designDoc, projectRoot, ...obsArgs("t-par", exec) });
    await Promise.all([run("e-a"), run("e-b"), run("e-c")]);
    for (const exec of ["e-a", "e-b", "e-c"]) {
      const lines = readJsonl(home, "t-par", exec);
      assert.equal(lines.length, 4, `${exec} 应有完整 4 条事件`);
      assert.ok(lines.every((l) => l.execution_id === exec));
    }
    assert.equal(readdirSync(join(home, ".agents/skill-data/workflow-observability/t-par")).length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 5. 观测层单元行为（单一构建输入 observability.shared.ts + 壳钩子拼接执行）──

// 观测层单元执行输入：壳 O 区钩子 + observability.shared.ts 拼接（与产物同一份文本，
// 非测试内复制）——两用例共用同一拼接结果，缓存避免重复 transpile
let obsLayerCodeCache = null;
const obsLayerCode = () => {
  if (obsLayerCodeCache === null) {
    const layerSrc = readFileSync(join(WF, "src/observability.shared.ts"), "utf8");
    const shellSrc = readFileSync(join(WF_V1, "src/tech-review-loop.zcode.tpl.ts"), "utf8");
    const hookStart = shellSrc.indexOf("// ── O 区观测平台钩子");
    const hookEnd = shellSrc.indexOf("@@STITCH@@");
    assert.ok(hookStart > 0 && hookEnd > hookStart, "壳 O 区锚点定位失败");
    obsLayerCodeCache = transpile(`${shellSrc.slice(hookStart, hookEnd)}\n${layerSrc}`);
  }
  return obsLayerCodeCache;
};

test("withStage/obsBegin/obsCloseExecution：正常 end、fn 抛异常补 script-error、阶段重叠披露 abandoned、终态统一补记", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const code = obsLayerCode();
    const logs = [];
    const world = makeFastWorld(home);
    const ctx = { args: { taskId: "t-ws", executionId: "e-ws" } };
    const fn = new vm.Script(
      `(async function __main__(args, world, log) {\n${code}\n
       // 观测层单独执行时无构建器注入——按拼接契约补 SKILL_VERSION 常量（业务源同位置）
       const SKILL_VERSION = "0.1.0-test";
       obsCtx = initObservation("tech-design-v1", "T2", null);
       obsAttachHome(${JSON.stringify(home)});
       await obsEmit("execution", null, "start", null);
       // withStage 正常路径
       await withStage("setup", null, async () => "ok");
       // withStage 抛异常路径（end 带 script-error）
       await withStage("review", 1, async () => { throw new Error("boom"); }).then(
         () => { throw new Error("withStage 应向调用方传播异常"); },
         () => {},
       );
       // 阶段重叠：fix 未结束即开 gate-a → 前一阶段补记 end（outcome=abandoned）+ 告警
       await obsBegin("fix", 2);
       await obsBegin("gate-a", null);
       // 打开 step 不关闭 → 终态统一补记 end（带 outcome）
       await obsCloseExecution("converged");
       })`,
    ).runInNewContext(ctx);
    await fn(ctx.args, world, (m) => logs.push(String(m)));
    const lines = readJsonl(home, "t-ws", "e-ws");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
      [
        { event: "start", step: "execution", round: null, outcome: undefined },
        { event: "start", step: "setup", round: null, outcome: undefined },
        { event: "end", step: "setup", round: null, outcome: undefined },
        { event: "start", step: "review", round: 1, outcome: undefined },
        { event: "end", step: "review", round: 1, outcome: "script-error" },
        { event: "start", step: "fix", round: 2, outcome: undefined },
        { event: "end", step: "fix", round: 2, outcome: "abandoned" },
        { event: "start", step: "gate-a", round: null, outcome: undefined },
        { event: "end", step: "gate-a", round: null, outcome: "converged" },
        { event: "end", step: "execution", round: null, outcome: "converged" },
      ],
    );
    assert.ok(
      logs.some((l) => l.includes("观测阶段重叠") && l.includes("abandoned") && l.includes("恢复动作")),
      `阶段重叠须显式披露且含恢复动作：${logs.join("\n")}`,
    );
    // skill_version = 拼接契约注入的常量（观测层自身不解析版本）
    lines.forEach((l) => assert.equal(l.skill_version, "0.1.0-test", "skill_version 应记注入常量"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("obsEnd 配对检查：错名/round 错位给实际打开阶段补 abandoned、重复 end 不伪造事件", { skip: V1_SKIP }, async () => {
  const home = tmpHome();
  try {
    const code = obsLayerCode();
    const logs = [];
    const world = makeFastWorld(home);
    const ctx = { args: { taskId: "t-pair", executionId: "e-pair" } };
    const fn = new vm.Script(
      `(async function __main__(args, world, log) {\n${code}\n
       const SKILL_VERSION = "0.1.0-test";
       obsCtx = initObservation("tech-design-v1", "T2", null);
       obsAttachHome(${JSON.stringify(home)});
       await obsEmit("execution", null, "start", null);
       // 错名 + round 错位：实际打开 fix(2)，收到 review(1) 的 end
       await obsBegin("fix", 2);
       await obsEnd("review", 1);
       // 无打开阶段：重复 end
       await obsEnd("review", 1);
       // 正常配对（对照：自然 end 语义不变）
       await obsBegin("fix", 3);
       await obsEnd("fix", 3);
       await obsEnd("fix", 3);
       await obsCloseExecution("converged");
       })`,
    ).runInNewContext(ctx);
    await fn(ctx.args, world, (m) => logs.push(String(m)));
    const lines = readJsonl(home, "t-pair", "e-pair");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
      [
        { event: "start", step: "execution", round: null, outcome: undefined },
        { event: "start", step: "fix", round: 2, outcome: undefined },
        { event: "end", step: "fix", round: 2, outcome: "abandoned" },
        { event: "start", step: "fix", round: 3, outcome: undefined },
        { event: "end", step: "fix", round: 3, outcome: undefined },
        { event: "end", step: "execution", round: null, outcome: "converged" },
      ],
    );
    const mismatchWarn = logs.find((l) => l.includes("观测配对异常") && l.includes("当前打开的是"));
    const dupWarn = logs.find((l) => l.includes("观测配对异常") && l.includes("无打开中的阶段"));
    assert.ok(mismatchWarn && mismatchWarn.includes("恢复动作"), `错名 end 须披露且含恢复动作：${logs.join("\n")}`);
    assert.ok(dupWarn && dupWarn.includes("恢复动作"), `重复 end 须披露且含恢复动作：${logs.join("\n")}`);
    lines.forEach((l) => assert.equal(l.skill_version, "0.1.0-test", "skill_version 应记注入常量"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 6. workflow-observe.mjs ──

// 进程内通道：observeMain 垫片（scripts/workflow-observe.mjs 导出）与 CLI 共用同一份参数
// 解析与落盘逻辑；返回 {code, stdout, stderr}，消费字段与 spawnSync 对齐（status→code）
import { main as observeMain } from "../workflow-observe.mjs";

const runObserve = (home, args) => {
  const r = observeMain(args, { home });
  // status 别名对齐 spawnSync 消费字段——既有断言（r.status / r.stdout / r.stderr）逐条保留不改
  return { ...r, status: r.code };
};

// CLI spawn 通道：仅防漂移对拍锚使用（进程内结果必须与真实 CLI spawn 逐字段一致）
const runObserveSpawn = (home, args) =>
  spawnSync(process.execPath, [join(ROOT, "scripts/workflow-observe.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

test("workflow-observe.mjs：start/end 写同一 JSONL、契约字段与 workflow 内建一致", () => {
  const home = tmpHome();
  try {
    const base = ["--task-id", "t-cli", "--execution-id", "e-cli", "--skill", "dev-flow-v1", "--stage", "D0", "--step", "compile"];
    let r = runObserve(home, ["start", ...base, "--attempt", "1", "--sample-type", "selftest"]);
    assert.equal(r.status, 0, r.stderr);
    r = runObserve(home, ["end", ...base, "--attempt", "1", "--sample-type", "selftest", "--outcome", "completed"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = readJsonl(home, "t-cli", "e-cli");
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome })),
      [
        { event: "start", step: "compile", outcome: undefined },
        { event: "end", step: "compile", outcome: "completed" },
      ],
    );
    lines.forEach((l) => assertContract(l, { task_id: "t-cli", execution_id: "e-cli", skill: "dev-flow-v1", stage: "D0", sample_type: "selftest", attempt: 1, round: null }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflow-observe.mjs：用法错误 exit 2 且不落盘（非法 ID / start 带 outcome / 缺必填 / 坏 round）", () => {
  const home = tmpHome();
  try {
    const cases = [
      ["start", "--task-id", "../evil", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--outcome", "x"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--round", "abc"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--round", "99999999999999999999"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--unknown-flag", "v"],
      ["start", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--skill-version", "  "],
      ["restart", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P"],
      ["end", "--task-id", "t", "--execution-id", "e", "--skill", "s", "--stage", "G", "--step", "P", "--sample-type", "staging"],
    ];
    for (const c of cases) {
      const r = runObserve(home, c);
      assert.equal(r.status, 2, `应 exit 2：${c.join(" ")}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.ok(r.stderr.includes("恢复动作"), `错误信息应含恢复动作：${r.stderr}`);
    }
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflow-observe.mjs：--skill-version 传入落字段、缺省不写；老 JSONL（无该字段）追加兼容（RL6）", () => {
  const home = tmpHome();
  try {
    const base = ["--task-id", "t-ver", "--execution-id", "e-ver", "--skill", "dev-flow-v1", "--stage", "D0", "--step", "compile"];
    // 缺省不写 skill_version（additive 契约：不带旗标的存量调用行为逐字节不变）
    let r = runObserve(home, ["start", ...base]);
    assert.equal(r.status, 0, r.stderr);
    let lines = readJsonl(home, "t-ver", "e-ver");
    assert.equal(lines.length, 1);
    assert.ok(!("skill_version" in lines[0]), "未传 --skill-version 时不写字段");

    // 老 JSONL 行（已落盘、无 skill_version）后追加带旗标的事件：老行原样保留，新行带字段
    const file = join(home, ".agents/skill-data/workflow-observability", "t-ver", "e-ver.jsonl");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}{"execution_id":"e-ver","task_id":"t-ver","skill":"dev-flow-v1","stage":"D0","step":"compile","round":null,"attempt":null,"event":"end","timestamp":"2026-01-01T00:00:00.000Z","sample_type":"production"}\n`,
    );
    r = runObserve(home, ["end", ...base, "--skill-version", "0.1.0", "--outcome", "completed"]);
    assert.equal(r.status, 0, r.stderr);
    lines = readJsonl(home, "t-ver", "e-ver");
    assert.equal(lines.length, 3);
    assert.ok(!("skill_version" in lines[0]) && !("skill_version" in lines[1]), "老行保持无字段（不被改写）");
    assert.equal(lines[2].skill_version, "0.1.0");
    assert.equal(lines[2].event, "end");
    assert.equal(lines[2].outcome, "completed");

    // 验收命令原文形态：start 带 --skill-version 0.1.0 → 落盘行含 "skill_version":"0.1.0"
    const r2 = runObserve(home, [
      "start", "--task-id", "t-accept", "--execution-id", "e-accept", "--skill", "dev-flow-v1",
      "--stage", "D0", "--step", "compile", "--skill-version", "0.1.0",
    ]);
    assert.equal(r2.status, 0, r2.stderr);
    const raw = readFileSync(join(home, ".agents/skill-data/workflow-observability", "t-accept", "e-accept.jsonl"), "utf8");
    assert.ok(raw.includes('"skill_version":"0.1.0"'), raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflow-observe.mjs：裸 --help / -h 打印用法 exit 0（先于子命令校验）", () => {
  const home = tmpHome();
  try {
    for (const flag of ["--help", "-h"]) {
      const r = runObserve(home, [flag]);
      assert.equal(r.status, 0, `--help 应 exit 0：${flag}\nstderr=${r.stderr}`);
      assert.ok(r.stdout.includes("用法"), r.stdout);
    }
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("防漂移锚：observeMain 进程内结果 == CLI spawn 结果（成功路径双跑对拍）", () => {
  // 进程内提速通道的防漂移约束：同参数在两个独立 home 各跑一次（observeMain 进程内 vs
  // 真实 CLI spawn），退出码、stdout（去掉各自 home 前缀）与落盘 JSONL 事件（除 timestamp
  // ——两次执行时刻必然不同）必须逐字段一致
  const args = [
    "start", "--task-id", "t-parity", "--execution-id", "e-parity", "--skill", "dev-flow-v1",
    "--stage", "D0", "--step", "compile", "--sample-type", "selftest", "--skill-version", "0.1.0",
  ];
  const inHome = tmpHome();
  const cliHome = tmpHome();
  try {
    const inProc = runObserve(inHome, args);
    const cli = runObserveSpawn(cliHome, args);
    assert.equal(inProc.status, cli.status, `退出码不一致：进程内 ${inProc.status} vs CLI ${cli.status}（stderr=${inProc.stderr}/${cli.stderr}）`);
    const stripHome = (s, home) => s.split(home).join("<home>");
    assert.equal(stripHome(inProc.stdout, inHome), stripHome(cli.stdout, cliHome), "stdout 不一致");
    assert.equal(inProc.stderr, cli.stderr, "stderr 不一致");
    const inLines = readJsonl(inHome, "t-parity", "e-parity").map(({ timestamp, ...rest }) => rest);
    const cliLines = readJsonl(cliHome, "t-parity", "e-parity").map(({ timestamp, ...rest }) => rest);
    assert.deepEqual(inLines, cliLines, "落盘 JSONL 事件（除 timestamp）应逐字段一致");
  } finally {
    rmSync(inHome, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});

// ── 7. 构建器 ──

test("构建器：全量 --check 不漏检（全部 workflow 接入观测且三平台产物一致）", () => {
  // 断言口径：全量 --check 必须覆盖全部 workflow（不悄悄漏检禁碰文件）且各份产物
  // 在三个落点（仓内双平台 + ~/.zcode/workflows saved 副本）全部一致
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `全量 --check 应全绿：\n${r.stdout}\n${r.stderr}`);
  for (const name of ["design-code-sync-loop", "design-code-sync-v2"]) {
    assert.ok(r.stdout.includes(name), `全量 --check 输出须覆盖 ${name}（不得漏检）`);
    assert.ok(r.stdout.includes(`${name}.dwf.ts（一致）`), `${name} 产物应一致：\n${r.stdout}\n${r.stderr}`);
  }
  assert.ok(!r.stdout.includes("未接入观测"), "全部 workflow 均已接入观测，不应再出现未接入分支");
  assert.ok(r.stdout.includes("stage=D5"), "design-code-sync-loop 应输出 D5 观测契约行");
});

test("构建器：--only 未知名报错 exit 2；--only 全部 workflow 构建绿", () => {
  let r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--only", "no-such"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("未知 workflow 名"), r.stderr);
  r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--only", "design-code-sync-loop,design-code-sync-v2"], { encoding: "utf8" });
  assert.equal(r.status, 0, `--only 构建应绿：\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes("--only 生效"), r.stdout);
  assert.ok(r.stdout.includes("观测契约"), "构建应输出观测契约核对结果");
});

// ── 8. design-code-sync-loop（D5）双平台真实产物 ──

/** 构造 D5 走到目标阶段所需的最小环境：git 仓库（HEAD 探针 / 组级 commit / 退役扫描
 *  都要真 git）+ 设计文档 + impl-plan JSON + 两 agent 模板（经 args 传绝对路径，
 *  不依赖 skill 安装位） */
function makeSyncScaffold(home) {
  const projectRoot = join(home, "proj");
  mkdirSync(join(projectRoot, "pkg"), { recursive: true });
  const git = (a) => {
    const r = spawnSync("git", a, { cwd: projectRoot, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${a.join(" ")} 失败：${r.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  const codeFile = join(projectRoot, "pkg", "mod.ts");
  writeFileSync(codeFile, "export const value = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  const designDoc = join(home, "design.md");
  writeFileSync(designDoc, "# 设计\n");
  const implPlan = join(home, "design.impl-plan.json");
  writeFileSync(implPlan, JSON.stringify({ units: [] }));
  const tplDir = join(home, "tpl");
  mkdirSync(tplDir, { recursive: true });
  const plannerTemplate = join(tplDir, "planner.md");
  const reviewerTemplate = join(tplDir, "reviewer.md");
  writeFileSync(plannerTemplate, "# planner\n");
  writeFileSync(reviewerTemplate, "# reviewer\n");
  // 空词表（scan/skip 皆空）+ 源指纹（2026-11-04 指纹制）：setup 的词表指纹预检要求
  // watchlist 必传且 sourceFingerprints 与两份源文档当前内容一致——脚手架文档零反引号
  // 零词表词，机械步零立项保持原用例的收敛语义
  const watchlist = join(home, "wl.json");
  const sha = (p) => createHash("sha256").update(readFileSync(p, "utf8")).digest("hex");
  writeFileSync(watchlist, JSON.stringify({ sourceFingerprints: { [designDoc]: sha(designDoc), [implPlan]: sha(implPlan) }, scan: [], skip: [] }));
  return { designDoc, implPlan, projectRoot, plannerTemplate, reviewerTemplate, codeFile, watchlist };
}

const syncBaseArgs = (s) => ({
  designDoc: s.designDoc,
  implPlan: s.implPlan,
  watchlist: s.watchlist,
  projectRoot: s.projectRoot,
  plannerTemplate: s.plannerTemplate,
  reviewerTemplate: s.reviewerTemplate,
});

/** D5 双平台通用 agent 桩：按实例名（前缀匹配）返回结构化结果。两平台调用形态不同——
 *  zcode facade 收 (name, persona) 返回 { ask }；pi 收 { prompt, schema, description }
 *  直接返回原始值——按首参形态自适应 */
function syncAgentStub(map) {
  return (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const hit = Object.keys(map).find((k) => name === k || name.startsWith(k));
    assert.ok(hit !== undefined, `未预期的 agent 实例：${name}`);
    const value = typeof map[hit] === "function" ? map[hit](name) : map[hit];
    return typeof a[0] === "string" ? { ask: async () => value } : value;
  };
}

/** 全清快乐路径返回桩：planner 单模块零框架发现 + reviewer 零发现 + retire 零候选。
 *  「争议仲裁」在 setup 注册（contested 分流前实例化，全清路径不会被 ask）——桩须登记
 *  该实例名，注册即触发桩调用 */
const convergeStubMap = (s) => ({
  "框架对照规划": {
    frameworkFindings: [],
    modules: [{ id: "m1", module: "pkg/mod.ts", files: [s.codeFile], focus: "对照 §1" }],
  },
  "模块审查-m1": { matrixRows: [], findings: [], moduleNoFinding: "在 pkg/mod.ts 未发现" },
  "伴生产物判定": { candidates: [], kept: [{ path: s.designDoc, reason: "合规放置" }] },
  "争议仲裁": { verdict: "genuinely-open", quote: "", anchorRef: "", reasoning: "全清路径不触发" },
});

test("D5 zcode：全清 converged 路径——setup/review 自然 end（无 outcome），retire 保持打开由终态统一补记（outcome=converged）", async () => {
  const home = tmpHome();
  try {
    const s = makeSyncScaffold(home);
    const { result } = await runZcodeArtifact(
      home,
      { ...syncBaseArgs(s), ...obsArgs("t-d5", "e-conv", { sampleType: "selftest" }) },
      syncAgentStub(convergeStubMap(s)),
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "converged");
    assert.ok(result.message.includes("终态同步收敛"), result.message);
    const lines = readJsonl(home, "t-d5", "e-conv");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome, attempt: l.attempt })),
      [
        { event: "start", step: "execution", round: null, outcome: undefined, attempt: null },
        { event: "start", step: "setup", round: null, outcome: undefined, attempt: null },
        { event: "end", step: "setup", round: null, outcome: undefined, attempt: 1 },
        { event: "start", step: "review", round: 1, outcome: undefined, attempt: 1 },
        { event: "end", step: "review", round: 1, outcome: undefined, attempt: 1 },
        { event: "start", step: "retire", round: 1, outcome: undefined, attempt: 1 },
        { event: "end", step: "retire", round: 1, outcome: "converged", attempt: 1 },
        { event: "end", step: "execution", round: null, outcome: "converged", attempt: 1 },
      ],
    );
    lines.forEach((l) =>
      assertContract(l, { task_id: "t-d5", execution_id: "e-conv", skill: "dev-flow-v1", stage: "D5", sample_type: "selftest" }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("D5 zcode：setup-failure（必读模板缺失）早退补终态——4 行完整事件且 attempt 全 null（失败早于检测）", async () => {
  const home = tmpHome();
  try {
    const s = makeSyncScaffold(home);
    const { result } = await runZcodeArtifact(
      home,
      { ...syncBaseArgs(s), reviewerTemplate: join(home, "no-such-template.md"), ...obsArgs("t-d5", "e-sf") },
      undefined,
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "setup-failure");
    assert.ok(result.message.includes("必读文件缺失"), result.message);
    const lines = readJsonl(home, "t-d5", "e-sf");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome })),
      [
        { event: "start", step: "execution", outcome: undefined },
        { event: "start", step: "setup", outcome: undefined },
        { event: "end", step: "setup", outcome: "setup-failure" },
        { event: "end", step: "execution", outcome: "setup-failure" },
      ],
    );
    assert.ok(lines.every((l) => l.attempt === null), `attempt 应全 null：${JSON.stringify(lines.map((l) => l.attempt))}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("D5 zcode：planner 调用失败——setup 保持打开由终态补记（outcome=planner-failure，attempt 已回填）", async () => {
  const home = tmpHome();
  try {
    const s = makeSyncScaffold(home);
    const agent = (name) => {
      assert.ok(
        String(name).includes("框架对照规划") || String(name).includes("争议仲裁"),
        `未预期的 agent 实例：${name}`,
      );
      return { ask: async () => { throw new Error("planner ask 失败（测试桩）"); } };
    };
    const { result } = await runZcodeArtifact(
      home,
      { ...syncBaseArgs(s), ...obsArgs("t-d5", "e-pf") },
      agent,
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "planner-failure");
    const lines = readJsonl(home, "t-d5", "e-pf");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome, attempt: l.attempt })),
      [
        { event: "start", step: "execution", outcome: undefined, attempt: null },
        { event: "start", step: "setup", outcome: undefined, attempt: null },
        { event: "end", step: "setup", outcome: "planner-failure", attempt: 1 },
        { event: "end", step: "execution", outcome: "planner-failure", attempt: 1 },
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("D5 zcode：must-fix 修复轮（maxRounds=1）——fix 自然 end + 轮次耗尽 finalize 补记（outcome=stuck）", async () => {
  const home = tmpHome();
  try {
    const s = makeSyncScaffold(home);
    const agent = syncAgentStub({
      "框架对照规划": {
        frameworkFindings: [],
        modules: [{ id: "m1", module: "pkg/mod.ts", files: [s.codeFile], focus: "对照 §1" }],
      },
      "模块审查-m1": {
        matrixRows: [{ claim: "§1 值为 1", impl: "pkg/mod.ts:1", align: "match", note: "核对通过" }],
        findings: [{
          id: "F1",
          location: "pkg/mod.ts:1",
          gap: "导出常量与设计声明不符",
          direction: "doc-right",
          severity: "must-fix",
          impact: "误导交付判断",
          rationale: "文档更合理",
          fixHint: "补常量",
        }],
        moduleNoFinding: "",
      },
      "同步修复-R1-G1": {
        fixes: [{ issueId: "F1-1", description: "按 fix-hint 修复", selfCheck: { kind: "existence-check", command: "grep -c 导出常量 pkg/mod.ts || true", expected: "0", actual: "0" } }],
        affectedFiles: [],
        deferred: [],
        exempt: [],
        delegated: [],
      },
      // 顶层注册实例（contested 分流前，本用例 findings 为 doc-right 不触发 ask）
      "争议仲裁": { verdict: "genuinely-open", quote: "", anchorRef: "", reasoning: "不触发" },
    });
    const { result } = await runZcodeArtifact(
      home,
      { ...syncBaseArgs(s), maxRounds: 1, ...obsArgs("t-d5", "e-fix") },
      agent,
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "stuck");
    const lines = readJsonl(home, "t-d5", "e-fix");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
      [
        { event: "start", step: "execution", round: null, outcome: undefined },
        { event: "start", step: "setup", round: null, outcome: undefined },
        { event: "end", step: "setup", round: null, outcome: undefined },
        { event: "start", step: "review", round: 1, outcome: undefined },
        { event: "end", step: "review", round: 1, outcome: undefined },
        { event: "start", step: "fix", round: 1, outcome: undefined },
        { event: "end", step: "fix", round: 1, outcome: undefined },
        { event: "start", step: "finalize", round: null, outcome: undefined },
        { event: "end", step: "finalize", round: null, outcome: "stuck" },
        { event: "end", step: "execution", round: null, outcome: "stuck" },
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("D5 zcode：不传观测参数——业务照常 converged 且无观测文件无告警", async () => {
  const home = tmpHome();
  try {
    const s = makeSyncScaffold(home);
    const { result, logs } = await runZcodeArtifact(
      home,
      syncBaseArgs(s),
      syncAgentStub(convergeStubMap(s)),
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "converged");
    assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")), "不应创建观测根目录");
    assert.ok(!logs.some((l) => l.includes("WARN: 观测")), "合法关闭不告警");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("D5 pi：converged 事件序列与 zcode 对拍一致（除 timestamp）", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home; // pi 壳 world.run 走 spawnSync 继承进程 env
  try {
    const s = makeSyncScaffold(home);
    const { result } = await runPiArtifact(
      home,
      { ...syncBaseArgs(s), ...obsArgs("t-d5", "e-pi") },
      syncAgentStub(convergeStubMap(s)),
      "design-code-sync-loop",
      WF,
    );
    assert.equal(result.terminated, "converged");
    const zcHome = tmpHome();
    try {
      const zs = makeSyncScaffold(zcHome);
      await runZcodeArtifact(
        zcHome,
        { ...syncBaseArgs(zs), ...obsArgs("t-d5", "e-pi") },
        syncAgentStub(convergeStubMap(zs)),
        "design-code-sync-loop",
        WF,
      );
      const piLines = readJsonl(home, "t-d5", "e-pi").map(({ timestamp, ...rest }) => rest);
      const zcLines = readJsonl(zcHome, "t-d5", "e-pi").map(({ timestamp, ...rest }) => rest);
      assert.deepEqual(piLines, zcLines, "双平台事件（除 timestamp）应逐字段一致");
    } finally {
      rmSync(zcHome, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 9. conformance-plane 四层结论与迁移链路（sync-conformance-plane U5/M5；观测分层断言）──
//
// 覆盖（设计编号属本设计包 sync-conformance-plane，裸用）：
//   四层结论词表（段七/GA9）与跨模块同源；分层权威源与缺省映射（AX10 不可互相覆盖）
//   V12 人工接管四层并存：scriptStatus=completed / engineOutcome=stopped /
//        integrationOutcome=integrated / deliveryOutcome=resolved-by-main-agent
//   V10 报告五视图落盘 <designPkg>/v2/（段七寻址）、删除后重建逐字节等价、事件 seq 无空洞、
//        索引可丢弃（报告层零本地状态）
//   V2/V9 导入半区：F2-1 两记录不合并、四项结构校验（引文/绑定/类别/同地址冲突人工确认）、
//        幂等重放、round 目录派发史证据（SC11）、exempted.json 与 retirement/retireCleanup
//        不入导入源（SC13/SC14 显式裁决）
//   V9 cutover 链路：绑定补录前置→两变体扫描→改名归档+tombstone→旧入口拒启（真实
//        cutoverGuardBlock）→复活通道（Unarchived 解档 + 标记保留 + tombstone 不变）
//   skill-data-addressing.md 五项登记与代码常量一致（路径单一来源）
//
// 夹具全部落系统临时目录（mkdtempSync），不留仓库内产物。

const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");
const outcomesMod = await import(join(CP, "reports", "outcomes.mjs"));
const renderMod = await import(join(CP, "reports", "render.mjs"));
const legacyMod = await import(join(CP, "migration", "legacy-import.mjs"));
const cutoverMod = await import(join(CP, "migration", "cutover.mjs"));
const factsMod = await import(join(CP, "kernel", "facts.mjs"));
const evidenceMod = await import(join(CP, "kernel", "evidence.mjs"));
const stateRepoMod = await import(join(CP, "kernel", "state-repo.mjs"));
const stateFoldMod = await import(join(CP, "kernel", "state-fold.mjs"));
const integratorMod = await import(join(CP, "integration", "integrator.mjs"));

const M5_H1 = "1".repeat(64);
const M5_H2 = "2".repeat(64);
const M5_CHECKER = { checkerId: "sym", checkerVersion: "1.0.0" };
const M5_BINDINGS = [
  { bindingId: "GL2", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 },
  { bindingId: "PR1", repoId: "repo-docs", violationKind: "documentation-mismatch", bindingVersion: 1 },
];
const M5_REPOS = [{ repoId: "repo-main" }, { repoId: "repo-docs" }];
const M5_ARTIFACTS = { "src/a.mjs": M5_H1, "docs/b.md": M5_H2 };

/** 证据负载（AX4 五要素；输入名按绑定 repoId 映射到 M5_ARTIFACTS 现值） */
function m5EvidencePayload(binding, { result = "pass", changesetId } = {}) {
  return evidenceMod.computeEvidence({
    address: factsMod.deriveAddress(binding),
    binding,
    checkerId: M5_CHECKER.checkerId,
    checkerVersion: M5_CHECKER.checkerVersion,
    inputs: [{ name: binding.repoId === "repo-main" ? "src/a.mjs" : "docs/b.md", hash: binding.repoId === "repo-main" ? M5_H1 : M5_H2 }],
    result,
    changesetId,
  });
}

async function m5InitState(tmp, name) {
  const root = join(tmp, name);
  await stateRepoMod.initStateRepo(root, {
    bindings: M5_BINDINGS,
    repos: M5_REPOS,
    checkerRuns: [M5_CHECKER],
    changesets: [{ changesetId: "cs-1" }],
    artifacts: M5_ARTIFACTS,
  });
  return root;
}

/** 从旧引擎单源提取真实 cutoverGuardBlock + 探针常量（零转抄；形态同 cutover-guard.test.mjs） */
function m5LoadCutoverGuard() {
  const src = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "design-code-sync-loop.shared.ts"), "utf8");
  const probe = src.match(/^const NODE_CUTOVER_EXISTS =\s*(.+);$/m);
  const fn = src.match(/^async function cutoverGuardBlock\([\s\S]*?^\}$/m);
  assert.ok(probe && fn, "旧引擎单源中提取 cutoverGuardBlock 失败——探针与实现失配须同步");
  const js = transpile(`${probe[0]}\n${fn[0]}`);
  return async (home, address, docName) => {
    const sandbox = {
      world: {
        run: async (cmd, argv) => {
          const { execFileSync } = await import("node:child_process");
          const out = execFileSync(cmd, ["-e", argv[1], argv[2]], { encoding: "utf8" });
          return { exitCode: 0, stdout: out, stderr: "" };
        },
      },
    };
    const guard = vm.runInNewContext(`${js}\ncutoverGuardBlock`, sandbox, { timeout: 15000 });
    return guard(home, address, docName);
  };
}

test("四层结论词表与设计段七逐值一致；partial 非终态枚举；跨模块词表同源（GA9）", () => {
  // 词表逐值断言（§3 终态第七段）
  assert.deepEqual([...outcomesMod.SCRIPT_STATUSES], ["running", "completed", "failed"]);
  assert.deepEqual([...outcomesMod.ENGINE_OUTCOMES], ["completed", "awaiting-ruling", "stopped", "failed"]);
  assert.deepEqual(
    [...outcomesMod.INTEGRATION_OUTCOMES],
    ["not-required", "not-started", "verified-pending-integration", "integrated", "rolled-back", "failed"],
  );
  assert.deepEqual([...outcomesMod.DELIVERY_OUTCOMES], ["pending", "resolved", "resolved-by-main-agent", "blocked"]);
  // partial 只作事件中的瞬时逐仓状态，不是终态枚举（段七明文）——词表级固化
  assert.ok(!outcomesMod.INTEGRATION_OUTCOMES.includes("partial"));
  // 与 v2 引擎词表常量同源（单源提取比对，防两处词表漂移）
  const v2src = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "design-code-sync-v2.shared.ts"), "utf8");
  const m = v2src.match(/const ENGINE_OUTCOMES = \[([^\]]+)\] as const/);
  assert.ok(m, "v2 引擎单源未找到 ENGINE_OUTCOMES 常量");
  assert.deepEqual(
    m[1].split(",").map((s) => s.trim().replaceAll('"', "")),
    [...outcomesMod.ENGINE_OUTCOMES],
  );
  assert.ok(v2src.includes("tech-design/${addr.slug}/${pkgName}/conformance-state"), "v2 引擎状态仓缺省寻址应与登记一致");
  // 集成器终值词表 ⊆ 集成层词表（integration/integrator.mjs INTEGRATION_OUTCOMES）
  for (const v of integratorMod.INTEGRATION_OUTCOMES) {
    assert.ok(outcomesMod.INTEGRATION_OUTCOMES.includes(v), `集成器终值 ${v} 应在集成层词表内`);
  }
  // manual actor 同值（人工接管唯一合法身份）
  assert.equal(outcomesMod.MANUAL_ACTOR, integratorMod.MANUAL_ACTOR);
});

test("四层派生：分层权威源、缺省映射与集成事实派生（段七/GA9/AX10）", () => {
  // 引擎层权威：scriptStatus/engineOutcome 来自 engineReturn；非 completed → blocked（引擎 finalize 同映射）
  let d = outcomesMod.deriveOutcomes({
    facts: [],
    bindings: M5_BINDINGS,
    engineReturn: { scriptStatus: "completed", engineOutcome: "stopped", integrationOutcome: "not-required" },
  });
  assert.deepEqual(
    [d.scriptStatus, d.engineOutcome, d.integrationOutcome, d.deliveryOutcome],
    ["completed", "stopped", "not-required", "blocked"],
  );
  d = outcomesMod.deriveOutcomes({ facts: [], bindings: [], engineReturn: { scriptStatus: "completed", engineOutcome: "completed" } });
  assert.equal(d.deliveryOutcome, "pending", "引擎 completed → 交付缺省 pending（resolved 系列由主 agent 追加）");
  // engineReturn 缺省 → running + fold 降级派生（无地址无失败 → stopped 轮次语义）
  d = outcomesMod.deriveOutcomes({ facts: [], bindings: [] });
  assert.equal(d.scriptStatus, "running");
  assert.equal(d.engineOutcome, "stopped");
  assert.equal(d.layers.engineOutcome.source, "event-stream-fold");
  // 词表外取值拒绝（错误带权威源与恢复动作）
  assert.throws(() => outcomesMod.deriveOutcomes({ facts: [], engineReturn: { scriptStatus: "converged" } }), /词表/);
  assert.throws(() => outcomesMod.deriveOutcomes({ facts: [], engineReturn: { engineOutcome: "converged" } }), /词表/);
  // 集成失败事实 → failed（流派生）；rolled-back 事件流无专属事实 → 从引擎返回采纳
  const ts = "2026-11-10T00:00:00.000Z";
  const failFact = { type: "IntegrationPrecheckFailed", seq: 1, ts, actor: "integration-writer", repoId: "repo-main", command: "git apply --check", exitCode: 1, summary: "冲突", recovery: "重生成" };
  d = outcomesMod.deriveOutcomes({ facts: [failFact], bindings: M5_BINDINGS });
  assert.equal(d.integrationOutcome, "failed");
  assert.equal(d.engineOutcome, "failed", "fold 降级派生：最新集成失败 → failed");
  const successFact = { type: "IntegrationGateChecked", seq: 2, ts, actor: "integration-writer", repoId: "repo-main", command: "git update-ref", exitCode: 0, summary: "两阶段提交", recovery: "非失败记录，无需恢复", failure: false };
  d = outcomesMod.deriveOutcomes({ facts: [failFact, successFact], bindings: M5_BINDINGS, engineReturn: { scriptStatus: "completed", engineOutcome: "failed", integrationOutcome: "rolled-back" } });
  assert.equal(d.integrationOutcome, "integrated", "失败后的成功事实 → integrated（流内时序权威）");
  d = outcomesMod.deriveOutcomes({ facts: [], bindings: [], engineReturn: { scriptStatus: "completed", engineOutcome: "failed", integrationOutcome: "rolled-back" } });
  assert.equal(d.integrationOutcome, "rolled-back", "rolled-back 从引擎层在案事实采纳");
  // awaiting-ruling fold 降级派生（在案请求 → awaiting-ruling + blocked）
  const binding = M5_BINDINGS[0];
  d = outcomesMod.deriveOutcomes({
    facts: [{ type: "RulingRequested", seq: 1, ts, actor: "reconcile-engine", address: factsMod.deriveAddress(binding), question: "方向争议" }],
    bindings: [binding],
  });
  assert.equal(d.engineOutcome, "awaiting-ruling");
  assert.equal(d.deliveryOutcome, "blocked");
});

test("V12 人工接管四层并存：completed/stopped/integrated/resolved-by-main-agent 且引擎结论不被覆盖（AX10）", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-obs-m5-v12-"));
  try {
    const stateRoot = await m5InitState(tmp, "state");
    // 引擎轮次：义务证据 fail 在案 → open；引擎轮次耗尽 stopped（终态返回）
    await stateRepoMod.appendCommands(stateRoot, [
      { type: "RecordEvidence", actor: "checker-wrapper", payload: m5EvidencePayload(M5_BINDINGS[0], { result: "fail" }) },
    ]);
    const engineReturn = { scriptStatus: "completed", engineOutcome: "stopped", integrationOutcome: "not-required" };
    let derived = outcomesMod.deriveOutcomes({
      facts: stateRepoMod.readEvents(stateRoot), bindings: M5_BINDINGS, artifacts: M5_ARTIFACTS, checkerRuns: [M5_CHECKER], engineReturn,
    });
    assert.deepEqual(
      [derived.scriptStatus, derived.engineOutcome, derived.integrationOutcome, derived.deliveryOutcome],
      ["completed", "stopped", "not-required", "blocked"],
    );
    // 人工接管：main-agent 以 manual 模式经集成器记录人工集成事件（同一门径），随后交付宣告
    await stateRepoMod.appendCommands(stateRoot, [
      {
        type: "RecordIntegrationGate", actor: "main-agent",
        payload: { repoId: "repo-main", command: "git update-ref refs/heads/main <cs-1-commit>", exitCode: 0, summary: "人工接管集成 cs-1（manual 门径）", recovery: "非失败记录，无需恢复", failure: false },
      },
    ]);
    derived = outcomesMod.deriveOutcomes({
      facts: stateRepoMod.readEvents(stateRoot), bindings: M5_BINDINGS, artifacts: M5_ARTIFACTS, checkerRuns: [M5_CHECKER], engineReturn,
      delivery: { outcome: "resolved-by-main-agent", actor: "main-agent", changesetId: "cs-1", commitRefs: ["repo-main@abc1234"] },
    });
    // V12 通过标准：四层并存
    assert.equal(derived.scriptStatus, "completed");
    assert.equal(derived.engineOutcome, "stopped", "引擎结论不被后续集成事实覆盖（AX10 分层呈现）");
    assert.equal(derived.integrationOutcome, "integrated");
    assert.equal(derived.deliveryOutcome, "resolved-by-main-agent");
    // 人工 actor、变更集与提交引用可见
    assert.equal(derived.layers.manualIntegration.actor, "main-agent");
    assert.equal(derived.layers.manualIntegration.mode, "manual");
    assert.equal(derived.layers.deliveryDeclaration.changesetId, "cs-1");
    assert.deepEqual(derived.layers.deliveryDeclaration.commitRefs, ["repo-main@abc1234"]);
    // 凭空宣告拒绝：无流内接管事实时 resolved-by-main-agent 不可宣告（AX10 只能追加事件）
    assert.throws(
      () => outcomesMod.deriveOutcomes({ facts: [], bindings: [], delivery: { outcome: "resolved-by-main-agent", actor: "main-agent" } }),
      (e) => e.code === "delivery-takeover-fact-missing",
    );
    // 引擎未完成时 resolved 交付宣告拒绝（人工接管场景应走 resolved-by-main-agent）
    assert.throws(
      () => outcomesMod.deriveOutcomes({
        facts: stateRepoMod.readEvents(stateRoot), bindings: M5_BINDINGS, engineReturn,
        delivery: { outcome: "resolved", actor: "main-agent" },
      }),
      (e) => e.code === "delivery-resolved-requires-completed",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("报告五视图落盘 <designPkg>/v2/；删除后重建逐字节等价；事件 seq 无空洞；索引可丢弃（V10）", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-obs-m5-v10-"));
  try {
    const designPkg = join(tmp, "tech-design", "pkg-demo");
    mkdirSync(designPkg, { recursive: true });
    const stateRoot = await m5InitState(tmp, "v10-state");
    await stateRepoMod.appendCommands(stateRoot, [
      { type: "RecordEvidence", actor: "checker-wrapper", payload: m5EvidencePayload(M5_BINDINGS[0], { result: "pass", changesetId: "cs-1" }) },
    ]);
    const engineReturn = { scriptStatus: "completed", engineOutcome: "stopped", integrationOutcome: "verified-pending-integration" };
    const r = renderMod.renderReports({ designPkg, stateRoot, engineReturn });
    // 五视图全部落盘 tech-design 段 <name>/v2/（段七寻址；不与旧 D5 final 同址）
    assert.equal(r.root, join(designPkg, "v2"));
    for (const f of Object.values(renderMod.REPORT_VIEW_FILES)) {
      assert.ok(existsSync(join(r.root, f)), `视图文件缺失：${f}`);
    }
    // fold 派生：verified pass + changeset + 无集成审计 → verified-pending-integration；
    // 覆盖率完成域 = verified/waived（D6）：pending-integration 非终态，单列计数不折算进 verified
    assert.equal(r.outcomes.integrationOutcome, "verified-pending-integration");
    assert.equal(r.outcomes.coverage.verified, 0);
    assert.equal(r.outcomes.coverage.pendingIntegration, 1);
    assert.equal(r.outcomes.coverage.denominator, 2);
    // V10：报告全部删除 → 重渲染 → 逐字节等价（报告全派生，AX3）
    const before = {};
    for (const [k, f] of Object.entries(renderMod.REPORT_VIEW_FILES)) before[k] = readFileSync(join(r.root, f), "utf8");
    for (const f of Object.values(renderMod.REPORT_VIEW_FILES)) rmSync(join(r.root, f));
    const r2 = renderMod.renderReports({ designPkg, stateRoot, engineReturn });
    for (const [k, f] of Object.entries(renderMod.REPORT_VIEW_FILES)) {
      assert.equal(readFileSync(join(r2.root, f), "utf8"), before[k], `视图 ${k} 删除后重建应逐字节等价`);
    }
    // 索引可丢弃：write=false 探针与落盘内容一致（报告层零本地状态）
    const views = renderMod.buildReportViews({ designPkg, stateRoot, engineReturn });
    assert.equal(JSON.stringify(views.current, null, 2) + "\n", before.current);
    assert.ok(before.matrix.includes("| bindingId | repoId | violationKind |"));
    assert.ok(before.trajectory.includes("| seq | ts | 事件 | actor | 摘要 |"));
    assert.ok(before.ledger.includes("权威源"));
    // 事件序列无空洞：fold 硬校验（seq 期望值从当前 lastSeq+1 连续；写侧 seq 由仓库
    // appendCommands 在锁内统一分配——命令通道结构性无法产生空洞）
    assert.throws(
      () => stateFoldMod.fold({ bindings: M5_BINDINGS, facts: [{ type: "Unarchived", seq: 99, ts: "2026-11-10T00:00:00.000Z", actor: "main-agent", reason: "gap 注入" }] }),
      (e) => e.code === "fact-seq-gap",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("旧档导入：F2-1 两记录不合并、四项结构校验整批拒绝、幂等重放、派发史证据与排除字段（V2/V9 导入半区）", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-obs-m5-imp-"));
  try {
    // 旧档夹具（临时目录）：两个真实 F2-1 形态回归——同旧 id 两条不同差距记录
    const syncDir = join(tmp, "dev-flow", "proj-aaa1111", "thesis-contract.sync");
    const round1 = join(syncDir, "round-1");
    mkdirSync(round1, { recursive: true });
    writeFileSync(join(round1, "planner.json"), JSON.stringify({ role: "planner" }));
    writeFileSync(join(round1, "fixer.json"), JSON.stringify({ role: "fixer" }));
    writeFileSync(join(syncDir, "exempted.json"), JSON.stringify([{ id: "E1", word: "x", reason: "r" }]));
    const legacyFinalPath = join(syncDir, "final.json");
    writeFileSync(
      legacyFinalPath,
      JSON.stringify({
        records: [
          { id: "F2-1", gap: "组外登记表缺失 obligations 出口（模块 m2 的登记缺口）", severity: "must-fix" },
          { id: "F2-1", gap: "data_as_of 字段缺实现（模块 m3 的数据契约缺口）", severity: "must-fix" },
          { id: "F7", gap: "叙述性条目无实现锚点", severity: "info", retirement: { retired: ["old.md"] }, retireCleanup: { pending: true } },
        ],
        retirement: { retired: [] },
        retireCleanup: { targets: [] },
      }, null, 2),
    );

    const stateRoot = join(tmp, "pkg", "conformance-state");
    mkdirSync(dirname(stateRoot), { recursive: true });
    const bindings = [
      { bindingId: "OB-M2", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 },
      { bindingId: "OB-M3", repoId: "repo-main", violationKind: "contract-mismatch", bindingVersion: 1 },
    ];
    await stateRepoMod.initStateRepo(stateRoot, { bindings, repos: [{ repoId: "repo-main" }], checkerRuns: [], changesets: [], artifacts: {} });

    const map = {
      package: "thesis-contract",
      mappings: [
        { legacyId: "F2-1", recordQuote: "组外登记表缺失 obligations 出口", bindingId: "OB-M2", repoId: "repo-main", violationKind: "missing-implementation", reason: "m2 组外登记差距承接" },
        { legacyId: "F2-1", recordQuote: "data_as_of 字段缺实现", bindingId: "OB-M3", repoId: "repo-main", violationKind: "contract-mismatch", reason: "m3 data_as_of 差距承接" },
      ],
    };
    const r = await legacyMod.importLegacyFinal({ legacyFinalPath, mapRaw: JSON.stringify(map), bindings, stateRoot, actor: "main-agent" });
    // V2：F2-1 两记录分离为两个地址（不合并）；旧 id 只作 alias（永不参与新身份）
    assert.equal(r.imported, 2);
    assert.deepEqual(
      r.addresses.map((a) => `${a.bindingId}|${a.repoId}|${a.violationKind}`).sort(),
      ["OB-M2|repo-main|missing-implementation", "OB-M3|repo-main|contract-mismatch"],
    );
    assert.deepEqual(r.aliases.map((a) => a.alias), ["legacy:F2-1#1", "legacy:F2-1#2"]);
    // 导入证据只承载 AX4 证据语义：retirement/retireCleanup/gap 等原文不入事实字段
    for (const f of r.facts) {
      assert.ok(!("retirement" in f) && !("retireCleanup" in f) && !("gap" in f), `导入事实不得携带排除字段：${JSON.stringify(f)}`);
    }
    // 幂等重放：同输入重跑 → imported=0 skipped=2，事件流不变
    const r2 = await legacyMod.importLegacyFinal({ legacyFinalPath, mapRaw: JSON.stringify(map), bindings, stateRoot, actor: "main-agent" });
    assert.equal(r2.imported, 0);
    assert.equal(r2.skipped, 2);
    assert.equal(stateRepoMod.readEvents(stateRoot).length, 2);
    // 派发史证据（SC11）：round 目录 planner/fixer 产物清单只读收集
    assert.equal(r.roundEvidence.length, 1);
    assert.equal(r.roundEvidence[0].round, 1);
    assert.deepEqual(r.roundEvidence[0].artifacts, ["fixer.json", "planner.json"]);
    // exempted.json 不入导入源（SC13）：读取即拒绝
    assert.throws(() => legacyMod.readLegacyFinal(join(syncDir, "exempted.json")), (e) => e.code === "exempted-file-not-importable");
    // 无孤儿证据（V11 性质二在导入侧：legacy-import checker 已登记进状态仓）
    assert.deepEqual(stateRepoMod.checkOrphanEvidence(stateRoot), []);

    // 四项结构校验各自拒绝（整批不导入，错误带四项校验编号与恢复动作）
    const cases = [
      { name: "①引文未命中", map: { mappings: [{ ...map.mappings[0], recordQuote: "不存在的引文文本" }] }, match: /引文校验失败/ },
      { name: "②绑定不存在", map: { mappings: [{ ...map.mappings[0], bindingId: "NO-SUCH" }] }, match: /绑定存在性校验失败/ },
      { name: "③违例类别词表外", map: { mappings: [{ ...map.mappings[0], violationKind: "made-up-kind" }] }, match: /违例类别校验失败/ },
      { name: "③b与绑定声明不一致", map: { mappings: [{ ...map.mappings[0], violationKind: "contract-mismatch" }] }, match: /地址一致性校验失败/ },
      {
        name: "④同地址冲突未人工确认",
        map: { mappings: [map.mappings[0], { ...map.mappings[1], bindingId: "OB-M2", repoId: "repo-main", violationKind: "missing-implementation" }] },
        match: /同地址冲突/,
      },
    ];
    for (const c of cases) {
      await assert.rejects(
        legacyMod.importLegacyFinal({ legacyFinalPath, mapRaw: JSON.stringify(c.map), bindings, stateRoot }),
        (e) => e.code === "legacy-map-invalid" && c.match.test(e.message),
        `用例「${c.name}」应整批拒绝`,
      );
      assert.equal(stateRepoMod.readEvents(stateRoot).length, 2, `用例「${c.name}」不得部分导入`);
    }
    // ④人工确认通道：冲突组全部成员携带 confirm: true 后同地址映射可导入（显式裁决承接；
    // 校验是映射文件的属性——即便部分条目此前已导入，组内未确认成员仍拒绝）
    const confirmedMap = {
      mappings: [
        { ...map.mappings[0], confirm: true },
        { ...map.mappings[1], bindingId: "OB-M2", repoId: "repo-main", violationKind: "missing-implementation", reason: "确属同一差距的重复报告", confirm: true },
      ],
    };
    const r3 = await legacyMod.importLegacyFinal({ legacyFinalPath, mapRaw: JSON.stringify(confirmedMap), bindings, stateRoot });
    assert.equal(r3.imported, 1, "确认后仅新记录落同地址；已导入记录幂等跳过");
    const finalEvents = stateRepoMod.readEvents(stateRoot);
    assert.equal(finalEvents.length, 3);
    assert.equal(finalEvents[2].address.bindingId, "OB-M2");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cutover 链路：绑定补录前置→两变体扫描→归档+tombstone→旧入口拒启→复活通道（V9）", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-obs-m5-cut-"));
  try {
    const home = tmp;
    const slug = "proj-aaa1111";
    const name = "thesis-contract";
    const designPkg = join(home, ".agents", "skill-data", "tech-design", slug, name);
    mkdirSync(designPkg, { recursive: true });
    // 六章节 JSON（一条 conformance 绑定——迁移分支分母非空前置）
    writeFileSync(join(designPkg, "meta.json"), JSON.stringify({
      name, designType: "greenfield", typeRationale: "新包示意", priority: "P1", riskScore: 4, riskRationale: "示意",
      reviewNav: [{ decisionId: "D1", anchor: "§3", level: "A", title: "t", criteria: "c", impact: "i" }], relatedDocs: [],
    }));
    writeFileSync(join(designPkg, "s1-context.json"), JSON.stringify({
      background: "b",
      goals: [{ id: "GL1", statement: "s", conformance: { bindingId: "GL1", repoId: "repo-main", targetSelector: "src/a.mjs", violationKind: "missing-implementation", checkerId: "sym", severity: "must-fix", evidenceInputs: ["src/a.mjs"] } }],
      outOfScope: "o",
    }));
    // tech-design 段 final.json = T2 审查终态（cutover 禁触碰对象）——字节基线
    const t2FinalPath = join(designPkg, "final.json");
    writeFileSync(t2FinalPath, JSON.stringify({ stage: "T2", converged: true }));
    const t2Before = readFileSync(t2FinalPath);

    // dev-flow 段旧档：两变体 + 他包 decoy + 平铺产物 decoy（禁裸前缀的对照面）
    const devFlowRoot = join(home, ".agents", "skill-data", "dev-flow", slug);
    const syncPlain = join(devFlowRoot, `${name}.sync`);
    const syncRendered = join(devFlowRoot, `${name}.rendered.sync`);
    const syncOther = join(devFlowRoot, `${name}-other.sync`);
    mkdirSync(join(syncPlain, "round-1"), { recursive: true });
    mkdirSync(syncRendered, { recursive: true });
    mkdirSync(syncOther, { recursive: true });
    writeFileSync(join(syncPlain, "final.json"), JSON.stringify({
      records: [{ id: "F2-1", gap: "组外登记表缺失 obligations 出口" }],
      retirement: { retired: ["old.md"] }, retireCleanup: { pending: true },
    }));
    writeFileSync(join(syncRendered, "final.json"), JSON.stringify({ records: [{ id: "F3", gap: "rendered 形态的旧差距" }] }));
    writeFileSync(join(syncOther, "final.json"), JSON.stringify({ records: [{ id: "F9", gap: "他包旧档，禁触碰" }] }));
    writeFileSync(join(devFlowRoot, `${name}.ledger.md`), "# 平铺产物");
    writeFileSync(join(syncPlain, "round-1", "planner.json"), "{}");

    const stateRoot = join(designPkg, "conformance-state");
    const bindings = [{ bindingId: "GL1", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 }];
    await stateRepoMod.initStateRepo(stateRoot, { bindings, repos: [{ repoId: "repo-main" }], checkerRuns: [], changesets: [], artifacts: {} });

    // 分母为空的 migrate 分支拒绝（绑定补录前置检查；恢复动作指向补绑定或只读归档分支）
    const emptyPkg = join(tmp, "tech-design", "empty-pkg");
    mkdirSync(emptyPkg, { recursive: true });
    writeFileSync(join(emptyPkg, "meta.json"), JSON.stringify({ name: "empty-pkg", designType: "evolution", typeRationale: "r", priority: "P2", riskScore: 1, riskRationale: "r", reviewNav: [], relatedDocs: [] }));
    assert.throws(
      () => cutoverMod.cutoverPackage({ designPkg: emptyPkg, devFlowRoot, pkgName: "empty-pkg", stateRoot: join(emptyPkg, "conformance-state") }),
      (e) => e.code === "cutover-denominator-empty" && e.message.includes("readonly-archive"),
      "分母为空的 migrate 切换应被前置检查拒绝",
    );

    // 导入半区（切换前，V9 步序：先导入映射 → 再标记管辖）：retirement 字段不入导入源
    const map = { mappings: [{ legacyId: "F2-1", recordQuote: "组外登记表缺失 obligations 出口", bindingId: "GL1", repoId: "repo-main", violationKind: "missing-implementation", reason: "承接" }] };
    const imp = await legacyMod.importLegacyFinal({ legacyFinalPath: join(syncPlain, "final.json"), mapRaw: JSON.stringify(map), bindings, stateRoot });
    assert.equal(imp.imported, 1);
    assert.ok(!("retirement" in imp.facts[0]) && !("retireCleanup" in imp.facts[0]));
    assert.deepEqual(stateRepoMod.checkOrphanEvidence(stateRoot), [], "导入后无孤儿证据（legacy-import checker 登记在案）");

    // 切换（migrate 分支）
    const r = cutoverMod.cutoverPackage({ designPkg, devFlowRoot, pkgName: name, stateRoot, mode: "migrate" });
    // 标记写入 <name>/cutover.json（+ docName 变体键——拒启探针两发起形态都命中）
    assert.equal(r.markerPath, join(designPkg, "cutover.json"));
    assert.equal(cutoverMod.readCutoverMarker(designPkg).engine, "v2");
    assert.ok(existsSync(join(designPkg, "..", `${name}.rendered`, "cutover.json")), "docName 变体键应同写标记");
    assert.equal(r.precheck.denominator, 1, "migrate 分支前置检查要求分母非空");
    // 两变体全部改名归档 + tombstone 指针（deprecated + 权威地址 + 归档件地址）
    assert.deepEqual(r.archived.map((a) => a.variant).sort(), ["plain", "rendered"]);
    for (const dir of [syncPlain, syncRendered]) {
      assert.ok(existsSync(join(dir, "final.legacy.json")), `归档件缺失：${dir}`);
      const tomb = JSON.parse(readFileSync(join(dir, "final.json"), "utf8"));
      assert.equal(tomb.deprecated, true);
      assert.equal(tomb.authority.stateRoot, stateRoot);
      assert.equal(tomb.authority.reportRoot, join(designPkg, "v2"));
      assert.equal(tomb.archivedTo, join(dir, "final.legacy.json"));
    }
    // v2 报告落 <name>/v2/ 与旧档不同址（切换即渲染一次终态对照）
    renderMod.renderReports({ designPkg, stateRoot, engineReturn: { scriptStatus: "completed", engineOutcome: "stopped", integrationOutcome: "not-required" } });
    assert.ok(existsSync(join(designPkg, "v2", "final.json")));
    // 禁裸前缀：他包目录与平铺产物零触碰
    assert.ok(existsSync(join(syncOther, "final.json")) && !existsSync(join(syncOther, "final.legacy.json")), "他包目录禁触碰");
    assert.ok(existsSync(join(devFlowRoot, `${name}.ledger.md`)), "平铺产物禁触碰");
    // tech-design 段 T2 审查终态字节级不变（段七禁令）
    assert.ok(t2Before.equals(readFileSync(t2FinalPath)), "T2 审查终态不得被切换触碰");
    // 归档件保留 retirement/retireCleanup（随 final.legacy.json 归档、可人读找回——D8/SC14）
    const archivedDoc = JSON.parse(readFileSync(join(syncPlain, "final.legacy.json"), "utf8"));
    assert.deepEqual(archivedDoc.retirement, { retired: ["old.md"] });
    assert.deepEqual(archivedDoc.retireCleanup, { pending: true });
    // 重复切换拒绝（幂等保护；恢复动作指向复活通道）
    assert.throws(
      () => cutoverMod.cutoverPackage({ designPkg, devFlowRoot, pkgName: name, stateRoot }),
      (e) => e.code === "cutover-already-marked",
    );
    // 状态仓转入归档态：普通命令拒写（state-store-archived），恢复动作指向复活通道
    await assert.rejects(
      stateRepoMod.appendCommands(stateRoot, [{ type: "RecordEvidence", actor: "checker-wrapper", payload: m5EvidencePayload(bindings[0], { result: "fail" }) }]),
      (e) => e.code === "state-store-archived" && e.message.includes("复活通道"),
    );

    // 旧入口拒启：真实 cutoverGuardBlock 对该包 blocked（plain 与 rendered 两种发起形态都拒启；
    // 他包目录不命中——探针精确匹配）
    const guard = m5LoadCutoverGuard();
    for (const docName of [name, `${name}.rendered`]) {
      const blocked = await guard(home, { form: "single", slug }, docName);
      assert.equal(blocked.blocked, true, `docName=${docName} 应拒启`);
      assert.ok(blocked.message.includes("design-code-sync-v2"), "拒启 message 指向 v2");
    }
    const other = await guard(home, { form: "single", slug }, `${name}-other`);
    assert.equal(other.blocked, false, "他包不命中拒启");

    // 复活通道：Unarchived 解档 + 标记保留 + tombstone 不变 + 恢复追加
    const tombBefore = readFileSync(join(syncPlain, "final.json"));
    const rev = await cutoverMod.unarchivePackage({ stateRoot, designPkg, reason: "同包重开对账范围" });
    assert.equal(rev.unarchived, true);
    assert.equal(rev.markerRetained, true);
    assert.equal(rev.event.type, "Unarchived");
    assert.ok(existsSync(r.markerPath), "复活后 cutover 标记保留（旧引擎仍拒启，复活只走 v2）");
    assert.ok(existsSync(join(designPkg, "..", `${name}.rendered`, "cutover.json")), "变体键标记同样保留");
    assert.ok(tombBefore.equals(readFileSync(join(syncPlain, "final.json"))), "tombstone 指向不变");
    // 解档后状态仓恢复追加（旧事件流不断链——seq 续编）
    await stateRepoMod.appendCommands(stateRoot, [{ type: "RecordEvidence", actor: "checker-wrapper", payload: m5EvidencePayload(bindings[0], { result: "fail" }) }]);
    const rebuilt = stateRepoMod.rebuild(stateRoot);
    assert.equal(rebuilt.state.archived, false);
    assert.equal(rebuilt.state.unarchivedSeen, true);
    assert.deepEqual(rebuilt.facts.map((f) => f.seq), [1, 2, 3], "复活后事件 seq 连续续编");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("五项寻址登记与代码常量一致（skill-data-addressing.md §2 conformance-plane 附加寻址；路径单一来源）", () => {
  const doc = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "references", "skill-data-addressing.md"), "utf8");
  const start = doc.indexOf("conformance-plane v2 附加寻址");
  assert.ok(start > 0, "登记小节缺失");
  const section = doc.slice(start);
  // 五项登记在案：conformance-state 状态仓段 / sandbox 段 / cutover 标记 / v2 报告根 /
  // 旧 final 归档件与 tombstone 寻址 + 两变体枚举键
  for (const needle of [
    "`<name>/conformance-state/`",
    "`sandbox/`",
    "cutover.json",
    "`<name>/v2/`",
    "final.legacy.json",
    "tombstone",
    "`<name>.sync/final.json`",
    "`<name>.rendered.sync/final.json`",
    "禁止裸前缀 glob",
  ]) {
    assert.ok(section.includes(needle), `登记缺失：${needle}`);
  }
  // 常量与登记一致（路径单一来源；常量定义处注释指向登记行）
  assert.equal(cutoverMod.CUTOVER_MARKER_NAME, "cutover.json");
  assert.equal(cutoverMod.STATE_DIRNAME, "conformance-state");
  assert.equal(cutoverMod.LEGACY_ARCHIVE_NAME, "final.legacy.json");
  assert.equal(cutoverMod.TOMBSTONE_NAME, "final.json");
  assert.equal(renderMod.REPORT_DIRNAME, "v2");
  assert.deepEqual(cutoverMod.LEGACY_SYNC_VARIANTS.map((v) => v.variant), ["plain", "rendered"]);
  assert.equal(legacyMod.LEGACY_ARCHIVE_NAME, cutoverMod.LEGACY_ARCHIVE_NAME, "归档件名跨模块同值");
  for (const f of ["migration/cutover.mjs", "reports/render.mjs", "migration/legacy-import.mjs"]) {
    const src = readFileSync(join(CP, ...f.split("/")), "utf8");
    assert.ok(src.includes("skill-data-addressing.md"), `${f} 模块头/常量注释应指向登记行`);
  }
});

// ── 10. delivery-v1 三 workflow（DESIGN / BUILD / ASSURE）双平台真实产物 ──
//
// delivery-v1 技能与产物已归档（.archived/delivery-v1/、.archived/workflows-v1/），本节
// 以归档产物为载体测三段 workflow 的通用观测行为（产物字节未变，仅路径迁移；归档产物
// 不再由构建器重建）。产物或 SKILL.md 缺失时本节跳过并说明原因；跳过不是静默的，
// node --test 会在输出中逐条打印 skip 原因。
const DELIVERY_WFS = ["contract-design", "candidate-build", "independent-assurance"];
const DELIVERY_SKILL_VERSION =
  readFileSync(join(ROOT, ".archived/delivery-v1/SKILL.md"), "utf8").match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] ?? null;
const DELIVERY_PRODUCTS_READY = DELIVERY_SKILL_VERSION !== null && DELIVERY_WFS.every((n) => {
  for (const p of [join(WF_V1, `${n}.dwf.ts`), join(WF_V1, "pi", `${n}.js`)]) {
    if (!existsSync(p)) return false;
    if (!readFileSync(p, "utf8").includes(`const SKILL_VERSION = "${DELIVERY_SKILL_VERSION}";`)) return false;
  }
  return true;
});
const DELIVERY_SKIP_REASON =
  `delivery-v1 归档产物缺失或内嵌 SKILL_VERSION 与归档 SKILL.md frontmatter 不一致（当前 ${DELIVERY_SKILL_VERSION ?? "无版本"}）` +
  "——本节用例以归档产物为载体，产物受损时跳过";

/** 事件写入凭据桩（模拟 delivery-gate init 输出的角色私钥：builderKey 只进 candidate-build、assuranceKey 只进 independent-assurance） */
const DELIVERY_BUILDER_KEY = "-----BEGIN PRIVATE KEY-----\nStubBuilderKeyForTests\n-----END PRIVATE KEY-----\n";
const DELIVERY_ASSURANCE_KEY = "-----BEGIN PRIVATE KEY-----\nStubAssuranceKeyForTests\n-----END PRIVATE KEY-----\n";
/** 用户凭据桩（approve-contract / accept-risk 的 --user-key；绝不注入 workflow） */
const DELIVERY_USER_KEY = "-----BEGIN PRIVATE KEY-----\nStubUserKeyForTests\n-----END PRIVATE KEY-----\n";
/** 桩裁决器缺省 verdict：state/missing 形态对齐 delivery-gate buildVerdict 输出 */
const DELIVERY_BASE_VERDICT = {
  state: "implementing", taskId: "obs-task", revision: "rev1", contractVersion: 1,
  requirements: [], implementedIncrementIds: [], openFindings: [],
  missing: {
    contractApproval: false, incrementIds: [], evidence: [],
    assuranceCompleted: false, explorationCompleted: false, riskAcceptances: [],
  },
  nextAction: "stub", generatedBy: "delivery-gate", generatedAt: "2026-01-01T00:00:00.000Z",
};

/** 构造 delivery 最小环境：项目根 + 任务目录（契约/增量/事件）+ 假 skill（角色提示词
 *  + 桩裁决器：evaluate 按 verdicts 队列出参——多元素逐个弹出、剩最后一个时重复；
 *  append 强制 --key 私钥与事件 actor 角色匹配（跨角色私钥拒绝），并把事件落盘
 *  events.jsonl 供断言；approve-contract/accept-risk 强制 --user-key）。
 *  withSkill=false 时省略 skill 目录——setup 必读路径缺失即 setup-failure 场景 */
function makeDeliveryScaffold(home, { withSkill = true, verdicts = [], events = [], requirements, incrementItems } = {}) {
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const taskDir = join(home, "task");
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ schemaVersion: 1, taskId: "obs-task", projectRoot }));
  writeFileSync(join(taskDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  writeFileSync(join(taskDir, "contract.json"), JSON.stringify({
    schemaVersion: 1, contractVersion: 1, taskId: "obs-task", projectRoot,
    objective: "观测验证用目标",
    requirements: requirements ?? [{ id: "R1", kind: "goal", statement: "外部可观察行为", required: true, riskAcceptable: false, evidenceKinds: ["inspection"] }],
    nonGoals: [], riskLevel: "low", exploratoryReview: "not-required", reviewDimensions: [],
  }));
  writeFileSync(join(taskDir, "solution.md"), "# 解决方案\n");
  writeFileSync(join(taskDir, "increments.json"), JSON.stringify({
    schemaVersion: 1, contractVersion: 1,
    items: incrementItems ?? [{ id: "I1", title: "首个增量", requirementIds: ["R1"] }],
  }));
  if (withSkill) {
    const roles = join(home, ".agents/skills/delivery-v1/references/roles");
    const scripts = join(home, ".agents/skills/delivery-v1/scripts");
    mkdirSync(roles, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    for (const r of ["designer", "contract-reviewer", "builder", "coverage-reviewer", "explorer"]) {
      writeFileSync(join(roles, `${r}.md`), `# ${r} 桩角色\n`);
    }
    writeFileSync(join(scripts, "gate-verdicts.json"), JSON.stringify(verdicts.length > 0 ? verdicts : [DELIVERY_BASE_VERDICT]));
    // 桩 CLI 用 CJS 语法（require 形态）：测试提速通道以 vm 进程内执行 node 桩调用，
    // vm.Script 不认 ESM import 语句；被测产物只消费退出码与 stdout，语法形态不影响语义
    writeFileSync(join(scripts, "delivery-gate.mjs"), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const cmd = process.argv[2];",
      "const argv = process.argv.slice(3);",
      "const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };",
      "if (cmd === 'evaluate') {",
      "  const p = path.join(path.dirname(process.argv[1]), 'gate-verdicts.json');",
      "  const list = JSON.parse(fs.readFileSync(p, 'utf8'));",
      "  const verdict = list.length > 1 ? list.shift() : list[0];",
      "  fs.writeFileSync(p, JSON.stringify(list));",
      "  process.stdout.write(JSON.stringify(verdict));",
      "  process.exit(0);",
      "}",
      "if (cmd === 'validate-contract') process.exit(0);",
      "if (cmd === 'append') {",
      "  const key = opt('key');",
      "  if (typeof key !== 'string' || !key.includes('PRIVATE KEY')) {",
      "    process.stderr.write('append 需要有效 --key 私钥');",
      "    process.exit(2);",
      "  }",
      "  const event = JSON.parse(opt('event'));",
      "  const actorKeyMark = { builder: 'StubBuilderKeyForTests', assurance: 'StubAssuranceKeyForTests' };",
      "  const expectedMark = event.actor === 'user' ? 'StubUserKeyForTests' : actorKeyMark[event.actor];",
      "  if (expectedMark && !key.includes(expectedMark)) {",
      "    process.stderr.write('私钥角色与事件 actor 不匹配：' + event.actor);",
      "    process.exit(2);",
      "  }",
      "  fs.appendFileSync(path.join(opt('task-dir'), 'events.jsonl'), JSON.stringify(event) + '\\n');",
      "  process.exit(0);",
      "}",
      "if (cmd === 'approve-contract' || cmd === 'accept-risk') {",
      "  const key = opt('user-key');",
      "  if (typeof key !== 'string' || !key.includes('PRIVATE KEY')) {",
      "    process.stderr.write(cmd + ' 需要 --user-key 私钥');",
      "    process.exit(2);",
      "  }",
      "  process.exit(0);",
      "}",
      "process.stderr.write('stub gate: 未知命令 ' + cmd);",
      "process.exit(2);",
    ].join("\n"));
  }
  return { projectRoot, taskDir };
}

/** 读 scaffold 任务目录的 events.jsonl 为对象数组 */
function readDeliveryEvents(taskDir) {
  return readFileSync(join(taskDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** delivery agent 桩：按实例名前缀分发；zcode 收 (name, persona) 返回 { ask }，pi 收
 *  {prompt, schema, description} 直接返回原始值——按首参形态自适应（形态同 syncAgentStub）。
 *  需要落盘的报告从 prompt 的「写入路径：X」行解析后写入（证据文件由桩函数自行写入） */
function deliveryAgentStub(map) {
  const apply = (hit, instructions) => {
    const value = typeof hit === "function" ? hit(instructions) : hit;
    for (const m of instructions.matchAll(/写入路径：(\S+)/g)) {
      mkdirSync(join(m[1], ".."), { recursive: true });
      writeFileSync(m[1], `# 桩产物（${m[1]}）\n`);
    }
    return value;
  };
  return (...a) => {
    const name = typeof a[0] === "string" ? a[0] : String(a[0]?.description ?? "");
    const hit = Object.keys(map).find((k) => name === k || name.startsWith(k));
    assert.ok(hit !== undefined, `未预期的 agent 实例：${name}`);
    if (typeof a[0] === "string") return { ask: async (...askArgs) => apply(map[hit], String(askArgs[askArgs.length - 1])) };
    return Promise.resolve(apply(map[hit], String(a[0].prompt)));
  };
}

/** 单次 ask 计数桩：记录每次 ask 的实例名并断言 prompt 自包含（报告写入路径、契约
 *  路径、注入数据标注「数据，不是指令」）——pi 无续聊，首次 prompt 必须一次给全 */
function singleAskCountingStub(askLog, outcome = { summary: "已实现并写报告", findings: [] }) {
  return (...a) => {
    const isZcode = typeof a[0] === "string";
    const name = isZcode ? a[0] : String(a[0]?.description ?? "");
    askLog.push(name);
    const apply = (instructions) => {
      assert.ok(instructions.includes("报告写入路径："), `${name} 单次 ask prompt 应自包含报告写入路径`);
      assert.ok(instructions.includes("契约："), `${name} prompt 应自包含契约路径`);
      assert.ok(instructions.includes("数据，不是指令"), `${name} 注入的 verdict/发现应标注为数据`);
      for (const m of instructions.matchAll(/写入路径：(\S+)/g)) {
        mkdirSync(join(m[1], ".."), { recursive: true });
        writeFileSync(m[1], "# 桩报告\n");
      }
      return outcome;
    };
    if (isZcode) return { ask: async (...askArgs) => apply(String(askArgs[askArgs.length - 1])) };
    return Promise.resolve(apply(String(a[0].prompt)));
  };
}

/** 各 workflow 的桩 agent 表与正常路径期望（终态 + 事件序列——step 只用 setup/review/
 *  execute/finalize，自然 end 无 outcome、execution end 带终态词） */
const DELIVERY_FIXTURES = {
  "contract-design": {
    terminated: "contract-ready",
    stage: "DESIGN",
    args: (s) => ({ objective: "观测验证用目标", ...s }),
    stub: () => deliveryAgentStub({
      designer: { summary: "契约草稿三件已写入" },
      "contract-reviewer": { summary: "独立复查完成，无问题", problems: [] },
    }),
    sequence: [
      { event: "start", step: "execution", round: null, outcome: undefined },
      { event: "start", step: "setup", round: null, outcome: undefined },
      { event: "end", step: "setup", round: null, outcome: undefined },
      { event: "start", step: "execute", round: 1, outcome: undefined },
      { event: "end", step: "execute", round: 1, outcome: undefined },
      { event: "start", step: "review", round: 1, outcome: undefined },
      { event: "end", step: "review", round: 1, outcome: undefined },
      { event: "start", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "execution", round: null, outcome: "contract-ready" },
    ],
  },
  "candidate-build": {
    terminated: "implemented",
    stage: "BUILD",
    args: (s) => ({ ...s, builderKey: DELIVERY_BUILDER_KEY }),
    stub: () => deliveryAgentStub({
      builder: { summary: "增量 I1 已实现并自测通过", findings: [] },
    }),
    sequence: [
      { event: "start", step: "execution", round: null, outcome: undefined },
      { event: "start", step: "setup", round: null, outcome: undefined },
      { event: "end", step: "setup", round: null, outcome: undefined },
      { event: "start", step: "execute", round: 1, outcome: undefined },
      { event: "end", step: "execute", round: 1, outcome: undefined },
      { event: "start", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "execution", round: null, outcome: "implemented" },
    ],
  },
  "independent-assurance": {
    terminated: "assurance-completed",
    stage: "ASSURE",
    args: (s) => ({ ...s, assuranceKey: DELIVERY_ASSURANCE_KEY }),
    stub: (s) => deliveryAgentStub({
      "coverage-review": () => {
        const artifact = `${s.taskDir}/evidence/cov-R1-inspection.log`;
        writeFileSync(artifact, "原始检视记录（桩）\n");
        return {
          summary: "逐项核对完成",
          evidence: [{ requirementId: "R1", kind: "inspection", result: "verified", artifact }],
          findings: [],
          resolvedFindingIds: [],
        };
      },
    }),
    sequence: [
      { event: "start", step: "execution", round: null, outcome: undefined },
      { event: "start", step: "setup", round: null, outcome: undefined },
      { event: "end", step: "setup", round: null, outcome: undefined },
      { event: "start", step: "review", round: 1, outcome: undefined },
      { event: "end", step: "review", round: 1, outcome: undefined },
      { event: "start", step: "execute", round: 1, outcome: undefined },
      { event: "end", step: "execute", round: 1, outcome: undefined },
      { event: "start", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "finalize", round: null, outcome: undefined },
      { event: "end", step: "execution", round: null, outcome: "assurance-completed" },
    ],
  },
};

/** 三 workflow 通用 zcode 执行（脚手架 + 桩 agent + 观测参数） */
async function runDeliveryZcode(home, name, executionId, extraObs = {}) {
  const fixture = DELIVERY_FIXTURES[name];
  const s = makeDeliveryScaffold(home);
  return runZcodeArtifact(
    home,
    fixture.args({ projectRoot: s.projectRoot, taskDir: s.taskDir, ...obsArgs("t-dwf", executionId, extraObs) }),
    fixture.stub(s),
    name,
  );
}

test("delivery-v1 zcode：三 workflow setup-failure（skill 未装）4 行完整事件与 stage/skill 字段", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  for (const name of DELIVERY_WFS) {
    const home = tmpHome();
    try {
      const s = makeDeliveryScaffold(home, { withSkill: false });
      const { result } = await runZcodeArtifact(
        home,
        DELIVERY_FIXTURES[name].args({ projectRoot: s.projectRoot, taskDir: s.taskDir, ...obsArgs("t-dwf", "e-sf") }),
        undefined,
        name,
      );
      assert.equal(result.terminated, "setup-failure", `${name} 应在必读路径缺失时 setup-failure`);
      assert.ok(result.message.includes("恢复动作"), `${name} 失败消息应含恢复动作`);
      const lines = readJsonl(home, "t-dwf", "e-sf");
      assert.deepEqual(
        lines.map((l) => ({ event: l.event, step: l.step, outcome: l.outcome })),
        [
          { event: "start", step: "execution", outcome: undefined },
          { event: "start", step: "setup", outcome: undefined },
          { event: "end", step: "setup", outcome: "setup-failure" },
          { event: "end", step: "execution", outcome: "setup-failure" },
        ],
        `${name} setup-failure 事件序列`,
      );
      lines.forEach((l) => assertContract(l, { task_id: "t-dwf", execution_id: "e-sf", skill: "delivery-v1", stage: DELIVERY_FIXTURES[name].stage }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("delivery-v1 pi：setup-failure 双平台对拍一致（除 timestamp）", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home; // pi 壳 world.run 走 spawnSync 继承进程 env
  try {
    const piLinesByName = new Map();
    for (const name of DELIVERY_WFS) {
      const s = makeDeliveryScaffold(home, { withSkill: false });
      const { result } = await runPiArtifact(
        home,
        DELIVERY_FIXTURES[name].args({ projectRoot: s.projectRoot, taskDir: s.taskDir, ...obsArgs("t-dwf", "e-pi-sf") }),
        undefined,
        name,
      );
      assert.equal(result.terminated, "setup-failure", `${name} pi 应 setup-failure`);
      piLinesByName.set(name, readJsonl(home, "t-dwf", "e-pi-sf").map(({ timestamp, ...rest }) => rest));
    }
    const zcHome = tmpHome();
    try {
      for (const name of DELIVERY_WFS) {
        const s = makeDeliveryScaffold(zcHome, { withSkill: false });
        await runZcodeArtifact(
          zcHome,
          DELIVERY_FIXTURES[name].args({ projectRoot: s.projectRoot, taskDir: s.taskDir, ...obsArgs("t-dwf", "e-pi-sf") }),
          undefined,
          name,
        );
        const zcLines = readJsonl(zcHome, "t-dwf", "e-pi-sf").map(({ timestamp, ...rest }) => rest);
        assert.deepEqual(piLinesByName.get(name), zcLines, `${name} 双平台 setup-failure 事件应逐字段一致`);
      }
    } finally {
      rmSync(zcHome, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：正常路径事件序列逐行断言（contract-ready / implemented / assurance-completed）", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  for (const name of DELIVERY_WFS) {
    const fixture = DELIVERY_FIXTURES[name];
    const home = tmpHome();
    try {
      const { result, logs } = await runDeliveryZcode(home, name, "e-ok", { sampleType: "selftest" });
      assert.equal(result.terminated, fixture.terminated, `${name} 正常路径终态：${result.message}`);
      const lines = readJsonl(home, "t-dwf", "e-ok");
      assert.deepEqual(
        lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
        fixture.sequence,
        `${name} 正常路径事件序列`,
      );
      lines.forEach((l) =>
        assertContract(l, { task_id: "t-dwf", execution_id: "e-ok", skill: "delivery-v1", stage: fixture.stage, sample_type: "selftest" }),
      );
      assert.ok(lines.every((l) => l.attempt === null), "delivery workflow 不做 attempt 自动检测，应恒 null");
      assert.ok(!logs.some((l) => l.includes("WARN: 观测")), `不应有观测告警：${logs.join("|")}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("delivery-v1 zcode：不传观测参数业务照常、无观测文件无告警", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  for (const name of DELIVERY_WFS) {
    const fixture = DELIVERY_FIXTURES[name];
    const home = tmpHome();
    try {
      const s = makeDeliveryScaffold(home);
      const { result, logs } = await runZcodeArtifact(
        home,
        fixture.args({ projectRoot: s.projectRoot, taskDir: s.taskDir }),
        fixture.stub(s),
        name,
      );
      assert.equal(result.terminated, fixture.terminated, `${name} 无观测参数业务照常：${result.message}`);
      assert.ok(!existsSync(join(home, ".agents/skill-data/workflow-observability")), `${name} 不应创建观测根目录`);
      assert.ok(!logs.some((l) => l.includes("WARN: 观测")), `${name} 合法关闭不告警`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("delivery-v1 pi：正常路径双平台对拍一致（除 timestamp）", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const piLinesByName = new Map();
    for (const name of DELIVERY_WFS) {
      const fixture = DELIVERY_FIXTURES[name];
      const s = makeDeliveryScaffold(home);
      const { result } = await runPiArtifact(
        home,
        fixture.args({ projectRoot: s.projectRoot, taskDir: s.taskDir, ...obsArgs("t-dwf", "e-pi-ok") }),
        fixture.stub(s),
        name,
      );
      assert.equal(result.terminated, fixture.terminated, `${name} pi 正常路径终态：${result.message}`);
      piLinesByName.set(name, readJsonl(home, "t-dwf", "e-pi-ok").map(({ timestamp, ...rest }) => rest));
    }
    const zcHome = tmpHome();
    try {
      for (const name of DELIVERY_WFS) {
        const { result } = await runDeliveryZcode(zcHome, name, "e-pi-ok");
        assert.equal(result.terminated, DELIVERY_FIXTURES[name].terminated);
        const zcLines = readJsonl(zcHome, "t-dwf", "e-pi-ok").map(({ timestamp, ...rest }) => rest);
        assert.deepEqual(piLinesByName.get(name), zcLines, `${name} 双平台正常路径事件应逐字段一致`);
      }
    } finally {
      rmSync(zcHome, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：independent-assurance 探索分支——explorer 与 coverage 并行派发且维度全覆盖", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  try {
    const s = makeDeliveryScaffold(home);
    // 高风险契约：探索性审查 required + 两个维度
    const contractPath = join(s.taskDir, "contract.json");
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    contract.riskLevel = "high";
    contract.exploratoryReview = "required";
    contract.reviewDimensions = ["边界条件", "错误路径"];
    writeFileSync(contractPath, JSON.stringify(contract));
    const asked = [];
    const agent = (name) => {
      asked.push(name);
      return {
        ask: async (...a) => {
          const instructions = String(a[a.length - 1]);
          for (const m of instructions.matchAll(/写入路径：(\S+)/g)) writeFileSync(m[1], "# 桩报告\n");
          if (name.startsWith("coverage")) {
            const artifact = `${s.taskDir}/evidence/cov-R1-inspection.log`;
            writeFileSync(artifact, "原始检视记录（桩）\n");
            return {
              summary: "逐项核对完成",
              evidence: [{ requirementId: "R1", kind: "inspection", result: "verified", artifact }],
              findings: [],
              resolvedFindingIds: [],
            };
          }
          return { summary: "探索完成", dimensions: ["边界条件", "错误路径"], findings: [] };
        },
      };
    };
    const { result } = await runZcodeArtifact(
      home,
      { projectRoot: s.projectRoot, taskDir: s.taskDir, assuranceKey: DELIVERY_ASSURANCE_KEY, ...obsArgs("t-dwf", "e-exp") },
      agent,
      "independent-assurance",
    );
    assert.equal(result.terminated, "assurance-completed", `探索分支应走完保证流程：${result.message}`);
    assert.deepEqual(asked, ["coverage-review", "explorer-review"], "coverage 与 explorer 两席都应被派发（前缀互斥）");
    const lines = readJsonl(home, "t-dwf", "e-exp");
    assert.deepEqual(
      lines.map((l) => ({ event: l.event, step: l.step, round: l.round, outcome: l.outcome })),
      DELIVERY_FIXTURES["independent-assurance"].sequence,
      "探索分支事件序列应与基础路径同构（两位角色同一 review 轮内并行）",
    );
    const evidenceFiles = readdirSync(join(s.taskDir, "evidence"));
    for (const prefix of ["coverage-", "exploration-", "assurance-"]) {
      assert.ok(evidenceFiles.some((f) => f.startsWith(prefix)), `evidence/ 应含 ${prefix}* 报告：${evidenceFiles.join(", ")}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：前置状态门禁——draft/contract-approved/missing.incrementIds 拒绝且不派 agent", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const cases = [
    { name: "candidate-build", verdict: { ...DELIVERY_BASE_VERDICT, state: "draft" }, needle: "draft" },
    { name: "independent-assurance", verdict: { ...DELIVERY_BASE_VERDICT, state: "draft" }, needle: "draft" },
    { name: "independent-assurance", verdict: { ...DELIVERY_BASE_VERDICT, state: "contract-approved" }, needle: "contract-approved" },
    {
      name: "independent-assurance",
      verdict: { ...DELIVERY_BASE_VERDICT, missing: { ...DELIVERY_BASE_VERDICT.missing, incrementIds: ["I1"] } },
      needle: "missing.incrementIds",
    },
  ];
  for (const c of cases) {
    const home = tmpHome();
    try {
      const s = makeDeliveryScaffold(home, { verdicts: [c.verdict] });
      const workflowArgs = c.name === "candidate-build"
        ? { builderKey: DELIVERY_BUILDER_KEY }
        : { assuranceKey: DELIVERY_ASSURANCE_KEY };
      const { result } = await runZcodeArtifact(
        home,
        { projectRoot: s.projectRoot, taskDir: s.taskDir, ...workflowArgs },
        undefined,
        c.name,
      );
      assert.equal(result.terminated, "setup-failure", `${c.name}/${c.needle} 应被前置门禁拒绝：${result.message}`);
      assert.ok(result.message.includes(c.needle), `${c.name}/${c.needle} 消息应点名拒绝原因`);
      assert.ok(result.message.includes("恢复动作"), `${c.name}/${c.needle} 消息应含恢复动作`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("delivery-v1 双平台：candidate-build 每增量单次 builder ask 且 prompt 自包含", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home; // pi 壳 world.run 走 spawnSync 继承进程 env
  try {
    const piAsk = [];
    const s = makeDeliveryScaffold(home);
    const { result } = await runPiArtifact(
      home,
      { projectRoot: s.projectRoot, taskDir: s.taskDir, builderKey: DELIVERY_BUILDER_KEY },
      singleAskCountingStub(piAsk),
      "candidate-build",
    );
    assert.equal(result.terminated, "implemented", `pi 单次 ask 正常路径：${result.message}`);
    assert.deepEqual(piAsk, ["builder-I1"], "pi 每增量只 ask 一次（无续聊，不二次补报告）");
    assert.ok(
      readDeliveryEvents(s.taskDir).some((e) => e.type === "ImplementationRecorded" && e.incrementId === "I1"),
      "pi append 应带 --key 通过桩校验并落盘实现事件",
    );
    const zcHome = tmpHome();
    try {
      const zcAsk = [];
      const zcS = makeDeliveryScaffold(zcHome);
      const { result: zcResult, logs } = await runZcodeArtifact(
        zcHome,
        { projectRoot: zcS.projectRoot, taskDir: zcS.taskDir, builderKey: DELIVERY_BUILDER_KEY },
        singleAskCountingStub(zcAsk),
        "candidate-build",
      );
      assert.equal(zcResult.terminated, "implemented", `zcode 单次 ask 正常路径：${zcResult.message}`);
      assert.deepEqual(zcAsk, ["builder-I1"], "zcode 每增量只 ask 一次");
      const reportFile = readdirSync(join(zcS.taskDir, "evidence")).find((f) => f.startsWith("implementation-"));
      assert.ok(reportFile !== undefined, "实现报告应存在");
      assert.ok(
        readFileSync(join(zcS.taskDir, "evidence", reportFile), "utf8").includes("引擎测试摘要"),
        "引擎应把测试摘要追加进实现报告",
      );
    } finally {
      rmSync(zcHome, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：修复轮仅 rework 命中未决发现/失败证据的增量，旧实现事件保留", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const twoReqs = [
    { id: "R1", kind: "goal", statement: "行为一", required: true, riskAcceptable: false, evidenceKinds: ["inspection"] },
    { id: "R2", kind: "goal", statement: "行为二", required: true, riskAcceptable: false, evidenceKinds: ["inspection"] },
  ];
  const twoItems = [
    { id: "I1", title: "增量一", requirementIds: ["R1"] },
    { id: "I2", title: "增量二", requirementIds: ["R2"] },
  ];
  const implEvent = (incrementId, revision) => ({
    eventId: `ev-impl-${incrementId}-${revision}`, type: "ImplementationRecorded", actor: "builder",
    contractVersion: 1, revision, summary: `旧实现 ${incrementId}`, incrementId, artifact: "/dev/null",
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const scenarios = [
    {
      label: "未决发现命中 R1 → 只 rework I1",
      verdict: {
        ...DELIVERY_BASE_VERDICT, implementedIncrementIds: ["I1", "I2"],
        openFindings: [{ findingId: "F1", requirementIds: ["R1"], severity: "blocker", artifact: "/dev/null", riskAccepted: false }],
      },
      expected: ["I1"],
    },
    {
      label: "当前 failed 证据命中 R2 → 只 rework I2",
      verdict: {
        ...DELIVERY_BASE_VERDICT, implementedIncrementIds: ["I1", "I2"],
        requirements: [
          { id: "R1", required: true, riskAcceptable: false, status: "verified", evidence: [], riskAccepted: false },
          { id: "R2", required: true, riskAcceptable: false, status: "failed", evidence: [], riskAccepted: false },
        ],
      },
      expected: ["I2"],
    },
    {
      label: "无关联需求的 blocker 发现 → 全部增量 rework",
      verdict: {
        ...DELIVERY_BASE_VERDICT, implementedIncrementIds: ["I1", "I2"],
        openFindings: [{ findingId: "F9", requirementIds: [], severity: "blocker", artifact: "/dev/null", riskAccepted: false }],
      },
      expected: ["I1", "I2"],
    },
  ];
  for (const scenario of scenarios) {
    const home = tmpHome();
    try {
      const s = makeDeliveryScaffold(home, {
        verdicts: [scenario.verdict],
        events: [implEvent("I1", "rev0"), implEvent("I2", "rev0")],
        requirements: twoReqs,
        incrementItems: twoItems,
      });
      const asked = [];
      const { result, logs } = await runZcodeArtifact(
        home,
        { projectRoot: s.projectRoot, taskDir: s.taskDir, builderKey: DELIVERY_BUILDER_KEY },
        singleAskCountingStub(asked),
        "candidate-build",
      );
      assert.equal(result.terminated, "implemented", `${scenario.label}：${result.message}`);
      assert.deepEqual(asked, scenario.expected.map((id) => `builder-${id}`), scenario.label);
      const appended = readDeliveryEvents(s.taskDir);
      assert.equal(
        appended.filter((e) => e.type === "ImplementationRecorded" && e.revision === "rev0").length,
        2,
        `${scenario.label}：旧实现事件必须保留`,
      );
      assert.deepEqual(
        appended.filter((e) => e.type === "ImplementationRecorded" && e.revision === "rev1").map((e) => e.incrementId),
        scenario.expected,
        `${scenario.label}：仅命中增量追加新实现事件`,
      );
      if (!scenario.expected.includes("I2")) {
        assert.ok(logs.some((l) => l.includes("I2")), `${scenario.label}：跳过未命中增量应有日志说明`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("delivery-v1 zcode：testCommand 无法执行属基础设施失败——不登记 FindingRaised，build-failed 前 re-evaluate", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  try {
    const s = makeDeliveryScaffold(home, {
      incrementItems: [{ id: "I1", title: "首个增量", requirementIds: ["R1"], testCommand: { program: "no-such-bin-zzz", args: [] } }],
    });
    const asked = [];
    const { result } = await runZcodeArtifact(
      home,
      { projectRoot: s.projectRoot, taskDir: s.taskDir, builderKey: DELIVERY_BUILDER_KEY },
      singleAskCountingStub(asked),
      "candidate-build",
    );
    assert.equal(result.terminated, "build-failed", `应 build-failed：${result.message}`);
    assert.ok(result.message.includes("无法执行"), "失败消息应说明 testCommand 无法执行");
    assert.ok(result.verdict !== null && result.verdict.state === "implementing", "build-failed 返回的 verdict 应为重新 evaluate 的当前裁决");
    assert.ok(!readDeliveryEvents(s.taskDir).some((e) => e.type === "FindingRaised"), "基础设施失败不得登记 FindingRaised");
    assert.ok(readdirSync(join(s.taskDir, "evidence")).some((f) => f.startsWith("build-failure-")), "failure 产物应落盘");
    assert.deepEqual(asked, ["builder-I1"], "失败路径同样只有单次 ask");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：testCommand 退出非零登记关联增量需求的 blocker finding；builder 产品发现照常登记", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  try {
    // 产品测试失败（命令可执行、退出码 3）：登记关联该增量需求的 blocker finding
    const s = makeDeliveryScaffold(home, {
      incrementItems: [{ id: "I1", title: "首个增量", requirementIds: ["R1"], testCommand: { program: "node", args: ["-e", "process.exit(3)"] } }],
    });
    const { result } = await runZcodeArtifact(
      home,
      { projectRoot: s.projectRoot, taskDir: s.taskDir, builderKey: DELIVERY_BUILDER_KEY },
      singleAskCountingStub([]),
      "candidate-build",
    );
    assert.equal(result.terminated, "build-failed");
    const raised = readDeliveryEvents(s.taskDir).filter((e) => e.type === "FindingRaised");
    assert.equal(raised.length, 1, "测试失败登记一条 blocker finding");
    assert.equal(raised[0].severity, "blocker");
    assert.deepEqual(raised[0].requirementIds, ["R1"], "finding 应关联该增量声明的需求，供下轮修复轮精准 rework");
    assert.ok(result.verdict !== null, "build-failed 返回前重新 evaluate，verdict 非空");
    // 基础设施失败叠加 builder 产品申报：产品发现照常登记，基础设施错误本身不登记
    const home2 = tmpHome();
    try {
      const s2 = makeDeliveryScaffold(home2, {
        incrementItems: [{ id: "I1", title: "首个增量", requirementIds: ["R1"], testCommand: { program: "no-such-bin-zzz", args: [] } }],
      });
      const { result: r2 } = await runZcodeArtifact(
        home2,
        { projectRoot: s2.projectRoot, taskDir: s2.taskDir, builderKey: DELIVERY_BUILDER_KEY },
        singleAskCountingStub([], {
          summary: "已实现并写报告",
          findings: [{ summary: "产品缺陷：边界处理缺失", requirementIds: ["R1"], severity: "non-blocker" }],
        }),
        "candidate-build",
      );
      assert.equal(r2.terminated, "build-failed");
      const raised2 = readDeliveryEvents(s2.taskDir).filter((e) => e.type === "FindingRaised");
      assert.deepEqual(
        raised2.map((e) => e.summary),
        ["产品缺陷：边界处理缺失"],
        "builder 申报的产品发现照常登记；基础设施失败自身不登记 finding",
      );
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery-v1 zcode：independent-assurance revision 漂移显式 assurance-failed，本轮事件带 setup revision", { skip: DELIVERY_PRODUCTS_READY ? false : DELIVERY_SKIP_REASON }, async () => {
  const home = tmpHome();
  try {
    const s = makeDeliveryScaffold(home, {
      verdicts: [
        { ...DELIVERY_BASE_VERDICT, state: "candidate" },
        { ...DELIVERY_BASE_VERDICT, state: "candidate", revision: "rev2" },
      ],
    });
    const { result } = await runZcodeArtifact(
      home,
      { projectRoot: s.projectRoot, taskDir: s.taskDir, assuranceKey: DELIVERY_ASSURANCE_KEY },
      DELIVERY_FIXTURES["independent-assurance"].stub(s),
      "independent-assurance",
    );
    assert.equal(result.terminated, "assurance-failed", `revision 漂移应显式失败：${result.message}`);
    assert.ok(result.message.includes("rev1") && result.message.includes("rev2"), "消息应比对 setup 与 finalize revision");
    assert.ok(result.message.includes("失效"), "消息应说明本轮证据失效");
    assert.ok(result.verdict !== null && result.verdict.revision === "rev2", "漂移时 verdict 应为当前裁决（rev2）");
    const appended = readDeliveryEvents(s.taskDir);
    assert.ok(appended.length > 0 && appended.every((e) => e.revision === "rev1"), "本轮以 setup revision 追加的事件全部带 rev1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
