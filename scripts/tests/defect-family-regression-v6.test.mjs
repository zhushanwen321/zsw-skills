// defect-family-regression-v6.test.mjs — 缺陷族双场已知答案样例回归
// （《V5 交付完整性与语义可信性改造设计》§9.2 双场已知答案样例 / §13.1 全部纳入回归；
// 机制五 §9.1 最小同族组合的形态模板——样例是测试形态模板，不是具体项目测试）
//
// 双态断言原则：每个样例同时断言「缺陷版被该场景抓住」（对缺陷版为红——抓得住真
// 缺陷的自证）与「修复版同场景绿」；并显式覆盖无区分度的邻近组合（缺陷版在彼组合
// 也绿），说明为何原回归只测彼组合时缺陷漏检。
//
// §9.2 样例归属：
//   1. 多条写入途中关闭   —— 本文件内嵌 fixture（GLM 场：关闭检查只在循环前一次）
//   2. 活跃锁元数据损坏   —— 本文件临时目录 fixture（GLM 场：损坏+活跃放行第二进入者）
//   3. 仓外提交           —— 由 scripts/tests/commit-scope-v6.test.mjs 承载
//                            （相对/绝对/../symlink/不同 cwd 形态已全覆盖，此处不重复，
//                            仅做存在性锚防止登记指向已移除的承载文件）
//   4. 验收失控计数       —— 由 scripts/tests/loop-attempts-v6.test.mjs 承载
//                            （连续打回/校验失败/重发均计入预算，此处仅存在性锚）
//   5. 相关性注入 / 空检测器 / 真实宿主命令 —— golden 任务级样例，随实跑任务建设：
//      三者依赖具体项目的记忆库形态/信号源形态/宿主命令解析规则，机器层无法脱离
//      项目构造非伪实现（设计 §13.1 的回归要求在任务级 golden 中满足）
//
// 运行：node --test scripts/tests/defect-family-regression-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMIT_SCOPE_TEST = join(ROOT, "scripts", "tests", "commit-scope-v6.test.mjs");
const LOOP_ATTEMPTS_TEST = join(ROOT, "scripts", "tests", "loop-attempts-v6.test.mjs");

// ══════════════════ 样例 1：多条写入途中关闭 ══════════════════
// fixture：极简 write-all——逐条写入数组，关闭信号由外部在写入间隙注入（hooks.onAfterWrite）。
// 关闭后写入 = 违反「关闭后零写入」不变量，由场景 harness 的 write 钩子记录为 violation。

/** 缺陷版（GLM 首场形态）：关闭检查只在循环前执行一次——第一条写入后外部关闭，
 * 第二条仍写入。写前已关闭的场景它也能正确拒绝，这正是原回归只测单条/写前组合时
 * 缺陷不暴露的原因（无区分度组合）。 */
function defectiveWriteAll(store, entries, hooks) {
  if (hooks.isClosed()) return;
  entries.forEach((entry, index) => {
    hooks.write(entry);
    hooks.onAfterWrite(index);
  });
}

/** 修复版：每条写前检查 closed 标志——第一条后关闭，第二条不再写入。 */
function fixedWriteAll(store, entries, hooks) {
  entries.forEach((entry, index) => {
    if (hooks.isClosed()) return;
    hooks.write(entry);
    hooks.onAfterWrite(index);
  });
}

/** 场景 harness（回归测试本体形态）：closeAfterWriteOf = 第几条写完后外部关闭（null =
 * 全程不关闭）；initiallyClosed = 写前已关闭。返回违规清单（非空 = 该实现对场景为红）。 */
function runWriteAllCase(writeAllImpl, { entries, closeAfterWriteOf = null, initiallyClosed = false }) {
  const store = { closed: initiallyClosed };
  const violations = [];
  writeAllImpl(store, entries, {
    isClosed: () => store.closed,
    write: (entry) => {
      store.written = store.written ?? [];
      store.written.push(entry);
      if (store.closed) violations.push(`关闭后写入：${entry}`);
    },
    onAfterWrite: (index) => {
      if (closeAfterWriteOf !== null && index === closeAfterWriteOf) store.closed = true;
    },
  });
  return violations;
}

test("样例 1 多条写入途中关闭：两条中第一条后关闭——缺陷版红/修复版绿（区分组合）", () => {
  const scenario = { entries: ["a", "b"], closeAfterWriteOf: 0 };
  const defectiveViolations = runWriteAllCase(defectiveWriteAll, scenario);
  assert.ok(defectiveViolations.length > 0, `缺陷版必须被该场景抓住（第二条在关闭后写入）——实际违规：${JSON.stringify(defectiveViolations)}；为空说明场景失去了区分度，须重检 fixture`);
  assert.deepEqual(runWriteAllCase(fixedWriteAll, scenario), [], "修复版同场景必须绿：第一条后关闭，第二条不得写入");
});

test("样例 1 邻近组合：写前关闭与单条路径——两版行为一致（无区分度，登记漏检原因）", () => {
  assert.deepEqual(
    runWriteAllCase(defectiveWriteAll, { entries: ["a", "b"], initiallyClosed: true }),
    [],
    "写前关闭：缺陷版也正确拒绝（循环前检查覆盖此组合）",
  );
  assert.deepEqual(runWriteAllCase(fixedWriteAll, { entries: ["a", "b"], initiallyClosed: true }), [], "写前关闭：修复版绿");
  assert.deepEqual(runWriteAllCase(defectiveWriteAll, { entries: ["a"] }), [], "单条无关闭：缺陷版也绿——原回归只测此组合故漏检（§2.5：回归只复现原始案例，未按根因改变输入数量）");
  assert.deepEqual(runWriteAllCase(fixedWriteAll, { entries: ["a"] }), [], "单条无关闭：修复版绿");
});

// ══════════════════ 样例 2：活跃锁元数据损坏 ══════════════════
// fixture：锁目录 = owner.json（holderPid）+ heartbeat.json（mtime 承载持有者活性迹象）。
// 正确进入规则：元数据可读且持有者活跃 → 拒绝；可读且死亡 → 接管；损坏/缺失时
// heartbeat 新鲜（活跃迹象）→ 拒绝，陈旧 → 接管。

const LOCK_STALE_MS = 60_000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同步等一个子进程退出并返回其 pid（已死——用作死亡持有者） */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  assert.ok(Number.isInteger(child.pid) && child.pid > 0, "应取得子进程 pid");
  assert.equal(isProcessAlive(child.pid), false, "spawnSync 同步返回后子进程应已退出");
  return child.pid;
}

/** 缺陷版（GLM 首场形态）：owner.json 解析失败（损坏/缺失）直接当无锁放行——
 * 不看 heartbeat 活跃迹象，活跃持有者在场的临界区被第二个进入者闯入。 */
function defectiveTryAcquire(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    return isProcessAlive(owner.holderPid) ? "rejected" : "acquired";
  } catch {
    return "acquired";
  }
}

/** 修复版：元数据不可用时退到 heartbeat 活跃迹象判定——新鲜拒绝、陈旧接管。 */
function fixedTryAcquire(lockDir) {
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    owner = null;
  }
  if (owner !== null) return isProcessAlive(owner.holderPid) ? "rejected" : "acquired";
  const ageMs = Date.now() - statSync(join(lockDir, "heartbeat.json")).mtimeMs;
  return ageMs <= LOCK_STALE_MS ? "rejected" : "acquired";
}

/** 组合构造：metadataState ∈ ok|corrupt|missing × holderActive ∈ true|false。
 * 持有者活跃 = 本测试进程 pid + heartbeat 置为当前时间；死亡 = 已退出子进程 pid +
 * heartbeat 置为陈旧时间。 */
function makeLockDir(t, { metadataState, holderActive }) {
  const lockDir = mkdtempSync(join(tmpdir(), "defect-family-lock-"));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  mkdirSync(lockDir, { recursive: true });
  const holderPid = holderActive ? process.pid : deadPid();
  const heartbeatTime = holderActive ? new Date() : new Date(Date.now() - 10 * LOCK_STALE_MS);
  if (metadataState === "ok") writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ holderPid }));
  if (metadataState === "corrupt") writeFileSync(join(lockDir, "owner.json"), '{"holderPid": 12');
  writeFileSync(join(lockDir, "heartbeat.json"), "{}");
  utimesSync(join(lockDir, "heartbeat.json"), heartbeatTime, heartbeatTime);
  return lockDir;
}

test("样例 2 活跃锁元数据损坏：活跃+损坏/缺失——缺陷版放行（红）/修复版拒绝（绿）", (t) => {
  for (const metadataState of ["corrupt", "missing"]) {
    const scenario = { metadataState, holderActive: true };
    const defectiveDir = makeLockDir(t, scenario);
    assert.equal(defectiveTryAcquire(defectiveDir), "acquired", `${metadataState}+持有者活跃：缺陷版放行了第二个进入者——该组合的回归测试对缺陷版为红（抓住真缺陷）`);
    const fixedDir = makeLockDir(t, scenario);
    assert.equal(fixedTryAcquire(fixedDir), "rejected", `${metadataState}+持有者活跃：修复版拒绝——同组合对修复版为绿`);
  }
});

test("样例 2 组合矩阵其余格：正常元数据行为一致 + 死亡持有者可接管（修复不矫枉过正）", (t) => {
  for (const impl of [defectiveTryAcquire, fixedTryAcquire]) {
    const okActiveDir = makeLockDir(t, { metadataState: "ok", holderActive: true });
    assert.equal(impl(okActiveDir), "rejected", "正常元数据+活跃：两版一致拒绝（无区分度组合，行为基线）");
    const okDeadDir = makeLockDir(t, { metadataState: "ok", holderActive: false });
    assert.equal(impl(okDeadDir), "acquired", "正常元数据+死亡：两版一致接管");
  }
  for (const metadataState of ["corrupt", "missing"]) {
    const deadDir = makeLockDir(t, { metadataState, holderActive: false });
    assert.equal(fixedTryAcquire(deadDir), "acquired", `${metadataState}+死亡（heartbeat 陈旧）：修复版接管——活性判定不许矫枉过正成永久拒绝`);
  }
});

// ══════════════════ 样例归属登记锚（§9.2 其余样例） ══════════════════

test("样例归属登记：仓外提交与验收失控由既有测试承载（存在性锚），其余为 golden 任务级", () => {
  assert.ok(existsSync(COMMIT_SCOPE_TEST), "仓外提交样例由 commit-scope-v6.test.mjs 承载（相对/绝对/../symlink/cwd 形态）——文件移除或改名须同步更新本登记");
  assert.ok(existsSync(LOOP_ATTEMPTS_TEST), "验收失控计数样例由 loop-attempts-v6.test.mjs 承载（打回/校验失败/重发均计入预算）——文件移除或改名须同步更新本登记");
});
