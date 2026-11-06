// migrate-skill-data.test.mjs — 存量迁移脚本（设计 D4 / 实施单元 U6）独立局部测试
//
// 覆盖（对应实现：scripts/migrate-skill-data.mjs；检测算法复用
// workflows/src/skill-data.shared.ts 的 NODE_PROJECT_ADDRESS 探针）：
//   1. 单仓目录零触碰：--check 与 --apply 都不移动文件（AX5），目录内容与 mtime 不变
//   2. workspace 目录文件级归位：设计包（含无 projectRoot 的伴生文件）与 dev-flow
//      运行产物归位到 <ws-slug>/（dev-flow 追加 worktreeName 段）；已删除 worktree
//      由父目录的同仓 worktree 检出后归位；实迁后二次 --check 零可迁移（幂等）；
//      实迁生成反向对照表
//   3. 混源目录拆分：同一旧 slug 目录内两个 worktree 的产物拆到各自目标
//   4. 同名冲突：两源归位同一目标路径时不覆盖、不改名，全部进待人工指派；
//      目标已存在时同样不覆盖
//   5. 零 projectRoot：进待人工指派；建议档按 basename 家族列出全部候选工作区及证据
//   6. 双信号活动检测：待迁移目录内文件 mtime 落入窗口、或观测 JSONL 近期写入，
//      --apply 一律拒绝（退出码 2、零移动）；--check 仍报可迁移项（补迁前属预期）
//
// fixture 自建、用完即删；被测行为是迁移脚本对临时目录的读写，不触碰真实 skill-data。
// 运行：node scripts/tests/migrate-skill-data.test.mjs（或 node --test ...）

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "migrate-skill-data.mjs");
const OLD_MTIME = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

// ── 基础工具 ────────────────────────────────────────────────────────────────

function gitIn(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `fixture 构造 git ${args.join(" ")} 应成功：${r.stderr}`);
  return r.stdout;
}

function makePlainRepo(parent) {
  gitIn(["init", "repo"], parent);
  const repo = join(parent, "repo");
  gitIn(["config", "user.email", "fixture@example.invalid"], repo);
  gitIn(["config", "user.name", "fixture"], repo);
  gitIn(["commit", "--allow-empty", "-m", "init"], repo);
  return repo;
}

/** workspace fixture：.bare 裸仓 + main / dev 两个兄弟 worktree（与 D1 兄弟计数同形） */
function makeWorkspace(prefix) {
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), `migrate-skill-data-${prefix}-`)));
  const seed = realpathSync(mkdtempSync(join(tmpdir(), `migrate-skill-data-${prefix}-seed-`)));
  gitIn(["clone", "--bare", makePlainRepo(seed), join(wsRoot, ".bare")]);
  const bare = join(wsRoot, ".bare");
  gitIn(["worktree", "add", "../main"], bare);
  gitIn(["worktree", "add", "../dev", "-b", "dev"], bare);
  return { wsRoot, seed, main: join(wsRoot, "main"), dev: join(wsRoot, "dev"), bare };
}

/** 旧布局 slug（单仓算法原样）：仅用于构造存量目录名，不参与被测逻辑 */
function legacySlugOf(dir) {
  const real = realpathSync(dir);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${basename(real)}-${hash}`;
}

function makeSkillRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `migrate-skill-data-${prefix}-root-`)));
}

function makeTemp(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `migrate-skill-data-${prefix}-`)));
}

function writeArtifact(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  utimesSync(abs, OLD_MTIME, OLD_MTIME); // 默认视为历史产物，避免活动检测误拦
  return abs;
}

function setOld(abs) {
  utimesSync(abs, OLD_MTIME, OLD_MTIME);
}

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

function runCheck(skillRoot, report, obsRoot) {
  const r = runScript([
    "--check",
    "--skill-data-root",
    skillRoot,
    "--observability-root",
    obsRoot,
    "--report",
    report,
  ]);
  assert.equal(r.status, 0, `--check 应零退出：${r.stderr}`);
  return { stdout: r.stdout, machine: readMachine(report) };
}

function runApply(skillRoot, report, obsRoot) {
  return runScript([
    "--apply",
    "--skill-data-root",
    skillRoot,
    "--observability-root",
    obsRoot,
    "--report",
    report,
  ]);
}

function readMachine(report) {
  return JSON.parse(readFileSync(report.replace(/\.md$/i, "") + ".json", "utf8"));
}

/** 目录树快照（相对路径 → 大小与 mtime），用于断言「零触碰」 */
function snapshotTree(root) {
  const out = {};
  const stack = [["", root]];
  while (stack.length > 0) {
    const [rel, dir] = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) stack.push([childRel, abs]);
      else out[childRel] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return out;
}

function destAbs(skillRoot, relFromSkillRoot) {
  return join(skillRoot, relFromSkillRoot);
}

// ── 1. 单仓目录零触碰 ──────────────────────────────────────────────────────

test("单仓目录零触碰：--check 与 --apply 都不移动文件、mtime 不变", () => {
  const parent = makeTemp("single-repo-parent");
  const skillRoot = makeSkillRoot("single");
  const obsRoot = makeTemp("single-obs");
  const reportDir = makeTemp("single-report");
  const report = join(reportDir, "report.md");
  try {
    const repo = makePlainRepo(parent);
    const slug = legacySlugOf(repo);
    writeArtifact(skillRoot, `tech-design/${slug}/pkg/run.json`, JSON.stringify({ projectRoot: repo }));
    writeArtifact(skillRoot, `tech-design/${slug}/pkg/design.md`, "# 设计");
    writeArtifact(skillRoot, `dev-flow/${slug}/foo.exec-plan.json`, JSON.stringify({ version: 1, projectRoot: repo }));
    writeArtifact(skillRoot, `dev-flow/${slug}/foo.ledger.md`, "ledger");

    const before = snapshotTree(skillRoot);
    const { machine } = runCheck(skillRoot, report, obsRoot);
    assert.equal(machine.counts.auto, 0, "单仓产物目标即当前位置，不应有自动归位项");
    assert.equal(machine.counts.manual, 0, "单仓目录不应有待人工指派项");
    assert.equal(machine.counts.singleInPlace, 4, "四个单仓产物应全部为终态零移动");
    assert.deepEqual(snapshotTree(skillRoot), before, "--check 不得改动磁盘");
    assert.ok(machine.directories.every((d) => d.auto === 0 && d.manual === 0), "单仓目录的统计应全为零移动");

    const applied = runApply(skillRoot, report, obsRoot);
    assert.equal(applied.status, 0, `--apply 应零退出：${applied.stderr}`);
    assert.deepEqual(snapshotTree(skillRoot), before, "单仓目录零触碰：实迁不得移动或改写任何文件");
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

// ── 2. workspace 文件级归位 + 已删除 worktree + 幂等 ────────────────────────

test("workspace 归位：伴生文件按结构锚归属、已删除 worktree 由父目录检出、二次 --check 零可迁移", () => {
  const ws = makeWorkspace("ws");
  const skillRoot = makeSkillRoot("ws");
  const obsRoot = makeTemp("ws-obs");
  const reportDir = makeTemp("ws-report");
  const report = join(reportDir, "report.md");
  try {
    const wsSlug = legacySlugOf(ws.wsRoot); // ws-slug 与展开前单仓 slug 同公式
    const mainSlug = legacySlugOf(ws.main);
    const devSlug = legacySlugOf(ws.dev);
    writeArtifact(skillRoot, `tech-design/${mainSlug}/pkg/run.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `tech-design/${mainSlug}/pkg/design.md`, "设计正文");
    writeArtifact(skillRoot, `tech-design/${mainSlug}/pkg.impl-plan.json`, "{}"); // 无 projectRoot，靠子目录锚
    writeArtifact(skillRoot, `dev-flow/${mainSlug}/foo.exec-plan.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `dev-flow/${mainSlug}/foo.ledger.md`, "ledger");
    writeArtifact(skillRoot, `dev-flow/${mainSlug}/foo.runlog/u1.md`, "runlog");
    writeArtifact(skillRoot, `dev-flow/${devSlug}/bar.exec-plan.json`, JSON.stringify({ projectRoot: ws.dev }));
    writeArtifact(skillRoot, `dev-flow/${devSlug}/bar.ledger.md`, "ledger");

    gitIn(["worktree", "remove", "--force", ws.dev], ws.bare); // 制造「worktree 已删除」

    const { machine, stdout } = runCheck(skillRoot, report, obsRoot);
    assert.equal(machine.counts.auto, 8, `八个文件应全部自动归位，实际 ${JSON.stringify(machine.counts)}`);
    assert.equal(machine.counts.manual, 0);
    const byFrom = new Map(machine.auto.map((a) => [a.fromRel, a]));
    assert.equal(
      byFrom.get(`tech-design/${mainSlug}/pkg/run.json`).toRel,
      `tech-design/${wsSlug}/pkg/run.json`,
      "tech-design 段应归位到工作区级共享目录",
    );
    assert.equal(
      byFrom.get(`tech-design/${mainSlug}/pkg.impl-plan.json`).toRel,
      `tech-design/${wsSlug}/pkg.impl-plan.json`,
      "无 projectRoot 的伴生文件应由同名字目录锚归属",
    );
    assert.equal(
      byFrom.get(`dev-flow/${mainSlug}/foo.runlog/u1.md`).toRel,
      `dev-flow/${wsSlug}/main/foo.runlog/u1.md`,
      "dev-flow 段应追加 worktreeName 段",
    );
    assert.equal(
      byFrom.get(`dev-flow/${devSlug}/bar.exec-plan.json`).toRel,
      `dev-flow/${wsSlug}/dev/bar.exec-plan.json`,
      "已删除 worktree 应由父目录同仓 worktree 检出后归位",
    );
    for (const section of ["## 1. 自动归位", "## 2. 建议档", "## 3. 待人工指派", "## 5. 活动检测"]) {
      assert.ok(stdout.includes(section), `stdout 报告应含三分结构与活动检测节：${section}`);
    }

    const applied = runApply(skillRoot, report, obsRoot);
    assert.equal(applied.status, 0, `--apply 应零退出：${applied.stderr}`);
    for (const rel of [
      `tech-design/${wsSlug}/pkg/run.json`,
      `tech-design/${wsSlug}/pkg.impl-plan.json`,
      `dev-flow/${wsSlug}/main/foo.runlog/u1.md`,
      `dev-flow/${wsSlug}/dev/bar.exec-plan.json`,
    ]) {
      assert.ok(existsSync(destAbs(skillRoot, rel)), `目标文件应存在：${rel}`);
    }
    assert.ok(!existsSync(join(skillRoot, "dev-flow", mainSlug)), "源目录文件迁空后应删除");
    assert.ok(!existsSync(join(skillRoot, "dev-flow", devSlug)), "已删除 worktree 的源目录应清理");
    const reverse = JSON.parse(readFileSync(join(reportDir, "migration-reverse-map.json"), "utf8"));
    assert.equal(reverse.moves.length, 8, "反向对照表应登记全部移动文件");
    assert.ok(
      reverse.moves.some((m) => m.to.endsWith(`dev-flow/${wsSlug}/dev/bar.exec-plan.json`) && m.from.includes(devSlug)),
      "反向对照表应可回溯源路径",
    );

    const second = readMachine(report);
    const afterCheck = runCheck(skillRoot, report, obsRoot);
    assert.equal(afterCheck.machine.counts.auto, 0, "实迁后二次 --check 应零可迁移（幂等）");
    assert.equal(afterCheck.machine.counts.manual, 0, "实迁后不应残留待人工指派项");
    assert.equal(second.applyResult.moved, 8, "机读报告应记录实迁移动数");
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(ws.wsRoot, { recursive: true, force: true });
    rmSync(ws.seed, { recursive: true, force: true });
  }
});

// ── 3. 混源目录拆分 ────────────────────────────────────────────────────────

test("混源目录：同一旧 slug 目录内两个 worktree 的产物拆到各自目标", () => {
  const ws = makeWorkspace("mixed");
  const skillRoot = makeSkillRoot("mixed");
  const obsRoot = makeTemp("mixed-obs");
  const reportDir = makeTemp("mixed-report");
  const report = join(reportDir, "report.md");
  try {
    const wsSlug = legacySlugOf(ws.wsRoot);
    const oldSlug = legacySlugOf(ws.main);
    writeArtifact(skillRoot, `tech-design/${oldSlug}/pkgA/run.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `tech-design/${oldSlug}/pkgB/run.json`, JSON.stringify({ projectRoot: ws.dev }));
    writeArtifact(skillRoot, `tech-design/${oldSlug}/pkgA.md`, "A");
    writeArtifact(skillRoot, `tech-design/${oldSlug}/pkgB.md`, "B");
    writeArtifact(skillRoot, `dev-flow/${oldSlug}/pkgA.exec-plan.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `dev-flow/${oldSlug}/pkgB.exec-plan.json`, JSON.stringify({ projectRoot: ws.dev }));
    writeArtifact(skillRoot, `dev-flow/${oldSlug}/pkgA.ledger.md`, "A");
    writeArtifact(skillRoot, `dev-flow/${oldSlug}/pkgB.ledger.md`, "B");

    const { machine } = runCheck(skillRoot, report, obsRoot);
    assert.equal(machine.counts.auto, 8);
    const targets = new Set(machine.auto.map((a) => a.toRel));
    assert.ok(targets.has(`dev-flow/${wsSlug}/main/pkgA.exec-plan.json`), "pkgA 应归 main 的 worktree 目录");
    assert.ok(targets.has(`dev-flow/${wsSlug}/dev/pkgB.exec-plan.json`), "pkgB 应归 dev 的 worktree 目录");
    assert.ok(targets.has(`tech-design/${wsSlug}/pkgA/run.json`), "tech-design 段 pkgA 归工作区级目录");
    assert.ok(targets.has(`tech-design/${wsSlug}/pkgB/run.json`), "tech-design 段 pkgB 归同一工作区目录的不同设计包");
    const dirRow = machine.directories.find(
      (d) => d.segment === "dev-flow" && d.slugDir === oldSlug,
    );
    assert.equal(dirRow.targets.length, 2, "混源目录应产生两个目标根（文件级拆分）");
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(ws.wsRoot, { recursive: true, force: true });
    rmSync(ws.seed, { recursive: true, force: true });
  }
});

// ── 4. 同名冲突零覆盖 ──────────────────────────────────────────────────────

test("同名冲突：两源同目标不覆盖、不改名，进待人工指派；目标已存在时同样不动", () => {
  const ws = makeWorkspace("dup");
  const skillRoot = makeSkillRoot("dup");
  const obsRoot = makeTemp("dup-obs");
  const reportDir = makeTemp("dup-report");
  const report = join(reportDir, "report.md");
  try {
    const wsSlug = legacySlugOf(ws.wsRoot);
    const slugA = "dup-aaaaaaaa";
    const slugB = "dup-bbbbbbbb";
    writeArtifact(skillRoot, `dev-flow/${slugA}/same.exec-plan.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `dev-flow/${slugB}/same.exec-plan.json`, JSON.stringify({ projectRoot: ws.main }));
    writeArtifact(skillRoot, `dev-flow/${slugA}/same.ledger.md`, "A");
    writeArtifact(skillRoot, `dev-flow/${slugB}/same.ledger.md`, "B");
    // 目标位置已有一份内容不同的文件：同样必须留在待人工指派
    const preexisting = join(skillRoot, `dev-flow/${wsSlug}/main/existing.exec-plan.json`);
    mkdirSync(dirname(preexisting), { recursive: true });
    writeFileSync(preexisting, "ORIGINAL", "utf8");
    setOld(preexisting);
    // 同目录放一份带 projectRoot 的锚文件，使目标侧已有文件本身是终态零移动
    const anchor = join(skillRoot, `dev-flow/${wsSlug}/main/run.json`);
    writeFileSync(anchor, JSON.stringify({ projectRoot: ws.main }), "utf8");
    setOld(anchor);
    writeArtifact(skillRoot, `dev-flow/${slugA}/existing.exec-plan.json`, JSON.stringify({ projectRoot: ws.main }));

    const { machine } = runCheck(skillRoot, report, obsRoot);
    assert.equal(machine.counts.manual, 5, "两侧同名文件与目标已存在项都应进待人工指派");
    assert.equal(machine.counts.conflicts, 5, "冲突登记按源文件计：同目标两侧各一条 + 目标已存在一条");
    assert.ok(
      machine.manual.every((m) => m.reason === "same-name-conflict"),
      "冲突项原因应标记为同名冲突",
    );

    const applied = runApply(skillRoot, report, obsRoot);
    assert.equal(applied.status, 0, `--apply 应零退出：${applied.stderr}`);
    assert.equal(readFileSync(preexisting, "utf8"), "ORIGINAL", "已存在的目标文件不得被覆盖");
    assert.ok(existsSync(join(skillRoot, `dev-flow/${slugA}/same.exec-plan.json`)), "冲突源文件应原地保留");
    assert.ok(existsSync(join(skillRoot, `dev-flow/${slugB}/same.ledger.md`)), "冲突源文件应原地保留");
    assert.ok(
      !existsSync(join(skillRoot, `dev-flow/${wsSlug}/main/same.exec-plan.json`)),
      "同名冲突不得在目标侧创建文件",
    );
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(ws.wsRoot, { recursive: true, force: true });
    rmSync(ws.seed, { recursive: true, force: true });
  }
});

// ── 5. 零 projectRoot → 建议档候选 ─────────────────────────────────────────

test("零 projectRoot：进待人工指派，建议档按 basename 家族列出全部候选工作区", () => {
  const ws1 = makeWorkspace("cand1");
  const ws2 = makeWorkspace("cand2");
  const skillRoot = makeSkillRoot("cand");
  const obsRoot = makeTemp("cand-obs");
  const reportDir = makeTemp("cand-report");
  const report = join(reportDir, "report.md");
  try {
    // 两处 projectRoot 证据让两个工作区进入发现集合
    writeArtifact(skillRoot, "dev-flow/evidence-11111111/x.exec-plan.json", JSON.stringify({ projectRoot: ws1.main }));
    writeArtifact(skillRoot, "dev-flow/evidence-22222222/y.exec-plan.json", JSON.stringify({ projectRoot: ws2.main }));
    // 零 projectRoot 的 slug 目录（名字是 main-* 家族）
    writeArtifact(skillRoot, "tech-design/main-33333333/foo.md", "无 projectRoot");
    writeArtifact(skillRoot, "tech-design/main-33333333/foo.impl-plan.json", "{}");

    const { machine } = runCheck(skillRoot, report, obsRoot);
    const manual = machine.manual.filter((m) => m.path.startsWith("tech-design/main-33333333/"));
    assert.equal(manual.length, 2, "零 projectRoot 文件应全部进待人工指派");
    assert.ok(manual.every((m) => m.reason === "no-project-root"));
    const suggestion = machine.suggestions.find(
      (s) => s.segment === "tech-design" && s.slugDir === "main-33333333",
    );
    assert.ok(suggestion, "建议档应包含该家族项");
    assert.equal(suggestion.familyKey, "main");
    assert.equal(suggestion.candidates.length, 2, "应列出全部候选工作区（两个工作区各有 main）");
    const roots = suggestion.candidates.map((c) => realpathSync(c.workspaceRoot)).sort();
    assert.deepEqual(roots, [realpathSync(ws1.wsRoot), realpathSync(ws2.wsRoot)].sort());
    for (const c of suggestion.candidates) {
      assert.match(c.evidence, /同名 worktree：main\//, "每个候选都应有证据");
    }
    // 自动归位的证据文件本身仍按 projectRoot 归位
    assert.equal(machine.counts.auto, 2);
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    for (const ws of [ws1, ws2]) {
      rmSync(ws.wsRoot, { recursive: true, force: true });
      rmSync(ws.seed, { recursive: true, force: true });
    }
  }
});

// ── 6. 双信号活动检测 ──────────────────────────────────────────────────────

test("活动检测：目录近期写入与观测 JSONL 近期写入都拒绝实迁，--check 仍报可迁移项", () => {
  const ws = makeWorkspace("active");
  const skillRoot = makeSkillRoot("active");
  const obsRoot = makeTemp("active-obs");
  const reportDir = makeTemp("active-report");
  const report = join(reportDir, "report.md");
  try {
    const oldSlug = legacySlugOf(ws.main);
    const execPlan = writeArtifact(
      skillRoot,
      `dev-flow/${oldSlug}/foo.exec-plan.json`,
      JSON.stringify({ projectRoot: ws.main }),
    );
    const ledger = writeArtifact(skillRoot, `dev-flow/${oldSlug}/foo.ledger.md`, "ledger");
    // 信号一：待迁移目录内文件 mtime 在窗口内
    const now = new Date();
    utimesSync(execPlan, now, now);
    utimesSync(ledger, now, now);
    const blocked = runApply(skillRoot, report, obsRoot);
    assert.equal(blocked.status, 2, `近期写入应拒绝实迁：${blocked.stderr}`);
    assert.ok(blocked.stderr.includes("实迁被拒绝"), "拒绝信息应说明原因与恢复动作");
    assert.ok(existsSync(execPlan), "拒绝实迁时源文件不得移动");
    const blockedMachine = readMachine(report);
    assert.equal(blockedMachine.activity.blocking, true);
    assert.ok(blockedMachine.counts.auto > 0, "拒迁项在补迁前仍应报可迁移（属预期）");

    // 信号二：全部产物改为历史 mtime，观测 JSONL 近期写入仍拒绝
    setOld(execPlan);
    setOld(ledger);
    mkdirSync(join(obsRoot, "task-x"), { recursive: true });
    writeFileSync(join(obsRoot, "task-x", "D1-live.jsonl"), "{}\n", "utf8");
    const blockedByObs = runApply(skillRoot, report, obsRoot);
    assert.equal(blockedByObs.status, 2, "观测 JSONL 近期写入应拒绝实迁");
    assert.equal(readMachine(report).activity.observabilityHits.length, 1);
    assert.ok(existsSync(execPlan), "观测信号命中时源文件不得移动");

    // --check 不受阻断影响：只读报告，仍列出可迁移项
    const { machine } = runCheck(skillRoot, report, obsRoot);
    assert.equal(machine.activity.blocking, true);
    assert.equal(machine.counts.auto, 2, "干跑应继续输出可迁移项，供补迁判断");
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
    rmSync(obsRoot, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(ws.wsRoot, { recursive: true, force: true });
    rmSync(ws.seed, { recursive: true, force: true });
  }
});
