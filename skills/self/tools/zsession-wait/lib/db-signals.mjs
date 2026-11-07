// db 信号采集：以只读短连接查询 ~/.zcode/cli/db/db.sqlite。
// 设计依据（源码与实机核实于 zcode 3.16.x）：
// - session 表无「正在运行」标志，last_outcome 是唯一终态字段；活状态只能靠
//   time_updated 静默 + 在途证据（tool_usage.running / dwf_run 非终态）推断
// - 崩溃后 running 行不会自愈（官方 reconcile 只在宿主下次启动时收敛），
//   且实机存在 turn 已收尾但 running 行永不更新的残留（跨宿主生命周期存活），
//   因此 running 行按行龄拆「新鲜 / 陈旧」，陈旧行交裁决层降级为提示
// - session_input 的 admitted 有大量 /compact 控制命令残留（实机 436 条，
//   正常结束不清理、只在 resume 时清扫），排队信号只统计 delivery='queue'
//   的行——那是「turn 收尾后 queue drain 会提升」的真排队语义
// - 每轮重开重关连接：WAL 模式下读者不阻塞写者，短连接对 21GB 大库最安全
//   （与 zcode 自带 debug 观察器 sources.ts 的用法一致）

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DB_PATH = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

// 一条语句拿全部会话树信号：CTE 在语句级可见，各子查询复用同一棵树。
// 树规模为个位数到几十个会话，相关表均按 session 主键/索引过滤，无全表扫压力。
// staleCutoffMs 为 running 行的新鲜截止 epoch ms（started_at >= 截止 = 新鲜）；
// 传 0 表示不做行龄区分（全部按新鲜计）。
const TREE_SIGNALS_SQL = `
with recursive tree(id) as (
  select id from session where id = ?
  union all
  select s.id from session s join tree t on s.parent_id = t.id
)
select
  (select count(*) from tree) as subtree_size,
  (select count(*) from session where id in (select id from tree) and parent_id is not null) as child_count,
  (select coalesce(max(time_updated), 0) from session where id in (select id from tree)) as last_activity_ms,
  (select count(*) from tool_usage where session_id in (select id from tree) and status = 'running' and started_at >= ?) as running_tools,
  (select count(*) from tool_usage where session_id in (select id from tree) and status = 'running' and started_at < ?) as running_tools_stale,
  (select count(*) from session_input where session_id in (select id from tree) and status = 'admitted' and delivery = 'queue') as pending_inputs,
  (select count(*) from dwf_run where parent_session_id in (select id from tree) and status in ('pending', 'running')) as active_runs,
  (select coalesce(group_concat(id), '') from dwf_run where parent_session_id in (select id from tree) and status in ('pending', 'running')) as active_run_ids,
  (select json_extract(data, '$.finish') from message where session_id = ? order by time_updated desc limit 1) as last_finish,
  (select json_extract(data, '$.role') from message where session_id = ? order by time_updated desc limit 1) as last_role
`;

const SESSION_ROW_SQL = `
select id, directory, title, task_type, last_outcome, time_created, time_updated
from session where id = ?
`;

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function loadSessionRow(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(SESSION_ROW_SQL).get(sessionId) ?? null;
  } finally {
    db.close();
  }
}

export function collectDbSignals(dbPath, sessionId, { staleCutoffMs = 0 } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(TREE_SIGNALS_SQL)
      .get(sessionId, staleCutoffMs, staleCutoffMs, sessionId, sessionId);
    return {
      subtreeSize: toCount(row.subtree_size),
      childCount: toCount(row.child_count),
      lastActivityMs: Number(row.last_activity_ms) || 0,
      runningTools: toCount(row.running_tools),
      runningToolsStale: toCount(row.running_tools_stale),
      pendingInputs: toCount(row.pending_inputs),
      activeRuns: toCount(row.active_runs),
      activeRunIds: row.active_run_ids ? String(row.active_run_ids).split(",").filter(Boolean) : [],
      lastFinish: row.last_finish ?? null,
      lastRole: row.last_role ?? null,
    };
  } finally {
    db.close();
  }
}
