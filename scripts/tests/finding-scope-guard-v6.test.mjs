// finding-scope-guard-v6.test.mjs — 空关联发现护栏与检测/分流判据词面初筛回归
// （设计《V5 交付完整性与语义可信性改造》机制一 §5.4：requirementIds=[] 不得成为绕过
//  定级护栏的通道；恒真/恒假不得作为已实现证据——机器层只做词面提示）
//
// 覆盖：
//   1. schema 2 下 category=boundary 且 requirementIds=[] 无 emptyScopeRefutation → 拒绝写入，
//      错误含三个恢复动作（补论证 / 关联需求重登 / open-revision 修订验收）
//   2. 附 --empty-scope-refutation 后登记成功，事件落盘字段完整
//   3. category=defect 的空关联不受该护栏约束（护栏只针对 boundary）
//   4. --empty-scope-refutation 空字符串被 shape 校验拒绝（论证必须非空）
//   5. 词面初筛：检测/分流类断言无否定性场景标记 → validate-acceptance 记 warning 不拒写入，
//      warning 附「补正负场景对照或书面论证不适用」恢复动作
//   6. 有否定性标记（不/排除/negative 等）或无检测关键词的需求组 → 无 warning
//   7. schema 1 存量任务不参与词面初筛（warnings 恒空——schema 1 保持需求级判定）
//
// 运行：node --test scripts/tests/finding-scope-guard-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "delivery-gate.mjs");

const parseStdout = (result) => result.stdout.slice(result.stdout.indexOf("{"));
function runGate(args, home) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });
}
function ok(result, label = "命令应成功") {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function makeFixture(t, { taskId = "scope-guard" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "finding-scope-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(projectDir);
  mkdirSync(home);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: projectDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: projectDir });
  writeFileSync(join(projectDir, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: projectDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: projectDir });
  const intentPath = join(root, "intent.md");
  writeFileSync(intentPath, "记忆检索只注入与当前工作相关的条目\n");
  const init = runGate(["init", "--project-root", projectDir, "--task-id", taskId, "--intent-file", intentPath], home);
  ok(init, "init 应成功");
  const output = JSON.parse(parseStdout(init));
  return { root, projectDir, home, taskDir: output.taskDir, creds: output.credentials };
}

function evidenceFile(fx, name, content) {
  const path = join(fx.taskDir, "evidence", name);
  mkdirSync(join(fx.taskDir, "evidence"), { recursive: true });
  writeFileSync(path, content ?? `# ${name}\n`);
  return `evidence/${name}`;
}

/** schema 2 验收包：R1 断言文本由调用方给定（词面初筛测试的变量——注意 given/when/then
 *  也参与词面初筛，无关键词用例须全字段避开检测/分流词）；schema 1 变体供对照 */
function writeAcceptance(fx, { assertionStatement = "检索返回与当前工作相关的记忆", schemaVersion = 2, plainFields = false } = {}) {
  const fields = plainFields
    ? { qualifiers: ["完整性"], given: "一次写入完成", when: "读取文件", then: "内容与写入一致" }
    : { qualifiers: ["相关性"], given: "已有多条记忆", when: "发起检索", then: "返回相关条目" };
  const requirement = schemaVersion === 2
    ? {
        id: "R1", kind: "goal", statement: assertionStatement, required: true, riskAcceptable: false,
        evidenceKinds: ["command", "inspection"],
        assertions: [{ id: "A1", statement: assertionStatement, adversarialFormRefs: ["AF1"], testAssetRefs: ["test-A1"], ...fields }],
      }
    : {
        id: "R1", kind: "goal", statement: "记忆检索按相关性注入", required: true, riskAcceptable: false,
        evidenceKinds: ["command", "inspection"],
      };
  const acceptance = {
    schemaVersion,
    acceptanceVersion: 1,
    taskId: basename(fx.taskDir),
    projectRoot: realpathSync(fx.projectDir),
    objective: "记忆检索只注入相关条目",
    requirements: [requirement],
    nonGoals: [],
    riskLevel: "low",
    exploratoryReview: "not-required",
    reviewDimensions: [],
  };
  if (schemaVersion === 2) {
    acceptance.adversarialForms = plainFields
      ? [{ id: "AF1", assertionId: "A1", qualifier: "完整性", entryPoint: "文件读取入口", initialState: "一次写入完成", operation: "读取文件", timing: "写入后", expected: "内容与写入一致", testAssetRefs: ["test-A1"], rationale: "部分写入检测" }]
      : [{ id: "AF1", assertionId: "A1", qualifier: "相关性", entryPoint: "检索入口", initialState: "无关记忆占多数", operation: "发起检索", timing: "检索期", expected: "无关记忆被排除", testAssetRefs: ["test-A1"], rationale: "全量注入蒙混检测" }];
  }
  writeFileSync(join(fx.taskDir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  writeFileSync(join(fx.taskDir, "increments.json"), `${JSON.stringify({
    schemaVersion: 1, acceptanceVersion: 1,
    items: [{ id: "I1", title: "检索与注入", requirementIds: ["R1"], testCommand: { program: "true", args: [] } }],
  }, null, 2)}\n`);
}

/** 驱动到可登记发现的状态：包合法 + 策略快照固定 */
function prepareForFindings(fx, options) {
  writeAcceptance(fx, options);
  ok(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home), "验收包应合法");
  ok(runGate(["snapshot-policy", "--task-dir", fx.taskDir], fx.home));
  return runGate(["revision", "--project-root", fx.projectDir], fx.home).stdout.trim();
}

function recordFinding(fx, revision, { category, severity = "non-blocker", requirementIds, emptyScopeRefutation } = {}) {
  const args = ["record-finding", "--task-dir", fx.taskDir,
    "--summary", `${category} 发现`, "--category", category, "--severity", severity,
    "--requirement-ids", JSON.stringify(requirementIds),
    "--artifact", evidenceFile(fx, `finding-${category}-${requirementIds.length}.md`),
    "--credential", fx.creds.assurance, "--revision", revision];
  // 既有规则：schema 2 的 non-blocker 必须附 consequenceRefutation（三类枚举之一）
  if (severity === "non-blocker") {
    args.push("--consequence-refutation", "模拟环境外的日志路径，用户不可观察", "--consequence-refutation-type", "not-observable");
  }
  if (emptyScopeRefutation !== undefined) args.push("--empty-scope-refutation", emptyScopeRefutation);
  return runGate(args, fx.home);
}

// ── 1-4. 空关联 boundary 护栏 ──

test("schema 2 空关联 boundary 未附论证被拒绝，错误含三个恢复动作", (t) => {
  const fx = makeFixture(t);
  const revision = prepareForFindings(fx);
  const rejected = recordFinding(fx, revision, { category: "boundary", requirementIds: [] });
  assert.notEqual(rejected.status, 0, "空关联 boundary 无论证应拒绝写入");
  assert.match(rejected.stderr, /emptyScopeRefutation/);
  assert.match(rejected.stderr, /空关联不得成为绕过定级护栏的通道/);
  assert.match(rejected.stderr, /恢复动作：三选一/);
  assert.match(rejected.stderr, /--empty-scope-refutation/);
  assert.match(rejected.stderr, /--requirement-ids/);
  assert.match(rejected.stderr, /open-revision/);
});

test("附 --empty-scope-refutation 的空关联 boundary 登记成功且事件字段完整", (t) => {
  const fx = makeFixture(t);
  const revision = prepareForFindings(fx);
  const accepted = recordFinding(fx, revision, {
    category: "boundary",
    requirementIds: [],
    emptyScopeRefutation: "该发现仅出现在模拟环境的日志采集路径，不影响任何验收需求：R1 断言的检索行为在真实宿主不经过该路径，已逐条对照。",
  });
  ok(accepted, "附论证的空关联 boundary 应登记成功");
  const event = JSON.parse(parseStdout(accepted));
  assert.equal(event.type, "FindingRaised");
  assert.equal(typeof event.emptyScopeRefutation, "string");
  assert.ok(event.emptyScopeRefutation.length > 0, "落盘事件须携带非空论证");
});

test("category=defect 的空关联不受护栏约束（护栏只针对 boundary）", (t) => {
  const fx = makeFixture(t);
  const revision = prepareForFindings(fx);
  const defect = recordFinding(fx, revision, { category: "defect", severity: "blocker", requirementIds: [] });
  ok(defect, "空关联 defect（blocker 触发全量修复通道）不需要空范围论证");
});

test("--empty-scope-refutation 空字符串被 shape 校验拒绝（论证必须非空）", (t) => {
  const fx = makeFixture(t);
  const revision = prepareForFindings(fx);
  const rejected = recordFinding(fx, revision, { category: "boundary", requirementIds: [], emptyScopeRefutation: "" });
  assert.notEqual(rejected.status, 0, "空字符串论证不得过 shape 校验");
  assert.match(rejected.stderr, /emptyScopeRefutation/);
});

// ── 5-7. 检测/分流判据词面初筛（warning 层，不拒写入）──

test("检测类断言无否定性场景标记 → validate-acceptance 记 warning 不拒写入", (t) => {
  const fx = makeFixture(t);
  writeAcceptance(fx, { assertionStatement: "检索返回与当前工作相关的记忆条目" });
  const result = runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home);
  ok(result, "词面初筛是提示层，不得拒写入");
  const output = JSON.parse(parseStdout(result));
  assert.ok(Array.isArray(output.warnings), "输出须含 warnings 数组");
  assert.equal(output.warnings.length, 1, "命中关键词且无否定标记的需求组记一条");
  assert.match(output.warnings[0], /R1/);
  assert.match(output.warnings[0], /恒真\/恒假/);
  assert.match(output.warnings[0], /补正负场景对照或书面论证不适用/);
});

test("断言含否定性标记或需求组无检测关键词 → 无 warning", (t) => {
  const fx = makeFixture(t);
  writeAcceptance(fx, { assertionStatement: "无关记忆不被注入，仅返回相关条目" });
  const negative = JSON.parse(parseStdout(runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home)));
  assert.equal(negative.warnings.length, 0, "含否定性场景标记（不/排除等）不警告");

  const fx2 = makeFixture(t, { taskId: "scope-guard-2" });
  writeAcceptance(fx2, { assertionStatement: "写入完成后文件内容完整", plainFields: true });
  const noKeyword = JSON.parse(parseStdout(runGate(["validate-acceptance", "--task-dir", fx2.taskDir], fx2.home)));
  assert.equal(noKeyword.warnings.length, 0, "无检测/分流关键词的需求组不参与初筛");
});

test("schema 1 存量任务 warnings 恒空（保持需求级判定，不引入新校验）", (t) => {
  const fx = makeFixture(t);
  writeAcceptance(fx, { schemaVersion: 1 });
  const result = runGate(["validate-acceptance", "--task-dir", fx.taskDir], fx.home);
  ok(result);
  const output = JSON.parse(parseStdout(result));
  assert.equal(output.warnings.length, 0);
});
