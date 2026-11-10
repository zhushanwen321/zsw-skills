// inventory.mjs — workspace 真实路径仓库清单提案与确认命令（sync-conformance-plane U3/M3）
//
// 语义权威（设计 sync-conformance-plane）：
//   D5   setup 自动提出 workspace 清单（repoId、真实根、允许编辑根、默认分支），主 agent 确认；
//        不采用 projectRoot 词法前缀——符号链接解析为真实仓库（GA5：多仓从隐式符号链接变为显式清单）
//   G5 --unknown-repository  未登记仓库、符号链接逃逸与 Git 根不一致必须拒启
//   U3 检查点  夹具五类：根仓 / 普通子目录 / 符号链接目标仓 / gitignore 命中路径 / 未登记仓库拒启
//
// 扫描口径：
//   - workspace 根自身是 Git 仓 → source="root"；其内的独立 Git 仓（子目录）→ source="subdir"；
//     子目录为符号链接且目标为 Git 仓 → source="symlink"（真实根 = realpath 目标，仓在 workspace 外可达）
//   - gitignore 命中路径：根仓以 .gitignore 显式声明该路径不属于自己（依赖仓副本 / node_modules 类），
//     命中路径下的 Git 仓不进提案、不参与未登记判定（判定走 git check-ignore 权威原语，不自造匹配引擎）
//   - Git 根不一致：登记路径 realpath ≠ 该路径的 git rev-parse --show-toplevel（登记指向仓中间目录 /
//     非仓路径），或登记真实根不在 workspace 可达集 → 拒启
//   - 未登记仓库：扫描发现（非 gitignore 命中）的 Git 根不在登记清单；符号链接形态单列为符号链接逃逸
//
// 本模块只读（全部 git 调用为只读原语：check-ignore / rev-parse），对 workspace 与项目仓零写入。

import { existsSync, readdirSync, realpathSync, lstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, relative, isAbsolute, sep } from "node:path";

/** 扫描深度缺省（workspace 根下三层足够覆盖根仓/子仓/链接目标形态；declared 显式登记不受此限） */
export const DEFAULT_MAX_DEPTH = 3;

function inventoryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** dir 是否为 Git 仓根（.git 可为目录——普通仓，或文件——worktree/子模块形态） */
function isGitRoot(dir) {
  return existsSync(join(dir, ".git"));
}

/** 仓的默认分支（只读）；detached HEAD 返回 "HEAD" */
function defaultBranchOf(repoRoot) {
  const r = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : "HEAD";
}

/**
 * 扫描 workspace 发现 Git 根候选。BFS：workspace 根自身（source=root）继续下探；
 * 发现的子 Git 根（subdir/symlink）不再深入（嵌套仓归属子仓自身，不外推给 workspace 清单）。
 * 返回候选 [{ realRoot, linkPath?, source }]，realRoot 已 realpath 去重。
 */
function discoverGitRoots(projectRoot, maxDepth) {
  const found = [];
  const seenReal = new Set();
  const addCandidate = (cand) => {
    const real = cand.realRoot;
    const key = real;
    if (seenReal.has(key)) return;
    seenReal.add(key);
    found.push(cand);
  };
  if (isGitRoot(projectRoot)) {
    addCandidate({ realRoot: projectRoot, source: "root" });
  }
  const queue = [{ abs: projectRoot, depth: 0 }];
  while (queue.length > 0) {
    const { abs, depth } = queue.shift();
    let names;
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const full = join(abs, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(full);
        } catch {
          continue; // 悬空符号链接：不产候选也不拒启（无仓可登记）
        }
        let tStat;
        try {
          tStat = statSync(target);
        } catch {
          continue;
        }
        if (tStat.isDirectory() && isGitRoot(target)) {
          addCandidate({ realRoot: target, linkPath: full, source: "symlink" });
        } else if (tStat.isDirectory() && depth + 1 < maxDepth) {
          queue.push({ abs: target, depth: depth + 1 }); // 链接到普通目录：深入目标目录继续找
        }
        continue;
      }
      if (!st.isDirectory()) continue;
      if (isGitRoot(full)) {
        addCandidate({ realRoot: full, source: "subdir" });
        continue; // Git 根内部不再下探
      }
      if (depth + 1 < maxDepth) queue.push({ abs: full, depth: depth + 1 });
    }
  }
  return found;
}

/**
 * 批量 gitignore 判定（git check-ignore 权威原语，--stdin 批量零竞态）。
 * 返回命中的 relPath 集合。候选键 = 符号链接路径或子目录相对路径（gitignore 只作用于
 * workspace 根仓工作树内的路径，符号链接按链接自身路径判定）。
 */
function gitIgnoreHits(projectRoot, relPaths) {
  const hits = new Set();
  // check-ignore 权威原语逐路径判定：0 = 命中；1 = 未命中；其他 = 环境错误按未命中（根仓无 .gitignore 场景）
  for (const rel of relPaths) {
    const one = spawnSync("git", ["-C", projectRoot, "check-ignore", "--quiet", rel], { encoding: "utf8" });
    if (one.status === 0) hits.add(rel);
  }
  return hits;
}

/** 候选在工作树内的判定键（符号链接用链接路径，子目录用相对路径；根仓自身无键 = 永不受 gitignore 过滤） */
function candidateScanKey(projectRoot, cand) {
  if (cand.source === "root") return null;
  const raw = cand.linkPath ?? cand.realRoot;
  const rel = relative(projectRoot, raw);
  return rel.split(sep).join("/");
}

/**
 * workspace 清单提案（setup 自动提出，主 agent 确认后生效）。
 *   declared = [{ repoId, path, editableRoot? }]（path 相对 workspace 根或绝对；登记即授权意图）
 * 返回 { ok, proposal, findings }；findings 任一非空 → ok=false（拒启，G5）：
 *   unregistered     扫描发现（非 gitignore 命中）但未登记的 Git 根
 *   escapedSymlinks  符号链接指向未登记仓库（符号链接逃逸）
 *   ignored          gitignore 命中路径下的 Git 根（不进提案，登记备查）
 *   rootMismatch     登记路径非法：非仓 / 指向仓中间目录（toplevel 不符）/ 真实根不在可达集
 * proposal 条目 = { repoId, realRoot, editableRoot, defaultBranch, source }
 */
export function proposeWorkspaceInventory({ projectRoot, declared, maxDepth = DEFAULT_MAX_DEPTH }) {
  if (!isGitRoot(projectRoot)) {
    throw inventoryError(
      "workspace-root-not-git",
      `workspace 根不是 Git 仓：${projectRoot}。恢复动作：核对 workspace 根路径（须为根仓）。`,
    );
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw inventoryError(
      "declared-repos-empty",
      "登记清单为空——workspace 清单至少登记根仓。恢复动作：declared 补 [{ repoId, path }] 后重试。",
    );
  }
  const realProject = realpathSync(projectRoot);
  const candidates = discoverGitRoots(realProject, maxDepth);

  // gitignore 过滤（根仓自身永不过滤）
  const scanKeys = candidates.map((c) => ({ cand: c, key: candidateScanKey(realProject, c) }));
  const ignoredKeys = gitIgnoreHits(
    realProject,
    scanKeys.map((s) => s.key).filter((k) => k !== null),
  );

  const unregistered = [];
  const escapedSymlinks = [];
  const ignored = [];
  for (const { cand, key } of scanKeys) {
    if (key !== null && ignoredKeys.has(key)) {
      ignored.push({ path: key, realRoot: cand.realRoot, source: cand.source });
    }
  }
  const ignoredReal = new Set(ignored.map((i) => i.realRoot));

  // 登记路径解析（Git 根一致性：realpath(登记路径) 必须 = 该路径 git toplevel 的 realpath）
  const registeredByReal = new Map(); // realRoot -> declared 条目
  const rootMismatch = [];
  const proposalDrafts = [];
  for (const d of declared) {
    const absPath = isAbsolute(d.path) ? d.path : resolve(realProject, d.path);
    let real;
    try {
      real = realpathSync(absPath);
    } catch {
      rootMismatch.push({ repoId: d.repoId, path: d.path, reason: "路径不存在" });
      continue;
    }
    if (typeof d.repoId !== "string" || d.repoId.trim() === "") {
      rootMismatch.push({ repoId: String(d.repoId), path: d.path, reason: "repoId 缺失或为空" });
      continue;
    }
    const top = git(real, ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) {
      rootMismatch.push({ repoId: d.repoId, path: d.path, reason: "登记路径不是 Git 仓" });
      continue;
    }
    const topLevel = realpathSync(top.stdout.trim());
    if (topLevel !== real) {
      rootMismatch.push({
        repoId: d.repoId,
        path: d.path,
        reason: `登记路径指向仓中间目录（Git 根在 ${topLevel}）——登记须指向仓根`,
      });
      continue;
    }
    const cand = candidates.find((c) => c.realRoot === real);
    if (!cand) {
      rootMismatch.push({
        repoId: d.repoId,
        path: d.path,
        reason: "登记真实根不在 workspace 可达集（非根仓/子目录仓/符号链接目标）",
      });
      continue;
    }
    if (ignoredReal.has(real)) {
      rootMismatch.push({
        repoId: d.repoId,
        path: d.path,
        reason: "登记路径被根仓 .gitignore 命中——gitignore 声明路径不进清单，移除登记或调整 .gitignore",
      });
      continue;
    }
    registeredByReal.set(real, d);
    const editable = d.editableRoot !== undefined ? realpathSync(isAbsolute(d.editableRoot) ? d.editableRoot : resolve(real, d.editableRoot)) : real;
    if (editable !== real) {
      const relEditable = relative(real, editable);
      if (relEditable.startsWith("..") || isAbsolute(relEditable)) {
        rootMismatch.push({ repoId: d.repoId, path: d.path, reason: "editableRoot 不在仓库真实根内" });
        continue;
      }
    }
    proposalDrafts.push({
      repoId: d.repoId,
      realRoot: real,
      editableRoot: editable,
      defaultBranch: defaultBranchOf(real),
      source: cand.source,
    });
  }

  // 未登记判定：可达（非 gitignore 命中）候选全部要已登记；符号链接形态单列
  for (const { cand, key } of scanKeys) {
    if (key !== null && ignoredKeys.has(key)) continue;
    if (registeredByReal.has(cand.realRoot)) continue;
    if (cand.source === "symlink") {
      escapedSymlinks.push({ linkPath: key, realRoot: cand.realRoot });
    } else {
      unregistered.push({ path: key ?? "(workspace 根)", realRoot: cand.realRoot, source: cand.source });
    }
  }

  const findings = { unregistered, escapedSymlinks, ignored, rootMismatch };
  const ok = unregistered.length === 0 && escapedSymlinks.length === 0 && rootMismatch.length === 0;
  // 拒启时不产出提案（findings 已指名详情）——防止消费方在拒启态误用半成品清单
  const proposal = ok
    ? proposalDrafts.sort((a, b) => (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0))
    : [];
  return { ok, proposal, findings };
}

/**
 * 主 agent 确认命令（D5：setup 提案 → 主 agent 确认生效）。
 * confirmedRepoIds 必须是提案 repoId 的非空子集；含提案外 id 或空集拒绝（inventory-repo-unknown / inventory-confirm-empty）。
 * 返回 { inventory, confirmedBy }——inventory 条目即运行时消费的多仓清单（真实根口径）。
 */
export function confirmWorkspaceInventory({ proposal, confirmedRepoIds, actor }) {
  if (typeof actor !== "string" || actor.trim() === "") {
    throw inventoryError("inventory-actor-missing", "确认必须携带 actor（主 agent 身份）。恢复动作：以确认者身份重发确认。");
  }
  const known = new Map(proposal.map((p) => [p.repoId, p]));
  const ids = [...new Set(confirmedRepoIds)];
  if (ids.length === 0) {
    throw inventoryError("inventory-confirm-empty", "确认清单为空——至少确认一个仓库。恢复动作：从提案 repoId 中选择后重新确认。");
  }
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw inventoryError(
      "inventory-repo-unknown",
      `确认含提案外 repoId：${unknown.join(", ")}（提案：${proposal.map((p) => p.repoId).join(", ")}）。恢复动作：只确认提案内仓库。`,
    );
  }
  const inventory = ids.map((id) => Object.freeze({ ...known.get(id) }));
  return { inventory, confirmedBy: actor };
}
