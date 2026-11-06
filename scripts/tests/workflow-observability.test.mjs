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
const ts = require("typescript");

const transpile = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

const tmpHome = () => mkdtempSync(join(tmpdir(), "wf-obs-test-"));

/** 构造 tech-review-loop 走到「必读文件探针失败」（setup-failure）或更远所需的最小环境 */
function makeSkillScaffold(home, withFakeSkill) {
  const designDoc = join(home, "design");
  const projectRoot = join(home, "proj");
  mkdirSync(designDoc, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  if (withFakeSkill) {
    const agents = join(home, ".agents/skills/tech-design-wf/agents");
    const refs = join(home, ".agents/skills/tech-design-wf/references");
    const review = join(home, ".agents/skills/tech-design-wf/review");
    const scripts = join(home, ".agents/skills/tech-design-wf/scripts");
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

/** zcode 产物执行器：transpile + vm，facade 全部由参数注入；world.run 真实 spawn（HOME 指向 home） */
async function runZcodeArtifact(home, argsValue, agentImpl, name = "tech-review-loop") {
  const raw = readFileSync(join(WF, `${name}.dwf.ts`), "utf8");
  const js = transpile(raw);
  const logs = [];
  const world = {
    run: async (cmd, a, opts) => {
      const r = spawnSync(cmd, a ?? [], {
        encoding: "utf8",
        cwd: home,
        env: { ...process.env, HOME: home },
        timeout: opts && opts.timeoutMs ? opts.timeoutMs : 30000,
      });
      return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
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

/** pi 产物执行器：vm + require/$ARGS/$WORKSPACE 注入（pi 宿主注入形态） */
async function runPiArtifact(home, argsValue, agentImpl, name = "tech-review-loop") {
  const raw = readFileSync(join(WF, "pi", `${name}.js`), "utf8");
  const logs = [];
  const context = {
    require,
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

test("zcode 产物：setup-failure 终态的观测事件序列与字段契约", async () => {
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
        task_id: "t-zc", execution_id: "e-sf", skill: "tech-design-wf", stage: "T2",
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
    const embedded = readFileSync(join(WF, "tech-review-loop.dwf.ts"), "utf8").match(/const SKILL_VERSION = "([^"]*)";/)?.[1] ?? null;
    assert.ok(embedded, "产物应内嵌 SKILL_VERSION 版本戳");
    lines.forEach((l) => assert.equal(l.skill_version, embedded, "事件 skill_version 应等于产物内嵌的引擎版本"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 产物：setup-failure 终态的观测事件序列与 zcode 对拍一致", async () => {
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

test("zcode 产物：setup 自然 end（无 outcome）+ review 由终态统一补记（outcome=review-failure）", async () => {
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

test("观测 ID 合法但业务参数缺失：execution 边界完整（参数失败早退不漏记）", async () => {
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

test("projectRoot 不存在：slug 探针失败早退仍有 4 行完整事件（真实 run dwfrun-e3741b98 漏记回归）", async () => {
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

test("不传观测参数：业务照常（setup-failure）且不产生观测文件", async () => {
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

test("只传 taskId：可操作告警且不落盘", async () => {
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

test("路径穿越形态 taskId（../evil）：拒绝落盘且观测根外无写入", async () => {
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

test("sampleType 非法：告警并关闭观测", async () => {
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

test("并发两次执行（不同 executionId）：各自 JSONL 完整互不串扰", async () => {
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

test("withStage/obsBegin/obsCloseExecution：正常 end、fn 抛异常补 script-error、阶段重叠披露 abandoned、终态统一补记", async () => {
  const home = tmpHome();
  try {
    // 直接消费单一构建输入全文（与产物同一份文本，非测试内复制）
    const layerSrc = readFileSync(join(WF, "src/observability.shared.ts"), "utf8");
    const shellSrc = readFileSync(join(WF, "src/tech-review-loop.zcode.tpl.ts"), "utf8");
    const hookStart = shellSrc.indexOf("// ── O 区观测平台钩子");
    const hookEnd = shellSrc.indexOf("@@STITCH@@");
    assert.ok(hookStart > 0 && hookEnd > hookStart, "壳 O 区锚点定位失败");
    const code = transpile(`${shellSrc.slice(hookStart, hookEnd)}\n${layerSrc}`);
    const logs = [];
    const world = {
      run: async (cmd, a) => {
        const r = spawnSync(cmd, a ?? [], { encoding: "utf8", env: { ...process.env, HOME: home } });
        return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    };
    const ctx = { args: { taskId: "t-ws", executionId: "e-ws" } };
    const fn = new vm.Script(
      `(async function __main__(args, world, log) {\n${code}\n
       // 观测层单独执行时无构建器注入——按拼接契约补 SKILL_VERSION 常量（业务源同位置）
       const SKILL_VERSION = "0.1.0-test";
       obsCtx = initObservation("tech-design-wf", "T2", null);
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

test("obsEnd 配对检查：错名/round 错位给实际打开阶段补 abandoned、重复 end 不伪造事件", async () => {
  const home = tmpHome();
  try {
    const layerSrc = readFileSync(join(WF, "src/observability.shared.ts"), "utf8");
    const shellSrc = readFileSync(join(WF, "src/tech-review-loop.zcode.tpl.ts"), "utf8");
    const hookStart = shellSrc.indexOf("// ── O 区观测平台钩子");
    const hookEnd = shellSrc.indexOf("@@STITCH@@");
    const code = transpile(`${shellSrc.slice(hookStart, hookEnd)}\n${layerSrc}`);
    const logs = [];
    const world = {
      run: async (cmd, a) => {
        const r = spawnSync(cmd, a ?? [], { encoding: "utf8", env: { ...process.env, HOME: home } });
        return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    };
    const ctx = { args: { taskId: "t-pair", executionId: "e-pair" } };
    const fn = new vm.Script(
      `(async function __main__(args, world, log) {\n${code}\n
       const SKILL_VERSION = "0.1.0-test";
       obsCtx = initObservation("tech-design-wf", "T2", null);
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

const runObserve = (home, args) =>
  spawnSync(process.execPath, [join(ROOT, "scripts/workflow-observe.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

test("workflow-observe.mjs：start/end 写同一 JSONL、契约字段与 workflow 内建一致", () => {
  const home = tmpHome();
  try {
    const base = ["--task-id", "t-cli", "--execution-id", "e-cli", "--skill", "dev-flow-wf", "--stage", "D0", "--step", "compile"];
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
    lines.forEach((l) => assertContract(l, { task_id: "t-cli", execution_id: "e-cli", skill: "dev-flow-wf", stage: "D0", sample_type: "selftest", attempt: 1, round: null }));
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
    const base = ["--task-id", "t-ver", "--execution-id", "e-ver", "--skill", "dev-flow-wf", "--stage", "D0", "--step", "compile"];
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
      `${readFileSync(file, "utf8")}{"execution_id":"e-ver","task_id":"t-ver","skill":"dev-flow-wf","stage":"D0","step":"compile","round":null,"attempt":null,"event":"end","timestamp":"2026-01-01T00:00:00.000Z","sample_type":"production"}\n`,
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
      "start", "--task-id", "t-accept", "--execution-id", "e-accept", "--skill", "dev-flow-wf",
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

// ── 7. 构建器 ──

test("构建器：全量 --check 不漏检（四个 workflow 全部接入观测且三平台产物一致）", () => {
  // 断言口径：全量 --check 必须覆盖全部四个 workflow（不悄悄漏检禁碰文件）且四份产物
  // 在三个落点（仓内双平台 + ~/.zcode/workflows saved 副本）全部一致
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `全量 --check 应全绿：\n${r.stdout}\n${r.stderr}`);
  for (const name of ["tech-review-loop", "wave-executor", "dev-consistency-loop", "design-code-sync-loop"]) {
    assert.ok(r.stdout.includes(name), `全量 --check 输出须覆盖 ${name}（不得漏检）`);
    assert.ok(r.stdout.includes(`${name}.dwf.ts（一致）`), `${name} 产物应一致：\n${r.stdout}\n${r.stderr}`);
  }
  assert.ok(!r.stdout.includes("未接入观测"), "四个 workflow 均已接入观测，不应再出现未接入分支");
  assert.ok(r.stdout.includes("stage=D5"), "design-code-sync-loop 应输出 D5 观测契约行");
});

test("构建器：--only 未知名报错 exit 2；--only 全部 workflow 构建绿", () => {
  let r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--only", "no-such"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("未知 workflow 名"), r.stderr);
  r = spawnSync(process.execPath, [join(ROOT, "scripts/build-workflows.mjs"), "--only", "tech-review-loop,wave-executor,dev-consistency-loop,design-code-sync-loop"], { encoding: "utf8" });
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
      assertContract(l, { task_id: "t-d5", execution_id: "e-conv", skill: "dev-flow-wf", stage: "D5", sample_type: "selftest" }),
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
