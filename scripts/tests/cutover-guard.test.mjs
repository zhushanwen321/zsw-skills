// cutover-guard.test.mjs — cutover 标记入口拒启检查（sync-conformance-plane D8/G11 / RL11）
//
// 覆盖（对应实现：workflows/src/design-code-sync-loop.shared.ts 的 cutoverGuardBlock +
// NODE_CUTOVER_EXISTS 探针——旧 W4 setup 前置第一步；flow/sync.md 手工入口第一步同检查）：
//   1. 带标记包拒启：blocked=true，message 含恢复动作与 v2 指向（G11 --legacy-entry-rejected）
//   2. 无标记包放行：blocked=false（拒启门不拦未切换包——setup 正常进入的前提）
//   3. docName 变体寻址：<name>.rendered 形态的标记目录同样命中（skill-data-addressing
//      dev-flow 段 docName 可含 .rendered 后缀，tech-design 段 <name> 同源）
//   4. 探针失败 fail-open 放行（命中判定 = 标记在场；探针故障不是在场信号——
//      实现注释登记的取舍，测试固化防回摆）
//   5. 手工入口同检查：flow/sync.md 携带 cutover 拒启指引（文档契约静态断言——手工路径
//      无引擎代码可驱动，靠流程文档第一步义务 + 本断言防文档漂移）
//
// 形态 = 零转抄探针：从单源提取真实函数源码与探针常量，transpile 后在 vm 中执行；
// world.run stub 真实执行 node -e 探针（夹具 = 临时目录内的标记文件有/无两态）。
// 运行：node --test scripts/tests/cutover-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO, "skills", "self", "dev-workflow", "workflows", "src", "design-code-sync-loop.shared.ts");
const SYNC_FLOW = join(REPO, "skills", "self", "dev-workflow", "dev-flow-v5", "flow", "sync.md");

/** 从单源提取 cutoverGuardBlock 真实源码 + 探针常量，transpile 后在 vm 里取可调用引用 */
function loadGuard() {
  const src = readFileSync(SRC, "utf-8");
  const probe = src.match(/^const NODE_CUTOVER_EXISTS =\s*(.+);$/m);
  assert.ok(probe, "单源中未找到 NODE_CUTOVER_EXISTS 探针常量——提取探针与实现失配，须同步更新");
  const fn = src.match(/^async function cutoverGuardBlock\([\s\S]*?^\}$/m);
  assert.ok(fn, "单源中未找到 cutoverGuardBlock 顶层函数——提取探针与实现失配，须同步更新");
  const js = ts.transpileModule(`${probe[0]}\n${fn[0]}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  // world stub：真实执行 node -e 探针（与引擎同通道）；stubMode 可注入探针故障
  const sandbox = {
    world: {
      run: async (cmd, argv) => {
        if (sandbox.__probeBroken) return { exitCode: 1, stdout: "", stderr: "stub: probe broken" };
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync(cmd, ["-e", argv[1], argv[2]], { encoding: "utf8" });
        return { exitCode: 0, stdout: out, stderr: "" };
      },
    },
    __probeBroken: false,
  };
  const ref = vm.runInNewContext(`${js}\ncutoverGuardBlock`, sandbox, { timeout: 15000 });
  return { guard: ref, sandbox };
}

/** 临时夹具：tech-design/<slug>/<name>/cutover.json 的目录树（withMarker 控制有/无标记） */
function makeFixture({ withMarker, name }) {
  const root = join(tmpdir(), `cutover-guard-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const pkgDir = join(root, ".agents", "skill-data", "tech-design", "proj-abcdef12", name);
  mkdirSync(pkgDir, { recursive: true });
  if (withMarker) writeFileSync(join(pkgDir, "cutover.json"), JSON.stringify({ cutover: true, engine: "v2" }, null, 2));
  return { root, pkgDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ADDR = { form: "single", slug: "proj-abcdef12" };

test("带标记包拒启：blocked 且 message 含恢复动作与 v2 指向", async () => {
  const { guard, sandbox } = loadGuard();
  const fx = makeFixture({ withMarker: true, name: "thesis-contract" });
  try {
    const r = await guard(fx.root, ADDR, "thesis-contract");
    assert.equal(r.blocked, true);
    assert.ok(r.message.includes("恢复动作"), "拒启 message 必须含恢复动作（失败契约四要素）");
    assert.ok(r.message.includes("design-code-sync-v2"), "恢复动作必须指向 v2 workflow");
    assert.ok(r.message.includes(fx.pkgDir.replace(/\/cutover\.json$/, "")) || r.message.includes("cutover.json"), "message 应携带标记路径线索");
    assert.equal(sandbox.__probeBroken, false);
  } finally {
    fx.cleanup();
  }
});

test("无标记包放行：blocked=false（setup 正常进入）", async () => {
  const { guard } = loadGuard();
  const fx = makeFixture({ withMarker: false, name: "thesis-contract" });
  try {
    const r = await guard(fx.root, ADDR, "thesis-contract");
    assert.equal(r.blocked, false);
    assert.equal(r.message, "");
  } finally {
    fx.cleanup();
  }
});

test("docName 变体：.rendered 形态标记目录命中", async () => {
  const { guard } = loadGuard();
  const fx = makeFixture({ withMarker: true, name: "trading-style-config.rendered" });
  try {
    const blocked = await guard(fx.root, ADDR, "trading-style-config.rendered");
    assert.equal(blocked.blocked, true);
    // 名字不同 = 未命中（防裸前缀误拦他包——<name> 精确匹配）
    const other = await guard(fx.root, ADDR, "trading-style-config");
    assert.equal(other.blocked, false);
  } finally {
    fx.cleanup();
  }
});

test("探针失败 fail-open 放行（命中判定 = 标记在场，探针故障非在场信号）", async () => {
  const { guard, sandbox } = loadGuard();
  const fx = makeFixture({ withMarker: true, name: "probe-broken-pkg" });
  try {
    sandbox.__probeBroken = true;
    const r = await guard(fx.root, ADDR, "probe-broken-pkg");
    assert.equal(r.blocked, false);
  } finally {
    fx.cleanup();
  }
});

test("workspace 形态寻址：标记在 tech-design/<ws-slug>/（无 worktree 段）", async () => {
  const { guard } = loadGuard();
  const fx = makeFixture({ withMarker: true, name: "ws-pkg" });
  try {
    const wsAddr = { form: "workspace", slug: "proj-abcdef12", workspaceRoot: "/ws", worktreeName: "wt-main" };
    const r = await guard(fx.root, wsAddr, "ws-pkg");
    // workspace 形态的 tech-design 段同样无 worktreeName 段——slug 相同即同一份标记
    assert.equal(r.blocked, true);
  } finally {
    fx.cleanup();
  }
});

test("手工入口同检查：flow/sync.md 携带 cutover 拒启指引（文档契约静态断言）", () => {
  const flow = readFileSync(SYNC_FLOW, "utf-8");
  assert.ok(flow.includes("cutover.json"), "flow/sync.md 手工路径必须登记 cutover 标记检查");
  assert.ok(/design-code-sync-v2/.test(flow), "手工路径拒启指引必须指向 v2");
  assert.ok(/第一步|拒启/.test(flow), "检查必须是手工入口第一步拒启义务");
});
