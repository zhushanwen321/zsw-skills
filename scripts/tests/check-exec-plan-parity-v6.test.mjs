// check-exec-plan-parity-v6.test.mjs — check-exec-plan 与两引擎校验的差分测试（防漂移对账）
//
// 对应实现：skills/self/dev-workflow/dev-flow-v6/scripts/check-exec-plan.mjs（D0 编译
// 「生成即校验」门）。该脚本的 schema 主段是 W2 wave-executor validatePlan 的 JS 移植
// （错误文案逐字一致），本测试防止两份实现漂移：
//   - 差分侧：从构建产物 workflows/pi/wave-executor-v6.js 零转抄提取 validatePlan 及其
//     依赖闭包（产物由构建器维护、已剥 TS、形态稳定；源↔产物一致性另有 build --check
//     与 parity 门把守），实跑后与移植侧逐 fixture 断言 ok 与错误文案完全一致。
//   - 附加侧：testPlan / 必填字段 / baseline hash / verify script 扩展名 / cwd 形态
//     属 W3 NODE_PREP 契约与编译点附加静态项（W2 validatePlan 无此段），单独断言。
//   - CLI 侧：输出契约（PASS exit 0 / FAIL: <分类>: <明细> exit 1 / 用法 exit 2）与
//     2026-11-06/07 三类实证错误（territory 混合形态、acceptance.nodes 空、artifactsRefs
//     引用不存在——当时到 D1/D3 发起才爆）在编译点即被拦截。
//
// 运行：node --test scripts/tests/check-exec-plan-parity-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { validatePlanSchema, checkPlan } from "../../skills/self/dev-workflow/dev-flow-v6/scripts/check-exec-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI_ARTIFACT = join(ROOT, "skills", "self", "dev-workflow", "workflows", "pi", "wave-executor-v6.js");
const CHECK_SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-exec-plan.mjs");

function loadReferenceValidatePlan() {
  const src = readFileSync(PI_ARTIFACT, "utf-8");
  const parts = [];
  for (const name of ["TEST_WHITELIST", "NOOP_CMD_STUB_RE", "NOOP_CMD_ECHO_RE", "NOOP_CMD_STUB_HEAD_RE", "SHELL_SAFE_ARG_RE"]) {
    const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(m, `构建产物中未找到 const ${name}——提取探针与实现失配，须同步更新探针`);
    parts.push(m[0]);
  }
  for (const name of ["shellQuoteArg", "noopCommandError", "isRec", "isStr", "isStrArr", "joinPath", "territoryFormatErrors", "detectCycle", "validatePlan"]) {
    const m = src.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"));
    assert.ok(m, `构建产物中未找到 function ${name}——提取探针与实现失配，须同步更新探针`);
    parts.push(m[0]);
  }
  return vm.runInNewContext(`${parts.join("\n")}\nvalidatePlan`, {}, { timeout: 5000 });
}

const referenceValidatePlan = loadReferenceValidatePlan();

// ── fixture 基座 ──

const HASH = "abc1234def5678abc1234def5678abc1234abcd";

function legalDevPlan() {
  return {
    version: 1,
    skillVersion: "0.2.1",
    mode: "dev",
    projectRoot: "/tmp/parity-project",
    workspaceRoot: "/tmp/parity-workspace",
    planPath: "/tmp/tech-design/parity/p.impl-plan.json",
    designDocPath: "/tmp/tech-design/parity/p.md",
    baseline: HASH,
    statusPath: "/tmp/skill-data/dev-flow/parity/p.status.json",
    testPlan: { fullSuite: { program: "pnpm", args: ["test"] } },
    commitTemplate: "feat(parity): {unitId} — {summary}",
    nodes: [
      { id: "u-1", kind: "dev", deps: [], designRef: "§3.2", territory: ["src/a/"], testCommand: { program: "pnpm", args: ["-C", "src/a", "test"] }, promptFile: "/tmp/skill-data/dev-flow/parity/p.prompts/u-1.md" },
      { id: "u-2", kind: "dev", deps: ["u-1"], designRef: "§3.3", territory: ["src/b/"], testCommand: { program: "npm", args: ["test"] }, promptFile: "/tmp/skill-data/dev-flow/parity/p.prompts/u-2.md" },
      { id: "e2e-1", kind: "verify", deps: ["u-1"], script: "scripts/e2e/smoke.mjs", artifactsDir: "out/e2e/smoke" },
    ],
    acceptance: { nodes: [], groups: { core: [], nonCore: [] } },
  };
}

function legalAcceptancePlan() {
  return {
    version: 1,
    skillVersion: "0.2.1",
    mode: "acceptance",
    projectRoot: "/tmp/parity-project",
    planPath: "/tmp/tech-design/parity/p.impl-plan.json",
    designDocPath: "/tmp/tech-design/parity/p.md",
    baseline: HASH,
    statusPath: "/tmp/skill-data/dev-flow/parity/p.status.json",
    testPlan: { fullSuite: { program: "pnpm", args: ["test"] } },
    nodes: [],
    acceptance: {
      groups: { core: [], nonCore: [] },
      nodes: [
        { id: "v-1", kind: "verify", deps: [], script: "scripts/verify/a.sh", artifactsDir: "out/accept/a" },
        { id: "i-1", kind: "inspect", deps: ["v-1"], promptFile: "/tmp/skill-data/dev-flow/parity/p.prompts/i-1.md", artifactsRefs: ["v-1"] },
      ],
    },
  };
}

// ── 差分 fixture 表：每项断言两侧 ok 与错误文案逐条一致 + 分类符合预期 ──

const PARITY_CASES = [
  { name: "合法 dev 计划", build: legalDevPlan, ok: true, categories: [] },
  { name: "合法 acceptance 计划", build: legalAcceptancePlan, ok: true, categories: [] },
  {
    name: "实证错误 1：territory 混合形态（空格/括号注释）",
    build: () => { const p = legalDevPlan(); p.nodes[0].territory = ["src/a/ (含测试)"]; return p; },
    ok: false, categories: ["territory"],
  },
  {
    name: "territory 绝对路径",
    build: () => { const p = legalDevPlan(); p.nodes[0].territory = ["/abs/src/a"]; return p; },
    ok: false, categories: ["territory"],
  },
  {
    name: "实证错误 2：acceptance.nodes 空数组",
    build: () => { const p = legalAcceptancePlan(); p.acceptance.nodes = []; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "实证错误 3：artifactsRefs 引用不存在的节点",
    build: () => { const p = legalAcceptancePlan(); p.acceptance.nodes[1].artifactsRefs = ["v-ghost"]; return p; },
    ok: false, categories: ["ref"],
  },
  {
    name: "deps 引用不存在的节点",
    build: () => { const p = legalDevPlan(); p.nodes[1].deps = ["u-ghost"]; return p; },
    ok: false, categories: ["ref"],
  },
  {
    name: "依赖环",
    build: () => { const p = legalDevPlan(); p.nodes[0].deps = ["u-2"]; return p; },
    ok: false, categories: ["cycle"],
  },
  {
    name: "territory 重叠且无依赖路径",
    build: () => { const p = legalDevPlan(); p.nodes[1].deps = []; p.nodes[1].territory = ["src/a/"]; return p; },
    ok: false, categories: ["overlap"],
  },
  {
    name: "territory 重叠但有依赖路径（互斥断言放行）",
    build: () => { const p = legalDevPlan(); p.nodes[1].territory = ["src/a/"]; return p; },
    ok: true, categories: [],
  },
  {
    name: "worktree 合并节点（territory 抄录被合单元 + deps 指向被合单元——compile.md 合并排布契约）",
    build: () => {
      const p = legalDevPlan();
      p.nodes.push({ id: "merge-u-1", kind: "dev", deps: ["u-1"], designRef: "§3.4", territory: ["src/a/"], testCommand: { program: "pnpm", args: ["test"] }, promptFile: "/tmp/skill-data/dev-flow/parity/p.prompts/merge-u-1.md" });
      return p;
    },
    ok: true, categories: [],
  },
  {
    name: "合并节点缺 territory（dev 节点 territory 必须非空——compile.md 未声明 territory 的字面编译形态两侧同拒）",
    build: () => {
      const p = legalDevPlan();
      p.nodes.push({ id: "merge-u-1", kind: "dev", deps: ["u-1"], testCommand: { program: "pnpm", args: ["test"] }, promptFile: "/tmp/skill-data/dev-flow/parity/p.prompts/merge-u-1.md" });
      return p;
    },
    ok: false, categories: ["field"],
  },
  {
    name: "缺 projectRoot",
    build: () => { const p = legalDevPlan(); delete p.projectRoot; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "缺 statusPath",
    build: () => { const p = legalDevPlan(); delete p.statusPath; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "workspaceRoot 相对路径",
    build: () => { const p = legalDevPlan(); p.workspaceRoot = "relative/ws"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "version 非 1（单错误早退）",
    build: () => { const p = legalDevPlan(); p.version = 2; return p; },
    ok: false, categories: ["schema"],
  },
  {
    name: "mode 非法值",
    build: () => { const p = legalDevPlan(); p.mode = "debug"; return p; },
    ok: false, categories: ["schema"],
  },
  {
    name: "testCommand.program 白名单违例",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = { program: "python3", args: ["-m", "pytest"] }; return p; },
    ok: false, categories: ["whitelist"],
  },
  {
    name: "testCommand 恒绿形态（bash -c true）",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = { program: "bash", args: ["-c", "true"] }; return p; },
    ok: false, categories: ["noop"],
  },
  {
    name: "testCommand 恒绿形态（echo 字样）",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = { program: "bash", args: ["-c", "echo done"] }; return p; },
    ok: false, categories: ["noop"],
  },
  {
    name: "dev 模式缺 commitTemplate",
    build: () => { const p = legalDevPlan(); delete p.commitTemplate; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "commitTemplate 缺占位符",
    build: () => { const p = legalDevPlan(); p.commitTemplate = "feat: change"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "acceptance 缺 groups 对象",
    build: () => { const p = legalAcceptancePlan(); delete p.acceptance.groups; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "acceptance 对象缺失",
    build: () => { const p = legalAcceptancePlan(); p.acceptance = null; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "dev 模式顶层 nodes 空",
    build: () => { const p = legalDevPlan(); p.nodes = []; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "kind 非法值",
    // 注意不能用 "review"——V4 起渐进式 review 使 kind=review 在 dev 模式合法
    build: () => { const p = legalDevPlan(); p.nodes[0].kind = "bogus"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "dev 节点 territory 空数组",
    build: () => { const p = legalDevPlan(); p.nodes[0].territory = []; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "dev 模式含 inspect 节点",
    build: () => { const p = legalDevPlan(); p.nodes.push({ id: "i-x", kind: "inspect", deps: [], promptFile: "/tmp/i.md", artifactsRefs: [] }); return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "acceptance 模式含 dev 节点",
    build: () => { const p = legalAcceptancePlan(); p.acceptance.nodes.push({ id: "u-x", kind: "dev", deps: [], territory: ["src/x/"], testCommand: { program: "pnpm", args: ["test"] }, promptFile: "/tmp/u.md" }); return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "deps 非字符串数组",
    build: () => { const p = legalDevPlan(); p.nodes[1].deps = "u-1"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "节点 id 重复",
    build: () => { const p = legalDevPlan(); p.nodes[1].id = "u-1"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "节点条目非对象",
    build: () => { const p = legalDevPlan(); p.nodes[0] = "garbage"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "节点缺 id",
    build: () => { const p = legalDevPlan(); delete p.nodes[0].id; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "verify 节点缺 script",
    build: () => { const p = legalDevPlan(); delete p.nodes[2].script; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "verify 节点缺 artifactsDir",
    build: () => { const p = legalDevPlan(); delete p.nodes[2].artifactsDir; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "inspect 节点缺 promptFile",
    build: () => { const p = legalAcceptancePlan(); delete p.acceptance.nodes[1].promptFile; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "artifactsRefs 非字符串数组",
    build: () => { const p = legalAcceptancePlan(); p.acceptance.nodes[1].artifactsRefs = "v-1"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "根非对象（schema 早退：整计划非 JSON 对象）",
    build: () => "not-an-object",
    ok: false, categories: ["schema"],
  },
  {
    name: "workspaceRoot 数字形态（若提供必须非空字符串）",
    build: () => { const p = legalDevPlan(); p.workspaceRoot = 42; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "workspaceRoot 对象形态（若提供必须非空字符串）",
    build: () => { const p = legalDevPlan(); p.workspaceRoot = { root: "/x" }; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "dev 节点缺 promptFile",
    build: () => { const p = legalDevPlan(); delete p.nodes[0].promptFile; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "testCommand 非 {program, args} 形态（字符串）",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = "pnpm test"; return p; },
    ok: false, categories: ["field"],
  },
  {
    name: "testCommand 恒绿藏于复合命令（; 切片分支：true; pnpm test）",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = { program: "bash", args: ["-c", "true; pnpm test"] }; return p; },
    ok: false, categories: ["noop"],
  },
  {
    name: "testCommand 恒绿藏于复合命令（&& 切片分支：true && pnpm test）",
    build: () => { const p = legalDevPlan(); p.nodes[0].testCommand = { program: "bash", args: ["-c", "true && pnpm test"] }; return p; },
    ok: false, categories: ["noop"],
  },
];

test("差分对账：每类 fixture 两侧 ok 与错误文案逐条一致", () => {
  const rows = [];
  for (const c of PARITY_CASES) {
    const plan = c.build();
    const ref = referenceValidatePlan(plan);
    // 参考侧 ok 形态无 errors 字段（{ok:true, plan}）归一为空数组；errors 数组出自 vm
    // 新 Realm（Array 原型不同），展开拷贝为宿主 Realm 数组后再做深度严格比较
    const refErrors = ref.ok ? [] : [...ref.errors];
    const mine = validatePlanSchema(plan);
    assert.equal(mine.ok, ref.ok, `「${c.name}」ok 判定两侧不一致（参考侧 ${ref.ok} / 移植侧 ${mine.ok}）`);
    assert.deepEqual(
      mine.errors.map((e) => e.message),
      refErrors,
      `「${c.name}」错误文案两侧不一致（移植侧 ${JSON.stringify(mine.errors.map((e) => e.message))} / 参考侧 ${JSON.stringify(refErrors)}）`,
    );
    assert.deepEqual(
      mine.errors.map((e) => e.category),
      c.categories,
      `「${c.name}」分类不符（实际 ${JSON.stringify(mine.errors.map((e) => e.category))}，预期 ${JSON.stringify(c.categories)}）`,
    );
    rows.push(`${c.ok ? "ok" : "FAIL"} | ${c.categories.join(",") || "-"} | ${c.name}（两侧错误 ${refErrors.length} 条，文案一致）`);
  }
  // 对照表落 stdout 供评审（node --test 以 TAP 输出，诊断信息经 comment 行可见）
  console.log(`差分 fixture × 两侧判定对照表（${rows.length} 项）：\n${rows.join("\n")}`);
});

// ── 附加契约段（W3 NODE_PREP 同源 + 静态附加项）：参考侧 validatePlan 无此段，
//    断言「参考侧放行 / 本门拦截」的加严方向与分类落点 ──

const EXTRA_CASES = [
  { name: "缺 testPlan（W3 Gate A 消费，缺失即 fail-fast）", mutate: (p) => { delete p.testPlan; }, category: "testPlan" },
  { name: "fullSuite.program 用 git（W2 白名单但 W3 全量门无 git）", mutate: (p) => { p.testPlan.fullSuite.program = "git"; }, category: "whitelist" },
  { name: "fullSuite 恒绿形态", mutate: (p) => { p.testPlan.fullSuite = { program: "bash", args: ["-c", "true"] }; }, category: "noop" },
  { name: "artifacts 条目缺 id", mutate: (p) => { p.testPlan.artifacts = [{ command: { program: "pnpm", args: ["build"] } }]; }, category: "testPlan" },
  { name: "incremental.program 白名单违例", mutate: (p) => { p.testPlan.incremental = { program: "git", args: ["status"] }; }, category: "whitelist" },
  { name: "baseline 非 git hash 形态", mutate: (p) => { p.baseline = "main"; }, category: "field" },
  { name: "缺 planPath（W3 必填）", mutate: (p) => { delete p.planPath; }, category: "field" },
  { name: "cwd 相对路径（会被引擎拼成仓库子目录）", mutate: (p) => { p.nodes[0].cwd = "worktrees/u-1"; }, category: "cwd" },
  { name: "verify script 扩展名不受支持", mutate: (p) => { p.nodes[2].script = "scripts/e2e/smoke.py"; }, category: "script" },
];

test("附加契约：W2 放行而编译门拦截的加严项，分类落点正确", () => {
  for (const c of EXTRA_CASES) {
    const plan = legalDevPlan();
    c.mutate(plan);
    const ref = referenceValidatePlan(plan);
    assert.equal(ref.ok, true, `「${c.name}」应属附加契约（W2 validatePlan 应放行），实际参考侧拒绝：${JSON.stringify(ref.errors)}`);
    const full = checkPlan(plan);
    assert.equal(full.ok, false, `「${c.name}」编译门应拦截`);
    const cats = full.errors.filter((e) => e.category === c.category);
    assert.ok(cats.length > 0, `「${c.name}」应报分类 ${c.category}，实际 ${JSON.stringify(full.errors.map((e) => e.category))}`);
  }
});

test("附加契约不误伤：合法计划整门 PASS", () => {
  assert.equal(checkPlan(legalDevPlan()).ok, true);
  assert.equal(checkPlan(legalAcceptancePlan()).ok, true);
});

// ── CLI 输出契约 ──

function runCli(planText) {
  const dir = mkdtempSync(join(tmpdir(), "exec-plan-check-"));
  const file = join(dir, "p.exec-plan.json");
  writeFileSync(file, planText);
  try {
    return { ...spawnSync(process.execPath, [CHECK_SCRIPT, file], { encoding: "utf8" }), file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI：合法计划 stdout PASS exit 0", () => {
  const r = runCli(JSON.stringify(legalDevPlan(), null, 2));
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), "PASS");
});

test("CLI：非法计划逐行 FAIL: <分类>: <明细> exit 1（报完再退出）", () => {
  // 尾段类别可同批多报（引用存在性 + commitTemplate）：schema 主段按 W2 分段早退语义，
  // 节点级错误会截住尾段——多报组合取「refs + commitTemplate」这一同批共存对
  const p = legalDevPlan();
  p.nodes[1].deps = ["u-ghost"];
  delete p.commitTemplate;
  const r = runCli(JSON.stringify(p, null, 2));
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.length >= 2, `应逐行多报，实际 stdout：${r.stdout}`);
  for (const line of lines) assert.match(line, /^FAIL: [a-z]+: /, `行格式不符：${line}`);
  assert.ok(lines.some((l) => l.startsWith("FAIL: ref:")), "应含 ref 分类行");
  assert.ok(lines.some((l) => l.startsWith("FAIL: field:")), "应含 field 分类行");
});

test("CLI：节点级错误分段早退（与 W2 validatePlan 同语义，单行即终）", () => {
  const p = legalDevPlan();
  p.nodes[0].territory = ["src/a/ (含测试)"];
  p.nodes[1].deps = ["u-ghost"];
  const r = runCli(JSON.stringify(p, null, 2));
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `节点级错误应截住尾段（W2 分段早退语义），实际 stdout：${r.stdout}`);
  assert.match(lines[0], /^FAIL: territory: /);
});

test("CLI：文件不存在 / 非 JSON / 缺参数的退出码与文案", () => {
  const missing = spawnSync(process.execPath, [CHECK_SCRIPT, join(tmpdir(), "no-such-exec-plan.json")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^FAIL: io: /);
  const bad = runCli("{ not json");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL: json: /);
  const usage = spawnSync(process.execPath, [CHECK_SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /用法/);
});
