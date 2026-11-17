import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "verification-index.mjs");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
}

/** 最小五输入 fixture：验收包（2 断言）+ 六章节设计包 + impl-plan + dev exec-plan（含开发期 e2e verify 节点）。
 *  设计包按真实布局（references/skill-data-addressing.md §2）：<slug>/demo-design/ 子目录放六章节
 *  JSON，<slug>/demo-design.rendered.md 平铺同层——designDirFromDocPath 据此推导设计目录。
 *  AX1 有完整引用链（机制对账→D1→s5 单元 U1；增量归属 u-main；AF1 被 acceptancePlan 认领→资产 asset-1）；
 *  AX2 只有机制对账行，其余引用为空——空集合是查询事实，索引照实登记（§5.2 红线）。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "verification-index-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const designRoot = join(root, "design");
  const designDir = join(designRoot, "demo-design");
  const taskDir = join(root, "task");
  mkdirSync(designDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeJson(join(taskDir, "acceptance.json"), {
    schemaVersion: 2,
    requirements: [
      {
        id: "R1",
        assertions: [
          { id: "AX1", adversarialFormRefs: ["AF1"], testAssetRefs: ["asset-1"], dependsOn: { incrementIds: ["inc-1"], mechanismRefs: [], testAssetRefs: [] } },
          { id: "AX2", adversarialFormRefs: [], testAssetRefs: ["asset-x"] },
        ],
      },
    ],
    adversarialForms: [
      { id: "AF1", assertionId: "AX1", qualifier: "q", entryPoint: "e", initialState: "i", operation: "o", timing: "t", expected: "x", testAssetRefs: ["asset-1"], rationale: "r" },
    ],
  });
  writeJson(join(taskDir, "increments.json"), { schemaVersion: 1, acceptanceVersion: 1, items: [{ id: "inc-1", title: "增量一" }] });
  writeJson(join(designDir, "meta.json"), {
    acceptanceBinding: { acceptanceVersion: 1, acceptancePackageSha256: "x", taskDir },
  });
  writeJson(join(designDir, "s3-solution.json"), { decisions: [{ id: "D1", unitRefs: ["U1"] }] });
  writeJson(join(designDir, "s4-accept.json"), {
    criterionMechanisms: [
      { assertionId: "AX1", decisionIds: ["D1"], mechanismRefs: ["D1.choice"], consistency: "pass", counterexample: "检查过程", resolution: "" },
      { assertionId: "AX2", decisionIds: ["D2"], mechanismRefs: ["D2.choice"], consistency: "pass", counterexample: "检查过程", resolution: "" },
    ],
    verificationBindings: [{ adversarialFormId: "AF1", testRef: "asset-1", preconditions: ["p"], actions: ["a"], assertions: ["t"] }],
  });
  writeJson(join(designDir, "s5-breakdown.json"), { units: [{ id: "U1", title: "t", justification: "j", files: ["a.ts"], checkpoints: [] }], fileMap: "m" });
  writeJson(join(root, "impl-plan.json"), {
    units: [{ id: "u-main", responsibility: "r", territory: ["src/"], deps: [], isolation: "plain", acceptance: ["条款"], decisionTier: "B", incrementId: "inc-1" }],
    acceptancePlan: [{ id: "A1", item: "i", level: "L3", group: "core", deps: ["u-main"], optimization: "o", verifyAsset: "reuse:asset-1", adversarialFormRefs: ["AF1"] }],
  });
  // dev 模式 exec-plan：acceptance.nodes 空数组 = acceptance exec-plan 未生成（compile.md §2「本步先空着」）
  const execPlanPath = join(root, "exec-plan.json");
  writeJson(execPlanPath, {
    version: 1,
    mode: "dev",
    projectRoot: "/p",
    planPath: join(root, "impl-plan.json"),
    designDocPath: join(designRoot, "demo-design.rendered.md"),
    baseline: "abc",
    statusPath: join(root, "status.json"),
    nodes: [
      { id: "u-main", kind: "dev", deps: [], territory: ["src/"], promptFile: "p.md", testCommand: { program: "node", args: ["test"] } },
      { id: "verify-e2e", kind: "verify", deps: ["u-main"], script: "s.sh", artifactsDir: "a" },
    ],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  });
  return { root, designRoot, designDir, taskDir, execPlanPath, indexPath: join(root, "verification-index.json") };
}

function build(fx, execPlanPath) {
  return run(["build", "--exec-plan", execPlanPath ?? fx.execPlanPath]);
}

test("build：rows 逐字段来自既有引用派生，acceptance 未生成时 acceptanceNodeIds 空", (t) => {
  const fx = fixture(t);
  const result = build(fx);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  assert.equal(index.schemaVersion, 1);
  // 五输入哈希（§5.2）：独立设计能力快照缺省时 projectCapabilities 为 null，验收包存在时全键非 null
  for (const key of ["acceptancePackage", "designPackage", "implPlan", "projectCapabilities", "execPlan"]) {
    assert.ok(Object.hasOwn(index.inputHashes, key), `inputHashes 缺 ${key}`);
  }
  for (const key of ["acceptancePackage", "designPackage", "implPlan", "execPlan"]) {
    assert.match(index.inputHashes[key], /^[0-9a-f]{64}$/, `inputHashes.${key} 应为 sha256`);
  }
  assert.equal(index.inputHashes.projectCapabilities, null);
  // 快照缺省 = 资产 id 无从回溯：索引顶层 note 显式登记核验缺口（不静默放行）
  assert.match(index.note, /资产 id 未核验（能力快照缺失/);
  const ax1 = index.rows.find((row) => row.assertionId === "AX1");
  // 派生链逐字段：机制对账→decisionIds；断言 refs ∪ 场景反查→adversarialFormIds；
  // s5 unitRefs + 增量归属 + acceptancePlan deps→unitIds；verifyAsset reuse→资产；dev 模式→节点空
  assert.deepEqual(ax1.decisionIds, ["D1"]);
  assert.deepEqual(ax1.adversarialFormIds, ["AF1"]);
  assert.deepEqual(ax1.unitIds, ["U1", "u-main"]);
  assert.deepEqual(ax1.verificationAssetIds, ["asset-1"]);
  assert.deepEqual(ax1.acceptanceNodeIds, []);
  // AX2 无反例场景引用、无认领——空集合照实登记，不算失败
  const ax2 = index.rows.find((row) => row.assertionId === "AX2");
  assert.deepEqual(ax2.decisionIds, ["D2"]);
  assert.deepEqual(ax2.adversarialFormIds, []);
  assert.deepEqual(ax2.unitIds, []);
  assert.deepEqual(ax2.acceptanceNodeIds, []);
});

test("build：能力快照存在时纳入 inputHashes；acceptance exec-plan 生成后重建填充 acceptanceNodeIds", (t) => {
  const fx = fixture(t);
  writeJson(join(fx.root, "project-capabilities.json"), {
    schemaVersion: 1,
    projectRoot: "/p",
    observedAt: "2026-11-17T00:00:00Z",
    inputHashes: {},
    commands: [],
    verificationAssets: [{ id: "asset-1", kind: "scenario", path: "s.js", sha256: "h", source: { kind: "scenario-manifest", ref: "r" } }],
    unknowns: [],
  });
  let result = build(fx);
  assert.equal(result.status, 0, result.stderr);
  let index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  assert.match(index.inputHashes.projectCapabilities, /^[0-9a-f]{64}$/);
  // acceptance 模式 exec-plan（D3 编译产物）：verify 节点携带 adversarialFormRefs → 重建后归属 AX1
  const accExecPlan = join(fx.root, "exec-plan-acceptance.json");
  writeJson(accExecPlan, {
    version: 1,
    mode: "acceptance",
    projectRoot: "/p",
    planPath: join(fx.root, "impl-plan.json"),
    designDocPath: join(fx.designRoot, "demo-design.rendered.md"),
    baseline: "abc",
    statusPath: join(fx.root, "status.json"),
    acceptance: {
      nodes: [
        { id: "verify-af1", kind: "verify", deps: [], script: "s.sh", artifactsDir: "a", adversarialFormRefs: ["AF1"] },
        { id: "inspect-af1", kind: "inspect", deps: ["verify-af1"], promptFile: "p.md", artifactsRefs: ["verify-af1"] },
      ],
      groups: { core: [], nonCore: [] },
    },
  });
  result = build(fx, accExecPlan);
  assert.equal(result.status, 0, result.stderr);
  index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  const ax1 = index.rows.find((row) => row.assertionId === "AX1");
  assert.deepEqual(ax1.acceptanceNodeIds, ["verify-af1"]);
  // inspect 节点无 adversarialFormRefs，不归属任何断言；acceptance 模式重建后 devUnits 空（无 dev 节点可映射）
  assert.deepEqual(index.devUnits, []);
});

test("build：手改索引后重建覆盖（全量重建，禁手改语义）", (t) => {
  const fx = fixture(t);
  assert.equal(build(fx).status, 0);
  const original = readFileSync(fx.indexPath, "utf8");
  writeFileSync(fx.indexPath, original.replace('"AX1"', '"AX1-TAMPERED"'));
  assert.equal(build(fx).status, 0);
  assert.equal(readFileSync(fx.indexPath, "utf8"), original);
});

test("build：exec-plan 缺失走三段式错误（输入不合法 → 权威源 → 恢复命令）", (t) => {
  const result = run(["build", "--exec-plan", "/nonexistent/exec-plan.json"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exec-plan 文件不存在/);
  assert.match(result.stderr, /权威源/);
  assert.match(result.stderr, /恢复/);
});

test("query --assertion / --unit / --asset 反查", (t) => {
  const fx = fixture(t);
  assert.equal(build(fx).status, 0);
  let result = run(["query", "--index", fx.indexPath, "--assertion", "AX1"]);
  assert.equal(result.status, 0);
  const row = JSON.parse(result.stdout);
  assert.equal(row.assertionId, "AX1");
  assert.deepEqual(row.verificationAssetIds, ["asset-1"]);
  result = run(["query", "--index", fx.indexPath, "--unit", "u-main"]);
  const unitHit = JSON.parse(result.stdout);
  assert.deepEqual(unitHit.assertions.map((entry) => entry.assertionId), ["AX1"]);
  result = run(["query", "--index", fx.indexPath, "--asset", "asset-1"]);
  assert.deepEqual(JSON.parse(result.stdout).assertions, ["AX1"]);
  // 查询不存在的 id：三段式错误 exit 1（不是静默空输出）
  result = run(["query", "--index", fx.indexPath, "--assertion", "NOPE"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /权威源/);
});

test("query --empty-refs：空引用集合只报事实，不做缺漏判定", (t) => {
  const fx = fixture(t);
  assert.equal(build(fx).status, 0);
  const result = run(["query", "--index", fx.indexPath, "--empty-refs"]);
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  const ax2 = out.assertionsWithEmptyRefs.find((entry) => entry.assertionId === "AX2");
  assert.ok(ax2.emptyFields.includes("adversarialFormIds"));
  assert.ok(ax2.emptyFields.includes("acceptanceNodeIds"));
  assert.match(out.note, /check-quality-contract/);
});

test("query --reviewer-seeds：文件按 dev 节点 territory 映射到单元后反查；未映射文件回退现行分区审查", (t) => {
  const fx = fixture(t);
  assert.equal(build(fx).status, 0);
  let result = run(["query", "--index", fx.indexPath, "--reviewer-seeds", "--files", "src/a.ts"]);
  assert.equal(result.status, 0);
  let out = JSON.parse(result.stdout);
  assert.deepEqual(out.seeds.units, ["u-main"]);
  assert.deepEqual(out.seeds.assertions, ["AX1"]);
  assert.deepEqual(out.seeds.designEntries, ["D1"]);
  assert.deepEqual(out.seeds.scenarios, ["AF1"]);
  assert.equal(out.fallback, null);
  // 未映射文件：空候选 + fallback 注明回退（§6.3 第 6 条——完整 diff 始终完整提供）
  result = run(["query", "--index", fx.indexPath, "--reviewer-seeds", "--files", "docs/other.md"]);
  out = JSON.parse(result.stdout);
  assert.deepEqual(out.seeds.units, []);
  assert.deepEqual(out.unmappedFiles, ["docs/other.md"]);
  assert.match(out.fallback, /回退现行分区审查/);
  // 索引无 --files 时用法错误 exit 2
  result = run(["query", "--index", fx.indexPath, "--reviewer-seeds"]);
  assert.equal(result.status, 2);
});

test("资产回溯校验：快照在场时幽灵 reuse 资产 id 被拒（三段式）；命中后 note 消失", (t) => {
  const fx = fixture(t);
  const snapPath = join(fx.root, "project-capabilities.json");
  // 快照在场但 verificationAssets 为空 → reuse:asset-1 成幽灵引用，build 三段式报错
  writeJson(snapPath, { schemaVersion: 1, projectRoot: "/p", observedAt: "2026-11-17T00:00:00Z", inputHashes: {}, commands: [], verificationAssets: [], unknowns: [] });
  let result = build(fx);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /引用了能力快照中不存在的资产 id：asset-1/);
  assert.match(result.stderr, /权威源/);
  assert.match(result.stderr, /恢复/);
  // 快照登记 asset-1 后通过；快照在场且核验通过 → 无未核验 note
  writeJson(snapPath, {
    schemaVersion: 1,
    projectRoot: "/p",
    observedAt: "2026-11-17T00:00:00Z",
    inputHashes: {},
    commands: [],
    verificationAssets: [{ id: "asset-1", kind: "scenario", path: "s.js", sha256: "h", source: { kind: "scenario-manifest", ref: "r" } }],
    unknowns: [],
  });
  result = build(fx);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  assert.equal(index.note, undefined);
});

test("query --reviewer-seeds：territory 多单元重合时候选含全部命中单元并回退标注", (t) => {
  const fx = fixture(t);
  // 造两个 dev 节点 territory 重合（u-shared 覆盖 src/shared/，u-main 覆盖 src/）——
  // 索引读文件内容不跑引擎 overlap 门，重合形态照实派生
  const execPlan = JSON.parse(readFileSync(fx.execPlanPath, "utf8"));
  execPlan.nodes.unshift({ id: "u-shared", kind: "dev", deps: ["u-main"], territory: ["src/shared/"], promptFile: "p2.md", testCommand: { program: "node", args: ["t"] } });
  writeFileSync(fx.execPlanPath, JSON.stringify(execPlan));
  const implPlan = JSON.parse(readFileSync(join(fx.root, "impl-plan.json"), "utf8"));
  implPlan.units.unshift({ id: "u-shared", responsibility: "r2", territory: ["src/shared/"], deps: ["u-main"], isolation: "plain", acceptance: ["条款2"], decisionTier: "B" });
  writeFileSync(join(fx.root, "impl-plan.json"), JSON.stringify(implPlan));
  assert.equal(build(fx).status, 0);
  const result = run(["query", "--index", fx.indexPath, "--reviewer-seeds", "--files", "src/shared/a.ts"]);
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  // 文件同时命中 u-shared（src/shared/）与 u-main（src/ 前缀）——候选含全部重合单元，不裁剪
  assert.deepEqual(out.seeds.units.sort(), ["u-main", "u-shared"]);
  assert.match(out.fallback, /territory 多单元重合/);
  assert.match(out.fallback, /回退现行分区审查/);
  // 单元命中但与断言无引用链时仍在 seeds.units（空引用集合也是候选事实）
  assert.ok(out.seeds.units.includes("u-shared"));
});

test("check：一致 PASS；手改 rows 报手改嫌疑；输入漂移报哈希不一致（两类分开）", (t) => {
  const fx = fixture(t);
  writeJson(join(fx.root, "project-capabilities.json"), {
    schemaVersion: 1,
    projectRoot: "/p",
    observedAt: "2026-11-17T00:00:00Z",
    inputHashes: {},
    commands: [],
    verificationAssets: [{ id: "asset-1", kind: "scenario", path: "s.js", sha256: "h", source: { kind: "scenario-manifest", ref: "r" } }],
    unknowns: [],
  });
  assert.equal(build(fx).status, 0);
  let result = run(["check", "--exec-plan", fx.execPlanPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
  // 手改 rows（哈希登记不变）→ 内容与派生不一致（手改嫌疑）
  const index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  index.rows[0].decisionIds = ["D-HACK"];
  writeFileSync(fx.indexPath, JSON.stringify(index, null, 2) + "\n");
  result = run(["check", "--exec-plan", fx.execPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /字段 rows 被手改/);
  assert.match(result.stderr, /重建索引/);
  // 输入漂移：impl-plan 在 build 后被改 → 重算哈希与登记值不一致（哈希类问题与手改类分开报）
  assert.equal(build(fx).status, 0);
  const implPlan = JSON.parse(readFileSync(join(fx.root, "impl-plan.json"), "utf8"));
  implPlan.units[0].decisionTier = "A";
  writeFileSync(join(fx.root, "impl-plan.json"), JSON.stringify(implPlan));
  result = run(["check", "--exec-plan", fx.execPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /输入漂移：inputHashes\.implPlan/);
  // 恢复后 check 复绿
  implPlan.units[0].decisionTier = "B";
  writeFileSync(join(fx.root, "impl-plan.json"), JSON.stringify(implPlan));
  result = run(["check", "--exec-plan", fx.execPlanPath]);
  assert.equal(result.status, 0, result.stderr);
});

test("acceptancePackage 哈希与 delivery-gate acceptancePackageSha256 同源（两段式公式逐字对齐）", (t) => {
  // 公式对照来源：delivery-v6/scripts/delivery-gate.mjs acceptancePackageSha256（679-686 行）——
  // 内层逐文件 canonicalJson 化为字符串、外层对象再 canonical 化；本测试按同一公式复刻期望值，
  // 断言索引登记值与其相等（公式漂移即红）
  const fx = fixture(t);
  assert.equal(build(fx).status, 0);
  const canonical = (value) => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (typeof value === "object" && value !== null) {
      return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
    }
    return JSON.stringify(value);
  };
  const sha256 = (text) => createHash("sha256").update(text).digest("hex");
  const acceptance = JSON.parse(readFileSync(join(fx.taskDir, "acceptance.json"), "utf8"));
  const increments = JSON.parse(readFileSync(join(fx.taskDir, "increments.json"), "utf8"));
  const expected = sha256(
    canonical({
      "acceptance.json": canonical(acceptance),
      "increments.json": canonical(increments),
    }),
  );
  const index = JSON.parse(readFileSync(fx.indexPath, "utf8"));
  assert.equal(index.inputHashes.acceptancePackage, expected);
});

test("独立设计任务（设计包无 acceptanceBinding）：验收包可缺省，断言全集从 criterionMechanisms 派生", (t) => {
  const root = mkdtempSync(join(tmpdir(), "verification-index-v6-solo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 真实布局：<slug>/solo-design/ 放章节，<slug>/solo-design.rendered.md 平铺
  const designRoot = join(root, "design");
  const designDir = join(designRoot, "solo-design");
  mkdirSync(designDir, { recursive: true });
  writeJson(join(designDir, "meta.json"), {});
  writeJson(join(designDir, "s3-solution.json"), { decisions: [{ id: "D9", unitRefs: ["U9"] }] });
  writeJson(join(designDir, "s4-accept.json"), {
    criterionMechanisms: [{ assertionId: "AX-SOLO", decisionIds: ["D9"], mechanismRefs: ["D9.choice"], consistency: "pass", counterexample: "c", resolution: "" }],
    verificationBindings: [],
  });
  writeJson(join(designDir, "s5-breakdown.json"), { units: [{ id: "U9", title: "t", justification: "j", files: ["a.ts"], checkpoints: [] }], fileMap: "m" });
  const execPlanPath = join(root, "exec-plan.json");
  writeJson(execPlanPath, {
    version: 1,
    mode: "dev",
    projectRoot: "/p",
    planPath: join(root, "impl-plan.json"),
    designDocPath: join(designRoot, "solo-design.rendered.md"),
    baseline: "abc",
    statusPath: join(root, "status.json"),
    nodes: [{ id: "u-solo", kind: "dev", deps: [], territory: ["src/"], promptFile: "p.md", testCommand: { program: "node", args: ["test"] } }],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  });
  writeJson(join(root, "impl-plan.json"), {
    units: [{ id: "u-solo", responsibility: "r", territory: ["src/"], deps: [], isolation: "plain", acceptance: ["条款"], decisionTier: "B" }],
    acceptancePlan: [],
  });
  const result = run(["build", "--exec-plan", execPlanPath]);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, "verification-index.json"), "utf8"));
  // 无验收绑定时 acceptancePackage 显式记 null（「无此输入」比省略键诚实）
  assert.equal(index.inputHashes.acceptancePackage, null);
  const row = index.rows.find((entry) => entry.assertionId === "AX-SOLO");
  assert.deepEqual(row.decisionIds, ["D9"]);
  assert.deepEqual(row.unitIds, ["U9"]);
  assert.deepEqual(row.adversarialFormIds, []);
});

test("旧错误布局（章节 JSON 放渲染视图同目录而非 <name>/ 子目录）按设计目录缺口三段式报错", (t) => {
  // 对照用例：skill-data-addressing §2 真实布局是六章节在 <slug>/<name>/ 子目录。历史 fixture 曾把
  // 章节放在渲染视图同目录、随错误推导口径碰巧通过——对齐 designDirFromDocPath 后该布局推导出的
  // <name>/ 子目录无章节文件，如实报缺口（正是真实设计包上会暴露的形态）
  const root = mkdtempSync(join(tmpdir(), "verification-index-v6-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const designRoot = join(root, "design");
  // <slug>/legacy/ 子目录存在但空（渲染视图与子目录齐全、章节错放平铺层的历史包形态）
  mkdirSync(join(designRoot, "legacy"), { recursive: true });
  writeJson(join(designRoot, "meta.json"), {});
  writeJson(join(designRoot, "s3-solution.json"), { decisions: [{ id: "D1", unitRefs: ["U1"] }] });
  writeJson(join(designRoot, "s4-accept.json"), { criterionMechanisms: [], verificationBindings: [] });
  const execPlanPath = join(root, "exec-plan.json");
  writeJson(execPlanPath, {
    version: 1,
    mode: "dev",
    projectRoot: "/p",
    planPath: join(root, "impl-plan.json"),
    designDocPath: join(designRoot, "legacy.rendered.md"),
    baseline: "abc",
    statusPath: join(root, "status.json"),
    nodes: [{ id: "u-main", kind: "dev", deps: [], territory: ["src/"], promptFile: "p.md", testCommand: { program: "node", args: ["test"] } }],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  });
  writeJson(join(root, "impl-plan.json"), {
    units: [{ id: "u-main", responsibility: "r", territory: ["src/"], deps: [], isolation: "plain", acceptance: ["条款"], decisionTier: "B" }],
    acceptancePlan: [],
  });
  const result = run(["build", "--exec-plan", execPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /设计目录缺 s3-solution\.json 或 s4-accept\.json/);
  assert.match(result.stderr, /design\/legacy/);
  assert.match(result.stderr, /权威源/);
});
