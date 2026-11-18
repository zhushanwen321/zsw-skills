// assurance-repair-loop-defect-family-v6.test.mjs — ARL 缺陷族组合分析（§9.1）校验行为
//
// 覆盖（V5 完整性设计 §9.1 最小同族组合 + 本次收敛）：
//   1. mutationWaiver 豁免形态移除回归锚：blocker 轮 mutationRefs 空一律结构非法
//      （附 waiver 字段也救不回）；非 blocker 轮允许 mutationRefs 空数组
//   2. 三组证据引用（redBeforeFix / greenAfterFix / mutationRefs）结构校验：非空字符串
//      数组，缺组即指名报错
//   3. 证据引用在盘存在性核对的路径解析（defectFamilyRefPaths）：相对路径挂 taskDir、
//      绝对路径原样、# 用例名后缀剥离——核对基准 = 修复报告所在 taskDir
//   4. 产物级守卫：ARL 产物不得再含 mutationWaiver；在盘存在性核对调用与含路径 +
//      恢复动作的红错误在位
//
// 运行：node --test scripts/tests/assurance-repair-loop-defect-family-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/pi/assurance-repair-loop-v6.js"), "utf8");

// 产物提取：defectFamilyError / defectFamilyRefPaths 都是模块级纯函数（TS 剥除后名字保留）
const errorMatch = /function defectFamilyError\([\s\S]*?\n}\n/.exec(PI);
const refPathsMatch = /function defectFamilyRefPaths\([\s\S]*?\n}\n/.exec(PI);
assert.ok(errorMatch, "pi 产物应含 defectFamilyError（提取前提）");
assert.ok(refPathsMatch, "pi 产物应含 defectFamilyRefPaths（在盘存在性核对前提）");
const { defectFamilyError, defectFamilyRefPaths } = new Function(
  `${errorMatch[0]}\n${refPathsMatch[0]}\nreturn { defectFamilyError, defectFamilyRefPaths };`,
)();

function family(overrides = {}) {
  return {
    rootCause: "关闭检查只在条目循环前执行一次",
    dimensions: [{ name: "待写条目数", values: ["1", "2"] }],
    selectedCases: ["单条写前关闭", "两条中第一条后关闭"],
    redBeforeFix: ["evidence/red-fail.log"],
    greenAfterFix: ["evidence/green.log#用例一"],
    mutationRefs: ["evidence/mutation-red.log"],
    ...overrides,
  };
}
const outcome = (fam) => ({ summary: "s", filesChanged: ["a.ts"], testEvidence: "t", affectedAssertionIds: [], defectFamily: fam });

// ── 1. mutationWaiver 移除回归锚 ──

test("blocker 轮 mutationRefs 空一律结构非法：waiver 字段在场也救不回（§9.1 无豁免形态）", () => {
  const blocked = defectFamilyError(outcome(family({ mutationRefs: [], mutationWaiver: "撤销验证不可行的长论证" })), true);
  assert.match(blocked, /mutationRefs 不得为空/, "blocker 轮空 mutationRefs 必须被拒");
  assert.doesNotMatch(blocked, /waiver/, "拒绝信息不得再指向豁免通道");
  // 非数组与非空串条目在 blocker 轮同样非法
  assert.match(defectFamilyError(outcome(family({ mutationRefs: "not-array" })), true), /须为字符串数组/);
  assert.match(defectFamilyError(outcome(family({ mutationRefs: ["  "] })), true), /须为字符串数组/);
});

test("非 blocker 轮 mutationRefs 空数组合法；blocker 轮非空 mutationRefs 合法", () => {
  assert.equal(defectFamilyError(outcome(family({ mutationRefs: [] })), false), "", "非 blocker 轮空 mutationRefs 不算结构非法");
  assert.equal(defectFamilyError(outcome(family()), true), "", "blocker 轮三组证据齐全 = 合法");
});

// ── 2. 三组证据引用结构校验 ──

test("redBeforeFix / greenAfterFix / mutationRefs 缺组或空条目即指名报错", () => {
  assert.match(defectFamilyError(outcome(family({ redBeforeFix: [] })), false), /redBeforeFix 须为非空引用数组/);
  assert.match(defectFamilyError(outcome(family({ greenAfterFix: [] })), false), /greenAfterFix 须为非空引用数组/);
  assert.equal(defectFamilyError(outcome(null), false), "missing");
  assert.equal(
    defectFamilyError(outcome({ ...family(), selectedCases: [] }), false),
    "missing",
    "selectedCases 空 = 无组合即无分析 → missing",
  );
});

// ── 3. 存在性核对的路径解析 ──

test("defectFamilyRefPaths：相对路径挂 taskDir、绝对路径原样、# 用例名后缀剥离", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arl-defect-family-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = defectFamilyRefPaths(
    family({
      redBeforeFix: ["evidence/red-fail.log", "/abs/elsewhere/red.log"],
      greenAfterFix: ["evidence/green.log#用例一"],
      mutationRefs: ["evidence/mutation-red.log#revert 后见红"],
    }),
    dir,
  );
  assert.deepEqual(paths, [
    join(dir, "evidence/red-fail.log"),
    "/abs/elsewhere/red.log",
    join(dir, "evidence/green.log"),
    join(dir, "evidence/mutation-red.log"),
  ]);
  // taskDir 带尾斜杠不产生双斜杠
  const pathsTrailing = defectFamilyRefPaths(family(), `${dir}/`);
  assert.ok(pathsTrailing.every((p) => !p.includes("//")), "尾斜杠归一，不产生 // 形态");
});

// ── 4. 产物级守卫 ──

test("ARL 产物：waiver 逻辑零引用；在盘存在性核对（含路径 + 恢复动作）与 prompt 约定在位", () => {
  // 校验逻辑与引擎消费点不得再读 mutationWaiver（pi 壳的 SCHEMA_RepairBuilderOutcome
  // 属性声明属壳级残留，另行工作清理——行为上本测试第 1 用例已钉住 waiver 救不回）
  assert.ok(!/family\.mutationWaiver/.test(PI), "校验逻辑不得再读 mutationWaiver");
  assert.ok(!errorMatch[0].includes("Waiver"), "defectFamilyError 函数体不得含豁免分支");
  assert.ok(PI.includes("证据引用在盘缺失"), "在盘存在性核对红错误在位（含缺失路径）");
  assert.ok(PI.includes("恢复动作：把三组证据文件落到引用路径"), "红错误须带恢复动作");
  assert.ok(PI.includes("NODE_CHECK_FILES, ...refPaths"), "存在性核对经 NODE_CHECK_FILES 逐文件核对");
  assert.ok(PI.includes("#用例名"), "prompt 须约定 greenAfterFix 的 路径#用例名 条目形态（机器可核对前提）");
});
