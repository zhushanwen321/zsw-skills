// workspace-inventory.test.mjs — workspace 真实路径清单提案与确认（sync-conformance-plane U3/M3）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   D5    setup 自动提出 workspace 清单（repoId、真实根、允许编辑根、默认分支），主 agent 确认
//   G5 --unknown-repository  未登记仓库、符号链接逃逸与 Git 根不一致必须拒启
//   U3 检查点  夹具五类：根仓 / 普通子目录 / 符号链接目标仓 / gitignore 命中路径 / 未登记仓库拒启
//   GA5   符号链接解析为真实仓库（多仓从隐式符号链接变为显式清单）
//
// 夹具全部落系统临时目录（os.tmpdir），用完清理，不留仓库内（任务书约束）。
//
// 运行：node --test scripts/tests/workspace-inventory.test.mjs
//（守护命令形态 node scripts/tests/workspace-inventory.test.mjs --unknown-repository 等价——
//  flag 为守护登记形态，文件恒跑全部用例）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { symlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");
const { proposeWorkspaceInventory, confirmWorkspaceInventory } = await import(join(CP, "workspace", "inventory.mjs"));

/**
 * 五类夹具工作区（tmpdir）：
 *   <tmp>/project/                 根仓（一类）
 *     .gitignore                   忽略 vendor-repo/
 *     lib-repo/                    普通子目录仓（二类）
 *     vendor-repo/                 gitignore 命中路径仓（四类）
 *     link-ext -> ../ext-repo      符号链接目标仓（三类）
 *   <tmp>/ext-repo/                workspace 外真实仓（符号链接目标）
 *   <tmp>/project/stray-repo/      未登记仓库（五类，可选开关）
 */
function buildWorkspaceFixture({ withStray = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "conf-inv-"));
  const mk = (dir) => {
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.email", "fixture@test"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.name", "fixture"], { encoding: "utf8" });
    return dir;
  };
  const commit = (dir, msg) => {
    spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
    const r = spawnSync("git", ["-C", dir, "commit", "-qm", msg], { encoding: "utf8" });
    assert.equal(r.status, 0, `commit in ${dir}: ${r.stderr}`);
  };
  const project = mk(join(tmp, "project"));
  const extRepo = mk(join(tmp, "ext-repo"));
  const libRepo = mk(join(project, "lib-repo"));
  const vendorRepo = mk(join(project, "vendor-repo"));
  const strayRepo = withStray ? mk(join(project, "stray-repo")) : null;
  writeFileSync(join(project, ".gitignore"), "vendor-repo/\n");
  writeFileSync(join(project, "root.txt"), "root\n");
  writeFileSync(join(libRepo, "lib.txt"), "lib\n");
  writeFileSync(join(vendorRepo, "v.txt"), "v\n");
  if (strayRepo) writeFileSync(join(strayRepo, "s.txt"), "s\n");
  writeFileSync(join(extRepo, "ext.txt"), "ext\n");
  // 先内容后提交：根仓的 .gitignore 必须在扫描判定前就位（判定只读 .gitignore，不依赖提交）
  commit(libRepo, "lib base");
  commit(vendorRepo, "vendor base");
  if (strayRepo) commit(strayRepo, "stray base");
  commit(extRepo, "ext base");
  commit(project, "project base");
  const linkPath = join(project, "link-ext");
  symlinkSync(extRepo, linkPath, "dir");
  return { tmp, project, extRepo, libRepo, vendorRepo, strayRepo, linkPath };
}

const DECLARED_ALL = (fixture) => [
  { repoId: "main", path: fixture.project },
  { repoId: "lib", path: "lib-repo" },
  { repoId: "ext", path: fixture.linkPath },
];

// ---------------------------------------------------------------------------
// 1. 五类夹具全覆盖：根仓 / 普通子目录 / 符号链接目标仓 / gitignore 命中路径（U3 检查点）
// ---------------------------------------------------------------------------

test("五类夹具：提案含根仓/子目录仓/符号链接目标仓（真实根），gitignore 命中不进提案不拒启", () => {
  const fx = buildWorkspaceFixture();
  try {
    const r = proposeWorkspaceInventory({ projectRoot: fx.project, declared: DECLARED_ALL(fx) });
    assert.equal(r.ok, true, `findings: ${JSON.stringify(r.findings)}`);
    const byId = new Map(r.proposal.map((p) => [p.repoId, p]));
    // 一类：根仓（source=root）
    assert.equal(byId.get("main").source, "root");
    assert.equal(byId.get("main").realRoot, realpathSync(fx.project), "根仓真实根 = realpath");
    // 二类：普通子目录仓（source=subdir）
    assert.equal(byId.get("lib").source, "subdir");
    assert.equal(byId.get("lib").realRoot, realpathSync(fx.libRepo));
    // 三类：符号链接目标仓（source=symlink，真实根 = 链接目标 realpath——GA5 隐式→显式）
    assert.equal(byId.get("ext").source, "symlink");
    assert.equal(byId.get("ext").realRoot, realpathSync(fx.extRepo), "符号链接解析为真实仓库");
    // 提案字段完备（D5：repoId、真实根、允许编辑根、默认分支）
    for (const p of r.proposal) {
      assert.equal(typeof p.repoId, "string");
      assert.equal(typeof p.realRoot, "string");
      assert.equal(typeof p.editableRoot, "string");
      assert.equal(typeof p.defaultBranch, "string");
      assert.notEqual(p.defaultBranch, "");
    }
    // 四类：gitignore 命中路径仓——不进提案、不触发未登记拒启，登记备查（findings.ignored）
    assert.ok(!r.proposal.some((p) => p.realRoot === realpathSync(fx.vendorRepo)), "gitignore 命中仓不进提案");
    assert.equal(r.findings.ignored.length, 1, `ignored: ${JSON.stringify(r.findings.ignored)}`);
    assert.equal(r.findings.ignored[0].realRoot, realpathSync(fx.vendorRepo));
    assert.equal(r.findings.unregistered.length, 0);
    assert.equal(r.findings.escapedSymlinks.length, 0);
    assert.equal(r.findings.rootMismatch.length, 0);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 未登记仓库拒启（五类之五，G5 --unknown-repository）
// ---------------------------------------------------------------------------

test("未登记仓库拒启：非 gitignore 的扫描发现仓不在登记清单 → ok=false 且 unregistered 指名（G5 --unknown-repository）", () => {
  const fx = buildWorkspaceFixture({ withStray: true });
  try {
    const r = proposeWorkspaceInventory({ projectRoot: fx.project, declared: DECLARED_ALL(fx) });
    assert.equal(r.ok, false, "未登记仓库必须拒启");
    assert.equal(r.findings.unregistered.length, 1);
    assert.equal(r.findings.unregistered[0].realRoot, realpathSync(fx.strayRepo));
    assert.match(r.findings.unregistered[0].path, /stray-repo$/);
    assert.equal(r.proposal.length, 0, "拒启时不产出提案（提案仅在全绿时有效）");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 符号链接逃逸与 Git 根不一致拒启（G5 其余两项）
// ---------------------------------------------------------------------------

test("符号链接逃逸拒启：链接指向未登记仓 → escapedSymlinks 指名链接路径（G5）", () => {
  const fx = buildWorkspaceFixture();
  try {
    // 未登记符号链接目标仓：声明只含根仓与子目录仓，ext 链接目标不入登记
    const r = proposeWorkspaceInventory({
      projectRoot: fx.project,
      declared: [{ repoId: "main", path: fx.project }, { repoId: "lib", path: "lib-repo" }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.findings.escapedSymlinks.length, 1, `escaped: ${JSON.stringify(r.findings.escapedSymlinks)}`);
    assert.equal(r.findings.escapedSymlinks[0].realRoot, realpathSync(fx.extRepo));
    assert.match(r.findings.escapedSymlinks[0].linkPath, /link-ext$/);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("Git 根不一致拒启：登记路径存在但不是 Git 仓 → rootMismatch（G5）", () => {
  const fx = buildWorkspaceFixture();
  try {
    // 存在但非 Git 仓的普通目录（放 tmp 根——不在任何仓内，toplevel 解析必失败）
    const plainDir = join(fx.tmp, "plain-dir");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "p.txt"), "p\n");
    const r = proposeWorkspaceInventory({
      projectRoot: fx.project,
      declared: [...DECLARED_ALL(fx), { repoId: "bad", path: plainDir }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.findings.rootMismatch.length, 1, `mismatch: ${JSON.stringify(r.findings.rootMismatch)}`);
    assert.equal(r.findings.rootMismatch[0].repoId, "bad");
    assert.match(r.findings.rootMismatch[0].reason, /不是 Git 仓/);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("Git 根不一致拒启：登记路径是仓的子目录（toplevel 指向别处）→ reason 指明仓中间目录（G5）", () => {
  const fx = buildWorkspaceFixture();
  try {
    // ext-repo 内建子目录并登记该子目录路径（登记指向仓中间目录）
    const nested = join(fx.extRepo, "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "n.txt"), "n\n");
    const r = proposeWorkspaceInventory({
      projectRoot: fx.project,
      declared: [...DECLARED_ALL(fx), { repoId: "bad", path: join(fx.extRepo, "sub") }],
    });
    assert.equal(r.ok, false);
    const mismatch = r.findings.rootMismatch.find((m) => m.repoId === "bad");
    assert.ok(mismatch, `mismatch: ${JSON.stringify(r.findings.rootMismatch)}`);
    assert.match(mismatch.reason, /仓中间目录/);
    assert.match(mismatch.reason, /Git 根在/);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 确认命令：子集生效 / 未知 id 拒绝 / 空选择拒绝 / 提案外不可混入（D5 主 agent 确认）
// ---------------------------------------------------------------------------

test("确认命令：确认子集返回 inventory（真实根口径），actor 登记（D5）", () => {
  const fx = buildWorkspaceFixture();
  try {
    const proposal = proposeWorkspaceInventory({ projectRoot: fx.project, declared: DECLARED_ALL(fx) }).proposal;
    const confirmed = confirmWorkspaceInventory({
      proposal,
      confirmedRepoIds: ["main", "ext"],
      actor: "main-agent",
    });
    assert.equal(confirmed.confirmedBy, "main-agent");
    assert.deepEqual(confirmed.inventory.map((i) => i.repoId), ["main", "ext"]);
    assert.equal(confirmed.inventory[1].realRoot, realpathSync(fx.extRepo), "确认产物保留真实根口径");
    assert.equal(confirmed.inventory[1].defaultBranch, proposal.find((p) => p.repoId === "ext").defaultBranch);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("确认命令：提案外 repoId 拒绝 / 空选择拒绝 / 缺 actor 拒绝（错误带恢复动作）", () => {
  const fx = buildWorkspaceFixture();
  try {
    const proposal = proposeWorkspaceInventory({ projectRoot: fx.project, declared: DECLARED_ALL(fx) }).proposal;
    assert.throws(
      () => confirmWorkspaceInventory({ proposal, confirmedRepoIds: ["main", "ghost"], actor: "main-agent" }),
      (e) => e.code === "inventory-repo-unknown" && /恢复动作/.test(e.message),
      "提案外 repoId 拒绝",
    );
    assert.throws(
      () => confirmWorkspaceInventory({ proposal, confirmedRepoIds: [], actor: "main-agent" }),
      (e) => e.code === "inventory-confirm-empty",
      "空选择拒绝",
    );
    assert.throws(
      () => confirmWorkspaceInventory({ proposal, confirmedRepoIds: ["main"], actor: "" }),
      (e) => e.code === "inventory-actor-missing",
      "缺 actor 拒绝",
    );
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});
