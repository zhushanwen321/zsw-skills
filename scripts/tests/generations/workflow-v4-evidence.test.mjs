import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "independent-assurance-v4.shared.ts");
const CB_SOURCE = join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "candidate-build-v4.shared.ts");
const source = readFileSync(SOURCE, "utf8");
const cbSource = readFileSync(CB_SOURCE, "utf8");

function declaration(name, nextName, from = source) {
  const start = from.indexOf(`const ${name} =`);
  const end = from.indexOf(`const ${nextName} =`, start);
  assert.ok(start >= 0 && end > start, `${name} 声明应可提取`);
  return eval(from.slice(start, end).replace(new RegExp(`^const ${name} =`), ""));
}
function runNode(code, args) {
  return spawnSync(process.execPath, ["-e", code, ...args], { encoding: "utf8" });
}

test("证据报告写文件使用排他创建，第二次写入不覆盖", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "v4-evidence-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "report.md");
  const code = declaration("NODE_WRITE_FILE", "NODE_RUN_TEST");
  assert.equal(runNode(code, [path, "first"]).status, 0);
  const second = runNode(code, [path, "second"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), "first");
});

test("测试日志同样使用排他创建，重复路径不会覆盖旧日志", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "v4-evidence-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "increment.log");
  const code = declaration("NODE_RUN_TEST", "NODE_HASH_TREE");
  const first = runNode(code, [dir, path, process.execPath, JSON.stringify(["-e", "process.exit(0)"]), "300000"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).exitCode, 0);
  const second = runNode(code, [dir, path, process.execPath, JSON.stringify(["-e", "process.exit(0)"]), "300000"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
});

test("candidate-build 的失败产物写入同样排他创建，且报错含路径与递增序号恢复指引", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "v4-evidence-cb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "build-failure.md");
  const code = declaration("NODE_WRITE_FILE", "NODE_APPEND_FILE", cbSource);
  assert.equal(runNode(code, [path, "# first\n"]).status, 0, "首次写入应成功");
  const second = runNode(code, [path, "# second\n"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /排他创建拒绝覆盖/);
  assert.match(second.stderr, new RegExp(path.replaceAll("/", "\\/")), "报错应含已存在路径");
  assert.match(second.stderr, /-2/, "恢复指引应给出递增序号的新文件名建议");
  assert.equal(readFileSync(path, "utf8"), "# first\n");
});

test("candidate-build 的候选反例审查不再被 exploratoryReview 门控（对全部 schema 2 任务执行）", () => {
  // 门控回归锚点：cb 源码中不得再出现按 exploratoryReview 风险字段包裹候选探索的条件
  assert.ok(!cbSource.includes('exploratoryReview === "required"'), "候选探索不得按 exploratoryReview=required 门控");
  assert.ok(cbSource.includes('if (acceptanceDoc?.schemaVersion === 2) {'), "候选探索应仅按 schema 2 判定");
});
