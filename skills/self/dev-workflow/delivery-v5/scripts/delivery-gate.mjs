#!/usr/bin/env node
// delivery-gate（DEV）——确定性交付裁决器（delivery-v2 的 V5 线，裁决语义同构）。语义权威：.tmp/delivery-wf/redesign-detailed.md 第 3 章。
// 与 v1 的核心差异：16 事件词表、凭据文件化（私钥不再经参数传递）、验收包联合哈希、
// 原始意图绑定、策略包三层与快照、逐事件失效范围、accepted 完整判定式、任务替换三段协议、
// 漂移链计数、写事务租约。命令层新增 record-review/approve-acceptance/supersede-*/lease-* 等。

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
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
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
import { fileURLToPath } from "node:url";
// 判定单源库（V5 内核）：发现 open 集、修复轮与跨 run 预算、定级改判统计只此一份实现，
// 本文件与 delivery-core.mjs 同进程复用；workflow 侧经 delivery-core CLI 的 JSON 子命令消费，
// 禁止在别处复刻同口径判定
import { KERNEL_RULES, findingRegrades, openFindingsFromEvents, repairBudgetFromEvents, taskPhaseFromEvents } from "./lib/kernel-judgments.mjs";

const GATE_COMMAND = "node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs";
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 事件写入角色与凭据一一对应；designer 的产物是验收草稿文件，engine 的测试摘要由 builder 角色记录，均不写事件
const ACTORS = ["builder", "assurance", "user"];
const CONFIRMATIONS = ["user-explicit", "standing-authorization"];
const EVIDENCE_KINDS = ["command", "scenario", "inspection"];
const FINDING_CATEGORIES = ["defect", "boundary"];
const FINDING_SEVERITIES = ["blocker", "non-blocker"];
const EVIDENCE_RESULTS = ["verified", "partial", "failed"];
// 任务级事件（替换/声明/基线/策略）允许在验收包出现前登记，此时 acceptanceVersion 为 0
const COMMON_EVENT_FIELDS = ["type", "actor", "acceptanceVersion", "revision", "summary"];
const EVENT_SCHEMAS = {
  AcceptanceReviewed: {
    actors: ["assurance"],
    fields: ["acceptancePackageSha256", "intentSha256", "policySnapshotSha256", "conclusion", "artifact"],
  },
  AcceptanceApproved: {
    actors: ["user"],
    fields: ["acceptancePackageSha256", "intentSha256", "policySnapshotSha256", "reviewEventId", "confirmation"],
  },
  DesignApproved: {
    actors: ["user"],
    fields: ["packageFiles", "decisionRef", "confirmation"],
  },
  ImplementationRecorded: {
    actors: ["builder"],
    fields: ["incrementId", "artifact", "mergeReceipt"],
  },
  EvidenceRecorded: {
    actors: ["assurance"],
    fields: ["requirementId", "kind", "result", "artifact", "artifactSha256"],
  },
  FindingRaised: {
    actors: ["assurance", "builder"],
    fields: ["findingId", "category", "severity", "requirementIds", "artifact"],
  },
  FindingResolved: {
    actors: ["assurance"],
    fields: ["findingId", "artifact"],
  },
  // 重认领（V5 代收敛机制）：revision 前进使旧 resolution 失效后，assurance 在新 revision 上
  // 确认「原修复仍有效」——指向原 resolution 的 eventId，不凭空产生新 resolution 语义
  ResolutionReaffirmed: {
    actors: ["assurance"],
    fields: ["findingId", "originalResolutionEventId", "basis", "artifact"],
  },
  ExplorationCompleted: {
    actors: ["assurance"],
    fields: ["dimensions", "coverageManifestSha256", "artifact"],
  },
  AssuranceCompleted: {
    actors: ["assurance"],
    fields: [
      "evidenceEventIds",
      "coverageManifestSha256",
      "explorationEventId",
      "incrementReceipts",
      "cleanBuild",
      "artifact",
    ],
  },
  AssuranceRevisionDrift: {
    actors: ["assurance"],
    fields: ["setupRevision", "finalizeRevision", "driftSeq"],
  },
  RepairRoundRecorded: {
    actors: ["builder"],
    fields: ["round", "triggerFindingIds", "affectedAssertionIds", "artifact"],
  },
  RiskAccepted: {
    actors: ["user"],
    fields: ["targetType", "targetId", "gapId", "evidenceState", "confirmation"],
  },
  // 风险预授权（V5 代收敛机制）：用户预先声明可由 standing-authorization 接受的 finding 范围。
  // 持久事实（不随版本/revision 失效——它是授权声明不是证据）。安全边界三条硬编码：
  // 仅 finding 目标、severity 上限恒 non-blocker（blocker 永不可预授权）、数量上限必填
  RiskPreauthorized: {
    actors: ["user"],
    fields: ["categories", "maxSeverity", "maxFindings", "confirmation"],
  },
  PolicyUpgraded: {
    actors: ["user"],
    fields: ["oldPolicySnapshotSha256", "newPolicySnapshotSha256", "invalidationNote", "confirmation"],
  },
  RevisionBaselineConfirmed: {
    actors: ["user"],
    fields: ["confirmedRevision", "reason"],
  },
  IndependentTaskDeclared: {
    actors: ["user"],
    fields: ["intentSha256", "unreplacedTasks"],
  },
  TaskSuperseded: {
    actors: ["user"],
    fields: ["phase", "predecessor", "inheritedFindings"],
  },
  TaskSupersedeCancelled: {
    actors: ["user"],
    fields: ["cancelledPrepareEventId", "predecessorTaskDir", "predecessorTaskJsonSha256", "cancelledTaskJsonSha256", "cancelledVerdictSha256", "reason"],
  },
  // 冻结解封（V5 写入防护）：批准后验收包 chmod 0444；合法修订唯一通道 = 用户登记
  // RevisionOpened 解封（chmod 0644 + 留痕），此后允许起草新版本并重新审查与批准。
  // 未解封的改动在 loadWorld 被篡改检测拦下（写入当秒被 chmod 拒，漏网者在加载时检出）
  RevisionOpened: {
    actors: ["user"],
    fields: ["target", "reason"],
  },
};
const EVENT_TYPES = Object.keys(EVENT_SCHEMAS);
// TaskSuperseded 的 prepareEventId 只在 committed 段必填；shape 校验按 phase 条件放行
const CONDITIONAL_EVENT_FIELDS = {
  TaskSuperseded: { onlyPhase: "committed", fields: ["prepareEventId"] },
};
const OPTIONAL_EVENT_FIELDS = {
  EvidenceRecorded: ["assertionIds", "adversarialFormIds"],
  // consequenceRefutationType = 行为后果否决论证的三类声明（合并稿 §9：不会发生 /
  // 用户不可观察 / 验收明确允许），正文存 consequenceRefutation，机器只认枚举
  FindingRaised: ["consequenceRefutation", "consequenceRefutationType", "reopenOf", "origin", "firstDetectedStage", "expectedStage", "regressionTestRef"],
  AssuranceCompleted: ["mode", "artifactSha256"],
  // 哈希绑定扩展到全部携带 artifact 的证据/回执事件（合并稿 §10.3 证据不可覆盖）：
  // OPTIONAL 起步兼容旧事件流，workflow 侧新登记必填
  ImplementationRecorded: ["artifactSha256"],
  ExplorationCompleted: ["artifactSha256"],
  // V5 代修复轮次溯源：fromRevision/toRevision = 该轮修复前后的 revision（受控修复循环
  // 登记时携带；旧事件与上限熔断事件可缺省）；incrementReceipts = 每轮修复的全量确定性
  // 测试回执（合并稿 §11.1，与 AssuranceCompleted 回执同款双哈希）；nature = 轮次性质
  //（behavior 计轮；environment/evidence 重试不计轮——合并稿 §7.1）
  RepairRoundRecorded: ["fromRevision", "toRevision", "artifactSha256", "incrementReceipts", "nature"],
};
const EVENTS_LOCK_DIRNAME = ".events.lock";
const EVENTS_LOCK_MAX_AGE_MS = 30_000;
const EVENTS_LOCK_WAIT_MS = 30_000;
const UNTRACKED_SYMLINK_BUDGET_BYTES = 8 * 1024 * 1024;
const UNTRACKED_DIRECTORY_MAX_DEPTH = 16;
const SIGNING_KEY_NAMES = { builder: "builderKey", assurance: "assuranceKey", user: "userKey" };
const SIGNING_KEY_ROLES = ["builder", "assurance", "user"];
const CREDENTIAL_KEY_DIR = join(homedir(), ".agents", "skill-data", "delivery-keys");
const POLICY_USER_DIR = join(homedir(), ".agents", "skill-data", "delivery-policies");
const DELIVERY_DATA_DIR = join(homedir(), ".agents", "skill-data", "delivery");
const LEASE_DIR = join(homedir(), ".agents", "skill-data", "delivery-leases");
const LEASE_STALE_MS = 120_000;
const HELP = `delivery-gate（DEV）：delivery-v5 的确定性交付裁决器（状态/转移/计数归 delivery-core 内核，判定单源 = scripts/lib/kernel-judgments.mjs）

凭据（v2 起私钥不再经参数传递）：
  init 将三把角色私钥写入用户级凭据目录（0600）：~/.agents/skill-data/delivery-keys/<分组>/<任务id>/{builder,assurance,user}.key。
  stdout 只输出凭据 id（credentialId）与三把公钥，不输出任何私钥。所有需要签名的事件命令用
  --credential <credentialId> 出示凭据；CLI 按 credentialId 定位私钥，并强制事件 actor 与凭据角色
  一致——builder 凭据签不出 actor=assurance 的事件，user 凭据只供主会话使用，绝不注入子 agent。

用法：
  delivery-gate init --project-root P --task-id T [--new-round] [--resume-existing] [--intent-file F]
  delivery-gate set-intent --task-dir D --file F
  delivery-gate validate-acceptance --task-dir D
  delivery-gate snapshot-policy --task-dir D
  delivery-gate record-review --task-dir D --conclusion pass|reject --summary S --credential <assurance credentialId>
  delivery-gate approve-acceptance --task-dir D --confirmation user-explicit|standing-authorization --summary S --credential <user credentialId> [--revision R]  # V5：批准即冻结（chmod 0444 + frozen/v<N>/ 快照）
  delivery-gate open-revision --task-dir D --reason S --credential <user credentialId>  # V5：合法解冻唯一通道（RevisionOpened 留痕 + chmod 0644）
  delivery-gate record-design-approved --task-dir D --package-file F --decision-file F2 --summary S --credential <user credentialId>
  # 意图提交命令组（执行器事件唯一通道；信封由 gate 构造：actor/revision/acceptanceVersion/domain/artifactSha256 缺省内核计算）
  delivery-gate record-implementation --task-dir D --increment-id INC-1 --summary S --artifact A --merge-receipt '<JSON>' --credential <builder credentialId> [--revision R]
  delivery-gate record-repair-round --task-dir D --round N --summary S --trigger-finding-ids '<JSON>' --affected-assertion-ids '<JSON>' --artifact A --credential <builder credentialId> [--from-revision R --to-revision R2 --nature behavior|environment|evidence --increment-receipts '<JSON>']
  delivery-gate record-finding --task-dir D --summary S --category defect|boundary --severity blocker|non-blocker --requirement-ids '<JSON>' --artifact A --credential <builder|assurance credentialId> [--finding-id F --origin O --consequence-refutation S --consequence-refutation-type T --reopen-of F0]
  delivery-gate resolve-finding --task-dir D --finding-id F --summary S --artifact A --credential <assurance credentialId>
  delivery-gate reaffirm-resolution --task-dir D --finding-id F --original-resolution-event-id E --basis S --summary S --artifact A --credential <assurance credentialId>
  delivery-gate record-evidence --task-dir D --requirement-id R --kind K --result S --summary S --artifact A --credential <assurance credentialId> [--assertion-ids '<JSON>' --adversarial-form-ids '<JSON>']
  delivery-gate record-exploration --task-dir D --summary S --dimensions '<JSON>' --coverage-manifest-sha256 H --artifact A --credential <assurance credentialId>
  delivery-gate complete-assurance --task-dir D --summary S --coverage-manifest-sha256 H --exploration-event-id E --increment-receipts '<JSON>' --artifact A --credential <assurance credentialId> [--mode full|recheck|explore-only --evidence-event-ids '<JSON>' --clean-build '<JSON>']
  delivery-gate record-assurance-drift --task-dir D --setup-revision R --finalize-revision R2 --drift-seq N --summary S --credential <assurance credentialId>
  delivery-gate accept-risk --task-dir D --target-type requirement|finding --target-id ID --confirmation user-explicit --summary S --credential <user credentialId> [--revision R] [--gap-id G]
  delivery-gate accept-risk --task-dir D --target-type finding --target-id ID --confirmation standing-authorization --summary S --credential <user credentialId>  # V5 代：须先由用户 preauthorize-risk 登记覆盖该 finding 的预授权（类别白名单 + 名额上限；severity 上限恒 non-blocker）
  delivery-gate preauthorize-risk --task-dir D --categories defect,boundary --max-findings N --summary S --credential <user credentialId>  # V5 代：用户预先声明 standing 接受范围（持久授权声明；blocker 永不可预授权）
  delivery-gate evaluate --task-dir D [--revision R]
  delivery-gate revision --project-root P
  delivery-gate confirm-baseline --task-dir D --reason S --credential <user credentialId> [--revision R]
  delivery-gate upgrade-policy --task-dir D --invalidation-note S --summary S --credential <user credentialId>
  delivery-gate declare-independent --task-dir D --credential <user credentialId>
  delivery-gate supersede-prepare --task-dir D --predecessor-dir P --summary S --credential <user credentialId>
  delivery-gate supersede-commit --task-dir D --summary S --credential <user credentialId>
  delivery-gate supersede-cancel --task-dir D --cancelled-prepare-event-id E --reason S --summary S --credential <user credentialId>
  delivery-gate lease-acquire --project-root P --run-id R
  delivery-gate lease-heartbeat --project-root P --run-id R
  delivery-gate lease-release --project-root P --run-id R

退出码：成功 0；业务校验失败 1；命令行用法错误 2。
完整入口：${GATE_COMMAND} <command> ...

init 重复语义：任务目录按 projectRoot 分组（~/.agents/skill-data/delivery/<分组 slug>/<taskId>/）。
  同 taskId 已存在时默认拒绝——继续既有任务用 --resume-existing；同项目新一轮交付用 --new-round
  （任务目录按 <taskId>-r2/-r3 递增分开，不共用）。init 输出 projectRoot/worktree/siblingTasks/evalIdentity，
  主会话据此确认 --project-root 是本会话自己的 worktree；评测等多会话同题环境必须每会话独立 worktree。
  血统规则：同一 git 仓库身份（覆盖全部 worktree）下已存在 intent 哈希或验收包相同的任务时，新 init
  必须走任务替换（supersede-prepare 继承未决发现）或由用户签署 IndependentTaskDeclared 声明确属独立任务。
  intent 对账在 init 执行；验收包对账在 validate-acceptance / record-review（验收包首次成型与绑定）执行。
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

function requireEventKeys(value, allowed, optional, label) {
  const required = allowed.filter((key) => !optional.includes(key));
  const keys = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`缺少字段 ${missing.join(", ")}`);
    if (unknown.length > 0) parts.push(`含未知字段 ${unknown.join(", ")}`);
    fail(`${label} 形态非法：${parts.join("；")}。`, `按事件契约补齐必需字段并删除未知字段后重试；可选字段为 ${optional.join(", ") || "无"}。`);
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

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${label} 必须是非负整数。`, `把 ${label} 改为从 0 开始的整数后重试当前命令。`);
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
    fail(`${label} 必须是 64 位小写 sha256 十六进制字符串。`, `重新计算目标内容的 sha256 并修正 ${label} 后重试；也可使用高层命令自动计算。`);
  }
}

function requireSignatureShape(value, label) {
  if (typeof value !== "string" || Buffer.from(value, "base64").length !== 64) {
    fail(`${label} 必须是 64 字节 Ed25519 签名的 base64 字符串。`, `保留追加时生成的原始签名；确需更正事件时，用对应角色凭据重新 append 该事件并审计手工修改。`);
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
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(filePath, label) {
  try {
    return sha256Text(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`无法读取 ${label}：${filePath}（${error.message}）。`, `确认文件存在且可读后重试当前命令。`);
  }
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
    fail(`${label} 不是合法 PEM 公钥：${error.message}。`, `保持 init 生成的公钥原文；若 task.json 已损坏，走任务替换用新任务 id 重放事件。`);
  }
}

// ── 凭据文件（v2）：私钥只落用户级目录（0600），CLI 按调用方出示的 credentialId 定位 ──
// credentialId 形态 "<project-slug>/<taskId>/<role>"，登记进 task.json；任何命令不得接收私钥文本。
function credentialFilePath(credentialId) {
  const parts = credentialId.split("/");
  if (parts.length !== 3 || !SIGNING_KEY_ROLES.includes(parts[2])) {
    fail(`credentialId ${JSON.stringify(credentialId)} 非法。`, `使用 init 输出的 credentialId（形态 <分组>/<任务id>/${SIGNING_KEY_ROLES.join("|")}）重试当前命令。`);
  }
  validateTaskId(parts[1]);
  return join(CREDENTIAL_KEY_DIR, parts[0], parts[1], `${parts[2]}.key`);
}

function writeCredentialKeys(groupSlug, taskId, pairs) {
  const dir = join(CREDENTIAL_KEY_DIR, groupSlug, taskId);
  mkdirSync(dir, { recursive: true });
  for (const role of SIGNING_KEY_ROLES) {
    const filePath = join(dir, `${role}.key`);
    // 原子创建：已存在即拒绝覆盖——凭据一旦生成本会话外不可重置，丢失走任务替换
    try {
      const descriptor = openSync(filePath, "wx");
      writeSync(descriptor, pairs[role].privateKey, null, "utf8");
      closeSync(descriptor);
      chmodSync(filePath, 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        fail(`凭据文件已存在，拒绝覆盖：${filePath}。`, `复用既有凭据（同 taskId 重新 init 时凭证登记不变）；凭据确实损坏或丢失时走任务替换（supersede-prepare），不要删除后重建。`);
      }
      throw error;
    }
  }
  return dir;
}

function loadCredentialPrivateKey(world, credentialId, expectedRole) {
  requireNonEmptyString(credentialId, "--credential");
  const role = credentialId.split("/")[2];
  const registered = world.task.credentials?.[role];
  if (registered !== credentialId) {
    fail(
      `credentialId ${JSON.stringify(credentialId)} 与任务登记不符（登记值 ${JSON.stringify(registered ?? "无")}）。`,
      `使用 init 输出的本任务 credentialId 重试；跨任务凭据不得混用。`,
    );
  }
  const filePath = credentialFilePath(credentialId);
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`无法读取凭据文件 ${filePath}：${error.message}。`, `确认凭据文件仍在用户级目录且当前用户可读；凭据丢失时走任务替换（supersede-prepare）在新任务继续，旧任务事件保留审计。`);
  }
  try {
    accessSync(filePath, fsConstants.W_OK);
  } catch {
    // 可读不可写不影响签名，但暴露权限异常时提示收紧
    process.stderr.write(`delivery-gate: 凭据文件权限宽于预期（可写）：${filePath}——建议 chmod 600。\n`);
  }
  const privateKey = createPrivateKey(text);
  const derivedX = publicJwkXFromPrivate(privateKey);
  const expectedX = world.keys[role].x;
  if (derivedX !== expectedX) {
    fail(`凭据 ${credentialId} 的派生公钥与 task.json 登记的 ${role} 公钥不匹配。`, `使用本任务 init 生成的凭据文件；若凭据文件被替换过，走任务替换重新建立信任。`);
  }
  if (role !== expectedRole) {
    fail(
      `actor=${expectedRole} 的事件必须出示 ${expectedRole} 凭据，提供的凭据对应 ${role} 角色。`,
      expectedRole === "user"
        ? `user 事件只能由主会话用 user 凭据（${world.task.credentials?.user ?? "..."}）追加；user 凭据不得注入子 agent 或 workflow。`
        : `使用 ${expectedRole} 凭据重试当前命令；角色凭据不得跨 workflow 注入。`,
    );
  }
  return privateKey;
}

function publicJwkXFromPrivate(privateKeyObject) {
  const jwk = createPublicKey(privateKeyObject).export({ format: "jwk" });
  return typeof jwk.x === "string" ? jwk.x : null;
}

// ── 策略包（三层）与快照 ──
// 只从技能安装目录与用户级目录加载；被验收的项目仓库不可覆盖（安全参数零信任）。
// 快照：AcceptanceReviewed 之前由 snapshot-policy 固化为任务目录内文件，此后审查/批准/evaluate 全按快照执行。
const POLICY_FILE_NAMES = ["roles.json", "evidence-kinds.json", "finding-categories.json", "verdict-rules.json", "revision.json"];

function readPolicyJson(filePath, originLabel) {
  const parsed = readJson(filePath, `${originLabel} 策略文件`);
  requireRecord(parsed, `${originLabel} 策略文件`);
  return parsed;
}

function loadPolicySources() {
  const sources = {};
  const installed = join(SKILL_ROOT, "policies");
  for (const name of POLICY_FILE_NAMES) {
    sources[name] = readPolicyJson(join(installed, name), "技能安装目录");
  }
  // 用户级覆盖：同名文件整体替换（L1/L2 数据与声明式规则）；L3 代码插件不在本 CLI 的加载范围
  if (existsSync(POLICY_USER_DIR)) {
    for (const name of POLICY_FILE_NAMES) {
      const override = join(POLICY_USER_DIR, name);
      if (existsSync(override)) sources[name] = readPolicyJson(override, "用户级策略目录");
    }
  }
  return sources;
}

function validatePolicySources(sources) {
  const roles = sources["roles.json"];
  requireRecord(roles, "roles.json");
  if (!Array.isArray(roles.roles) || roles.roles.length === 0) {
    fail("roles.json 的 roles 必须是非空数组。", `修正 ${join(SKILL_ROOT, "policies", "roles.json")} 或用户级覆盖后重试。`);
  }
  const seenRoleIds = new Set();
  for (let index = 0; index < roles.roles.length; index += 1) {
    const role = roles.roles[index];
    const label = `roles.json roles[${index}]`;
    requireRecord(role, label);
    requireExactKeys(role, ["id", "mayWrite"], label);
    requireNonEmptyString(role.id, `${label}.id`);
    if (seenRoleIds.has(role.id)) fail(`${label}.id 重复：${role.id}。`, "角色 id 必须唯一，修正后重试。");
    seenRoleIds.add(role.id);
    requireStringArray(role.mayWrite, `${label}.mayWrite`, { nonEmptyItems: true, unique: true });
    for (const eventType of role.mayWrite) {
      if (!EVENT_TYPES.includes(eventType)) {
        fail(`${label}.mayWrite 含未知事件类型 ${JSON.stringify(eventType)}。`, `mayWrite 只能引用内核事件词表：${EVENT_TYPES.join(", ")}。`);
      }
    }
  }
  for (const actor of ACTORS) {
    if (!seenRoleIds.has(actor)) fail(`roles.json 缺少内核必需角色 ${actor}。`, `保留 builder/assurance/user 三角色定义（密钥体系依赖），可在其上追加自定义角色。`);
  }
  const kinds = sources["evidence-kinds.json"];
  requireRecord(kinds, "evidence-kinds.json");
  requireStringArray(kinds.evidenceKinds ?? kinds.kinds ?? [], "evidence-kinds.json 词表", { nonEmptyItems: true, unique: true });
  const categories = sources["finding-categories.json"];
  requireRecord(categories, "finding-categories.json");
  if (!Array.isArray(categories.categories) || categories.categories.length === 0) {
    fail("finding-categories.json 的 categories 必须是非空数组。", `修正 ${join(SKILL_ROOT, "policies", "finding-categories.json")} 或用户级覆盖后重试。`);
  }
  const seenCategories = new Set();
  for (let index = 0; index < categories.categories.length; index += 1) {
    const category = categories.categories[index];
    const label = `finding-categories.json categories[${index}]`;
    requireRecord(category, label);
    requireExactKeys(category, ["id", "blocksAccepted", "exits", "riskAcceptAllowed"], label);
    requireNonEmptyString(category.id, `${label}.id`);
    if (seenCategories.has(category.id)) fail(`${label}.id 重复。`, "分类 id 必须唯一，修正后重试。");
    seenCategories.add(category.id);
    // blocksAccepted 三态：true（修复或接受风险后放行）/ "until-confirmed"（确认前阻塞，不可接受）/ false（不阻）
    if (category.blocksAccepted !== true && category.blocksAccepted !== false && category.blocksAccepted !== "until-confirmed") {
      fail(`${label}.blocksAccepted 必须是 true、false 或 "until-confirmed"。`, `把 ${label}.blocksAccepted 改为三态之一后重试。`);
    }
    requireBoolean(category.riskAcceptAllowed, `${label}.riskAcceptAllowed`);
    requireStringArray(category.exits, `${label}.exits`, { nonEmptyItems: true, unique: true });
  }
  for (const category of FINDING_CATEGORIES) {
    if (!seenCategories.has(category)) fail(`finding-categories.json 缺少内核必需分类 ${category}。`, "保留 defect/boundary 分类定义（裁决语义依赖），可在其上追加。");
  }
  const rules = sources["verdict-rules.json"];
  requireRecord(rules, "verdict-rules.json");
  requireNonNegativeInteger(rules.maxDriftChain ?? 2, "verdict-rules.json maxDriftChain");
  requireBoolean(rules.requireAcceptanceReview ?? true, "verdict-rules.json requireAcceptanceReview");
  requireBoolean(rules.requireDesignApproved ?? true, "verdict-rules.json requireDesignApproved");
  const revision = sources["revision.json"];
  requireRecord(revision, "revision.json");
  requireEnum(revision.mode ?? "auto-git", ["auto-git", "content-manifest"], "revision.json mode");
  requireBoolean(revision.runsFromIgnoredArtifacts ?? false, "revision.json runsFromIgnoredArtifacts");
  return true;
}

function policySnapshotDocument(sources) {
  // 快照 = 五个策略文件解析后的规范内容；快照哈希 = 该文档的 canonicalJson sha256
  const document = {};
  for (const name of POLICY_FILE_NAMES) document[name] = sources[name];
  return document;
}

function policySnapshotSha256Of(document) {
  return sha256Text(canonicalJson(document));
}

// ── git 仓库身份（血统判定用）：gitdir 与远端 URL 组合，覆盖同一仓库全部 worktree ──
function gitRepositoryIdentity(projectRootValue) {
  requireExistingDirectory(projectRootValue, "--project-root");
  const projectRoot = realpathSync(projectRootValue);
  const inside = runGit(["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], projectRoot, { nonGitAllowed: true });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isGit: false, projectRoot };
  }
  const commonDirResult = runGit(["-C", projectRoot, "rev-parse", "--git-common-dir"], projectRoot);
  const commonDir = realpathResult(commonDirResult.stdout.trim(), projectRoot);
  const remoteResult = runGit(["-C", projectRoot, "remote"], projectRoot, { nonGitAllowed: true });
  const remotes = remoteResult.ok ? remoteResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  const remoteUrls = [];
  for (const remote of remotes) {
    const urlResult = runGit(["-C", projectRoot, "remote", "get-url", remote], projectRoot, { nonGitAllowed: true });
    if (urlResult.ok) remoteUrls.push(urlResult.stdout.trim());
  }
  return { isGit: true, projectRoot, commonDir, remoteUrls: [...new Set(remoteUrls)].sort() };
}

function sameRepositoryIdentity(left, right) {
  if (!left.isGit || !right.isGit) return left.projectRoot === right.projectRoot;
  if (left.commonDir !== right.commonDir) return false;
  // 远端为空（纯本地仓）时按 gitdir 判定；都有远端时要求至少一个共同 URL
  if (left.remoteUrls.length === 0 && right.remoteUrls.length === 0) return true;
  return left.remoteUrls.some((url) => right.remoteUrls.includes(url));
}

function realpathResult(pathValue, fallbackBase) {
  try {
    return realpathSync(pathValue);
  } catch {
    // gitdir 解析失败按原字符串参与比较，保持可复现
    return resolve(fallbackBase, pathValue);
  }
}

// ── 验收包联合哈希：acceptance.json + increments.json 的文件名 + 规范内容 ──
function acceptancePackageSha256(acceptanceParsed, incrementsParsed) {
  return sha256Text(
    canonicalJson({
      "acceptance.json": canonicalJson(acceptanceParsed),
      "increments.json": canonicalJson(incrementsParsed),
    }),
  );
}

// ── 任务目录基础（task.json / keys / credentials）与完整世界（验收包 + 事件流）──
function validateTaskRecord(task, taskDir) {
  requireRecord(task, "task.json");
  if (!Object.hasOwn(task, "schemaVersion") || task.schemaVersion !== 2) {
    fail(
      "task.json 的 schemaVersion 必须为 2（v2 凭据登记形态）。",
      `v1 任务（schemaVersion 1、无凭据登记）不能直接升级：走任务替换（supersede-prepare）在新任务继承未决发现，旧目录保留审计。`,
    );
  }
  requireRecord(task.credentials, "task.json.credentials");
  for (const role of SIGNING_KEY_ROLES) {
    requireNonEmptyString(task.credentials[role], `task.json.credentials.${role}`);
  }
  const requiredKeys = ["builderPublicKey", "assurancePublicKey", "userPublicKey"];
  const taskKeys = ["schemaVersion", "taskId", "projectRoot", "credentials", ...requiredKeys, "supersededBy", "supersedeCancelled"];
  // 只核验模式（纳管体系外已有实现）：豁免方案包与 DesignApproved，init 时显式声明
  if (Object.hasOwn(task, "verificationOnly")) {
    requireBoolean(task.verificationOnly, "task.json.verificationOnly");
    taskKeys.push("verificationOnly");
  }
  requireExactKeys(task, taskKeys, "task.json");
  validateTaskId(task.taskId);
  requireExistingDirectory(task.projectRoot, "task.json.projectRoot");
  for (const keyName of requiredKeys) requirePublicKeyPem(task[keyName], `task.json.${keyName}`);
  for (const marker of ["supersededBy", "supersedeCancelled"]) {
    if (task[marker] !== null) {
      requireRecord(task[marker], `task.json.${marker}`);
      requireNonEmptyString(task[marker].successorTaskId, `task.json.${marker}.successorTaskId`);
      requireSha256(task[marker].prepareEventId, `task.json.${marker}.prepareEventId`);
    }
  }
  // 凭据登记必须与本任务目录对应，防止跨任务借凭据
  const expectedPrefix = `${projectSlug(task.projectRoot)}/${task.taskId}/`;
  for (const role of SIGNING_KEY_ROLES) {
    if (!task.credentials[role].startsWith(expectedPrefix)) {
      fail(
        `task.json.credentials.${role} 与任务目录不一致（期望前缀 ${expectedPrefix}）。`,
        "使用本任务 init 输出的凭据；凭据登记损坏时走任务替换重建。",
      );
    }
  }
}

function loadTaskCore(taskDirValue) {
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

// ── 验收文件与增量文件的 schema 校验（v2 命名：acceptanceVersion）──
function validateAcceptance(acceptance, task) {
  requireRecord(acceptance, "acceptance.json");
  const acceptanceFields = [
    "schemaVersion", "acceptanceVersion", "taskId", "projectRoot", "objective", "requirements",
    "nonGoals", "riskLevel", "exploratoryReview", "reviewDimensions",
  ];
  if (acceptance.schemaVersion === 2) acceptanceFields.push("adversarialForms");
  requireExactKeys(acceptance, acceptanceFields, "acceptance.json");
  if (acceptance.schemaVersion !== 1 && acceptance.schemaVersion !== 2) {
    fail("acceptance.json 的 schemaVersion 必须为 1 或 2。", "旧任务保留 1；带断言与反例场景的 V5 验收包使用 2 后重试 validate-acceptance。");
  }
  requirePositiveInteger(acceptance.acceptanceVersion, "acceptance.acceptanceVersion");
  validateTaskId(acceptance.taskId);
  if (acceptance.taskId !== task.taskId) {
    fail("acceptance.taskId 与 task.json.taskId 不一致。", `把 acceptance.taskId 改为 ${JSON.stringify(task.taskId)} 后重试；若这是另一任务，请使用对应任务目录。`);
  }
  requireExistingDirectory(acceptance.projectRoot, "acceptance.projectRoot");
  if (acceptance.projectRoot !== task.projectRoot) {
    fail("acceptance.projectRoot 与 task.json.projectRoot 不一致。", `把 acceptance.projectRoot 改为 ${JSON.stringify(task.projectRoot)}，并保持 task.json 与 acceptance.json 指向同一项目后重试。`);
  }
  requireNonEmptyString(acceptance.objective, "acceptance.objective");
  if (!Array.isArray(acceptance.requirements) || acceptance.requirements.length === 0) {
    fail("acceptance.requirements 必须至少包含一项。", "为 acceptance.requirements 添加至少一条可证伪需求后重试 validate-acceptance。");
  }
  const requirementIds = new Set();
  const assertionIds = new Set();
  for (let index = 0; index < acceptance.requirements.length; index += 1) {
    const requirement = acceptance.requirements[index];
    const label = `acceptance.requirements[${index}]`;
    requireRecord(requirement, label);
    const requirementFields = ["id", "kind", "statement", "required", "riskAcceptable", "evidenceKinds"];
    if (acceptance.schemaVersion === 2) requirementFields.push("assertions");
    requireExactKeys(requirement, requirementFields, label);
    requireNonEmptyString(requirement.id, `${label}.id`);
    if (requirementIds.has(requirement.id)) {
      fail(`acceptance.requirements 含重复 id ${JSON.stringify(requirement.id)}。`, "为每条需求分配唯一 id，并同步修正 increments 与事件中的引用后重试。");
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
    for (const kind of requirement.evidenceKinds) requireEnum(kind, EVIDENCE_KINDS, `${label}.evidenceKinds 元素`);
    if (acceptance.schemaVersion === 2) {
      if (!Array.isArray(requirement.assertions) || requirement.assertions.length === 0) {
        fail(`${label}.assertions 必须至少包含一条最小行为断言。`, "把该需求拆成至少一条可独立判定的断言后重试 validate-acceptance。");
      }
      for (let assertionIndex = 0; assertionIndex < requirement.assertions.length; assertionIndex += 1) {
        const assertion = requirement.assertions[assertionIndex];
        const assertionLabel = `${label}.assertions[${assertionIndex}]`;
        requireRecord(assertion, assertionLabel);
        // 可选键（合并稿 §4.1「允许记录不适用理由」+ §10.2 断言依赖声明）：
        // qualifierNotApplicable = 限定条件不适用登记（带非空理由，豁免该限定条件的反例场景要求）；
        // dependsOn = 断言声明依赖的实现增量/机制条款/测试资产（修复轮影响范围机器推导的输入）
        requireEventKeys(
          assertion,
          ["id", "statement", "qualifiers", "given", "when", "then", "adversarialFormRefs", "testAssetRefs", "qualifierNotApplicable", "dependsOn"],
          ["qualifierNotApplicable", "dependsOn"],
          assertionLabel,
        );
        requireNonEmptyString(assertion.id, `${assertionLabel}.id`);
        if (assertionIds.has(assertion.id)) fail(`验收包含重复断言 id ${assertion.id}。`, "为每条断言分配全验收包唯一 id，并同步修正反例场景与证据引用后重试。");
        assertionIds.add(assertion.id);
        requireNonEmptyString(assertion.statement, `${assertionLabel}.statement`);
        requireStringArray(assertion.qualifiers, `${assertionLabel}.qualifiers`, { nonEmptyItems: true, unique: true });
        requireNonEmptyString(assertion.given, `${assertionLabel}.given`);
        requireNonEmptyString(assertion.when, `${assertionLabel}.when`);
        requireNonEmptyString(assertion.then, `${assertionLabel}.then`);
        requireStringArray(assertion.adversarialFormRefs, `${assertionLabel}.adversarialFormRefs`, { nonEmptyItems: true, unique: true });
        requireStringArray(assertion.testAssetRefs, `${assertionLabel}.testAssetRefs`, { nonEmptyItems: true, unique: true });
        if (assertion.adversarialFormRefs.length === 0 && !Object.hasOwn(assertion, "qualifierNotApplicable")) {
          fail(`${assertionLabel} 必须至少引用一个反例场景（或为不适用的限定条件登记 qualifierNotApplicable 理由）。`, "补齐 adversarialFormRefs，或为无法构造反例的限定条件逐条登记不适用理由后重试 validate-acceptance。");
        }
        if (assertion.testAssetRefs.length === 0) {
          fail(`${assertionLabel} 必须至少引用一个测试资产。`, `为 ${assertionLabel} 补齐 testAssetRefs 后重试 validate-acceptance。`);
        }
        // 限定条件不适用登记（合并稿 §4.1）：每条须落在本断言 qualifiers 内且理由非空，
        // 豁免该限定条件的「每个限定条件有反例场景」要求
        if (Object.hasOwn(assertion, "qualifierNotApplicable")) {
          if (!Array.isArray(assertion.qualifierNotApplicable) || assertion.qualifierNotApplicable.length === 0) {
            fail(`${assertionLabel}.qualifierNotApplicable 必须是非空数组。`, `逐条登记 { qualifier, rationale }（限定条件 + 不适用理由），或删除该键并补齐反例场景。`);
          }
          const exemptSeen = new Set();
          for (let exemptIndex = 0; exemptIndex < assertion.qualifierNotApplicable.length; exemptIndex += 1) {
            const exempt = assertion.qualifierNotApplicable[exemptIndex];
            const exemptLabel = `${assertionLabel}.qualifierNotApplicable[${exemptIndex}]`;
            requireRecord(exempt, exemptLabel);
            requireExactKeys(exempt, ["qualifier", "rationale"], exemptLabel);
            requireNonEmptyString(exempt.qualifier, `${exemptLabel}.qualifier`);
            requireNonEmptyString(exempt.rationale, `${exemptLabel}.rationale`);
            if (!assertion.qualifiers.includes(exempt.qualifier)) {
              fail(`${exemptLabel}.qualifier=${exempt.qualifier} 不在本断言 qualifiers 内。`, "不适用登记只能指向本断言已声明的限定条件后重试。");
            }
            if (exemptSeen.has(exempt.qualifier)) fail(`${exemptLabel}.qualifier 重复登记。`, "同一限定条件只登记一条不适用理由。");
            exemptSeen.add(exempt.qualifier);
          }
        }
        // 依赖声明（合并稿 §10.2）：机器可推导的影响范围输入；incrementIds 的存在性在
        // validateIncrements（increments 读取后）对账
        if (Object.hasOwn(assertion, "dependsOn")) {
          const dependsOn = assertion.dependsOn;
          const dependsOnLabel = `${assertionLabel}.dependsOn`;
          requireRecord(dependsOn, dependsOnLabel);
          requireExactKeys(dependsOn, ["incrementIds", "mechanismRefs", "testAssetRefs"], dependsOnLabel);
          requireStringArray(dependsOn.incrementIds, `${dependsOnLabel}.incrementIds`, { nonEmptyItems: true, unique: true });
          requireStringArray(dependsOn.mechanismRefs, `${dependsOnLabel}.mechanismRefs`, { nonEmptyItems: true, unique: true });
          requireStringArray(dependsOn.testAssetRefs, `${dependsOnLabel}.testAssetRefs`, { nonEmptyItems: true, unique: true });
        }
      }
    }
  }
  if (acceptance.schemaVersion === 2) {
    if (!Array.isArray(acceptance.adversarialForms)) fail("acceptance.adversarialForms 必须是数组。", "为每条断言补充反例场景后重试 validate-acceptance。");
    const formIds = new Set();
    const formsByAssertion = new Map();
    for (let index = 0; index < acceptance.adversarialForms.length; index += 1) {
      const form = acceptance.adversarialForms[index];
      const label = `acceptance.adversarialForms[${index}]`;
      requireRecord(form, label);
      requireExactKeys(form, ["id", "assertionId", "qualifier", "entryPoint", "initialState", "operation", "timing", "expected", "testAssetRefs", "rationale"], label);
      for (const field of ["id", "assertionId", "qualifier", "entryPoint", "initialState", "operation", "timing", "expected", "rationale"]) requireNonEmptyString(form[field], `${label}.${field}`);
      if (formIds.has(form.id)) fail(`反例场景含重复 id ${form.id}。`, "为每个反例场景分配唯一 id 后重试。");
      formIds.add(form.id);
      if (!assertionIds.has(form.assertionId)) fail(`${label} 引用未知断言 ${form.assertionId}。`, "把 assertionId 改为验收包已声明的断言 id 后重试。");
      requireStringArray(form.testAssetRefs, `${label}.testAssetRefs`, { nonEmptyItems: true, unique: true });
      if (form.testAssetRefs.length === 0) fail(`${label}.testAssetRefs 必须至少包含一个测试资产。`, "为该反例场景指定计划或实际测试资产后重试。");
      if (!formsByAssertion.has(form.assertionId)) formsByAssertion.set(form.assertionId, []);
      formsByAssertion.get(form.assertionId).push(form);
    }
    for (const requirement of acceptance.requirements) {
      for (const assertion of requirement.assertions) {
        const forms = formsByAssertion.get(assertion.id) ?? [];
        const actualFormIds = new Set(forms.map((form) => form.id));
        for (const id of assertion.adversarialFormRefs) {
          if (!actualFormIds.has(id)) fail(`断言 ${assertion.id} 的 adversarialFormRefs 引用 ${id}，但该场景未反向关联此断言。`, "修正断言与反例场景的双向引用后重试。");
        }
        if (actualFormIds.size !== assertion.adversarialFormRefs.length) {
          fail(`断言 ${assertion.id} 的反例场景数量与 adversarialFormRefs 不一致。`, "确保该断言的每个反例场景都列入 adversarialFormRefs，且没有未登记引用后重试。");
        }
        const coveredQualifiers = new Set(forms.map((form) => form.qualifier));
        // 不适用登记的限定条件豁免「每个限定条件有反例场景」（合并稿 §4.1/§11.1）
        const exemptQualifiers = new Set((assertion.qualifierNotApplicable ?? []).map((row) => row.qualifier));
        for (const qualifier of assertion.qualifiers) {
          if (!coveredQualifiers.has(qualifier) && !exemptQualifiers.has(qualifier)) {
            fail(`断言 ${assertion.id} 的限定条件 ${qualifier} 没有反例场景。`, `为该限定条件补充 adversarialForms 条目并加入 assertion.adversarialFormRefs，或在 assertion.qualifierNotApplicable 登记带理由的不适用声明后重试。`);
          }
        }
      }
    }
  }
  requireStringArray(acceptance.nonGoals, "acceptance.nonGoals");
  requireEnum(acceptance.riskLevel, ["low", "medium", "high"], "acceptance.riskLevel");
  requireEnum(acceptance.exploratoryReview, ["not-required", "required"], "acceptance.exploratoryReview");
  requireStringArray(acceptance.reviewDimensions, "acceptance.reviewDimensions", { nonEmptyItems: true, unique: true });
  if (acceptance.riskLevel === "high" && acceptance.exploratoryReview !== "required") {
    fail("高风险验收必须要求探索性审查。", "把 acceptance.exploratoryReview 改为 required，并至少填写一项 reviewDimensions 后重试。");
  }
  if (acceptance.exploratoryReview === "required" && acceptance.reviewDimensions.length === 0) {
    fail("探索性审查为 required 时 reviewDimensions 不能为空。", "为 acceptance.reviewDimensions 添加至少一个非空且去重的审查维度后重试。");
  }
}

function validateIncrements(increments, acceptance) {
  requireRecord(increments, "increments.json");
  requireExactKeys(increments, ["schemaVersion", "acceptanceVersion", "items"], "increments.json");
  if (increments.schemaVersion !== 1) {
    fail("increments.json 的 schemaVersion 必须为 1。", "把 increments.schemaVersion 修正为 1 后重试 validate-acceptance。");
  }
  requirePositiveInteger(increments.acceptanceVersion, "increments.acceptanceVersion");
  if (increments.acceptanceVersion !== acceptance.acceptanceVersion) {
    fail("increments.acceptanceVersion 必须等于当前 acceptanceVersion。", `把 increments.acceptanceVersion 更新为 ${acceptance.acceptanceVersion}，并核对增量与当前验收后重试。`);
  }
  if (!Array.isArray(increments.items) || increments.items.length === 0) {
    fail("increments.items 必须至少包含一项。", "为 increments.items 添加至少一个可运行增量后重试 validate-acceptance。");
  }
  const requirementIds = new Set(acceptance.requirements.map((requirement) => requirement.id));
  const incrementIds = new Set();
  for (let index = 0; index < increments.items.length; index += 1) {
    const item = increments.items[index];
    const label = `increments.items[${index}]`;
    requireRecord(item, label);
    // testCommand 必填（redesign 3.4/5.3：每个增量有自己的测试命令；裁决器要求回执覆盖全部增量）
    requireExactKeys(item, ["id", "title", "requirementIds", "testCommand"], label);
    requireNonEmptyString(item.id, `${label}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id)) {
      fail(`${label}.id 格式非法：${JSON.stringify(item.id)}。`, "把增量 id 改为字母或数字开头、仅含字母数字/下划线/连字符且长度不超过 64 的形式后重试。");
    }
    if (incrementIds.has(item.id)) {
      fail(`increments.items 含重复 id ${JSON.stringify(item.id)}。`, "为每个增量分配唯一 id，并修正 ImplementationRecorded.incrementId 后重试。");
    }
    incrementIds.add(item.id);
    requireNonEmptyString(item.title, `${label}.title`);
    requireStringArray(item.requirementIds, `${label}.requirementIds`, { nonEmptyItems: true, unique: true });
    if (item.requirementIds.length === 0) {
      fail(`${label}.requirementIds 必须至少引用一项需求。`, `为 ${label}.requirementIds 填写 acceptance.requirements 中已声明的需求 id 后重试。`);
    }
    for (const requirementId of item.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        fail(`${label}.requirementIds 引用了未知需求 ${JSON.stringify(requirementId)}。`, "把该引用改为 acceptance.requirements 中已声明的 id，或先补充验收条目后重试。");
      }
    }
    requireRecord(item.testCommand, `${label}.testCommand`);
    const testCommandAllowed = ["program", "args"];
    if (Object.hasOwn(item.testCommand, "timeoutMs")) testCommandAllowed.push("timeoutMs");
    requireExactKeys(item.testCommand, testCommandAllowed, `${label}.testCommand`);
    requireNonEmptyString(item.testCommand.program, `${label}.testCommand.program`);
    requireStringArray(item.testCommand.args, `${label}.testCommand.args`);
    if (Object.hasOwn(item.testCommand, "timeoutMs")) {
      const timeoutMs = item.testCommand.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
        fail(`${label}.testCommand.timeoutMs 必须是 1000..3600000 的整数。`, `把 ${label}.testCommand.timeoutMs 改为该区间的整数（缺省 300000）后重试。`);
      }
    }
  }
  // 断言依赖声明对账（合并稿 §10.2）：dependsOn.incrementIds 必须指向已声明的增量
  if (acceptance.schemaVersion === 2) {
    for (const requirement of acceptance.requirements) {
      for (const assertion of requirement.assertions) {
        if (!Object.hasOwn(assertion, "dependsOn")) continue;
        for (const incrementId of assertion.dependsOn.incrementIds) {
          if (!incrementIds.has(incrementId)) {
            fail(`断言 ${assertion.id} 的 dependsOn.incrementIds 引用未知增量 ${incrementId}。`, "把该引用改为 increments.items 已声明的 id，或先补增量定义后重试。");
          }
        }
      }
    }
  }
}

// ── 事件形态校验（16 类）──
function eventFields(type, event = null) {
  const schema = EVENT_SCHEMAS[type];
  let conditional = [];
  if (event && CONDITIONAL_EVENT_FIELDS[type]) {
    const rule = CONDITIONAL_EVENT_FIELDS[type];
    if (event.phase === rule.onlyPhase) conditional = rule.fields;
  } else if (!event && CONDITIONAL_EVENT_FIELDS[type]) {
    // 无事件上下文（record 重放校验）时按宽松集，phase 匹配性在 switch 分支内校验
    conditional = CONDITIONAL_EVENT_FIELDS[type].fields;
  }
  return [...COMMON_EVENT_FIELDS, ...schema.fields, ...conditional, ...(OPTIONAL_EVENT_FIELDS[type] ?? [])];
}

function eventContent(record) {
  const content = {};
  for (const field of eventFields(record.type, record)) {
    if (record[field] !== undefined) content[field] = record[field];
  }
  // domain 章参与内容哈希（无章历史事件不含该键，哈希口径向后兼容）
  if (record.domain !== undefined) content.domain = record.domain;
  return content;
}

function computeEventId(event) {
  return sha256Text(canonicalJson(event));
}

function requireFindingId(value, label) {
  if (typeof value !== "string" || !/^F-[A-Z0-9-]+$/.test(value)) {
    fail(`${label} 格式非法。`, "把 findingId 改为 F- 后缀仅含英文大写字母、数字或连字符的格式，例如 F-A1；不要由 agent 自行编造其他格式。");
  }
}

function requireMergeReceiptShape(value, label) {
  requireRecord(value, label);
  requireExactKeys(value, ["fromRevision", "toRevision", "patchSha256"], label);
  requireNonEmptyString(value.fromRevision, `${label}.fromRevision`);
  requireNonEmptyString(value.toRevision, `${label}.toRevision`);
  requireSha256(value.patchSha256, `${label}.patchSha256`);
}

function requireIncrementReceiptShape(value, label) {
  requireRecord(value, label);
  const allowed = ["incrementId", "program", "args", "exitCode", "logSha256", "cwd", "artifactSha256"];
  if (Object.hasOwn(value, "buildId")) allowed.push("buildId");
  requireExactKeys(value, allowed, label);
  requireNonEmptyString(value.incrementId, `${label}.incrementId`);
  requireNonEmptyString(value.program, `${label}.program`);
  requireStringArray(value.args, `${label}.args`);
  if (!Number.isInteger(value.exitCode)) {
    fail(`${label}.exitCode 必须是整数退出码。`, `记录测试命令的真实退出码后重试。`);
  }
  requireSha256(value.logSha256, `${label}.logSha256`);
  requireNonEmptyString(value.cwd, `${label}.cwd`);
  requireSha256(value.artifactSha256, `${label}.artifactSha256`);
  if (Object.hasOwn(value, "buildId")) requireNonEmptyString(value.buildId, `${label}.buildId`);
}

function requireCleanBuildShape(value, label) {
  requireRecord(value, label);
  requireExactKeys(value, ["buildId", "artifactSha256"], label);
  requireNonEmptyString(value.buildId, `${label}.buildId`);
  requireSha256(value.artifactSha256, `${label}.artifactSha256`);
}

function requirePackageFilesShape(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} 必须是非空数组（方案包文件哈希清单）。`, `列出方案包全部文件（name + sha256）后重试。`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryLabel = `${label}[${index}]`;
    requireRecord(entry, entryLabel);
    requireExactKeys(entry, ["name", "sha256"], entryLabel);
    requireNonEmptyString(entry.name, `${entryLabel}.name`);
    requireSha256(entry.sha256, `${entryLabel}.sha256`);
    if (seen.has(entry.name)) fail(`${entryLabel}.name 重复：${entry.name}。`, "方案包文件名必须唯一。");
    seen.add(entry.name);
  }
}

function requirePredecessorShape(value, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    ["taskDir", "taskJsonSha256", "verdictSha256", "openFindingsSha256"],
    label,
  );
  requireNonEmptyString(value.taskDir, `${label}.taskDir`);
  requireSha256(value.taskJsonSha256, `${label}.taskJsonSha256`);
  requireSha256(value.verdictSha256, `${label}.verdictSha256`);
  requireSha256(value.openFindingsSha256, `${label}.openFindingsSha256`);
}

function requireInheritedFindingsShape(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} 必须是数组（继承的未决发现清单）。`, `从前任任务的 openFindings 逐条复制 findingId/category/severity/requirementIds 后重试。`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const finding = value[index];
    const entryLabel = `${label}[${index}]`;
    requireRecord(finding, entryLabel);
    requireExactKeys(finding, ["findingId", "category", "severity", "requirementIds"], entryLabel);
    requireFindingId(finding.findingId, `${entryLabel}.findingId`);
    // category 词表不在此处枚举：shape 层只保证非空字符串，合法性由 fold 层按策略快照分类校验（TaskSuperseded prepare 分支）
    requireNonEmptyString(finding.category, `${entryLabel}.category`);
    requireEnum(finding.severity, FINDING_SEVERITIES, `${entryLabel}.severity`);
    requireStringArray(finding.requirementIds, `${entryLabel}.requirementIds`, { unique: true });
    if (seen.has(finding.findingId)) fail(`${entryLabel}.findingId 重复。`, "继承清单内的 findingId 必须唯一。");
    seen.add(finding.findingId);
  }
}

function validateEventShape(event, { record = false } = {}) {
  requireRecord(event, record ? "events.jsonl 事件记录" : "append 事件");
  requireEnum(event.type, EVENT_TYPES, "event.type");
  const schema = EVENT_SCHEMAS[event.type];
  const allowed = eventFields(event.type, event);
  if (record) allowed.push("seq", "recordedAt", "eventId", "signature");
  // domain = 写入目标域章（appendEvent 写入时盖；可选——读侧对无章历史事件按 eventDomains 补判）
  allowed.push("domain");
  const optional = [...(OPTIONAL_EVENT_FIELDS[event.type] ?? []), "domain"];
  // TaskSuperseded 条件字段：非 committed 段出现 prepareEventId 即形态错误
  if (event.type === "TaskSuperseded" && event.phase !== "committed") {
    if (Object.hasOwn(event, "prepareEventId")) {
      fail("TaskSuperseded(prepare) 不允许携带 prepareEventId（该字段属 committed 段）。", "删除 prepareEventId 字段后重试；committed 段再携带指向 prepare 的 eventId。");
    }
  }
  requireEventKeys(event, allowed, optional, record ? `事件记录 ${event.type}` : `事件 ${event.type}`);
  requireEnum(event.actor, ACTORS, "event.actor");
  if (!schema.actors.includes(event.actor)) {
    fail(`${event.type} 不允许 actor=${event.actor}。`, `把 actor 改为 ${schema.actors.join(" | ")} 后重试 append；不要伪造其他角色事件。`);
  }
  requireNonNegativeInteger(event.acceptanceVersion, "event.acceptanceVersion");
  if (event.type === "AcceptanceApproved") requireString(event.revision, "event.revision");
  else requireNonEmptyString(event.revision, "event.revision");
  requireNonEmptyString(event.summary, "event.summary");

  if (Object.hasOwn(event, "artifact")) requireNonEmptyString(event.artifact, "event.artifact");
  // 哈希绑定扩展（合并稿 §10.3）：任何携带 artifact 的事件均可带 artifactSha256，
  // 内容哈希不匹配磁盘时由防覆盖对账拦截（append 侧）
  if (Object.hasOwn(event, "artifactSha256")) requireSha256(event.artifactSha256, "event.artifactSha256");
  switch (event.type) {
    case "AcceptanceReviewed":
      requireSha256(event.acceptancePackageSha256, "event.acceptancePackageSha256");
      requireSha256(event.intentSha256, "event.intentSha256");
      requireSha256(event.policySnapshotSha256, "event.policySnapshotSha256");
      requireEnum(event.conclusion, ["pass", "reject"], "event.conclusion");
      break;
    case "AcceptanceApproved":
      requireSha256(event.acceptancePackageSha256, "event.acceptancePackageSha256");
      requireSha256(event.intentSha256, "event.intentSha256");
      requireSha256(event.policySnapshotSha256, "event.policySnapshotSha256");
      // "none" 占位仅当策略 requireAcceptanceReview=false 时合法（语义层 appendEvent/verdict 按策略判定）
      if (event.reviewEventId !== "none") requireSha256(event.reviewEventId, "event.reviewEventId");
      requireEnum(event.confirmation, CONFIRMATIONS, "event.confirmation");
      break;
    case "DesignApproved":
      requirePackageFilesShape(event.packageFiles, "event.packageFiles");
      requireNonEmptyString(event.decisionRef, "event.decisionRef");
      requireEnum(event.confirmation, CONFIRMATIONS, "event.confirmation");
      break;
    case "ImplementationRecorded":
      requireNonEmptyString(event.incrementId, "event.incrementId");
      requireMergeReceiptShape(event.mergeReceipt, "event.mergeReceipt");
      break;
    case "EvidenceRecorded":
      requireNonEmptyString(event.requirementId, "event.requirementId");
      requireEnum(event.kind, EVIDENCE_KINDS, "event.kind");
      requireEnum(event.result, EVIDENCE_RESULTS, "event.result");
      requireSha256(event.artifactSha256, "event.artifactSha256");
      if (Object.hasOwn(event, "assertionIds")) requireStringArray(event.assertionIds, "event.assertionIds", { nonEmptyItems: true, unique: true });
      if (Object.hasOwn(event, "adversarialFormIds")) requireStringArray(event.adversarialFormIds, "event.adversarialFormIds", { nonEmptyItems: true, unique: true });
      break;
    case "FindingRaised":
      requireFindingId(event.findingId, "event.findingId");
      // category 词表不在此处枚举：shape 层只保证非空字符串，合法性由 fold 层按策略快照分类校验
      requireNonEmptyString(event.category, "event.category");
      requireEnum(event.severity, FINDING_SEVERITIES, "event.severity");
      // 无关联需求的发现允许空数组（blocker 时触发全量增量修复）
      requireStringArray(event.requirementIds, "event.requirementIds", { unique: true });
      if (Object.hasOwn(event, "consequenceRefutation")) requireNonEmptyString(event.consequenceRefutation, "event.consequenceRefutation");
      // 三类论证居其一（合并稿 §9）：机器只认枚举，论证正文存 consequenceRefutation
      if (Object.hasOwn(event, "consequenceRefutationType")) {
        requireEnum(event.consequenceRefutationType, ["will-not-occur", "not-observable", "accepted-by-acceptance"], "event.consequenceRefutationType");
      }
      if (Object.hasOwn(event, "reopenOf")) requireFindingId(event.reopenOf, "event.reopenOf");
      if (Object.hasOwn(event, "origin")) requireEnum(event.origin, ["acceptance", "design", "planning", "implementation", "testing", "evidence", "environment"], "event.origin");
      if (Object.hasOwn(event, "firstDetectedStage")) requireNonEmptyString(event.firstDetectedStage, "event.firstDetectedStage");
      if (Object.hasOwn(event, "expectedStage")) requireNonEmptyString(event.expectedStage, "event.expectedStage");
      if (Object.hasOwn(event, "regressionTestRef")) requireNonEmptyString(event.regressionTestRef, "event.regressionTestRef");
      break;
    case "FindingResolved":
      requireFindingId(event.findingId, "event.findingId");
      break;
    case "ResolutionReaffirmed":
      requireFindingId(event.findingId, "event.findingId");
      requireNonEmptyString(event.originalResolutionEventId, "event.originalResolutionEventId");
      requireNonEmptyString(event.basis, "event.basis");
      break;
    case "ExplorationCompleted":
      requireStringArray(event.dimensions, "event.dimensions", { nonEmptyItems: true, unique: true });
      requireSha256(event.coverageManifestSha256, "event.coverageManifestSha256");
      break;
    case "AssuranceCompleted": {
      requireStringArray(event.evidenceEventIds, "event.evidenceEventIds", { nonEmptyItems: true, unique: true });
      requireSha256(event.coverageManifestSha256, "event.coverageManifestSha256");
      requireNonEmptyString(event.explorationEventId, "event.explorationEventId");
      if (!Array.isArray(event.incrementReceipts) || event.incrementReceipts.length === 0) {
        fail("event.incrementReceipts 必须是非空数组（逐增量测试回执）。", "为每个增量记录命令、退出码、日志哈希、cwd 与被测产物哈希后重试。");
      }
      const seenIncrement = new Set();
      for (let index = 0; index < event.incrementReceipts.length; index += 1) {
        const receipt = event.incrementReceipts[index];
        requireIncrementReceiptShape(receipt, `event.incrementReceipts[${index}]`);
        if (seenIncrement.has(receipt.incrementId)) {
          fail(`event.incrementReceipts 含重复增量 ${receipt.incrementId}。`, "每个增量一条回执，去重后重试。");
        }
        seenIncrement.add(receipt.incrementId);
      }
      if (event.cleanBuild !== null) requireCleanBuildShape(event.cleanBuild, "event.cleanBuild");
      if (Object.hasOwn(event, "mode")) requireEnum(event.mode, ["full", "recheck"], "event.mode");
      break;
    }
    case "AssuranceRevisionDrift":
      requireNonEmptyString(event.setupRevision, "event.setupRevision");
      requireNonEmptyString(event.finalizeRevision, "event.finalizeRevision");
      requirePositiveInteger(event.driftSeq, "event.driftSeq");
      break;
    case "RepairRoundRecorded":
      requirePositiveInteger(event.round, "event.round");
      requireStringArray(event.triggerFindingIds, "event.triggerFindingIds", { nonEmptyItems: true, unique: true });
      requireStringArray(event.affectedAssertionIds, "event.affectedAssertionIds", { nonEmptyItems: true, unique: true });
      // 轮次性质（合并稿 §7.1）：behavior=实现性修复计轮；environment/evidence=重试不计轮
      if (Object.hasOwn(event, "nature")) requireEnum(event.nature, ["behavior", "environment", "evidence"], "event.nature");
      // 每轮修复的全量确定性测试回执（合并稿 §11.1）：与 AssuranceCompleted 回执同款形态
      if (Object.hasOwn(event, "incrementReceipts")) {
        if (!Array.isArray(event.incrementReceipts) || event.incrementReceipts.length === 0) {
          fail("event.incrementReceipts 必须是非空数组（逐增量测试回执）。", "由修复循环引擎重跑全部增量 testCommand 后逐条登记回执；上限熔断轮可省略该字段。");
        }
        const seenIncrement = new Set();
        for (let index = 0; index < event.incrementReceipts.length; index += 1) {
          const receipt = event.incrementReceipts[index];
          requireIncrementReceiptShape(receipt, `event.incrementReceipts[${index}]`);
          if (seenIncrement.has(receipt.incrementId)) {
            fail(`event.incrementReceipts 含重复增量 ${receipt.incrementId}。`, "每个增量一条回执，去重后重试。");
          }
          seenIncrement.add(receipt.incrementId);
        }
      }
      break;
    case "RiskAccepted":
      requireEnum(event.targetType, ["requirement", "finding"], "event.targetType");
      requireNonEmptyString(event.targetId, "event.targetId");
      // 缺口 id：requirement 目标 = 派生 sha256（missing）或证据事件 id；finding 目标 = findingId 原文
      if (event.targetType === "requirement") requireSha256(event.gapId, "event.gapId");
      else requireFindingId(event.gapId, "event.gapId");
      requireEnum(event.evidenceState, [...EVIDENCE_RESULTS, "missing"], "event.evidenceState");
      if (event.confirmation !== "user-explicit") {
        // V5 代：standing-authorization 仅在「finding 目标 + 有效风险预授权覆盖」时合法，
        // 预授权匹配在 fold 重放层按世界状态校验（shape 层只拦 requirement 目标）
        if (!(event.confirmation === "standing-authorization" && event.targetType === "finding")) {
          fail(
            "RiskAccepted.confirmation 非法。",
            "requirement 目标只允许 user-explicit；finding 目标允许 user-explicit，或 standing-authorization（须先由用户 preauthorize-risk 登记覆盖该 finding 的预授权）。",
          );
        }
      }
      break;
    case "RiskPreauthorized":
      requireStringArray(event.categories, "event.categories", { nonEmptyItems: true, unique: true });
      // blocker 永不可预授权——分级判据安全底线，词表收窄为单项
      requireEnum(event.maxSeverity, ["non-blocker"], "event.maxSeverity");
      requirePositiveInteger(event.maxFindings, "event.maxFindings");
      if (event.confirmation !== "user-explicit") {
        fail("RiskPreauthorized.confirmation 只允许 user-explicit。", "风险预授权本身必须用户亲自登记——全托管授权不能代替用户对未来风险接受的预先声明；由用户执行 preauthorize-risk 后重试。");
      }
      break;
    case "PolicyUpgraded":
      requireSha256(event.oldPolicySnapshotSha256, "event.oldPolicySnapshotSha256");
      requireSha256(event.newPolicySnapshotSha256, "event.newPolicySnapshotSha256");
      requireNonEmptyString(event.invalidationNote, "event.invalidationNote");
      requireEnum(event.confirmation, CONFIRMATIONS, "event.confirmation");
      break;
    case "RevisionBaselineConfirmed":
      requireNonEmptyString(event.confirmedRevision, "event.confirmedRevision");
      requireNonEmptyString(event.reason, "event.reason");
      break;
    case "RevisionOpened":
      requireEnum(event.target, ["acceptance"], "event.target");
      requireNonEmptyString(event.reason, "event.reason");
      break;
    case "IndependentTaskDeclared":
      requireSha256(event.intentSha256, "event.intentSha256");
      requireStringArray(event.unreplacedTasks, "event.unreplacedTasks", { nonEmptyItems: true, unique: true });
      break;
    case "TaskSuperseded":
      requireEnum(event.phase, ["prepare", "committed"], "event.phase");
      requirePredecessorShape(event.predecessor, "event.predecessor");
      requireInheritedFindingsShape(event.inheritedFindings, "event.inheritedFindings");
      if (event.phase === "committed") requireSha256(event.prepareEventId, "event.prepareEventId");
      break;
    case "TaskSupersedeCancelled":
      requireSha256(event.cancelledPrepareEventId, "event.cancelledPrepareEventId");
      requireNonEmptyString(event.predecessorTaskDir, "event.predecessorTaskDir");
      requireSha256(event.predecessorTaskJsonSha256, "event.predecessorTaskJsonSha256");
      requireSha256(event.cancelledTaskJsonSha256, "event.cancelledTaskJsonSha256");
      requireSha256(event.cancelledVerdictSha256, "event.cancelledVerdictSha256");
      requireNonEmptyString(event.reason, "event.reason");
      break;
    default:
      break;
  }

  if (record) {
    requirePositiveInteger(event.seq, "event.seq");
    requireNonEmptyString(event.recordedAt, "event.recordedAt");
    if (!Number.isFinite(Date.parse(event.recordedAt))) {
      fail(`event.recordedAt 不是有效时间：${event.recordedAt}。`, "把 recordedAt 修为 ISO 8601 时间，或从 events.jsonl 备份恢复该行后重试。");
    }
    requireSha256(event.eventId, "event.eventId");
    requireSignatureShape(event.signature, "事件记录 signature");
  }
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
    fail(`无法定位证据目录 ${evidenceDir}。`, "重新运行 init 创建 evidence/，或修复任务目录后重试当前命令。");
  }
  if (probed.reason === "outside") {
    fail(`artifact 必须位于任务目录 evidence/ 内：${artifact}。`, `把证据文件放入 ${evidenceDir}，并将 artifact 写为 evidence/<文件名> 后重试。`);
  }
  const candidate = isAbsolute(artifact) ? resolve(artifact) : resolve(taskDir, artifact);
  if (probed.reason === "missing") {
    fail(`artifact 指向的文件不存在或不可读：${artifact}。`, `先创建 ${candidate} 并写入原始证据，再用相同 artifact 重试当前命令。`);
  }
  if (probed.reason === "not-file") {
    fail(`artifact 必须是文件：${artifact}。`, "把 artifact 改为 evidence/ 内的普通文件，而不是目录或其他文件类型后重试。");
  }
  if (probed.reason === "escape") {
    fail(`artifact 的实际路径逃逸出 evidence/：${artifact}。`, "删除指向外部的符号链接，把真实证据文件复制到 evidence/ 内后重试。");
  }
  fail(`artifact 无法使用：${artifact}。`, "把真实证据文件放入 evidence/ 后重试当前命令。");
}

// 已登记 artifact 禁止覆盖写：同名写入即失败，新证据用新文件名（追加前校验）。
// 对账范围（合并稿 §10.3 证据不可覆盖）：全部携带 artifact 的事件，不再只限带
// artifactSha256 的 EvidenceRecorded——四类证据/回执事件（ImplementationRecorded /
// ExplorationCompleted / AssuranceCompleted / RepairRoundRecorded）同样受保护。
// 三道对账：① 既有事件已以不同内容哈希登记同一路径 → 覆盖写，直接拒绝（预防性）；
// ② 既有事件以内容哈希登记过同一路径，本次事件不带哈希 → 拒绝（已登记路径的
// 再引用必须携带一致哈希，防绕过哈希绑定）；③ 本次事件声明的哈希与磁盘现状不一致 →
// 拒绝（防止把已覆盖的文件再登记进事件流）。双方均无哈希的旧形态引用只做磁盘可读
// 校验（validateArtifact 已覆盖），无内容对账依据时放行以兼容旧事件流。
// 可携带 artifactSha256 的事件类型（其余类型引用 artifact 但契约上不绑内容哈希——
// 发现类引用证据文件属常态，防覆盖检查对其不要求携带哈希，其本身也不登记哈希）
const ARTIFACT_HASH_CAPABLE_TYPES = new Set(["EvidenceRecorded", "ImplementationRecorded", "ExplorationCompleted", "AssuranceCompleted", "RepairRoundRecorded"]);

function validateArtifactNotOverwritten(world, event) {
  const artifact = event.artifact;
  const artifactSha256 = Object.hasOwn(event, "artifactSha256") ? event.artifactSha256 : null;
  const filePath = isAbsolute(artifact) ? resolve(artifact) : resolve(world.taskDir, artifact);
  for (const entry of world.entries) {
    const prior = entry.record;
    if (!Object.hasOwn(prior, "artifact")) continue;
    const priorPath = isAbsolute(prior.artifact) ? resolve(prior.artifact) : resolve(world.taskDir, prior.artifact);
    if (priorPath !== filePath) continue;
    if (!Object.hasOwn(prior, "artifactSha256")) continue;
    if (artifactSha256 === null) {
      fail(
        `artifact ${artifact} 已被事件 seq=${prior.seq} 以内容哈希登记，本事件引用同一路径必须携带一致的 artifactSha256。`,
        `重新计算 ${basename(filePath)} 的 sha256 后随事件携带再重试；新证据用新文件名追加新事件。`,
      );
    }
    if (prior.artifactSha256 !== artifactSha256) {
      fail(
        `artifact ${artifact} 已被事件 seq=${prior.seq} 以不同内容哈希登记，拒绝覆盖写（登记 ${prior.artifactSha256.slice(0, 12)}…，本次 ${artifactSha256.slice(0, 12)}…）。`,
        `已登记证据禁止覆盖写——新证据用新文件名（如 ${basename(filePath)} 递增序号）追加新事件后重试。`,
      );
    }
  }
  if (artifactSha256 === null) return;
  const currentSha = sha256File(filePath, `artifact ${artifact}`);
  if (currentSha !== artifactSha256) {
    fail(
      `artifact 内容哈希与事件声明不一致：${artifact}（磁盘 ${currentSha.slice(0, 12)}…，事件 ${artifactSha256.slice(0, 12)}…）。`,
      `重新计算文件 sha256 后重试；已登记证据禁止覆盖写——新证据请用新文件名追加新事件。`,
    );
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
  const text = readText(filePath, "events.jsonl", "重新运行 init 创建缺失的空 events.jsonl；若文件已损坏，从备份恢复后重试。");
  if (text.length === 0) return { entries: [], text };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      fail(`events.jsonl 第 ${index + 1} 行为空。`, "删除空行并保持每条事件占一行，或从备份恢复 events.jsonl 后重试。");
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`events.jsonl 第 ${index + 1} 行不是合法 JSON：${error.message}。`, `修复第 ${index + 1} 行，或从备份恢复 events.jsonl 后重试；不要删除无法识别的事实。`);
    }
    validateEventShape(record, { record: true });
    if (record.seq !== index + 1) {
      fail(`events.jsonl 第 ${index + 1} 行 seq=${record.seq}，预期 ${index + 1}。`, "按现有行序恢复从 1 开始的连续 seq；不要重排事件，修复后重试。");
    }
    const content = eventContent(record);
    const expectedId = computeEventId(content);
    if (record.eventId !== expectedId) {
      fail(`events.jsonl 第 ${index + 1} 行 eventId 与事件内容哈希不一致。`, `从追加时的原始记录恢复第 ${index + 1} 行；若确需更正事件内容，重新计算 eventId 并明确审计该手工修改后重试。`);
    }
    if (!verifyEventSignature(record, keys)) {
      fail(`events.jsonl 第 ${index + 1} 行事件签名验证失败（actor=${record.actor}：签名错误或公钥不匹配）。`, `从追加时的原始记录恢复该行；确需更正事件时，用对应角色凭据（${Object.entries(SIGNING_KEY_NAMES).map(([actor, keyName]) => `actor=${actor} 用 ${keyName}`).join("，")}）重新 append 并审计该手工修改。`);
    }
    entries.push({ record, line: index + 1 });
  }
  return { entries, text };
}

// ── 完整世界：验收包 + 意图 + 策略快照 + 事件流折叠 ──
function loadWorld(taskDirValue, { withEvents = true, requirePackage = true, allowTampered = false } = {}) {
  const core = loadTaskCore(taskDirValue);
  const { taskDir, task, keys } = core;
  const world = {
    taskDir,
    task,
    keys,
    acceptance: null,
    increments: null,
    packageSha256: null,
    intentSha256: null,
    policySnapshot: null,
    policySnapshotSha256: null,
    policy: null,
    entries: [],
    eventsText: "",
    fold: null,
  };

  const intentPath = join(taskDir, "intent.md");
  if (existsSync(intentPath)) world.intentSha256 = sha256File(intentPath, "intent.md");

  const snapshotPath = join(taskDir, "policy-snapshot.json");
  if (existsSync(snapshotPath)) {
    const snapshotText = readText(snapshotPath, "policy-snapshot.json", "重新运行 snapshot-policy 生成快照，或从任务备份恢复后重试。");
    world.policySnapshot = JSON.parse(snapshotText);
    world.policySnapshotSha256 = sha256Text(snapshotText);
  }

  if (requirePackage) {
    const acceptancePath = join(taskDir, "acceptance.json");
    const acceptanceText = readText(
      acceptancePath,
      "acceptance.json",
      "运行 delivery-v5/acceptance-design-v5 生成 acceptance.json，或从任务备份恢复后重试。",
    );
    let acceptance;
    try {
      acceptance = JSON.parse(acceptanceText);
    } catch (error) {
      fail(`acceptance.json 不是合法 JSON：${error.message}。`, `修复 ${acceptancePath} 的 JSON 语法后重试当前命令。`);
    }
    validateAcceptance(acceptance, task);
    const increments = readJson(join(taskDir, "increments.json"), "increments.json");
    validateIncrements(increments, acceptance);
    world.acceptance = acceptance;
    world.increments = increments;
    world.packageSha256 = acceptancePackageSha256(acceptance, increments);
  }

  // 策略：有快照按快照执行（审查/批准/裁决全按快照）；无快照按安装目录+用户级当前值（快照前的阶段）
  const sources = world.policySnapshot ?? loadPolicySources();
  validatePolicySources(sources);
  world.policy = sources;

  if (withEvents) {
    const parsed = parseEventRecords(taskDir, keys);
    world.entries = parsed.entries;
    world.eventsText = parsed.text;
    // 加载折算容忍历史护栏违规（V4 代任务目录可读；违规留档 fold.guardrailWarnings）——
    // 写入路径 appendEvent 的 prospective 折算保持严格（新写入当时被拒）
    world.fold = foldEvents(world, world.entries, { guardrailStrict: false });
    // 篡改检测（V5 写入防护的加载侧）：最近批准绑定的验收包哈希与当前盘上包不一致，且其后
    // 无 RevisionOpened 解封 → 冻结对象被绕过通道改动（chmod 挡不住的写入在此检出；AG-2
    // 类「修复组直改已冻结 increments.json」在写入当秒被 0444 拒，漏网者在此拦下）。
    // allowTampered 仅供 open-revision（合法解冻通道本身不能被检测拦死——鸡生蛋）与
    // 从快照恢复的读取路径使用
    if (world.acceptance !== null && !allowTampered && world.fold.approvals.length > 0) {
      const lastApproval = world.fold.approvals[world.fold.approvals.length - 1];
      const openedAfter = world.fold.revisionOpens.some((event) => event.seq > lastApproval.seq);
      if (lastApproval.acceptancePackageSha256 !== world.packageSha256 && !openedAfter) {
        fail(
          `冻结的验收包被改动：最近批准（seq ${lastApproval.seq}）绑定哈希 ${lastApproval.acceptancePackageSha256.slice(0, 12)}… 与当前盘上包 ${world.packageSha256.slice(0, 12)}… 不一致，且其后无 RevisionOpened 解封记录。`,
          `合法修订走 ${GATE_COMMAND} open-revision --task-dir D --reason "修订理由" --credential <user credentialId> 解封后重新起草并递增 acceptanceVersion；误改则从 frozen/v${lastApproval.acceptanceVersion}/ 快照恢复 acceptance.json 与 increments.json。`,
        );
      }
    }
  }
  return world;
}

function policyRoleMayWrite(policy, actor, eventType) {
  const role = policy["roles.json"].roles.find((entry) => entry.id === actor);
  return role !== undefined && role.mayWrite.includes(eventType);
}

function policyFindingCategory(policy, categoryId) {
  return policy["finding-categories.json"].categories.find((entry) => entry.id === categoryId);
}

function requirementById(acceptance, requirementId) {
  return acceptance.requirements.find((requirement) => requirement.id === requirementId);
}

function coversDimensions(eventDimensions, requiredDimensions) {
  const actual = new Set(eventDimensions);
  return requiredDimensions.every((dimension) => actual.has(dimension));
}

// 逐事件折叠。失效范围（redesign 3.9；V5 代增补见标注）：
//   AcceptanceReviewed/Approved —— 当前版本 + 包哈希 + intent + 快照（verdict 端组合判定）
//   DesignApproved —— 当前版本（方案包哈希清单是声明值，技能③入口门核对）
//   ImplementationRecorded —— 按版本有效、跨 revision 保留
//   EvidenceRecorded / AssuranceCompleted / ExplorationCompleted / FindingResolved / RiskAccepted
//     —— 当前版本 + 当前 revision（revision 过滤在 verdict，fold 只做版本与结构校验）
//   ResolutionReaffirmed（V5 代）—— 当前版本 + 当前 revision（与 FindingResolved 同口径：
//     修复被回退时重认领同样失效，须 assurance 重新核对后再次登记）
//   FindingRaised —— 按版本持久；继承发现同语义且跨版本持久
//   RiskPreauthorized（V5 代）—— 持久事实（授权声明不是证据；名额用量按事件流顺序累计）
//   AssuranceRevisionDrift / RevisionBaselineConfirmed / IndependentTaskDeclared /
//   TaskSuperseded / TaskSupersedeCancelled —— 持久事实
// ── 风险预授权匹配（V5 代）：standing RiskAccepted(finding) 逐条消耗预授权名额 ──
// 名额按事件流顺序贪心分配（一条 standing 接受消耗一条匹配预授权的一个名额），fold 重放
// 可复现。匹配条件：categories 含该 finding 分类、severity 非 blocker（双保险——shape 层
// 已限 maxSeverity=non-blocker）、该预授权本版本已用名额 < maxFindings。
function matchPreauthorization(preauthorizations, usedCounts, category, severity) {
  for (let index = 0; index < preauthorizations.length; index += 1) {
    if (usedCounts[index] >= preauthorizations[index].maxFindings) continue;
    if (severity === "blocker") continue;
    if (!preauthorizations[index].categories.includes(category)) continue;
    return index;
  }
  return -1;
}

function foldEvents(world, entries, { guardrailStrict = true } = {}) {
  const currentVersion = world.acceptance ? world.acceptance.acceptanceVersion : null;
  const fold = {
    reviews: [],
    approvals: [],
    designApprovals: [],
    implementations: [],
    evidence: [],
    findingHistory: [],
    repairs: [],
    // 历史记录的护栏违规留档（guardrailStrict=false 的加载折算不崩溃，逐条记录在此）
    guardrailWarnings: [],
    assurances: [],
    explorations: [],
    findings: new Map(),
    risks: [],
    preauthorizations: [],
    drifts: [],
    baselines: [],
    declarations: [],
    supersedePrepare: null,
    supersedeCommitted: null,
    cancelRecords: [],
    revisionOpens: [],
    missingArtifacts: [],
  };
  // 预授权名额用量（与 fold.preauthorizations 按 index 对齐；每验收版本独立配额）
  const preauthUsedCounts = [];
  const seenEvents = new Map();
  const raisedFindings = new Map();
  const currentIncrementIds = world.increments
    ? new Set(world.increments.items.map((item) => item.id))
    : new Set();

  for (const entry of entries) {
    const event = entry.record;
    const lineLabel = `events.jsonl 第 ${entry.line} 行`;
    const contentKey = canonicalJson(eventContent(event));
    if (seenEvents.has(event.eventId)) {
      if (seenEvents.get(event.eventId) !== contentKey) {
        fail(`${lineLabel} 与先前 eventId 相同但内容不同。`, "从原始备份恢复事件流并重新计算事件哈希后重试；不要复用其他事件的 eventId。");
      }
      continue;
    }
    seenEvents.set(event.eventId, contentKey);
    if (!policyRoleMayWrite(world.policy, event.actor, event.type)) {
      fail(
        `${lineLabel}：角色 ${event.actor} 无权写 ${event.type}（策略 roles.json 未授权）。`,
        `按策略分工由授权角色登记该事件；确需扩展时走策略升级（upgrade-policy）并重新审查与批准。`,
      );
    }
    let artifactUsable = true;
    if (Object.hasOwn(event, "artifact")) {
      const probed = probeArtifact(world.taskDir, event.artifact);
      if (!probed.ok) {
        artifactUsable = false;
        // 只把当前版本的缺失计入 missingArtifacts；历史版本事件的 artifact 缺失属历史噪声，不阻塞当前判定
        if (world.acceptance && event.acceptanceVersion === currentVersion) {
          fold.missingArtifacts.push({ artifact: event.artifact, type: event.type, seq: event.seq });
        }
      } else if (Object.hasOwn(event, "artifactSha256")) {
        // 证据事件绑定的 artifact 内容哈希与磁盘不一致 = 证据不可用（同缺失处理）
        const diskSha = sha256File(
          isAbsolute(event.artifact) ? resolve(event.artifact) : resolve(world.taskDir, event.artifact),
          `artifact ${event.artifact}`,
        );
        if (diskSha !== event.artifactSha256) {
          artifactUsable = false;
          if (world.acceptance && event.acceptanceVersion === currentVersion) {
            fold.missingArtifacts.push({ artifact: event.artifact, type: event.type, seq: event.seq, reason: "hash-mismatch" });
          }
        }
      }
    }
    if (world.acceptance && event.acceptanceVersion > currentVersion) {
      fail(`${lineLabel} 的 acceptanceVersion=${event.acceptanceVersion} 高于当前验收版本 ${currentVersion}。`, "恢复匹配的 acceptance.json/increments.json，或移除误写入的未来版本事件后重试。");
    }
    const current = world.acceptance !== null && event.acceptanceVersion === currentVersion;

    switch (event.type) {
      case "AcceptanceReviewed":
        fold.reviews.push(event);
        break;
      case "AcceptanceApproved":
        fold.approvals.push(event);
        break;
      case "DesignApproved":
        if (current) fold.designApprovals.push(event);
        break;
      case "ImplementationRecorded":
        if (current && artifactUsable) {
          if (!currentIncrementIds.has(event.incrementId)) {
            fail(`${lineLabel} 引用了当前 increments.json 中不存在的增量 ${event.incrementId}。`, "恢复该增量定义，或修正 ImplementationRecorded.incrementId 后重试。");
          }
          fold.implementations.push(event);
        }
        break;
      case "EvidenceRecorded":
        if (current && artifactUsable) {
          const requirement = requirementById(world.acceptance, event.requirementId);
          if (!requirement) {
            fail(`${lineLabel} 引用了未知需求 ${event.requirementId}。`, "把 requirementId 修为当前验收中的需求 id，或恢复被误删的验收条目后重试。");
          }
          if (!requirement.evidenceKinds.includes(event.kind)) {
            fail(`${lineLabel} 的 kind=${event.kind} 未声明于需求 ${event.requirementId}。`, "改用该需求 evidenceKinds 中声明的证据类型，或递增验收版本并更新证据声明后重试。");
          }
          if (world.acceptance.schemaVersion === 2) {
            const knownAssertions = new Set(requirement.assertions.map((assertion) => assertion.id));
            const knownForms = new Set(world.acceptance.adversarialForms.map((form) => form.id));
            if (!Array.isArray(event.assertionIds) || event.assertionIds.length === 0) {
              fail(`${lineLabel} 缺少 assertionIds；schema 2 证据必须明确覆盖断言。`, "由 coverage reviewer 为该证据填写断言 id 后重试。");
            }
            for (const id of event.assertionIds) {
              if (!knownAssertions.has(id)) fail(`${lineLabel} 引用了需求 ${event.requirementId} 之外的断言 ${id}。`, "把 assertionIds 修为该需求已声明的断言后重试。");
            }
            for (const id of event.adversarialFormIds ?? []) {
              if (!knownForms.has(id)) fail(`${lineLabel} 引用了未知反例场景 ${id}。`, "把 adversarialFormIds 修为验收包已声明的场景 id 后重试。");
              const form = world.acceptance.adversarialForms.find((item) => item.id === id);
              if (!event.assertionIds.includes(form.assertionId)) fail(`${lineLabel} 的反例场景 ${id} 与 assertionIds 不匹配。`, "同时列入该场景所属的断言 id 后重试。");
            }
          }
          fold.evidence.push(event);
        }
        break;
      case "AssuranceCompleted":
        if (current && artifactUsable) fold.assurances.push(event);
        break;
      case "ExplorationCompleted":
        if (current && artifactUsable) {
          if (!coversDimensions(event.dimensions, world.acceptance.reviewDimensions)) {
            fail(`${lineLabel} 未完整覆盖 acceptance.reviewDimensions。`, `补齐维度 ${world.acceptance.reviewDimensions.join(", ")} 后重新追加 ExplorationCompleted；允许同时申报验收外额外维度。`);
          }
          fold.explorations.push(event);
        }
        break;
      case "FindingRaised": {
        if (raisedFindings.get(event.findingId) === event.acceptanceVersion) {
          fail(`${lineLabel} 重复分配 findingId=${event.findingId} 且内容不同。`, "为新发现使用新的 F- 格式 id；若这是同一事件，请恢复原事件内容与 eventId 以实现幂等。");
        }
        if (policyFindingCategory(world.policy, event.category) === undefined) {
          fail(`${lineLabel} 的 category=${event.category} 不在策略 finding-categories.json 词表内。`, "使用策略登记的分类；新增分类走策略升级（upgrade-policy）。");
        }
        if (current) {
          for (const requirementId of event.requirementIds) {
            if (!requirementById(world.acceptance, requirementId)) {
              fail(`${lineLabel} 的 finding 引用了未知需求 ${requirementId}。`, "把 requirementIds 修为当前验收中的需求 id，或恢复验收条目后重试。");
            }
          }
        }
        if (event.reopenOf !== undefined) {
          if (!raisedFindings.has(event.reopenOf)) fail(`${lineLabel} 的 reopenOf=${event.reopenOf} 指向不存在的旧 finding。`, "先登记原 finding，再使用 reopenOf 关联；新问题删除 reopenOf 后重试。");
          if (event.reopenOf === event.findingId) fail(`${lineLabel} 的 reopenOf 不能等于 findingId。`, "引用此前不同的 finding id 后重试。");
        }
        if (current && world.acceptance.schemaVersion === 2 && event.severity === "non-blocker") {
          requireNonEmptyString(event.consequenceRefutation, `${lineLabel}.consequenceRefutation`);
          // 三类论证居其一（合并稿 §9）：不只非空，必须显式声明类型（shape 层已限枚举）
          if (!Object.hasOwn(event, "consequenceRefutationType")) {
            fail(`${lineLabel} 缺少 consequenceRefutationType（行为后果否证论证必须声明三类之一）。`, `为该 non-blocker 附 consequenceRefutationType（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许）后重试。`);
          }
        }
        // 护栏①（V5 定级护栏）：boundary 禁令——关联需求已有断言级判据明文覆盖的行为，
        // 禁止归 boundary 类（V4 实跑实证：违反判据 AX5 明文的发现被定 boundary 绕过
        // must-fix 计数与接受判定——LLM 语义输出不得直接改写机器判据）。
        // 仅对新写入执行：历史（V4 代）记录在加载折算时降级为 fold.guardrailWarnings
        // 留档（加载不得因历史违规崩溃——next/replay/统计要能读旧任务目录）
        if (
          KERNEL_RULES.guardrails.boundaryBanOnAssertedRequirements &&
          current && world.acceptance.schemaVersion === 2 && event.category === "boundary"
        ) {
          const onAsserted = event.requirementIds.some((requirementId) => {
            const requirement = requirementById(world.acceptance, requirementId);
            return requirement !== undefined && Array.isArray(requirement.assertions) && requirement.assertions.length > 0;
          });
          if (onAsserted) {
            const message = `${lineLabel} 的 category=boundary 但关联需求已有断言级判据明文覆盖（schema 2 assertions）——有断言覆盖的行为不得申报为边界。`;
            if (guardrailStrict) {
              fail(message, `改为 category=defect（按实际严重度定级），或从 requirementIds 移除已有断言覆盖的需求并附对照论证后重试。`);
            }
            fold.guardrailWarnings.push(`${message}（历史记录，写入时未拦）`);
          }
        }
        // 护栏③（V5 定级护栏）：定级改判熔断——同一条目（reopenOf 根）累计 (category,severity)
        // 组合数超过上限即拒绝（改判必须停回用户裁决，不允许多次无声改写收敛与停机判据）
        if (KERNEL_RULES.guardrails.regradeHaltEnabled) {
          const { halt, offenders } = findingRegrades([...fold.findingHistory, event]);
          if (offenders.length > 0) {
            const message = `${lineLabel} 使条目 ${offenders.map((item) => item.root).join(", ")} 的定级组合数超过 ${halt} 种（${offenders.map((item) => item.grades.join("/")).join("；")}）——定级反复改写触发熔断。`;
            if (guardrailStrict) {
              fail(message, `停回用户裁决定级：由用户确定最终 (category, severity) 后按裁决登记；或走 accept-risk 风险通道，不再改判。`);
            }
            fold.guardrailWarnings.push(`${message}（历史记录，写入时未拦）`);
          }
        }
        raisedFindings.set(event.findingId, event.acceptanceVersion);
        fold.findingHistory.push(event);
        if (current) fold.findings.set(event.findingId, { raised: event, resolutions: [], reaffirmations: [], inherited: false });
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
      case "ResolutionReaffirmed": {
        if (!raisedFindings.has(event.findingId)) {
          fail(`${lineLabel} 试图重认领尚未出现的 finding ${event.findingId}。`, `先追加对应 FindingRaised；若 id 写错，修正 ${event.findingId} 后重试。`);
        }
        const finding = fold.findings.get(event.findingId);
        if (current && finding) {
          // 重认领必须锚定该 finding 在本版本内的既有 resolution——防凭空 resolve
          //（跨版本的 resolution 不是重认领依据：验收版本递增后应重新 FindingResolved）
          const origin = finding.resolutions.find((resolution) => resolution.eventId === event.originalResolutionEventId);
          if (!origin) {
            fail(
              `${lineLabel} 的 originalResolutionEventId 不指向 finding ${event.findingId} 在本版本内的 FindingResolved。`,
              `以 evaluate 输出的 reaffirmableFindings[].originalResolutionEventIds 中的值重试；该 finding 从未在本版本内 resolved 时走 FindingResolved 而非重认领。`,
            );
          }
          finding.reaffirmations.push(event);
        }
        break;
      }
      case "RepairRoundRecorded":
        for (const findingId of event.triggerFindingIds) {
          if (!raisedFindings.has(findingId)) fail(`${lineLabel} 的 triggerFindingIds 含未登记 finding ${findingId}。`, "先登记 FindingRaised，再记录修复轮次。");
        }
        if (current && world.acceptance.schemaVersion === 2) {
          const knownAssertions = new Set(world.acceptance.requirements.flatMap((requirement) => requirement.assertions.map((assertion) => assertion.id)));
          for (const id of event.affectedAssertionIds) {
            if (!knownAssertions.has(id)) fail(`${lineLabel} 的 affectedAssertionIds 含未知断言 ${id}。`, "只填写当前验收包已声明的断言 id 后重试。");
          }
          // 每轮修复的全量确定性测试回执（合并稿 §11.1）：受控修复轮（带 fromRevision/
          // toRevision 溯源）在 schema 2 下必须附带且回执覆盖全部增量；上限熔断轮
          //（无修复发生）与旧事件流不要求
          const controlledRepairRound = Object.hasOwn(event, "fromRevision") && Object.hasOwn(event, "toRevision");
          if (controlledRepairRound) {
            if (!Array.isArray(event.incrementReceipts) || event.incrementReceipts.length === 0) {
              fail(
                `${lineLabel} 缺少 incrementReceipts（schema 2 受控修复轮必须附带全量确定性测试回执）。`,
                "由 assurance-repair-loop-v5 引擎在修复提交后重跑全部增量 testCommand，随 RepairRoundRecorded 逐条登记回执后重试。",
              );
            }
            const receiptIncrementIds = new Set(event.incrementReceipts.map((receipt) => receipt.incrementId));
            const missingReceipts = currentIncrementIds.size > 0
              ? [...currentIncrementIds].filter((id) => !receiptIncrementIds.has(id))
              : [];
            if (missingReceipts.length > 0) {
              fail(
                `${lineLabel} 的 incrementReceipts 未覆盖全部增量（缺 ${missingReceipts.join(", ")}）。`,
                "重跑全部增量 testCommand 并逐条登记回执后重试；修复轮回执必须与 AssuranceCompleted 同口径覆盖全部增量。",
              );
            }
          }
        }
        fold.repairs.push(event);
        break;
      case "RiskPreauthorized":
        // 持久事实，不按版本/revision 过滤；shape 层已强制 user-explicit 与 non-blocker 上限
        fold.preauthorizations.push(event);
        preauthUsedCounts.push(0);
        break;
      case "AssuranceRevisionDrift":
        fold.drifts.push(event);
        break;
      case "RevisionBaselineConfirmed":
        fold.baselines.push(event);
        break;
      case "RevisionOpened":
        fold.revisionOpens.push(event);
        break;
      case "IndependentTaskDeclared":
        fold.declarations.push(event);
        break;
      case "TaskSuperseded":
        if (event.phase === "prepare") {
          if (fold.supersedePrepare !== null) {
            fail(`${lineLabel} 重复登记 TaskSuperseded(prepare)。`, "同一任务只允许一个 prepare 序列（取消后可由恢复任务重新发起）；恢复事件流后重试。");
          }
          fold.supersedePrepare = event;
          // 继承发现折叠：跨版本持久参与判定（与 FindingRaised 的版本语义一致，且不因新版本消失）
          for (const inherited of event.inheritedFindings) {
            if (fold.findings.has(inherited.findingId)) {
              fail(`${lineLabel} 继承的 findingId ${inherited.findingId} 与本地登记冲突。`, "继承发现沿用前任 findingId；本地新发现请用新 id。");
            }
            if (policyFindingCategory(world.policy, inherited.category) === undefined) {
              fail(`${lineLabel} 继承发现的 category=${inherited.category} 不在策略 finding-categories.json 词表内。`, "使用策略登记的分类；新增分类走策略升级（upgrade-policy）。");
            }
            fold.findings.set(inherited.findingId, {
              raised: {
                type: "FindingRaised",
                actor: "assurance",
                acceptanceVersion: event.acceptanceVersion,
                revision: event.revision,
                summary: `继承自前任任务（prepare ${event.eventId.slice(0, 12)}…）`,
                findingId: inherited.findingId,
                category: inherited.category,
                severity: inherited.severity,
                requirementIds: [...inherited.requirementIds],
                artifact: `evidence/inherited-${inherited.findingId}.md`,
              },
              resolutions: [],
              reaffirmations: [],
              inherited: true,
            });
            // 继承发现与本地 FindingRaised 同语义（state-and-events.md）——同步登记
            // raisedFindings，否则 FindingResolved / ResolutionReaffirmed / reopenOf /
            // RepairRoundRecorded.triggerFindingIds 的存在性校验会拒绝继承 id，
            // 继承 blocker 除用户接受风险外无任何机器合法出口（修复死路）
            raisedFindings.set(inherited.findingId, event.acceptanceVersion);
          }
        } else {
          if (fold.supersedeCommitted !== null) {
            fail(`${lineLabel} 重复登记 TaskSuperseded(committed)。`, "committed 只登记一次；恢复事件流后重试。");
          }
          fold.supersedeCommitted = event;
        }
        break;
      case "TaskSupersedeCancelled":
        fold.cancelRecords.push(event);
        break;
      case "RiskAccepted": {
        if (current) {
          if (event.targetType === "requirement") {
            const requirement = requirementById(world.acceptance, event.targetId);
            if (!requirement) {
              fail(`${lineLabel} 的风险接受指向未知需求 ${event.targetId}。`, "把 targetId 修为当前验收中的需求 id 后重试 accept-risk。");
            }
            if (!requirement.riskAcceptable) {
              fail(`需求 ${event.targetId} 的 riskAcceptable=false，拒绝风险接受。`, "不要追加该 RiskAccepted；补充验证或递增验收版本并由用户重新裁决风险策略。");
            }
          } else {
            const finding = fold.findings.get(event.targetId);
            if (!finding) {
              fail(`${lineLabel} 的风险接受指向当前版本中不存在的 finding ${event.targetId}。`, "先追加当前版本的 FindingRaised，并确认 targetId 与 findingId 完全一致后重试。");
            }
            const categoryPolicy = policyFindingCategory(world.policy, finding.raised.category);
            if (categoryPolicy !== undefined && categoryPolicy.riskAcceptAllowed === false) {
              fail(`finding ${event.targetId} 所属分类 ${finding.raised.category} 不允许风险接受（策略 riskAcceptAllowed=false）。`, `该类发现的出路是 assurance 对照论证后 FindingResolved 确认，或递增验收版本缩减判据。`);
            }
            if (finding.raised.severity === "blocker" && finding.raised.requirementIds.length === 0) {
              // 无关联需求的 blocker：策略上仍允许用户显式接受（关联需求全 strict 时由下一分支拦截）
            }
            for (const requirementId of finding.raised.requirementIds) {
              const requirement = requirementById(world.acceptance, requirementId);
              if (requirement && !requirement.riskAcceptable) {
                fail(`finding ${event.targetId} 关联的需求 ${requirementId} 不允许接受风险。`, "不要接受该 finding 风险；修复问题并追加 FindingResolved，或递增验收版本重新裁决风险策略。");
              }
            }
            // V5 代：standing-authorization 的风险接受必须落在预授权范围内（名额按事件流
            // 顺序贪心消耗；版本递增后旧消耗不再计数——每个验收版本独立配额）
            if (event.confirmation === "standing-authorization") {
              const matched = matchPreauthorization(
                fold.preauthorizations,
                preauthUsedCounts,
                finding.raised.category,
                finding.raised.severity,
              );
              if (matched < 0) {
                fail(
                  `finding ${event.targetId} 的 standing 风险接受无预授权覆盖（类别 ${finding.raised.category}、severity ${finding.raised.severity} 或名额已耗尽）。`,
                  `由用户执行 ${GATE_COMMAND} preauthorize-risk 追加覆盖范围或名额后重试；或该 finding 改用 --confirmation user-explicit 由用户亲自接受。`,
                );
              }
              preauthUsedCounts[matched] += 1;
            }
          }
          fold.risks.push(event);
        }
        break;
      }
      case "PolicyUpgraded":
        // 持久事实；失效范围由事件自身声明，策略执行仍按快照
        break;
      default:
        break;
    }
  }
  return fold;
}

// ── 缺口 id 派生（redesign 3.7）：完全缺失 = 确定性派生；partial/failed = 绑对应证据事件 id ──
function missingGapId(acceptanceVersion, requirementId, evidenceKind, revision) {
  return sha256Text(
    canonicalJson({ acceptanceVersion, requirementId, evidenceKind, revision, missing: "missing" }),
  );
}

// ── 漂移链（redesign 3.9）：链式衔接 + 基线后计数 + 预期修复豁免 + 失败保证 ──
// validAssurances = 有效性校验通过的 AssuranceCompleted（绑定完整、回执全绿）；
// 只有这些事件使链归零——回执无效的完成事件不清零漂移链（链长不被低估）
function computeDriftChain(fold, revision, implementations, maxDriftChain, validAssurances) {
  const baselineSeq = fold.baselines.length > 0
    ? Math.max(...fold.baselines.map((event) => event.seq))
    : 0;
  const drifts = [...fold.drifts].sort((left, right) => left.seq - right.seq)
    .filter((event) => event.seq > baselineSeq);
  // 有效性校验通过的 AssuranceCompleted 使链归零：只统计最近一次有效保证完成之后的漂移
  const assuranceSeqs = validAssurances.map((event) => event.seq);
  const lastAssuranceSeq = assuranceSeqs.length > 0 ? Math.max(...assuranceSeqs) : 0;
  const effectiveDrifts = drifts.filter((event) => event.seq > lastAssuranceSeq);
  let chainLength = 0;
  if (effectiveDrifts.length > 0) {
    const latest = effectiveDrifts[effectiveDrifts.length - 1];
    if (latest.finalizeRevision === revision) {
      chainLength = 1;
      for (let index = effectiveDrifts.length - 2; index >= 0; index -= 1) {
        if (effectiveDrifts[index].finalizeRevision === effectiveDrifts[index + 1].setupRevision) {
          chainLength += 1;
        } else {
          break;
        }
      }
    }
  }
  // 预期修复豁免：当前 revision 恰为最新实现事件指纹（builder 合并后的稳定状态）→ 漂移不计
  const lastImplementation = implementations.length > 0
    ? implementations[implementations.length - 1]
    : null;
  const expectedFix = lastImplementation !== null && lastImplementation.mergeReceipt.toRevision === revision;
  // 失败保证：当前 revision 超出最新实现事件指纹（受验树又被外部改动），按 (实现事件, revision) 去重只计一次
  const failedGuarantee = lastImplementation !== null && !expectedFix && chainLength === 0 ? 1 : 0;
  const effective = expectedFix ? 0 : chainLength + failedGuarantee;
  return {
    chainLength,
    failedGuarantee,
    effective,
    unstable: effective > maxDriftChain,
    sinceBaselineSeq: baselineSeq,
  };
}

function requirementEvidenceStatus(kindEntries) {
  const results = kindEntries.map((entry) => entry.result);
  if (results.length > 0 && results.every((result) => result === "verified")) return "verified";
  if (results.includes("failed")) return "failed";
  if (results.includes("partial")) return "partial";
  return "missing";
}

// ── 交付判定（redesign 3.7 完整判定式 + 3.9 失效范围）──
function buildVerdict(world, revision, revisionSource = "computed") {
  requireNonEmptyString(revision, "--revision");
  const { acceptance, fold } = world;
  const currentVersion = acceptance.acceptanceVersion;
  const currentRevision = (event) => event.revision === revision;

  // 批准有效性四元组：版本 + 验收包哈希 + intent 哈希 + 策略快照哈希；绑定的审查必须通过且未被后续打回收回。
  // 策略 requireAcceptanceReview=false 时允许 reviewEventId="none" 的免审查批准（verdict-rules L2 开关）
  const rules = world.policy["verdict-rules.json"];
  const acceptanceReviewOptional = rules.requireAcceptanceReview === false;
  const reviewById = new Map(fold.reviews.map((event) => [event.eventId, event]));
  const matchingReviews = fold.reviews.filter(
    (event) =>
      event.acceptanceVersion === currentVersion &&
      event.acceptancePackageSha256 === world.packageSha256 &&
      event.intentSha256 === world.intentSha256 &&
      event.policySnapshotSha256 === world.policySnapshotSha256,
  );
  const approval = fold.approvals.find((event) => {
    if (
      event.acceptanceVersion !== currentVersion ||
      event.acceptancePackageSha256 !== world.packageSha256 ||
      event.intentSha256 !== world.intentSha256 ||
      event.policySnapshotSha256 !== world.policySnapshotSha256
    ) return false;
    if (event.reviewEventId === "none") return acceptanceReviewOptional;
    const review = reviewById.get(event.reviewEventId);
    if (!review || review.conclusion !== "pass") return false;
    // 同组合下后发的打回审查使旧通过失效
    const laterReject = matchingReviews.some(
      (candidate) => candidate.conclusion === "reject" && candidate.seq > review.seq,
    );
    return !laterReject;
  });
  const approved = approval !== undefined;
  const designApproved = fold.designApprovals.length > 0;

  // 增量实现：按版本有效、跨 revision 保留
  const implemented = new Set(fold.implementations.map((event) => event.incrementId));
  const implementedIncrementIds = world.increments.items
    .filter((item) => implemented.has(item.id))
    .map((item) => item.id);
  const missingIncrementIds = world.increments.items.filter((item) => !implemented.has(item.id)).map((item) => item.id);

  // 证据：当前 revision；schema 1 按需求×类型，schema 2 按断言×类型。
  const usesAssertions = acceptance.schemaVersion === 2;
  const latestEvidence = new Map();
  const latestAssertionEvidence = new Map();
  for (const event of fold.evidence) {
    if (!currentRevision(event)) continue;
    latestEvidence.set(`${event.requirementId}\0${event.kind}`, event);
    for (const assertionId of event.assertionIds ?? []) latestAssertionEvidence.set(`${assertionId}\0${event.kind}`, event);
  }

  // 发现状态：defect 未决阻 accepted；boundary 未经确认阻 accepted。
  // open 集判定走内核单源（kernel-judgments.openFindingsFromEvents——V4 此处为折叠内联实现、
  // 与 assurance-repair-loop / independent-assurance 两处复刻三份并存，口径靠注释同步；现收敛
  // 为一份，折叠结构仅用于 origin/expectedStage 等归因字段富化）
  const kernelOpen = openFindingsFromEvents(world.entries.map((entry) => entry.record), {
    revision,
    acceptanceVersion: currentVersion,
  });
  const openFindingEntries = [...fold.findings.values()].filter((finding) =>
    kernelOpen.openIds.has(finding.raised.findingId),
  );
  const openFindings = openFindingEntries
    .map((finding) => ({
      findingId: finding.raised.findingId,
      category: finding.raised.category,
      severity: finding.raised.severity,
      requirementIds: [...finding.raised.requirementIds],
      inherited: finding.inherited,
      artifact: finding.raised.artifact,
      // 归因透传（nextAction process-failed 指引按 origin/expectedStage 回阶段归因，
      // 主 agent 只读 verdict 时必须能拿到被指引使用的数据；未填输出 null）
      origin: finding.raised.origin ?? null,
      firstDetectedStage: finding.raised.firstDetectedStage ?? null,
      expectedStage: finding.raised.expectedStage ?? null,
      regressionTestRef: finding.raised.regressionTestRef ?? null,
      riskAccepted: false,
    }));
  const reaffirmableFindings = openFindingEntries
    .filter((finding) => finding.resolutions.length > 0)
    .map((finding) => ({
      findingId: finding.raised.findingId,
      category: finding.raised.category,
      severity: finding.raised.severity,
      requirementIds: [...finding.raised.requirementIds],
      originalResolutionEventIds: finding.resolutions.map((resolution) => resolution.eventId),
      lastResolvedRevision: finding.resolutions[finding.resolutions.length - 1].revision,
    }));
  const findingRiskById = new Map(
    fold.risks
      .filter((event) => currentRevision(event) && event.targetType === "finding")
      .map((event) => [event.targetId, event]),
  );
  for (const open of openFindings) open.riskAccepted = findingRiskById.has(open.findingId);

  // 保证完成：full 必须引用当前 revision 探索；recheck 可引用同验收版本的历史探索，
  // 但必须有当前 revision 的定向覆盖报告与全量确定性测试回执。full-first 门禁：recheck
  // 只有在同验收版本（fold.assurances 只收当前版本）存在序号更早、登记时点合格的 full
  // 时才算有效保证——首次完整保证不可被定向复核替代（explore-only 只产生
  // ExplorationCompleted，不构成保证事件）。
  const currentEvidenceIds = new Set(fold.evidence.filter(currentRevision).map((event) => event.eventId));
  const currentExplorationIds = new Set(fold.explorations.filter(currentRevision).map((event) => event.eventId));
  const allExplorationIds = new Set(fold.explorations.map((event) => event.eventId));
  const allIncrementIds = world.increments.items.map((item) => item.id);
  const requiresCleanBuild =
    world.policy["revision.json"].runsFromIgnoredArtifacts === true &&
    (world.policy["revision.json"].mode ?? "auto-git") !== "content-manifest";
  // 探索需求判定（合并稿 §6）：schema 2 按「缺候选探索证据/验收或关键设计变化」触发，
  // 不由 exploratoryReview 风险字段门控（该词表仅保留为高风险披露要求）；schema 1 保持原语义
  const lastChangeSeqBefore = (seq) => Math.max(
    0,
    ...fold.approvals.filter((event) => event.seq < seq).map((event) => event.seq),
    ...fold.designApprovals.filter((event) => event.seq < seq).map((event) => event.seq),
  );
  const explorationDueAt = (seq) => {
    const explorationsBefore = fold.explorations.filter((event) => event.seq < seq);
    if (explorationsBefore.length === 0) return true;
    return lastChangeSeqBefore(seq) > Math.max(...explorationsBefore.map((event) => event.seq));
  };
  const assuranceBaseValid = (event) => {
    const covered = new Set(event.incrementReceipts.map((receipt) => receipt.incrementId));
    if (!allIncrementIds.every((id) => covered.has(id))) return false;
    if (!event.incrementReceipts.every((receipt) => receipt.exitCode === 0)) return false;
    if (!event.evidenceEventIds.every((id) => currentEvidenceIds.has(id))) return false;
    const mode = event.mode ?? "full";
    if (mode === "full") {
      const needsFreshExploration = usesAssertions ? explorationDueAt(event.seq) : acceptance.exploratoryReview === "required";
      if (needsFreshExploration) {
        // 验收或关键设计变化后缺少新探索：full 必须引用晚于最后一次变化登记的当前
        // revision 探索（版本递增不改 revision——同 revision 的旧探索不覆盖新判据）
        const changeSeq = lastChangeSeqBefore(event.seq);
        const freshExplorationIds = new Set(
          fold.explorations
            .filter((exploration) => exploration.seq < event.seq && exploration.seq > changeSeq && currentRevision(exploration))
            .map((exploration) => exploration.eventId),
        );
        if (!freshExplorationIds.has(event.explorationEventId)) return false;
      } else if (usesAssertions) {
        // 候选探索已存在且验收/设计未变化：full 引用既有探索作为证据来源（不允许 none）
        if (!allExplorationIds.has(event.explorationEventId)) return false;
      } else if (event.explorationEventId !== "none" && !allExplorationIds.has(event.explorationEventId)) {
        return false;
      }
    } else if (usesAssertions
      ? // recheck 必须引用既有探索（合并稿 §6：recheck 引用已有探索结果并记录定向复核依据）——
        // schema 2 全部任务都有候选探索证据，"none" 会把定向复核降级成无探索依据的复核
        !allExplorationIds.has(event.explorationEventId)
      : acceptance.exploratoryReview === "required" && !allExplorationIds.has(event.explorationEventId)) {
      return false;
    }
    if (requiresCleanBuild) {
      if (event.cleanBuild === null) return false;
      if (!event.incrementReceipts.every((receipt) => receipt.buildId === event.cleanBuild.buildId)) return false;
    }
    return true;
  };
  // full-first 的「先前 full」按登记时点完整性判定（同验收版本内任意 revision）：
  // receipts 覆盖全部增量 + 证据事件可解析（artifact 失效的不算）+ 探索引用存在——
  // 不查回执红绿（红 = full 发现了缺陷，属正常修复链起点，绿留给验收判定与 recheck
  // 自身的全量回执）；也不要求其证据仍在当前 revision（修复后旧证据按 currentRevision
  // 失效是既有语义，recheck 自身补齐当前 revision 的全量证据）
  const knownEvidenceIds = new Set(fold.evidence.map((event) => event.eventId));
  const priorFullQualified = (event) => {
    const covered = new Set(event.incrementReceipts.map((receipt) => receipt.incrementId));
    const explorationRefOk = usesAssertions
      ? allExplorationIds.has(event.explorationEventId)
      : (acceptance.exploratoryReview !== "required" || allExplorationIds.has(event.explorationEventId));
    return (
      allIncrementIds.every((id) => covered.has(id)) &&
      event.evidenceEventIds.every((id) => id === "none" || knownEvidenceIds.has(id)) &&
      explorationRefOk
    );
  };
  const hasPriorValidFull = (event) =>
    fold.assurances.some((full) => (full.mode ?? "full") === "full" && full.seq < event.seq && priorFullQualified(full));
  const assuranceValid = fold.assurances.filter(
    (event) => currentRevision(event) && assuranceBaseValid(event) && ((event.mode ?? "full") !== "recheck" || hasPriorValidFull(event)),
  );
  // recheck 因缺先前有效 full 被拒的披露（missing.assuranceFullFirst）——可操作的
  // 恢复指引：先跑 full，recheck 只作修复后定向复核
  const recheckWithoutFull = fold.assurances.filter(
    (event) => currentRevision(event) && (event.mode ?? "full") === "recheck" && assuranceBaseValid(event) && !hasPriorValidFull(event),
  );
  const assuranceCompleted = assuranceValid.length > 0;
  const explorationCompleted = fold.explorations.length > 0;
  // schema 2：有效保证成立即满足（full 的探索引用已在 assuranceBaseValid 按 due 判定校验）；
  // schema 1：保持 exploratoryReview 词表语义（required 时须有探索）
  const explorationSatisfied = usesAssertions
    ? assuranceCompleted
    : acceptance.exploratoryReview !== "required" || assuranceCompleted;

  const requirementRiskByGap = new Map(
    fold.risks
      .filter((event) => currentRevision(event) && event.targetType === "requirement")
      .map((event) => [event.gapId, event]),
  );
  const missingAssertionIds = [];
  const requirements = acceptance.requirements.map((requirement) => {
    let assertionResults = null;
    if (usesAssertions) {
      assertionResults = requirement.assertions.map((assertion) => {
        const evidence = requirement.evidenceKinds.map((kind) => {
          const event = latestAssertionEvidence.get(`${assertion.id}\0${kind}`);
          const result = event ? event.result : "missing";
          const gapId = result === "verified" ? null : missingGapId(currentVersion, assertion.id, kind, revision);
          if (result !== "verified") missingAssertionIds.push({ assertionId: assertion.id, requirementId: requirement.id, kind, result, gapId });
          return {
            kind,
            result,
            eventId: event ? event.eventId : null,
            artifact: event ? event.artifact : null,
            gapId,
            riskAccepted: false,
          };
        });
        return { id: assertion.id, status: requirementEvidenceStatus(evidence), evidence };
      });
    }
    const kindEntries = requirement.evidenceKinds.map((kind) => {
      if (usesAssertions) {
        const result = requirementEvidenceStatus(assertionResults.map((assertion) => assertion.evidence.find((entry) => entry.kind === kind)));
        const gapId = result === "verified" ? null : missingGapId(currentVersion, requirement.id, kind, revision);
        return { kind, result, eventId: null, artifact: null, gapId, riskAccepted: requirementRiskByGap.has(gapId) };
      }
      const event = latestEvidence.get(`${requirement.id}\0${kind}`);
      if (event) {
        return {
          kind,
          result: event.result,
          eventId: event.eventId,
          artifact: event.artifact,
          gapId: event.result === "verified" ? null : event.eventId,
          riskAccepted: event.result !== "verified" && requirementRiskByGap.has(event.eventId),
        };
      }
      const gapId = missingGapId(currentVersion, requirement.id, kind, revision);
      return { kind, result: "missing", eventId: null, artifact: null, gapId, riskAccepted: requirementRiskByGap.has(gapId) };
    });
    const output = {
      id: requirement.id,
      required: requirement.required,
      riskAcceptable: requirement.riskAcceptable,
      status: requirementEvidenceStatus(kindEntries),
      evidence: kindEntries,
    };
    if (usesAssertions) output.assertions = assertionResults;
    return output;
  });

  const maxDriftChain = world.policy["verdict-rules.json"].maxDriftChain ?? 2;
  const drift = computeDriftChain(fold, revision, fold.implementations, maxDriftChain, assuranceValid);

  // 完整证据清单哈希（redesign 3.7：verdict 含完整证据清单哈希）：本轮参与判定的证据事件
  // （当前版本+当前 revision、同需求×类型最后一条）的 eventId + artifactSha256 清单 canonicalJson 哈希
  const evidenceManifest = (usesAssertions ? [...latestAssertionEvidence.values()] : [...latestEvidence.values()])
    .sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0))
    .map((event) => ({ eventId: event.eventId, artifactSha256: event.artifactSha256 }));
  const evidenceManifestSha256 = sha256Text(canonicalJson(evidenceManifest));

  const findingById = new Map(fold.findingHistory.map((event) => [event.findingId, event]));
  for (const finding of fold.findings.values()) {
    if (finding.inherited && !findingById.has(finding.raised.findingId)) findingById.set(finding.raised.findingId, finding.raised);
  }
  const rootFindingId = (findingId, seen = new Set()) => {
    if (seen.has(findingId)) fail(`finding 的 reopenOf 形成循环：${findingId}。`, "修正 reopenOf 链，使其指向不再重开的原始 finding 后重试。");
    const event = findingById.get(findingId);
    if (!event || event.reopenOf === undefined) return findingId;
    seen.add(findingId);
    return rootFindingId(event.reopenOf, seen);
  };
  const uniqueMustFix = new Set(
    [...findingById.values()]
      .filter((event) => event.category === "defect" && event.severity === "blocker")
      .map((event) => rootFindingId(event.findingId)),
  );
  // 计轮与预算走内核单源（kernel-judgments.repairBudgetFromEvents）。perVersion 口径不变：
  // behavior 性质的 RepairRoundRecorded + 同任务内首次 AssuranceCompleted 之后的
  // DesignApproved（方案修订）与 AcceptanceApproved（验收版本递增）各按一轮并入——否则
  // 方案/验收修订路径绕过 3 轮上限（nature=environment/evidence 不计轮）。
  // V5 新增跨 run 保证预算：保证 run 次数（AssuranceCompleted）+ perVersion 轮数超过
  // assuranceCrossRunCap 同样进入 process-failed——跨 run「重取证→新发现→再修复」循环
  // 失控（V4 实跑双场实证：失控场输出为交付物的 3.73 倍）由此获得机器上界
  const budget = repairBudgetFromEvents(world.entries.map((entry) => entry.record));
  const repairRounds = budget.perVersionUsed;
  // breakdown 展示拆分（判定已收敛进内核；此处仅为 verdict 展示分别列出两类修订数）
  const firstAssuranceEntry = world.entries.find((entry) => entry.record.type === "AssuranceCompleted");
  const firstAssuranceSeq = firstAssuranceEntry !== undefined ? firstAssuranceEntry.record.seq : null;
  const postAssuranceDesignRevisions = firstAssuranceSeq === null ? 0 : world.entries.filter(
    (entry) => entry.record.seq > firstAssuranceSeq && entry.record.type === "DesignApproved",
  ).length;
  const postAssuranceAcceptanceRevisions = firstAssuranceSeq === null ? 0 : world.entries.filter(
    (entry) => entry.record.seq > firstAssuranceSeq && entry.record.type === "AcceptanceApproved",
  ).length;
  const budgetsBlock = {
    repairPerVersion: { used: budget.perVersionUsed, cap: budget.perVersionCap, remaining: budget.perVersionRemaining },
    assuranceCrossRun: { used: budget.crossRunUsed, cap: budget.crossRunCap, remaining: budget.crossRunRemaining },
    uniqueMustFix: { count: uniqueMustFix.size, cap: KERNEL_RULES.budgets.uniqueMustFixCap },
  };
  const processFailed =
    uniqueMustFix.size > KERNEL_RULES.budgets.uniqueMustFixCap ||
    budget.perVersionUsed > budget.perVersionCap ||
    budget.crossRunExceeded;
  // 循环外实现性修复呈报（不硬拦，显式披露不静默）：同验收版本最后一次保证之后
  // revision 前进，且其间无 RepairRoundRecorded（受控修复循环）、无新增
  // ImplementationRecorded（candidate-build 补增量）、无 AssuranceRevisionDrift（保证
  // 期间漂移登记）——revision 变化无任何登记通道 = 疑似绕过修复循环直接改实现（主会话
  // 裸提交或外部写入）。主 agent 读到该披露后：属真实旁路修复 → 回 assurance-repair-loop-v5
  // 走受控通道；属无关临时产物 → 清理后重新取证
  const lastAssurance = fold.assurances.length > 0 ? fold.assurances[fold.assurances.length - 1] : null;
  const offLoopRepair =
    lastAssurance !== null &&
    lastAssurance.revision !== revision &&
    !fold.repairs.some((event) => event.seq > lastAssurance.seq) &&
    !fold.implementations.some((event) => event.seq > lastAssurance.seq) &&
    !fold.drifts.some((event) => event.seq > lastAssurance.seq);

  // ── 两个终态的完整判定式 ──
  const evidenceGaps = [];
  for (const requirement of requirements) {
    if (!requirement.required) continue;
    for (const evidence of requirement.evidence) {
      if (evidence.result !== "verified") {
        evidenceGaps.push({ requirementId: requirement.id, kind: evidence.kind, result: evidence.result, gapId: evidence.gapId });
      }
    }
  }
  const unacceptedEvidenceGaps = evidenceGaps.filter((gap) => {
    const requirement = requirements.find((entry) => entry.id === gap.requirementId);
    const entry = requirement.evidence.find((item) => item.kind === gap.kind);
    return !entry.riskAccepted;
  });
  // 发现阻塞语义按策略分类实例化（finding-categories L2）：
  //   blocksAccepted=true → defect 位（修复或用户接受风险后放行，默认 defect 分类）
  //   blocksAccepted="until-confirmed" → boundary 位（确认前阻塞且不可接受，默认 boundary 分类）
  //   blocksAccepted=false → 不阻 accepted
  const openDefects = openFindings.filter(
    (finding) => policyFindingCategory(world.policy, finding.category)?.blocksAccepted === true,
  );
  const unconfirmedBoundaries = openFindings.filter(
    (finding) => policyFindingCategory(world.policy, finding.category)?.blocksAccepted === "until-confirmed",
  );
  const unacceptedDefects = openDefects.filter((finding) => !finding.riskAccepted);

  // accepted 要求全部必需证据 verified、无未决 defect（不是「全部缺口被接受」——被接受的缺口只通往 accepted_with_risk）
  const accepted =
    !processFailed &&
    approved &&
    missingIncrementIds.length === 0 &&
    evidenceGaps.length === 0 &&
    assuranceCompleted &&
    explorationSatisfied &&
    openDefects.length === 0 &&
    unconfirmedBoundaries.length === 0;

  // accepted_with_risk：在 accepted 之外逐项豁免——每个缺口独立判定，两类证据缺口各自需有效接受
  const acceptableWithRisk =
    !processFailed &&
    approved &&
    missingIncrementIds.length === 0 &&
    assuranceCompleted &&
    explorationSatisfied &&
    unacceptedEvidenceGaps.length === 0 &&
    unacceptedDefects.length === 0 &&
    (evidenceGaps.length > 0 || openDefects.length > 0) &&
    unconfirmedBoundaries.length === 0;

  // ── 状态路由（redesign 3.7 优先级表，自上而下首条命中）──
  const unacceptedFailed = requirements.filter(
    (requirement) => requirement.required && requirement.evidence.some((item) => item.result === "failed" && !item.riskAccepted),
  );
  const unacceptedBlockers = openDefects.filter((finding) => finding.severity === "blocker" && !finding.riskAccepted);
  // 无关联需求的未接受 non-blocker：无法按需求定位修复范围，修复时须全部增量复查（与 candidate-build 的全量复查口径一致）
  const unlinkedNonBlockers = openDefects
    .filter((finding) => finding.severity === "non-blocker" && !finding.riskAccepted && finding.requirementIds.length === 0)
    .map((finding) => finding.findingId);

  let state;
  if (world.task.supersededBy !== null) state = "superseded";
  else if (world.task.supersedeCancelled !== null) state = "supersede-cancelled";
  else if (fold.supersedePrepare !== null && fold.supersedeCommitted === null) state = "supersede-pending";
  else if (!approved) state = "draft";
  else if (!designApproved && !isVerificationOnlyTask(world) && rules.requireDesignApproved !== false) state = "design";
  else if (drift.unstable) state = "revision-unstable";
  else if (processFailed) state = "process-failed";
  else if (unacceptedFailed.length > 0) state = "implementing";
  else if (unacceptedBlockers.length > 0) state = "implementing";
  else if (implementedIncrementIds.length === 0) state = "acceptance-approved";
  else if (missingIncrementIds.length > 0) state = "implementing";
  else if (openDefects.some((finding) => finding.severity === "non-blocker" && !finding.riskAccepted)) state = "candidate";
  else if (unconfirmedBoundaries.length > 0) state = "candidate";
  else if (unacceptedEvidenceGaps.length > 0) state = "candidate";
  else if (!assuranceCompleted || !explorationSatisfied) state = "candidate";
  else if (accepted) state = "accepted";
  else if (acceptableWithRisk) state = "accepted_with_risk";
  else state = "candidate";

  // 非必需需求出现 failed 不阻 accepted，但必须在 verdict 中披露
  const nonRequiredFailures = requirements
    .filter((requirement) => !requirement.required && requirement.evidence.some((item) => item.result === "failed"))
    .map((requirement) => requirement.id);

  // 未覆盖反例场景清单（合并稿 §4.4：verdict 输出断言级缺口和未覆盖反例场景）：
  // schema 2 下逐 form 检查当前 revision 是否存在 verified 且 adversarialFormIds 认领
  // 该场景的 EvidenceRecorded，未认领的场景 id 进 missing（新增场景无人认领时可操作）
  const missingAdversarialFormIds = usesAssertions
    ? acceptance.adversarialForms
        .filter((form) => !fold.evidence.some(
          (event) => event.revision === revision && event.result === "verified" && (event.adversarialFormIds ?? []).includes(form.id),
        ))
        .map((form) => form.id)
    : [];

  const missing = {
    acceptanceApproval: !approved,
    approvalBindings: approvalBindingGaps(world, approved),
    designApproval: !designApproved,
    incrementIds: missingIncrementIds,
    evidence: evidenceGaps,
    assuranceCompleted: !assuranceCompleted,
    explorationCompleted: (usesAssertions ? fold.explorations.length === 0 : acceptance.exploratoryReview === "required") && !explorationCompleted,
    adversarialForms: missingAdversarialFormIds,
    riskAcceptances: [
      ...unacceptedEvidenceGaps.map((gap) => ({ targetType: "requirement", targetId: gap.requirementId, gapId: gap.gapId })),
      ...unacceptedDefects.map((finding) => ({ targetType: "finding", targetId: finding.findingId, gapId: finding.findingId })),
    ],
    unconfirmedBoundaries: unconfirmedBoundaries.map((finding) => finding.findingId),
    nonRequiredFailures,
    missingArtifacts: [...fold.missingArtifacts],
    assertions: missingAssertionIds,
    processFailure: processFailed ? { uniqueMustFix: uniqueMustFix.size, repairRounds } : null,
    assuranceFullFirst:
      recheckWithoutFull.length > 0
        ? {
            reassuranceCount: recheckWithoutFull.length,
            note: "当前 revision 存在基础校验通过的 recheck 保证，但其之前无登记时点完整的 full（同验收版本、receipts 覆盖全部增量、证据可解析、探索引用存在——任意 revision）——首次完整保证不可被定向复核替代。恢复动作：先运行 independent-assurance-v5（mode=full）完成首次完整取证，再以 recheck 做修复后定向复核",
          }
        : null,
  };

  const nextAction = buildNextAction({
    state,
    taskDir: world.taskDir,
    revision,
    world,
    repairRounds,
    budgets: budgetsBlock,
    missingIncrementIds,
    unacceptedFailed: unacceptedFailed.map((requirement) => requirement.id),
    unacceptedBlockers: unacceptedBlockers.map((finding) => finding.findingId),
    unlinkedNonBlockers,
  });

  return {
    state,
    taskId: world.task.taskId,
    projectRoot: world.task.projectRoot,
    revision,
    revisionSource,
    acceptanceVersion: currentVersion,
    acceptancePackageSha256: world.packageSha256,
    intentSha256: world.intentSha256,
    policySnapshotSha256: world.policySnapshotSha256,
    designApproved,
    requirements,
    implementedIncrementIds,
    openFindings,
    reaffirmableFindings,
    nonRequiredFailures,
    driftChain: drift,
    evidenceManifestSha256,
    quality: {
      uniqueMustFix: uniqueMustFix.size,
      repairRounds,
      repairRoundsBreakdown: {
        behaviorRepairRounds: budget.behaviorRepairRounds,
        designRevisionsAfterAssurance: postAssuranceDesignRevisions,
        acceptanceRevisionsAfterAssurance: postAssuranceAcceptanceRevisions,
      },
      budgets: budgetsBlock,
      processFailed,
      offLoopRepair: offLoopRepair ? { lastAssuranceRevision: lastAssurance.revision, currentRevision: revision } : null,
    },
    missing,
    integrity: { eventCount: world.entries.length, signatureVerified: true },
    nextAction,
    generatedBy: "delivery-gate",
    generatedAt: new Date().toISOString(),
  };
}

// 只核验模式（纳管已有实现）不要求 DesignApproved；标记在 task.json 由 init 时写入
function isVerificationOnlyTask(world) {
  return world.task.verificationOnly === true;
}

function approvalBindingGaps(world, approved) {
  if (approved) return [];
  const gaps = [];
  if (world.intentSha256 === null) gaps.push("intent.md 缺失（set-intent 写入原始意图后重审）");
  if (world.policySnapshotSha256 === null) gaps.push("策略快照缺失（snapshot-policy 固定快照后重审）");
  return gaps;
}

function buildNextAction({
  state,
  taskDir,
  revision,
  world,
  repairRounds = 0,
  budgets = null,
  missingIncrementIds,
  unacceptedFailed,
  unacceptedBlockers,
  unlinkedNonBlockers = [],
}) {
  const taskArg = JSON.stringify(taskDir);
  const revisionArg = JSON.stringify(revision);
  const evaluate = `${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision ${revisionArg}`;
  const userCredential = world.task.credentials.user;
  if (state === "superseded") {
    return `本任务已被替换（task.json.supersededBy 指向后继）；查看后继任务的 verdict 继续交付。`;
  }
  if (state === "supersede-cancelled") {
    return `本任务的替换 prepare 已被取消且进入不可交付终态；由恢复任务继续交付流程。`;
  }
  if (state === "supersede-pending") {
    return `完成替换（supersede-commit）或中止（恢复任务走 supersede-cancel）；本任务在替换落定前禁止批准与交付。`;
  }
  if (state === "draft") {
    return `先 set-intent 与 snapshot-policy 固定意图与策略，再运行 delivery-v5/acceptance-design-v5 复核验收包，由用户执行 ${GATE_COMMAND} approve-acceptance --task-dir ${taskArg} --confirmation user-explicit --summary "批准当前验收" --credential ${JSON.stringify(userCredential)}。`;
  }
  if (state === "design") {
    return `运行 tech-design-v5 产出完整方案包（设计文档目录 + 渲染视图 + impl-plan 双格式 + 审查终态），用户确认后执行 ${GATE_COMMAND} record-design-approved 登记方案包哈希清单。`;
  }
  if (state === "revision-unstable") {
    return `连续漂移超上限：人工排查项目写入源后由用户执行 ${GATE_COMMAND} confirm-baseline --task-dir ${taskArg} --reason "排查结论" --credential ${JSON.stringify(userCredential)} --revision ${revisionArg} 确认新基线。`;
  }
  if (state === "process-failed") {
    const budgetDetail = budgets === null
      ? `rounds=${repairRounds}，含修复轮与保证后的方案/验收修订`
      : `修复轮预算 ${budgets.repairPerVersion.used}/${budgets.repairPerVersion.cap}、跨 run 保证预算 ${budgets.assuranceCrossRun.used}/${budgets.assuranceCrossRun.cap}、不同 must-fix ${budgets.uniqueMustFix.count}/${budgets.uniqueMustFix.cap}`;
    return `预算耗尽停回用户（${budgetDetail}）：停止继续补丁与重取证，由用户裁决——按 finding 的 origin 与 expectedStage 回验收、设计或实现阶段重做，或使用任务替换并完整披露本任务失败原因。`;
  }
  if (unacceptedFailed.length > 0) {
    return `修复需求 ${unacceptedFailed.join(", ")} 的 failed 证据并运行 delivery-v5/candidate-build-v5 + independent-assurance-v5（taskDir=${taskArg}）；仅对允许风险的缺口执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (unacceptedBlockers.length > 0) {
    const unlinked = unacceptedBlockers.filter((findingId) => {
      const finding = world.fold.findings.get(findingId);
      return finding !== undefined && finding.raised.requirementIds.length === 0;
    });
    return `修复并解决 blocker ${unacceptedBlockers.join(", ")}${unlinked.length > 0 ? `（其中 ${unlinked.join(", ")} 无关联需求，修复时全部增量复查）` : ""}，或对允许风险的 finding 执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (state === "acceptance-approved" || missingIncrementIds.length > 0) {
    return `运行 delivery-v5/candidate-build-v5（taskDir=${taskArg}）完成增量 ${missingIncrementIds.join(", ") || "全部待实施增量"}，然后执行 ${evaluate}。`;
  }
  if (state === "accepted") {
    return `保留 verdict.json 与原始证据作为当前交付裁决；代码或验收变化后运行 delivery-v5/independent-assurance-v5，并执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  if (state === "accepted_with_risk") {
    return `按 verdict.json 中已接受的风险交付并逐项披露；下一内容版本运行 delivery-v5/independent-assurance-v5，再执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  if (unlinkedNonBlockers.length > 0) {
    return `未接受的 non-blocker ${unlinkedNonBlockers.join(", ")} 无关联需求——修复时全部增量复查（或对其执行 accept-risk）；再运行 delivery-v5/independent-assurance-v5（taskDir=${taskArg}）补齐 missing.evidence 与当前保证，然后执行 ${evaluate}。`;
  }
  return `运行 delivery-v5/independent-assurance-v5（taskDir=${taskArg}）补齐 missing.evidence、当前保证与探索审查；对允许风险的缺口执行 accept-risk（多缺口时用 --gap-id 指定其一），然后执行 ${evaluate}。`;
}

// ── 事件锁（与 v1 同语义：目录锁 + 死持有者抢占）与写事务租约（projectRoot 级）──
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

// 按进程组终止：心跳失效只说明写者失联，不证明写入已停；接管前先终止进程组再等退出
function terminateProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 进程组不存在（已退出或非组长）时对 pid 本身发送；失败视为已终止
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    sleepSync(100);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
}

function leasePath(projectRoot) {
  return join(LEASE_DIR, `${projectSlug(projectRoot)}.json`);
}

function readLease(projectRoot) {
  const filePath = leasePath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      isRecord(parsed) &&
      typeof parsed.runId === "string" &&
      Number.isInteger(parsed.pid) &&
      Number.isInteger(parsed.generation) &&
      typeof parsed.heartbeatAt === "string"
    ) {
      return parsed;
    }
  } catch {
    // 损坏的租约文件按无租约处理（下次 acquire 重建）
  }
  return null;
}

function writeLease(projectRoot, lease) {
  const filePath = leasePath(projectRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWrite(filePath, `${JSON.stringify(lease, null, 2)}\n`);
}

// 事件追加在同一临界区内复核租约：--run-id 与租约持有者不一致即拒绝（redesign 3.9 代次复核）
function verifyLeaseForAppend(world, runId) {
  if (runId === undefined) return;
  requireNonEmptyString(runId, "--run-id");
  const lease = readLease(world.task.projectRoot);
  if (lease === null) {
    fail(`--run-id 指定了运行 ${runId}，但项目无有效写事务租约。`, `先执行 lease-acquire 获取租约，或去掉 --run-id（手工路径不需要租约）。`);
  }
  if (lease.runId !== runId) {
    fail(
      `写事务租约由运行 ${lease.runId}（generation ${lease.generation}）持有，本次 --run-id=${runId} 不是当前代次。`,
      `等待当前运行结束，或由主会话接管（lease-acquire 会终止旧进程树并递增代次）后重试。`,
    );
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

// 写入目标域（事件类型 → 域；唯一权威 = kernel/rules.json eventDomains）
function eventDomainOf(eventType) {
  for (const [writeDomain, eventTypes] of Object.entries(KERNEL_RULES.eventDomains)) {
    if (writeDomain.startsWith("//")) continue;
    if (eventTypes.includes(eventType)) return writeDomain;
  }
  return null;
}

// 写入防护（设计文档 §3.2）：「角色 × 当前状态 × 目标域」矩阵在写入当刻执行——
// 角色不可写的域、当前阶段不允许的写入，在事件落盘前被拒。同时给事件盖 domain 章
function enforceWriteMatrix(world, event) {
  const domain = eventDomainOf(event.type);
  if (domain === null) {
    fail(`事件类型 ${event.type} 不在 eventDomains 表（kernel/rules.json）。`, "在 eventDomains 登记该类型的目标域后再写入；未登记类型不允许落盘。");
  }
  const rows = KERNEL_RULES.writeMatrix?.rows ?? [];
  const row = rows.find((candidate) => candidate.actor === event.actor && candidate.domain === domain);
  if (row === undefined) {
    fail(
      `写入被拒：角色 ${event.actor} 不可写 ${domain} 域（事件 ${event.type}）——写入矩阵未授权。`,
      `builder 只可写 implementation/finding 域，assurance 只可写 evidence/finding/acceptance 域，user 写 acceptance/design/decision 域；修复实现走 record-repair-round / record-implementation，改验收走 open-revision 合法通道。`,
    );
  }
  if (!row.states.includes("*")) {
    const records = world.entries.map((entry) => entry.record);
    const phase = taskPhaseFromEvents(records, { incrementsCount: world.increments !== null ? world.increments.items.length : null });
    if (!row.states.includes(phase)) {
      fail(
        `写入被拒：${event.actor} 写 ${domain} 域在当前阶段（${phase}）不允许（事件 ${event.type}）。`,
        `写入矩阵允许的阶段：${row.states.join(", ")}；按当前阶段的合法转移推进（delivery-core next 查看下一步）后重试。`,
      );
    }
  }
  event.domain = domain;
}

function appendEvent(world, event, privateKey, options = {}) {
  validateEventShape(event);
  enforceWriteMatrix(world, event);
  if (Object.hasOwn(event, "artifact")) validateArtifact(world.taskDir, event.artifact);
  // 覆盖写对账（合并稿 §10.3）：全部携带 artifact 的事件（不再只限带哈希的 EvidenceRecorded）
  if (Object.hasOwn(event, "artifact")) validateArtifactNotOverwritten(world, event);
  const eventId = computeEventId(event);
  const contentKey = canonicalJson(event);
  for (const entry of world.entries) {
    if (entry.record.eventId === eventId) {
      if (canonicalJson(eventContent(entry.record)) !== contentKey) {
        fail("新事件与既有 eventId 冲突但内容不同。", "修改事件内容以生成新的哈希；若持续冲突，保留事件流并排查哈希计算后重试。");
      }
      return entry.record;
    }
  }
  if (world.acceptance !== null && event.acceptanceVersion !== world.acceptance.acceptanceVersion) {
    if (!(event.acceptanceVersion === 0 && isTaskLevelEventType(event.type))) {
      fail(
        `event.acceptanceVersion=${event.acceptanceVersion} 与当前验收版本 ${world.acceptance.acceptanceVersion} 不一致。`,
        `把 acceptanceVersion 改为 ${world.acceptance.acceptanceVersion}，并重新核对事件对当前验收的引用后重试。`,
      );
    }
  }

  // 高层绑定校验（redesign 3.7 关键绑定规则）
  if (event.type === "AcceptanceApproved") {
    if (event.acceptancePackageSha256 !== world.packageSha256) {
      fail("AcceptanceApproved.acceptancePackageSha256 与当前验收包不一致。", `重新计算验收包哈希；建议使用 ${GATE_COMMAND} approve-acceptance 自动计算与绑定。`);
    }
    if (world.intentSha256 === null || event.intentSha256 !== world.intentSha256) {
      fail("AcceptanceApproved.intentSha256 与当前 intent.md 不一致。", `先 set-intent 固定原始意图，再由 approve-acceptance 自动绑定当前哈希。`);
    }
    if (world.policySnapshotSha256 === null || event.policySnapshotSha256 !== world.policySnapshotSha256) {
      fail("AcceptanceApproved.policySnapshotSha256 与任务目录快照不一致。", `先 snapshot-policy 固定策略快照，再由 approve-acceptance 自动绑定当前快照哈希。`);
    }
    if (event.reviewEventId === "none") {
      if (world.policy["verdict-rules.json"].requireAcceptanceReview !== false) {
        fail("AcceptanceApproved.reviewEventId=none 但策略要求目标与验收审查为批准前置。", `先由 assurance 执行 record-review --conclusion pass 再批准；确需免审查由用户升级策略（requireAcceptanceReview=false）并重新审查与批准。`);
      }
    } else {
      const review = world.entries.find((entry) => entry.record.eventId === event.reviewEventId);
      if (!review || review.record.type !== "AcceptanceReviewed") {
        fail("AcceptanceApproved.reviewEventId 不指向任何 AcceptanceReviewed 事件。", `先由 assurance 执行 record-review（同版本、同包哈希、同 intent、同快照且 conclusion=pass），再引用其 eventId 批准。`);
      }
      const reviewRecord = review.record;
      if (
        reviewRecord.conclusion !== "pass" ||
        reviewRecord.acceptancePackageSha256 !== world.packageSha256 ||
        reviewRecord.intentSha256 !== world.intentSha256 ||
        reviewRecord.policySnapshotSha256 !== world.policySnapshotSha256
      ) {
        fail("AcceptanceApproved 引用的审查事件不满足批准前置（须同版本、同验收包、同 intent、同快照且 conclusion=pass）。", `重新执行 record-review 通过当前验收包后，用新的 reviewEventId 批准。`);
      }
    }
  }
  if (event.type === "AcceptanceReviewed") {
    if (event.acceptancePackageSha256 !== world.packageSha256) {
      fail("AcceptanceReviewed.acceptancePackageSha256 与当前验收包不一致。", `使用 record-review 自动计算绑定；验收包变化后旧审查自动失效。`);
    }
    if (world.intentSha256 === null || event.intentSha256 !== world.intentSha256) {
      fail("AcceptanceReviewed.intentSha256 与当前 intent.md 不一致。", `先 set-intent，再 record-review（自动绑定）。`);
    }
    if (world.policySnapshotSha256 === null || event.policySnapshotSha256 !== world.policySnapshotSha256) {
      fail("AcceptanceReviewed.policySnapshotSha256 与任务目录快照不一致。", `先 snapshot-policy 固定策略快照，再 record-review（自动绑定）。`);
    }
  }
  if (event.type === "ImplementationRecorded" && world.acceptance?.schemaVersion === 2) {
    // 候选反例审查对全部 schema 2 任务执行（合并稿 §2.1/§5.3：D3 后 D4 前无风险门控）
    const explored = world.fold.explorations.some((item) => item.revision === event.revision);
    if (!explored) {
      fail(
        "schema 2 候选登记前必须完成当前 revision 的反例审查。",
        "先运行 independent-assurance-v5 --mode explore-only（或 candidate-build-v5 内置候选探索），处置 must-fix 并补回归测试；代码变化后在新的 revision 重新探索，再登记 ImplementationRecorded。",
      );
    }
    const blockers = [...world.fold.findings.values()].filter((finding) =>
      finding.raised.category === "defect" && finding.raised.severity === "blocker" &&
      !finding.resolutions.some((item) => item.revision === event.revision) &&
      !finding.reaffirmations.some((item) => item.revision === event.revision),
    );
    if (blockers.length > 0) {
      fail(
        `候选登记前仍有 ${blockers.length} 条 must-fix 未解决。`,
        `先修复并解决 ${blockers.map((finding) => finding.raised.findingId).join(", ")}，再于当前 revision 登记 ImplementationRecorded。`,
      );
    }
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

// 任务级事件（替换/取消/声明/基线/策略/漂移记录）允许在验收包就位前登记（acceptanceVersion=0）
function isTaskLevelEventType(type) {
  return [
    "TaskSuperseded",
    "TaskSupersedeCancelled",
    "IndependentTaskDeclared",
    "RevisionBaselineConfirmed",
    "PolicyUpgraded",
    "AssuranceRevisionDrift",
    // V5 代：授权声明先于验收包存在（托管开始前登记），任务级事件形态
    "RiskPreauthorized",
  ].includes(type);
}

// ── revision 计算（git：提交号+工作区差异+未跟踪内容；非 git 项目要求显式 --revision）──
function runGit(args, cwd, { binary = false, nonGitAllowed = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    fail(`执行 git ${args[0]} 失败：${result.error.message}。`, "确认 git 已安装且项目目录可访问，解除挂起的 git 进程后重试；非 git 项目请在 evaluate 中显式传 --revision。");
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : `退出码 ${result.status}`;
    if (nonGitAllowed && /not a git repository/i.test(stderr)) return { ok: false, stderr };
    fail(`git ${args.join(" ")} 执行失败：${stderr}。`, "在项目工作树内重试并修复 git 报告的问题；若仓库尚无 HEAD，先创建初始提交，或在 evaluate 中显式传 --revision。");
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
    fail(`计算 revision 时无法读取 ${filePath}：${error.message}。`, "确认文件仍存在且可读，关闭正在改写它的进程后重试 revision；也可在 evaluate 中显式传稳定的内容版本。");
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

// ── 内容清单指纹（revision.json mode=content-manifest，redesign 3.6 内置算法）──
// 清单 = 项目根 delivery-manifest.txt，每行一条纳入 revision 计算的文件相对路径（# 注释与空行忽略）。
// 产物路径纳入清单后其内容变化即改变 revision（旧证据自动失效），且豁免干净构建记录。
const CONTENT_MANIFEST_FILE = "delivery-manifest.txt";

function contentManifestRevision(projectRoot) {
  const manifestPath = join(projectRoot, CONTENT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    fail(
      `内容清单模式缺少清单文件：${manifestPath}。`,
      `在项目根创建 ${CONTENT_MANIFEST_FILE}（每行一条纳入 revision 计算的文件相对路径，# 开头为注释），或把 revision.json 的 mode 改回 auto-git（git 工作树自动指纹）。`,
    );
  }
  const entries = readText(manifestPath, "内容清单", `修正 ${CONTENT_MANIFEST_FILE} 的语法后重试 revision。`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .sort();
  if (entries.length === 0) {
    fail(`内容清单为空：${manifestPath}。`, `在 ${CONTENT_MANIFEST_FILE} 中列出至少一个纳入 revision 计算的文件相对路径后重试。`);
  }
  const hash = createHash("sha256");
  hash.update("delivery-gate-revision-v1\0content-manifest\0");
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) {
      fail(`内容清单含重复条目 ${JSON.stringify(entry)}。`, `删除 ${CONTENT_MANIFEST_FILE} 中的重复行后重试。`);
    }
    seen.add(entry);
    const absolutePath = resolve(projectRoot, entry);
    const lexicalRelative = relative(projectRoot, absolutePath);
    if (entry.includes("..") || isAbsolute(entry) || lexicalRelative.startsWith("..")) {
      fail(`内容清单条目越界：${JSON.stringify(entry)}。`, `把 ${CONTENT_MANIFEST_FILE} 的条目改为项目根内的相对路径后重试。`);
    }
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch (error) {
      fail(`内容清单条目无法读取：${entry}（${error.message}）。`, `恢复该文件，或从 ${CONTENT_MANIFEST_FILE} 移除该条目后重试 revision。`);
    }
    if (!stat.isFile()) {
      fail(`内容清单条目不是文件：${entry}。`, `把 ${CONTENT_MANIFEST_FILE} 的条目改为普通文件的相对路径（目录不纳入清单）后重试。`);
    }
    hash.update(`file\0${entry}\0`);
    hashFileContents(hash, absolutePath);
  }
  return `manifest-${hash.digest("hex").slice(0, 24)}`;
}

function revisionModeFromPolicy() {
  const sources = loadPolicySources();
  validatePolicySources(sources);
  return sources["revision.json"].mode ?? "auto-git";
}

function computeRevision(projectRootValue) {
  requireExistingDirectory(projectRootValue, "--project-root");
  const projectRoot = realpathSync(projectRootValue);
  if (revisionModeFromPolicy() === "content-manifest") return contentManifestRevision(projectRoot);
  if (!isGitWorktree(projectRoot)) {
    fail(`目录不是可自动计算 revision 的 git 工作树：${projectRoot}。`, "在 git 项目根目录重试 revision；非 git 项目请在 revision.json 设 mode=content-manifest 并提供内容清单，或使用 evaluate --task-dir <dir> --revision <非空内容版本>。");
  }
  const topLevelResult = runGit(["-C", projectRoot, "rev-parse", "--show-toplevel"], projectRoot);
  const gitRoot = topLevelResult.stdout.trim();
  const headResult = runGit(["-C", gitRoot, "rev-parse", "HEAD"], gitRoot);
  const head = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    fail(`git HEAD 返回了无法识别的值：${JSON.stringify(head)}。`, "修复仓库 HEAD 后重试 revision，或在 evaluate 中显式传 --revision。");
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
      fail(`计算 revision 时未跟踪文件发生变化：${absolutePath}（${error.message}）。`, "等工作区文件稳定后重试 revision，避免在扫描期间创建或删除文件。");
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      let target;
      try {
        target = readlinkSync(absolutePath);
      } catch (error) {
        fail(`无法读取未跟踪符号链接 ${absolutePath}：${error.message}。`, "修复或移除该链接后重试 revision。");
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

// ── 血统辅助：枚举全部分组任务、查同仓库身份的开放任务与未完成 prepare ──
function iterateAllTaskDirs() {
  const tasks = [];
  if (!existsSync(DELIVERY_DATA_DIR)) return tasks;
  for (const group of readdirSync(DELIVERY_DATA_DIR, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(DELIVERY_DATA_DIR, group.name);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(groupDir, entry.name, "task.json"))) {
        tasks.push({ taskId: entry.name, taskDir: join(groupDir, entry.name) });
      }
    }
  }
  return tasks;
}

function scanEventsOfType(taskDir, predicate) {
  const filePath = join(taskDir, "events.jsonl");
  if (!existsSync(filePath)) return [];
  const hits = [];
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (predicate(record)) hits.push(record);
    } catch {
      // 他任务的损坏行不阻塞本任务（对账时该任务自会失败）
    }
  }
  return hits;
}

// 开放的 prepare：事件在流中、无对应 committed、所在任务未被取消
function findOpenPrepareForPredecessor(predecessorDir, { excludingTaskDir = null } = {}) {
  for (const task of iterateAllTaskDirs()) {
    if (excludingTaskDir !== null && realpathOf(task.taskDir) === realpathOf(excludingTaskDir)) continue;
    const prepares = scanEventsOfType(task.taskDir, (record) =>
      record.type === "TaskSuperseded" && record.phase === "prepare" && record.predecessor?.taskDir === predecessorDir);
    if (prepares.length === 0) continue;
    const committed = scanEventsOfType(task.taskDir, (record) => record.type === "TaskSuperseded" && record.phase === "committed");
    if (committed.length > 0) continue;
    const taskRecord = readJson(join(task.taskDir, "task.json"), `任务 ${task.taskId} task.json`);
    if (taskRecord.supersedeCancelled) continue;
    return { holdingTask: task, prepare: prepares[prepares.length - 1] };
  }
  return null;
}

function realpathOf(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return pathValue;
  }
}

function taskIdentityOf(taskRecord) {
  try {
    return gitRepositoryIdentity(taskRecord.projectRoot);
  } catch {
    // projectRoot 已不存在（任务目录残留）时退化为路径比较
    return { isGit: false, projectRoot: taskRecord.projectRoot };
  }
}

// ── 命令层 ──
function parseOptions(args, specification) {
  // optional/flags 允许缺省（新命令漏写不致崩溃；required 必填）
  const flags = new Set(specification.flags ?? []);
  const allowed = new Set([...specification.required, ...(specification.optional ?? []), ...flags]);
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
    fail(`--event 不是合法 JSON：${error.message}。`, "修正 --event 的 JSON 引号与语法后重试 append；复杂事件建议使用对应高层命令。");
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

function readEvalIdentity(projectRoot) {
  const evalPath = join(projectRoot, "eval-session.json");
  if (!existsSync(evalPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(evalPath, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.eval === "string") {
      return { eval: parsed.eval };
    }
  } catch {
    // 损坏的标识文件不阻塞 init，仅作归属提示
  }
  return null;
}

// 血统检查（redesign 3.3）：同 git 仓库身份下已存在 intent 或验收包相同的未替换任务时，
// 新任务必须走替换（继承未决发现）或由用户签署独立任务声明。
// intent 对账在 init（意图首次固定）；验收包对账在验收包首次成型与绑定（validate-acceptance / record-review）
function lineageCheckForInit(projectRoot, newIntentSha256, excludeTaskDir) {
  const conflicts = [];
  const identity = gitRepositoryIdentity(projectRoot);
  for (const task of iterateAllTaskDirs()) {
    if (excludeTaskDir && realpathOf(task.taskDir) === realpathOf(excludeTaskDir)) continue;
    let taskRecord;
    try {
      taskRecord = readJson(join(task.taskDir, "task.json"), `任务 ${task.taskId} task.json`);
    } catch {
      continue;
    }
    if (taskRecord.supersededBy || taskRecord.supersedeCancelled) continue;
    if (!sameRepositoryIdentity(identity, taskIdentityOf(taskRecord))) continue;
    const taskIntentPath = join(task.taskDir, "intent.md");
    const taskIntentSha = existsSync(taskIntentPath) ? sha256File(taskIntentPath, "intent.md") : null;
    if (newIntentSha256 !== null && taskIntentSha === newIntentSha256) {
      conflicts.push({ taskId: task.taskId, taskDir: task.taskDir, reason: `intent 哈希相同（${newIntentSha256.slice(0, 12)}…）` });
    }
  }
  return conflicts;
}

// 验收包哈希对账（血统规则的包维度）：同仓库身份下已存在验收包相同的未替换任务时拒绝，
// 出口与 intent 冲突一致——任务替换或独立任务声明（声明的豁免基线是 intent 哈希）
function lineageCheckForPackage(projectRoot, newPackageSha256, excludeTaskDir) {
  const conflicts = [];
  const identity = gitRepositoryIdentity(projectRoot);
  for (const task of iterateAllTaskDirs()) {
    if (excludeTaskDir && realpathOf(task.taskDir) === realpathOf(excludeTaskDir)) continue;
    let taskRecord;
    try {
      taskRecord = readJson(join(task.taskDir, "task.json"), `任务 ${task.taskId} task.json`);
    } catch {
      continue;
    }
    if (taskRecord.supersededBy || taskRecord.supersedeCancelled) continue;
    if (!sameRepositoryIdentity(identity, taskIdentityOf(taskRecord))) continue;
    const taskAcceptancePath = join(task.taskDir, "acceptance.json");
    const taskIncrementsPath = join(task.taskDir, "increments.json");
    if (!existsSync(taskAcceptancePath) || !existsSync(taskIncrementsPath)) continue;
    let taskPackageSha256;
    try {
      taskPackageSha256 = acceptancePackageSha256(
        JSON.parse(readFileSync(taskAcceptancePath, "utf8")),
        JSON.parse(readFileSync(taskIncrementsPath, "utf8")),
      );
    } catch {
      continue;
    }
    if (taskPackageSha256 === newPackageSha256) {
      conflicts.push({ taskId: task.taskId, taskDir: task.taskDir, reason: `验收包哈希相同（${newPackageSha256.slice(0, 12)}…）` });
    }
  }
  return conflicts;
}

// 验收包首次成型与绑定（validate-acceptance / record-review）时执行包对账：
// 冲突任务上已有同 intent 的独立声明则豁免（与 init 的豁免口径一致）
function requireNoPackageLineageConflict(world) {
  const conflicts = lineageCheckForPackage(world.task.projectRoot, world.packageSha256, world.taskDir);
  if (conflicts.length === 0) return;
  const independentDeclared = conflicts.every((conflict) => {
    const declarations = scanEventsOfType(conflict.taskDir, (record) => record.type === "IndependentTaskDeclared");
    return world.intentSha256 !== null && declarations.some((declaration) => declaration.intentSha256 === world.intentSha256);
  });
  if (!independentDeclared) {
    fail(
      `血统对账未通过：同一 git 仓库身份下已有未替换任务 ${conflicts.map((conflict) => `${conflict.taskId}（${conflict.reason}）`).join("、")}。`,
      `改走任务替换（supersede-prepare 继承未决发现），或确认确属独立任务后先在既有任务上 declare-independent 再重试；复制旧任务验收包洗历史不属于独立任务。`,
    );
  }
}

function commandInit(args) {
  const options = parseOptions(args, {
    required: ["project-root", "task-id"],
    optional: ["intent-file"],
    flags: ["new-round", "resume-existing", "verification-only"],
  });
  if (options["new-round"] && options["resume-existing"]) {
    fail("--new-round 与 --resume-existing 互斥：继续既有任务用 --resume-existing，开新一轮目录用 --new-round。", "按目标二选一后重试 init。");
  }
  validateTaskId(options["task-id"]);
  requireExistingDirectory(options["project-root"], "--project-root");
  const projectRoot = realpathSync(options["project-root"]);
  const groupSlug = projectSlug(projectRoot);
  const groupDir = join(DELIVERY_DATA_DIR, groupSlug);
  const worktree = isGitWorktree(projectRoot);
  const evalIdentity = readEvalIdentity(projectRoot);
  const identityNote = evalIdentity
    ? {
        evalIdentity,
        evalIdentityNotice:
          "该 projectRoot 挂有评测身份标识（eval-session.json）——确认它是本会话经评测入口创建的评测后再继续；不是则停止并核查 worktree 归属。",
      }
    : {};

  let intentText = null;
  let intentSha = null;
  if (Object.hasOwn(options, "intent-file")) {
    requireExistingDirectory(dirname(options["intent-file"]) === "" ? "." : dirname(options["intent-file"]), "--intent-file 所在目录");
    intentText = readText(options["intent-file"], "--intent-file", "修正 --intent-file 路径后重试 init。");
    if (intentText.trim().length === 0) {
      fail("--intent-file 内容为空。", "原始意图必须是非空文本；确认文件内容后重试。");
    }
    intentSha = sha256Text(intentText);
  }

  const exactDir = join(groupDir, options["task-id"]);
  const exactExists = existsSync(join(exactDir, "task.json"));

  if (options["resume-existing"]) {
    if (!exactExists) {
      fail(`--resume-existing 指向的任务不存在：${exactDir}。`, `去掉 --resume-existing 直接 init 新任务；或核对 --task-id 与 --project-root 是否与既有任务一致。`);
    }
    const existing = readJson(join(exactDir, "task.json"), "task.json");
    validateTaskRecord(existing, exactDir);
    if (existing.taskId !== options["task-id"] || existing.projectRoot !== projectRoot) {
      fail(`任务目录已存在且 task.json 与本次 init 参数不一致：${exactDir}。`, "复用原 taskId 与原 projectRoot，或选择新的 taskId；不要清空既有任务目录。");
    }
    const eventsPath = join(exactDir, "events.jsonl");
    if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
    printJson({
      taskDir: realpathSync(exactDir),
      reused: true,
      projectRoot,
      worktree,
      ...identityNote,
      siblingTasks: listGroupTasks(groupDir).filter((task) => task.taskId !== options["task-id"]),
      credentials: existing.credentials,
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

  // 血统检查：同仓库身份 + 相同 intent 的开放任务必须走替换或独立声明
  const lineageConflicts = lineageCheckForInit(projectRoot, intentSha, null);
  const independentDeclared = lineageConflicts.every((conflict) => {
    const declarations = scanEventsOfType(conflict.taskDir, (record) => record.type === "IndependentTaskDeclared");
    return declarations.some((declaration) => declaration.intentSha256 === intentSha);
  });
  if (lineageConflicts.length > 0 && !independentDeclared) {
    fail(
      `血统检查未通过：同一 git 仓库身份下已有未替换任务 ${lineageConflicts.map((conflict) => `${conflict.taskId}（${conflict.reason}）`).join("、")}。`,
      `改走任务替换（supersede-prepare 继承未决发现），或确认确属独立任务后先在既有任务上 declare-independent 再重新 init；口头声明独立无效。`,
    );
  }

  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  const taskPath = join(taskDir, "task.json");
  if (existsSync(taskPath)) {
    const existing = readJson(taskPath, "task.json");
    validateTaskRecord(existing, taskDir);
    if (existing.taskId !== taskId || existing.projectRoot !== projectRoot) {
      fail(`任务目录已存在且 task.json 与本次 init 参数不一致：${taskDir}。`, "复用原 taskId 与原 projectRoot，或选择新的 taskId；不要清空既有任务目录。");
    }
    const eventsPath = join(taskDir, "events.jsonl");
    if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
    printJson({
      taskDir: realpathSync(taskDir),
      reused: true,
      projectRoot,
      worktree,
      ...identityNote,
      siblingTasks: listGroupTasks(groupDir).filter((task) => task.taskId !== taskId),
      credentials: existing.credentials,
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
  writeCredentialKeys(groupSlug, taskId, pairs);
  const credentials = Object.fromEntries(
    SIGNING_KEY_ROLES.map((role) => [role, `${groupSlug}/${taskId}/${role}`]),
  );
  const taskRecord = {
    schemaVersion: 2,
    taskId,
    projectRoot,
    credentials,
    builderPublicKey: pairs.builder.publicKey,
    assurancePublicKey: pairs.assurance.publicKey,
    userPublicKey: pairs.user.publicKey,
    supersededBy: null,
    supersedeCancelled: null,
  };
  if (options["verification-only"]) taskRecord.verificationOnly = true;
  atomicWrite(taskPath, `${JSON.stringify(taskRecord, null, 2)}\n`);
  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) atomicWrite(eventsPath, "");
  if (intentText !== null) atomicWrite(join(taskDir, "intent.md"), intentText);
  const siblingTasks = listGroupTasks(groupDir).filter((task) => task.taskId !== taskId);
  printJson({
    taskDir: realpathSync(taskDir),
    projectRoot,
    worktree,
    ...identityNote,
    siblingTasks,
    ...(siblingTasks.length > 0
      ? {
          notice:
            `该 worktree 分组下已有其他交付任务（${siblingTasks.map((task) => task.taskId).join("、")}）。` +
            "init 前必须确认本会话对该 worktree 的归属：任务目录不是本会话创建时立即停止并核实；评测等多会话同题环境，每场评测必须基于干净基线新建自己的 worktree，禁止读写他人任务目录。",
        }
      : {}),
    credentialDir: join(CREDENTIAL_KEY_DIR, groupSlug, taskId),
    // 凭据 id 即调用方出示给 --credential 的值；私钥不在 stdout 出现
    credentials,
    intentSha256: intentSha,
    builderPublicKey: pairs.builder.publicKey,
    assurancePublicKey: pairs.assurance.publicKey,
    userPublicKey: pairs.user.publicKey,
  });
}

function commandSetIntent(args) {
  const options = parseOptions(args, { required: ["task-dir", "file"], optional: [] });
  const core = loadTaskCore(options["task-dir"]);
  const intentPath = join(core.taskDir, "intent.md");
  const text = readText(options.file, "--file", "修正 --file 路径后重试 set-intent。");
  if (text.trim().length === 0) {
    fail("原始意图文件内容为空。", "intent.md 必须原样保存非空的需求全文。");
  }
  if (existsSync(intentPath)) {
    const current = readText(intentPath, "intent.md", "从任务备份恢复 intent.md 后重试。");
    if (current !== text) {
      fail(
        "intent.md 已存在且与本次内容不同：原始意图写入后不可修改。",
        `需要修订意图 = 新任务（血统规则会拦截同 intent 重复；确属不同需求用新 intent 重新 init）；本任务沿用已固定的 intent（sha256=${sha256Text(current).slice(0, 12)}…）。`,
      );
    }
    printJson({ taskDir: core.taskDir, intentSha256: sha256Text(current), reused: true });
    return;
  }
  atomicWrite(intentPath, text);
  printJson({ taskDir: core.taskDir, intentSha256: sha256Text(text) });
}

function commandValidateAcceptance(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: [] });
  const world = loadWorld(options["task-dir"], { withEvents: false });
  // 验收包首次成型时执行血统包对账（intent 对账已在 init 完成）
  requireNoPackageLineageConflict(world);
  printJson({
    valid: true,
    taskDir: world.taskDir,
    acceptanceVersion: world.acceptance.acceptanceVersion,
    acceptancePackageSha256: world.packageSha256,
    intentSha256: world.intentSha256,
  });
}

function commandSnapshotPolicy(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: [] });
  const core = loadTaskCore(options["task-dir"]);
  const sources = loadPolicySources();
  validatePolicySources(sources);
  const document = policySnapshotDocument(sources);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const newSha = sha256Text(text);
  const snapshotPath = join(core.taskDir, "policy-snapshot.json");
  if (existsSync(snapshotPath)) {
    const currentText = readText(snapshotPath, "policy-snapshot.json", "从任务备份恢复快照后重试。");
    if (sha256Text(currentText) !== newSha) {
      fail(
        `任务已有策略快照且与当前策略不同（已固定 ${sha256Text(currentText).slice(0, 12)}…，当前 ${newSha.slice(0, 12)}…）。`,
        `在途任务固定按既有快照执行；确需升级策略由用户执行 upgrade-policy（含逐事件失效范围声明并重新审查与批准）。`,
      );
    }
    printJson({ taskDir: core.taskDir, policySnapshotSha256: newSha, reused: true });
    return;
  }
  atomicWrite(snapshotPath, text);
  printJson({ taskDir: core.taskDir, policySnapshotSha256: newSha });
}

function commandRecordReview(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "conclusion", "summary", "credential"],
    optional: ["artifact"],
  });
  const world = loadWorld(options["task-dir"], { requirePackage: true });
  const privateKey = loadCredentialPrivateKey(world, options.credential, "assurance");
  // 审查绑定验收包时执行血统包对账（与 validate-acceptance 同口径，双时点拦复制）
  requireNoPackageLineageConflict(world);
  const revision = computeRevision(world.task.projectRoot);
  const artifact = Object.hasOwn(options, "artifact") ? options.artifact : `evidence/acceptance-review-v${world.acceptance.acceptanceVersion}.md`;
  const event = {
    type: "AcceptanceReviewed",
    actor: "assurance",
    acceptanceVersion: world.acceptance.acceptanceVersion,
    revision,
    summary: options.summary,
    acceptancePackageSha256: world.packageSha256,
    intentSha256: world.intentSha256 ?? "",
    policySnapshotSha256: world.policySnapshotSha256 ?? "",
    conclusion: options.conclusion,
    artifact,
  };
  if (world.intentSha256 === null || world.policySnapshotSha256 === null) {
    fail("登记审查前必须先固定原始意图与策略快照。", "依次执行 set-intent 与 snapshot-policy，再 record-review（事件自动绑定两者哈希）。");
  }
  withEventsLock(options["task-dir"], () => {
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandApproveAcceptance(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "confirmation", "summary", "credential"],
    optional: ["revision"],
  });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const passReview = [...world.fold.reviews]
      .reverse()
      .find((event) =>
        event.conclusion === "pass" &&
        event.acceptanceVersion === world.acceptance.acceptanceVersion &&
        event.acceptancePackageSha256 === world.packageSha256 &&
        event.intentSha256 === world.intentSha256 &&
        event.policySnapshotSha256 === world.policySnapshotSha256);
    if (!passReview && world.policy["verdict-rules.json"].requireAcceptanceReview !== false) {
      fail(
        "批准前置不满足：不存在同版本、同验收包、同 intent、同策略快照且 conclusion=pass 的 AcceptanceReviewed。",
        `先由 assurance 执行 record-review --conclusion pass，再执行 approve-acceptance（自动绑定最新通过审查，无需手工指定 eventId）。`,
      );
    }
    if (!passReview && world.policy["verdict-rules.json"].requireAcceptanceReview === false) {
      process.stderr.write("delivery-gate: 策略 requireAcceptanceReview=false，本次批准免审查（reviewEventId=none）。\n");
    }
    const event = {
      type: "AcceptanceApproved",
      actor: "user",
      acceptanceVersion: world.acceptance.acceptanceVersion,
      revision: Object.hasOwn(options, "revision") ? options.revision : "",
      summary: options.summary,
      acceptancePackageSha256: world.packageSha256,
      intentSha256: world.intentSha256,
      policySnapshotSha256: world.policySnapshotSha256,
      reviewEventId: passReview ? passReview.eventId : "none",
      confirmation: options.confirmation,
    };
    const record = appendEvent(world, event, privateKey);
    // 写入防护（V5）：批准即冻结——验收包两文件 chmod 0444（写入当时拒非法改写）+
    // 只追加快照 frozen/v<N>/（事后对账与恢复的权威副本）。合法修订唯一通道 = open-revision
    const frozenDir = join(world.taskDir, "frozen", `v${world.acceptance.acceptanceVersion}`);
    mkdirSync(frozenDir, { recursive: true });
    for (const fileName of ["acceptance.json", "increments.json"]) {
      const sourcePath = join(world.taskDir, fileName);
      copyFileSync(sourcePath, join(frozenDir, fileName));
      chmodSync(sourcePath, 0o444);
      chmodSync(join(frozenDir, fileName), 0o444);
    }
    printJson(record);
  });
}

// 合法解冻唯一通道（V5 写入防护）：用户登记 RevisionOpened 并说明理由，chmod 0644 解锁
// 起草；重新批准时 approve-acceptance 再次冻结。不登记即改动 = loadWorld 篡改检测拦截
function commandOpenRevision(args) {
  const options = parseOptions(args, { required: ["task-dir", "reason", "credential"], optional: [] });
  withEventsLock(options["task-dir"], () => {
    // 解冻是合法恢复通道：即使检出包已被动过也要能加载并登记 RevisionOpened（留痕）；
    // 之后的重新审查与批准仍按正常门禁走
    const world = loadWorld(options["task-dir"], { allowTampered: true });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    if (world.fold.approvals.length === 0) {
      fail("任务尚无已批准验收包（无冻结可解）。", "批准前验收包本就可写；先走审查与批准流程。");
    }
    const lastApproval = world.fold.approvals[world.fold.approvals.length - 1];
    const alreadyOpened = world.fold.revisionOpens.some((event) => event.seq > lastApproval.seq);
    if (alreadyOpened) {
      fail("当前批准后的验收包已解封（RevisionOpened 在场）。", "直接起草新版本并递增 acceptanceVersion，审查通过后 approve-acceptance 会再次冻结。");
    }
    const event = {
      type: "RevisionOpened",
      actor: "user",
      acceptanceVersion: world.acceptance.acceptanceVersion,
      revision: computeRevision(world.task.projectRoot),
      summary: options.reason,
      target: "acceptance",
      reason: options.reason,
    };
    const record = appendEvent(world, event, privateKey);
    for (const fileName of ["acceptance.json", "increments.json"]) {
      chmodSync(join(world.taskDir, fileName), 0o644);
    }
    printJson(record);
  });
}

function commandRecordDesignApproved(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "summary", "credential", "package-file"],
    optional: ["decision-file"],
  });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    // 方案包清单文件：[{name, sha256}]（主会话按方案包文件逐个计算）
    const manifest = readJson(options["package-file"], "--package-file（方案包哈希清单）");
    if (!Array.isArray(manifest) || manifest.length === 0) {
      fail("--package-file 必须是非空数组（方案包文件哈希清单）。", "按 [{name, sha256}] 逐文件登记设计文档目录、渲染视图、impl-plan 双格式与审查终态后重试。");
    }
    requirePackageFilesShape(manifest, "--package-file");
    const revision = computeRevision(world.task.projectRoot);
    const event = {
      type: "DesignApproved",
      actor: "user",
      acceptanceVersion: world.acceptance.acceptanceVersion,
      revision,
      summary: options.summary,
      packageFiles: manifest,
      decisionRef: Object.hasOwn(options, "decision-file") ? options["decision-file"] : "evidence/design-decisions.md",
      confirmation: "user-explicit",
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

// ── 意图提交命令组（设计文档 §3.2：事件由内核构造，执行器只提交意图）──
// 信封（type/actor/acceptanceVersion/revision/domain/artifactSha256 可推导项）一律本命令组
// 计算，调用方不再手工拼事件 JSON、不再自算 revision 与内容哈希；语义内容（观察到了什么）
// 仍由调用方提供。--revision 可选：缺省取当前 computeRevision（保证 run 在途锁定的
// setup revision 用它传入——漂移语义保持显式）。
function parseJsonOption(value, label, commandName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${commandName} 的 ${label} 不是合法 JSON：${error.message}`, `按 JSON 数组/对象字面量重传（workflow 侧用 JSON.stringify 序列化）。`);
  }
}

function nextFindingId(world, prefix = "F-N") {
  const used = new Set(
    world.entries.map((entry) => entry.record.findingId).filter((id) => typeof id === "string"),
  );
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

const INTENT_SPECS = {
  "record-implementation": {
    type: "ImplementationRecorded",
    role: "builder",
    required: ["task-dir", "increment-id", "summary", "artifact", "merge-receipt", "credential"],
    optional: ["revision", "run-id"],
    jsonFields: { "merge-receipt": "mergeReceipt" },
    build: (world, options, parsed) => ({
      incrementId: options["increment-id"],
      artifact: options.artifact,
      mergeReceipt: parsed["merge-receipt"],
    }),
  },
  "record-repair-round": {
    type: "RepairRoundRecorded",
    role: "builder",
    required: ["task-dir", "round", "summary", "trigger-finding-ids", "affected-assertion-ids", "artifact", "credential"],
    optional: ["from-revision", "to-revision", "nature", "increment-receipts", "revision", "run-id"],
    jsonFields: { "trigger-finding-ids": "triggerFindingIds", "affected-assertion-ids": "affectedAssertionIds", "increment-receipts": "incrementReceipts" },
    build: (world, options, parsed) => ({
      round: Number(options.round),
      triggerFindingIds: parsed["trigger-finding-ids"],
      affectedAssertionIds: parsed["affected-assertion-ids"],
      artifact: options.artifact,
      ...(options["from-revision"] !== undefined ? { fromRevision: options["from-revision"] } : {}),
      ...(options["to-revision"] !== undefined ? { toRevision: options["to-revision"] } : {}),
      ...(options.nature !== undefined ? { nature: options.nature } : {}),
      ...(parsed["increment-receipts"] !== undefined ? { incrementReceipts: parsed["increment-receipts"] } : {}),
    }),
  },
  "record-finding": {
    type: "FindingRaised",
    role: null, // actor 由凭据角色决定（builder 自报 / assurance 审查）
    required: ["task-dir", "summary", "category", "severity", "requirement-ids", "artifact", "credential"],
    optional: ["finding-id", "origin", "consequence-refutation", "consequence-refutation-type", "reopen-of", "first-detected-stage", "expected-stage", "regression-test-ref", "revision", "run-id"],
    jsonFields: { "requirement-ids": "requirementIds" },
    build: (world, options, parsed) => ({
      findingId: options["finding-id"] ?? nextFindingId(world),
      category: options.category,
      severity: options.severity,
      requirementIds: parsed["requirement-ids"],
      artifact: options.artifact,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options["consequence-refutation"] !== undefined ? { consequenceRefutation: options["consequence-refutation"] } : {}),
      ...(options["consequence-refutation-type"] !== undefined ? { consequenceRefutationType: options["consequence-refutation-type"] } : {}),
      ...(options["reopen-of"] !== undefined ? { reopenOf: options["reopen-of"] } : {}),
      ...(options["first-detected-stage"] !== undefined ? { firstDetectedStage: options["first-detected-stage"] } : {}),
      ...(options["expected-stage"] !== undefined ? { expectedStage: options["expected-stage"] } : {}),
      ...(options["regression-test-ref"] !== undefined ? { regressionTestRef: options["regression-test-ref"] } : {}),
    }),
  },
  "resolve-finding": {
    type: "FindingResolved",
    role: "assurance",
    required: ["task-dir", "finding-id", "summary", "artifact", "credential"],
    optional: ["revision", "run-id"],
    build: (world, options) => ({ findingId: options["finding-id"], artifact: options.artifact }),
  },
  "reaffirm-resolution": {
    type: "ResolutionReaffirmed",
    role: "assurance",
    required: ["task-dir", "finding-id", "original-resolution-event-id", "basis", "summary", "artifact", "credential"],
    optional: ["revision", "run-id"],
    build: (world, options) => ({
      findingId: options["finding-id"],
      originalResolutionEventId: options["original-resolution-event-id"],
      basis: options.basis,
      artifact: options.artifact,
    }),
  },
  "record-evidence": {
    type: "EvidenceRecorded",
    role: "assurance",
    required: ["task-dir", "requirement-id", "kind", "result", "summary", "artifact", "credential"],
    optional: ["assertion-ids", "adversarial-form-ids", "artifact-sha256", "revision", "run-id"],
    jsonFields: { "assertion-ids": "assertionIds", "adversarial-form-ids": "adversarialFormIds" },
    build: (world, options, parsed) => ({
      requirementId: options["requirement-id"],
      kind: options.kind,
      result: options.result,
      artifact: options.artifact,
      ...(parsed["assertion-ids"] !== undefined ? { assertionIds: parsed["assertion-ids"] } : {}),
      ...(parsed["adversarial-form-ids"] !== undefined ? { adversarialFormIds: parsed["adversarial-form-ids"] } : {}),
    }),
  },
  "record-exploration": {
    type: "ExplorationCompleted",
    role: "assurance",
    required: ["task-dir", "summary", "dimensions", "coverage-manifest-sha256", "artifact", "credential"],
    optional: ["artifact-sha256", "revision", "run-id"],
    jsonFields: { dimensions: "dimensions" },
    build: (world, options, parsed) => ({
      dimensions: parsed.dimensions,
      coverageManifestSha256: options["coverage-manifest-sha256"],
      artifact: options.artifact,
    }),
  },
  "complete-assurance": {
    type: "AssuranceCompleted",
    role: "assurance",
    required: ["task-dir", "summary", "coverage-manifest-sha256", "exploration-event-id", "increment-receipts", "artifact", "credential"],
    optional: ["mode", "evidence-event-ids", "clean-build", "artifact-sha256", "revision", "run-id"],
    jsonFields: { "increment-receipts": "incrementReceipts", "evidence-event-ids": "evidenceEventIds", "clean-build": "cleanBuild" },
    build: (world, options, parsed) => ({
      coverageManifestSha256: options["coverage-manifest-sha256"],
      explorationEventId: options["exploration-event-id"],
      incrementReceipts: parsed["increment-receipts"],
      artifact: options.artifact,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(parsed["evidence-event-ids"] !== undefined ? { evidenceEventIds: parsed["evidence-event-ids"] } : { evidenceEventIds: ["none"] }),
      // cleanBuild 必填可空：content-manifest 豁免干净构建时显式 null（与 workflow 构造同形态）
      cleanBuild: parsed["clean-build"] !== undefined ? parsed["clean-build"] : null,
    }),
  },
  "record-assurance-drift": {
    type: "AssuranceRevisionDrift",
    role: "assurance",
    required: ["task-dir", "summary", "setup-revision", "finalize-revision", "drift-seq", "credential"],
    optional: ["revision", "run-id"],
    build: (world, options) => ({
      setupRevision: options["setup-revision"],
      finalizeRevision: options["finalize-revision"],
      driftSeq: Number(options["drift-seq"]),
    }),
  },
};

function commandIntent(commandName, args) {
  const spec = INTENT_SPECS[commandName];
  const options = parseOptions(args, { required: spec.required, optional: spec.optional });
  const parsed = {};
  for (const [optionKey] of Object.entries(spec.jsonFields ?? {})) {
    if (options[optionKey] !== undefined) parsed[optionKey] = parseJsonOption(options[optionKey], `--${optionKey}`, commandName);
  }
  withEventsLock(options["task-dir"], () => {
    // 包语义事件需要完整世界（fold 依赖包结构）；record-assurance-drift 等无包也合法
    const world = loadWorld(options["task-dir"], { requirePackage: !isTaskLevelEventType(spec.type) });
    // actor 由凭据角色裁决（record-finding 双角色：builder 自报 / assurance 审查）
    const actor = spec.role ?? options.credential.split("/")[2];
    const privateKey = loadCredentialPrivateKey(world, options.credential, actor);
    const revision = options.revision !== undefined ? options.revision : computeRevision(world.task.projectRoot);
    const content = spec.build(world, options, parsed);
    const event = {
      type: spec.type,
      actor,
      acceptanceVersion: world.acceptance !== null ? world.acceptance.acceptanceVersion : 0,
      revision,
      summary: options.summary,
      ...content,
    };
    // artifactSha256 缺省由内核计算（仅限事件契约允许该字段的内容哈希类型；发现类事件不绑内容哈希）
    if (Object.hasOwn(event, "artifact") && ARTIFACT_HASH_CAPABLE_TYPES.has(spec.type)) {
      if (options["artifact-sha256"] === undefined && event.artifact !== "none") {
        event.artifactSha256 = sha256File(join(world.taskDir, event.artifact), `--artifact ${event.artifact}`);
      } else if (options["artifact-sha256"] !== undefined) {
        event.artifactSha256 = options["artifact-sha256"];
      }
    }
    verifyLeaseForAppend(world, options["run-id"]);
    printJson(appendEvent(world, event, privateKey));
  });
}

// append 已退役（意图命令组覆盖全部事件类型）：消灭「执行器手工拼事件 JSON」通道
function commandAppend(args) {
  fail(
    "append 已退役：全部事件经意图提交命令登记（信封由 gate 构造——type/actor/revision/acceptanceVersion/domain/artifactSha256 不再手工拼）。",
    "执行器命令：record-implementation / record-repair-round / record-finding / resolve-finding / reaffirm-resolution / record-evidence / record-exploration / complete-assurance / record-assurance-drift；主会话命令见 --help。",
  );
}

// V5 代收敛机制：用户预先声明可由 standing-authorization 接受的 finding 范围。
// 安全边界（shape 层与 shape 后校验双保险）：仅 finding 目标生效、severity 上限恒
// non-blocker（blocker 永不可预授权——出现 blocker 的出路只有修复或用户亲自接受）、
// 名额必填且按事件流顺序消耗（每个验收版本独立配额）。
function commandPreauthorizeRisk(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "categories", "max-findings", "summary", "credential"],
    optional: [],
  });
  const categories = options.categories
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (categories.length === 0) {
    fail("--categories 为空。", "逗号分隔登记策略分类（如 defect,boundary），至少一项后重试。");
  }
  const maxFindings = Number.parseInt(options["max-findings"], 10);
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    fail("--max-findings 须为正整数。", "登记可消耗的名额上限（该授权下允许的 standing 接受累计数）后重试。");
  }
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    if (world.policy === null) {
      fail("策略快照缺失，无法校验预授权分类词表。", "先 set-intent 与 snapshot-policy 固定策略快照，再登记预授权。");
    }
    for (const category of categories) {
      if (policyFindingCategory(world.policy, category) === undefined) {
        fail(`--categories 含未登记分类 ${category}。`, "只允许策略 finding-categories.json 词表内的分类（新增分类走策略升级 upgrade-policy）。");
      }
    }
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const event = {
      type: "RiskPreauthorized",
      actor: "user",
      // 持久事件：验收包出现前也允许登记（托管开始前的授权声明）
      acceptanceVersion: world.acceptance !== null ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(world.task.projectRoot),
      summary: options.summary,
      categories,
      maxSeverity: "non-blocker",
      maxFindings,
      confirmation: "user-explicit",
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandAcceptRisk(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "target-type", "target-id", "confirmation", "summary", "credential"],
    optional: ["revision", "gap-id"],
  });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const revision = Object.hasOwn(options, "revision")
      ? options.revision
      : computeRevision(world.task.projectRoot);
    const verdict = buildVerdict(world, revision, "risk-acceptance");
    let gapId = null;
    let evidenceState = null;
    if (options["target-type"] === "requirement") {
      const requirement = verdict.requirements.find((entry) => entry.id === options["target-id"]);
      if (!requirement) {
        fail(`--target-id ${options["target-id"]} 不是当前验收中的需求。`, "核对 acceptance.requirements 的 id 后重试 accept-risk。");
      }
      const gaps = requirement.evidence.filter((item) => item.result !== "verified" && !item.riskAccepted);
      const gapList = gaps.map((item) => `${item.kind}=${item.gapId}`).join(" | ");
      if (Object.hasOwn(options, "gap-id")) {
        // 显式指定缺口：必须确属该需求的未接受缺口，防登记项与用户批准项错位
        const gap = gaps.find((item) => item.gapId === options["gap-id"]);
        if (!gap) {
          fail(
            `--gap-id ${options["gap-id"]} 不是需求 ${options["target-id"]} 的未接受缺口（候选：${gaps.length > 0 ? gapList : "无——全部证据已 verified 或已接受"}）。`,
            `以 evaluate 输出的 verdict.requirements 中该需求的 gapId 重试；缺口已全部处理时不要执行 accept-risk。`,
          );
        }
        gapId = gap.gapId;
        evidenceState = gap.result;
      } else if (gaps.length === 0) {
        fail(`需求 ${options["target-id"]} 的全部证据类型均已 verified，不存在可接受的缺口。`, "不要对该需求执行 accept-risk；如需覆盖历史风险请核对 verdict 后再决定。");
      } else if (gaps.length > 1) {
        fail(
          `需求 ${options["target-id"]} 存在 ${gaps.length} 个未接受缺口，必须用 --gap-id 指定其一：${gapList}。`,
          `用户批准了哪个缺口就指定哪个 gapId 重试 accept-risk；多缺口时不允许自动绑定（登记项可能与批准项错位）。`,
        );
      } else {
        gapId = gaps[0].gapId;
        evidenceState = gaps[0].result;
      }
    } else {
      const finding = verdict.openFindings.find((entry) => entry.findingId === options["target-id"]);
      if (!finding) {
        fail(`--target-id ${options["target-id"]} 不是当前未决 finding。`, "核对 verdict.openFindings 的 findingId 后重试 accept-risk。");
      }
      const categoryPolicy = policyFindingCategory(world.policy, finding.category);
      if (categoryPolicy !== undefined && categoryPolicy.riskAcceptAllowed === false) {
        fail(`finding ${options["target-id"]} 所属分类 ${finding.category} 不允许风险接受（策略 riskAcceptAllowed=false）。`, `该类发现的出路是 assurance 对照论证后确认（FindingResolved），或递增验收版本缩减判据。`);
      }
      // V5 代：standing-authorization 仅在预授权覆盖内放行（与 fold 重放校验同规则同口径）
      if (options.confirmation === "standing-authorization") {
        const preauthUsedCounts = [];
        for (const preauthorization of world.fold.preauthorizations) preauthUsedCounts.push(0);
        // 名额口径与 fold 重放一致：按事件流顺序重放 standing 接受，先占先得
        for (const risk of world.fold.risks) {
          if (risk.confirmation !== "standing-authorization" || risk.targetType !== "finding") continue;
          const riskFinding = world.fold.findings.get(risk.targetId);
          if (!riskFinding) continue;
          const matched = matchPreauthorization(
            world.fold.preauthorizations,
            preauthUsedCounts,
            riskFinding.raised.category,
            riskFinding.raised.severity,
          );
          if (matched >= 0) preauthUsedCounts[matched] += 1;
        }
        const matched = matchPreauthorization(
          world.fold.preauthorizations,
          preauthUsedCounts,
          finding.category,
          finding.severity,
        );
        if (matched < 0) {
          fail(
            `finding ${options["target-id"]} 超出风险预授权范围（类别 ${finding.category}、severity ${finding.severity} 或名额已耗尽）。`,
            `由用户执行 ${GATE_COMMAND} preauthorize-risk --task-dir <dir> --categories <类别> --max-findings <n> --summary <理由> --credential <user credentialId> 追加覆盖后重试；或改用 --confirmation user-explicit 由用户亲自接受。`,
          );
        }
      }
      if (Object.hasOwn(options, "gap-id") && options["gap-id"] !== options["target-id"]) {
        fail(`--gap-id 与 --target-id 不一致：finding 目标的缺口 id 即 findingId。`, `去掉 --gap-id，或将其改为与 --target-id 相同的值后重试。`);
      }
      gapId = finding.findingId;
      evidenceState = "failed";
    }
    const event = {
      type: "RiskAccepted",
      actor: "user",
      acceptanceVersion: world.acceptance.acceptanceVersion,
      revision,
      summary: options.summary,
      targetType: options["target-type"],
      targetId: options["target-id"],
      gapId,
      evidenceState,
      confirmation: options.confirmation,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandEvaluate(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
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

function commandConfirmBaseline(args) {
  const options = parseOptions(args, { required: ["task-dir", "reason", "credential"], optional: ["revision"] });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const revision = Object.hasOwn(options, "revision") ? options.revision : computeRevision(world.task.projectRoot);
    const event = {
      type: "RevisionBaselineConfirmed",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision,
      summary: options.reason,
      confirmedRevision: revision,
      reason: options.reason,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandUpgradePolicy(args) {
  const options = parseOptions(args, { required: ["task-dir", "invalidation-note", "summary", "credential"], optional: [] });
  withEventsLock(options["task-dir"], () => {
    const core = loadTaskCore(options["task-dir"]);
    const snapshotPath = join(core.taskDir, "policy-snapshot.json");
    if (!existsSync(snapshotPath)) {
      fail("任务没有既有策略快照，无需升级。", "直接执行 snapshot-policy 固定当前策略即可。");
    }
    const oldSha = sha256File(snapshotPath, "policy-snapshot.json");
    const sources = loadPolicySources();
    validatePolicySources(sources);
    const document = policySnapshotDocument(sources);
    const text = `${JSON.stringify(document, null, 2)}\n`;
    const newSha = sha256Text(text);
    if (newSha === oldSha) {
      fail("当前策略与既有快照相同，无可升级内容。", "调整安装目录或用户级策略后重试 upgrade-policy。");
    }
    const privateKey = loadCredentialPrivateKey({ task: core.task, keys: core.keys }, options.credential, "user");
    // 世界（含验收包）可能不存在：任务级事件允许无包
    let world;
    try {
      world = loadWorld(options["task-dir"]);
    } catch {
      world = loadWorld(options["task-dir"], { requirePackage: false });
    }
    const event = {
      type: "PolicyUpgraded",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(core.task.projectRoot),
      summary: options.summary,
      oldPolicySnapshotSha256: oldSha,
      newPolicySnapshotSha256: newSha,
      invalidationNote: options["invalidation-note"],
      confirmation: "user-explicit",
    };
    const record = appendEvent(world, event, privateKey);
    atomicWrite(snapshotPath, text);
    printJson(record);
  });
}

function commandDeclareIndependent(args) {
  const options = parseOptions(args, { required: ["task-dir", "credential"], optional: ["summary"] });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const intentPath = join(world.taskDir, "intent.md");
    if (!existsSync(intentPath)) {
      fail("独立任务声明必须绑定新任务的 intent 哈希。", "先 set-intent 写入本任务的原始意图，再 declare-independent。");
    }
    const intentSha = sha256File(intentPath, "intent.md");
    // 未替换清单含签署任务自身：声明绑定的是「当时全部未替换任务」，供事后对账
    const unreplacedTasks = iterateAllTaskDirs()
      .filter((task) => {
        const record = readJson(join(task.taskDir, "task.json"), `任务 ${task.taskId} task.json`);
        return !record.supersededBy && !record.supersedeCancelled;
      })
      .map((task) => task.taskId);
    if (unreplacedTasks.length === 0) {
      fail("当前不存在任何未替换任务，独立声明无可对账对象。", "血统检查会直接放行；本命令用于存在同仓库同 intent 开放任务时的显式声明。");
    }
    const event = {
      type: "IndependentTaskDeclared",
      actor: "user",
      acceptanceVersion: 0,
      revision: computeRevision(world.task.projectRoot),
      summary: options.summary ?? `独立任务声明：绑定 intent ${intentSha.slice(0, 12)}… 与当时全部未替换任务清单`,
      intentSha256: intentSha,
      unreplacedTasks,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

// ── 任务替换三段协议 ──
function predecessorBindings(predecessorCore) {
  const verdictPath = join(predecessorCore.taskDir, "verdict.json");
  if (!existsSync(verdictPath)) {
    fail(`前任任务缺少 verdict.json（${predecessorCore.taskDir}）。`, `先对前任任务执行 ${GATE_COMMAND} evaluate --task-dir <前任目录> 生成最终裁决，再发起替换。`);
  }
  const verdict = readJson(verdictPath, "前任 verdict.json");
  const openFindings = Array.isArray(verdict.openFindings) ? verdict.openFindings : [];
  return {
    taskJsonSha256: sha256File(join(predecessorCore.taskDir, "task.json"), "前任 task.json"),
    verdictSha256: sha256File(verdictPath, "前任 verdict.json"),
    openFindingsSha256: sha256Text(canonicalJson(openFindings)),
    openFindings,
  };
}

function requireSameLineage(newCore, predecessorCore) {
  const newIdentity = gitRepositoryIdentity(newCore.task.projectRoot);
  const predecessorIdentity = taskIdentityOf(predecessorCore.task);
  if (!sameRepositoryIdentity(newIdentity, predecessorIdentity)) {
    fail(
      "任务替换只允许在同一 git 仓库身份内（gitdir/远端一致，覆盖全部 worktree）。",
      `本任务 projectRoot=${newCore.task.projectRoot}，前任 projectRoot=${predecessorCore.task.projectRoot}；跨仓库请用独立任务（新 intent 重新 init）。`,
    );
  }
}

function commandSupersedePrepare(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "predecessor-dir", "summary", "credential"],
    optional: [],
  });
  withEventsLock(options["task-dir"], () => {
    const newCore = loadTaskCore(options["task-dir"]);
    const predecessorCore = loadTaskCore(options["predecessor-dir"]);
    requireSameLineage(newCore, predecessorCore);
    // 同一前任只允许一个有效 prepare（其余任务侧的开放 prepare 即冲突）
    const openPrepare = findOpenPrepareForPredecessor(realpathSync(options["predecessor-dir"]), {
      excludingTaskDir: newCore.taskDir,
    });
    if (openPrepare) {
      fail(
        `前任已存在未完成的替换 prepare（由任务 ${openPrepare.holdingTask.taskId} 持有）。`,
        `等待其 committed，或由恢复任务走 supersede-cancel 取消后再接管；同一前任不允许两个有效 prepare。`,
      );
    }
    const predecessorReal = predecessorCore.taskDir;
    if (predecessorCore.task.supersededBy !== null) {
      fail(`前任已被任务 ${predecessorCore.task.supersededBy.successorTaskId} 替换。`, `接管已替换任务无意义；如需再次替换，以现后继为前任重新发起。`);
    }
    const bindings = predecessorBindings(predecessorCore);
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    // 继承清单沿用前任 verdict 的开放发现（id/category/severity/关联需求）
    const inheritedFindings = bindings.openFindings.map((finding) => ({
      findingId: finding.findingId,
      category: finding.category,
      severity: finding.severity,
      requirementIds: [...(finding.requirementIds ?? [])],
    }));
    const event = {
      type: "TaskSuperseded",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(newCore.task.projectRoot),
      summary: options.summary,
      phase: "prepare",
      predecessor: {
        taskDir: predecessorReal,
        taskJsonSha256: bindings.taskJsonSha256,
        verdictSha256: bindings.verdictSha256,
        openFindingsSha256: bindings.openFindingsSha256,
      },
      inheritedFindings,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandSupersedeCommit(args) {
  const options = parseOptions(args, { required: ["task-dir", "summary", "credential"], optional: [] });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    if (!world.fold.supersedePrepare) {
      fail("本任务没有 TaskSuperseded(prepare)，无可提交的替换。", `先执行 supersede-prepare --task-dir <本任务> --predecessor-dir <前任>。`);
    }
    if (world.fold.supersedeCommitted) {
      printJson(world.fold.supersedeCommitted);
      return;
    }
    const prepare = world.fold.supersedePrepare;
    const predecessorCore = loadTaskCore(prepare.predecessor.taskDir);
    // 前任 task.json 哈希须仍与 prepare 绑定一致（比较后交换的前置）
    const currentSha = sha256File(join(predecessorCore.taskDir, "task.json"), "前任 task.json");
    if (currentSha !== prepare.predecessor.taskJsonSha256) {
      fail(
        "前任 task.json 自 prepare 后已变化，替换绑定失效。",
        `重新执行 supersede-prepare 绑定最新前任身份后重试 commit。`,
      );
    }
    // 比较后交换：无标记 → 写入本后继；已指向本后继 → 幂等；指向其他 → 冲突停止
    const predecessorTaskPath = join(predecessorCore.taskDir, "task.json");
    const predecessorTask = readJson(predecessorTaskPath, "前任 task.json");
    const marker = { successorTaskId: world.task.taskId, prepareEventId: prepare.eventId };
    if (predecessorTask.supersededBy === null) {
      predecessorTask.supersededBy = marker;
      atomicWrite(predecessorTaskPath, `${JSON.stringify(predecessorTask, null, 2)}\n`);
    } else if (
      predecessorTask.supersededBy.successorTaskId !== world.task.taskId ||
      predecessorTask.supersededBy.prepareEventId !== prepare.eventId
    ) {
      fail(
        `前任已标记由任务 ${predecessorTask.supersededBy.successorTaskId} 接管，本任务 ${world.task.taskId} 的 commit 冲突停止。`,
        `两个后继并发时只有一个能完成；另一任务应停止交付并保留事件审计。`,
      );
    }
    const event = {
      type: "TaskSuperseded",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(world.task.projectRoot),
      summary: options.summary,
      phase: "committed",
      predecessor: { ...prepare.predecessor },
      inheritedFindings: [...prepare.inheritedFindings],
      prepareEventId: prepare.eventId,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

function commandSupersedeCancel(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "cancelled-task-dir", "cancelled-prepare-event-id", "reason", "summary", "credential"],
    optional: [],
    flags: ["transfer-marker"],
  });
  withEventsLock(options["task-dir"], () => {
    const recoveryCore = loadTaskCore(options["task-dir"]);
    const cancelledCore = loadTaskCore(options["cancelled-task-dir"]);
    requireSameLineage(recoveryCore, cancelledCore);
    const prepareEventId = options["cancelled-prepare-event-id"];
    requireSha256(prepareEventId, "--cancelled-prepare-event-id");
    // 校验被取消任务的流中确有该 prepare 且未 committed、未被取消
    const prepares = scanEventsOfType(cancelledCore.taskDir, (record) => record.type === "TaskSuperseded" && record.phase === "prepare" && record.eventId === prepareEventId);
    if (prepares.length === 0) {
      fail(`--cancelled-prepare-event-id 在被取消任务的事件流中不存在。`, `核对事件 id（取 supersede-prepare 输出的 eventId）后重试。`);
    }
    const cancelledPrepare = prepares[0];
    const committed = scanEventsOfType(cancelledCore.taskDir, (record) => record.type === "TaskSuperseded" && record.phase === "committed");
    if (committed.length > 0) {
      fail("被取消任务的替换已 committed，不能再取消。", `该替换已完成；如需再次更换后继，以现后继为前任重新发起替换。`);
    }
    if (cancelledCore.task.supersedeCancelled !== null) {
      fail("该任务的 prepare 已被取消过。", `恢复任务 ${cancelledCore.task.supersedeCancelled?.successorTaskId ?? "?"} 已接管；不要重复取消。`);
    }
    const predecessorCore = loadTaskCore(cancelledPrepare.predecessor.taskDir);
    const bindings = predecessorBindings(cancelledCore);
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    // 1) 恢复任务流：取消事件（绑 A 的 prepare 与身份）
    const cancelEvent = {
      type: "TaskSupersedeCancelled",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(recoveryCore.task.projectRoot),
      summary: options.summary,
      cancelledPrepareEventId: prepareEventId,
      predecessorTaskDir: cancelledPrepare.predecessor.taskDir,
      // 前任（O）当时的 task.json 哈希：单看取消事件即可锚定 O 身份（与恢复 prepare 内的绑定对账）
      predecessorTaskJsonSha256: sha256File(join(predecessorCore.taskDir, "task.json"), "前任 task.json"),
      cancelledTaskJsonSha256: sha256File(join(cancelledCore.taskDir, "task.json"), "被取消任务 task.json"),
      cancelledVerdictSha256: bindings.verdictSha256,
      reason: options.reason,
    };
    appendEvent(world, cancelEvent, privateKey);
    // 2) 恢复任务流：自己的 prepare（predecessor = 原 predecessor O，接管自 A）
    const inheritedFindings = cancelledPrepare.inheritedFindings.map((finding) => ({
      findingId: finding.findingId,
      category: finding.category,
      severity: finding.severity,
      requirementIds: [...finding.requirementIds],
    }));
    const prepareEvent = {
      type: "TaskSuperseded",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(recoveryCore.task.projectRoot),
      summary: `恢复型替换：接管自 ${cancelledCore.task.taskId}（prepare ${prepareEventId.slice(0, 12)}… 已取消）`,
      phase: "prepare",
      predecessor: {
        taskDir: cancelledPrepare.predecessor.taskDir,
        taskJsonSha256: sha256File(join(predecessorCore.taskDir, "task.json"), "前任 task.json"),
        verdictSha256: sha256File(join(predecessorCore.taskDir, "verdict.json"), "前任 verdict.json"),
        openFindingsSha256: cancelledPrepare.predecessor.openFindingsSha256,
      },
      inheritedFindings,
    };
    const record = appendEvent(world, prepareEvent, privateKey);
    // 3) 被取消任务 task.json 写 supersedeCancelled 标记（进入不可交付终态）
    const cancelledTaskPath = join(cancelledCore.taskDir, "task.json");
    const cancelledTask = readJson(cancelledTaskPath, "被取消任务 task.json");
    if (cancelledTask.supersedeCancelled === null) {
      cancelledTask.supersedeCancelled = { successorTaskId: recoveryCore.task.taskId, prepareEventId };
      atomicWrite(cancelledTaskPath, `${JSON.stringify(cancelledTask, null, 2)}\n`);
    }
    // 4) 原前任的标记：仅在已指向被取消任务链时按 --transfer-marker 转移（默认报告人工处理）
    const predecessorTaskPath = join(predecessorCore.taskDir, "task.json");
    const predecessorTask = readJson(predecessorTaskPath, "前任 task.json");
    if (predecessorTask.supersededBy !== null && predecessorTask.supersededBy.successorTaskId === cancelledCore.task.taskId) {
      if (options["transfer-marker"]) {
        predecessorTask.supersededBy = { successorTaskId: recoveryCore.task.taskId, prepareEventId: record.eventId };
        atomicWrite(predecessorTaskPath, `${JSON.stringify(predecessorTask, null, 2)}\n`);
      } else {
        process.stderr.write(
          `delivery-gate: 前任标记仍指向被取消任务 ${cancelledCore.task.taskId}——确认转移给恢复任务时加 --transfer-marker 重试，或人工修正。\n`,
        );
      }
    }
    printJson(record);
  });
}

// ── 写事务租约命令 ──
function commandLeaseAcquire(args) {
  const options = parseOptions(args, { required: ["project-root", "run-id"], optional: [] });
  requireExistingDirectory(options["project-root"], "--project-root");
  const projectRoot = realpathSync(options["project-root"]);
  const existing = readLease(projectRoot);
  const now = Date.now();
  if (existing !== null) {
    const heartbeatAge = now - Date.parse(existing.heartbeatAt);
    // 活性由心跳时长单独承重：租约 pid 是登记 lease-acquire 的 CLI 进程（短命），持租
    // 互斥的真实信号是 workflow 长阶段的周期 lease-heartbeat——心跳新鲜即视为持租运行
    // 中，异 runId 不得接管；心跳陈旧按失联接管（terminateProcessGroup 已容错死 pid）
    const alive = heartbeatAge <= LEASE_STALE_MS;
    if (alive && existing.runId === options["run-id"]) {
      writeLease(projectRoot, { ...existing, heartbeatAt: new Date().toISOString() });
      printJson({ projectRoot, runId: existing.runId, generation: existing.generation, reused: true });
      return;
    }
    if (alive && existing.runId !== options["run-id"]) {
      fail(
        `项目写租约由运行 ${existing.runId}（generation ${existing.generation}，pid ${existing.pid}，心跳 ${Math.round(heartbeatAge / 1000)}s 前）持有且仍存活。`,
        `等待该运行结束或由主会话决意接管（先终止其进程树）后重试 lease-acquire；不要双写并发。`,
      );
    }
    // 失联租约：终止进程组后接管并递增代次
    if (isPidAlive(existing.pid)) terminateProcessGroup(existing.pid);
    const lease = {
      projectRoot,
      runId: options["run-id"],
      pid: process.pid,
      generation: existing.generation + 1,
      heartbeatAt: new Date().toISOString(),
    };
    writeLease(projectRoot, lease);
    printJson({ ...lease, tookOverFrom: existing.runId });
    return;
  }
  const lease = { projectRoot, runId: options["run-id"], pid: process.pid, generation: 1, heartbeatAt: new Date().toISOString() };
  writeLease(projectRoot, lease);
  printJson(lease);
}

function commandLeaseHeartbeat(args) {
  const options = parseOptions(args, { required: ["project-root", "run-id"], optional: [] });
  const projectRoot = realpathSync(options["project-root"]);
  const existing = readLease(projectRoot);
  if (existing === null || existing.runId !== options["run-id"]) {
    fail(`租约不存在或不属于运行 ${options["run-id"]}。`, `先执行 lease-acquire 获取租约；若已被接管，当前运行必须停止写入。`);
  }
  const updated = { ...existing, heartbeatAt: new Date().toISOString() };
  writeLease(projectRoot, updated);
  printJson(updated);
}

function commandLeaseRelease(args) {
  const options = parseOptions(args, { required: ["project-root", "run-id"], optional: [] });
  const projectRoot = realpathSync(options["project-root"]);
  const existing = readLease(projectRoot);
  if (existing === null) {
    printJson({ projectRoot, released: true, note: "无租约" });
    return;
  }
  if (existing.runId !== options["run-id"]) {
    fail(`租约属于运行 ${existing.runId}，运行 ${options["run-id"]} 不能释放他人租约。`, `由租约持有者执行 release；接管场景重新 acquire 即可。`);
  }
  try {
    rmSync(leasePath(projectRoot), { force: true });
  } catch (error) {
    fail(`无法删除租约文件：${error.message}。`, `检查 ${leasePath(projectRoot)} 权限后重试。`);
  }
  printJson({ projectRoot, released: true });
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
      case "set-intent":
        commandSetIntent(commandArgs);
        break;
      case "validate-acceptance":
        commandValidateAcceptance(commandArgs);
        break;
      case "snapshot-policy":
        commandSnapshotPolicy(commandArgs);
        break;
      case "record-review":
        commandRecordReview(commandArgs);
        break;
      case "approve-acceptance":
        commandApproveAcceptance(commandArgs);
        break;
      case "open-revision":
        commandOpenRevision(commandArgs);
        break;
      case "record-design-approved":
        commandRecordDesignApproved(commandArgs);
        break;
      case "append":
        commandAppend(commandArgs);
        break;
      case "record-implementation":
      case "record-repair-round":
      case "record-finding":
      case "resolve-finding":
      case "reaffirm-resolution":
      case "record-evidence":
      case "record-exploration":
      case "complete-assurance":
      case "record-assurance-drift":
        commandIntent(command, commandArgs);
        break;
      case "accept-risk":
        commandAcceptRisk(commandArgs);
        break;
      case "preauthorize-risk":
        commandPreauthorizeRisk(commandArgs);
        break;
      case "evaluate":
        commandEvaluate(commandArgs);
        break;
      case "revision":
        commandRevision(commandArgs);
        break;
      case "confirm-baseline":
        commandConfirmBaseline(commandArgs);
        break;
      case "upgrade-policy":
        commandUpgradePolicy(commandArgs);
        break;
      case "declare-independent":
        commandDeclareIndependent(commandArgs);
        break;
      case "supersede-prepare":
        commandSupersedePrepare(commandArgs);
        break;
      case "supersede-commit":
        commandSupersedeCommit(commandArgs);
        break;
      case "supersede-cancel":
        commandSupersedeCancel(commandArgs);
        break;
      case "lease-acquire":
        commandLeaseAcquire(commandArgs);
        break;
      case "lease-heartbeat":
        commandLeaseHeartbeat(commandArgs);
        break;
      case "lease-release":
        commandLeaseRelease(commandArgs);
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

// 直接执行才跑 main；被 import（delivery-core.mjs 复用内部函数）时不跑。两侧都取 realpath
// 比较——本文件经 symlink（~/.agents/skills/delivery-v5）调用时 import.meta.url 与 argv[1]
// 字面不同、realpath 相同；被 import 时 argv[1] 是调用方文件、realpath 必不相同
const invokedPath = process.argv[1] !== undefined ? realpathSync(resolve(process.argv[1])) : null;
if (invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

// ── 内核复用导出（V5）：delivery-core.mjs 同进程消费的世界加载与裁决组装。
// 导出的是既有实现本身，不是副本——改这些函数只改一处，两侧同步生效 ──
export { buildVerdict, computeRevision, loadTaskCore, loadWorld };
