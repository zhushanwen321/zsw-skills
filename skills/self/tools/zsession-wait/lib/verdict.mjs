// 裁决：单轮红绿判定 + 连续 N 轮绿的状态机。
//
// 信号语义（依据源码与实机核实，见 db-signals.mjs / process-signals.mjs 文件头）：
// - running_tools / active_runs 是 db 在途证据，但宿主进程死掉后是脏数据
//   （崩溃不写终态）——「宿主死」的判定收紧为 ps 里连 app-server 候选都
//   没有；有候选但 cwd 全不匹配 / lsof 全失败属识别失败，db 在途证据必须
//   照常采信（否则活着的后台 bash 会被误判已停止）
// - running 行另按行龄拆新鲜 / 陈旧（turn 已收尾但行永不更新的实机残留）：
//   陈旧行不阻塞判定、输出 warning，如确认任务真在长跑可调大 --stale-after
// - 沙箱进程独立于宿主死活：孤儿沙箱仍在跑，必须单独阻塞判定
// - 孤儿 shell（PPID=1）始终采集（前代宿主被 SIGKILL 的残留 detached bash
//   在新宿主起来后只能靠全表扫发现）；用户终端 nohup 的进程同样命中且无法
//   归属，默认只提示，--strict-orphan 升级为阻塞
// - host_shells 是 workspace 级保守信号（无法归属到具体会话），多宿主同
//   cwd 时取全部宿主的 shell 后代并集；可用 --ignore-shells 关闭
// - quiet_period 防「模型思考空窗 / 轮次间隙」误判：zcode 在长推理期间
//   几分钟不写 db 属正常，静默不足阈值时一律视为未停

export function judgeRound({ db, procs, now, quietPeriodMs, ignoreShells, strictOrphan }) {
  const idleMs = db.lastActivityMs > 0 ? Math.max(0, now - db.lastActivityMs) : Number.POSITIVE_INFINITY;
  const red = [];
  const warnings = [];

  const hostBound = procs.hostPids.length > 0;
  const dbStillMoving = idleMs < quietPeriodMs;
  // 宿主真死 = ps 里连候选形态都没有；有候选但没绑上属识别失败，不算死。
  const dirtyMode = !hostBound && procs.hostCandidateCount === 0;

  if (!hostBound && procs.hostCandidateCount > 0) {
    warnings.push(
      `host unresolved: ${procs.hostCandidateCount} app-server candidate(s) found but none matched workspace cwd (${procs.lsofFailures} lsof failure(s)); db in-flight evidence is being trusted as-is`,
    );
  }
  if (!hostBound && dbStillMoving && procs.hostCandidateCount === 0) {
    warnings.push("no app-server candidate in process table but db recently active; treating as alive with shell signal unavailable");
  }
  if (procs.lsofFailures > 0 && hostBound) {
    warnings.push(`${procs.lsofFailures} candidate cwd lookup(s) failed; host binding may be incomplete`);
  }

  if (dirtyMode) {
    warnings.push("host process gone (no candidates); treating db running rows as stale (crash residue)");
  } else {
    if (db.runningTools > 0) red.push("running_tools");
    if (db.activeRuns > 0) red.push("active_runs");
    // 排队输入：turn 收尾后 queue drain 会提升 admitted 输入开新 turn，
    // 存在即说明还有待消费的工作（只统计 delivery='queue'，排除 /compact 残留）。
    if (db.pendingInputs > 0) red.push("pending_inputs");
    if (hostBound && !ignoreShells && procs.hostShells.length > 0) red.push("host_shells");
  }

  // 陈旧 running 行：不阻塞，但要让调用方看见（可能是 turn 已收尾的残留）。
  if (db.runningToolsStale > 0) {
    warnings.push(`${db.runningToolsStale} running tool_usage row(s) older than --stale-after treated as residue; raise --stale-after if the task really runs that long`);
  }

  // 沙箱进程与宿主死活无关（独立 ZCode Helper 进程），始终阻塞。
  if (procs.sandboxProcs.length > 0) red.push("sandbox_procs");

  if (procs.orphanShells.length > 0 && !strictOrphan) {
    warnings.push(`${procs.orphanShells.length} orphan shell(s) (PPID=1) detected; cannot attribute to this session — rerun with --strict-orphan to block on them`);
  }
  if (strictOrphan && procs.orphanShells.length > 0) red.push("orphan_shells");

  if (idleMs < quietPeriodMs) red.push("quiet_period");

  return {
    green: red.length === 0,
    red,
    warnings,
    dirtyMode,
    hostBound,
    idleMs,
  };
}

export function formatIdle(ms) {
  if (!Number.isFinite(ms)) return "never-active";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
