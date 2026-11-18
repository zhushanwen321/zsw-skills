// impl-plan-render-v6-contract-spike.test.mjs — units[].kind=contract-spike 的 additive
// 渲染断言（《V6 运行可用性与外部契约守门升级设计》§7.2 T3 / 丁 渲染支持）
//
// 背景：impl-plan 的契约 spike 单元以 additive 可选字段 kind: "contract-spike" 标记
// （唯一登记值；与 dev-flow 线的接口契约 = spike 单元在 units[] 中以该字段标记、业务
// 单元经既有 deps 依赖它，撰写要求见 tech-design-v6 flow/plan.md「外部契约任务」节，
// 字段登记与渲染落点见 references/impl-plan-mapping.md §1.2）。渲染契约 =
// unit.kind=contract-spike 在渲染视图呈现为单元标题后缀标注（Unit 列 `<id>（契约 spike）`）。
//
// 本文件只放 additive 断言，不改既有 impl-plan-render-v6.test.mjs（其 fixture 无 kind
// 字段，渲染结果须逐字节不变——无 kind 缺省无标注是本文件的反向断言）。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const RENDERER = join(
  ROOT,
  "skills",
  "self",
  "dev-workflow",
  "tech-design-v6",
  "scripts",
  "render-impl-plan.mjs",
);

/** 最小合法计划 + 契约 spike 单元（DAG 唯一根）与两个业务单元（deps 依赖 spike） */
const SPIKE_PLAN = {
  name: "contract-spike-plan",
  designDoc: "/tmp/fake-skill-data/tech-design/slug/spike",
  baseline: "aaa000",
  skillVersion: "6.2.0",
  sectionMap: { goal: "§1", mechanism: "§3", acceptance: "§4", breakdown: "§5" },
  units: [
    {
      id: "u-contract-spike",
      kind: "contract-spike",
      responsibility: "外部契约冒烟 spike",
      territory: ["scripts/runtime-probe.mjs"],
      deps: [],
      isolation: "plain",
      acceptance: ["A1"],
      decisionTier: "A",
      incrementId: "inc-0-contract-smoke",
    },
    {
      id: "u-foundation",
      responsibility: "共享契约根",
      territory: ["src/types.ts"],
      deps: ["u-contract-spike"],
      depReasons: { "u-contract-spike": "契约形态未确认前不展开业务实现" },
      isolation: "plain",
      acceptance: ["A2"],
      decisionTier: "B",
      incrementId: "inc-1",
    },
    {
      id: "u-main",
      responsibility: "主实现",
      territory: ["src/main.ts"],
      deps: ["u-contract-spike", "u-foundation"],
      isolation: "plain",
      acceptance: ["A3"],
      decisionTier: "B",
      incrementId: "inc-1",
    },
  ],
  testPlan: { fullSuite: "pnpm test" },
  acceptancePlan: [{ id: "A1", item: "契约冒烟", level: "L3", group: "核心", deps: [], optimization: "可脚本化" }],
};

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "impl-plan-spike-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlan(dir, plan, fileName = "spike.impl-plan.json") {
  const planPath = join(dir, fileName);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
}

function runRenderer(planPath, extraArgs = []) {
  const r = spawnSync("node", [RENDERER, planPath, ...extraArgs], { encoding: "utf8" });
  assert.notEqual(r.status, null, `渲染器应正常启动：${r.error?.message ?? r.stderr}`);
  return r;
}

const mdOf = (planPath) => planPath.replace(/\.impl-plan\.json$/, ".impl-plan.md");

test("contract-spike 单元渲染为 Unit 列后缀标注（<id>（契约 spike））", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, SPIKE_PLAN);
  const r = runRenderer(planPath);
  assert.equal(r.status, 0, `含 kind 字段的计划须可渲染：${r.stderr}`);
  const md = readFileSync(mdOf(planPath), "utf8");
  assert.match(
    md,
    /\| u-contract-spike（契约 spike） \| 外部契约冒烟 spike \| scripts\/runtime-probe\.mjs \| — \| plain \| A1 \| A \| inc-0-contract-smoke \|/,
    "spike 单元行 Unit 列带后缀标注，其余列不变",
  );
});

test("无 kind 字段的单元渲染不变（additive 缺省空形态，存量计划零影响）", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, SPIKE_PLAN);
  runRenderer(planPath);
  const md = readFileSync(mdOf(planPath), "utf8");
  assert.match(md, /\| u-foundation \| 共享契约根 \| src\/types\.ts \| u-contract-spike（契约形态未确认前不展开业务实现） \| plain \| A2 \| B \| inc-1 \|/);
  assert.match(md, /\| u-main \| 主实现 \| src\/main\.ts \| u-contract-spike、u-foundation \| plain \| A3 \| B \| inc-1 \|/);
  assert.ok(!md.includes("u-foundation（契约 spike）"), "业务单元不得被误标");
  assert.ok(!md.includes("u-main（契约 spike）"), "业务单元不得被误标");
});

test("kind 非 contract-spike 的值不标注（渲染器不校验取值，只认唯一登记值）", (t) => {
  const dir = makeDir(t);
  const broken = JSON.parse(JSON.stringify(SPIKE_PLAN));
  broken.units[0].kind = "dev"; // 非登记值：不标注、不报错（语义归 D0 编译门）
  const planPath = writePlan(dir, broken, "other-kind.impl-plan.json");
  const r = runRenderer(planPath);
  assert.equal(r.status, 0, `非登记 kind 值不得拦截渲染：${r.stderr}`);
  const md = readFileSync(mdOf(planPath), "utf8");
  assert.match(md, /\| u-contract-spike \| 外部契约冒烟 spike \|/);
  assert.ok(!md.includes("（契约 spike）"), "非 contract-spike 值不得加标注");
});

test("--check 往返：含 kind 字段的渲染视图与 JSON 自证一致", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, SPIKE_PLAN);
  runRenderer(planPath);
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 0, `--check 应绿：${r.stderr}`);
  assert.match(r.stdout, /CHECK PASS/);
});

test("手改视图（删后缀标注）被 --check 检出", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, SPIKE_PLAN);
  runRenderer(planPath);
  const mdPath = mdOf(planPath);
  const tampered = readFileSync(mdPath, "utf8").replace("u-contract-spike（契约 spike）", "u-contract-spike");
  assert.notEqual(tampered, readFileSync(mdPath, "utf8"), "篡改须真实发生");
  writeFileSync(mdPath, tampered);
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 1, "手改后 --check 必须红");
  assert.match(r.stderr, /渲染不一致/);
});

test("生成视图头部元数据含渲染器版本（additive 渲染支持的观测依据）", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, SPIKE_PLAN);
  runRenderer(planPath);
  const md = readFileSync(mdOf(planPath), "utf8");
  assert.match(md, /render-impl-plan\.mjs v1\.1\.0/, "渲染器版本随 additive 渲染支持升级");
});
