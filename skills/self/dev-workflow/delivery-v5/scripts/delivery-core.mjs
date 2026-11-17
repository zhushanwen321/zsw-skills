#!/usr/bin/env node
// delivery-core.mjs — 交付事务内核 CLI（V5）
//
// 职责边界（设计文档 /tmp 交付事务状态机内核设计的落地载体）：
//   状态、转移、写入、计数四件事收归一处。delivery-gate 保持裁决器（verdict 与事件 append
//   唯一门），本 CLI 提供：
//     validate         转移表静态校验（无环除修复回边/可达/执行器唯一/谓词与角色在词表）
//     rules            规则转储（预算/护栏/转移表）
//     next             「下一步」唯一回答者：五域状态 + 待办优先 + 合法转移 + 预算
//     pending          脑内状态实体化：待办登记 / 解决 / 清单（pending-actions.json）
//     budget           循环预算查询（修复轮/跨 run 保证/改判熔断）
//     open-findings    发现 open 集（kernel-judgments 单源，workflow 消费入口）
//     usable-explorations 可用探索集（同上，含磁盘 artifact 校验）
//     exploration-due  探索 due 判定（同上）
//     repair-budget    修复轮预算（同上）
//     node-transition  DAG 节点状态转移（wave-executor 六写入点收敛后的唯一判定；
//                      --dry-run 供引擎在串行写链内先判定后自写，非 dry-run 直接落盘）
//
// 单源纪律：判定逻辑一律 import lib/kernel-judgments.mjs 或读 kernel/rules.json，
// 本文件不另立判定副本。gate 内部函数经 delivery-gate.mjs 导入复用（同一份实现）。

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_RULES,
  explorationDue,
  findingRegrades,
  openFindingsFromEvents,
  repairBudgetFromEvents,
  usableExplorations,
} from "./lib/kernel-judgments.mjs";
import {
  buildVerdict,
  computeRevision,
  loadTaskCore,
  loadWorld,
} from "./delivery-gate.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_PATH = join(SKILL_ROOT, "scripts", "kernel", "rules.json");
const PENDING_KINDS = ["cleanup", "awaiting-restore", "awaiting-registration", "awaiting-ruling"];

function usageFail(message) {
  process.stderr.write(`delivery-core: ${message}\n`);
  process.exit(2);
}

function fail(message, recovery) {
  // 抛错而非只置退出码——校验失败必须终止当前命令（否则拒绝后仍继续执行写盘路径）
  throw new Error(`${message}${recovery ? ` 恢复动作：${recovery}` : ""}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(args, specification) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (!match) usageFail(`无法解析参数 ${JSON.stringify(token)}。`);
    const key = match[1];
    if (match[2] !== undefined) {
      options[key] = match[2];
      continue;
    }
    if ((specification.flags ?? []).includes(key)) {
      options[key] = "true";
      continue;
    }
    const value = args[++index];
    if (value === undefined) usageFail(`参数 --${key} 缺值。`);
    options[key] = value;
  }
  for (const key of specification.required) {
    if (!(key in options)) usageFail(`缺少必填参数 --${key}。`);
  }
  for (const key of Object.keys(options)) {
    if (
      !specification.required.includes(key) &&
      !(specification.optional ?? []).includes(key) &&
      !(specification.flags ?? []).includes(key)
    ) {
      usageFail(`未知参数 --${key}。`);
    }
  }
  return options;
}

// ── 转移表静态校验 ──
// 检查项（设计文档目标 1：顺序矛盾在定义期被机器检出）：
//   ① from/to ∈ 状态词表（通配 "*" 只允许作 from）
//   ② 从 initial 出发非通配边可达每个状态（不可达 = 建模遗漏）
//   ③ 环检测：成环的边组必须含 repair:true 标记（修复回边），无标记环 = 顺序矛盾
//   ④ 同一 (from,to) 至多一条转移（执行器唯一）
//   ⑤ requires ∈ 谓词词表；actor ∈ 角色词表；terminalStates ⊆ states
//   ⑥ 非终态非 initial 状态必须有出边（死端 = 流程走进去出不来）
function validateRules(rules) {
  const errors = [];
  const actorSet = new Set(rules.actors);
  const predicateSet = new Set(Object.keys(rules.predicates));
  for (const [domainName, domain] of Object.entries(rules.domains)) {
    const states = new Set(domain.states);
    const label = `域 ${domainName}`;
    if (!states.has(domain.initial)) errors.push(`${label}: initial ${domain.initial} 不在状态词表`);
    for (const stateName of domain.terminalStates) {
      if (!states.has(stateName)) errors.push(`${label}: terminalStates 含未声明状态 ${stateName}`);
    }
    const edges = new Map();
    for (const transition of domain.transitions) {
      const tLabel = `${label} ${transition.from} -> ${transition.to} (${transition.event})`;
      if (transition.from !== "*" && !states.has(transition.from)) errors.push(`${tLabel}: from 不在状态词表`);
      if (!states.has(transition.to)) errors.push(`${tLabel}: to 不在状态词表`);
      const pairKey = `${transition.from}\u0000${transition.to}`;
      if (edges.has(pairKey)) errors.push(`${tLabel}: 与 ${edges.get(pairKey)} 重复定义同一 (from,to) 转移`);
      else edges.set(pairKey, tLabel);
      if (!actorSet.has(transition.actor)) errors.push(`${tLabel}: actor ${transition.actor} 不在角色词表`);
      for (const predicate of transition.requires ?? []) {
        if (!predicateSet.has(predicate)) errors.push(`${tLabel}: 谓词 ${predicate} 不在词表（不可机器判定）`);
      }
      if (typeof transition.executor !== "string" || transition.executor === "") {
        errors.push(`${tLabel}: executor 缺失（同一转移的执行器必须唯一且显式）`);
      }
    }
    // 可达性（非通配边 + 通配边——通配边语义 = 从任意已达状态可达）
    const outgoing = new Map();
    for (const transition of domain.transitions) {
      if (transition.from === "*") continue;
      if (!outgoing.has(transition.from)) outgoing.set(transition.from, []);
      outgoing.get(transition.from).push(transition.to);
    }
    const wildcardTargets = domain.transitions.filter((transition) => transition.from === "*").map((transition) => transition.to);
    const reachable = new Set([domain.initial]);
    const queue = [domain.initial];
    while (queue.length > 0) {
      const current = queue.shift();
      const nexts = [...(outgoing.get(current) ?? []), ...wildcardTargets];
      for (const next of nexts) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const stateName of domain.states) {
      if (!reachable.has(stateName)) errors.push(`${label}: 状态 ${stateName} 从 initial 不可达`);
    }
    // 环检测：环内任一边带 backedge 标记（repair = 消耗修复预算的回边；lifecycle = 暂停/
    // 恢复类生命周期环）即合法；无标记环 = 顺序矛盾。通配边不参与（入射边不成环）
    const color = new Map();
    const stack = [];
    const unmarkedCycles = [];
    const visit = (stateName) => {
      color.set(stateName, 1);
      stack.push(stateName);
      for (const transition of domain.transitions) {
        if (transition.from !== stateName) continue;
        const next = transition.to;
        const nextColor = color.get(next) ?? 0;
        if (nextColor === 1) {
          const cycleStates = new Set([...stack.slice(stack.indexOf(next)), next]);
          const marked = domain.transitions.some(
            (candidate) =>
              typeof candidate.backedge === "string" &&
              candidate.from !== "*" &&
              cycleStates.has(candidate.from) &&
              cycleStates.has(candidate.to),
          );
          if (!marked) unmarkedCycles.push([...stack.slice(stack.indexOf(next)), next].join(" -> "));
        } else if (nextColor === 0) {
          visit(next);
        }
      }
      stack.pop();
      color.set(stateName, 2);
    };
    for (const stateName of domain.states) {
      if ((color.get(stateName) ?? 0) === 0) visit(stateName);
    }
    for (const cycle of unmarkedCycles) errors.push(`${label}: 存在无 backedge 标记的环 ${cycle}（顺序矛盾，须声明回边 backedge=repair|lifecycle 或修正方向）`);
    // 死端检测
    const terminal = new Set(domain.terminalStates);
    for (const stateName of domain.states) {
      const hasOutgoing = domain.transitions.some((transition) => transition.from === stateName || transition.from === "*");
      if (!hasOutgoing && !terminal.has(stateName) && stateName !== domain.initial) {
        errors.push(`${label}: 非终态 ${stateName} 无出边（死端——流程进入后无法继续，须补转移或标记终态）`);
      }
    }
  }
  return errors;
}

// ── 待办实体（脑内状态落盘；advisory 状态不签名不进事件流——它驱动 next，不是证据）──
function pendingPath(taskDir) {
  return join(taskDir, "pending-actions.json");
}

function readPending(taskDir) {
  const filePath = pendingPath(taskDir);
  if (!existsSync(filePath)) return { items: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

function writePending(taskDir, document) {
  writeFileSync(pendingPath(taskDir), `${JSON.stringify(document, null, 2)}\n`);
}

function commandPending(args) {
  // args[0] = 子命令（add|resolve|list，由分发处校验），其余为 --key value 形态
  const action = args[0];
  const options = parseOptions(args.slice(1), { required: ["task-dir"], optional: ["kind", "note", "ref", "id", "outcome"] });
  const core = loadTaskCore(options["task-dir"]);
  const document = readPending(core.taskDir);
  if (action === "list") {
    printJson({ taskDir: core.taskDir, open: document.items.filter((item) => item.status === "open"), resolved: document.items.filter((item) => item.status !== "open") });
    return;
  }
  if (action === "add") {
    if (!PENDING_KINDS.includes(options.kind ?? "")) {
      fail(`--kind 必须是 ${PENDING_KINDS.join(" / ")} 之一（善后/待恢复/待登记/待裁决四类）。`, "按中断时的实际待办类型重选 kind 后重试。");
    }
    if (typeof options.note !== "string" || options.note.trim() === "") {
      fail("--note 必填（一句话说明待办内容，恢复后可直接照做）。", "补 --note 后重试。");
    }
    const id = `pa-${document.items.length + 1}`;
    document.items.push({
      id,
      kind: options.kind,
      note: options.note.trim(),
      ref: options.ref ?? null,
      createdAt: new Date().toISOString(),
      status: "open",
    });
    writePending(core.taskDir, document);
    printJson({ added: id, open: document.items.filter((item) => item.status === "open").length });
    return;
  }
  if (action === "resolve") {
    const item = document.items.find((entry) => entry.id === options.id && entry.status === "open");
    if (item === undefined) {
      fail(`待办 ${options.id ?? "(空)"} 不存在或已解决。`, "先 pending list 核对 id 后重试。");
    }
    item.status = "resolved";
    item.resolvedAt = new Date().toISOString();
    item.outcome = options.outcome ?? "";
    writePending(core.taskDir, document);
    printJson({ resolved: item.id, open: document.items.filter((entry) => entry.status === "open").length });
    return;
  }
  usageFail(`--action 必须是 list / add / resolve。`);
}

// ── 世界加载（带验收包缺省降级：早期任务无 acceptance.json 时只读事件流）──
function loadWorldAuto(taskDirValue) {
  try {
    return loadWorld(taskDirValue);
  } catch (error) {
    if (error && typeof error.message === "string" && /acceptance\.json|increments\.json/.test(error.message)) {
      return loadWorld(taskDirValue, { requirePackage: false });
    }
    throw error;
  }
}

function recordsOf(world) {
  return world.entries.map((entry) => entry.record);
}

function artifactUsableInDir(taskDir) {
  return async (event) => {
    if (typeof event.artifact !== "string" || event.artifact === "") return false;
    const absPath = isAbsolute(event.artifact) ? event.artifact : join(taskDir, event.artifact);
    if (!existsSync(absPath)) return false;
    if (typeof event.artifactSha256 === "string" && event.artifactSha256 !== "") {
      const diskSha = createHash("sha256").update(readFileSync(absPath)).digest("hex");
      if (diskSha !== event.artifactSha256) return false;
    }
    return true;
  };
}

async function explorationFacts(world) {
  if (world.acceptance === null) return { usable: [], usableIds: new Set(), latestUsableId: "none", due: { due: false, reason: "无验收包" } };
  const records = recordsOf(world);
  const result = await usableExplorations(records, {
    acceptanceVersion: world.acceptance.acceptanceVersion,
    isArtifactUsable: artifactUsableInDir(world.taskDir),
  });
  const due = explorationDue(records, result.usable);
  return { ...result, due };
}

function findingFacts(world, revision) {
  if (world.acceptance === null) return { openRecords: [], openIds: new Set(), raisedRecords: [] };
  return openFindingsFromEvents(recordsOf(world), {
    revision,
    acceptanceVersion: world.acceptance.acceptanceVersion,
  });
}

function commandJudgment(command, args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  const world = loadWorldAuto(options["task-dir"]);
  const revision = options.revision ?? computeRevision(world.task.projectRoot);
  if (command === "open-findings") {
    const facts = findingFacts(world, revision);
    printJson({
      taskDir: world.taskDir,
      revision,
      acceptanceVersion: world.acceptance?.acceptanceVersion ?? null,
      openIds: [...facts.openIds],
      open: facts.openRecords.map((record) => ({
        findingId: record.findingId,
        summary: record.summary ?? "",
        category: record.category,
        severity: record.severity,
        requirementIds: record.requirementIds,
        reopenOf: record.reopenOf ?? null,
      })),
    });
    return;
  }
  if (command === "repair-budget") {
    printJson({ taskDir: world.taskDir, ...repairBudgetFromEvents(recordsOf(world)) });
    return;
  }
  usageFail(`未知判定命令 ${command}。`);
}

async function commandExploration(command, args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  const world = loadWorldAuto(options["task-dir"]);
  const facts = await explorationFacts(world);
  if (command === "usable-explorations") {
    printJson({
      taskDir: world.taskDir,
      acceptanceVersion: world.acceptance?.acceptanceVersion ?? null,
      usableIds: [...facts.usableIds],
      latestUsableId: facts.latestUsableId,
      usable: facts.usable.map((record) => ({ eventId: record.eventId, seq: record.seq, artifact: record.artifact })),
    });
    return;
  }
  if (command === "exploration-due") {
    printJson({ taskDir: world.taskDir, ...facts.due });
    return;
  }
  usageFail(`未知探索命令 ${command}。`);
}

// ── 验收包冻结态（写入防护的观测面：chmod 位 + 哈希绑定 + 篡改检出）──
function acceptancePackageFacts(world) {
  if (world.acceptance === null) return { state: "absent" };
  const frozen = world.fold?.approvals?.length > 0;
  const facts = { state: frozen ? "frozen" : "drafting", acceptanceVersion: world.acceptance.acceptanceVersion };
  try {
    const acceptanceStat = statSync(join(world.taskDir, "acceptance.json"));
    const incrementsStat = statSync(join(world.taskDir, "increments.json"));
    facts.writable = Boolean(acceptanceStat.mode & 0o200) || Boolean(incrementsStat.mode & 0o200);
  } catch {
    facts.writable = null;
  }
  if (frozen) {
    const lastApproval = world.fold.approvals[world.fold.approvals.length - 1];
    const lastOpen = (world.fold?.revisionOpens ?? []).at(-1);
    facts.lastApprovalSeq = lastApproval.seq;
    facts.lastOpenSeq = lastOpen?.seq ?? null;
    facts.tampered = lastApproval.acceptancePackageSha256 !== world.packageSha256 && !(lastOpen && lastOpen.seq > lastApproval.seq);
    if (facts.tampered) {
      facts.recovery = "冻结验收包被改动：合法修订走 delivery-gate open-revision 后重新审查与批准；否则从 frozen 快照恢复文件";
    }
  }
  return facts;
}

// ── 任务流状态推导（verdict 态 → 转移表流程态）──
function deriveFlowState(world, verdict, findingOpenIds, exploration) {
  if (verdict === null) return "acceptance-drafting";
  const schema2 = world.acceptance?.schemaVersion === 2;
  switch (verdict.state) {
    case "superseded":
    case "supersede-cancelled":
    case "supersede-pending":
    case "revision-unstable":
    case "process-failed":
    case "accepted":
    case "accepted_with_risk":
      return verdict.state;
    case "draft": {
      const reviewed = (world.fold?.reviews ?? []).some((event) => event.conclusion === "pass");
      return reviewed ? "acceptance-reviewed" : "acceptance-drafting";
    }
    case "design":
      return "design";
    case "acceptance-approved":
    case "implementing": {
      // verdict 输出不含 missingIncrementIds（gate 内部局部量）——按增量清单自算
      const allIncrementIds = world.increments !== null ? world.increments.items.map((item) => item.id) : [];
      const implemented = new Set(verdict.implementedIncrementIds ?? []);
      const implementedAll = allIncrementIds.length > 0 && allIncrementIds.every((id) => implemented.has(id));
      if (!implementedAll) return "implementing";
      if (schema2 && exploration.due.due) return "candidate-formed";
      if (findingOpenIds.size > 0) {
        const lastAssurance = (world.fold?.assurances ?? []).at(-1);
        const lastRepair = (world.fold?.repairs ?? []).at(-1);
        if (lastRepair && (!lastAssurance || lastRepair.seq > lastAssurance.seq)) return "repairing";
        return "assuring";
      }
      if ((world.fold?.assurances ?? []).length === 0) return "implementation-recorded";
      return "candidate";
    }
    default:
      return "candidate";
  }
}

// 「下一步」唯一回答者。输出顺序 = 待办优先 → 五域状态 → 合法转移（含执行器与角色）→ 预算。
async function commandNext(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision", "status-file"] });
  const world = loadWorldAuto(options["task-dir"]);
  const revision = options.revision ?? computeRevision(world.task.projectRoot);
  let verdict = null;
  try {
    verdict = buildVerdict(world, revision);
  } catch (error) {
    // 早期任务（无验收批准等）verdict 组装可能失败——降级为无 verdict，流程态走推导
    verdict = null;
  }
  const pending = readPending(world.taskDir);
  const finding = findingFacts(world, revision);
  const exploration = await explorationFacts(world);
  const budget = repairBudgetFromEvents(recordsOf(world));
  const regrades = findingRegrades(recordsOf(world));
  const flowState = deriveFlowState(world, verdict, finding.openIds, exploration);

  const mustFixOpen = finding.openRecords.filter((record) => record.category === "defect" && record.severity === "blocker").length;
  const taskDomain = KERNEL_RULES.domains.task;
  const legalTransitions = taskDomain.transitions
    .filter((transition) => transition.from === flowState || transition.from === "*")
    .map((transition) => ({
      to: transition.to,
      event: transition.event,
      executor: transition.executor,
      actor: transition.actor,
      repairBackedge: transition.backedge === "repair",
      requires: transition.requires ?? [],
    }));

  const output = {
    taskDir: world.taskDir,
    generatedBy: "delivery-core",
    generatedAt: new Date().toISOString(),
    revision,
    flowState,
    verdictState: verdict?.state ?? null,
    nextAction: verdict?.nextAction ?? null,
    pendingActions: pending.items.filter((item) => item.status === "open"),
    legalTransitions,
    machineChecks: {
      schema2: world.acceptance?.schemaVersion === 2,
      mustFixOpen,
      openFindings: finding.openIds.size,
      explorationDue: exploration.due.due,
      usableExplorations: exploration.usableIds.size,
    },
    budgets: {
      repair: budget,
      findingRegrades: regrades.offenders.length > 0 ? { halt: regrades.halt, offenders: regrades.offenders } : { halt: regrades.halt, offenders: [] },
    },
    domains: {
      finding: { open: finding.openIds.size, ids: [...finding.openIds] },
      exploration: { due: exploration.due.due, reason: exploration.due.reason, usable: exploration.usableIds.size },
      acceptancePackage: acceptancePackageFacts(world),
      node: null,
    },
  };
  if (options["status-file"]) {
    output.domains.node = nodeDomainFacts(options["status-file"]);
  }
  printJson(output);
}

function nodeDomainFacts(statusFilePath) {
  if (!existsSync(statusFilePath)) return { error: `status 文件不存在：${statusFilePath}` };
  try {
    const status = JSON.parse(readFileSync(statusFilePath, "utf8"));
    const nodes = status.nodes ?? {};
    const byStatus = {};
    for (const entry of Object.values(nodes)) {
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }
    return { byStatus, total: Object.keys(nodes).length };
  } catch (error) {
    return { error: `status 文件不可解析：${error.message}` };
  }
}

// ── DAG 节点转移（node 域唯一判定；rules.json node 表驱动合法性与 attempts 语义）──
function commandNodeTransition(args) {
  const options = parseOptions(args, {
    required: ["status", "node", "event"],
    optional: ["current-json", "payload", "basis", "reason", "commit", "evidence", "detail"],
    flags: ["dry-run"],
  });
  const eventName = options.event;
  const nodeTable = KERNEL_RULES.domains.node;
  let status;
  let current;
  const dryRun = options["dry-run"] === "true";
  if (options["current-json"] !== undefined) {
    current = JSON.parse(options["current-json"]);
    status = null;
  } else {
    if (!existsSync(options.status)) fail(`status 文件不存在：${options.status}`, "核对 --status 路径后重试。");
    try {
      status = JSON.parse(readFileSync(options.status, "utf8"));
    } catch (error) {
      fail(`status 文件不是合法 JSON：${error.message}`, "修复 status 文件后重试，或用 --current-json 传入当前节点条目做纯判定。");
    }
    current = status.nodes?.[options.node];
    if (current === undefined) current = { status: "pending", attempts: 0 };
  }
  const fromStatus = current.status ?? "pending";
  const transition = nodeTable.transitions.find((candidate) => candidate.event === eventName && candidate.from === fromStatus);
  if (transition === undefined) {
    const legal = nodeTable.transitions.filter((candidate) => candidate.from === fromStatus).map((candidate) => candidate.event);
    fail(`节点 ${options.node} 在 ${fromStatus} 态不接受事件 ${eventName}（该态合法事件：${legal.join(", ") || "无"}）。`, "按 node 域转移表修正事件或先转移到前置状态；人工处置用 manual-disposition 并带 --basis。");
  }
  if (eventName === "finish-done" || eventName === "reconcile-done") {
    if (typeof options.commit !== "string" || options.commit === "") {
      fail(`${eventName} 需要提交回执。`, "带 --commit <sha> 后重试。");
    }
  }
  if ((eventName === "block" || eventName === "fail") && (options.reason ?? "") === "") {
    fail(`${eventName} 需要 --reason（阻塞/失败原因必填）。`, "补 --reason 后重试。");
  }
  if (eventName === "manual-disposition" && (options.basis ?? "") === "") {
    fail("manual-disposition 需要 --basis（人工处置依据必填，留痕供复盘）。", "补 --basis：说明为什么该节点可判 done（如阻塞原因已消除的证据）。");
  }
  const priorAttempts = typeof current.attempts === "number" ? current.attempts : 0;
  // attempts 语义（与 rules.json node 域 effect 注记同口径，wave-executor-v5 同表对拍）：
  // 派发即计数（begin +1）；完成/阻塞/失败/重排队保留；reconcile-done 补记 +1（下限 1）
  let entry;
  switch (eventName) {
    case "begin":
      entry = { status: "in-progress", attempts: priorAttempts + 1 };
      break;
    case "finish-done":
      entry = { status: "done", attempts: Math.max(1, priorAttempts), ...(options.commit ? { commit: options.commit } : {}), ...(options.evidence ? { evidence: options.evidence } : {}) };
      break;
    case "block":
      entry = { status: "blocked", attempts: priorAttempts, reason: options.reason };
      break;
    case "fail":
      entry = { status: "failed", attempts: priorAttempts, reason: options.reason };
      break;
    case "reset":
      entry = { status: "pending", attempts: priorAttempts };
      break;
    case "suspend":
      entry = { status: "suspended", attempts: priorAttempts };
      break;
    case "resume":
      entry = { status: "pending", attempts: priorAttempts };
      break;
    case "reconcile-pending":
      entry = { status: "pending", attempts: priorAttempts };
      break;
    case "reconcile-done":
      entry = { status: "done", attempts: Math.max(1, priorAttempts + 1), commit: options.commit, ...(options.evidence ? { evidence: options.evidence } : {}) };
      break;
    case "manual-disposition":
      entry = { status: "done", attempts: Math.max(1, priorAttempts), evidence: `人工处置：${options.basis}` };
      break;
    default:
      fail(`事件 ${eventName} 未实现执行分支。`, "该事件已在转移表登记但缺执行分支——补 delivery-core.mjs 的 switch 分支后重试。");
  }
  const detail =
    options.detail ??
    (eventName === "manual-disposition"
      ? `人工处置（basis=${options.basis}）`
      : eventName === "block" || eventName === "fail"
        ? options.reason
        : options.commit
          ? `commit=${options.commit}`
          : eventName);
  if (dryRun || status === null) {
    printJson({ ok: true, node: options.node, event: eventName, from: fromStatus, to: entry.status, entry });
    return;
  }
  status.nodes[options.node] = entry;
  const events = Array.isArray(status.events) ? status.events : [];
  events.push({ seq: events.length + 1, node: options.node, event: eventName, detail });
  status.events = events;
  writeFileSync(options.status, `${JSON.stringify(status, null, 2)}\n`);
  printJson({ ok: true, node: options.node, event: eventName, from: fromStatus, to: entry.status, entry, written: true });
}

// ── main 分发 ──
const command = process.argv[2];
const commandArgs = process.argv.slice(3);
try {
  switch (command) {
    case "validate": {
      const errors = validateRules(KERNEL_RULES);
      if (errors.length > 0) {
        for (const error of errors) process.stderr.write(`delivery-core: ${error}\n`);
        process.exitCode = 1;
        process.stderr.write("恢复动作：修正 kernel/rules.json 后重跑 validate（转移表错误 = 流程顺序矛盾，提交前必须清零）。\n");
      } else {
        printJson({ valid: true, domains: Object.keys(KERNEL_RULES.domains), budgets: KERNEL_RULES.budgets });
      }
      break;
    }
    case "rules": {
      printJson(KERNEL_RULES);
      break;
    }
    case "next":
      await commandNext(commandArgs);
      break;
    case "pending": {
      const action = process.argv[3];
      if (!["add", "resolve", "list"].includes(action ?? "")) {
        usageFail(`用法：delivery-core pending <add|resolve|list> --task-dir D [--kind K --note N] / [--id PA-N [--outcome S]]。`);
      }
      commandPending([action, ...process.argv.slice(4)]);
      break;
    }
    case "budget": {
      const options = parseOptions(commandArgs, { required: ["task-dir"], optional: [] });
      const world = loadWorldAuto(options["task-dir"]);
      const records = recordsOf(world);
      printJson({ taskDir: world.taskDir, repair: repairBudgetFromEvents(records), findingRegrades: findingRegrades(records) });
      break;
    }
    case "open-findings":
    case "repair-budget":
      commandJudgment(command, commandArgs);
      break;
    case "usable-explorations":
    case "exploration-due":
      await commandExploration(command, commandArgs);
      break;
    case "node-transition":
      commandNodeTransition(commandArgs);
      break;
    default:
      usageFail(
        `未知命令 ${JSON.stringify(command ?? "")}。合法命令：validate / rules / next / pending / budget / open-findings / usable-explorations / exploration-due / repair-budget / node-transition。`,
      );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`delivery-core: ${message}\n`);
  if (!/恢复动作/.test(message)) {
    process.stderr.write("恢复动作：检查参数与任务目录状态后重试；若仍失败，保留此错误并排查 delivery-core.mjs。\n");
  }
  process.exitCode = 1;
}
