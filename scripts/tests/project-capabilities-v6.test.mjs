// project-capabilities-v6.test.mjs —— 项目静态能力快照独立局部测试
//
// 被测实现：skills/self/dev-workflow/delivery-v6/scripts/detect-project-capabilities.mjs
//（设计《V5 三技能结构化交付优化》第二步：只读静态能力快照，§5.1 schemaVersion 1 / §7.1 校验）。
//
// 覆盖：
//   1. 探测：命令登记来源正确——package.json scripts → kind=package-script（npm run 通道），
//      测试配置存在性 → kind=test-config（不解析语义）；被消费来源全进 inputHashes
//   2. unknown 在场：AGENTS.md 声明 verification skill 但清单定位不到 → unknowns 登记、不编命令、
//      无假资产；反向：显式「未声明」= 项目事实，不记 unknown
//   3. 场景清单定位成功：--skills-root 指向 fixture 技能 → verificationAssets 按 scenario-manifest
//      来源登记，清单本身进 inputHashes（失效口径：被消费的来源文件）
//   4. 快照校验通过：--validate 对合法快照零退出 PASS
//   5. --check 通过态：同输入重探测一致（观测元数据 observedAt 不参与比较）
//   6. 输入失效：改 package.json 后 --check 报「输入已变化」
//   7. 值漂移：手改快照命令字段（输入未变）报「不一致（疑似手改）」
//   8. 结构无执行证据字段：grep 断言合法快照不含 probe/status 类字段；注入 probe.status /
//      didPass / success / outcome 等执行语义键的快照被 --validate 白名单校验拒绝
//     （§7.1：不含执行通过状态；快照结构是封闭集合，未知键一律 FAIL）
//   9. 内嵌寻址探针与单源逐字节一致（parity 防漂移；单源 = workflows/src/skill-data.shared.ts）
//  10. 缺省输出路径 = skill-data 寻址段 dev-flow 段（单仓形态 <slug>/project-capabilities.json；
//      HOME 重定向验证，不写真实 skill-data）；同输入两次探测除 observedAt 外逐字节一致
//  11. 用法错误退出码 2；--project-root 不存在退出码 1
//  12. 白名单绕过形态：didPass / success / outcome 注入各层级 → --validate FAIL（未知键）
//  13. md 场景清单：非 JSON 清单整体登记为 scenario-manifest 资产（哈希字段实测非 undefined）
//  14. 负向声明只在整行无 token 时成立：带「不使用 watch 模式」括注的声明行技能仍被登记；
//      无反引号 token 的声明行（如「verification skill 是 x」）→ 记 unknown 不静默丢
//  15. code-unit 排序：乱序 scripts 键（alpha/Beta）命令序按码元（Beta 在 alpha 前）
//  16. 悬空 flag：--out 无取值 → 用法错误 exit 2，不静默落缺省路径
//  17. 场景文件失效：改场景文件内容后 --check 报「输入已变化」（场景文件并入 inputHashes）
//
// fixture 一律临时目录构造、用完即删（绝对路径不入仓）；HOME 重定向避免污染真实 skill-data。
//
// 运行：node --test scripts/tests/project-capabilities-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "skills", "self", "dev-workflow", "delivery-v6", "scripts", "detect-project-capabilities.mjs");
const SKILL_DATA_SRC = join(REPO_ROOT, "skills", "self", "dev-workflow", "workflows", "src", "skill-data.shared.ts");

/** 跑被测 CLI；home 覆盖用于缺省路径用例（脚本经 os.homedir() 读 $HOME） */
function runCli(args, homeOverride) {
  const env = { ...process.env };
  if (homeOverride) env.HOME = homeOverride;
  else delete env.HOME;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 标准探测源 fixture：package.json scripts + vitest 配置 + 声明了定位不到的 verification skill 的 AGENTS.md */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "projcap-fixture-"));
  writeJson(join(root, "package.json"), { name: "fixture", version: "0.0.0", scripts: { lint: "eslint .", test: "vitest run" } });
  writeFileSync(join(root, "vitest.config.ts"), "export default {};\n");
  writeFileSync(
    join(root, "AGENTS.md"),
    "# fixture\n\n**verification skill 声明**：`zz-fixture-nonexistent-verify`（场景清单见该技能场景库）。\n",
  );
  return root;
}

/** 带场景库的 fixture 技能（--skills-root 指向它，避免读写真实 ~/.agents/skills） */
function makeFakeVerificationSkill() {
  const skillsRoot = mkdtempSync(join(tmpdir(), "projcap-skills-"));
  const skillDir = join(skillsRoot, "zz-fixture-verify");
  mkdirSync(join(skillDir, "cases"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# fixture verification skill\n");
  writeJson(join(skillDir, "scenarios.json"), { scenarios: [{ id: "p0-login", path: "cases/login.md" }] });
  writeFileSync(join(skillDir, "cases", "login.md"), "step: login\n");
  return skillsRoot;
}

let cleanup = [];
test.afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("探测：命令登记来源正确，被消费来源全进 inputHashes", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  const run = runCli(["--project-root", root, "--out", out]);
  assert.equal(run.status, 0, `探测应零退出：${run.stderr}`);
  const snapshot = JSON.parse(run.stdout);

  // package.json scripts → kind=package-script，npm run 通道（fixture 无 lockfile → 缺省 npm）
  const scriptTest = snapshot.commands.find((command) => command.id === "script.test");
  assert.deepEqual(scriptTest, {
    id: "script.test",
    command: { program: "npm", args: ["run", "test"] },
    source: { kind: "package-script", ref: "scripts.test" },
  });
  // 测试配置存在性 → kind=test-config（ref = 配置文件；不解析配置语义）
  const testVitest = snapshot.commands.find((command) => command.id === "test.vitest");
  assert.deepEqual(testVitest, {
    id: "test.vitest",
    command: { program: "npx", args: ["vitest", "run"] },
    source: { kind: "test-config", ref: "vitest.config.ts" },
  });
  assert.equal(snapshot.commands.length, 3, "应恰好登记 2 条脚本命令 + 1 条测试配置命令");

  // 失效口径（§5.1）：被消费的路由与来源文件全进 inputHashes；产品代码不在探测范围
  const shaOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.deepEqual(snapshot.inputHashes, {
    "AGENTS.md": shaOf(join(root, "AGENTS.md")),
    "package.json": shaOf(join(root, "package.json")),
    "vitest.config.ts": shaOf(join(root, "vitest.config.ts")),
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.projectRoot, realpathSync(root), "projectRoot 应为 realpath（寻址探针第一步约定）");
});

test("unknown 在场：声明了 verification skill 但清单定位不到；显式未声明不记 unknown", () => {
  const root = makeFixture();
  cleanup.push(root);
  const run = runCli(["--project-root", root, "--out", join(root, "snap.json")]);
  assert.equal(run.status, 0, "unknown 是快照合法内容，探测本身应零退出");
  const snapshot = JSON.parse(run.stdout);
  assert.equal(snapshot.verificationAssets.length, 0, "定位不到清单不得登记假资产（禁止猜路径）");
  assert.equal(snapshot.unknowns.length, 1);
  assert.match(snapshot.unknowns[0], /zz-fixture-nonexistent-verify/);
  assert.match(snapshot.unknowns[0], /恢复动作/, "unknown 条目必须自带恢复动作（错误消息可操作）");

  // 反向：显式「未声明」= 项目没有 verification skill 的事实，不记 unknown
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：本项目未声明 verification skill（以本行为准）。\n");
  const run2 = runCli(["--project-root", root, "--out", join(root, "snap2.json")]);
  assert.equal(run2.status, 0);
  const snapshot2 = JSON.parse(run2.stdout);
  assert.deepEqual(snapshot2.unknowns, []);
  assert.deepEqual(snapshot2.verificationAssets, []);
});

test("场景清单定位成功：资产按 scenario-manifest 来源登记，清单进 inputHashes", () => {
  const root = makeFixture();
  cleanup.push(root);
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：`zz-fixture-verify`。\n");
  const skillsRoot = makeFakeVerificationSkill();
  cleanup.push(skillsRoot);
  const run = runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", join(root, "snap.json")]);
  assert.equal(run.status, 0, `应零退出：${run.stderr}`);
  const snapshot = JSON.parse(run.stdout);
  assert.deepEqual(snapshot.unknowns, []);
  assert.deepEqual(snapshot.verificationAssets, [
    {
      id: "p0-login",
      kind: "scenario",
      path: join(skillsRoot, "zz-fixture-verify", "cases", "login.md"),
      sha256: createHash("sha256").update("step: login\n").digest("hex"),
      source: { kind: "scenario-manifest", ref: "scenarios.json#p0-login" },
    },
  ]);
  // 清单是被消费的来源文件（失效口径）：必须进 inputHashes（技能目录在 projectRoot 外 → 绝对路径键）
  assert.equal(
    snapshot.inputHashes[join(skillsRoot, "zz-fixture-verify", "scenarios.json")],
    createHash("sha256").update(readFileSync(join(skillsRoot, "zz-fixture-verify", "scenarios.json"))).digest("hex"),
  );
});

test("快照校验通过：--validate 对合法快照 PASS", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--out", out]).status, 0);
  const run = runCli(["--validate", out]);
  assert.equal(run.status, 0, `校验应通过：${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /PASS/);
});

test("--check 通过态：同输入重探测一致", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--out", out]).status, 0);
  const run = runCli(["--project-root", root, "--out", out, "--check"]);
  assert.equal(run.status, 0, `同输入应判一致：${run.stdout}`);
  assert.match(run.stdout, /PASS/);
});

test("输入失效：改 package.json 后 --check 报「输入已变化」", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--out", out]).status, 0);
  writeJson(join(root, "package.json"), { name: "fixture", scripts: { lint: "eslint ." } });
  const run = runCli(["--project-root", root, "--out", out, "--check"]);
  assert.equal(run.status, 1, "输入已变化必须非零退出");
  assert.match(run.stdout, /输入已变化/);
  assert.match(run.stdout, /package\.json/);
  assert.match(run.stdout, /恢复动作/, "FAIL 输出必须带恢复动作");
});

test("值漂移：输入未变但手改快照命令字段 → 报「不一致（疑似手改）」", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--out", out]).status, 0);
  const snapshot = JSON.parse(readFileSync(out, "utf8"));
  snapshot.commands[0].command.program = "deno";
  writeJson(out, snapshot);
  const run = runCli(["--project-root", root, "--out", out, "--check"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /不一致/);
  assert.match(run.stdout, /手改/);
});

test("结构无执行证据字段：合法快照不含 probe/status 类字段；注入执行语义键被白名单校验拒绝", () => {
  const root = makeFixture();
  cleanup.push(root);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--out", out]).status, 0);
  // grep 断言：整个快照文本不含执行证据字段名（§5.1 规则 1 / §7.1 第 1 条）
  const text = readFileSync(out, "utf8");
  assert.doesNotMatch(text, /"(probe[^"]*|[^"]*status[^"]*|executed|exitCode|lastRun|passed|verified|evidence[^"]*)"\s*:/);

  // 白名单校验：结构是封闭集合，执行语义键（含黑名单词形覆盖不到的 didPass/success/outcome）一律拒绝
  const tamperedPath = join(root, "tampered.json");
  const tampered = JSON.parse(text);
  tampered.success = true;
  tampered.commands[0].probe = { status: "passed" };
  tampered.commands[0].didPass = true;
  tampered.verificationAssets = [{ outcome: "verified", id: "x" }];
  writeJson(tamperedPath, tampered);
  const run = runCli(["--validate", tamperedPath]);
  assert.equal(run.status, 1, "含执行语义键的快照不得通过校验");
  assert.match(run.stdout, /未知键/);
  assert.match(run.stdout, /success/);
  assert.match(run.stdout, /didPass/);
  assert.match(run.stdout, /outcome/);
});

test("内嵌寻址探针与单源逐字节一致（parity 防漂移）", async () => {
  // 单源 = workflows/src/skill-data.shared.ts 的 NODE_PROJECT_ADDRESS；本脚本为独立技能脚本
  //（不经构建器注入），按 skill-data-addressing.md 并入约定内嵌同款 + 注明来源，测试守住字节一致
  const src = readFileSync(SKILL_DATA_SRC, "utf8");
  const match = src.match(/^const NODE_PROJECT_ADDRESS = "((?:[^"\\]|\\.)*)";$/m);
  assert.ok(match, "单源 NODE_PROJECT_ADDRESS 应为单行字符串常量（parity 按行提取依赖该形态）");
  const mod = await import(SCRIPT);
  assert.equal(mod.NODE_PROJECT_ADDRESS, match[1]);
});

test("缺省输出路径 = skill-data 寻址段 dev-flow 段；同输入两次探测除 observedAt 外一致", () => {
  const root = makeFixture();
  cleanup.push(root);
  const fakeHome = mkdtempSync(join(tmpdir(), "projcap-home-"));
  cleanup.push(fakeHome);
  // 单仓形态（临时目录非 git 仓）：slug = basename + '-' + sha256(realpath)[:8]
  //（寻址探针第一步 realpath；macOS 临时目录在 /private/var 下带 symlink 前缀，两侧必须同基）
  const realRoot = realpathSync(root);
  const slug = `${realRoot.split("/").filter(Boolean).pop()}-${createHash("sha256").update(realRoot).digest("hex").slice(0, 8)}`;
  const expected = join(fakeHome, ".agents", "skill-data", "dev-flow", slug, "project-capabilities.json");
  assert.equal(existsSync(expected), false, "前置：缺省路径尚未落盘");
  const run = runCli(["--project-root", root], fakeHome);
  assert.equal(run.status, 0, `缺省路径探测应零退出：${run.stderr}`);
  assert.equal(existsSync(expected), true, "缺省输出应落在 dev-flow 寻址段 <slug>/project-capabilities.json");

  // 同输入重探测：除观测元数据 observedAt 外逐字节一致（--check 值比对的前提）
  const first = JSON.parse(readFileSync(expected, "utf8"));
  const second = JSON.parse(runCli(["--project-root", root], fakeHome).stdout);
  assert.notEqual(first.observedAt, undefined);
  first.observedAt = null;
  second.observedAt = null;
  assert.deepEqual(second, first);
  assert.equal(homedir() !== fakeHome, true, "用例前提：fakeHome 是重定向 HOME，真实 skill-data 未被写入");
});

test("md 场景清单：整体登记为 scenario-manifest 资产（哈希字段实测非 undefined）", () => {
  const root = makeFixture();
  cleanup.push(root);
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：`zz-fixture-verify`。\n");
  const skillsRoot = mkdtempSync(join(tmpdir(), "projcap-skills-"));
  cleanup.push(skillsRoot);
  const skillDir = join(skillsRoot, "zz-fixture-verify");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# fixture verification skill\n");
  const manifestBody = "# 场景清单\n\n- p0-login：登录场景（cases/login.md）\n";
  writeFileSync(join(skillDir, "references", "scenarios.md"), manifestBody);
  const run = runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", join(root, "snap.json")]);
  assert.equal(run.status, 0, `应零退出：${run.stderr}`);
  const snapshot = JSON.parse(run.stdout);
  assert.deepEqual(snapshot.unknowns, []);
  assert.deepEqual(snapshot.verificationAssets, [
    {
      id: "scenarios",
      kind: "scenario-manifest",
      path: join(skillDir, "references", "scenarios.md"),
      sha256: createHash("sha256").update(manifestBody).digest("hex"),
      source: { kind: "verification-skill-declaration", ref: "AGENTS.md:zz-fixture-verify" },
    },
  ]);
});

test("负向声明只在整行无 token 时成立：括注含负向词技能仍被登记；无 token 声明行记 unknown", () => {
  const root = makeFixture();
  cleanup.push(root);
  const skillsRoot = makeFakeVerificationSkill();
  cleanup.push(skillsRoot);
  // 声明行带「不使用 watch 模式」括注：负向词不成立（行内有 token），技能照常登记
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：`zz-fixture-verify`（不使用 watch 模式，场景清单见该技能场景库）。\n");
  const run = runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", join(root, "snap.json")]);
  assert.equal(run.status, 0, `应零退出：${run.stderr}`);
  const snapshot = JSON.parse(run.stdout);
  assert.deepEqual(snapshot.unknowns, []);
  assert.equal(snapshot.verificationAssets.length, 1, "括注含负向词不得静默丢声明——技能应被登记");

  // 声明行无反引号 token（负向词也不在）：声明存在但无可定位名称 → unknown，不静默丢
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：verification skill 是 zz-fixture-plain-mention。\n");
  const run2 = runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", join(root, "snap2.json")]);
  assert.equal(run2.status, 0);
  const snapshot2 = JSON.parse(run2.stdout);
  assert.equal(snapshot2.verificationAssets.length, 0);
  assert.equal(snapshot2.unknowns.length, 1);
  assert.match(snapshot2.unknowns[0], /无可定位的技能名或清单路径/);
});

test("code-unit 排序：乱序 scripts 键按码元序登记（Beta 在 alpha 前）", () => {
  const root = makeFixture();
  cleanup.push(root);
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：本项目未声明 verification skill。\n");
  rmSync(join(root, "vitest.config.ts"));
  // 键序故意乱放 + 大小写混排：localeCompare（ICU）会把 alpha 排在 Beta 前，码元序相反
  writeJson(join(root, "package.json"), { name: "fixture", scripts: { zeta: "echo z", alpha: "echo a", Beta: "echo b" } });
  const run = runCli(["--project-root", root, "--out", join(root, "snap.json")]);
  assert.equal(run.status, 0, `应零退出：${run.stderr}`);
  const snapshot = JSON.parse(run.stdout);
  assert.deepEqual(snapshot.commands.map((command) => command.id), ["script.Beta", "script.alpha", "script.zeta"], "命令 id 必须按 code-unit 序（跨 ICU 环境确定性）");
});

test("悬空 flag：--out 无取值 → 用法错误 exit 2，不静默落缺省路径", () => {
  const root = makeFixture();
  cleanup.push(root);
  const run = runCli(["--project-root", root, "--out"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /缺取值/);
  const run2 = runCli(["--validate"]);
  assert.equal(run2.status, 2);
  assert.match(run2.stderr, /缺取值/);
});

test("场景文件失效：改场景文件内容后 --check 报「输入已变化」", () => {
  const root = makeFixture();
  cleanup.push(root);
  writeFileSync(join(root, "AGENTS.md"), "**verification skill 声明**：`zz-fixture-verify`。\n");
  const skillsRoot = makeFakeVerificationSkill();
  cleanup.push(skillsRoot);
  const out = join(root, "snap.json");
  assert.equal(runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", out]).status, 0);
  const scenarioFile = join(skillsRoot, "zz-fixture-verify", "cases", "login.md");
  writeFileSync(scenarioFile, "step: login v2\n");
  const run = runCli(["--project-root", root, "--skills-root", skillsRoot, "--out", out, "--check"]);
  assert.equal(run.status, 1, "场景文件是被消费来源，变化必须判输入已变化");
  assert.match(run.stdout, /输入已变化/);
  assert.match(run.stdout, /login\.md/);
});

test("用法错误退出码 2；--project-root 不存在退出码 1", () => {
  const noArgs = runCli([]);
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /用法错误/);
  assert.equal(runCli(["--project-root", join(tmpdir(), "projcap-not-exist-xyz")]).status, 1);
});
