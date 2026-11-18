// contract-rescan-parity-v6.test.mjs — 复扫判定单源收敛与指针布局集成（代码断点修复批）
//
// 被测实现（设计《V6 运行可用性与外部契约守门升级》§4.2/§4.3/§7.3/§8.1）：
//   - skills/self/dev-workflow/delivery-v6/scripts/lib/contract-rescan.mjs：复扫判定唯一
//     实现（原 dev-flow check-contract-rescan 与 gate externalContractPreflight 两份收敛
//     为一份；P0-2 的 hit0 恒拒与 P1-1 的 manifest 类还原在此修复）；
//   - skills/self/dev-workflow/dev-flow-v6/scripts/check-contract-rescan.mjs：dev-flow 侧
//     薄壳（import 单源库 + CLI）；compile-exec-plan.mjs 的 D0 复扫缺口渲染；
//   - skills/self/dev-workflow/delivery-v6/scripts/delivery-gate.mjs：evaluate 前置复扫
//     改调单源函数（含探测器输出 memo，F12）；
//   - skills/self/dev-workflow/delivery-v6/scripts/resolve-external-contracts.mjs：current
//     指针落 taskDir 根（P0-1 修复）+ 旧布局兼容读。
//
// 覆盖：
//   1. 单源断言：dev-flow 侧导出的 runContractRescan 与库内实现是同一函数（无第二份判定）；
//   2. 类提取口径（P1-1/C）：call-class 段 / manifest-field 映射 / 纯 import 无类 / 蕴含观察类；
//   3. 复扫行为（P0-2/B）：manifest 字段型与纯 import 型强候选不因「提不到调用类」被拒；
//      调用类未覆盖才拒且点名缺失类；未处置强候选拒绝；
//   4. 两侧对拍（B）：同一探测输出喂 D0 形态（默认探测器路径 + 策略缺省）与 gate 形态
//      （注入探测输出 + 策略包文档 + 探测器路径）→ 判定一致、错误 code 一致、渲染消息
//      点名同一候选/类；端到端再对拍一次（真实探测器：D0 编译拒绝 vs gate evaluate 拒绝）；
//   5. 指针布局集成（P0-1/A）：真实 resolver --write → 指针在 taskDir 根、快照在子目录；
//      真实 D0 编译门读到指针放过快照门；旧布局（只有子目录指针）重跑 resolver 迁回根；
//   6. readiness 锚（P1-2/D）：非增强契约「从未有权威」→ not-established（不是 unknown）；
//   7. profile=a 维度对账（P1-3/E）：validate-acceptance 拒绝超出降档词表的 reviewDimensions。
//
// fixture 纪律：mkdtempSync 临时目录、HOME 重定向、t.after 清理、无固定文件名；
// npm 缓存形态照 external-contract-resolve-v6.test.mjs 的 plantNpmCache。
//
// 运行：node --test scripts/tests/contract-rescan-parity-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V6 = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6");
const DEVFLOW = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6");
const RESCAN_LIB = await import(pathToFileURL(join(V6, "scripts", "lib", "contract-rescan.mjs")).href);
const KERNEL = await import(pathToFileURL(join(V6, "scripts", "lib", "kernel-judgments.mjs")).href);
const GATE_MODULE = await import(pathToFileURL(join(V6, "scripts", "delivery-gate.mjs")).href);
const RESOLVER = join(V6, "scripts", "resolve-external-contracts.mjs");
const DETECTOR = join(V6, "scripts", "detect-external-contracts.mjs");
const COMPILER = join(DEVFLOW, "scripts", "compile-exec-plan.mjs");
const RENDERER = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "scripts", "render-impl-plan.mjs");
const POLICY_FILE = join(V6, "policies", "external-contract-classes.json");
const POLICY_DOCUMENT = JSON.parse(readFileSync(POLICY_FILE, "utf8"));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
const ok = (result, label = "命令应成功") => {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
};

// ── 1. 单源断言：dev-flow 侧与库内是同一函数（无第二份判定）──

test("单源收敛：dev-flow 侧导出的 runContractRescan 就是库内实现（引用同一，禁复刻）", async () => {
  const devFlowSide = await import(pathToFileURL(join(DEVFLOW, "scripts", "check-contract-rescan.mjs")).href);
  assert.equal(typeof devFlowSide.runContractRescan, "function");
  assert.equal(devFlowSide.runContractRescan, RESCAN_LIB.runContractRescan, "两侧必须引用同一函数对象——出现两份实现即口径漂移回潮");
  assert.equal(typeof devFlowSide.renderRescanErrorDevFlow, "function", "dev-flow 侧消息渲染器随单源库提供");
});

// ── 2. 类提取口径（P1-1 / C）──

test("类提取：call-class 段 / manifest-field 映射 / 纯 import 无类 / 蕴含观察类", () => {
  const tables = RESCAN_LIB.loadClassTables(POLICY_DOCUMENT);
  assert.equal(tables.policyAvailable, true);
  // ① call-class 段：探测器实定形态 source:<文件>:call-class:<类id> 与裸 call-class:<类id>
  for (const signal of ["source:src/app/main.ts:call-class:register-command", "call-class:register-command"]) {
    const { classes, hasCallClassSignal } = RESCAN_LIB.candidateCallClasses({ signals: [signal] }, tables);
    assert.deepEqual(classes, ["register-command"], `call-class 段提取：${signal}`);
    assert.equal(hasCallClassSignal, true);
  }
  // ② manifest-field 映射：manifest:pi.extensions → extension-entrypoint（P1-1 修复——
  //    不读策略包 staticSignals 的 manifest-field 表就会把 manifest 型候选的 hit 判空）
  const manifest = RESCAN_LIB.candidateCallClasses({ signals: ["manifest:pi.extensions"] }, tables);
  assert.deepEqual(manifest.classes, ["extension-entrypoint"], "manifest 字段信号必须经策略表还原到调用类");
  assert.equal(manifest.hasCallClassSignal, false, "manifest 字段型候选没有 call-class 段信号");
  // 普通依赖 / 包自身形态信号不是调用类（不误映射）
  assert.deepEqual(RESCAN_LIB.candidateCallClasses({ signals: ["manifest:dependencies:fake-host-sdk", "manifest:type-module"] }, tables).classes, []);
  // ③ 纯 import 型：提不到调用类，且没有 call-class 段信号
  const importOnly = RESCAN_LIB.candidateCallClasses({ signals: ["source:src/app/x.ts:import:x-sdk"] }, tables);
  assert.deepEqual(importOnly.classes, [], "纯 import 型候选不提调用类");
  assert.equal(importOnly.hasCallClassSignal, false);
  // 探测器自带 callClasses 数组合并
  assert.deepEqual(RESCAN_LIB.candidateCallClasses({ signals: [], callClasses: ["invoke-tool"] }, tables).classes, ["invoke-tool"]);
  // 蕴含观察类：register-command → dispatch-command（策略表 impliesObservationClasses）
  assert.deepEqual(RESCAN_LIB.observedClassesOf({ signals: ["call-class:register-command"] }, tables).sort(), ["dispatch-command", "register-command"]);
  // 词表缺席：蕴含回退初始表，manifest/regex 映射缺席（不猜）
  const fallback = RESCAN_LIB.loadClassTables(null);
  assert.equal(fallback.policyAvailable, false);
  assert.deepEqual([...fallback.implied.get("register-command")], ["dispatch-command"], "回退表保设计 §4.1 初始关系");
  assert.deepEqual(RESCAN_LIB.candidateCallClasses({ signals: ["manifest:pi.extensions"] }, fallback).classes, [], "无策略包时不做 manifest→类映射（不猜）");
});

// ── 3+4. 复扫行为与两侧对拍（P0-2 / B）──

/** 最小验收包（单契约 EC-demo-host；capabilityClasses 可控；处置表可控）。 */
function rescanAcceptance({ essential = true, capabilityClasses = ["register-tool", "invoke-tool"], disposition = "bound" } = {}) {
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
          { id: "register-tool-and-invoke", minEnvironment: "official-runner", detectionClasses: capabilityClasses, surfaceRefs: ["types.d.ts#ToolDefinition"] },
        ],
      },
    ],
    externalContractReview: {
      detectionSha256: "c".repeat(64),
      dispositions: disposition === null ? [] : [{ candidateId: "candidate-x", disposition, contractId: "EC-demo-host" }],
    },
  };
}

/** 探测输出（候选快照 JSON 文档）。 */
const detectionOf = (candidates, unresolved = []) => ({ schemaVersion: 1, inputHashes: {}, candidates, unresolved });

/** D0 形态调用（dev-flow 侧：探测输出同样由调用方喂入，策略读库同技能 policies/ 缺省路径，
 *  stage=d0、不传 detectorPath/policyDocument——消费方选项形态的差异不得改变判定）。 */
function rescanAsD0({ taskDir, projectRoot, acceptance, detection }) {
  return RESCAN_LIB.runContractRescan({ taskDir, projectRoot, acceptance, stage: "d0", detection: { ok: true, parsed: detection } });
}

/** gate 形态调用（evaluate 前置：注入探测输出与策略包文档，探测器路径显式传入）。 */
function rescanAsGate({ taskDir, projectRoot, acceptance, detection }) {
  return RESCAN_LIB.runContractRescan({
    taskDir,
    projectRoot,
    acceptance,
    stage: "d3",
    detection: { ok: true, parsed: detection },
    detectorPath: DETECTOR,
    policyDocument: POLICY_DOCUMENT,
  });
}

test("复扫行为：manifest 字段型与纯 import 型强候选不因「提不到调用类」被拒（P0-2 修复）", (t) => {
  const base = mkdtempSync(join(tmpdir(), "crp-behavior-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const taskDir = join(base, "task");
  const projectRoot = join(base, "project");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const acceptance = rescanAcceptance();
  // manifest 字段型（pi.extensions 本属 extension-entrypoint，已登记）+ bound 处置 → 放行
  const manifestRescan = rescanAsGate({
    taskDir, projectRoot, acceptance,
    detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["manifest:pi.extensions"] }]),
  });
  assert.equal(manifestRescan.ok, true, `manifest 字段型强候选不得被拒：${JSON.stringify(manifestRescan.errors)}`);
  // 纯 import 型 + bound 处置 → 放行（无调用类可对账，处置表兜底）
  const importRescan = rescanAsGate({
    taskDir, projectRoot, acceptance,
    detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["source:src/app/x.ts:import:x-sdk"] }]),
  });
  assert.equal(importRescan.ok, true, `纯 import 型强候选不得被拒：${JSON.stringify(importRescan.errors)}`);
  // 纯 import 型 + 未处置 → 拒，但拒绝理由是「未处置」而非「缺调用类」（恢复动作可执行）
  const undisposed = rescanAsGate({
    taskDir, projectRoot, acceptance: rescanAcceptance({ disposition: null }),
    detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["source:src/app/x.ts:import:x-sdk"] }]),
  });
  assert.equal(undisposed.ok, false);
  assert.equal(undisposed.errors[0].code, "candidate-undisposed", "纯 import 型未处置候选按未处置拒绝");
  // 调用类未覆盖 → 拒且点名缺失类（含蕴含观察类）——能力清单低报的主机器门仍在
  const unmapped = rescanAsGate({
    taskDir, projectRoot, acceptance: rescanAcceptance({ capabilityClasses: ["extension-entrypoint"] }),
    detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }]),
  });
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.errors[0].code, "candidate-classes-unmapped");
  assert.deepEqual(unmapped.errors[0].missing.sort(), ["dispatch-command", "register-command"], "拒绝须点名调用类与蕴含观察类");
  // unresolved 外部访问 → 停回（停回口径不变）
  const unresolvedRescan = rescanAsGate({
    taskDir, projectRoot, acceptance,
    detection: detectionOf([], [{ signal: "动态 import(moduleName)", reason: "调用参数不是字符串字面量" }]),
  });
  assert.equal(unresolvedRescan.ok, false);
  assert.equal(unresolvedRescan.errors[0].code, "unresolved-external-access");
  // weak 候选不进机器门（未处置也放行）
  const weakRescan = rescanAsGate({
    taskDir, projectRoot, acceptance: rescanAcceptance({ disposition: null }),
    detection: detectionOf([{ id: "candidate-weak", strength: "weak", signals: ["intent:plugin"] }]),
  });
  assert.equal(weakRescan.ok, true, "weak 候选由 reviewer 论证，不进机器门");
  // 升级前旧任务（无 externalContracts / externalContractReview）→ 整门跳过
  const legacy = RESCAN_LIB.runContractRescan({ taskDir, projectRoot, acceptance: { schemaVersion: 2 }, stage: "d0" });
  assert.equal(legacy.skipped, true);
  assert.equal(legacy.ok, true);
});

test("两侧对拍：同一探测输出喂 D0 形态与 gate 形态，判定与错误数据一致（放行/拒绝相同）", (t) => {
  const base = mkdtempSync(join(tmpdir(), "crp-parity-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const taskDir = join(base, "task");
  const projectRoot = join(base, "project");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const cases = [
    {
      label: "调用类全覆盖（放行）",
      acceptance: rescanAcceptance(),
      detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["manifest:pi.extensions", "source:src/spike/entry.ts:call-class:extension-entrypoint"] }]),
    },
    {
      label: "调用类未覆盖（拒绝）",
      acceptance: rescanAcceptance({ capabilityClasses: ["extension-entrypoint"] }),
      detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["source:src/app/main.ts:call-class:register-command"] }]),
    },
    {
      label: "manifest 字段型已处置（放行——P0-2 修复后不再是恒拒）",
      acceptance: rescanAcceptance(),
      detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["manifest:pi.extensions"] }]),
    },
    {
      label: "未处置强候选（拒绝）",
      acceptance: rescanAcceptance({ disposition: null }),
      detection: detectionOf([{ id: "candidate-x", strength: "strong", signals: ["source:src/app/x.ts:import:x-sdk"] }]),
    },
    {
      label: "unresolved 外部访问（拒绝）",
      acceptance: rescanAcceptance(),
      detection: detectionOf([], [{ signal: "计算式外部成员访问（src/x.ts 的绑定 pi）", reason: "方括号访问目标不是字面量" }]),
    },
  ];
  for (const item of cases) {
    const d0 = rescanAsD0({ taskDir, projectRoot, acceptance: item.acceptance, detection: item.detection });
    const gate = rescanAsGate({ taskDir, projectRoot, acceptance: item.acceptance, detection: item.detection });
    assert.equal(d0.ok, gate.ok, `对拍「${item.label}」：D0 ok=${d0.ok} 与 gate ok=${gate.ok} 不一致`);
    assert.deepEqual(
      d0.errors.map((error) => error.code),
      gate.errors.map((error) => error.code),
      `对拍「${item.label}」：错误 code 序列一致（判定单源）`,
    );
    if (!d0.ok) {
      // 渲染消息点名同一候选/同一缺失类（呈现分局但锚点相同）
      const devFlowMessage = RESCAN_LIB.renderRescanErrorDevFlow(d0.errors[0]);
      const gateMessage = RESCAN_LIB.renderRescanErrorGate(gate.errors[0]);
      const anchor = d0.errors[0].candidateId ?? d0.errors[0].signal ?? null;
      if (anchor !== null) {
        assert.ok(devFlowMessage.includes(anchor), `dev-flow 消息点名锚点：${devFlowMessage}`);
        assert.ok(gateMessage.includes(anchor), `gate 消息点名锚点：${gateMessage}`);
      }
      for (const classId of d0.errors[0].missing ?? []) {
        assert.ok(devFlowMessage.includes(classId) && gateMessage.includes(classId), `两侧消息都点名缺失调用类 ${classId}`);
      }
    }
  }
});

// ── 4b. 端到端对拍：真实探测器输出 → D0 编译拒绝 vs gate evaluate 拒绝 ──

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

/** 把假 tarball 内容写进 HOME 下的 npm cacache，返回 lockfile 用的 integrity 串。 */
function plantNpmCache(home, content) {
  const digest = createHash("sha512").update(content).digest();
  const hex = digest.toString("hex");
  const dir = join(home, ".npm", "_cacache", "content-v2", "sha512", hex.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hex.slice(2)), content);
  return `sha512-${digest.toString("base64")}`;
}

const NPM_CONTRACT = {
  id: "EC-npm",
  essential: true,
  authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
  capabilities: [
    { id: "register-tool-and-invoke", minEnvironment: "official-runner", observable: "x", surfaceRefs: ["dist/types.d.ts"], detectionClasses: ["register-tool"] },
  ],
};

/** git 模板仓（init + commit 一次成型）：src 三目录 + probe driver + design stub。 */
let gitTemplate = null;
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "crp-git-tpl-"));
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

/** 把真实探测器与策略包复制进临时 HOME 安装位（探测器缺策略文件即 exit 3：调用类词表是
 *  探测的唯一权威来源，两者必须同装）——D0 复扫默认走 homedir 安装位锚定。 */
function installRealDetector(home) {
  const scripts = join(home, ".agents", "skills", "delivery-v6", "scripts");
  const policies = join(home, ".agents", "skills", "delivery-v6", "policies");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(policies, { recursive: true });
  cpSync(DETECTOR, join(scripts, "detect-external-contracts.mjs"));
  cpSync(POLICY_FILE, join(policies, "external-contract-classes.json"));
}

/** D0 编译 fixture：临时 HOME（npm 缓存 + 假探测器）+ 临时 git 项目 + 临时交付任务目录。
 *  realDetector=true 时把真实探测器装进临时 HOME 安装位（端到端对拍用）。 */
function makeCompileFixture(t, { snapshot = true, realDetector = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "crp-home-"));
  const proj = mkdtempSync(join(tmpdir(), "crp-proj-"));
  cpSync(ensureGitTemplate(), proj, { recursive: true });
  const taskDir = mkdtempSync(join(tmpdir(), "crp-task-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  });
  installFakeDetector(home);
  if (realDetector) installRealDetector(home);
  const projReal = realpathSync(proj);
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  // npm 假包项目（resolver 的 installed-npm-package 信任链输入）
  write(join(projReal, "package.json"), `${JSON.stringify({ name: "fixture-proj", version: "1.0.0", dependencies: { "fake-host-sdk": "^1.0.0" } }, null, 2)}\n`);
  write(join(projReal, "node_modules", "fake-host-sdk", "package.json"), `${JSON.stringify({ name: "fake-host-sdk", version: "1.0.0", main: "dist/index.js" }, null, 2)}\n`);
  write(join(projReal, "node_modules", "fake-host-sdk", "dist", "types.d.ts"), "export interface ToolDefinition { name: string }\n");
  write(join(projReal, "node_modules", "fake-host-sdk", "dist", "index.js"), "module.exports = {};\n");
  const integrity = plantNpmCache(home, "TARBALL:fake-host-sdk@1.0.0");
  write(join(projReal, "package-lock.json"), `${JSON.stringify({
    name: "fixture-proj",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture-proj", dependencies: { "fake-host-sdk": "^1.0.0" } },
      "node_modules/fake-host-sdk": { version: "1.0.0", integrity },
    },
  }, null, 2)}\n`);
  const git = (args) => spawnSync("git", args, { cwd: projReal, encoding: "utf8" });
  assert.equal(git(["add", "."]).status, 0, "git add 失败");
  assert.equal(git(["commit", "-qm", "npm fixture"]).status, 0, "git commit 失败");
  // 交付任务目录三件套
  const acceptance = {
    schemaVersion: 2,
    acceptanceVersion: 1,
    taskId: basename(taskDir),
    projectRoot: projReal,
    externalContracts: [NPM_CONTRACT],
    externalContractReview: { detectionSha256: "c".repeat(64), dispositions: [] },
    adversarialForms: [],
    requirements: [{ id: "R1", assertions: [] }],
  };
  write(join(taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  write(join(taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1,
    acceptanceVersion: 1,
    items: [
      { id: "inc-smoke", title: "契约冒烟", requirementIds: ["R1"], kind: "contract-smoke", testCommand: { program: "node", args: ["--test", "tests/smoke"] } },
      { id: "inc-1", title: "契约根", requirementIds: ["R1"], testCommand: { program: "node", args: ["--test", "tests/shared"] } },
    ],
  }, null, 2)}\n`);
  write(join(taskDir, "intent.md"), "# 意图\n实现 demo 宿主扩展。\n");
  write(join(taskDir, "events.jsonl"), "");
  if (snapshot) {
    const snapshotSha = "a".repeat(64);
    const dir = join(taskDir, "environment-contracts");
    mkdirSync(dir, { recursive: true });
    write(join(dir, `${snapshotSha}.json`), `${JSON.stringify({
      schemaVersion: 1,
      snapshotSha256: snapshotSha,
      contracts: [{ id: "EC-npm", status: "resolved", resolvedPath: "/opt/demo", surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: "d".repeat(64) }], aggregateHash: "b".repeat(64) }],
    }, null, 2)}\n`);
    write(join(taskDir, "environment-contracts.current.json"), `${JSON.stringify({ schemaVersion: 1, snapshotSha256: snapshotSha, snapshotPath: `environment-contracts/${snapshotSha}.json` }, null, 2)}\n`);
  }
  // impl-plan：spike 单元 + 一个依赖 spike 的业务单元
  const plan = {
    name: "demo-contract",
    designDoc: join(projReal, "design"),
    baseline: "abcdef1234567890",
    skillVersion: "1.0.0",
    sectionMap: { goal: "§1", mechanism: "§2", acceptance: "§3", breakdown: "§4" },
    units: [
      { id: "u-spike", responsibility: "契约冒烟 spike", territory: ["src/spike/"], deps: [], isolation: "plain", acceptance: ["A0 契约形态确认"], decisionTier: "A", designRef: "§4.0", incrementId: "inc-smoke", kind: "contract-spike" },
      { id: "u-main", responsibility: "主实现", territory: ["src/app/"], deps: ["u-spike"], isolation: "plain", acceptance: ["A2 主链路可用"], decisionTier: "B", designRef: "§4.2", incrementId: "inc-1" },
    ],
    testPlan: {
      incrementalCommands: [
        { incrementId: "inc-smoke", unitIds: ["u-spike"], command: { program: "node", args: ["--test", "tests/smoke"] } },
        { incrementId: "inc-1", unitIds: ["u-main"], command: { program: "node", args: ["--test", "tests/shared"] } },
      ],
      fullSuite: { program: "node", args: ["--test", "tests/all"] },
    },
    acceptancePlan: [],
  };
  const planPath = join(projReal, "demo-contract.impl-plan.json");
  write(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const rendered = spawnSync(process.execPath, [RENDERER, planPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(rendered.status, 0, `fixture 渲染失败：${rendered.stderr}`);
  // meta.json acceptanceBinding（D0 绑定核对输入）
  const increments = JSON.parse(readFileSync(join(taskDir, "increments.json"), "utf8"));
  write(join(projReal, "design", "meta.json"), `${JSON.stringify({
    acceptanceBinding: {
      acceptanceVersion: acceptance.acceptanceVersion,
      acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acceptance), "increments.json": canonicalJson(increments) })),
      taskDir,
    },
  }, null, 2)}\n`);
  const slug = `${basename(projReal)}-${createHash("sha256").update(projReal).digest("hex").slice(0, 8)}`;
  const productRoot = join(home, ".agents", "skill-data", "dev-flow", slug);
  const run = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [COMPILER, ...args], { cwd: projReal, env: { ...process.env, HOME: home, ...extraEnv }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { home, proj: projReal, taskDir, planPath, productRoot, execPath: join(productRoot, "demo-contract.exec-plan.json"), run };
}

test("指针布局集成（P0-1）：真实 resolver --write → 指针在 taskDir 根，真实 D0 编译读到并放过快照门", (t) => {
  const f = makeCompileFixture(t, { snapshot: false });
  const write = spawnSync(process.execPath, [RESOLVER, "--task-dir", f.taskDir, "--project-root", f.proj, "--write"], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home },
  });
  assert.equal(write.status, 0, `resolver --write 应成功：${write.stderr}`);
  // 终态锚 1：current 指针落 taskDir 根（设计 §4.3；全部消费端读根路径）
  assert.ok(existsSync(join(f.taskDir, "environment-contracts.current.json")), "current 指针必须落在 taskDir 根");
  // 终态锚 2：快照文件仍在 environment-contracts/ 子目录（按哈希分文件）
  const summary = JSON.parse(write.stdout);
  assert.ok(existsSync(join(f.taskDir, "environment-contracts", `${summary.snapshotSha256}.json`)), "快照文件按哈希分文件落子目录");
  // 终态锚 3：真实 D0 编译门读到指针，不报「缺权威环境契约快照指针」
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `D0 编译应读过指针放行：${r.stderr}`);
  assert.ok(!r.stderr.includes("缺权威环境契约快照指针"), "不得报缺快照指针");
  assert.ok(existsSync(f.execPath), "exec-plan 应生成");
});

test("指针布局集成（P0-1 兼容读）：旧布局（只有子目录指针）重跑 resolver --write 迁回根，D0 读到放行", (t) => {
  const f = makeCompileFixture(t, { snapshot: false });
  const write = spawnSync(process.execPath, [RESOLVER, "--task-dir", f.taskDir, "--project-root", f.proj, "--write"], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home },
  });
  assert.equal(write.status, 0, `resolver --write 应成功：${write.stderr}`);
  // 模拟升级前旧布局：根指针搬进 environment-contracts/ 子目录（升级前 resolver 的落点）
  const rootPointer = join(f.taskDir, "environment-contracts.current.json");
  const subPointer = join(f.taskDir, "environment-contracts", "environment-contracts.current.json");
  mkdirSync(join(f.taskDir, "environment-contracts"), { recursive: true });
  writeFileSync(subPointer, readFileSync(rootPointer, "utf8"));
  rmSync(rootPointer, { force: true });
  assert.ok(!existsSync(rootPointer) && existsSync(subPointer), "fixture 前提：旧布局（只有子目录指针）");
  // 重跑 --write：兼容读旧布局指针并把指针迁回根
  const second = spawnSync(process.execPath, [RESOLVER, "--task-dir", f.taskDir, "--project-root", f.proj, "--write"], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home },
  });
  assert.equal(second.status, 0, `迁移重跑应成功：${second.stderr}`);
  assert.ok(existsSync(rootPointer), "重跑 --write 后指针应迁回 taskDir 根");
  const r = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(r.status, 0, `迁移后 D0 编译应放行：${r.stderr}`);
  assert.ok(!r.stderr.includes("缺权威环境契约快照指针"), "迁移后不得报缺快照指针");
});

test("端到端对拍（P0-2/B）：真实探测器输出下 D0 编译与 gate evaluate 同判拒绝并点名同一缺失调用类", (t) => {
  const f = makeCompileFixture(t, { realDetector: true });
  // 项目源码引入外部包并调用 registerCommand（真实探测器的 strong 信号源）
  mkdirSync(join(f.proj, "src", "app"), { recursive: true });
  writeFileSync(join(f.proj, "src", "app", "extension.mjs"), [
    'import * as pi from "fake-host-sdk";',
    "export default function activate(ctx) {",
    '  pi.registerCommand("memory", { handler: () => 1 });',
    "  return 1;",
    "}",
    "",
  ].join("\n"));
  const git = (args) => spawnSync("git", args, { cwd: f.proj, encoding: "utf8" });
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-qm", "registerCommand source"]).status, 0);
  // 验收能力只登记 register-tool（不含 register-command 及其蕴含 dispatch-command）
  const acceptance = JSON.parse(readFileSync(join(f.taskDir, "acceptance.json"), "utf8"));
  acceptance.externalContractReview.dispositions = [{ candidateId: "candidate-pkg-fake-host-sdk", disposition: "bound", contractId: "EC-npm" }];
  writeFileSync(join(f.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  const increments = JSON.parse(readFileSync(join(f.taskDir, "increments.json"), "utf8"));
  writeFileSync(join(f.proj, "design", "meta.json"), `${JSON.stringify({
    acceptanceBinding: {
      acceptanceVersion: acceptance.acceptanceVersion,
      acceptancePackageSha256: sha256Text(canonicalJson({ "acceptance.json": canonicalJson(acceptance), "increments.json": canonicalJson(increments) })),
      taskDir: f.taskDir,
    },
  }, null, 2)}\n`);
  // D0 侧：真实探测器（临时 HOME 安装位）+ 复扫单源判定 → 拒绝并点名 register-command / dispatch-command
  const d0 = f.run(["--impl-plan", f.planPath, "--task-dir", f.taskDir]);
  assert.equal(d0.status, 1, `D0 侧应拒绝：${d0.stderr}`);
  assert.ok(d0.stderr.includes("D0 外部契约复扫未过"), "D0 侧走复扫缺口通道");
  assert.ok(d0.stderr.includes("register-command"), "D0 侧点名未登记调用类");
  assert.ok(d0.stderr.includes("dispatch-command"), "D0 侧点名蕴含观察类");
  // gate 侧：同一项目同一探测器输出 → evaluate 前置复扫同判拒绝
  const home = mkdtempSync(join(tmpdir(), "crp-gate-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const intentPath = join(home, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册命令\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", f.proj, "--task-id", "crp-seam", "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const gateTaskDir = JSON.parse(parseStdout(init)).taskDir;
  const gateAcceptance = {
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
        requiredEnvironment: { kind: "real-host", capability: "register-tool-and-invoke" },
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "host", initialState: "已装载", operation: "用单对象调用注册", timing: "命令期", expected: "注册失败被观察", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: "EC-npm",
      essential: true,
      authorityRequest: { resolverKind: "installed-npm-package", locator: "fake-host-sdk" },
      capabilities: [{ id: "register-tool-and-invoke", minEnvironment: "official-runner", observable: "x", surfaceRefs: ["dist/types.d.ts"], detectionClasses: ["register-tool"] }],
    }],
    externalContractReview: { detectionSha256: "c".repeat(64), dispositions: [{ candidateId: "candidate-pkg-fake-host-sdk", disposition: "bound", contractId: "EC-npm" }] },
  };
  gateAcceptance.taskId = basename(gateTaskDir);
  gateAcceptance.projectRoot = f.proj;
  writeFileSync(join(gateTaskDir, "acceptance.json"), `${JSON.stringify(gateAcceptance, null, 2)}\n`);
  writeFileSync(join(gateTaskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
  ok(GATE_MODULE.runGateCommand(["snapshot-policy", "--task-dir", gateTaskDir], home), "snapshot-policy 应成功");
  const evaluated = GATE_MODULE.runGateCommand(["evaluate", "--task-dir", gateTaskDir], home, {
    DELIVERY_EXTERNAL_CONTRACT_DETECTOR: DETECTOR,
    DELIVERY_EXTERNAL_CONTRACT_RESOLVER: RESOLVER,
  });
  assert.notEqual(evaluated.status, 0, `gate 侧应拒绝：${evaluated.stderr}`);
  assert.match(evaluated.stderr, /未登记 strong 信号/, "gate 侧与 D0 同判：未登记 strong 信号");
  assert.match(evaluated.stderr, /register-command/, "gate 侧点名同一未登记调用类");
  assert.match(evaluated.stderr, /dispatch-command/, "gate 侧点名同一蕴含观察类");
});

// ── 6. readiness 锚（P1-2 / D）：非增强契约「从未有权威」→ not-established ──

test("readiness：非增强契约快照无条目（从未有权威）→ not-established，不是 unknown", () => {
  const facts = {
    acceptance: {
      externalContracts: [{
        id: "EC-optional",
        essential: false,
        capabilities: [{ id: "cap-x", minEnvironment: "official-runner", detectionClasses: ["register-tool"], surfaceRefs: ["x"] }],
      }],
    },
    // resolver 正常解析（available=true）但快照不含该契约——「从未有权威」
    environmentSnapshot: { available: true, contracts: [] },
    evidence: [],
    currentRevision: "rev-final",
    chainOkContracts: new Set(["EC-optional"]),
  };
  const obligations = KERNEL.deriveRuntimeObligations(facts);
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].required, false, "非增强契约的 runtime 义务 required=false");
  assert.equal(obligations[0].state, "open");
  assert.equal(obligations[0].readiness, "not-established", "从未有权威 = 确定的未建立（unknown 留给权威存在但解析失败）");
  assert.match(obligations[0].reason, /从未登记权威/);
  // 对照：条目在但非 resolved（权威存在但解析失败）→ unknown
  const unresolved = KERNEL.deriveRuntimeObligations({
    ...facts,
    environmentSnapshot: { available: true, contracts: [{ id: "EC-optional", status: "declared-unavailable", authorityAggregateHash: null }] },
  });
  assert.equal(unresolved[0].readiness, "unknown", "权威存在但解析失败 = 无法判定");
  // 对照：essential 契约从未有权威 → unknown（fail-closed）
  const essential = KERNEL.deriveRuntimeObligations({
    ...facts,
    acceptance: { externalContracts: [{ id: "EC-optional", essential: true, capabilities: facts.acceptance.externalContracts[0].capabilities }] },
  });
  assert.equal(essential[0].readiness, "unknown", "essential 契约权威不可得 = 无法判定，不得写成未建立");
});

// ── 7. profile=a 维度对账（P1-3 / E）：validate-acceptance 机器约束 ──

test("profile=a 维度对账：验收含外部契约时 reviewDimensions 超出降档词表 → validate-acceptance 拒绝", (t) => {
  const root = mkdtempSync(join(tmpdir(), "crp-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectDir = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  const git = (args) => spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "扩展在真实宿主装载并注册工具\n");
  const init = GATE_MODULE.runGateCommand(["init", "--project-root", projectDir, "--task-id", "crp-profile", "--intent-file", intentPath, "--delivery-profile", "a"], home);
  ok(init, "init 应成功");
  const taskDir = JSON.parse(parseStdout(init)).taskDir;
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
  assert.equal(task.deliveryProfile, "a", "init 显式分级 a");
  // 声明层前置：候选快照 + 处置表 detectionSha256 + resolved 权威（stub resolver）
  const candidateDocument = { schemaVersion: 1, inputHashes: { intent: sha256("intent") }, candidates: [{ id: "candidate-host", strength: "strong", signals: ["call-class:register-tool"] }], unresolved: [] };
  const candidateDir = join(taskDir, "evidence", "acceptance-v1");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, "external-contract-candidates.json"), `${JSON.stringify(candidateDocument, null, 2)}\n`);
  const detectionSha256 = sha256Text(readFileSync(join(candidateDir, "external-contract-candidates.json"), "utf8"));
  const stubResolver = join(root, "stub-resolver.mjs");
  writeFileSync(stubResolver, [
    "import { readFileSync, existsSync } from 'node:fs';",
    "const p = process.env.STUB_RESOLVER_SNAPSHOT;",
    "if (p && existsSync(p)) process.stdout.write(readFileSync(p, 'utf8'));",
    "else process.stdout.write(JSON.stringify({ schemaVersion: 1, contracts: [], snapshotSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }));",
    "",
  ].join("\n"));
  const snapshotPath = join(root, "snapshot.json");
  writeFileSync(snapshotPath, `${JSON.stringify({
    schemaVersion: 1,
    snapshotSha256: sha256("snap-profile"),
    contracts: [{ id: "EC-host", status: "resolved", authorityAggregateHash: sha256("authority-v1"), identity: { name: "host", version: "1.1.0" }, surfaces: [{ surfaceRef: "dist/types.d.ts", sha256: sha256("t") }] }],
  }, null, 2)}\n`);
  const baseAcceptance = {
    schemaVersion: 2, acceptanceVersion: 1, taskId: task.taskId, projectRoot: task.projectRoot,
    objective: "扩展装载并注册工具", nonGoals: [], riskLevel: "high", exploratoryReview: "required",
    requirements: [{
      id: "R1", kind: "invariant", statement: "工具在真实宿主注册并可调用", required: true, riskAcceptable: false,
      evidenceKinds: ["command"],
      assertions: [{
        id: "A1", statement: "工具按宿主签名执行", qualifiers: ["真实宿主"], given: "真实 official-runner 装载扩展", when: "调用工具", then: "返回结果对象",
        adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"], requiredEnvironment: { kind: "official-runner", capability: "register-tool-and-invoke" },
      }],
    }],
    adversarialForms: [{ id: "AF1", assertionId: "A1", qualifier: "真实宿主", entryPoint: "auto", initialState: "已注册", operation: "带错签名调用", timing: "命令期", expected: "被真实宿主拒绝", testAssetRefs: ["test-A1"], rationale: "签名差异" }],
    externalContracts: [{
      id: "EC-host", essential: true, authorityRequest: { resolverKind: "installed-npm-package", locator: "@scope/host" },
      capabilities: [{ id: "register-tool-and-invoke", minEnvironment: "official-runner", observable: "x", surfaceRefs: ["dist/types.d.ts"], detectionClasses: ["register-tool"] }],
    }],
    externalContractReview: { detectionSha256, dispositions: [{ candidateId: "candidate-host", disposition: "bound", contractId: "EC-host" }] },
  };
  const writePackage = (reviewDimensions) => {
    const acceptance = { ...baseAcceptance, reviewDimensions };
    writeFileSync(join(taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
    writeFileSync(join(taskDir, "increments.json"), `${JSON.stringify({
      schemaVersion: 1, acceptanceVersion: 1,
      items: [{ id: "I1", kind: "contract-smoke", title: "契约冒烟", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
    }, null, 2)}\n`);
    return GATE_MODULE.runGateCommand(["validate-acceptance", "--task-dir", taskDir], home, {
      DELIVERY_EXTERNAL_CONTRACT_RESOLVER: stubResolver,
      STUB_RESOLVER_SNAPSHOT: snapshotPath,
    });
  };
  // 超出降档词表（多出 smoke）→ 拒绝，三段式 + 两条出路
  const rejected = writePackage(["外部契约", "故障形态", "smoke"]);
  assert.notEqual(rejected.status, 0, "超出降档词表的 reviewDimensions 应被拒");
  assert.match(rejected.stderr, /deliveryProfile=a 且验收含外部契约时/, "须点名分级与契约条件");
  assert.match(rejected.stderr, /外部契约 \/ 故障形态/, "须给出降档词表");
  assert.match(rejected.stderr, /set-delivery-profile/, "恢复动作须含改分级出路");
  assert.match(rejected.stderr, /恢复动作：/, "三段式齐全");
  // 收窄到两类 → 放行（声明层其余检查同时满足）
  const narrowed = writePackage(["外部契约", "故障形态"]);
  assert.equal(narrowed.status, 0, `收窄到降档词表应放行：${narrowed.stderr}`);
});
