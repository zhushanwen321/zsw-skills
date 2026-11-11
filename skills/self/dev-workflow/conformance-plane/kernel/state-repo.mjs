// state-repo.mjs — 状态仓读写：append-only JSONL + 快照 + 单写者锁（sync-conformance-plane U1/M1）
//
// 语义权威（设计 sync-conformance-plane）：
//   AX3/D2  事件 JSONL 与快照唯一权威；当前状态由纯函数 fold 重建（本文件是 IO 适配器，
//           领域核不依赖本文件的锁实现与文件系统细节——适配器分离约束）
//   段四    写入用本地仲裁锁：非阻塞 flock、轮询 1 秒、最多 30 秒；锁元数据含 pid 与启动时间
//           （跨机协作出范围，不记主机 id）；进程死亡可清理；超时返回 state-store-busy 与恢复动作
//   段七    归档态是派生谓词：归档（cutover 输入）拒写普通命令，Unarchived（复活通道）白名单放行并解档
//   红灯    单仓事件 JSONL 超 50 MB 或事件条数超 10 万（facts.RED_LINE_THRESHOLDS，D2）——追加时探针
//
// flock 等价实现说明：Node 无 flock 绑定，锁原语 = `open(lockPath, "wx")` 原子独占创建
// （非阻塞语义等价：占用即失败、不等待），配合 1s 轮询 / 30s 超时 / 死亡清理达成设计段四完整锁策略。

import { openSync, closeSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { commandToFact, validateCommand, checkRedLineThresholds } from "./facts.mjs";
import { fold, findOrphanEvidence } from "./state-fold.mjs";

const EVENTS_FILE = "events.jsonl";
const SNAPSHOT_FILE = "snapshot.json";
const LOCK_FILE = "lock";

/** 锁默认参数（设计段四口径；测试以注入参数覆盖行为、以本常量断言默认值） */
export const LOCK_DEFAULTS = Object.freeze({ pollMs: 1000, timeoutMs: 30000 });

/**
 * 空/残缺元数据锁的孤儿判定阈值：写入间隙（openSync(wx) 成功到 writeFileSync 写元数据）为
 * 毫秒级，1s 轮询天然跨过；空锁文件超过该时长仍无元数据 = 持有者在写入间隙崩溃（进程死亡
 * 不再有机会补写元数据），按孤儿锁清理。
 */
export const EMPTY_LOCK_ORPHAN_MS = 10_000;

// ---------------------------------------------------------------------------
// 错误形态：每条错误必须同时携带事实、权威源指向与恢复动作
// ---------------------------------------------------------------------------

/** 锁文件 mtime（不存在返回 0——调用方以超龄分支语义裁决，空锁超龄必然存在过） */
function lockMtimeMs(lockPath) {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** 存在即删除；不存在（并发清理竞态）返回 false，调用方转轮询而非抛裸 ENOENT。导出仅供单测 */
export function removeIfPresent(lockPath) {
  try {
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function busyError(root, waitedMs) {
  const err = new Error(
    `state-store-busy：状态仓锁等待超时（等了 ${waitedMs}ms）。` +
      `权威源：${join(root, LOCK_FILE)} 的持有者。` +
      `恢复动作：残留锁已自动清理两类——元数据在场且持有进程死亡（pid 不存在或启动时间不符）、` +
      `空/残缺元数据锁超龄（>${EMPTY_LOCK_ORPHAN_MS}ms，持有者死于写入间隙）；` +
      `其余形态（活进程持锁、空锁未超龄）属持有中，等待其释放；` +
      `确认持有者已消失但锁仍残留时，人工删除锁文件 ${join(root, LOCK_FILE)} 后重发。`,
  );
  err.code = "state-store-busy";
  return err;
}

function archivedError(root) {
  const err = new Error(
    `状态仓处于归档态，拒绝追加普通事件。` +
      `权威源：快照 input.archived（cutover 归档标记）。` +
      `恢复动作：该包走 v2 复活通道——先追加 UnarchivePackage 命令解档，再恢复对账；旧引擎入口保持拒启。`,
  );
  err.code = "state-store-archived";
  return err;
}

// ---------------------------------------------------------------------------
// 进程启动时间（锁元数据第二要素：pid 复用防护）
// ---------------------------------------------------------------------------

let selfStartTime = null;

/** 进程启动时间字符串（darwin/linux 共通 ps 口径）；进程已死返回 null */
export function processStartTime(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").trim();
  return line.length > 0 ? line : null;
}

function getSelfStartTime() {
  if (selfStartTime === null) selfStartTime = processStartTime(process.pid) ?? "unknown";
  return selfStartTime;
}

/** 持有者是否仍活着：pid 存活且启动时间与锁元数据一致（不一致 = pid 已被复用，原持有者已死） */
function holderAlive(meta) {
  const current = processStartTime(meta.pid);
  return current !== null && current === meta.startedAt;
}

// ---------------------------------------------------------------------------
// 锁（非阻塞互斥 + 轮询 + 超时 + 死亡清理）
// ---------------------------------------------------------------------------

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取单写者锁。opts = { pollMs, timeoutMs }（缺省 LOCK_DEFAULTS）。
 * 返回 { release() }；非阻塞失败立即抛 state-store-busy（timeoutMs=0），等待超限同抛。
 *
 * 已知限制（TOCTOU，登记不修——D6 审查发现 3 问题二，移交后续裁决）：判死到 unlink 之间存在
 * 竞争窗口——原持有者恰在此间隙释放、新持有者以 wx 接入时，本次 unlink 会误删新锁。触发条件 =
 * 「陈旧锁清理判定」与「unlink 执行」之间发生「原持有者释放 + 新持有者获取」的完整序列；
 * 概率极低（要求死亡持有者的锁与新获取在毫秒级窗口内交接），当前接受。
 */
export async function acquireLock(root, opts = {}) {
  const pollMs = opts.pollMs ?? LOCK_DEFAULTS.pollMs;
  const timeoutMs = opts.timeoutMs ?? LOCK_DEFAULTS.timeoutMs;
  const lockPath = join(root, LOCK_FILE);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      // 非阻塞互斥原语：wx = 已存在即失败，不等待（flock LOCK_EX|LOCK_NB 等价）
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 锁被占用：持有裁决与死亡清理（设计段四「进程死亡可清理」）。
      // 元数据在场：清理条件 = 持有者死亡（pid 不存在或启动时间不符 = pid 复用）。
      // 空/残缺元数据（bl-4 + D6 发现 3）：写入间隙为毫秒级（openSync(wx) 成功到
      // writeFileSync 写元数据之间），1s 轮询天然覆盖；空锁超过 EMPTY_LOCK_ORPHAN_MS
      // 仍无元数据 = 持有者死于写入间隙（不会再补写），按孤儿锁清理；未超龄视为持有中
      // 继续轮询（不清理、不抢锁）。
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        meta = null; // 空锁文件 / 残缺 JSON：写入间隙或孤儿形态，按年龄裁决
      }
      if (meta === null) {
        if (Date.now() - lockMtimeMs(lockPath) > EMPTY_LOCK_ORPHAN_MS) {
          // 空锁超龄：持有者已在写入间隙崩溃，孤儿锁清理后立即重试获取。
          // ENOENT = 并发等待者已抢先清理同一孤儿锁——转常规轮询重试，不抛裸 fs 错误
          //（D6 二轮审查 minor：错误契约要求带恢复动作，不走裸传播）
          if (!removeIfPresent(lockPath)) {
            if (Date.now() >= deadline) throw busyError(root, timeoutMs);
            await sleep(pollMs);
          }
          continue;
        }
        if (Date.now() >= deadline) throw busyError(root, timeoutMs);
        await sleep(pollMs);
        continue;
      }
      if (holderAlive(meta)) {
        if (Date.now() >= deadline) throw busyError(root, timeoutMs);
        await sleep(pollMs);
        continue;
      }
      // 元数据在场且持有者死亡 → 清理陈旧锁后立即重试获取（ENOENT 同上：并发清理竞态转轮询）
      if (!removeIfPresent(lockPath)) {
        if (Date.now() >= deadline) throw busyError(root, timeoutMs);
        await sleep(pollMs);
      }
      continue;
    }
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: getSelfStartTime(), acquiredAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return {
      release() {
        try {
          const meta = JSON.parse(readFileSync(lockPath, "utf8"));
          // 只释放自己的锁：元数据不匹配（已被清理重建）时不误删他人锁
          if (meta.pid === process.pid && meta.startedAt === getSelfStartTime()) unlinkSync(lockPath);
        } catch {
          /* 锁文件已不在 = 已释放 */
        }
      },
    };
  }
}

/** withLock(root, fn)：锁内执行异步 fn，结束（含抛错）释放 */
export async function withLock(root, fn, opts) {
  const handle = await acquireLock(root, opts);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

// ---------------------------------------------------------------------------
// 事件与快照 IO
// ---------------------------------------------------------------------------

/** 读事件流；容忍崩溃残留的尾部残行（append-only 权威的读侧防御，RL「事件序列无空洞」） */
export function readEvents(root) {
  const p = join(root, EVENTS_FILE);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const events = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      if (i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1].trim() === "")) {
        break; // 尾部残行：进程在写入中途崩溃的痕迹，丢弃（下次追加前由 compactTail 修复）
      }
      throw e;
    }
  }
  return events;
}

/** 读快照（未初始化返回 null） */
export function readSnapshot(root) {
  const p = join(root, SNAPSHOT_FILE);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function writeSnapshot(root, snapshot) {
  writeFileSync(join(root, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}

/** 状态仓初始化：登记静态输入（义务绑定集 / repo 清单 / checker 登记 / 变更集登记 / artifact 哈希表） */
export function initStateRepo(root, input) {
  mkdirSync(root, { recursive: true });
  if (existsSync(join(root, EVENTS_FILE)) || existsSync(join(root, SNAPSHOT_FILE))) {
    const err = new Error(`状态仓已初始化（${root} 下已存在事件或快照）。恢复动作：续跑直接 appendCommands/rebuild，勿重复初始化。`);
    err.code = "state-store-exists";
    throw err;
  }
  writeSnapshot(root, { input: { archived: false, ...input }, lastSeq: 0, state: fold({ ...input, facts: [] }) });
  return readSnapshot(root);
}

/** 全量重建（V10 报告重建的领域核入口）：事件流 + 快照静态输入 → fold 快照 */
export function rebuild(root) {
  const snap = readSnapshot(root);
  if (!snap) {
    const err = new Error(`状态仓未初始化（缺 ${SNAPSHOT_FILE}）。恢复动作：先 initStateRepo 或改用 fold({ input, facts }) 纯函数入口。`);
    err.code = "state-store-missing";
    throw err;
  }
  const facts = readEvents(root);
  const state = fold({ ...snap.input, facts });
  return { input: snap.input, facts, state };
}

/** 当前 fold 状态（含快照） */
export function foldState(root) {
  return rebuild(root);
}

/**
 * 归档态派生（权威口径）：input.archived（cutover 归档标记输入）且事件流无 Unarchived。
 * 从权威源现算，不读快照 state 缓存——外部直接改快照 input（如 M5 cutover 命令）后检查仍正确。
 */
function deriveArchived(snap, facts) {
  return Boolean(snap.input?.archived) && !facts.some((f) => f.type === "Unarchived");
}

/**
 * 追加命令（引擎/agent 唯一写入口）：锁内 校验 → 分配 seq/ts → append JSONL → 重建快照。
 * opts = { pollMs, timeoutMs }。返回 { appended, appendedFacts }。
 */
export async function appendCommands(root, commands, opts = {}) {
  return withLock(root, async () => {
    const snap = readSnapshot(root);
    if (!snap) {
      const err = new Error(`状态仓未初始化（缺 ${SNAPSHOT_FILE}）。恢复动作：先 initStateRepo 登记绑定集与 repo 清单。`);
      err.code = "state-store-missing";
      throw err;
    }
    for (const cmd of commands) {
      const check = validateCommand(cmd);
      if (!check.ok) {
        const err = new Error(`命令不在词表或未过 schema，拒绝追加：${check.errors.join("；")}。权威源：kernel/facts.mjs COMMAND_TYPES。恢复动作：改用词表内命令并补齐 payload。`);
        err.code = "invalid-command";
        throw err;
      }
    }
    const existing = readEvents(root);
    const lastSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;
    if (deriveArchived(snap, existing)) {
      const onlyUnarchive = commands.length > 0 && commands.every((c) => c.type === "UnarchivePackage");
      if (!onlyUnarchive) throw archivedError(root);
    }
    const ts = new Date().toISOString();
    let seq = lastSeq;
    const appendedFacts = commands.map((cmd) => {
      seq += 1;
      return commandToFact(cmd, { seq, ts });
    });
    // append-only JSONL 写入（单写者锁内，顺序追加）
    appendFileSync(join(root, EVENTS_FILE), appendedFacts.map((f) => JSON.stringify(f)).join("\n") + "\n");
    // 快照 = 全量 fold 重建（AX3：快照与事件流同权威；RL2 等价性由 fold 确定性保证）
    const allFacts = [...existing, ...appendedFacts];
    const state = fold({ ...snap.input, facts: allFacts });
    // 红灯探针（D2）：超阈值记录快照标记（探针常量判定，不阻断——重审触发器，非运行时错误）
    const bytes = statSync(join(root, EVENTS_FILE)).size;
    const redLine = checkRedLineThresholds({ bytes, count: allFacts.length });
    writeSnapshot(root, { input: snap.input, lastSeq: seq, state, redLine });
    return { appended: appendedFacts.length, appendedFacts, redLine };
  }, opts);
}

/** 孤儿证据检查（状态仓视角，V11 性质二的仓级入口） */
export function checkOrphanEvidence(root) {
  const { input, facts } = rebuild(root);
  return findOrphanEvidence({ ...input, facts });
}
