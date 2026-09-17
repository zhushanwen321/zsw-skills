'use strict';
/**
 * zsw 在线清理（不停机路径，2026-09-08）
 *
 * 与官方 zsw doctor clean 的差异（其余 1:1 复刻 lib/clean-exec.js 删除序列）：
 *   1. 不做四项停机校验——用户确认 2 个 zcode-cli(8/26, /tmp/zc-probe) 为活跃
 *      subagent，保持运行；改为「删除集 ∩ zc-probe 会话 = 0」专项防护。
 *   2. 不做 VACUUM（用户指令）——磁盘空间不回收，仅删行；WAL 增长由
 *      PASSIVE checkpoint 自然回落。
 *   3. busy_timeout 30s（官方 5s 以停机校验为前提；本路径有活跃持库者）。
 *   4. 备份用 python3 sqlite3 在线 .backup（WAL 安全快照）+ quick_check 校验。
 *
 * 无环境变量 ZSW_ONLINE_CLEAN_CONFIRM=YES 时 = 纯只读预演（识别+文件面计划），
 * 不做任何写操作。确认后同脚本重跑执行。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PLUGIN = '/Users/zhushanwen/Code/zcode-plugin-workspace/main/z-subagent-workflow';
const ci = require(path.join(PLUGIN, 'lib/clean-identify'));
const cfg = require(path.join(PLUGIN, 'lib/config'));
const cfs = require(path.join(PLUGIN, 'lib/clean-fs'));

const CONFIRM = process.env.ZSW_ONLINE_CLEAN_CONFIRM === 'YES';
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
const fail = (msg) => {
  console.error('\n✗ ABORT: ' + msg);
  process.exit(1);
};

const CASCADE_SESSION_TABLES = [
  'message', 'todo', 'session_entry', 'session_input', 'session_target',
  'model_usage', 'turn_usage', 'tool_usage',
];
const CHUNK_SIZE = 200;
const BUSY_TIMEOUT_MS = 30000;

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)}${u[i]}`;
};

log(`# zsw 在线清理报告（${new Date().toISOString()}）`);
log(`模式：${CONFIRM ? '★执行（写库+删文件）' : '预演（全只读，不写不删）'}`);
log('');

// ---------------- Phase 1 识别与安全网（只读） ----------------
const p = cfg.resolveEnginePaths();
const records = cfg.recordsPath();

let ds0;
try {
  ds0 = ci.buildDeleteSet({
    engineDbPath: p.engineDbPath, indexDbPath: p.indexDbPath, recordsPath: records,
  });
} catch (e) { fail(`识别失败：${e.message}`); }

// 哨兵
const sent = ci.checkSentinel(ds0, records);
if (!sent.ok) fail(`污染哨兵命中 ${sent.intersection.length} 个：${sent.intersection.join(', ')}`);
log(`✓ 污染哨兵：删除集 ∩ targetSessionId 值域 = 0`);

// 冲突预检 + 剔除
const conflicts = ci.checkIndexConflicts(ds0.engineSessionIds, p.indexDbPath);
const { deleteSet: ds, removed } = ci.excludeConflicts(ds0, conflicts);
log(`✓ 索引冲突预检：members ${conflicts.members.length} / automations ${conflicts.automations.length} / off_peak ${conflicts.offPeak.length}，剔除 ${removed.length} 个`);
for (const r of removed) log(`    剔除 ${r.id}（${r.source}: ${r.detail}）`);

const engineIds = [...ds.engineSessionIds].sort();
const indexIds = [...ds.indexTaskIds].sort();
log(`删除集：引擎 session ${engineIds.length}（白名单∩库 ${ds.byClass.whitelist.length} / 特征目录 ${ds.byClass.feature.length} / 超龄 child ${ds.byClass.subagentChildStale.length}）+ 索引 tasks ${indexIds.length}`);

// 红灯复核（记录）
const ro = new DatabaseSync(p.engineDbPath, { readOnly: true });
const rl = ci.checkRedLight(ds, ro);
log(`红灯复核：临时类占比 ${(rl.ratio * 100).toFixed(1)}%（workspace ${rl.workspaceN}/tmp ${rl.tmpN}），表外命中 ${rl.outsideFeatureHits}（人工审已过，留档）`);

// 活跃 subagent 专项防护：/tmp/zc-probe 会话不得入删除集
const liveRows = ro.prepare("SELECT id, task_type FROM session WHERE directory LIKE '/tmp/zc-probe%'").all();
const liveInSet = liveRows.filter((r) => ds.engineSessionIds.has(r.id));
if (liveInSet.length) fail(`活跃 subagent 会话命中删除集 ${liveInSet.length} 个：${liveInSet.map((r) => r.id).join(', ')}`);
log(`✓ 活跃 subagent 防护：zc-probe 会话在库 ${liveRows.length} 行，∩删除集 = 0`);

// 8 个调用方会话删除前在库状态（哨兵已保证不在删除集）
const targets = ci.parseRecordTargetSessionIds(records);
const phT = [...targets].map(() => '?').join(',');
const targetsPre = ro.prepare(`SELECT COUNT(*) AS n FROM session WHERE id IN (${phT})`).get(...targets).n;
log(`✓ 调用方会话（targetSessionId ${targets.size} 个）：删除前在库 ${targetsPre} 个`);

const sessionBefore = ro.prepare('SELECT COUNT(*) AS n FROM session').get().n;
const partBefore = ro.prepare('SELECT COUNT(*) AS n FROM part').get().n;
const tasksTotalBefore = (() => {
  const idx = new DatabaseSync(p.indexDbPath, { readOnly: true });
  const n = idx.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  idx.close();
  return n;
})();
ro.close();

// 期望对账（09-08 dry-run 基准）：白名单/特征目录/索引只能因新写入变化，必须精确相等；
// 超龄 child 随 7 天年龄线前移只能单调增长（不设上限，自然老化合法），禁止减少。
if (ds.byClass.whitelist.length !== 57) fail(`白名单∩库 ${ds.byClass.whitelist.length} ≠ 基准 57（有新写入？）`);
if (ds.byClass.feature.length !== 180) fail(`特征目录类 ${ds.byClass.feature.length} ≠ 基准 180（有新写入？）`);
if (indexIds.length !== 45) fail(`索引 tasks ${indexIds.length} ≠ 基准 45（有新写入？）`);
if (ds.byClass.subagentChildStale.length < 5952) fail(`超龄 child ${ds.byClass.subagentChildStale.length} < 基准 5952（异常减少）`);

// ---------------- Phase 2 文件面计划（只读） ----------------
const plan = cfs.planFileCleanup({
  engineSessionIds: ds.engineSessionIds,
  artifactsDir: p.artifactsDir, logDir: p.logDir, execDir: p.execDir,
});
log(`文件面计划：artifacts ${plan.artifacts.length} / exec∈集 ${plan.execInSet.length} / exec超龄空壳 ${plan.execStaleEmpty.length} / log ${plan.logFiles.length}，可回收 ${fmtBytes(plan.totalReclaimableBytes)}`);

const du = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
log(`执行前：db ${fmtBytes(du(p.engineDbPath))} + wal ${fmtBytes(du(p.engineDbPath + '-wal'))}；index ${fmtBytes(du(p.indexDbPath))} + wal ${fmtBytes(du(p.indexDbPath + '-wal'))}；session 总数 ${sessionBefore}；tasks 总数 ${tasksTotalBefore}`);

if (!CONFIRM) {
  log('');
  log('（预演模式：到此为止，未写任何数据。确认执行：ZSW_ONLINE_CLEAN_CONFIRM=YES 重跑）');
  process.exit(0);
}

// ---------------- Phase 3 在线备份 + quick_check ----------------
const ts = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
const backupDir = path.join(os.homedir(), '.zcode', 'zsw', 'maintenance', `backup-manual-online-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

const PY_BACKUP = `
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect('file:' + src + '?mode=ro', uri=True)
d = sqlite3.connect(dst)
s.backup(d)
d.close(); s.close()
q = sqlite3.connect('file:' + dst + '?mode=ro', uri=True)
r = q.execute('PRAGMA quick_check').fetchone()[0]
q.close()
print(r)
sys.exit(0 if r == 'ok' else 2)
`;
for (const [label, src, name] of [['引擎库', p.engineDbPath, 'db.sqlite'], ['索引库', p.indexDbPath, 'tasks-index.sqlite']]) {
  const dst = path.join(backupDir, name);
  log(`备份 ${label} → ${dst}（在线 .backup，可能数分钟）...`);
  try {
    const out = execFileSync('python3', ['-c', PY_BACKUP, src, dst], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
    if (out !== 'ok') fail(`${label}备份 quick_check = ${out}`);
    log(`✓ ${label}备份完成，quick_check = ok（${fmtBytes(fs.statSync(dst).size)}）`);
  } catch (e) { fail(`${label}备份失败：${e.message}`); }
}
log(`✓ 备份目录：${backupDir}（回滚唯一安全网，确认无异常前勿删）`);

// ---------------- Phase 4 引擎库分块删除（1:1 复刻 clean-exec 语句序） ----------------
const db = new DatabaseSync(p.engineDbPath);
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
db.exec('PRAGMA foreign_keys = ON');
if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) fail('foreign_keys=ON 未生效，中止');

const counts = {
  sessionDeleted: 0, inputHistoryDeleted: 0, sessionTaskLinkDeleted: 0,
  sessionTaskLinkParentNull: 0, workflowRunNull: 0, workflowActivityNull: 0,
  perTable: Object.fromEntries(CASCADE_SESSION_TABLES.map((t) => [t, 0])),
};
let ci2 = 0;
for (let i = 0; i < engineIds.length; i += CHUNK_SIZE) {
  const chunk = engineIds.slice(i, i + CHUNK_SIZE);
  const ph = chunk.map(() => '?').join(', ');
  db.exec('BEGIN');
  try {
    for (const t of CASCADE_SESSION_TABLES) {
      counts.perTable[t] += db.prepare(`DELETE FROM ${t} WHERE session_id IN (${ph})`).run(...chunk).changes;
    }
    counts.sessionTaskLinkDeleted += db.prepare(`DELETE FROM session_task_link WHERE child_session_id IN (${ph})`).run(...chunk).changes;
    counts.sessionTaskLinkParentNull += db.prepare(`UPDATE session_task_link SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...chunk).changes;
    counts.workflowRunNull += db.prepare(`UPDATE workflow_run SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...chunk).changes;
    counts.workflowActivityNull += db.prepare(`UPDATE workflow_activity SET child_session_id = NULL WHERE child_session_id IN (${ph})`).run(...chunk).changes;
    counts.inputHistoryDeleted += db.prepare(`DELETE FROM input_history WHERE session_id IN (${ph})`).run(...chunk).changes;
    counts.sessionDeleted += db.prepare(`DELETE FROM session WHERE id IN (${ph})`).run(...chunk).changes;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* keep original error */ }
    db.close();
    fail(`引擎库删除中止于块 ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(engineIds.length / CHUNK_SIZE)}（已提交块保持生效，备份安全网在）：${e.message}`);
  }
  db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  ci2 += 1;
  if (ci2 % 5 === 0 || i + CHUNK_SIZE >= engineIds.length) log(`  批次 ${ci2}/${Math.ceil(engineIds.length / CHUNK_SIZE)} 已提交（累计 session ${counts.sessionDeleted}）`);
}
const sessionAfter = db.prepare('SELECT COUNT(*) AS n FROM session').get().n;
const partAfter = db.prepare('SELECT COUNT(*) AS n FROM part').get().n;
counts.partCascaded = Math.max(0, partBefore - partAfter);
db.close();
log(`✓ 引擎库删除完成：session ${counts.sessionDeleted}（${sessionBefore}→${sessionAfter}）；` +
  `part 级联 ${fmtNum(counts.partCascaded)}（${fmtNum(partBefore)}→${fmtNum(partAfter)}）；input_history ${counts.inputHistoryDeleted}`);
log(`  级联表明细：${CASCADE_SESSION_TABLES.map((t) => `${t} ${fmtNum(counts.perTable[t])}`).join(' / ')}`);
log(`  session_task_link: child删 ${counts.sessionTaskLinkDeleted} / parent置NULL ${counts.sessionTaskLinkParentNull}；workflow_run置NULL ${counts.workflowRunNull}；workflow_activity置NULL ${counts.workflowActivityNull}`);

function fmtNum(n) { return n.toLocaleString('en-US'); }

// ---------------- Phase 5 索引库联动 ----------------
const idx = new DatabaseSync(p.indexDbPath);
idx.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
let indexRes = { tasksDeleted: 0, membersDeleted: 0 };
if (indexIds.length > 0) {
  const ph = indexIds.map(() => '?').join(', ');
  idx.exec('BEGIN');
  try {
    indexRes.tasksDeleted = idx.prepare(`DELETE FROM tasks WHERE task_id IN (${ph})`).run(...indexIds).changes;
    indexRes.membersDeleted = idx.prepare(`DELETE FROM task_group_members WHERE task_id IN (${ph})`).run(...indexIds).changes;
    idx.exec('COMMIT');
  } catch (e) {
    try { idx.exec('ROLLBACK'); } catch { /* keep original error */ }
    idx.close();
    fail(`索引库删除中止（引擎库已删，备份安全网在）：${e.message}`);
  }
}
const tasksAfter = idx.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
idx.close();
log(`✓ 索引库联动：tasks ${indexRes.tasksDeleted}（${tasksTotalBefore}→${tasksAfter}）；task_group_members ${indexRes.membersDeleted}`);

// ---------------- Phase 6 后验（只读） ----------------
const ro2 = new DatabaseSync(p.engineDbPath, { readOnly: true });
const remain = ro2.prepare('SELECT COUNT(*) AS n FROM session WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(engineIds)).n;
if (remain !== 0) { ro2.close(); fail(`后验失败：删除集仍有 ${remain} 行 session 残留`); }
const targetsPost = ro2.prepare(`SELECT COUNT(*) AS n FROM session WHERE id IN (${phT})`).get(...targets).n;
if (targetsPost < targetsPre) { ro2.close(); fail(`后验失败：调用方会话在库 ${targetsPost} < 删除前 ${targetsPre}`); }
ro2.close();
log(`✓ 后验：删除集残留 0；调用方会话 ${targetsPost}/${targets.size} 完好`);

// ---------------- Phase 7 文件面执行 ----------------
const fres = cfs.executeFileCleanup(plan, { artifactsDir: p.artifactsDir, logDir: p.logDir, execDir: p.execDir });
const fsLine = (label, r) => `${label}: 计划 ${r.planned} / 已删 ${r.deletedCount} / 失败 ${r.failures.length}`;
log(`✓ 文件面：${fsLine('artifacts', fres.artifacts)}；${fsLine('exec∈集+空壳', fres.exec)}；${fsLine('log', fres.log)}；回收 ${fmtBytes(fres.totalDeletedBytes)}（失败 ${fres.totalFailureCount}）`);
for (const key of ['artifacts', 'exec', 'log']) {
  for (const f of (fres[key] && fres[key].failures) || []) log(`  ⚠ ${key} 删除失败：${f.name}（${f.code}）`);
}

// ---------------- Phase 8 收尾 ----------------
log('');
log(`执行后：db ${fmtBytes(du(p.engineDbPath))} + wal ${fmtBytes(du(p.engineDbPath + '-wal'))}（未 VACUUM：库文件不变，空间待后续停机 VACUUM 回收，预估 ~5.7GB）`);
log('');
log('## 回滚指引（仅异常时）');
log(`1. 退出 ZCode 且停掉 /tmp/zc-probe 的 zcode-cli subagent（持库进程必须全退）`);
log(`2. 原位删除 db.sqlite{,-wal,-shm} 与 tasks-index.sqlite{,-wal,-shm} 后，整组拷回：`);
log(`   cp ${backupDir}/db.sqlite ~/.zcode/cli/db/db.sqlite`);
log(`   cp ${backupDir}/tasks-index.sqlite ~/.zcode/v2/tasks-index.sqlite`);
log('3. 重启 ZCode 核对 session 总数回到基线 ' + sessionBefore);
log('');
log('## 遗留事项');
log('- VACUUM 未做：下次天然停机窗口跑 `node bin/zsw.js doctor clean`（幂等，剩 0 行删除）或手动 VACUUM');
log('- 备份释放（确认 1-2 天无异常后）：rm -rf ' + backupDir);

const reportPath = path.join(os.homedir(), `zsw-clean-manual-${stamp}.txt`);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`\n报告已写入：${reportPath}`);
