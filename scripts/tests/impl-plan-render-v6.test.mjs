// impl-plan-render-v6.test.mjs — impl-plan 渲染器已知答案样例（设计稿 §7.3 / §9.1）
//
// 被测实现：skills/self/dev-workflow/tech-design-v6/scripts/render-impl-plan.mjs
// （JSON 单源权威 → .impl-plan.md 确定性渲染视图；--check 防手改）。
// 元素 ↔ 字段权威落点 = tech-design-v6/references/impl-plan-mapping.md，往返断言按该表逐节核对。
//
// 用例：渲染确定性（两次逐字节一致）/ --check 绿 / --check 检出手改 / 元数据注释不参与等价 /
// JSON 缺字段报语义缺口（列缺失路径，不猜测渲染）/ 解析失败可操作 / 往返无损（含非空
// 合理偏差、残留风险、变更历史）/ additive 字段缺省空形态 / 视图缺失 / 用法错误。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(
  ROOT,
  "skills",
  "self",
  "dev-workflow",
  "tech-design-v6",
  "scripts",
  "render-impl-plan.mjs",
);

/** 全字段 fixture：含非空合理偏差、残留风险、变更历史（设计稿 §9.1 无损往返样例必含三节） */
const FULL_PLAN = {
  name: "demo-plan",
  designDoc: "/tmp/fake-skill-data/tech-design/slug/demo",
  baseline: "abc123def",
  date: "2026-11-17",
  headerNote: ["v2 修订（并行度复审 P1 采纳）见文末变更历史。"],
  skillVersion: "5.3.0",
  sectionMap: {
    goal: "§1 背景目标",
    mechanism: "§3.1 终态",
    acceptance: "§4.1 验证场景",
    breakdown: "§5.1 拆分单元",
    验收契约: "交付任务目录 acceptance.json（v3）",
  },
  goalSnapshot: {
    problem: "示例问题一句话。",
    goals: ["GL1：示例目标一", "GL2：示例目标二"],
    outOfScope: "示例范围外。",
  },
  units: [
    {
      id: "u-foundation",
      responsibility: "共享契约根",
      territory: ["src/types.ts", "src/index.ts"],
      deps: [],
      isolation: "plain",
      acceptance: ["A1"],
      decisionTier: "A",
    },
    {
      id: "u-main",
      responsibility: "主实现",
      territory: ["src/main.ts"],
      deps: ["u-foundation"],
      depReasons: { "u-foundation": "编译依赖：消费共享类型" },
      isolation: "plain",
      acceptance: ["A2", "A3"],
      decisionTier: "B",
      incrementId: "inc-1",
    },
  ],
  unitsNotes: ["波次覆盖对账：G1→u-main。"],
  dagNote: {
    nodeLabels: { "u-main": "主实现单元" },
    criticalPath: "u-foundation → u-main（深度 2）",
    parallelWindows: ["根波次 {u-foundation} 单独成波"],
    edgeReasons: [{ edge: "u-foundation→u-main", reason: "编译依赖：共享类型" }],
  },
  testPlan: {
    incrementalCommands: [
      {
        incrementId: "inc-1",
        unitIds: ["u-main"],
        command: 'node --test "tests/demo/*.test.mjs"',
        timeoutMs: 300000,
      },
    ],
    fullSuite: { program: "pnpm", args: ["-C", "packages/demo", "test"] },
    fullSuiteChecks: [
      { id: "chk-build", command: "pnpm build", kind: "产物类" },
      { id: "chk-lint", command: "pnpm lint", kind: "验证类", note: "含 typecheck" },
      { id: "chk-full", command: { program: "pnpm", args: ["test"] }, kind: "验证类" },
    ],
    // artifacts 与 fullSuiteChecks 同时在场：artifacts 是 Gate A 消费的产物类子集，
    // 视图侧由 fullSuiteChecks 承载，不重复渲染（断言见「往返无损」用例）
    artifacts: [{ id: "build-e2e", command: { program: "pnpm", args: ["build:e2e"] } }],
    fullSuiteNote: ["全量段范围 = 改动范围 + 依赖闭包。"],
  },
  acceptancePlanIntro: "项目无 verification skill → 验证资产列统一填 -。",
  acceptancePlan: [
    {
      id: "A1",
      item: "契约静态核对",
      level: "L0 静态",
      group: "核心",
      deps: [],
      optimization: "L0 可消化",
    },
    {
      id: "A2",
      item: "主链路行为",
      level: "L3 脚本",
      group: "核心",
      deps: ["A1"],
      optimization: "可脚本化",
      verifyAsset: "reuse:demo-scene",
      adversarialFormRefs: ["AF-DEMO-ONLY"],
    },
  ],
  adversarialClaim: "adversarialForm 认领对账（1/1）：A2→AF-1。",
  e2eImpactScreening: ["继承项：无（greenfield，依据 noneReason）。"],
  speedupNote: ["可降级：0 项。", "可脚本化：1 项（A2）。"],
  reasonableDeviations: [
    {
      id: "R-1",
      title: "偏差标题示例",
      content: "偏差内容与理由示例",
      impact: "影响面示例",
      disposition: "已接受",
    },
  ],
  residualRisks: [
    {
      id: "R1",
      title: "风险标题示例",
      trigger: "触发条件示例",
      impact: "影响示例",
      disposition: "处置示例",
      reexamine: "重审触发条件示例",
    },
  ],
  changeHistory: [
    { id: "v1", note: "2026-11-17，T3 首版", summary: "2 单元 / 2 验收项，自检全绿。" },
    { id: "v2", note: "2026-11-17，并行度复审采纳", summary: "边因标注补齐。" },
  ],
  associations: [
    { id: "assoc-1", kind: "contract", trigger: "src/types.ts", related: ["src/main.ts"], action: "co-change" },
  ],
  notes: ["历轮裁决备注（JSON-only，不进渲染视图）。"],
};

/** 最小合法 fixture：只含渲染必填字段（additive 全省略 → 空形态渲染） */
const MINIMAL_PLAN = {
  name: "mini-plan",
  designDoc: "/tmp/fake-skill-data/tech-design/slug/mini",
  baseline: "aaa000",
  skillVersion: "5.3.0",
  sectionMap: { goal: "§1", mechanism: "§3", acceptance: "§4", breakdown: "§5" },
  units: [
    { id: "u-only", responsibility: "唯一单元", territory: ["src/a.ts"], deps: [], isolation: "plain", acceptance: ["A1"], decisionTier: "B" },
  ],
  testPlan: { fullSuite: "pnpm test", artifacts: [{ id: "art-1", command: "pnpm build" }] },
  acceptancePlan: [
    { id: "A1", item: "唯一验收项", level: "L1", group: "核心", deps: [], optimization: "可脚本化" },
  ],
};

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "impl-plan-render-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlan(dir, plan, fileName = "demo.impl-plan.json") {
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

test("渲染确定性：同输入两次渲染逐字节一致 + 头部元数据在场", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, FULL_PLAN);
  runRenderer(planPath);
  const first = readFileSync(mdOf(planPath), "utf8");
  runRenderer(planPath);
  const second = readFileSync(mdOf(planPath), "utf8");
  assert.equal(first, second, "两次渲染须逐字节一致（无时间戳等运行时值）");
  assert.match(first, /^<!-- 生成视图：.*输入 sha256: [0-9a-f]{64}.*-->$/m, "文件头须带生成器元数据注释");
  assert.match(first, /重新生成：node /, "元数据须含重新生成命令");
});

test("--check 绿：渲染后自证通过", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, FULL_PLAN);
  runRenderer(planPath);
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 0, `--check 应绿：${r.stderr}`);
  assert.match(r.stdout, /CHECK PASS/);
});

test("--check 检出手改：改一个字节即红，错误消息含恢复命令", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, FULL_PLAN);
  runRenderer(planPath);
  const mdPath = mdOf(planPath);
  writeFileSync(mdPath, `${readFileSync(mdPath, "utf8")}x`);
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 1, "手改后 --check 必须红");
  assert.match(r.stderr, /渲染不一致/);
  assert.match(r.stderr, /权威源：/);
  assert.match(r.stderr, /恢复：node .*render-impl-plan\.mjs .*\.impl-plan\.json/);
});

test("元数据注释不参与等价：改头部元数据行 --check 仍绿", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, FULL_PLAN);
  runRenderer(planPath);
  const mdPath = mdOf(planPath);
  const content = readFileSync(mdPath, "utf8");
  // 模拟 JSON 良性重排版（哈希变化、生成器版本升级）而正文未变——不得误报
  const rewritten = content.replace(
    /^<!-- 生成视图：.*-->$/m,
    "<!-- 生成视图：由 tech-design-v6 render-impl-plan.mjs v9.9.9 从 .impl-plan.json 生成（输入 sha256: ffffffffff）。重新生成命令略 -->",
  );
  assert.notEqual(rewritten, content, "元数据改写须真实发生");
  writeFileSync(mdPath, rewritten);
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 0, `元数据变化不应误报：${r.stderr}`);
});

test("JSON 缺字段 → 语义缺口（列出缺失路径，不写视图）", (t) => {
  const dir = makeDir(t);
  const broken = JSON.parse(JSON.stringify(FULL_PLAN));
  delete broken.testPlan.fullSuite;
  delete broken.units[1].decisionTier;
  const planPath = writePlan(dir, broken, "broken.impl-plan.json");
  const r = runRenderer(planPath);
  assert.equal(r.status, 1, "缺必填字段必须红");
  assert.match(r.stderr, /语义缺口/);
  assert.match(r.stderr, /units\[1\]\.decisionTier/);
  assert.match(r.stderr, /testPlan\.fullSuite/);
  assert.match(r.stderr, /权威源：/);
  assert.ok(!existsSync(mdOf(planPath)), "语义缺口时不得写渲染视图（不猜测渲染）");
});

test("JSON 解析失败 → 输入不合法（可操作错误）", (t) => {
  const dir = makeDir(t);
  const planPath = join(dir, "bad.impl-plan.json");
  writeFileSync(planPath, "{ not json");
  const r = runRenderer(planPath);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /输入不合法/);
  assert.match(r.stderr, /解析失败/);
});

test("artifacts 条目缺 command → 语义缺口报逐条路径", (t) => {
  const dir = makeDir(t);
  const broken = JSON.parse(JSON.stringify(MINIMAL_PLAN));
  delete broken.testPlan.artifacts[0].command;
  const planPath = writePlan(dir, broken, "broken-artifacts.impl-plan.json");
  const r = runRenderer(planPath);
  assert.equal(r.status, 1, "artifacts 条目缺 command 必须红");
  assert.match(r.stderr, /语义缺口/);
  assert.match(r.stderr, /testPlan\.artifacts\[0\]\.command/);
});

test("往返无损：md 每一节按映射表回指 JSON 字段（含非空偏差/风险/变更历史）", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, FULL_PLAN);
  runRenderer(planPath);
  const md = readFileSync(mdOf(planPath), "utf8");
  // 头部
  assert.match(md, /^# demo-plan 实施计划$/m);
  assert.match(md, /基线: abc123def/);
  assert.match(md, /来源设计: \/tmp\/fake-skill-data\/tech-design\/slug\/demo/);
  assert.match(md, /日期: 2026-11-17/);
  assert.match(md, /版本: 5\.3\.0/);
  assert.match(md, /^> v2 修订（并行度复审 P1 采纳）见文末变更历史。$/m, "headerNote 渲染");
  // 0 章节映射（四固定键 + 扩展键）
  assert.match(md, /\| 背景 \/ 目标 \| §1 背景目标 \|/);
  assert.match(md, /\| 终态 \/ 机制 \| §3\.1 终态 \|/);
  assert.match(md, /\| 验收场景表 \| §4\.1 验证场景 \|/);
  assert.match(md, /\| 下一层拆分 \| §5\.1 拆分单元 \|/);
  assert.match(md, /\| 验收契约 \| 交付任务目录 acceptance\.json（v3） \|/, "sectionMap 扩展键渲染");
  // 1 目标快照
  assert.match(md, /\*\*问题一句话\*\*：示例问题一句话。/);
  assert.match(md, /- GL1：示例目标一/);
  assert.match(md, /- GL2：示例目标二/);
  assert.match(md, /\*\*范围外（逐字摘录）\*\*：示例范围外。/);
  // 2 单元列表（单元数、territory、depReasons 括注、增量归属两形态、unitsNotes）
  assert.match(md, /\| u-foundation \| 共享契约根 \| src\/types\.ts、src\/index\.ts \| — \| plain \| A1 \| A \| —（不归属增量） \|/);
  assert.match(
    md,
    /\| u-main \| 主实现 \| src\/main\.ts \| u-foundation（编译依赖：消费共享类型） \| plain \| A2、A3 \| B \| inc-1 \|/,
    "u-main 行八列逐字断言（territory/依赖括注/隔离/验收条款不被吞）",
  );
  assert.match(md, /波次覆盖对账：G1→u-main。/);
  // 3 DAG 图（节点、边、nodeLabels 覆盖、dagNote 三段）
  assert.match(md, /u-foundation\[u-foundation\]/);
  assert.match(md, /u-main\[主实现单元\]/, "dagNote.nodeLabels 覆盖默认标注");
  assert.match(md, /u-foundation --> u-main/);
  assert.match(md, /\*\*关键路径\*\*：u-foundation → u-main（深度 2）/);
  assert.match(md, /- 根波次 \{u-foundation\} 单独成波/);
  assert.match(md, /\| u-foundation→u-main \| 编译依赖：共享类型 \|/);
  // 4 测试与验收计划
  assert.match(md, /\| inc-1 \| u-main \| `node --test "tests\/demo\/\*\.test\.mjs"` \| 300000 ms \|/);
  assert.match(md, /全量命令：`pnpm -C packages\/demo test`/);
  // fullSuiteChecks 在场 → 4.2 逐条渲染（产物类/验证类标注 + note）
  assert.match(md, /- \[产物类\] chk-build：`pnpm build`/);
  assert.match(md, /- \[验证类\] chk-lint：`pnpm lint`（含 typecheck）/);
  assert.match(md, /- \[验证类\] chk-full：`pnpm test`/);
  assert.ok(!md.includes("build-e2e"), "fullSuiteChecks 在场时 artifacts 不重复渲染（兜底退位）");
  assert.match(md, /- 全量段范围 = 改动范围 \+ 依赖闭包。/);
  assert.match(md, /项目无 verification skill → 验证资产列统一填 -。/);
  assert.match(md, /\| A1 \| 契约静态核对 \| L0 静态 \| 核心 \| — \| L0 可消化 \| - \|/);
  assert.match(md, /\| A2 \| 主链路行为 \| L3 脚本 \| 核心 \| A1 \| 可脚本化 \| reuse:demo-scene \|/);
  assert.match(md, /adversarialForm 认领对账（1\/1）：A2→AF-1。/);
  assert.match(md, /- 继承项：无（greenfield，依据 noneReason）。/);
  assert.match(md, /- 可脚本化：1 项（A2）。/);
  // 5 合理偏差登记表（非空）
  assert.match(md, /\| R-1\. 偏差标题示例 \| 偏差内容与理由示例 \| 影响面示例 \| 已接受 \|/);
  // 6 残留风险与变更历史（非空）
  assert.match(md, /\| R1\. 风险标题示例 \| 触发条件示例 \| 影响示例 \| 处置示例 \| 重审触发条件示例 \|/);
  assert.match(md, /- v1（2026-11-17，T3 首版）：2 单元 \/ 2 验收项，自检全绿。/);
  assert.match(md, /- v2（2026-11-17，并行度复审采纳）：边因标注补齐。/);
  // JSON-only 字段不进渲染视图
  assert.ok(!md.includes("assoc-1"), "associations 是 JSON-only，不渲染");
  assert.ok(!md.includes("历轮裁决备注"), "notes 是 JSON-only，不渲染");
  assert.ok(!md.includes("AF-DEMO-ONLY"), "adversarialFormRefs 是 JSON-only，不渲染（对账陈述走 adversarialClaim）");
});

test("additive 字段缺省 → 空形态渲染（不报语义缺口）", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, MINIMAL_PLAN, "mini.impl-plan.json");
  const r = runRenderer(planPath);
  assert.equal(r.status, 0, `最小合法计划须可渲染：${r.stderr}`);
  const md = readFileSync(mdOf(planPath), "utf8");
  assert.match(md, /日期: —/);
  assert.match(md, /\*\*问题一句话\*\*：—/);
  assert.match(md, /\*\*范围外（逐字摘录）\*\*：—/);
  assert.match(md, /（暂无登记）/, "偏差/风险空表渲染占位");
  assert.match(md, /变更历史：\n（暂无登记）/);
  // fullSuiteChecks 缺场 → artifacts 兜底渲染产物类条目（兜底路径不回归）
  assert.match(md, /- 产物类条目 art-1：`pnpm build`/);
});

test("视图缺失时 --check 红（恢复 = 重新生成）", (t) => {
  const dir = makeDir(t);
  const planPath = writePlan(dir, MINIMAL_PLAN, "missing-view.impl-plan.json");
  const r = runRenderer(planPath, ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /渲染视图缺失/);
  assert.match(r.stderr, /恢复：node /);
});

test("用法错误 → exit 2（缺参数 / 非 .impl-plan.json 输入）", (t) => {
  const r = spawnSync("node", [RENDERER], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用法错误/);
  const dir = makeDir(t);
  const notPlan = join(dir, "plan.json");
  writeFileSync(notPlan, "{}");
  const r2 = spawnSync("node", [RENDERER, notPlan], { encoding: "utf8" });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /\.impl-plan\.json/);
});
