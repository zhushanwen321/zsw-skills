// resilience-layer.test.mjs — 韧性层（workflows/src/resilience.shared.ts）单元测试。
// 层是 workflow 拼接件（无 import、依赖宿主 world/log），测试经 typescript 转译后
// 注入桩 world/log 执行——验证 askGuarded 修正重问语义、recordRepair JSONL 落盘、
// repairSummary 终态块与 retryOnSpawnFailure 的 -1 重试/语义失败不重试。
// 运行：node --test scripts/tests/resilience-layer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, rmSync, mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("韧性层：askGuarded / recordRepair / retryOnSpawnFailure 语义", async () => {
  const ts = createRequire(join(ROOT, "package.json"))("typescript");
  const srcPath = join(ROOT, "skills/self/dev-workflow/workflows/src/resilience.shared.ts");
  const js = ts.transpileModule(readFileSync(srcPath, "utf8"), { compilerOptions: { target: "es2022" } }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "resilience-test-"));
  const fakeWorld = {
    run: async (_cmd, argv) => {
      // 桩：world.run(cmd, ["-e", script, ...args]) —— argv[1]=script、argv[2]=首参
      if (argv[0] === "-e" && argv[1]?.includes("toISOString")) return { exitCode: 0, stdout: "2026-11-14T00:00:00.000Z", stderr: "" };
      if (argv[0] === "-e" && argv[1]?.includes("appendFileSync")) {
        mkdirSync(dirname(argv[2]), { recursive: true });
        appendFileSync(argv[2], argv[3] + "\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const logs = [];
  const factory = new Function("world", "log", js + "\nreturn { askGuarded, recordRepair, repairSummary, initResilience, retryOnSpawnFailure };");
  const api = factory(fakeWorld, (m) => logs.push(m));
  const journal = () => {
    try {
      return readFileSync(join(dir, "self-repairs.jsonl"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  try {
    api.initResilience(dir);

    // 场景 1：首答合法——零登记、汇总块为空（正常路径无噪音）
    {
      const r = await api.askGuarded(
        async () => ({ summary: "ok" }),
        (v) => (typeof v.summary === "string" && v.summary !== "" ? "" : "bad"),
        { workflow: "w", step: "execute", round: 1, target: "a1" },
      );
      assert.equal(r.ok, true);
      assert.equal(r.value.summary, "ok");
      assert.equal(api.repairSummary(), "");
      assert.equal(journal().length, 0);
    }

    // 场景 2：首答非法 → 携修正提示重问成功 → recovered 落 JSONL
    {
      let correctiveSeen = null;
      const r = await api.askGuarded(
        async (c) => {
          if (c === null) return { summary: "" };
          correctiveSeen = c;
          return { summary: "fixed" };
        },
        (v) => (v.summary !== "" ? "" : "summary 须为非空字符串"),
        { workflow: "w", step: "review", round: 2, target: "a2" },
      );
      assert.equal(r.ok, true);
      assert.match(correctiveSeen, /返回结构非法：summary 须为非空字符串/);
      const lines = journal();
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.kind, "agent-structure-retry");
      assert.equal(entry.outcome, "recovered");
      assert.equal(entry.workflow, "w");
      assert.equal(entry.target, "a2");
      assert.match(api.repairSummary(), /共 1 条/);
      assert.match(api.repairSummary(), /agent-structure-retry 1/);
    }

    // 场景 3：抛异常 + 重问仍抛 → 耗尽（2 条 exhausted、error 带耗尽说明）
    {
      const r = await api.askGuarded(
        async () => {
          throw new Error("boom");
        },
        () => "",
        { workflow: "w", step: "execute", round: 3, target: "a3" },
      );
      assert.equal(r.ok, false);
      assert.equal(r.value, null);
      assert.match(r.error, /boom/);
      assert.match(r.error, /共 2 次尝试后耗尽/);
      const lines = journal();
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[2]).kind, "agent-error-retry");
      assert.equal(JSON.parse(lines[2]).outcome, "exhausted");
      assert.match(api.repairSummary(), /共 3 条/);
    }

    // 场景 4：cli-retry——spawn 级失败（-1）重试一次成功 → recovered
    {
      let n = 0;
      const r = await api.retryOnSpawnFailure(
        async () => {
          n += 1;
          return n === 1 ? { exitCode: -1, stdout: "", stderr: "spawn ENOENT" } : { exitCode: 0, stdout: "out", stderr: "" };
        },
        { workflow: "w", step: "setup", round: null, command: "evaluate" },
      );
      assert.equal(r.exitCode, 0);
      assert.equal(n, 2);
      const last = JSON.parse(journal().at(-1));
      assert.equal(last.kind, "cli-retry");
      assert.equal(last.outcome, "recovered");
      assert.match(last.trigger, /ENOENT/);
    }

    // 场景 5：语义性失败（非 -1）不重试——归调用方处理
    {
      let n = 0;
      const r = await api.retryOnSpawnFailure(
        async () => {
          n += 1;
          return { exitCode: 3, stdout: "", stderr: "semantics" };
        },
        { workflow: "w", step: "setup", round: null, command: "evaluate" },
      );
      assert.equal(n, 1);
      assert.equal(r.exitCode, 3);
      assert.equal(journal().length, 4, "语义失败不产生登记");
    }

    // 场景 6：校验器自身抛异常（对 null 解引用）→ 层内兜住按结构非法进修正重问，
    // 不穿透（穿透会使 pending 不落 JSONL、调用方终态出口全部被绕过）
    {
      let correctiveSeen = null;
      const r = await api.askGuarded(
        async (c) => {
          if (c === null) return null;
          correctiveSeen = c;
          return { summary: "fixed" };
        },
        (v) => (typeof v.summary === "string" && v.summary !== "" ? "" : "bad"),
        { workflow: "w", step: "review", round: 6, target: "a6" },
      );
      assert.equal(r.ok, true);
      assert.match(correctiveSeen, /返回结构非法（校验器异常：/);
      const last = JSON.parse(journal().at(-1));
      assert.equal(last.kind, "agent-structure-retry");
      assert.equal(last.outcome, "recovered");
    }

    // 场景 7：重问耗尽保留最后一次返回值（raw）——已申报数据不随耗尽静默蒸发
    {
      const r = await api.askGuarded(
        async () => ({ summary: "kept", findings: [{ summary: "d1" }] }),
        () => "always bad",
        { workflow: "w", step: "execute", round: 7, target: "a7" },
      );
      assert.equal(r.ok, false);
      assert.equal(r.value, null);
      assert.equal(r.raw.summary, "kept");
      assert.equal(r.raw.findings.length, 1);
    }

    // 场景 8：登记写入失败后 repairSummary 声明明细不可信（终态块自身体现，不只执行日志）
    {
      const failingWorld = {
        run: async (_cmd, argv) => {
          if (argv[0] === "-e" && argv[1]?.includes("toISOString")) return { exitCode: 0, stdout: "2026-11-14T00:00:00.000Z", stderr: "" };
          if (argv[0] === "-e" && argv[1]?.includes("appendFileSync")) return { exitCode: 1, stdout: "", stderr: "EACCES" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      const failLogs = [];
      const failApi = new Function("world", "log", js + "\nreturn { askGuarded, recordRepair, repairSummary, initResilience, retryOnSpawnFailure };")(failingWorld, (m) => failLogs.push(m));
      failApi.initResilience(dir);
      await failApi.askGuarded(
        async (c) => (c === null ? { summary: "" } : { summary: "ok" }),
        (v) => (v.summary !== "" ? "" : "bad"),
        { workflow: "w", step: "execute", round: 8, target: "a8" },
      );
      const summary = failApi.repairSummary();
      assert.match(summary, /共 1 条/);
      assert.match(summary, /逐条明细写入曾失败/);
      assert.match(summary, /仅计数可信/);
      assert.ok(failLogs.some((m) => m.includes("WARN")), "写失败仍告警一次");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
