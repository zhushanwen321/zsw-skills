// state-fold.mjs — 确定性 fold：事件序列 → 状态快照（sync-conformance-plane U1/M1）
//
// 语义权威（设计 sync-conformance-plane）：
//   AX3  唯一权威是状态仓中的只能追加事件流与快照；所有当前状态均由确定性 fold 重建
//   AX5  awaiting-ruling / verified / pending-integration 等是事件与哈希等值的派生谓词，不持久化
//   D3   evidenceValid 由全部输入、checker 版本与绑定版本等值计算；谓词不落存储
//   同序事件重放结论不变（G2 --replay-equivalence / RL2；快照 + 增量 fold 等价全量 fold）
//
// 结论派生规则（每地址，按事件时序收敛，缺省 open）：
//   1. awaiting-ruling  —— 存在未应答的 RulingRequested（V8 裁决续跑）
//   2. verified / pending-integration —— 最新 pass 证据经 evaluateEvidence 判定有效：
//        证据携带 changesetId（变更集就绪，AX7）且该 repo 无集成审计事实 → pending-integration
//        其余（无变更集引用，或集成审计事实已在场）→ verified
//   3. CheckerFailed 不伪造 verified：义务保持 open，失败四要素留存 lastCheckerFailure 可查（段五）
//   4. archived 是包级派生谓词：输入归档标记 + Unarchived 事件解档（段七复活通道，M5）

import { canonicalJson, validateFact, obligationSummaryHash } from "./facts.mjs";
import { evaluateEvidence } from "./evidence.mjs";

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
  if (initialState) {
    for (const s of Object.values(initialState.addresses)) {
      addresses.set(s.key, structuredClone(s));
      keys[canonicalJson(s.address)] = s.key;
    }
    unarchivedSeen = Boolean(initialState.unarchivedSeen);
    lastSeq = initialState.seq;
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
      addresses.set(key, emptyAddressState(f.address));
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
        const evidenceFacts = (s._evidenceFacts ??= []);
        evidenceFacts.push(f);
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
            !s.integrationBlocked && !s._integrationSeen;
        }
        break;
      }
      case "IntegrationGateChecked":
      case "IntegrationPrecheckFailed": {
        const repoId = f.repoId;
        for (const s of addresses.values()) {
          if (s.address.repoId !== repoId) continue;
          s._integrationSeen = true;
          if (f.type === "IntegrationPrecheckFailed" || f.failure === true) {
            s.integrationBlocked = true;
            s.pendingIntegration = false;
          } else {
            s.pendingIntegration = false; // 集成审计在场 = 离开 pending-integration（V12 分层）
          }
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

  // 结论收敛（优先级：awaiting-ruling > verified/pending-integration > open；CheckerFailed 保持 open）
  for (const s of addresses.values()) {
    if (s.awaitingRuling) s.conclusion = "awaiting-ruling";
    else if (s.verification === "verified") s.conclusion = s.pendingIntegration ? "pending-integration" : "verified";
    else s.conclusion = "open";
    delete s._evidenceFacts;
    delete s._integrationSeen;
    // pendingRulingSeq 保留在产物中：initialState 续 fold 的 respondsTo 配对校验依赖它（seq 引用，非谓词）
  }

  return {
    archived: Boolean(archived) && !unarchivedSeen,
    unarchivedSeen,
    seq: lastSeq,
    keys,
    addresses: Object.fromEntries(addresses),
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
