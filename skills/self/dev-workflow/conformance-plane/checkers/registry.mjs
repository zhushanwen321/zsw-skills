// registry.mjs — checker 登记处与退出契约（sync-conformance-plane U2/M2）
//
// 语义权威（设计 sync-conformance-plane 段五 / D7 / V13 / G10）：
//   退出契约固定：0 = 检查完成且无违例；10 = 检查完成且发现违例；20 = checker 自身失败；
//     其他值同样按失败处理。
//   失败不伪造证据：失败写 CheckerFailed 事实（四要素：命令、退出码、摘要、恢复动作）并
//     保持义务 open。
//   semantic 输出非法回喂重试最多 2 次（MAX_SEMANTIC_REFEEDS = 2，即最多 3 次调用），
//     仍失败升级为 CheckerFailed。
//   deterministic 优先，semantic 按义务摘要 + 输入哈希 + checker 版本缓存（缓存见
//     semantic-cache.mjs；命中复用零 agent 调用）。
//
// 本模块是纯编排层：不直接读文件系统、不发起命令——deterministic checker 的 run 由登记方
// 注入（命令执行封装），semantic checker 的 run 由登记方注入（agent 调用封装）。产物是
// 词表内命令序列（RecordEvidence / RecordCheckerFailure），追加状态仓走 kernel/state-repo
// 的唯一写入口 appendCommands——checker wrapper 不直接写状态。

import { CHECKER_RESULTS } from "../kernel/facts.mjs";
import { computeEvidence, hashContent } from "../kernel/evidence.mjs";
import { buildCacheKey } from "./semantic-cache.mjs";

export const CHECKER_EXIT = Object.freeze({ PASS: 0, VIOLATION: 10, FAILURE: 20 });

/** semantic 非法输出回喂重试上限（设计段五「最多 2 次」；总调用数 ≤ 1 + 2 = 3） */
export const MAX_SEMANTIC_REFEEDS = 2;

/** 退出码 → 退出契约三分类（其他值同样按失败处理，段五） */
export function classifyExit(exitCode) {
  if (exitCode === CHECKER_EXIT.PASS) return "pass";
  if (exitCode === CHECKER_EXIT.VIOLATION) return "violation";
  return "failure";
}

const CHECKER_KINDS = Object.freeze(["deterministic", "semantic"]);

/** checker 登记处：def = { id, kind: "deterministic"|"semantic", version, run } */
export function createCheckerRegistry(checkers = []) {
  const byId = new Map();
  const register = (def) => {
    if (!def || typeof def !== "object") {
      const err = new Error("checker 登记定义须为对象（{ id, kind, version, run }）。恢复动作：补齐登记定义。");
      err.code = "invalid-checker-def";
      throw err;
    }
    if (typeof def.id !== "string" || def.id.trim() === "") {
      const err = new Error("checker 登记缺 id——checkerId 是义务绑定与证据记录的引用键。恢复动作：登记非空 id。");
      err.code = "invalid-checker-def";
      throw err;
    }
    if (!CHECKER_KINDS.includes(def.kind)) {
      const err = new Error(`checker「${def.id}」kind 不在词表（${CHECKER_KINDS.join(" / ")}）。恢复动作：登记 deterministic 或 semantic。`);
      err.code = "invalid-checker-kind";
      throw err;
    }
    if (typeof def.version !== "string" || def.version.trim() === "") {
      const err = new Error(`checker「${def.id}」缺版本——版本进缓存键与证据有效期判定，升版即失效旧缓存。恢复动作：登记 semver 版本串。`);
      err.code = "invalid-checker-version";
      throw err;
    }
    if (typeof def.run !== "function") {
      const err = new Error(`checker「${def.id}」缺 run 函数。恢复动作：注入命令执行封装（deterministic）或 agent 调用封装（semantic）。`);
      err.code = "invalid-checker-run";
      throw err;
    }
    byId.set(def.id, def);
    return def;
  };
  for (const def of checkers) register(def);
  return {
    register,
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
  };
}

/** 输入齐备检查：evidenceInputs 声明的每个名字都必须有 artifact 内容快照 */
function missingInputs(obligation, artifacts) {
  return obligation.evidenceInputs.filter((name) => !(name in artifacts));
}

function evidenceCommand({ obligation, checkerId, checkerVersion, inputHashes, result, actor, changesetId }) {
  const record = computeEvidence({
    address: obligation.address,
    binding: obligation.binding,
    checkerId,
    checkerVersion,
    inputs: Object.keys(inputHashes).sort().map((name) => ({ name, hash: inputHashes[name] })),
    result,
    changesetId,
  });
  return { type: "RecordEvidence", actor, payload: record };
}

function failureCommand({ address, command, exitCode, summary, recovery, actor }) {
  return {
    type: "RecordCheckerFailure",
    actor,
    payload: { address, command, exitCode, summary, recovery },
  };
}

const DEFAULT_RECOVERY = "修复 checker 后重跑；义务保持 open，不伪造 verified";

/** 语义输出合法性：result ∈ CHECKER_RESULTS 且 summary 非空字符串（非法 → 回喂） */
export function parseSemanticVerdict(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { legal: false, reason: "输出不是可解析 JSON" };
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { legal: false, reason: "输出不是 JSON 对象" };
  }
  if (!CHECKER_RESULTS.includes(parsed.result)) {
    return { legal: false, reason: `result 不在词表（${CHECKER_RESULTS.join(" / ")}）` };
  }
  if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") {
    return { legal: false, reason: "summary 缺失或为空" };
  }
  return { legal: true, verdict: { result: parsed.result, summary: parsed.summary } };
}

/**
 * 运行 checker 并产出词表内命令。语义缓存命中时零 run 调用（V7）。
 * 参数：registry、{ obligation, artifacts = { 输入名: 内容 }, actor = "checker-wrapper",
 *   changesetId?, cache? }。
 * 返回 { status: "pass"|"violation"|"failure", commands, checkerId, checkerVersion,
 *   inputHashes, calls: run 调用次数, reused: 是否缓存复用 }。
 */
export async function runChecker(registry, { obligation, artifacts = {}, actor = "checker-wrapper", changesetId, cache }) {
  const def = registry.get(obligation.checkerId);
  if (!def) {
    // U2 检查点：显式绑定但 checker 未注册 → 失败四要素 + 义务保持 open，提示补 checker
    const cmd = failureCommand({
      address: obligation.address,
      command: `unregistered-checker ${obligation.checkerId}`,
      exitCode: CHECKER_EXIT.FAILURE,
      summary: `checker「${obligation.checkerId}」未注册（义务 ${obligation.bindingId} 显式绑定了未登记 checker）`,
      recovery: `在 checker registry 登记「${obligation.checkerId}」（deterministic 命令封装或 semantic agent 封装）后重跑`,
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: obligation.checkerId, checkerVersion: null, inputHashes: {}, calls: 0, reused: false };
  }

  const missing = missingInputs(obligation, artifacts);
  if (missing.length > 0) {
    const cmd = failureCommand({
      address: obligation.address,
      command: `${def.kind}:${def.id}@${def.version}`,
      exitCode: CHECKER_EXIT.FAILURE,
      summary: `输入 artifact 缺失：${missing.join("、")}（evidenceInputs 声明的输入必须有内容快照）`,
      recovery: "补齐缺失输入的内容快照后重跑；义务保持 open，不伪造 verified",
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes: {}, calls: 0, reused: false };
  }
  const inputHashes = Object.fromEntries(obligation.evidenceInputs.map((name) => [name, hashContent(artifacts[name])]));

  // ── semantic：缓存优先（D7/V7）──
  if (def.kind === "semantic") {
    const key = buildCacheKey({ obligation, inputHashes, checkerVersion: def.version });
    const cached = cache?.get(key);
    if (cached) {
      const cmd = evidenceCommand({ obligation, checkerId: def.id, checkerVersion: def.version, inputHashes, result: cached.result, actor, changesetId });
      return { status: cached.result === "pass" ? "pass" : "violation", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls: 0, reused: true };
    }
    const input = {
      // 最小义务包（段三）：规范化义务绑定 + 目标 artifact 输入哈希 + rubric 由 checker 定义自带。
      // 禁携带完整会话历史（U2 检查点）——输入只有义务与被检内容哈希
      obligation: { binding: obligation.binding, address: obligation.address, targetSelector: obligation.targetSelector, severity: obligation.severity },
      inputHashes,
      attempt: 0,
      feedback: null,
    };
    let lastReason = null;
    let calls = 0;
    for (let attempt = 1; attempt <= 1 + MAX_SEMANTIC_REFEEDS; attempt++) {
      input.attempt = attempt;
      let raw;
      try {
        raw = await def.run(input, { attempt, feedback: input.feedback });
      } catch (e) {
        const cmd = failureCommand({
          address: obligation.address,
          command: `semantic:${def.id}@${def.version}`,
          exitCode: CHECKER_EXIT.FAILURE,
          summary: `semantic checker 调用抛错（第 ${attempt} 次）：${String(e?.message ?? e).slice(0, 300)}`,
          recovery: DEFAULT_RECOVERY,
          actor,
        });
        return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls, reused: false };
      }
      calls += 1;
      const parsed = parseSemanticVerdict(raw);
      if (parsed.legal) {
        cache?.set(key, parsed.verdict);
        const cmd = evidenceCommand({ obligation, checkerId: def.id, checkerVersion: def.version, inputHashes, result: parsed.verdict.result, actor, changesetId });
        return { status: parsed.verdict.result === "pass" ? "pass" : "violation", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls, reused: false };
      }
      lastReason = parsed.reason;
      // 回喂：把非法原因与期望契约发回 checker 重试（≤ MAX_SEMANTIC_REFEEDS 次）
      input.feedback = { illegalReason: parsed.reason, expected: { result: CHECKER_RESULTS, summary: "非空字符串" } };
    }
    const cmd = failureCommand({
      address: obligation.address,
      command: `semantic:${def.id}@${def.version}`,
      exitCode: CHECKER_EXIT.FAILURE,
      summary: `semantic checker 连续 ${calls} 次输出非法（末次原因：${lastReason}），回喂 ${MAX_SEMANTIC_REFEEDS} 次耗尽`,
      recovery: "修复 checker 输出契约后重跑；义务保持 open，不伪造 verified",
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls, reused: false };
  }

  // ── deterministic：退出码契约分类（段五）──
  let out;
  try {
    out = await def.run({ obligation, inputHashes });
  } catch (e) {
    const cmd = failureCommand({
      address: obligation.address,
      command: `deterministic:${def.id}@${def.version}`,
      exitCode: CHECKER_EXIT.FAILURE,
      summary: `deterministic checker 调用抛错：${String(e?.message ?? e).slice(0, 300)}`,
      recovery: DEFAULT_RECOVERY,
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls: 1, reused: false };
  }
  if (out === null || typeof out !== "object" || Array.isArray(out) || !Number.isInteger(out.exitCode)) {
    const cmd = failureCommand({
      address: obligation.address,
      command: `deterministic:${def.id}@${def.version}`,
      exitCode: CHECKER_EXIT.FAILURE,
      summary: "deterministic checker 封装未返回 { command, exitCode } 形态（wrapper 契约违反）",
      recovery: "修复命令封装，返回真实命令串与退出码后重跑",
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls: 1, reused: false };
  }
  const kind = classifyExit(out.exitCode);
  const command = typeof out.command === "string" && out.command.trim() !== "" ? out.command : `deterministic:${def.id}@${def.version}`;
  if (kind === "failure") {
    const cmd = failureCommand({
      address: obligation.address,
      command,
      exitCode: out.exitCode,
      summary: typeof out.summary === "string" && out.summary.trim() !== "" ? out.summary : `checker 退出码 ${out.exitCode}（非 0/10，按自身失败处理）`,
      recovery: typeof out.recovery === "string" && out.recovery.trim() !== "" ? out.recovery : DEFAULT_RECOVERY,
      actor,
    });
    return { status: "failure", commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls: 1, reused: false };
  }
  const cmd = evidenceCommand({ obligation, checkerId: def.id, checkerVersion: def.version, inputHashes, result: kind === "pass" ? "pass" : "fail", actor, changesetId });
  return { status: kind, commands: [cmd], checkerId: def.id, checkerVersion: def.version, inputHashes, calls: 1, reused: false };
}
