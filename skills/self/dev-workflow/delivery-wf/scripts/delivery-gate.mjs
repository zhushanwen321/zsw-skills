#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GATE_COMMAND = "node ~/.agents/skills/delivery-wf/scripts/delivery-gate.mjs";
// 事件写入角色与签名密钥一一对应；designer 的产物是契约草稿文件，engine 的测试摘要由 builder 角色记录，均不写事件
const ACTORS = ["builder", "assurance", "user"];
const CONFIRMATIONS = ["user-explicit", "standing-authorization"];
const EVIDENCE_KINDS = ["command", "scenario", "inspection"];
const COMMON_EVENT_FIELDS = ["type", "actor", "contractVersion", "revision", "summary"];
const EVENT_SCHEMAS = {
  ContractApproved: {
    actors: ["user"],
    fields: ["contractSha256", "confirmation"],
  },
  ImplementationRecorded: {
    actors: ["builder"],
    fields: ["incrementId", "artifact"],
  },
  EvidenceRecorded: {
    actors: ["assurance"],
    fields: ["requirementId", "kind", "result", "artifact"],
  },
  AssuranceCompleted: {
    actors: ["assurance"],
    fields: ["artifact"],
  },
  ExplorationCompleted: {
    actors: ["assurance"],
    fields: ["dimensions", "artifact"],
  },
  FindingRaised: {
    actors: ["assurance", "builder"],
    fields: ["findingId", "requirementIds", "severity", "artifact"],
  },
  FindingResolved: {
    actors: ["assurance"],
    fields: ["findingId", "artifact"],
  },
  RiskAccepted: {
    actors: ["user"],
    fields: ["targetType", "targetId", "confirmation"],
  },
};
const EVENT_TYPES = Object.keys(EVENT_SCHEMAS);
const EVENTS_LOCK_DIRNAME = ".events.lock";
const EVENTS_LOCK_MAX_AGE_MS = 30_000;
const EVENTS_LOCK_WAIT_MS = 30_000;
const UNTRACKED_SYMLINK_BUDGET_BYTES = 8 * 1024 * 1024;
const UNTRACKED_DIRECTORY_MAX_DEPTH = 16;
const SIGNING_KEY_NAMES = { builder: "builderKey", assurance: "assuranceKey", user: "userKey" };
const SIGNING_KEY_ROLES = ["builder", "assurance", "user"];
const HELP = `delivery-gate：delivery-wf 的确定性交付裁决器

密钥：
  init 只在 stdout 输出一次 builderKey、assuranceKey 与 userKey（PEM 私钥）；task.json 仅登记三个公钥，私钥不落盘。
  事件 actor 必须用对应角色密钥签名：actor=builder 用 builderKey、actor=assurance 用 assuranceKey、
  actor=user 用 userKey。append 通过 --key 提供私钥，approve-contract/accept-risk 通过 --user-key 提供 userKey；
  任何跨角色密钥一律拒绝。

用法：
  delivery-gate init --project-root P --task-id T [--new-round] [--resume-existing]
  delivery-gate validate-contract --task-dir D
  delivery-gate approve-contract --task-dir D --confirmation user-explicit|standing-authorization --summary S --user-key <userKey PEM> [--revision R]
  delivery-gate append --task-dir D --event '<JSON>' --key <builderKey|assuranceKey|userKey PEM>
  delivery-gate accept-risk --task-dir D --target-type requirement|finding --target-id ID --confirmation user-explicit --summary S --user-key <userKey PEM> [--revision R]
  delivery-gate evaluate --task-dir D [--revision R]
  delivery-gate revision --project-root P

退出码：成功 0；业务校验失败 1；命令行用法错误 2。
完整入口：${GATE_COMMAND} <command> ...

init 重复语义：任务目录按 projectRoot 分组（~/.agents/skill-data/delivery/<分组 slug>/<taskId>/）。
  同 taskId 已存在时默认拒绝——继续既有任务用 --resume-existing；同项目新一轮交付用 --new-round
  （任务目录按 <taskId>-r2/-r3 递增分开，不共用）。init 输出 projectRoot/worktree/siblingTasks，
  主会话据此确认 --project-root 是本会话自己的 worktree；评测等多会话同题环境必须每会话独立 worktree。
`;

class GateError extends Error {
  constructor(message, recovery, exitCode = 1) {
    super(`${message} 恢复动作：${recovery}`);
    this.name = "GateError";
    this.exitCode = exitCode;
  }
}

function fail(message, recovery) {
  throw new GateError(message, recovery, 1);
}

function usageFail(message) {
  throw new GateError(message, `运行 ${GATE_COMMAND} --help 查看合法命令与参数后重试。`, 2);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    fail(`${label} 必须是 JSON 对象。`, `把 ${label} 改为 JSON 对象后重试当前命令。`);
  }
}

function requireExactKeys(value, allowed, label) {
  const keys = Object.keys(value);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`缺少字段 ${missing.join(", ")}`);
    if (unknown.length > 0) parts.push(`含未知字段 ${unknown.join(", ")}`);
    fail(`${label} 形态非法：${parts.join("；")}。`, `按契约补齐必需字段并删除未知字段后重试；${label} 允许的字段为 ${allowed.join(", ")}。`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} 必须是非空字符串。`, `为 ${label} 提供非空字符串后重试当前命令。`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string") {
    fail(`${label} 必须是字符串。`, `为 ${label} 提供字符串后重试当前命令。`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} 必须是布尔值。`, `把 ${label} 改为 true 或 false 后重试当前命令。`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} 必须是正整数。`, `把 ${label} 改为从 1 开始的整数后重试当前命令。`);
  }
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(`${label} 的值 ${JSON.stringify(value)} 不在合法范围内。`, `把 ${label} 改为 ${allowed.join(" | ")} 之一后重试当前命令。`);
  }
}

function requireStringArray(value, label, { nonEmptyItems = false, unique = false } = {}) {
  if (!Array.isArray(value)) {
    fail(`${label} 必须是字符串数组。`, `把 ${label} 改为 JSON 字符串数组后重试当前命令。`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemLabel = `${label}[${index}]`;
    if (nonEmptyItems) requireNonEmptyString(item, itemLabel);
    else requireString(item, itemLabel);
    if (unique && seen.has(item)) {
      fail(`${label} 含重复元素 ${JSON.stringify(item)}。`, `删除 ${label} 中的重复元素后重试当前命令。`);
    }
    seen.add(item);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} 必须是 64 位小写 sha256 十六进制字符串。`, `重新计算当前文件的 sha256 并修正 ${label} 后重试；也可使用高层命令自动计算。`);
  }
}

function requireSignatureShape(value, label) {
  if (typeof value !== "string" || Buffer.from(value, "base64").length !== 64) {
    fail(`${label} 必须是 64 字节 Ed25519 签名的 base64 字符串。`, `保留追加时生成的原始签名；确需更正事件时，用对应私钥重新 append 该事件并审计手工修改。`);
  }
}

function validateTaskId(taskId) {
  if (
    typeof taskId !== "string" ||
    taskId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) ||
    taskId.includes("..")
  ) {
    fail(
      `taskId ${JSON.stringify(taskId)} 非法。`,
      "使用字母或数字开头、仅含字母数字/点/下划线/连字符且不含连续两个点的 id，长度不超过 128，然后重试 init。",
    );
  }
}

function requireExistingDirectory(pathValue, label) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) {
    fail(`${label} 必须是绝对路径。`, `把 ${label} 改为已存在目录的绝对路径后重试当前命令。`);
  }
  let stat;
  try {
    stat = statSync(pathValue);
  } catch {
    fail(`${label} 指向的目录不存在：${pathValue}。`, `创建该目录或修正 ${label} 后重试当前命令。`);
  }
  if (!stat.isDirectory()) {
    fail(`${label} 不是目录：${pathValue}。`, `把 ${label} 改为目录路径后重试当前命令。`);
  }
}

function readText(filePath, label, recovery) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`无法读取 ${label}：${filePath}（${error.message}）。`, recovery);
  }
}

function readJson(filePath, label) {
  const text = readText(filePath, label, `确认 ${filePath} 存在且可读；若文件缺失，重新生成 ${label} 后重试。`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} 不是合法 JSON：${error.message}。`, `修复 ${filePath} 的 JSON 语法后重试当前命令。`);
  }
}

function atomicWrite(filePath, text) {
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, filePath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 保留原始写入错误，恢复动作指向目标文件与目录权限。
    }
    fail(`无法原子写入 ${filePath}：${error.message}。`, `检查目标目录写权限与剩余磁盘空间，解除占用后重试当前命令。`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function projectSlug(projectRoot) {
  const normalized = basename(projectRoot)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  return `${normalized}-${sha256Text(projectRoot).slice(0, 8)}`;
}

function publicJwkX(publicKeyPem) {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });
  return typeof jwk.x === "string" ? jwk.x : null;
}

function requirePublicKeyPem(value, label) {
  requireNonEmptyString(value, label);
  try {
    createPublicKey(value);
  } catch (error) {
    fail(`${label} 不是合法 PEM 公钥：${error.message}。`, `保持 init 生成的公钥原文；若 task.json 已损坏，用新的 --task-id 重新 init 并重放事件。`);
  }
}

function validateTaskRecord(task, taskDir) {
  requireRecord(task, "task.json");
  const requiredKeys = ["builderPublicKey", "assurancePublicKey", "userPublicKey"];
  const missingKeys = requiredKeys.filter((keyName) => !Object.hasOwn(task, keyName));
  if (missingKeys.length > 0) {
    fail(
      `任务目录缺少角色签名公钥（缺 ${missingKeys.join("、")}；旧版无密钥或两密钥任务），已拒绝继续使用。`,
      `旧任务无法补签：用新的 --task-id 重新运行 init 生成三把角色密钥，再重放所需事件；原 ${join(taskDir, "events.jsonl")} 仅作审计保留。`,
    );
  }
  requireExactKeys(task, ["schemaVersion", "taskId", "projectRoot", ...requiredKeys], "task.json");
  if (task.schemaVersion !== 1) {
    fail("task.json 的 schemaVersion 必须为 1。", `把 ${join(taskDir, "task.json")} 的 schemaVersion 修正为 1，或用当前版本重新 init 到新 taskId。`);
  }
  validateTaskId(task.taskId);
  requireExistingDirectory(task.projectRoot, "task.json.projectRoot");
  for (const keyName of requiredKeys) requirePublicKeyPem(task[keyName], `task.json.${keyName}`);
}

function loadTask(taskDirValue) {
  requireExistingDirectory(taskDirValue, "--task-dir");
  const taskDir = realpathSync(taskDirValue);
  const task = readJson(join(taskDir, "task.json"), "task.json");
  validateTaskRecord(task, taskDir);
  const keys = Object.fromEntries(
    SIGNING_KEY_ROLES.map((role) => {
      const pem = task[`${role}PublicKey`];
      return [role, { keyObject: createPublicKey(pem), x: publicJwkX(pem) }];
    }),
  );
  return { taskDir, task, keys };
}

function resolveSigningKey(world, privateKeyPem, eventActor) {
  let privateKey;
  let derivedX = null;
  try {
    privateKey = createPrivateKey(privateKeyPem);
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    if (typeof jwk.x === "string") derivedX = jwk.x;
  } catch (error) {
    fail(`提供的签名私钥无法解析：${error.message}。`, `使用 init 输出的 ${Object.values(SIGNING_KEY_NAMES).join("/")} 的 PEM 原文重试；不要手工改动密钥内容。`);
  }
  let role = null;
  if (derivedX !== null) {
    for (const candidate of SIGNING_KEY_ROLES) {
      if (derivedX === world.keys[candidate].x) {
        role = candidate;
        break;
      }
    }
  }
  if (role === null) {
    fail("提供的私钥不属于本任务：派生公钥与 task.json 登记的三把角色公钥均不匹配。", `改用本任务 init 输出的 ${Object.values(SIGNING_KEY_NAMES).join("/")} 中对应角色的私钥重试当前命令。`);
  }
  const expectedRole = eventActor;
  if (role !== expectedRole) {
    fail(
      `actor=${eventActor} 的事件必须用 ${SIGNING_KEY_NAMES[expectedRole]} 签名，提供的私钥对应 ${role} 角色（${SIGNING_KEY_NAMES[role]}）。`,
      expectedRole === "user"
        ? "user 事件（ContractApproved/RiskAccepted）只能由主会话用 userKey 通过 approve-contract/accept-risk 追加；userKey 不得注入子 agent。"
        : `${eventActor} 事件只能用 ${SIGNING_KEY_NAMES[expectedRole]} 通过 append --key 追加；角色密钥不得跨 workflow 注入。`,
    );
  }
  return privateKey;
}

function validateContract(contract, task) {
  requireRecord(contract, "contract.json");
  requireExactKeys(
    contract,
    [
      "schemaVersion",
      "contractVersion",
      "taskId",
      "projectRoot",
      "objective",
      "requirements",
      "nonGoals",
      "riskLevel",
      "exploratoryReview",
      "reviewDimensions",
    ],
    "contract.json",
  );
  if (contract.schemaVersion !== 1) {
    fail("contract.json 的 schemaVersion 必须为 1。", "把 contract.schemaVersion 修正为 1 后重试 validate-contract。");
  }
  requirePositiveInteger(contract.contractVersion, "contract.contractVersion");
  validateTaskId(contract.taskId);
  if (contract.taskId !== task.taskId) {
    fail("contract.taskId 与 task.json.taskId 不一致。", `把 contract.taskId 改为 ${JSON.stringify(task.taskId)} 后重试；若这是另一任务，请使用对应任务目录。`);
  }
  requireExistingDirectory(contract.projectRoot, "contract.projectRoot");
  if (contract.projectRoot !== task.projectRoot) {
    fail("contract.projectRoot 与 task.json.projectRoot 不一致。", `把 contract.projectRoot 改为 ${JSON.stringify(task.projectRoot)}，并保持 task.json 与 contract.json 指向同一项目后重试。`);
  }
  requireNonEmptyString(contract.objective, "contract.objective");
  if (!Array.isArray(contract.requirements) || contract.requirements.length === 0) {
    fail("contract.requirements 必须至少包含一项。", "为 contract.requirements 添加至少一条可证伪需求后重试 validate-contract。");
  }
  const requirementIds = new Set();
  for (let index = 0; index < contract.requirements.length; index += 1) {
    const requirement = contract.requirements[index];
    const label = `contract.requirements[${index}]`;
    requireRecord(requirement, label);
    requireExactKeys(
      requirement,
      ["id", "kind", "statement", "required", "riskAcceptable", "evidenceKinds"],
      label,
    );
    requireNonEmptyString(requirement.id, `${label}.id`);
    if (requirementIds.has(requirement.id)) {
      fail(`contract.requirements 含重复 id ${JSON.stringify(requirement.id)}。`, "为每条需求分配唯一 id，并同步修正 increments 与事件中的引用后重试。 ");
    }
    requirementIds.add(requirement.id);
    requireEnum(requirement.kind, ["goal", "invariant"], `${label}.kind`);
    requireNonEmptyString(requirement.statement, `${label}.statement`);
    requireBoolean(requirement.required, `${label}.required`);
    requireBoolean(requirement.riskAcceptable, `${label}.riskAcceptable`);
    if (!Array.isArray(requirement.evidenceKinds) || requirement.evidenceKinds.length === 0) {
      fail(`${label}.evidenceKinds 必须至少包含一种证据类型。`, `为 ${label}.evidenceKinds 添加 command、scenario 或 inspection 后重试。`);
    }
    requireStringArray(requirement.evidenceKinds, `${label}.evidenceKinds`, { unique: true });
    for (const kind of requirement.evidenceKinds) {
      requireEnum(kind, EVIDENCE_KINDS, `${label}.evidenceKinds 元素`);
    }
  }
  requireStringArray(contract.nonGoals, "contract.nonGoals");
  requireEnum(contract.riskLevel, ["low", "medium", "high"], "contract.riskLevel");
  requireEnum(contract.exploratoryReview, ["not-required", "required"], "contract.exploratoryReview");
  requireStringArray(contract.reviewDimensions, "contract.reviewDimensions", {
    nonEmptyItems: true,
    unique: true,
  });
  if (contract.riskLevel === "high" && contract.exploratoryReview !== "required") {
    fail("高风险契约必须要求探索性审查。", "把 contract.exploratoryReview 改为 required，并至少填写一项 reviewDimensions 后重试。 ");
  }
  if (contract.exploratoryReview === "required" && contract.reviewDimensions.length === 0) {
    fail("探索性审查为 required 时 reviewDimensions 不能为空。", "为 contract.reviewDimensions 添加至少一个非空且去重的审查维度后重试。 ");
  }
}

function validateIncrements(increments, contract) {
  requireRecord(increments, "increments.json");
  requireExactKeys(increments, ["schemaVersion", "contractVersion", "items"], "increments.json");
  if (increments.schemaVersion !== 1) {
    fail("increments.json 的 schemaVersion 必须为 1。", "把 increments.schemaVersion 修正为 1 后重试 validate-contract。 ");
  }
  requirePositiveInteger(increments.contractVersion, "increments.contractVersion");
  if (increments.contractVersion !== contract.contractVersion) {
    fail("increments.contractVersion 必须等于当前 contractVersion。", `把 increments.contractVersion 更新为 ${contract.contractVersion}，并核对增量与当前契约后重试。`);
  }
  if (!Array.isArray(increments.items) || increments.items.length === 0) {
    fail("increments.items 必须至少包含一项。", "为 increments.items 添加至少一个可运行增量后重试 validate-contract。 ");
  }
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
  const incrementIds = new Set();
  for (let index = 0; index < increments.items.length; index += 1) {
    const item = increments.items[index];
    const label = `increments.items[${index}]`;
    requireRecord(item, label);
    const allowed = ["id", "title", "requirementIds"];
    if (Object.hasOwn(item, "testCommand")) allowed.push("testCommand");
    requireExactKeys(item, allowed, label);
    requireNonEmptyString(item.id, `${label}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id)) {
      fail(`${label}.id 格式非法：${JSON.stringify(item.id)}。`, "把增量 id 改为字母或数字开头、仅含字母数字/下划线/连字符且长度不超过 64 的形式后重试。 ");
    }
    if (incrementIds.has(item.id)) {
      fail(`increments.items 含重复 id ${JSON.stringify(item.id)}。`, "为每个增量分配唯一 id，并修正 ImplementationRecorded.incrementId 后重试。 ");
    }
    incrementIds.add(item.id);
    requireNonEmptyString(item.title, `${label}.title`);
    requireStringArray(item.requirementIds, `${label}.requirementIds`, {
      nonEmptyItems: true,
      unique: true,
    });
    if (item.requirementIds.length === 0) {
      fail(`${label}.requirementIds 必须至少引用一项需求。`, `为 ${label}.requirementIds 填写 contract.requirements 中已声明的需求 id 后重试。 `);
    }
    for (const requirementId of item.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        fail(`${label}.requirementIds 引用了未知需求 ${JSON.stringify(requirementId)}。`, "把该引用改为 contract.requirements 中已声明的 id，或先补充契约条目后重试。 ");
      }
    }
    if (Object.hasOwn(item, "testCommand")) {
      requireRecord(item.testCommand, `${label}.testCommand`);
      const testCommandAllowed = ["program", "args"];
      if (Object.hasOwn(item.testCommand, "timeoutMs")) testCommandAllowed.push("timeoutMs");
      requireExactKeys(item.testCommand, testCommandAllowed, `${label}.testCommand`);
      requireNonEmptyString(item.testCommand.program, `${label}.testCommand.program`);
      requireStringArray(item.testCommand.args, `${label}.testCommand.args`);
      if (Object.hasOwn(item.testCommand, "timeoutMs")) {
        const timeoutMs = item.testCommand.timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
          fail(`${label}.testCommand.timeoutMs 必须是 1000..3600000 的整数。`, `把 ${label}.testCommand.timeoutMs 改为该区间的整数（缺省 300000）后重试。 `);
        }
      }
    }
  }
}

function eventFields(type) {
  return [...COMMON_EVENT_FIELDS, ...EVENT_SCHEMAS[type].fields];
}

function eventContent(record) {
  const content = {};
  for (const field of eventFields(record.type)) content[field] = record[field];
  return content;
}

function computeEventId(event) {
  return sha256Text(canonicalJson(event));
}

function probeArtifact(taskDir, artifact) {
  if (typeof artifact !== "string" || artifact.trim().length === 0) {
    return { ok: false, reason: "shape" };
  }
  const evidenceDir = join(taskDir, "evidence");
  let candidate;
  let evidenceReal;
  try {
    candidate = isAbsolute(artifact) ? resolve(artifact) : resolve(taskDir, artifact);
    evidenceReal = realpathSync(evidenceDir);
  } catch {
    return { ok: false, reason: "evidence-dir" };
  }
  const lexicalRelative = relative(evidenceReal, candidate);
  if (
    lexicalRelative.length === 0 ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    return { ok: false, reason: "outside" };
  }
  let stat;
  let artifactReal;
  try {
    stat = statSync(candidate);
    artifactReal = realpathSync(candidate);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "not-file" };
  }
  const realRelative = relative(evidenceReal, artifactReal);
  if (
    realRelative.length === 0 ||
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    return { ok: false, reason: "escape" };
  }
  return { ok: true };
}

function validateArtifact(taskDir, artifact) {
  requireNonEmptyString(artifact, "event.artifact");
  const evidenceDir = join(taskDir, "evidence");
  const probed = probeArtifact(taskDir, artifact);
  if (probed.ok) return;
  if (probed.reason === "evidence-dir") {
    fail(`无法定位证据目录 ${evidenceDir}。`, "重新运行 init 创建 evidence/，或修复任务目录后重试当前命令。 ");
  }
  if (probed.reason === "outside") {
    fail(`artifact 必须位于任务目录 evidence/ 内：${artifact}。`, `把证据文件放入 ${evidenceDir}，并将 artifact 写为 evidence/<文件名> 后重试。`);
  }
  const candidate = isAbsolute(artifact) ? resolve(artifact) : resolve(taskDir, artifact);
  if (probed.reason === "missing") {
    fail(`artifact 指向的文件不存在或不可读：${artifact}。`, `先创建 ${candidate} 并写入原始证据，再用相同 artifact 重试当前命令。`);
  }
  if (probed.reason === "not-file") {
    fail(`artifact 必须是文件：${artifact}。`, "把 artifact 改为 evidence/ 内的普通文件，而不是目录或其他文件类型后重试。 ");
  }
  if (probed.reason === "escape") {
    fail(`artifact 的实际路径逃逸出 evidence/：${artifact}。`, "删除指向外部的符号链接，把真实证据文件复制到 evidence/ 内后重试。 ");
  }
  fail(`artifact 无法使用：${artifact}。`, "把真实证据文件放入 evidence/ 后重试当前命令。");
}

function validateEventShape(event, { record = false } = {}) {
  requireRecord(event, record ? "events.jsonl 事件记录" : "append 事件");
  requireEnum(event.type, EVENT_TYPES, "event.type");
  const schema = EVENT_SCHEMAS[event.type];
  const allowed = eventFields(event.type);
  if (record) allowed.push("seq", "recordedAt", "eventId", "signature");
  requireExactKeys(event, allowed, record ? `事件记录 ${event.type}` : `事件 ${event.type}`);
  requireEnum(event.actor, ACTORS, "event.actor");
  if (!schema.actors.includes(event.actor)) {
    fail(`${event.type} 不允许 actor=${event.actor}。`, `把 actor 改为 ${schema.actors.join(" | ")} 后重试 append；不要伪造其他角色事件。`);
  }
  requirePositiveInteger(event.contractVersion, "event.contractVersion");
  if (event.type === "ContractApproved") requireString(event.revision, "event.revision");
  else requireNonEmptyString(event.revision, "event.revision");
  requireNonEmptyString(event.summary, "event.summary");

  if (Object.hasOwn(event, "artifact")) validateNonEmptyArtifactShape(event.artifact);
  switch (event.type) {
    case "ContractApproved":
      requireSha256(event.contractSha256, "event.contractSha256");
      requireEnum(event.confirmation, CONFIRMATIONS, "event.confirmation");
      break;
    case "ImplementationRecorded":
      requireNonEmptyString(event.incrementId, "event.incrementId");
      break;
    case "EvidenceRecorded":
      requireNonEmptyString(event.requirementId, "event.requirementId");
      requireEnum(event.kind, EVIDENCE_KINDS, "event.kind");
      requireEnum(event.result, ["verified", "partial", "failed"], "event.result");
      break;
    case "AssuranceCompleted":
      break;
    case "ExplorationCompleted":
      requireStringArray(event.dimensions, "event.dimensions", {
        nonEmptyItems: true,
        unique: true,
      });
      break;
    case "FindingRaised":
      requireFindingId(event.findingId, "event.findingId");
      requireStringArray(event.requirementIds, "event.requirementIds", {
        nonEmptyItems: true,
        unique: true,
      });
      requireEnum(event.severity, ["blocker", "non-blocker"], "event.severity");
      break;
    case "FindingResolved":
      requireFindingId(event.findingId, "event.findingId");
      break;
    case "RiskAccepted":
      requireEnum(event.targetType, ["requirement", "finding"], "event.targetType");
      requireNonEmptyString(event.targetId, "event.targetId");
      if (event.confirmation !== "user-explicit") {
        fail("RiskAccepted.confirmation 只允许 user-explicit。", "把 confirmation 改为 user-explicit 后重试；standing-authorization 仅适用于 approve-contract，全托管授权不能替代具体风险接受。");
      }
      break;
    default:
      break;
  }

  if (record) {
    requirePositiveInteger(event.seq, "event.seq");
    requireNonEmptyString(event.recordedAt, "event.recordedAt");
    if (!Number.isFinite(Date.parse(event.recordedAt))) {
      fail(`event.recordedAt 不是有效时间：${event.recordedAt}。`, "把 recordedAt 修为 ISO 8601 时间，或从 events.jsonl 备份恢复该行后重试。 ");
    }
    requireSha256(event.eventId, "event.eventId");
    requireSignatureShape(event.signature, "事件记录 signature");
  }
}

function validateNonEmptyArtifactShape(artifact) {
  requireNonEmptyString(artifact, "event.artifact");
}

function requireFindingId(value, label) {
  if (typeof value !== "string" || !/^F-[A-Z0-9-]+$/.test(value)) {
    fail(`${label} 格式非法。`, "把 findingId 改为 F- 后缀仅含英文大写字母、数字或连字符的格式，例如 F-A1；不要由 agent 自行编造其他格式。 ");
  }
}

function verifyEventSignature(record, keys) {
  const contentBytes = Buffer.from(canonicalJson(eventContent(record)), "utf8");
  const publicKey = keys[record.actor].keyObject;
  try {
    return cryptoVerify(null, contentBytes, publicKey, Buffer.from(record.signature, "base64"));
  } catch {
    return false;
  }
}

function parseEventRecords(taskDir, keys) {
  const filePath = join(taskDir, "events.jsonl");
  const text = readText(filePath, "events.jsonl", "重新运行 init 创建缺失的空 events.jsonl；若文件已损坏，从备份恢复后重试。 ");
  if (text.length === 0) return { entries: [], text };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      fail(`events.jsonl 第 ${index + 1} 行为空。`, "删除空行并保持每条事件占一行，或从备份恢复 events.jsonl 后重试。 ");
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`events.jsonl 第 ${index + 1} 行不是合法 JSON：${error.message}。`, `修复第 ${index + 1} 行，或从备份恢复 events.jsonl 后重试；不要删除无法识别的事实。`);
    }
    validateEventShape(record, { record: true });
    if (record.seq !== index + 1) {
      fail(`events.jsonl 第 ${index + 1} 行 seq=${record.seq}，预期 ${index + 1}。`, "按现有行序恢复从 1 开始的连续 seq；不要重排事件，修复后重试。 ");
    }
    const content = eventContent(record);
    const expectedId = computeEventId(content);
    if (record.eventId !== expectedId) {
      fail(`events.jsonl 第 ${index + 1} 行 eventId 与事件内容哈希不一致。`, `从追加时的原始记录恢复第 ${index + 1} 行；若确需更正事件内容，重新计算 eventId 并明确审计该手工修改后重试。`);
    }
    if (!verifyEventSignature(record, keys)) {
      fail(`events.jsonl 第 ${index + 1} 行事件签名验证失败（actor=${record.actor}：签名错误或公钥不匹配）。`, `从追加时的原始记录恢复该行；确需更正事件时，用对应角色私钥（${Object.entries(SIGNING_KEY_NAMES).map(([actor, keyName]) => `actor=${actor} 用 ${keyName}`).join("，")}）重新 append 并审计该手工修改。`);
    }
    entries.push({ record, line: index + 1 });
  }
  return { entries, text };
}

function requirementById(contract, requirementId) {
  return contract.requirements.find((requirement) => requirement.id === requirementId);
}

function coversDimensions(eventDimensions, requiredDimensions) {
  const actual = new Set(eventDimensions);
  return requiredDimensions.every((dimension) => actual.has(dimension));
}

function foldEvents(world, entries) {
  const currentVersion = world.contract.contractVersion;
  const fold = {
    approvals: [],
    implementations: [],
    evidence: [],
    assurances: [],
    explorations: [],
    findings: new Map(),
    risks: [],
    missingArtifacts: [],
  };
  const seenEvents = new Map();
  const raisedFindings = new Map();
  const currentIncrementIds = new Set(world.increments.items.map((item) => item.id));

  for (const entry of entries) {
    const event = entry.record;
    const lineLabel = `events.jsonl 第 ${entry.line} 行`;
    const contentKey = canonicalJson(eventContent(event));
    if (seenEvents.has(event.eventId)) {
      if (seenEvents.get(event.eventId) !== contentKey) {
        fail(`${lineLabel} 与先前 eventId 相同但内容不同。`, "从原始备份恢复事件流并重新计算事件哈希后重试；不要复用其他事件的 eventId。 ");
      }
      continue;
    }
    seenEvents.set(event.eventId, contentKey);
    let artifactUsable = true;
    if (Object.hasOwn(event, "artifact")) {
      const probed = probeArtifact(world.taskDir, event.artifact);
      if (!probed.ok) {
        artifactUsable = false;
        // 只把当前契约版本的缺失计入 missingArtifacts；历史版本事件的 artifact 缺失属历史噪声，不阻塞当前判定
        if (event.contractVersion === currentVersion) {
          fold.missingArtifacts.push({ artifact: event.artifact, type: event.type, seq: event.seq });
        }
      }
    }
    if (event.contractVersion > currentVersion) {
      fail(`${lineLabel} 的 contractVersion=${event.contractVersion} 高于当前契约版本 ${currentVersion}。`, "恢复匹配的 contract.json/increments.json，或移除误写入的未来版本事件后重试。 ");
    }
    const current = event.contractVersion === currentVersion;

    switch (event.type) {
      case "ContractApproved":
        if (current) fold.approvals.push(event);
        break;
      case "ImplementationRecorded":
        if (current && artifactUsable) {
          if (!currentIncrementIds.has(event.incrementId)) {
            fail(`${lineLabel} 引用了当前 increments.json 中不存在的增量 ${event.incrementId}。`, "恢复该增量定义，或修正 ImplementationRecorded.incrementId 后重试。 ");
          }
          fold.implementations.push(event);
        }
        break;
      case "EvidenceRecorded":
        if (current && artifactUsable) {
          const requirement = requirementById(world.contract, event.requirementId);
          if (!requirement) {
            fail(`${lineLabel} 引用了未知需求 ${event.requirementId}。`, "把 requirementId 修为当前契约中的需求 id，或恢复被误删的契约条目后重试。 ");
          }
          if (!requirement.evidenceKinds.includes(event.kind)) {
            fail(`${lineLabel} 的 kind=${event.kind} 未声明于需求 ${event.requirementId}。`, "改用该需求 evidenceKinds 中声明的证据类型，或递增契约版本并更新证据声明后重试。 ");
          }
          fold.evidence.push(event);
        }
        break;
      case "AssuranceCompleted":
        if (current && artifactUsable) fold.assurances.push(event);
        break;
      case "ExplorationCompleted":
        if (current && artifactUsable) {
          if (!coversDimensions(event.dimensions, world.contract.reviewDimensions)) {
            fail(`${lineLabel} 未完整覆盖 contract.reviewDimensions。`, `补齐维度 ${world.contract.reviewDimensions.join(", ")} 后重新追加 ExplorationCompleted；允许同时申报契约外额外维度。`);
          }
          fold.explorations.push(event);
        }
        break;
      case "FindingRaised": {
        if (raisedFindings.get(event.findingId) === event.contractVersion) {
          fail(`${lineLabel} 重复分配 findingId=${event.findingId} 且内容不同。`, "为新发现使用新的 F- 格式 id；若这是同一事件，请恢复原事件内容与 eventId 以实现幂等。 ");
        }
        if (current) {
          for (const requirementId of event.requirementIds) {
            if (!requirementById(world.contract, requirementId)) {
              fail(`${lineLabel} 的 finding 引用了未知需求 ${requirementId}。`, "把 requirementIds 修为当前契约中的需求 id，或恢复契约条目后重试。 ");
            }
          }
        }
        raisedFindings.set(event.findingId, event.contractVersion);
        if (current) fold.findings.set(event.findingId, { raised: event, resolutions: [] });
        break;
      }
      case "FindingResolved": {
        if (!raisedFindings.has(event.findingId)) {
          fail(`${lineLabel} 试图解决尚未出现的 finding ${event.findingId}。`, `先追加对应 FindingRaised，再追加 FindingResolved；若 id 写错，修正 ${event.findingId} 后重试。`);
        }
        const finding = fold.findings.get(event.findingId);
        if (current && finding) finding.resolutions.push(event);
        break;
      }
      case "RiskAccepted": {
        if (current) {
          if (event.targetType === "requirement") {
            const requirement = requirementById(world.contract, event.targetId);
            if (!requirement) {
              fail(`${lineLabel} 的风险接受指向未知需求 ${event.targetId}。`, "把 targetId 修为当前契约中的需求 id 后重试 accept-risk。 ");
            }
            if (!requirement.riskAcceptable) {
              fail(`需求 ${event.targetId} 的 riskAcceptable=false，拒绝风险接受。`, "不要追加该 RiskAccepted；补充验证或递增契约版本并由用户重新裁决风险策略。 ");
            }
          } else {
            const finding = fold.findings.get(event.targetId);
            if (!finding) {
              fail(`${lineLabel} 的风险接受指向当前版本中不存在的 finding ${event.targetId}。`, "先追加当前版本的 FindingRaised，并确认 targetId 与 findingId 完全一致后重试。 ");
            }
            if (finding.resolutions.some((resolution) => resolution.revision === event.revision)) {
              fail(`finding ${event.targetId} 在 revision ${event.revision} 下已解决，不能再接受其风险。`, "不要追加该 RiskAccepted；若问题复现，使用新的 findingId 记录新发现后重试。 ");
            }
            for (const requirementId of finding.raised.requirementIds) {
              const requirement = requirementById(world.contract, requirementId);
              if (requirement && !requirement.riskAcceptable) {
                fail(`finding ${event.targetId} 关联的需求 ${requirementId} 不允许接受风险。`, "不要接受该 finding 风险；修复问题并追加 FindingResolved，或递增契约版本重新裁决风险策略。 ");
              }
            }
          }
          fold.risks.push(event);
        }
        break;
      }
      default:
        break;
    }
  }
  return fold;
}

function loadWorld(taskDirValue, { withEvents = true } = {}) {
  const { taskDir, task, keys } = loadTask(taskDirValue);
  const contractPath = join(taskDir, "contract.json");
  const contractText = readText(contractPath, "contract.json", "运行 delivery-wf/contract-design 生成 contract.json，或从任务备份恢复后重试。 ");
  let contract;
  try {
    contract = JSON.parse(contractText);
  } catch (error) {
    fail(`contract.json 不是合法 JSON：${error.message}。`, `修复 ${contractPath} 的 JSON 语法后重试当前命令。`);
  }
  validateContract(contract, task);
  const increments = readJson(join(taskDir, "increments.json"), "increments.json");
  validateIncrements(increments, contract);
  const world = {
    taskDir,
    task,
    keys,
    contract,
    increments,
    contractSha256: createHash("sha256").update(contractText, "utf8").digest("hex"),
    entries: [],
    eventsText: "",
    fold: null,
  };
  if (withEvents) {
    const parsed = parseEventRecords(taskDir, keys);
    world.entries = parsed.entries;
    world.eventsText = parsed.text;
    world.fold = foldEvents(world, world.entries);
  }
  return world;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function tryClaimEventsLock(lockDir, ownerDocument) {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    fail(`无法创建事件锁目录 ${lockDir}：${error.message}。`, `检查任务目录写权限后重试；确认没有其他进程正在写入该任务目录的 events.jsonl。`);
  }
  try {
    writeFileSync(join(lockDir, "owner"), JSON.stringify(ownerDocument), "utf8");
  } catch {
    // owner 写入失败说明锁目录刚被抢占者删除，回到循环重新竞争。
    return false;
  }
  return true;
}

function readLockOwner(lockDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, "owner"), "utf8"));
    if (
      isRecord(parsed) &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.startedAt === "string" &&
      Number.isFinite(Date.parse(parsed.startedAt))
    ) {
      return parsed;
    }
  } catch {
    // owner 缺失或损坏时按锁目录时间判龄。
  }
  return null;
}

function acquireEventsLock(taskDir) {
  const lockDir = join(taskDir, EVENTS_LOCK_DIRNAME);
  const deadline = Date.now() + EVENTS_LOCK_WAIT_MS;
  const ownerDocument = { pid: process.pid, startedAt: new Date().toISOString() };
  for (;;) {
    if (tryClaimEventsLock(lockDir, ownerDocument)) {
      return { preempted: false, previousOwner: null };
    }
    const owner = readLockOwner(lockDir);
    let lockStartedAt = Date.now();
    if (owner) {
      lockStartedAt = Date.parse(owner.startedAt);
    } else {
      try {
        lockStartedAt = statSync(lockDir).mtimeMs;
      } catch {
        lockStartedAt = Date.now();
      }
    }
    const staleByAge = Date.now() - lockStartedAt > EVENTS_LOCK_MAX_AGE_MS;
    const deadOwner = owner !== null && (owner.pid <= 0 || !isPidAlive(owner.pid));
    if (staleByAge || deadOwner) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // 抢占删除失败时重新循环评估。
      }
      const previousOwner = owner ?? { startedAt: new Date(lockStartedAt).toISOString(), note: "owner 缺失，按锁目录时间判龄" };
      if (tryClaimEventsLock(lockDir, ownerDocument)) {
        return { preempted: true, previousOwner };
      }
      continue;
    }
    if (Date.now() > deadline) {
      fail(`等待事件锁超时：${lockDir} 被其他进程持有超过 ${EVENTS_LOCK_WAIT_MS / 1000} 秒。`, `等待持有进程完成（owner 内含 pid 与起始时间）；若持有进程已退出，删除 ${lockDir} 后重试当前命令。`);
    }
    sleepSync(50);
  }
}

function releaseEventsLock(taskDir) {
  try {
    rmSync(join(taskDir, EVENTS_LOCK_DIRNAME), { recursive: true, force: true });
  } catch {
    // 锁目录可能已被抢占流程删除；删除失败不影响已完成的写入。
  }
}

function withEventsLock(taskDirValue, run) {
  requireExistingDirectory(taskDirValue, "--task-dir");
  const taskDir = realpathSync(taskDirValue);
  const acquired = acquireEventsLock(taskDir);
  try {
    const result = run();
    if (acquired.preempted) {
      process.stderr.write(`delivery-gate: 已抢占陈旧或失效的 ${EVENTS_LOCK_DIRNAME}（原持有者 ${JSON.stringify(acquired.previousOwner)}）；本次写入已在重建的锁下串行完成。\n`);
    }
    return result;
  } finally {
    releaseEventsLock(taskDir);
  }
}

function appendEvent(world, event, privateKey) {
  validateEventShape(event);
  if (Object.hasOwn(event, "artifact")) validateArtifact(world.taskDir, event.artifact);
  const eventId = computeEventId(event);
  const contentKey = canonicalJson(event);
  for (const entry of world.entries) {
    if (entry.record.eventId === eventId) {
      if (canonicalJson(eventContent(entry.record)) !== contentKey) {
        fail("新事件与既有 eventId 冲突但内容不同。", "修改事件内容以生成新的哈希；若持续冲突，保留事件流并排查哈希计算后重试。 ");
      }
      return entry.record;
    }
  }
  if (event.contractVersion !== world.contract.contractVersion) {
    fail(
      `event.contractVersion=${event.contractVersion} 与当前契约版本 ${world.contract.contractVersion} 不一致。`,
      `把 contractVersion 改为 ${world.contract.contractVersion}，并重新核对事件对当前契约的引用后重试。`,
    );
  }
  if (event.type === "ContractApproved" && event.contractSha256 !== world.contractSha256) {
    fail("ContractApproved.contractSha256 与当前 contract.json 不一致。", `重新计算当前 contract.json 的 sha256；也可运行 ${GATE_COMMAND} approve-contract --task-dir <dir> --confirmation <确认方式> --summary <摘要> --user-key <userKey> 自动计算。`);
  }

  const signature = cryptoSign(null, Buffer.from(contentKey, "utf8"), privateKey).toString("base64");
  const record = {
    ...event,
    seq: world.entries.length + 1,
    recordedAt: new Date().toISOString(),
    eventId,
    signature,
  };
  const prospective = [...world.entries, { record, line: world.entries.length + 1 }];
  foldEvents(world, prospective);

  const prefix = world.eventsText.length > 0 && !world.eventsText.endsWith("\n") ? "\n" : "";
  const filePath = join(world.taskDir, "events.jsonl");
  let descriptor;
  try {
    descriptor = openSync(filePath, "a");
    writeSync(descriptor, `${prefix}${JSON.stringify(record)}\n`, null, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留追加失败原因，调用方按恢复动作检查文件。
      }
    }
    fail(`无法追加 events.jsonl：${error.message}。`, `检查 ${filePath} 的写权限与磁盘空间；确认最后一条完整记录后重试，完全相同的成功重试不会重复追加。`);
  }
  return record;
}

function runGit(args, cwd, { binary = false, nonGitAllowed = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    fail(`执行 git ${args[0]} 失败：${result.error.message}。`, "确认 git 已安装且项目目录可访问，解除挂起的 git 进程后重试；非 git 项目请在 evaluate 中显式传 --revision。 ");
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : `退出码 ${result.status}`;
    if (nonGitAllowed && /not a git repository/i.test(stderr)) return { ok: false, stderr };
    fail(`git ${args.join(" ")} 执行失败：${stderr}。`, "在项目工作树内重试并修复 git 报告的问题；若仓库尚无 HEAD，先创建初始提交，或在 evaluate 中显式传 --revision。 ");
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

function isGitWorktree(projectRootValue) {
  requireExistingDirectory(projectRootValue, "--project-root");
  const projectRoot = realpathSync(projectRootValue);
  const probe = runGit(["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], projectRoot, {
    nonGitAllowed: true,
  });
  return probe.ok && probe.stdout.trim() === "true";
}

function hashFileContents(hash, filePath, budget = null) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      if (budget) {
        budget.bytes += bytesRead;
        if (budget.bytes > budget.limit) {
          budget.exceeded = true;
          break;
        }
      }
    }
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留读取错误，恢复动作指向 revision 重试。
      }
    }
    fail(`计算 revision 时无法读取 ${filePath}：${error.message}。`, "确认文件仍存在且可读，关闭正在改写它的进程后重试 revision；也可在 evaluate 中显式传稳定的内容版本。 ");
  }
}

function specialKind(statLike) {
  if (statLike.isFIFO()) return "fifo";
  if (statLike.isSocket()) return "socket";
  if (typeof statLike.isCharacterDevice === "function" && statLike.isCharacterDevice()) return "chardev";
  if (typeof statLike.isBlockDevice === "function" && statLike.isBlockDevice()) return "blockdev";
  return "unknown";
}

function markTruncated(hash, budget) {
  if (!budget.truncated) {
    hash.update("\0truncated\0");
    budget.truncated = true;
  }
}

function hashDirectoryTree(hash, dirPath, displayPath, budget, depth) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    hash.update(`\0dir-unreadable\0${displayPath}\0${error.code ?? error.message}\0`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (budget.truncated) return;
    const entryDisplay = `${displayPath}/${entry.name}`;
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (depth + 1 > UNTRACKED_DIRECTORY_MAX_DEPTH) {
        hash.update(`\0dir-depth-limit\0${entryDisplay}\0`);
        continue;
      }
      hash.update(`\0dir\0${entryDisplay}\0`);
      hashDirectoryTree(hash, entryPath, entryDisplay, budget, depth + 1);
    } else if (entry.isFile()) {
      hash.update(`\0file\0${entryDisplay}\0`);
      hashFileContents(hash, entryPath, budget);
      if (budget.exceeded) markTruncated(hash, budget);
    } else if (entry.isSymbolicLink()) {
      hash.update(`\0symlink\0${entryDisplay}\0`);
      let target;
      try {
        target = readlinkSync(entryPath);
      } catch (error) {
        hash.update(`unreadable\0${error.code ?? ""}\0`);
        continue;
      }
      hash.update(`${target}\0`);
      hashSymlinkTarget(hash, entryPath, target, budget, depth + 1);
    } else {
      hash.update(`\0special\0${entryDisplay}\0${specialKind(entry)}\0`);
    }
  }
}

function hashSymlinkTarget(hash, linkPath, target, budget, depth) {
  const resolvedTarget = resolve(dirname(linkPath), target);
  let stat;
  try {
    stat = lstatSync(resolvedTarget);
  } catch {
    hash.update("broken\0");
    return;
  }
  // 目标本身也是符号链接时继续递归解析（含链接环：深度上限终止），否则二级链接的目标内容变化不会反映进 revision
  if (stat.isSymbolicLink()) {
    if (depth > UNTRACKED_DIRECTORY_MAX_DEPTH) {
      hash.update("target-link-depth-limit\0");
      return;
    }
    let nextTarget;
    try {
      nextTarget = readlinkSync(resolvedTarget);
    } catch (error) {
      hash.update(`target-link-unreadable\0${error.code ?? ""}\0`);
      return;
    }
    hash.update("target-link\0");
    hash.update(nextTarget, "utf8");
    hash.update("\0");
    hashSymlinkTarget(hash, resolvedTarget, nextTarget, budget, depth + 1);
    return;
  }
  if (stat.isFile()) {
    hash.update("target-file\0");
    hashFileContents(hash, resolvedTarget, budget);
    if (budget.exceeded) markTruncated(hash, budget);
  } else if (stat.isDirectory()) {
    if (depth > UNTRACKED_DIRECTORY_MAX_DEPTH) {
      hash.update("target-dir-depth-limit\0");
      return;
    }
    hash.update("target-dir\0");
    hashDirectoryTree(hash, resolvedTarget, target, budget, depth + 1);
  } else {
    hash.update(`target-special\0${specialKind(stat)}\0`);
  }
}

function computeRevision(projectRootValue) {
  requireExistingDirectory(projectRootValue, "--project-root");
  const projectRoot = realpathSync(projectRootValue);
  if (!isGitWorktree(projectRoot)) {
    fail(`目录不是可自动计算 revision 的 git 工作树：${projectRoot}。`, "在 git 项目根目录重试 revision；非 git 项目请使用 evaluate --task-dir <dir> --revision <非空内容版本>。 ");
  }
  const topLevelResult = runGit(["-C", projectRoot, "rev-parse", "--show-toplevel"], projectRoot);
  const gitRoot = topLevelResult.stdout.trim();
  const headResult = runGit(["-C", gitRoot, "rev-parse", "HEAD"], gitRoot);
  const head = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    fail(`git HEAD 返回了无法识别的值：${JSON.stringify(head)}。`, "修复仓库 HEAD 后重试 revision，或在 evaluate 中显式传 --revision。 ");
  }
  const diff = runGit(["-C", gitRoot, "diff", "--binary", "--full-index", "HEAD", "--"], gitRoot, {
    binary: true,
  }).stdout;
  const untrackedResult = runGit(
    ["-C", gitRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    gitRoot,
  );
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean).sort();
  if (diff.length === 0 && untracked.length === 0) return head;

  const hash = createHash("sha256");
  hash.update("delivery-gate-revision-v1\0tracked-diff\0");
  hash.update(diff);
  const budget = { limit: UNTRACKED_SYMLINK_BUDGET_BYTES, bytes: 0, exceeded: false, truncated: false };
  for (const relativePath of untracked) {
    const absolutePath = resolve(gitRoot, relativePath);
    hash.update("\0untracked\0");
    hash.update(relativePath, "utf8");
    hash.update("\0");
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      fail(`计算 revision 时未跟踪文件发生变化：${absolutePath}（${error.message}）。`, "等工作区文件稳定后重试 revision，避免在扫描期间创建或删除文件。 ");
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      let target;
      try {
        target = readlinkSync(absolutePath);
      } catch (error) {
        fail(`无法读取未跟踪符号链接 ${absolutePath}：${error.message}。`, "修复或移除该链接后重试 revision。 ");
      }
      hash.update(target, "utf8");
      hash.update("\0");
      hashSymlinkTarget(hash, absolutePath, target, budget, 0);
      if (budget.exceeded) markTruncated(hash, budget);
    } else if (stat.isFile()) {
      hash.update("file\0");
      hashFileContents(hash, absolutePath);
    } else {
      hash.update(`special\0${specialKind(stat)}\0`);
    }
  }
  return `${head}+${hash.digest("hex").slice(0, 12)}`;
}

function requirementEvidenceStatus(kindEntries) {
  const results = kindEntries.map((entry) => entry.result);
  if (results.length > 0 && results.every((result) => result === "verified")) return "verified";
  if (results.includes("failed")) return "failed";
  if (results.includes("partial")) return "partial";
  return "missing";
}

function buildVerdict(world, revision, revisionSource = "computed") {
  requireNonEmptyString(revision, "--revision");
  const { contract, fold } = world;
  const currentRevision = (event) => event.revision === revision;
  const implemented = new Set(
    fold.implementations.map((event) => event.incrementId),
  );
  const implementedIncrementIds = world.increments.items
    .filter((item) => implemented.has(item.id))
    .map((item) => item.id);

  const latestEvidence = new Map();
  for (const event of fold.evidence) {
    if (currentRevision(event)) latestEvidence.set(`${event.requirementId}\0${event.kind}`, event);
  }
  const requirementRisks = new Set(
    fold.risks.filter((event) => currentRevision(event) && event.targetType === "requirement").map((event) => event.targetId),
  );
  const findingRisks = new Set(
    fold.risks.filter((event) => currentRevision(event) && event.targetType === "finding").map((event) => event.targetId),
  );

  const requirements = contract.requirements.map((requirement) => {
    const kindEntries = requirement.evidenceKinds.map((kind) => {
      const event = latestEvidence.get(`${requirement.id}\0${kind}`);
      return event
        ? { kind, result: event.result, eventId: event.eventId, artifact: event.artifact }
        : { kind, result: "missing" };
    });
    return {
      id: requirement.id,
      required: requirement.required,
      riskAcceptable: requirement.riskAcceptable,
      status: requirementEvidenceStatus(kindEntries),
      evidence: kindEntries,
      riskAccepted: requirementRisks.has(requirement.id),
    };
  });

  const openFindings = [...fold.findings.values()]
    .filter((finding) => !finding.resolutions.some((resolution) => resolution.revision === revision))
    .map((finding) => ({
      findingId: finding.raised.findingId,
      requirementIds: [...finding.raised.requirementIds],
      severity: finding.raised.severity,
      artifact: finding.raised.artifact,
      riskAccepted: findingRisks.has(finding.raised.findingId),
    }));
  const assuranceCompleted = fold.assurances.some(currentRevision);
  const explorationCompleted = fold.explorations.some(currentRevision);
  const explorationSatisfied = contract.exploratoryReview !== "required" || explorationCompleted;
  const approved = fold.approvals.some((event) => event.contractSha256 === world.contractSha256);
  const missingIncrementIds = world.increments.items.filter((item) => !implemented.has(item.id)).map((item) => item.id);

  const evidenceGaps = [];
  for (const requirement of requirements) {
    if (!requirement.required) continue;
    for (const evidence of requirement.evidence) {
      if (evidence.result !== "verified") {
        evidenceGaps.push({ requirementId: requirement.id, kind: evidence.kind, result: evidence.result });
      }
    }
  }
  const unmetRiskRequirementIds = requirements
    .filter((requirement) => requirement.required && requirement.status !== "verified" && !requirement.riskAccepted)
    .map((requirement) => requirement.id);
  const unacceptedFailedRequirementIds = requirements
    .filter((requirement) =>
      requirement.required &&
      requirement.evidence.some((evidence) => evidence.result === "failed") &&
      !requirement.riskAccepted,
    )
    .map((requirement) => requirement.id);
  const unacceptedFindingIds = openFindings.filter((finding) => !finding.riskAccepted).map((finding) => finding.findingId);
  const unacceptedBlockerIds = openFindings
    .filter((finding) => finding.severity === "blocker" && !finding.riskAccepted)
    .map((finding) => finding.findingId);

  const allRequiredVerified = requirements
    .filter((requirement) => requirement.required)
    .every((requirement) => requirement.status === "verified");
  const allRequiredRisksAccepted = requirements
    .filter((requirement) => requirement.required && requirement.status !== "verified")
    .every((requirement) => requirement.riskAccepted);
  const allOpenFindingsAccepted = openFindings.every((finding) => finding.riskAccepted);
  const hasCurrentRiskAcceptance = fold.risks.some(currentRevision);
  const allIncrementsImplemented = missingIncrementIds.length === 0;

  const accepted = approved &&
    allIncrementsImplemented &&
    allRequiredVerified &&
    assuranceCompleted &&
    explorationSatisfied &&
    openFindings.length === 0;
  const acceptedWithRisk = approved &&
    allIncrementsImplemented &&
    assuranceCompleted &&
    explorationSatisfied &&
    allRequiredRisksAccepted &&
    allOpenFindingsAccepted &&
    (hasCurrentRiskAcceptance || !allRequiredVerified);

  let state;
  if (!approved) state = "draft";
  // 无实现记录但已有未接受 failed 证据或 blocker finding 时，实现事务已在进行，不回退成 contract-approved
  else if (
    implementedIncrementIds.length === 0 &&
    unacceptedFailedRequirementIds.length === 0 &&
    unacceptedBlockerIds.length === 0
  ) state = "contract-approved";
  else if (!allIncrementsImplemented || unacceptedFailedRequirementIds.length > 0 || unacceptedBlockerIds.length > 0) {
    state = "implementing";
  } else if (accepted) state = "accepted";
  else if (acceptedWithRisk) state = "accepted_with_risk";
  else state = "candidate";

  const missing = {
    contractApproval: !approved,
    incrementIds: missingIncrementIds,
    evidence: evidenceGaps,
    assuranceCompleted: !assuranceCompleted,
    explorationCompleted: contract.exploratoryReview === "required" && !explorationCompleted,
    riskAcceptances: [
      ...unmetRiskRequirementIds.map((targetId) => ({ targetType: "requirement", targetId })),
      ...unacceptedFindingIds.map((targetId) => ({ targetType: "finding", targetId })),
    ],
    missingArtifacts: [...fold.missingArtifacts],
  };
  const nextAction = buildNextAction({
    state,
    taskDir: world.taskDir,
    revision,
    missingIncrementIds,
    unacceptedFailedRequirementIds,
    unacceptedBlockerIds,
  });

  return {
    state,
    taskId: world.task.taskId,
    projectRoot: world.task.projectRoot,
    revision,
    revisionSource,
    contractVersion: contract.contractVersion,
    requirements,
    implementedIncrementIds,
    openFindings,
    missing,
    integrity: { eventCount: world.entries.length, signatureVerified: true },
    nextAction,
    generatedBy: "delivery-gate",
    generatedAt: new Date().toISOString(),
  };
}

function buildNextAction({
  state,
  taskDir,
  revision,
  missingIncrementIds,
  unacceptedFailedRequirementIds,
  unacceptedBlockerIds,
}) {
  const taskArg = JSON.stringify(taskDir);
  const revisionArg = JSON.stringify(revision);
  const evaluate = `${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision ${revisionArg}`;
  if (state === "draft") {
    return `运行 delivery-wf/contract-design 复核当前契约，再由用户执行 ${GATE_COMMAND} approve-contract --task-dir ${taskArg} --confirmation user-explicit --summary "批准当前契约" --user-key <userKey>。`;
  }
  if (unacceptedFailedRequirementIds.length > 0) {
    return `修复需求 ${unacceptedFailedRequirementIds.join(", ")} 的 failed 证据并运行 delivery-wf/independent-assurance（taskDir=${taskArg}）；仅对允许风险的需求执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (unacceptedBlockerIds.length > 0) {
    return `运行 delivery-wf/independent-assurance（taskDir=${taskArg}）修复并解决 blocker ${unacceptedBlockerIds.join(", ")}，或对允许风险的 finding 执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (state === "contract-approved" || missingIncrementIds.length > 0) {
    return `运行 delivery-wf/candidate-build（taskDir=${taskArg}）完成增量 ${missingIncrementIds.join(", ") || "全部待实施增量"}，然后执行 ${evaluate}。`;
  }
  if (state === "accepted") {
    return `保留 verdict.json 与原始证据作为当前交付裁决；代码或契约变化后运行 delivery-wf/independent-assurance，并执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  if (state === "accepted_with_risk") {
    return `按 verdict.json 中已接受的风险交付并保留证据；下一内容版本运行 delivery-wf/independent-assurance，再执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  return `运行 delivery-wf/independent-assurance（taskDir=${taskArg}）补齐 missing.evidence、当前保证与探索审查；对允许风险的缺口执行 accept-risk，然后执行 ${evaluate}。`;
}

function parseOptions(args, specification) {
  const flags = new Set(specification.flags ?? []);
  const allowed = new Set([...specification.required, ...specification.optional, ...flags]);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) usageFail(`无法识别位置参数 ${JSON.stringify(argument)}。`);
    const name = argument.slice(2);
    if (!allowed.has(name)) usageFail(`命令含未知参数 --${name}。`);
    if (Object.hasOwn(values, name)) usageFail(`参数 --${name} 重复出现。`);
    if (flags.has(name)) {
      values[name] = true;
      continue;
    }
    if (index + 1 >= args.length) {
      usageFail(`参数 --${name} 缺少值。`);
    }
    values[name] = args[index + 1];
    index += 1;
  }
  for (const name of specification.required) {
    if (!Object.hasOwn(values, name)) usageFail(`缺少必需参数 --${name}。`);
  }
  return values;
}

function parseAppendEvent(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`--event 不是合法 JSON：${error.message}。`, "修正 --event 的 JSON 引号与语法后重试 append；复杂事件建议使用 approve-contract 或 accept-risk 高层命令。 ");
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function listGroupTasks(groupDir) {
  if (!existsSync(groupDir)) return [];
  return readdirSync(groupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(groupDir, entry.name, "task.json")))
    .map((entry) => ({ taskId: entry.name, taskDir: join(groupDir, entry.name) }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function nextRoundTaskId(groupDir, baseTaskId) {
  if (!existsSync(join(groupDir, baseTaskId, "task.json"))) return baseTaskId;
  let round = 2;
  while (existsSync(join(groupDir, `${baseTaskId}-r${round}`, "task.json"))) round += 1;
  return `${baseTaskId}-r${round}`;
}

function commandInit(args) {
  const options = parseOptions(args, {
    required: ["project-root", "task-id"],
    optional: [],
    flags: ["new-round", "resume-existing"],
  });
  if (options["new-round"] && options["resume-existing"]) {
    fail("--new-round 与 --resume-existing 互斥：继续既有任务用 --resume-existing，开新一轮目录用 --new-round。", "按目标二选一后重试 init。");
  }
  validateTaskId(options["task-id"]);
  requireExistingDirectory(options["project-root"], "--project-root");
  const projectRoot = realpathSync(options["project-root"]);
  const groupDir = join(homedir(), ".agents", "skill-data", "delivery", projectSlug(projectRoot));
  const worktree = isGitWorktree(projectRoot);
  const exactDir = join(groupDir, options["task-id"]);
  const exactExists = existsSync(join(exactDir, "task.json"));

  if (options["resume-existing"]) {
    if (!exactExists) {
      fail(`--resume-existing 指向的任务不存在：${exactDir}。`, `去掉 --resume-existing 直接 init 新任务；或核对 --task-id 与 --project-root 是否与既有任务一致。`);
    }
    const existing = readJson(join(exactDir, "task.json"), "task.json");
    validateTaskRecord(existing, exactDir);
    if (existing.taskId !== options["task-id"] || existing.projectRoot !== projectRoot) {
      fail(`任务目录已存在且 task.json 与本次 init 参数不一致：${exactDir}。`, "复用原 taskId 与原 projectRoot，或选择新的 taskId；不要清空既有任务目录。 ");
    }
    const eventsPath = join(exactDir, "events.jsonl");
    if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
    printJson({
      taskDir: realpathSync(exactDir),
      reused: true,
      projectRoot,
      worktree,
      siblingTasks: listGroupTasks(groupDir).filter((task) => task.taskId !== options["task-id"]),
      builderPublicKey: existing.builderPublicKey,
      assurancePublicKey: existing.assurancePublicKey,
      userPublicKey: existing.userPublicKey,
    });
    return;
  }

  if (exactExists && !options["new-round"]) {
    const siblings = listGroupTasks(groupDir).filter((task) => task.taskId !== options["task-id"]);
    fail(
      `任务目录已存在，拒绝静默复用：${exactDir}${siblings.length > 0 ? `（同 worktree 分组下还有 ${siblings.length} 个任务：${siblings.map((task) => task.taskId).join("、")}）` : ""}。`,
      `继续该任务加 --resume-existing；同项目新一轮交付加 --new-round（目录按 ${options["task-id"]}-r2/-r3 递增分开）；若该目录不是本会话创建的，立即停止——先确认 --project-root 是你自己的 worktree（当前 projectRoot=${projectRoot}, worktree=${worktree}），评测等多会话同题环境必须每会话独立 worktree。`,
    );
  }

  const taskId = options["new-round"] ? nextRoundTaskId(groupDir, options["task-id"]) : options["task-id"];
  const taskDir = join(groupDir, taskId);
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  const taskPath = join(taskDir, "task.json");
  if (existsSync(taskPath)) {
    const existing = readJson(taskPath, "task.json");
    validateTaskRecord(existing, taskDir);
    if (existing.taskId !== taskId || existing.projectRoot !== projectRoot) {
      fail(`任务目录已存在且 task.json 与本次 init 参数不一致：${taskDir}。`, "复用原 taskId 与原 projectRoot，或选择新的 taskId；不要清空既有任务目录。 ");
    }
    const eventsPath = join(taskDir, "events.jsonl");
    if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
    printJson({
      taskDir: realpathSync(taskDir),
      reused: true,
      projectRoot,
      worktree,
      siblingTasks: listGroupTasks(groupDir).filter((task) => task.taskId !== taskId),
      builderPublicKey: existing.builderPublicKey,
      assurancePublicKey: existing.assurancePublicKey,
      userPublicKey: existing.userPublicKey,
    });
    return;
  }
  const pairs = Object.fromEntries(
    SIGNING_KEY_ROLES.map((role) => {
      const pair = generateKeyPairSync("ed25519");
      return [role, { privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }), publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }];
    }),
  );
  atomicWrite(taskPath, `${JSON.stringify({
    schemaVersion: 1,
    taskId,
    projectRoot,
    builderPublicKey: pairs.builder.publicKey,
    assurancePublicKey: pairs.assurance.publicKey,
    userPublicKey: pairs.user.publicKey,
  }, null, 2)}\n`);
  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
  const siblingTasks = listGroupTasks(groupDir).filter((task) => task.taskId !== taskId);
  printJson({
    taskDir: realpathSync(taskDir),
    projectRoot,
    worktree,
    siblingTasks,
    ...(siblingTasks.length > 0
      ? {
          notice:
            `该 worktree 分组下已有其他交付任务（${siblingTasks.map((task) => task.taskId).join("、")}）。` +
            "init 前必须确认本会话对该 worktree 的归属：任务目录不是本会话创建时立即停止并核实；评测等多会话同题环境，每场评测必须基于干净基线新建自己的 worktree，禁止读写他人任务目录。",
        }
      : {}),
    builderKey: pairs.builder.privateKey,
    assuranceKey: pairs.assurance.privateKey,
    userKey: pairs.user.privateKey,
    builderPublicKey: pairs.builder.publicKey,
    assurancePublicKey: pairs.assurance.publicKey,
    userPublicKey: pairs.user.publicKey,
  });
}

function commandValidateContract(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: [] });
  const world = loadWorld(options["task-dir"], { withEvents: false });
  printJson({
    valid: true,
    taskDir: world.taskDir,
    contractVersion: world.contract.contractVersion,
    contractSha256: world.contractSha256,
  });
}

function commandApproveContract(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "confirmation", "summary", "user-key"],
    optional: ["revision"],
  });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = resolveSigningKey(world, options["user-key"], "user");
    const event = {
      type: "ContractApproved",
      actor: "user",
      contractVersion: world.contract.contractVersion,
      revision: Object.hasOwn(options, "revision") ? options.revision : "",
      summary: options.summary,
      contractSha256: world.contractSha256,
      confirmation: options.confirmation,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandAppend(args) {
  const options = parseOptions(args, { required: ["task-dir", "event", "key"], optional: [] });
  const event = parseAppendEvent(options.event);
  validateEventShape(event);
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = resolveSigningKey(world, options.key, event.actor);
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandAcceptRisk(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "target-type", "target-id", "confirmation", "summary", "user-key"],
    optional: ["revision"],
  });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = resolveSigningKey(world, options["user-key"], "user");
    const revision = Object.hasOwn(options, "revision")
      ? options.revision
      : computeRevision(world.task.projectRoot);
    const event = {
      type: "RiskAccepted",
      actor: "user",
      contractVersion: world.contract.contractVersion,
      revision,
      summary: options.summary,
      targetType: options["target-type"],
      targetId: options["target-id"],
      confirmation: options.confirmation,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandEvaluate(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  // 持事件锁：与 append/approve/accept 互斥，防止读到写入中途的事件流组合
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    let revision;
    let revisionSource;
    if (Object.hasOwn(options, "revision")) {
      requireNonEmptyString(options.revision, "--revision");
      revision = options.revision;
      if (isGitWorktree(world.task.projectRoot)) {
        const computed = computeRevision(world.task.projectRoot);
        if (computed !== revision) {
          fail(
            `git 项目显式 --revision=${revision} 与当前工作树 revision=${computed} 不一致。`,
            `重新执行 ${GATE_COMMAND} evaluate --task-dir <dir> --revision ${JSON.stringify(computed)} 使用当前工作树 revision；若需保留旧裁决，先恢复项目内容为该 revision 对应状态。`,
          );
        }
        revisionSource = "caller-verified";
      } else {
        revisionSource = "caller";
      }
    } else {
      revision = computeRevision(world.task.projectRoot);
      revisionSource = "computed";
    }
    const verdict = buildVerdict(world, revision, revisionSource);
    const text = `${JSON.stringify(verdict, null, 2)}\n`;
    atomicWrite(join(world.taskDir, "verdict.json"), text);
    process.stdout.write(text);
  });
}

function commandRevision(args) {
  const options = parseOptions(args, { required: ["project-root"], optional: [] });
  process.stdout.write(`${computeRevision(options["project-root"])}\n`);
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
      process.stdout.write(HELP);
      return;
    }
    if (args.length === 0) usageFail("未提供命令。");
    const command = args[0];
    const commandArgs = args.slice(1);
    if (commandArgs.length === 1 && commandArgs[0] === "--help") {
      process.stdout.write(HELP);
      return;
    }
    switch (command) {
      case "init":
        commandInit(commandArgs);
        break;
      case "validate-contract":
        commandValidateContract(commandArgs);
        break;
      case "approve-contract":
        commandApproveContract(commandArgs);
        break;
      case "append":
        commandAppend(commandArgs);
        break;
      case "accept-risk":
        commandAcceptRisk(commandArgs);
        break;
      case "evaluate":
        commandEvaluate(commandArgs);
        break;
      case "revision":
        commandRevision(commandArgs);
        break;
      default:
        usageFail(`未知命令 ${JSON.stringify(command)}。`);
    }
  } catch (error) {
    const exitCode = error instanceof GateError ? error.exitCode : 1;
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail.includes("恢复动作：")
      ? detail
      : `${detail} 恢复动作：检查输入文件、目录权限与磁盘状态后重试；若仍失败，保留此错误并排查 delivery-gate.mjs。`;
    process.stderr.write(`delivery-gate: ${message}\n`);
    process.exitCode = exitCode;
  }
}

main();
