// facts.mjs — 命令/事实 schema 与纯领域核（sync-conformance-plane U1/M1，后续单元的共享契约根）
//
// 本文件是事件词表的唯一权威登记处（设计 U1 检查点：新增事件名必须同步登记本 schema，防词表分裂）。
// 编号域：GL/PR/AX/D/GA/V/RL/U/G/M/SC/UD/AS/SI/RH 裸用 = 本设计包 sync-conformance-plane；
// 引用其他设计包编号须带域前缀（如 thesis-contract·V3）。
//
// 词表来源（设计文档 sync-conformance-plane.rendered.md）：
//   设计具名 7 事件：
//     RulingRequested / RulingRecorded  —— 方向裁决流（targetForm 段一、段六 doc-proposals；V8/V14）
//     BacklogAdopted                    —— backlog 采纳转新地址初始证据（段七；V6）
//     CheckerFailed                     —— checker 自身失败四要素事实（段五；V13）
//     IntegrationGateChecked            —— 集成挂钩审计（挂钩拒绝失败形态 / 两阶段提交绕过前提记录形态）（段六；V5）
//     IntegrationPrecheckFailed         —— apply 预检失败审计（段六；V5）
//     Unarchived                        —— 归档包复活解档事件（段七复活通道；V9）
//   领域核登记扩展（AX4 授权路径「新增事件名同步登记」）：
//     EvidenceRecorded                  —— checker wrapper 证据落流载体（AX4 五要素；段三证据层）
//                                        —— 无它则 fold 无法从事件流重建 verified（AX3），故属 M1 最小词表
//
// 纯领域核约束：本文件不得依赖文件系统、锁实现或任何 IO（AX3 + U1 检查点「领域核语义不依赖锁实现」）。

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/** 设计具名事件（验收条款 4：逐一在 EVENT_PAYLOAD_SCHEMAS 可校验） */
export const NAMED_EVENT_TYPES = Object.freeze([
  "RulingRequested",
  "RulingRecorded",
  "BacklogAdopted",
  "CheckerFailed",
  "IntegrationGateChecked",
  "IntegrationPrecheckFailed",
  "Unarchived",
]);

/** 全文事件词表 = 设计具名 7 事件 + 领域核登记的 EvidenceRecorded */
export const EVENT_TYPES = Object.freeze([...NAMED_EVENT_TYPES, "EvidenceRecorded"]);

/** violationKind 初始词表（设计 targetForm 段一；扩词表必须升 schema 版本） */
export const VIOLATION_KINDS = Object.freeze([
  "missing-implementation",
  "behavior-mismatch",
  "contract-mismatch",
  "documentation-mismatch",
  "test-evidence-missing",
  "overimplementation",
]);

/** RulingRecorded.direction 词表（code-right/doc-right 来自 D4 方向语义；waived 来自 AX8 义务终态） */
export const RULING_DIRECTIONS = Object.freeze(["code-right", "doc-right", "waived"]);

/** EvidenceRecorded.result 词表（checker 退出契约 0=pass、10=fail 的语义投影；20=失败走 CheckerFailed） */
export const CHECKER_RESULTS = Object.freeze(["pass", "fail"]);

// ---------------------------------------------------------------------------
// 事件 payload schema（声明式；键集必须与 EVENT_TYPES 逐名一致——测试断言）
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

export const EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  RulingRequested: {
    required: ["address", "question"],
    kinds: { address: "address", question: "string" },
  },
  RulingRecorded: {
    required: ["address", "direction", "respondsTo"],
    kinds: { address: "address", direction: "rulingDirection", respondsTo: "positiveInt" },
  },
  BacklogAdopted: {
    required: ["backlogId", "newBinding"],
    kinds: { backlogId: "string", newBinding: "bindingRef" },
  },
  CheckerFailed: {
    // 四要素（设计段五）：命令、退出码、摘要与恢复动作
    required: ["address", "command", "exitCode", "summary", "recovery"],
    kinds: { address: "address", command: "string", exitCode: "int", summary: "string", recovery: "string" },
  },
  IntegrationGateChecked: {
    required: ["repoId", "command", "exitCode", "summary", "recovery", "failure"],
    optional: ["hookPath"],
    kinds: { repoId: "string", command: "string", exitCode: "int", summary: "string", recovery: "string", failure: "bool", hookPath: "string" },
  },
  IntegrationPrecheckFailed: {
    required: ["repoId", "command", "exitCode", "summary", "recovery"],
    kinds: { repoId: "string", command: "string", exitCode: "int", summary: "string", recovery: "string" },
  },
  Unarchived: {
    required: ["reason"],
    kinds: { reason: "string" },
  },
  EvidenceRecorded: {
    required: ["address", "obligationHash", "checkerId", "checkerVersion", "bindingVersion", "inputs", "result"],
    optional: ["changesetId"],
    kinds: {
      address: "address",
      obligationHash: "hex64",
      checkerId: "string",
      checkerVersion: "string",
      bindingVersion: "positiveInt",
      inputs: "inputs",
      result: "checkerResult",
      changesetId: "string",
    },
  },
});

// ---------------------------------------------------------------------------
// 校验纯函数
// ---------------------------------------------------------------------------

const KIND_CHECKERS = {
  string: (v) => typeof v === "string" && v.length > 0,
  bool: (v) => typeof v === "boolean",
  int: (v) => typeof v === "number" && Number.isInteger(v),
  positiveInt: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1,
  hex64: (v) => typeof v === "string" && HEX64.test(v),
  rulingDirection: (v) => RULING_DIRECTIONS.includes(v),
  checkerResult: (v) => CHECKER_RESULTS.includes(v),
  address: (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) &&
    typeof v.bindingId === "string" && v.bindingId.length > 0 &&
    typeof v.repoId === "string" && v.repoId.length > 0 &&
    VIOLATION_KINDS.includes(v.violationKind),
  bindingRef: (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) &&
    typeof v.bindingId === "string" && v.bindingId.length > 0 &&
    typeof v.repoId === "string" && v.repoId.length > 0 &&
    VIOLATION_KINDS.includes(v.violationKind) &&
    typeof v.bindingVersion === "number" && Number.isInteger(v.bindingVersion) && v.bindingVersion >= 1,
  inputs: (v) =>
    Array.isArray(v) && v.length > 0 &&
    v.every((i) => i !== null && typeof i === "object" &&
      typeof i.name === "string" && i.name.length > 0 &&
      typeof i.hash === "string" && HEX64.test(i.hash)),
};

/** 事实 schema 校验纯函数。返回 { ok, errors[] }，不抛错（fold/仓库层决定 fail-fast 形态）。 */
export function validateFact(f) {
  const errors = [];
  if (f === null || typeof f !== "object" || Array.isArray(f)) return { ok: false, errors: ["事实必须是对象"] };
  if (!EVENT_TYPES.includes(f.type)) errors.push(`type 不在事件词表：${JSON.stringify(f.type)}`);
  if (!KIND_CHECKERS.positiveInt(f.seq)) errors.push("seq 必须是正整数");
  if (typeof f.ts !== "string" || Number.isNaN(Date.parse(f.ts))) errors.push("ts 必须是可解析时间戳");
  if (!KIND_CHECKERS.string(f.actor)) errors.push("actor 必须是非空字符串");
  const schema = EVENT_PAYLOAD_SCHEMAS[f.type];
  if (schema) {
    for (const field of schema.required) {
      if (!(field in f)) errors.push(`${f.type} 缺必填字段 ${field}`);
    }
    for (const [field, kind] of Object.entries(schema.kinds)) {
      if (field in f && !KIND_CHECKERS[kind](f[field])) errors.push(`${f.type} 字段 ${field} 形态不符（${kind}）`);
    }
    for (const field of Object.keys(f)) {
      if (["type", "seq", "ts", "actor"].includes(field)) continue;
      if (!schema.required.includes(field) && !(schema.optional ?? []).includes(field)) {
        errors.push(`${f.type} 出现 schema 外字段 ${field}（词表纪律：扩字段须同步登记 schema）`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 命令层（命令 = 引擎/agent 可发出动作；事实 = 已发生。一一对应，追加时由仓库分配 seq/ts）
// ---------------------------------------------------------------------------

export const COMMAND_TYPES = Object.freeze([
  "RequestRuling",
  "RecordRuling",
  "AdoptBacklogEntry",
  "RecordCheckerFailure",
  "RecordIntegrationGate",
  "RecordIntegrationPrecheckFailure",
  "UnarchivePackage",
  "RecordEvidence",
]);

export const COMMAND_TO_EVENT = Object.freeze({
  RequestRuling: "RulingRequested",
  RecordRuling: "RulingRecorded",
  AdoptBacklogEntry: "BacklogAdopted",
  RecordCheckerFailure: "CheckerFailed",
  RecordIntegrationGate: "IntegrationGateChecked",
  RecordIntegrationPrecheckFailure: "IntegrationPrecheckFailed",
  UnarchivePackage: "Unarchived",
  RecordEvidence: "EvidenceRecorded",
});

export function validateCommand(cmd) {
  const errors = [];
  if (cmd === null || typeof cmd !== "object" || Array.isArray(cmd)) return { ok: false, errors: ["命令必须是对象"] };
  if (!COMMAND_TYPES.includes(cmd.type)) errors.push(`type 不在命令词表：${JSON.stringify(cmd.type)}`);
  if (!KIND_CHECKERS.string(cmd.actor)) errors.push("actor 必须是非空字符串");
  if (cmd.type && COMMAND_TYPES.includes(cmd.type)) {
    const payload = cmd.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push(`${cmd.type} 缺 payload 对象`);
    } else {
      const probe = { type: COMMAND_TO_EVENT[cmd.type], seq: 1, ts: "1970-01-01T00:00:00.000Z", actor: cmd.actor, ...payload };
      const r = validateFact(probe);
      errors.push(...r.errors.map((e) => e.replace(/^RulingRequested|^RulingRecorded|^BacklogAdopted|^CheckerFailed|^IntegrationGateChecked|^IntegrationPrecheckFailed|^Unarchived|^EvidenceRecorded/, cmd.type)));
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 命令 → 事实（seq/ts 由状态仓追加时分配——append-only 权威的写入口径） */
export function commandToFact(cmd, { seq, ts }) {
  const check = validateCommand(cmd);
  if (!check.ok) {
    const err = new Error(`命令未通过 schema 校验，拒绝追加：${check.errors.join("；")}`);
    err.code = "invalid-command";
    err.errors = check.errors;
    throw err;
  }
  return { type: COMMAND_TO_EVENT[cmd.type], seq, ts, actor: cmd.actor, ...cmd.payload };
}

// ---------------------------------------------------------------------------
// 身份与规范化原语（AX1/AX2 + 设计段三）
// ---------------------------------------------------------------------------

/** 差距地址由义务绑定派生（AX2）：(bindingId, repoId, violationKind) */
export function deriveAddress(binding) {
  return { bindingId: binding.bindingId, repoId: binding.repoId, violationKind: binding.violationKind };
}

/** 规范化 JSON：键排序递归序列化（义务摘要与地址键的稳定性依赖它；同内容不同键序必须同串） */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** 义务摘要 = 规范化绑定 JSON 的内容哈希（设计段三） */
export function obligationSummaryHash(binding) {
  return createHash("sha256").update(canonicalJson(binding)).digest("hex");
}

// ---------------------------------------------------------------------------
// 事件量红灯探针常量（来源：设计 D2 决策行——单仓事件 JSONL 超 50 MB 或事件条数超 10 万为红灯，
// 约实测 golden corpus 基线两个数量级裕度；超限触发压缩策略重审，非运行时错误）
// ---------------------------------------------------------------------------

export const RED_LINE_THRESHOLDS = Object.freeze({
  maxEventJsonlBytes: 50 * 1024 * 1024,
  maxEventCount: 100000,
});

export function checkRedLineThresholds({ bytes, count }) {
  const violations = [];
  if (bytes > RED_LINE_THRESHOLDS.maxEventJsonlBytes) {
    violations.push({ kind: "bytes", actual: bytes, threshold: RED_LINE_THRESHOLDS.maxEventJsonlBytes });
  }
  if (count > RED_LINE_THRESHOLDS.maxEventCount) {
    violations.push({ kind: "count", actual: count, threshold: RED_LINE_THRESHOLDS.maxEventCount });
  }
  return { exceeded: violations.length > 0, violations };
}
