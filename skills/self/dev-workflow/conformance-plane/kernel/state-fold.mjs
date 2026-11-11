// state-fold.mjs — 确定性 fold：事件序列 → 状态快照（sync-conformance-plane U1/M1）
//
// 语义权威（设计 sync-conformance-plane）：
//   AX3  唯一权威是状态仓中的只能追加事件流与快照；所有当前状态均由确定性 fold 重建
//   AX5  awaiting-ruling / verified / pending-integration 等是事件与哈希等值的派生谓词，不持久化
//   D3   evidenceValid 由全部输入、checker 版本与绑定版本等值计算；谓词不落存储
//   同序事件重放结论不变（G2 --replay-equivalence / RL2；快照 + 增量 fold 等价全量 fold）
//
// 结论派生规则（每地址，按事件时序收敛，缺省 open；优先级与 workflow 层终态派生同序，
// workflow 层（design-code-sync-v2 derivedConclusion / reports/outcomes.mjs）消费 fold conclusion 自然贯通）：
//   1. awaiting-ruling  —— 存在未应答的 RulingRequested（V8 裁决续跑）
//   2. verified / pending-integration —— 最新 pass 证据经 evaluateEvidence 判定有效：
//        证据携带 changesetId（变更集就绪，AX7）且该 repo 无集成审计事实 → pending-integration
//        其余（无变更集引用，或集成审计事实已在场）→ verified
//   3. waived —— 最新裁决 direction=waived 且无更高优先结论（AX8 义务终态；新一轮
//      RulingRequested 重新打开裁决流程回到 awaiting-ruling，direction 变更随 lastRuling 覆盖）
//   4. CheckerFailed 不伪造 verified：义务保持 open，失败四要素留存 lastCheckerFailure 可查（段五）
//   5. archived 是包级派生谓词：输入归档标记 + Unarchived 事件解档（段七复活通道，M5）

import { canonicalJson, validateFact, obligationSummaryHash } from "./facts.mjs";
import { evaluateEvidence } from "./evidence.mjs";

/** 地址结论词表（fold 派生唯一产出域；扩词表必须同步结论收敛循环分支） */
export const CONCLUSIONS = Object.freeze(["open", "awaiting-ruling", "verified", "pending-integration", "waived"]);

/** 地址派生键：bindingId|repoId|violationKind（AX2） */
export function addressKey(address) {
  return `${address.bindingId}|${address.repoId}|${address.violationKind}`;
}

function emptyAddressState(address) {
  return {
    key: addressKey(address),
    address,
    conclusion: "open",
    awaitingRuling: false,
    verification: "unverified", // unverified | verified | invalid
    evidence: { status: "none", reasons: [] }, // none | valid | invalid（invalid 时 reasons 可查，V3）
    pendingIntegration: false,
    integrationBlocked: false,
    // 该 repo 集成成功审计（IntegrationGateChecked failure !== true）已在场——创建时由 repo 级
    // 预扫描聚合初始化（事件先于地址首现不丢失），随快照携带（RL2 快照+增量等价全量 fold）
    integrationSeen: false,
    lastCheckerFailure: null,
    lastRuling: null,
  };
}

/** 全量/增量 fold。input = { archived?, bindings, repos, checkerRuns, changesets, artifacts?, facts, initialState? } */
export function fold(input) {
  const {
    archived = false,
    bindings = [],
    repos = [],
    checkerRuns = [],
    changesets = [],
    artifacts = {},
    facts = [],
    initialState = null,
  } = input;

  const bindingsById = new Map(bindings.map((b) => [b.bindingId, b]));

  const addresses = new Map();
  const keys = {};
  let unarchivedSeen = false;
  let lastSeq = 0;
  // repo 级集成审计聚合（预扫描全部事件，地址首现前即建立）：集成审计事实是 repo 级事实，
  // 不得依赖地址入场顺序——事件先于地址首现时结论必须与后于首现一致。两集合与下方事件
  // 循环分支共用同一判定式：阻断 = IntegrationPrecheckFailed 或 failure === true（挂钩拒绝）；
  // 集成成功在场 = IntegrationGateChecked 且 failure !== true。
  // 快照切点可能落在「repo 级事件已发生、地址未首现」之间，聚合随快照携带（RL2：快照+增量
  // 等价全量 fold），initialState 携带的历史聚合与本批预扫描并集生效。
  const integrationSeenRepos = new Set();
  const integrationBlockedRepos = new Set();
  if (initialState) {
    for (const s of Object.values(initialState.addresses)) {
      addresses.set(s.key, structuredClone(s));
      keys[canonicalJson(s.address)] = s.key;
    }
    unarchivedSeen = Boolean(initialState.unarchivedSeen);
    lastSeq = initialState.seq;
    // RL2 等价性前提：repo 级集成审计聚合必须随快照携带。旧格式快照缺聚合字段时增量 fold
    // 会把已发生的集成审计当空集，pending-integration 派生静默失真（旧快照增量 fold 得
    // pending-integration、全量 fold 得 verified）——显式拒绝，不做从地址段补全的部分迁移
    // （地址段本身可能已丢「审计先于地址首现」的事实，补全是不完整迁移）。
    if (!Array.isArray(initialState.integrationSeenRepos) || !Array.isArray(initialState.integrationBlockedRepos)) {
      const err = new Error(
        "快照为旧格式（缺 integrationSeenRepos / integrationBlockedRepos 聚合字段），" +
          "快照 + 增量 fold 等价全量 fold（RL2）对该快照不成立，拒绝续 fold。" +
          "恢复动作：快照为旧格式——用 rebuild（kernel/state-repo.mjs）或全量 fold 从事件流重建快照后重试" +
          "（生产链 appendCommands/rebuild 全走全量 fold，不受影响；磁盘旧快照下次追加会被重写为新格式）。",
      );
      err.code = "snapshot-legacy-format";
      throw err;
    }
    for (const r of initialState.integrationSeenRepos) integrationSeenRepos.add(r);
    for (const r of initialState.integrationBlockedRepos) integrationBlockedRepos.add(r);
  }

  // 事件序列无空洞：seq 从当前 lastSeq+1 起连续（AX3 权威完整性）
  let expect = lastSeq + 1;
  for (const f of facts) {
    if (f.seq !== expect) {
      const err = new Error(`事件序列 seq 空洞或乱序：期望 ${expect}，实际 ${f.seq}（事件流权威不得有空洞）`);
      err.code = "fact-seq-gap";
      throw err;
    }
    expect++;
  }

  // repo 级聚合预扫描：合并本批全部事件（排序输出保证产物逐字节确定性，RL2）
  for (const f of facts) {
    if (f.type === "IntegrationGateChecked") {
      (f.failure === true ? integrationBlockedRepos : integrationSeenRepos).add(f.repoId);
    } else if (f.type === "IntegrationPrecheckFailed") {
      integrationBlockedRepos.add(f.repoId);
    }
  }

  const resolveAddress = (f) => {
    const binding = bindingsById.get(f.address.bindingId);
    if (!binding) {
      const err = new Error(`事实 seq=${f.seq} 地址不可解析：bindingId ${f.address.bindingId} 不在绑定集（AX2 身份一致性）`);
      err.code = "unresolvable-address";
      throw err;
    }
    if (binding.repoId !== f.address.repoId || binding.violationKind !== f.address.violationKind) {
      const err = new Error(
        `事实 seq=${f.seq} 地址与绑定声明不一致（repoId/violationKind）：bindingId ${f.address.bindingId} 在绑定集声明 (${binding.repoId}, ${binding.violationKind})，事实携带 (${f.address.repoId}, ${f.address.violationKind})。恢复动作：核对 AX2 地址派生 (bindingId, repoId, violationKind) 与绑定集登记。`,
      );
      err.code = "address-binding-mismatch";
      throw err;
    }
    const key = addressKey(f.address);
    if (!addresses.has(key)) {
      const s = emptyAddressState(f.address);
      // 创建即携带本批全流聚合终值（含首现之前的同 repo 集成审计事件效果）
      s.integrationSeen = integrationSeenRepos.has(f.address.repoId);
      s.integrationBlocked = integrationBlockedRepos.has(f.address.repoId);
      addresses.set(key, s);
      keys[canonicalJson(f.address)] = key;
    }
    return addresses.get(key);
  };

  for (const f of facts) {
    const check = validateFact(f);
    if (!check.ok) {
      const err = new Error(`事实 seq=${f.seq} 未通过 schema 校验：${check.errors.join("；")}`);
      err.code = "invalid-fact";
      throw err;
    }
    lastSeq = f.seq;
    switch (f.type) {
      case "RulingRequested": {
        const s = resolveAddress(f);
        s.awaitingRuling = true;
        s.pendingRulingSeq = f.seq;
        s.lastRuling = { requestedAt: f.seq, question: f.question };
        break;
      }
      case "RulingRecorded": {
        const s = resolveAddress(f);
        if (!s.awaitingRuling || s.pendingRulingSeq !== f.respondsTo) {
          const err = new Error(
            `RulingRecorded seq=${f.seq} 的 respondsTo=${f.respondsTo} 不匹配该地址未应答的 RulingRequested（裁决必须回应在案请求，AX10）`,
          );
          err.code = "ruling-unmatched";
          throw err;
        }
        s.awaitingRuling = false;
        s.pendingRulingSeq = null;
        s.lastRuling = { ...(s.lastRuling ?? {}), resolvedAt: f.seq, direction: f.direction };
        break;
      }
      case "CheckerFailed": {
        const s = resolveAddress(f);
        // 段五：失败只记录事实并保持义务 open，绝不推进 verification
        s.lastCheckerFailure = { seq: f.seq, command: f.command, exitCode: f.exitCode, summary: f.summary, recovery: f.recovery };
        break;
      }
      case "EvidenceRecorded": {
        const s = resolveAddress(f);
        if (f.result === "pass") {
          // 只由最新 pass 证据派生有效性（内容变化自动失效，AX4/D3）
          const verdict = evaluateEvidence(f, { bindings, checkerRuns, artifacts });
          if (verdict.valid) {
            s.verification = "verified";
            s.evidence = { status: "valid", reasons: [], evidenceSeq: f.seq };
          } else {
            s.verification = "invalid";
            s.evidence = { status: "invalid", reasons: verdict.reasons, evidenceSeq: f.seq };
          }
          s.pendingIntegration =
            s.verification === "verified" && typeof f.changesetId === "string" &&
            !s.integrationBlocked && !s.integrationSeen;
        }
        break;
      }
      case "IntegrationGateChecked":
      case "IntegrationPrecheckFailed": {
        // repo 级聚合已在预扫描完成（integrationSeenRepos / integrationBlockedRepos）；此处对
        // 已入场地址做幂等更新，判定式与预扫描一致。集成审计在场 = 离开 pending-integration（V12 分层）
        const repoId = f.repoId;
        const blocked = f.type === "IntegrationPrecheckFailed" || f.failure === true;
        for (const s of addresses.values()) {
          if (s.address.repoId !== repoId) continue;
          if (blocked) s.integrationBlocked = true;
          else s.integrationSeen = true;
          s.pendingIntegration = false;
        }
        break;
      }
      case "BacklogAdopted": {
        if (!bindingsById.has(f.newBinding.bindingId)) {
          const err = new Error(`BacklogAdopted seq=${f.seq} 引用的新绑定 ${f.newBinding.bindingId} 不在绑定集（新地址初始证据要求绑定先登记，段七）`);
          err.code = "unresolvable-backlog-binding";
          throw err;
        }
        break;
      }
      case "Unarchived": {
        unarchivedSeen = true;
        break;
      }
      default: {
        const err = new Error(`fold 未覆盖词表事件 ${f.type}（词表扩展必须同步 fold 分支）`);
        err.code = "unhandled-event";
        throw err;
      }
    }
  }

  // 结论收敛（优先级与头部派生规则一致：awaiting-ruling > verified/pending-integration > waived > open；
  // CheckerFailed 保持 open；waived 按最新裁决方向派生——RulingRecorded direction 变更随 lastRuling 覆盖）
  for (const s of addresses.values()) {
    if (s.awaitingRuling) s.conclusion = "awaiting-ruling";
    else if (s.verification === "verified") s.conclusion = s.pendingIntegration ? "pending-integration" : "verified";
    else if (s.lastRuling?.direction === "waived") s.conclusion = "waived";
    else s.conclusion = "open";
    // pendingRulingSeq / integrationSeen 保留在产物中：initialState 续 fold 依赖它们保持与全量 fold
    // 等价（RL2）——respondsTo 配对校验依赖 pendingRulingSeq，pass 证据的 pending-integration 派生
    // 依赖 integrationSeen；两者都是流内事实在场标记（seq/布尔），非结论谓词（AX5 不涉）
  }

  return {
    archived: Boolean(archived) && !unarchivedSeen,
    unarchivedSeen,
    seq: lastSeq,
    keys,
    addresses: Object.fromEntries(addresses),
    // repo 级聚合随产物/快照携带（排序数组保证逐字节确定性）；initialState 续 fold 时并入
    integrationSeenRepos: [...integrationSeenRepos].sort(),
    integrationBlockedRepos: [...integrationBlockedRepos].sort(),
    summary: {
      byConclusion: countBy([...addresses.values()].map((s) => s.conclusion)),
      archived: Boolean(archived) && !unarchivedSeen,
    },
  };
}

function countBy(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// 无孤儿证据检测（V11 性质二）：每条证据引用的 binding / repo / checker run / changeset 均存在
// ---------------------------------------------------------------------------

export function findOrphanEvidence(input) {
  const { bindings = [], repos = [], checkerRuns = [], changesets = [], facts = [] } = input;
  const bindingIds = new Set(bindings.map((b) => b.bindingId));
  const repoIds = new Set(repos.map((r) => r.repoId));
  const checkerRunsKeyed = new Set(checkerRuns.map((c) => `${c.checkerId}@${c.checkerVersion}`));
  const changesetIds = new Set(changesets.map((c) => c.changesetId));
  const orphans = [];
  for (const f of facts) {
    if (f.type !== "EvidenceRecorded") continue;
    const where = { seq: f.seq, address: addressKey(f.address) };
    if (!bindingIds.has(f.address.bindingId)) orphans.push({ kind: "binding", ref: f.address.bindingId, ...where });
    if (!repoIds.has(f.address.repoId)) orphans.push({ kind: "repo", ref: f.address.repoId, ...where });
    if (!checkerRunsKeyed.has(`${f.checkerId}@${f.checkerVersion}`)) {
      orphans.push({ kind: "checker-run", ref: `${f.checkerId}@${f.checkerVersion}`, ...where });
    }
    if (f.changesetId !== undefined && !changesetIds.has(f.changesetId)) {
      orphans.push({ kind: "changeset", ref: f.changesetId, ...where });
    }
  }
  return orphans;
}

// obligationSummaryHash 重导出（地址/摘要语义的唯一入口在 facts；fold 消费方无需二次 import facts）
export { canonicalJson, obligationSummaryHash, validateFact };
