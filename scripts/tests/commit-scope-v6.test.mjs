// commit-scope-v6.test.mjs — 提交前仓外路径检查器已知答案样例
// （V5 交付完整性改造设计 §9.2 仓外提交样例 / §11 路线 A 第 4 条）
//
// 被测实现：skills/self/dev-workflow/dev-flow-v6/scripts/check-commit-scope.mjs
//
// 用例：干净暂存区与正常路径 exit 0 / `..` 相对路径逃逸 FAIL / 仓外绝对路径 FAIL /
// symlink 指仓外 FAIL（文件 symlink、目录 symlink、staged symlink 三形态）/
// symlink 指仓内 PASS / staged 删除文件的路径也能检查 / 含空格与换行路径不误判 /
// rename 双路径解析 / 用法错误 exit 2 三段式 / 不同 cwd 调用结果一致（相对路径只按
// --repo-root 解析，cwd 参与即分歧）/ --paths 与 --staged 并集去重 / 无 HEAD 初始仓
// --staged（首提前暂存）/ darwin 大小写不敏感归一（linux 跳过）/ --help 冒烟。
//
// 隔离：临时 git 仓 fixture（git init + add + commit 最小构造）+ 独立临时仓外目录，
// 测试后删除，不触碰真实仓库。
//
// 运行：node --test scripts/tests/commit-scope-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "dev-flow-v6", "scripts", "check-commit-scope.mjs");

// ── fixture 基座 ──

/** 临时 git 仓 + 独立仓外目录。仓内预置：src/in-repo.txt、a space.txt、we\nird.txt、
 *  sub/deep/（cwd 一致性用例的调用目录）；仓外预置 outside.txt。返回 run() 封装与常用路径。 */
function makeFixture(t) {
  const proj = mkdtempSync(join(tmpdir(), "commit-scope-proj-"));
  const outside = mkdtempSync(join(tmpdir(), "commit-scope-out-"));
  const git = (args) =>
    spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: proj, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0, "git init 失败");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "sub", "deep"), { recursive: true });
  writeFileSync(join(proj, "README.md"), "fixture\n");
  writeFileSync(join(proj, "src", "in-repo.txt"), "in\n");
  writeFileSync(join(proj, "a space.txt"), "sp\n");
  writeFileSync(join(proj, "we\nird.txt"), "nl\n");
  writeFileSync(join(outside, "outside.txt"), "out\n");
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
  const projReal = realpathSync(proj); // darwin 的 /var/folders 含 symlink 组件，期望值统一按真实形态算
  const run = (args, cwd = proj) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  const fails = (r) => r.stdout.split("\n").filter((l) => l.startsWith("FAIL:"));
  t.after(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  return { proj, projReal, outside, git, run, fails };
}

// ── 用例 ──

test("干净暂存区与仓内正常路径 exit 0", (t) => {
  const f = makeFixture(t);
  const staged = f.run(["--repo-root", f.projReal, "--staged"]);
  assert.equal(staged.status, 0, `干净暂存区应 PASS：${staged.stdout}${staged.stderr}`);
  assert.ok(staged.stdout.trim().startsWith("PASS:"), "干净输出应为单行 PASS 结论");
  const paths = f.run(["--repo-root", f.projReal, "--paths", join(f.projReal, "src/in-repo.txt"), "a space.txt"]);
  assert.equal(paths.status, 0, `仓内路径应 PASS：${paths.stdout}${paths.stderr}`);
});

test("`..` 相对路径逃逸 FAIL（相对路径逃逸）", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--repo-root", f.projReal, "--paths", "../outside.txt"]);
  assert.equal(r.status, 1, `逃逸应 FAIL：${r.stdout}${r.stderr}`);
  const lines = f.fails(r);
  assert.equal(lines.length, 1, `应恰好一条 FAIL：${r.stdout}`);
  assert.ok(lines[0].includes("相对路径逃逸"), `类型应为相对路径逃逸：${lines[0]}`);
  // 期望落点 = 按 repo-root 解析（词法），与调用方 cwd 无关
  assert.ok(lines[0].includes(resolve(f.projReal, "../outside.txt")), `FAIL 行应含解析后落点：${lines[0]}`);
  assert.ok(r.stdout.includes("恢复动作"), "违例输出末尾应有恢复动作段");
});

test("仓外绝对路径 FAIL（仓外绝对路径）", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--repo-root", f.projReal, "--paths", join(f.outside, "outside.txt")]);
  assert.equal(r.status, 1, `仓外绝对路径应 FAIL：${r.stdout}${r.stderr}`);
  const lines = f.fails(r);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("仓外绝对路径"), `类型应为仓外绝对路径：${lines[0]}`);
});

test("symlink 指仓外 FAIL：文件 symlink / 目录 symlink / staged symlink", (t) => {
  const f = makeFixture(t);
  symlinkSync(join(f.outside, "outside.txt"), join(f.proj, "link-out.txt"));
  symlinkSync(f.outside, join(f.proj, "link-out-dir"));
  // 形态一：symlink 文件本身（真实落点在仓外）
  const file = f.run(["--repo-root", f.projReal, "--paths", "link-out.txt"]);
  assert.equal(file.status, 1, `symlink 文件应 FAIL：${file.stdout}${file.stderr}`);
  const fileLine = f.fails(file)[0];
  assert.ok(fileLine.includes("symlink 逃逸"), `类型应为 symlink 逃逸：${fileLine}`);
  assert.ok(fileLine.includes(join(f.outside, "outside.txt")), `FAIL 行应含真实落点：${fileLine}`);
  // 形态二：目录 symlink 下的文件（祖先组件 symlink）
  const dir = f.run(["--repo-root", f.projReal, "--paths", join(f.outside, "outside.txt"), "link-out-dir/nested.txt"]);
  // nested.txt 在仓外目录里不存在：目录 symlink 祖先已逃逸即可判 FAIL（最长存在祖先解析）
  assert.equal(dir.status, 1, `目录 symlink 祖先应 FAIL：${dir.stdout}${dir.stderr}`);
  assert.ok(
    f.fails(dir).some((l) => l.includes("symlink 逃逸")),
    `nested.txt 应经祖先 symlink 判逃逸：${dir.stdout}`,
  );
  // 形态三：staged symlink——git 暂存的是路径名（仓内），检查器须复核磁盘真实落点
  assert.equal(f.git(["add", "link-out.txt"]).status, 0);
  const staged = f.run(["--repo-root", f.projReal, "--staged"]);
  assert.equal(staged.status, 1, `staged symlink 应 FAIL：${staged.stdout}${staged.stderr}`);
  assert.ok(
    f.fails(staged).some((l) => l.includes("symlink 逃逸") && l.includes("link-out.txt")),
    `--staged 应对暂存路径做 symlink 复核：${staged.stdout}`,
  );
});

test("symlink 指仓内 PASS", (t) => {
  const f = makeFixture(t);
  symlinkSync("src", join(f.proj, "link-in")); // 相对目标的目录 symlink，指仓内
  const r = f.run(["--repo-root", f.projReal, "--paths", join(f.projReal, "link-in/in-repo.txt")]);
  assert.equal(r.status, 0, `指仓内 symlink 应 PASS：${r.stdout}${r.stderr}`);
});

test("staged 删除文件的路径也能检查（不存在 → 词法判定）", (t) => {
  const f = makeFixture(t);
  assert.equal(f.git(["rm", "-q", "src/in-repo.txt"]).status, 0, "git rm 失败");
  // 删除后文件不在盘上，路径在仓内 → 词法判定放行，不因不存在而报错或漏查
  const staged = f.run(["--repo-root", f.projReal, "--staged"]);
  assert.equal(staged.status, 0, `staged 删除路径应 PASS：${staged.stdout}${staged.stderr}`);
  assert.ok(staged.stdout.includes("暂存区 1"), `PASS 行应统计到删除路径：${staged.stdout}`);
  // 同一路径显式传入同样放行
  const explicit = f.run(["--repo-root", f.projReal, "--paths", "src/in-repo.txt"]);
  assert.equal(explicit.status, 0);
});

test("含空格与换行路径不误判（-z 解析不裂项）", (t) => {
  const f = makeFixture(t);
  const staged = f.run(["--repo-root", f.projReal, "--staged"]);
  // 首提后暂存区干净；重新暂存一个未提交的含空格文件，验证 NUL 分隔解析
  writeFileSync(join(f.proj, "b c.txt"), "x\n");
  assert.equal(f.git(["add", "b c.txt"]).status, 0);
  const r = f.run(["--repo-root", f.projReal, "--staged"]);
  assert.equal(r.status, 0, `含空格路径应正常解析并 PASS：${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes("暂存区 1"), `应统计到 1 条暂存路径：${r.stdout}`);
  // 换行路径经 --paths 词法判定放行（realpath 对含换行路径同样成立）
  const nl = f.run(["--repo-root", f.projReal, "--paths", "we\nird.txt"]);
  assert.equal(nl.status, 0, `含换行路径应 PASS：${nl.stdout}${nl.stderr}`);
});

test("rename 暂存输出新路径且解析不裂（-z NUL 分隔）", (t) => {
  const f = makeFixture(t);
  assert.equal(f.git(["mv", "README.md", "docs.md"]).status, 0, "git mv 失败");
  assert.equal(f.git(["add", "-A"]).status, 0);
  const r = f.run(["--repo-root", f.projReal, "--staged"]);
  assert.equal(r.status, 0, `rename 应解析且 PASS：${r.stdout}${r.stderr}`);
  // 实测：默认 rename 检测下 --name-only -z 只输出新路径一条（旧路径是删除侧，
  // 不在待提交集内；脚本头注同款口径）
  assert.ok(r.stdout.includes("暂存区 1"), `-z 下 rename 应输出新路径一条：${r.stdout}`);
});

test("用法错误 exit 2 + stderr 三段式", (t) => {
  const f = makeFixture(t);
  const cases = [
    { name: "无参数", args: [] },
    { name: "只有 --repo-root（无检查对象）", args: ["--repo-root", f.projReal] },
    { name: "未知参数", args: ["--repo-root", f.projReal, "--staged", "--foo"] },
    { name: "--repo-root 相对路径", args: ["--repo-root", "some/rel", "--staged"] },
    { name: "--repo-root 不存在", args: ["--repo-root", join(f.projReal, "no-such-dir"), "--staged"] },
    { name: "--paths 后无值", args: ["--repo-root", f.projReal, "--paths"] },
    { name: "--repo-root 后无值", args: ["--repo-root"] },
  ];
  for (const c of cases) {
    const r = f.run(c.args);
    assert.equal(r.status, 2, `${c.name} 应 exit 2：${r.stdout}${r.stderr}`);
    // 三段式：什么不合法 → 权威源 → 恢复动作
    assert.ok(r.stderr.includes("用法错误"), `${c.name} stderr 缺「用法错误」段：${r.stderr}`);
    assert.ok(r.stderr.includes("权威源"), `${c.name} stderr 缺「权威源」段：${r.stderr}`);
    assert.ok(r.stderr.includes("恢复动作"), `${c.name} stderr 缺「恢复动作」段：${r.stderr}`);
    assert.ok(r.stderr.includes("--repo-root <仓库根绝对路径>"), `${c.name} 恢复动作应含完整用法行：${r.stderr}`);
  }
});

test("不同 cwd 调用结果一致（相对路径只按 --repo-root 解析）", (t) => {
  const f = makeFixture(t);
  // cwd = repo-root 直下子目录（sub/deep）：同一串相对路径若按 cwd 解析会落在仓内
  // （sub/deep/../../escape.txt = proj/escape.txt），按 --repo-root 解析则落在仓外——
  // 两种实现在此分歧，断言 FAIL 且落点等于按 repo-root 的词法解析结果
  const deep = join(f.proj, "sub", "deep");
  const fromRoot = f.run(["--repo-root", f.projReal, "--paths", "../../escape.txt"], f.projReal);
  const fromDeep = f.run(["--repo-root", f.projReal, "--paths", "../../escape.txt"], deep);
  assert.equal(fromRoot.status, 1);
  assert.equal(fromDeep.status, 1, `结果应与 cwd 无关：${fromDeep.stdout}${fromDeep.stderr}`);
  const expected = resolve(f.projReal, "../../escape.txt");
  assert.ok(
    f.fails(fromDeep)[0].includes(expected),
    `落点应按 --repo-root 解析（期望 ${expected}）：${f.fails(fromDeep)[0]}`,
  );
  // 正常路径在不同 cwd 下同样一致（脚本不读 cwd 参与解析）
  const okRoot = f.run(["--repo-root", f.projReal, "--paths", "src/in-repo.txt"], f.projReal);
  const okDeep = f.run(["--repo-root", f.projReal, "--paths", "src/in-repo.txt"], deep);
  assert.equal(okRoot.status, 0);
  assert.equal(okDeep.status, 0, `${okDeep.stdout}${okDeep.stderr}`);
});

test("--paths 与 --staged 并集去重", (t) => {
  const f = makeFixture(t);
  // 暂存区：含空格的仓内文件（不应误报）；显式：仓外绝对路径（应 FAIL）+ 与暂存区同落点的重复写法（去重）
  writeFileSync(join(f.proj, "staged-file.txt"), "x\n");
  assert.equal(f.git(["add", "staged-file.txt"]).status, 0);
  const dup = join(f.projReal, "staged-file.txt");
  const r = f.run([
    "--repo-root", f.projReal,
    "--staged",
    "--paths", join(f.outside, "outside.txt"), dup, "./staged-file.txt",
  ]);
  assert.equal(r.status, 1, `并集含仓外路径应 FAIL：${r.stdout}${r.stderr}`);
  const lines = f.fails(r);
  assert.equal(lines.length, 1, `同一落点应只报一次，仓内暂存路径不应误报：${r.stdout}`);
  assert.ok(lines[0].includes("仓外绝对路径"), `${lines[0]}`);
});

test("无 HEAD 初始仓 --staged（首提前暂存以空树为基准）", (t) => {
  const proj = mkdtempSync(join(tmpdir(), "commit-scope-init-"));
  t.after(() => rmSync(proj, { recursive: true, force: true }));
  const git = (args) =>
    spawnSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", ...args], { cwd: proj, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  writeFileSync(join(proj, "README.md"), "first\n");
  assert.equal(git(["add", "README.md"]).status, 0);
  const r = spawnSync(process.execPath, [SCRIPT, "--repo-root", realpathSync(proj), "--staged"], { encoding: "utf8" });
  assert.equal(r.status, 0, `首提前暂存应可检查且 PASS：${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes("暂存区 1"), `应统计到首提暂存路径：${r.stdout}`);
});

test("darwin 大小写不敏感：repo-root 与路径书写大小写与磁盘不一致不误判", { skip: process.platform !== "darwin" }, (t) => {
  const f = makeFixture(t);
  // repo-root 与路径书写大小写与磁盘不一致：darwin FS 不区分大小写，两种拼法指向同一目录，
  // 脚本 realpath 归一后判定基准不变、真实落点在仓内即放行
  const base = f.projReal.split("/").pop();
  const flipped = (base[0] === base[0].toUpperCase() ? base[0].toLowerCase() : base[0].toUpperCase()) + base.slice(1);
  const altRoot = join(dirname(f.projReal), flipped);
  const r = f.run(["--repo-root", altRoot, "--paths", join(altRoot, "SRC/IN-REPO.TXT")]);
  assert.equal(r.status, 0, `大小写误写应经 realpath 归一后 PASS：${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes(f.projReal), `PASS 行应输出归一后的真实 repo-root：${r.stdout}`);
});

test("--help 输出用途、参数、退出码与示例", (t) => {
  const f = makeFixture(t);
  const r = f.run(["--help"]);
  assert.equal(r.status, 0);
  for (const kw of ["--repo-root", "--staged", "--paths", "退出码", "示例", "恢复动作", "symlink"]) {
    assert.ok(r.stdout.includes(kw), `--help 应含「${kw}」：${r.stdout}`);
  }
  const h = f.run(["-h"]);
  assert.equal(h.status, 0);
});

test("运行错误 exit 3 三段式（--staged 在非 git 仓）", (t) => {
  const f = makeFixture(t);
  const plain = mkdtempSync(join(tmpdir(), "commit-scope-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const r = f.run(["--repo-root", realpathSync(plain), "--staged"]);
  assert.equal(r.status, 3, `非 git 仓应 exit 3：${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes("运行错误"), `stderr 缺「运行错误」段：${r.stderr}`);
  assert.ok(r.stderr.includes("权威源") && r.stderr.includes("恢复动作"), `三段式不完整：${r.stderr}`);
});

test("脚本无 npm 依赖可直跑（import 全部来自 node: 内建）", (t) => {
  const src = readFileSync(SCRIPT, "utf8");
  const imports = [...src.matchAll(/^import\s+(?:[^"']*?from\s+)?"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "应存在 import 语句（解析失效时显式失败）");
  for (const spec of imports) {
    assert.ok(spec.startsWith("node:"), `发现非内建依赖「${spec}」——本脚本须 Node 直跑零依赖`);
  }
});
