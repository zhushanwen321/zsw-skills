// manifest.mjs — 多仓补丁 manifest：每仓补丁文件 + 基准快照 + 目标树哈希（sync-conformance-plane U3/M3）
//
// 语义权威（设计 sync-conformance-plane）：
//   D5   每个变更集携带多仓补丁 manifest 与逐仓目标树哈希；集成结果逐仓可追溯（GA5/GA12）
//   第六段  agent 只用工作树级 diff 产补丁（第④类禁产对象裁决）——本模块全部 git 调用为
//          只读或工作树级（git diff / git diff --no-index / rev-parse），零对象写入；
//          新文件（untracked）用 git diff --no-index -- /dev/null <file> 拼接补丁
//          （探针实测：git add -N 使宿主 count 3→4 写对象库，故禁用；--no-index 拼接零写入）
//   树哈希口径：目标树哈希 = 变更文件集 { 相对路径 → 内容 sha256 } 的规范化 JSON 哈希
//          （canonicalJson + hashContent）——工作树级内容哈希，不用 git write-tree
//          （write-tree 写宿主对象库，agent 阶段禁止）。基准快照 = baseCommit + 其 tree id
//          （rev-parse 只读引用既有对象，不新写）。
//   变更集哈希不可变：manifest 落盘时登记 changesetHash = 规范化内容哈希；集成器消费前
//   verifyManifest 重算对账，任何篡改（补丁/基准/树哈希被改）即拒绝。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { hashContent } from "../kernel/evidence.mjs";
import { canonicalJson } from "../kernel/facts.mjs";

function manifestError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function git(repoRoot, args, opts = {}) {
  return spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** git status --porcelain -z 解析：{ tracked: [rel], untracked: [rel] }（重命名两段 NUL 均归 tracked） */
function workingTreeChanges(sandboxDir) {
  const r = git(sandboxDir, ["status", "--porcelain", "-z"]);
  if (r.status !== 0) {
    throw manifestError("status-failed", `git status 失败：${(r.stderr || "").trim()}。恢复动作：核对 sandbox 工作树状态。`);
  }
  const tokens = r.stdout.split("\0").filter((t) => t !== "");
  const tracked = [];
  const untracked = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("??")) {
      untracked.push(t.slice(3));
    } else {
      tracked.push(t.slice(3));
      // rename 形态 "R  old\0new"：下一 token 是新路径，同为 tracked
      if (/^[ARC]/.test(t) && i + 1 < tokens.length && !tokens[i + 1].match(/^[ MADRCU?]{2}/)) {
        i += 1;
        tracked.push(tokens[i]);
      }
    }
  }
  return { tracked, untracked };
}

/** 工作树级 tracked diff（含删除；不含 untracked——零对象写入） */
function trackedDiff(sandboxDir, pathspec) {
  const args = ["diff", "--"];
  if (pathspec && pathspec.length > 0) args.push(...pathspec);
  const r = git(sandboxDir, args);
  if (r.status !== 0) {
    throw manifestError("diff-failed", `git diff 失败：${(r.stderr || "").trim()}。恢复动作：核对 sandbox 工作树状态。`);
  }
  return r.stdout;
}

/** untracked 新文件补丁（git diff --no-index -- /dev/null <file>；exit 1 = 有差异属正常） */
function untrackedDiff(sandboxDir, relPath) {
  // 第二参数必须传相对路径（相对 sandboxDir）：绝对路径会让补丁头携带完整绝对形态
  //（+++ b/tmp/.../x.txt），git apply -p1 后静默写进错误嵌套路径（2026-11-10 实证）
  const r = spawnSync("git", ["-C", sandboxDir, "diff", "--no-index", "--", "/dev/null", relPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== 1) {
    throw manifestError("diff-no-index-failed", `git diff --no-index 失败（${relPath}）：${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

/** 变更文件集的目标树哈希：{ relPath → 内容 sha256（删除记 null）} 的规范化 JSON 哈希（工作树级口径） */
function targetTreeHashOf(sandboxDir, changedFiles) {
  const table = {};
  for (const rel of [...changedFiles].sort()) {
    const abs = join(sandboxDir, rel);
    table[rel] = existsSync(abs) ? hashContent(readFileSync(abs)) : null;
  }
  return createHash("sha256").update(canonicalJson(table)).digest("hex");
}

/**
 * 从 sandbox 工作树收集单仓变更 → manifest 条目（零对象写入）。
 * sandbox = createSandbox 返回；files 可选限定 pathspec（缺省全部变更）。
 */
function collectRepoEntry({ repoId, repoRoot, sandbox, files }) {
  const { tracked, untracked } = workingTreeChanges(sandbox.dir);
  const limit = files && files.length > 0 ? new Set(files) : null;
  const keepTracked = limit ? tracked.filter((p) => limit.has(p)) : tracked;
  const keepUntracked = limit ? untracked.filter((p) => limit.has(p)) : untracked;
  const patch = trackedDiff(sandbox.dir, limit ? [...keepTracked] : undefined) +
    keepUntracked.map((rel) => untrackedDiff(sandbox.dir, rel)).join("");
  const changedFiles = [...keepTracked, ...keepUntracked].sort();
  const baseTreeSha = git(sandbox.dir, ["rev-parse", `${sandbox.baseCommit}^{tree}`]);
  if (baseTreeSha.status !== 0) {
    throw manifestError("base-tree-failed", `读取基准 tree 失败：${(baseTreeSha.stderr || "").trim()}。恢复动作：核对 sandbox 基线 commit。`);
  }
  return {
    repoId,
    realRoot: realpathSync(repoRoot),
    baseRef: sandbox.branch,
    baseCommit: sandbox.baseCommit,
    baseTreeHash: baseTreeSha.stdout.trim(),
    patchFile: `${repoId}.patch`,
    patchHash: hashContent(patch),
    hasChanges: patch.length > 0,
    changedFiles,
    targetTreeHash: targetTreeHashOf(sandbox.dir, changedFiles),
    patch,
  };
}

/**
 * 给定补丁文本的单仓 manifest 条目（doc-proposals manual 门径流：文档变更在集成前不落
 * 正式仓工作树，补丁由提案内容本地生成）。patch/changedFiles/targetTreeHash 由调用方给出
 * （targetTreeHash 按同一 {path → 内容哈希} 规范化口径预计算）。
 */
export function buildRepoEntry({ repoId, repoRoot, baseRef, baseCommit, patch, changedFiles, targetTreeHash }) {
  const baseTreeSha = git(repoRoot, ["rev-parse", `${baseCommit}^{tree}`]);
  if (baseTreeSha.status !== 0) {
    throw manifestError("base-tree-failed", `读取基准 tree 失败：${(baseTreeSha.stderr || "").trim()}。恢复动作：核对基线 commit。`);
  }
  return {
    repoId,
    realRoot: realpathSync(repoRoot),
    baseRef,
    baseCommit,
    baseTreeHash: baseTreeSha.stdout.trim(),
    patchFile: `${repoId}.patch`,
    patchHash: hashContent(patch),
    hasChanges: patch.length > 0,
    changedFiles: [...changedFiles].sort(),
    targetTreeHash,
    patch,
  };
}

/** manifest 规范化内容的哈希（changesetHash 口径：changesetId + createdAt + repos） */
function manifestContentHash(manifest) {
  return hashContent(
    canonicalJson({
      changesetId: manifest.changesetId,
      createdAt: manifest.createdAt,
      repos: manifest.repos,
    }),
  );
}

/**
 * 构造不可变 manifest 对象（changesetHash = 规范化内容哈希；此后任何内容变化 verifyManifest 即拒绝）。
 * entries = collectRepoEntry / buildRepoEntry 产物数组（已含 patch 文本）。
 */
export function buildManifestObject({ changesetId, entries, createdAt }) {
  const manifest = {
    changesetId,
    createdAt: createdAt ?? new Date().toISOString(),
    repos: entries.map(({ patch, ...rest }) => rest),
  };
  const changesetHash = manifestContentHash(manifest);
  return { ...manifest, changesetHash, _patches: entries.map((e) => ({ repoId: e.repoId, patch: e.patch })) };
}

/**
 * 从 N 个 sandbox 收集多仓变更并落盘 manifest（变更集段 = outDir，skill-data 注入）。
 * repos = [{ repoId, repoRoot, sandbox, files? }]。
 * 落盘 outDir/manifest.json 与 outDir/<repoId>.patch；返回 manifest 对象。
 */
export function createManifest({ changesetId, repos, outDir, createdAt }) {
  if (!Array.isArray(repos) || repos.length === 0) {
    throw manifestError("manifest-repos-empty", "manifest 至少含一个仓库条目。恢复动作：核对变更集的多仓清单。");
  }
  const ids = new Set();
  for (const r of repos) {
    if (ids.has(r.repoId)) throw manifestError("duplicate-repo-id", `repoId「${r.repoId}」在 manifest 内重复。恢复动作：repoId 唯一。`);
    ids.add(r.repoId);
  }
  mkdirSync(outDir, { recursive: true });
  const entries = repos.map((r) => collectRepoEntry(r));
  const manifest = buildManifestObject({ changesetId, entries, createdAt });
  for (const e of entries) {
    writeFileSync(join(outDir, e.patchFile), e.patch);
  }
  const { _patches, ...persisted } = manifest;
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(persisted, null, 2));
  return manifest;
}

/**
 * 变更集哈希不可变校验：重算规范化内容哈希与登记 changesetHash 对账。
 * 返回 { ok, reason? }；篡改补丁/基准/树哈希任一字段即 ok=false。
 */
export function verifyManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || typeof manifest.changesetHash !== "string") {
    return { ok: false, reason: "manifest 形态非法或缺 changesetHash" };
  }
  const actual = manifestContentHash(manifest);
  if (actual !== manifest.changesetHash) {
    return { ok: false, reason: `changesetHash 不符（登记 ${manifest.changesetHash}，重算 ${actual}）——变更集内容已被篡改或损坏` };
  }
  return { ok: true };
}

/** 读盘 + 校验（集成器消费入口）；篡改即抛错（manifest-tampered，恢复动作 = 重新生成变更集） */
export function readManifest(manifestDir) {
  const p = join(manifestDir, "manifest.json");
  if (!existsSync(p)) {
    throw manifestError("manifest-missing", `manifest 不存在：${p}。恢复动作：核对变更集段路径，或重新生成变更集。`);
  }
  const manifest = JSON.parse(readFileSync(p, "utf8"));
  const v = verifyManifest(manifest);
  if (!v.ok) {
    throw manifestError("manifest-tampered", `${v.reason}。恢复动作：拒绝该变更集，基于新基线重新生成（冲突补丁不自动变基）。`);
  }
  const patches = {};
  for (const repo of manifest.repos) {
    const pp = join(manifestDir, repo.patchFile);
    const patch = existsSync(pp) ? readFileSync(pp, "utf8") : null;
    if (patch === null) {
      throw manifestError("patch-missing", `补丁文件缺失：${pp}。恢复动作：重新生成变更集。`);
    }
    if (hashContent(patch) !== repo.patchHash) {
      throw manifestError("manifest-tampered", `补丁文件 ${repo.patchFile} 与 patchHash 不符——变更集已被篡改。恢复动作：重新生成变更集。`);
    }
    patches[repo.repoId] = patch;
  }
  return { manifest, patches, dir: manifestDir };
}
