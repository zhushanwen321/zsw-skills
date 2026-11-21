#!/usr/bin/env node
// zsession-wait：监控某个 zcode 会话是否「完全停止」的外部旁观 CLI。
//
// 判定条件（全部满足、连续 N 轮）：
//   1. 会话及其全部子会话（subagent / workflow actor）db 静默超 quiet-period
//   2. 会话树无在途工具调用（tool_usage.status='running'，行龄超
//      --stale-after 的残留行降级为提示不阻塞）
//   3. 会话树无在途 workflow run（dwf_run 非终态）且无存活的 workflow 沙箱进程
//   4. 宿主 app-server 进程树中无 shell 后代（后台 bash 的唯一外部可见证据；
//      workspace 级信号，可用 --ignore-shells 关闭）
//
// 宿主进程消失的判定收紧为「ps 里无任何 app-server 候选」；有候选但未能按
// cwd 绑定时 db 在途证据照常采信。db 的 running 行按崩溃残留处理的语义与
// 官方 reconcile 一致。
//
// 退出码：0=已停止  1=超时  2=会话不存在/db 不可读  3=参数错误  4=采集连续失败

import { collectDbSignals, loadSessionRow, DEFAULT_DB_PATH } from "../lib/db-signals.mjs";
import { collectProcessSignals } from "../lib/process-signals.mjs";
import { judgeRound, formatIdle } from "../lib/verdict.mjs";

const USAGE = `usage: zsession-wait <sessionId> [options]

options:
  --interval <sec>       轮询间隔（默认 15）
  --quiet-period <sec>   db 静默阈值，防模型思考空窗误判（默认 180）
  --rounds <n>           连续全绿轮数（默认 3）
  --timeout <sec>        总超时，0 表示不限（默认 7200）
  --stale-after <sec>    tool_usage running 行视为残留的行龄阈值，0 禁用（默认 86400）
  --json                 最终报告以 JSON 输出到 stdout（进度行始终在 stderr）
  --ignore-shells        跳过宿主 shell 后代信号（workspace 有并发会话时用）
  --strict-orphan        孤儿 shell（PPID=1）升级为阻塞信号（默认只提示）
  --shell-grace-polls <n> 泄漏确认轮数：会话本体已停、只剩 host_shells 且 shell 清单与
                         CPU 时间连续 n 轮零变化时，带 stopped-stale-shells 终态退出
                         （默认 20 ≈ 5 分钟；泄漏 shell 由调用方裁决杀否，监控不杀）
  --db <path>            db 路径（默认 ~/.zcode/cli/db/db.sqlite）
  -h, --help             显示本帮助`;

function parseArgs(argv) {
  const opts = {
    sessionId: null,
    intervalSec: 15,
    quietPeriodSec: 180,
    rounds: 3,
    timeoutSec: 7200,
    staleAfterSec: 86_400,
    shellGracePolls: 20,
    json: false,
    ignoreShells: false,
    strictOrphan: false,
    dbPath: DEFAULT_DB_PATH,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--interval") opts.intervalSec = Number(next());
    else if (a === "--quiet-period") opts.quietPeriodSec = Number(next());
    else if (a === "--rounds") opts.rounds = Number(next());
    else if (a === "--timeout") opts.timeoutSec = Number(next());
    else if (a === "--stale-after") opts.staleAfterSec = Number(next());
    else if (a === "--shell-grace-polls") opts.shellGracePolls = Number(next());
    else if (a === "--json") opts.json = true;
    else if (a === "--ignore-shells") opts.ignoreShells = true;
    else if (a === "--strict-orphan") opts.strictOrphan = true;
    else if (a === "--db") opts.dbPath = next();
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`unexpected extra argument: ${positional[1]}`);
  opts.sessionId = positional[0] ?? null;
  return opts;
}

function hhmmss(date) {
  return date.toTimeString().slice(0, 8);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(code, message) {
  process.stderr.write(`zsession-wait: ${message}\n`);
  process.exitCode = code;
  // die 后直接抛出终止主流程，让已写入的 stderr 自然 flush（不用 process.exit 硬切）。
  throw new EarlyExit();
}

class EarlyExit extends Error {}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!opts.sessionId) die(3, `session id required.\n\n${USAGE}`);
  for (const [name, v, min] of [
    ["--interval", opts.intervalSec, 1],
    ["--quiet-period", opts.quietPeriodSec, 0],
    ["--rounds", opts.rounds, 1],
    ["--timeout", opts.timeoutSec, 0],
    ["--stale-after", opts.staleAfterSec, 0],
  ]) {
    if (!Number.isFinite(v) || v < min) die(3, `${name} must be a number >= ${min}`);
  }

  let sessionRow;
  try {
    sessionRow = loadSessionRow(opts.dbPath, opts.sessionId);
  } catch (error) {
    die(2, `cannot open db at ${opts.dbPath}: ${error.message}`);
  }
  if (!sessionRow) die(2, `session ${opts.sessionId} not found in ${opts.dbPath}`);

  const quietPeriodMs = opts.quietPeriodSec * 1000;
  const intervalMs = opts.intervalSec * 1000;
  const staleAfterMs = opts.staleAfterSec * 1000;
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutSec > 0 ? opts.timeoutSec * 1000 : Number.POSITIVE_INFINITY;

  process.stderr.write(
    `zsession-wait: watching ${opts.sessionId} "${sessionRow.title}"\n` +
      `  workspace: ${sessionRow.directory}\n` +
      `  interval=${opts.intervalSec}s quiet-period=${opts.quietPeriodSec}s rounds=${opts.rounds} timeout=${opts.timeoutSec > 0 ? `${opts.timeoutSec}s` : "none"} stale-after=${opts.staleAfterSec > 0 ? `${opts.staleAfterSec}s` : "off"}\n`,
  );

  let greenStreak = 0;
  let round = 0;
  let failures = 0;
  let lastSnapshot = null;
  let lastJudge = null;
  // 泄漏确认状态机：红条件只剩 host_shells 时，逐轮对比 shell 清单与 CPU 时间快照；
  // 连续 shellGracePolls 轮零变化 = 挂死泄漏（会话本体已停、shell 永不自行收尾），
  // 带终态退出交调用方裁决——监控只报事实（pid/cputime/command），不做杀进程裁决。
  let staleShellRounds = 0;
  let staleShellStreakSince = null;
  let shellCpuSnapshot = new Map();
  let staleShellsFinal = null;

  while (true) {
    round++;
    try {
      const now = Date.now();
      const db = collectDbSignals(opts.dbPath, opts.sessionId, {
        // staleAfter=0 → cutoff 0（started_at >= 0 恒真）= 不做行龄区分。
        staleCutoffMs: staleAfterMs > 0 ? now - staleAfterMs : 0,
      });
      const procs = await collectProcessSignals({
        directory: sessionRow.directory,
        activeRunIds: db.activeRunIds,
      });
      lastSnapshot = { db, procs };
      lastJudge = judgeRound({
        db,
        procs,
        now,
        quietPeriodMs,
        ignoreShells: opts.ignoreShells,
        strictOrphan: opts.strictOrphan,
      });
      failures = 0;
    } catch (error) {
      if (error instanceof EarlyExit) throw error;
      failures++;
      process.stderr.write(`zsession-wait: collect failed (${failures}/5): ${error.message}\n`);
      if (failures >= 5) die(4, `collection failed ${failures} times in a row`);
      greenStreak = 0;
      await sleep(intervalMs);
      continue;
    }

    const j = lastJudge;
    const p = lastSnapshot.procs;
    const hostLabel = j.hostBound ? p.hostPids.join(",") : p.hostCandidateCount > 0 ? "unresolved" : "gone";
    const status = j.green ? `green ${greenStreak + 1}/${opts.rounds}` : `RED (${j.red.join(",")})`;
    process.stderr.write(
      `[${hhmmss(new Date())}] #${round} ${status} | host=${hostLabel} ` +
        `tools=${lastSnapshot.db.runningTools}(+${lastSnapshot.db.runningToolsStale}stale) runs=${lastSnapshot.db.activeRuns} ` +
        `sandbox=${p.sandboxProcs.length} queue=${lastSnapshot.db.pendingInputs} shells=${p.hostShells.length} orphans=${p.orphanShells.length} idle=${formatIdle(j.idleMs)}\n`,
    );
    for (const w of j.warnings) process.stderr.write(`    warn: ${w}\n`);
    if (p.foreignSandboxes.length > 0) {
      process.stderr.write(
        `    note: ${p.foreignSandboxes.length} workflow sandbox process(es) of other sessions in this workspace (not blocking)\n`,
      );
    }

    greenStreak = j.green ? greenStreak + 1 : 0;
    if (greenStreak >= opts.rounds) break;

    // 泄漏确认：其余红条件全部解除、只剩宿主 shell 时开始记账。
    const onlyShellsRed = j.red.length === 1 && j.red[0] === "host_shells";
    if (onlyShellsRed && !opts.ignoreShells) {
      const current = new Map(p.hostShells.map((s) => [s.pid, s.cputime ?? null]));
      const sameShellSet =
        current.size === shellCpuSnapshot.size &&
        [...current.keys()].every((pid) => shellCpuSnapshot.has(pid));
      const cpuAllFrozen =
        sameShellSet &&
        [...current.entries()].every(([pid, cpu]) => cpu !== null && shellCpuSnapshot.get(pid) === cpu);
      if (sameShellSet && cpuAllFrozen) {
        if (staleShellRounds === 0) staleShellStreakSince = new Date();
        staleShellRounds++;
      } else {
        staleShellRounds = 0;
        staleShellStreakSince = null;
      }
      shellCpuSnapshot = current;
      if (staleShellRounds >= opts.shellGracePolls) {
        staleShellsFinal = p.hostShells.map((s) => ({ pid: s.pid, cputime: s.cputime, command: s.command }));
        break;
      }
    } else {
      staleShellRounds = 0;
      staleShellStreakSince = null;
      shellCpuSnapshot = new Map();
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) break;
    // 睡眠不超过剩余预算，保证 --timeout 是墙上时钟硬上限。
    await sleep(Math.max(0, Math.min(intervalMs, timeoutMs - (Date.now() - startedAt))));
  }

  const stopped = greenStreak >= opts.rounds;
  const elapsedMs = Date.now() - startedAt;
  const verdict = stopped ? "stopped" : staleShellsFinal ? "stopped-stale-shells" : "timeout";
  const report = {
    sessionId: opts.sessionId,
    verdict,
    greenStreak,
    rounds: round,
    elapsedMs,
    session: {
      title: sessionRow.title,
      directory: sessionRow.directory,
      taskType: sessionRow.task_type,
      subtreeSize: lastSnapshot.db.subtreeSize,
      childCount: lastSnapshot.db.childCount,
      lastOutcome: sessionRow.last_outcome,
      lastActivityMs: lastSnapshot.db.lastActivityMs,
      lastFinish: lastSnapshot.db.lastFinish,
      lastRole: lastSnapshot.db.lastRole,
    },
    finalSignals: {
      hostPids: lastSnapshot.procs.hostPids,
      hostCandidateCount: lastSnapshot.procs.hostCandidateCount,
      lsofFailures: lastSnapshot.procs.lsofFailures,
      runningTools: lastSnapshot.db.runningTools,
      runningToolsStale: lastSnapshot.db.runningToolsStale,
      activeRuns: lastSnapshot.db.activeRuns,
      activeRunIds: lastSnapshot.db.activeRunIds,
      sandboxProcs: lastSnapshot.procs.sandboxProcs,
      pendingInputs: lastSnapshot.db.pendingInputs,
      hostShells: lastSnapshot.procs.hostShells,
      orphanShells: lastSnapshot.procs.orphanShells,
      foreignSandboxes: lastSnapshot.procs.foreignSandboxes,
      idleMs: lastJudge.idleMs,
      red: lastJudge.red,
      warnings: lastJudge.warnings,
    },
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const outcome = sessionRow.last_outcome ?? "none";
    const finish = lastSnapshot.db.lastFinish ?? "none";
    const headLine = stopped
      ? `session ${opts.sessionId} fully stopped after ${round} rounds (${Math.round(elapsedMs / 1000)}s)\n`
      : staleShellsFinal
        ? `session ${opts.sessionId} stopped with stale shell(s) after ${round} rounds (${Math.round(elapsedMs / 1000)}s) — ` +
          `session idle, ${staleShellsFinal.length} host shell(s) frozen for ${opts.shellGracePolls} polls ` +
          `(since ${staleShellStreakSince ? hhmmss(staleShellStreakSince) : "?"}); caller decides whether to kill:\n` +
          staleShellsFinal.map((s) => `  stale-shell pid=${s.pid} cputime=${s.cputime ?? "?"} cmd=${s.command}`).join("\n") + "\n"
        : `TIMEOUT after ${Math.round(elapsedMs / 1000)}s, last state: red=(${lastJudge.red.join(",")}) green=${greenStreak}/${opts.rounds}\n`;
    process.stdout.write(
      headLine +
        `  last_outcome=${outcome} last_message_finish=${finish} idle=${formatIdle(lastJudge.idleMs)}\n`,
    );
  }
  // stopped 与 stopped-stale-shells 都是「会话已停」的确定性结论，退出码 0；
  // 区别在后者留了泄漏 shell 清单交调用方裁决（杀否由调用方定，监控不做破坏性动作）。
  process.exitCode = stopped || staleShellsFinal ? 0 : 1;
}

main().catch((error) => {
  if (error instanceof EarlyExit) return;
  process.stderr.write(`zsession-wait: ${error.stack ?? error.message}\n`);
  process.exitCode = 4;
});
