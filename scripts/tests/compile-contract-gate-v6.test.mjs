// compile-contract-gate-v6.test.mjs — D0 外部契约门 / runtime-probe 行 / deliveryProfile 已知答案样例
//
// 被测实现（设计《V6 运行可用性与外部契约守门升级》§7.1 / §7.3 / §13 的 dev-flow 侧接线）：
//   - compile-exec-plan.mjs：外部契约门（缺权威快照 / 缺契约冒烟增量 / 业务单元 DAG 未达
//     spike / D0 复扫拒绝）+ runtime-probe 行编译与 probe wrapper 生成 + deliveryProfile 登记；
//   - check-exec-plan.mjs：runtime-probe 行级与节点级校验（与编译期同源）；
//   - check-contract-rescan.mjs：D0 / D3 复扫判定（D3 侧经 CLI 实跑）。
//
// 用例覆盖：旧任务整门跳过 / 缺快照拒绝 / essential 非 resolved 拒绝 / 缺契约冒烟增量拒绝 /
//   DAG 未达 spike 拒绝 / 全链路编译过（unitKind 传递 + deliveryProfile 登记 + optional 契约
//   强制按 essential 披露）/ acceptance 编译 runtime-probe 行（节点字段 + wrapper 落点 +
//   --check 委托 + 真校验器 --task-dir）/ runtime-probe 行 capabilityIds 不在验收包拒绝 /
//   runtime-probe 行缺 command 拒绝 / 复扫未处置 strong 候选拒绝 / D3 复扫 artifact 未落盘
//   拒绝与落盘后放行 / deliveryProfile 非法值缺口与缺省 b。
//
// 隔离：临时 HOME（os.homedir() 读 HOME 环境变量）+ 临时 git 项目 + 临时交付任务目录。
//   探测 CLI 用替身（临时 HOME 下 ~/.agents/skills/delivery-v6/scripts/detect-external-contracts.mjs，
//   输出经 RESCAN_FIXTURE 环境变量指向的 JSON）——复扫判定逻辑被测，探测器本身归探测线；
//   产物全部落临时目录，测试后删除，不触碰真实 skill-data 与真实任务目录。
//
// 运行：node --test scripts/tests/compile-contract-gate-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPILER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "compile-exec-plan.mjs");
const CHECKER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-exec-plan.mjs");
const RENDERER = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "scripts", "render-impl-plan.mjs");
const RESCAN_CLI = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-contract-rescan.mjs");
const GEN_PROBE_WRAPPER = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "gen-runtime-probe-wrapper.mjs");
const VERIFY_INDEX = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "verification-index.mjs");

// 执行通道：真实 spawn（非进程内转译）——复扫模块经 require(esm) 在 vm 沙箱外加载时
// homedir() 取真实 HOME，探测 CLI 替身（临时 HOME 下）不会被命中；本文件的契约门断言
// 依赖 HOME 注入语义（探测替身 + 产物根隔离），故全走 CLI spawn 通道（与 compile-exec-plan-v6
// 的「进程内转译 == CLI spawn 对拍」用例互为补充：那条守住进程内 == spawn 等价，本条守住 HOME 相关行为）
const runCompiler = (args, { cwd, env }) => {
  const r = spawnSync(process.execPath, [COMPILER, ...args], { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// ── 验收包联合哈希（与 check-exec-plan.mjs 的 acceptancePackageSha256 同源复刻——
//    meta.json acceptanceBinding 的登记值；测试侧只造 fixture，不消费被校逻辑） ──
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
const sha256Text = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// ── fixture 基座 ──

const SNAPSHOT_SHA = "a".repeat(64);
const AGG_HASH = "b".repeat(64);

/** 契约感知验收包（essential 契约 EC-demo-host，两个 capability 覆盖初始调用类） */
function contractAcceptance({ essential = true } = {}) {
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
          { id: "register-command", minEnvironment: "real-host", detectionClasses: ["register-command", "dispatch-command"], surfaceRefs: ["types.d.ts#RegisteredCommand"] },
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

/** 契约任务 impl-plan：spike 单元（kind=contract-spike，归属契约冒烟增量）+ 两个业务单元
 *  经 deps 传递依赖 spike；acceptancePlan 含 runtime-probe 行 + 一行 L3 剧本 + 一行 L4 */
function contractPlan(proj, { businessDepsOnSpike = true, withProbeRow = true } = {}) {
  const plan = {
    name: "demo-contract",
    designDoc: join(proj, "design"),
    baseline: "abcdef1234567890",
    skillVersion: "1.0.0",
    sectionMap: { goal: "§1", mechanism: "§2", acceptance: "§3", breakdown: "§4" },
    units: [
      {
        id: "u-spike",
        responsibility: "契约冒烟 spike",
        territory: ["src/spike/"],
        deps: [],
        isolation: "plain",
        acceptance: ["A0 契约形态确认"],
        decisionTier: "A",
        designRef: "§4.0",
        incrementId: "inc-smoke",
        kind: "contract-spike",
      },
      {
        id: "u-foundation",
        responsibility: "共享契约根",
        territory: ["src/shared/"],
        deps: businessDepsOnSpike ? ["u-spike"] : [],
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
        deps: businessDepsOnSpike ? ["u-foundation"] : ["u-foundation"],
        isolation: "plain",
        acceptance: ["A2 主链路可用"],
        decisionTier: "B",
        designRef: "§4.2",
        incrementId: "inc-2",
      },
    ],
    testPlan: {
      incrementalCommands: [
        { incrementId: "inc-smoke", unitIds: ["u-spike"], command: { program: "node", args: ["--test", "tests/smoke"] } },
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
      id: "A-probe-reg",
      item: "runtime 探针：命令注册与分发",
      level: "L3",
      group: "core",
      deps: [],
      optimization: "可脚本化",
      type: "runtime-probe",
      capabilityIds: ["EC-demo-host:register-command"],
      command: { program: "node", args: ["scripts/probe.mjs"] },
      artifact: "evidence/runtime-probe-A-probe-reg.json",
    });
    plan.acceptancePlan[1].deps = ["A-probe-reg"];
  }
  return plan;
}

/** git 模板仓（init + commit 一次成型）：design stub / 剧本 / probe driver 预置 */
let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "ccg-git-tpl-"));
    const git = (args) => spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: tpl, encoding: "utf8" });
    assert.equal(git(["init", "-q"]).status, 0, "git init 失败");
    mkdirSync(join(tpl, "src", "shared"), { recursive: true });
    mkdirSync(join(tpl, "src", "spike"), { recursive: true });
    mkdirSync(join(tpl, "src", "app"), { recursive: true });
    mkdirSync(join(tpl, "scripts"), { recursive: true });
    mkdirSync(join(tpl, "design"), { recursive: true });
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

/** 探测 CLI 替身：输出 RESCAN_FIXTURE 指向的 JSON（缺省 = 空候选快照） */
function installFakeDetector(home) {
  const dir = join(home, ".agents", "skills", "delivery-v6", "scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "detect-external-contracts.mjs"),
    [
      "import { readFileSync } from 'node:fs';",
      "const out = { schemaVersion: 1, inputHashes: {}, candidates: [], unresolved: [] };",
      "const p = process.env.RESCAN_FIXTURE;",
      "if (p) Object.assign(out, JSON.parse(readFileSync(p, 'utf8')));",
      "process.stdout.write(JSON.stringify(out));",
      "",
    ].join("\n"),
  );
}

/**
 * 构造临时 git 项目 + 临时 HOME + 临时交付任务目录。
 * @param {object} opts
 *   planOverrides  contractPlan 的覆盖项
 *   acceptance     验收包对象（null = 不写 acceptance.json；{legacy:true} = 写无外部契约字段的旧包）
 *   increments     increments.json 内容（null = 不写）
 *   snapshot       true = 写权威快照指针 + 快照文件；"unresolved" = 快照里契约非 resolved；false = 不写
 *   taskMeta       task.json 的 deliveryProfile 值（undefined = 不写 task.json；字符串 = 写）
 *   detectorOutput 探测替身输出（null = 空候选）
 *   writeBinding   true = 写 meta.json acceptanceBinding（默认 true）
 */
function makeContractFixture(t, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "ccg-home-"));
  const proj = mkdtempSync(join(tmpdir(), "ccg-proj-"));
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const taskDir = mkdtempSync(join(tmpdir(), "ccg-task-"));
  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]).stdout.trim();

  installFakeDetector(home);

  const plan = contractPlan(proj, opts.planOverrides ?? {});
  const planPath = join(proj, "demo-contract.impl-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const rendered = spawnSync(process.execPath, [RENDERER, planPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(rendered.status, 0, `fixture 渲染失败：${rendered.stderr}`);

  // 交付任务目录三件套（按 opts 裁剪）
  if (opts.increments !== null) {
    writeFileSync(join(taskDir, "increments.json"), `${JSON.stringify(opts.increments ?? contractIncrements(), null, 2)}\n`);
  }
  if (opts.acceptance !== null && opts.acceptance !== undefined) {
    const acc = opts.acceptance.legacy === true
      ? { schemaVersion: 2, acceptanceVersion: 1, requirements: [{ id: "R1", assertions: [] }], adversarialForms: [] }
      : opts.acceptance;
    writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(acc, null, 2)}\n`);
  }
  if (opts.snapshot === true || opts.snapshot === "unresolved") {
    const dir = join(taskDir, "environment-contracts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SNAPSHOT_SHA}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          snapshotSha256: SNAPSHOT_SHA,
          contracts: [
            {
              id: "EC-demo-host",
              status: opts.snapshot === "unresolved" ? "declared-unavailable" : "resolved",
              resolvedPath: "/opt/demo-host",
              surfaces: [{ surfaceRef: "types.d.ts", sha256: "d".repeat(64) }],
              aggregateHash: AGG_HASH,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, "..", "environment-contracts.current.json"),
      `${JSON.stringify({ schemaVersion: 1, snapshotSha256: SNAPSHOT_SHA, snapshotPath: `environment-contracts/${SNAPSHOT_SHA}.json`, updatedAt: "2026-11-18T00:00:00.000Z" }, null, 2)}\n`,
    );
  }
  if (opts.taskMeta !== undefined) {
    writeFileSync(join(taskDir, "task.json"), `${JSON.stringify({ schemaVersion: 1, deliveryProfile: opts.taskMeta }, null, 2)}\n`);
  }
  writeFileSync(join(taskDir, "intent.md"), "# 意图\n实现 demo 宿主扩展。\n");
  if (opts.detectorOutput !== undefined && opts.detectorOutput !== null) {
    writeFileSync(join(taskDir, "detector-output.json"), `${JSON.stringify(opts.detectorOutput)}\n`);
  }
  // meta.json acceptanceBinding（binding 核对输入；哈希与验收包实算值一致——旧任务同样
  // 要求绑定在场，只是外部契约整门跳过）
  if (opts.writeBinding !== false && opts.acceptance !== null && opts.acceptance !== undefined && opts.increments !== null) {
    const acc = JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8"));
    const inc = JSON.parse(readFileSync(join(taskDir, "increments.json"), "utf8"));
    writeFileSync(
      join(proj, "design", "meta.json"),
      `${JSON.stringify(
        {
          acceptanceBinding: {
            acceptanceVersion: acc.acceptanceVersion,
            acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acc), "increments.json": canonicalJson(inc) })),
            taskDir,
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  const projReal = realpathSync(proj);
  const slug = `${basename(projReal)}-${createHash("sha256").update(projReal).digest("hex").slice(0, 8)}`;
  const productRoot = join(home, ".agents", "skill-data", "dev-flow", slug);
  const execPath = join(productRoot, "demo-contract.exec-plan.json");

  const run = (args, extraEnv = {}) => {
    const env = { ...process.env, HOME: home, ...extraEnv };
    if (opts.detectorOutput !== undefined && opts.detectorOutput !== null) env.RESCAN_FIXTURE = join(taskDir, "detector-output.json");
    return runCompiler(args, { cwd: proj, env });
  };
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { home, proj, projReal, taskDir, planPath, plan, productRoot, execPath, head, run };
}

// ── 用例 ──

test("旧任务（验收包无外部契约字段）：外部契约整门跳过，不读快照不跑探测", (t) => {
  const f = makeContractFixture(t, {
    acceptance: { legacy: true },
    increments: contractIncrements(),
    snapshot: false, // 无快照——旧任务不要求
    planOverrides: {},
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `旧任务编译应放行：${r.stderr}`);
  assert.ok(existsSync(f.execPath), "exec-plan 未生成");
  // 未安装探测替身也应过（整门在探测前跳过）——这里替身已装，改验证摘要无外部契约披露
  assert.ok(!r.stdout.includes("外部契约披露"), "旧任务不应有契约披露");
});

test("缺权威环境契约快照指针：拒绝编译（三段式、未写盘）", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: false, // 契约感知任务但无快照指针
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `缺快照应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("缺权威环境契约快照指针"), `须点名缺快照：${r.stderr}`);
  assert.ok(r.stderr.includes("resolve-external-contracts.mjs"), "恢复动作须给重建命令");
  assert.ok(r.stderr.includes("不合法输入") && r.stderr.includes("权威源") && r.stderr.includes("恢复动作"), "三段式齐全");
  assert.ok(!existsSync(f.execPath), "缺口时不得生成 exec-plan");
  assert.ok(!existsSync(join(f.productRoot, "demo-contract.status.json")), "缺口时不得生成 status.json");
});

test("essential 契约在快照中非 resolved：拒绝编译", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: "unresolved",
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `非 resolved 应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("非 resolved"), `须点名 resolved 缺失：${r.stderr}`);
  assert.ok(r.stderr.includes("不得伪造 resolved"), "恢复动作须含不得伪造");
});

test("essential 契约但缺 kind=contract-smoke 增量：拒绝编译", (t) => {
  const inc = contractIncrements();
  inc.items = inc.items.filter((it) => it.kind !== "contract-smoke"); // 删契约冒烟增量
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: inc, snapshot: true });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `缺契约冒烟增量应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("无 kind=contract-smoke 增量"), `须点名缺冒烟增量：${r.stderr}`);
});

test("业务单元 DAG 未依赖契约 spike 单元：拒绝编译并点名单元", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    planOverrides: { businessDepsOnSpike: false }, // u-foundation 不依赖 u-spike
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `DAG 未达 spike 应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("业务单元 DAG 未依赖契约 spike 单元"), `须点名 DAG 缺口：${r.stderr}`);
  assert.ok(r.stderr.includes("u-foundation"), "须点名未达标业务单元");
  assert.ok(r.stderr.includes("只看 increments 数组顺序不算满足"), "须说明拓扑复算判据");
});

test("D0 复扫拒绝：未处置 strong 候选 → 拒绝编译并回验收修订", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    detectorOutput: {
      candidates: [{ id: "candidate-pkg-x", strength: "strong", signals: ["source:src/app/x.ts:import:x-sdk"], suggestedResolver: "installed-npm-package", suggestedLocator: "x-sdk" }],
      unresolved: [],
    },
  });
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `未处置 strong 候选应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("D0 外部契约复扫未过"), "须走复扫缺口通道");
  assert.ok(r.stderr.includes("candidate-pkg-x 未处置"), "须点名未处置候选");
  assert.ok(r.stderr.includes("递增验收版本"), "恢复动作须指回验收修订");
});

test("全链路 dev 编译：unitKind 传递 + deliveryProfile 登记 + optional 契约强制按 essential 披露", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance({ essential: false }), // 标可选
    increments: contractIncrements(),
    snapshot: true,
    taskMeta: "a",
    // 复扫发现实际使用（bound 强候选）→ 强制按 essential：冒烟增量与 spike DAG 门照常生效
    detectorOutput: {
      candidates: [{ id: "candidate-manifest-pi-extensions", strength: "strong", signals: ["manifest:pi.extensions", "source:src/spike/entry.ts:call-class:extension-entrypoint"] }],
      unresolved: [],
    },
  });
  // 该候选 bound 到 EC-demo-host（能力已覆盖 extension-entrypoint）
  const acc = contractAcceptance({ essential: false });
  acc.externalContractReview.dispositions = [{ candidateId: "candidate-manifest-pi-extensions", disposition: "bound", contractId: "EC-demo-host" }];
  writeFileSync(join(f.taskDir, "acceptance.json"), `${JSON.stringify(acc, null, 2)}\n`);
  // binding 哈希随验收包重写（meta.json 已按旧内容写过——重算覆盖）
  const inc = JSON.parse(readFileSync(join(f.taskDir, "increments.json"), "utf8"));
  writeFileSync(
    join(f.proj, "design", "meta.json"),
    `${JSON.stringify(
      {
        acceptanceBinding: {
          acceptanceVersion: acc.acceptanceVersion,
          acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acc), "increments.json": canonicalJson(inc) })),
          taskDir: f.taskDir,
        },
      },
      null,
      2,
    )}\n`,
  );
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `全链路 dev 编译应过：${r.stderr}`);
  const plan = JSON.parse(readFileSync(f.execPath, "utf8"));
  // unitKind 传递（D2 降档与 DAG 门的消费输入）
  assert.equal(plan.nodes.find((n) => n.id === "u-spike").unitKind, "contract-spike");
  assert.equal(plan.nodes.find((n) => n.id === "u-main").unitKind, undefined, "业务单元不带 spike 标记");
  // deliveryProfile 登记（a 级 D2 降档输入）
  assert.equal(plan.deliveryProfile, "a");
  // 强制按 essential 披露进编译摘要
  assert.ok(r.stdout.includes("外部契约披露"), "编译摘要须披露复扫 note");
  assert.ok(r.stdout.includes("强制按 essential 处理") || r.stdout.includes("按 essential 处理"), "须披露 optional 契约被强制升级");
});

test("deliveryProfile：缺 task.json 缺省 b；非法值报缺口", (t) => {
  const f1 = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  assert.equal(f1.run(["--impl-plan", f1.planPath, "--task-dir", f1.taskDir]).status, 0);
  assert.equal(JSON.parse(readFileSync(f1.execPath, "utf8")).deliveryProfile, "b", "读不到字段缺省 b");
  const f2 = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true, taskMeta: "S" });
  const r2 = f2.run(["--impl-plan", f2.planPath, "--task-dir", f2.taskDir]);
  assert.equal(r2.status, 1, `非法 profile 应拒绝：${r2.stderr}`);
  assert.ok(r2.stderr.includes("deliveryProfile 值非法"), "须点名非法值");
});

test("units[].kind 非契约枚举值：报缺口不静默忽略", (t) => {
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  const plan = JSON.parse(readFileSync(f.planPath, "utf8"));
  plan.units[0].kind = "contract-final";
  writeFileSync(f.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(spawnSync(process.execPath, [RENDERER, f.planPath], { encoding: "utf8" }).status, 0);
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `未知 kind 应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("kind 值不在已登记枚举"), "须点名 kind 缺口");
});

test("acceptance 编译 runtime-probe 行：节点字段 + wrapper 落点 + --check 委托 + 真校验器 PASS", (t) => {
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "dev 编译前置");
  const r = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `acceptance 编译应过：${r.stderr}`);
  const plan = JSON.parse(readFileSync(f.execPath, "utf8"));
  const probe = plan.acceptance.nodes.find((n) => n.id === "A-probe-reg");
  assert.equal(probe.kind, "verify");
  assert.deepEqual(probe.runtimeProbe.capabilityIds, ["EC-demo-host:register-command"]);
  assert.deepEqual(probe.runtimeProbe.command, { program: "node", args: ["scripts/probe.mjs"] });
  assert.equal(probe.runtimeProbe.artifact, join(f.taskDir, "evidence", "runtime-probe-A-probe-reg.json"), "artifact 编译期解析为任务目录绝对路径");
  assert.equal(probe.script, join(f.taskDir, "evidence", "runtime-probes", "A-probe-reg.mjs"), "wrapper 落 taskDir evidence");
  assert.ok(existsSync(probe.script), "probe wrapper 未生成");
  assert.ok(readFileSync(probe.script, "utf8").includes("scripts/probe.mjs"), "wrapper 未内嵌 driver 命令");
  // 汇总 inspect 节点依赖全部 verify（含 probe 节点）
  const summary = plan.acceptance.nodes.find((n) => n.id === "summarize");
  assert.ok(summary.deps.includes("A-probe-reg"), "汇总节点须挂 probe 节点");
  // --check 委托 probe wrapper 防手改核对
  const c = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir, "--check"]);
  assert.equal(c.status, 0, `--check 未过：${c.stderr}`);
  assert.ok(c.stdout.includes("gen-runtime-probe-wrapper --check"), "--check 须报告 probe wrapper 委托核对");
  // 写盘后真校验器（--task-dir：runtime-probe 能力对账段实跑）
  const checked = spawnSync(process.execPath, [CHECKER, f.execPath, "--task-dir", f.taskDir], { encoding: "utf8" });
  assert.equal(checked.status, 0, `真校验器未过：${checked.stdout}${checked.stderr}`);
});

test("runtime-probe 行 capabilityIds 不在验收包 externalContracts：拒绝编译", (t) => {
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  const plan = JSON.parse(readFileSync(f.planPath, "utf8"));
  plan.acceptancePlan[0].capabilityIds = ["EC-demo-host:no-such-capability"];
  writeFileSync(f.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(spawnSync(process.execPath, [RENDERER, f.planPath], { encoding: "utf8" }).status, 0);
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "dev 编译前置");
  const r = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]);
  assert.equal(r.status, 1, `能力 id 不在验收包应拒绝：${r.stderr}`);
  assert.ok(r.stderr.includes("不在验收包 externalContracts"), "须点名能力对账缺口");
});

test("runtime-probe 行缺 command / driver 文件不存在：拒绝编译（占位引用硬门槛）", (t) => {
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  const plan = JSON.parse(readFileSync(f.planPath, "utf8"));
  delete plan.acceptancePlan[0].command;
  writeFileSync(f.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(spawnSync(process.execPath, [RENDERER, f.planPath], { encoding: "utf8" }).status, 0);
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "dev 编译前置");
  const r1 = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]);
  assert.equal(r1.status, 1, `缺 command 应拒绝：${r1.stderr}`);
  assert.ok(r1.stderr.includes("缺 command"), "须点名 command 缺失");

  // driver 文件不存在（指向尚未实现的 scripts/probe.mjs——从工作区删掉它再编译）
  rmSync(join(f.proj, "scripts", "probe.mjs"));
  const plan2 = JSON.parse(readFileSync(f.planPath, "utf8"));
  plan2.acceptancePlan[0].command = { program: "node", args: ["scripts/probe.mjs"] };
  writeFileSync(f.planPath, `${JSON.stringify(plan2, null, 2)}\n`);
  assert.equal(spawnSync(process.execPath, [RENDERER, f.planPath], { encoding: "utf8" }).status, 0);
  const r2 = f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]);
  assert.equal(r2.status, 1, `driver 缺失应拒绝：${r2.stderr}`);
  assert.ok(r2.stderr.includes("driver 文件不存在"), "须点名 driver 占位引用");
});

test("D3 复扫门（CLI）：probe artifact 未落盘拒绝、落盘合法 JSON 放行", (t) => {
  const f = makeContractFixture(t, { acceptance: contractAcceptance(), increments: contractIncrements(), snapshot: true });
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "dev 编译前置");
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]).status, 0, "acceptance 编译前置");
  const runRescan = () =>
    spawnSync(process.execPath, [RESCAN_CLI, "--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home },
    });
  const before = runRescan();
  assert.equal(before.status, 1, `artifact 未落盘应拒绝：${before.stdout}`);
  assert.ok(before.stdout.includes("probe artifact 未落盘") || before.stdout.includes("runtime probe artifact"), "须点名 probe 未跑");
  // 落盘合法 JSON → 放行
  mkdirSync(join(f.taskDir, "evidence"), { recursive: true });
  writeFileSync(join(f.taskDir, "evidence", "runtime-probe-A-probe-reg.json"), `${JSON.stringify({ environment: { kind: "official-runner" }, cases: [], summary: { passed: 1, failed: 0, skipped: 0 } })}\n`);
  const after = runRescan();
  assert.equal(after.status, 0, `artifact 落盘后应放行：${after.stdout}${after.stderr}`);
  assert.ok(after.stdout.includes("PASS"), "须输出 PASS");
});

test("D3 复扫门（CLI）：essential 契约任务无 runtime-probe 节点 → 拒绝（probe 未跑）", (t) => {
  const f = makeContractFixture(t, {
    acceptance: contractAcceptance(),
    increments: contractIncrements(),
    snapshot: true,
    planOverrides: { withProbeRow: false }, // T3 未登记 runtime-probe 行
  });
  assert.equal(f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]).status, 0, "dev 编译前置");
  assert.equal(f.run(["--impl-plan", f.planPath, "--mode", "acceptance", "--task-dir", f.taskDir]).status, 0, "acceptance 编译前置");
  const r = spawnSync(process.execPath, [RESCAN_CLI, "--task-dir", f.taskDir, "--project-root", f.proj, "--exec-plan", f.execPath, "--stage", "d3"], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home },
  });
  assert.equal(r.status, 1, `无 probe 节点应拒绝：${r.stdout}`);
  assert.ok(r.stdout.includes("未编译任何 runtime-probe 验收节点"), "须点名 probe 节点缺失");
});
