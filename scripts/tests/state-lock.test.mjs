// state-lock.test.mjs — 状态仓单写者锁与读写行为测试（sync-conformance-plane U1/M1）
//
// 覆盖（守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   - G9 --busy-and-stale-recovery / RL9（设计段四锁策略）：非阻塞互斥（flock 等价原语）、
//     1 秒轮询、30 秒超时返回 state-store-busy 与恢复动作、死亡进程锁清理可恢复、
//     锁元数据 = pid + 启动时间（跨机协作出范围，不记主机 id——设计终态段四权威表述）
//   - 附加（state-repo 读写主链）：命令追加分配 seq / 归档态拒写普通命令、Unarchived 白名单放行
//
// 运行：node --test scripts/tests/state-lock.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane", "kernel");
const repo = await import(join(CP, "state-repo.mjs"));

function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "state-lock-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initInput() {
  return {
    archived: false,
    bindings: [{ bindingId: "GL1", repoId: "repo-a", violationKind: "documentation-mismatch", bindingVersion: 1 }],
    repos: [{ repoId: "repo-a" }],
    checkerRuns: [{ checkerId: "symbol-scan", checkerVersion: "1.0.0" }],
    changesets: [],
    artifacts: {},
  };
}

const rulingCmd = () => ({
  type: "RequestRuling",
  actor: "main-agent",
  payload: { address: { bindingId: "GL1", repoId: "repo-a", violationKind: "documentation-mismatch" }, question: "方向？" },
});

// ---------------------------------------------------------------------------
// 锁默认参数与元数据形态
// ---------------------------------------------------------------------------

test("锁默认参数：1 秒轮询、30 秒超时；锁元数据含 pid 与启动时间、不含主机标识", async (t) => {
  assert.equal(repo.LOCK_DEFAULTS.pollMs, 1000, "设计段四：轮询 1 秒");
  assert.equal(repo.LOCK_DEFAULTS.timeoutMs, 30000, "设计段四：最多 30 秒");
  const root = tmpRoot(t);
  mkdirSync(root, { recursive: true });
  const handle = await repo.acquireLock(root);
  try {
    const meta = JSON.parse(readFileSync(join(root, "lock"), "utf8"));
    assert.equal(meta.pid, process.pid, "锁元数据必须记录持有者 pid");
    assert.ok(meta.startedAt, "锁元数据必须记录持有者进程启动时间");
    assert.ok(!("host" in meta) && !("hostname" in meta), "锁元数据不得记录主机标识（设计终态段四：跨机协作出范围）");
  } finally {
    await handle.release();
  }
  assert.ok(!existsSync(join(root, "lock")), "释放后锁文件必须删除");
});

// ---------------------------------------------------------------------------
// 非阻塞互斥 + 等待成功
// ---------------------------------------------------------------------------

test("非阻塞互斥：持有期间第二次获取立即失败；持有者释放后等待者成功（RL9）", async (t) => {
  const root = tmpRoot(t);
  const first = await repo.acquireLock(root);
  try {
    // 非阻塞形态：等待上限 0 → 立即 busy
    await assert.rejects(
      () => repo.acquireLock(root, { pollMs: 10, timeoutMs: 0 }),
      (err) => err.code === "state-store-busy",
      "持有期间非阻塞获取必须立即返回 state-store-busy",
    );
  } finally {
    await first.release();
  }
  // 释放后可重新获取（互斥不泄漏）
  const second = await repo.acquireLock(root);
  await second.release();
});

test("持锁者释放后，轮询等待中的 appendCommands 成功完成且写入完整（互斥等待链路）", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  const holder = await repo.acquireLock(root);
  const startedAt = Date.now();
  setTimeout(() => holder.release(), 300);
  const res = await repo.appendCommands(root, [rulingCmd()]);
  assert.ok(Date.now() - startedAt >= 250, "等待者必须真实等到锁释放（非绕过互斥）");
  assert.equal(res.appended, 1);
  const events = repo.readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "RulingRequested");
});

// ---------------------------------------------------------------------------
// 超时 state-store-busy 与恢复动作
// ---------------------------------------------------------------------------

test("持锁不释放时等待超限返回 state-store-busy，错误携带恢复动作与锁路径（G9）", async (t) => {
  const root = tmpRoot(t);
  const holder = await repo.acquireLock(root);
  try {
    await assert.rejects(
      () => repo.acquireLock(root, { pollMs: 20, timeoutMs: 120 }),
      (err) => {
        assert.equal(err.code, "state-store-busy", "超时错误码必须是 state-store-busy");
        assert.match(err.message, /state-store-busy/);
        assert.match(err.message, /恢复/, "错误信息必须含恢复动作指引");
        assert.match(err.message, /lock/, "错误信息必须指向锁文件路径（错误、权威源、重试三要素齐全）");
        return true;
      },
    );
  } finally {
    await holder.release();
  }
});

test("appendCommands 走同一锁策略：持锁时追加在短超时下报 state-store-busy", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  const holder = await repo.acquireLock(root);
  try {
    await assert.rejects(
      () => repo.appendCommands(root, [rulingCmd()], { pollMs: 20, timeoutMs: 100 }),
      (err) => err.code === "state-store-busy",
    );
  } finally {
    await holder.release();
  }
});

// ---------------------------------------------------------------------------
// 死亡进程锁清理可恢复
// ---------------------------------------------------------------------------

test("死亡进程遗留锁被清理并可恢复写入（G9 死亡清理）", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  // 造一个真实存在过、现已退出的进程 pid 与其启动时间
  const probe = spawnSync("node", ["-e", "setTimeout(() => {}, 50)"], { encoding: "utf8" });
  const deadPid = probe.pid;
  await new Promise((r) => setTimeout(r, 150)); // 等子进程退出
  const startedAt = repo.processStartTime(deadPid) ?? repo.processStartTime(process.pid);
  writeFileSync(
    join(root, "lock"),
    JSON.stringify({ pid: deadPid, startedAt, acquiredAt: "2026-11-10T09:00:00.000Z" }),
  );
  const res = await repo.appendCommands(root, [rulingCmd()], { pollMs: 50, timeoutMs: 3000 });
  assert.equal(res.appended, 1, "死亡进程锁必须被清理并让等待者成功");
  assert.equal(repo.readEvents(root).length, 1);
});

test("pid 复用防护：活 pid 但启动时间与锁元数据不符时按陈旧锁清理（不误等活进程）", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  writeFileSync(
    join(root, "lock"),
    JSON.stringify({ pid: process.pid, startedAt: "Thu Jan  1 1970 00:00:00 (fake-reused)", acquiredAt: "1970" }),
  );
  const res = await repo.appendCommands(root, [rulingCmd()], { pollMs: 50, timeoutMs: 3000 });
  assert.equal(res.appended, 1, "启动时间不符 = 原持有者已死、pid 被复用，必须清理放行");
});

test("活进程持真实元数据的锁不被误清（死亡判定不误报）", async (t) => {
  const root = tmpRoot(t);
  const holder = await repo.acquireLock(root);
  try {
    // 另一路径短超时等待：因为持有者（本进程）活着且元数据真实，不得清理，只能 busy
    await assert.rejects(
      () => repo.acquireLock(root, { pollMs: 20, timeoutMs: 100 }),
      (err) => err.code === "state-store-busy",
      "活持有者的锁必须保持互斥，不得被死亡清理误删",
    );
    assert.ok(existsSync(join(root, "lock")), "锁文件在 busy 期间不得被删除");
  } finally {
    await holder.release();
  }
});

// ---------------------------------------------------------------------------
// state-repo 主链：seq 分配、schema 校验拒词表外、归档白名单
// ---------------------------------------------------------------------------

test("appendCommands 分配连续 seq、拒绝词表外命令、事实逐条过 schema", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  const r1 = await repo.appendCommands(root, [rulingCmd()]);
  assert.deepEqual(r1.appendedFacts.map((f) => f.seq), [1]);
  const r2 = await repo.appendCommands(root, [
    { type: "RecordRuling", actor: "arbiter", payload: { address: rulingCmd().payload.address, direction: "doc-right", respondsTo: 1 } },
  ]);
  assert.deepEqual(r2.appendedFacts.map((f) => f.seq), [2], "seq 跨调用连续分配");
  await assert.rejects(
    () => repo.appendCommands(root, [{ type: "NoSuchCommand", actor: "x", payload: {} }]),
    /词表|command|COMMAND/i,
    "词表外命令必须在写入前被拒（append-only 权威不被污染）",
  );
});

test("归档态拒写普通命令、放行 Unarchived 且解档后恢复追加（V9 事件层复活语义）", async (t) => {
  const root = tmpRoot(t);
  await repo.initStateRepo(root, initInput());
  const snapPath = join(root, "snapshot.json");
  const snap = JSON.parse(readFileSync(snapPath, "utf8"));
  snap.input.archived = true; // cutover 归档输入（M5 由 cutover 命令写入；M1 直接构造快照）
  writeFileSync(snapPath, JSON.stringify(snap, null, 2));

  await assert.rejects(
    () => repo.appendCommands(root, [rulingCmd()]),
    (err) => err.code === "state-store-archived" && /Unarchived|复活/.test(err.message),
    "归档态必须拒写普通命令并指向复活通道",
  );
  await repo.appendCommands(root, [{ type: "UnarchivePackage", actor: "main-agent", payload: { reason: "重开对账范围" } }]);
  assert.equal(repo.foldState(root).state.archived, false, "Unarchived 事件解档");
  const res = await repo.appendCommands(root, [rulingCmd()]);
  assert.equal(res.appended, 1, "解档后恢复追加");
  assert.equal(repo.readEvents(root).length, 2);
});
