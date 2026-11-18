// counter-implementation-v6.test.mjs — 反例实现检查（判别力）契约回归
// （设计《V5 交付完整性与语义可信性改造》机制一 §5.1/§5.2 轻量档 + §5.5 成本判据责任）
//
// workflow 源是单文件自包含形态（zcode 产物编译进函数体、pi 产物剥 TS），结构校验与
// 控制流无法 import 单测——本测试按 delivery-core-v6.test.mjs 的「对拍 workflow 源字面量」
// 先例做契约存在性回归：三份产物（shared 源 / zcode 产物 / pi 产物）与角色提示词必须
// 同步携带反例实现检查的关键契约，防止后续演进悄悄删掉或只改一侧。
//
// 覆盖：
//   1. 接口契约：三份产物均含 counterImplementations 五字段（obligationId /
//      counterImplementation / violatesIntent / discriminatingScenarioRef /
//      wouldPassCurrentCriteria）与布尔校验
//   2. artifact 落盘：审查隔离目录下的 r<round>-counter-implementations.json
//   3. 打回语义：wouldPass=true 的反例触发「判据判别力不足」独立打回理由（与 problems 并列）
//   4. 推荐档定位：构造反例输入是鼓励项不强制（轻量档 = 书面反例即满足）
//   5. reviewer.md 角色责任：反例实现检查 + 检测/分流硬判定 + 产品运行成本判据
//
// 运行：node --test scripts/tests/counter-implementation-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(ROOT, "skills", "self", "dev-workflow", "workflows");
const SHARED = readFileSync(join(WORKFLOWS, "src", "acceptance-design-v6.shared.ts"), "utf8");
const ZCODE = readFileSync(join(WORKFLOWS, "acceptance-design-v6.dwf.ts"), "utf8");
const PI = readFileSync(join(WORKFLOWS, "pi", "acceptance-design-v6.js"), "utf8");
const REVIEWER_ROLE = readFileSync(
  join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "references", "roles", "acceptance-reviewer.md"),
  "utf8",
);

const COUNTER_FIELDS = [
  "obligationId",
  "counterImplementation",
  "violatesIntent",
  "discriminatingScenarioRef",
  "wouldPassCurrentCriteria",
];

test("接口契约：三份产物同步携带 counterImplementations 五字段与布尔校验", () => {
  for (const [label, source] of [["shared 源", SHARED], ["zcode 产物", ZCODE], ["pi 产物", PI]]) {
    for (const field of COUNTER_FIELDS) {
      assert.ok(source.includes(field), `${label} 缺反例记录字段 ${field}（五字段契约不得单侧漂移）`);
    }
    assert.ok(source.includes("wouldPassCurrentCriteria 须为布尔"), `${label} 缺布尔结构校验`);
    assert.ok(source.includes("counterImplementations 须为数组"), `${label} 缺数组结构校验`);
  }
});

test("artifact 落盘：审查隔离目录下 r<round>-counter-implementations.json（与反馈 artifact 同目录形态）", () => {
  for (const [label, source] of [["shared 源", SHARED], ["zcode 产物", ZCODE], ["pi 产物", PI]]) {
    assert.match(source, /r\$\{round\}-counter-implementations\.json/, `${label} 缺反例 artifact 落盘路径`);
    // 与审查报告同按 acceptanceVersion+runId+round 隔离（§8.2 防覆盖历史报告）
    assert.ok(source.includes("evidence/acceptance-review/v"), `${label} 缺隔离目录前缀`);
  }
});

test("打回语义：wouldPass=true 的反例是独立打回理由，与 problems 并列且报告明示判别力不足", () => {
  for (const [label, source] of [["shared 源", SHARED], ["zcode 产物", ZCODE], ["pi 产物", PI]]) {
    assert.ok(source.includes("判据判别力不足"), `${label} 缺打回明示文案`);
    // 打回判定：problems 非空或反例可通过，二者任一即 rejected
    assert.match(source, /review\.problems\.length > 0 \|\| counterHits\.length > 0/, `${label} 缺并列打回判定`);
  }
});

test("推荐档定位：构造反例输入是提示词鼓励项，轻量档（书面反例）为底线", () => {
  for (const [label, source] of [["shared 源", SHARED], ["zcode 产物", ZCODE], ["pi 产物", PI]]) {
    assert.match(source, /鼓励项（不强制）/, `${label} 缺推荐档不强制声明`);
    assert.ok(source.includes("counterImplementations"), `${label} 缺轻量档书面反例要求`);
  }
});

test("reviewer.md 角色责任：反例实现检查、检测/分流硬判定、产品运行成本判据三责齐备", () => {
  // §5.1 判别力问题（反例实现检查）
  assert.match(REVIEWER_ROLE, /反例实现检查（判别力）/, "reviewer 角色须承担反例实现检查");
  assert.ok(REVIEWER_ROLE.includes("wouldPassCurrentCriteria=true 的反例 = 独立打回理由"), "reviewer 角色须声明独立打回理由");
  // §5.4 硬判定（恒真/恒假不算实现——语义判定在 reviewer，机器只提示）
  assert.ok(REVIEWER_ROLE.includes("恒 true、恒 false 或空变量集只能登记为未实现或残余风险"), "reviewer 角色须承担检测/分流硬判定");
  // §5.5 产品运行成本判据（默认遗漏不允许）
  assert.ok(REVIEWER_ROLE.includes("「默认遗漏」不允许"), "reviewer 角色须承担产品运行成本判据责任");
  assert.ok(REVIEWER_ROLE.includes("产品自身运行成本"), "reviewer 角色须指明成本判据范围");
});

test("pi 壳 SCHEMA 与 shared 接口对齐：counterImplementations 列入 required 且五字段齐备", () => {
  const PI_TPL = readFileSync(join(WORKFLOWS, "src", "acceptance-design-v6.pi.tpl.js"), "utf8");
  assert.match(PI_TPL, /required: \["summary", "problems", "counterImplementations"\]/, "pi SCHEMA required 须含 counterImplementations");
  for (const field of COUNTER_FIELDS) {
    assert.ok(PI_TPL.includes(field), `pi SCHEMA 缺字段 ${field}`);
  }
});
