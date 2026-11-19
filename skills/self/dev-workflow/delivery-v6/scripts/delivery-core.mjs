#!/usr/bin/env node
// delivery-core.mjs — 交付事务内核 CLI（V6）
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
//     full-qualification full 保证资格判定（同上：历史 full 能否作为 recheck/full-first 资格）
//     node-transition  DAG 节点状态转移（wave-executor 六写入点收敛后的唯一判定；
//                      --dry-run 供引擎在串行写链内先判定后自写，非 dry-run 直接落盘；
//                      manual-disposition 带 --task-dir 时自动登记待复盘待办）
//     node-project     status.json 派生视图：按 status.events 重算节点状态视图，比对在盘
//                      nodes（篡改/漂移检测），--write 以事件为准重建（恢复通道）
//     events           事件时间线读侧合流：交付事件（domain 盖章）+ 过程记录
//                      （process-review.jsonl，process 域）按序合并输出
//     replay           历史任务回放：逐事件前缀推算阶段，报告转移表无法表达的
//                      事件序列（定义期矛盾检测对真实数据的补充）
//     loop-attempt     循环尝试登记（loop-attempts.jsonl 执行记录；started/finished，
//                      按 attemptKey 幂等，打回/失败/中断均计数）
//     loop-budget      循环尝试预算查询（started 计数 vs rules.json 上限；未接入循环 cap=null）
//     revision-provenance revision 来源对账（只读派生：每次 revision 变化的来源清单 +
//                      unknown 区间计数）
//     obligations      交付义务派生（verdict/事件流/pending 聚合视图 + open 必需义务清单）
//
// 单源纪律：判定逻辑一律 import lib/kernel-judgments.mjs 或读 kernel/rules.json，
// 本文件不另立判定副本。gate 内部函数经 delivery-gate.mjs 导入复用（同一份实现）。

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_RULES,
  LOOP_BUDGET_CAP_KEYS,
  deriveObligations,
  deriveRevisionProvenance,
  explorationDue,
  findingRegrades,
  loopAttemptsBudget,
  openFindingsFromEvents,
  parseLoopAttemptsText,
  priorFullQualification,
  projectNodeEvents,
  repairBudgetFromEvents,
  taskPhaseFromEvents,
  usableExplorations,
} from "./lib/kernel-judgments.mjs";
import {
  buildVerdict,
  computeRevision,
  loadTaskCore,
  loadWorld,
  runtimeObligationsOf,
} from "./delivery-gate.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_PATH = join(SKILL_ROOT, "scripts", "kernel", "rules.json");
const PENDING_KINDS = ["cleanup", "awaiting-restore", "awaiting-registration", "awaiting-ruling", "awaiting-review"];

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
//   ④ 同一 (from,event) 至多一条转移（判定唯一：node-transition 等查表按 event+from 定位，
//      同状态同事件必须唯一去向与唯一执行器；同一 (from,to) 允许多事件并存——不同业务
//      原因如恢复对账 reconcile-pending 与级联失效 cascade-reset 合法共享同一状态变化）
//   ⑤ requires ∈ 谓词词表；actor ∈ 角色词表；terminalStates ⊆ states
//   ⑥ 非终态非 initial 状态必须有出边（死端 = 流程走进去出不来）
//   ⑦ eventDomains 域闭包且事件不重复登记；writeMatrix 角色/域/阶段在词表且 (actor,domain) 唯一
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
      // 判定唯一性按 (from,event)：查表入口（node-transition / 转移发起）以「某状态收某事件」
      // 定位转移，同状态同事件出现两条边 = 判定歧义；(from,to) 不唯一是合法形态（同状态变化
      // 可来自不同业务原因），不再拦截
      const pairKey = `${transition.from}\u0000${transition.event}`;
      if (edges.has(pairKey)) errors.push(`${tLabel}: 与 ${edges.get(pairKey)} 重复定义同一 (from,event) 转移`);
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
  // ⑦ eventDomains / writeMatrix：域词表闭包、矩阵角色与域在词表、states 用任务阶段词表
  const writeDomainSet = new Set(rules.writeDomains?.values ?? []);
  const taskStateSet = new Set(rules.domains.task.states);
  const domainOfEvent = new Map();
  for (const [writeDomain, eventTypes] of Object.entries(rules.eventDomains ?? {})) {
    if (writeDomain.startsWith("//")) continue;
    if (!Array.isArray(eventTypes)) {
      errors.push(`eventDomains: 域 ${writeDomain} 的值必须是事件类型数组`);
      continue;
    }
    if (!writeDomainSet.has(writeDomain)) errors.push(`eventDomains: 域 ${writeDomain} 不在 writeDomains 词表`);
    for (const eventType of eventTypes) {
      if (domainOfEvent.has(eventType)) errors.push(`eventDomains: 事件 ${eventType} 在 ${domainOfEvent.get(eventType)} 与 ${writeDomain} 两域重复登记`);
      else domainOfEvent.set(eventType, writeDomain);
    }
  }
  const matrixRows = new Map();
  for (const row of rules.writeMatrix?.rows ?? []) {
    if (!actorSet.has(row.actor)) errors.push(`writeMatrix: actor ${row.actor} 不在角色词表`);
    if (!writeDomainSet.has(row.domain)) errors.push(`writeMatrix: 域 ${row.domain} 不在 writeDomains 词表（process 域不可经签名事件流写入，不设行）`);
    const rowKey = `${row.actor}\u0000${row.domain}`;
    if (matrixRows.has(rowKey)) errors.push(`writeMatrix: ${row.actor} × ${row.domain} 重复登记`);
    else matrixRows.set(rowKey, row);
    if (!Array.isArray(row.states) || row.states.length === 0) errors.push(`writeMatrix: ${row.actor} × ${row.domain} states 为空`);
    for (const stateName of row.states ?? []) {
      if (stateName !== "*" && !taskStateSet.has(stateName)) errors.push(`writeMatrix: ${row.actor} × ${row.domain} 状态 ${stateName} 不在任务域状态词表`);
    }
  }
  return errors;
}

// ── 待办实体（脑内状态落盘；advisory 状态不签名不进事件流——它驱动 next，不是证据）──
function pendingPath(taskDir) {
  return join(taskDir, "pending-actions.json");
}

function readPending(taskDir, { onUnparseable = "tolerate" } = {}) {
  const filePath = pendingPath(taskDir);
  if (!existsSync(filePath)) return { items: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    // 判定路径（obligations）损坏即报错：损坏文件中的 blocking 待办不得按不存在处理
    //（设计 §14「未知默认不接受交付」）；查询路径（pending list）容忍并在输出披露
    // unreadable，不崩
    if (onUnparseable === "fail") {
      fail(
        `pending-actions.json 解析失败（${error.message}）：损坏文件中的 blocking 待办不得按不存在处理。`,
        `修复 ${filePath} 的 JSON 语法后重跑本命令（权威源 = 该文件；修复前不得依据本次输出判定交付义务）`,
      );
    }
    return { items: [], unreadable: true, parseError: error.message };
  }
  return { items: Array.isArray(parsed.items) ? parsed.items : [] };
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
    // 查询路径容忍损坏：unreadable 披露文件状态（open/resolved 为空清单不代表无待办）
    printJson({
      taskDir: core.taskDir,
      ...(document.unreadable === true ? { unreadable: true, parseError: document.parseError } : {}),
      open: document.items.filter((item) => item.status === "open"),
      resolved: document.items.filter((item) => item.status !== "open"),
    });
    return;
  }
  if (action === "add") {
    if (!PENDING_KINDS.includes(options.kind ?? "")) {
      fail(`--kind 必须是 ${PENDING_KINDS.join(" / ")} 之一（善后/待恢复/待登记/待裁决/待复盘）。`, "按中断时的实际待办类型重选 kind 后重试。");
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
  usageFail(`pending 子命令必须是 add / resolve / list（用法：pending <子命令> --task-dir <taskDir> [...]）。`);
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
    // 账本行传入 = 跨 run 保证预算走 started 尝试口径（V5 §8.1）；无账本时内核回退
    // 成功事件口径并带 migrationNote 注记
    printJson({ taskDir: world.taskDir, ...repairBudgetFromEvents(recordsOf(world), { attemptRows: readLoopAttemptRows(world.taskDir) }) });
    return;
  }
  usageFail(`未知判定命令 ${command}。`);
}

// full 保证资格判定（workflow 预检消费入口）：历史 full 能否作为 recheck / full-first
// 的资格基础。输入与裁决器 buildVerdict 完全同源——world.fold 三组记录（artifact 失效
// 事件已在折算阶段过滤）+ 当前增量清单；判定谓词在 kernel-judgments 单源
function commandFullQualification(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: [] });
  const world = loadWorldAuto(options["task-dir"]);
  if (world.acceptance === null) {
    // 无验收包（早期任务）：无保证资格可判，空结果而非报错——与探索/发现查询的无包
    // 降级同思路，查询类命令不因包缺失崩溃
    printJson({
      taskDir: world.taskDir,
      acceptanceVersion: null,
      qualified: false,
      qualifiedEventIds: [],
      inspections: [],
      reason: "无验收包（acceptance.json 缺失），无保证资格可判",
    });
    return;
  }
  const judgment = priorFullQualification(
    { assurances: world.fold.assurances, evidence: world.fold.evidence, explorations: world.fold.explorations },
    {
      incrementIds: world.increments.items.map((item) => item.id),
      usesAssertions: world.acceptance.schemaVersion === 2,
      exploratoryReviewRequired: world.acceptance.exploratoryReview === "required",
    },
  );
  printJson({ taskDir: world.taskDir, acceptanceVersion: world.acceptance.acceptanceVersion, ...judgment });
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

// ── 验收包冻结态（写入防护的检查事实：chmod 位 + 哈希绑定 + 篡改检出）──
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
// 推导序（两断点修复后的终态口径）：verdict 裁决终态直接短路；实现段三态
// （acceptance-approved=零登记 / implementing=部分登记或有未接受 blocker / candidate=登记后
// 证据缺口常态）共用事件流主链——主链走不通（证据缺口）不等于流程没走到，此前 verdict=candidate
// 直落 candidate 使 implementation-recorded/assuring 主链态与 assurance-start 边不可达
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
    case "implementing":
    case "candidate":
      return deriveMainChainFlowState(world, verdict, findingOpenIds, exploration, schema2);
    default:
      return "candidate";
  }
}

// 实现段主链推导（以事件/登记进度为准，verdict 只决定进入本链与否）。推导序：
//   增量未全登记：schema2 探索已完成（due=false）→ candidate-explored（D4 登记窗口：
//     探索完成、增量未全登记——register-implementation 边在该态可达；旧口径恒落
//     implementing 使 candidate-explored 永不产出）；否则 implementing（探索仍 due，
//     explore-only 边合法——V4 死锁修复语义保留）
//   增量全登记：schema2 探索 due → candidate-formed；open finding → assuring/repairing
//     （seq 比较保留）；无保证 → implementation-recorded（assurance-start 边可达）；
//     保证已完成 → finalizing（evaluate 边可达，终态裁决交给 verdict 短路）
function deriveMainChainFlowState(world, verdict, findingOpenIds, exploration, schema2) {
  // verdict 输出不含 missingIncrementIds（gate 内部局部量）——按增量清单自算
  const allIncrementIds = world.increments !== null ? world.increments.items.map((item) => item.id) : [];
  const implemented = new Set(verdict.implementedIncrementIds ?? []);
  const implementedAll = allIncrementIds.length > 0 && allIncrementIds.every((id) => implemented.has(id));
  if (!implementedAll) {
    // D4 登记窗口：schema2 下探索已完成（due=false 即可用探索不早于最近判据变化）而
    // 增量未全登记——流程态是 candidate-explored 而非 implementing
    if (schema2 && !exploration.due.due) return "candidate-explored";
    return "implementing";
  }
  if (schema2 && exploration.due.due) return "candidate-formed";
  if (findingOpenIds.size > 0) {
    const lastAssurance = (world.fold?.assurances ?? []).at(-1);
    const lastRepair = (world.fold?.repairs ?? []).at(-1);
    if (lastRepair && (!lastAssurance || lastRepair.seq > lastAssurance.seq)) return "repairing";
    return "assuring";
  }
  if ((world.fold?.assurances ?? []).length === 0) return "implementation-recorded";
  // 主链末段：增量全登记、无 open finding、保证已完成——finalizing 等 evaluate 裁决
  // （旧口径此处返回 candidate，跳过了 finalizing→candidate 的 evaluate 主链边）
  return "finalizing";
}

// 「下一步」唯一回答者。输出顺序 = 待办优先 → 五域状态 → 合法转移（含执行器与角色）→ 预算。
// ── 转移分类与预填发起（三-6：例行转移给到可直接照抄的发起形态；裁决点显式停回）──
// 裁决类谓词 = rules.json predicates.decider=user 的登记集合（单源生成，不本地枚举——
// 新增 decider=user 谓词时转移分类自动跟随；本地枚举会让新谓词被误分类为可自动执行）
const ADJUDICATION_PREDICATES = new Set(
  Object.entries(KERNEL_RULES.predicates)
    .filter(([, definition]) => definition !== null && typeof definition === "object" && definition.decider === "user")
    .map(([name]) => name),
);
// CreateWorkflow 可直接发起的 workflow 名 → 预填参数骨架（凭据由主 agent 持有，占位）
const WORKFLOW_LAUNCH_ARGS = {
  "acceptance-design-v6": { projectRoot: "<projectRoot>", taskDir: "<taskDir>", objective: "<objective>", assuranceCredentialId: "<assuranceCredentialId>" },
  "candidate-build-v6": { projectRoot: "<projectRoot>", taskDir: "<taskDir>", builderCredentialId: "<builderCredentialId>", assuranceCredentialId: "<assuranceCredentialId>" },
  "independent-assurance-v6": { projectRoot: "<projectRoot>", taskDir: "<taskDir>", assuranceCredentialId: "<assuranceCredentialId>", mode: "<full|recheck|explore-only>" },
  "assurance-repair-loop-v6": { projectRoot: "<projectRoot>", taskDir: "<taskDir>", assuranceCredentialId: "<assuranceCredentialId>", builderCredentialId: "<builderCredentialId>", allowCommit: "<bool>" },
};
const WORKFLOW_NAMES = new Set(Object.keys(WORKFLOW_LAUNCH_ARGS));

function classifyTransition(transition) {
  if ((transition.requires ?? []).some((predicate) => ADJUDICATION_PREDICATES.has(predicate))) return "adjudication";
  const executor = transition.executor ?? "";
  if (executor.startsWith("delivery-gate")) return "gate-command";
  for (const name of WORKFLOW_NAMES) {
    if (executor === name || executor.startsWith(`${name} `) || executor.startsWith(`${name} --`)) return "workflow";
  }
  if (executor.startsWith("tech-design-v6") || executor.startsWith("dev-flow-v6")) return "skill";
  return "engine";
}

function launchSpecOf(transition, world) {
  const executor = transition.executor ?? "";
  const [workflowName, ...rest] = executor.split(/\s+/);
  const replacements = { "<projectRoot>": world.task?.projectRoot ?? "<projectRoot>", "<taskDir>": world.taskDir };
  const args = {};
  for (const [key, value] of Object.entries(WORKFLOW_LAUNCH_ARGS[workflowName] ?? {})) {
    args[key] = replacements[value] ?? value;
  }
  for (const token of rest) {
    if (token.startsWith("--") && token.includes("=")) {
      const [flag, value] = token.slice(2).split("=");
      args[flag] = replacements[value] ?? value;
    } else if (token.startsWith("--mode")) {
      // 「--mode explore-only」拆词形态：值取后续词（executor 字符串内联常量）
    }
  }
  const modeMatch = executor.match(/--mode\s+(\S+)/);
  if (modeMatch !== null) args.mode = modeMatch[1];
  return {
    zcode: `CreateWorkflow saved: ${workflowName}（args 见下，凭据占位符替换为实际 credentialId）`,
    pi: `workflow run ${workflowName}`,
    args,
  };
}

async function commandNext(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision", "status-file"], flags: ["auto"] });
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
  // 账本行传入 = 跨 run 保证预算走 started 尝试口径（V5 §8.1），与 repair-budget 子命令同源
  const budget = repairBudgetFromEvents(recordsOf(world), { attemptRows: readLoopAttemptRows(world.taskDir) });
  const regrades = findingRegrades(recordsOf(world));
  const flowState = deriveFlowState(world, verdict, finding.openIds, exploration);

  // must-fix 计数按策略分类实例化（与 gate uniqueMustFix 同口径）：阻断位 = blocksAccepted
  // ===true 的分类集合（默认 defect），不字面量比对分类 id——策略新增阻断分类后计数随策略走
  const blockingCategoryIds = new Set(
    (world.policy?.["finding-categories.json"]?.categories ?? [])
      .filter((entry) => entry !== null && typeof entry === "object" && entry.blocksAccepted === true)
      .map((entry) => entry.id),
  );
  const mustFixOpen = finding.openRecords.filter((record) => blockingCategoryIds.has(record.category) && record.severity === "blocker").length;
  const taskDomain = KERNEL_RULES.domains.task;
  const legalTransitions = taskDomain.transitions
    .filter((transition) => transition.from === flowState || transition.from === "*")
    .map((transition) => {
      const kind = classifyTransition(transition);
      return {
        to: transition.to,
        event: transition.event,
        executor: transition.executor,
        actor: transition.actor,
        kind,
        repairBackedge: transition.backedge === "repair",
        requires: transition.requires ?? [],
        ...(kind === "workflow" ? { launch: launchSpecOf(transition, world) } : {}),
      };
    });
  // 例行转移中唯一可安全自动执行的是 evaluate（幂等、无用户语义输入；其余 gate 命令
  // 需 confirmation/summary 等裁决语义，workflow/skill 类由主 agent 按预填规格发起）
  const auto = [];
  if (options.auto === "true") {
    const evaluateTransitions = legalTransitions.filter(
      (transition) => transition.kind === "gate-command" && transition.event === "evaluate",
    );
    for (const transition of evaluateTransitions) {
      const { spawnSync } = await import("node:child_process");
      const gatePath = join(SKILL_ROOT, "scripts", "delivery-gate.mjs");
      const run = spawnSync(process.execPath, [gatePath, "evaluate", "--task-dir", world.taskDir], { encoding: "utf8" });
      let verdictState = null;
      try {
        verdictState = JSON.parse(run.stdout).state ?? null;
      } catch {
        verdictState = null;
      }
      auto.push({ event: "evaluate", to: transition.to, exitCode: run.status, verdictState, error: run.status === 0 ? null : run.stderr.trim() });
    }
  }

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
    ...(auto.length > 0 ? { auto } : {}),
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
    optional: ["current-json", "payload", "basis", "reason", "commit", "evidence", "detail", "task-dir"],
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
  // attempts 语义（与 rules.json node 域 effect 注记同口径，wave-executor-v6 同表对拍）：
  // 派发即计数（begin +1）；完成/阻塞/失败/重排队/级联失效保留；reconcile-done 补记 +1（下限 1）
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
    case "cascade-reset":
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
  // payload = 结构化字段（node-project 派生视图的无损重算依赖它；detail 保持人读）
  const payload = {};
  if (options.commit !== undefined) payload.commit = options.commit;
  if (options.evidence !== undefined) payload.evidence = options.evidence;
  if (options.reason !== undefined) payload.reason = options.reason;
  if (options.basis !== undefined) payload.basis = options.basis;
  events.push({
    seq: events.length + 1,
    node: options.node,
    event: eventName,
    detail,
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  });
  status.events = events;
  writeFileSync(options.status, `${JSON.stringify(status, null, 2)}\n`);
  // 人工处置 = 逃生口不是后门：每次使用登记待复盘待办（设计文档 §5），复盘后 resolve
  let reviewRegistered = false;
  if (eventName === "manual-disposition" && options["task-dir"] !== undefined) {
    const core = loadTaskCore(options["task-dir"]);
    const document = readPending(core.taskDir);
    document.items.push({
      id: `pa-${document.items.length + 1}`,
      kind: "awaiting-review",
      note: `人工处置复盘：节点 ${options.node} 判 done（依据：${options.basis}）——确认处置正确并总结为何走到人工通道`,
      ref: options.status,
      createdAt: new Date().toISOString(),
      status: "open",
    });
    writePending(core.taskDir, document);
    reviewRegistered = true;
  }
  printJson({ ok: true, node: options.node, event: eventName, from: fromStatus, to: entry.status, entry, written: true, reviewRegistered });
}

// ── status.json 派生视图（二-1：事件为源，nodes 是派生视图；篡改/漂移检测 + 恢复通道）──
function commandNodeProject(args) {
  const options = parseOptions(args, { required: ["status"], optional: [], flags: ["write"] });
  if (!existsSync(options.status)) fail(`status 文件不存在：${options.status}`, "核对 --status 路径后重试。");
  let status;
  try {
    status = JSON.parse(readFileSync(options.status, "utf8"));
  } catch (error) {
    fail(`status 文件不是合法 JSON：${error.message}`, "修复 status 文件后重试；无法解析时以 git 与日志为源重建。");
  }
  const events = Array.isArray(status.events) ? status.events : [];
  const projection = projectNodeEvents(events, KERNEL_RULES.domains.node);
  const onDisk = status.nodes ?? {};
  const mismatches = [];
  const nodeIds = new Set([...Object.keys(projection.nodes), ...Object.keys(onDisk)]);
  for (const nodeId of nodeIds) {
    const projected = projection.nodes[nodeId];
    const disk = onDisk[nodeId];
    const same =
      disk !== undefined &&
      projected !== undefined &&
      disk.status === projected.status &&
      disk.attempts === projected.attempts;
    if (!same) mismatches.push({ node: nodeId, projected, onDisk: disk ?? null });
  }
  const result = {
    statusFile: options.status,
    eventsReplayed: events.length,
    partialEvents: projection.partialEvents,
    nodeCount: Object.keys(projection.nodes).length,
    consistent: mismatches.length === 0,
    mismatches,
  };
  if (mismatches.length > 0) {
    result.recovery = "以事件为源恢复：delivery-core node-project --status <path> --write（nodes 按事件重算重建；events 不动）；mismatches 非零 = 在盘 nodes 与事件流不一致（写入绕过转移入口或手工编辑）";
  }
  if (options.write === "true") {
    status.nodes = projection.nodes;
    writeFileSync(options.status, `${JSON.stringify(status, null, 2)}\n`);
    result.written = true;
  }
  printJson(result);
}

// ── 事件时间线读侧合流（三-3：交付事件 domain 盖章 + 过程记录 process 域，单一读取口）──
function domainOfType(eventType) {
  // "//" 是 rules.json 的注释键（值是说明文字不是事件数组）：不过滤会被 String.prototype.includes
  // 当子串匹配，注释文本命中事件名子串即错判 domain——与 validateRules 的注释键过滤同口径
  for (const [domain, types] of Object.entries(KERNEL_RULES.eventDomains)) {
    if (domain.startsWith("//")) continue;
    if (types.includes(eventType)) return domain;
  }
  return "unknown";
}

function commandEventsTimeline(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["domain"] });
  const world = loadWorldAuto(options["task-dir"]);
  const timeline = [];
  for (const entry of world.entries) {
    const record = entry.record;
    timeline.push({
      source: "events",
      seq: record.seq,
      domain: typeof record.domain === "string" ? record.domain : domainOfType(record.type),
      type: record.type,
      at: record.recordedAt ?? null,
      summary: record.summary ?? "",
    });
  }
  const processPath = join(world.taskDir, "process-review.jsonl");
  if (existsSync(processPath)) {
    const lines = readFileSync(processPath, "utf8").split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        timeline.push({
          source: "process-review",
          seq: parsed.id ?? null,
          domain: "process",
          type: "ProcessObserved",
          at: parsed.ts ?? null,
          summary: `${parsed.nodeId ?? "?"}/${parsed.mechanism ?? "?"} ${parsed.verdict ?? ""}：${parsed.summary ?? ""}`,
        });
      } catch {
        timeline.push({ source: "process-review", seq: null, domain: "process", type: "ProcessObserved", at: null, summary: `（不可解析行：${line.slice(0, 80)}）` });
      }
    }
  }
  const filtered = options.domain !== undefined ? timeline.filter((item) => item.domain === options.domain) : timeline;
  const counts = {};
  for (const item of timeline) counts[item.domain] = (counts[item.domain] ?? 0) + 1;
  printJson({
    taskDir: world.taskDir,
    counts,
    timeline: filtered,
  });
}

// ── 历史任务回放（三-8：真实事件序列 vs 转移表可表达性——定义期校验的经验补充）──
// 合法性规则：
//   decision 域事件（RiskAccepted 等）= 任意非终态阶段合法（裁决可打断流程，结构上如此）
//   流程事件 = 任务域存在 event 同名边且 from == 当前阶段或 "*"；
//     放行一类在途阶段：AssuranceCompleted 落盘前「保证 run 在途」在事件流不可见
//     （阶段停在 implementation-recorded），assuring/repairing 出发的边在此阶段放行
const REPLAY_INFLIGHT_EDGES = ["AssuranceCompleted", "RepairRoundRecorded", "repair-start"];
function commandReplay(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: [] });
  const world = loadWorldAuto(options["task-dir"]);
  const records = recordsOf(world);
  const incrementsCount = world.increments !== null ? world.increments.items.length : null;
  const taskTransitions = KERNEL_RULES.domains.task.transitions;
  const decisionTypes = new Set(KERNEL_RULES.eventDomains.decision);
  const flowEventNames = new Set(taskTransitions.map((transition) => transition.event));
  const edgeFromByEvent = new Map();
  for (const transition of taskTransitions) {
    if (!edgeFromByEvent.has(transition.event)) edgeFromByEvent.set(transition.event, new Set());
    edgeFromByEvent.get(transition.event).add(transition.from);
  }
  const stats = { routed: 0, decision: 0, relaxedInflight: 0, content: 0, unroutable: 0 };
  const unroutable = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const phase = taskPhaseFromEvents(records.slice(0, index), { incrementsCount });
    if (decisionTypes.has(record.type)) {
      stats.decision += 1;
      continue;
    }
    const edgeEvent = record.type === "TaskSuperseded" ? (record.phase === "committed" ? "supersede-commit" : "supersede-prepare") : record.type;
    if (!flowEventNames.has(edgeEvent)) {
      stats.content += 1; // 内容事件（发现/证据/实现/探索/漂移等）——不驱动任务域转移，阶段无关
      continue;
    }
    const froms = edgeFromByEvent.get(edgeEvent) ?? new Set();
    if (froms.has(phase) || froms.has("*")) {
      stats.routed += 1;
    } else if (froms.has("assuring") && phase === "implementation-recorded" && REPLAY_INFLIGHT_EDGES.includes(edgeEvent)) {
      stats.relaxedInflight += 1;
    } else if (froms.has("assuring") && phase === "finalizing" && edgeEvent === "AssuranceCompleted") {
      // recheck 重入（历史任务回放实证）：判据/探索变化触发的重取证不经过修复轮，
      // 起点（assurance-start）不落事件流——AssuranceCompleted(recheck) 直接从 finalizing 到场
      stats.relaxedInflight += 1;
    } else {
      stats.unroutable += 1;
      unroutable.push({
        seq: record.seq,
        type: record.type,
        phaseBefore: phase,
        legalFrom: [...froms],
        summary: record.summary ?? "",
        note: "该事件在当前阶段按任务域转移表不可表达——补转移边（若语义合法）或确认为词表外操作（应被拦截）",
      });
    }
  }
  const finalPhase = taskPhaseFromEvents(records, { incrementsCount });
  printJson({
    taskDir: world.taskDir,
    events: records.length,
    finalPhase,
    stats,
    unroutable,
    verdict: unroutable.length === 0 ? "全序列可表达" : `${unroutable.length} 个事件不可表达（见 unroutable 清单）`,
  });
}

// ── 循环尝试记录（机制四 §8.1：执行记录落盘，不签名、只追加不回写）──
// workflow 与手工路径共用同一记录；attemptKey = <runId>:<round> 由内核拼装，登记侧
// 不自行拼 key（口径漂移防线）。幂等：同 (attemptKey, event) 重复提交跳过——崩溃恢复
// 后重放登记不产生重复计数（读取端 loopAttemptsBudget 再按同键去重兜底双写竞态）。
const LOOP_PATHS = ["workflow", "manual"];
const LOOP_EVENTS = ["started", "finished"];
const LOOP_OUTCOMES = ["passed", "rejected", "failed", "interrupted"];

function loopAttemptsPath(taskDir) {
  return join(taskDir, "loop-attempts.jsonl");
}

function readLoopAttemptRows(taskDir) {
  const filePath = loopAttemptsPath(taskDir);
  if (!existsSync(filePath)) return [];
  return parseLoopAttemptsText(readFileSync(filePath, "utf8"));
}

function commandLoopAttempt(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "loop", "path", "run-id", "round", "event"],
    optional: ["outcome", "input-hash"],
  });
  if (!LOOP_PATHS.includes(options.path)) {
    fail(`--path 必须是 ${LOOP_PATHS.join(" / ")} 之一（workflow 与手工路径同表记录）。`, "按发起通道选 path 后重试。");
  }
  if (!LOOP_EVENTS.includes(options.event)) {
    fail(`--event 必须是 ${LOOP_EVENTS.join(" / ")} 之一。`, "进入循环登记 started，离开（含打回/失败/中断）登记 finished。");
  }
  const round = Number(options.round);
  if (!Number.isInteger(round) || round < 1) {
    fail(`--round 必须是正整数（attemptKey = <runId>:<round> 的本地轮次）。`, "以 1 起计的本地轮次重试。");
  }
  if (options.event === "finished" && !LOOP_OUTCOMES.includes(options.outcome ?? "")) {
    fail(`finished 必须带 --outcome（${LOOP_OUTCOMES.join(" / ")} 之一）。`, "按本次尝试的实际结果补 --outcome 后重试。");
  }
  if (options.event === "started" && options.outcome !== undefined) {
    fail("started 不携带结果（outcome 只在 finished 出现）。", "去掉 --outcome 后重试；结果在 finished 时登记。");
  }
  if (options["input-hash"] !== undefined && options["input-hash"].trim() === "") {
    fail("--input-hash 为空字符串。", "提供本次尝试的输入哈希，或省略该参数。");
  }
  const core = loadTaskCore(options["task-dir"]);
  const attemptKey = `${options["run-id"]}:${round}`;
  const duplicate = readLoopAttemptRows(core.taskDir).some(
    (row) => row.attemptKey === attemptKey && row.event === options.event,
  );
  if (duplicate) {
    printJson({ recorded: false, duplicate: true, attemptKey, event: options.event, loop: options.loop });
    return;
  }
  const row = {
    taskId: core.task.taskId,
    loop: options.loop,
    path: options.path,
    runId: options["run-id"],
    attemptKey,
    event: options.event,
    ...(options["input-hash"] !== undefined ? { inputHash: options["input-hash"] } : {}),
    at: new Date().toISOString(),
    ...(options.event === "finished" ? { outcome: options.outcome } : {}),
  };
  const filePath = loopAttemptsPath(core.taskDir);
  const prefix = existsSync(filePath) && readFileSync(filePath, "utf8").length > 0 && !readFileSync(filePath, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(filePath, `${prefix}${JSON.stringify(row)}\n`, "utf8");
  printJson({ recorded: true, attemptKey, event: options.event, loop: options.loop });
}

function commandLoopBudget(args) {
  const options = parseOptions(args, { required: ["task-dir", "loop"], optional: [] });
  const core = loadTaskCore(options["task-dir"]);
  // 上限键由 kernel-judgments.LOOP_BUDGET_CAP_KEYS 单源登记；未登记的循环 cap=null、
  // exceeded=false——「未接入的循环属已知缺口」（§8.2），如实返回而不是猜上限
  const capKey = LOOP_BUDGET_CAP_KEYS[options.loop];
  const cap = capKey !== undefined ? KERNEL_RULES.budgets[capKey] : null;
  const budget = loopAttemptsBudget(readLoopAttemptRows(core.taskDir), { loop: options.loop, cap });
  printJson({
    taskDir: core.taskDir,
    loop: options.loop,
    started: budget.started,
    byOutcome: budget.byOutcome,
    cap: budget.cap,
    exceeded: budget.exceeded,
    ...(capKey === undefined ? { note: `循环 ${options.loop} 未接入尝试预算（已知缺口）：cap=null 表示尚无机器上界，不表示无限制` } : {}),
  });
}

// ── revision 来源对账（机制三 §7.2：只读派生，无写入）──
function commandRevisionProvenance(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  const world = loadWorldAuto(options["task-dir"]);
  const revision = options.revision ?? computeRevision(world.task.projectRoot);
  const provenance = deriveRevisionProvenance(recordsOf(world), { currentRevision: revision });
  printJson({
    taskDir: world.taskDir,
    revision,
    revisions: provenance.revisions,
    unknownCount: provenance.unknownCount,
    explainedRevision: provenance.explainedRevision,
    enabled: provenance.enabled,
  });
}

// ── 交付义务派生（机制三 §7.1：聚合派生视图，accepted 前置的数据源）──
function commandObligations(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  const world = loadWorldAuto(options["task-dir"]);
  const revision = options.revision ?? computeRevision(world.task.projectRoot);
  // 判定路径：pending 文件损坏即报错退出（fail-closed），不得按空清单派生义务
  const pendingItems = readPending(world.taskDir, { onUnparseable: "fail" }).items.filter((item) => item.status === "open");
  if (world.acceptance === null) {
    // 无验收包：断言/阶段义务无判定源（不猜），只报 pending 义务——查询类命令不因包缺失崩溃
    const pendingObligations = pendingItems.map((item) => ({
      id: `pending-${item.id}`,
      kind: "pending",
      sourceRef: `pending-actions.json#${item.id}`,
      required: true,
      state: "open",
      evidenceRefs: [],
    }));
    printJson({
      taskDir: world.taskDir,
      revision,
      acceptanceVersion: null,
      obligations: pendingObligations,
      openRequired: pendingObligations,
      reason: "无验收包（acceptance.json 缺失）：断言与阶段义务暂无判定源，仅 pending 待办参与义务清单",
    });
    return;
  }
  let verdict;
  try {
    verdict = buildVerdict(world, revision);
  } catch (error) {
    // verdict 组装失败（早期任务缺批准等）：义务视图判定源不可用，如实报缺而非按 0 补齐
    printJson({
      taskDir: world.taskDir,
      revision,
      acceptanceVersion: world.acceptance.acceptanceVersion,
      obligations: pendingItems.map((item) => ({ id: `pending-${item.id}`, kind: "pending", sourceRef: `pending-actions.json#${item.id}`, required: true, state: "open", evidenceRefs: [] })),
      openRequired: pendingItems.map((item) => ({ id: `pending-${item.id}`, kind: "pending", sourceRef: `pending-actions.json#${item.id}`, required: true, state: "open", evidenceRefs: [] })),
      reason: `verdict 判定暂不可用（${error.message}）：断言与阶段义务暂无判定源，仅 pending 待办参与义务清单`,
    });
    return;
  }
  const result = deriveObligations({
    verdict,
    acceptance: world.acceptance,
    records: recordsOf(world),
    pendingItems,
    verificationOnly: world.task.verificationOnly === true,
    designStageRequired: world.policy["verdict-rules.json"].requireDesignApproved !== false,
    // 外部契约 runtime 义务（§6.1）：判定单源 kernel-judgments.deriveRuntimeObligations，
    // 组装（权威重解析 + probe artifact 读取）经 gate 导出侧同一实现，不在此复刻
    runtimeObligations: runtimeObligationsOf(world, revision).obligations,
  });
  printJson({
    taskDir: world.taskDir,
    revision,
    acceptanceVersion: world.acceptance.acceptanceVersion,
    obligations: result.obligations,
    openRequired: result.openRequired,
  });
}

// ── main 分发（包成 async 函数：CLI 直接执行与进程内测试垫片共用同一实现）──

// usageFail 的 process.exit(2) 在进程内垫片中经临时替换的 process.exit 抛出此信号；
// 定义在 runCoreCommand 之前使 catch 分支可引用
class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

async function runCoreCommand(args) {
  const command = args[0];
  const commandArgs = args.slice(1);
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
        const action = args[1];
        if (!["add", "resolve", "list"].includes(action ?? "")) {
          usageFail(`用法：delivery-core pending <add|resolve|list> --task-dir D [--kind K --note N] / [--id PA-N [--outcome S]]。`);
        }
        commandPending([action, ...args.slice(2)]);
        break;
      }
      case "budget": {
        const options = parseOptions(commandArgs, { required: ["task-dir"], optional: [] });
        const world = loadWorldAuto(options["task-dir"]);
        const records = recordsOf(world);
        // 账本行传入 = 跨 run 保证预算走 started 尝试口径（V5 §8.1），三个查询口同源
        printJson({ taskDir: world.taskDir, repair: repairBudgetFromEvents(records, { attemptRows: readLoopAttemptRows(world.taskDir) }), findingRegrades: findingRegrades(records) });
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
      case "full-qualification":
        commandFullQualification(commandArgs);
        break;
      case "node-transition":
        commandNodeTransition(commandArgs);
        break;
      case "node-project":
        commandNodeProject(commandArgs);
        break;
      case "events":
        commandEventsTimeline(commandArgs);
        break;
      case "replay":
        commandReplay(commandArgs);
        break;
      case "loop-attempt":
        commandLoopAttempt(commandArgs);
        break;
      case "loop-budget":
        commandLoopBudget(commandArgs);
        break;
      case "revision-provenance":
        commandRevisionProvenance(commandArgs);
        break;
      case "obligations":
        commandObligations(commandArgs);
        break;
      default:
        usageFail(
          `未知命令 ${JSON.stringify(command ?? "")}。合法命令：validate / rules / next / pending / budget / open-findings / usable-explorations / exploration-due / repair-budget / full-qualification / node-transition / node-project / events / replay / loop-attempt / loop-budget / revision-provenance / obligations。`,
        );
    }
  } catch (error) {
    if (error instanceof ExitSignal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`delivery-core: ${message}\n`);
    if (!/恢复动作/.test(message)) {
      process.stderr.write("恢复动作：检查参数与任务目录状态后重试；若仍失败，保留此错误并排查 delivery-core.mjs。\n");
    }
    process.exitCode = 1;
  }
}

// 直接执行才跑 main；被 import（测试进程内垫片）时不跑——realpath 比对同 delivery-gate 的直接执行检查
const invokedPath = process.argv[1] !== undefined ? realpathSync(resolve(process.argv[1])) : null;
if (invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  await runCoreCommand(process.argv.slice(2));
}

// ── 进程内调用垫片（测试提速）：走与 CLI 完全相同的 runCoreCommand 分发，返回与
// spawnSync 同口径的结构化结果 { status, stdout, stderr }。usageFail 的 process.exit(2)
// 硬退出经临时替换 process.exit 捕获为退出码（子进程语义 = 进程退出，垫片内 = 返回值）。
// node --test 用例串行执行，临时替换全局口径安全；函数保证恢复现场 ──
async function runCoreCommandInProcess(argv, env) {
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  const previousExit = process.exit;
  const chunks = { stdout: [], stderr: [] };
  const previousEnv = {};
  const overriddenKeys = env === undefined || env === null ? [] : Object.keys(env);
  for (const key of overriddenKeys) {
    previousEnv[key] = process.env[key];
    process.env[key] = env[key];
  }
  process.argv = [previousArgv[0], previousArgv[1], ...argv];
  process.exitCode = 0;
  process.stdout.write = (chunk) => { chunks.stdout.push(chunk); return true; };
  process.stderr.write = (chunk) => { chunks.stderr.push(chunk); return true; };
  process.exit = (code) => {
    throw new ExitSignal(code);
  };
  let exitSignal = null;
  try {
    await runCoreCommand(argv);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitSignal = error;
  } finally {
    process.argv = previousArgv;
    for (const key of overriddenKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
    process.exit = previousExit;
  }
  const result = {
    status: exitSignal !== null ? exitSignal.exitCode : process.exitCode ?? 0,
    stdout: chunks.stdout.join(""),
    stderr: chunks.stderr.join(""),
  };
  process.exitCode = previousExitCode;
  return result;
}

export { runCoreCommandInProcess };
