// contract-rescan-gates-v6.test.mjs — 外部契约复扫门（D0/D3）与 evaluate 侧守门回归
//
// 被测实现（设计《V6 运行可用性与外部契约守门升级》§4.2 D0 复扫规则 / §7.3 D0/D3 /
// §6.2 accepted 公式 / §4.3 预算规则 / §13 降档）：
//   - compile-exec-plan.mjs：D0 外部契约门（快照指针 / essential resolved / 契约冒烟增量 /
//     spike 单元存在性与 DAG / D0 复扫拒绝）——spawn 真实 CLI；
//   - check-contract-rescan.mjs：D0/D3 复扫判定单一实现——D3 经 CLI 实跑（进程内转译
//     通道，CLI spawn 通道仅存于防漂移对拍锚）；
//   - delivery-gate.mjs：evaluate 前置复扫、EnvironmentBaselineConfirmed 预算规则、
//     accepted 公式 runtime 三区块、record-exploration 维度覆盖。
//
// 覆盖（测试审查报告结论的补执行断言；变异探针定位的无承重机制逐条对应）：
//   A. D0 复扫三条规则锚（审查发现 2，P1）：strong 候选 call-class 不被任何 capability
//      detectionClasses 覆盖 → 拒绝；unresolved 非空 → 拒绝；D3 同两类经 CLI 实跑；
//   B. 编译门 spike 单元存在性（审查发现 8，P2）：units 全为业务单元（无 kind=contract-spike）
//      + essential 契约 → 拒绝编译；
//   C. 复扫真实策略文件（审查发现 12，P3）：真策略包复制进临时 HOME 安装位后蕴含观察类
//      按策略判定（不靠回退表），且回退表与策略文件初始关系一致；
//   D. 接缝一：resolver --write 落盘 → 真实 D0 编译读到指针（钉修复后终态：指针在 taskDir
//      根；兼容读子目录旧布局）；
//   E. 接缝三：真实 detect 输出喂 D0 复扫与 gate evaluate 前置两侧判定一致（含 register-command
//      蕴含 dispatch-command 的蕴含观察类对账）；
//   F. accepted 公式 runtime 三区块承重（审查发现 1，P1）：唯一缺口是 runtime 义务时
//      state=candidate、义务块与 readiness 块同时可观测、恢复动作可操作；对照 probe 齐备
//      才 accepted（成对断言证明区块承重）；
//   G. evaluate 侧强制 essential（审查发现 9，P2）：optional 契约 + 强信号候选 + 无 probe
//      → 义务 required 且不得 accepted；
//   H. evaluate 侧基线预算可达性（审查发现 10，P3）：手改两条 EnvironmentBaselineConfirmed
//      → evaluate 拒绝（命令层单一防线之外的 evaluate 侧判定）。
//
// fixture 纪律：mkdtempSync 临时目录、HOME 重定向、t.after 清理、无固定文件名；
// 编译/复扫 fixture 形态照 compile-contract-gate-v6.test.mjs（该文件不动，此处为新文件
// 独立复刻——测试文件之间不互相 import，避免测试进程互相装载）。
//
// 提速通道（进程内转译执行）：fixture 渲染器（RENDERER）、真实 resolver（--write 三用例）、
// COMPILER（f.run 全部用例）与 RESCAN_CLI（D3 三用例）走 runMjsScript，语义一致性由防漂移
// 对拍锚钉住（进程内 == CLI spawn 逐字节一致）。复扫库经 require(esm) 落主测试进程后，其
// DEFAULT_DETECTOR_PATH（顶层 homedir() 常量）随模块缓存只求值一次——预加载窗口把 HOME 指向
// 会话级 detector 安装位根完成固化（见常量区）；每 fixture 的探测器/策略副本由 install* 双写
// （home 安装位供 CLI spawn 形态、会话位供进程内形态），两形态同内容同 env——HOME 与
// RESCAN_FIXTURE 注入经 runner 宿主临时应用进复扫库 detector 孙进程的继承链。保留真实 spawn
// 的点：gate 侧 stub resolver/detector（makeEvalFixture / makeGateTaskFixture）由进程内 gate
// 模块自行 spawn，测试不可注入；git 系 spawnSync 全部保持真实。
//
// 运行：node --test scripts/tests/contract-rescan-gates-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { makeMjsStubSpawn, runMjsScript } from "./helpers/mjs-runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const COMPILER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "compile-exec-plan.mjs");
const COMPILER_DIR_REAL = dirname(realpathSync(COMPILER));
const RENDERER = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "scripts", "render-impl-plan.mjs");
const RESCAN_CLI = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-contract-rescan.mjs");
const RESCAN_LIB = join(V6, "scripts", "lib", "contract-rescan.mjs");
const GATE = join(V6, "scripts", "delivery-gate.mjs");
const RESOLVER = join(V6, "scripts", "resolve-external-contracts.mjs");
const DETECTOR = join(V6, "scripts", "detect-external-contracts.mjs");
const POLICY_FILE = join(V6, "policies", "external-contract-classes.json");
// COMPILER 进程内执行时沙箱内 spawn 的子脚本白名单（与 compile-exec-plan 内 spawn 参数逐字
// 同构：四项无 .. 段，渲染器一项带 ".." 段——SCRIPT_DIR 在被测脚本内是 realpath 形态，
// spawn 字符串原样透传，白名单按精确匹配，形态必须一致）
const COMPILER_CHILD_SCRIPTS = [
  join(COMPILER_DIR_REAL, "gen-acceptance-wrapper.mjs"),
  join(COMPILER_DIR_REAL, "gen-runtime-probe-wrapper.mjs"),
  join(COMPILER_DIR_REAL, "verification-index.mjs"),
  join(COMPILER_DIR_REAL, "check-exec-plan.mjs"),
  join(COMPILER_DIR_REAL, "..", "..", "tech-design-v6", "scripts", "render-impl-plan.mjs"),
];
// 复扫库 DEFAULT_DETECTOR_PATH = join(homedir(), ...) 顶层常量：库经 require(esm) 落主测试
// 进程后随模块缓存只求值一次，进程内执行时无法按 fixture 注入重定向。预加载窗口把 HOME 指向
// 会话级安装位根后加载 GATE（其 import 链含复扫库）与复扫库本身，固化路径即落到该根；窗口
// 即恢复。detector/策略副本由 install* 双写（home 安装位供 CLI spawn 形态、会话位供进程内
// 形态），两形态同内容同 env，判定输入一致
const DETECTOR_HOME_ROOT = mkdtempSync(join(tmpdir(), "crg-detector-home-"));
process.on("exit", () => rmSync(DETECTOR_HOME_ROOT, { recursive: true, force: true }));
const RESCAN_INSTALL_SCRIPTS = join(DETECTOR_HOME_ROOT, ".agents", "skills", "delivery-v6", "scripts");
const RESCAN_INSTALL_POLICIES = join(DETECTOR_HOME_ROOT, ".agents", "skills", "delivery-v6", "policies");
const savedHome = process.env.HOME;
process.env.HOME = DETECTOR_HOME_ROOT;
const GATE_MODULE = await import(pathToFileURL(GATE).href);
createRequire(import.meta.url)(RESCAN_LIB);
if (savedHome === undefined) delete process.env.HOME;
else process.env.HOME = savedHome;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Text = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
const ok = (result, label = "命令应成功") => {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
};

const SNAPSHOT_SHA = "a".repeat(64);
const AGG_HASH = "b".repeat(64);

// ── 编译/复扫 fixture 基座（形态照 compile-contract-gate-v6.test.mjs，新文件独立复刻）──

function contractAcceptance({ essential = true, capabilityClasses = ["register-command", "dispatch-command"] } = {}) {
  return {
    schemaVersion: 2,
    acceptanceVersion: 1,
    externalContracts: [
      {
        id: "EC-demo-host",
        essential,
        authorityRequest: { resolverKind: "installed-npm-package", locator: "@demo/host-sdk" },
        capabilities: [
          { id: "load-extension", minEnvironment: "official-runner", detectionClasses: ["extension-entrypoint"], surfaceRefs: ["types.d.ts"] },
          { id: "register-command", minEnvironment: "real-host", detectionClasses: capabilityClasses, surfaceRefs: ["types.d.ts#RegisteredCommand"] },
        ],
      },
    ],
    externalContractReview: { detectionSha256: "c".repeat(64), dispositions: [] },
    adversarialForms: [],
    requirements: [{ id: "R1", assertions: [] }],
  };
}

function contractIncrements() {
  return {
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [
      { id: "inc-smoke", title: "契约冒烟", requirementIds: ["R1"], kind: "contract-smoke", testCommand: { program: "node", args: ["--test", "tests/smoke"] } },
      { id: "inc-1", title: "契约根", requirementIds: ["R1"], testCommand: { program: "node", args: ["--test", "tests/shared"] } },
      { id: "inc-2", title: "主实现", requirementIds: ["R2"], testCommand: { program: "pnpm", args: ["-C", "app", "test"] } },
    ],
  };
}

/** 契约任务 impl-plan：spike 单元 + 两个业务单元（businessDepsOnSpike=false 时业务单元不依赖 spike）；
 *  probeFormRefs 非空时给 runtime-probe 行加 adversarialFormRefs（JSON-only 字段——D3 节点场景归属连接） */
function contractPlan(proj, { withSpike = true, businessDepsOnSpike = true, withProbeRow = true, probeFormRefs = null } = {}) {
  const units = [];
  if (withSpike) {
    units.push({
      id: "u-spike", responsibility: "契约冒烟 spike", territory: ["src/spike/"], deps: [], isolation: "plain",
      acceptance: ["A0 契约形态确认"], decisionTier: "A", designRef: "§4.0", incrementId: "inc-smoke", kind: "contract-spike",
    });
  }
  units.push({
    id: "u-foundation", responsibility: "共享契约根", territory: ["src/shared/"], deps: businessDepsOnSpike && withSpike ? ["u-spike"] : [], isolation: "plain",
    acceptance: ["A1 共享契约成立"], decisionTier: "A", designRef: "§4.1", incrementId: "inc-1",
  });
  units.push({
    id: "u-main", responsibility: "主实现", territory: ["src/app/"], deps: ["u-foundation"], isolation: "plain",
    acceptance: ["A2 主链路可用"], decisionTier: "B", designRef: "§4.2", incrementId: "inc-2",
  });
  const plan = {
    name: "demo-contract",
    designDoc: join(proj, "design"),
    baseline: "abcdef1234567890",
    skillVersion: "1.0.0",
    sectionMap: { goal: "§1", mechanism: "§2", acceptance: "§3", breakdown: "§4" },
    units,
    testPlan: {
      incrementalCommands: [
        { incrementId: "inc-smoke", unitIds: withSpike ? ["u-spike"] : [], command: { program: "node", args: ["--test", "tests/smoke"] } },
        { incrementId: "inc-1", unitIds: ["u-foundation"], command: "node --test tests/shared" },
        { incrementId: "inc-2", unitIds: ["u-main"], command: { program: "pnpm", args: ["-C", "app", "test"] } },
      ],
      fullSuite: { program: "pnpm", args: ["test"] },
    },
    acceptancePlan: [
      { id: "A1", item: "主链路脚本验收", level: "L3", group: "core", deps: [], optimization: "可脚本化", verifyAsset: "-", script: join(proj, "scripts", "verify-a1.mjs") },
      { id: "A2", item: "全页人工审查", level: "L4", group: "non-core", deps: ["A1"], optimization: "判断行" },
    ],
  };
  if (withProbeRow) {
    plan.acceptancePlan.unshift({
      id: "A-probe-reg", item: "runtime 探针：命令注册与分发", level: "L3", group: "core", deps: [], optimization: "可脚本化",
      type: "runtime-probe", capabilityIds: ["EC-demo-host:register-command"], command: { program: "node", args: ["scripts/probe.mjs"] },
      artifact: "evidence/runtime-probe-A-probe-reg.json",
      ...(probeFormRefs !== null ? { adversarialFormRefs: probeFormRefs } : {}),
    });
    plan.acceptancePlan[1].deps = ["A-probe-reg"];
  }
  return plan;
}

let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "crg-git-tpl-"));
    const git = (args) => spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: tpl, encoding: "utf8" });
    assert.equal(git(["init", "-q"]).status, 0, "git init 失败");
    for (const dir of ["src/shared", "src/spike", "src/app", "scripts", "design"]) mkdirSync(join(tpl, dir), { recursive: true });
    writeFileSync(join(tpl, "scripts", "verify-a1.mjs"), "process.exit(0);\n");
    writeFileSync(join(tpl, "scripts", "probe.mjs"), "process.stdout.write(JSON.stringify({ summary: { passed: 1, failed: 0, skipped: 0 } }));\n");
    writeFileSync(join(tpl, "design", "s3-solution.json"), "{}\n");
    writeFileSync(join(tpl, "design", "s4-accept.json"), "{}\n");
    writeFileSync(join(tpl, "README.md"), "fixture\n");
    assert.equal(git(["add", "."]).status, 0);
    assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
    gitTemplate = tpl;
  }
  return gitTemplate;
}

/** 探测 CLI 替身：输出 RESCAN_FIXTURE 指向的 JSON（缺省 = 空候选快照）。
 *  双写（fixture home 安装位 + 会话级安装位）：CLI spawn 形态经 HOME 注入命中前者，
 *  进程内形态命中固化到会话位的 DEFAULT_DETECTOR_PATH——两形态拿同一份脚本内容 */
function installFakeDetector(home) {
  const dir = join(home, ".agents", "skills", "delivery-v6", "scripts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(RESCAN_INSTALL_SCRIPTS, { recursive: true });
  const body = [
    "import { readFileSync } from 'node:fs';",
    "const out = { schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] };",
    "const p = process.env.RESCAN_FIXTURE;",
    "if (p) Object.assign(out, JSON.parse(readFileSync(p, 'utf8')));",
    "process.stdout.write(JSON.stringify(out));",
    "",
  ].join("\n");
  writeFileSync(join(dir, "detect-external-contracts.mjs"), body);
  writeFileSync(join(RESCAN_INSTALL_SCRIPTS, "detect-external-contracts.mjs"), body);
}

/** 把真实探测器与策略包复制进临时 HOME 安装位——复扫/对拍（对照验证（differential testing）：同一探测输出喂两侧判定）走真实探测输出
 （探测器缺策略文件即 exit 3：调用类词表是探测的唯一权威来源，两者必须同装）。
 *  同 installFakeDetector 双写：home 安装位供 CLI spawn 形态、会话位供进程内形态 */
function installRealDetector(home) {
  const scripts = join(home, ".agents", "skills", "delivery-v6", "scripts");
  const policies = join(home, ".agents", "skills", "delivery-v6", "policies");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(policies, { recursive: true });
  mkdirSync(RESCAN_INSTALL_SCRIPTS, { recursive: true });
  mkdirSync(RESCAN_INSTALL_POLICIES, { recursive: true });
  cpSync(DETECTOR, join(scripts, "detect-external-contracts.mjs"));
  cpSync(DETECTOR, join(RESCAN_INSTALL_SCRIPTS, "detect-external-contracts.mjs"));
  cpSync(POLICY_FILE, join(policies, "external-contract-classes.json"));
  cpSync(POLICY_FILE, join(RESCAN_INSTALL_POLICIES, "external-contract-classes.json"));
}

/** 把真实策略包复制进临时 HOME 安装位（探测器仍可用替身控候选——复扫判定的策略表走库
 *  缺省路径即仓库真策略包，与本安装位无关）；双写同上，保持两形态安装位布局对称 */
function installRealPolicy(home) {
  const policies = join(home, ".agents", "skills", "delivery-v6", "policies");
  mkdirSync(policies, { recursive: true });
  mkdirSync(RESCAN_INSTALL_POLICIES, { recursive: true });
  cpSync(POLICY_FILE, join(policies, "external-contract-classes.json"));
  cpSync(POLICY_FILE, join(RESCAN_INSTALL_POLICIES, "external-contract-classes.json"));
}

function makeContractFixture(t, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "crg-home-"));
  const proj = mkdtempSync(join(tmpdir(), "crg-proj-"));
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const taskDir = mkdtempSync(join(tmpdir(), "crg-task-"));
  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  git(["rev-parse", "HEAD"]);
  if (opts.realDetector === true) installRealDetector(home);
  else installFakeDetector(home);
  if (opts.realPolicy === true) installRealPolicy(home);

  const plan = contractPlan(proj, opts.planOverrides ?? {});
  const planPath = join(proj, "demo-contract.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  // 渲染器进程内转译执行（CLI spawn 通道仅存于防漂移对拍锚）；进程内捕获无缓冲上限，
  // 原为防大输出截断的 maxBuffer 放宽选项随 spawn 一起移除
  const rendered = runMjsScript(RENDERER, [planPath]);
  assert.equal(rendered.status, 0, `fixture 渲染失败：${rendered.stderr}`);

  if (opts.increments !== null) {
    writeFileSync(join(taskDir, "increments.json"), `${JSON.stringify(opts.increments ?? contractIncrements(), null, 2)}\n`);
  }
  if (opts.acceptance !== null && opts.acceptance !== undefined) {
    writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(opts.acceptance, null, 2)}\n`);
  }
  if (opts.snapshot === true || opts.snapshot === "unresolved") {
    const dir = join(taskDir, "environment-contracts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SNAPSHOT_SHA}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        snapshotSha256: SNAPSHOT_SHA,
        contracts: [{
          id: "EC-demo-host",
          status: opts.snapshot === "unresolved" ? "declared-unavailable" : "resolved",
          resolvedPath: "/opt/demo-host",
          surfaces: [{ surfaceRef: "types.d.ts", sha256: "d".repeat(64) }],
          aggregateHash: AGG_HASH,
        }],
      }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "..", "environment-contracts.current.json"),
      `${JSON.stringify({ schemaVersion: 1, snapshotSha256: SNAPSHOT_SHA, snapshotPath: `environment-contracts/${SNAPSHOT_SHA}.json`, updatedAt: "2026-11-18T00:00:00.000Z" }, null, 2)}\n`,
    );
  }
  writeFileSync(join(taskDir, "intent.md"), "# 意图\n实现 demo 宿主扩展。\n");
  if (opts.detectorOutput !== undefined && opts.detectorOutput !== null) {
    writeFileSync(join(taskDir, "detector-output.json"), `${JSON.stringify(opts.detectorOutput)}\n`);
  }
  if (opts.writeBinding !== false && opts.acceptance !== null && opts.acceptance !== undefined && opts.increments !== null) {
    const acc = JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8"));
    const inc = JSON.parse(readFileSync(join(taskDir, "increments.json"), "utf8"));
    writeFileSync(
      join(proj, "design", "meta.json"),
      `${JSON.stringify({
        acceptanceBinding: {
          acceptanceVersion: acc.acceptanceVersion,
          acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acc), "increments.json": canonicalJson(inc) })),
          taskDir,
        },
      }, null, 2)}\n`,
    );
  }

  const projReal = realpathSync(proj);
  const slug = `${basename(projReal)}-${createHash("sha256").update(projReal).digest("hex").slice(0, 8)}`;
  const productRoot = join(home, ".agents", "skill-data", "dev-flow", slug);
  const execPath = join(productRoot, "demo-contract.exec-plan.json");

  // 改写验收包后同步重算 meta.json acceptanceBinding（binding 哈希与盘上包一致，
  // 否则 D0 编译门在绑定核对处拒绝——与 compile-contract-gate-v6 全链路用例同形态）
  const rewriteAcceptance = (acceptance) => {
    writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
    const inc = JSON.parse(readFileSync(join(taskDir, "increments.json"), "utf8"));
    writeFileSync(
      join(proj, "design", "meta.json"),
      `${JSON.stringify({
        acceptanceBinding: {
          acceptanceVersion: acceptance.acceptanceVersion,
          acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acceptance), "increments.json": canonicalJson(inc) })),
          taskDir,
        },
      }, null, 2)}\n`,
    );
  };

  const run = (args, extraEnv = {}) => {
    const env = { ...process.env, HOME: home, ...extraEnv };
    if (opts.detectorOutput !== undefined && opts.detectorOutput !== null) env.RESCAN_FIXTURE = join(taskDir, "detector-output.json");
    // 进程内转译执行：COMPILER 沙箱内 spawn 的子脚本走白名单桩（转译执行），git 系与白名单外
    // 回退真实 spawnSync（cwd/env 由桩对齐 CLI 语义）；复扫库的 detector spawn 发生在真实
    // 模块层（不经桩），HOME/RESCAN_FIXTURE 经 runner 宿主临时应用进其继承链（安装位双写
    // 见 install*）；进程内捕获无缓冲上限，原为防大输出截断的 maxBuffer 放宽随 spawn 移除
    return runMjsScript(COMPILER, args, { env, cwd: proj, spawn: makeMjsStubSpawn({ mjs: COMPILER_CHILD_SCRIPTS, env, cwd: proj }) });
  };
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  });
  return { home, proj, projReal, taskDir, planPath, productRoot, execPath, run, rewriteAcceptance };
}

// ── 防漂移锚：渲染器进程内执行 == CLI spawn（本文件唯一保留的渲染器 spawn 点）──

test("防漂移锚：渲染器进程内执行 == CLI spawn（fixture 渲染双跑逐字节对拍）", (t) => {
  // 渲染为同输入确定性输出（同一 planPath 双跑不涉及路径差异，严格逐字节）；
  // 提速通道（fixture 渲染 + resolver --write 进程内转译）的语义一致性由本锚钉住
  const f = makeContractFixture(t);
  const inProc = runMjsScript(RENDERER, [f.planPath]);
  const cli = spawnSync(process.execPath, [RENDERER, f.planPath], { encoding: "utf8" });
  assert.equal(inProc.status, cli.status);
  assert.equal(inProc.stdout, cli.stdout);
  assert.equal(inProc.stderr, cli.stderr);
});

test("防漂移锚：编译器与复扫 CLI 进程内执行 == CLI spawn（复扫链双跑逐字节对拍）", (t) => {
  // COMPILER（f.run）与 RESCAN_CLI（D3）转换通道的语义一致性锚：拒绝路径只读不写盘，
  // 同 fixture 双跑（进程内先、CLI spawn 后）输出须逐字节一致；复扫链含库内 detector
  // spawn（安装位双写见文件头），两形态同内容同 env，判定输入一致
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ capabilityClasses: ["register-tool"] }),
    increments: contractIncrements(),
    snapshot: true,
    detectorOutput: {
      candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }],
      unresolved: [],
    },
  });
  const acc = contractAcceptance({ capabilityClasses: ["register-tool"] });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-cmd", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  const runEnv = { ...process.env, HOME: f.home, RESCAN_FIXTURE: join(f.taskDir, "detector-output.json") };
  const inProc = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  const cli = spawnSync(process.execPath, [COMPILER, "--impl-plan", f.planPath, "--task-dir", f.taskDir], { cwd: f.proj, env: runEnv, encoding: "utf8" });
  assert.equal(inProc.status, cli.status);
  assert.equal(inProc.stdout, cli.stdout);
  assert.equal(inProc.stderr, cli.stderr);
  assert.equal(inProc.status, 1, "fixture 前提：调用类未覆盖形态复扫拒绝");
  // D3 侧同口径（probe artifact 未落盘拒绝，只读判定；合法编译后 exec-plan 在场）
  const g = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  assert.equal(g.run(["--impl-plan", g.planPath, "--task-dir", g.taskDir]).status, 0, "dev 编译前置");
  assert.equal(g.run(["--impl-plan", g.planPath, "--mode", "acceptance", "--task-dir", g.taskDir]).status, 0, "acceptance 编译前置");
  const d3Args = ["--task-dir", g.taskDir, "--project-root", g.proj, "--exec-plan", g.execPath, "--stage", "d3"];
  const d3Env = { ...process.env, HOME: g.home };
  const inProcD3 = runMjsScript(RESCAN_CLI, d3Args, { env: d3Env, cwd: g.proj });
  const cliD3 = spawnSync(process.execPath, [RESCAN_CLI, ...d3Args], { cwd: g.proj, env: d3Env, encoding: "utf8" });
  assert.equal(inProcD3.status, cliD3.status);
  assert.equal(inProcD3.stdout, cliD3.stdout);
  assert.equal(inProcD3.stderr, cliD3.stderr);
  assert.equal(inProcD3.status, 1, "fixture 前提：probe 未落盘 D3 拒绝");
});

// ── A. D0/D3 复扫三条规则锚（审查发现 2）──

test("D0 复扫：strong 候选 call-class 不被任何 capability detectionClasses 覆盖 → 拒绝编译", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ capabilityClasses: ["register-tool"] }), // 只登记 register-tool
    increments: contractIncrements(),
    snapshot: true,
    detectorOutput: {
      candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }],
      unresolved: [],
    },
  });
  // 处置表：候选 bound 到 EC-demo-host（处置合法——拒绝点落在调用类覆盖对账）
  const acc = contractAcceptance({ capabilityClasses: ["register-tool"] });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-cmd", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `调用类未覆盖应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("D0 外部契约复扫未过"), "须走复扫缺口通道");
  assert.ok(r.stderr.includes("调用类未登记到契约"), "须点名调用类覆盖缺口");
  assert.ok(r.stderr.includes("register-command"), "须点名缺失的调用类本身");
  assert.ok(r.stderr.includes("dispatch-command"), "须点名蕴含观察类（register-command 蕴含 dispatch-command）");
  assert.ok(r.stderr.includes("恢复动作"), "拒绝须带恢复动作");
  assert.ok(!existsSync(f.execPath), "拒绝时不得生成 exec-plan");
});

test("D0 复扫：unresolved 非空 → 拒绝编译（计算式外部访问停回，不做字面白名单放行）", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    detectorOutput: {
      candidates: [],
      unresolved: [{ signal: "动态 import(moduleName)@src/dyn.ts", reason: "调用参数不是字符串字面量，无法静态归因" }],
    },
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `unresolved 应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("D0 外部契约复扫未过"), "须走复扫缺口通道");
  assert.ok(r.stderr.includes("未解析外部访问"), "须点名未解析外部访问");
  assert.ok(r.stderr.includes("停回"), "须体现停回人工口径");
  assert.ok(!existsSync(f.execPath), "拒绝时不得生成 exec-plan");
});

test("D3 复扫（CLI）：绿地后引入新调用类 → 候选完成前复扫拒绝（与 D0 同判定）", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(), // capability 覆盖 register-command + dispatch-command
    increments: contractIncrements(),
    snapshot: true,
    detectorOutput: {
      candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }],
      unresolved: [],
    },
  });
  const acc = contractAcceptance();
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-cmd", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "D0 编译前置（D0 时应放行）");
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]).status, 0, "acceptance 编译前置");
  // probe artifact 落盘（隔离复扫错误——否则 probe 未跑错误会并报）
  mkdirSync(join(f.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(f.taskDir, "evidence", "runtime-probe-A-probe-reg.json"), `${JSON.stringify({ environment: { kind: "real-host" }, cases: [], summary: { passed: 1, failed: 0, skipped: 0 } })}\n`);
  const runRescan = () =>
    runMjsScript(RESCAN_CLI, ["--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
      env: { ...process.env, HOME: f.home, RESCAN_FIXTURE: join(f.taskDir, "detector-output.json") },
      cwd: f.proj,
    });
  // D1 引入新调用类 register-tool（验收 capability 未覆盖）→ D3 复扫拒绝
  writeFileSync(join(f.taskDir, "detector-output.json"), `${JSON.stringify({
    candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command", "source:src/app/tool.ts:call-class:register-tool"] }],
    unresolved: [],
  })}\n`);
  const rejected = runRescan();
  assert.equal(rejected.status, 1, `D3 应拒绝：${rejected.stdout}`);
  assert.ok(rejected.stdout.includes("调用类未登记到契约"), "D3 与 D0 同一判定：须点名调用类覆盖缺口");
  assert.ok(rejected.stdout.includes("register-tool"), "须点名 D1 新引入的未覆盖调用类");
  assert.ok(rejected.stdout.includes("恢复动作"), "拒绝须带恢复动作");
});

test("D3 复扫（CLI）：unresolved 非空 → 候选完成前复扫拒绝（与 D0 同判定）", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
  });
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "D0 编译前置");
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]).status, 0, "acceptance 编译前置");
  mkdirSync(join(f.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(f.taskDir, "evidence", "runtime-probe-A-probe-reg.json"), `${JSON.stringify({ environment: { kind: "real-host" }, cases: [], summary: { passed: 1, failed: 0, skipped: 0 } })}\n`);
  writeFileSync(join(f.taskDir, "detector-output.json"), `${JSON.stringify({
    candidates: [],
    unresolved: [{ signal: "运行时代码生成 eval(code)@src/gen.ts", reason: "动态生成调用无法静态归类" }],
  })}\n`);
  const r = runMjsScript(RESCAN_CLI, ["--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
    env: { ...process.env, HOME: f.home, RESCAN_FIXTURE: join(f.taskDir, "detector-output.json") },
    cwd: f.proj,
  });
  assert.equal(r.status, 1, `D3 应拒绝：${r.stdout}`);
  assert.ok(r.stdout.includes("未解析外部访问"), "D3 与 D0 同一判定：须点名未解析外部访问");
  assert.ok(r.stdout.includes("停回"), "须体现停回人工口径");
});

// ── B. 编译门 spike 单元存在性（审查发现 8）──

test("编译门：units 全为业务单元（无 kind=contract-spike）+ essential 契约 → 拒绝编译", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    planOverrides: { withSpike: false, businessDepsOnSpike: false }, // 全部业务单元、无 spike
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `无 spike 单元应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("无 kind=contract-spike 单元"), "须点名 spike 单元缺失");
  assert.ok(r.stderr.includes("tech-design-v6"), "恢复动作须指回 T3 拆 spike 单元");
  assert.ok(!existsSync(f.execPath), "拒绝时不得生成 exec-plan");
});

// ── C. 复扫真实策略文件（审查发现 12）──

test("复扫策略文件：回退表与真策略初始关系一致；判定消费策略文件而非回退表", async (t) => {
  // ① 回退表与真策略文件一致（改策略包的蕴含关系时两侧必须同步，否则复扫判定漂移）
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  const register = policy.classes.find((entry) => entry.id === "register-command");
  assert.deepEqual(register.impliesObservationClasses, ["dispatch-command"], "真策略包初始蕴含关系 = register-command 蕴含 dispatch-command（与 contract-rescan 库的 IMPLIED_CLASSES_FALLBACK 回退表同值）");
  // ② 单源库级承重：loadClassTablesFromFile 按路径读文件（临时复本上改蕴含关系 → 表跟着变），
  //    缺省路径（库同技能 policies/）读到的就是真策略包（policyAvailable=true，判定不靠回退表）
  const RESCAN_LIB = await import(pathToFileURL(join(V6, "scripts", "lib", "contract-rescan.mjs")).href);
  const tamperedCopy = join(mkdtempSync(join(tmpdir(), "crg-policy-")), "external-contract-classes.json");
  t.after(() => rmSync(dirname(tamperedCopy), { recursive: true, force: true }));
  const tampered = JSON.parse(JSON.stringify(policy));
  tampered.classes.find((entry) => entry.id === "register-command").impliesObservationClasses = ["dispatch-slash-x"];
  writeFileSync(tamperedCopy, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedTables = RESCAN_LIB.loadClassTablesFromFile(tamperedCopy);
  assert.deepEqual([...tamperedTables.implied.get("register-command")], ["dispatch-slash-x"], "loadClassTablesFromFile 必须按文件内容出表（改策略即改判定）");
  const defaultTables = RESCAN_LIB.loadClassTablesFromFile();
  assert.equal(defaultTables.policyAvailable, true, "缺省路径（库同技能 policies/）必须读到真策略包——复扫判定消费策略文件而非代码内回退表");
  assert.deepEqual([...defaultTables.implied.get("register-command")], ["dispatch-command"], "真策略包的蕴含观察关系进入判定表");
  // ③ 端到端：D0 复扫的蕴含观察类拒绝点名 dispatch-command（策略表走真文件）
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ capabilityClasses: ["register-command"] }), // 缺 dispatch-command
    increments: contractIncrements(),
    snapshot: true,
    realPolicy: true,
    detectorOutput: {
      candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }],
      unresolved: [],
    },
  });
  const acc = contractAcceptance({ capabilityClasses: ["register-command"] });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-cmd", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `蕴含观察类未覆盖应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("dispatch-command"), "复扫拒绝须点名策略表的蕴含观察类");
});

// ── D. 接缝一：resolver --write 落盘 → 真实 D0 编译读到指针 ──
// 曾是指针路径 P0（resolver 实装把 current 指针写进 environment-contracts/ 子目录，而
// D0 编译门读 taskDir 根）。本组钉修复后终态：指针在 taskDir 根（已落定转绿）+ 旧布局
// 经「重跑 resolver --write 迁移」兼容（写入侧兼容，代码线 parity 测试同口径）+ 纯旧
// 布局不重解析时响亮失败带恢复动作（读侧不猜路径）。

/** 手写最小 ustar 头（512 字节）：resolver 现按真实 tarball 解析（缓存条目 = gzipped ustar，
 * 权威内容源 = 缓存 tarball 本体），裸字符串假内容会被 fail-closed 拒绝——fixture 不引第三方
 * tar 依赖，字段布局照 external-contract-resolve-v6 测试同款 */
function ustarHeader(entryName, size) {
  const header = Buffer.alloc(512);
  header.write(entryName, 0, 100, "utf8"); // name
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size（八进制）
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write("        ", 148, "utf8"); // chksum 占位 8 空格
  header.write("0", 156, "utf8"); // typeflag：普通文件
  header.write("ustar\0", 257, "utf8"); // magic
  header.write("00", 263, "utf8"); // version
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8"); // chksum：6 位八进制 + \0 + 空格
  return header;
}

/** 构造 npm registry 同形态的包 tarball（gzipped ustar，条目带 package/ 根前缀） */
function buildPackageTarball(name, version, files) {
  const manifest = `${JSON.stringify({ name, version, main: "dist/index.js" }, null, 2)}\n`;
  const entries = [
    { name: "package/package.json", content: Buffer.from(manifest) },
    ...Object.entries(files).map(([rel, content]) => ({ name: `package/${rel}`, content: Buffer.from(content) })),
  ];
  const blocks = [];
  for (const entry of entries) {
    blocks.push(ustarHeader(entry.name, entry.content.length), entry.content, Buffer.alloc((512 - (entry.content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // tar 结束双零块
  return gzipSync(Buffer.concat(blocks));
}

/** 把 tarball 字节写进 HOME 下的 npm cacache（内容文件 = tarball 本体），返回 lockfile 用的 integrity 串。 */
function plantNpmCache(home, tarball) {
  const digest = createHash("sha512").update(tarball).digest();
  const hex = digest.toString("hex");
  const dir = join(home, ".npm", "_cacache", "content-v2", "sha512", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex.slice(2)), tarball);
  return `sha512-${digest.toString("base64")}`;
}

// 缓存 tarball 与 node_modules 解包副本共用这一份事实源（resolver 从缓存 tarball 提取
// surface 并与 node_modules 对账，两侧不一致即 fail-closed）
const NPM_SURFACE_FILES = {
  "dist/types.d.ts": "export interface ToolDefinition { name: string }\n",
  "dist/index.js": "module.exports = {};\n",
};

function npmAcceptance() {
  return {
    schemaVersion: 2,
    acceptanceVersion: 1,
    externalContracts: [
      {
        id: "EC-npm",
        essential: true,
        authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
        capabilities: [
          { id: "register-tool-and-invoke", minEnvironment: "official-runner", detectionClasses: ["register-tool"], surfaceRefs: ["dist/types.d.ts"] },
        ],
      },
    ],
    externalContractReview: { detectionSha256: "c".repeat(64), dispositions: [] },
    adversarialForms: [],
    requirements: [{ id: "R1", assertions: [] }],
  };
}

/** 把 npm 假包项目内容铺进编译 fixture 的项目目录（git 提交一次，供 resolver/编译消费） */
function overlayNpmProject(f, home) {
  const proj = f.proj;
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(join(proj, "package.json"), `${JSON.stringify({ name: "fixture-proj", version: "1.0.0", dependencies: { "fake-host-sdk": "^1.0.0" } }, null, 2)}\n`);
  write(join(proj, "node_modules", "fake-host-sdk", "package.json"), `${JSON.stringify({ name: "fake-host-sdk", version: "1.0.0", main: "dist/index.js" }, null, 2)}\n`);
  // node_modules 副本与缓存 tarball 条目共用 NPM_SURFACE_FILES 一份事实源（resolver 双侧对账）
  for (const [rel, content] of Object.entries(NPM_SURFACE_FILES)) {
    write(join(proj, "node_modules", "fake-host-sdk", rel), content);
  }
  // resolver 现从 npm 缓存 tarball 提取 surface：种真实 gzipped ustar 形态（裸字符串会被 fail-closed 拒绝）
  const integrity = plantNpmCache(home, buildPackageTarball("fake-host-sdk", "1.0.0", NPM_SURFACE_FILES));
  write(join(proj, "package-lock.json"), `${JSON.stringify({
    name: "fixture-proj",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture-proj", dependencies: { "fake-host-sdk": "^1.0.0" } },
      "node_modules/fake-host-sdk": { version: "1.0.0", integrity },
    },
  }, null, 2)}\n`);
  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  assert.equal(git(["add", "."]).status, 0, "git add 失败");
  assert.equal(git(["commit", "-qm", "npm fixture"]).status, 0, "git commit 失败");
}

const runResolverWrite = (home, taskDir, projectRoot) =>
  // resolver 进程内转译执行：无复扫库依赖链（内部 git/npm 等探测 spawn 经 runner 缺省
  // 注入保持真实），CLI spawn 通道仅存于防漂移对拍锚
  runMjsScript(RESOLVER, ["--task-dir", taskDir, "--project-root", projectRoot, "--write"], {
    env: { ...process.env, HOME: home },
  });

test("接缝一（resolver→D0）：真实 resolver --write 落盘后指针在 taskDir 根，真实 D0 编译读到并放过快照门", (t) => {
  const f = makeContractFixture(t, {
    acceptance: npmAcceptance(),
    increments: contractIncrements(),
    snapshot: false,
    detectorOutput: { candidates: [], unresolved: [] },
  });
  overlayNpmProject(f, f.home);
  writeFileSync(join(f.taskDir, "events.jsonl"), ""); // resolver 读取事件流（local-path 登记核对；此处无登记）
  const write = runResolverWrite(f.home, f.taskDir, f.proj);
  assert.equal(write.status, 0, `resolver --write 应成功：${write.stderr}`);
  // 终态锚 1：current 指针落在 taskDir 根（compile-exec-plan D0 门的读取落点）
  assert.ok(
    existsSync(join(f.taskDir, "environment-contracts.current.json")),
    `指针必须落在 taskDir 根：${join(f.taskDir, "environment-contracts.current.json")}`,
  );
  // 终态断言 2：D0 编译读到指针并放过权威快照门（不报「缺权威环境契约快照指针」）
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `D0 编译应读过指针放行：${r.stderr}`);
  assert.ok(!r.stderr.includes("缺权威环境契约快照指针"), "不得报缺快照指针");
  assert.ok(existsSync(f.execPath), "exec-plan 应生成");
});

test("接缝一（resolver→D0 兼容）：旧布局任务目录重跑 resolver --write 迁移指针到根，D0 读到放行", (t) => {
  const f = makeContractFixture(t, {
    acceptance: npmAcceptance(),
    increments: contractIncrements(),
    snapshot: false,
    detectorOutput: { candidates: [], unresolved: [] },
  });
  overlayNpmProject(f, f.home);
  writeFileSync(join(f.taskDir, "events.jsonl"), "");
  const first = runResolverWrite(f.home, f.taskDir, f.proj);
  assert.equal(first.status, 0, `resolver --write 应成功：${first.stderr}`);
  // 模拟升级前旧布局：把根指针搬进 environment-contracts/ 子目录（升级前 resolver 的落点）
  const rootPointer = join(f.taskDir, "environment-contracts.current.json");
  const subPointer = join(f.taskDir, "environment-contracts", "environment-contracts.current.json");
  assert.ok(existsSync(rootPointer), "fixture 前提：新布局指针在根");
  mkdirSync(join(f.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(subPointer, readFileSync(rootPointer, "utf8"));
  rmSync(rootPointer, { force: true });
  assert.ok(!existsSync(rootPointer) && existsSync(subPointer), "fixture 前提：旧布局（只有子目录指针）");
  // 重跑 --write：resolver 读旧布局（readCurrentPointer 兼容）并把指针迁回根
  const second = runResolverWrite(f.home, f.taskDir, f.proj);
  assert.equal(second.status, 0, `迁移重跑应成功：${second.stderr}`);
  assert.ok(existsSync(rootPointer), "重跑 --write 后指针应迁回 taskDir 根");
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `迁移后 D0 编译应放行：${r.stderr}`);
  assert.ok(!r.stderr.includes("缺权威环境契约快照指针"), "迁移后不得报缺快照指针");
});

test("接缝一（旧布局不重解析）：只有子目录旧布局指针且不重跑 resolve 时 D0 编译响亮失败且恢复动作指向重跑 resolve", (t) => {
  // 已落定的兼容语义（代码线 parity 测试同口径）：旧布局的兼容发生在「重跑 resolve --write
  // 迁移指针」这一写入侧；D0 读侧不猜路径——纯旧布局（不重解析）按缺失处理，但必须
  // 响亮失败并给出可操作恢复动作，不得静默放行或静默误判
  const f = makeContractFixture(t, {
    acceptance: npmAcceptance(),
    increments: contractIncrements(),
    snapshot: false,
    detectorOutput: { candidates: [], unresolved: [] },
  });
  overlayNpmProject(f, f.home);
  writeFileSync(join(f.taskDir, "events.jsonl"), "");
  const first = runResolverWrite(f.home, f.taskDir, f.proj);
  assert.equal(first.status, 0, `resolver --write 应成功：${first.stderr}`);
  // 只留子目录旧布局指针（不重跑 resolve）
  const rootPointer = join(f.taskDir, "environment-contracts.current.json");
  const subPointer = join(f.taskDir, "environment-contracts", "environment-contracts.current.json");
  mkdirSync(join(f.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(subPointer, readFileSync(rootPointer, "utf8"));
  rmSync(rootPointer, { force: true });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `纯旧布局应拒绝编译：${r.stderr}`);
  assert.ok(r.stderr.includes("缺权威环境契约快照指针"), "须点名缺指针（不静默放行）");
  assert.ok(r.stderr.includes("resolve-external-contracts.mjs"), "恢复动作须指向重跑 resolve --write 迁移指针");
  assert.ok(!existsSync(f.execPath), "拒绝时不得生成 exec-plan");
});

// ── E. 接缝三：真实 detect 输出喂 D0 复扫与 gate evaluate 前置，两侧判定一致 ──

/** gate 任务 fixture（init + 验收包 + 增量 + 策略快照）；evaluate 复扫前置的消费侧 */
function makeGateTaskFixture(t, { projectRoot, acceptance }) {
  const home = mkdtempSync(join(tmpdir(), "crg-gate-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const intentPath = join(home, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册命令\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", projectRoot, "--task-id", "crg-seam", "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const taskDir = JSON.parse(parseStdout(init)).taskDir;
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  const acc = JSON.parse(JSON.stringify(acceptance));
  acc.projectRoot = task.projectRoot;
  acc.taskId = task.taskId;
  writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(acc, null, 2)}\n`);
  writeFileSync(join(taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(GATE_MODULE.runGateCommand(["snapshot-policy", "--task-dir", taskDir], home), "snapshot-policy 应成功");
  return { home, taskDir, creds: JSON.parse(parseStdout(init)).credentials };
}

/** gate 侧验收包：register-command 能力（capabilityClasses / essential 可控），断言绑定该能力 */
function gateAcceptance({ capabilityClasses = ["register-command"], essential = true } = {}) {
  return {
    schemaVersion: 2,
    acceptanceVersion: 1,
    objective: "扩展在真实宿主注册并分发命令",
    nonGoals: [],
    riskLevel: "high",
    exploratoryReview: "required",
    reviewDimensions: ["外部契约"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "命令在真实宿主注册并可分发", required: true, riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{
        id: "A1", statement: "命令按真实宿主规则注册", qualifiers: ["真实宿主"], given: "真实宿主装载扩展", when: "调用 registerCommand", then: "命令进入注册表",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
        requiredEnvironment: { kind: "real-host", capability: "register-command" },
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "host", initialState: "已装载", operation: "用单对象调用注册", timing: "命令期", expected: "注册失败被观察", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: "EC-demo-host",
      essential,
      authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
      capabilities: [
        { id: "register-command", minEnvironment: "real-host", observable: "命令经真实宿主注册并分发", surfaceRefs: ["dist/host.d.ts#registerCommand"], detectionClasses: capabilityClasses },
      ],
    }],
    externalContractReview: { detectionSha256: "c".repeat(64), dispositions: [{ candidateId: "candidate-pkg-fake-host-sdk", disposition: "bound", contractId: "EC-demo-host" }] },
  };
}

/** 在编译 fixture 项目里写入真实 registerCommand 调用（真实探测器的 strong 信号源） */
function writeRegisterCommandSource(proj) {
  writeFileSync(join(proj, "src", "extension.mjs"), [
    'import * as pi from "fake-host-sdk";',
    "export default function activate(ctx) {",
    '  pi.registerCommand("memory", { handler: () => 1 });',
    "  return 1;",
    "}",
    "",
  ].join("\n"));
  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  assert.equal(git(["add", "."]).status, 0, "git add 失败");
  assert.equal(git(["commit", "-qm", "registerCommand source"]).status, 0, "git commit 失败");
}

test("接缝三（detector→两侧对拍）：register-command 蕴含 dispatch-command 未覆盖——D0 复扫与 gate evaluate 前置同判拒绝", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ capabilityClasses: ["register-command"] }), // 缺 dispatch-command
    increments: contractIncrements(),
    snapshot: true,
    realDetector: true,
  });
  writeRegisterCommandSource(f.proj);
  const acc = contractAcceptance({ capabilityClasses: ["register-command"] });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-pkg-fake-host-sdk", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  // D0 侧：真实探测器输出 → 复扫判定（蕴含观察类 dispatch-command 未覆盖 → 拒绝）
  const d0 = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(d0.status, 1, `D0 侧应拒绝：${d0.stderr}`);
  assert.ok(d0.stderr.includes("D0 外部契约复扫未过"), "D0 侧走复扫缺口通道");
  assert.ok(d0.stderr.includes("dispatch-command"), "D0 侧须点名蕴含观察类缺口");
  // gate 侧：同一真实探测器输出 → evaluate 前置复扫（未登记 strong 信号 → 拒绝）
  const gate = makeGateTaskFixture(t, { projectRoot: f.projReal, acceptance: gateAcceptance({ capabilityClasses: ["register-command"] }) });
  const evaluated = GATE_MODULE.runGateCommand(["evaluate", "--task-dir", gate.taskDir], gate.home, {
    DELIVERY_EXTERNAL_CONTRACT_DETECTOR: DETECTOR,
    DELIVERY_EXTERNAL_CONTRACT_RESOLVER: RESOLVER,
  });
  assert.notEqual(evaluated.status, 0, `gate 侧应拒绝：${evaluated.stderr}${evaluated.stdout}`);
  // 拒绝出口二选一（均为复扫口径的消费端，措辞不同但判定同源）：
  //   ① loadWorld 结构检查：声明 register-command 但能力清单未覆盖蕴含的 dispatch-command；
  //   ② evaluate 前置复扫：未登记 strong 信号（缺调用类 dispatch-command）
  assert.match(evaluated.stderr, /dispatch-command/, "gate 侧拒绝须点名蕴含观察类缺口");
  assert.ok(/未登记 strong 信号|蕴含 dispatch-command 观察义务/.test(evaluated.stderr), "gate 侧拒绝须走复扫口径通道");
});

test("接缝三（detector→两侧对拍）：调用类与蕴含观察类全覆盖——D0 复扫与 gate evaluate 前置同判放行", (t) => {
  const full = ["register-command", "dispatch-command", "extension-entrypoint"];
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ capabilityClasses: full }),
    increments: contractIncrements(),
    snapshot: true,
    realDetector: true,
  });
  writeRegisterCommandSource(f.proj);
  const acc = contractAcceptance({ capabilityClasses: full });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-pkg-fake-host-sdk", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  // D0 侧放行（含复扫段）
  const d0 = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(d0.status, 0, `D0 侧应放行：${d0.stderr}`);
  assert.ok(!d0.stderr.includes("复扫未过"), "D0 侧复扫应通过");
  // gate 侧放行：前置复扫不拒（evaluate 继续走完并出 verdict——draft 态无批准，属预期）
  const gate = makeGateTaskFixture(t, { projectRoot: f.projReal, acceptance: gateAcceptance({ capabilityClasses: full }) });
  const evaluated = GATE_MODULE.runGateCommand(["evaluate", "--task-dir", gate.taskDir], gate.home, {
    DELIVERY_EXTERNAL_CONTRACT_DETECTOR: DETECTOR,
    DELIVERY_EXTERNAL_CONTRACT_RESOLVER: RESOLVER,
  });
  ok(evaluated, "gate 侧 evaluate 应成功（前置复扫放行）");
  assert.ok(!/未登记 strong 信号|未解外部访问/.test(evaluated.stderr), "gate 侧不得报复扫拒绝");
});

// ── F. D3 强制 essential：optional 契约被强信号命中后 probe 门按 essential 判定（样例 22 D3 侧）──

test("D3 复扫（CLI）：optional 契约被 strong 信号强制 essential 后，无 runtime-probe 节点 → 拒绝候选完成", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ essential: false }), // 验收标 optional
    increments: contractIncrements(),
    snapshot: true,
    planOverrides: { withProbeRow: false }, // T3 未登记 runtime-probe 行
    detectorOutput: {
      candidates: [{ id: "candidate-cmd", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }],
      unresolved: [],
    },
  });
  const acc = contractAcceptance({ essential: false });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-cmd", disposition: "bound", contractId: "EC-demo-host" }];
  f.rewriteAcceptance(acc);
  // D0 放行（optional + 强信号 → 强制按 essential：冒烟增量与 spike DAG 照常满足）
  const d0 = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(d0.status, 0, `D0 编译应放行：${d0.stderr}`);
  assert.ok(/按 essential 处理|强制按 essential/.test(d0.stdout), "D0 摘要须披露 optional 契约被强制按 essential 处理");
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]).status, 0, "acceptance 编译前置");
  // D3：essentialIds = 声明 essential ∪ 强制 essential —— 强制升级的契约同样受 probe 门约束
  const r = runMjsScript(RESCAN_CLI, ["--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
    env: { ...process.env, HOME: f.home, RESCAN_FIXTURE: join(f.taskDir, "detector-output.json") },
    cwd: f.proj,
  });
  assert.equal(r.status, 1, `D3 应拒绝：${r.stdout}`);
  assert.ok(r.stdout.includes("未编译任何 runtime-probe 验收节点"), "须点名 probe 节点缺失");
  assert.ok(r.stdout.includes("EC-demo-host"), "essential 契约清单须含被强制升级的 optional 契约");
});

// ── G. 接缝二：gate→IA 降档维度（真实 record-exploration 覆盖检查 × 验收侧维度约束）──

/** gate 任务 fixture（init + 验收包 + 增量 + 策略快照），支持显式 deliveryProfile */
function makeProfileTaskFixture(t, { profile = "a", reviewDimensions, projectRoot }) {
  const home = mkdtempSync(join(tmpdir(), "crg-prof-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const intentPath = join(home, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册命令\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", projectRoot, "--task-id", "crg-prof", "--intent-file", intentPath, "--delivery-profile", profile], home);
  ok(init, `init --delivery-profile ${profile} 应成功`);
  const taskDir = JSON.parse(parseStdout(init)).taskDir;
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  const acc = gateAcceptance({ capabilityClasses: ["register-command", "dispatch-command"], essential: false });
  acc.projectRoot = task.projectRoot;
  acc.taskId = task.taskId;
  acc.reviewDimensions = reviewDimensions;
  // 候选快照（空候选）+ detectionSha256 实算对账（validate 声明层检查的输入）
  const candDir = join(taskDir, "evidence", "acceptance-v1");
  mkdirSync(candDir, { recursive: true });
  writeFileSync(join(candDir, "external-contract-candidates.json"), `${JSON.stringify({ schemaVersion: 1, inputHashes: { intent: sha256("intent") }, candidates: [], unresolved: [] }, null, 2)}\n`);
  acc.externalContractReview.detectionSha256 = sha256(readFileSync(join(candDir, "external-contract-candidates.json"), "utf8"));
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-manual", disposition: "manual", contractId: "EC-demo-host", rationale: "intent 明示外部宿主，项目尚无源码与 manifest 信号，由 reviewer 依语义补充登记" }];
  writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(acc, null, 2)}\n`);
  writeFileSync(join(taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(GATE_MODULE.runGateCommand(["snapshot-policy", "--task-dir", taskDir], home), "snapshot-policy 应成功");
  return { home, taskDir, creds: JSON.parse(parseStdout(init)).credentials };
}

test("接缝二（验收侧维度约束）：profile=a + 契约任务 reviewDimensions 超出降档两类 → validate-acceptance 拒绝", (t) => {
  const project = mkdtempSync(join(tmpdir(), "crg-prof-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], { cwd: project });
  const gate = makeProfileTaskFixture(t, { profile: "a", reviewDimensions: ["外部契约", "故障形态", "状态机时序"], projectRoot: realpathSync(project) });
  const r = GATE_MODULE.runGateCommand(["validate-acceptance", "--task-dir", gate.taskDir], gate.home);
  assert.notEqual(r.status, 0, `超两类维度应被拒：${r.stderr}`);
  assert.match(r.stderr, /reviewDimensions 只能取/, "须点名 a 级维度收窄约束");
  assert.match(r.stderr, /状态机时序/, "须点名超出的维度");
  assert.match(r.stderr, /set-delivery-profile/, "恢复动作须给改分级出路");
});

test("接缝二（降档后可过 gate）：reviewDimensions 收窄为降档两类后，IA 降档维度可过 record-exploration 覆盖检查", (t) => {
  const project = mkdtempSync(join(tmpdir(), "crg-prof-proj2-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], { cwd: project });
  const projectReal = realpathSync(project);
  const narrowed = ["外部契约", "故障形态"]; // = independent-assurance-v6 的 PROFILE_A_DIMENSIONS
  const gate = makeProfileTaskFixture(t, { profile: "a", reviewDimensions: narrowed, projectRoot: projectReal });
  // 收窄后 validate-acceptance 放行（维度约束侧）
  ok(GATE_MODULE.runGateCommand(["validate-acceptance", "--task-dir", gate.taskDir], gate.home), "收窄为两类后 validate 应放行");
  // IA 降档维度（effectiveReviewDimensions = PROFILE_A_DIMENSIONS）登记 ExplorationCompleted：
  // gate 的 coversDimensions 覆盖检查放行（两侧词表一致）
  mkdirSync(join(gate.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(gate.taskDir, "evidence", "explore.md"), "# 探索\n");
  const revision = GATE_MODULE.runGateCommand(["revision", "--project-root", projectReal], gate.home).stdout.trim();
  const recorded = GATE_MODULE.runGateCommand(["record-exploration", "--task-dir", gate.taskDir, "--summary", "探索",
    "--dimensions", JSON.stringify(narrowed), "--coverage-manifest-sha256", sha256("cov"),
    "--artifact", "evidence/explore.md", "--revision", revision, "--credential", gate.creds.assurance], gate.home);
  ok(recorded, "IA 降档维度应过 gate 覆盖检查");
  // 反向对照：缺一个验收维度的申报被覆盖检查拒绝（响亮失败——覆盖检查是活的）；
  // 超集申报允许（设计口径：允许同时申报验收外额外维度），故负向样本取「缺项」而非「多项」
  const missing = GATE_MODULE.runGateCommand(["record-exploration", "--task-dir", gate.taskDir, "--summary", "探索",
    "--dimensions", JSON.stringify(["外部契约"]), "--coverage-manifest-sha256", sha256("cov2"),
    "--artifact", "evidence/explore.md", "--revision", revision, "--credential", gate.creds.assurance], gate.home);
  assert.notEqual(missing.status, 0, "缺验收维度的申报应被覆盖检查拒绝");
  assert.match(missing.stderr, /未完整覆盖 acceptance.reviewDimensions/, "须点名维度覆盖缺口");
});

// ── H. evaluate 侧守门：accepted 公式 runtime 三区块 / 强制 essential / 基线预算 ──

const STUB_RESOLVER = `#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const path = process.env.STUB_RESOLVER_SNAPSHOT;
const args = process.argv.slice(2);
const taskDirIndex = args.indexOf("--task-dir");
const taskDir = taskDirIndex >= 0 ? args[taskDirIndex + 1] : null;
if (path && existsSync(path)) {
  const text = readFileSync(path, "utf8");
  process.stdout.write(text);
  // 模拟 resolve --write 的落盘产物：按哈希分文件的快照 + current 指针（批准基线对账的输入）
  if (taskDir) {
    try {
      const doc = JSON.parse(text);
      const dir = join(taskDir, "environment-contracts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, doc.snapshotSha256 + ".json"), text);
      writeFileSync(join(dir, "environment-contracts.current.json"), JSON.stringify({ snapshotSha256: doc.snapshotSha256 }, null, 2));
    } catch {}
  }
} else {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, contracts: [], snapshotSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
}
`;
const STUB_DETECTOR = `#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const path = process.env.STUB_DETECTOR_CANDIDATES;
if (path && existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
else process.stdout.write(JSON.stringify({ schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] }));
`;

const EVAL_CONTRACT_ID = "EC-host";
const EVAL_CAPABILITY_ID = "register-tool-and-invoke";
const EVAL_AUTHORITY_HASH = sha256("authority-v1");

/** evaluate 侧 fixture：init + git 项目 + 桩 resolver/detector（形态照 runtime-obligations-v6） */
function makeEvalFixture(t, { taskId = "crg-eval" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crg-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  const stubDir = join(root, "stubs");
  mkdirSync(projectDir);
  mkdirSync(home);
  mkdirSync(stubDir);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  appendFileSync(join(projectDir, ".git", "config"), "[user]\n\temail = t@t\n\tname = t\n");
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectDir });
  writeFileSync(join(stubDir, "resolve-external-contracts.mjs"), STUB_RESOLVER);
  writeFileSync(join(stubDir, "detect-external-contracts.mjs"), STUB_DETECTOR);
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册工具\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return {
    root, projectDir, home, taskDir: output.taskDir, creds: output.credentials, stubDir,
    env: {
      DELIVERY_EXTERNAL_CONTRACT_RESOLVER: join(stubDir, "resolve-external-contracts.mjs"),
      DELIVERY_EXTERNAL_CONTRACT_DETECTOR: join(stubDir, "detect-external-contracts.mjs"),
    },
  };
}

// gate 侧快照身份复算（delivery-gate.mjs environmentSnapshotStableFacts 的测试镜像，与
// resolver stableContractFacts 同源）：手写快照 fixture 的文件名必须用本函数计算——gate 读取
// 快照时重算内容规范哈希与文件名对账，文件名与内容不符即拒（照 external-contracts-v6 同款）
const canonicalJsonOf = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonOf).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonOf(value[key])}`).join(",")}}`;
};
const snapshotShaOf = (contracts) => sha256(canonicalJsonOf(contracts.map((contract) => {
  const resolver = contract.resolver ?? {};
  return {
    id: contract.id,
    status: contract.status,
    resolver: { kind: resolver.kind, locator: resolver.locator, resolution: resolver.resolution },
    identity: contract.identity,
    surfaces: contract.surfaces,
    aggregateHash: contract.aggregateHash,
  };
})));

function evalWriteSnapshot(fx, contracts, snapshotSha256 = null) {
  // 缺省文件名哈希 = 内容稳定事实规范哈希（gate 读快照时身份复核，手写假哈希会被拒）
  const sha = snapshotSha256 ?? snapshotShaOf(contracts);
  const path = join(fx.root, "snapshot.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, contracts, snapshotSha256: sha }, null, 2)}\n`);
  fx.env.STUB_RESOLVER_SNAPSHOT = path;
  return sha;
}

function evalWriteCandidates(fx, candidates) {
  const dir = join(fx.taskDir, "evidence", "acceptance-v1");
  mkdirSync(dir, { recursive: true });
  const document = { schemaVersion: 1, inputHashes: { intent: sha256("intent") }, candidates, unresolved: [] };
  const path = join(dir, "external-contract-candidates.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  fx.env.STUB_DETECTOR_CANDIDATES = path; // 探测替身读它（evaluate 前置复扫的强信号来源）
  return sha256(readFileSync(path, "utf8"));
}

function evalWritePackage(fx, { capabilities, essential, candidates }) {
  const detectionSha256 = evalWriteCandidates(fx, candidates);
  const acceptance = {
    schemaVersion: 2, acceptanceVersion: 1, taskId: basename(fx.taskDir), projectRoot: realpathSync(fx.projectDir),
    objective: "扩展装载并注册工具", nonGoals: [], riskLevel: "high", exploratoryReview: "required", reviewDimensions: ["smoke"],
    requirements: [{
      id: "R1", kind: "invariant", statement: "工具在真实宿主注册并可调用", required: true, riskAcceptable: false,
      evidenceKinds: ["command", "inspection"],
      assertions: [{
        id: "A1", statement: "工具按宿主签名执行并返回宿主可消费的结果对象", qualifiers: ["真实宿主"], given: "真实 official-runner 装载扩展", when: "调用工具", then: "返回结果对象",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"],
        requiredEnvironment: { kind: "official-runner", capability: EVAL_CAPABILITY_ID },
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "按错误签名调用", timing: "命令期", expected: "被真实宿主拒绝", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: EVAL_CONTRACT_ID, essential, authorityRequest: { resolverKind: "installed-npm-package", locator: "@scope/host" },
      capabilities,
    }],
    externalContractReview: {
      detectionSha256,
      dispositions: candidates.map((candidate) => candidate.id === "candidate-host"
        ? { candidateId: "candidate-host", disposition: "bound", contractId: EVAL_CONTRACT_ID }
        : { candidateId: candidate.id, disposition: "not-external", rationale: "纯进程内库，无宿主生命周期" }),
    },
  };
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  return acceptance;
}

const evalCapability = () => ({
  id: EVAL_CAPABILITY_ID, minEnvironment: "official-runner", observable: "真实工具按宿主调用签名执行，返回宿主可消费的结果对象",
  surfaceRefs: ["dist/types.d.ts#ToolDefinition"], detectionClasses: ["register-tool", "invoke-tool"],
});

/** 推进到「已批准 + 方案确认 + 实现 + 探索 + 保证」（probe 证据由调用方决定是否登记） */
function driveToAssured(fx, { essential, candidates }) {
  evalWriteSnapshot(fx, [{ id: EVAL_CONTRACT_ID, status: "resolved", authorityAggregateHash: EVAL_AUTHORITY_HASH, identity: { name: "host", version: "1.1.0" }, surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256("t") }], snapshotSha256: sha256("s") }]);
  mkdirSync(join(fx.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(fx.projectDir, "scripts", "runtime-probe.mjs"), "// runtime probe driver\n");
  evalWritePackage(fx, { capabilities: [evalCapability()], essential, candidates });
  const gate = (args) => GATE_MODULE.runGateCommand(args, fx.home, fx.env);
  ok(gate(["validate-acceptance", "--task-dir", fx.taskDir]), "验收包应合法");
  ok(gate(["snapshot-policy", "--task-dir", fx.taskDir]));
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(fx.taskDir, "evidence", "acceptance-review-v1.md"), "# review\n");
  ok(gate(["record-review", "--task-dir", fx.taskDir, "--conclusion", "pass", "--summary", "通过", "--credential", fx.creds.assurance]));
  ok(gate(["approve-acceptance", "--task-dir", fx.taskDir, "--confirmation", "user-explicit", "--summary", "批准", "--credential", fx.creds.user]));
  const solution = "evidence/solution.md";
  writeFileSync(join(fx.taskDir, solution), "# 方案\n");
  writeFileSync(join(fx.taskDir, "evidence", "package.json"), `${JSON.stringify([{ name: "solution.md", sha256: sha256(readFileSync(join(fx.taskDir, solution), "utf8")) }])}\n`);
  ok(gate(["record-design-approved", "--task-dir", fx.taskDir, "--summary", "方案", "--package-file", join(fx.taskDir, "evidence", "package.json"), "--credential", fx.creds.user]));
  writeFileSync(join(fx.projectDir, "a.txt"), "two\n");
  spawnSync("git", ["add", "."], { cwd: fx.projectDir });
  spawnSync("git", ["commit", "-qm", "impl I1"], { cwd: fx.projectDir });
  const revision = gate(["revision", "--project-root", fx.projectDir]).stdout.trim();
  writeFileSync(join(fx.taskDir, "evidence", "explore.md"), "# 探索\n");
  ok(gate(["record-exploration", "--task-dir", fx.taskDir, "--summary", "探索", "--dimensions", JSON.stringify(["smoke"]),
    "--coverage-manifest-sha256", sha256("cov"), "--artifact", "evidence/explore.md", "--revision", revision,
    "--credential", fx.creds.assurance]));
  writeFileSync(join(fx.taskDir, "evidence", "impl-I1.md"), "# 实现\n");
  ok(gate(["record-implementation", "--task-dir", fx.taskDir, "--increment-id", "I1", "--summary", "实现",
    "--artifact", "evidence/impl-I1.md", "--merge-receipt", JSON.stringify({ fromRevision: gate(["revision", "--project-root", fx.projectDir]).stdout.trim(), toRevision: revision, patchSha256: sha256("patch") }),
    "--revision", revision, "--credential", fx.creds.builder]));
  return revision;
}

/** 登记 runtime probe 证据 + full 保证 */
function recordProbeEvidence(fx, revision) {
  const document = {
    environment: {
      kind: "official-runner", name: "host", version: "1.1.0", source: "@scope/host dist/types.d.ts",
      sourceHash: EVAL_AUTHORITY_HASH, driver: "scripts/runtime-probe.mjs", driverHash: sha256(readFileSync(join(fx.projectDir, "scripts", "runtime-probe.mjs"), "utf8")), capabilities: [EVAL_CAPABILITY_ID],
    },
    subject: { revision, entrypoint: "dist/index.js" },
    cases: [{ capabilityId: EVAL_CAPABILITY_ID, operation: "按真实宿主签名调用工具", observed: { called: true, resultAccepted: true }, passed: true }],
    summary: { passed: 1, failed: 0, skipped: 0 },
  };
  writeFileSync(join(fx.taskDir, "evidence", "runtime-probe.json"), `${JSON.stringify(document, null, 2)}\n`);
  const gate = (args) => GATE_MODULE.runGateCommand(args, fx.home, fx.env);
  const appended = gate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "command",
    "--result", "verified", "--summary", "runtime probe 观察", "--artifact", "evidence/runtime-probe.json",
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--contract-capability-ids", JSON.stringify([`${EVAL_CONTRACT_ID}:${EVAL_CAPABILITY_ID}`]), "--runtime-probe",
    "--revision", revision, "--credential", fx.creds.assurance]);
  ok(appended, "runtime probe 证据应登记");
  const eventId = JSON.parse(parseStdout(appended)).eventId;
  const inspectionArtifact = "ev-inspection.json";
  // 审查证据也带 environment 元数据（机制二 §8.1 环境真实性：缺元数据的证据最多 partial）
  writeFileSync(join(fx.taskDir, "evidence", inspectionArtifact), `${JSON.stringify({
    summary: "审查证据",
    environment: { kind: "official-runner", name: "host", version: "1.1.0", source: "@scope/host", sourceHash: EVAL_AUTHORITY_HASH, driver: "scripts/runtime-probe.mjs", capabilities: [EVAL_CAPABILITY_ID] },
  }, null, 2)}\n`);
  const inspection = gate(["record-evidence", "--task-dir", fx.taskDir, "--requirement-id", "R1", "--kind", "inspection",
    "--result", "verified", "--summary", "审查取证", "--artifact", `evidence/${inspectionArtifact}`,
    "--assertion-ids", JSON.stringify(["A1"]), "--adversarial-form-ids", JSON.stringify(["AF1"]),
    "--revision", revision, "--credential", fx.creds.assurance]);
  ok(inspection, "审查证据登记");
  const explorationId = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "ExplorationCompleted").eventId;
  writeFileSync(join(fx.taskDir, "evidence", "assurance-full.md"), "# 保证\n");
  ok(gate(["complete-assurance", "--task-dir", fx.taskDir, "--mode", "full",
    "--summary", "首次完整保证", "--evidence-event-ids", JSON.stringify([eventId, JSON.parse(parseStdout(inspection)).eventId]),
    "--coverage-manifest-sha256", sha256("cov"), "--exploration-event-id", explorationId,
    "--increment-receipts", JSON.stringify([{ incrementId: "I1", program: "true", args: [], exitCode: 0, logSha256: sha256("log"), cwd: fx.projectDir, artifactSha256: sha256("receipt") }]),
    "--artifact", "evidence/assurance-full.md", "--revision", revision,
    "--credential", fx.creds.assurance]), "full 保证登记");
  return eventId;
}

const evaluateVerdict = (fx) => {
  const result = GATE_MODULE.runGateCommand(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env);
  ok(result, "evaluate 应成功");
  return JSON.parse(parseStdout(result));
};

const STRONG_CANDIDATE = [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }];
const WEAK_CANDIDATE = [{ id: "candidate-lib", strength: "weak", signals: ["intent:plugin"] }];

test("accepted 公式 runtime 三区块承重：唯一缺口是 runtime 义务 → state=candidate 且恢复动作可操作；probe 齐备才 accepted（审查发现 1）", async (t) => {
  // 证据全 verified、保证完整、无未决发现，唯一缺口 = 缺 runtime probe 证据
  const fx = makeEvalFixture(t, { taskId: "crg-eval-b1" });
  const revision = driveToAssured(fx, { essential: true, candidates: STRONG_CANDIDATE });
  const blocked = evaluateVerdict(fx);
  // 义务块可观测：openObligations 含 kind=runtime 条目，恢复动作指向重跑 probe 且明示不可豁免
  const openRuntime = blocked.missing.openObligations.find((item) => item.kind === "runtime");
  assert.ok(openRuntime !== undefined, "runtime 义务必须进 missing.openObligations（义务块承重）");
  assert.equal(openRuntime.contractId, EVAL_CONTRACT_ID);
  assert.match(openRuntime.recovery ?? "", /record-evidence --runtime-probe/, "恢复动作须指向真实环境重跑 probe");
  assert.match(openRuntime.recovery ?? "", /runtime 义务没有豁免通道/, "恢复动作须明示不可豁免");
  // readiness 块可观测：overall=not-established（非 unknown——缺证据是确定的未建立）
  assert.equal(blocked.runtimeReadiness.overall, "not-established", "readiness 块承重：无 probe 不得判 established");
  // 终态：两个交付终态都到不了
  assert.equal(blocked.state, "candidate", "唯一缺口是 runtime 义务时 state=candidate");
  assert.notEqual(blocked.state, "accepted");
  assert.notEqual(blocked.state, "accepted_with_risk");
  // 对照：同一 fixture 补 probe 证据 → accepted（成对断言证明上述区块是承重机制而非恒真装饰）
  recordProbeEvidence(fx, revision);
  const passed = evaluateVerdict(fx);
  assert.equal(passed.runtimeReadiness.overall, "established");
  assert.equal(passed.state, "accepted", "probe 齐备且其余条件满足时应 accepted");
});

test("evaluate 侧强制 essential：optional 契约 + 强信号候选 + 无 probe → 义务 required 且不得 accepted（审查发现 9）", async (t) => {
  const fx = makeEvalFixture(t, { taskId: "crg-eval-b6" });
  // 契约自报 optional；候选 strong 信号 call-class:register-tool 被能力 detectionClasses 覆盖
  // （前置复扫放行——拒绝点不在「未登记」，而在「强制 essential 后义务 required」）
  const revision = driveToAssured(fx, { essential: false, candidates: STRONG_CANDIDATE });
  const verdict = evaluateVerdict(fx);
  const openRuntime = verdict.missing.openObligations.find((item) => item.kind === "runtime");
  assert.ok(openRuntime !== undefined, "强信号命中的 optional 契约能力必须派生 runtime 义务");
  // missing.openObligations = openRequired（required && open 的过滤结果）——成员身份即
  // 证明 required=true：非 required 的 open 义务不会进这个清单（设计 §4.1：机器强制按
  // essential 处理，不看契约自报的 optional）
  assert.equal(openRuntime.contractId, EVAL_CONTRACT_ID);
  assert.equal(openRuntime.readiness, "not-established", "义务 readiness 须为 not-established（无 probe 是确定的未建立）");
  // readiness 侧同样把该契约算作 effectively essential
  const contract = verdict.runtimeReadiness.contracts.find((entry) => entry.contractId === EVAL_CONTRACT_ID);
  assert.equal(contract.essential, true, "readiness 契约级 essential 标记须反映强制升级");
  assert.notEqual(verdict.state, "accepted", "optional 契约被实际使用（强信号）且无 probe → 不得 accepted");
  assert.notEqual(verdict.state, "accepted_with_risk");
});

test("evaluate 侧基线预算可达性：手改两条 EnvironmentBaselineConfirmed → evaluate 拒绝（审查发现 10）", async (t) => {
  const fx = makeEvalFixture(t, { taskId: "crg-eval-b7" });
  const revision = driveToAssured(fx, { essential: true, candidates: STRONG_CANDIDATE });
  recordProbeEvidence(fx, revision);
  // 对照：单条基线确认合法（命令层登记一次）——新环境快照文件先落盘（命令校验其存在）；
  // 文件名哈希 = 内容稳定事实规范哈希（gate 读快照时身份复核，手写假哈希会被拒）
  const newSnapshotContracts = [{ id: EVAL_CONTRACT_ID, status: "resolved", authorityAggregateHash: sha256("authority-v2"), identity: { name: "host", version: "2.0.0" }, surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256("t2") }], snapshotSha256: sha256("s2") }];
  const newSnapSha = snapshotShaOf(newSnapshotContracts);
  mkdirSync(join(fx.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(join(fx.taskDir, "environment-contracts", `${newSnapSha}.json`), `${JSON.stringify({
    schemaVersion: 1, snapshotSha256: newSnapSha,
    contracts: newSnapshotContracts,
  }, null, 2)}\n`);
  ok(GATE_MODULE.runGateCommand(["confirm-environment-baseline", "--task-dir", fx.taskDir, "--contract-ids", JSON.stringify([EVAL_CONTRACT_ID]),
    "--new-authority-snapshot-sha256", newSnapSha, "--credential", fx.creds.user], fx.home, fx.env), "首次基线确认应成功");
  assert.equal(evaluateVerdict(fx).state, "accepted", "单条基线确认不影响 accepted（对照）");
  // 手改第二条 EnvironmentBaselineConfirmed（绕过命令层单防线）——evaluate 侧预算规则必须拒绝
  const task = JSON.parse(readFileSync(join(fx.taskDir, "task.json"), "utf8"));
  const keyPath = `${join(fx.home, ".agents", "skill-data", "delivery-keys", ...fx.creds.user.split("/"))}.key`;
  const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  const lines = readFileSync(join(fx.taskDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  const event = {
    type: "EnvironmentBaselineConfirmed",
    actor: "user",
    acceptanceVersion: 1,
    revision,
    summary: "手改第二条基线确认（测试注入：模拟绕过命令层单防线的写入）",
    newAuthoritySnapshotSha256: sha256("new-snap-2"),
    contractIds: [EVAL_CONTRACT_ID],
  };
  const eventId = sha256(canonicalJson(event));
  const signature = sign(null, Buffer.from(canonicalJson(event), "utf8"), privateKey).toString("base64");
  const record = { ...event, seq: lines.length + 1, recordedAt: new Date().toISOString(), eventId, signature };
  appendFileSync(join(fx.taskDir, "events.jsonl"), `${JSON.stringify(record)}\n`);
  const deniedResult = GATE_MODULE.runGateCommand(["evaluate", "--task-dir", fx.taskDir], fx.home, fx.env);
  assert.notEqual(deniedResult.status, 0, `第二条基线确认应被 evaluate 拒绝：${deniedResult.stderr}`);
  assert.match(deniedResult.stderr, /同一验收版本（v1）内登记了 2 次 EnvironmentBaselineConfirmed/, "须点名预算规则（同版本上限 1 次）");
  assert.match(deniedResult.stderr, /恢复动作：/, "拒绝须带恢复动作");
});

// ── I. D3 probe artifact cases 结论核对（§7.3「D3 全绿但 runtime 义务未满足时不能进候选完成」）──
// artifact 落盘可解析只证 JSON 在场；runtime 义务判定输入是 cases（设计 §6.3）——在场 case
// 结论全绿（全部 passed 且无 skipped）才构成 D3 侧放行。cases 与 capability 的覆盖对账归
// gate 义务派生单源，空 cases 数组在此按「无可判 case」放行（compile-contract-gate 用例钉住该边界）。

test("D3 复扫（CLI）：probe cases 有未通过/跳过 case → 拒绝并点名 case id；全绿对照放行", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    planOverrides: { probeFormRefs: ["AF-PROBE-1"] }, // 探针行声明反例场景引用（D3 节点须随行携带）
  });
  // 探针行引用的场景必须在验收包登记 + 配 verificationBindings 测试绑定
  //（check-quality-contract 引用存在性门：acceptancePlan 引用未知场景即拒）
  writeFileSync(
    join(f.proj, "design", "s4-accept.json"),
    `${JSON.stringify({
      criterionMechanisms: [],
      verificationBindings: [{ adversarialFormId: "AF-PROBE-1", testRef: "probe-asset", preconditions: ["真实宿主已装载"], actions: ["按五参签名调用"], assertions: ["注册表含命令"] }],
    }, null, 2)}\n`,
  );
  const acc = contractAcceptance();
  acc.adversarialForms = [{ id: "AF-PROBE-1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "host", initialState: "已装载", operation: "按五参签名调用", timing: "命令期", expected: "注册失败被观察", testAssetRefs: ["probe-asset"], rationale: "签名差异" }];
  f.rewriteAcceptance(acc);
  const d0 = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(d0.status, 0, `D0 编译前置失败：${d0.stderr}`);
  const accepted = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]);
  assert.equal(accepted.status, 0, `acceptance 编译前置失败：${accepted.stderr}`);
  // 接缝回归（任务一并断言）：runtime-probe 行的 adversarialFormRefs 须随行复制到 exec-plan 节点
  const accPlan = JSON.parse(readFileSync(f.execPath, "utf8"));
  assert.deepEqual(accPlan.acceptance.nodes.find((n) => n.runtimeProbe).adversarialFormRefs, ["AF-PROBE-1"], "probe 节点须携带行级反例场景引用");
  mkdirSync(join(f.taskDir, "evidence"), { recursive: true });
  const artifactPath = join(f.taskDir, "evidence", "runtime-probe-A-probe-reg.json");
  const writeArtifact = (document) => writeFileSync(artifactPath, `${JSON.stringify(document)}\n`);
  const runRescan = () =>
    runMjsScript(RESCAN_CLI, ["--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
      env: { ...process.env, HOME: f.home },
      cwd: f.proj,
    });
  // 红 1：passed=false → 拒绝并点名失败 case id（capabilityId）
  writeArtifact({ environment: { kind: "real-host" }, cases: [{ capabilityId: "register-command", operation: "注册命令", observed: { called: false }, passed: false }], summary: { passed: 0, failed: 1, skipped: 0 } });
  const failed = runRescan();
  assert.equal(failed.status, 1, `失败 case 应拒绝：${failed.stdout}`);
  assert.ok(failed.stdout.includes("probe case 未通过") && failed.stdout.includes("register-command"), `须点名失败 case id：${failed.stdout}`);
  assert.ok(failed.stdout.includes("恢复动作"), "拒绝须带恢复动作");
  // 红 2：skipped=true → 拒绝并点名 case id 与理由
  writeArtifact({ environment: { kind: "real-host" }, cases: [{ capabilityId: "register-command", skipped: true, skipReason: "真实宿主不可得" }], summary: { passed: 0, failed: 0, skipped: 1 } });
  const skipped = runRescan();
  assert.equal(skipped.status, 1, `跳过 case 应拒绝：${skipped.stdout}`);
  assert.ok(skipped.stdout.includes("probe case 被 skipped") && skipped.stdout.includes("真实宿主不可得"), `须点名跳过 case 与理由：${skipped.stdout}`);
  // 红 3：cases 非数组 → 义务判定输入缺失拒绝
  writeArtifact({ environment: { kind: "real-host" }, cases: "all-passed", summary: {} });
  const invalid = runRescan();
  assert.equal(invalid.status, 1, `cases 形态非法应拒绝：${invalid.stdout}`);
  assert.ok(invalid.stdout.includes("cases 缺失或形态非法"), `须点名 cases 形态缺口：${invalid.stdout}`);
  // 绿：cases 全部 passed（唯一变量 = artifact 内容——其余复扫段全绿，对照证明门是活的）
  writeArtifact({ environment: { kind: "real-host" }, cases: [{ capabilityId: "register-command", operation: "注册命令", observed: { called: true }, passed: true }], summary: { passed: 1, failed: 0, skipped: 0 } });
  const green = runRescan();
  assert.equal(green.status, 0, `cases 全绿应放行：${green.stdout}${green.stderr}`);
  assert.ok(green.stdout.includes("PASS"), "放行须输出 PASS");
});
