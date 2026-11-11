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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } from "node:fs";
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
// 写入间隙（空锁文件）持有裁决（bl-4）：openSync(wx) 成功到写元数据之间的空文件
// 是合法写入间隙，视为「持有中」——等待者不清理、不抢锁，1s 轮询（测试用注入短轮询）
// 天然覆盖该间隙；清理条件收紧为「元数据在场且 pid 死亡」。
// ---------------------------------------------------------------------------

test("空锁文件是写入间隙：等待者不清理不抢锁，元数据出现（活持有者）后按正常互斥裁决（bl-4）", async (t) => {
  const root = tmpRoot(t);
  const lockPath = join(root, "lock");
  mkdirSync(root, { recursive: true });
  writeFileSync(lockPath, ""); // 手工构造 openSync(wx) 已成功、元数据未写入的间隙形态
  // 等待者轮询：空元数据 = 持有中——不清理、不抢锁、持续等待
  const waiter = repo.acquireLock(root, { pollMs: 20, timeoutMs: 500 });
  let settled = false;
  waiter.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(settled, false, "写入间隙内等待者持续轮询：既不提前 busy 也不抢先获得锁");
  assert.equal(readFileSync(lockPath, "utf8"), "", "等待期间空锁文件不得被等待者清理或重写（非持有者不得动它）");
  // 元数据出现且持有者存活 → 按正常互斥裁决：持续等待直至 busy
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: repo.processStartTime(process.pid), acquiredAt: "2026-11-11T00:00:00.000Z" }));
  await assert.rejects(
    () => waiter,
    (err) => err.code === "state-store-busy",
    "空锁间隙结束后元数据为活持有者 → 正常互斥，等待超时返回 state-store-busy",
  );
  const finalMeta = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(finalMeta.pid, process.pid, "全程等待者的清理通道未触发：锁元数据仍是最初写入者的");
});

test("空锁间隙结束后元数据为死亡持有者 → 等待者按陈旧锁清理并成功获得（bl-4 联动）", async (t) => {
  const root = tmpRoot(t);
  const lockPath = join(root, "lock");
  mkdirSync(root, { recursive: true });
  writeFileSync(lockPath, "");
  // 造一个真实存在过、现已退出的进程 pid 与其启动时间
  const probe = spawnSync("node", ["-e", "setTimeout(() => {}, 50)"], { encoding: "utf8" });
  const deadPid = probe.pid;
  await new Promise((r) => setTimeout(r, 150));
  const waiter = repo.acquireLock(root, { pollMs: 20, timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(readFileSync(lockPath, "utf8"), "", "空锁期间等待者不得清理");
  // 死亡持有者元数据出现 → 下一轮轮询按「元数据在场且 pid 死亡」清理并获锁
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid, startedAt: repo.processStartTime(deadPid) ?? repo.processStartTime(process.pid), acquiredAt: "2026-11-11T00:00:00.000Z" }),
  );
  const handle = await waiter;
  const meta = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(meta.pid, process.pid, "死亡持有者的锁被清理后等待者获得锁");
  await handle.release();
  assert.ok(!existsSync(lockPath), "释放后锁文件删除");
});

// ---------------------------------------------------------------------------
// 空锁年龄裁决（D6 发现 3）：空/残缺元数据锁超龄 = 持有者死于写入间隙，按孤儿清理；
// 未超龄 = 写入间隙持有中，不清理继续轮询。
// ---------------------------------------------------------------------------

test("空锁超龄（mtime 距今超阈值）被按孤儿锁清理，等待者成功获得锁", async (t) => {
  const root = tmpRoot(t);
  const lockPath = join(root, "lock");
  mkdirSync(root, { recursive: true });
  writeFileSync(lockPath, ""); // 空/残缺元数据形态
  // mtime 手工回拨到阈值之外（模拟持有者在写入间隙崩溃后时间流逝）
  const stale = new Date(Date.now() - repo.EMPTY_LOCK_ORPHAN_MS - 5000);
  utimesSync(lockPath, stale, stale);
  const handle = await repo.acquireLock(root, { pollMs: 20, timeoutMs: 2000 });
  const meta = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(meta.pid, process.pid, "超龄空锁被清理后本进程获得锁（元数据为本进程）");
  await handle.release();
  assert.ok(!existsSync(lockPath), "释放后锁文件删除");
});

test("空锁未超龄不清理：视为写入间隙持有中，等待至 busy 且锁文件保持原样", async (t) => {
  const root = tmpRoot(t);
  const lockPath = join(root, "lock");
  mkdirSync(root, { recursive: true });
  writeFileSync(lockPath, ""); // 刚写入的空锁（mtime = now，写入间隙形态）
  await assert.rejects(
    () => repo.acquireLock(root, { pollMs: 20, timeoutMs: 120 }),
    (err) => {
      assert.equal(err.code, "state-store-busy");
      assert.match(err.message, /空|超龄/, "busy 文案须覆盖空锁未超龄分支（持有中等待）");
      return true;
    },
    "未超龄空锁必须按持有中处理（等待超时 busy，不得清理抢锁）",
  );
  assert.equal(readFileSync(lockPath, "utf8"), "", "未超龄空锁不被等待者清理或重写");
  assert.equal(existsSync(lockPath), true, "锁文件仍在（未超龄不触发孤儿清理）");
});

// ---------------------------------------------------------------------------
// 真实跨进程并发（bl-3）：spawn 两个 node 子进程同时 acquireLock 同一锁路径。
// 本机 darwin 实测口径；linux 本机无环境未实测（spawn/acquireLock 语义 POSIX 通用，
// 无平台分支代码，理论可迁移）——沿用任务书 deviation 登记，不做同进程 Promise.all 模拟。
// ---------------------------------------------------------------------------

test("真实跨进程并发：两子进程同时抢同一锁，任一时刻恰一持有（区间不重叠），释放后另一进程获得（bl-3）", async (t) => {
  const root = tmpRoot(t);
  // 子进程脚本落系统临时目录（tmpRoot 在 os.tmpdir 下），通过绝对路径 import kernel
  const childScript = join(root, "lock-racer-child.mjs");
  writeFileSync(
    childScript,
    [
      `import { acquireLock } from ${JSON.stringify(join(CP, "state-repo.mjs"))};`,
      `const root = process.argv[2];`,
      `const holdMs = Number(process.argv[3] ?? 400);`,
      `const handle = await acquireLock(root, { pollMs: 25, timeoutMs: 5000 });`,
      `const acquiredAt = Date.now();`,
      `console.log(JSON.stringify({ event: "acquired", pid: process.pid, acquiredAt }));`,
      `await new Promise((r) => setTimeout(r, holdMs));`,
      `const releasedAt = Date.now();`,
      `handle.release();`,
      `console.log(JSON.stringify({ event: "released", pid: process.pid, releasedAt }));`,
      `process.exit(0);`,
    ].join("\n"),
  );
  const runChild = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [childScript, root, "400"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { out += d; });
      c.on("close", (code) => resolve({ code, out }));
    });
  const [a, b] = await Promise.all([runChild(), runChild()]);
  assert.equal(a.code, 0, `子进程 A 正常退出：${a.out}`);
  assert.equal(b.code, 0, `子进程 B 正常退出：${b.out}`);
  const parseEvents = ({ out }, label) => {
    const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
    assert.equal(lines.length, 2, `${label} 必须产出 acquired + released 两行事件`);
    return lines.map((l) => JSON.parse(l));
  };
  const [acqA, relA] = parseEvents(a, "A");
  const [acqB, relB] = parseEvents(b, "B");
  assert.equal(acqA.event, "acquired");
  assert.equal(acqB.event, "acquired");
  assert.notEqual(acqA.pid, acqB.pid, "两事件来自不同进程（真实跨进程，非同进程模拟）");
  assert.ok(relA.releasedAt >= acqA.acquiredAt && relB.releasedAt >= acqB.acquiredAt, "各自持有区间自洽");
  // 互斥判定（真判据）：后获得者不早于先持有者释放（串行持有，区间不相交）。
  // Date.now() 为毫秒分辨率：同毫秒「释放→获得」两时间戳相等，区间端点相触不算重叠——
  // 重叠判定取严格小于，否则同毫秒交接被误判为并行双持（假红灯）
  const overlap = acqA.acquiredAt < relB.releasedAt && acqB.acquiredAt < relA.releasedAt;
  assert.ok(!overlap, "两个子进程的锁持有区间不得重叠（跨进程互斥）");
  const [first, second] = acqA.acquiredAt <= acqB.acquiredAt ? [acqA, acqB] : [acqB, acqA];
  const firstRel = acqA.acquiredAt <= acqB.acquiredAt ? relA.releasedAt : relB.releasedAt;
  assert.ok(
    second.acquiredAt >= firstRel,
    "后获得者的获得时刻不早于先持有者的释放时刻（串行持有，互斥不泄漏）",
  );
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

// D6 二轮审查 minor：并发清理竞态守卫——removeIfPresent 语义（ENOENT 转 false，其他错误照抛）
test("removeIfPresent：存在则删除返回 true；已消失（并发清理竞态）返回 false 不抛裸 ENOENT；非 ENOENT fs 错误照抛", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lock-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "orphan.lock");
  writeFileSync(target, "");
  assert.equal(repo.removeIfPresent(target), true, "存在 → 删除成功");
  assert.equal(existsSync(target), false);
  assert.equal(repo.removeIfPresent(target), false, "已消失（并发清理竞态）→ false，不抛裸 ENOENT");
  const sub = join(dir, "sub");
  mkdirSync(sub);
  assert.throws(() => repo.removeIfPresent(sub), (e) => e.code !== "ENOENT", "非 ENOENT fs 错误照抛（不吞错）");
});
