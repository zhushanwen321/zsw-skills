// sandbox.mjs — 隔离 worktree sandbox 创建与回收（sync-conformance-plane U3/M3）
//
// 语义权威（设计 sync-conformance-plane targetForm 第六段执行层 / D4 / G4）：
//   sandbox 机制固定为 git worktree：检出目录统一落 skill-data 段 sandbox 子段（目标仓外固定段），
//   不落在任何目标仓工作树内（本模块以 realpath 包含关系断言强制）。
//   宿主仓写入点由此穷举为四类（HOST_WRITE_POINTS）并全部登记：
//     ① .git/worktrees/<name>/ 管理区元数据 —— worktree add 即产生，机制生命周期内豁免项
//     ② worktree 临时分支                     —— 豁免项，受 remove 与清扫通道约束
//     ③ 管理区锁文件                          —— 豁免项
//     ④ 共享对象库 .git/objects               —— 裁决为禁止写入（D4 不采用豁免+清理通道）：
//        worktree 与宿主共用对象库，sandbox 内任何产对象命令都写宿主对象库（探针实测
//        git add 使 count 3→4）。agent 在 sandbox 内只用工作树级 diff 产补丁，产对象只
//        发生在集成器阶段（授权写者，两阶段提交创建 commit 对象属其职责）。
//   清理通道：变更集回收时 git worktree remove + prune；引擎启动期清扫 prunable 残留条目
//   与孤儿分支（实测：硬删 worktree 目录后 worktree list 仍列 prunable 残留，需 prune 清除）。
//   「正式仓零写入」口径：agent 执行期间目标仓工作树文件与 HEAD/ref、设计文档与共享对象库
//   零写入；①②③为 sandbox 机制生命周期内豁免项（V4/G4/RL4 同口径）。
//   对象库检测口径（G4 --no-shared-writes，运行期失守检测与测试共用）：agent 阶段前后宿主
//   git count-objects -v 的 count（松散）+ in-pack（打包）合计不变——合计口径对 gc 打包稳定。
//
// 禁令执行载体双防线（第六段）：① 模板 prompt 注入（U4 agent 契约，非本模块）；
// ② 运行期失守检测 = 收尾期对 manifest 内全部仓库逐仓 count-objects 对账（本模块
// measureObjectCounts 是该口径唯一实现点），红灯走失败契约，不自动清理。

import { existsSync, mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, isAbsolute } from "node:path";

/** 宿主写入点四类穷举清单（登记常量，第六段口径；kind ①②③豁免 / ④禁止） */
export const HOST_WRITE_POINTS = Object.freeze([
  {
    kind: "admin-metadata",
    path: ".git/worktrees/<name>/",
    policy: "lifecycle-exempt",
    note: "① 管理区元数据（HEAD/index/logs/refs）——worktree add 即产生，sandbox 机制生命周期内豁免项",
  },
  {
    kind: "worktree-branch",
    path: "refs/heads/<branch>",
    policy: "lifecycle-exempt",
    note: "② worktree 临时分支——豁免项，受 remove 与启动期清扫通道约束",
  },
  {
    kind: "admin-lock",
    path: ".git/worktrees/<name>/*.lock",
    policy: "lifecycle-exempt",
    note: "③ 管理区锁文件——豁免项",
  },
  {
    kind: "shared-object-store",
    path: ".git/objects",
    policy: "forbidden",
    note: "④ 共享对象库——裁决为禁止写入（D4）：sandbox 内禁产对象命令，agent 只用工作树级 diff 产补丁；产对象只发生在集成器阶段（授权写者）",
  },
]);

/** 禁产对象命令清单（第④类裁决的命令面；agent 在 sandbox 内禁止使用） */
export const FORBIDDEN_OBJECT_COMMANDS = Object.freeze(["add", "commit", "stash", "hash-object"]);

/** worktree 临时分支前缀（②类写入点的命名空间；清扫通道按此前缀识别孤儿分支） */
export const SANDBOX_BRANCH_PREFIX = "conformance-sandbox/";

function sandboxError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function git(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return r;
}

function gitOk(repoRoot, args, errCode, errPrefix) {
  const r = git(repoRoot, args);
  if (r.status !== 0) {
    throw sandboxError(errCode, `${errPrefix}失败（退出码 ${r.status}）：${(r.stderr || "").trim()}。恢复动作：核对宿主仓状态后重试；残留经 sweepHost 清扫。`);
  }
  return r.stdout;
}

/**
 * 对象库计数（G4 --no-shared-writes 检测口径唯一实现点）：count-objects -v 的
 * count（松散）+ in-pack（打包）合计——合计口径对 gc 打包操作稳定。
 * 引擎收尾期对 manifest 内全部仓库逐仓调用对账（多仓不外推）。
 */
export function measureObjectCounts(repoRoot) {
  const out = gitOk(repoRoot, ["count-objects", "-v"], "count-objects-failed", `git count-objects -v（${repoRoot}）`);
  const map = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(\w+):\s*(\d+)$/);
    if (m) map[m[1]] = Number(m[2]);
  }
  return { loose: map.count ?? 0, inPack: map["in-pack"] ?? 0, total: (map.count ?? 0) + (map["in-pack"] ?? 0) };
}

/** sandboxRoot 必须在目标仓工作树之外（第六段：检出目录落目标仓外固定段） */
function assertOutsideRepo(repoRoot, sandboxRoot) {
  const rel = relative(repoRoot, sandboxRoot);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw sandboxError(
      "sandbox-inside-host",
      `sandbox 检出目录 ${sandboxRoot} 落在目标仓 ${repoRoot} 内——违反第六段「不落在任何目标仓工作树内」。` +
        `恢复动作：把 sandboxRoot 指到 skill-data 段 sandbox 子段（目标仓外固定段）后重试。`,
    );
  }
}

/**
 * 创建隔离 worktree sandbox（worktree add + 临时分支，宿主写入点①②③）。
 *   repoRoot   目标仓根
 *   sandboxRoot skill-data 段 sandbox 子段（目标仓外；须已存在或可创建）
 *   changesetId 变更集 id（^[A-Za-z0-9._-]+$，作检出目录名与临时分支名后缀）
 *   ref         基线（缺省 HEAD）
 * 返回 { repoRoot, dir, branch, changesetId, baseCommit }。
 * 断言：检出目录已存在即拒绝（残留未清理，恢复动作指向 sweepHost）——不静默复用。
 */
export function createSandbox({ repoRoot, sandboxRoot, changesetId, ref }) {
  if (typeof changesetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(changesetId)) {
    throw sandboxError("invalid-changeset-id", `changesetId「${String(changesetId)}」不合法（须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]*$）。恢复动作：改用安全字符 id。`);
  }
  const realRepo = realpathSync(repoRoot);
  mkdirSync(sandboxRoot, { recursive: true });
  const realSandboxRoot = realpathSync(sandboxRoot);
  assertOutsideRepo(realRepo, realSandboxRoot);
  const dir = join(realSandboxRoot, changesetId);
  if (existsSync(dir)) {
    throw sandboxError(
      "sandbox-dir-exists",
      `检出目录已存在：${dir}（上次会话残留或 id 撞名）。恢复动作：跑 sweepHost 清扫 prunable 残留，或换新 changesetId。`,
    );
  }
  const branch = `${SANDBOX_BRANCH_PREFIX}${changesetId}`;
  const r = git(realRepo, ref !== undefined ? ["worktree", "add", "-b", branch, dir, ref] : ["worktree", "add", "-b", branch, dir]);
  if (r.status !== 0) {
    throw sandboxError("worktree-add-failed", `git worktree add 失败（退出码 ${r.status}）：${(r.stderr || "").trim()}。恢复动作：核对基线 ref 存在性与宿主仓状态后重试。`);
  }
  const baseCommit = gitOk(dir, ["rev-parse", "HEAD"], "sandbox-base-commit-failed", "读取 sandbox 基线 HEAD").trim();
  return { repoRoot: realRepo, dir, branch, changesetId, baseCommit };
}

/**
 * 回收 sandbox（第六段清理通道：worktree remove + prune + 删临时分支）。
 * sandbox 内容回收前必须已入 manifest（remove --force 丢弃工作树改动）。
 * 容错：目录已被硬删（崩溃注入形态）时跳过 remove，仍走 prune 清管理区残留。
 */
export function releaseSandbox(sandbox) {
  const { repoRoot, dir, branch } = sandbox;
  let removed = false;
  if (existsSync(dir)) {
    gitOk(repoRoot, ["worktree", "remove", "--force", dir], "worktree-remove-failed", `git worktree remove（${dir}）`);
    removed = true;
  }
  let branchDeleted = false;
  const listBranch = git(repoRoot, ["branch", "--list", branch]);
  if (listBranch.status === 0 && listBranch.stdout.trim() !== "") {
    gitOk(repoRoot, ["branch", "-D", branch], "branch-delete-failed", `删除临时分支 ${branch}`);
    branchDeleted = true;
  }
  gitOk(repoRoot, ["worktree", "prune"], "worktree-prune-failed", "git worktree prune");
  return { removed, branchDeleted };
}

/**
 * 启动期清扫（第六段）：prunable 残留条目（worktree prune）+ 孤儿临时分支
 * （prefix 命中且无 worktree 挂载）。宿主写入点②的回收通道。
 * 返回 { prunedEntries, removedBranches }。
 */
export function sweepHost({ repoRoot, branchPrefix = SANDBOX_BRANCH_PREFIX }) {
  const realRepo = realpathSync(repoRoot);
  const before = gitOk(realRepo, ["worktree", "list", "--porcelain"], "worktree-list-failed", "git worktree list --porcelain");
  const prunableEntries = [];
  for (const block of before.split("\n\n")) {
    if (block.includes("prunable")) {
      const line = block.split("\n").find((l) => l.startsWith("worktree "));
      prunableEntries.push(line ? line.slice("worktree ".length) : "(unknown)");
    }
  }
  gitOk(realRepo, ["worktree", "prune"], "worktree-prune-failed", "git worktree prune");
  // 孤儿分支：prefix 命中且未被任何挂载 worktree 占用
  const mounted = new Set(
    before
      .split("\n")
      .filter((l) => l.startsWith("branch "))
      .map((l) => l.slice("branch ".length).trim()),
  );
  const removedBranches = [];
  const refs = gitOk(realRepo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], "for-each-ref-failed", "git for-each-ref");
  for (const ref of refs.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith(branchPrefix)) continue;
    if (mounted.has(ref)) continue;
    gitOk(realRepo, ["branch", "-D", ref], "branch-delete-failed", `清扫孤儿分支 ${ref}`);
    removedBranches.push(ref);
  }
  return { prunedEntries: prunableEntries, removedBranches };
}

/**
 * 宿主管理区不变量探针（U3 检查点 / V15）：worktree list / branch / status 的机器判定形态。
 * 返回 { worktreeEntries, sandboxBranches, dirtyFiles }——三者全空 = 无残留。
 */
export function hostResidueProbe(repoRoot, { branchPrefix = SANDBOX_BRANCH_PREFIX } = {}) {
  const realRepo = realpathSync(repoRoot);
  const list = gitOk(repoRoot, ["worktree", "list", "--porcelain"], "worktree-list-failed", "git worktree list --porcelain");
  const worktreeEntries = [];
  for (const block of list.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    if (!line) continue;
    const path = line.slice("worktree ".length).trim();
    // realpath 归一化比较（git 输出形态随平台 symlink 前缀差异，如 darwin /tmp → /private/tmp）
    let realPath = path;
    try {
      realPath = realpathSync(path);
    } catch {
      /* 已消失的 prunable 残留路径按原样保留 */
    }
    if (realPath === realRepo) continue; // 宿主自身主工作树不算残留
    worktreeEntries.push(path);
  }
  const refs = gitOk(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], "for-each-ref-failed", "git for-each-ref");
  const sandboxBranches = refs.split("\n").map((s) => s.trim()).filter((r) => r.startsWith(branchPrefix));
  const status = gitOk(repoRoot, ["status", "--porcelain"], "status-failed", "git status --porcelain");
  const dirtyFiles = status.split("\n").filter((l) => l.trim() !== "");
  return { worktreeEntries, sandboxBranches, dirtyFiles };
}

/** sandbox 内禁产对象命令清单的运行时提示（agent 阶段检查义务；检测载体见 HOST_WRITE_POINTS[3]） */
export function assertNoObjectCommands(commands) {
  const offenders = commands.filter((c) => FORBIDDEN_OBJECT_COMMANDS.includes(c));
  if (offenders.length > 0) {
    throw sandboxError(
      "forbidden-object-command",
      `sandbox 内禁用产对象命令（第④类裁决）：${offenders.join(", ")}。` +
        `恢复动作：改用工作树级 diff 产补丁（git diff / git diff --no-index）；产对象只发生在集成器阶段。`,
    );
  }
}
