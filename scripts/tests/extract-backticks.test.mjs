// extract-backticks.test.mjs — T3 符号词表生成脚本的键形态归一 + --check 自验模式测试
//
// 覆盖（对应实现：skills/self/dev-workflow/symbol-watchlist/scripts/extract-backticks.mjs）：
//   1. 相对路径入参 → 指纹键为归一绝对路径且 sha256 与文件内容一致
//   2. ~/ 入参（HOME 指向临时目录）→ 读取与键都走 HOME 展开，键为绝对路径
//   3. 不存在的入参 → exit 1 且 stderr 指明归一后路径（替代旧 WARN + exit 0 静默跳过）
//   4. 双文件入参 → stdout 合法 JSON、sourceFingerprints 键数 == 输入数
//   5. 多形态入参同指一文件（相对 + 绝对）→ 撞键致键数 != 入参数，输出前自验 exit 1
//   6. --check 差分测试（防漂移机制）：从 design-code-sync-loop.shared.ts 源文本零转抄
//      提取 NODE_BACKTICK_GREP 探针（join 后 node -e 实跑，形态对齐引擎 world.run 调用），
//      与 --check 子模式对同一批 fixture 各拿判定，断言探针 ok:false ⟺ --check FAIL、
//      探针 ok:true ⟺ --check PASS——两侧校验集漂移在此被拦；指纹失败 fixture 另断言
//      探针 reason 按根因分路（键不可读 / 指纹过期 / 两段并发先不可读后过期）——
//      reason 归因文案漂移在此被拦
//
// 运行：node scripts/tests/extract-backticks.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "self",
  "dev-workflow",
  "symbol-watchlist",
  "scripts",
  "extract-backticks.mjs",
);

const FIXTURE_TEXT = "# 设计草稿\n\n核心符号 `exitPlanMode` 与 `u-foundation`。\n";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("相对路径入参 → 键为归一绝对路径且 sha256 正确", () => {
  const dir = makeTempDir("extract-bt-rel-");
  try {
    writeFileSync(join(dir, "doc.md"), FIXTURE_TEXT);
    // cwd = 临时目录：脚本对相对入参 path.resolve 归一，键须指向同一文件
    const r = spawnSync(process.execPath, [SCRIPT, "doc.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `exit ${r.status}，stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const expectedKey = join(realpathSync(dir), "doc.md"); // process.cwd() 返回物理路径
    assert.ok(Object.hasOwn(out.sourceFingerprints, expectedKey), `实际键: ${Object.keys(out.sourceFingerprints).join(", ")}`);
    assert.equal(out.sourceFingerprints[expectedKey], sha256(FIXTURE_TEXT));
    assert.ok(isAbsolute(Object.keys(out.sourceFingerprints)[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("~/ 入参 → HOME 展开为绝对路径键", () => {
  const home = makeTempDir("extract-bt-home-");
  try {
    writeFileSync(join(home, "doc.md"), FIXTURE_TEXT);
    // HOME 指向临时目录，~/ 入参须被展开后成功读取（旧实现对 ~/ 输入会 WARN + 跳过）
    const r = spawnSync(process.execPath, [SCRIPT, "~/doc.md"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0, `exit ${r.status}，stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const expectedKey = join(home, "doc.md");
    assert.ok(Object.hasOwn(out.sourceFingerprints, expectedKey), `实际键: ${Object.keys(out.sourceFingerprints).join(", ")}`);
    assert.equal(out.sourceFingerprints[expectedKey], sha256(FIXTURE_TEXT));
    assert.ok(isAbsolute(Object.keys(out.sourceFingerprints)[0]));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("不存在的入参 → exit 1 且 stderr 指明归一后路径", () => {
  const dir = makeTempDir("extract-bt-miss-");
  try {
    // 相对形态：报错路径 = 归一后绝对路径
    const rel = spawnSync(process.execPath, [SCRIPT, "missing.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(rel.status, 1, `相对入参应 exit 1，实得 ${rel.status}，stdout: ${rel.stdout}`);
    assert.ok(rel.stderr.includes(join(realpathSync(dir), "missing.md")), `stderr 应含归一路径，实际: ${rel.stderr}`);
    assert.ok(!rel.stdout.trim(), "失败时不得向 stdout 输出词表");

    // ~/ 形态：报错路径 = HOME 展开后的绝对路径（归一同时作用于读取路径的佐证）
    const home = makeTempDir("extract-bt-miss-home-");
    try {
      const tilde = spawnSync(process.execPath, [SCRIPT, "~/missing.md"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      assert.equal(tilde.status, 1, `~/ 不存在入参应 exit 1，实得 ${tilde.status}，stdout: ${tilde.stdout}`);
      assert.ok(tilde.stderr.includes(join(home, "missing.md")), `stderr 应含 HOME 展开路径，实际: ${tilde.stderr}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("双文件入参 → stdout 合法 JSON、键数 == 输入数", () => {
  const dir = makeTempDir("extract-bt-two-");
  try {
    writeFileSync(join(dir, "a.md"), FIXTURE_TEXT);
    writeFileSync(join(dir, "b.md"), "# 另一份\n\n含 `designDoc`。\n");
    const r = spawnSync(process.execPath, [SCRIPT, "a.md", "b.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `exit ${r.status}，stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout); // 非法 JSON 会在此抛错使测试失败
    assert.equal(out.schemaVersion, 1);
    assert.equal(Object.keys(out.sourceFingerprints).length, 2);
    assert.deepStrictEqual(Object.keys(out.sourceFingerprints).sort(), [join(realpathSync(dir), "a.md"), join(realpathSync(dir), "b.md")].sort());
    assert.ok(out.words.includes("exitPlanMode"));
    assert.ok(Array.isArray(out.dropped));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多形态入参同指一文件 → 撞键，输出前自验 exit 1", () => {
  const dir = makeTempDir("extract-bt-dup-");
  try {
    writeFileSync(join(dir, "a.md"), FIXTURE_TEXT);
    const abs = join(realpathSync(dir), "a.md");
    const r = spawnSync(process.execPath, [SCRIPT, "a.md", abs], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1, `撞键应 exit 1，实得 ${r.status}，stdout: ${r.stdout}`);
    assert.ok(r.stderr.includes("自验失败"), `stderr 应含自验失败说明，实际: ${r.stderr}`);
    assert.ok(!r.stdout.trim(), "自验失败时不得向 stdout 输出词表");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ════════ --check 差分测试（防漂移机制） ════════

const DCS_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "self",
  "dev-workflow",
  "workflows",
  "src",
  "design-code-sync-loop.shared.ts",
);

/** 零转抄提取：从单源读出 NODE_BACKTICK_GREP 数组字面量，join 求值拿到探针全文 */
function loadProbe() {
  const src = readFileSync(DCS_SRC, "utf-8");
  const m = src.match(/const NODE_BACKTICK_GREP = \[([\s\S]*?)\]\.join\("\\n"\);/);
  assert.ok(m, "单源中未找到 NODE_BACKTICK_GREP 数组——提取正则与实现失配，须同步更新");
  return vm.runInNewContext(`[${m[1]}].join("\\n")`, {}, { timeout: 5000 });
}

/** 探针实跑：node -e <probe> <projectRoot> <watchlist>，形态对齐引擎 world.run 调用 */
function runProbe(probe, projectRoot, wlPath, cwd) {
  const r = spawnSync(process.execPath, ["-e", probe, projectRoot, wlPath], { encoding: "utf8", cwd });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // 探针崩溃 / 无输出时保持 null（差分按「未输出 ok:true」处理）
  }
  return { r, parsed };
}

function runCheckAt(wlPath, cwd) {
  return spawnSync(process.execPath, [SCRIPT, "--check", wlPath], { encoding: "utf8", cwd });
}

test("--check 判定与 NODE_BACKTICK_GREP 探针判定逐 fixture 等价（差分）", () => {
  const probe = loadProbe();
  const dir = makeTempDir("extract-bt-diff-");
  const rows = [];
  try {
    const textA = "# 设计草稿\n\n核心符号 `exitPlanMode` 与 `u-foundation`。\n";
    const textB = "# 计划\n\n字段 `designDoc` 与 `u-foundation`。\n";
    const docA = join(dir, "design.rendered.md");
    const docB = join(dir, "design.impl-plan.md");
    writeFileSync(docA, textA);
    writeFileSync(docB, textB);
    // 差分盲区 fixture 的磁盘前提：相对键「rel-doc.md」在两侧共同 cwd（dir）下存在且指纹正确
    // ——旧 --check 按可读性判定会误 PASS，探针按形态判定拒启，自验闭环断裂（P2-1 实证）
    writeFileSync(join(dir, "rel-doc.md"), textA);
    const goodFps = { [docA]: sha256(textA), [docB]: sha256(textB) };

    const fixtures = [
      { name: "合法（绝对键+指纹正确）", file: "wl-ok.json", wl: { schemaVersion: 1, sourceFingerprints: goodFps, scan: ["exitPlanMode", "u-foundation"], skip: [{ word: "designDoc", reason: "JSON 字段名" }] }, expect: "PASS" },
      { name: "指纹键为相对路径（键不可读）", file: "wl-relkey.json", wl: { schemaVersion: 1, sourceFingerprints: { "no-such-relative-key.md": sha256(textA) }, scan: ["exitPlanMode"], skip: [] }, expect: "指纹键不可读", probeReasonHas: ["路径解析失败，与文档内容无关", "绝对路径形态"] },
      { name: "相对键且 cwd 下同名文件存在、指纹正确（形态判定盲区：两侧均须拒）", file: "wl-relexists.json", wl: { schemaVersion: 1, sourceFingerprints: { "rel-doc.md": sha256(textA) }, scan: ["exitPlanMode"], skip: [] }, expect: "指纹键不可读", probeReasonHas: ["路径解析失败，与文档内容无关"], probeReasonNotHas: ["源文档已改"] },
      { name: "指纹过期（内容已改）", file: "wl-stale.json", wl: { schemaVersion: 1, sourceFingerprints: { [docA]: "0".repeat(64) }, scan: ["exitPlanMode"], skip: [] }, expect: "指纹不等", probeReasonHas: ["源文档已改而词表未重生成"], probeReasonNotHas: ["不可读"] },
      { name: "指纹键混合（一不可读一不等）", file: "wl-mixed.json", wl: { schemaVersion: 1, sourceFingerprints: { "no-such-relative-key.md": sha256(textA), [docB]: "1".repeat(64) }, scan: ["exitPlanMode"], skip: [] }, expect: "指纹键不可读", alsoExpect: "指纹不等", probeReasonHas: ["路径解析失败，与文档内容无关", "源文档已改而词表未重生成"], probeReasonOrdered: ["路径解析失败，与文档内容无关", "源文档已改而词表未重生成"] },
      { name: "缺 scan 数组（缺 skip 同类）", file: "wl-noscan.json", wl: { schemaVersion: 1, sourceFingerprints: goodFps, scan: ["exitPlanMode"] }, expect: "缺 scan 数组或 skip 数组" },
      { name: "skip 元素畸形（缺 reason）", file: "wl-badskip.json", wl: { schemaVersion: 1, sourceFingerprints: goodFps, scan: ["exitPlanMode"], skip: [{ word: "designDoc" }] }, expect: "skip 元素畸形" },
      { name: "skip 元素为 null（明细构造须检查不抛 TypeError）", file: "wl-nullskip.json", wl: { schemaVersion: 1, sourceFingerprints: goodFps, scan: ["exitPlanMode"], skip: [null] }, expect: "skip 元素畸形", detailNeedle: "元素 #0: null" },
      { name: "sourceFingerprints 空对象", file: "wl-emptyfps.json", wl: { schemaVersion: 1, sourceFingerprints: {}, scan: ["exitPlanMode"], skip: [] }, expect: "缺 sourceFingerprints" },
      { name: "词表文件不存在", file: "wl-missing.json", wl: null, expect: "词表不可读或非合法 JSON" },
      { name: "词表非合法 JSON", file: "wl-badjson.json", raw: "{oops", expect: "词表不可读或非合法 JSON" },
    ];

    for (const fx of fixtures) {
      const wlPath = join(dir, fx.file);
      if (fx.raw !== undefined) writeFileSync(wlPath, fx.raw);
      else if (fx.wl !== null) writeFileSync(wlPath, JSON.stringify(fx.wl, null, 2));
      // wl === null → 故意不落盘（覆盖「词表文件不存在」类）

      // 两侧同一 cwd：指纹键原样直读的解析语义一致（--check 键读法与探针逐字同源）
      const probeOut = runProbe(probe, dir, wlPath, dir);
      const checkOut = runCheckAt(wlPath, dir);

      assert.ok(probeOut.parsed, `探针未输出合法 JSON [${fx.name}]: stderr=${probeOut.r.stderr.slice(0, 300)}`);
      const probeFail = probeOut.parsed.ok === false;
      const checkFail = checkOut.status === 1;
      assert.equal(
        checkFail,
        probeFail,
        `判定不等价 [${fx.name}] probe=${JSON.stringify(probeOut.parsed).slice(0, 200)} vs check(exit=${checkOut.status}) stdout=${checkOut.stdout.trim().slice(0, 200)}`,
      );

      if (fx.expect === "PASS") {
        assert.equal(probeOut.parsed.ok, true, `[${fx.name}] 探针应 ok:true，实际 ${JSON.stringify(probeOut.parsed).slice(0, 200)}`);
        assert.equal(checkOut.status, 0, `[${fx.name}] --check 应 exit 0，stderr: ${checkOut.stderr}`);
        assert.equal(checkOut.stdout.trim(), "PASS", `[${fx.name}] --check PASS 输出形态不符`);
      } else {
        assert.equal(probeOut.parsed.ok, false, `[${fx.name}] 探针应 ok:false，实际 ${JSON.stringify(probeOut.parsed).slice(0, 200)}`);
        assert.ok(checkOut.stdout.startsWith(`FAIL: ${fx.expect}: `), `[${fx.name}] --check 首行应为「FAIL: ${fx.expect}: …」，实际: ${checkOut.stdout.trim()}`);
        if (fx.alsoExpect) assert.ok(checkOut.stdout.includes(`FAIL: ${fx.alsoExpect}: `), `[${fx.name}] --check 应同时报告「FAIL: ${fx.alsoExpect}」，实际: ${checkOut.stdout.trim()}`);
        if (fx.detailNeedle) assert.ok(checkOut.stdout.includes(fx.detailNeedle), `[${fx.name}] FAIL 明细应含「${fx.detailNeedle}」，实际: ${checkOut.stdout.trim()}`);
        // 探针 reason 根因断言（F2 报错拆路）：键不可读路归因「路径解析失败，与文档内容
        // 无关」，指纹过期路归因「文档已改」——两路 reason 文案漂移在此被拦
        for (const needle of fx.probeReasonHas ?? []) {
          assert.ok(probeOut.parsed.reason.includes(needle), `[${fx.name}] 探针 reason 应含「${needle}」，实际: ${probeOut.parsed.reason}`);
        }
        for (const needle of fx.probeReasonNotHas ?? []) {
          assert.ok(!probeOut.parsed.reason.includes(needle), `[${fx.name}] 探针 reason 不应含「${needle}」（不可读与过期须分路归因），实际: ${probeOut.parsed.reason}`);
        }
        if (fx.probeReasonOrdered) {
          const [first, second] = fx.probeReasonOrdered;
          const atFirst = probeOut.parsed.reason.indexOf(first);
          const atSecond = probeOut.parsed.reason.indexOf(second);
          assert.ok(atFirst >= 0 && atSecond > atFirst, `[${fx.name}] 探针 reason 两段应先不可读后过期（；分隔），实际: ${probeOut.parsed.reason}`);
        }
      }
      const probeVerdict = probeFail ? "ok:false" : "ok:true";
      const categories = checkOut.stdout.trim().split("\n").map((l) => l.match(/^FAIL: ([^:]+):/)?.[1]).filter(Boolean);
      const checkVerdict = checkFail ? `FAIL(${categories.join(" + ")})` : "PASS";
      rows.push(`${fx.name} | 探针 ${probeVerdict} | --check ${checkVerdict}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`差分对照（fixture × 两侧判定，共 ${rows.length} 份）：\n` + rows.map((r) => `  · ${r}`).join("\n"));
});

test("--check 用法错误（缺 watchlist 路径）→ exit 1 走 stderr", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 1, `应 exit 1，实得 ${r.status}`);
  assert.ok(r.stderr.includes("--check"), `stderr 应含 --check 用法行，实际: ${r.stderr}`);
  assert.ok(!r.stdout.trim(), "用法错误不得向 stdout 输出判定");
});
