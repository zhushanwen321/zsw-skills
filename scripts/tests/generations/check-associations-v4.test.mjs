// check-associations-v4.test.mjs — check-associations.mjs 的 fixture 仓实跑测试
//
// 被测实现：skills/self/dev-workflow/dev-flow-v4/scripts/check-associations.mjs
// （exec-plan associations 的两个子命令：check 关联同步检查 / recheck 声明外跨单元
// 依赖边对账）。测试在 mkdtemp 临时目录建真实 git 仓（init → 提交 base → 改工作树），
// spawnSync 实跑被测脚本，断言 exit code 与 stdout JSON（含 unknown=2 的三态硬契约：
// dirty 与 unknown 绝不互混）。fixture 仓内的 git 操作只发生在临时目录，不动本仓库。
//
// 用例：
//   check：
//     1. co-change 两侧同改 → clean
//     2. 只改 trigger → dirty（missing 正确，stderr 含恢复动作）
//     3. exempt 条目跳过 → clean
//     4. trigger 未改动 → clean
//     5. associations 字段缺失 → clean（可选字段）
//     6. --base 与 plan.baseline 双缺 → exit 3 且含恢复动作
//   recheck：
//     7. 新增跨单元字面量 import 且未声明 → dirty（fromNode/toNode 正确）
//     8. 同一边被 associations 覆盖（trigger→related 与 related→trigger 两方向）→ clean
//     9. 同单元内新增边 → clean
//    10. 包名引用（lodash-es / node:fs）不追踪 → clean
//    11. require(非字面量) → status=unknown（exit 2，不是 clean 也不是 dirty）
//    12. base 不存在的新增文件按空 base 处理；未 add 的 untracked 不进改动集
//    13. worktree 节点 territory 文件 → unknowns（不做边解析，若误解析会 dirty）
//    14. dirty 与 unknown 并存 → dirty 优先（三态不混），unknowns 保留
//    15. 四种字面量形态 × 四扩展名（.js/.ts/.mjs/.cjs）全部成边
//
// 运行：node --test scripts/tests/check-associations-v4.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "skills", "self", "dev-workflow", "dev-flow-v4", "scripts", "check-associations.mjs",
);

function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")} 失败：${r.stderr}`);
  return r;
}

function write(repo, rel, content) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const DEV_NODES = [
  { id: "u-a", kind: "dev", deps: [], cwd: null, territory: ["src/a/"] },
  { id: "u-b", kind: "dev", deps: [], cwd: null, territory: ["src/b/"] },
];

const BASE_FILES = {
  "src/a/a.js": "export const a = 1;\n",
  "src/b/b.js": "export const b = 2;\n",
};

// 建临时 fixture：root/repo 为 git 仓（base 提交 = files 全量），root/plan.json 在仓外
// （避免被 add 卷进改动集）。baseline 缺省取 base 提交 rev，传 "" 可测双缺场景
function setup({ files = BASE_FILES, nodes = DEV_NODES, associations, baseline } = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-associations-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "fixture");
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    projectRoot: repo,
    baseline: baseline === undefined ? git(repo, "rev-parse", "HEAD").stdout.trim() : baseline,
    nodes,
    ...(associations !== undefined ? { associations } : {}),
  }, null, 2));
  return { root, repo, planPath };
}

function runScript(sub, planPath, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, sub, "--plan", planPath, ...extra], { encoding: "utf8" });
}

const CO_CHANGE = (trigger, related) => ({
  id: "assoc-1", kind: "contract", trigger, related, action: "co-change",
});

// ── check ──

test("check：co-change 两侧同改 → clean", (t) => {
  const { root, repo, planPath } = setup({ associations: [CO_CHANGE("src/a/a.js", ["src/b/b.js"])] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "export const a = 3;\n");
  write(repo, "src/b/b.js", "export const b = 4;\n");
  const r = runScript("check", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("check：只改 trigger → dirty 且 missing 正确（stderr 含恢复动作）", (t) => {
  const { root, repo, planPath } = setup({ associations: [CO_CHANGE("src/a/a.js", ["src/b/b.js"])] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "export const a = 3;\n");
  const r = runScript("check", planPath);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "dirty");
  assert.deepEqual(out.diffs, [
    { id: "assoc-1", kind: "contract", trigger: "src/a/a.js", missing: ["src/b/b.js"] },
  ]);
  assert.match(r.stderr, /exempt/);
  assert.match(r.stderr, /rationale/);
});

test("check：exempt 条目跳过 → clean", (t) => {
  const { root, repo, planPath } = setup({
    associations: [{
      id: "assoc-1", kind: "contract", trigger: "src/a/a.js", related: ["src/b/b.js"],
      action: "exempt", rationale: "消费方由独立单元接管，本单元刻意不同步",
    }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "export const a = 3;\n");
  const r = runScript("check", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("check：trigger 未改动 → clean", (t) => {
  const { root, repo, planPath } = setup({
    files: { ...BASE_FILES, "src/other/c.js": "export const c = 1;\n" },
    associations: [CO_CHANGE("src/a/a.js", ["src/b/b.js"])],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/other/c.js", "export const c = 2;\n"); // 改的是无关文件
  const r = runScript("check", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("check：associations 字段缺失 → clean（可选字段）", (t) => {
  const { root, repo, planPath } = setup({}); // plan 不含 associations
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "export const a = 3;\n");
  const r = runScript("check", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("check：--base 与 plan.baseline 双缺 → exit 3 且含恢复动作", (t) => {
  const { root, planPath } = setup({ baseline: "" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = runScript("check", planPath);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /--base/);
});

// ── recheck ──

test("recheck：新增跨单元字面量 import 且未声明 → dirty（fromNode/toNode 正确）", (t) => {
  const { root, repo, planPath } = setup({});
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", 'import { b } from "../b/b.js";\nexport const a2 = b;\n');
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "dirty");
  assert.deepEqual(out.diffs, [
    { from: "src/a/a.js", to: "src/b/b.js", fromNode: "u-a", toNode: "u-b" },
  ]);
  assert.deepEqual(out.unknowns, []);
});

test("recheck：同一边被 associations 覆盖（两方向）→ clean", (t) => {
  // 方向一：trigger 登记 a 侧，b 侧在 related
  const s1 = setup({ associations: [CO_CHANGE("src/a/a.js", ["src/b/b.js"])] });
  t.after(() => rmSync(s1.root, { recursive: true, force: true }));
  write(s1.repo, "src/a/a.js", 'import { b } from "../b/b.js";\nexport const a2 = b;\n');
  const r1 = runScript("recheck", s1.planPath);
  assert.equal(r1.status, 0);
  assert.equal(JSON.parse(r1.stdout).status, "clean");

  // 方向二：trigger 登记 b 侧，a 侧在 related（related→trigger）
  const s2 = setup({ associations: [CO_CHANGE("src/b/b.js", ["src/a/a.js"])] });
  t.after(() => rmSync(s2.root, { recursive: true, force: true }));
  write(s2.repo, "src/a/a.js", 'import { b } from "../b/b.js";\nexport const a2 = b;\n');
  const r2 = runScript("recheck", s2.planPath);
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(r2.stdout).status, "clean");
});

test("recheck：同单元内新增边 → clean", (t) => {
  const { root, repo, planPath } = setup({
    files: { ...BASE_FILES, "src/a/peer.js": "export const p = 1;\n" },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", 'import { p } from "./peer.js";\nexport const a2 = p;\n');
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("recheck：包名引用（lodash-es / node:fs）不追踪 → clean", (t) => {
  const { root, repo, planPath } = setup({});
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", 'import { curry } from "lodash-es";\nimport { readFileSync } from "node:fs";\nexport const a2 = 1;\n');
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "clean");
  assert.deepEqual(out.diffs, []);
});

test("recheck：require(非字面量) → status=unknown（exit 2，不是 clean/dirty）", (t) => {
  const { root, repo, planPath } = setup({});
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "const mod = require(someVar);\nexport const u = mod;\n");
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "unknown");
  assert.deepEqual(out.diffs, []);
  assert.equal(out.unknowns.length, 1);
  assert.equal(out.unknowns[0].file, "src/a/a.js");
  assert.match(out.unknowns[0].reason, /require/);
});

test("recheck：base 不存在的新增文件按空 base 处理（untracked 不进改动集）", (t) => {
  const { root, repo, planPath } = setup({
    associations: [CO_CHANGE("src/a/new.js", ["src/b/b.js"])],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/new.js", 'import { b } from "../b/b.js";\nexport const n = b;\n');
  // 未 git add：untracked 对 git diff 不可见 → 不进改动集 → clean 且不报错
  const r1 = runScript("recheck", planPath);
  assert.equal(r1.status, 0);
  assert.equal(JSON.parse(r1.stdout).status, "clean");
  // git add 后进改动集：base 无此文件按空 base 处理（不报错），新增边已被 associations 覆盖
  git(repo, "add", "src/a/new.js");
  const r2 = runScript("recheck", planPath);
  assert.equal(r2.status, 0);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.status, "clean");
  assert.deepEqual(out2.unknowns, []);
});

test("recheck：worktree 节点 territory 文件 → unknowns（不做边解析）", (t) => {
  const { root, repo, planPath } = setup({
    files: { ...BASE_FILES, "wt/x.js": "export const x = 0;\n" },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 注入 worktree 节点：cwd 为非 projectRoot 的绝对路径（存在与否不影响判定，字符串直比）
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes = [
    ...DEV_NODES,
    { id: "u-w", kind: "dev", deps: [], cwd: join(root, "wt-checkout"), territory: ["wt/"] },
  ];
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  // 内容带未声明跨单元 import：若被误解析会判 dirty，正确行为是 unknown 且不做边解析
  write(repo, "wt/x.js", 'import { b } from "../b/b.js";\nexport const x = 1;\n');
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "unknown");
  assert.deepEqual(out.diffs, []);
  assert.deepEqual(out.unknowns, [
    { file: "wt/x.js", reason: "worktree 节点暂不支持静态分析" },
  ]);
});

test("recheck：dirty 与 unknown 并存 → dirty 优先（三态不混），unknowns 保留", (t) => {
  const { root, repo, planPath } = setup({
    files: { ...BASE_FILES, "src/c/c.js": "export const c = 1;\n" },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", 'import { b } from "../b/b.js";\nexport const a2 = b;\n'); // 未声明跨单元边
  write(repo, "src/c/c.js", "const mod = require(someVar);\nexport const c2 = mod;\n"); // 不可判定
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 1); // dirty（1），不是 unknown（2）
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "dirty");
  assert.equal(out.diffs.length, 1);
  assert.equal(out.diffs[0].from, "src/a/a.js");
  assert.equal(out.unknowns.length, 1);
  assert.equal(out.unknowns[0].file, "src/c/c.js");
});

test("recheck：四种字面量形态 × 四扩展名全部成边", (t) => {
  // 被改文件全部先入 base 提交（tracked）：untracked 文件不进 git diff 改动集，
  // 留在 untracked 态会让整个用例空转
  const { root, repo, planPath } = setup({
    files: {
      "src/a/a.js": "export const a = 1;\n",
      "src/a/a.ts": "export const t = 1;\n",
      "src/a/a.mjs": "export const m = 1;\n",
      "src/a/a.cjs": "exports.c = 1;\n",
      "src/b/b.js": "export const b = 2;\n",
      "src/b/b2.js": "export const b2 = 1;\n",
      "src/b/b3.js": "module.exports = { b3: 1 };\n",
      "src/b/b4.js": "export const b4 = 1;\n",
      "src/c/c1.js": "export const c1 = 1;\n", // 不属于任何节点 territory → 边不报告
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, "src/a/a.js", "const dyn = require(missingVar);\n"); // 非字面量 → unknown，边不出
  write(repo, "src/a/a.ts", 'import { b } from "../b/b.js";\nawait import("../c/c1.js");\nexport const x = b;\n');
  write(repo, "src/a/a.mjs", 'export { b2 } from "../b/b2.js";\nconst p = import("../b/b4.js");\n');
  write(repo, "src/a/a.cjs", 'const m = require("../b/b3.js");\nmodule.exports = m;\n');
  const r = runScript("recheck", planPath);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "dirty");
  const edges = out.diffs.map((d) => `${d.from}->${d.to}`).sort();
  assert.deepEqual(edges, [
    "src/a/a.cjs->src/b/b3.js", // require 字面量
    "src/a/a.mjs->src/b/b2.js", // export from 字面量
    "src/a/a.mjs->src/b/b4.js", // 动态 import 字面量
    "src/a/a.ts->src/b/b.js",   // import from 字面量
  ]);
  // 指向非节点文件的动态 import 边（a.ts→c1.js）不报告
  assert.ok(!edges.some((e) => e.includes("c1.js")));
  assert.deepEqual(out.unknowns.map((u) => u.file), ["src/a/a.js"]);
});
