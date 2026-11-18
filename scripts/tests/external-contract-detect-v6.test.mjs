// external-contract-detect-v6.test.mjs —— 外部契约候选探测独立局部测试
//
// 被测实现：skills/self/dev-workflow/delivery-v6/scripts/detect-external-contracts.mjs
//（设计《V6 运行可用性与外部契约守门升级》§4.2：五类信号源、strong/weak 分级、
// unresolved 形态、候选快照 schema）。
//
// 覆盖：
//   1. manifest 信号源：pi.extensions 点路径字段（strong）+ 普通依赖（weak）+ 包自身形态（weak）
//   2. 源码调用类信号源：registerTool / registerCommand / on("context") 等七初始类识别
//   3. intent 词信号源：宿主/插件/SDK 通用词 + manifest 平台名（weak）
//   4. 测试导入形态：真实 SDK import（strong）与 harness-only（weak）
//   5. 项目文档平台说明路径：URL + 平台词（weak）
//   6. strong/weak 分级：真实 import / 调用类 / manifest 字段为 strong；词与文档为 weak
//   7. unresolved 形态：计算式外部成员访问 / 动态 import / eval / re-export 链超过一层
//   8. re-export 穿透一层归因外部包
//   9. 内置模块与本地相对 import 不产生外部候选
//  10. 输出稳定性：同输入两次 stdout 逐字节一致；改 intent 只动 intent 哈希
//  11. 退出码：缺参 / 悬空 flag → 2；路径不存在 → 3；--help → 0
//
// fixture 一律临时目录构造、用完即删（绝对路径不入仓）；不依赖真实全局安装。
//
// 运行：node --test scripts/tests/external-contract-detect-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "detect-external-contracts.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 主 fixture：五类信号源齐备的项目 */
function makeProject(t) {
  const proj = mkdtempSync(join(tmpdir(), "ec-detect-proj-"));
  write(join(proj, "package.json"), `${JSON.stringify({
    name: "fixture-ext",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["src/extension.mjs"] },
    dependencies: { "fake-host-sdk": "^1.0.0", lodash: "^4.0.0" },
  }, null, 2)}\n`);
  write(join(proj, "src", "extension.mjs"), [
    'import * as pi from "fake-host-sdk";',
    "export default function activate(ctx) {",
    '  pi.registerTool({ name: "save" });',
    '  ctx.on("context", (messages) => messages);',
    "  return 1;",
    "}",
    "",
  ].join("\n"));
  write(join(proj, "src", "reexport-passthrough.mjs"), 'export * from "fake-host-sdk";\n');
  write(join(proj, "src", "consumer.mjs"), 'import { helper } from "./reexport-passthrough.mjs";\nexport const use = () => helper();\n');
  write(join(proj, "src", "chain-a.mjs"), 'export * from "./chain-b.mjs";\n');
  write(join(proj, "src", "chain-b.mjs"), 'export * from "./chain-c.mjs";\n');
  write(join(proj, "src", "chain-c.mjs"), "export const leaf = 1;\n");
  write(join(proj, "src", "consumer-of-chain.mjs"), 'import { leaf } from "./chain-a.mjs";\nexport const v = leaf;\n');
  write(join(proj, "src", "dynamic.mjs"), 'const name = "fake-host-sdk";\nexport const load = () => import(name);\n');
  write(join(proj, "src", "computed.mjs"), [
    'import * as pi from "fake-host-sdk";',
    'export const pick = (key) => pi[key];',
    "",
  ].join("\n"));
  write(join(proj, "src", "generated.mjs"), 'export const run = (code) => eval(code);\n');
  write(join(proj, "src", "builtin-only.mjs"), 'import { readFileSync } from "node:fs";\nexport const read = (p) => readFileSync(p);\n');
  write(join(proj, "test", "sdk.test.mjs"), 'import { activate } from "fake-host-sdk";\ndescribe("sdk", () => { it("loads", () => activate({})); });\n');
  write(join(proj, "test", "harness.test.mjs"), 'import { activate } from "../src/extension.mjs";\ndescribe("local", () => { it("runs", () => activate({})); });\n');
  write(join(proj, "docs", "platform.md"), "# 平台\n\n扩展 SDK 的装载说明见 https://platform.example.com/sdk/extensions 。\n");
  write(join(proj, "intent.md"), "目标：为 fake-host 平台实现一个插件扩展，经官方 SDK 注册工具与命令。\n");
  t.after(() => rmSync(proj, { recursive: true, force: true }));
  return proj;
}

function detect(proj) {
  const run = runCli(["--project-root", proj, "--intent-file", join(proj, "intent.md")]);
  assert.equal(run.status, 0, `探测应成功：${run.stderr}`);
  return JSON.parse(run.stdout);
}

test("manifest 信号源：pi.extensions 点路径为 strong，普通依赖与包自身形态为 weak", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const byId = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]));
  assert.ok(byId.has("candidate-manifest-pi-extensions"), "pi.extensions 点路径字段应产 strong 候选");
  assert.equal(byId.get("candidate-manifest-pi-extensions").strength, "strong");
  assert.ok(byId.get("candidate-manifest-pi-extensions").signals.includes("manifest:pi.extensions"));
  assert.equal(byId.get("candidate-pkg-lodash").strength, "weak", "未 import 的普通依赖只是 weak 线索");
  assert.equal(byId.get("candidate-manifest-self-shape").strength, "weak");
  assert.ok(byId.get("candidate-manifest-self-shape").signals.includes("manifest:type-module"));
});

test("源码调用类信号源：七初始类调用点识别为 strong 并归因到 import 的外部包候选", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const pkg = snapshot.candidates.find((candidate) => candidate.id === "candidate-pkg-fake-host-sdk");
  assert.ok(pkg, "真实 SDK import 应产 strong 包候选");
  assert.equal(pkg.strength, "strong");
  assert.equal(pkg.suggestedResolver, "installed-npm-package");
  assert.equal(pkg.suggestedLocator, "fake-host-sdk");
  assert.ok(pkg.signals.some((signal) => signal.includes("call-class:register-tool")), "registerTool 调用类应被识别");
  assert.ok(pkg.signals.some((signal) => signal.includes("call-class:context-event")), 'on("context") 调用类应被识别');
  assert.ok(pkg.signals.some((signal) => signal.includes("call-class:extension-entrypoint")), "manifest 入口文件应获得 extension-entrypoint 类信号");
  assert.ok(pkg.signals.some((signal) => signal === "source:src/extension.mjs:import:fake-host-sdk"));
});

test("intent 词信号源：宿主/插件/SDK 通用词命中为 weak 候选", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const intent = snapshot.candidates.find((candidate) => candidate.id === "candidate-intent-external-terms");
  assert.ok(intent, "intent 命中外部系统词应产候选");
  assert.equal(intent.strength, "weak");
  assert.ok(intent.signals.includes("intent:sdk"));
  assert.ok(intent.signals.includes("intent:host"));
});

test("测试导入形态：真实 SDK import 为 strong，harness-only 为 weak", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const pkg = snapshot.candidates.find((candidate) => candidate.id === "candidate-pkg-fake-host-sdk");
  assert.ok(pkg.signals.some((signal) => signal.startsWith("test:test/sdk.test.mjs:import:")), "测试中真实 SDK import 应为 strong 信号");
  const harness = snapshot.candidates.find((candidate) => candidate.id === "candidate-test-harness-only");
  assert.ok(harness, "自写 harness-only 应产 weak 候选");
  assert.equal(harness.strength, "weak");
  assert.ok(harness.signals.includes("test:test/harness.test.mjs:harness-only"));
});

test("项目文档平台说明路径：URL + 平台词仅 weak 信号", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const doc = snapshot.candidates.find((candidate) => candidate.id === "candidate-doc-platform-example-com");
  assert.ok(doc, "文档 URL + 平台词应产 weak 候选");
  assert.equal(doc.strength, "weak");
  assert.ok(doc.signals.some((signal) => signal.startsWith("doc:docs/platform.md:url:")));
});

test("unresolved 形态：计算式外部成员访问 / 动态 import / eval / re-export 链超过一层", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const signals = snapshot.unresolved.map((entry) => entry.signal);
  assert.ok(signals.some((signal) => signal.includes("计算式外部成员访问") && signal.includes("computed.mjs")), "外部包绑定上的计算式访问应记 unresolved");
  assert.ok(signals.some((signal) => signal.includes("动态 import") && signal.includes("dynamic.mjs")), "动态 import 应记 unresolved");
  assert.ok(signals.some((signal) => signal.includes("运行时代码生成") && signal.includes("generated.mjs")), "eval 应记 unresolved");
  assert.ok(signals.some((signal) => signal.includes("re-export 链超过一层")), "链式本地 re-export 应记 unresolved");
  for (const entry of snapshot.unresolved) {
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, "unresolved 条目必须带理由");
  }
});

test("re-export 穿透一层：本地模块直接 re-export 外部包时归因该包", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const pkg = snapshot.candidates.find((candidate) => candidate.id === "candidate-pkg-fake-host-sdk");
  assert.ok(
    pkg.signals.some((signal) => signal === "source:src/consumer.mjs:reexport-via:src/reexport-passthrough.mjs"),
    "穿透一层 re-export 应把外部包信号归到消费方候选",
  );
});

test("内置模块与本地相对 import 不产生外部包候选", (t) => {
  const proj = makeProject(t);
  const snapshot = detect(proj);
  const ids = snapshot.candidates.map((candidate) => candidate.id);
  assert.ok(!ids.includes("candidate-pkg-node-fs"), "node: 前缀内置模块不产候选");
  assert.ok(!ids.some((id) => id.includes("extension-mjs") || id.includes("consumer")), "本地相对 import 不产包候选");
});

test("输出稳定性：同输入两次运行 stdout 逐字节一致；改 intent 只动 intent 哈希", (t) => {
  const proj = makeProject(t);
  const first = runCli(["--project-root", proj, "--intent-file", join(proj, "intent.md")]);
  const second = runCli(["--project-root", proj, "--intent-file", join(proj, "intent.md")]);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout, "同输入两次探测输出必须逐字节一致");
  const snapshot = JSON.parse(first.stdout);
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.inputHashes.intent, /^[0-9a-f]{64}$/);
  assert.match(snapshot.inputHashes.packageManifest, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(snapshot.inputHashes.sourceScanInputs) && snapshot.inputHashes.sourceScanInputs.length > 0);
  for (const entry of snapshot.inputHashes.sourceScanInputs) {
    assert.match(entry, /^[^:]+:[0-9a-f]{64}$/, "扫描输入条目形态 = <相对路径>:<sha256>");
  }
  // intent 内容变化：intent 哈希变、扫描输入集不变
  write(join(proj, "intent.md"), "目标：为 fake-host 平台实现一个插件扩展（修订）。\n");
  const third = JSON.parse(runCli(["--project-root", proj, "--intent-file", join(proj, "intent.md")]).stdout);
  assert.notEqual(third.inputHashes.intent, snapshot.inputHashes.intent);
  assert.deepEqual(third.inputHashes.sourceScanInputs, snapshot.inputHashes.sourceScanInputs);
});

test("退出码：缺参 / 悬空 flag → 2；路径不存在 → 3；--help → 0", (t) => {
  const proj = makeProject(t);
  const intent = join(proj, "intent.md");
  assert.equal(runCli(["--project-root", proj]).status, 2, "缺 --intent-file = 用法错误");
  assert.equal(runCli(["--intent-file", intent]).status, 2, "缺 --project-root = 用法错误");
  assert.equal(runCli(["--project-root", proj, "--intent-file"]).status, 2, "悬空 flag = 用法错误");
  assert.equal(runCli(["--project-root", join(proj, "no-such-dir"), "--intent-file", intent]).status, 3, "project-root 不存在 = 运行错误");
  assert.equal(runCli(["--project-root", proj, "--intent-file", join(proj, "no-intent.md")]).status, 3, "intent 文件不存在 = 运行错误");
  assert.equal(runCli(["--help"]).status, 0);
  // 运行错误的 stderr 是三段式（什么不合法 → 权威源 → 恢复动作）
  const bad = runCli(["--project-root", join(proj, "no-such-dir"), "--intent-file", intent]);
  assert.match(bad.stderr, /运行错误/);
  assert.match(bad.stderr, /权威源/);
  assert.match(bad.stderr, /恢复动作/);
  assert.equal(bad.stdout, "", "失败时 stdout 不输出候选快照");
});
