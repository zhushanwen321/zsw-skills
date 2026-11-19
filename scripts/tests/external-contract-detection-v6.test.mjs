// external-contract-detection-v6.test.mjs — 候选探测器范围过滤回归
// （gitignored 路径排除 + intent 交付面声明块；2026-11-19 裁决：探测范围随任务交付面定）
//
// 覆盖：
//   1. glob/范围块解析单元：globToRegExp 语义（** 跨目录、* 段内、字面前缀）、
//      parseDetectionScope（无块 / 空块 / 注释行 / CRLF）、compileScopeMatchers 裸段展开
//   2. git 过滤集成：gitignored 目录内文件的真实 SDK import 不产生候选、tracked 文件正常产生
//   3. 交付面声明集成：声明块在场时只扫命中 glob 的文件（非交付面 tracked 源码被排除）、
//      裸目录段匹配递归子路径、detectionScope 字段显形、docs 信号仍可达
//   4. 非 git 仓退化：git 不可用时全量扫描 + stderr 告警（不静默）
//   5. 确定性：同输入两次运行 stdout 逐字节一致
//
// 运行：node --test scripts/tests/external-contract-detection-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DETECTOR = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "detect-external-contracts.mjs");
const MODULE = await import(pathToFileURL(DETECTOR).href);
const { compileScopeMatchers, globToRegExp, parseDetectionScope } = MODULE;

function runDetector(projectRoot, intentFile) {
  const result = spawnSync(process.execPath, [DETECTOR, "--project-root", projectRoot, "--intent-file", intentFile], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `探测器应成功\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const jsonStart = result.stdout.indexOf("{");
  return { snapshot: JSON.parse(result.stdout.slice(jsonStart)), stderr: result.stderr };
}

function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "ext-detect-scope-"));
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} 应成功：${result.stderr}`);
  };
  git(["init", "-q"]);
  return { root, git };
}

test("globToRegExp：** 跨目录、* 段内通配、字面转义、行首 / 规格化", () => {
  assert.ok(globToRegExp("docs/**").test("docs/a.md"));
  assert.ok(globToRegExp("docs/**").test("docs/x/y/z.md"));
  assert.ok(!globToRegExp("docs/**").test("docsx/a.md"));
  assert.ok(!globToRegExp("docs/**").test("docs"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/sub/a.ts"));
  assert.ok(globToRegExp("AGENTS.md").test("AGENTS.md"));
  assert.ok(!globToRegExp("AGENTS.md").test("XAGENTS.md"));
  assert.ok(globToRegExp("/docs/**").test("docs/a.md"));
  assert.ok(globToRegExp("a.b+c.md").test("a.b+c.md"));
  assert.ok(!globToRegExp("a.b+c.md").test("aXbYc.md"));
});

test("parseDetectionScope：无块/空块/注释行/CRLF 形态", () => {
  assert.equal(parseDetectionScope("普通意图文本，无声明块"), null);
  assert.equal(parseDetectionScope("<!-- delivery-detection-scope\n# 只有注释\n-->"), null);
  const block = ["<!-- delivery-detection-scope", "docs/**", "AGENTS.md", "-->"].join("\n");
  assert.deepEqual(parseDetectionScope(block), ["docs/**", "AGENTS.md"]);
  const crlf = "<!-- delivery-detection-scope\r\ndocs/**\r\n-->";
  assert.deepEqual(parseDetectionScope(crlf), ["docs/**"]);
});

test("compileScopeMatchers：不含通配符的段展开为自身 + 递归子路径", () => {
  const matchers = compileScopeMatchers(["docs", "src/**"]);
  const matches = (rel) => matchers.some((matcher) => matcher.test(rel));
  assert.ok(matches("docs"));
  assert.ok(matches("docs/a/b.md"));
  assert.ok(matches("src/a.ts"));
  assert.ok(!matches("docsx/a.md"));
  assert.ok(!matches("other/a.ts"));
});

test("git 过滤：gitignored 目录内的真实 SDK import 不产生候选，tracked 文件正常产生", () => {
  const { root, git } = makeFixtureRepo();
  try {
    writeFileSync(join(root, ".gitignore"), ".references/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), 'import react from "react";\n');
    mkdirSync(join(root, ".references", "learn", "src"), { recursive: true });
    writeFileSync(join(root, ".references", "learn", "src", "main.ts"), 'import vue from "vue";\n');
    writeFileSync(join(root, "intent.md"), "交付任务：修复日报生成器。\n");
    git(["add", "-A"]);
    const { snapshot, stderr } = runDetector(root, join(root, "intent.md"));
    const ids = snapshot.candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes("candidate-pkg-react"), `tracked 文件的 react import 应产生候选：${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("candidate-pkg-vue"), `gitignored .references 的 vue import 不应产生候选：${JSON.stringify(ids)}`);
    assert.ok(!stderr.includes("git 不可用"), "git 仓内不应触发退化告警");
    assert.ok(
      snapshot.candidates.every((candidate) => candidate.signals.every((signal) => !signal.includes(".references"))),
      "任何候选信号都不应指向 .references 路径",
    );
    assert.equal(snapshot.detectionScope, null, "无声明块时 detectionScope 为 null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("交付面声明：非交付面 tracked 源码被排除，裸目录段递归匹配，detectionScope 显形", () => {
  const { root, git } = makeFixtureRepo();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".pi", "tools"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), 'import react from "react";\n');
    writeFileSync(join(root, ".pi", "tools", "index.ts"), 'import { Type } from "@sinclair/typebox";\n');
    writeFileSync(join(root, "docs", "api.md"), "上游平台文档：https://example.com/platform 提供 sdk extension 接口。\n");
    const intent = ["交付任务：日报生成器改造。", "", "<!-- delivery-detection-scope", "src/**", "docs", "-->", ""].join("\n");
    writeFileSync(join(root, "intent.md"), intent);
    git(["add", "-A"]);
    const { snapshot } = runDetector(root, join(root, "intent.md"));
    const ids = snapshot.candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes("candidate-pkg-react"), `交付面内 src 的 react import 应产生候选：${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("candidate-pkg-typebox"), `非交付面 .pi 的 typebox import 不应产生候选：${JSON.stringify(ids)}`);
    assert.ok(ids.some((id) => id.startsWith("candidate-doc-")), `交付面内 docs 的平台 URL 应产生 weak 候选：${JSON.stringify(ids)}`);
    assert.deepEqual(snapshot.detectionScope, { source: "intent", patterns: ["src/**", "docs"] });
    assert.ok(
      snapshot.inputHashes.sourceScanInputs.every((input) => !input.startsWith(".pi/")),
      "sourceScanInputs 不应含非交付面文件",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非 git 仓：退化全量扫描并 stderr 告警（不静默）", () => {
  const root = mkdtempSync(join(tmpdir(), "ext-detect-nogit-"));
  try {
    mkdirSync(join(root, "vendor"), { recursive: true });
    writeFileSync(join(root, "vendor", "lib.js"), 'import vue from "vue";\n');
    writeFileSync(join(root, "intent.md"), "交付任务：修复脚本。\n");
    const { snapshot, stderr } = runDetector(root, join(root, "intent.md"));
    const ids = snapshot.candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes("candidate-pkg-vue"), `退化扫描应发现 vue import：${JSON.stringify(ids)}`);
    assert.match(stderr, /WARN: git 不可用或非 git 仓/, "退化路径必须向 stderr 告警");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("动态 require 一层归因：__dirname 锚定且目标在仓内 → 不进 unresolved；目标缺失或参数非字面量 → 仍进 unresolved", () => {
  const { root, git } = makeFixtureRepo();
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "helpers.cjs"), "module.exports = {};\n");
    writeFileSync(join(root, "tests", "a.test.mjs"), 'import path from "node:path";\nconst H = require(path.resolve(__dirname, "../lib/helpers.cjs"));\n');
    writeFileSync(join(root, "tests", "b.test.mjs"), 'const M = require(join(__dirname, "../missing.cjs"));\n');
    writeFileSync(join(root, "tests", "c.test.mjs"), 'const X = require(buildPath(name));\n');
    writeFileSync(join(root, "intent.md"), "交付任务：修复脚本。\n");
    git(["add", "-A"]);
    const { snapshot } = runDetector(root, join(root, "intent.md"));
    const signals = (snapshot.unresolved || []).map((item) => item.signal);
    assert.ok(!signals.some((signal) => signal.includes("a.test.mjs")), `仓内存在目标的一层归因不应进 unresolved：${JSON.stringify(snapshot.unresolved)}`);
    assert.ok(signals.some((signal) => signal.includes("b.test.mjs")), "目标不存在的动态 require 应保留 unresolved");
    assert.ok(signals.some((signal) => signal.includes("c.test.mjs")), "参数非字面量的动态 require 应保留 unresolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("确定性：同输入两次运行 stdout 逐字节一致", () => {
  const { root, git } = makeFixtureRepo();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), 'import react from "react";\n');
    const intent = ["交付任务：日报生成器。", "", "<!-- delivery-detection-scope", "src/**", "-->", ""].join("\n");
    writeFileSync(join(root, "intent.md"), intent);
    git(["add", "-A"]);
    const first = spawnSync(process.execPath, [DETECTOR, "--project-root", root, "--intent-file", join(root, "intent.md")], { encoding: "utf8" });
    const second = spawnSync(process.execPath, [DETECTOR, "--project-root", root, "--intent-file", join(root, "intent.md")], { encoding: "utf8" });
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(first.stdout.slice(first.stdout.indexOf("{")), second.stdout.slice(second.stdout.indexOf("{")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
