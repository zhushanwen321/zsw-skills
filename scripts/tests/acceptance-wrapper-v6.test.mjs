// D3 wrapper 生成器已知答案样例（设计《V6 三技能结构化交付优化》§7.3 首切片）。
// 钉住的契约：清单 schema（含键白名单）、wrapper 生成文本逐字（节点 / 命令 / 参数 / 头部哈希）、
// 输入哈希定义（测试侧独立复算，不 import 生成器实现）、确定性、--check 防手改（含孤立落点）、
// 语义缺口不生成（设计 §6.3 第 3 条：契约不明禁止猜参数）、wrapper 运行行为实跑。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATOR = join(REPO_ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "gen-acceptance-wrapper.mjs");

const NODE_ID = "verify-close-in-flight";
// compile.md §7 点名的四旗——fixture 用全量声明；空数组等变体在独立用例覆盖。
const FLAGS = ["--repo", "--artifacts-dir", "--name", "--run-id"];
const RUNNER_BODY = "#!/usr/bin/env node\nconsole.log('fixture runner');\n";
const SCENARIO_BODY = "// fixture scenario: close-with-in-flight\n";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

// 与生成器同判据的独立复算：对象键递归排序后序列化——键书写顺序非语义，不进哈希；
// 数组保留书写序（flags 的顺序归一在 descriptor 构造时单独排序，两侧行为一致）。
// 这里故意重新实现而非复用生成器内部函数：哈希定义是契约，测试钉住它，实现漂移即红灯。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "acc-wrapper-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "proj");
  mkdirSync(join(projectRoot, "scenarios"), { recursive: true });
  const runnerPath = join(projectRoot, "verification-runner.mjs");
  writeFileSync(runnerPath, RUNNER_BODY);
  const scenarioPath = join(projectRoot, "scenarios", "close-in-flight.mjs");
  writeFileSync(scenarioPath, SCENARIO_BODY);
  return { root, projectRoot, runnerPath, scenarioPath };
}

function artifactsDirOf(f) {
  return join(f.root, "acceptance", NODE_ID);
}

function buildManifest(f, overrides = {}) {
  return {
    schemaVersion: 1,
    projectRoot: f.projectRoot,
    assets: [
      {
        nodeId: NODE_ID,
        runner: { path: f.runnerPath, flags: FLAGS },
        scenario: { path: f.scenarioPath },
        artifactsDir: artifactsDirOf(f),
      },
    ],
    ...overrides,
  };
}

function writeManifest(f, manifest) {
  const path = join(f.root, "acceptance-assets.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function runGenerator(manifestPath, outDir, extraArgs = []) {
  return spawnSync(process.execPath, [GENERATOR, "--assets", manifestPath, "--out", outDir, ...extraArgs], {
    encoding: "utf8",
  });
}

function combinedOutput(r) {
  return `${r.stdout}\n${r.stderr}`;
}

// 期望哈希独立复算：descriptor 键集与键序无关（canonicalJson 排序），flags 排序归一（书写序
// 非语义），与生成器实现逐字段对齐（含 generatorVersion——版本升级走「输入已变化」通道）。
function expectedInputHash(manifest, f) {
  const descriptor = {
    schemaVersion: manifest.schemaVersion,
    generatorVersion: 1,
    projectRoot: manifest.projectRoot ?? null,
    asset: {
      ...manifest.assets[0],
      runner: { ...manifest.assets[0].runner, flags: [...manifest.assets[0].runner.flags].sort() },
    },
    runnerSha256: sha256File(f.runnerPath),
    scenarioSha256: sha256File(f.scenarioPath),
  };
  return sha256(canonicalJson(descriptor));
}

// 期望 wrapper 文本逐字构造（known-answer：生成模板被钉住，任何漂移红灯）。
// flags 参数化以覆盖空数组变体；输出顺序固定 = compile.md §7 四旗点名顺序。
function expectedWrapperText({ manifest, f, inputHash, generatorPath, outDir, flags }) {
  const runnerLiteral = JSON.stringify(f.runnerPath);
  const scenarioLiteral = JSON.stringify(f.scenarioPath);
  const manifestLiteral = join(f.root, "acceptance-assets.json");
  const L = [];
  L.push("// 由 gen-acceptance-wrapper.mjs 生成——D3 verify 节点 wrapper（L3 预编译剧本 runner 脚本）。");
  L.push("// 仅用于 verify 节点——review 节点的 script 三态语义里 exit 2 = 分析能力不足（派 reviewer），勿配作 machine-check。");
  L.push("// 禁止手改：手改会被 --check 判不一致，且 D0 重编译时被覆盖；语义修订回上游验收清单后重新生成。");
  L.push(`// 输入清单：${manifestLiteral}`);
  L.push(`// 输入哈希（sha256）：${inputHash}`);
  L.push("// 生成器版本：1");
  L.push(`// 重新生成：node ${generatorPath} --assets ${manifestLiteral} --out ${outDir}`);
  L.push("");
  L.push('import { mkdirSync } from "node:fs";');
  L.push('import { spawnSync } from "node:child_process";');
  L.push("");
  L.push("// runner 调用契约来自验收清单的显式声明，参数生成期全部写死——引擎与剧本进程之间只有 script 路径一个通道");
  L.push("//（node <script> 直跑、无参数、无 per-node env），runner 参数只能进本文件（compile.md §7）。");
  L.push(`const artifactsDir = ${JSON.stringify(artifactsDirOf(f))};`);
  L.push("const args = [");
  L.push(`  ${runnerLiteral},`);
  L.push(`  ${scenarioLiteral},`);
  L.push("];");
  for (const flag of ["--repo", "--artifacts-dir", "--name", "--run-id"]) {
    if (!flags.includes(flag)) continue;
    if (flag === "--repo") L.push(`args.push("--repo", ${JSON.stringify(manifest.projectRoot)});`);
    else if (flag === "--artifacts-dir") L.push('args.push("--artifacts-dir", artifactsDir);');
    else if (flag === "--name") L.push(`args.push("--name", ${JSON.stringify(`verify-${NODE_ID}`)});`);
    else if (flag === "--run-id") {
      L.push("// --run-id 隔离值在 wrapper 执行时现算——runner 默认 runId 是秒级时间戳，同秒并发会共享");
      L.push("// 数据目录；时间戳属运行时值，不写进生成文本（同输入重新生成须字节一致，设计 §4 第 1 条）。");
      L.push(`args.push("--run-id", ${JSON.stringify(NODE_ID)} + "-" + Date.now().toString(10));`);
    }
  }
  L.push("");
  L.push("// 引擎对 verify 节点强制 exit 0 后 artifactsDir 存在且从不自建——wrapper 先建目录兜底：");
  L.push("// flags 未声明 --artifacts-dir 时 runner 收不到该路径，目录只能由 wrapper 创建（已存在时幂等无害）。");
  L.push("mkdirSync(artifactsDir, { recursive: true });");
  L.push("");
  L.push('const run = spawnSync(process.execPath, args, { stdio: "inherit" });');
  L.push("if (run.error) {");
  L.push(`  console.error("[verify wrapper] runner 启动失败：" + run.error.message + "（runner：" + ${runnerLiteral} + "）");`);
  L.push("}");
  L.push("process.exit(run.status ?? 1);");
  L.push("");
  return L.join("\n");
}

test("明确契约 → 生成内容逐字断言（文件名 / runner 命令 / 四旗参数 / 头部哈希）", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");

  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 0, `生成应成功：${combinedOutput(r)}`);

  const file = join(outDir, `${NODE_ID}.mjs`);
  assert.ok(existsSync(file), "wrapper 文件名 = <nodeId>.mjs，落 --out 目录");
  const text = readFileSync(file, "utf8");

  const inputHash = expectedInputHash(manifest, f);
  const expected = expectedWrapperText({
    manifest,
    f,
    inputHash,
    generatorPath: GENERATOR,
    outDir,
    flags: FLAGS,
  });
  assert.equal(text, expected, "生成内容与已知答案逐字一致（头部 / 命令 / 参数 / 哈希）");

  // 头部哈希 = 测试侧独立复算的输入哈希（清单结构 + 资产条目 + runner/剧本内容哈希 + 生成器版本）
  assert.match(text, new RegExp(`^// 输入哈希（sha256）：${inputHash}$`, "m"));
  // runner 命令逐项核对（spawnSync(process.execPath, args) 形态 + 四旗值）
  assert.ok(text.includes(`  ${JSON.stringify(f.runnerPath)},`), "args[0] = runner 绝对路径");
  assert.ok(text.includes(`  ${JSON.stringify(f.scenarioPath)},`), "args[1] = 剧本绝对路径");
  assert.ok(text.includes(`args.push("--repo", ${JSON.stringify(f.projectRoot)});`), "--repo = 清单 projectRoot");
  assert.ok(text.includes('args.push("--artifacts-dir", artifactsDir);'), "--artifacts-dir = wrapper 内 artifactsDir 常量");
  assert.ok(text.includes("mkdirSync(artifactsDir, { recursive: true });"), "spawn 前 wrapper 兜底创建 artifactsDir");
  assert.ok(text.includes(`args.push("--name", ${JSON.stringify(`verify-${NODE_ID}`)});`), "--name = verify-<nodeId>");
  assert.ok(text.includes(`args.push("--run-id", ${JSON.stringify(NODE_ID)} + "-" + Date.now().toString(10));`), "--run-id 执行时现算（时间戳不进生成文本）");
  // 生成产物必须可通过 node 语法检查（引擎 node <script> 直跑前的最低门槛，compile.md §7）
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `生成的 wrapper 须通过 node --check：${syntax.stderr}`);
});

test("确定性：两次生成与重复覆盖生成字节一致", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  const first = readFileSync(join(outDir, `${NODE_ID}.mjs`));

  // 同输入重复生成（D0 重编译覆盖路径）幂等。头部「重新生成」命令含 --out 落点，
  // 属调用参数而非语义输入——不同输出目录的产物字节本就不同，确定性只对同一调用成立。
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  assert.ok(first.equals(readFileSync(join(outDir, `${NODE_ID}.mjs`))), "重复覆盖生成不改变字节");
});

test("flags 空数组 = 显式契约「runner 不收 flag」→ 正常生成、实跑绿且 artifactsDir 由 wrapper 兜底创建", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets[0].runner.flags = [];
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "noflags.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 0, `显式空数组是合法契约：${combinedOutput(r)}`);
  const file = join(outDir, `${NODE_ID}.mjs`);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(`${JSON.stringify(f.runnerPath)},`), "runner 位置参数保留");
  assert.ok(text.includes(`${JSON.stringify(f.scenarioPath)},`), "剧本位置参数保留");
  assert.ok(!text.includes("args.push"), "未声明任何 flag 就不生成任何 args.push 行");

  // 引擎契约（wave-executor-v6 executeVerifyNode）：exit 0 后 artifactsDir 必须存在且引擎
  // 从不自建——flags=[] 时 runner 收不到该路径，目录只能由 wrapper 兜底创建
  const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
  assert.equal(run.status, 0, `wrapper 实跑应绿：${run.stderr}`);
  assert.ok(existsSync(artifactsDirOf(f)), "artifactsDir 已由 wrapper 创建");
  // 对已存在目录幂等无害：二次实跑仍绿
  const run2 = spawnSync(process.execPath, [file], { encoding: "utf8" });
  assert.equal(run2.status, 0, "artifactsDir 已存在时 wrapper 实跑仍绿");
});

test("--check：生成后原样核对 → exit 0 输出 PASS 且不写盘", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  const file = join(outDir, `${NODE_ID}.mjs`);
  const before = readFileSync(file);
  const mtimeBefore = statSync(file).mtimeMs;

  const r = runGenerator(manifestPath, outDir, ["--check"]);
  assert.equal(r.status, 0, `一致时 --check 应通过：${combinedOutput(r)}`);
  assert.ok(r.stdout.includes("PASS"), "成功主路径输出 PASS");
  assert.ok(readFileSync(file).equals(before), "内容未被重写");
  assert.equal(statSync(file).mtimeMs, mtimeBefore, "核对模式不写盘（mtime 不变）");
});

test("--check：wrapper 缺失报缺失，且核对模式不补写文件", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);

  // 删除 wrapper 后 --check 必须报缺失，且核对模式不补写文件（写盘是生成模式的职责）
  const file = join(outDir, `${NODE_ID}.mjs`);
  rmSync(file);
  const r = runGenerator(manifestPath, outDir, ["--check"]);
  assert.equal(r.status, 1, "wrapper 缺失时 --check 退出非零");
  assert.ok(combinedOutput(r).includes("wrapper 文件缺失"), "缺失要有明确指认");
  assert.ok(!existsSync(file), "--check 不写文件（缺失也保持缺失，恢复走重新生成命令）");
});

test("--check：抓住手改（输入哈希一致但正文被改）", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  const file = join(outDir, `${NODE_ID}.mjs`);
  writeFileSync(file, `${readFileSync(file, "utf8")}// 手改注入\n`);

  const r = runGenerator(manifestPath, outDir, ["--check"]);
  assert.equal(r.status, 1, "手改必须被 --check 抓住");
  const out = combinedOutput(r);
  assert.ok(out.includes("文件被手改"), "区分手改与输入变化");
  assert.ok(out.includes("权威源"), "错误消息含权威源指向（设计 §7 形态）");
  assert.ok(out.includes("重新生成：node"), "错误消息含重新生成命令（设计 §7 形态）");
});

test("--check：输入已变化（剧本内容改变 → 哈希失效）报输入变化而非手改", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);

  writeFileSync(f.scenarioPath, `${SCENARIO_BODY}// 剧本内容演进\n`);
  const r = runGenerator(manifestPath, outDir, ["--check"]);
  assert.equal(r.status, 1, "输入文件变化必须被 --check 抓住（按输入失效）");
  const out = combinedOutput(r);
  assert.ok(out.includes("输入已变化"), "按输入哈希区分：输入变化 ≠ 手改");
  assert.ok(out.includes("重新生成：node"), "恢复动作 = 重新生成命令");
});

test("契约不明（runner.flags 未声明）→ 语义缺口退出 1 且不生成任何文件", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  delete manifest.assets[0].runner.flags;
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "语义缺口退出码恒为 1");
  const out = combinedOutput(r);
  assert.ok(out.includes("语义缺口"), "输出语义缺口报告");
  assert.ok(out.includes("禁止猜参数"), "指明禁止猜参数（设计 §6.3 第 3 条）");
  assert.ok(out.includes("runner.flags 未显式声明"), "指认缺口字段");
  assert.ok(out.includes("权威源"), "含权威源指向");
  assert.ok(out.includes("恢复动作"), "含恢复动作");
  assert.ok(!existsSync(outDir), "生成中止：连输出目录都不创建（不产半成品）");
});

test("未建模 flag → 语义缺口（不建通用 runner 描述语言）", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets[0].runner.flags = [...FLAGS, "--headless"];
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "语义缺口退出码恒为 1");
  const out = combinedOutput(r);
  assert.ok(out.includes("未建模"), "指认未建模");
  assert.ok(out.includes("--headless"), "点名具体 flag");
  assert.ok(!existsSync(outDir), "不生成任何文件");
});

test("部分资产契约不明 → 全体不生成（不产半成品）", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets.push({
    nodeId: "verify-second",
    runner: { path: f.runnerPath }, // 缺 flags = 契约不明
    scenario: { path: f.scenarioPath },
    artifactsDir: join(f.root, "acceptance", "verify-second"),
  });
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "语义缺口退出码恒为 1");
  assert.ok(!existsSync(outDir), "一条缺口即全体中止，不出现部分生成的混合态");
  assert.ok(combinedOutput(r).includes("共 1 条"), "缺口计数准确");
});

test("资产缺失（runner / 剧本文件不存在）→ 报错含路径与恢复动作", (t) => {
  const f = makeFixture(t);
  const missingRunner = join(f.root, "nope", "runner.mjs");
  const manifest = buildManifest(f);
  manifest.assets[0].runner.path = missingRunner;
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "资产缺失退出码恒为 1");
  const out = combinedOutput(r);
  assert.ok(out.includes(missingRunner), "点名缺失路径");
  assert.ok(out.includes("不存在"), "指认缺失事实");
  assert.ok(out.includes("恢复动作"), "含恢复动作");
  assert.ok(!existsSync(outDir));

  const missingScenario = join(f.root, "nope", "scenario.mjs");
  const m2 = buildManifest(f);
  m2.assets[0].scenario.path = missingScenario;
  const p2 = writeManifest(f, m2);
  const r2 = runGenerator(p2, outDir);
  assert.equal(r2.status, 1, "剧本缺失同样退出 1");
  assert.ok(combinedOutput(r2).includes(missingScenario));
});

test("清单非法（JSON 语法错 / schemaVersion 不符 / assets 空）→ 语义缺口退出 1", (t) => {
  const f = makeFixture(t);
  const outDir = join(f.root, "task-x.verify");

  const badJson = join(f.root, "bad.json");
  writeFileSync(badJson, "{ not json");
  const r1 = runGenerator(badJson, outDir);
  assert.equal(r1.status, 1, "清单非法退出码恒为 1");
  assert.ok(combinedOutput(r1).includes("不是合法 JSON"));

  const wrongVersion = join(f.root, "wrong-version.json");
  writeFileSync(wrongVersion, JSON.stringify({ ...buildManifest(f), schemaVersion: 2 }));
  const r2 = runGenerator(wrongVersion, outDir);
  assert.equal(r2.status, 1, "未知 schemaVersion 同样退出 1");
  assert.ok(combinedOutput(r2).includes("schemaVersion"), "拒绝未知 schemaVersion（不在补丁版本静默改语义）");

  const emptyAssets = join(f.root, "empty-assets.json");
  writeFileSync(emptyAssets, JSON.stringify({ ...buildManifest(f), assets: [] }));
  const r3 = runGenerator(emptyAssets, outDir);
  assert.equal(r3.status, 1, "空 assets 同样退出 1");
  assert.ok(combinedOutput(r3).includes("非空数组"));
  assert.ok(!existsSync(outDir));
});

test("nodeId 重复 → 语义缺口（文件名 = <nodeId>.mjs，重复会互相覆盖）", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets.push({
    nodeId: NODE_ID,
    runner: { path: f.runnerPath, flags: [] },
    scenario: { path: f.scenarioPath },
    artifactsDir: artifactsDirOf(f),
  });
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "语义缺口退出码恒为 1");
  assert.ok(combinedOutput(r).includes("重复"), "指认 nodeId 重复");
  assert.ok(!existsSync(outDir));
});

test("wrapper 运行行为：flag 传参正确且退出码透传（引擎消费契约实跑核实）", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  // runner 把收到的 argv 落盘并以 3 退出——文本断言只证明「长得对」，这里证明「跑得对」
  const argvLog = join(f.root, "runner-argv.json");
  writeFileSync(
    f.runnerPath,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.exit(3);\n`,
  );
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  const run = spawnSync(process.execPath, [join(outDir, `${NODE_ID}.mjs`)], { encoding: "utf8" });
  assert.equal(run.status, 3, "wrapper 退出码 = runner 退出码（透传含非零）");
  const passed = JSON.parse(readFileSync(argvLog, "utf8"));
  assert.equal(passed[0], f.scenarioPath, "剧本位置参数第一位");
  assert.deepEqual(
    passed.slice(1, 7),
    ["--repo", f.projectRoot, "--artifacts-dir", artifactsDirOf(f), "--name", `verify-${NODE_ID}`],
    "四旗按 compile.md §7 点名顺序传值",
  );
  assert.match(passed[8], new RegExp(`^${NODE_ID}-\\d+$`), "--run-id = <nodeId>-<毫秒时间戳>（执行时现算）");

  // runner exit 0 → wrapper exit 0（引擎判绿的唯一通道）
  writeFileSync(f.runnerPath, "process.exit(0);\n");
  const run2 = spawnSync(process.execPath, [join(outDir, `${NODE_ID}.mjs`)], { encoding: "utf8" });
  assert.equal(run2.status, 0, "runner 绿则 wrapper 绿");
});

test("用法错误（缺 --out）→ 退出码 2 并输出用法", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const r = spawnSync(process.execPath, [GENERATOR, "--assets", manifestPath], { encoding: "utf8" });
  assert.equal(r.status, 2, "用法错误退出码 2（区别于语义缺口 / 比对不一致的 1）");
  assert.ok(combinedOutput(r).includes("用法"), "输出用法说明");
});

test("flags 书写顺序换序 → 哈希归一：重生成字节一致且 --check PASS（顺序非语义）", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  const first = readFileSync(join(outDir, `${NODE_ID}.mjs`));

  // 仅调换清单内 flags 书写顺序（集合语义不变）→ 哈希排序归一，核对须通过
  const reordered = buildManifest(f);
  reordered.assets[0].runner.flags = [...FLAGS].reverse();
  const reorderedPath = writeManifest(f, reordered);
  const check = runGenerator(reorderedPath, outDir, ["--check"]);
  assert.equal(check.status, 0, `换序后 --check 应 PASS（书写顺序非语义）：${combinedOutput(check)}`);
  // 覆盖生成字节一致（输出顺序固定为 compile.md §7 点名顺序，与清单书写序无关）
  assert.equal(runGenerator(reorderedPath, outDir).status, 0);
  assert.ok(first.equals(readFileSync(join(outDir, `${NODE_ID}.mjs`))), "换序重生成字节一致");
});

test("孤立 wrapper：--check 报不一致，重新生成清理清单外落点", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets.push({
    nodeId: "verify-second",
    runner: { path: f.runnerPath, flags: [] },
    scenario: { path: f.scenarioPath },
    artifactsDir: join(f.root, "acceptance", "verify-second"),
  });
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  assert.equal(runGenerator(manifestPath, outDir).status, 0);
  assert.ok(existsSync(join(outDir, "verify-second.mjs")));

  // 清单缩到单资产 → verify-second.mjs 成为清单外孤立落点
  const shrunkPath = writeManifest(f, buildManifest(f));
  const r = runGenerator(shrunkPath, outDir, ["--check"]);
  assert.equal(r.status, 1, "孤立 wrapper 属磁盘 ≠ 重生成结果，--check 退出非零");
  assert.ok(combinedOutput(r).includes("孤立"), "报告指认孤立落点");

  // 重新生成 = 落点与清单一致：清理孤立文件，保留清单内 wrapper
  assert.equal(runGenerator(shrunkPath, outDir).status, 0);
  assert.ok(!existsSync(join(outDir, "verify-second.mjs")), "生成模式清理陈旧 wrapper");
  assert.ok(existsSync(join(outDir, `${NODE_ID}.mjs`)), "清单内 wrapper 保留");
});

test("--help → 输出用法 + 清单契约 schema + 退出码约定，退出 0", (t) => {
  const r = spawnSync(process.execPath, [GENERATOR, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, "--help 退出 0（不落未知参数分支）");
  const out = combinedOutput(r);
  assert.ok(out.includes("--assets"), "含用法");
  assert.ok(out.includes("schemaVersion"), "含清单契约 schema");
  assert.ok(out.includes("退出码"), "含退出码约定");
});

test("nodeId 含路径分隔符 → 拒止（防路径穿越落盘）", (t) => {
  const f = makeFixture(t);
  const manifest = buildManifest(f);
  manifest.assets[0].nodeId = "verify/../evil";
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "非法 nodeId 退出码恒为 1");
  assert.ok(combinedOutput(r).includes("nodeId 缺失或形态非法"), "指认 nodeId 形态非法");
  assert.ok(!existsSync(outDir), "未创建输出目录");
  assert.ok(!existsSync(join(f.root, "evil.mjs")), "未发生路径穿越落盘");
});

test("多余字段拒止（顶层 / 资产条目键白名单，未知字段不静默进哈希）", (t) => {
  const f = makeFixture(t);
  const outDir = join(f.root, "task-x.verify");

  const topExtra = buildManifest(f);
  topExtra.extraTop = true;
  const r1 = runGenerator(writeManifest(f, topExtra), outDir);
  assert.equal(r1.status, 1, "顶层未知字段拒止");
  assert.ok(combinedOutput(r1).includes("extraTop"), "顶层未知字段被点名");

  const assetExtra = buildManifest(f);
  assetExtra.assets[0].note = "why not";
  const r2 = runGenerator(writeManifest(f, assetExtra), outDir);
  assert.equal(r2.status, 1, "资产条目未知字段拒止");
  assert.ok(combinedOutput(r2).includes("note"), "资产条目未知字段被点名");
  assert.ok(!existsSync(outDir), "不生成任何文件");
});

test("runner 扩展名非 node 脚本（.sh）→ 拒止", (t) => {
  const f = makeFixture(t);
  const shRunner = join(f.projectRoot, "runner.sh");
  writeFileSync(shRunner, "echo ok\n");
  const manifest = buildManifest(f);
  manifest.assets[0].runner.path = shRunner;
  const manifestPath = writeManifest(f, manifest);
  const outDir = join(f.root, "task-x.verify");
  const r = runGenerator(manifestPath, outDir);
  assert.equal(r.status, 1, "扩展名拒止退出码恒为 1");
  const out = combinedOutput(r);
  assert.ok(out.includes("node 脚本"), "指明 runner 必须是 node 脚本");
  assert.ok(!existsSync(outDir));
});

test("写盘失败 → 结构化报告退出 1（不裸栈轨迹）", (t) => {
  const f = makeFixture(t);
  const manifestPath = writeManifest(f, buildManifest(f));
  // --out 指向已存在的文件——目录创建必失败，触发写盘失败路径
  const outPath = join(f.root, "occupied");
  writeFileSync(outPath, "not a dir");
  const r = runGenerator(manifestPath, outPath);
  assert.equal(r.status, 1, "写盘失败退出 1");
  const out = combinedOutput(r);
  assert.ok(out.includes("写盘"), "指认写盘故障");
  assert.ok(out.includes("重新生成：node"), "含恢复动作");
  assert.ok(!out.includes("\n    at "), "不输出裸栈轨迹");
});
