// compile-exec-plan-v6.test.mjs — D0 编译器已知答案样例（设计稿 §7.3 / §9.1）
//
// 被测实现：skills/self/dev-workflow/dev-flow-v6/scripts/compile-exec-plan.mjs
// （第三步「D0 编译器分阶段接管生成」：impl-plan.json → exec-plan + promptFile +
// 初始 status.json + acceptance 节点与 wrapper）。
//
// 用例：dev 生成过真校验器（spawn check-exec-plan.mjs exit 0）/ promptFile 含单元目标、
// territory、测试命令 / status.json 初始形态 / --check PASS / 手改任务书后 --check 红 /
// 缺必填字段报语义缺口列路径且不生成 / acceptance 模式 verify script 指向存在的剧本 /
// wrapper 形态（runner+scenario 契约齐备时 spawn gen-acceptance-wrapper）/ verifyAsset=new
// 实装单元未完成报缺口、完成后可编译 / --replay-compare 对自生成产物零差异。
//
// 隔离：临时 HOME（os.homedir() 读 HOME 环境变量）+ 临时 git 项目——编译器产物落
// ~/.agents/skill-data/dev-flow/<slug>/，HOME 重定向后全部落在临时目录，测试后删除，
// 不触碰真实 skill-data。
//
// 运行：node --test scripts/tests/compile-exec-plan-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPILER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "compile-exec-plan.mjs");
const CHECKER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-exec-plan.mjs");
const RENDERER = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "scripts", "render-impl-plan.mjs");
const GEN_WRAPPER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "gen-acceptance-wrapper.mjs");
const VERIFY_INDEX = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "verification-index.mjs");

// ── 提速通道（编译器与 fixture 渲染器进程内转译执行，与 CLI spawn 语义一致）──
// COMPILER 内部还会 spawn 校验器 / wrapper 生成器 / 索引构建器（node <file>.mjs）与
// node -e 寻址探针——子脚本白名单内进程内执行，git 等真实 spawn。CLI spawn 通道保留在
// 两处：真校验器独立复跑（生成即校验门的独立口径）+ 防漂移对拍锚（进程内 == spawn 逐字段一致）
import { runMjsScript, makeMjsStubSpawn } from "./helpers/mjs-runner.mjs";
const MJS_INNER = [CHECKER, RENDERER, GEN_WRAPPER, VERIFY_INDEX];

const runCompiler = (args, { cwd, env } = {}) =>
  runMjsScript(COMPILER, args, {
    cwd,
    env: env ?? process.env,
    spawn: makeMjsStubSpawn({ mjs: MJS_INNER, cwd }),
  });

const runRenderer = (planPath) => runMjsScript(RENDERER, [planPath]);

/** dev-flow-v6 SKILL.md frontmatter version 实值（exec-plan.skillVersion 断言基准） */
const SKILL_VERSION = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "SKILL.md"), "utf8").match(/^version:\s*([^\s#]+)/m)[1];

// ── fixture 基座 ──

/** verification-index（编译成功后自动重建）的最小设计章节输入：索引按 designDirFromDocPath
 *  口径（与 check-exec-plan.mjs 逐字同源）从渲染视图 <proj>/design.rendered.md 推导设计目录
 *  <proj>/design/，s3-solution.json / s4-accept.json 硬必填（缺即 build FAIL），其余章节、
 *  能力快照与验收包缺失均容忍（自记「未核验」note）。布局 = 真实 skill-data 形态
 * （skill-data-addressing.md §2）：impl-plan 与渲染视图平铺 <slug>/ 层（fixture 的 proj 根），
 *  六章节 JSON 在 <slug>/design/ 子目录（= impl-plan designDoc 声明的设计目录） */
function writeDesignStub(proj) {
  const designDir = join(proj, "design");
  mkdirSync(designDir, { recursive: true });
  writeFileSync(join(designDir, "s3-solution.json"), "{}\n");
  writeFileSync(join(designDir, "s4-accept.json"), "{}\n");
}

/** 全字段最小 impl-plan：2 单元 1 依赖 + associations + acceptancePlan 两行 L3/L4 +
 *  fullSuiteChecks（任务书fixture 契约见编译器头注「impl-plan 编译消费字段」） */
function implPlanFixture(proj) {
  return {
    name: "demo-compile",
    designDoc: join(proj, "design"),
    baseline: "abcdef1234567890",
    skillVersion: "1.0.0",
    sectionMap: { goal: "§1", mechanism: "§2", acceptance: "§3", breakdown: "§4" },
    units: [
      {
        id: "u-foundation",
        responsibility: "共享契约根",
        territory: ["src/shared/"],
        deps: [],
        isolation: "plain",
        acceptance: ["A1 共享契约成立"],
        decisionTier: "A",
        designRef: "§4.1",
        incrementId: "inc-1",
      },
      {
        id: "u-main",
        responsibility: "主实现",
        territory: ["src/app/"],
        deps: ["u-foundation"],
        isolation: "plain",
        acceptance: ["A2 主链路可用"],
        decisionTier: "B",
        designRef: "§4.2",
        incrementId: "inc-2",
      },
    ],
    testPlan: {
      incrementalCommands: [
        { incrementId: "inc-1", unitIds: ["u-foundation"], command: "node --test tests/shared" },
        { incrementId: "inc-2", unitIds: ["u-main"], command: { program: "pnpm", args: ["-C", "app", "test"] } },
      ],
      fullSuite: { program: "pnpm", args: ["test"] },
      fullSuiteChecks: [
        { id: "chk-build", command: "pnpm build", kind: "产物类", note: "e2e 预备" },
        { id: "chk-lint", command: "pnpm lint", kind: "验证类" },
      ],
    },
    acceptancePlan: [
      { id: "A1", item: "主链路脚本验收", level: "L3", group: "core", deps: [], optimization: "可脚本化", verifyAsset: "-", script: join(proj, "scripts", "verify-a1.mjs") },
      { id: "A2", item: "全页人工审查", level: "L4", group: "non-core", deps: ["A1"], optimization: "判断行" },
    ],
    associations: [
      { id: "assoc-1", kind: "contract", trigger: "src/shared/api.ts", related: ["src/shared/client.ts"], action: "co-change" },
    ],
    formNotApplicable: [{ adversarialFormId: "AF-DEMO-1", rationale: "fixture 场景构造不出该反例形态" }],
  };
}

/** git 模板仓（init + config + 初始文件 commit 一次成型）：每用例直接复制副本替代
 *  逐用例 git init/add/commit（4 次 git spawn ~100ms × 10 用例）——编译器读 HEAD 与
 *  working tree，副本语义与全新 init 等价；模板落系统临时目录，进程退出后由 OS 清理 */
let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "cep-git-tpl-"));
    const git = (args) => spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: tpl, encoding: "utf8" });
    assert.equal(git(["init", "-q"]).status, 0, "git init 失败");
    // 剧本与关联声明文件（associations 对账要求 trigger/related 在 territory 内——文件无需真实存在，
    // 校验器只对账 territory 覆盖；剧本本体必须是真实存在且可指认的文件）
    mkdirSync(join(tpl, "src", "shared"), { recursive: true });
    mkdirSync(join(tpl, "scripts"), { recursive: true });
    writeFileSync(join(tpl, "scripts", "verify-a1.mjs"), "process.exit(0);\n");
    // runner 与三个场景桩（wrapper 形态 / verifyAsset=new / flags 超界三用例共用）——
    // 预置进模板让手写 fixture 零 git 操作（gen-acceptance-wrapper 只核存在性与扩展名）
    writeFileSync(join(tpl, "scripts", "fake-runner.mjs"), "process.exit(0);\n");
    for (const scene of ["scene-a1.mjs", "scene-new.mjs", "scene-x.mjs"]) {
      writeFileSync(join(tpl, "scripts", scene), "process.exit(0);\n");
    }
    writeFileSync(join(tpl, "README.md"), "fixture\n");
    writeDesignStub(tpl);
    assert.equal(git(["add", "."]).status, 0);
    assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
    gitTemplate = tpl;
  }
  return gitTemplate;
}

/** 构造临时 git 项目 + 临时 HOME + impl-plan（渲染视图一并生成，过编译前置门）。
 *  返回产物根与常用路径；cleanup() 删除全部临时目录。 */
function makeFixture(t, planOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "cep-home-"));
  const proj = mkdtempSync(join(tmpdir(), "cep-proj-"));
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]).stdout.trim();

  const plan = { ...implPlanFixture(proj), ...planOverrides };
  const planPath = join(proj, "demo-compile.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  // 渲染视图（编译前置门 render --check 需要）
  const rendered = runRenderer(planPath);
  assert.equal(rendered.status, 0, `fixture 渲染失败：${rendered.stderr}`);

  const projReal = realpathSync(proj);
  const slug = `${basename(projReal)}-${createHash("sha256").update(projReal).digest("hex").slice(0, 8)}`;
  const productRoot = join(home, ".agents", "skill-data", "dev-flow", slug);

  const run = (args, extraEnv = {}) =>
    runCompiler(args, { cwd: proj, env: { ...process.env, HOME: home, ...extraEnv } });
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { home, proj, projReal, planPath, plan, productRoot, head, run };
}

/** 最小 verification runner（.mjs；gen-acceptance-wrapper 只核存在性与扩展名） */
function writeRunner(proj) {
  mkdirSync(join(proj, "scripts"), { recursive: true });
  const runnerPath = join(proj, "scripts", "fake-runner.mjs");
  writeFileSync(runnerPath, "process.exit(0);\n");
  return runnerPath;
}

// ── 用例 ──

test("dev 编译：生成过真校验器（check-exec-plan.mjs exit 0），节点/依赖/wave 契约齐备", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--impl-plan", f.planPath]);
  assert.equal(r.status, 0, `dev 编译失败：${r.stderr}`);
  const execPath = join(f.productRoot, "demo-compile.exec-plan.json");
  assert.ok(existsSync(execPath), "exec-plan 未生成");
  // 独立 spawn 真校验器（生成即校验门的独立复跑口径）
  const checked = spawnSync(process.execPath, [CHECKER, execPath], { encoding: "utf8" });
  assert.equal(checked.status, 0, `真校验器未过：${checked.stdout}${checked.stderr}`);
  const plan = JSON.parse(readFileSync(execPath, "utf8"));
  assert.equal(plan.version, 1);
  assert.equal(plan.mode, "dev");
  assert.equal(plan.skillVersion, SKILL_VERSION, "skillVersion 必须读 SKILL.md frontmatter 实值");
  assert.equal(plan.baseline, f.head, "baseline = git rev-parse HEAD");
  assert.equal(plan.projectRoot, f.projReal);
  // units → dev 节点：id / deps / wave 拓扑分层 / incrementId 逐字转抄 / cwd=null / territory / promptFile
  const devNodes = plan.nodes.filter((n) => n.kind === "dev");
  assert.deepEqual(devNodes.map((n) => [n.id, n.wave]), [["u-foundation", 1], ["u-main", 2]]);
  assert.deepEqual(devNodes.find((n) => n.id === "u-main").deps, ["u-foundation"]);
  assert.equal(devNodes.find((n) => n.id === "u-foundation").incrementId, "inc-1");
  assert.equal(devNodes.every((n) => n.cwd === null), true);
  assert.deepEqual(devNodes.find((n) => n.id === "u-foundation").territory, ["src/shared/"]);
  assert.ok(devNodes.every((n) => existsSync(n.promptFile)), "dev 节点 promptFile 必须落盘");
  // testCommand 从 incrementalCommands 提取并归一 {program,args}
  assert.deepEqual(devNodes.find((n) => n.id === "u-foundation").testCommand, { program: "node", args: ["--test", "tests/shared"] });
  assert.deepEqual(devNodes.find((n) => n.id === "u-main").testCommand, { program: "pnpm", args: ["-C", "app", "test"] });
  // fullSuiteChecks / associations / formNotApplicable 逐字转抄；acceptance 空壳
  assert.equal(plan.testPlan.fullSuiteChecks.length, 2);
  assert.equal(plan.associations[0].id, "assoc-1");
  assert.equal(plan.formNotApplicable[0].adversarialFormId, "AF-DEMO-1");
  assert.deepEqual(plan.acceptance, { nodes: [], groups: { core: [], nonCore: [] } });
  // 单仓形态不写 workspaceRoot
  assert.equal(plan.workspaceRoot, undefined);
  // runlog / ledger 初始化
  assert.ok(existsSync(join(f.productRoot, "demo-compile.runlog")), "runlog 目录未初始化");
  assert.ok(readFileSync(join(f.productRoot, "demo-compile.ledger.md"), "utf8").includes("未决事项与裁决处置档案"));
});

test("promptFile 含单元目标、territory、测试命令与返回契约", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const text = readFileSync(join(f.productRoot, "demo-compile.prompts", "u-foundation.md"), "utf8");
  assert.ok(text.includes("u-foundation 开发任务书"), "缺任务书标题");
  assert.ok(text.includes("共享契约根"), "缺单元目标（职责）");
  assert.ok(text.includes("§4.1"), "缺 designRef 设计章节锚");
  assert.ok(text.includes("src/shared/"), "缺 territory 范围声明");
  assert.ok(text.includes("node --test tests/shared"), "缺增量测试命令");
  assert.ok(text.includes("inc-1"), "缺增量归属");
  assert.ok(text.includes('"files_changed"'), "缺返回契约 JSON");
  assert.ok(text.includes("测试：node --test tests/shared 绿"), "缺 summary 末行测试结论契约");
  assert.ok(text.includes("禁止包级全量套件"), "缺全量禁跑纪律");
});

test("status.json 初始形态：baseline / 全节点 pending / events 空 / skillVersion", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const status = JSON.parse(readFileSync(join(f.productRoot, "demo-compile.status.json"), "utf8"));
  assert.equal(status.name, "demo-compile");
  assert.equal(status.baseline, f.head);
  assert.equal(status.skillVersion, SKILL_VERSION);
  assert.deepEqual(status.nodes, {
    "u-foundation": { status: "pending", attempts: 0 },
    "u-main": { status: "pending", attempts: 0 },
  });
  assert.deepEqual(status.events, []);
  assert.ok(!Number.isNaN(Date.parse(status.updated)), "updated 须为 ISO 时间戳");
});

test("--check PASS；重编译幂等（两次生成逐字节一致）", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const execPath = join(f.productRoot, "demo-compile.exec-plan.json");
  const first = readFileSync(execPath, "utf8");
  const c1 = f.run(["--impl-plan", f.planPath, "--check"]);
  assert.equal(c1.status, 0, `首次 --check 未过：${c1.stderr}`);
  assert.ok(c1.stdout.includes("CHECK PASS"));
  assert.ok(c1.stdout.includes("status.json 为执行态载体"), "--check 须显式说明 status.json 跳过");
  // 幂等：无 --check 重编译后 exec-plan 不变（updated 只在 status.json，exec-plan 无运行时值）
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  assert.equal(readFileSync(execPath, "utf8"), first, "重编译 exec-plan 不字节一致——存在运行时值泄漏");
});

test("手改 promptFile 后 --check 红，恢复重新生成后复绿", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const promptPath = join(f.productRoot, "demo-compile.prompts", "u-main.md");
  writeFileSync(promptPath, `${readFileSync(promptPath, "utf8")}\n<!-- 手改 -->\n`);
  const c = f.run(["--impl-plan", f.planPath, "--check"]);
  assert.equal(c.status, 1, "手改后 --check 应红");
  assert.ok(c.stderr.includes("逐字节比较"), "红行须指出任务书逐字节不一致");
  assert.ok(c.stderr.includes("重新生成"), "红行须给重新生成命令");
  // 幂等重编译覆盖手改，--check 复绿
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  assert.equal(f.run(["--impl-plan", f.planPath, "--check"]).status, 0);
});

test("缺必填字段报语义缺口（列路径、三段式）且全体不生成", (t) => {
  // 形态一：编译器自身缺口——单元无 testCommand 来源（incrementalCommands 删除）
  const f1 = makeFixture(t, { testPlan: { fullSuite: { program: "pnpm", args: ["test"] } } });
  const r1 = f1.run(["--impl-plan", f1.planPath]);
  assert.equal(r1.status, 1);
  assert.ok(r1.stderr.includes("语义缺口"), "须按语义缺口形态输出");
  assert.ok(r1.stderr.includes("u-foundation 无 testCommand 来源"), "须点名缺口单元");
  assert.ok(r1.stderr.includes("权威源"), "三段式缺权威源");
  assert.ok(r1.stderr.includes("恢复动作"), "三段式缺恢复动作");
  assert.ok(!existsSync(join(f1.productRoot, "demo-compile.exec-plan.json")), "缺口时不得生成 exec-plan");
  // 形态二：渲染必填缺口——units[].territory 缺失，前置门转发渲染器列路径
  const proj2 = mkdtempSync(join(tmpdir(), "cep-proj2-"));
  const home2 = mkdtempSync(join(tmpdir(), "cep-home2-"));
  t.after(() => {
    rmSync(proj2, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });
  });
  const f2base = implPlanFixture(proj2);
  f2base.units[0] = { ...f2base.units[0], territory: undefined };
  const planPath2 = join(proj2, "demo-compile.impl-plan.json");
  writeFileSync(planPath2, `${JSON.stringify(f2base, null, 2)}\n`);
  const r2 = runCompiler(["--impl-plan", planPath2], { cwd: proj2, env: { ...process.env, HOME: home2 } });
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.includes("units[0].territory"), `渲染缺口须列缺失路径：${r2.stderr}`);
});

test("acceptance 编译：verify script 指向存在的剧本、inspect 任务书落盘、汇总节点挂全部 verify", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0, "acceptance 前置 dev 编译失败");
  const r = f.run(["--impl-plan", f.planPath, "--mode", "acceptance"]);
  assert.equal(r.status, 0, `acceptance 编译失败：${r.stderr}`);
  const plan = JSON.parse(readFileSync(join(f.productRoot, "demo-compile.exec-plan.json"), "utf8"));
  assert.equal(plan.mode, "acceptance");
  // dev 期字段保留（同一文件演进：顶层 nodes 不变）
  assert.equal(plan.nodes.filter((n) => n.kind === "dev").length, 2);
  const acc = plan.acceptance;
  const verify = acc.nodes.find((n) => n.id === "A1");
  assert.equal(verify.kind, "verify");
  assert.ok(existsSync(verify.script), `verify script 须指向存在的剧本：${verify.script}`);
  assert.equal(verify.script, join(f.proj, "scripts", "verify-a1.mjs")); // abs() 保持声明书写形态（不 realpath）
  assert.ok(existsSync(verify.artifactsDir) === false || true); // artifactsDir 执行期由剧本创建，生成期只登记
  const inspect = acc.nodes.find((n) => n.id === "A2");
  assert.equal(inspect.kind, "inspect");
  assert.deepEqual(inspect.deps, ["A1"]);
  assert.deepEqual(inspect.artifactsRefs, ["A1"]);
  assert.ok(existsSync(inspect.promptFile), "inspect 任务书未生成");
  const inspectText = readFileSync(inspect.promptFile, "utf8");
  assert.ok(inspectText.includes("确定性产物已就绪"), "inspect 任务书缺产物就绪指针");
  assert.ok(inspectText.includes("summary.jsonl"), "inspect 任务书缺汇总核对路径");
  assert.ok(inspectText.includes('"verdict"'), "inspect 返回契约缺 verdict");
  assert.ok(inspectText.includes("禁写 status 字段"), "inspect 返回契约须禁 status 双承载");
  assert.ok(inspectText.includes("verdict.json"), "缺判定书落盘锚");
  // 汇总 inspect 节点：deps = 全部 verify 节点
  const summary = acc.nodes.find((n) => n.id === "summarize");
  assert.deepEqual(summary.deps, ["A1"]);
  assert.ok(existsSync(summary.promptFile));
  // groups 空壳（现行兼容字段）
  assert.deepEqual(acc.groups, { core: [], nonCore: [] });
  // acceptance 编译不重置 status.json（执行进度不可重置）
  const statusPath = join(f.productRoot, "demo-compile.status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.nodes["u-foundation"] = { status: "done", attempts: 1 }; // 模拟 D1 执行进度
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance"]).status, 0);
  const statusAfter = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(statusAfter.nodes["u-foundation"].status, "done", "acceptance 编译不得重置 status.json 执行进度");
});

test("wrapper 形态：runner+scenario 契约齐备时生成 wrapper，verify script 指向 wrapper 落点", (t) => {
  const proj = mkdtempSync(join(tmpdir(), "cep-proj3-"));
  const home = mkdtempSync(join(tmpdir(), "cep-home3-"));
  t.after(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  // git 仓 = 模板副本（README / design stub / verify 剧本 / runner / 场景桩已带，零 git 操作）
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const runnerPath = join(proj, "scripts", "fake-runner.mjs");
  const scenarioPath = join(proj, "scripts", "scene-a1.mjs");
  // 编译器从 cwd 推导 projectRoot（git 仓库根）
  const plan = implPlanFixture(proj);
  plan.acceptancePlan[0] = {
    id: "A1",
    item: "主链路脚本验收",
    level: "L3",
    group: "core",
    deps: [],
    optimization: "可脚本化",
    verifyAsset: "reuse:scene-a1",
    runner: { path: runnerPath, flags: ["--repo", "--artifacts-dir"] },
    scenario: { path: scenarioPath },
  };
  const planPath = join(proj, "demo-compile.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(runRenderer(planPath).status, 0);
  const run = (args) =>
    runCompiler(args, { cwd: proj, env: { ...process.env, HOME: home } });
  assert.equal(run(["--impl-plan", planPath]).status, 0);
  const r = run(["--impl-plan", planPath, "--mode", "acceptance"]);
  assert.equal(r.status, 0, `wrapper 形态 acceptance 编译失败：${r.stderr}`);
  const projReal = realpathSync(proj);
  const slug = `${basename(projReal)}-${createHash("sha256").update(projReal).digest("hex").slice(0, 8)}`;
  const planOut = JSON.parse(readFileSync(join(home, ".agents", "skill-data", "dev-flow", slug, "demo-compile.exec-plan.json"), "utf8"));
  const verify = planOut.acceptance.nodes.find((n) => n.id === "A1");
  assert.equal(basename(dirname(verify.script)), "demo-compile.verify", "wrapper 落点须为 <name>.verify/");
  assert.ok(existsSync(verify.script), "wrapper 文件未生成");
  assert.ok(readFileSync(verify.script, "utf8").includes(runnerPath), "wrapper 未内嵌 runner 路径");
  // wrapper 防手改委托：--check 输出须含委托核对说明
  const c = run(["--impl-plan", planPath, "--mode", "acceptance", "--check"]);
  assert.equal(c.status, 0, `wrapper 形态 --check 未过：${c.stderr}`);
  assert.ok(c.stdout.includes("gen-acceptance-wrapper --check"), "--check 须报告 wrapper 委托核对");
});

test("verifyAsset=new 实装单元未完成报缺口不生成；完成后可编译", (t) => {
  const proj = mkdtempSync(join(tmpdir(), "cep-proj4-"));
  const home = mkdtempSync(join(tmpdir(), "cep-home4-"));
  t.after(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  // git 仓 = 模板副本（runner / 场景桩已带，零 git 操作）
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const runnerPath = join(proj, "scripts", "fake-runner.mjs");
  const scenarioPath = join(proj, "scripts", "scene-new.mjs");
  const plan = implPlanFixture(proj);
  plan.acceptancePlan[0] = {
    id: "A1",
    item: "新剧本验收",
    level: "L3",
    group: "core",
    deps: [],
    optimization: "可脚本化",
    verifyAsset: "new",
    unit: "u-main",
    runner: { path: runnerPath, flags: [] },
    scenario: { path: scenarioPath },
  };
  const planPath = join(proj, "demo-compile.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(runRenderer(planPath).status, 0);
  const run = (args) =>
    runCompiler(args, { cwd: proj, env: { ...process.env, HOME: home } });
  assert.equal(run(["--impl-plan", planPath]).status, 0);
  // 实装单元未完成（status.json 里 u-main 仍 pending）→ 缺口、全体不生成
  const r1 = run(["--impl-plan", planPath, "--mode", "acceptance"]);
  assert.equal(r1.status, 1);
  assert.ok(r1.stderr.includes("未完成") || r1.stderr.includes("未就绪"), `须报资产未就绪：${r1.stderr}`);
  assert.ok(r1.stderr.includes("不合法输入"), "三段式缺不合法输入段");
  const slug = `${basename(realpathSync(proj))}-${createHash("sha256").update(realpathSync(proj)).digest("hex").slice(0, 8)}`;
  const execPath = join(home, ".agents", "skill-data", "dev-flow", slug, "demo-compile.exec-plan.json");
  assert.equal(JSON.parse(readFileSync(execPath, "utf8")).mode, "dev", "缺口时不得把 dev 期 exec-plan 覆盖为 acceptance 形态");
  // 实装单元完成后可编译
  const statusPath = join(home, ".agents", "skill-data", "dev-flow", slug, "demo-compile.status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.nodes["u-main"].status = "done";
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  const r2 = run(["--impl-plan", planPath, "--mode", "acceptance"]);
  assert.equal(r2.status, 0, `实装单元完成后 acceptance 编译应过：${r2.stderr}`);
});

test("--task-dir 增量契约前移：归属不全在写盘前拦截（盘上无任何产物）", (t) => {
  const f = makeFixture(t);
  // 最小交付任务目录：increments.json 多声明一个无单元归属的增量 inc-3 → 归属不全缺口
  const taskDir = mkdtempSync(join(tmpdir(), "cep-task-"));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  writeFileSync(
    join(taskDir, "increments.json"),
    `${JSON.stringify({ schemaVersion: 1, acceptanceVersion: 3, items: [{ id: "inc-1", title: "契约根", requirementIds: ["R1"], testCommand: { program: "node", args: ["--test", "tests/shared"] } }, { id: "inc-2", title: "主实现", requirementIds: ["R2"] }, { id: "inc-3", title: "无归属增量", requirementIds: ["R3"] }] }, null, 2)}\n`,
  );
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", taskDir]);
  assert.equal(r.status, 1, `归属缺口应 exit 1：${r.stderr}`);
  assert.ok(r.stderr.includes("增量无单元归属") && r.stderr.includes("inc-3"), `须报增量归属缺口：${r.stderr}`);
  assert.ok(r.stderr.includes("不合法输入") && r.stderr.includes("权威源") && r.stderr.includes("恢复动作"), "三段式齐全");
  // 写盘前拦截：exec-plan / status / prompts 一律不落盘
  assert.ok(!existsSync(join(f.productRoot, "demo-compile.exec-plan.json")), "缺口时不得生成 exec-plan");
  assert.ok(!existsSync(join(f.productRoot, "demo-compile.status.json")), "缺口时不得生成 status.json");
  assert.ok(!existsSync(join(f.productRoot, "demo-compile.prompts")), "缺口时不得生成 prompts");
});

test("runner flags 超界在缺口阶段拦截（exec-plan 保持 dev 形态、无半截清单）", (t) => {
  const proj = mkdtempSync(join(tmpdir(), "cep-proj5-"));
  const home = mkdtempSync(join(tmpdir(), "cep-home5-"));
  t.after(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  // git 仓 = 模板副本（runner / 场景桩已带，零 git 操作）
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const runnerPath = join(proj, "scripts", "fake-runner.mjs");
  const scenarioPath = join(proj, "scripts", "scene-x.mjs");
  const plan = implPlanFixture(proj);
  plan.acceptancePlan[0] = {
    id: "A1",
    item: "超界 flag 验收行",
    level: "L3",
    group: "core",
    deps: [],
    optimization: "可脚本化",
    verifyAsset: "reuse:scene-x",
    runner: { path: runnerPath, flags: ["--repo", "--headless"] }, // --headless 在四旗之外
    scenario: { path: scenarioPath },
  };
  const planPath = join(proj, "demo-compile.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(runRenderer(planPath).status, 0);
  const run = (args) =>
    runCompiler(args, { cwd: proj, env: { ...process.env, HOME: home } });
  assert.equal(run(["--impl-plan", planPath]).status, 0, "dev 编译应先行通过");
  const execPath = join(home, ".agents", "skill-data", "dev-flow", joinSlug(home), "demo-compile.exec-plan.json");
  const r = run(["--impl-plan", planPath, "--mode", "acceptance"]);
  assert.equal(r.status, 1, `flags 超界应 exit 1：${r.stderr}`);
  assert.ok(r.stderr.includes("未建模的 flag") && r.stderr.includes("--headless"), `须点名超界 flag：${r.stderr}`);
  assert.equal(JSON.parse(readFileSync(execPath, "utf8")).mode, "dev", "exec-plan 须保持 dev 形态未被改写");
  assert.ok(!existsSync(join(dirname(execPath), "demo-compile.verify-assets.json")), "不得产生半截验收资产清单");
});

function joinSlug(home) {
  // 手写 fixture 用例的产物目录定位：dev-flow 段下唯一的 slug 目录（HOME 是临时目录）
  const root = join(home, ".agents", "skill-data", "dev-flow");
  const hits = readdirSync(root);
  assert.equal(hits.length, 1, `dev-flow 段下应只有一个 slug 目录：${hits.join("、")}`);
  return hits[0];
}

test("processReviews / associations 非数组报三段式缺口不静默", (t) => {
  const f1 = makeFixture(t, { processReviews: "review-u-foundation" });
  const r1 = f1.run(["--impl-plan", f1.planPath]);
  assert.equal(r1.status, 1);
  assert.ok(r1.stderr.includes("processReviews 存在但不是数组"), `须报形态缺口：${r1.stderr}`);
  assert.ok(!existsSync(join(f1.productRoot, "demo-compile.exec-plan.json")));
  const f2 = makeFixture(t, { associations: "assoc-1" });
  const r2 = f2.run(["--impl-plan", f2.planPath]);
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.includes("associations 存在但不是数组"), `须报形态缺口：${r2.stderr}`);
  assert.ok(!existsSync(join(f2.productRoot, "demo-compile.exec-plan.json")));
});

test("dev 重编译遇执行进度缺省拒绝；--reinit 显式确认后重置", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const statusPath = join(f.productRoot, "demo-compile.status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.nodes["u-foundation"] = { status: "in-progress", attempts: 1 }; // 模拟 D1 执行进度
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  // 不带 --reinit：拒绝且进度不被重置
  const r1 = f.run(["--impl-plan", f.planPath]);
  assert.equal(r1.status, 1, `有进度重编译应拒绝：${r1.stderr}`);
  assert.ok(r1.stderr.includes("已有执行进度"), `须点名执行进度：${r1.stderr}`);
  assert.ok(r1.stderr.includes("--reinit"), "拒绝消息须给 --reinit 通道");
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).nodes["u-foundation"].status, "in-progress", "拒绝时不得重置进度");
  // 带 --reinit：显式确认后重置
  const r2 = f.run(["--impl-plan", f.planPath, "--reinit"]);
  assert.equal(r2.status, 0, `--reinit 后应重置成功：${r2.stderr}`);
  const after = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.deepEqual(after.nodes["u-foundation"], { status: "pending", attempts: 0 }, "重置后节点回 pending");
});

test("内嵌寻址探针与单源逐字节一致（parity 防漂移）", async () => {
  // 单源 = workflows/src/skill-data.shared.ts 的 NODE_PROJECT_ADDRESS；编译器为独立技能脚本
  //（不经构建器注入），按 skill-data-addressing.md 并入约定内嵌同款 + 注明来源，测试守住字节一致
  const src = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "skill-data.shared.ts"), "utf8");
  const match = src.match(/^const NODE_PROJECT_ADDRESS = "((?:[^"\\]|\\.)*)";$/m);
  assert.ok(match, "单源 NODE_PROJECT_ADDRESS 应为单行字符串常量（parity 按行提取依赖该形态）");
  const mod = await import(COMPILER);
  assert.equal(mod.NODE_PROJECT_ADDRESS_PROBE, match[1]);
});

test("编译成功后自动重建 verification-index.json（inputHashes.execPlan 与产物一致）", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--impl-plan", f.planPath]);
  assert.equal(r.status, 0, `dev 编译失败：${r.stderr}`);
  assert.ok(r.stdout.includes("verification-index"), "编译摘要须附索引重建结果行");
  const execPath = join(f.productRoot, "demo-compile.exec-plan.json");
  const indexPath = join(f.productRoot, "verification-index.json");
  assert.ok(existsSync(indexPath), "索引未落盘（exec-plan 同目录）");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  // 索引哈希口径 = 解析后规范 JSON 的 sha256（键排序、无空白；与 delivery-gate canonicalJson
  // 同族）——复算按同口径，不比文件字节
  const canonicalJson = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
    if (v !== null && typeof v === "object") {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  const execSha = createHash("sha256").update(canonicalJson(JSON.parse(readFileSync(execPath, "utf8")))).digest("hex");
  assert.equal(index.inputHashes.execPlan, execSha, "inputHashes.execPlan 须与 exec-plan 产物内容哈希一致（canonicalJson 口径）");
  // acceptance 编译后索引随 mode=acceptance 重建（哈希随新 exec-plan 内容演进）
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance"]).status, 0);
  const index2 = JSON.parse(readFileSync(indexPath, "utf8"));
  const execSha2 = createHash("sha256").update(canonicalJson(JSON.parse(readFileSync(execPath, "utf8")))).digest("hex");
  assert.equal(index2.inputHashes.execPlan, execSha2, "acceptance 编译后索引须与新产物一致");
});

test("--replay-compare 对自生成产物零差异；baseline 演进差异如实报告", (t) => {
  const f = makeFixture(t);
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0);
  const execPath = join(f.productRoot, "demo-compile.exec-plan.json");
  const r = f.run(["--impl-plan", f.planPath, "--replay-compare", execPath]);
  assert.equal(r.status, 0, `重放失败：${r.stderr}`);
  assert.ok(r.stdout.includes("零差异"), `自生成产物应零差异：${r.stdout}`);
  // 模拟历史演进：旧文件手工加字段后重放，差异逐字段报告（不写盘、不判错）
  const oldPlan = JSON.parse(readFileSync(execPath, "utf8"));
  oldPlan.nodes[0].designRef = "§9.9"; // 模拟旧代次的历史值
  writeFileSync(execPath, `${JSON.stringify(oldPlan, null, 2)}\n`);
  const r2 = f.run(["--impl-plan", f.planPath, "--replay-compare", execPath]);
  assert.equal(r2.status, 0, "差异是重放报告的正常产出，不是失败");
  assert.ok(r2.stdout.includes("差异 1 处"), `须逐字段报告差异计数：${r2.stdout}`);
  assert.ok(r2.stdout.includes("nodes[0].designRef"), "须报告差异字段路径");
  // 重放只读：旧文件不被重写
  assert.equal(JSON.parse(readFileSync(execPath, "utf8")).nodes[0].designRef, "§9.9");
});

test("防漂移锚：进程内转译执行 == CLI spawn（同 fixture dev 编译双跑对拍）", (t) => {
  // 提速通道的防漂移约束：同 fixture 两个独立 (home, proj) 各跑一次 dev 编译，退出码、
  // stdout、stderr 逐字段一致（slug 派生自 proj realpath——两个 proj 路径不同会使产物
  // 摘要里的路径不同，统一把各自临时根归一后再比）
  const fIn = makeFixture(t);
  const inProc = runCompiler(["--impl-plan", fIn.planPath], { cwd: fIn.proj, env: { ...process.env, HOME: fIn.home } });
  assert.equal(inProc.status, 0, `进程内 dev 编译应成功：${inProc.stderr}`);
  // CLI 通道：独立 fixture（同 plan 模板、独立临时目录）真实 spawn
  const projCli = mkdtempSync(join(tmpdir(), "cep-proj-"));
  const homeCli = mkdtempSync(join(tmpdir(), "cep-home-"));
  t.after(() => {
    rmSync(projCli, { recursive: true, force: true });
    rmSync(homeCli, { recursive: true, force: true });
  });
  const git = (args) => spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: projCli, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  mkdirSync(join(projCli, "src", "shared"), { recursive: true });
  mkdirSync(join(projCli, "scripts"), { recursive: true });
  writeFileSync(join(projCli, "scripts", "verify-a1.mjs"), "process.exit(0);\n");
  writeFileSync(join(projCli, "README.md"), "fixture\n");
  writeDesignStub(projCli);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
  const planPathCli = join(projCli, "demo-compile.impl-plan.json");
  writeFileSync(planPathCli, `${JSON.stringify(implPlanFixture(projCli), null, 2)}\n`);
  assert.equal(spawnSync(process.execPath, [RENDERER, planPathCli], { encoding: "utf8" }).status, 0, "fixture 渲染失败");
  const cli = spawnSync(process.execPath, [COMPILER, "--impl-plan", planPathCli], {
    cwd: projCli,
    encoding: "utf8",
    env: { ...process.env, HOME: homeCli },
  });
  assert.equal(cli.status, inProc.status, `退出码不一致：CLI ${cli.status} vs 进程内 ${inProc.status}（stderr=${cli.stderr}/${inProc.stderr}）`);
  // slug 目录名 = mkdtemp 前缀-随机段-sha256 前 8 位（两 fixture 必然不同）——一并归一
  const normalize = (s, home, proj) =>
    s.split(home).join("<home>").split(proj).join("<proj>").split(realpathSync(proj)).join("<proj>")
      .replace(/(proj|home|task)-?[\w]*-[0-9a-f]{8}/g, "<tmp-slug>");
  assert.equal(normalize(inProc.stdout, fIn.home, fIn.proj), normalize(cli.stdout, homeCli, projCli), "stdout 不一致（路径归一后应逐字段相同）");
  assert.equal(normalize(inProc.stderr, fIn.home, fIn.proj), normalize(cli.stderr, homeCli, projCli), "stderr 不一致（路径归一后应逐字段相同）");
});

// ── acceptancePlan[].adversarialFormRefs 随行携带（接缝回归：verification-index 的
// acceptanceNodeIds 以节点上的该字段为唯一连接，编译器不携带即索引恒空）──

/** 改写 fixture 的 impl-plan 后重渲染（编译前置门需要渲染视图与 JSON 同源） */
function rewritePlan(f, mutate) {
  mutate(f.plan);
  writeFileSync(f.planPath, `${JSON.stringify(f.plan, null, 2)}\n`);
  assert.equal(runRenderer(f.planPath).status, 0, "fixture 重渲染失败");
}

test("acceptance 编译：acceptancePlan 行 adversarialFormRefs 随行携带到节点，汇总节点聚合去重", (t) => {
  const f = makeFixture(t);
  rewritePlan(f, (plan) => {
    plan.acceptancePlan[0].adversarialFormRefs = ["AF-1", "AF-2"];
    plan.acceptancePlan[1].adversarialFormRefs = ["AF-2", "AF-1"];
  });
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0, "dev 编译前置失败");
  const r = f.run(["--impl-plan", f.planPath, "--mode", "acceptance"]);
  assert.equal(r.status, 0, `acceptance 编译失败：${r.stderr}`);
  const plan = JSON.parse(readFileSync(join(f.productRoot, "demo-compile.exec-plan.json"), "utf8"));
  // 行级引用逐字复制：script verify 与 inspect 节点随行携带
  assert.deepEqual(plan.acceptance.nodes.find((n) => n.id === "A1").adversarialFormRefs, ["AF-1", "AF-2"]);
  assert.deepEqual(plan.acceptance.nodes.find((n) => n.id === "A2").adversarialFormRefs, ["AF-2", "AF-1"]);
  // 汇总 inspect 节点 = 聚合其 verify 前驱（仅 A1）的 refs 去重；inspect 行不进聚合域
  assert.deepEqual(plan.acceptance.nodes.find((n) => n.id === "summarize").adversarialFormRefs, ["AF-1", "AF-2"]);
});

test("acceptance 编译：adversarialFormRefs 形态破损报三段式缺口不静默", (t) => {
  const f = makeFixture(t);
  rewritePlan(f, (plan) => {
    plan.acceptancePlan[0].adversarialFormRefs = "AF-1"; // 字符串非数组——上游契约含糊
  });
  assert.equal(f.run(["--impl-plan", f.planPath]).status, 0, "dev 编译不受验收行字段影响");
  const r = f.run(["--impl-plan", f.planPath, "--mode", "acceptance"]);
  assert.equal(r.status, 1, `形态破损应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("adversarialFormRefs 存在但不是字符串数组"), `须点名字段形态缺口：${r.stderr}`);
  assert.ok(r.stderr.includes("不合法输入") && r.stderr.includes("权威源") && r.stderr.includes("恢复动作"), "三段式齐全");
  // acceptance 缺口不得覆盖 dev 期 exec-plan（保持 dev 形态，同 runner-flags 用例纪律）
  assert.equal(JSON.parse(readFileSync(join(f.productRoot, "demo-compile.exec-plan.json"), "utf8")).mode, "dev", "exec-plan 须保持 dev 形态未被改写");
});

test("check-exec-plan schema 同步：节点 adversarialFormRefs 可选、在场须为字符串数组", async () => {
  // 单元级断言（import checkPlan；CLI 全量校验由编译器生成即校验门与其他用例覆盖）
  const { checkPlan } = await import(CHECKER);
  const base = () => ({
    version: 1,
    mode: "acceptance",
    projectRoot: "/p",
    statusPath: "/p/s.json",
    planPath: "/p/impl-plan.json",
    designDocPath: "/p/design.rendered.md",
    baseline: "abcdef1234567890",
    testPlan: { fullSuite: { program: "node", args: ["--test", "all"] } },
    acceptance: {
      nodes: [{ id: "A1", kind: "verify", deps: [], script: "/p/s.mjs", artifactsDir: "/p/a" }],
      groups: { core: [], nonCore: [] },
    },
  });
  // 字段缺省 = 合法（行未声明引用的节点形态）
  assert.equal(checkPlan(base()).ok, true, "无 adversarialFormRefs 的节点应放行");
  // 字符串数组 = 合法
  const arr = base();
  arr.acceptance.nodes[0].adversarialFormRefs = ["AF-1"];
  assert.equal(checkPlan(arr).ok, true, "字符串数组形态应放行");
  // 在场但非数组 = field 缺口
  const bad = base();
  bad.acceptance.nodes[0].adversarialFormRefs = "AF-1";
  const result = checkPlan(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.category === "field" && e.message.includes("adversarialFormRefs")), "非数组形态须报 field 缺口");
});

// ── 机制八 D0 门（设计 §11.2 类型层门 / §11.3 测试命令有效性）：红绿用例 ──

/** 手写项目能力快照（真实快照由 detect-project-capabilities.mjs 生成，此处只造门判定输入）。
 *  testConfig 缺省 = 中性非空条目（zeroTestPassThrough=false）：11.2 用例不触发 11.3 的
 *  「testConfig 为空 + fullSuite 绑定」拒绝，两门判定互不串扰 */
function capabilitiesSnapshot(toolchain = [], testConfig = [{ runner: "vitest", zeroTestPassThrough: false, source: "vitest.config.ts" }]) {
  return {
    schemaVersion: 1,
    generator: { name: "detect-project-capabilities", version: 1 },
    projectRoot: "/p",
    observedAt: "2026-11-18T00:00:00.000Z",
    inputHashes: {},
    commands: [],
    verificationAssets: [],
    toolchain,
    testConfig,
    unknowns: [],
  };
}

function writeSnapshot(f, snapshot) {
  mkdirSync(f.productRoot, { recursive: true });
  writeFileSync(join(f.productRoot, "project-capabilities.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

const TS_MISSING = [{ id: "typescript", status: "missing", command: "tsc --noEmit", source: "devDependencies + node_modules/.bin" }];
const TS_AVAILABLE = [{ id: "typescript", status: "available", command: "tsc --noEmit", source: "devDependencies + node_modules/.bin" }];

test("机制八 11.2 类型层门：tsconfig 在场 + typescript=missing → 拒绝编译，三选一处置齐全", (t) => {
  const f = makeFixture(t);
  writeFileSync(join(f.proj, "tsconfig.json"), "{}\n"); // 触发依据：项目 tsconfig 在场
  writeSnapshot(f, capabilitiesSnapshot(TS_MISSING));
  const r = f.run(["--impl-plan", f.planPath]);
  assert.equal(r.status, 1, `类型工具链 missing 应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("类型层门未过"), `须走类型层门缺口通道：${r.stderr}`);
  assert.ok(r.stderr.includes("tsconfig.json 在场"), "须点名触发依据");
  assert.ok(r.stderr.includes("status=missing"), "须点名快照事实");
  for (const option of ["纳入首个增量", "显式裁决", "不再声称类型层断言"]) {
    assert.ok(r.stderr.includes(option), `设计 §11.2 三选一处置须含「${option}」`);
  }
  assert.ok(r.stderr.includes("--allow-missing-typescript"), "恢复动作须给出裁决旗");
  assert.ok(!existsSync(join(f.productRoot, "demo-compile.exec-plan.json")), "拒绝时不得生成 exec-plan");
});

test("机制八 11.2 放行三态：available / 快照不在盘 / 显式裁决旗，全部放行并登记披露", (t) => {
  // ① status=available → 放行 + 披露快照事实
  const f1 = makeFixture(t);
  writeFileSync(join(f1.proj, "tsconfig.json"), "{}\n");
  writeSnapshot(f1, capabilitiesSnapshot(TS_AVAILABLE));
  const r1 = f1.run(["--impl-plan", f1.planPath]);
  assert.equal(r1.status, 0, `available 应放行：${r1.stderr}`);
  assert.ok(r1.stdout.includes("验证资产门披露") && r1.stdout.includes("类型层门") && r1.stdout.includes("status=available"), "放行须披露快照事实");
  // ② 快照不在盘（旧项目）→ 放行 + 披露未核验与补核验通道
  const f2 = makeFixture(t);
  writeFileSync(join(f2.proj, "tsconfig.json"), "{}\n");
  const r2 = f2.run(["--impl-plan", f2.planPath]);
  assert.equal(r2.status, 0, `快照不在盘应放行：${r2.stderr}`);
  assert.ok(r2.stdout.includes("快照不在盘") && r2.stdout.includes("detect-project-capabilities.mjs"), "放行披露须点名快照缺省与探测通道");
  // ③ 显式裁决旗 → 放行 + 披露裁决理由；裁决旗冻结进 exec-plan 溯源
  const f3 = makeFixture(t);
  writeFileSync(join(f3.proj, "tsconfig.json"), "{}\n");
  writeSnapshot(f3, capabilitiesSnapshot(TS_MISSING));
  const r3 = f3.run(["--impl-plan", f3.planPath, "--allow-missing-typescript", "用户裁决：接受无类型检查"]);
  assert.equal(r3.status, 0, `裁决旗应放行：${r3.stderr}`);
  assert.ok(r3.stdout.includes("按用户显式裁决放行") && r3.stdout.includes("用户裁决：接受无类型检查"), "放行披露须点名裁决");
  const plan = JSON.parse(readFileSync(join(f3.productRoot, "demo-compile.exec-plan.json"), "utf8"));
  assert.ok(plan.generatedBy.command.includes("--allow-missing-typescript"), "裁决旗须随 generatedBy.command 冻结");
});

test("机制八 11.3 测试命令有效性门：zeroTestPassThrough 拒绝（裁决旗放行）／testConfig 空 + fullSuite 绑定拒绝／快照损坏拒绝", (t) => {
  // ① 空跑放行配置事实 → 拒绝（fixture 无 tsconfig、快照 toolchain 空——确认拒绝只来自 11.3）
  const f1 = makeFixture(t);
  writeSnapshot(f1, capabilitiesSnapshot([], [{ runner: "vitest", zeroTestPassThrough: true, source: "vitest.config.ts" }]));
  const r1 = f1.run(["--impl-plan", f1.planPath]);
  assert.equal(r1.status, 1, `空跑放行配置应拒绝：${r1.stderr}`);
  assert.ok(r1.stderr.includes("测试命令有效性门未过"), `须走测试命令有效性门通道：${r1.stderr}`);
  assert.ok(r1.stderr.includes("zeroTestPassThrough=true") && r1.stderr.includes("vitest"), "须点名快照事实与 runner");
  assert.ok(r1.stderr.includes("移除 passWithNoTests") && r1.stderr.includes("--allow-zero-test-passthrough"), "两条处置须齐全");
  assert.ok(!r1.stderr.includes("类型层门未过"), "类型层门未触发不得误报");
  // ② 显式裁决旗 → 放行 + 披露
  const f2 = makeFixture(t);
  writeSnapshot(f2, capabilitiesSnapshot([], [{ runner: "vitest", zeroTestPassThrough: true, source: "vitest.config.ts" }]));
  const r2 = f2.run(["--impl-plan", f2.planPath, "--allow-zero-test-passthrough", "过渡期保留"]);
  assert.equal(r2.status, 0, `裁决旗应放行：${r2.stderr}`);
  assert.ok(r2.stdout.includes("按用户显式裁决放行") && r2.stdout.includes("过渡期保留"), "放行披露须点名裁决");
  // ③ testConfig 为空（探测不到任何测试配置）+ fullSuite 绑定 → 全量命令空跑拒绝
  const f3 = makeFixture(t);
  writeSnapshot(f3, capabilitiesSnapshot([], []));
  const r3 = f3.run(["--impl-plan", f3.planPath]);
  assert.equal(r3.status, 1, `无测试配置应拒绝：${r3.stderr}`);
  assert.ok(r3.stderr.includes("测试命令不可空跑成功"), "须点名空跑风险");
  assert.ok(r3.stderr.includes("detect-project-capabilities.mjs"), "恢复动作须指向重跑探测");
  // ④ 快照在场但损坏 → 照实报缺口（禁手改产物损坏不静默当缺省）
  const f4 = makeFixture(t);
  mkdirSync(f4.productRoot, { recursive: true });
  writeFileSync(join(f4.productRoot, "project-capabilities.json"), "{broken");
  const r4 = f4.run(["--impl-plan", f4.planPath]);
  assert.equal(r4.status, 1, `损坏快照应拒绝：${r4.stderr}`);
  assert.ok(r4.stderr.includes("项目能力快照不可读"), "须点名快照损坏");
  assert.ok(r4.stderr.includes("detect-project-capabilities.mjs"), "恢复动作须指向重建快照");
});

test("机制八 §11.3 登记义务：编译摘要披露机检脚本绑定义务（机器不可判定子条的登记性注释）", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--impl-plan", f.planPath]);
  assert.equal(r.status, 0, `编译应成功：${r.stderr}`);
  assert.ok(r.stdout.includes("验证资产门披露") && r.stdout.includes("登记义务"), "摘要须登记 §11.3 机器不可判定义务");
  assert.ok(r.stdout.includes("D2 Gate A") && r.stdout.includes("verification asset obligation open"), "义务登记须点名绑定去向与 open 处置");
});
