#!/usr/bin/env node
// delivery-gate（V6）——确定性交付裁决器。语义权威：.tmp/delivery-wf/redesign-detailed.md 第 3 章。
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
// 判定单源库（V6 内核）：发现 open 集、修复轮与跨 run 预算、定级改判统计只此一份实现，
// 本文件与 delivery-core.mjs 同进程复用；workflow 侧经 delivery-core CLI 的 JSON 子命令消费，
// 禁止在别处复刻同口径判定
import {
  KERNEL_RULES,
  LOOP_BUDGET_CAP_KEYS,
  capabilityDeclarationMatches,
  criterionChangedSinceResolution,
  deriveObligations,
  deriveRevisionProvenance,
  deriveRuntimeObligations,
  environmentKindSatisfies,
  findingRegrades,
  loopAttemptsBudget,
  openFindingsFromEvents,
  parseLoopAttemptsText,
  priorFullQualification,
  repairBudgetFromEvents,
  runtimeEvidenceIntegrityGap,
  taskPhaseFromEvents,
} from "./lib/kernel-judgments.mjs";
import {
  loadClassTables,
  renderRescanErrorGate,
  rescanRecoveryGate,
  runContractRescan,
  strongCandidateClasses,
} from "./lib/contract-rescan.mjs";

const GATE_COMMAND = "node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs";
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 事件写入角色与凭据一一对应；designer 的产物是验收草稿文件，engine 的测试摘要由 builder 角色记录，均不写事件
const ACTORS = ["builder", "assurance", "user"];
const CONFIRMATIONS = ["user-explicit", "standing-authorization"];
const EVIDENCE_KINDS = ["command", "scenario", "inspection"];
const FINDING_CATEGORIES = ["defect", "boundary"];
const FINDING_SEVERITIES = ["blocker", "non-blocker"];
const EVIDENCE_RESULTS = ["verified", "partial", "failed"];
// 任务级事件（替换/声明/基线/策略）允许在验收包出现前登记，此时 acceptanceVersion 为 0
// channel 进公共字段（信封+内容身份双投影：写入侧整事件哈希、读取侧 eventFields 投影
// 必须一致——历史事件无该键时投影自然不含，哈希向后兼容）
const COMMON_EVENT_FIELDS = ["type", "actor", "acceptanceVersion", "revision", "channel", "summary"];
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
  // 重认领（V6 代收敛机制）：revision 前进使旧 resolution 失效后，assurance 在新 revision 上
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
  // 风险预授权（V6 代收敛机制）：用户预先声明可由 standing-authorization 接受的 finding 范围。
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
  // 冻结解封（V6 写入防护）：批准后验收包 chmod 0444；合法修订唯一通道 = 用户登记
  // RevisionOpened 解封（chmod 0644 + 留痕），此后允许起草新版本并重新审查与批准。
  // 未解封的改动在 loadWorld 被篡改检测拦下（写入当秒被 chmod 拒，漏网者在加载时检出）
  RevisionOpened: {
    actors: ["user"],
    fields: ["target", "reason"],
  },
  // 外部权威登记（V6 运行可用性升级 §4.4）：local-path / executable 权威必须由用户凭据
  // 登记——designer 或 builder 填写的本地路径不生成 resolved。任务级事件（验收包就位前
  // 亦可登记），字段 {contractId, resolverKind, locator, snapshotSha256, summary}
  ExternalAuthorityDeclared: {
    actors: ["user"],
    fields: ["contractId", "resolverKind", "locator", "snapshotSha256"],
  },
  // 外部环境基线确认（V6 运行可用性升级 §10）：外部依赖升级/宿主版本变化后，用户确认新
  // 环境基线并接上环境历史链——不直接把 runtime 义务置 satisfied，确认后仍必须在当前环境
  // 重跑 probe。同一 acceptanceVersion 内最多一次（§4.3 预算规则，evaluate 判定）
  EnvironmentBaselineConfirmed: {
    actors: ["user"],
    fields: ["newAuthoritySnapshotSha256", "contractIds"],
  },
};
const EVENT_TYPES = Object.keys(EVENT_SCHEMAS);
// TaskSuperseded 的 prepareEventId 只在 committed 段必填；shape 校验按 phase 条件放行
const CONDITIONAL_EVENT_FIELDS = {
  TaskSuperseded: { onlyPhase: "committed", fields: ["prepareEventId"] },
};
const OPTIONAL_EVENT_FIELDS = {
  // 外部契约能力绑定与 runtime probe 标记（V6 运行可用性升级 §6.3）：additive 可选。
  // contractCapabilityIds = 该证据覆盖的「契约id:能力id」清单；runtimeProbe=true 表示
  // 该证据由真实 runner/宿主驱动产生，是 runtime 义务唯一可满足的证据形态
  EvidenceRecorded: ["assertionIds", "adversarialFormIds", "contractCapabilityIds", "runtimeProbe"],
  // consequenceRefutationType = 行为后果否决论证的三类声明（合并稿 §9：不会发生 /
  // 用户不可观察 / 验收明确允许），正文存 consequenceRefutation，机器只认枚举。
  // emptyScopeRefutation = 空关联 boundary 的不影响任何需求论证（V5 完整性设计 §5.4：
  // requirementIds=[] 曾绕过定级护栏——GLM F-5 实证；空关联必须证明其不影响任何需求）
  // authority 反驳组（V6 运行可用性升级 §9）：结构命中外部契约（contractCapabilityIds
  // 非空，或 requirementIds 反查断言含 requiredEnvironment.capability）时 authorityBacked
  // 必须为 true 且 authorityHash / authorityObservationRef 非空——堵住拿同一份文字文档
  // 自我证明的弱关闭通道
  FindingRaised: ["consequenceRefutation", "consequenceRefutationType", "reopenOf", "origin", "firstDetectedStage", "expectedStage", "regressionTestRef", "emptyScopeRefutation", "contractCapabilityIds", "authorityBacked", "authorityHash", "authorityObservationRef"],
  AssuranceCompleted: ["mode", "artifactSha256"],
  // 审查/批准时刻的环境契约快照哈希（V6 运行可用性升级 §4.4）：审计事实，不进批准四元组
  // 有效性判定；新任务即使无外部契约也绑定空快照哈希，历史事件与升级前任务允许缺省
  AcceptanceReviewed: ["authoritySnapshotSha256"],
  AcceptanceApproved: ["authoritySnapshotSha256"],
  // 哈希绑定扩展到全部携带 artifact 的证据/回执事件（合并稿 §10.3 证据不可覆盖）：
  // OPTIONAL 起步兼容旧事件流，workflow 侧新登记必填
  ImplementationRecorded: ["artifactSha256"],
  ExplorationCompleted: ["artifactSha256"],
  // V6 代修复轮次溯源：fromRevision/toRevision = 该轮修复前后的 revision（受控修复循环
  // 登记时携带；旧事件与上限熔断事件可缺省）；incrementReceipts = 每轮修复的全量确定性
  // 测试回执（合并稿 §11.1，与 AssuranceCompleted 回执同款双哈希）；nature = 轮次性质
  //（behavior 计轮；environment/evidence 重试不计轮——合并稿 §7.1）
  RepairRoundRecorded: ["fromRevision", "toRevision", "artifactSha256", "incrementReceipts", "nature"],
  // 历史 unknown 区间确认（confirm-history 命令，V5 完整性改造 §7.2 的最小补充通道）：
  // explainedUnknownIntervals = 用户署名确认的 revision 区间清单 [{fromRevision,toRevision,
  // intervalSha256,rationale}]——每段区间与哈希绑定，只解释派生结果中精确匹配的 unknown
  // 区间，不推进链条位置、不构成新基线；未确认的 unknown 仍阻断 accepted
  RevisionBaselineConfirmed: ["explainedUnknownIntervals"],
};
const EVENTS_LOCK_DIRNAME = ".events.lock";
const EVENTS_LOCK_MAX_AGE_MS = 30_000;
const EVENTS_LOCK_WAIT_MS = 30_000;
const UNTRACKED_SYMLINK_BUDGET_BYTES = 8 * 1024 * 1024;
const UNTRACKED_DIRECTORY_MAX_DEPTH = 16;
const SIGNING_KEY_NAMES = { builder: "builderKey", assurance: "assuranceKey", user: "userKey" };
const SIGNING_KEY_ROLES = ["builder", "assurance", "user"];
// HOME 派生目录惰性求值（调用时读 os.homedir()）：CLI 单次进程语义不变；进程内测试垫片
// 按用例切换 HOME 时路径必须跟随变化，顶层固化会让 HOME 隔离失效并把测试数据写进真实用户目录
const CREDENTIAL_KEY_DIR = () => join(homedir(), ".agents", "skill-data", "delivery-keys");
const POLICY_USER_DIR = () => join(homedir(), ".agents", "skill-data", "delivery-policies");
const DELIVERY_DATA_DIR = () => join(homedir(), ".agents", "skill-data", "delivery");
const LEASE_DIR = () => join(homedir(), ".agents", "skill-data", "delivery-leases");
const LEASE_STALE_MS = 120_000;
const HELP = `delivery-gate（V6）：delivery-v6 的确定性交付裁决器（状态/转移/计数归 delivery-core 内核，判定单源 = scripts/lib/kernel-judgments.mjs）

凭据（v2 起私钥不再经参数传递）：
  init 将三把角色私钥写入用户级凭据目录（0600）：~/.agents/skill-data/delivery-keys/<分组>/<任务id>/{builder,assurance,user}.key。
  stdout 只输出凭据 id（credentialId）与三把公钥，不输出任何私钥。所有需要签名的事件命令用
  --credential <credentialId> 出示凭据；CLI 按 credentialId 定位私钥，并强制事件 actor 与凭据角色
  一致——builder 凭据签不出 actor=assurance 的事件，user 凭据只供主会话使用，绝不注入子 agent。

用法：
  delivery-gate init --project-root P --task-id T [--new-round] [--resume-existing] [--intent-file F] [--verification-only] [--delivery-profile a|b|c]  # 缺省 b（§13 分级；降档只减审查席与分区，不减必做机器门）；--verification-only = 纳管体系外已有实现的只核验模式
  delivery-gate set-intent --task-dir D --file F
  delivery-gate validate-acceptance --task-dir D
  delivery-gate snapshot-policy --task-dir D
  delivery-gate record-review --task-dir D --conclusion pass|reject --summary S --credential <assurance credentialId> [--artifact A] [--authority-snapshot-sha256 H]  # 验收包声明外部契约时自动绑定当前环境契约快照哈希
  delivery-gate approve-acceptance --task-dir D --confirmation user-explicit|standing-authorization --summary S --credential <user credentialId> [--revision R] [--authority-snapshot-sha256 H]  # V6：批准即冻结（chmod 0444 + frozen/v<N>/ 快照）；快照哈希 = 环境历史链起点
  delivery-gate open-revision --task-dir D --reason S --credential <user credentialId>  # V6：合法解冻唯一通道（RevisionOpened 留痕 + chmod 0644）
  delivery-gate declare-external-authority --task-dir D --contract-id C --resolver-kind K --locator L --snapshot-sha256 H --summary S --credential <user credentialId>  # local-path/executable 权威必须由用户凭据登记；designer/builder 填写的本地路径不生成 resolved
  delivery-gate confirm-environment-baseline --task-dir D --contract-ids '<JSON>' --new-authority-snapshot-sha256 H --credential <user credentialId>  # 用户确认新外部环境基线（只接环境历史链，不满足 runtime 义务；同一 acceptanceVersion 最多一次）
  delivery-gate set-delivery-profile --task-dir D --profile a|b|c --credential <user credentialId>  # 任务分级唯一写通道（禁直改 task.json）
  delivery-gate record-design-approved --task-dir D --package-file F [--decision-file F2] --summary S --credential <user credentialId>
  # 意图提交命令组（执行器事件唯一通道；信封由 gate 构造：actor/revision/acceptanceVersion/domain/artifactSha256 缺省内核计算）
  delivery-gate record-implementation --task-dir D --increment-id INC-1 --summary S --artifact A --merge-receipt '<JSON>' --credential <builder credentialId> [--revision R]
  delivery-gate record-repair-round --task-dir D --round N --summary S --trigger-finding-ids '<JSON>' --affected-assertion-ids '<JSON>' --artifact A --credential <builder credentialId> [--from-revision R --to-revision R2 --nature behavior|environment|evidence --increment-receipts '<JSON>']
  delivery-gate record-finding --task-dir D --summary S --category defect|boundary --severity blocker|non-blocker --requirement-ids '<JSON>' --artifact A --credential <builder|assurance credentialId> [--finding-id F --origin O --first-detected-stage S --expected-stage S --regression-test-ref R --consequence-refutation S --consequence-refutation-type T --reopen-of F0 --empty-scope-refutation S --contract-capability-ids '<JSON>' --authority-backed true --authority-hash H --authority-observation-ref R --revision R --run-id RUN]  # schema 2 下 category=boundary 且 --requirement-ids '[]'（空关联）必须附 --empty-scope-refutation（不影响任何需求的论证）；结构命中外部契约时 authority 三段必填
  delivery-gate resolve-finding --task-dir D --finding-id F --summary S --artifact A --credential <assurance credentialId>
  delivery-gate reaffirm-resolution --task-dir D --finding-id F --original-resolution-event-id E --basis S --summary S --artifact A --credential <assurance credentialId>
  delivery-gate record-evidence --task-dir D --requirement-id R --kind K --result S --summary S --artifact A --credential <assurance credentialId> [--assertion-ids '<JSON>' --adversarial-form-ids '<JSON>' --contract-capability-ids '<JSON>' --runtime-probe --artifact-sha256 H --revision R --run-id RUN]  # --runtime-probe = 真实 runner/宿主驱动产生的 runtime probe 证据（runtime 义务唯一可满足形态）
  delivery-gate record-exploration --task-dir D --summary S --dimensions '<JSON>' --coverage-manifest-sha256 H --artifact A --credential <assurance credentialId> [--artifact-sha256 H --revision R --run-id RUN]
  delivery-gate complete-assurance --task-dir D --summary S --coverage-manifest-sha256 H --exploration-event-id E --increment-receipts '<JSON>' --artifact A --credential <assurance credentialId> [--mode full|recheck|explore-only --evidence-event-ids '<JSON>' --clean-build '<JSON>' --artifact-sha256 H --revision R --run-id RUN]
  delivery-gate record-assurance-drift --task-dir D --setup-revision R --finalize-revision R2 --drift-seq N --summary S --credential <assurance credentialId>
  delivery-gate accept-risk --task-dir D --target-type requirement|finding --target-id ID --confirmation user-explicit --summary S --credential <user credentialId> [--revision R] [--gap-id G]
  delivery-gate accept-risk --task-dir D --target-type finding --target-id ID --confirmation standing-authorization --summary S --credential <user credentialId>  # V6 代：须先由用户 preauthorize-risk 登记覆盖该 finding 的预授权（类别白名单 + 名额上限；severity 上限恒 non-blocker）
  delivery-gate preauthorize-risk --task-dir D --categories defect,boundary --max-findings N --summary S --credential <user credentialId> [--allow-duplicate true]  # V6 代：用户预先声明 standing 接受范围（持久授权声明；blocker 永不可预授权；同分类范围重复登记默认拒绝）
  delivery-gate evaluate --task-dir D [--revision R]
  delivery-gate revision --project-root P
  delivery-gate confirm-baseline --task-dir D --reason S --credential <user credentialId> [--revision R]
  delivery-gate confirm-history --task-dir D --reason S --intervals '<JSON:[{fromRevision,toRevision,rationale}]>' --credential <user credentialId> [--revision R]  # 用户署名解释历史 unknown 区间（区间须在 revision-provenance 派生结果中精确存在；不推进链条）
  delivery-gate upgrade-policy --task-dir D --invalidation-note S --summary S --credential <user credentialId>
  delivery-gate declare-independent --task-dir D --credential <user credentialId>
  delivery-gate supersede-prepare --task-dir D --predecessor-dir P --summary S --credential <user credentialId>
  delivery-gate supersede-commit --task-dir D --summary S --credential <user credentialId>
  delivery-gate supersede-cancel --task-dir D --cancelled-task-dir D2 --cancelled-prepare-event-id E --reason S --summary S --credential <user credentialId>
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

/** revision 区间哈希（confirm-history 的区间绑定）：规范化 JSON（键序固定）覆盖
 *  {fromRevision,toRevision}——区间与哈希同绑，事件签名之外再加一层区间身份校验。 */
function revisionIntervalSha256(fromRevision, toRevision) {
  return sha256Text(canonicalJson({ fromRevision, toRevision }));
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
  return join(CREDENTIAL_KEY_DIR(), parts[0], parts[1], `${parts[2]}.key`);
}

function writeCredentialKeys(groupSlug, taskId, pairs) {
  const dir = join(CREDENTIAL_KEY_DIR(), groupSlug, taskId);
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
// 外部契约调用类目录（V6 运行可用性升级）：文件由候选探测线创建，本 CLI 只读消费。
// 声明提前到模块顶层——OPTIONAL_POLICY_FILE_NAMES 在模块初始化时就要引用它
const EXTERNAL_CONTRACT_CLASSES_FILE = "external-contract-classes.json";

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
  if (existsSync(POLICY_USER_DIR())) {
    for (const name of POLICY_FILE_NAMES) {
      const override = join(POLICY_USER_DIR(), name);
      if (existsSync(override)) sources[name] = readPolicyJson(override, "用户级策略目录");
    }
  }
  // 可选策略文件：安装目录存在才加载；用户级覆盖同样可选
  for (const name of [EXTERNAL_CONTRACT_CLASSES_FILE]) {
    const installedFile = join(installed, name);
    if (!existsSync(installedFile)) continue;
    sources[name] = readPolicyJson(installedFile, "技能安装目录");
    const override = existsSync(POLICY_USER_DIR()) ? join(POLICY_USER_DIR(), name) : null;
    if (override !== null && existsSync(override)) sources[name] = readPolicyJson(override, "用户级策略目录");
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
    if (!seenRoleIds.has(actor)) fail(`roles.json 缺少内核必需角色 ${actor}。`, `保留 builder/assurance/user 三角色定义（密钥体系依赖）。角色词表封闭：三角色由 ACTORS / 签名密钥 / 事件 schema 三处共同约束，追加自定义角色需要改 delivery-gate 内核，不是策略文件可独立完成的扩展。`);
  }
  const kinds = sources["evidence-kinds.json"];
  requireRecord(kinds, "evidence-kinds.json");
  requireStringArray(kinds.evidenceKinds ?? kinds.kinds ?? [], "evidence-kinds.json 词表", { nonEmptyItems: true, unique: true });
  // 证据环境词表（机制二 §6.1）：fake-host | official-runner | real-host。缺省空 = 旧快照
  // 无该词表，环境检查按「不在词表」拒绝（带 requiredEnvironment 的断言在旧快照下取不了证
  // ——词表属验收契约的一部分，升级走策略升级通道）
  requireStringArray(kinds.environmentKinds ?? [], "evidence-kinds.json 环境词表", { nonEmptyItems: true, unique: true });
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
  // 外部契约调用类目录（可选策略文件）：词表形态校验。文件缺失 = 未登记调用类，外部契约
  // 的词表与环境底线校验整体关闭（消费方以 warnings 披露），此处不因缺失而失败
  const classes = sources[EXTERNAL_CONTRACT_CLASSES_FILE];
  if (classes !== undefined) {
    requireRecord(classes, `${EXTERNAL_CONTRACT_CLASSES_FILE}`);
    if (!Array.isArray(classes.classes) || classes.classes.length === 0) {
      fail(`${EXTERNAL_CONTRACT_CLASSES_FILE} 的 classes 必须是非空数组。`, `修正 ${join(SKILL_ROOT, "policies", EXTERNAL_CONTRACT_CLASSES_FILE)} 或用户级覆盖后重试。`);
    }
    if (classes.resolverKinds !== undefined) {
      requireStringArray(classes.resolverKinds, `${EXTERNAL_CONTRACT_CLASSES_FILE} resolverKinds`, { nonEmptyItems: true, unique: true });
    }
    const environmentVocabulary = sources["evidence-kinds.json"].environmentKinds ?? [];
    const seenClassIds = new Set();
    for (let index = 0; index < classes.classes.length; index += 1) {
      const entry = classes.classes[index];
      const label = `${EXTERNAL_CONTRACT_CLASSES_FILE} classes[${index}]`;
      requireRecord(entry, label);
      requireNonEmptyString(entry.id, `${label}.id`);
      if (seenClassIds.has(entry.id)) fail(`${label}.id 重复：${entry.id}。`, "调用类 id 必须唯一，修正后重试。");
      seenClassIds.add(entry.id);
      // 环境底线不得是 fake-host（自写模拟宿主不是任何能力的底线档位）
      requireEnum(entry.minEnvironment, environmentVocabulary.filter((kind) => kind !== "fake-host"), `${label}.minEnvironment`);
      // 蕴含观察类字段名以策略文件为准（impliesObservationClasses）；缺省空数组 = 无蕴含
      if (entry.impliesObservationClasses !== undefined) requireStringArray(entry.impliesObservationClasses, `${label}.impliesObservationClasses`, { unique: true });
      // 静态信号清单由候选探测线消费（detect-external-contracts 的匹配源）；本 CLI 只校验
      // 它是数组，不解释其内容（信号语义归探测线）
      if (entry.staticSignals !== undefined && !Array.isArray(entry.staticSignals)) {
        fail(`${label}.staticSignals 必须是数组。`, `把 ${label}.staticSignals 改为信号对象数组后重试。`);
      }
    }
    // 蕴含关系必须指向已登记调用类（否则蕴含观察义务无法对账）
    for (const entry of classes.classes) {
      for (const implied of entry.impliesObservationClasses ?? []) {
        if (!seenClassIds.has(implied)) {
          fail(`${EXTERNAL_CONTRACT_CLASSES_FILE} 中 ${entry.id} 的 impliesObservationClasses 含未登记调用类 ${implied}。`, "把蕴含目标改为已登记的调用类 id，或先登记该调用类后重试。");
        }
      }
    }
  }
  return true;
}

function policySnapshotDocument(sources) {
  // 快照 = 五个策略文件解析后的规范内容；快照哈希 = 该文档的 canonicalJson sha256。
  // 可选策略文件（外部契约调用类目录）落盘即进快照——与其余策略同受冻结保护
  // （改词表 = 走策略升级通道，不得静默替换）
  const document = {};
  for (const name of POLICY_FILE_NAMES) document[name] = sources[name];
  if (sources[EXTERNAL_CONTRACT_CLASSES_FILE] !== undefined) document[EXTERNAL_CONTRACT_CLASSES_FILE] = sources[EXTERNAL_CONTRACT_CLASSES_FILE];
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
  // 任务分级（设计 §13）：a/b/c additive 可选字段。init 在该升级后统一写入（缺省 b）；
  // 字段缺失 = 升级前创建的任务，按 b 处理。该字段同时是「升级后新建任务」的判定锚——
  // 外部契约相关的新静态检查只对带该字段的任务生效
  if (Object.hasOwn(task, "deliveryProfile")) {
    requireEnum(task.deliveryProfile, DELIVERY_PROFILES, "task.json.deliveryProfile");
    taskKeys.push("deliveryProfile");
  }
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
// taskDir = 任务目录（外部契约检查读其中的候选快照与环境快照产物）；
// sources = 已解析的策略包（调用方先加载再传入：外部契约检查要读调用类环境底线词表）
function validateAcceptance(acceptance, task, taskDir, sources) {
  requireRecord(acceptance, "acceptance.json");
  const acceptanceFields = [
    "schemaVersion", "acceptanceVersion", "taskId", "projectRoot", "objective", "requirements",
    "nonGoals", "riskLevel", "exploratoryReview", "reviewDimensions",
  ];
  if (acceptance.schemaVersion === 2) acceptanceFields.push("adversarialForms");
  // 外部契约登记与候选处置表（V6 运行可用性升级 §4.1/§4.2）：additive 可选顶层字段——
  // 缺省不限制（未声明外部契约的验收包与升级前旧任务不受新检查约束）；声明非空
  // externalContracts 时 externalContractReview 必填（候选处置随验收包冻结）
  const optionalAcceptanceFields = ["externalContracts", "externalContractReview"];
  const unknownAcceptanceFields = Object.keys(acceptance).filter((key) => !acceptanceFields.includes(key) && !optionalAcceptanceFields.includes(key));
  const missingAcceptanceFields = acceptanceFields.filter((key) => !Object.hasOwn(acceptance, key));
  if (missingAcceptanceFields.length > 0 || unknownAcceptanceFields.length > 0) {
    const parts = [];
    if (missingAcceptanceFields.length > 0) parts.push(`缺少字段 ${missingAcceptanceFields.join(", ")}`);
    if (unknownAcceptanceFields.length > 0) parts.push(`含未知字段 ${unknownAcceptanceFields.join(", ")}`);
    fail(
      `acceptance.json 形态非法：${parts.join("；")}。`,
      `按契约补齐必需字段并删除未知字段后重试；acceptance.json 可选字段为 ${optionalAcceptanceFields.join(", ")}。`,
    );
  }
  if (acceptance.schemaVersion !== 1 && acceptance.schemaVersion !== 2) {
    fail("acceptance.json 的 schemaVersion 必须为 1 或 2。", "旧任务保留 1；带断言与反例场景的验收包使用 2 后重试 validate-acceptance。");
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
        // 可选键（合并稿 §4.1「允许记录不适用理由」+ §10.2 断言依赖声明 + 机制二 §6.1 环境要求）：
        // qualifierNotApplicable = 限定条件不适用登记（带非空理由，豁免该限定条件的反例场景要求）；
        // dependsOn = 断言声明依赖的实现增量/机制条款/测试资产（修复轮影响范围机器推导的输入）；
        // requiredEnvironment = 宿主类断言的结构化环境要求（additive 可选字段，不改 schemaVersion；
        //   缺省不限制；变更仍随验收包递增 acceptanceVersion 走既有修订通道）
        requireEventKeys(
          assertion,
          ["id", "statement", "qualifiers", "given", "when", "then", "adversarialFormRefs", "testAssetRefs", "qualifierNotApplicable", "dependsOn", "requiredEnvironment"],
          ["qualifierNotApplicable", "dependsOn", "requiredEnvironment"],
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
        // 环境要求（机制二 §6.1）：kind ∈ official-runner | real-host（环境词表见策略包
        // evidence-kinds.json 的 environmentKinds，含 fake-host 共三档）；capability 可选。
        // official-runner 证明官方命令解析/注册/事件语义；完整用户交互或进程行为要求 real-host。
        if (Object.hasOwn(assertion, "requiredEnvironment")) {
          const requiredEnvironment = assertion.requiredEnvironment;
          const requiredEnvironmentLabel = `${assertionLabel}.requiredEnvironment`;
          requireRecord(requiredEnvironment, requiredEnvironmentLabel);
          // capability 可选（requireExactKeys 不区分可选键，键集合手工校验）
          const unknownEnvironmentKeys = Object.keys(requiredEnvironment).filter((key) => !["kind", "capability"].includes(key));
          if (unknownEnvironmentKeys.length > 0) {
            fail(`${requiredEnvironmentLabel} 含未知字段 ${unknownEnvironmentKeys.join(", ")}。`, `按契约删除未知字段后重试；${requiredEnvironmentLabel} 允许的字段为 kind（必填）、capability（可选）。`);
          }
          requireEnum(requiredEnvironment.kind, ["official-runner", "real-host"], `${requiredEnvironmentLabel}.kind`);
          if (Object.hasOwn(requiredEnvironment, "capability")) {
            requireNonEmptyString(requiredEnvironment.capability, `${requiredEnvironmentLabel}.capability`);
          }
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
  // 外部契约结构层静态检查（设计 §5.1 检查 1/4/5/6/7/9）：纯计算，随每次加载执行。
  // 声明层（候选处置表与 resolved 权威快照）只在 validate-acceptance 命令执行——
  // 它要读候选快照并跑 resolver，属声明期门禁，不放进入口路径
  if (Object.hasOwn(acceptance, "externalContracts")) {
    validateExternalContractStructure(acceptance, sources);
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
    // testCommand 必填（redesign 3.4/5.3：每个增量有自己的测试命令；裁决器要求回执覆盖全部增量）；
    // kind 可选（V6 运行可用性升级 §7.1 契约冒烟类型）——能力绑定不写在增量里，唯一来源
    // 仍是断言 requiredEnvironment.capability
    const itemAllowed = ["id", "title", "requirementIds", "testCommand"];
    const itemOptional = ["kind"];
    const unknownItemFields = Object.keys(item).filter((key) => !itemAllowed.includes(key) && !itemOptional.includes(key));
    const missingItemFields = itemAllowed.filter((key) => !Object.hasOwn(item, key));
    if (unknownItemFields.length > 0 || missingItemFields.length > 0) {
      const parts = [];
      if (missingItemFields.length > 0) parts.push(`缺少字段 ${missingItemFields.join(", ")}`);
      if (unknownItemFields.length > 0) parts.push(`含未知字段 ${unknownItemFields.join(", ")}`);
      fail(`${label} 形态非法：${parts.join("；")}。`, `按契约补齐必需字段并删除未知字段后重试；increments.items 可选字段为 ${itemOptional.join(", ")}。`);
    }
    if (Object.hasOwn(item, "kind")) {
      // 词表当前只登记 contract-smoke 一个值；新增增量类型是显式动作（改这里 + 同步消费方），
      // 不接受任意字符串
      requireEnum(item.kind, ["contract-smoke"], `${label}.kind`);
    }
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
  // 契约冒烟增量检查（设计 §5.1 第 8 条）：验收含 essential 外部契约时必须存在
  // kind=contract-smoke 增量——放在本函数是因为增量结构在此校验，与 validate-acceptance
  // 是同一条命令的同一次执行
  validateContractSmokeIncrement(increments, acceptance);
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
  // channel = 事件来源（workflow|manual，信封字段；历史事件无该键按 legacy 读）
  allowed.push("channel");
  if (Object.hasOwn(event, "channel")) requireEnum(event.channel, ["workflow", "manual"], "event.channel");
  const optional = [...(OPTIONAL_EVENT_FIELDS[event.type] ?? []), "domain", "channel"];
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
      // 外部契约能力绑定（§6.3）：元素 = 「契约id:能力id」限定 id（单契约包允许裸能力 id，
      // 语义层按验收包核对存在性）；runtimeProbe 标记该证据由真实 runner/宿主驱动产生
      if (Object.hasOwn(event, "contractCapabilityIds")) requireStringArray(event.contractCapabilityIds, "event.contractCapabilityIds", { nonEmptyItems: true, unique: true });
      if (Object.hasOwn(event, "runtimeProbe")) requireBoolean(event.runtimeProbe, "event.runtimeProbe");
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
      // 空关联 boundary 的不影响任何需求论证：非空字符串（存在性由 fold 层护栏裁决）
      if (Object.hasOwn(event, "emptyScopeRefutation")) requireNonEmptyString(event.emptyScopeRefutation, "event.emptyScopeRefutation");
      // authority 反驳组（§9）：结构命中外部契约时 authorityBacked 必须为 true 且
      // authorityHash / authorityObservationRef 非空（三段必填组的完整性在此保证；
      // 「是否结构命中」的判定在 fold 层——需要验收包才能反查断言）
      if (Object.hasOwn(event, "contractCapabilityIds")) requireStringArray(event.contractCapabilityIds, "event.contractCapabilityIds", { nonEmptyItems: true, unique: true });
      if (Object.hasOwn(event, "authorityBacked")) requireBoolean(event.authorityBacked, "event.authorityBacked");
      if (Object.hasOwn(event, "authorityHash")) requireSha256(event.authorityHash, "event.authorityHash");
      if (Object.hasOwn(event, "authorityObservationRef")) requireNonEmptyString(event.authorityObservationRef, "event.authorityObservationRef");
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
        // V6 代：standing-authorization 仅在「finding 目标 + 有效风险预授权覆盖」时合法，
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
      // 历史 unknown 区间确认（confirm-history）：区间形态与哈希绑定校验——from/to 与
      // intervalSha256 必须同时存在且哈希与区间一致（哈希覆盖规范化 JSON，防区间被
      // 误配到另一段变化）
      if (Object.hasOwn(event, "explainedUnknownIntervals")) {
        const intervals = event.explainedUnknownIntervals;
        if (!Array.isArray(intervals) || intervals.length === 0) {
          fail("RevisionBaselineConfirmed.explainedUnknownIntervals 须为非空数组（无区间确认走 confirm-baseline）。", "删除该字段改用 confirm-baseline，或传入至少一段区间后重试。");
        }
        for (let index = 0; index < intervals.length; index += 1) {
          const interval = intervals[index];
          const label = `event.explainedUnknownIntervals[${index}]`;
          requireRecord(interval, label);
          requireNonEmptyString(interval.fromRevision, `${label}.fromRevision`);
          requireNonEmptyString(interval.toRevision, `${label}.toRevision`);
          requireSha256(interval.intervalSha256, `${label}.intervalSha256`);
          requireNonEmptyString(interval.rationale, `${label}.rationale`);
          if (interval.intervalSha256 !== revisionIntervalSha256(interval.fromRevision, interval.toRevision)) {
            fail(`${label}.intervalSha256 与区间 from/to 不一致。`, "按 confirm-history 命令重新计算区间哈希（区间经命令登记，不允许手拼事件）后重试。");
          }
        }
      }
      break;
    case "RevisionOpened":
      requireEnum(event.target, ["acceptance"], "event.target");
      requireNonEmptyString(event.reason, "event.reason");
      break;
    case "ExternalAuthorityDeclared":
      requireNonEmptyString(event.contractId, "event.contractId");
      requireNonEmptyString(event.resolverKind, "event.resolverKind");
      requireNonEmptyString(event.locator, "event.locator");
      requireSha256(event.snapshotSha256, "event.snapshotSha256");
      break;
    case "EnvironmentBaselineConfirmed":
      requireSha256(event.newAuthoritySnapshotSha256, "event.newAuthoritySnapshotSha256");
      requireStringArray(event.contractIds, "event.contractIds", { nonEmptyItems: true, unique: true });
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
  // 不可携哈希的事件类型（FindingRaised 等）引用已被哈希登记的证据文件属常态
  // （上方注释语义：发现类不要求携带哈希、本身也不登记哈希）——检查②只约束可携
  // 哈希类型的再登记；发现类跳过既有绑定对账，覆盖写防线①③与磁盘可读校验不受
  // 影响。实测：candidate-build 的 builder 自报发现按设计排在 ImplementationRecorded
  // 之后（同一报告路径），被检查②误拦致 build-failed
  if (artifactSha256 === null && !ARTIFACT_HASH_CAPABLE_TYPES.has(event.type)) return;
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

  // 策略先于验收包解析：外部契约静态检查要读调用类环境底线词表（策略包第三层数据）
  const sources = world.policySnapshot ?? loadPolicySources();
  validatePolicySources(sources);
  world.policy = sources;

  if (requirePackage) {
    const acceptancePath = join(taskDir, "acceptance.json");
    const acceptanceText = readText(
      acceptancePath,
      "acceptance.json",
      "运行 delivery-v6/acceptance-design-v6 生成 acceptance.json，或从任务备份恢复后重试。",
    );
    let acceptance;
    try {
      acceptance = JSON.parse(acceptanceText);
    } catch (error) {
      fail(`acceptance.json 不是合法 JSON：${error.message}。`, `修复 ${acceptancePath} 的 JSON 语法后重试当前命令。`);
    }
    validateAcceptance(acceptance, task, taskDir, sources);
    const increments = readJson(join(taskDir, "increments.json"), "increments.json");
    validateIncrements(increments, acceptance);
    world.acceptance = acceptance;
    world.increments = increments;
    world.packageSha256 = acceptancePackageSha256(acceptance, increments);
  }

  if (withEvents) {
    const parsed = parseEventRecords(taskDir, keys);
    world.entries = parsed.entries;
    world.eventsText = parsed.text;
    // 加载折算容忍历史护栏违规（V4 代任务目录可读；违规留档 fold.guardrailWarnings）——
    // 写入路径 appendEvent 的 prospective 折算保持严格（新写入当时被拒）
    world.fold = foldEvents(world, world.entries, { guardrailStrict: false });
    // 篡改检测（V6 写入防护的加载侧）：最近批准绑定的验收包哈希与当前盘上包不一致，且其后
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

// 逐事件折叠。失效范围（redesign 3.9；V6 代增补见标注）：
//   AcceptanceReviewed/Approved —— 当前版本 + 包哈希 + intent + 快照（verdict 端组合判定）
//   DesignApproved —— 当前版本（方案包哈希清单是声明值，机器不核对文件内容——方案包改动后
//     须重新 record-design-approved，人工纪律保证；见 state-and-events.md 失效范围表）
//   ImplementationRecorded —— 按版本有效、跨 revision 保留
//   EvidenceRecorded / AssuranceCompleted / ExplorationCompleted / FindingResolved / RiskAccepted
//     —— 当前版本 + 当前 revision（revision 过滤在 verdict，fold 只做版本与结构校验）
//   ResolutionReaffirmed（V6 代）—— 当前版本 + 当前 revision（与 FindingResolved 同口径：
//     修复被回退时重认领同样失效，须 assurance 重新核对后再次登记）
//   FindingRaised —— 按版本持久；继承发现同语义且跨版本持久
//   RiskPreauthorized（V6 代）—— 持久事实（授权声明不是证据；名额用量按事件流顺序累计）
//   AssuranceRevisionDrift / RevisionBaselineConfirmed / IndependentTaskDeclared /
//   TaskSuperseded / TaskSupersedeCancelled —— 持久事实
// ── 风险预授权匹配（V6 代）：standing RiskAccepted(finding) 逐条消耗预授权名额 ──
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
    // finding 域态推导的跨版本事实（kernel/rules.json domains.finding 转移表的 from 态来源）：
    // closures 收全部版本的 FindingResolved / ResolutionReaffirmed（fold.findings 只收当前
    // 版本，跨版本 reopen 时被重开条目不在其中）；findingRiskAcceptedIds 收全部版本的
    // finding 风险接受（fold.risks 只收当前版本，同理由）
    findingClosures: [],
    findingRiskAcceptedIds: new Set(),
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
    // 外部权威登记与环境基线确认（V6 运行可用性升级）：持久事实，不按版本/revision 过滤
    externalAuthorities: [],
    environmentBaselines: [],
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
          // 外部契约能力绑定存在性（§6.3）：contractCapabilityIds 的元素必须能在当前验收包
          // 的 externalContracts 能力清单中解析到（qualified 精确命中或裸尾唯一命中——
          // resolveContractCapabilityId 单源）——防自造能力名把 runtime 义务挂到不存在的
          // 能力上。验收包未声明外部契约时该字段无意义，直接拒绝
          if (Array.isArray(event.contractCapabilityIds) && event.contractCapabilityIds.length > 0) {
            const unresolved = event.contractCapabilityIds
              .map((id) => ({ id, resolved: resolveContractCapabilityId(world.acceptance, String(id)) }))
              .filter((item) => !item.resolved.ok);
            if (unresolved.length > 0) {
              fail(
                `${lineLabel} 的 contractCapabilityIds 含无法解析的能力：${unresolved.map((item) => `${item.id}（${item.resolved.reason}）`).join("；")}。`,
                "多契约包或裸 id 歧义时必须用「契约id:能力id」限定形式重登（能力 id 取 acceptance.externalContracts[].capabilities[].id）；验收包未声明 externalContracts 时删除该字段。",
              );
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
            // a 级契约任务的维度由 IA 机器降档（只取「外部契约 / 故障形态」两类）——降档词表
            // 与验收 reviewDimensions 不一致时在此响亮失败，恢复消息须同时给出两条出路，
            // 不能只让调用方「补齐维度」（降档侧补不回来）
            const profileNarrowed = world.task.deliveryProfile === "a" && externalContractsOf(world.acceptance).length > 0;
            fail(
              `${lineLabel} 未完整覆盖 acceptance.reviewDimensions。`,
              profileNarrowed
                ? `两因二选一：① 验收声明的 reviewDimensions（${world.acceptance.reviewDimensions.join(", ")}）超出 a 级机器降档词表（${PROFILE_A_EXPLORATION_DIMENSIONS.join(" / ")}）——收窄验收维度后重新起草并递增 acceptanceVersion；② 确需更多探索维度——由用户执行 ${GATE_COMMAND} set-delivery-profile --task-dir <dir> --profile b --credential <user credentialId> 改为 b 级后重跑探索。补齐维度 ${world.acceptance.reviewDimensions.join(", ")} 后重新追加 ExplorationCompleted 亦允许（允许同时申报验收外额外维度）。`
                : `补齐维度 ${world.acceptance.reviewDimensions.join(", ")} 后重新追加 ExplorationCompleted；允许同时申报验收外额外维度。`,
            );
          }
          fold.explorations.push(event);
        }
        break;
      case "FindingRaised": {
        if (raisedFindings.get(event.findingId) === event.acceptanceVersion) {
          fail(`${lineLabel} 重复分配 findingId=${event.findingId} 且内容不同。`, "为新发现使用新的 F- 格式 id；若这是同一事件，请恢复原事件内容与 eventId 以实现幂等。");
        }
        // reopenOf 重报的 from 态检查（finding 域转移表：reopen 的合法 from =
        // resolved / reaffirmed / risk-accepted）。重报生成新 findingId、不改变被重开条目的
        // 态——被重开条目仍 open（从未关闭、从未接受风险）时重报是表外转移 open→open：
        // 凭空多出一个重报条目而原发现照样 open，收敛判定被重复计数污染。指向未登记 id 的
        // 重报（from 态不存在）同拒
        if (typeof event.reopenOf === "string" && event.reopenOf !== "") {
          // 存在性口径与 FindingRaised 同源：本地登记（raisedFindings）或任务替换继承发现
          //（TaskSuperseded prepare 视同 raise，同样进 raisedFindings）都算已登记
          if (!raisedFindings.has(event.reopenOf)) {
            fail(
              `${lineLabel} 的 reopen-of 指向未登记的发现 ${event.reopenOf}。`,
              `确认被重开的 findingId 后重试；全新发现不带 --reopen-of 直接登记。`,
            );
          }
          const reopenState = findingLifecycleStateOf(fold, event.reopenOf);
          if (reopenState === "open") {
            fail(
              `${lineLabel} 表外转移：被重开的发现 ${event.reopenOf} 当前处于 open 态，不接受 reopen（该态合法事件：${findingLegalEventsOf("open").join(" / ")}）。`,
              `open 态的发现直接继续处置（${GATE_COMMAND} resolve-finding --finding-id ${event.reopenOf} 或 accept-risk）；重报只用于已关闭/已接受风险的发现在判据变化后复发。`,
            );
          }
          // reopen 谓词接线（状态机设计：reopen 边 requires criterionChanged，decider=core）。
          // 判据环境两维：验收版本变化（判据本身变）或代码 revision 变化（修复后复发——
          // 缺陷族 reopenOf 不重复计数通道）；同版本同 revision 重开 = 无变化重开，拒绝
          if (
            !criterionChangedSinceResolution(
              world.entries.map((entry) => entry.record),
              { findingId: event.reopenOf, currentAcceptanceVersion: event.acceptanceVersion, currentRevision: event.revision },
            )
          ) {
            fail(
              `${lineLabel} 的 reopen 谓词不满足：被重开的发现 ${event.reopenOf} 关闭后判据环境未变化（同验收版本且同代码 revision）——criterionChanged=false（状态机设计 finding 域 reopen 边机器谓词）。`,
              `判据变化后（验收版本递增或代码 revision 变化）重开；同版本同 revision 的新问题登记为新发现（不带 --reopen-of）。`,
            );
          }
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
        // 护栏①（V6 定级护栏）：boundary 禁令——关联需求已有断言级判据明文覆盖的行为，
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
        // 护栏②（V6 空关联护栏，V5 完整性设计 §5.4）：boundary 且 requirementIds=[] 的发现
        // 必须附 emptyScopeRefutation（证明该发现不影响任何需求的论证）——空关联绕过护栏①
        //（护栏①只检查已关联需求的断言覆盖，空数组使其恒不触发；GLM F-5 实证：真实宿主
        // 命令解析问题以此形态归 boundary 规避定级）。同护栏①只在 schema 2 新写入执行；
        // 历史记录加载容忍（guardrailWarnings 留档）。开关读 kernel rules.json 的
        // guardrails.emptyScopeBoundaryRequiresRefutation，未登记时默认启用（!== false）——
        // 与其余护栏键一致的可关闭形态，rules.json 键由内核规则统一登记后即可显式管理
        if (
          KERNEL_RULES.guardrails.emptyScopeBoundaryRequiresRefutation !== false &&
          current && world.acceptance.schemaVersion === 2 && event.category === "boundary" &&
          Array.isArray(event.requirementIds) && event.requirementIds.length === 0
        ) {
          if (!Object.hasOwn(event, "emptyScopeRefutation")) {
            const message = `${lineLabel} 的 category=boundary 且 requirementIds 为空（空关联）但未附 emptyScopeRefutation——空关联不得成为绕过定级护栏的通道，必须证明该发现不影响任何需求。`;
            if (guardrailStrict) {
              fail(message, `三选一：① 补充 --empty-scope-refutation "<该发现不影响任何需求的论证>" 后重登；② 该发现实际影响需求时，把对应需求 id 填入 --requirement-ids 重登（已断言覆盖的需求禁归 boundary，见护栏①）；③ 判据本身无法覆盖该行为时走 open-revision 修订验收（递增 acceptanceVersion 重审重批）。`);
            }
            fold.guardrailWarnings.push(`${message}（历史记录，写入时未拦）`);
          }
        }
        // 护栏④（V6 运行可用性升级 §9）：外部契约 authority 反驳必填组——机器可判的结构命中
        // 只有两种：contractCapabilityIds 非空，或 requirementIds 反查到的断言含
        // requiredEnvironment.capability。命中时 authorityBacked 必须为 true 且 authorityHash
        // 与 authorityObservationRef 非空；否则拒绝写入（拿平台文字文档 / 自写类型 / mock
        // 行为自我证明的弱关闭通道由此封住）。只对新写入执行；历史记录在加载折算时降级为
        // guardrailWarnings 留档（与护栏①②同模式）
        if (current && Array.isArray(event.contractCapabilityIds) && event.contractCapabilityIds.length > 0) {
          const unresolvedIds = event.contractCapabilityIds
            .map((id) => ({ id, resolved: resolveContractCapabilityId(world.acceptance, String(id)) }))
            .filter((item) => !item.resolved.ok);
          if (unresolvedIds.length > 0) {
            fail(
              `${lineLabel} 的 contractCapabilityIds 含无法解析的能力：${unresolvedIds.map((item) => `${item.id}（${item.resolved.reason}）`).join("；")}。`,
              "多契约包或裸 id 歧义时必须用「契约id:能力id」限定形式（能力 id 取 acceptance.externalContracts[].capabilities[].id）；裸 id 仅在当前任务能力全表中唯一命中时可用。",
            );
          }
        }
        const structuralContractHit = current && (
          (Array.isArray(event.contractCapabilityIds) && event.contractCapabilityIds.length > 0) ||
          (world.acceptance.schemaVersion === 2 && event.requirementIds.some((requirementId) => {
            const requirement = requirementById(world.acceptance, requirementId);
            return requirement !== undefined && (requirement.assertions ?? []).some((assertion) =>
              typeof assertion.requiredEnvironment?.capability === "string" && assertion.requiredEnvironment.capability !== "");
          }))
        );
        if (structuralContractHit) {
          const complete = event.authorityBacked === true &&
            typeof event.authorityHash === "string" && /^[0-9a-f]{64}$/.test(event.authorityHash) &&
            typeof event.authorityObservationRef === "string" && event.authorityObservationRef.trim() !== "";
          if (!complete) {
            const message = `${lineLabel} 结构命中外部契约（contractCapabilityIds 非空，或关联需求断言带 requiredEnvironment.capability）但 authority 反驳组缺失或不完整（authorityHash 须为 64 位十六进制 aggregateHash）——外部行为反驳必须引用权威工件。`;
            if (guardrailStrict) {
              fail(message, `三选一：① 补 --authority-backed --authority-hash <当前权威 aggregateHash> --authority-observation-ref <快照文件+符号/行 或真实 probe case id> 后重登；② 该发现与外部契约无关时删除 contractCapabilityIds 并确认关联需求断言不带 requiredEnvironment.capability；③ 判据本身缺外部契约依据时走 open-revision 修订验收。`);
            }
            fold.guardrailWarnings.push(`${message}（历史记录，写入时未拦）`);
          }
          // authorityHash 同源核对（R1-09 最小形态）：任务目录在盘当前权威快照（指针指向
          // 的 environment-contracts/<sha>.json）可解析时，把声明值与命中契约的当前
          // aggregateHash 对账——「当前权威 aggregateHash」是机器可核对的事实，不是纯文案；
          // 快照缺席（无外部契约任务 / 指针缺失 / 快照损坏）时退回形态校验，真实性靠人工
          // 核查（恢复文案已注明）。仅核对显式认领（contractCapabilityIds）的契约——
          // requiredEnvironment.capability 侧的契约归属存在跨契约歧义，不在此判定
          if (complete && current && Array.isArray(event.contractCapabilityIds) && event.contractCapabilityIds.length > 0) {
            const claimedContractIds = new Set();
            for (const id of event.contractCapabilityIds) {
              const resolved = resolveContractCapabilityId(world.acceptance, String(id));
              if (resolved.ok) claimedContractIds.add(resolved.contractId);
            }
            const authorityHashes = currentAuthorityHashesByContract(world.taskDir);
            if (authorityHashes !== null) {
              const mismatched = [...claimedContractIds].filter((contractId) => {
                const hash = authorityHashes.get(contractId);
                return hash !== undefined && hash !== event.authorityHash;
              });
              if (mismatched.length > 0) {
                const message = `${lineLabel} 的 authorityHash 与契约 ${mismatched.join(", ")} 当前权威 aggregateHash 不一致——外部行为反驳必须引用当前权威工件（resolver 复核快照在盘，机器可核对）。`;
                if (guardrailStrict) {
                  fail(message, `重跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir <taskDir> --project-root <projectRoot> --write 刷新权威快照后，以当前快照该契约的 aggregateHash 作为 --authority-hash 重登；权威确实变化时先由用户 confirm-environment-baseline 接环境历史链，再按新权威重登。`);
                }
                fold.guardrailWarnings.push(`${message}（历史记录，写入时未拦）`);
              }
            }
          }
        }
        // 护栏③（V6 定级护栏）：定级改判熔断——同一条目（reopenOf 根）累计 (category,severity)
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
        // from 态检查（finding 域转移表：FindingResolved 合法 from = open）。当前态非 open
        // 时仅当本次事件 revision 与最后一次关闭/重认领不同（旧关闭在新 revision 失效、判定
        // 语义回 open——openFindingsFromEvents 的 revision 口径）才合法；同 revision 重复
        // 关闭是表外转移（resolved→resolved / reaffirmed→resolved），拒绝
        const resolveFromState = findingLifecycleStateOf(fold, event.findingId);
        if (resolveFromState !== "open") {
          const lastClosure = fold.findingClosures.filter((item) => item.findingId === event.findingId).at(-1);
          const invalidated = lastClosure !== undefined && typeof event.revision === "string" && lastClosure.revision !== event.revision;
          if (!invalidated) {
            fail(
              `${lineLabel} 表外转移：发现 ${event.findingId} 当前处于 ${resolveFromState} 态，不接受事件 FindingResolved（该态合法事件：${findingLegalEventsOf(resolveFromState).join(" / ")}）。`,
              `已关闭的发现不能重复解决：确需重开走 ${GATE_COMMAND} record-finding --reopen-of ${event.findingId} 重报后在新条目上处置；本次登记与原关闭同 revision（关闭仍有效）时直接删除重复事件。`,
            );
          }
        }
        fold.findingClosures.push(event);
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
          // from 态检查（finding 域转移表：ResolutionReaffirmed 合法 from = open——语义是
          // 旧关闭在新 revision 失效后重认领）。同 revision 内重复重认领（或关闭未失效就
          // 重认领）是表外转移，拒绝
          const lastClosure = fold.findingClosures.filter((item) => item.findingId === event.findingId).at(-1);
          if (lastClosure !== undefined && lastClosure.revision === event.revision) {
            fail(
              `${lineLabel} 表外转移：发现 ${event.findingId} 的关闭（${lastClosure.type}，revision ${lastClosure.revision}）仍然有效，不接受事件 ResolutionReaffirmed（重认领只用于 revision 前进使旧关闭失效的场景）。`,
              `以 evaluate 输出的 reaffirmableFindings 清单为准：旧关闭失效（finding 回 open）后按清单里的 originalResolutionEventId 重认领；关闭仍有效时无需重认领，误登记直接删除。`,
            );
          }
        }
        fold.findingClosures.push(event);
        if (current && finding) finding.reaffirmations.push(event);
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
                "由 assurance-repair-loop-v6 引擎在修复提交后重跑全部增量 testCommand，随 RepairRoundRecorded 逐条登记回执后重试。",
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
        // confirm-history（携带 explainedUnknownIntervals）只解释历史 unknown 区间，
        // 不是新基线：不进 baselines，不得重置漂移链计数
        if (!(Array.isArray(event.explainedUnknownIntervals) && event.explainedUnknownIntervals.length > 0)) {
          fold.baselines.push(event);
        }
        break;
      case "RevisionOpened":
        fold.revisionOpens.push(event);
        break;
      case "ExternalAuthorityDeclared":
        // 用户登记的本地/可执行权威：持久事实（本地权威登记先于验收包存在）
        fold.externalAuthorities.push(event);
        break;
      case "EnvironmentBaselineConfirmed":
        fold.environmentBaselines.push(event);
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
        // finding 目标的风险接受收全部版本（与 findingClosures 同理由）：findingLifecycleStateOf
        // 凭本集合判 risk-accepted 态——缺写入点会让「已接受风险的发现在判据变化后复发」的
        // reopen 通道（gate 自己的恢复文案指引）永远被判 open 而拒绝
        if (event.targetType === "finding" && typeof event.targetId === "string" && event.targetId !== "") {
          fold.findingRiskAcceptedIds.add(event.targetId);
        }
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
            // V6 代：standing-authorization 的风险接受必须落在预授权范围内（名额按事件流
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

// ── 循环尝试预算（机制四 §8.1 gate 侧）：读任务目录 loop-attempts.jsonl 的 started 计数 ──
// 文件缺失 = 无尝试登记（返回零计数）；解析容错与去重走 kernel-judgments 单源
function readLoopAttemptsBudget(taskDirValue, loop) {
  const filePath = join(taskDirValue, "loop-attempts.jsonl");
  const capKey = LOOP_BUDGET_CAP_KEYS[loop];
  const cap = capKey !== undefined ? KERNEL_RULES.budgets[capKey] : null;
  if (!existsSync(filePath)) return { started: 0, byOutcome: {}, cap, exceeded: false, loop };
  return { loop, ...loopAttemptsBudget(parseLoopAttemptsText(readFileSync(filePath, "utf8")), { loop, cap }) };
}

// pending-actions.json 的 open 条目读取（义务派生输入）。pending 实体由 delivery-core
// pending 命令管理，gate 只读不写：文件缺失 = 无待办；解析失败 = fail loud——损坏文件中
// 的 blocking 待办不得按不存在处理（设计 §14「未知默认不接受交付」），静默返回空清单会把
// 损坏文件的待办全部洗掉、gate 照常 accepted
function readPendingItems(taskDirValue) {
  const filePath = join(taskDirValue, "pending-actions.json");
  if (!existsSync(filePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `pending-actions.json 解析失败（${error.message}）：损坏文件中的 blocking 待办不得按不存在处理。`,
      `修复 ${filePath} 的 JSON 语法后重跑 evaluate（权威源 = 该文件；修复前不得依据本次输出判定交付义务）`,
    );
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.filter((item) => item !== null && typeof item === "object" && item.status === "open");
}

// ── 证据环境元数据（机制二 §6.1/§6.2 gate 侧）──
// 宿主类证据的 artifact 为 JSON，内含 environment: {kind, name, version, source, sourceHash, driver}。
// 环境词表（fake-host | official-runner | real-host）落策略包 evidence-kinds.json（environmentKinds），
// 随策略快照受冻结保护——执行者不能靠自造 kind 词表放宽要求。
function readEvidenceEnvironment(world, event) {
  // artifact 缺失/不可解析/无 environment 对象 → null（无环境元数据 = 模拟环境同级处理）
  if (typeof event.artifact !== "string" || event.artifact === "") return null;
  const filePath = isAbsolute(event.artifact) ? resolve(event.artifact) : resolve(world.taskDir, event.artifact);
  if (!existsSync(filePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const environment = parsed.environment;
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) return null;
  return environment;
}

function environmentSatisfies(world, environment, required) {
  const vocabulary = world.policy["evidence-kinds.json"].environmentKinds ?? [];
  if (typeof environment.kind !== "string" || !vocabulary.includes(environment.kind)) {
    return { ok: false, reason: `environment.kind=${JSON.stringify(environment.kind ?? null)} 不在策略环境词表（${vocabulary.join(" / ") || "空"}）内` };
  }
  // kind 匹配：real-host 要求必须真机证据；official-runner 要求接受 official-runner 或
  // real-host（真实环境是官方运行器的超集——强证据不因要求较宽而降级，§6.2 分层规则）
  const kindOk = required.kind === "real-host" ? environment.kind === "real-host" : environment.kind === "official-runner" || environment.kind === "real-host";
  if (!kindOk) {
    return { ok: false, reason: `证据环境 kind=${environment.kind} 不满足断言要求 ${required.kind}（模拟环境不能独立证明宿主类断言）` };
  }
  if (typeof environment.source !== "string" || environment.source.trim() === "") {
    return { ok: false, reason: "environment.source 缺失（须登记权威来源：真实 SDK / 宿主源码 / 正式文档）" };
  }
  // capability 终判（设计 §6.1 capability 字段，双侧核对中的 gate 侧）：IA 登记侧
  //（independent-assurance 的 satisfiesRequiredEnvironment）只降级「已声明且不含要求值」
  // 的证据、未声明时不降级；gate 终判侧保守兜住该缺口——required.capability 存在而证据未声明
  // 能力覆盖即不满足（能力维度无法证伪时不得凭 kind 单独放行，否则 IA 侧降级会被
  // evaluate 的 verified 洗掉）。
  // capability 词法归一化（双形态）：验收包写 requiredEnvironment.capability，gate 其余
  // 位置（contractCapabilityIds 等）同时使用裸 id 与 qualified 形态「契约id:能力id」，两侧
  // 来源不同（designer 写验收、assurance 手写 probe artifact），严格字面相等会错判同一能力
  //（2026-11-19 实跑：声明值明明在列仍报「能力声明不含 X」）。归一化判定单源在
  // kernel-judgments.capabilityDeclarationMatches（runtime 义务判定同口径消费本函数，
  // 同一 probe artifact 在断言环境检查与 runtime 义务两条判据下结论一致）：完全相等或
  // 裸尾（去「契约id:」前缀）相等即命中；归一化只统一词法、不放宽覆盖判定。
  if (typeof required.capability === "string" && required.capability !== "") {
    const declared = [];
    if (typeof environment.capability === "string") declared.push(environment.capability);
    else if (Array.isArray(environment.capability)) declared.push(...environment.capability.filter((item) => typeof item === "string"));
    if (Array.isArray(environment.capabilities)) declared.push(...environment.capabilities.filter((item) => typeof item === "string"));
    if (declared.length === 0) {
      return { ok: false, reason: `environment 未声明能力覆盖（capability=${JSON.stringify(required.capability)} 要求）：证据未声明 capability/capabilities，不能证明该能力维度` };
    }
    if (!capabilityDeclarationMatches(declared, required.capability)) {
      return {
        ok: false,
        reason: `environment 能力声明不含 ${JSON.stringify(required.capability)}（裸尾归一化后仍无命中；声明值：${declared.join(" / ")}）`,
      };
    }
  }
  // sourceHash 只登记不核对：其权威源内容的哈希比对通道不存在（本仓无权威源索引），
  // 核哈希会伪造确定性——如实不核，环境身份靠 kind + source 登记与人工可核查
  return { ok: true, reason: null };
}

/** 断言环境要求检查（机制二）：断言带 requiredEnvironment 时，其 verified 证据必须携带
 * 满足要求的环境元数据；不满足 → 证据最多 partial（真实环境不可用时只能 unknown/partial，
 * EVIDENCE_RESULTS 无 unknown，落地为 partial 并附 gapId 走既有风险通道）。 */
function assertionEnvironmentGap(world, assertion, evidenceEvent) {
  const required = assertion.requiredEnvironment;
  if (required === undefined) return null; // 缺省不限制
  if (evidenceEvent === undefined || evidenceEvent === null) return null; // 缺证据由既有 missing 判定负责
  const environment = readEvidenceEnvironment(world, evidenceEvent);
  if (environment === null) {
    return { requirement: required.kind, reason: `证据 artifact 无可解析的环境元数据（宿主类断言要求 ${required.kind}；模拟环境或无元数据不能独立证明）` };
  }
  const verdictOf = environmentSatisfies(world, environment, required);
  return verdictOf.ok ? null : { requirement: required.kind, reason: verdictOf.reason };
}

// ── 外部契约登记、权威解析与运行可用性（V6 运行可用性升级设计 §4/§5/§6/§8/§12）──
// 验收包 additive 顶层字段 externalContracts / externalContractReview；调用类目录与环境底线
// 落策略包 external-contract-classes.json（该文件由候选探测线创建，本 CLI 只读消费——文件
// 缺失时词表与底线校验整体跳过并在 validate-acceptance 输出 warnings 披露，不静默当成通过）。
//   resolve-external-contracts.mjs --task-dir D --project-root R [--acceptance-file F]
//     → stdout JSON {contracts:[{id,status,authorityAggregateHash,identity,surfaces,snapshotSha256}],snapshotSha256}
//   detect-external-contracts.mjs --project-root R --intent-file F
//     → stdout JSON {candidates:[{id,strength,signals,...}],unresolved:[...]}
// 两个脚本路径可用环境变量覆盖（测试与排障：DELIVERY_EXTERNAL_CONTRACT_RESOLVER /
// DELIVERY_EXTERNAL_CONTRACT_DETECTOR），缺省取技能安装目录内的脚本。
const ENVIRONMENT_CONTRACTS_DIRNAME = "environment-contracts";
const ENVIRONMENT_CONTRACTS_POINTER = "environment-contracts.current.json";
// 任务分级（设计 §13）：a=机制小改 / b=结构改（缺省）/ c=大版本。降档只减少审查席与分区，
// 不减必做机器门；唯一写通道 = init 参数或 set-delivery-profile（禁直改 task.json）
const DELIVERY_PROFILES = ["a", "b", "c"];

function resolverScriptPath() {
  const override = process.env.DELIVERY_EXTERNAL_CONTRACT_RESOLVER;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return join(SKILL_ROOT, "scripts", "resolve-external-contracts.mjs");
}

function detectorScriptPath() {
  const override = process.env.DELIVERY_EXTERNAL_CONTRACT_DETECTOR;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return join(SKILL_ROOT, "scripts", "detect-external-contracts.mjs");
}

function externalContractsOf(acceptance) {
  return Array.isArray(acceptance?.externalContracts) ? acceptance.externalContracts : [];
}

/** 调用类目录策略（含环境底线与蕴含观察类）。文件缺失 → null（词表校验整体跳过）。 */
function externalContractClassesPolicy(world) {
  const document = world?.policy?.[EXTERNAL_CONTRACT_CLASSES_FILE];
  return document === null || document === undefined ? null : document;
}

/** classId → {minEnvironment, implies[]}；策略文件缺失或 classes 为空 → null。
 * 表由 contract-rescan 单源库派生（D0/D3/evaluate 三处复扫与 validate 的词表校验同一份）。 */
function classFloorTable(policyDocument) {
  const tables = loadClassTables(policyDocument);
  return tables.classes.size > 0 ? tables.classes : null;
}

/** 验收包全部「契约 × 能力」条目（sourceRef 指向 acceptance.externalContracts 的能力项）。 */
function contractCapabilityEntries(acceptance) {
  const entries = [];
  externalContractsOf(acceptance).forEach((contract, contractIndex) => {
    (Array.isArray(contract?.capabilities) ? contract.capabilities : []).forEach((capability, capabilityIndex) => {
      entries.push({
        contractId: contract.id,
        contractIndex,
        capabilityId: capability.id,
        capability,
        sourceRef: `acceptance.externalContracts[${contract.id}].capabilities[${capability.id}]`,
      });
    });
  });
  return entries;
}

/** 契约能力 id 解析（裸 id 限定，R1-27）：qualified 形态「契约id:能力id」精确命中；
 * 裸 id（或任意外来前缀的「X:能力id」）按当前任务已知能力全表（多契约全集）做裸尾归一化
 * 解析——唯一命中即接受（同一能力在单契约与多契约包里都可用裸 id 指称），命中多个契约
 * （歧义）或零命中（未声明）即拒绝并要求 qualified 形态。多契约包不再一律拒裸 id——
 * 「单契约能过、多契约烧 run」的不对称由此消除；歧义防护保留（歧义裸 id 静默选契约会把
 * runtime 义务挂到错误契约上）。返回 { ok, contractId, capabilityId, reason }。 */
function resolveContractCapabilityId(acceptance, rawId) {
  const entries = contractCapabilityEntries(acceptance);
  const qualifiedHit = entries.find((entry) => `${entry.contractId}:${entry.capabilityId}` === rawId);
  if (qualifiedHit !== undefined) return { ok: true, contractId: qualifiedHit.contractId, capabilityId: qualifiedHit.capabilityId, reason: null };
  const bareTail = (value) => (value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value);
  const requiredBare = bareTail(rawId);
  const bareHits = entries.filter((entry) => entry.capabilityId === requiredBare);
  if (bareHits.length === 1) return { ok: true, contractId: bareHits[0].contractId, capabilityId: bareHits[0].capabilityId, reason: null };
  if (bareHits.length > 1) {
    return {
      ok: false,
      contractId: null,
      capabilityId: null,
      reason: `裸能力 id ${rawId} 在多契约包中歧义（命中 ${bareHits.map((entry) => `${entry.contractId}:${entry.capabilityId}`).join("、")}）`,
    };
  }
  return { ok: false, contractId: null, capabilityId: null, reason: `能力 ${rawId} 不在当前验收包 externalContracts 已声明能力全表中` };
}

/** 候选快照路径（按验收版本隔离，设计 §4.2）。 */
function candidateSnapshotPath(taskDir, acceptanceVersion) {
  return join(taskDir, "evidence", `acceptance-v${acceptanceVersion}`, "external-contract-candidates.json");
}

function readCandidateSnapshot(taskDir, acceptanceVersion) {
  const filePath = candidateSnapshotPath(taskDir, acceptanceVersion);
  if (!existsSync(filePath)) return { available: false, path: filePath, document: null, sha256: null };
  const text = readText(filePath, "外部契约候选快照", `重新运行 detect-external-contracts 生成 ${filePath} 后重试。`);
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`外部契约候选快照不是合法 JSON：${error.message}。`, `修复 ${filePath} 的 JSON 语法后重试；不要手工改写探测产物。`);
  }
  return { available: true, path: filePath, document, sha256: sha256Text(text) };
}

/** strong 候选信号命中的调用类集合（含蕴含观察类）——实现 = contract-rescan 单源库的提取
 * 口径（call-class 段正则 + manifest-field 映射 + regex 还原 + 词表缺席时的末段退化），
 * 与 D0/D3/evaluate 复扫同一份，不再子串匹配。词表缺失时退化为取信号末段
 * （manifest:pi.extensions → pi.extensions；call-class:register-command → register-command）。 */
function strongClassesFromSnapshot(candidateSnapshot, policyDocument) {
  return strongCandidateClasses(candidateSnapshot, loadClassTables(policyDocument));
}

/** 机器强制按 essential 处理的能力（设计 §4.1 字段规则 + §7.3 D0）：源码/manifest strong
 * 信号命中的能力，或已被断言 requiredEnvironment.capability 引用的能力——不看契约自报的
 * essential，也不看需求自报的 required / riskAcceptable 标志。 */
function forcedEssentialCapabilityIds(acceptance, strongClasses) {
  const forced = new Set();
  if (strongClasses.size === 0) return forced;
  for (const entry of contractCapabilityEntries(acceptance)) {
    const declared = Array.isArray(entry.capability.detectionClasses) ? entry.capability.detectionClasses : [];
    if (declared.some((classId) => strongClasses.has(classId))) {
      forced.add(`${entry.contractId}:${entry.capabilityId}`);
    }
  }
  for (const requirement of acceptance.requirements ?? []) {
    for (const assertion of requirement.assertions ?? []) {
      const capability = assertion.requiredEnvironment?.capability;
      if (typeof capability !== "string" || capability === "") continue;
      for (const entry of contractCapabilityEntries(acceptance)) {
        if (entry.capabilityId === capability || `${entry.contractId}:${entry.capabilityId}` === capability) {
          forced.add(`${entry.contractId}:${entry.capabilityId}`);
        }
      }
    }
  }
  return forced;
}

/** 契约是否 effectively essential（自报 essential 或被机器强制）。 */
function effectivelyEssentialContracts(acceptance, forced) {
  const essential = new Set();
  for (const contract of externalContractsOf(acceptance)) {
    if (contract.essential === true) {
      essential.add(contract.id);
      continue;
    }
    const forcedHit = (Array.isArray(contract.capabilities) ? contract.capabilities : [])
      .some((capability) => forced.has(`${contract.id}:${capability.id}`));
    if (forcedHit) essential.add(contract.id);
  }
  return essential;
}

// ── finding 域状态机（kernel/rules.json domains.finding = 唯一转移表，此处只做写入侧
// from 态检查，不改表）：open --FindingResolved--> resolved；open --ResolutionReaffirmed-->
// reaffirmed；open --RiskAccepted--> risk-accepted；resolved/reaffirmed/risk-accepted
// --reopen（record-finding --reopen-of）--> open。与判定侧（kernel-judgments
// openFindingsFromEvents 回答「当前裁决 revision 上谁 open」）互补：本函数回答「这次写入
// 是不是表外转移」。态推导取最后一条关闭/重认领事件的类型——同一条 finding resolve 后
// 跨 revision 重认领，态随最后事件演进为 reaffirmed。

/** finding 当前态（fold 折叠过程中推导）。返回 open / resolved / reaffirmed / risk-accepted。 */
function findingLifecycleStateOf(fold, findingId) {
  const closures = fold.findingClosures.filter((event) => event.findingId === findingId);
  if (closures.length > 0) {
    return closures[closures.length - 1].type === "FindingResolved" ? "resolved" : "reaffirmed";
  }
  if (fold.findingRiskAcceptedIds.has(findingId)) return "risk-accepted";
  return "open";
}

/** 该态的合法事件词表（从转移表整理，用于错误消息给出可用出路）。 */
function findingLegalEventsOf(state) {
  switch (state) {
    case "open":
      return ["FindingResolved", "ResolutionReaffirmed", "RiskAccepted"];
    case "resolved":
    case "reaffirmed":
    case "risk-accepted":
      return ["reopen（record-finding --reopen-of）"];
    default:
      return [];
  }
}

/** 只读执行探测/解析脚本，返回 {ok, parsed, reason}（不写盘、无副作用）。 */
function runExternalContractScript(scriptPath, args) {
  if (!existsSync(scriptPath)) {
    return { ok: false, parsed: null, reason: `脚本不存在：${scriptPath}` };
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, parsed: null, reason: `脚本执行失败：${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return { ok: false, parsed: null, reason: `脚本退出码 ${result.status}${stderr === "" ? "" : `：${stderr.split("\n")[0]}`}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, parsed: null, reason: `脚本输出不是合法 JSON：${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, parsed: null, reason: "脚本输出不是 JSON 对象" };
  }
  return { ok: true, parsed, reason: null };
}

/** 每契约权威哈希取值：探测线输出 authorityAggregateHash；design §4.3 的 aggregateHash
 * 形态一并接受（同一事实的两个命名，前者优先）。 */
function contractAggregateHashOf(contract) {
  if (typeof contract?.authorityAggregateHash === "string" && contract.authorityAggregateHash !== "") return contract.authorityAggregateHash;
  if (typeof contract?.aggregateHash === "string" && contract.aggregateHash !== "") return contract.aggregateHash;
  return null;
}

/** 环境契约快照文件（按哈希分文件、不覆盖）。 */
function environmentSnapshotFilePath(taskDir, sha256) {
  return join(taskDir, ENVIRONMENT_CONTRACTS_DIRNAME, `${sha256}.json`);
}

/** 快照稳定事实映射（提取参与身份哈希的字段子集，与 resolver 的 stableContractFacts 同源：resolvedAt / resolvedPath 是
 * 本机观测信息，不参与快照身份，设计 §4.3）。resolver 未导出该函数，此处本地镜像一份，
 * 两侧漂移由对拍测试钉住（scripts/tests/external-contracts-v6.test.mjs 快照身份对拍用例）。
 * 字段防御性取值：损坏快照按同一映射算出的哈希必然与文件名不一致，走下方身份复核分支拒绝。 */
function environmentSnapshotStableFacts(contract) {
  const source = contract === null || typeof contract !== "object" ? {} : contract;
  const resolver = source.resolver === null || typeof source.resolver !== "object" ? {} : source.resolver;
  return {
    id: source.id,
    status: source.status,
    resolver: { kind: resolver.kind, locator: resolver.locator, resolution: resolver.resolution },
    identity: source.identity,
    surfaces: source.surfaces,
    aggregateHash: source.aggregateHash,
  };
}

/** 快照内容规范哈希（与 resolver 的 snapshotSha256 同一公式：contracts 稳定事实排序由
 * resolver 落盘时保证，此处按文件内容原序映射）。 */
function computeEnvironmentSnapshotSha256(document) {
  return sha256Text(canonicalJson((Array.isArray(document.contracts) ? document.contracts : []).map(environmentSnapshotStableFacts)));
}

function readEnvironmentSnapshotFile(taskDir, sha256) {
  const filePath = environmentSnapshotFilePath(taskDir, sha256);
  if (!existsSync(filePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.contracts)) return null;
  // 身份复核（§4.4 规则 7）：文件名 = 快照稳定身份哈希，读取时重算内容规范哈希对账——
  // 不复核时改写批准时的基线快照（例如把 contracts 换成宽松内容）可以借同一文件名
  // 静默通过 environmentChain，环境漂移防线被架空
  const recomputed = computeEnvironmentSnapshotSha256(parsed);
  if (recomputed !== sha256) {
    fail(
      `环境契约快照身份不一致：${ENVIRONMENT_CONTRACTS_DIRNAME}/${sha256.slice(0, 12)}….json 的内容规范哈希为 ${recomputed.slice(0, 12)}…，与文件名哈希不匹配（快照内容被改写或损坏）。`,
      `重跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${JSON.stringify(taskDir)} --project-root <projectRoot> --write 重建快照（按哈希分文件、不覆盖旧文件，重建后以新 snapshotSha256 更新引用方）；不要手工修复快照内容。`,
    );
  }
  return parsed;
}

/** 解析当前外部契约权威。evaluate 侧必须走 resolver 现场重解析（不允许用 taskDir 内旧快照
 * 结论蒙混——设计 §4.4 第 6/7 条）；validate-acceptance 是声明期检查，resolver 不可用时
 * 允许回落到 current 指针（该指针由工作流在解析后刚写过）。 */
function resolveEnvironmentContracts(taskDir, projectRoot, { allowPointerFallback = false } = {}) {
  const outcome = runExternalContractScript(resolverScriptPath(), [
    "--task-dir", taskDir,
    "--project-root", projectRoot,
  ]);
  if (outcome.ok) {
    const contracts = Array.isArray(outcome.parsed.contracts) ? outcome.parsed.contracts : [];
    return {
      available: true,
      source: "resolver",
      snapshotSha256: typeof outcome.parsed.snapshotSha256 === "string" ? outcome.parsed.snapshotSha256 : null,
      contracts,
      reason: null,
    };
  }
  if (allowPointerFallback) {
    const pointerPath = join(taskDir, ENVIRONMENT_CONTRACTS_POINTER);
    if (existsSync(pointerPath)) {
      try {
        const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
        const sha256 = typeof pointer?.snapshotSha256 === "string" ? pointer.snapshotSha256 : null;
        const document = sha256 === null ? null : readEnvironmentSnapshotFile(taskDir, sha256);
        if (document !== null) {
          return {
            available: true,
            source: "pointer",
            snapshotSha256: sha256,
            contracts: document.contracts,
            reason: `resolver 不可用（${outcome.reason}），已回落至 ${ENVIRONMENT_CONTRACTS_POINTER} 指向的快照`,
          };
        }
      } catch {
        // 指针损坏：与缺失同等处理，走下方不可用分支
      }
    }
  }
  return { available: false, source: "none", snapshotSha256: null, contracts: [], reason: outcome.reason };
}

/** 当前权威逐契约 aggregateHash（FindingRaised authorityHash 同源核对用，R1-09）：只读
 * 任务目录在盘快照（environment-contracts.current.json 指针 → environment-contracts/<sha>.json），
 * 不 spawn resolver（写入路径上的核对必须廉价）。返回 null = 当前权威快照不可得
 * （指针缺失 / 损坏 / 快照文件缺失），调用方退回形态校验；Map 只收 status=resolved 且
 * aggregateHash 可解析的契约条目。 */
function currentAuthorityHashesByContract(taskDir) {
  const pointerPath = join(taskDir, ENVIRONMENT_CONTRACTS_POINTER);
  if (!existsSync(pointerPath)) return null;
  let sha256 = null;
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (typeof pointer?.snapshotSha256 === "string") sha256 = pointer.snapshotSha256;
  } catch {
    return null;
  }
  if (sha256 === null) return null;
  const document = readEnvironmentSnapshotFile(taskDir, sha256);
  if (document === null || !Array.isArray(document.contracts)) return null;
  const hashes = new Map();
  for (const contract of document.contracts) {
    if (contract === null || typeof contract !== "object" || typeof contract.id !== "string") continue;
    // 只收 resolved 契约（unresolved 无权威哈希可核对）；hash 取值口径与
    // contractAggregateHashOf 一致（authorityAggregateHash / aggregateHash 双拼写兼容）
    if (contract.status !== undefined && contract.status !== "resolved") continue;
    const hash = contractAggregateHashOf(contract);
    if (typeof hash === "string" && hash !== "") hashes.set(contract.id, hash);
  }
  return hashes;
}

/** 批准时的每契约权威哈希（环境历史链起点）。approve-acceptance 在验收包声明外部契约时
 * 自动绑定当前快照哈希，因此正常情况下可取到；缺字段/缺快照文件 → null + 原因。 */
function approvalBaselineHashes(world) {
  const approvals = world.fold.approvals.filter((event) => event.acceptanceVersion === world.acceptance.acceptanceVersion);
  const approval = approvals.length > 0 ? approvals[approvals.length - 1] : null;
  if (approval === null) return { approval: null, hashes: null, reason: "任务尚无验收批准（无环境历史链起点）" };
  const sha256 = typeof approval.authoritySnapshotSha256 === "string" ? approval.authoritySnapshotSha256 : null;
  if (sha256 === null) {
    return { approval, hashes: null, reason: `批准事件（seq ${approval.seq}）未绑定 authoritySnapshotSha256——升级前批准或未经自动绑定，无法确定批准时权威基线` };
  }
  const document = readEnvironmentSnapshotFile(world.taskDir, sha256);
  if (document === null) {
    return { approval, hashes: null, reason: `批准时快照文件缺失或损坏：${ENVIRONMENT_CONTRACTS_DIRNAME}/${sha256}.json` };
  }
  const hashes = new Map();
  for (const contract of document.contracts) {
    if (typeof contract?.id !== "string") continue;
    hashes.set(contract.id, contractAggregateHashOf(contract));
  }
  return { approval, hashes, reason: null };
}

/** 环境历史链判定（设计 §4.3/§10）：契约当前 aggregateHash 等于批准时该契约哈希，或存在
 * 覆盖该 contractId 的 EnvironmentBaselineConfirmed 接链（同验收版本、晚于批准）。 */
function environmentChainOk(contractId, currentHash, baseline, world) {
  if (baseline.hashes !== null && baseline.hashes.get(contractId) === currentHash) return true;
  const approvalSeq = baseline.approval?.seq ?? 0;
  return world.fold.environmentBaselines.some((event) =>
    event.acceptanceVersion === world.acceptance.acceptanceVersion &&
    event.seq > approvalSeq &&
    Array.isArray(event.contractIds) &&
    event.contractIds.includes(contractId));
}

/** 检查 5：每个（有效）essential capability 必须被断言 requiredEnvironment.capability 引用，
 * 且该断言的 kind 满足能力环境底线。结构层（按验收包自报 essential）与声明层（叠加候选
 * strong 信号强制判定的 essential）共用——强制 essential 只在能读到候选快照的层生效。 */
function validateEssentialCapabilityBindings(acceptance, essentialContracts) {
  const contracts = externalContractsOf(acceptance);
  const assertions = (acceptance.requirements ?? []).flatMap((requirement) => requirement.assertions ?? []);
  const assertionCapabilityKinds = new Map();
  for (const assertion of assertions) {
    const capability = assertion.requiredEnvironment?.capability;
    if (typeof capability !== "string" || capability === "") continue;
    const kinds = assertionCapabilityKinds.get(capability) ?? [];
    kinds.push(assertion.requiredEnvironment.kind);
    assertionCapabilityKinds.set(capability, kinds);
  }
  for (const contract of contracts) {
    if (!essentialContracts.has(contract.id)) continue;
    for (const capability of contract.capabilities) {
      const kinds = assertionCapabilityKinds.get(capability.id) ?? assertionCapabilityKinds.get(`${contract.id}:${capability.id}`) ?? [];
      if (kinds.length === 0) {
        fail(
          `essential 能力 ${contract.id}:${capability.id} 未被任何断言的 requiredEnvironment.capability 引用。`,
          `在至少一条断言的 requiredEnvironment 增加 capability=${capability.id}（绑定唯一权威 = assertion.requiredEnvironment.capability，不另设 consumedBy 映射表）；确无对应行为断言时把该契约改为非 essential 并说明理由。`,
        );
      }
      if (!kinds.some((kind) => environmentKindSatisfies(kind, capability.minEnvironment))) {
        fail(
          `essential 能力 ${contract.id}:${capability.id} 的底线 ${capability.minEnvironment} 无满足档位的断言引用（现有断言 kind：${kinds.join(" / ")}）。`,
          `把绑定断言的 requiredEnvironment.kind 提升到不低于 ${capability.minEnvironment}（真实环境是官方运行器的超集，real-host 证据可满足 official-runner 要求）后重试。`,
        );
      }
    }
  }
}

// ── validate-acceptance 静态检查（设计 §5.1 九条）──
// 分两层，触发条件相同：验收包出现 externalContracts 键即执行；未声明该键的验收包与升级前
// 旧任务不受任何新检查约束（设计 §16 R1 验收项「无外部依赖的普通任务不受影响」；判定锚 =
// task.json 的 deliveryProfile 元数据，init 在该升级后统一写入，旧任务目录无该字段）。
//   ① 结构层（本函数，纯计算无 I/O）：检查 1/4/5/6/7/9 + 调用类底线与蕴含观察。
//      随 loadWorld 每次执行——验收包结构损坏在任何命令入口都被拦下。
//   ② 声明层（validateExternalContractDeclarations，读候选快照文件 + 跑 resolver）：
//      检查 2/3。只在 validate-acceptance 命令执行——resolver 是外部进程调用，
//      放进 loadWorld 会让 next / obligations / evaluate 之外的每个命令都依赖探测线脚本
//      可用，读路径（「下一步是什么」）会被拖死，属于把声明期门禁放错了层。
// 检查 8（contract-smoke 增量）在 validateIncrements——增量结构在那里校验，与
// validate-acceptance 是同一条命令的同一次执行。
function validateExternalContractStructure(acceptance, sources) {
  const contracts = externalContractsOf(acceptance);
  // 检查 1：externalContracts 若存在必须非空且结构合法
  if (!Array.isArray(acceptance.externalContracts) || acceptance.externalContracts.length === 0) {
    fail(
      "acceptance.externalContracts 若存在必须是非空数组。",
      "把 externalContracts 改为至少含一个契约的数组（id/essential/authorityRequest/capabilities），或删除该键表示本任务无外部契约依赖后重试。",
    );
  }
  const policyDocument = sources?.[EXTERNAL_CONTRACT_CLASSES_FILE] ?? null;
  const floorTable = classFloorTable(policyDocument);
  const environmentKinds = (sources?.["evidence-kinds.json"]?.environmentKinds ?? []).filter((kind) => kind !== "fake-host");
  // 结构层不读候选快照：strong 信号命中导致的「强制 essential」在声明层与 evaluate 复扫
  // 两处生效（那里有候选快照/源码事实），结构层按验收包自报的 essential 判定
  const forced = forcedEssentialCapabilityIds(acceptance, new Set());
  const essentialContracts = effectivelyEssentialContracts(acceptance, forced);
  const assertions = (acceptance.requirements ?? []).flatMap((requirement) => requirement.assertions ?? []);
  // 断言能力引用 → 能力条目（裸 id 或限定 id）
  const capabilityByReference = new Map();
  for (const entry of contractCapabilityEntries(acceptance)) {
    capabilityByReference.set(entry.capabilityId, entry);
    capabilityByReference.set(`${entry.contractId}:${entry.capabilityId}`, entry);
  }
  const seenContractIds = new Set();
  const seenCapabilityIds = new Set();
  for (const contract of contracts) {
    const contractLabel = `acceptance.externalContracts[${contract.id}]`;
    // 检查 1：结构合法（非空数组、字段齐备、id 唯一）
    requireRecord(contract, contractLabel);
    requireExactKeys(contract, ["id", "essential", "authorityRequest", "capabilities"], contractLabel);
    requireNonEmptyString(contract.id, `${contractLabel}.id`);
    if (seenContractIds.has(contract.id)) {
      fail(`${contractLabel}.id 重复：${contract.id}。`, "为每个外部契约分配唯一 id，并同步修正事件与证据中的引用后重试。");
    }
    seenContractIds.add(contract.id);
    requireBoolean(contract.essential, `${contractLabel}.essential`);
    const authorityRequest = contract.authorityRequest;
    const authorityLabel = `${contractLabel}.authorityRequest`;
    requireRecord(authorityRequest, authorityLabel);
    requireExactKeys(authorityRequest, ["resolverKind", "locator"], authorityLabel);
    requireNonEmptyString(authorityRequest.resolverKind, `${authorityLabel}.resolverKind`);
    requireNonEmptyString(authorityRequest.locator, `${authorityLabel}.locator`);
    if (policyDocument !== null && Array.isArray(policyDocument.resolverKinds) && policyDocument.resolverKinds.length > 0) {
      requireEnum(authorityRequest.resolverKind, policyDocument.resolverKinds, `${authorityLabel}.resolverKind`);
    }
    if (!Array.isArray(contract.capabilities) || contract.capabilities.length === 0) {
      fail(`${contractLabel}.capabilities 不能为空（能力清单是机器可对账的最小单元）。`, `至少登记一个 capability（id/minEnvironment/observable/surfaceRefs/detectionClasses）后重试。`);
    }
    const declaredClasses = new Set();
    for (const capability of contract.capabilities) {
      const capabilityLabel = `${contractLabel}.capabilities[${capability?.id ?? "?"}]`;
      requireRecord(capability, capabilityLabel);
      // 检查 4：capability 结构合法 + detectionClasses/surfaceRefs 非空
      requireExactKeys(capability, ["id", "minEnvironment", "observable", "surfaceRefs", "detectionClasses"], capabilityLabel);
      requireNonEmptyString(capability.id, `${capabilityLabel}.id`);
      if (seenCapabilityIds.has(capability.id)) {
        fail(`${capabilityLabel}.id 与已登记能力重复：${capability.id}。`, "能力 id 在全验收包内唯一（跨契约用「契约id:能力id」限定形式引用）后重试。");
      }
      seenCapabilityIds.add(capability.id);
      requireNonEmptyString(capability.observable, `${capabilityLabel}.observable`);
      requireStringArray(capability.surfaceRefs, `${capabilityLabel}.surfaceRefs`, { nonEmptyItems: true, unique: true });
      requireStringArray(capability.detectionClasses, `${capabilityLabel}.detectionClasses`, { nonEmptyItems: true, unique: true });
      if (capability.surfaceRefs.length === 0) {
        fail(`${capabilityLabel}.surfaceRefs 不能为空。`, "每个 capability 必须带 surfaceRefs，指向权威快照中的文件或类型符号（probe 观察与审查抽查至少要能回溯到这些 surface）后重试。");
      }
      if (capability.detectionClasses.length === 0) {
        fail(`${capabilityLabel}.detectionClasses 不能为空。`, "每个 capability 必须声明 detectionClasses（D0 探测到某个调用类时必须存在声明该类的 capability，否则拒绝编译并回验收修订）后重试。");
      }
      // 检查 9：minEnvironment 用策略环境词表（fake-host 不得作为档位——自写模拟宿主不是底线）
      if (environmentKinds.length > 0) {
        requireEnum(capability.minEnvironment, environmentKinds, `${capabilityLabel}.minEnvironment`);
      } else {
        requireEnum(capability.minEnvironment, ["official-runner", "real-host"], `${capabilityLabel}.minEnvironment`);
      }
      for (const classId of capability.detectionClasses) declaredClasses.add(classId);
    }
    // 检查 4 续：调用类环境底线——能力档位不得低于其声明调用类（及蕴含观察类）的底线
    if (floorTable !== null) {
      for (const capability of contract.capabilities) {
        const floors = [];
        for (const classId of capability.detectionClasses) {
          const entry = floorTable.get(classId);
          if (entry === undefined) {
            fail(`${contractLabel}.capabilities[${capability.id}].detectionClasses 含未登记调用类 ${classId}。`, `只用策略包 ${EXTERNAL_CONTRACT_CLASSES_FILE} 已登记的调用类；新调用类走策略升级（upgrade-policy）后重试。`);
          }
          if (entry.minEnvironment !== null) floors.push({ classId, minEnvironment: entry.minEnvironment });
          for (const implied of entry.implies) {
            const impliedEntry = floorTable.get(implied);
            if (impliedEntry !== undefined && impliedEntry.minEnvironment !== null) {
              floors.push({ classId: implied, minEnvironment: impliedEntry.minEnvironment });
            }
          }
        }
        for (const floor of floors) {
          if (!environmentKindSatisfies(capability.minEnvironment, floor.minEnvironment)) {
            fail(
              `${contractLabel}.capabilities[${capability.id}].minEnvironment=${capability.minEnvironment} 低于调用类 ${floor.classId} 的环境底线 ${floor.minEnvironment}。`,
              `把 minEnvironment 提升到不低于 ${floor.minEnvironment}，或从 detectionClasses 移除该调用类（移除后源码复扫会按未登记 strong 信号拒绝）后重试。`,
            );
          }
        }
      }
      // 蕴含观察义务：源码出现注册类时，能力清单必须同时覆盖注册与真实分发（§4.1 调用类目录规则）
      for (const capability of contract.capabilities) {
        for (const classId of capability.detectionClasses) {
          for (const implied of floorTable.get(classId)?.implies ?? []) {
            if (!declaredClasses.has(implied)) {
              fail(
                `${contractLabel} 声明调用类 ${classId}（蕴含 ${implied} 观察义务）但能力清单未覆盖 ${implied}。`,
                `在 ${contractLabel}.capabilities 增加声明 detectionClasses 含 ${implied} 的能力（register-command 蕴含 dispatch-command：只登记注册不登记分发等于漏掉真实命令解析观察）后重试。`,
              );
            }
          }
        }
      }
    }
  }
  validateEssentialCapabilityBindings(acceptance, essentialContracts);
  // 检查 6：验收中出现的每个 requiredEnvironment.capability 必须可回溯到已声明能力
  for (const assertion of assertions) {
    const capability = assertion.requiredEnvironment?.capability;
    if (typeof capability !== "string" || capability === "") continue;
    if (!capabilityByReference.has(capability)) {
      fail(
        `断言 ${assertion.id} 的 requiredEnvironment.capability=${capability} 无法回溯到 acceptance.externalContracts 的能力清单。`,
        "把该能力登记进对应契约的 capabilities（含 minEnvironment/detectionClasses/surfaceRefs），或改为不带 capability 的环境要求后重试。",
      );
    }
  }
  // 检查 7：capability 绑定断言的 given/when 把 mock/fake/自写 harness 作为唯一装载或
  // 分发环境时拒绝（mock 可以是补充场景，不能是该 capability 的唯一声明来源）。
  // 判定 = 出现 mock 类词且全文无任何真实环境词/档位枚举才拒——真实环境词表须覆盖
  // 连字符与空格两种写法（official-runner / official runner）与中文写法（官方运行器 /
  // 真实宿主），否则词面变体即误伤（F17）
  for (const assertion of assertions) {
    const capability = assertion.requiredEnvironment?.capability;
    if (typeof capability !== "string" || capability === "" || !capabilityByReference.has(capability)) continue;
    const text = `${assertion.given}\n${assertion.when}`.toLowerCase();
    const mockHit = /(mock|fake|harness|stub|模拟|自写|假宿主)/.test(text);
    const realHit = /(真实|real|official-runner|real-host|official runner|real host|官方|官方运行器|真实宿主|生产环境|实际宿主)/.test(text);
    if (mockHit && !realHit) {
      fail(
        `断言 ${assertion.id}（绑定能力 ${capability}）的 given/when 只把 mock/fake/自写 harness 作为装载或分发环境。`,
        "mock 只能作补充场景：在 given/when 同时写明真实环境观察点（official-runner 或 real-host），或把该断言的能力绑定移除后重试。",
      );
    }
  }
}

/** 声明层检查（设计 §5.1 第 2/3/5/8 条）：候选处置表、resolved 权威快照与（强制 essential
 * 口径下的）契约冒烟增量。candidateSnapshot 由调用方读盘
 * （taskDir/evidence/acceptance-v<N>/external-contract-candidates.json），权威快照经 resolver
 * 现场解析（validate-acceptance 是声明期检查，resolver 不可用时允许回落到 current 指针——
 * 该指针由工作流在解析后刚写过）。返回声明层算出的强类集合（检查 8 透传用）。 */
function validateExternalContractDeclarations(acceptance, taskDir, sources, candidateSnapshot) {
  const contracts = externalContractsOf(acceptance);
  const policyDocument = sources?.[EXTERNAL_CONTRACT_CLASSES_FILE] ?? null;
  const floorTable = classFloorTable(policyDocument);
  const strongClasses = strongClassesFromSnapshot(candidateSnapshot, policyDocument);
  const forced = forcedEssentialCapabilityIds(acceptance, strongClasses);
  const essentialContracts = effectivelyEssentialContracts(acceptance, forced);
  const seenContractIds = new Set(externalContractsOf(acceptance).map((contract) => contract.id));
  // 检查 5（强制 essential 口径）：候选 strong 信号命中的能力被机器强制按 essential 处理
  // （§4.1 字段规则）——结构层按自报 essential 已判过一次，这里用叠加后的集合再判
  validateEssentialCapabilityBindings(acceptance, essentialContracts);
  // 检查 2：候选处置表必填、detectionSha256 与候选快照一致、全部候选已处置、
  // strong 候选只能 bound/unresolved、每个 externalContracts id 有 bound 或带 rationale 的
  // manual 处置可回溯。V6 世代新任务无外部契约时键同样必须在场（设计 §5.1 检查 2：
  // 允许空处置表，不允许键缺席——键缺席 = 候选探测与处置判定无可绑定对象，任务是否
  // 做过候选探测无从机器对账）
  const review = acceptance.externalContractReview;
  if (!Object.hasOwn(acceptance, "externalContractReview")) {
    fail(
      contracts.length > 0
        ? "acceptance.externalContractReview 缺失：声明了 externalContracts 的验收包必须携带候选处置表。"
        : "acceptance.externalContractReview 缺失：V6 升级后新建任务即使无外部契约也必须携带该键（设计 §5.1 检查 2——设计允许空处置表，但键必须在场）。",
      `在 acceptance.json 补 externalContractReview: { detectionSha256: <候选快照文件内容 sha256>, dispositions: [] } 后重试；候选快照缺失时先跑 detect-external-contracts（无外部候选也会生成空候选快照，§4.5），用其内容哈希填 detectionSha256。`,
    );
  }
  requireRecord(review, "acceptance.externalContractReview");
  requireExactKeys(review, ["detectionSha256", "dispositions"], "acceptance.externalContractReview");
  requireSha256(review.detectionSha256, "acceptance.externalContractReview.detectionSha256");
  if (candidateSnapshot?.available !== true) {
    fail(
      `externalContractReview.detectionSha256 无法对账：候选快照缺失（期望路径 taskDir/evidence/acceptance-v${acceptance.acceptanceVersion}/external-contract-candidates.json）。`,
      `先运行 detect-external-contracts 生成该候选快照，再把其文件内容 sha256 填入 externalContractReview.detectionSha256 后重试；探测输入（intent/manifest/源码）变化后必须重新探测。`,
    );
  }
  if (review.detectionSha256 !== candidateSnapshot.sha256) {
    fail(
      `externalContractReview.detectionSha256 与候选快照不一致（登记 ${review.detectionSha256.slice(0, 12)}…，快照 ${candidateSnapshot.sha256.slice(0, 12)}…）。`,
      `探测输入变化后必须重新探测并重新冻结处置表：重跑 detect-external-contracts，用新快照内容 sha256 更新 externalContractReview.detectionSha256 后重试。`,
    );
  }
  const candidates = Array.isArray(candidateSnapshot.document?.candidates) ? candidateSnapshot.document.candidates : [];
  if (!Array.isArray(review.dispositions)) {
    fail("acceptance.externalContractReview.dispositions 必须是数组（可为空）。", "把 dispositions 改为数组；每个候选一条处置记录后重试。");
  }
  const dispositionByCandidate = new Map();
  for (let index = 0; index < review.dispositions.length; index += 1) {
    const disposition = review.dispositions[index];
    const label = `acceptance.externalContractReview.dispositions[${index}]`;
    requireRecord(disposition, label);
    const dispositionAllowed = ["candidateId", "disposition", "contractId", "rationale"];
    const unknownDispositionFields = Object.keys(disposition).filter((key) => !dispositionAllowed.includes(key));
    const missingDispositionFields = ["candidateId", "disposition"].filter((key) => !Object.hasOwn(disposition, key));
    if (unknownDispositionFields.length > 0 || missingDispositionFields.length > 0) {
      const parts = [];
      if (missingDispositionFields.length > 0) parts.push(`缺少字段 ${missingDispositionFields.join(", ")}`);
      if (unknownDispositionFields.length > 0) parts.push(`含未知字段 ${unknownDispositionFields.join(", ")}`);
      fail(`${label} 形态非法：${parts.join("；")}。`, `按契约补齐必需字段并删除未知字段后重试；${label} 允许的字段为 ${dispositionAllowed.join(", ")}（contractId/rationale 按处置类型条件必填）。`);
    }
    requireNonEmptyString(disposition.candidateId, `${label}.candidateId`);
    requireEnum(disposition.disposition, ["bound", "manual", "not-external", "unresolved"], `${label}.disposition`);
    if (dispositionByCandidate.has(disposition.candidateId)) {
      fail(`${label} 重复处置候选 ${disposition.candidateId}。`, "每个候选只登记一条处置；修正后重试。");
    }
    dispositionByCandidate.set(disposition.candidateId, disposition);
    if (disposition.disposition === "bound") {
      requireNonEmptyString(disposition.contractId, `${label}.contractId`);
      if (!seenContractIds.has(disposition.contractId)) {
        fail(`${label}.contractId=${disposition.contractId} 不是已声明的 externalContracts id。`, "把 contractId 改为 acceptance.externalContracts 中已登记的 id 后重试。");
      }
    } else if (disposition.disposition === "manual") {
      requireNonEmptyString(disposition.contractId, `${label}.contractId`);
      requireNonEmptyString(disposition.rationale, `${label}.rationale`);
      if (!seenContractIds.has(disposition.contractId)) {
        fail(`${label}.contractId=${disposition.contractId} 不是已声明的 externalContracts id。`, "把 contractId 改为 acceptance.externalContracts 中已登记的 id 后重试。");
      }
    } else if (disposition.disposition === "not-external") {
      requireNonEmptyString(disposition.rationale, `${label}.rationale`);
    }
  }
  for (const candidate of candidates) {
    const candidateId = typeof candidate?.id === "string" ? candidate.id : null;
    if (candidateId === null) continue;
    const disposition = dispositionByCandidate.get(candidateId);
    if (disposition === undefined) {
      fail(
        `候选 ${candidateId} 未处置（externalContractReview.dispositions 缺该候选）。`,
        `为每个候选登记一条处置：bound（绑定契约）/ manual（reviewer 依 intent 补充，须给 rationale 与 contractId）/ not-external（仅 weak 候选可用，须给 rationale）/ unresolved（停回）。`,
      );
    }
    if (candidate.strength === "strong" && disposition.disposition === "not-external") {
      fail(
        `strong 候选 ${candidateId} 被处置为 not-external——无效处置。`,
        "strong 候选只能 bound（绑定契约）或 unresolved（停回用户裁决）；确不构成外部契约时由用户裁决并走 open-revision 修订验收，不接受一句自由文本放行。",
      );
    }
  }
  for (const contractId of seenContractIds) {
    const bound = [...dispositionByCandidate.values()].some(
      (disposition) => (disposition.disposition === "bound" || disposition.disposition === "manual") && disposition.contractId === contractId,
    );
    if (!bound) {
      fail(
        `externalContracts 契约 ${contractId} 没有可回溯的候选处置（缺 bound 或带 rationale 的 manual）。`,
        `为 ${contractId} 补一条 bound/manual 处置；无对应候选时用 manual 并在 rationale 说明 intent 语义来源。`,
      );
    }
  }
  // 检查 3：essential 契约必须有 resolved 权威快照（含被机器强制判为 essential 的契约）。
  // 仅存在 essential 契约时执行——resolver 是外部进程调用，无契约新任务（世代判别把
  // review-only 验收包也带进本函数）不应被引入 resolver 脚本可用性依赖
  if (essentialContracts.size > 0) {
    const environment = resolveEnvironmentContracts(taskDir, acceptance.projectRoot, { allowPointerFallback: true });
    for (const contractId of essentialContracts) {
      const snapshotEntry = environment.contracts.find((entry) => entry?.id === contractId);
      if (!environment.available || snapshotEntry === undefined) {
        fail(
          `essential 外部契约 ${contractId} 无权威解析结果（当前解析：${environment.reason ?? "不可用"}）。`,
          `先运行 resolve-external-contracts --write 生成权威快照；权威确实不可得时把该契约改为非 essential 并走普通风险接受，或停回用户裁决「目标环境不可满足」。`,
        );
      }
      if (snapshotEntry.status !== "resolved" || contractAggregateHashOf(snapshotEntry) === null) {
        fail(
          `essential 外部契约 ${contractId} 的权威状态为 ${snapshotEntry.status ?? "未知"}（无 aggregateHash）。`,
          "declared-unavailable 不能伪造 resolved：补齐权威工件（安装包/官方二进制/用户登记的本地路径）后重跑 resolve --write，或停回用户裁决。",
        );
      }
    }
  }
  // 强类集合回传：检查 8（契约冒烟增量）的 forced essential 口径与检查 3/5 同源
  return strongClasses;
}

/** 检查 8：验收含（有效）essential 契约时，increments 必须存在 kind=contract-smoke 增量。
 * strongClasses = 声明层从候选快照算出的强类集合（检查 3/5 同源）；validateIncrements 在
 * loadWorld 热路径上以空集合调用（只覆盖自报 essential），这里用实算集合补覆盖「源码强
 * 信号强制按 essential」的契约——两处调用同一判定，数据源对齐。 */
function validateContractSmokeIncrement(increments, acceptance, strongClasses = new Set()) {
  const contracts = externalContractsOf(acceptance);
  if (contracts.length === 0) return;
  const forced = forcedEssentialCapabilityIds(acceptance, strongClasses);
  const essentialContracts = effectivelyEssentialContracts(acceptance, forced);
  if (essentialContracts.size === 0) return;
  const hasSmoke = (increments.items ?? []).some((item) => item.kind === "contract-smoke");
  if (hasSmoke) return;
  fail(
    `验收含 essential 外部契约（${[...essentialContracts].join(", ")}）但 increments 无 kind=contract-smoke 的契约冒烟增量。`,
    "增加一个契约冒烟增量（kind=contract-smoke，testCommand 指向 runtime probe 入口），让 API 形态/签名/回执通道在业务实现前先被真实环境揭示。",
  );
}

/** profile=a 探索维度词表（设计 §13 机器降档）：a 级契约任务的探索维度只取契约与故障两类。
 * 与 independent-assurance-v6 workflow 的 PROFILE_A_DIMENSIONS 逐字一致——两侧是不变量：
 * IA 按此降档产出 ExplorationCompleted.dimensions，gate 的维度覆盖检查要求完整覆盖
 * acceptance.reviewDimensions，词表不一致时 full 保证循环无法收敛。 */
const PROFILE_A_EXPLORATION_DIMENSIONS = ["外部契约", "故障形态"];

/** E 类对账：deliveryProfile=a 且验收含外部契约时，acceptance.reviewDimensions 必须 ⊆
 * 降档词表。只在 validate-acceptance 命令执行（不进 loadWorld 热路径：批准后由用户改分级
 * 不应把任务锁死在「任何命令都跑不了」的状态，那种情形的兜底是 ExplorationCompleted 追加时
 * 的维度覆盖失败，消息里指明两条出路）。 */
function validateProfileADimensionScope(acceptance, task) {
  if (task?.deliveryProfile !== "a") return;
  if (externalContractsOf(acceptance).length === 0) return;
  const outOfScope = (Array.isArray(acceptance.reviewDimensions) ? acceptance.reviewDimensions : [])
    .filter((dimension) => !PROFILE_A_EXPLORATION_DIMENSIONS.includes(dimension));
  if (outOfScope.length === 0) return;
  fail(
    `deliveryProfile=a 且验收含外部契约时，acceptance.reviewDimensions 只能取 ${PROFILE_A_EXPLORATION_DIMENSIONS.join(" / ")}（当前超出：${outOfScope.join(", ")}）。`,
    `两种改法二选一：① 把 reviewDimensions 收窄到「${PROFILE_A_EXPLORATION_DIMENSIONS.join("」与「")}」两类（a 级任务探索维度按机器降档只做契约与故障两类，降档不减必做机器门）；② 需要更多探索维度时由用户执行 ${GATE_COMMAND} set-delivery-profile --task-dir <dir> --profile b --credential <user credentialId> 改为 b 级后重跑 validate-acceptance。`,
  );
}

// ── runtime 义务与 readiness 组装（§6.1/§12.1）──
// 磁盘读取（artifact 解析、driver 哈希、权威重解析）都在本段完成，判定本体交给
// kernel-judgments.deriveRuntimeObligations（pure 单源）——gate evaluate 与
// delivery-core obligations 共用同一段组装逻辑。

/** 证据 artifact 全文（probe 判定输入）。不可读/非 JSON 对象 → null。 */
function readEvidenceArtifactDocument(world, event) {
  if (typeof event.artifact !== "string" || event.artifact === "") return null;
  const filePath = isAbsolute(event.artifact) ? resolve(event.artifact) : resolve(world.taskDir, event.artifact);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** driver 路径解析（taskDir / projectRoot 相对与绝对路径三候选；不存在返回 null）。 */
function driverResolvedPathOf(world, environment) {
  if (environment === null || environment === undefined) return null;
  if (typeof environment.driver !== "string" || environment.driver.trim() === "") return null;
  const candidates = [];
  if (isAbsolute(environment.driver)) candidates.push(resolve(environment.driver));
  else {
    candidates.push(resolve(world.taskDir, environment.driver));
    candidates.push(resolve(world.task.projectRoot, environment.driver));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** driver 动态 import 静态扫描（设计 §6.3：driver 限定单文件、无动态 import）。逐行匹配
 * /\bimport\s*\(/；整行注释（// / * 开头）与空行不算命中。动态 import 会运行时加载代码，
 * 使「driverHash 覆盖全文」的核验失去静态可预期性——哈希一致也证明不了 driver 行为。
 * 读不出全文按命中处理（fail-closed：无法证明无动态 import 的驱动不证明任何能力）。 */
function driverHasDynamicImport(driverPath) {
  let text;
  try {
    text = readFileSync(driverPath, "utf8");
  } catch {
    return true;
  }
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
    return /\bimport\s*\(/.test(line);
  });
}

/** driver 哈希核对（§6.3/§8.1）：driver 非空；声明 driverHash 时必须与驱动文件全文哈希
 * 一致，文件不可解析同样按不一致处理（fail-closed——不可核验的驱动不证明任何能力）；
 * 哈希一致后还须无动态 import（§6.3 driver 形态约束）。 */
function driverHashOkOf(world, environment) {
  if (environment === null || environment === undefined) return false;
  if (typeof environment.driver !== "string" || environment.driver.trim() === "") return false;
  const driverPath = driverResolvedPathOf(world, environment);
  if (driverPath === null) return false;
  if (typeof environment.driverHash !== "string" || environment.driverHash === "") return false;
  if (sha256File(driverPath, `environment.driver ${environment.driver}`) !== environment.driverHash) return false;
  return !driverHasDynamicImport(driverPath);
}

/** 参与 runtime 判定的证据记录（当前 revision、声明了契约能力或 runtimeProbe）。 */
function runtimeEvidenceRecordsOf(world, revision) {
  const records = [];
  for (const event of world.fold.evidence) {
    if (event.revision !== revision) continue;
    const hasCapabilities = Array.isArray(event.contractCapabilityIds) && event.contractCapabilityIds.length > 0;
    if (event.runtimeProbe !== true && !hasCapabilities) continue;
    const document = readEvidenceArtifactDocument(world, event);
    const driverPath = driverResolvedPathOf(world, document?.environment ?? null);
    records.push({
      eventId: event.eventId,
      actor: event.actor,
      revision: event.revision,
      runtimeProbe: event.runtimeProbe === true,
      contractCapabilityIds: hasCapabilities ? event.contractCapabilityIds : [],
      artifactReadable: document !== null,
      environment: document?.environment ?? null,
      cases: Array.isArray(document?.cases) ? document.cases : [],
      subject: document?.subject ?? null,
      driverHashOk: driverHashOkOf(world, document?.environment ?? null),
      // 动态 import 命中标记：仅在 kernel 判 driver-unverifiable 时用于给出具体原因
      //（判定单源仍在 runtimeEvidenceIntegrityGap，本字段只是呈现层归因）
      driverDynamicImport: driverPath !== null && driverHasDynamicImport(driverPath),
    });
  }
  return records;
}

/** 证据认领能力 → 当前权威逐契约哈希映射（contractCapabilityIds 前缀或单契约裸 id；
 * hash = null 表示该契约当前权威不可得——快照无条目或非 resolved）。 */
function capabilityAuthorityHashesOf(acceptance, record, snapshot) {
  const contracts = externalContractsOf(acceptance);
  return record.contractCapabilityIds
    .map((id) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : (contracts.length === 1 ? contracts[0].id : null)))
    .filter((id) => typeof id === "string")
    .map((contractId) => {
      const entry = snapshot.contracts.find((item) => item?.id === contractId);
      return {
        contractId,
        hash: entry === undefined ? null : contractAggregateHashOf(entry),
        status: entry?.status ?? "不在快照中",
      };
    });
}

/** 证据级权威核对（§8.1 第 4-6 条，与能力无关的维度）：sourceHash 与当前权威
 * aggregateHash 一致、driver 与 driverHash 可核、probe subject.revision 与事件 revision 一致。
 * 判定走 kernel-judgments.runtimeEvidenceIntegrityGap 单源（与 deriveRuntimeObligations 的
 * 证据核对同一函数，不各写一份）；消息措辞保持 gate 侧既有形态（测试冻结）。
 * 返回 null = 无缺口；非 null = 该证据最多 partial 的原因。 */
function runtimeEvidenceAuthorityGap(world, record, snapshot) {
  const authorityHashes = capabilityAuthorityHashesOf(world.acceptance, record, snapshot);
  const gap = runtimeEvidenceIntegrityGap({
    artifactReadable: record.artifactReadable,
    driverHashOk: record.driverHashOk,
    environment: record.environment,
    authorityHashes,
    subjectRevision: record.subject?.revision,
    eventRevision: record.revision,
  });
  if (gap === null) return null;
  switch (gap.kind) {
    case "artifact-unreadable":
      return "runtime probe artifact 不可读或不是 JSON 对象";
    case "driver-unverifiable":
      return record.driverDynamicImport === true
        ? "driver 含动态 import（违反 §6.3 driver 形态约束：driver 限定单文件、无动态 import——动态加载使 driverHash 核验失去静态可预期性）"
        : "environment.driver 缺失、文件不可解析或 driverHash 与驱动文件内容不一致";
    case "environment-missing":
      return "artifact 无 environment 元数据";
    case "sourceHash-missing":
      return "environment.sourceHash 缺失";
    case "authority-unresolved":
      return `契约 ${gap.contractId} 当前权威不可解析（status=${gap.status ?? "不在快照中"}）——无法核对证据 environment.sourceHash`;
    case "sourceHash-mismatch":
      return `environment.sourceHash 与契约 ${gap.contractId} 当前权威 aggregateHash 不一致（证据 ${gap.evidenceHash.slice(0, 12)}…，权威 ${gap.authorityHash.slice(0, 12)}…）`;
    case "subject-revision-mismatch":
      return `probe subject.revision（${gap.subjectRevision ?? "缺失"}）与证据事件 revision（${gap.eventRevision}）不一致——早期 spike 不能替代 final`;
    default:
      return `runtime 证据核对拒绝（未登记 kind ${String(gap.kind)}）`;
  }
}

/** runtime 义务 + readiness 组装（evaluate / obligations 共用）。
 * 结果按 world 对象身份 × revision memo（F12：delivery-core obligations 命令先跑 buildVerdict
 * 再显式调用本函数，同一 world 同一 revision 的两次完整组装（resolver spawn + 探测器 spawn +
 * artifact 读取）共享一次）。key = world 对象（每次 loadWorld 新建，天然按命令隔离）。 */
const RUNTIME_OBLIGATIONS_MEMO = new WeakMap();
function runtimeObligationsOf(world, revision) {
  let byRevision = RUNTIME_OBLIGATIONS_MEMO.get(world);
  if (byRevision === undefined) {
    byRevision = new Map();
    RUNTIME_OBLIGATIONS_MEMO.set(world, byRevision);
  }
  if (byRevision.has(revision)) return byRevision.get(revision);
  const result = assembleRuntimeObligations(world, revision);
  byRevision.set(revision, result);
  return result;
}

function assembleRuntimeObligations(world, revision) {
  const acceptance = world.acceptance;
  const contracts = externalContractsOf(acceptance);
  if (contracts.length === 0) {
    return { obligations: [], readiness: { overall: "not-applicable", contracts: [] }, snapshot: null, baseline: null, chainBroken: [], chainGaps: [], chainDisclosed: [], forced: new Set(), strongClasses: new Set(), rescanAvailable: true, rescanReason: null };
  }
  // evaluate 侧必须现场重解析权威（不允许读 taskDir 旧快照结论蒙混，设计 §4.4 第 6/7 条）
  const snapshot = resolveEnvironmentContracts(world.taskDir, world.task.projectRoot, { allowPointerFallback: false });
  const baseline = approvalBaselineHashes(world);
  const rescan = rescanStrongClasses(world);
  const strongClasses = rescan.classes;
  const forced = forcedEssentialCapabilityIds(acceptance, strongClasses);
  const essentialContracts = effectivelyEssentialContracts(acceptance, forced);
  const chainOk = new Set();
  const chainGaps = [];
  for (const contract of contracts) {
    const entry = snapshot.contracts.find((item) => item?.id === contract.id);
    const currentHash = entry === undefined ? null : contractAggregateHashOf(entry);
    // 批准时与当前均无该契约条目 = 从未有权威：无漂移可判（两快照相同，报「哈希不一致」
    // 自相矛盾）——设计 §6.2 豁免规则 4 / §17 例 18：非 essential 权威不可得走风险接受，
    // readiness 记 not-established，不 Chain 断裂
    const baselineHashes = baseline.hashes;
    const absentInBoth = entry === undefined && baselineHashes !== null && !baselineHashes.has(contract.id);
    if (absentInBoth) {
      chainOk.add(contract.id);
      continue;
    }
    if (currentHash !== null && environmentChainOk(contract.id, currentHash, baseline, world)) chainOk.add(contract.id);
    else {
      chainGaps.push({
        contractId: contract.id,
        essential: essentialContracts.has(contract.id),
        kind: entry === undefined
          ? (baselineHashes !== null && baselineHashes.has(contract.id) ? "authority-lost" : "approval-snapshot-unavailable")
          : "authority-drift",
        baselineHash: baselineHashes === null || !baselineHashes.has(contract.id) ? null : baselineHashes.get(contract.id),
        currentHash,
      });
    }
  }
  // 环境历史链阻断只覆盖 essential 契约；非 essential 契约的链缺口降为披露（进
  // missing.nonEssentialEnvironmentChain，不进 environmentChainBlock）
  const chainBroken = chainGaps.filter((gap) => gap.essential).map((gap) => gap.contractId);
  const chainDisclosed = chainGaps.filter((gap) => !gap.essential);
  const obligations = deriveRuntimeObligations({
    acceptance,
    environmentSnapshot: snapshot,
    evidence: runtimeEvidenceRecordsOf(world, revision),
    currentRevision: revision,
    forcedEssential: forced,
    chainOkContracts: chainOk,
  });
  const readiness = buildRuntimeReadiness(acceptance, obligations, essentialContracts, snapshot, rescan);
  return { obligations, readiness, snapshot, baseline, chainBroken, chainGaps, chainDisclosed, forced, strongClasses, rescanAvailable: rescan.available, rescanReason: rescan.reason };
}

/** readiness 汇总（§12.1）：overall 只看 effectively essential 契约；非增强契约的能力缺失
 * 不进入 overall，逐条披露在 nonEssentialGaps。 */
function buildRuntimeReadiness(acceptance, obligations, essentialContracts, snapshot, rescan = { available: true }) {
  const contracts = externalContractsOf(acceptance).map((contract) => {
    const entry = snapshot.contracts.find((item) => item?.id === contract.id);
    return {
      contractId: contract.id,
      essential: essentialContracts.has(contract.id),
      authorityHash: entry === undefined ? null : contractAggregateHashOf(entry),
      authorityStatus: entry?.status ?? "absent",
      capabilities: (Array.isArray(contract.capabilities) ? contract.capabilities : []).map((capability) => {
        const obligation = obligations.find((item) => item.contractId === contract.id && item.capabilityId === capability.id);
        return {
          id: capability.id,
          state: obligation?.readiness ?? "unknown",
          reason: obligation?.reason ?? "无对应 runtime 义务记录",
          evidenceEventId: obligation?.evidenceRefs?.[0] ?? null,
        };
      }),
    };
  });
  const essential = contracts.filter((contract) => contract.essential);
  const nonEssentialGaps = contracts
    .filter((contract) => !contract.essential)
    .flatMap((contract) => contract.capabilities.filter((capability) => capability.state !== "established").map((capability) => ({ contractId: contract.contractId, capabilityId: capability.id, state: capability.state, reason: capability.reason })));
  let overall = "established";
  if (essential.length === 0) {
    overall = "established";
  } else if (essential.some((contract) => contract.capabilities.some((capability) => capability.state === "unknown"))) {
    overall = "unknown";
  } else if (essential.some((contract) => contract.capabilities.some((capability) => capability.state !== "established"))) {
    overall = "not-established";
  }
  return {
    overall,
    contracts,
    ...(nonEssentialGaps.length > 0 ? { nonEssentialGaps } : {}),
    authorityAvailable: snapshot.available === true,
    ...(snapshot.reason !== null && snapshot.reason !== undefined ? { authorityReason: snapshot.reason } : {}),
    // 候选复扫可用性：探测脚本缺失时复扫未执行——如实披露，不得当成「无未登记信号」
    candidateRescanAvailable: rescan.available === true,
    ...(rescan.available !== true ? { candidateRescanReason: rescan.reason ?? "未说明" } : {}),
  };
}

/** 探测 CLI 输出（按 world 对象身份 memo，F12：evaluate 前置的复扫与 runtimeObligationsOf
 * 的复扫共享一次探测器 spawn——同一输入跑两遍既慢又可能给出两个结论）。key = world 对象
 * （loadWorld 每次命令新建，天然按次隔离，不会跨命令残留）× 项目根。 */
const DETECTOR_OUTPUT_MEMO = new WeakMap();
function detectorOutputOf(world) {
  let byProjectRoot = DETECTOR_OUTPUT_MEMO.get(world);
  if (byProjectRoot === undefined) {
    byProjectRoot = new Map();
    DETECTOR_OUTPUT_MEMO.set(world, byProjectRoot);
  }
  const key = world.task.projectRoot;
  if (byProjectRoot.has(key)) return byProjectRoot.get(key);
  const intentPath = join(world.taskDir, "intent.md");
  const args = ["--project-root", world.task.projectRoot];
  if (existsSync(intentPath)) args.push("--intent-file", intentPath);
  const outcome = runExternalContractScript(detectorScriptPath(), args);
  byProjectRoot.set(key, outcome);
  return outcome;
}

/** 候选复扫（§8.1 第 1 条 / §7.3 D3）：对当前候选源码重跑完整候选探测，strong 信号与蕴含
 * 观察类必须映射到已声明 capability，unresolved 外部访问必须清零。
 * 返回 {available, classes}——探测脚本不可用时 available=false（调用方按 fail-closed 处理，
 * 不把「没扫」当成「无信号」）。 */
function rescanStrongClasses(world) {
  const acceptance = world.acceptance;
  if (externalContractsOf(acceptance).length === 0) return { available: true, classes: new Set(), reason: null };
  const outcome = detectorOutputOf(world);
  if (!outcome.ok) return { available: false, classes: new Set(), reason: outcome.reason };
  return {
    available: true,
    classes: strongClassesFromSnapshot({ available: true, document: outcome.parsed }, externalContractClassesPolicy(world)),
    reason: null,
  };
}

/** evaluate 前置（§8.1）：候选复扫（判定单源 = contract-rescan 库，D0/D3 同一实现）+
 * EnvironmentBaselineConfirmed 预算规则。复扫命中未登记 strong 信号、未处置 strong 候选或
 * 未解外部访问 → 直接拒绝 evaluate（不是判个 candidate 了事）。触发条件与 D0 对齐
 *（contract-rescan 库同款：externalContracts / externalContractReview 任一在场即跑，两键
 * 全无 = 升级前旧任务豁免路径）——只看 contracts 会在 review-only 验收包上留下 D0 有复扫、
 * evaluate 没有的缺口（同一验收包两侧判定不一致）。 */
function externalContractPreflight(world) {
  const acceptance = world.acceptance;
  if (!Object.hasOwn(acceptance, "externalContracts") && !Object.hasOwn(acceptance, "externalContractReview")) return;
  // 预算规则（§4.3/§10）：同一 acceptanceVersion 内最多一次 EnvironmentBaselineConfirmed，
  // 再次环境漂移必须 open-revision 或停回——不允许用环境重试掩盖实现缺陷
  const baselines = world.fold.environmentBaselines.filter((event) => event.acceptanceVersion === acceptance.acceptanceVersion);
  if (baselines.length > 1) {
    fail(
      `同一验收版本（v${acceptance.acceptanceVersion}）内登记了 ${baselines.length} 次 EnvironmentBaselineConfirmed（上限 1 次）。`,
      "外部环境再次漂移时停回用户裁决：① 走 open-revision 重新核对验收（递增 acceptanceVersion）；② 或由用户重新定义目标；不得继续用环境基线确认重试。",
    );
  }
  // 复扫判定：探测器输出与 runtimeObligationsOf 的复扫共享一次 spawn（detectorOutputOf memo）
  const rescan = runContractRescan({
    taskDir: world.taskDir,
    projectRoot: world.task.projectRoot,
    acceptance,
    detection: detectorOutputOf(world),
    detectorPath: detectorScriptPath(),
    policyDocument: externalContractClassesPolicy(world),
  });
  if (rescan.detectorAvailable !== true) {
    // 探测脚本不可用：不伪造「无信号」结论——复扫缺口进 verdict 披露并阻断 accepted
    const first = rescan.errors[0];
    const detail = first === undefined ? "未说明" : renderRescanErrorGate(first);
    process.stderr.write(`delivery-gate: 外部契约候选复扫不可用（${detail}）：本次 evaluate 无法确认无未登记 strong 信号，accepted 判定按 fail-closed 处理。\n`);
    return;
  }
  if (!rescan.ok) {
    const first = rescan.errors[0];
    fail(`外部契约候选复扫未过：${renderRescanErrorGate(first)}`, rescanRecoveryGate(first));
  }
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

  // 外部契约运行可用性（§6.1/§8.1/§12.1）：权威现场重解析 + runtime 义务派生 + readiness。
  // 无外部契约时整体短路（零开销、零行为变化——普通任务不受影响）
  const runtime = runtimeObligationsOf(world, revision);
  const runtimeAuthorityGaps = new Map();
  if (runtime.snapshot !== null) {
    for (const record of runtimeEvidenceRecordsOf(world, revision)) {
      if (record.runtimeProbe) {
        const gap = runtimeEvidenceAuthorityGap(world, record, runtime.snapshot);
        if (gap !== null) runtimeAuthorityGaps.set(record.eventId, gap);
        continue;
      }
      // 非 probe 宿主证据（带 capability 绑定，§8.1 第 4 条不区分证据类型）：sourceHash 在场
      // 且对应契约权威 aggregateHash 可得时不一致即降 partial——环境身份造假不因证据不是
      // probe 就放行。driver / subject.revision 是 probe 专属核对项（非 probe 证据没有这些
      // 字段），不在本核对范围；sourceHash 缺失同样不拦（只核在场值的真实性）。
      // 设计边界（登记）：权威不可得（快照无该契约条目或非 resolved）时不猜测——该证据不因
      // 权威缺口降级，权威侧缺口由 readiness 与 runtime 义务判定披露
      if (record.contractCapabilityIds.length === 0) continue;
      const evidenceHash = typeof record.environment?.sourceHash === "string" && record.environment.sourceHash !== ""
        ? record.environment.sourceHash
        : null;
      if (evidenceHash === null) continue;
      for (const entry of capabilityAuthorityHashesOf(world.acceptance, record, runtime.snapshot)) {
        if (typeof entry.hash !== "string" || entry.hash === "") continue;
        if (entry.hash !== evidenceHash) {
          runtimeAuthorityGaps.set(
            record.eventId,
            `environment.sourceHash 与契约 ${entry.contractId} 当前权威 aggregateHash 不一致（证据 ${evidenceHash.slice(0, 12)}…，权威 ${entry.hash.slice(0, 12)}…）——非 probe 宿主证据同样受 sourceHash 核对约束（§8.1 第 4 条）`,
          );
          break;
        }
      }
    }
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
  // 失效是既有语义，recheck 自身补齐当前 revision 的全量证据）。
  // 谓词走内核单源（kernel-judgments.priorFullQualification——V6 前此处为闭包内联实现，
  // workflow 侧另持两份弱化副本靠注释同步；现收敛为一份，gate / core / workflow 消费
  // 同一谓词，fold 输入即本函数折算产物的三组记录）
  const priorFullJudgment = priorFullQualification(
    { assurances: fold.assurances, evidence: fold.evidence, explorations: fold.explorations },
    {
      incrementIds: allIncrementIds,
      usesAssertions,
      exploratoryReviewRequired: acceptance.exploratoryReview === "required",
    },
  );
  const qualifiedPriorFullById = new Map(priorFullJudgment.inspections.map((item) => [item.eventId, item.qualified]));
  const hasPriorValidFull = (event) =>
    fold.assurances.some(
      (full) => (full.mode ?? "full") === "full" && full.seq < event.seq && qualifiedPriorFullById.get(full.eventId) === true,
    );
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
          // 环境要求检查（机制二 §6.2）：带 requiredEnvironment 的断言，其 verified 证据
          // 必须携带满足要求的环境元数据；不满足降级 partial——真实环境不可用时只能
          // unknown/partial，不能 verified（模拟环境不能独立证明宿主类契约）
          const environmentGap = assertionEnvironmentGap(world, assertion, event);
          // runtime probe 证据的权威核对（§8.1 第 4-6 条）：sourceHash/driver/driverHash/
          // subject.revision 任一项不通过 → 该证据最多 partial（与 runtime 义务 open 同源）
          const runtimeGap = event === undefined || event === null ? null : runtimeAuthorityGaps.get(event.eventId) ?? null;
          const downgraded = (environmentGap !== null || runtimeGap !== null) && event !== undefined && event !== null && event.result === "verified";
          const result = event === undefined || event === null ? "missing" : downgraded ? "partial" : event.result;
          const gapId = result === "verified" ? null : missingGapId(currentVersion, assertion.id, kind, revision);
          if (result !== "verified") missingAssertionIds.push({ assertionId: assertion.id, requirementId: requirement.id, kind, result, gapId });
          return {
            kind,
            result,
            eventId: event ? event.eventId : null,
            artifact: event ? event.artifact : null,
            gapId,
            riskAccepted: false,
            ...(environmentGap !== null ? { environmentGap } : {}),
            ...(runtimeGap !== null ? { runtimeEvidenceGap: { reason: runtimeGap } } : {}),
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
  // uniqueMustFix 计数按策略分类实例化：「阻断位」= blocksAccepted===true 的分类集合
  //（默认 defect），不字面量比对分类 id——策略新增阻断分类后预算与裁决口径保持一致
  const uniqueMustFix = new Set(
    [...findingById.values()]
      .filter((event) => policyFindingCategory(world.policy, event.category)?.blocksAccepted === true && event.severity === "blocker")
      .map((event) => rootFindingId(event.findingId)),
  );
  // 计轮与预算走内核单源（kernel-judgments.repairBudgetFromEvents）。perVersion 口径不变：
  // behavior 性质的 RepairRoundRecorded + 同任务内首次 AssuranceCompleted 之后的
  // DesignApproved（方案修订）与 AcceptanceApproved（验收版本递增）各按一轮并入——否则
  // 方案/验收修订路径绕过 3 轮上限（nature=environment/evidence 不计轮）。
  // V5 新增跨 run 保证预算：保证 run 次数（AssuranceCompleted）+ perVersion 轮数超过
  // assuranceCrossRunCap 同样进入 process-failed——跨 run「重取证→新发现→再修复」循环
  // 失控（V4 实跑双场实证：失控场输出为交付物的 3.73 倍）由此获得机器上界
  // 跨 run 保证预算优先读 loop-attempts 账本的 started 计数（V5 完整性设计 §8.1 口径：
  // 进入循环即计数，失败 run 同样消耗预算）；账本无 assurance 记录（迁移前旧任务）时
  // 内核回退 AssuranceCompleted 事件计数并附 migrationNote，两口径不并存猜测
  const loopAttemptsPath = join(world.taskDir, "loop-attempts.jsonl");
  const budget = repairBudgetFromEvents(world.entries.map((entry) => entry.record), {
    attemptRows: existsSync(loopAttemptsPath) ? parseLoopAttemptsText(readFileSync(loopAttemptsPath, "utf8")) : null,
  });
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
    // 验收复审尝试预算（机制四 §8.1）：按 loop-attempts.jsonl 的 started 计数（跨 run 累计，
    // 打回/失败/中断均计），不再按成功登记的 AcceptanceReviewed 计数——后者漏掉主要失败路径
    acceptanceReReviewLoop: (() => {
      const loopBudget = readLoopAttemptsBudget(world.taskDir, "acceptance-review");
      return { used: loopBudget.started, cap: loopBudget.cap, exceeded: loopBudget.exceeded };
    })(),
  };
  // revision 来源对账（机制三 §7.2）：候选形成锚点存在时，每次 revision 变化必须有合法
  // 来源；无法解释的区间（手工直改 / 外部进程写入）记 unknown——不得进入交付终态
  const provenance = deriveRevisionProvenance(world.entries.map((entry) => entry.record), { currentRevision: revision });
  const revisionUnknown = provenance.unknownCount > 0;
  const processFailed =
    uniqueMustFix.size > KERNEL_RULES.budgets.uniqueMustFixCap ||
    budget.perVersionUsed > budget.perVersionCap ||
    budget.crossRunExceeded ||
    budgetsBlock.acceptanceReReviewLoop.exceeded;
  // 循环外实现性修复呈报（不硬拦，显式披露不静默）：同验收版本最后一次保证之后
  // revision 前进，且其间无 RepairRoundRecorded（受控修复循环）、无新增
  // ImplementationRecorded（candidate-build 补增量）、无 AssuranceRevisionDrift（保证
  // 期间漂移登记）——revision 变化无任何登记通道 = 疑似绕过修复循环直接改实现（主会话
  // 裸提交或外部写入）。主 agent 读到该披露后：属真实旁路修复 → 回 assurance-repair-loop-v6
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
  //   blocksAccepted=true → defect 位（默认 defect 分类）；blocksAccepted="until-confirmed" →
  //   boundary 位（确认前阻塞且不可接受，默认 boundary 分类）；blocksAccepted=false → 不阻终态
  // 三档分级的裁决落地：阻断收敛在 blocker 档——must-fix 映射 blocker+defect（修复或用户
  // 接受风险后放行）；suggestion / info 映射 non-blocker+defect，披露即可不阻终态（修复
  // 循环只修 blocker，non-blocker 若阻断则披露档永不收敛、accepted 无机器出口）。open
  // non-blocker 照常进 verdict.openFindings 与 openDefects 披露，accept-risk 对其仍可用
  //（显式接受）但不再是终态前置
  const openDefects = openFindings.filter(
    (finding) => policyFindingCategory(world.policy, finding.category)?.blocksAccepted === true,
  );
  const unconfirmedBoundaries = openFindings.filter(
    (finding) => policyFindingCategory(world.policy, finding.category)?.blocksAccepted === "until-confirmed",
  );
  const openBlockerDefects = openDefects.filter((finding) => finding.severity === "blocker");
  const unacceptedDefects = openBlockerDefects.filter((finding) => !finding.riskAccepted);

  // 交付义务派生（机制三 §7.1）：断言/阶段 state 全部复用上方既有缺口判定（聚合派生，
  // 不另立第二套判定）；受控修复轮与 blocking 待办从事件流与 pending-actions 派生。
  // 输入用与 missing 组装同源的局部事实构造 verdict 视图（判定本体只有 buildVerdict 一份）
  const missingFacts = {
    designApproval: !designApproved,
    incrementIds: missingIncrementIds,
    assuranceCompleted: !assuranceCompleted,
    explorationCompleted:
      (usesAssertions ? fold.explorations.length === 0 : acceptance.exploratoryReview === "required") && !explorationCompleted,
  };
  const obligationJudgment = deriveObligations({
    verdict: { requirements, missing: missingFacts },
    acceptance,
    records: world.entries.map((entry) => entry.record),
    pendingItems: readPendingItems(world.taskDir),
    verificationOnly: world.task.verificationOnly === true,
    // design 阶段是否必需与状态路由同一判定源（requireDesignApproved 策略开关）——
    // 策略允许跳过 design 时不得把它判成 open 义务阻断 accepted（义务视图不覆盖策略裁决）
    designStageRequired: rules.requireDesignApproved !== false,
    // 外部契约 runtime 义务（§6.1/§6.2）：不可豁免，无 explicitly-waived 态
    runtimeObligations: runtime.obligations,
  });
  const openObligations = obligationJudgment.openRequired;
  // accepted 前置（机制三）：存在 open 必需义务不得 accepted；revision 来源不明的区间
  // 同样阻断（两个交付终态一并阻断——用户裁决豁免只适用于既有规则允许的事项，
  // 无法解释的代码变化不在可豁免范围内，出路是补登记 / 恢复基线 / 用户确认新基线）
  const obligationsBlock = openObligations.length > 0;
  // accepted 前置（§6.2/§12.1）：全部 essential 外部契约的 runtime 能力 established
  // （含证据环境满足 capability.minEnvironment 与 sourceHash 核对——两者已编码进 readiness），
  // 且每个契约的环境历史链完好。unknown 不写成成功：不可判定时同样阻断
  const runtimeReadinessBlock = runtime.readiness.overall !== "established" && runtime.readiness.overall !== "not-applicable";
  const environmentChainBlock = runtime.chainBroken.length > 0;
  // 候选复扫不可用（探测脚本缺失/执行失败）：不伪造「无未登记 strong 信号」结论——fail-closed
  const candidateRescanBlock = runtime.rescanAvailable !== true;

  // accepted 要求全部必需证据 verified、无未决 blocker defect（不是「全部缺口被接受」——
  // 被接受的缺口只通往 accepted_with_risk；non-blocker defect 披露即可不阻，见三档分级注释）
  const accepted =
    !processFailed &&
    approved &&
    missingIncrementIds.length === 0 &&
    evidenceGaps.length === 0 &&
    assuranceCompleted &&
    explorationSatisfied &&
    openBlockerDefects.length === 0 &&
    unconfirmedBoundaries.length === 0 &&
    !obligationsBlock &&
    !runtimeReadinessBlock &&
    !environmentChainBlock &&
    !candidateRescanBlock &&
    !revisionUnknown;

  // accepted_with_risk：在 accepted 之外逐项豁免——每个缺口独立判定，两类证据缺口各自需有效接受
  const acceptableWithRisk =
    !processFailed &&
    approved &&
    missingIncrementIds.length === 0 &&
    assuranceCompleted &&
    explorationSatisfied &&
    unacceptedEvidenceGaps.length === 0 &&
    unacceptedDefects.length === 0 &&
    (evidenceGaps.length > 0 || openBlockerDefects.length > 0) &&
    unconfirmedBoundaries.length === 0 &&
    !obligationsBlock &&
    !runtimeReadinessBlock &&
    !environmentChainBlock &&
    !candidateRescanBlock &&
    !revisionUnknown;

  // ── 状态路由（redesign 3.7 优先级表，自上而下首条命中）──
  const unacceptedFailed = requirements.filter(
    (requirement) => requirement.required && requirement.evidence.some((item) => item.result === "failed" && !item.riskAccepted),
  );
  const unacceptedBlockers = openBlockerDefects.filter((finding) => !finding.riskAccepted);
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
  // 未接受 non-blocker defect 不再单独路由到 candidate（三档分级裁决落地：披露即可不阻，
  // 清单见 verdict.openFindings；其余条件齐时直达 accepted / accepted_with_risk）
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
    // 验收复审尝试预算超限（机制四 §8.1）：与既有预算超限同型（process-failed 停回）；
    // 计数含打回/校验失败/中断（started 事件），恢复 = 停回用户裁决，不以重开 run 重置
    loopAttempts: budgetsBlock.acceptanceReReviewLoop.exceeded
      ? {
          loop: "acceptance-review",
          started: budgetsBlock.acceptanceReReviewLoop.used,
          cap: budgetsBlock.acceptanceReReviewLoop.cap,
          recovery: `验收复审已尝试 ${budgetsBlock.acceptanceReReviewLoop.used} 次（上限 ${budgetsBlock.acceptanceReReviewLoop.cap}，按 loop-attempts.jsonl started 计数，打回/失败/中断均计）：停止继续重发，停回用户裁决验收方案；确需继续时由用户显式批准新的复审预算并登记说明`,
        }
      : null,
    // revision 来源对账缺口（机制三 §7.2）：unknown 区间 = 无登记来源的代码变化。
    // 恢复三选一：补做合法修复登记 / 恢复已知基线 / 由用户确认新的外部基线
    //（confirm-baseline 为既有命令；其确认事件 RevisionBaselineConfirmed 会作为
    // external-baseline 来源进入对账链条）
    revisionProvenance: revisionUnknown
      ? {
          unknownCount: provenance.unknownCount,
          unknowns: provenance.revisions.filter((item) => item.source === "unknown"),
          explainedRevision: provenance.explainedRevision,
          recovery: "存在来源不明的 revision 变化，不得交付：①属真实修复 → 回 assurance-repair-loop-v6 补做带 from/to revision 的受控修复登记（record-repair-round）；②属无关改动 → 恢复项目内容到已解释的基线（git 恢复）；③属合法外部基线前进（链条继续向前） → 由用户执行 delivery-gate confirm-baseline 确认新基线后重新 evaluate；④属历史断链段（候选形成后已存在的旧 unknown 区间，多会话/外部写入留下的无来源代际） → 由用户执行 delivery-gate confirm-history 逐段署名确认（--intervals 须与 revision-provenance 输出的 unknown 区间精确匹配；只解释历史、不推进链条）。①②③消除或覆盖 unknown 后重新 evaluate；confirm-history 适用判据 = 该区间已是历史（后续已有合法锚点续接），需要确立新基线时走 confirm-baseline",
        }
      : null,
    // open 必需义务清单（机制三 §7.1）：accepted 前置——非空即不得进入交付终态。
    // 恢复动作按义务类型指向既有裁决命令；stage/repair/pending 类的显式豁免通道尚未
    // 登记（现有豁免只有 accept-risk 绑定断言缺口），不得凭空 waived
    openObligations: openObligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      sourceRef: obligation.sourceRef,
      ...(obligation.kind === "runtime"
        ? {
            contractId: obligation.contractId,
            capabilityId: obligation.capabilityId,
            readiness: obligation.readiness,
            ...(obligation.reason !== undefined && obligation.reason !== null ? { reason: obligation.reason } : {}),
          }
        : {}),
      recovery:
        obligation.kind === "assertion"
          ? "补齐证据至 verified（重新取证），或对允许风险的缺口执行 accept-risk（用户裁决）"
          : obligation.kind === "runtime"
            ? `外部契约能力 ${obligation.contractId}:${obligation.capabilityId} 未在当前 revision 由 official-runner/real-host 证据建立（${obligation.reason ?? "无 probe 观察通过记录"}）。恢复动作：① 由 assurance 以真实 runner/宿主重跑 runtime probe（driver 单文件、driverHash 覆盖全文）并 record-evidence --runtime-probe --contract-capability-ids '["${obligation.contractId}:${obligation.capabilityId}"]'；② 权威变化时先由用户 confirm-environment-baseline 接上环境历史链再重跑 probe；③ 环境确实不可得时停回用户裁决「目标环境不可满足」，不得写成 accepted / accepted_with_risk。runtime 义务没有豁免通道（accept-risk / preauthorize-risk 都不消化它）`
            : obligation.kind === "pending"
              ? "执行 delivery-core pending resolve 关闭该待办（或按其 note 完成事项后 resolve）"
              : obligation.kind === "stage"
                ? "按 verdict.missing 对应条目的恢复动作推进该阶段（阶段无独立豁免通道，走正常交付流程）"
                : "核对修复轮登记完整性（受控修复轮须带 from/to revision 与全量回执）",
    })),
    assuranceFullFirst:
      recheckWithoutFull.length > 0
        ? {
            reassuranceCount: recheckWithoutFull.length,
            note: "当前 revision 存在基础校验通过的 recheck 保证，但其之前无登记时点完整的 full（同验收版本、receipts 覆盖全部增量、证据可解析、探索引用存在——任意 revision）——首次完整保证不可被定向复核替代。恢复动作：先运行 independent-assurance-v6（mode=full）完成首次完整取证，再以 recheck 做修复后定向复核",
          }
        : null,
    // 外部环境历史链断裂（§4.3/§10）：契约当前权威哈希与批准时不一致（或批准时快照不可用），
    // 且事件链无覆盖该 contractId 的 EnvironmentBaselineConfirmed 接链。只阻断 essential
    // 契约；非 essential 契约的链缺口降为披露（见 missing.nonEssentialEnvironmentChain）。
    // 「批准时与当前均无该契约条目」按无漂移（从未有权威），不进本字段
    environmentChain: runtime.chainBroken.length > 0
      ? {
          contractIds: runtime.chainBroken,
          gaps: runtime.chainGaps.filter((gap) => gap.essential),
          approvalSnapshotSha256: runtime.baseline.approval?.authoritySnapshotSha256 ?? null,
          currentSnapshotSha256: runtime.snapshot?.snapshotSha256 ?? null,
          // 两成因并列（恢复动作按成因给，不默认全是「哈希漂移」）：① 批准时与当前均无该
          // 契约条目——权威从未建立；② 当前权威缺失或与批准时不一致——环境变化/权威丢失
          // 未经用户确认
          reason: `契约 ${runtime.chainBroken.join(", ")} 的环境历史链不完整（两成因：① 批准时与当前均无该契约条目——权威从未建立；② 当前权威缺失或与批准时不一致——环境变化或权威丢失未经用户确认）`,
          recovery: `先跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${JSON.stringify(world.taskDir)} --project-root ${JSON.stringify(world.task.projectRoot)} --write 重建/确认当前权威快照，再按成因三选一：① 把外部环境恢复到批准版本；② 或由用户执行 ${GATE_COMMAND} confirm-environment-baseline 确认新基线，然后在当前环境重跑 runtime probe；③ 契约语义确实变化时走 open-revision 重新核对验收。同一 acceptanceVersion 内最多确认一次基线。`,
        }
      : null,
    // 非 essential 契约的环境链缺口（披露不阻断）：设计 §6.2 豁免规则 4 / §17 例 18——
    // 未进入验收断言的可选集成权威不可得时走普通风险接受，readiness 记 not-established
    nonEssentialEnvironmentChain: runtime.chainDisclosed.length > 0
      ? {
          contractIds: runtime.chainDisclosed.map((gap) => gap.contractId),
          gaps: runtime.chainDisclosed,
          recovery: `契约 ${runtime.chainDisclosed.map((gap) => gap.contractId).join(", ")} 为非增强契约：链缺口不阻断 accepted/accepted_with_risk，按普通风险接受通道处理（accept-risk），runtimeReadiness 如实记 not-established。恢复动作三选一：① 补跑 resolve --write 建立权威；② 由用户执行 ${GATE_COMMAND} declare-external-authority 登记 local-path / executable 权威后重跑 resolve；③ 确不需要该集成时走风险接受并披露。`,
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
    // 运行可用性阻断的下一步指引（F8/F9）：readiness 未建立或环境链断裂时直接输出对应
    // recovery 三段式，不走通用 accept-risk 文案（runtime 义务没有豁免通道）
    runtimeReadiness: runtime.readiness,
    runtimeOpenObligations: openObligations.filter((obligation) => obligation.kind === "runtime"),
    environmentChain: missing.environmentChain,
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
    // 外部契约运行可用性（§12.1）：逐契约能力结论。unknown 不写成成功——报告首段据此披露
    runtimeReadiness: runtime.readiness,
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
  runtimeReadiness = null,
  runtimeOpenObligations = [],
  environmentChain = null,
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
    return `先 set-intent 与 snapshot-policy 固定意图与策略，再运行 delivery-v6/acceptance-design-v6 复核验收包，由用户执行 ${GATE_COMMAND} approve-acceptance --task-dir ${taskArg} --confirmation user-explicit --summary "批准当前验收" --credential ${JSON.stringify(userCredential)}。`;
  }
  if (state === "design") {
    return `运行 tech-design-v6 产出完整方案包（设计文档目录 + 渲染视图 + impl-plan（JSON 单源 + 渲染视图）+ 审查终态），用户确认后执行 ${GATE_COMMAND} record-design-approved 登记方案包哈希清单。`;
  }
  if (state === "revision-unstable") {
    return `连续漂移超上限：人工排查项目写入源后由用户执行 ${GATE_COMMAND} confirm-baseline --task-dir ${taskArg} --reason "排查结论" --credential ${JSON.stringify(userCredential)} --revision ${revisionArg} 确认新基线。`;
  }
  if (state === "process-failed") {
    const budgetDetail = budgets === null
      ? `rounds=${repairRounds}，含修复轮与保证后的方案/验收修订`
      : `修复轮预算 ${budgets.repairPerVersion.used}/${budgets.repairPerVersion.cap}、跨 run 保证预算 ${budgets.assuranceCrossRun.used}/${budgets.assuranceCrossRun.cap}、不同 must-fix ${budgets.uniqueMustFix.count}/${budgets.uniqueMustFix.cap}`;
    // 验收复审尝试超限（机制四 §8.1）时在既有预算明细后追加成因段（仅超限场景追加，
    // 不改动其他 process-failed 场景的既有文案）
    const loopNote =
      budgets !== null && budgets.acceptanceReReviewLoop?.exceeded === true
        ? `；验收复审尝试 ${budgets.acceptanceReReviewLoop.used}/${budgets.acceptanceReReviewLoop.cap}（loop-attempts started 计数，含打回/失败/中断）`
        : "";
    return `预算耗尽停回用户（${budgetDetail}${loopNote}）：停止继续补丁与重取证，由用户裁决——按 finding 的 origin 与 expectedStage 回验收、设计或实现阶段重做，或使用任务替换并完整披露本任务失败原因。`;
  }
  if (unacceptedFailed.length > 0) {
    return `修复需求 ${unacceptedFailed.join(", ")} 的 failed 证据并运行 delivery-v6/candidate-build-v6 + independent-assurance-v6（taskDir=${taskArg}）；仅对允许风险的缺口执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (unacceptedBlockers.length > 0) {
    const unlinked = unacceptedBlockers.filter((findingId) => {
      const finding = world.fold.findings.get(findingId);
      return finding !== undefined && finding.raised.requirementIds.length === 0;
    });
    return `修复并解决 blocker ${unacceptedBlockers.join(", ")}${unlinked.length > 0 ? `（其中 ${unlinked.join(", ")} 无关联需求，修复时全部增量复查）` : ""}，或对允许风险的 finding 执行 accept-risk，然后执行 ${evaluate}。`;
  }
  if (state === "acceptance-approved" || missingIncrementIds.length > 0) {
    return `运行 delivery-v6/candidate-build-v6（taskDir=${taskArg}）完成增量 ${missingIncrementIds.join(", ") || "全部待实施增量"}，然后执行 ${evaluate}。`;
  }
  if (state === "accepted") {
    return `保留 verdict.json 与原始证据作为当前交付裁决；代码或验收变化后运行 delivery-v6/independent-assurance-v6，并执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  if (state === "accepted_with_risk") {
    return `按 verdict.json 中已接受的风险交付并逐项披露；下一内容版本运行 delivery-v6/independent-assurance-v6，再执行 ${GATE_COMMAND} evaluate --task-dir ${taskArg} --revision <新revision>。`;
  }
  if (unlinkedNonBlockers.length > 0) {
    return `未接受的 non-blocker ${unlinkedNonBlockers.join(", ")} 无关联需求——修复时全部增量复查（或对其执行 accept-risk）；再运行 delivery-v6/independent-assurance-v6（taskDir=${taskArg}）补齐 missing.evidence 与当前保证，然后执行 ${evaluate}。`;
  }
  // 运行可用性阻断（§6.2/§12.1）：readiness 未建立/未知或环境链断裂时，直接给对应的恢复
  // 三段式——runtime 义务没有豁免通道，通用 accept-risk 文案在这里是错误指引
  const readinessBlocked = runtimeReadiness !== null
    && runtimeReadiness.overall !== "established"
    && runtimeReadiness.overall !== "not-applicable";
  if (readinessBlocked || environmentChain !== null) {
    const details = runtimeOpenObligations.length > 0
      ? runtimeOpenObligations.map((obligation) => obligation.recovery).join("；")
      : `外部契约 runtime readiness=${runtimeReadiness?.overall ?? "未知"}：逐契约能力结论见 verdict.runtimeReadiness（unknown 不写成成功）。`;
    const chainNote = environmentChain !== null ? `环境历史链：${environmentChain.recovery}` : "";
    return `运行可用性未建立（runtimeReadiness.overall=${runtimeReadiness?.overall ?? "未知"}${environmentChain !== null ? "，环境历史链断裂" : ""}）——不得按通用风险接受处理（runtime 义务没有豁免通道）。${details}${chainNote}然后执行 ${evaluate}。`;
  }
  return `运行 delivery-v6/independent-assurance-v6（taskDir=${taskArg}）补齐 missing.evidence、当前保证与探索审查；对允许风险的缺口执行 accept-risk（多缺口时用 --gap-id 指定其一），然后执行 ${evaluate}。`;
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
  return join(LEASE_DIR(), `${projectSlug(projectRoot)}.json`);
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
        "先运行 independent-assurance-v6 --mode explore-only（或 candidate-build-v6 内置候选探索），处置 must-fix 并补回归测试；代码变化后在新的 revision 重新探索，再登记 ImplementationRecorded。",
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
    // V6 代：授权声明先于验收包存在（托管开始前登记），任务级事件形态
    "RiskPreauthorized",
    // V6 代：外部权威登记先于验收包存在（本地 SDK / 官方二进制的用户凭据登记）
    "ExternalAuthorityDeclared",
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
  if (!existsSync(DELIVERY_DATA_DIR())) return tasks;
  for (const group of readdirSync(DELIVERY_DATA_DIR(), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(DELIVERY_DATA_DIR(), group.name);
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
    optional: ["intent-file", "delivery-profile"],
    flags: ["new-round", "resume-existing", "verification-only"],
  });
  // 任务分级（设计 §13）：缺省 b；只接受 a/b/c（降档只减审查席与分区，不减必做机器门）
  const deliveryProfile = Object.hasOwn(options, "delivery-profile") ? options["delivery-profile"] : "b";
  requireEnum(deliveryProfile, DELIVERY_PROFILES, "--delivery-profile");
  if (options["new-round"] && options["resume-existing"]) {
    fail("--new-round 与 --resume-existing 互斥：继续既有任务用 --resume-existing，开新一轮目录用 --new-round。", "按目标二选一后重试 init。");
  }
  validateTaskId(options["task-id"]);
  requireExistingDirectory(options["project-root"], "--project-root");
  const projectRoot = realpathSync(options["project-root"]);
  const groupSlug = projectSlug(projectRoot);
  const groupDir = join(DELIVERY_DATA_DIR(), groupSlug);
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
      deliveryProfile: existing.deliveryProfile ?? "b",
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
      deliveryProfile: existing.deliveryProfile ?? "b",
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
    deliveryProfile,
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
    deliveryProfile,
    ...identityNote,
    siblingTasks,
    ...(siblingTasks.length > 0
      ? {
          notice:
            `该 worktree 分组下已有其他交付任务（${siblingTasks.map((task) => task.taskId).join("、")}）。` +
            "init 前必须确认本会话对该 worktree 的归属：任务目录不是本会话创建时立即停止并核实；评测等多会话同题环境，每场评测必须基于干净基线新建自己的 worktree，禁止读写他人任务目录。",
        }
      : {}),
    credentialDir: join(CREDENTIAL_KEY_DIR(), groupSlug, taskId),
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
  // 外部契约声明层静态检查（设计 §5.1 检查 2/3/5/8）：候选处置表 + resolved 权威快照。
  // 放在结构层之后：结构先合法才有对账对象。返回声明层算出的强类集合（检查 8 透传）。
  // 触发条件（§5.1 检查 2 的世代口径）：externalContracts 键存在，或任务属 V6 升级后
  // 新建（task.json 带 deliveryProfile——validateTaskRecord 注释明示该字段是「升级后新建
  // 任务」的世代判别锚，init 统一写入）。新任务即使无外部契约也必须有 externalContractReview
  // 键（允许空处置表）；升级前旧任务（无 deliveryProfile）无法判世代，退化为「externalContracts
  // 在场则 review 必填」——残余缺口：旧任务「两键全无」场景不受检查（升级兼容的代价）
  let externalContractStrongClasses = new Set();
  if (Object.hasOwn(world.acceptance, "externalContracts") || Object.hasOwn(world.task, "deliveryProfile")) {
    // profile=a 机器降档与验收探索维度的对账（设计 §13）：IA 侧把探索维度降为
    // 「外部契约 / 故障形态」两类，gate 的 ExplorationCompleted 维度覆盖检查要求完整覆盖
    // acceptance.reviewDimensions——两侧词表不一致时 full 模式必败且循环无法收敛，
    // 故在验收侧机器约束。放在声明层之前：维度词表是纯静态作者约束，先于需要 IO 的
    // 候选快照/权威对账给出错误。只在 validate-acceptance 命令执行（不进 loadWorld 热
    // 路径——否则批准后改分级会把任务锁死在「任何命令都跑不了」的状态，那种情形的兜底
    // 是 ExplorationCompleted 追加时的维度覆盖失败，消息里指明两条出路）
    validateProfileADimensionScope(world.acceptance, world.task);
    externalContractStrongClasses = validateExternalContractDeclarations(
      world.acceptance,
      world.taskDir,
      world.policy,
      readCandidateSnapshot(world.taskDir, world.acceptance.acceptanceVersion),
    );
    // 检查 8（强制 essential 口径）：源码强信号命中的契约同样必须有契约冒烟增量——
    // 与检查 3/5 用同一强类集合（loadWorld 热路径上的那次只覆盖自报 essential）
    validateContractSmokeIncrement(world.increments, world.acceptance, externalContractStrongClasses);
  }
  const warnings = detectionRoutingCriteriaWarnings(world.acceptance);
  // 外部契约声明存在但调用类目录策略未落盘：词表与环境底线校验整体关闭——如实披露，
  // 不把「没校验」显示成「已通过」
  if (externalContractsOf(world.acceptance).length > 0 && externalContractClassesPolicy(world) === null) {
    warnings.push(
      `策略文件 ${EXTERNAL_CONTRACT_CLASSES_FILE} 缺失：外部契约调用类词表、resolverKind 词表与环境底线校验本次未执行。恢复动作：确认该策略文件已随技能分发（技能 policies/ 目录内置，探测器只读消费、不创建该文件），缺失属技能安装残缺，重新安装或修复技能后重跑 snapshot-policy 与 validate-acceptance；在途任务确需变更调用类词表时由用户走 upgrade-policy（重拍快照并逐事件声明失效范围）。确无调用类目录时，外部契约能力仍按结构规则校验，但调用类低报只由候选复扫兜底。`,
    );
  }
  printJson({
    valid: true,
    taskDir: world.taskDir,
    acceptanceVersion: world.acceptance.acceptanceVersion,
    acceptancePackageSha256: world.packageSha256,
    intentSha256: world.intentSha256,
    // 检测/分流类判别力词面初筛 warning（不拒写入——词面有误伤率，硬判定留给 reviewer 语义审）
    warnings,
  });
}

// ── 检测/分流类判据判别力词面初筛（V5 完整性设计 §5.4：恒真/恒假不得作为已实现证据）──
// 为什么只做词面初筛记 warning：正负信号「行为不同」的硬判定是语义判断（空检测器 /
// 恒 true 实现要通过反例输入才能证明被拒），机器词面匹配有误伤率，故本层只提示，
// 不拦写入；reviewer 侧的语义审查是硬判定层（references/roles/acceptance-reviewer.md）。
// 词表可扩展：命中新形态的检测/分流同义词或否定性标记时，直接补充下列两个常量
//（它们是词面提示层，非语义权威——扩展不需要递增 acceptanceVersion 或走策略升级）。
const DETECTION_ROUTING_KEYWORDS = ["detector", "classify", "classifier", "router", "retrieve", "retrieval", "inject", "检测", "分流", "检索", "注入"];
const NEGATIVE_SCENARIO_MARKERS = ["negative", "拒绝", "不", "排除", "miss", "false", "负例", "不应", "不得"];

/** 单条断言的词面描述域：statement + qualifiers + given/when/then（初筛只看文本词面） */
function assertionText(assertion) {
  return [assertion.statement, ...(Array.isArray(assertion.qualifiers) ? assertion.qualifiers : []), assertion.given, assertion.when, assertion.then]
    .filter((part) => typeof part === "string")
    .join("\n");
}

/** 逐需求筛查：断言描述含检测/分流关键词的需求组，若该组没有任何断言含否定性场景标记，记 warning */
function detectionRoutingCriteriaWarnings(acceptance) {
  if (acceptance.schemaVersion !== 2) return [];
  const warnings = [];
  for (const requirement of acceptance.requirements) {
    const assertions = Array.isArray(requirement.assertions) ? requirement.assertions : [];
    const keywordHit = assertions.some((assertion) =>
      DETECTION_ROUTING_KEYWORDS.some((keyword) => assertionText(assertion).toLowerCase().includes(keyword.toLowerCase())));
    if (!keywordHit) continue;
    const hasNegativeScenario = assertions.some((assertion) =>
      NEGATIVE_SCENARIO_MARKERS.some((marker) => assertionText(assertion).toLowerCase().includes(marker.toLowerCase())));
    if (!hasNegativeScenario) {
      warnings.push(
        `需求 ${requirement.id} 含检测/分流类断言但未发现否定性场景标记（${NEGATIVE_SCENARIO_MARKERS.join(" / ")}）——恒真/恒假/空变量集不得作为已实现证据。恢复动作：补正负场景对照或书面论证不适用（正负信号场景且行为不同；不适用理由登记进该需求断言的 qualifierNotApplicable 或审查报告）。`,
      );
    }
  }
  return warnings;
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
    optional: ["artifact", "authority-snapshot-sha256", "channel"],
  });
  if (options.channel !== undefined && options.channel !== "workflow" && options.channel !== "manual") {
    fail(`--channel 取值非法（${options.channel}）。`, "使用 workflow | manual；缺省按 manual 处理。");
  }
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
    channel: options.channel ?? "manual",
    summary: options.summary,
    acceptancePackageSha256: world.packageSha256,
    intentSha256: world.intentSha256 ?? "",
    policySnapshotSha256: world.policySnapshotSha256 ?? "",
    conclusion: options.conclusion,
    artifact,
  };
  // 审查时刻的环境契约快照哈希（§4.4 审计事实）：验收包声明外部契约时自动绑定当前快照
  const authoritySnapshotSha256 = resolveAuthoritySnapshotSha256(world, options);
  if (authoritySnapshotSha256 !== null) event.authoritySnapshotSha256 = authoritySnapshotSha256;
  if (world.intentSha256 === null || world.policySnapshotSha256 === null) {
    fail("登记审查前必须先固定原始意图与策略快照。", "依次执行 set-intent 与 snapshot-policy，再 record-review（事件自动绑定两者哈希）。");
  }
  withEventsLock(options["task-dir"], () => {
    printJson(appendEvent(world, event, privateKey));
  });
}

/** 审查/批准时刻的环境契约快照哈希（§4.4）。验收包声明外部契约时必须绑定（自动解析当前
 * 权威快照；显式 --authority-snapshot-sha256 优先）；未声明外部契约时不绑定——空快照的
 * 显式绑定由工作流在物化空候选/空环境快照后完成，内核不把该字段塞进无契约任务的事件
 * （保持无外部依赖任务的事件形态不变）。 */
function resolveAuthoritySnapshotSha256(world, options) {
  if (Object.hasOwn(options, "authority-snapshot-sha256")) {
    requireSha256(options["authority-snapshot-sha256"], "--authority-snapshot-sha256");
    return options["authority-snapshot-sha256"];
  }
  if (world.acceptance === null || externalContractsOf(world.acceptance).length === 0) return null;
  const snapshot = resolveEnvironmentContracts(world.taskDir, world.task.projectRoot, { allowPointerFallback: true });
  if (!snapshot.available || snapshot.snapshotSha256 === null) {
    fail(
      `验收包声明了外部契约但当前无法解析权威快照（${snapshot.reason ?? "未说明"}），审查/批准事件无快照哈希可绑。`,
      `先运行 ${GATE_COMMAND.replace("delivery-gate.mjs", "resolve-external-contracts.mjs")} --task-dir <dir> --project-root <root> --write 生成环境契约快照后重试；或显式传 --authority-snapshot-sha256 绑定既有快照哈希。`,
    );
  }
  return snapshot.snapshotSha256;
}

function commandApproveAcceptance(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "confirmation", "summary", "credential"],
    optional: ["revision", "authority-snapshot-sha256"],
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
    // 批准时刻的环境契约快照哈希（§4.4）：环境历史链起点。additive 可选、不进批准四元组
    const authoritySnapshotSha256 = resolveAuthoritySnapshotSha256(world, options);
    if (authoritySnapshotSha256 !== null) event.authoritySnapshotSha256 = authoritySnapshotSha256;
    const record = appendEvent(world, event, privateKey);
    // 写入防护（V6）：批准即冻结——验收包两文件 chmod 0444（写入当时拒非法改写）+
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

// 合法解冻唯一通道（V6 写入防护）：用户登记 RevisionOpened 并说明理由，chmod 0644 解锁
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
      fail("--package-file 必须是非空数组（方案包文件哈希清单）。", "按 [{name, sha256}] 逐文件登记设计文档目录、渲染视图、impl-plan（JSON 与渲染视图）与审查终态后重试。");
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
    optional: ["finding-id", "origin", "consequence-refutation", "consequence-refutation-type", "reopen-of", "first-detected-stage", "expected-stage", "regression-test-ref", "empty-scope-refutation", "contract-capability-ids", "authority-backed", "authority-hash", "authority-observation-ref", "revision", "run-id"],
    jsonFields: { "requirement-ids": "requirementIds", "contract-capability-ids": "contractCapabilityIds" },
    build: (world, options, parsed) => ({
      findingId: options["finding-id"] ?? nextFindingId(world),
      category: options.category,
      severity: options.severity,
      requirementIds: parsed["requirement-ids"],
      artifact: options.artifact,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options["empty-scope-refutation"] !== undefined ? { emptyScopeRefutation: options["empty-scope-refutation"] } : {}),
      ...(options["consequence-refutation"] !== undefined ? { consequenceRefutation: options["consequence-refutation"] } : {}),
      ...(options["consequence-refutation-type"] !== undefined ? { consequenceRefutationType: options["consequence-refutation-type"] } : {}),
      ...(options["reopen-of"] !== undefined ? { reopenOf: options["reopen-of"] } : {}),
      ...(options["first-detected-stage"] !== undefined ? { firstDetectedStage: options["first-detected-stage"] } : {}),
      ...(options["expected-stage"] !== undefined ? { expectedStage: options["expected-stage"] } : {}),
      ...(options["regression-test-ref"] !== undefined ? { regressionTestRef: options["regression-test-ref"] } : {}),
      // authority 反驳组（§9）：结构命中外部契约时三段必填（fold 层护栏④裁决完整性）
      ...(parsed["contract-capability-ids"] !== undefined ? { contractCapabilityIds: parsed["contract-capability-ids"] } : {}),
      ...(options["authority-backed"] !== undefined ? { authorityBacked: options["authority-backed"] === "true" } : {}),
      ...(options["authority-hash"] !== undefined ? { authorityHash: options["authority-hash"] } : {}),
      ...(options["authority-observation-ref"] !== undefined ? { authorityObservationRef: options["authority-observation-ref"] } : {}),
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
    optional: ["assertion-ids", "adversarial-form-ids", "artifact-sha256", "contract-capability-ids", "revision", "run-id"],
    flags: ["runtime-probe"],
    jsonFields: { "assertion-ids": "assertionIds", "adversarial-form-ids": "adversarialFormIds", "contract-capability-ids": "contractCapabilityIds" },
    build: (world, options, parsed) => ({
      requirementId: options["requirement-id"],
      kind: options.kind,
      result: options.result,
      artifact: options.artifact,
      ...(parsed["assertion-ids"] !== undefined ? { assertionIds: parsed["assertion-ids"] } : {}),
      ...(parsed["adversarial-form-ids"] !== undefined ? { adversarialFormIds: parsed["adversarial-form-ids"] } : {}),
      // 外部契约能力绑定 + runtime probe 标记（§6.3）：runtime 义务只能由 assurance 签署、
      // 带 runtimeProbe=true 且 capability id 匹配的证据满足
      ...(parsed["contract-capability-ids"] !== undefined ? { contractCapabilityIds: parsed["contract-capability-ids"] } : {}),
      ...(options["runtime-probe"] !== undefined ? { runtimeProbe: options["runtime-probe"] === true || options["runtime-probe"] === "true" } : {}),
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
  // --channel 全意图命令通用（信封字段，workflow|manual——V5 完整性设计 §7.3 事件来源记录义务）
  const options = parseOptions(args, { required: spec.required, optional: [...spec.optional, "channel"], flags: spec.flags ?? [] });
  if (options.channel !== undefined && options.channel !== "workflow" && options.channel !== "manual") {
    fail(`--channel 取值非法（${options.channel}）。`, "使用 workflow | manual；缺省按 manual（人工经 CLI 直接提交）处理。");
  }
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
      // 事件来源（V5 完整性设计 §7.3：终态报告不得把工作流执行与手工补登记混为一谈）。
      // 历史事件无该键——读侧按 legacy 处理，不回填猜测
      channel: options.channel ?? "manual",
      summary: options.summary,
      ...content,
    };
    // artifactSha256 缺省由内核计算（仅限事件契约允许该字段的内容哈希类型；发现类事件不绑内容哈希）。
    // 绝对 artifact 路径按原样解析——join 对绝对路径是拼接不是取根（与 probeArtifact 的
    // isAbsolute 分支同口径；实测 candidate-build-v6 未显式传 --artifact-sha256 时绝对路径必 ENOENT）
    if (Object.hasOwn(event, "artifact") && ARTIFACT_HASH_CAPABLE_TYPES.has(spec.type)) {
      if (options["artifact-sha256"] === undefined && event.artifact !== "none") {
        const artifactPath = isAbsolute(event.artifact) ? event.artifact : join(world.taskDir, event.artifact);
        event.artifactSha256 = sha256File(artifactPath, `--artifact ${event.artifact}`);
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

// V6 代收敛机制：用户预先声明可由 standing-authorization 接受的 finding 范围。
// 安全边界（shape 层与 shape 后校验双保险）：仅 finding 目标生效、severity 上限恒
// non-blocker（blocker 永不可预授权——出现 blocker 的出路只有修复或用户亲自接受）、
// 名额必填且按事件流顺序消耗（每个验收版本独立配额）。
function commandPreauthorizeRisk(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "categories", "max-findings", "summary", "credential"],
    optional: ["allow-duplicate"],
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
  const allowDuplicate = options["allow-duplicate"] === "true";
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
    // 重复登记查重（D16/R9）：同分类范围的既有预授权不会合并，名额按事件流顺序
    // 独立叠加——同一范围再来一条等于悄悄扩大名额池，与「预授权是收紧机制」的意图相反。
    // 命中时要求显式确认（--allow-duplicate true）才能登记，确认动作留痕在事件流里
    const sortedCategories = [...categories].sort();
    const duplicate = world.fold.preauthorizations.find((event) =>
      Array.isArray(event.categories) &&
      [...event.categories].sort().join(",") === sortedCategories.join(",") &&
      event.maxSeverity === "non-blocker");
    if (duplicate !== undefined && !allowDuplicate) {
      fail(
        `同分类范围的预授权已存在（eventId=${String(duplicate.eventId ?? "?")}，名额 ${String(duplicate.maxFindings ?? "?")}）：重复登记会叠加名额池，不做合并。`,
        `确认这是有意追加的独立授权时加 --allow-duplicate true 重试；只是同一范围的复述则不要重登（名额已按事件流顺序消耗）。`,
      );
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
      // V6 代：standing-authorization 仅在预授权覆盖内放行（与 fold 重放校验同规则同口径）
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

// 外部权威登记（§4.4 第 3 条）：local-path 与 executable 权威必须由用户凭据登记——
// designer 或 builder 填写的本地路径/可执行文件不生成 resolved。任务级事件，验收包就位前
// 亦可登记（托管开始前的权威声明）
function commandDeclareExternalAuthority(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "contract-id", "resolver-kind", "locator", "snapshot-sha256", "summary", "credential"],
    optional: [],
  });
  withEventsLock(options["task-dir"], () => {
    // 验收包已起草时必须按包校验契约 id（防把权威挂到未声明的契约上）；包未就位时允许预登记
    const packageReady = existsSync(join(loadTaskCore(options["task-dir"]).taskDir, "acceptance.json"));
    const world = loadWorld(options["task-dir"], { requirePackage: packageReady });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    requireNonEmptyString(options["resolver-kind"], "--resolver-kind");
    requireNonEmptyString(options.locator, "--locator");
    requireSha256(options["snapshot-sha256"], "--snapshot-sha256");
    if (world.acceptance !== null) {
      const declared = externalContractsOf(world.acceptance).some((contract) => contract.id === options["contract-id"]);
      if (!declared) {
        fail(
          `--contract-id ${options["contract-id"]} 不是当前验收包已声明的 externalContracts id。`,
          "把 contract-id 改为 acceptance.externalContracts 中已登记的 id；验收包尚未起草时该字段只做预登记，批准前必须与验收包一致。",
        );
      }
    }
    const event = {
      type: "ExternalAuthorityDeclared",
      actor: "user",
      acceptanceVersion: world.acceptance !== null ? world.acceptance.acceptanceVersion : 0,
      revision: computeRevision(world.task.projectRoot),
      summary: options.summary,
      contractId: options["contract-id"],
      resolverKind: options["resolver-kind"],
      locator: options.locator,
      snapshotSha256: options["snapshot-sha256"],
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

// 外部环境基线确认（§10）：用户确认新的外部环境基线并接上环境历史链。只接链，不把 runtime
// 义务置 satisfied——确认后仍必须在当前环境重跑 probe。同一 acceptanceVersion 内最多一次
// （evaluate 判定该预算规则）
function commandConfirmEnvironmentBaseline(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "contract-ids", "new-authority-snapshot-sha256", "credential"],
    optional: [],
  });
  const contractIds = parseJsonOption(options["contract-ids"], "--contract-ids", "confirm-environment-baseline");
  requireStringArray(contractIds, "--contract-ids", { nonEmptyItems: true, unique: true });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    requireSha256(options["new-authority-snapshot-sha256"], "--new-authority-snapshot-sha256");
    const declared = new Set(externalContractsOf(world.acceptance).map((contract) => contract.id));
    const unknown = contractIds.filter((contractId) => !declared.has(contractId));
    if (unknown.length > 0) {
      fail(
        `--contract-ids 含未声明契约 ${unknown.join(", ")}。`,
        "只允许确认 acceptance.externalContracts 中已登记的契约 id；新契约先修订验收再确认基线。",
      );
    }
    // 新基线快照必须在盘（environment-contracts/<sha>.json，按哈希分文件、不覆盖）：
    // 确认一个不存在的快照 = 接上一条空链，后续 evaluate 的批准基线对账必然失败——
    // 恢复动作不是重试本命令，而是先把权威解析落盘
    const newSnapshotSha256 = options["new-authority-snapshot-sha256"];
    const newSnapshotDocument = readEnvironmentSnapshotFile(world.taskDir, newSnapshotSha256);
    if (newSnapshotDocument === null) {
      fail(
        `--new-authority-snapshot-sha256 指向的快照文件不存在或不可解析：${environmentSnapshotFilePath(world.taskDir, newSnapshotSha256)}。`,
        `先跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${JSON.stringify(world.taskDir)} --project-root ${JSON.stringify(world.task.projectRoot)} --write 生成新环境的权威快照（按哈希分文件落 environment-contracts/<sha>.json），用其 snapshotSha256 重试本命令；快照手改或损坏的恢复动作是重跑 resolve --write 重建，不手工修复。`,
      );
    }
    const sameVersionBaselines = world.fold.environmentBaselines.filter(
      (event) => event.acceptanceVersion === world.acceptance.acceptanceVersion,
    );
    if (sameVersionBaselines.length > 0) {
      fail(
        `同一验收版本（v${world.acceptance.acceptanceVersion}）已登记过 EnvironmentBaselineConfirmed（上限 1 次）。`,
        "再次环境漂移时停回用户裁决：走 open-revision 重新核对验收，或由用户重新定义目标；不得继续用环境基线确认重试。",
      );
    }
    const event = {
      type: "EnvironmentBaselineConfirmed",
      actor: "user",
      acceptanceVersion: world.acceptance.acceptanceVersion,
      revision: computeRevision(world.task.projectRoot),
      summary: `确认外部环境基线 ${options["new-authority-snapshot-sha256"].slice(0, 12)}…（契约 ${contractIds.join(", ")}）`,
      newAuthoritySnapshotSha256: options["new-authority-snapshot-sha256"],
      contractIds,
    };
    printJson(appendEvent(world, event, privateKey));
  });
}

// 任务分级唯一写通道之一（§13）：另一通道是 init 的 --delivery-profile。禁止直改 task.json
function commandSetDeliveryProfile(args) {
  const options = parseOptions(args, {
    required: ["task-dir", "profile", "credential"],
    optional: [],
  });
  requireEnum(options.profile, DELIVERY_PROFILES, "--profile");
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    loadCredentialPrivateKey(world, options.credential, "user");
    const taskPath = join(world.taskDir, "task.json");
    const current = readJson(taskPath, "task.json");
    const currentProfile = typeof current.deliveryProfile === "string" ? current.deliveryProfile : "b";
    if (currentProfile === options.profile) {
      printJson({ taskDir: world.taskDir, deliveryProfile: options.profile, changed: false });
      return;
    }
    current.deliveryProfile = options.profile;
    validateTaskRecord(current, world.taskDir);
    atomicWrite(taskPath, `${JSON.stringify(current, null, 2)}\n`);
    printJson({ taskDir: world.taskDir, deliveryProfile: options.profile, changed: true, previous: currentProfile });
  });
}

function commandEvaluate(args) {
  const options = parseOptions(args, { required: ["task-dir"], optional: ["revision"] });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"]);
    // 外部契约前置（§8.1）：当前候选源码复扫（strong 信号/蕴含观察类映射 + unresolved 外部
    // 访问）+ EnvironmentBaselineConfirmed 预算规则。未通过 → 直接拒绝 evaluate
    externalContractPreflight(world);
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

// 历史 unknown 区间的用户确认通道（revision 来源对账 §7.2 的最小补充）：confirm-baseline
// 只能从确认点续接链条，不消除已产生的历史 unknown 段；confirm-history 让用户对派生结果
// 中精确存在的 unknown 区间逐段署名确认（区间 from/to + 区间哈希），使其归为
// user-confirmed 而不改变「无确认不得 accepted」的语义。只接受用户凭据——builder/
// assurance 无法自证洗白来源不明的变化。
function commandConfirmHistory(args) {
  const options = parseOptions(args, { required: ["task-dir", "reason", "intervals", "credential"], optional: ["revision"] });
  withEventsLock(options["task-dir"], () => {
    const world = loadWorld(options["task-dir"], { requirePackage: false });
    const privateKey = loadCredentialPrivateKey(world, options.credential, "user");
    const revision = Object.hasOwn(options, "revision") ? options.revision : computeRevision(world.task.projectRoot);
    const provenance = deriveRevisionProvenance(world.entries.map((entry) => entry.record), { currentRevision: revision });
    const unknownSegments = provenance.revisions.filter((item) => item.source === "unknown");
    const unknownList = unknownSegments
      .map((item) => `${item.fromRevision}..${item.toRevision}`)
      .join(" | ");
    let parsed;
    try {
      parsed = JSON.parse(options.intervals);
    } catch (error) {
      fail(`--intervals 不是合法 JSON：${error.message}。`, `传入 [{"fromRevision":"<旧>","toRevision":"<新>","rationale":"<为何属合法外部变化>"}] 后重试；当前 unknown 区间：${unknownList || "无"}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      fail("--intervals 须为非空数组。", `当前 unknown 区间：${unknownList || "无"}——按该清单逐段登记 from/to 与理由后重试。`);
    }
    const explainedUnknownIntervals = [];
    for (const raw of parsed) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        fail("--intervals 的条目须为对象。", `传入 [{"fromRevision":"<旧>","toRevision":"<新>","rationale":"..."}] 后重试；当前 unknown 区间：${unknownList || "无"}`);
      }
      const fromRevision = raw.fromRevision;
      const toRevision = raw.toRevision;
      const rationale = raw.rationale;
      if (typeof fromRevision !== "string" || fromRevision === "" || typeof toRevision !== "string" || toRevision === "" || typeof rationale !== "string" || rationale.trim() === "") {
        fail("--intervals 条目字段非法。", "fromRevision/toRevision 须为非空字符串、rationale 须非空（说明该段变化为何属合法外部变更）；三者齐全后重试。");
      }
      const matched = unknownSegments.some((item) => item.fromRevision === fromRevision && item.toRevision === toRevision);
      if (!matched) {
        fail(`区间 ${fromRevision}..${toRevision} 不在当前派生结果的无来源段中。`, `只允许确认派生结果里精确存在的 unknown 区间；当前 unknown 区间：${unknownList || "无"}——按该清单重登（派生结果随事件与当前 revision 变化，登记前先跑 revision-provenance 核对）。`);
      }
      explainedUnknownIntervals.push({
        fromRevision,
        toRevision,
        intervalSha256: revisionIntervalSha256(fromRevision, toRevision),
        rationale: rationale.trim(),
      });
    }
    const event = {
      type: "RevisionBaselineConfirmed",
      actor: "user",
      acceptanceVersion: world.acceptance ? world.acceptance.acceptanceVersion : 0,
      revision,
      summary: options.reason,
      // 历史确认不推进链条：confirmedRevision 记录确认时点的当前 revision，派生层对
      // 携带 explainedUnknownIntervals 的确认事件不作基线锚点（见 kernel-judgments）
      confirmedRevision: revision,
      reason: options.reason,
      explainedUnknownIntervals,
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
    // mayWrite 收窄前置校验（C-08）：新策略对既有任务全部历史事件在内存里折算一遍
    // 「角色是否可写该事件」——任何事件将被判无权写入即拒绝升级并列出受影响事件。
    // 不做本步，收窄后的快照会让任务在下次加载时折算崩溃（append 拒绝 + CLI 恢复通道
    // 一并失效——loadWorld 都进不去），错误暴露点与操作点相隔整条执行链
    try {
      const previewWorld = loadWorld(options["task-dir"], { requirePackage: existsSync(join(core.taskDir, "acceptance.json")) });
      const newPolicyDocument = document;
      const affected = [];
      for (const entry of previewWorld.entries) {
        const event = entry.record;
        if (!policyRoleMayWrite(newPolicyDocument, event.actor, event.type)) {
          affected.push({ eventId: event.eventId ?? null, seq: event.seq ?? null, actor: event.actor, type: event.type, line: entry.line });
        }
      }
      if (affected.length > 0) {
        fail(
          `升级后策略将使既有任务 ${affected.length} 条历史事件无法折算（角色无权写该事件类型）。`,
          `先调整新策略 roles.json 的 mayWrite 覆盖全部已登记事件（受影响清单见下），或改用任务替换（supersede-prepare）在新任务上使用新策略；受影响事件：${JSON.stringify(affected.slice(0, 20))}${affected.length > 20 ? `（另有 ${affected.length - 20} 条略）` : ""}`,
        );
      }
    } catch (error) {
      // 任务目录本就加载失败（损坏事件流等）：与升级无关的既有故障，不因预检升级失败而掩盖
      process.stderr.write(`delivery-gate: upgrade-policy 前置折算预检跳过（任务目录当前无法加载：${error && typeof error.message === "string" ? error.message.split("。")[0] : String(error)}）——升级后该任务的恢复仍受新策略约束。\n`);
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
      case "declare-external-authority":
        commandDeclareExternalAuthority(commandArgs);
        break;
      case "confirm-environment-baseline":
        commandConfirmEnvironmentBaseline(commandArgs);
        break;
      case "set-delivery-profile":
        commandSetDeliveryProfile(commandArgs);
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
      case "confirm-history":
        commandConfirmHistory(commandArgs);
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
// 比较——本文件经 symlink（~/.agents/skills/delivery-v6）调用时 import.meta.url 与 argv[1]
// 字面不同、realpath 相同；被 import 时 argv[1] 是调用方文件、realpath 必不相同
const invokedPath = process.argv[1] !== undefined ? realpathSync(resolve(process.argv[1])) : null;
if (invokedPath !== null && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

// ── 内核复用导出（V6）：delivery-core.mjs 同进程消费的世界加载与裁决组装。
// 导出的是既有实现本身，不是副本——改这些函数只改一处，两侧同步生效 ──

// 进程内调用垫片（测试提速）：走与 CLI 完全相同的 main 分发执行一段 argv，返回与
// spawnSync 同口径的结构化结果 { status, stdout, stderr }。stdout/stderr 经临时替换
// write 口径捕获（gate 全部输出都走这两处），status 取 process.exitCode 终值（未设即 0，
// 与进程退出码一致）；home 参数与 spawn 时的 HOME env 等价（HOME 派生目录已惰性化），
// env 参数按键覆盖 process.env（外部契约探测/解析脚本路径的测试注入走此通道），
// 返回前恢复现场。node --test 用例串行执行，临时替换全局口径安全；函数保证恢复现场，
// 失败也不例外
function runGateCommand(argv, home, env) {
  const previousArgv = process.argv;
  const previousHome = process.env.HOME;
  const previousExitCode = process.exitCode;
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  const chunks = { stdout: [], stderr: [] };
  const previousEnv = {};
  const overriddenKeys = env === undefined || env === null ? [] : Object.keys(env);
  for (const key of overriddenKeys) {
    previousEnv[key] = process.env[key];
    process.env[key] = env[key];
  }
  // 夹具隔离窗口：HOME 重定向时同时剥掉宿主 npm 上下文注入的 npm_*（npm test 注入的
  // npm_config_cache 会把 evaluate 前置复扫里 resolver 的 npm config get cache 引到真实
  // 用户缓存，读到隔离外内容——external-contract-resolve 测试同族坑的进程内形态）
  const strippedNpmKeys = home !== undefined ? Object.keys(process.env).filter((key) => key.startsWith("npm_")) : [];
  for (const key of strippedNpmKeys) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.argv = [previousArgv[0], previousArgv[1], ...argv];
  if (home !== undefined) process.env.HOME = home;
  process.exitCode = 0;
  process.stdout.write = (chunk) => { chunks.stdout.push(chunk); return true; };
  process.stderr.write = (chunk) => { chunks.stderr.push(chunk); return true; };
  try {
    main();
  } finally {
    process.argv = previousArgv;
    if (home !== undefined) process.env.HOME = previousHome;
    for (const key of [...overriddenKeys, ...strippedNpmKeys]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
  }
  const result = { status: process.exitCode ?? 0, stdout: chunks.stdout.join(""), stderr: chunks.stderr.join("") };
  process.exitCode = previousExitCode;
  return result;
}

export { buildVerdict, computeRevision, loadTaskCore, loadWorld, runGateCommand, runtimeObligationsOf };
