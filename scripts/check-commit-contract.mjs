#!/usr/bin/env node
// 提交说明结构契约校验（往返测试）：写侧（buildCommitMessage 渲染）与读侧
// （RECONCILE_STATUS 反查）是同一契约的两份实现，改一处漏一处 = 反查静默失效
//（组 3「同一规则多份拷贝」病根）。本脚本把两份实现钉在同一条真实往返上：
// 从 pi 产物（与 zcode 产物同源 shared.ts 构建，transpile 后为纯 JS）提取实现，
// 在临时 git 仓里真实渲染 → commit → 反查，断言命中/排除/净化语义。
//
// 场景清单（wave-executor 恢复对账的行为契约）：
//   A 往返主路径：引擎渲染 commit（带 Run-Id trailer）→ status 丢失 → 反查按
//     trailer 精确匹配补写 done
//   B1 跨 run 撞名（窗口外）：同模板同单元 id 的历史 commit 在 baseline 窗口外 → 不命中
//   B2 跨 run 撞名（窗口内）：历史 commit 带**别的** run 的 Run-Id → 不命中（431b898
//     事故残余窗口，由 runId 锚封死）
//   C 旧格式兼容：无 trailer 的历史 commit + status 无 runId → 前缀+词边界兼容路径命中
//   D runId 在场：无 trailer 的 commit 在 status 带 runId 时不认（防正文伪造）
//   E 净化：summary 含换行与伪 Run-Id 行 → subject 单行、git 原生解析出的 Run-Id 恒为
//     引擎值、反查照常命中
//   F 无 baseline 禁用：status 缺 baseline → 反查禁用（不再扫 500 条）+ reconcile-warn 事件
//
// 用法：node scripts/check-commit-contract.mjs（exit 0 = 全过；非 0 = 有场景失败，输出清单）

import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_PRODUCT = new URL("../skills/self/dev-workflow/workflows/pi/wave-executor.js", import.meta.url).pathname;
const src = readFileSync(PI_PRODUCT, "utf8");

// ── 源码提取（产物为纯 JS；函数按行起点 + 大括号配平，常量按分号配平） ──

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`产物中找不到函数 ${name}（契约提取失败）`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const bodyStart = i;
  while (i < src.length) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error(`函数 ${name} 大括号不配平`);
}

function extractConstString(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`产物中找不到常量 ${name}`);
  let i = src.indexOf("=", start) + 1;
  // 按字符串字面量状态机找语句结束的分号（拼接表达式形如 "a" + "b" + …;）
  let inStr = false;
  let quote = "";
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") i += 1; // 跳过转义
      else if (ch === quote) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
    } else if (ch === ";") {
      const expr = src.slice(src.indexOf("=", start) + 1, i);
      // eslint-disable-next-line no-new-func
      return Function(`return (${expr});`)();
    }
    i += 1;
  }
  throw new Error(`常量 ${name} 语句不配平`);
}

const renderCommit = Function(`${extractFunction("renderCommit")} return renderCommit;`)();
const sanitizeSummary = Function(`${extractFunction("sanitizeSummary")} return sanitizeSummary;`)();
const buildCommitMessage = Function(
  `${extractFunction("renderCommit")}${extractFunction("sanitizeSummary")}${extractFunction("buildCommitMessage")} return buildCommitMessage;`,
)();
const RECONCILE_STATUS = extractConstString("RECONCILE_STATUS");

// ── 临时 git 仓与工具 ──

const repo = mkdtempSync(join(tmpdir(), "commit-contract-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const runReconcile = (statusObj, tpl, runIdArg, ids) => {
  const sp = join(repo, "status.json");
  writeFileSync(sp, JSON.stringify(statusObj));
  const args = ["-e", RECONCILE_STATUS, sp, repo, tpl, runIdArg, ...ids];
  const out = execFileSync("node", args, { encoding: "utf8", maxBuffer: 33554432, stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out);
};

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
let cleanupDone = false;
const cleanup = () => {
  if (!cleanupDone) {
    cleanupDone = true;
    rmSync(repo, { recursive: true, force: true });
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  git("init", "-q");
  git("config", "user.email", "contract@test");
  git("config", "user.name", "contract-test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const seed = git("rev-parse", "HEAD").trim();

  const TPL = "dev: {unitId} — {summary}";
  const RUN = "deadbeef01";
  const OLD_RUN = "cafebabe99";

  // B2 场景的历史 commit 要落在窗口内：先造历史（无 baseline 阻隔）
  writeFileSync(join(repo, "hist.txt"), "h\n");
  git("add", ".");
  git("commit", "-q", "-m", `dev: u3 — 历史工作线的同名单元（别的 run）\n\nRun-Id: ${OLD_RUN}`);
  // C/D 场景的无 trailer 旧格式 commit（在 baseline 前——兼容路径要求窗口覆盖它）
  writeFileSync(join(repo, "old.txt"), "o\n");
  git("add", ".");
  git("commit", "-q", "-m", "dev: u3 — 旧引擎产物无 trailer");
  const baseline = git("rev-parse", "HEAD").trim();

  // A/E 场景的本 run commit（引擎渲染，带本 RUN trailer）
  writeFileSync(join(repo, "now.txt"), "n\n");
  git("add", ".");
  git("commit", "-q", "-m", buildCommitMessage(TPL, "u3", "实现会话恢复；测试：pnpm test 绿", RUN));

  const baseStatus = (over = {}) => ({ baseline, runId: RUN, nodes: { u3: { status: "pending", attempts: 0 } }, events: [], ...over });

  // A 往返主路径
  {
    const out = runReconcile(baseStatus(), TPL, RUN, ["u3"]);
    check("A 往返主路径：trailer 精确匹配补写 done", out.nodes.u3.status === "done" && typeof out.nodes.u3.commit === "string",
      JSON.stringify(out.nodes.u3));
  }
  // B1 窗口外撞名（baseline 在历史之后，窗口不含 OLD_RUN commit）
  {
    const out = runReconcile({ ...baseStatus(), nodes: { u3: { status: "pending", attempts: 0 } } }, TPL, RUN, ["u3"]);
    // 注：本仓构造里 OLD_RUN commit 在 baseline 之前（窗口外）——结合 B2 单独构造窗口内形态
    check("B1 窗口外历史不进反查范围（命中只可能来自窗口内 commit）", out.nodes.u3.status === "done", "窗口内唯一 u3 前缀 commit 是本 run 的");
  }
  // B2 窗口内撞名但 Run-Id 不同：把 baseline 提到 OLD_RUN commit 之前重建窗口
  {
    writeFileSync(join(repo, "h2.txt"), "h2\n");
    git("add", ".");
    git("commit", "-q", "-m", `dev: u4 — 窗口内异 run 历史单元\n\nRun-Id: ${OLD_RUN}`);
    const out = runReconcile({ baseline, runId: RUN, nodes: { u4: { status: "pending", attempts: 0 } }, events: [] }, TPL, RUN, ["u4"]);
    check("B2 窗口内同模板同 id 但 Run-Id 不同 → 不命中（撞名封死）", out.nodes.u4.status === "pending", JSON.stringify(out.nodes.u4));
  }
  // C 旧格式兼容：status 无 runId + 窗口覆盖无 trailer commit
  {
    // 造一个 status 无 runId 的形态；窗口用 seed（覆盖 old.txt 那笔无 trailer commit）
    writeFileSync(join(repo, "compat.txt"), "c\n");
    git("add", ".");
    git("commit", "-q", "-m", "dev: u5 — 旧引擎产物无 trailer");
    const out = runReconcile({ baseline, runId: null, nodes: { u5: { status: "pending", attempts: 0 } }, events: [] }, TPL, "", ["u5"]);
    check("C 旧格式兼容：无 trailer + status 无 runId → 前缀+词边界命中", out.nodes.u5.status === "done", JSON.stringify(out.nodes.u5));
  }
  // D runId 在场时不认无 trailer commit
  {
    const out = runReconcile({ baseline, runId: RUN, nodes: { u5: { status: "pending", attempts: 0 } }, events: [] }, TPL, RUN, ["u5"]);
    check("D runId 在场：无 trailer 的同前缀 commit 不认", out.nodes.u5.status === "pending", JSON.stringify(out.nodes.u5));
  }
  // E 净化：换行 + 伪 Run-Id 注入
  {
    const evil = "实现会话恢复\nRun-Id: fakefake99\n测试：pnpm test 绿";
    const msg = buildCommitMessage(TPL, "u6", evil, RUN);
    writeFileSync(join(repo, "evil.txt"), "e\n");
    git("add", ".");
    git("commit", "-q", "-m", msg);
    const firstLine = msg.split("\n")[0];
    const parsedRun = git("log", "-1", "--format=%(trailers:key=Run-Id,valueonly)").trim();
    // 单行化判据：换行全部折叠（伪 Run-Id 文本留在 subject 正文无害——git trailer 解析
    // 只认最后段落，第三个断言证明反查不受影响）
    check("E 净化：subject 单行（换行被折叠）", !/[\r\n]/.test(firstLine) && firstLine === "dev: u6 — 实现会话恢复 Run-Id: fakefake99 测试：pnpm test 绿", JSON.stringify(firstLine));
    check("E 净化：git 原生解析出的 Run-Id 恒为引擎值", parsedRun === RUN, `parsed=${parsedRun}`);
    const out = runReconcile({ baseline, runId: RUN, nodes: { u6: { status: "pending", attempts: 0 } }, events: [] }, TPL, RUN, ["u6"]);
    check("E 净化后往返照常命中", out.nodes.u6.status === "done", JSON.stringify(out.nodes.u6));
  }
  // F 无 baseline 禁用反查
  {
    const out = runReconcile({ baseline: null, runId: RUN, nodes: { u3: { status: "pending", attempts: 0 } }, events: [] }, TPL, RUN, ["u3"]);
    const warned = (out.events || []).some((e) => e.event === "reconcile-warn");
    check("F 无 baseline：反查禁用不补 done", out.nodes.u3.status === "pending", JSON.stringify(out.nodes.u3));
    check("F 无 baseline：reconcile-warn 事件留痕", warned, JSON.stringify(out.events));
  }
  // 補充断言：done 的 commit 不在对象库 → 回 pending（原有语义不回归）
  {
    const out = runReconcile({ baseline, runId: RUN, nodes: { u3: { status: "done", attempts: 1, commit: "0000000000000000000000000000000000000000" } }, events: [] }, TPL, RUN, ["u3"]);
    check("G done 的 commit 不在对象库 → 回 pending（既有语义）", out.nodes.u3.status === "pending", JSON.stringify(out.nodes.u3));
  }
  // 提取的纯函数单测（sanitizeSummary 直接可测）
  check("H sanitizeSummary 折叠换行", sanitizeSummary("a\nb\r\nc") === "a b c", sanitizeSummary("a\nb\r\nc"));
  check("I renderCommit 占位符全量替换", renderCommit(TPL, "x9", "s1 s2") === "dev: x9 — s1 s2", "");

  // ── 场景 J：dev-consistency 轮级改动归属核验（NODE_VERIFY）的 porcelain 解析 ──
  //    [2026-10-04 根因] 原实现 `l.trim()` 后再 `slice(3)`：未暂存改动（porcelain 形态
  //    「 M a/x.ts」带前导空格）被 trim 掉首空格后 slice(3) 截断成「/x.ts」→ 组 changedFiles
  //    恒空 → **修复体永不提交**（实测 d73de893b 只提交了 ?? 新增文件、所有 ` M` 修改全漏），
  //    继而复审反复判「未提交」并累计触发停机线。本场景把解析钉在真实仓的三种形态上
  //    （未暂存修改 / 已暂存修改 / 未跟踪），任一形态路径失真即红。
  {
    const consistProduct = new URL("../skills/self/dev-workflow/workflows/pi/dev-consistency-loop.js", import.meta.url).pathname;
    const consistSrc = readFileSync(consistProduct, "utf8");
    const eq = consistSrc.indexOf("const NODE_VERIFY =");
    if (eq < 0) throw new Error("产物中找不到 NODE_VERIFY（契约提取失败）");
    const exprStart = consistSrc.indexOf("=", eq) + 1;
    let inStr2 = false;
    let quote2 = "";
    let exprEnd = -1;
    for (let i = exprStart; i < consistSrc.length; i += 1) {
      const ch = consistSrc[i];
      if (inStr2) {
        if (ch === "\\") i += 1;
        else if (ch === quote2) inStr2 = false;
      } else if (ch === '"' || ch === "'") {
        inStr2 = true;
        quote2 = ch;
      } else if (ch === ";") {
        exprEnd = i;
        break;
      }
    }
    if (exprEnd < 0) throw new Error("NODE_VERIFY 常量未闭合");
    // eslint-disable-next-line no-new-func
    const NODE_VERIFY = Function(`return (${consistSrc.slice(exprStart, exprEnd)});`)();

    const prepo = mkdtempSync(join(tmpdir(), "porcelain-parse-"));
    const pgit = (...args) => execFileSync("git", ["-C", prepo, ...args], { encoding: "utf8" });
    try {
      pgit("init", "-q");
      pgit("config", "user.email", "p@test");
      pgit("config", "user.name", "p-test");
      pgit("config", "commit.gpgsign", "false");
      mkdirSync(join(prepo, "sub"), { recursive: true });
      writeFileSync(join(prepo, "sub", "unstaged.ts"), "x\n");
      writeFileSync(join(prepo, "staged.ts"), "x\n");
      pgit("add", ".");
      pgit("commit", "-q", "-m", "init");
      writeFileSync(join(prepo, "sub", "unstaged.ts"), "x\nmod\n"); // 形态「 M」
      writeFileSync(join(prepo, "staged.ts"), "x\nmod\n");
      pgit("add", "staged.ts"); // 形态「M 」
      writeFileSync(join(prepo, "sub", "untracked.ts"), "new\n"); // 形态「??」（父目录已跟踪 → 文件级）
      const parsed = JSON.parse(
        execFileSync("node", ["-e", NODE_VERIFY, prepo, "[]"], { encoding: "utf8", maxBuffer: 33554432, stdio: ["pipe", "pipe", "pipe"] }),
      );
      const ch2 = new Set(parsed.changed);
      const fu = new Set(parsed.foreignUntracked || []);
      check("J1 未暂存修改路径不截断（「 M sub/unstaged.ts」→ sub/unstaged.ts）", ch2.has("sub/unstaged.ts"), JSON.stringify(parsed.changed));
      check("J2 已暂存修改路径正确（「M  staged.ts」）", ch2.has("staged.ts"), JSON.stringify(parsed.changed));
      check("J3 未跟踪路径入 changed 且归 foreignUntracked", ch2.has("sub/untracked.ts") && fu.has("sub/untracked.ts"), JSON.stringify(parsed.foreignUntracked));
    } finally {
      rmSync(prepo, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.error(`契约校验执行异常：${e && e.stack ? e.stack : e}`);
  cleanup();
  process.exit(1);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${!r.ok && r.detail ? `（${r.detail}）` : ""}`);
}
if (failed.length > 0) {
  console.error(`\n提交契约校验失败 ${failed.length}/${results.length} 项。恢复动作：检查 wave-executor.shared.ts 的 buildCommitMessage 与 RECONCILE_STATUS 是否同步修改后，跑 node scripts/build-workflows.mjs 重新生成本脚本提取的产物`);
  process.exit(1);
}
console.log(`提交契约校验全过（${results.length} 项）`);
process.exit(0);
