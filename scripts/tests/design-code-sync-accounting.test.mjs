// design-code-sync-accounting.test.mjs — W4 记账 diff changed 判定的独立局部测试
//
// 覆盖（对应实现：workflows/src/design-code-sync-loop.shared.ts 的纯函数
// accountingDiffChangedSet——D5 规则⑤记账三态判定的输入集合计算）：
//   1. 持有者指纹差捕获（组改过的文件）
//   2. 多组同持按任一快照不同判
//   3. 删除文件经 null 哨兵指纹差捕获
//   4. 无快照持有者的记账时点盘上脏文件不逃出判定（新增文件/批外脏文件——设计 D5
//      明令不存在逃出 diff 集合的路径；此前实现带快照持有守卫，无主脏文件静默丢失）
//   5. 仅申报而未落盘的文件不误报（申报存在性由调用方单独并入）
//   6. 读盘时点已消失的瞬时文件不判（读盘 = 记账权威读点）
//
// 形态 = 零转抄探针：从单源 transpile 后提取真实函数源码在 vm 中执行，不复制逻辑。
// 运行：node --test scripts/tests/design-code-sync-accounting.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "self",
  "dev-workflow",
  "workflows",
  "src",
  "design-code-sync-loop.shared.ts",
);

/** 从单源提取 accountingDiffChangedSet 真实源码，transpile 后在 vm 里取可调用引用 */
function loadFn() {
  const src = readFileSync(SRC, "utf-8");
  const m = src.match(/^function accountingDiffChangedSet\([\s\S]*?^\}/m);
  assert.ok(m, "单源中未找到 accountingDiffChangedSet 顶层函数——提取探针与实现失配，须同步更新");
  const js = ts.transpileModule(m[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return vm.runInNewContext(`${js}\naccountingDiffChangedSet`, {}, { timeout: 5000 });
}

/** 成员构造 helper：snapshot = 绝对路径→指纹 Map */
function member(snapshotEntries) {
  return { snapshot: new Map(snapshotEntries) };
}

const F = (p) => `/repo/${p}`;

test("持有者指纹差捕获", () => {
  const fn = loadFn();
  const unit = [member([[F("a.ts"), "v1"]])];
  const changed = fn(unit, [F("a.ts")], new Set(), new Map([[F("a.ts"), "v2"]]));
  assert.ok(changed.has(F("a.ts")));
});

test("多组同持按任一快照不同判", () => {
  const fn = loadFn();
  const unit = [member([[F("a.ts"), "v1"]]), member([[F("a.ts"), "v1"]])];
  const same = fn(unit, [F("a.ts")], new Set(), new Map([[F("a.ts"), "v1"]]));
  assert.ok(!same.has(F("a.ts")));
  const drifted = fn(unit, [F("a.ts")], new Set(), new Map([[F("a.ts"), "v3"]]));
  assert.ok(drifted.has(F("a.ts")));
});

test("删除文件经 null 哨兵指纹差捕获", () => {
  const fn = loadFn();
  const unit = [member([[F("gone.ts"), "v1"]])];
  const changed = fn(unit, [F("gone.ts")], new Set(), new Map([[F("gone.ts"), null]]));
  assert.ok(changed.has(F("gone.ts")));
});

test("无快照持有者的记账时点盘上脏文件不逃出判定", () => {
  const fn = loadFn();
  // 运行期新建的无主文件：不在任何组派发前快照里，但记账读盘时在 porcelain 脏清单
  const unit = [member([[F("a.ts"), "v1"]])];
  const changed = fn(unit, [F("a.ts"), F("stray-new.ts")], new Set([F("stray-new.ts")]), new Map([[F("stray-new.ts"), "x"]]));
  assert.ok(changed.has(F("stray-new.ts")), "无主脏文件必须进 changed 走三态判定（挂起或呈报），不得静默丢失");
});

test("仅申报而未落盘的文件不误报", () => {
  const fn = loadFn();
  // union 含申报文件（claimSet 来源）但盘上干净（不在 curAbs）——不因申报而 changed
  const unit = [member([[F("a.ts"), "v1"]])];
  const changed = fn(unit, [F("a.ts"), F("claimed.ts")], new Set(), new Map([[F("claimed.ts"), "x"]]));
  assert.ok(!changed.has(F("claimed.ts")));
});

test("读盘时点已消失的瞬时文件不判", () => {
  const fn = loadFn();
  // porcelain 与读盘之间被删：current 无该 key——以读盘为记账权威读点
  const unit = [member([[F("a.ts"), "v1"]])];
  const changed = fn(unit, [F("a.ts"), F("ephemeral.ts")], new Set([F("ephemeral.ts")]), new Map());
  assert.ok(!changed.has(F("ephemeral.ts")));
});
