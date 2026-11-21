// 进程信号采集：宿主进程、workflow 沙箱进程、shell 后代 / 孤儿 shell。
// 设计依据（实机核实于 macOS / zcode 3.16.x）：
// - 会话活状态在 app-server 进程内存里，db 无表达，只能旁观进程
// - app-server 每 workspace 一个；打包态 ps 里显示为 "zcode-cli"（argv 被
//   process.title 改写），定位靠 lsof 取 cwd 与 session.directory 比对。
//   同 workspace 可能有多个同 cwd 宿主（多窗口同目录），shell 后代取并集，
//   避免 first-match 绑定漏掉目标会话自己的后台 bash
// - 「没找到宿主」要区分两种：ps 里连 app-server 候选都没有（宿主真死，
//   db 的 running 行可按崩溃残留处理）vs 有候选但 cwd 全不匹配 / lsof 全
//   失败（识别失败，db 在途证据必须照常采信）——返回候选数与失败数给裁决层
// - workflow 沙箱是独立 "ZCode Helper" 进程，命令行含 dwfrun-<uuid>.mjs；
//   只按「db 中该会话子树的活跃 run id 交集」计数，避免同 workspace
//   兄弟会话的沙箱误阻塞目标会话判定
// - 后台 bash 是 app-server 的 detached 后代：宿主优雅退出会杀树，被
//   SIGKILL 后孤儿存活（PPID 变 1）。孤儿 shell 与宿主死活无关、始终采集：
//   前代宿主被杀后新宿主起来，残留的 detached bash 只能靠全表扫发现

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";

const execFileAsync = promisify(execFile);

const SHELL_NAMES = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish", "csh", "tcsh"]);
const DWFRUN_RE = /(dwfrun-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mjs/g;
const PS_TIMEOUT_MS = 10_000;
const LSOF_TIMEOUT_MS = 5_000;

function firstTokenBase(command) {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return basename(first).replace(/^-/, "");
}

function isShellProcess(proc) {
  return SHELL_NAMES.has(firstTokenBase(proc.command));
}

function looksLikeAppServer(proc) {
  const base = firstTokenBase(proc.command);
  return base === "zcode-cli" || base === "zcode" || proc.command.includes("app-server --stdio");
}

export function extractRunIds(command) {
  const ids = [];
  DWFRUN_RE.lastIndex = 0;
  let m;
  while ((m = DWFRUN_RE.exec(command)) !== null) ids.push(m[1]);
  return ids;
}

async function listProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,cputime=,command="], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const procs = [];
  for (const line of stdout.split("\n")) {
    // ps 固定列 pid ppid cputime 后跟 command（command 本身含空格，不能按空白 split 整行）
    // cputime 形态：MM:SS / HH:MM:SS / DD-HH:MM:SS；取不到时为 null（快照对比按未知处理）
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cputime: m[3], command: m[4] });
  }
  return procs;
}

// 返回 null 表示 cwd 未知（lsof 失败/超时），与「取到了但不匹配」区分。
async function cwdOfProcess(pid) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: LSOF_TIMEOUT_MS,
    });
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function descendants(procs, rootPid) {
  const childrenOf = new Map();
  for (const p of procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export async function collectProcessSignals({ directory, activeRunIds }) {
  const procs = await listProcesses();
  const candidates = procs.filter(looksLikeAppServer);

  // 宿主绑定：对全部候选取 cwd，命中 directory 的都算（多窗口同目录场景），
  // shell 后代取并集。lsof 失败单独计数——全失败时无法断言宿主死活。
  const hostPids = [];
  let lsofFailures = 0;
  for (const candidate of candidates) {
    const cwd = await cwdOfProcess(candidate.pid);
    if (cwd === null) lsofFailures++;
    else if (cwd === directory) hostPids.push(candidate.pid);
  }

  // 沙箱：只认 db 报告的活跃 run id（交集判定，见文件头注释）。
  // run id 集合为空时直接跳过正则扫描，省 CPU。
  const activeRunIdSet = new Set(activeRunIds);
  const sandboxProcs = [];
  if (activeRunIdSet.size > 0) {
    for (const p of procs) {
      if (p.command.includes(".zcode/workflow-runs/") || p.command.includes("zcode-workflow-runs")) {
        for (const id of extractRunIds(p.command)) {
          if (activeRunIdSet.has(id)) {
            sandboxProcs.push({ pid: p.pid, runId: id });
            break;
          }
        }
      }
    }
  }

  // 同 workspace 其余沙箱进程（活跃集合之外）：不阻塞判定，只作提示信号，
  // 让调用方知道 workspace 里还有别的会话在跑 workflow。
  const foreignSandboxes = [];
  for (const p of procs) {
    if (!p.command.includes(".zcode/workflow-runs/")) continue;
    const ids = extractRunIds(p.command);
    if (ids.length === 0) continue;
    if (ids.some((id) => activeRunIdSet.has(id))) continue;
    if (!p.command.includes(directory)) continue;
    foreignSandboxes.push({ pid: p.pid, runId: ids[0] });
  }

  const hostShells = [];
  const seenShellPids = new Set();
  for (const hostPid of hostPids) {
    for (const d of descendants(procs, hostPid)) {
      if (seenShellPids.has(d.pid)) continue;
      if (!isShellProcess(d)) continue;
      seenShellPids.add(d.pid);
      hostShells.push({ pid: d.pid, cputime: d.cputime ?? null, command: d.command.slice(0, 120) });
    }
  }

  // 孤儿 shell（PPID=1）：宿主被 SIGKILL 后 detached 后台 bash 被 launchd 收养。
  // 与宿主死活无关始终采集；用户终端 nohup 的进程同样命中且无法归属，
  // 默认只提示不阻塞（--strict-orphan 升级为阻塞）。
  const orphanShells = procs
    .filter((p) => p.ppid === 1 && isShellProcess(p))
    .map((p) => ({ pid: p.pid, cputime: p.cputime ?? null, command: p.command.slice(0, 120) }));

  return {
    hostPids,
    hostCandidateCount: candidates.length,
    lsofFailures,
    sandboxProcs,
    hostShells,
    orphanShells,
    foreignSandboxes,
  };
}
