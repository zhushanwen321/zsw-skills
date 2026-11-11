// changeset-isolation.test.mjs — 隔离变更集与集成器（sync-conformance-plane U3/M3）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   D4/G4 --no-shared-writes  agent 执行期间目标仓工作树文件与 HEAD/ref、设计文档与宿主共享
//                             对象库 .git/objects 零写入；多仓 manifest 逐仓 count-objects 对账
//                             （松散+打包合计，口径对 gc 打包稳定）；反例注入（sandbox 内 git add）
//                             计数增长可检出（V15，探针实测 3→4）
//   第六段  worktree 生命周期（创建→补丁→回收无残留）；宿主管理区不变量（N 次生成 + 中途崩溃
//           注入后 worktree list / branch / status 无残留，U3 检查点）；清理通道 remove+prune +
//           启动期清扫 prunable/孤儿分支；集成三分支各自可区分（IntegrationPrecheckFailed /
//           IntegrationGateChecked(failure=true) / rolled-back）且挂钩拒绝全量不应用（V5）；
//           两阶段提交绕过挂钩写 IntegrationGateChecked(failure=false) 审计不静默；
//           版本 bump 预检（触及技能自有文件缺 SKILL.md version bump = 预检红灯）；manual 模式
//           （actor=main-agent 同一门径）；冲突补丁不自动变基（生成重生成任务）
//   V14  doc-proposals 四步闭环：提案 → RulingRequested/RulingRecorded(doc-right) 裁决采纳 →
//           集成器 manual 同门径应用到章节 JSON → 新绑定版本 + BacklogAdopted 语义转新地址初始证据
//
// 夹具全部落系统临时目录（os.tmpdir），用完清理，禁写 skill-data 段或项目仓（任务书约束）。
// 「宿主管理区不变量的 N 次」取 N=3（任务书约束：可判定下限，实施期可调）——3 轮覆盖
// 正常创建/回收、崩溃注入、清扫恢复三种形态各至少一次，是能判明清扫通道正确性的下限。
//
// 运行：node --test scripts/tests/changeset-isolation.test.mjs
//（守护命令形态 node scripts/tests/changeset-isolation.test.mjs --no-shared-writes 等价——
//  flag 为守护登记形态，文件恒跑全部用例）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");
const sandboxMod = await import(join(CP, "changeset", "sandbox.mjs"));
const manifestMod = await import(join(CP, "changeset", "manifest.mjs"));
const integratorMod = await import(join(CP, "integration", "integrator.mjs"));
const docProposals = await import(join(CP, "integration", "doc-proposals.mjs"));
const stateRepo = await import(join(CP, "kernel", "state-repo.mjs"));
const factsMod = await import(join(CP, "kernel", "facts.mjs"));
const evidenceMod = await import(join(CP, "kernel", "evidence.mjs"));

const { createSandbox, releaseSandbox, sweepHost, measureObjectCounts, hostResidueProbe, SANDBOX_BRANCH_PREFIX, HOST_WRITE_POINTS, FORBIDDEN_OBJECT_COMMANDS } = sandboxMod;
const { createManifest, readManifest, verifyManifest } = manifestMod;
const { integrateChangeset } = integratorMod;

/**
 * 测试自有工具（原 sandbox.mjs 导出下沉至此，bl-8/bl-6 裁决）：agent 阶段禁用命令检查义务——
 * 禁产对象命令（FORBIDDEN_OBJECT_COMMANDS）命中即拒。设计防线只有两层（模板 prompt 注入 +
 * 收尾 count-objects 对账），引擎不接线本检查；此处仅供测试断言命令清单检查行为。
 */
function assertNoObjectCommands(commands) {
  const offenders = commands.filter((c) => FORBIDDEN_OBJECT_COMMANDS.includes(c));
  if (offenders.length > 0) {
    const err = new Error(
      `sandbox 内禁用产对象命令（第④类裁决）：${offenders.join(", ")}。` +
        `恢复动作：改用工作树级 diff 产补丁（git diff / git diff --no-index）；产对象只发生在集成器阶段。`,
    );
    err.code = "forbidden-object-command";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 夹具基座（全部落 os.tmpdir；对项目仓零 git 写操作）
// ---------------------------------------------------------------------------

function git(dir, args, opts = {}) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", ...opts });
}

function gitOk(dir, args, label) {
  const r = git(dir, args);
  assert.equal(r.status, 0, `${label ?? `git ${args.join(" ")}`} 失败: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ["init", "-q"], `init ${dir}`);
  gitOk(dir, ["config", "user.email", "fixture@test"], "config email");
  gitOk(dir, ["config", "user.name", "fixture"], "config name");
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  gitOk(dir, ["add", "-A"], "add");
  gitOk(dir, ["commit", "-qm", "base"], "commit");
  return dir;
}

/** 两仓夹具（多仓 manifest 逐仓断言的基座）：repo-main（含技能自有文件形态）+ repo-ext */
function buildTwoRepos() {
  const tmp = mkdtempSync(join(tmpdir(), "conf-iso-"));
  const repoMain = makeRepo(join(tmp, "repo-main"), {
    "src/app.txt": "app v1\n",
    "skills/self/dev-workflow/my-skill/SKILL.md": "---\nname: my-skill\nversion: 0.1.0\n---\n\n# my-skill\n",
    "skills/self/dev-workflow/my-skill/scripts/helper.js": "export const x = 1;\n",
  });
  const repoExt = makeRepo(join(tmp, "repo-ext"), { "ext/lib.txt": "lib v1\n" });
  return { tmp, repoMain, repoExt };
}

/** 单仓 + 状态仓夹具（事件断言用；bindings 登记 repo-main 一条义务，checker/artifact 可供 pass 证据入场） */
function buildWithStateRepo() {
  const fx = buildTwoRepos();
  const stateRoot = join(fx.tmp, "state-store");
  stateRepo.initStateRepo(stateRoot, {
    archived: false,
    bindings: [
      { bindingId: "V12", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 },
    ],
    repos: [{ repoId: "repo-main" }, { repoId: "repo-ext" }],
    checkerRuns: [{ checkerId: "symbol-scan", checkerVersion: "1.0.0" }],
    changesets: [],
    artifacts: { "src/app.txt": evidenceMod.hashContent("app v1\n") },
  });
  return { ...fx, stateRoot };
}

/** sandbox 段与变更集段（模拟 skill-data 注入段，tmpdir 形态） */
function segments(tmp, changesetId) {
  return { sandboxRoot: join(tmp, "sandbox"), outDir: join(tmp, "changesets", changesetId) };
}

/** 标准隔离周期：创建 sandbox → 工作树级修改（含新文件）→ 产 manifest（零对象写） */
function produceChangeset(fx, { changesetId, mutate }) {
  const { sandboxRoot, outDir } = segments(fx.tmp, changesetId);
  const sbMain = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: `${changesetId}-main` });
  const sbExt = createSandbox({ repoRoot: fx.repoExt, sandboxRoot, changesetId: `${changesetId}-ext` });
  mutate(sbMain, sbExt);
  const manifest = createManifest({
    changesetId,
    outDir,
    repos: [
      { repoId: "repo-main", repoRoot: fx.repoMain, sandbox: sbMain },
      { repoId: "repo-ext", repoRoot: fx.repoExt, sandbox: sbExt },
    ],
  });
  return { sbMain, sbExt, manifest, outDir };
}

/** 读状态仓事件流（类型序列） */
function eventTypes(stateRoot) {
  return stateRepo.readEvents(stateRoot).map((e) => e.type);
}

// ---------------------------------------------------------------------------
// 1. worktree 生命周期：创建 → 补丁 → 回收无残留（第六段清理通道）
// ---------------------------------------------------------------------------

test("worktree 生命周期：创建→工作树级修改→manifest→回收后宿主无残留（worktree list/branch/status）", () => {
  const fx = buildTwoRepos();
  try {
    const { sandboxRoot, outDir } = segments(fx.tmp, "cs-life");
    const before = { main: measureObjectCounts(fx.repoMain).total, ext: measureObjectCounts(fx.repoExt).total };
    const sb = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: "cs-life-main" });
    assert.equal(sb.branch, `${SANDBOX_BRANCH_PREFIX}cs-life-main`);
    // agent 工作树级修改（禁产对象命令——只用工作树写入 + diff）
    writeFileSync(join(sb.dir, "src/app.txt"), "app v2\n");
    writeFileSync(join(sb.dir, "src/added.txt"), "new file\n"); // untracked 新文件
    const manifest = createManifest({
      changesetId: "cs-life",
      outDir,
      repos: [{ repoId: "repo-main", repoRoot: fx.repoMain, sandbox: sb }],
    });
    // 补丁含修改与新文件（--no-index 拼接）；基准快照登记
    const repoEntry = manifest.repos[0];
    assert.equal(repoEntry.hasChanges, true);
    assert.match(readFileSync(join(outDir, "repo-main.patch"), "utf8"), /app v2/);
    assert.match(readFileSync(join(outDir, "repo-main.patch"), "utf8"), /added\.txt/);
    assert.ok(/^[0-9a-f]{40}$/.test(repoEntry.baseCommit), "基准 commit 登记为 sha");
    assert.ok(/^[0-9a-f]{64}$/.test(repoEntry.targetTreeHash), "目标树哈希为 sha256（工作树级口径）");
    assert.deepEqual(repoEntry.changedFiles, ["src/added.txt", "src/app.txt"]);
    // 回收：remove + prune + 删临时分支
    const rel = releaseSandbox(sb);
    assert.equal(rel.removed, true);
    assert.equal(rel.branchDeleted, true);
    // 宿主无残留（worktree list / branch / status 三探针全空）
    const residue = hostResidueProbe(fx.repoMain);
    assert.deepEqual(residue.worktreeEntries, [], `worktree 残留: ${JSON.stringify(residue.worktreeEntries)}`);
    assert.deepEqual(residue.sandboxBranches, [], `分支残留: ${JSON.stringify(residue.sandboxBranches)}`);
    assert.deepEqual(residue.dirtyFiles, [], `status 残留: ${JSON.stringify(residue.dirtyFiles)}`);
    // agent 阶段对象库零写（创建/修改/diff/回收全程）
    assert.equal(measureObjectCounts(fx.repoMain).total, before.main, "生命周期全程宿主对象库零写入");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 宿主管理区不变量：N=3 次生成 + 中途崩溃注入 → 清扫通道恢复（U3 检查点；N=3 依据见文件头）
// ---------------------------------------------------------------------------

test("宿主管理区不变量：N=3 次变更集生成（第 2 次崩溃注入硬删）后 sweep 恢复无残留", () => {
  const fx = buildTwoRepos();
  try {
    const sandboxRoot = join(fx.tmp, "sandbox");
    // 第 1 轮：正常创建 → 回收
    const sb1 = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: "cs-n1" });
    writeFileSync(join(sb1.dir, "src/app.txt"), "n1\n");
    releaseSandbox(sb1);
    // 第 2 轮：创建 → 中途崩溃注入（进程死亡 = 检出目录被硬删，不走回收通道）
    const sb2 = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: "cs-n2" });
    writeFileSync(join(sb2.dir, "src/app.txt"), "n2\n");
    rmSync(sb2.dir, { recursive: true, force: true });
    // 崩溃后 worktree list 留 prunable 残留（实测参考数据：需 prune 清除）——先断言残留可见
    const afterCrash = hostResidueProbe(fx.repoMain);
    assert.equal(afterCrash.worktreeEntries.length, 1, "崩溃注入后 worktree 管理区残留可见");
    // 第 3 轮：创建 → 正常回收
    const sb3 = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: "cs-n3" });
    releaseSandbox(sb3);
    // 启动期清扫：prunable 残留条目 + 孤儿临时分支（cs-n2 的分支此时已无 worktree 挂载）
    const swept = sweepHost({ repoRoot: fx.repoMain });
    assert.deepEqual(swept.removedBranches, [`${SANDBOX_BRANCH_PREFIX}cs-n2`], `孤儿分支清扫: ${JSON.stringify(swept.removedBranches)}`);
    // 不变量终态：三探针全空
    const residue = hostResidueProbe(fx.repoMain);
    assert.deepEqual(residue.worktreeEntries, [], `worktree 残留: ${JSON.stringify(residue.worktreeEntries)}`);
    assert.deepEqual(residue.sandboxBranches, [], `分支残留: ${JSON.stringify(residue.sandboxBranches)}`);
    assert.deepEqual(residue.dirtyFiles, [], `status 残留: ${JSON.stringify(residue.dirtyFiles)}`);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 对象库零写 + 反例注入可检出（G4 --no-shared-writes / V15；多仓逐仓不外推）
// ---------------------------------------------------------------------------

test("对象库零写：两仓 agent 阶段（创建/修改/纯 diff 产补丁）逐仓 count+in-pack 合计不变（V15 正例）", () => {
  const fx = buildTwoRepos();
  try {
    const before = { main: measureObjectCounts(fx.repoMain).total, ext: measureObjectCounts(fx.repoExt).total };
    const { sbMain, sbExt } = produceChangeset(fx, {
      changesetId: "cs-zerowrite",
      mutate: (m, e) => {
        writeFileSync(join(m.dir, "src/app.txt"), "zero-write\n");
        writeFileSync(join(e.dir, "ext/lib.txt"), "lib v2\n");
      },
    });
    const after = { main: measureObjectCounts(fx.repoMain).total, ext: measureObjectCounts(fx.repoExt).total };
    assert.equal(after.main, before.main, `repo-main 对象库零写（${before.main} → ${after.main}）`);
    assert.equal(after.ext, before.ext, `repo-ext 对象库零写（${before.ext} → ${after.ext}）——多仓逐仓不外推`);
    // 回收后宿主 status 干净（工作树/HEAD 零写入的同义探针）
    releaseSandbox(sbMain);
    releaseSandbox(sbExt);
    assert.deepEqual(hostResidueProbe(fx.repoMain).dirtyFiles, [], "repo-main 工作树零写入");
    assert.deepEqual(hostResidueProbe(fx.repoExt).dirtyFiles, [], "repo-ext 工作树零写入");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("反例注入可检出：sandbox 内 git add 使宿主对象库计数增长，检测器口径可判定（V15 反例）", () => {
  const fx = buildTwoRepos();
  try {
    const sandboxRoot = join(fx.tmp, "sandbox");
    const before = measureObjectCounts(fx.repoMain).total;
    const sb = createSandbox({ repoRoot: fx.repoMain, sandboxRoot, changesetId: "cs-violate" });
    writeFileSync(join(sb.dir, "src/app.txt"), "violating\n");
    // 反例注入：第④类禁产对象命令真实执行（探针实测口径：git add 使 count 3→4）
    gitOk(sb.dir, ["add", "src/app.txt"], "注入 git add");
    const after = measureObjectCounts(fx.repoMain).total;
    assert.ok(after > before, `检测器必须可检出违例（${before} → ${after}）`);
    // 禁令常量登记：四类写入点第④类 policy=forbidden；禁产命令清单齐备
    assert.equal(HOST_WRITE_POINTS.find((w) => w.kind === "shared-object-store").policy, "forbidden");
    assert.deepEqual([...FORBIDDEN_OBJECT_COMMANDS], ["add", "commit", "stash", "hash-object"]);
    assert.throws(
      () => assertNoObjectCommands(["add"]),
      (e) => e.code === "forbidden-object-command" && /恢复动作/.test(e.message),
      "命令清单检查器拒绝禁产命令",
    );
    releaseSandbox(sb);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("变更集哈希不可变：manifest 内容篡改（补丁/树哈希）被 verifyManifest 拒绝", () => {
  const fx = buildTwoRepos();
  try {
    const { manifest, outDir } = produceChangeset(fx, {
      changesetId: "cs-tamper",
      mutate: (m) => writeFileSync(join(m.dir, "src/app.txt"), "tamper-check\n"),
    });
    assert.equal(verifyManifest(manifest).ok, true);
    // 读盘形态完整（manifest + patch 落盘 + patchHash 对账）
    const loaded = readManifest(outDir);
    assert.equal(loaded.manifest.changesetId, "cs-tamper");
    // 篡改树哈希 → 哈希不符
    const tampered = structuredClone(loaded.manifest);
    tampered.repos[0].targetTreeHash = "f".repeat(64);
    assert.equal(verifyManifest(tampered).ok, false, "树哈希篡改被拒绝");
    // 篡改补丁文件 → patchHash 对账拒绝
    writeFileSync(join(outDir, "repo-main.patch"), "malicious patch\n");
    assert.throws(() => readManifest(outDir), (e) => e.code === "manifest-tampered", "补丁篡改被拒绝");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 集成三分支事件可区分 + 挂钩拒绝全量不应用（V5）
// ---------------------------------------------------------------------------

test("分支一 预检失败：冲突补丁 → IntegrationPrecheckFailed（四要素），全量不应用，生成重生成任务", async () => {
  const fx = buildWithStateRepo();
  try {
    const produced = produceChangeset(fx, {
      changesetId: "cs-prefail",
      mutate: (m) => writeFileSync(join(m.dir, "src/app.txt"), "conflicting\n"),
    });
    // 集成前正式仓基线漂移（补丁基于旧基线 → apply --check 冲突）
    writeFileSync(join(fx.repoMain, "src/app.txt"), "moved-on\n");
    gitOk(fx.repoMain, ["add", "-A"], "stage drift");
    gitOk(fx.repoMain, ["commit", "-qm", "drift"], "commit drift");
    const headBefore = gitOk(fx.repoMain, ["rev-parse", "HEAD"], "head").trim();
    const r = await integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "engine" });
    assert.equal(r.outcome, "failed");
    assert.equal(r.events.includes("RecordIntegrationPrecheckFailure"), true, `事件: ${JSON.stringify(r.events)}`);
    assert.equal(eventTypes(fx.stateRoot).includes("IntegrationPrecheckFailed"), true, "事件入流");
    // 四要素字段契约（逐仓命令、退出码、摘要、恢复动作）
    const fact = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "IntegrationPrecheckFailed");
    assert.equal(fact.repoId, "repo-main");
    for (const field of ["command", "summary", "recovery"]) assert.ok(typeof fact[field] === "string" && fact[field] !== "");
    assert.ok(Number.isInteger(fact.exitCode));
    assert.match(fact.recovery, /不自动变基|重新生成/);
    // 冲突补丁不自动变基：重生成任务生成
    assert.deepEqual(r.regenerateTask.repos, ["repo-main"]);
    assert.equal(r.regenerateTask.reason, "apply-conflict");
    // 全量不应用：repo-ext（无冲突仓）也未被集成
    assert.equal(gitOk(fx.repoExt, ["rev-parse", "HEAD"], "ext head").trim(), produced.sbExt.baseCommit, "无冲突仓同样不应用");
    assert.equal(gitOk(fx.repoMain, ["rev-parse", "HEAD"], "main head").trim(), headBefore, "目标仓 HEAD 未动");
    assert.deepEqual(hostResidueProbe(fx.repoMain).dirtyFiles, [], "正式仓工作树未被污染");
    // 两分支可区分：此分支不产生 IntegrationGateChecked
    assert.equal(eventTypes(fx.stateRoot).includes("IntegrationGateChecked"), false);
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("分支二 挂钩拒绝：pre-commit 非零退出 → IntegrationGateChecked(failure=true+hookPath)，两仓全量不应用", async () => {
  const fx = buildWithStateRepo();
  try {
    // repo-main 配置宿主形态挂钩（core.hooksPath 挂载点；恒拒绝）
    const hooksDir = join(fx.tmp, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    gitOk(fx.repoMain, ["config", "core.hooksPath", hooksDir], "hooksPath");
    const produced = produceChangeset(fx, {
      changesetId: "cs-hookrej",
      mutate: (m, e) => {
        writeFileSync(join(m.dir, "src/app.txt"), "hook-rejected\n");
        writeFileSync(join(e.dir, "ext/lib.txt"), "lib v9\n"); // 无挂钩仓同样不许应用（全量不应用）
      },
    });
    const mainHead = gitOk(fx.repoMain, ["rev-parse", "HEAD"], "head").trim();
    const extHead = gitOk(fx.repoExt, ["rev-parse", "HEAD"], "ext head").trim();
    const r = await integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "engine" });
    assert.equal(r.outcome, "failed");
    assert.equal(r.events.includes("RecordIntegrationGate"), true, `事件: ${JSON.stringify(r.events)}`);
    const fact = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "IntegrationGateChecked");
    // 挂钩拒绝形态：failure=true + hookPath（两分支字段级可区分）
    assert.equal(fact.failure, true);
    assert.equal(fact.hookPath, hook);
    assert.equal(fact.repoId, "repo-main");
    assert.ok(fact.exitCode === 1);
    assert.match(fact.summary, /hook says no|挂钩/);
    assert.match(fact.recovery, /修复挂钩或修正 staged 变更/);
    // 全量不应用：目标仓与无挂钩仓 HEAD 均未动、工作树干净
    assert.equal(gitOk(fx.repoMain, ["rev-parse", "HEAD"], "head").trim(), mainHead);
    assert.equal(gitOk(fx.repoExt, ["rev-parse", "HEAD"], "ext head").trim(), extHead);
    assert.deepEqual(hostResidueProbe(fx.repoMain).dirtyFiles, []);
    assert.deepEqual(hostResidueProbe(fx.repoExt).dirtyFiles, []);
    // 与分支一可区分：无 IntegrationPrecheckFailed
    assert.equal(eventTypes(fx.stateRoot).includes("IntegrationPrecheckFailed"), false);
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("分支三 ref 移动失败：lock 注入 → 按回滚计划恢复，终值 rolled-back，两仓回基线", async () => {
  const fx = buildWithStateRepo();
  try {
    const produced = produceChangeset(fx, {
      changesetId: "cs-refmove",
      mutate: (m, e) => {
        writeFileSync(join(m.dir, "src/app.txt"), "ref-move\n");
        writeFileSync(join(e.dir, "ext/lib.txt"), "lib ref\n");
      },
    });
    // 注入 repo-ext 的 ref 移动失败：update-ref 撞既有 lock 文件
    const branch = gitOk(fx.repoExt, ["rev-parse", "--abbrev-ref", "HEAD"], "branch").trim();
    const lockFile = join(fx.repoExt, ".git", "refs", "heads", `${branch}.lock`);
    writeFileSync(lockFile, "");
    const r = await integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "engine" });
    assert.equal(r.outcome, "rolled-back", `outcome: ${JSON.stringify(r)}`);
    const statuses = new Map(r.perRepo.map((p) => [p.repoId, p.status]));
    // 先集成成功的 repo-main 被回滚计划恢复；失败的 repo-ext 专属状态 ref-move-failed
    assert.equal(statuses.get("repo-main"), "rolled-back");
    assert.equal(statuses.get("repo-ext"), "ref-move-failed");
    // 两仓 HEAD 与工作树均回基线（回滚计划 = 记录的 baseRefSha）
    assert.equal(gitOk(fx.repoMain, ["rev-parse", "HEAD"], "main head").trim(), produced.sbMain.baseCommit);
    assert.equal(gitOk(fx.repoExt, ["rev-parse", "HEAD"], "ext head").trim(), produced.sbExt.baseCommit);
    assert.deepEqual(hostResidueProbe(fx.repoMain).dirtyFiles, [], "repo-main 工作树回基线");
    assert.deepEqual(hostResidueProbe(fx.repoExt).dirtyFiles, [], "repo-ext 工作树回基线");
    // 三分支可区分：无预检失败、无挂钩拒绝（failure=true）——repo-main 移 ref 成功的绕过审计
    // 事件合法在场（append-only 史：移 ref 已发生，随后按回滚计划恢复，不抹事件）
    const types = eventTypes(fx.stateRoot);
    assert.ok(!types.includes("IntegrationPrecheckFailed"), `事件: ${JSON.stringify(types)}`);
    const gates = stateRepo.readEvents(fx.stateRoot).filter((e) => e.type === "IntegrationGateChecked");
    assert.ok(gates.every((g) => g.failure === false), `挂钩拒绝事件不应在场: ${JSON.stringify(gates)}`);
    rmSync(lockFile, { force: true });
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. 成功集成：两阶段提交 + 绕过审计（failure=false）+ 工作树/HEAD 同步 + manual 模式
// ---------------------------------------------------------------------------

test("成功集成：两仓 commit 对象先建后移 ref，绕过挂钩审计 failure=false 入流，工作树与 HEAD 同步", async () => {
  const fx = buildWithStateRepo();
  try {
    // 地址先入场：pass 证据（带 changesetId）→ verified + pending-integration；集成审计在场后离开
    const binding = { bindingId: "V12", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 };
    const address = factsMod.deriveAddress(binding);
    const evidencePayload = evidenceMod.computeEvidence({
      address,
      binding,
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      inputs: [{ name: "src/app.txt", hash: evidenceMod.hashContent("app v1\n") }],
      result: "pass",
      changesetId: "cs-ok",
    });
    await stateRepo.appendCommands(fx.stateRoot, [{ type: "RecordEvidence", actor: "checker-wrapper", payload: evidencePayload }]);
    const produced = produceChangeset(fx, {
      changesetId: "cs-ok",
      mutate: (m, e) => {
        writeFileSync(join(m.dir, "src/app.txt"), "integrated\n");
        writeFileSync(join(e.dir, "ext/lib.txt"), "lib v2\n");
        writeFileSync(join(e.dir, "ext/new.txt"), "brand new\n"); // 新文件（--no-index 补丁）
      },
    });
    const r = await integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "engine" });
    assert.equal(r.outcome, "integrated", `perRepo: ${JSON.stringify(r.perRepo)}`);
    // 工作树与 HEAD 同步（update-ref 后工作树含补丁内容）
    assert.equal(readFileSync(join(fx.repoMain, "src/app.txt"), "utf8"), "integrated\n");
    assert.equal(readFileSync(join(fx.repoExt, "ext/lib.txt"), "utf8"), "lib v2\n");
    assert.equal(readFileSync(join(fx.repoExt, "ext/new.txt"), "utf8"), "brand new\n", "新文件已应用");
    const mainHead = gitOk(fx.repoMain, ["rev-parse", "HEAD"], "head").trim();
    const extHead = gitOk(fx.repoExt, ["rev-parse", "HEAD"], "head").trim();
    assert.notEqual(mainHead, produced.sbMain.baseCommit, "repo-main HEAD 前进");
    assert.notEqual(extHead, produced.sbExt.baseCommit, "repo-ext HEAD 前进");
    // 提交内容与目标树哈希对账（工作树级口径）
    const entry = produced.manifest.repos.find((x) => x.repoId === "repo-main");
    assert.equal(entry.targetTreeHash.length, 64);
    assert.equal(gitOk(fx.repoMain, ["status", "--porcelain"], "status"), "", "集成后正式仓干净");
    // 绕过审计：每仓一条 IntegrationGateChecked(failure=false)，恢复动作 =「非失败记录，无需恢复」
    const facts = stateRepo.readEvents(fx.stateRoot).filter((e) => e.type === "IntegrationGateChecked");
    assert.equal(facts.length, 2, `绕过审计事件: ${JSON.stringify(r.events)}`);
    for (const f of facts) {
      assert.equal(f.failure, false);
      assert.match(f.summary, /绕过挂钩前提/);
      assert.equal(f.recovery, "非失败记录，无需恢复");
    }
    // fold：集成审计在场后 repo-main 地址离开 pending-integration（verified 保留——fail=false 不阻塞）
    const { state } = stateRepo.rebuild(fx.stateRoot);
    const key = state.keys[factsMod.canonicalJson(address)];
    assert.ok(key, "绑定地址在 fold 状态中");
    assert.equal(state.addresses[key].pendingIntegration, false);
    assert.equal(state.addresses[key].integrationBlocked, false);
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("manual 模式：actor=main-agent 走同一门径集成成功；非 main-agent actor 拒绝", async () => {
  const fx = buildWithStateRepo();
  try {
    const produced = produceChangeset(fx, {
      changesetId: "cs-manual",
      mutate: (m) => writeFileSync(join(m.dir, "src/app.txt"), "manual\n"),
    });
    // manual + 非 main-agent → 拒绝（同一门径的 actor 纪律）
    await assert.rejects(
      integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "someone", mode: "manual" }),
      (e) => e.code === "invalid-manual-actor",
    );
    // manual + main-agent → 同一门径成功
    const r = await integrateChangeset(readManifest(produced.outDir), { stateRoot: fx.stateRoot, actor: "main-agent", mode: "manual" });
    assert.equal(r.outcome, "integrated");
    assert.equal(readFileSync(join(fx.repoMain, "src/app.txt"), "utf8"), "manual\n");
    const facts = stateRepo.readEvents(fx.stateRoot).filter((e) => e.type === "IntegrationGateChecked");
    assert.equal(facts.at(-1).actor, "main-agent", "审计事件 actor=main-agent");
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 版本 bump 预检（{{G4}}/{{G5}} 域内版本纪律：触及技能自有文件缺 bump = 预检红灯）
// ---------------------------------------------------------------------------

const SKILL_VERSION_DISCIPLINE = {
  skills: [{ dir: "skills/self/dev-workflow/my-skill", skillMd: "skills/self/dev-workflow/my-skill/SKILL.md" }],
};

test("版本 bump 预检红灯：触及技能自有文件但补丁缺 SKILL.md version bump → IntegrationPrecheckFailed", async () => {
  const fx = buildWithStateRepo();
  try {
    const produced = produceChangeset(fx, {
      changesetId: "cs-verfail",
      mutate: (m) => {
        writeFileSync(join(m.dir, "skills/self/dev-workflow/my-skill/scripts/helper.js"), "export const x = 2;\n");
      },
    });
    const r = await integrateChangeset(readManifest(produced.outDir), {
      stateRoot: fx.stateRoot, actor: "engine", versionDiscipline: SKILL_VERSION_DISCIPLINE,
    });
    assert.equal(r.outcome, "failed");
    const fact = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "IntegrationPrecheckFailed");
    assert.ok(fact, "版本纪律红灯落 IntegrationPrecheckFailed 事件");
    assert.match(fact.summary, /版本纪律预检红灯/);
    assert.match(fact.summary, /version 行变更|未 bump/);
    assert.match(fact.recovery, /SKILL\.md frontmatter version 升号/);
    assert.equal(r.regenerateTask.reason, "version-discipline");
    // 全量不应用：HEAD 未动
    assert.equal(gitOk(fx.repoMain, ["rev-parse", "HEAD"], "head").trim(), produced.sbMain.baseCommit);
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("版本 bump 正向路径：补丁同时携带 SKILL.md version 升号 → 预检通过并集成", async () => {
  const fx = buildWithStateRepo();
  try {
    const produced = produceChangeset(fx, {
      changesetId: "cs-verok",
      mutate: (m) => {
        writeFileSync(join(m.dir, "skills/self/dev-workflow/my-skill/scripts/helper.js"), "export const x = 2;\n");
        writeFileSync(join(m.dir, "skills/self/dev-workflow/my-skill/SKILL.md"), "---\nname: my-skill\nversion: 0.2.0\n---\n\n# my-skill\n");
      },
    });
    const r = await integrateChangeset(readManifest(produced.outDir), {
      stateRoot: fx.stateRoot, actor: "engine", versionDiscipline: SKILL_VERSION_DISCIPLINE,
    });
    assert.equal(r.outcome, "integrated", `perRepo: ${JSON.stringify(r.perRepo)}`);
    assert.match(readFileSync(join(fx.repoMain, "skills/self/dev-workflow/my-skill/SKILL.md"), "utf8"), /version: 0\.2\.0/);
    releaseSandbox(produced.sbMain);
    releaseSandbox(produced.sbExt);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. doc-proposals 四步闭环（V14）
// ---------------------------------------------------------------------------

/** 设计文档仓夹具：docs/pkg/s3-solution.json + 状态仓（documentation-mismatch 绑定） */
function buildDocProposalFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "conf-docprop-"));
  const designRepo = makeRepo(join(tmp, "design-repo"), {
    "docs/pkg/s3-solution.json": JSON.stringify({
      decisions: [{ id: "D4", title: "隔离变更集", text: "原文：修复 agent 直接写正式仓" }],
    }, null, 2) + "\n",
  });
  const stateRoot = join(tmp, "state-store");
  stateRepo.initStateRepo(stateRoot, {
    archived: false,
    bindings: [
      { bindingId: "D4", repoId: "design-docs", violationKind: "documentation-mismatch", bindingVersion: 1 },
    ],
    repos: [{ repoId: "design-docs" }],
    checkerRuns: [],
    changesets: [],
    artifacts: {},
  });
  return { tmp, designRepo, stateRoot };
}

test("doc-proposals 四步闭环（V14）：提案→裁决(doc-right)→manual 门径应用→升版+BacklogAdopted 初始证据", async () => {
  const fx = buildDocProposalFixture();
  try {
    const sectionRelPath = "docs/pkg/s3-solution.json";
    const address = { bindingId: "D4", repoId: "design-docs", violationKind: "documentation-mismatch" };
    // 初版义务表版本（升版前基线，同 obligationsFromBindingSet 口径）
    const initialSnap = stateRepo.readSnapshot(fx.stateRoot);
    const obligationsMod = await import(join(CP, "extractors", "obligations.mjs"));
    const tableV1 = obligationsMod.obligationsFromBindingSet(initialSnap.input.bindings).tableVersion;

    // ① 提案（结构化对象，不直接改章节 JSON）
    const proposal = docProposals.createDocProposal({
      address,
      sectionFile: "s3-solution.json",
      jsonPointer: "/decisions/0/text",
      expectedCurrentValue: "原文：修复 agent 直接写正式仓",
      proposedValue: "修正：修复 agent 只产隔离变更集，集成器唯一写正式仓",
      reason: "设计正文与 AX7 冲突，documentation-mismatch 文档侧修复",
    });
    const headBefore = gitOk(fx.designRepo, ["rev-parse", "HEAD"], "head").trim();
    // 章节文件在提案阶段零写入
    assert.equal(gitOk(fx.designRepo, ["status", "--porcelain"], "clean"), "", "提案阶段设计仓零写入");

    // ②③④ 闭环编排（裁决 doc-right → manual 同门径应用 → 升版 + BacklogAdopted）
    const cycle = await docProposals.runDocProposalCycle({
      stateRoot: fx.stateRoot,
      proposal,
      designRepoRoot: fx.designRepo,
      sectionRelPath,
      rulingDirection: "doc-right",
      actor: "main-agent",
      checkerId: "doc-proposal",
      checkerVersion: "1.0.0",
      evidenceInputs: [{ name: "docs/pkg/s3-solution.json", hash: "a".repeat(64) }],
    });
    // ③ 应用成功：章节 JSON 已更新、设计仓 HEAD 前进、工作树干净
    assert.equal(cycle.applied.integration.outcome, "integrated", JSON.stringify(cycle.applied.integration));
    const newDoc = JSON.parse(readFileSync(join(fx.designRepo, sectionRelPath), "utf8"));
    assert.equal(newDoc.decisions[0].text, "修正：修复 agent 只产隔离变更集，集成器唯一写正式仓");
    assert.notEqual(gitOk(fx.designRepo, ["rev-parse", "HEAD"], "head").trim(), headBefore, "设计仓 HEAD 前进（经集成器门径）");
    assert.equal(gitOk(fx.designRepo, ["status", "--porcelain"], "clean"), "", "应用后设计仓干净");
    // 事件形态：RulingRequested / RulingRecorded(doc-right) / BacklogAdopted / EvidenceRecorded(fail)
    const types = eventTypes(fx.stateRoot);
    assert.deepEqual(
      types.filter((t) => ["RulingRequested", "RulingRecorded", "BacklogAdopted", "EvidenceRecorded", "IntegrationGateChecked"].includes(t)),
      ["RulingRequested", "RulingRecorded", "IntegrationGateChecked", "BacklogAdopted", "EvidenceRecorded"],
      `事件序列: ${JSON.stringify(types)}`,
    );
    const recorded = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "RulingRecorded");
    assert.equal(recorded.direction, "doc-right");
    const gate = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "IntegrationGateChecked");
    assert.equal(gate.actor, "main-agent", "manual 同门径：审计事件 actor=main-agent");
    assert.equal(gate.failure, false);
    // ④ 升版 + BacklogAdopted 语义：bindingVersion 2 + 新地址初始 fail 证据 + 义务表随之升版
    const snap = stateRepo.readSnapshot(fx.stateRoot);
    assert.equal(snap.input.bindings[0].bindingVersion, 2, "绑定集升版");
    const evidence = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "EvidenceRecorded");
    assert.equal(evidence.result, "fail", "观察转新地址初始证据（fail）");
    assert.equal(evidence.bindingVersion, 2);
    assert.equal(evidence.address.bindingId, "D4");
    const adopted = stateRepo.readEvents(fx.stateRoot).find((e) => e.type === "BacklogAdopted");
    assert.equal(adopted.backlogId, proposal.proposalId);
    assert.equal(adopted.newBinding.bindingVersion, 2);
    assert.notEqual(cycle.obligationsTable.tableVersion, tableV1, "义务表随之升版");
    // fold：新地址 fail 证据不伪造 verified；裁决史可查
    const { state } = stateRepo.rebuild(fx.stateRoot);
    const key = state.keys[factsMod.canonicalJson({ ...address, bindingVersion: 2 })] ?? state.keys[factsMod.canonicalJson(address)];
    assert.ok(key, "地址在 fold 状态");
    const addr = state.addresses[key];
    assert.equal(addr.awaitingRuling, false, "裁决已应答");
    assert.equal(addr.lastRuling.direction, "doc-right");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("doc-proposals 裁决非 doc-right 中止：code-right 不应用不升版（提案通道方向纪律）", async () => {
  const fx = buildDocProposalFixture();
  try {
    const proposal = docProposals.createDocProposal({
      address: { bindingId: "D4", repoId: "design-docs", violationKind: "documentation-mismatch" },
      sectionFile: "s3-solution.json",
      jsonPointer: "/decisions/0/text",
      proposedValue: "不应被应用的值",
      reason: "方向争议",
    });
    const headBefore = gitOk(fx.designRepo, ["rev-parse", "HEAD"], "head").trim();
    const cycle = await docProposals.runDocProposalCycle({
      stateRoot: fx.stateRoot, proposal, designRepoRoot: fx.designRepo, sectionRelPath: "docs/pkg/s3-solution.json",
      rulingDirection: "code-right", actor: "main-agent",
    });
    assert.equal(cycle.adopted, false);
    assert.equal(cycle.applied, null, "非 doc-right 不应用");
    assert.equal(cycle.evidence, null);
    const doc = JSON.parse(readFileSync(join(fx.designRepo, "docs/pkg/s3-solution.json"), "utf8"));
    assert.equal(doc.decisions[0].text, "原文：修复 agent 直接写正式仓", "章节 JSON 未变");
    assert.equal(gitOk(fx.designRepo, ["rev-parse", "HEAD"], "head").trim(), headBefore);
    assert.ok(!eventTypes(fx.stateRoot).includes("BacklogAdopted"), "不产生采纳事件");
    const snap = stateRepo.readSnapshot(fx.stateRoot);
    assert.equal(snap.input.bindings[0].bindingVersion, 1, "不升版");
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});
