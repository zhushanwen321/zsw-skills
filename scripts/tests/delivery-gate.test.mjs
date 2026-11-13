// delivery-gate.test.mjs — delivery-wf 统一交付裁决器 CLI 与状态派生测试
// 运行：node --test scripts/tests/delivery-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-wf", "scripts", "delivery-gate.mjs");
const ACTOR_BY_TYPE = {
  ContractApproved: "user",
  ImplementationRecorded: "builder",
  EvidenceRecorded: "assurance",
  AssuranceCompleted: "assurance",
  ExplorationCompleted: "assurance",
  FindingRaised: "assurance",
  FindingResolved: "assurance",
  RiskAccepted: "user",
};

function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
    timeout: 30_000,
  });
}

function spawnGateAsync(args, home) {
  return new Promise((resolveSpawn) => {
    const child = spawn(process.execPath, [GATE, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveSpawn({ status: -1, stdout, stderr: String(error) });
    });
    child.on("close", (status) => {
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

function assertOk(result, message = "命令应成功") {
  assert.equal(result.status, 0, `${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertFailure(result, expectedStatus = 1) {
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /恢复动作：/, "每个错误都必须给出恢复动作");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertNoPrivateKeysOnDisk(directory) {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else {
        const text = readFileSync(entryPath, "utf8");
        assert.ok(!text.includes("PRIVATE KEY"), `私钥不得写入任何文件：${entryPath}`);
      }
    }
  }
}

function canonicalJsonTest(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonTest).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonTest(value[key])}`).join(",")}}`;
}

function tamperRecordContent(record, changes) {
  const content = {};
  for (const key of Object.keys(record)) {
    if (!["seq", "recordedAt", "eventId", "signature"].includes(key)) content[key] = record[key];
  }
  Object.assign(content, changes);
  return {
    ...record,
    ...changes,
    eventId: createHash("sha256").update(canonicalJsonTest(content)).digest("hex"),
  };
}

function makeFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-gate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = realpathSync(mkdtempSync(join(root, "Project Root-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const taskId = "task-1";
  const init = runGate(["init", "--project-root", projectRoot, "--task-id", taskId], home);
  assertOk(init, "夹具 init 应成功");
  const initOutput = JSON.parse(init.stdout);
  const taskDir = initOutput.taskDir;
  assert.match(initOutput.builderKey, /BEGIN PRIVATE KEY/, "init 必须输出 builderKey 私钥 PEM");
  assert.match(initOutput.assuranceKey, /BEGIN PRIVATE KEY/, "init 必须输出 assuranceKey 私钥 PEM");
  assert.match(initOutput.userKey, /BEGIN PRIVATE KEY/, "init 必须输出 userKey 私钥 PEM");
  assert.notEqual(initOutput.builderKey, initOutput.assuranceKey, "builder 与 assurance 私钥必须不同");
  assert.notEqual(initOutput.assuranceKey, initOutput.userKey, "assurance 与 user 私钥必须不同");
  const requirements = options.requirements ?? [{
    id: "R1",
    kind: "goal",
    statement: "命令证据可验证目标行为",
    required: true,
    riskAcceptable: true,
    evidenceKinds: ["command"],
  }];
  const contract = {
    schemaVersion: 1,
    contractVersion: 1,
    taskId,
    projectRoot,
    objective: "验证交付裁决器行为",
    requirements,
    nonGoals: [],
    riskLevel: "low",
    exploratoryReview: "not-required",
    reviewDimensions: [],
    ...(options.contractOverrides ?? {}),
  };
  const increments = {
    schemaVersion: 1,
    contractVersion: contract.contractVersion,
    items: options.incrementItems ?? [{
      id: "I1",
      title: "实现目标行为",
      requirementIds: [requirements[0].id],
      testCommand: { program: "node", args: ["--test"] },
    }],
  };
  writeJson(join(taskDir, "contract.json"), contract);
  writeJson(join(taskDir, "increments.json"), increments);

  const context = {
    root,
    projectRoot,
    home,
    taskDir,
    taskId,
    contract,
    increments,
    revision: "rev-1",
    builderKey: initOutput.builderKey,
    assuranceKey: initOutput.assuranceKey,
    userKey: initOutput.userKey,
    keyFor(actor) {
      return initOutput[`${actor}Key`];
    },
    artifact(name, content = `证据 ${name}\n`) {
      writeFileSync(join(taskDir, "evidence", name), content);
      return `evidence/${name}`;
    },
    event(type, fields = {}, revision = context.revision) {
      return {
        type,
        actor: ACTOR_BY_TYPE[type],
        contractVersion: context.contract.contractVersion,
        revision: type === "ContractApproved" ? "" : revision,
        summary: `${type} 测试摘要`,
        ...fields,
      };
    },
    append(event, expectedStatus = 0, key = context.keyFor(event.actor)) {
      const result = runGate([
        "append",
        "--task-dir",
        taskDir,
        "--event",
        JSON.stringify(event),
        "--key",
        key,
      ], home);
      if (expectedStatus === 0) {
        assertOk(result, `追加 ${event.type} 应成功`);
        return JSON.parse(result.stdout);
      }
      assertFailure(result, expectedStatus);
      return result;
    },
    add(type, fields = {}, revision = context.revision, expectedStatus = 0) {
      return context.append(context.event(type, fields, revision), expectedStatus);
    },
    approve(confirmation = "user-explicit", summary = "用户批准当前契约", revision) {
      const args = [
        "approve-contract",
        "--task-dir",
        taskDir,
        "--confirmation",
        confirmation,
        "--summary",
        summary,
        "--user-key",
        initOutput.userKey,
      ];
      if (revision !== undefined) args.push("--revision", revision);
      const result = runGate(args, home);
      assertOk(result, "approve-contract 应成功");
      return JSON.parse(result.stdout);
    },
    acceptRisk(targetType, targetId, {
      confirmation = "user-explicit",
      summary = `接受 ${targetType} ${targetId} 的具体风险`,
      revision = context.revision,
      expectedStatus = 0,
    } = {}) {
      const args = [
        "accept-risk",
        "--task-dir",
        taskDir,
        "--target-type",
        targetType,
        "--target-id",
        targetId,
        "--confirmation",
        confirmation,
        "--summary",
        summary,
        "--user-key",
        initOutput.userKey,
      ];
      if (revision !== null) args.push("--revision", revision);
      const result = runGate(args, home);
      if (expectedStatus === 0) {
        assertOk(result, "accept-risk 应成功");
        return JSON.parse(result.stdout);
      }
      assertFailure(result, expectedStatus);
      return result;
    },
    evaluate(revision = context.revision) {
      const result = runGate([
        "evaluate",
        "--task-dir",
        taskDir,
        "--revision",
        revision,
      ], home);
      assertOk(result, `evaluate ${revision} 应成功`);
      const stdoutVerdict = JSON.parse(result.stdout);
      assert.deepEqual(readJson(join(taskDir, "verdict.json")), stdoutVerdict, "stdout 必须与 verdict.json 同 JSON");
      return stdoutVerdict;
    },
    events() {
      const text = readFileSync(join(taskDir, "events.jsonl"), "utf8");
      return text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
    },
    complete(revision = context.revision) {
      context.approve();
      context.add("ImplementationRecorded", {
        incrementId: increments.items[0].id,
        artifact: context.artifact("implementation.txt"),
      }, revision);
      context.add("EvidenceRecorded", {
        requirementId: contract.requirements[0].id,
        kind: contract.requirements[0].evidenceKinds[0],
        result: "verified",
        artifact: context.artifact("evidence.txt"),
      }, revision);
      context.add("AssuranceCompleted", {
        artifact: context.artifact("assurance.txt"),
      }, revision);
      if (contract.exploratoryReview === "required") {
        context.add("ExplorationCompleted", {
          dimensions: [...contract.reviewDimensions],
          artifact: context.artifact("exploration.txt"),
        }, revision);
      }
    },
  };
  return context;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
  return result.stdout.trim();
}

function initGitProject(projectRoot) {
  writeFileSync(join(projectRoot, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(projectRoot, "tracked.txt"), "初始内容\n");
  git(["init", "-q"], projectRoot);
  git(["config", "user.name", "Delivery Gate Test"], projectRoot);
  git(["config", "user.email", "delivery-gate@example.invalid"], projectRoot);
  git(["add", ".gitignore", "tracked.txt"], projectRoot);
  git(["commit", "-qm", "initial fixture"], projectRoot);
}

test("init 输出任务目录与一次性密钥，幂等复用不重发私钥，私钥不落盘", (t) => {
  const root = mkdtempSync(join(tmpdir(), "delivery-gate-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "My Project");
  mkdirSync(projectDir);
  const projectRoot = realpathSync(projectDir);
  const home = join(root, "home");
  mkdirSync(home);
  const args = ["init", "--project-root", projectRoot, "--task-id", "Task_1.ok"];
  const first = runGate(args, home);
  assertOk(first);
  const output = JSON.parse(first.stdout);
  const taskDir = output.taskDir;
  assert.match(taskDir, /my-project-[0-9a-f]{8}\/Task_1\.ok$/);
  assert.notEqual(output.builderKey, output.assuranceKey, "builder 与 assurance 私钥必须不同");
  assert.notEqual(output.assuranceKey, output.userKey, "assurance 与 user 私钥必须不同");
  assert.notEqual(output.builderKey, output.userKey, "builder 与 user 私钥必须不同");
  const taskRecord = readJson(join(taskDir, "task.json"));
  assert.deepEqual(
    Object.keys(taskRecord).sort(),
    ["assurancePublicKey", "builderPublicKey", "projectRoot", "schemaVersion", "taskId", "userPublicKey"],
  );
  assert.equal(taskRecord.taskId, "Task_1.ok");
  assert.equal(taskRecord.projectRoot, projectRoot);
  assert.equal(taskRecord.builderPublicKey, output.builderPublicKey);
  assert.equal(taskRecord.assurancePublicKey, output.assurancePublicKey);
  assert.equal(taskRecord.userPublicKey, output.userPublicKey);
  assertNoPrivateKeysOnDisk(taskDir);
  writeFileSync(join(taskDir, "evidence", "keep.txt"), "保留我");
  writeFileSync(join(taskDir, "events.jsonl"), "不可清空\n");
  writeFileSync(join(taskDir, "verdict.json"), "不可更新\n");
  const second = runGate(args, home);
  assertOk(second);
  const reusedOutput = JSON.parse(second.stdout);
  assert.equal(reusedOutput.taskDir, taskDir);
  assert.equal(reusedOutput.reused, true);
  assert.equal(Object.hasOwn(reusedOutput, "builderKey"), false, "幂等 init 不得再次输出 builderKey");
  assert.equal(Object.hasOwn(reusedOutput, "assuranceKey"), false, "幂等 init 不得再次输出 assuranceKey");
  assert.equal(Object.hasOwn(reusedOutput, "userKey"), false, "幂等 init 不得再次输出 userKey");
  assert.equal(reusedOutput.builderPublicKey, output.builderPublicKey);
  assert.equal(reusedOutput.assurancePublicKey, output.assurancePublicKey);
  assert.equal(readFileSync(join(taskDir, "evidence", "keep.txt"), "utf8"), "保留我");
  assert.equal(readFileSync(join(taskDir, "events.jsonl"), "utf8"), "不可清空\n");
  assert.equal(readFileSync(join(taskDir, "verdict.json"), "utf8"), "不可更新\n");
  assertNoPrivateKeysOnDisk(taskDir);

  // 旧版无公钥或两密钥任务均拒绝后续写入并给新任务 id 恢复动作
  for (const legacyTaskRecord of [
    { schemaVersion: 1, taskId: "Task_1.ok", projectRoot },
    { schemaVersion: 1, taskId: "Task_1.ok", projectRoot, writerPublicKey: output.userPublicKey, userPublicKey: output.builderPublicKey },
  ]) {
    writeJson(join(taskDir, "task.json"), legacyTaskRecord);
    const legacyProbeEvent = {
      type: "AssuranceCompleted",
      actor: "assurance",
      contractVersion: 1,
      revision: "rev-1",
      summary: "旧任务写入探测",
      artifact: "evidence/keep.txt",
    };
    const legacyAppend = runGate([
      "append",
      "--task-dir", taskDir,
      "--event", JSON.stringify(legacyProbeEvent),
      "--key", output.assuranceKey,
    ], home);
    assertFailure(legacyAppend);
    assert.match(legacyAppend.stderr, /--task-id/);
  }

  for (const taskId of ["", "-bad", "a..b", "a/b", "a b", "a".repeat(129)]) {
    const invalid = runGate(["init", "--project-root", projectRoot, "--task-id", taskId], home);
    assertFailure(invalid);
  }
});

test("--help 可执行；未知命令与未知参数 exit 2 且含恢复动作", () => {
  const help = runGate(["--help"]);
  assertOk(help);
  assert.match(help.stdout, /approve-contract/);
  assert.match(help.stdout, /accept-risk/);
  assert.match(help.stdout, /--user-key/);
  assertFailure(runGate(["no-such-command"]), 2);
  assertFailure(runGate(["init", "--unknown", "x"]), 2);
  assertFailure(runGate(["evaluate", "--task-dir"]), 2);
});

test("契约 schema 对字段、词表、去重、高风险探索和项目一致性做显式校验", (t) => {
  const context = makeFixture(t);
  const original = structuredClone(context.contract);
  const path = join(context.taskDir, "contract.json");
  const invalidContracts = [
    { ...original, schemaVersion: 2 },
    { ...original, objective: "" },
    { ...original, unknown: true },
    { ...original, projectRoot: "relative/path" },
    { ...original, taskId: "other-task" },
    { ...original, riskLevel: "high", exploratoryReview: "not-required" },
    { ...original, exploratoryReview: "required", reviewDimensions: [] },
    { ...original, reviewDimensions: ["安全", "安全"] },
    {
      ...original,
      requirements: [original.requirements[0], original.requirements[0]],
    },
    {
      ...original,
      requirements: [{ ...original.requirements[0], required: "yes" }],
    },
    {
      ...original,
      requirements: [{ ...original.requirements[0], evidenceKinds: ["unknown"] }],
    },
    {
      ...original,
      requirements: [{ ...original.requirements[0], evidenceKinds: [] }],
    },
  ];
  for (const invalid of invalidContracts) {
    writeJson(path, invalid);
    assertFailure(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
  }
  writeJson(path, original);
  const valid = runGate(["validate-contract", "--task-dir", context.taskDir], context.home);
  assertOk(valid);
  assert.equal(JSON.parse(valid.stdout).valid, true);
});

test("increments schema 校验版本、引用、唯一 id、id 格式、非空需求引用与 testCommand 形态", (t) => {
  const context = makeFixture(t);
  const original = structuredClone(context.increments);
  const path = join(context.taskDir, "increments.json");
  const invalidIncrements = [
    { ...original, contractVersion: 2 },
    { ...original, items: [] },
    { ...original, items: [original.items[0], original.items[0]] },
    { ...original, items: [{ ...original.items[0], requirementIds: ["NO-SUCH"] }] },
    { ...original, items: [{ ...original.items[0], requirementIds: [] }] },
    { ...original, items: [{ ...original.items[0], id: "I 1" }] },
    { ...original, items: [{ ...original.items[0], id: "-I1" }] },
    { ...original, items: [{ ...original.items[0], id: "I#1" }] },
    { ...original, items: [{ ...original.items[0], id: "I".repeat(65) }] },
    { ...original, items: [{ ...original.items[0], testCommand: "node --test" }] },
    { ...original, items: [{ ...original.items[0], testCommand: { program: "node", args: "test" } }] },
    { ...original, items: [{ ...original.items[0], testCommand: { program: "node", args: [], timeoutMs: 999 } }] },
    { ...original, items: [{ ...original.items[0], testCommand: { program: "node", args: [], timeoutMs: 3_600_001 } }] },
    { ...original, items: [{ ...original.items[0], testCommand: { program: "node", args: [], timeoutMs: "300000" } }] },
    { ...original, items: [{ ...original.items[0], extra: true }] },
  ];
  for (const invalid of invalidIncrements) {
    writeJson(path, invalid);
    assertFailure(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
  }
  writeJson(path, {
    ...original,
    items: [{ ...original.items[0], testCommand: { program: "node", args: ["--test"], timeoutMs: 300_000 } }],
  });
  assertOk(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
  writeJson(path, original);
  assertOk(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
});

test("approve-contract 自动计算当前契约哈希，校验 actor/哈希/confirmation 并幂等", (t) => {
  const context = makeFixture(t);
  const contractSha256 = createHash("sha256").update(readFileSync(join(context.taskDir, "contract.json"))).digest("hex");
  context.append(context.event("ContractApproved", {
    contractSha256: "0".repeat(64),
    confirmation: "user-explicit",
  }), 1);
  context.append(context.event("ContractApproved", {
    actor: "engine",
    contractSha256,
    confirmation: "user-explicit",
  }), 1);
  context.approve();
  const duplicate = context.approve();
  assert.equal(context.events().length, 1, "完全相同的高层批准不得重复追加");
  assert.equal(duplicate.eventId, context.events()[0].eventId);
  assert.equal(context.events()[0].contractSha256, contractSha256);
  assert.equal(context.events()[0].actor, "user");
  const standing = context.approve("standing-authorization", "全托管授权批准", "rev-standing");
  assert.equal(standing.confirmation, "standing-authorization");
  assert.equal(standing.revision, "rev-standing");
  assertFailure(runGate([
    "approve-contract",
    "--task-dir", context.taskDir,
    "--confirmation", "implicit",
    "--summary", "非法确认词",
    "--user-key", context.userKey,
  ], context.home));
});

test("手工重复 append 完全幂等，JSON 解析与 actor 错误含恢复动作", (t) => {
  const context = makeFixture(t);
  const event = context.event("ImplementationRecorded", {
    incrementId: "I1",
    artifact: context.artifact("implementation.txt"),
  });
  const first = context.append(event);
  const second = context.append({ ...event });
  assert.deepEqual(second, first);
  assert.equal(context.events().length, 1);
  context.append(context.event("EvidenceRecorded", {
    actor: "builder",
    requirementId: "R1",
    kind: "command",
    result: "verified",
    artifact: "evidence/evidence.txt",
  }), 1);
  assertFailure(runGate([
    "append",
    "--task-dir", context.taskDir,
    "--event", "{",
    "--key", context.builderKey,
  ], context.home));
});

test("draft → contract-approved → candidate → accepted；缺证据不得伪造 accepted", (t) => {
  const context = makeFixture(t);
  assert.equal(context.evaluate().state, "draft");
  context.approve();
  assert.equal(context.evaluate().state, "contract-approved");
  context.add("ImplementationRecorded", {
    incrementId: "I1",
    artifact: context.artifact("implementation.txt"),
  });
  const candidate = context.evaluate();
  assert.equal(candidate.state, "candidate");
  assert.deepEqual(candidate.missing.evidence, [{ requirementId: "R1", kind: "command", result: "missing" }]);
  context.add("EvidenceRecorded", {
    requirementId: "R1",
    kind: "command",
    result: "verified",
    artifact: context.artifact("evidence.txt"),
  });
  assert.equal(context.evaluate().state, "candidate", "保证完成前不得 accepted");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  const accepted = context.evaluate();
  assert.equal(accepted.state, "accepted");
  assert.deepEqual(accepted.implementedIncrementIds, ["I1"]);
  assert.equal(accepted.requirements[0].status, "verified");
  assert.equal(accepted.revisionSource, "caller");
  assert.equal(accepted.integrity.signatureVerified, true);
  assert.equal(accepted.integrity.eventCount, context.events().length);
  assert.equal(accepted.generatedBy, "delivery-gate");
  assert.ok(accepted.generatedAt);
  assert.match(accepted.nextAction, /delivery-wf\/independent-assurance|delivery-gate\.mjs evaluate/);
});

test("无实现记录但存在未接受 blocker 时状态不得仍是 contract-approved", (t) => {
  const context = makeFixture(t);
  context.approve();
  const blockerOnly = context.evaluate();
  assert.equal(blockerOnly.state, "contract-approved", "无任何缺陷事实时保持 contract-approved");
  context.add("FindingRaised", {
    findingId: "F-EARLY",
    requirementIds: [],
    severity: "blocker",
    artifact: context.artifact("early-finding.txt"),
  });
  const withBlocker = context.evaluate();
  assert.equal(withBlocker.state, "implementing", "未接受 blocker 存在时实现事务已在进行，不得回退成 contract-approved");
  assert.equal(withBlocker.implementedIncrementIds.length, 0);
  assert.ok(withBlocker.nextAction.includes("F-EARLY"), "nextAction 必须指向该 blocker");
});

test("required requirement 的每种 evidenceKind 都必须有 verified", (t) => {
  const context = makeFixture(t, {
    requirements: [{
      id: "R1",
      kind: "goal",
      statement: "命令与场景证据都可验证",
      required: true,
      riskAcceptable: true,
      evidenceKinds: ["command", "scenario"],
    }],
  });
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("command.txt"),
  });
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  assert.equal(context.evaluate().state, "candidate");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "scenario", result: "partial", artifact: context.artifact("scenario.txt"),
  });
  assert.equal(context.evaluate().state, "candidate");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "scenario", result: "verified", artifact: context.artifact("scenario-verified.txt"),
  });
  assert.equal(context.evaluate().state, "accepted");
});

test("旧 revision 证据与保证失效；实施记录仍按当前 contractVersion 判定", (t) => {
  const context = makeFixture(t);
  context.complete("rev-1");
  assert.equal(context.evaluate("rev-1").state, "accepted");
  const stale = context.evaluate("rev-2");
  assert.equal(stale.state, "candidate");
  assert.deepEqual(stale.implementedIncrementIds, ["I1"], "新 revision 不应抹掉当前契约实施记录");
  assert.equal(stale.requirements[0].evidence[0].result, "missing");
  assert.equal(stale.missing.assuranceCompleted, true);
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("evidence-v2.txt"),
  }, "rev-2");
  assert.equal(context.evaluate("rev-2").state, "candidate", "旧 revision AssuranceCompleted 不得复用");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance-v2.txt") }, "rev-2");
  assert.equal(context.evaluate("rev-2").state, "accepted");
});

test("契约递增后旧批准、实施、证据与保证保留但不参与当前裁决", (t) => {
  const context = makeFixture(t);
  context.complete("rev-1");
  const oldEventCount = context.events().length;
  context.contract = { ...context.contract, contractVersion: 2 };
  context.increments = { ...context.increments, contractVersion: 2 };
  writeJson(join(context.taskDir, "contract.json"), context.contract);
  writeJson(join(context.taskDir, "increments.json"), context.increments);
  assert.equal(context.evaluate("rev-1").state, "draft");
  context.approve();
  assert.equal(context.evaluate("rev-1").state, "contract-approved");
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation-v2.txt") }, "rev-1");
  assert.equal(context.evaluate("rev-1").state, "candidate");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("evidence-v2.txt"),
  }, "rev-1");
  assert.equal(context.evaluate("rev-1").state, "candidate");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance-v2.txt") }, "rev-1");
  assert.equal(context.evaluate("rev-1").state, "accepted");
  assert.ok(context.events().length > oldEventCount, "旧事件必须保留在事件流");
});

test("未接受 failed 证据使状态为 implementing；新的 verified 复测取代同 kind 失败", (t) => {
  const context = makeFixture(t);
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "failed", artifact: context.artifact("failed.txt"),
  });
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  assert.equal(context.evaluate().state, "implementing");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("verified.txt"),
  });
  assert.equal(context.evaluate().state, "accepted");
});

test("open blocker 使状态为 implementing；解决 finding 不自动产生 verified", (t) => {
  const context = makeFixture(t);
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  context.add("FindingRaised", {
    findingId: "F-BLOCKER-1",
    requirementIds: ["R1"],
    severity: "blocker",
    artifact: context.artifact("finding.txt"),
  });
  const blocked = context.evaluate();
  assert.equal(blocked.state, "implementing");
  assert.equal(blocked.openFindings[0].findingId, "F-BLOCKER-1");
  context.add("FindingResolved", {
    findingId: "F-BLOCKER-1",
    artifact: context.artifact("resolution.txt"),
  });
  const resolved = context.evaluate();
  assert.equal(resolved.state, "candidate", "没有当前 verified 证据时解决 finding 仍只是 candidate");
  assert.equal(resolved.requirements[0].status, "missing");
  assert.deepEqual(resolved.openFindings, []);
});

for (const resultKind of ["missing", "partial", "failed"]) {
  test(`具体用户风险接受 ${resultKind} → accepted_with_risk，且不改变证据事实`, (t) => {
    const context = makeFixture(t);
    context.approve();
    context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
    if (resultKind !== "missing") {
      context.add("EvidenceRecorded", {
        requirementId: "R1",
        kind: "command",
        result: resultKind,
        artifact: context.artifact(`${resultKind}.txt`),
      });
    }
    context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
    context.acceptRisk("requirement", "R1");
    const verdict = context.evaluate();
    assert.equal(verdict.state, "accepted_with_risk");
    assert.equal(verdict.requirements[0].status, resultKind);
    assert.equal(verdict.requirements[0].evidence[0].result, resultKind);
    assert.equal(verdict.requirements[0].riskAccepted, true);
    assert.notEqual(verdict.requirements[0].status, "verified", "RiskAccepted 不得伪造 verified");
  });
}

test("riskAcceptable=false 拒绝需求风险与关联 finding 风险，无关联 finding 可单独接受", (t) => {
  const context = makeFixture(t, {
    requirements: [{
      id: "R1",
      kind: "invariant",
      statement: "不可接受风险的约束",
      required: true,
      riskAcceptable: false,
      evidenceKinds: ["command"],
    }],
  });
  context.acceptRisk("requirement", "R1", { expectedStatus: 1 });
  context.add("FindingRaised", {
    findingId: "F-LINKED-1",
    requirementIds: ["R1"],
    severity: "blocker",
    artifact: context.artifact("linked-finding.txt"),
  });
  context.acceptRisk("finding", "F-LINKED-1", { expectedStatus: 1 });
  context.add("FindingRaised", {
    findingId: "F-UNRELATED-1",
    requirementIds: [],
    severity: "non-blocker",
    artifact: context.artifact("unrelated-finding.txt"),
  });
  const accepted = context.acceptRisk("finding", "F-UNRELATED-1");
  assert.equal(accepted.targetId, "F-UNRELATED-1");
  assert.equal(context.events().filter((event) => event.type === "RiskAccepted").length, 1);
});

test("open non-blocker 阻止 accepted；接受该 finding 后进入 accepted_with_risk，解决后回到 accepted", (t) => {
  const context = makeFixture(t);
  context.complete();
  context.add("FindingRaised", {
    findingId: "F-NONBLOCKER-1",
    requirementIds: ["R1"],
    severity: "non-blocker",
    artifact: context.artifact("finding.txt"),
  });
  assert.equal(context.evaluate().state, "candidate");
  context.acceptRisk("finding", "F-NO-SUCH", { expectedStatus: 1 });
  context.acceptRisk("finding", "F-NONBLOCKER-1");
  const withRisk = context.evaluate();
  assert.equal(withRisk.state, "accepted_with_risk");
  assert.equal(withRisk.requirements[0].status, "verified");
  assert.equal(withRisk.openFindings[0].riskAccepted, true);
  context.add("FindingResolved", {
    findingId: "F-NONBLOCKER-1", artifact: context.artifact("resolution.txt"),
  });
  assert.equal(context.evaluate().state, "accepted");
});

test("required ExplorationCompleted 是 accepted 的必要条件且必须完整覆盖维度", (t) => {
  const context = makeFixture(t, {
    contractOverrides: {
      riskLevel: "high",
      exploratoryReview: "required",
      reviewDimensions: ["契约外反例", "异常路径"],
    },
  });
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("evidence.txt"),
  });
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  assert.equal(context.evaluate().state, "candidate");
  context.add("ExplorationCompleted", {
    dimensions: ["契约外反例"], artifact: context.artifact("incomplete-exploration.txt"),
  }, context.revision, 1);
  context.add("ExplorationCompleted", {
    dimensions: ["契约外反例", "异常路径"], artifact: context.artifact("exploration.txt"),
  });
  assert.equal(context.evaluate().state, "accepted");
});

test("ExplorationCompleted 接受契约外额外维度，完整覆盖要求不变", (t) => {
  const context = makeFixture(t, {
    contractOverrides: {
      riskLevel: "high",
      exploratoryReview: "required",
      reviewDimensions: ["契约外反例"],
    },
  });
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") });
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("evidence.txt"),
  });
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  context.add("ExplorationCompleted", {
    dimensions: ["额外性能维度"], artifact: context.artifact("only-extra.txt"),
  }, context.revision, 1);
  context.add("ExplorationCompleted", {
    dimensions: ["契约外反例", "额外性能维度", "兼容性"],
    artifact: context.artifact("exploration.txt"),
  });
  const verdict = context.evaluate();
  assert.equal(verdict.state, "accepted");
  assert.equal(verdict.missing.explorationCompleted, false);
});

test("accepted_with_risk 同样需要完整实施、当前保证与 required 探索", (t) => {
  const context = makeFixture(t, {
    contractOverrides: {
      riskLevel: "high",
      exploratoryReview: "required",
      reviewDimensions: ["契约外反例"],
    },
    incrementItems: [
      { id: "I1", title: "第一部分", requirementIds: ["R1"] },
      { id: "I2", title: "第二部分", requirementIds: ["R1"] },
    ],
  });
  context.approve();
  context.acceptRisk("requirement", "R1");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  context.add("ExplorationCompleted", {
    dimensions: ["契约外反例"], artifact: context.artifact("exploration.txt"),
  });
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation-1.txt") });
  assert.equal(context.evaluate().state, "implementing", "风险接受不得跳过未完成增量");
  context.add("ImplementationRecorded", { incrementId: "I2", artifact: context.artifact("implementation-2.txt") });
  assert.equal(context.evaluate().state, "accepted_with_risk");
});

test("旧 revision 风险接受不能覆盖当前 failed；当前接受后才可 accepted_with_risk", (t) => {
  const context = makeFixture(t);
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") }, "rev-2");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "failed", artifact: context.artifact("failed-v2.txt"),
  }, "rev-2");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance-v2.txt") }, "rev-2");
  context.acceptRisk("requirement", "R1", { revision: "rev-1" });
  assert.equal(context.evaluate("rev-2").state, "implementing");
  context.acceptRisk("requirement", "R1", { revision: "rev-2" });
  assert.equal(context.evaluate("rev-2").state, "accepted_with_risk");
  assert.equal(context.evaluate("rev-3").state, "candidate", "旧 revision 风险不得泄漏到新内容版本");
});

test("accept-risk 校验 confirmation、target 类型与 target id；standing-authorization 被拒绝", (t) => {
  const context = makeFixture(t);
  context.acceptRisk("requirement", "R1", { confirmation: "implicit", expectedStatus: 1 });
  const standing = context.acceptRisk("requirement", "R1", { confirmation: "standing-authorization", expectedStatus: 1 });
  assert.match(standing.stderr, /user-explicit/);
  assert.equal(context.events().filter((event) => event.type === "RiskAccepted").length, 0, "standing 接受不得写入事件流");
  context.acceptRisk("unknown", "R1", { expectedStatus: 1 });
  context.acceptRisk("requirement", "NO-SUCH", { expectedStatus: 1 });
  const record = context.acceptRisk("requirement", "R1", {
    revision: "rev-high-level",
  });
  assert.equal(record.actor, "user");
  assert.equal(record.contractVersion, 1);
  assert.equal(record.revision, "rev-high-level");
  assert.equal(record.confirmation, "user-explicit");
  assert.match(record.eventId, /^[0-9a-f]{64}$/);
  assert.match(record.signature, /^[A-Za-z0-9+/]+={0,2}$/);
});

test("accept-risk 省略 revision 时自动使用当前 git revision，evaluate 可复现同一裁决", (t) => {
  const context = makeFixture(t);
  initGitProject(context.projectRoot);
  const revision = runGate(["revision", "--project-root", context.projectRoot], context.home).stdout.trim();
  context.approve();
  context.add("ImplementationRecorded", { incrementId: "I1", artifact: context.artifact("implementation.txt") }, revision);
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "failed", artifact: context.artifact("failed.txt"),
  }, revision);
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") }, revision);
  const risk = context.acceptRisk("requirement", "R1", { revision: null });
  assert.equal(risk.revision, revision);
  const evaluated = runGate(["evaluate", "--task-dir", context.taskDir], context.home);
  assertOk(evaluated);
  assert.equal(JSON.parse(evaluated.stdout).state, "accepted_with_risk");
});

test("git revision：clean=HEAD，tracked 与未跟踪内容改变哈希，ignored 不影响", (t) => {
  const context = makeFixture(t);
  initGitProject(context.projectRoot);
  const revisionArgs = ["revision", "--project-root", context.projectRoot];
  const clean = runGate(revisionArgs, context.home);
  assertOk(clean);
  const head = git(["rev-parse", "HEAD"], context.projectRoot);
  assert.equal(clean.stdout.trim(), head);
  assert.equal(runGate(revisionArgs, context.home).stdout.trim(), head, "clean revision 必须稳定");

  writeFileSync(join(context.projectRoot, "tracked.txt"), "已修改\n");
  const dirtyTracked = runGate(revisionArgs, context.home).stdout.trim();
  assert.match(dirtyTracked, new RegExp(`^${head}\\+[0-9a-f]{12}$`));
  writeFileSync(join(context.projectRoot, "tracked.txt"), "初始内容\n");
  assert.equal(runGate(revisionArgs, context.home).stdout.trim(), head);

  writeFileSync(join(context.projectRoot, "ignored.txt"), "忽略内容一\n");
  assert.equal(runGate(revisionArgs, context.home).stdout.trim(), head);
  writeFileSync(join(context.projectRoot, "ignored.txt"), "忽略内容二\n");
  assert.equal(runGate(revisionArgs, context.home).stdout.trim(), head);

  writeFileSync(join(context.projectRoot, "untracked.txt"), "未跟踪内容一\n");
  const untrackedOne = runGate(revisionArgs, context.home).stdout.trim();
  assert.match(untrackedOne, new RegExp(`^${head}\\+[0-9a-f]{12}$`));
  writeFileSync(join(context.projectRoot, "untracked.txt"), "未跟踪内容二\n");
  const untrackedTwo = runGate(revisionArgs, context.home).stdout.trim();
  assert.notEqual(untrackedTwo, untrackedOne, "同一未跟踪路径的内容变化必须改变 revision");
  rmSync(join(context.projectRoot, "untracked.txt"));
  assert.equal(runGate(revisionArgs, context.home).stdout.trim(), head);
});

test("untracked symlink 哈希目标内容：目标变化改变 revision；目录目标与 FIFO 稳定处理", (t) => {
  const context = makeFixture(t);
  initGitProject(context.projectRoot);
  const revisionArgs = ["revision", "--project-root", context.projectRoot];
  const head = git(["rev-parse", "HEAD"], context.projectRoot);

  // 目标为被忽略的普通文件：目标内容变化只能经由链接目标哈希捕获
  writeFileSync(join(context.projectRoot, "ignored.txt"), "忽略目标一\n");
  symlinkSync("ignored.txt", join(context.projectRoot, "link.txt"));
  const withLink = runGate(revisionArgs, context.home).stdout.trim();
  assert.match(withLink, new RegExp(`^${head}\\+[0-9a-f]{12}$`));
  writeFileSync(join(context.projectRoot, "ignored.txt"), "忽略目标二\n");
  const changedTarget = runGate(revisionArgs, context.home).stdout.trim();
  assert.notEqual(changedTarget, withLink, "symlink 目标内容变化必须改变 revision");

  // 目标为被忽略的目录：目录内文件内容变化必须改变 revision
  writeFileSync(join(context.projectRoot, ".gitignore"), "ignored.txt\ndir-target/\n");
  mkdirSync(join(context.projectRoot, "dir-target"));
  writeFileSync(join(context.projectRoot, "dir-target", "a.txt"), "A\n");
  symlinkSync("dir-target", join(context.projectRoot, "dir-link"));
  const dirLink = runGate(revisionArgs, context.home).stdout.trim();
  writeFileSync(join(context.projectRoot, "dir-target", "a.txt"), "A2\n");
  const dirChanged = runGate(revisionArgs, context.home).stdout.trim();
  assert.notEqual(dirChanged, dirLink, "目录目标内文件内容变化必须改变 revision");

  // untracked FIFO 不让 revision 失败且稳定
  const mkfifoResult = spawnSync("mkfifo", [join(context.projectRoot, "events.fifo")], { encoding: "utf8" });
  assert.equal(mkfifoResult.status, 0, `mkfifo 失败：${mkfifoResult.stderr}`);
  const fifoOne = runGate(revisionArgs, context.home);
  assertOk(fifoOne, "untracked FIFO 不得让 revision 失败");
  const fifoTwo = runGate(revisionArgs, context.home).stdout.trim();
  assert.equal(fifoTwo, fifoOne.stdout.trim(), "FIFO 存在时 revision 必须稳定");

  // 二级 symlink：链接 → 链接 → 文件，最内层文件内容变化必须改变 revision（含链接环终止）
  writeFileSync(join(context.projectRoot, "inner-target.txt"), "内层一\n");
  symlinkSync("inner-target.txt", join(context.projectRoot, "mid-link.txt"));
  symlinkSync("mid-link.txt", join(context.projectRoot, "outer-link.txt"));
  const nestedLink = runGate(revisionArgs, context.home).stdout.trim();
  writeFileSync(join(context.projectRoot, "inner-target.txt"), "内层二\n");
  const nestedChanged = runGate(revisionArgs, context.home).stdout.trim();
  assert.notEqual(nestedChanged, nestedLink, "二级 symlink 最内层目标内容变化必须改变 revision");
  symlinkSync("loop-b", join(context.projectRoot, "loop-a"));
  symlinkSync("loop-a", join(context.projectRoot, "loop-b"));
  const loopRevision = runGate(revisionArgs, context.home);
  assertOk(loopRevision, "symlink 环不得让 revision 失败");
});

test("非 git 项目未显式传 revision 时失败，并给出 --revision 恢复动作", (t) => {
  const context = makeFixture(t);
  const revision = runGate(["revision", "--project-root", context.projectRoot], context.home);
  assertFailure(revision);
  assert.match(revision.stderr, /--revision/);
  const evaluated = runGate(["evaluate", "--task-dir", context.taskDir], context.home);
  assertFailure(evaluated);
  assert.match(evaluated.stderr, /--revision/);
  assert.equal(context.evaluate("explicit-content-v1").state, "draft");
});

test("git 项目显式旧 revision 拒绝 evaluate；一致时 caller-verified，自动计算为 computed", (t) => {
  const context = makeFixture(t);
  initGitProject(context.projectRoot);
  const revisionArgs = ["revision", "--project-root", context.projectRoot];
  const rev1 = runGate(revisionArgs, context.home).stdout.trim();
  writeFileSync(join(context.projectRoot, "tracked.txt"), "修改后\n");
  const rev2 = runGate(revisionArgs, context.home).stdout.trim();
  assert.notEqual(rev2, rev1);
  const stale = runGate(["evaluate", "--task-dir", context.taskDir, "--revision", rev1], context.home);
  assertFailure(stale);
  assert.ok(stale.stderr.includes(rev2), "恢复动作必须指向当前工作树 revision");

  const current = runGate(["evaluate", "--task-dir", context.taskDir, "--revision", rev2], context.home);
  assertOk(current);
  const currentVerdict = JSON.parse(current.stdout);
  assert.equal(currentVerdict.revision, rev2);
  assert.equal(currentVerdict.revisionSource, "caller-verified");

  const computed = runGate(["evaluate", "--task-dir", context.taskDir], context.home);
  assertOk(computed);
  const computedVerdict = JSON.parse(computed.stdout);
  assert.equal(computedVerdict.revision, rev2);
  assert.equal(computedVerdict.revisionSource, "computed");

  // 非 git 项目显式 revision 保留，标 caller
  const nonGit = makeFixture(t);
  const explicit = runGate(["evaluate", "--task-dir", nonGit.taskDir, "--revision", "explicit-v1"], nonGit.home);
  assertOk(explicit);
  const explicitVerdict = JSON.parse(explicit.stdout);
  assert.equal(explicitVerdict.revision, "explicit-v1");
  assert.equal(explicitVerdict.revisionSource, "caller");
});

test("只有 evaluate 更新 verdict.json，validate/append/高层命令均不改写", (t) => {
  const context = makeFixture(t);
  const verdictPath = join(context.taskDir, "verdict.json");
  assert.equal(existsSync(verdictPath), false);
  assertOk(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
  context.approve();
  const event = context.event("ImplementationRecorded", {
    incrementId: "I1", artifact: context.artifact("implementation.txt"),
  });
  context.append(event);
  assert.equal(existsSync(verdictPath), false);
  writeFileSync(verdictPath, "手工哨兵\n");
  context.append(event);
  context.approve();
  assertOk(runGate(["validate-contract", "--task-dir", context.taskDir], context.home));
  assert.equal(readFileSync(verdictPath, "utf8"), "手工哨兵\n");
  context.evaluate();
  assert.equal(readJson(verdictPath).generatedBy, "delivery-gate");
});

test("FindingResolved 相同内容幂等，不同内容必须追加新事件且不静默短路", (t) => {
  const context = makeFixture(t);
  context.add("FindingRaised", {
    findingId: "F-IDEMPOTENT-1",
    requirementIds: [],
    severity: "non-blocker",
    artifact: context.artifact("finding.txt"),
  });
  const first = context.add("FindingResolved", {
    findingId: "F-IDEMPOTENT-1", artifact: context.artifact("resolution-1.txt"),
  });
  const same = context.add("FindingResolved", {
    findingId: "F-IDEMPOTENT-1", artifact: context.artifact("resolution-1.txt"),
  });
  assert.deepEqual(same, first);
  assert.equal(context.events().length, 2);
  const different = context.add("FindingResolved", {
    findingId: "F-IDEMPOTENT-1",
    summary: "重新确认解决",
    artifact: context.artifact("resolution-2.txt"),
  });
  assert.notEqual(different.eventId, first.eventId);
  assert.equal(context.events().length, 3, "同 findingId 不同内容必须追加新事件");
  assert.deepEqual(context.evaluate().openFindings, [], "当前 revision 存在 resolution 时 finding 保持关闭");
});

test("finding 跨 revision：resolve 仅当前 revision 有效，新 revision 重新打开并需重新确认", (t) => {
  const context = makeFixture(t);
  context.complete("rev-1");
  assert.equal(context.evaluate("rev-1").state, "accepted");
  context.add("FindingRaised", {
    findingId: "F-CROSS-1",
    requirementIds: ["R1"],
    severity: "blocker",
    artifact: context.artifact("finding.txt"),
  }, "rev-1");
  assert.equal(context.evaluate("rev-1").state, "implementing");
  context.add("FindingResolved", {
    findingId: "F-CROSS-1", artifact: context.artifact("resolution-1.txt"),
  }, "rev-1");
  assert.equal(context.evaluate("rev-1").state, "accepted");

  const reopened = context.evaluate("rev-2");
  assert.equal(reopened.openFindings.length, 1, "新 revision 必须重新确认已解决的 finding");
  assert.equal(reopened.openFindings[0].findingId, "F-CROSS-1");
  assert.equal(reopened.state, "implementing", "重新打开的 blocker 回到 implementing");

  context.add("FindingResolved", {
    findingId: "F-CROSS-1", artifact: context.artifact("resolution-2.txt"),
  }, "rev-2");
  const resolvedAgain = context.evaluate("rev-2");
  assert.deepEqual(resolvedAgain.openFindings, []);
  assert.equal(resolvedAgain.state, "candidate", "rev-2 尚无当前证据，重开解决后只到 candidate");
});

test("artifact 必须存在于 evidence 内，拒绝缺失文件与符号链接逃逸", (t) => {
  const context = makeFixture(t);
  context.append(context.event("ImplementationRecorded", {
    incrementId: "I1", artifact: "evidence/missing.txt",
  }), 1);
  context.append(context.event("ImplementationRecorded", {
    incrementId: "I1", artifact: "contract.json",
  }), 1);
  const outside = join(context.root, "outside.txt");
  writeFileSync(outside, "外部文件");
  symlinkSync(outside, join(context.taskDir, "evidence", "escape.txt"));
  context.append(context.event("ImplementationRecorded", {
    incrementId: "I1", artifact: "evidence/escape.txt",
  }), 1);
  context.add("ImplementationRecorded", {
    incrementId: "I1", artifact: context.artifact("valid.txt"),
  });
  assert.equal(context.events().length, 1);
});

test("历史 artifact 缺失时 evaluate 不整体失败：相关证据不计入并列入 missingArtifacts", (t) => {
  const context = makeFixture(t);
  context.complete("rev-1");
  assert.equal(context.evaluate("rev-1").state, "accepted");

  rmSync(join(context.taskDir, "evidence", "evidence.txt"));
  const degraded = context.evaluate("rev-1");
  assert.equal(degraded.state, "candidate", "证据 artifact 缺失后不得维持 accepted");
  assert.deepEqual(degraded.missing.evidence, [{ requirementId: "R1", kind: "command", result: "missing" }]);
  assert.deepEqual(degraded.missing.missingArtifacts, [
    { artifact: "evidence/evidence.txt", type: "EvidenceRecorded", seq: 3 },
  ]);

  // finding 保留：artifact 缺失不影响 finding 状态
  context.add("FindingRaised", {
    findingId: "F-KEEP-1",
    requirementIds: [],
    severity: "non-blocker",
    artifact: context.artifact("keep-finding.txt"),
  }, "rev-1");
  rmSync(join(context.taskDir, "evidence", "keep-finding.txt"));
  const kept = context.evaluate("rev-1");
  assert.equal(kept.openFindings.length, 1, "finding 不因 artifact 缺失而消失");
  assert.equal(kept.missing.missingArtifacts.length, 2);

  // artifact 缺失不阻塞后续写入，补齐新证据后恢复
  context.add("FindingResolved", {
    findingId: "F-KEEP-1", artifact: context.artifact("keep-resolution.txt"),
  }, "rev-1");
  context.add("EvidenceRecorded", {
    requirementId: "R1", kind: "command", result: "verified", artifact: context.artifact("evidence-again.txt"),
  }, "rev-1");
  const recovered = context.evaluate("rev-1");
  assert.equal(recovered.state, "accepted");
  assert.equal(recovered.missing.missingArtifacts.length, 2, "缺失记录仍保留在 verdict 中供审计");
});

test("事件流 JSON、seq、eventId 损坏均 fail-fast，失败 evaluate 不更新 verdict", (t) => {
  const context = makeFixture(t);
  const eventsPath = join(context.taskDir, "events.jsonl");
  const verdictPath = join(context.taskDir, "verdict.json");
  writeFileSync(verdictPath, "保持原裁决\n");
  writeFileSync(eventsPath, "{\n");
  assertFailure(runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home));
  assert.equal(readFileSync(verdictPath, "utf8"), "保持原裁决\n");

  writeFileSync(eventsPath, "");
  context.add("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  const validRecord = context.events()[0];
  writeFileSync(eventsPath, `${JSON.stringify({ ...validRecord, eventId: "0".repeat(64) })}\n`);
  assertFailure(runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home));
  writeFileSync(eventsPath, `${JSON.stringify({ ...validRecord, seq: 2 })}\n`);
  assertFailure(runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home));
});

test("事件签名篡改或缺失 fail-fast 且不更新 verdict", (t) => {
  const context = makeFixture(t);
  context.approve();
  const [record] = context.events();
  const eventsPath = join(context.taskDir, "events.jsonl");
  const verdictPath = join(context.taskDir, "verdict.json");
  writeFileSync(verdictPath, "签名哨兵\n");

  // 签名值损坏（内容与 eventId 一致）
  const badSignature = { ...record, signature: Buffer.from("x".repeat(64), "utf8").toString("base64") };
  writeFileSync(eventsPath, `${JSON.stringify(badSignature)}\n`);
  const broken = runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home);
  assertFailure(broken);
  assert.match(broken.stderr, /签名验证失败/);

  // signature 字段缺失
  const noSignature = { ...record };
  delete noSignature.signature;
  writeFileSync(eventsPath, `${JSON.stringify(noSignature)}\n`);
  assertFailure(runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home));

  // 内容被篡改但 eventId 被同步重算：旧签名必须失效
  const tampered = tamperRecordContent(record, { summary: "篡改后的摘要" });
  writeFileSync(eventsPath, `${JSON.stringify(tampered)}\n`);
  const tamperedResult = runGate(["evaluate", "--task-dir", context.taskDir, "--revision", "rev-1"], context.home);
  assertFailure(tamperedResult);
  assert.match(tamperedResult.stderr, /签名验证失败/);

  assert.equal(readFileSync(verdictPath, "utf8"), "签名哨兵\n", "验签失败不得更新 verdict");
});

test("敌意 actor：无 key、错 key、跨角色 key 均拒绝，正确 key 签名可验", (t) => {
  const context = makeFixture(t);
  const contractSha256 = createHash("sha256").update(readFileSync(join(context.taskDir, "contract.json"))).digest("hex");
  const userEvent = context.event("ContractApproved", { contractSha256, confirmation: "user-explicit" });

  // 无 key
  const noKey = runGate([
    "append", "--task-dir", context.taskDir, "--event", JSON.stringify(userEvent),
  ], context.home);
  assertFailure(noKey, 2);

  // 错 key（不属于本任务的第三方私钥）
  const stranger = generateKeyPairSync("ed25519");
  const strangerPem = stranger.privateKey.export({ type: "pkcs8", format: "pem" });
  const wrongKey = context.append(userEvent, 1, strangerPem);
  assert.match(wrongKey.stderr, /不属于本任务/);

  // builderKey 伪造 user 事件
  const forgedUser = context.append(userEvent, 1, context.builderKey);
  assert.match(forgedUser.stderr, /userKey/);

  // userKey 伪造 assurance 事件
  const writerEvent = context.event("AssuranceCompleted", { artifact: context.artifact("assurance.txt") });
  const forgedWriter = context.append(writerEvent, 1, context.userKey);
  assert.match(forgedWriter.stderr, /assuranceKey/);

  // builderKey 伪造 assurance 事件（跨 workflow 角色伪造）
  const forgedAssurance = context.append(writerEvent, 1, context.builderKey);
  assert.match(forgedAssurance.stderr, /assuranceKey/);

  assert.equal(context.events().length, 0, "被拒绝的事件不得进入事件流");

  // 正确 key 签名可验
  context.append(userEvent, 0, context.userKey);
  context.append(writerEvent, 0, context.assuranceKey);
  const verdict = context.evaluate();
  assert.equal(verdict.integrity.signatureVerified, true);
  assert.equal(verdict.integrity.eventCount, 2);

  // 高层命令必须携带本任务 userKey
  assertFailure(runGate([
    "approve-contract", "--task-dir", context.taskDir,
    "--confirmation", "user-explicit", "--summary", "缺密钥",
  ], context.home), 2);
  const wrongHighLevel = runGate([
    "approve-contract", "--task-dir", context.taskDir,
    "--confirmation", "user-explicit", "--summary", "错密钥",
    "--user-key", context.builderKey,
  ], context.home);
  assertFailure(wrongHighLevel);
  assert.match(wrongHighLevel.stderr, /userKey/);
  assertFailure(runGate([
    "accept-risk", "--task-dir", context.taskDir,
    "--target-type", "requirement", "--target-id", "R1",
    "--confirmation", "user-explicit", "--summary", "缺密钥",
    "--revision", context.revision,
  ], context.home), 2);
});

test("并发 append 双进程串行成功且 seq 单调；陈旧锁可抢占并在结果中说明", async (t) => {
  const context = makeFixture(t);
  context.approve();
  const artifactA = context.artifact("conc-a.txt");
  const artifactB = context.artifact("conc-b.txt");
  const eventA = context.event("FindingRaised", {
    findingId: "F-CONC-A", requirementIds: [], severity: "non-blocker", artifact: artifactA,
  });
  const eventB = context.event("FindingRaised", {
    findingId: "F-CONC-B", requirementIds: [], severity: "non-blocker", artifact: artifactB,
  });
  // 先放置由本测试进程持有的活锁：两个写入进程同时进入等待后释放锁，制造真实争抢窗口
  const lockDir = join(context.taskDir, ".events.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
  const promiseA = spawnGateAsync([
    "append", "--task-dir", context.taskDir, "--event", JSON.stringify(eventA), "--key", context.assuranceKey,
  ], context.home);
  const promiseB = spawnGateAsync([
    "append", "--task-dir", context.taskDir, "--event", JSON.stringify(eventB), "--key", context.assuranceKey,
  ], context.home);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 400));
  rmSync(lockDir, { recursive: true, force: true });
  const [a, b] = await Promise.all([promiseA, promiseB]);
  assert.equal(a.status, 0, `并发 append A 失败：${a.stderr}`);
  assert.equal(b.status, 0, `并发 append B 失败：${b.stderr}`);
  const events = context.events();
  assert.equal(events.length, 3, "两个并发事件必须都成功追加");
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3], "seq 必须从 1 单调递增且无重复");
  const verdict = context.evaluate();
  assert.equal(verdict.integrity.eventCount, 3);
  assert.equal(verdict.openFindings.length, 2);

  // 陈旧锁：持有进程已不存在的锁必须可抢占，且写入结果中说明
  mkdirSync(lockDir, { recursive: false });
  writeFileSync(join(lockDir, "owner"), JSON.stringify({
    pid: 999999999,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const eventC = context.event("FindingRaised", {
    findingId: "F-CONC-C", requirementIds: [], severity: "non-blocker", artifact: context.artifact("conc-c.txt"),
  });
  const preempted = runGate([
    "append", "--task-dir", context.taskDir, "--event", JSON.stringify(eventC), "--key", context.assuranceKey,
  ], context.home);
  assertOk(preempted, "陈旧锁必须可抢占");
  assert.match(preempted.stderr, /抢占/, "抢占必须在写入结果中说明");
  assert.equal(context.events().length, 4);
  assert.deepEqual(context.events().map((event) => event.seq), [1, 2, 3, 4]);
});

test("parseOptions 允许以 -- 开头的参数值", (t) => {
  const context = makeFixture(t);
  context.approve("user-explicit", "--看起来像参数的摘要--");
  assert.equal(context.events()[0].summary, "--看起来像参数的摘要--");
  const risk = context.acceptRisk("requirement", "R1", { summary: "--dash-leading--" });
  assert.equal(risk.summary, "--dash-leading--");
});

test("契约内容变化但未递增版本时旧 ContractApproved 哈希失效，状态回到 draft", (t) => {
  const context = makeFixture(t);
  context.complete();
  assert.equal(context.evaluate().state, "accepted");
  context.contract = { ...context.contract, objective: "同一版本号下被改变的契约内容" };
  writeJson(join(context.taskDir, "contract.json"), context.contract);
  assert.equal(context.evaluate().state, "draft");
});

test("非 required 需求缺证据不妨碍 required 需求全部 verified 后 accepted", (t) => {
  const context = makeFixture(t, {
    requirements: [
      {
        id: "R1", kind: "goal", statement: "必须验证的目标", required: true,
        riskAcceptable: false, evidenceKinds: ["command"],
      },
      {
        id: "R2", kind: "goal", statement: "可选增强", required: false,
        riskAcceptable: true, evidenceKinds: ["inspection"],
      },
    ],
  });
  context.complete();
  const verdict = context.evaluate();
  assert.equal(verdict.state, "accepted");
  assert.equal(verdict.requirements.find((requirement) => requirement.id === "R2").status, "missing");
});
