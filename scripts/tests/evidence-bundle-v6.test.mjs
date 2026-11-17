import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "gen-evidence-bundle.mjs");

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
}

/** D3 verify 节点 artifacts 目录形态：summary.jsonl + inspect verdict.json + 附属日志/截图/轨迹（compile.md「每步汇总落盘」）。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-v6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactsDir = join(root, "artifacts");
  mkdirSync(join(artifactsDir, "sub"), { recursive: true });
  writeFileSync(join(artifactsDir, "summary.jsonl"), '{"node":"v1","passed":2,"failed":0,"skipped":1,"exitCode":0}\n{"node":"v1","passed":3,"failed":0,"skipped":0,"exitCode":0}\n');
  writeFileSync(join(artifactsDir, "verdict.json"), '{"ok":true}');
  writeFileSync(join(artifactsDir, "run.log"), "run log line\n");
  writeFileSync(join(artifactsDir, "shot.png"), "PNGDATA");
  writeFileSync(join(artifactsDir, "sub", "trace.har"), "HARDATA");
  return { root, artifactsDir, bundlePath: join(artifactsDir, "evidence-bundle.json") };
}

test("build：sourceRecords 与 artifacts 逐文件哈希登记，附属按扩展名归类", (t) => {
  const fx = fixture(t);
  const result = run(["--artifacts-dir", fx.artifactsDir, "--summary", join(fx.artifactsDir, "summary.jsonl"), "--verdict", join(fx.artifactsDir, "verdict.json")]);
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(readFileSync(fx.bundlePath, "utf8"));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.generator.name, "gen-evidence-bundle");
  // sourceRecords：原始记录 path+sha256，kind 区分汇总与 inspect 判定（§5.3）
  assert.deepEqual(bundle.sourceRecords.map((entry) => entry.kind), ["summary", "inspect-verdict"]);
  for (const entry of bundle.sourceRecords) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.path, entry.kind === "summary" ? "summary.jsonl" : "verdict.json");
  }
  // artifacts：原始记录与 bundle 自身不重复登记；kind 按扩展名归类
  const byId = Object.fromEntries(bundle.artifacts.map((entry) => [entry.id, entry]));
  assert.equal(byId["log-1"].path, "run.log");
  assert.equal(byId["screenshot-1"].path, "shot.png");
  assert.equal(byId["trace-1"].path, join("sub", "trace.har"));
  assert.ok(!bundle.artifacts.some((entry) => entry.path.includes("summary.jsonl") || entry.path.includes("verdict.json")));
  // §5.3 红线：事件绑定字段（revision / 断言 / 反例绑定）与执行事实（steps / skipped / verdict）不进索引
  for (const field of ["revision", "assertionIds", "adversarialFormIds", "unitIds", "steps", "skipped", "verdict"]) {
    assert.ok(!Object.hasOwn(bundle, field), `bundle 顶层不得含禁字段 ${field}`);
  }
});

test("--check：一致 PASS；内容改动（哈希漂移）与文件删除逐条 FAIL（问题清单走 stderr），消息三段式", (t) => {
  const fx = fixture(t);
  const args = ["--artifacts-dir", fx.artifactsDir, "--summary", join(fx.artifactsDir, "summary.jsonl"), "--verdict", join(fx.artifactsDir, "verdict.json")];
  assert.equal(run(args).status, 0);
  let result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /PASS/);
  // 抓手改：附属文件内容被改 → 哈希漂移（问题清单走 stderr，stdout 不承载 FAIL）
  writeFileSync(join(fx.artifactsDir, "run.log"), "tampered\n");
  result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /哈希漂移/);
  assert.match(result.stderr, /权威源/);
  assert.match(result.stderr, /恢复/);
  // 文件缺失：引用文件被删 → 不一致
  unlinkSync(join(fx.artifactsDir, "shot.png"));
  result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /文件已缺失/);
});

test("--check 白名单 schema：顶层多余键与条目嵌套藏字段逐条 FAIL（禁字段给专门消息）", (t) => {
  const fx = fixture(t);
  const args = ["--artifacts-dir", fx.artifactsDir, "--summary", join(fx.artifactsDir, "summary.jsonl"), "--verdict", join(fx.artifactsDir, "verdict.json")];
  assert.equal(run(args).status, 0);
  // 顶层塞多余键（非禁字段的普通多余键）
  let bundle = JSON.parse(readFileSync(fx.bundlePath, "utf8"));
  bundle.extraKey = "whatever";
  writeFileSync(fx.bundlePath, JSON.stringify(bundle));
  let result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bundle 顶层 键集与白名单不一致/);
  assert.match(result.stderr, /多余键 extraKey/);
  // 嵌套藏字段：sourceRecords 条目塞 assertionIds（事件绑定不进内容索引的专门消息）
  bundle = JSON.parse(readFileSync(fx.bundlePath, "utf8"));
  delete bundle.extraKey;
  bundle.sourceRecords[0].assertionIds = ["AX1"];
  writeFileSync(fx.bundlePath, JSON.stringify(bundle));
  result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /含禁字段（事件绑定 \/ 执行事实不进内容索引）：assertionIds/);
  // 嵌套藏字段：artifacts 条目塞 revision
  bundle = JSON.parse(readFileSync(fx.bundlePath, "utf8"));
  delete bundle.sourceRecords[0].assertionIds;
  bundle.artifacts[0].revision = "abc123";
  writeFileSync(fx.bundlePath, JSON.stringify(bundle));
  result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /含禁字段（事件绑定 \/ 执行事实不进内容索引）：revision/);
});

test("build：--summary/--verdict 给定但文件不存在时「存在才登记」不报错；--check 对登记后缺失报不一致", (t) => {
  const fx = fixture(t);
  const missingVerdict = join(fx.root, "no-such", "verdict.json");
  let result = run(["--artifacts-dir", fx.artifactsDir, "--summary", join(fx.artifactsDir, "summary.jsonl"), "--verdict", missingVerdict]);
  assert.equal(result.status, 0, result.stderr);
  let bundle = JSON.parse(readFileSync(fx.bundlePath, "utf8"));
  assert.deepEqual(bundle.sourceRecords.map((entry) => entry.kind), ["summary"]);
  // 登记后文件被删（summary 登记的文件被清理）→ --check 报缺失（问题清单走 stderr）
  unlinkSync(join(fx.artifactsDir, "summary.jsonl"));
  result = run(["--artifacts-dir", fx.artifactsDir, "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /文件已缺失/);
});

test("纯命令场景：无 summary/verdict 时登记 receipt.jsonl 为原始回执，不生成第二份同语义回执", (t) => {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-v6-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactsDir = join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "receipt.jsonl"), '{"command":"pnpm test","exitCode":0}\n');
  writeFileSync(join(artifactsDir, "output.txt"), "stdout tail\n");
  const outPath = join(root, "bundle.json");
  const result = run(["--artifacts-dir", artifactsDir, "--out", outPath]);
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(readFileSync(outPath, "utf8"));
  // bundle 直接承载原始命令回执：receipt 登记为 sourceRecords（kind=command-receipt），其余文件进 artifacts
  assert.deepEqual(bundle.sourceRecords.map((entry) => entry.kind), ["command-receipt"]);
  assert.equal(bundle.sourceRecords[0].path, "receipt.jsonl");
  assert.ok(!bundle.artifacts.some((entry) => entry.path === "receipt.jsonl"));
  assert.deepEqual(bundle.artifacts.map((entry) => entry.path), ["output.txt"]);
  // 回执内容不被复制（不生成第二份同语义回执——只有 path+sha256 引用）
  assert.ok(!JSON.stringify(bundle).includes('"command":"pnpm test"'));
});

test("build：artifacts 目录不存在走三段式错误", (t) => {
  const result = run(["--artifacts-dir", "/nonexistent/dir"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /artifacts 目录不存在/);
  assert.match(result.stderr, /权威源/);
  assert.match(result.stderr, /恢复/);
});
