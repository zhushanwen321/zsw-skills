// integrator.mjs — 集成器：正式仓唯一写入门径（sync-conformance-plane U3/M3）
//
// 语义权威（设计 sync-conformance-plane targetForm 第六段执行层 / D4 / AX7 / V5 / V15）：
//   AX7   集成器是正式仓唯一写入门径；人工接管以 actor=main-agent 的 manual 模式走同一门径
//   预检  集成前对全部仓库做 apply 预检并逐仓执行宿主 pre-commit 挂钩（按该仓 core.hooksPath
//         挂载点作用于 staged 变更）；挂钩非零退出与预检失败同归类为集成失败，全部不应用
//   事件  两个失败分支各有独立审计事件可区分（字段契约 = 四要素：逐仓命令、退出码、摘要与恢复动作）：
//           apply 预检失败        → IntegrationPrecheckFailed
//           挂钩拒绝              → IntegrationGateChecked { failure: true, hookPath }
//         两分支同终值 failed、事件可区分。两阶段提交（先创建全部 commit 对象、再逐仓移动 ref）
//         在 ref 移动时不隐式触发挂钩——该绕过以预检已执行同一挂钩为前提并同样写
//         IntegrationGateChecked（failure=false，摘要记录绕过前提、恢复动作栏记「非失败记录，无需恢复」），
//         不静默。ref 移动失败按已记录回滚计划恢复、终值 rolled-back（专属终值，可判定）。
//   版本纪律  触及技能自有文件或共享源的补丁必须自带版本 bump（SKILL.md frontmatter version），
//         缺失即预检红灯（宿主 pre-commit 段 3 check-version-discipline.mjs 同规：
//         判定 = 补丁中 version 行与基线不等，即 staged ≠ HEAD 口径的补丁形态投影）
//   冲突  补丁冲突不自动变基：拒绝该变更集并生成重生成任务
//   事件写出走 kernel（facts schema 校验 + state-repo appendCommands）——RecordIntegrationGate /
//   RecordIntegrationPrecheckFailure 命令经 validateCommand 校验后入流（词表分裂不可能）。

import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { verifyManifest } from "../changeset/manifest.mjs";
import { appendCommands } from "../kernel/state-repo.mjs";

/** 集成终值词表（integrationOutcome 子集；not-required 等非本门径产出） */
export const INTEGRATION_OUTCOMES = Object.freeze(["integrated", "failed", "rolled-back"]);

/** manual 模式的唯一合法 actor（第六段：人工接管以 actor=main-agent 走同一集成器） */
export const MANUAL_ACTOR = "main-agent";

const VERSION_LINE_RE = /^[-+]\s*version:\s*(\d+\.\d+\.\d+)\s*$/;

function integrationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function git(repoRoot, args, opts = {}) {
  return spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** 宿主 pre-commit 挂钩路径（core.hooksPath 挂载点；相对配置相对仓根解析；未配置时 .git/hooks） */
export function resolveHookPath(repoRoot, hookName = "pre-commit") {
  const cfg = git(repoRoot, ["config", "--get", "core.hooksPath"]);
  let hooksDir;
  if (cfg.status === 0 && cfg.stdout.trim() !== "") {
    const raw = cfg.stdout.trim();
    hooksDir = isAbsolute(raw) ? raw : join(repoRoot, raw);
  } else {
    hooksDir = join(repoRoot, ".git", "hooks");
  }
  const hook = join(hooksDir, hookName);
  return existsSync(hook) ? hook : null;
}

/**
 * 版本纪律判定（宿主 check-version-discipline.mjs 规则 1 的补丁形态投影）：
 * 补丁触及技能自有文件目录（dir 前缀）→ 同一补丁必须含对应 skillMd 的 version 行变更
 * （+version 值不在 -version 基线集中 = bump，即 staged ≠ HEAD 口径）。返回违规清单（空 = 通过）。
 */
export function checkVersionDiscipline({ patch, versionDiscipline }) {
  const skills = versionDiscipline?.skills ?? [];
  const violations = [];
  const changedFiles = new Set(
    [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((m) => m[2]),
  );
  for (const skill of skills) {
    const touched = [...changedFiles].filter((p) => p === skill.dir || p.startsWith(`${skill.dir}/`));
    if (touched.length === 0) continue;
    // 提取该 skillMd 的 diff 段：version 行 -/+ 值集对账（+ 值不在 - 集中 = bump）
    const diffSections = patch.split(/^diff --git /m).slice(1);
    const section = diffSections.find((s) => s.startsWith(`a/${skill.skillMd} b/${skill.skillMd}`));
    const changes = section
      ? section.split("\n").map((l) => l.match(VERSION_LINE_RE)).filter(Boolean)
          .map((m) => ({ sign: m[0].trim()[0], version: m[1] }))
      : [];
    const from = new Set(changes.filter((c) => c.sign === "-").map((c) => c.version));
    const to = changes.filter((c) => c.sign === "+").map((c) => c.version);
    const bumped = to.some((v) => !from.has(v));
    if (!bumped) {
      violations.push({
        repoFile: touched[0],
        skillMd: skill.skillMd,
        detail: to.length === 0
          ? "补丁未含 version 行变更（frontmatter version 未 bump）"
          : `补丁 version 行非 bump 形态（${[...from].join("/")} → ${to.join("/")}）`,
      });
    }
  }
  return violations;
}

/** 事件命令（kernel 词表）：预检失败 / 挂钩审计两形态，字段契约四要素 */
function precheckFailedCommand(actor, payload) {
  return { type: "RecordIntegrationPrecheckFailure", actor, payload };
}
function gateCheckedCommand(actor, payload) {
  return { type: "RecordIntegrationGate", actor, payload };
}

/** 补丁中的新增文件清单（--- /dev/null 形态）——失败仓工作树恢复时需删除（checkout 不清 untracked） */
function newFilesFromPatch(patch) {
  const out = [];
  const heads = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  heads.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < heads.length ? heads[i + 1].index : patch.length;
    const body = patch.slice(start, end);
    if (/^--- \/dev\/null$/m.test(body)) out.push(m[2]);
  });
  return out;
}

/** 临时 index 文件（挂钩 staged 形态与两阶段提交 write-tree 共用机制；落系统临时目录，用完删除） */
function makeTempIndex(tag) {
  const dir = mkdtempSync(join(tmpdir(), `conf-int-${tag}-`));
  const indexFile = join(dir, "index");
  return { dir, indexFile };
}

function withTempIndex(tag, fn) {
  const t = makeTempIndex(tag);
  try {
    return fn(t.indexFile);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

/**
 * 集成变更集（唯一正式仓写入门径）。
 *   source          readManifest 产物 { manifest, patches, dir } 或 { manifest, patches }（调用方已读盘）
 *   stateRoot       状态仓根（审计事件入流处；null = 不写事件，仅供测试探针）
 *   actor / mode    mode="manual" 时 actor 必须 = "main-agent"（同一门径）
 *   targetBranches  repoId → 集成目标分支（缺省 = 该仓当前 HEAD 分支）
 *   versionDiscipline { skills: [{ dir, skillMd }] }（缺省无技能根 = 版本纪律不触发）
 * 返回 { outcome, perRepo, events, regenerateTask? }。
 */
export async function integrateChangeset(source, {
  stateRoot = null,
  actor = "integration-writer",
  mode = "agent",
  targetBranches = {},
  versionDiscipline = { skills: [] },
} = {}) {
  if (mode === "manual" && actor !== MANUAL_ACTOR) {
    throw integrationError(
      "invalid-manual-actor",
      `manual 模式 actor 必须 = "${MANUAL_ACTOR}"（第六段：人工接管走同一门径），实际「${actor}」。` +
        `恢复动作：以 ${MANUAL_ACTOR} 身份重发，或改用 agent 模式。`,
    );
  }
  const { manifest, patches } = source;
  // 变更集哈希不可变校验（篡改拒绝；readManifest 已校验，此处兜底直传对象形态）
  const integrity = verifyManifest(manifest);
  if (!integrity.ok) {
    throw integrationError("manifest-tampered", `${integrity.reason}。恢复动作：拒绝该变更集，基于新基线重新生成。`);
  }

  const repos = manifest.repos.map((repo) => {
    const branch = targetBranches[repo.repoId] ?? git(repo.realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    return { ...repo, patch: patches[repo.repoId] ?? "", targetBranch: branch };
  });

  const perRepo = [];
  const events = [];
  const writeEvents = async (cmds) => {
    if (stateRoot === null || cmds.length === 0) return;
    await appendCommands(stateRoot, cmds);
    events.push(...cmds.map((c) => c.type));
  };

  // ── 回滚计划：记录各仓目标分支当前 ref 值（ref 移动失败按此恢复，终值 rolled-back）──
  const rollbackPlan = new Map();
  for (const repo of repos) {
    const refShow = git(repo.realRoot, ["rev-parse", `refs/heads/${repo.targetBranch}`]);
    if (refShow.status !== 0) {
      throw integrationError(
        "target-branch-missing",
        `仓 ${repo.repoId} 目标分支 refs/heads/${repo.targetBranch} 不存在。恢复动作：核对 targetBranches 参数或该仓分支状态。`,
      );
    }
    rollbackPlan.set(repo.repoId, { branch: repo.targetBranch, baseRefSha: refShow.stdout.trim() });
  }

  // ── 预检阶段（全量先行，任何失败 = 全量不应用）──
  const precheckCommands = [];
  const precheckFailures = [];
  for (const repo of repos) {
    if (!repo.hasChanges) {
      perRepo.push({ repoId: repo.repoId, status: "no-changes" });
      continue;
    }
    // a. 补丁可应用（git apply --check 零写入）
    const tmpPatch = mkdtempSync(join(tmpdir(), `conf-precheck-`));
    const patchFile = join(tmpPatch, `${repo.repoId}.patch`);
    writeFileSync(patchFile, repo.patch);
    let r;
    try {
      r = git(repo.realRoot, ["apply", "--check", "--whitespace=nowarn", patchFile]);
    } finally {
      rmSync(tmpPatch, { recursive: true, force: true });
    }
    if (r.status !== 0) {
      const stderr = (r.stderr || "").trim();
      const cmd = `git -C ${repo.realRoot} apply --check <${repo.patchFile}>`;
      precheckFailures.push({
        repoId: repo.repoId,
        kind: "apply-conflict",
        command: cmd,
        exitCode: r.status,
        summary: `补丁与正式仓冲突或不可应用：${stderr || "git apply --check 非零退出"}`,
        recovery: `冲突补丁不自动变基（第六段）：基于该仓新基线重新生成变更集（重生成任务已生成），或先收敛该仓工作树状态后重试。`,
      });
      continue;
    }
    // b. 版本纪律预检（触及技能自有文件缺 SKILL.md version bump = 红灯，归预检失败分支）
    const violations = checkVersionDiscipline({ patch: repo.patch, versionDiscipline });
    if (violations.length > 0) {
      precheckFailures.push({
        repoId: repo.repoId,
        kind: "version-discipline",
        command: `checkVersionDiscipline(${repo.repoId}, ${violations.map((x) => x.skillMd).join(",")})`,
        exitCode: 1,
        summary: `版本纪律预检红灯：${violations.map((x) => `${x.skillMd} ${x.detail}`).join("；")}`,
        recovery: `把对应 SKILL.md frontmatter version 升号并纳入同一变更集补丁后重新集成（宿主 pre-commit 段 3 同规强制）。`,
      });
    }
  }
  if (precheckFailures.length > 0) {
    for (const f of precheckFailures) {
      precheckCommands.push(precheckFailedCommand(actor, {
        repoId: f.repoId, command: f.command, exitCode: f.exitCode, summary: f.summary, recovery: f.recovery,
      }));
    }
    await writeEvents(precheckCommands);
    return {
      outcome: "failed",
      perRepo: [
        ...precheckFailures.map((f) => ({ repoId: f.repoId, status: "precheck-failed", kind: f.kind, summary: f.summary })),
        ...perRepo.filter((p) => !precheckFailures.some((f) => f.repoId === p.repoId)),
      ],
      events,
      regenerateTask: {
        changesetId: manifest.changesetId,
        repos: precheckFailures.map((f) => f.repoId),
        reason: precheckFailures.map((f) => f.kind).join("+"),
        instruction: "基于各仓当前基线重新生成补丁（版本纪律红灯须同时携带 SKILL.md version bump）；冲突不自动变基。",
      },
    };
  }

  // ── 挂钩阶段（预检全过 → 逐仓执行宿主 pre-commit，作用于 staged 变更形态）──
  for (const repo of repos) {
    if (!repo.hasChanges) continue;
    const hookPath = resolveHookPath(repo.realRoot);
    if (hookPath === null) {
      perRepo.push({ repoId: repo.repoId, status: "hook-absent", hookPath: null });
      continue;
    }
    const patchFile = join(mkdtempSync(join(tmpdir(), `conf-hook-`)), `${repo.repoId}.patch`);
    writeFileSync(patchFile, repo.patch);
    let hook;
    try {
      hook = withTempIndex(`${repo.repoId}`, (indexFile) => {
        const rt = git(repo.realRoot, ["read-tree", "HEAD"], { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
        if (rt.status !== 0) throw integrationError("read-tree-failed", `read-tree 失败（${repo.repoId}）：${(rt.stderr || "").trim()}`);
        const ap = git(repo.realRoot, ["apply", "--cached", "--whitespace=nowarn", patchFile], { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
        if (ap.status !== 0) throw integrationError("stage-failed", `staged 补丁失败（${repo.repoId}）：${(ap.stderr || "").trim()}`);
        // 按挂载点执行挂钩（作用于 staged 变更；GIT_INDEX_FILE 使 hook 内 git diff --cached 可见 staged 内容）
        return spawnSync(hookPath, [], { cwd: repo.realRoot, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: indexFile } });
      });
    } finally {
      rmSync(dirname(patchFile), { recursive: true, force: true });
    }
    if (hook.status !== 0) {
      // 挂钩拒绝 → IntegrationGateChecked（failure=true + hookPath），同终值 failed，全量不应用
      const cmd = { type: "RecordIntegrationGate", actor, payload: {
        repoId: repo.repoId,
        command: hookPath,
        exitCode: hook.status,
        summary: `宿主 pre-commit 挂钩拒绝该变更集（作用于 staged 变更）：${(hook.stderr || hook.stdout || "").trim().slice(0, 500) || "挂钩非零退出"}`,
        recovery: "修复挂钩或修正 staged 变更后重新集成。",
        failure: true,
        hookPath,
      } };
      await writeEvents([cmd]);
      return {
        outcome: "failed",
        perRepo: [
          { repoId: repo.repoId, status: "hook-rejected", hookPath, summary: cmd.payload.summary },
          ...perRepo,
        ],
        events,
        regenerateTask: {
          changesetId: manifest.changesetId,
          repos: [repo.repoId],
          reason: "hook-rejected",
          instruction: "按挂钩输出修正变更内容（或修复挂钩）后重新生成并集成。",
        },
      };
    }
    perRepo.push({ repoId: repo.repoId, status: "hook-passed", hookPath });
  }

  // ── 两阶段提交：阶段一 创建全部 commit 对象（write-tree / commit-tree，授权产对象）──
  const commits = new Map(); // repoId -> { treeSha, commitSha }
  for (const repo of repos) {
    if (!repo.hasChanges) continue;
    const patchFile = join(mkdtempSync(join(tmpdir(), `conf-commit-`)), `${repo.repoId}.patch`);
    writeFileSync(patchFile, repo.patch);
    try {
      // 工作树级应用（写目标仓工作树文件——集成器授权写入；此后正式仓工作树 = 目标内容）
      const w = git(repo.realRoot, ["apply", "--whitespace=nowarn", patchFile]);
      if (w.status !== 0) {
        throw integrationError("apply-failed", `工作树应用失败（${repo.repoId}）：${(w.stderr || "").trim()}。恢复动作：git checkout -- . 恢复工作树后排查预检与工作树差异。`);
      }
    } finally {
      rmSync(dirname(patchFile), { recursive: true, force: true });
    }
    const commitSha = withTempIndex(`${repo.repoId}-tree`, (indexFile) => {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      const rt = git(repo.realRoot, ["read-tree", "HEAD"], { env });
      if (rt.status !== 0) throw integrationError("read-tree-failed", `read-tree 失败（${repo.repoId}）：${(rt.stderr || "").trim()}`);
      const patchFile2 = join(mkdtempSync(join(tmpdir(), `conf-cached-`)), `${repo.repoId}.patch`);
      writeFileSync(patchFile2, repo.patch);
      let ap;
      try {
        ap = git(repo.realRoot, ["apply", "--cached", "--whitespace=nowarn", patchFile2], { env });
      } finally {
        rmSync(dirname(patchFile2), { recursive: true, force: true });
      }
      if (ap.status !== 0) throw integrationError("stage-failed", `staged 补丁失败（${repo.repoId}）：${(ap.stderr || "").trim()}`);
      const wt = git(repo.realRoot, ["write-tree"], { env });
      if (wt.status !== 0) throw integrationError("write-tree-failed", `write-tree 失败（${repo.repoId}）：${(wt.stderr || "").trim()}`);
      const treeSha = wt.stdout.trim();
      const ct = git(repo.realRoot, ["commit-tree", treeSha, "-p", "HEAD", "-m", `integrate(${manifest.changesetId}): ${repo.repoId}`]);
      if (ct.status !== 0) throw integrationError("commit-tree-failed", `commit-tree 失败（${repo.repoId}）：${(ct.stderr || "").trim()}`);
      return ct.stdout.trim();
    });
    commits.set(repo.repoId, commitSha);
  }

  // ── 阶段二 逐仓移动 ref（update-ref 不触发挂钩——绕过前提：预检已执行同一挂钩，审计不静默）──
  const moved = [];
  for (const repo of repos) {
    if (!repo.hasChanges) continue;
    const commitSha = commits.get(repo.repoId);
    const ur = git(repo.realRoot, ["update-ref", `refs/heads/${repo.targetBranch}`, commitSha]);
    if (ur.status !== 0) {
      // ref 移动失败 → 按已记录回滚计划恢复，终值 rolled-back（专属终值，可判定）
      const failures = [];
      for (const done of moved) {
        const plan = rollbackPlan.get(done.repoId);
        const rv = git(done.realRoot, ["update-ref", `refs/heads/${plan.branch}`, plan.baseRefSha]);
        if (rv.status !== 0) throw integrationError("rollback-failed", `回滚 ref 失败（${done.repoId}）：${(rv.stderr || "").trim()}。恢复动作：人工核对 ${done.realRoot} 的 refs/heads/${plan.branch}。`);
        const rst = git(done.realRoot, ["reset", "--hard", plan.baseRefSha]);
        if (rst.status !== 0) throw integrationError("rollback-failed", `回滚工作树失败（${done.repoId}）：${(rst.stderr || "").trim()}。恢复动作：人工核对该仓工作树。`);
        failures.push({ repoId: done.repoId, status: "rolled-back", branch: plan.branch, restoredTo: plan.baseRefSha });
      }
      // 失败仓：ref 未动（真实 index 也未动——staged 走临时 index），只恢复工作树；
      // checkout 恢复 tracked 变更，新增文件（untracked）按补丁清单删除；不用 reset --hard（会撞既有 ref lock）
      const co = git(repo.realRoot, ["checkout", "--", "."]);
      if (co.status !== 0) throw integrationError("rollback-failed", `失败仓工作树恢复失败（${repo.repoId}）：${(co.stderr || "").trim()}。`);
      for (const rel of newFilesFromPatch(repo.patch)) {
        rmSync(join(repo.realRoot, rel), { force: true });
      }
      failures.push({ repoId: repo.repoId, status: "ref-move-failed", branch: repo.targetBranch, stderr: (ur.stderr || "").trim() });
      const order = new Map(repos.map((r, i) => [r.repoId, i]));
      const merged = [...perRepo.filter((p) => !failures.some((f) => f.repoId === p.repoId)), ...failures]
        .sort((a, b) => (order.get(a.repoId) ?? 0) - (order.get(b.repoId) ?? 0));
      return { outcome: "rolled-back", perRepo: merged, events };
    }
    moved.push(repo);
    // 同步真实 index（staged 走临时 index 未触真实侧；HEAD 已前进而 index 停在基线会成 MM 脏态）。
    // reset --mixed 只写 index（工作树已含补丁内容，不动）；reset 非 commit，不触发挂钩
    const rs = git(repo.realRoot, ["reset", "--mixed", commitSha]);
    if (rs.status !== 0) throw integrationError("index-sync-failed", `集成后 index 同步失败（${repo.repoId}）：${(rs.stderr || "").trim()}。恢复动作：人工核对该仓 index 状态。`);
    // 绕过审计：同一字段契约，摘要记录绕过前提、恢复动作栏记「非失败记录，无需恢复」；
    // hookPath 为 optional string——该仓无挂钩时缺省不携带（null 不过 schema）
    const gatePayload = {
      repoId: repo.repoId,
      command: `git -C ${repo.realRoot} update-ref refs/heads/${repo.targetBranch} ${commitSha}`,
      exitCode: 0,
      summary: `两阶段提交 ref 移动（绕过挂钩前提：预检阶段已按 core.hooksPath 执行同一 pre-commit 并通过）`,
      recovery: "非失败记录，无需恢复",
      failure: false,
    };
    const hookPathUsed = perRepo.find((p) => p.repoId === repo.repoId)?.hookPath;
    if (hookPathUsed) gatePayload.hookPath = hookPathUsed;
    await writeEvents([gateCheckedCommand(actor, gatePayload)]);
    perRepo.push({ repoId: repo.repoId, status: "integrated", commit: commitSha, branch: repo.targetBranch });
  }

  return { outcome: "integrated", perRepo, events };
}
