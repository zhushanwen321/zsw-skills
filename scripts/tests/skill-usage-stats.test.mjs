// skill-usage-stats.test.mjs — 五技能统一统计命令独立局部测试
//
// 覆盖（对应实现：scripts/skill-usage-stats.mjs）：
//   1. executionId 精确关联：run ↔ 观测 JSONL（attribution=observed、窗口时间归属 actor/node）
//   2. taskId 跨技能 / 跨 attempt 汇总（byTask）
//   3. 并行时间口径分开：区间并集 < actor 时长相加
//   4. legacy 分类器：execPlan/designDoc/implPlan/base/taskDir + 名称 → 五技能 + T2/D1/D2/D3/D5/
//      gates/branch-review/pr-lifecycle，恒标 attribution=estimated；认不出 → unclassified；
//      DEV 加固线六 workflow 名 → dev 三技能与阶段，design-code-sync-v2 不入 DEV 名单仍归 dev-flow-v1
//   5. 手工段（D0 等只有事件没有 run）：耗时照报、token = unknown（null，不写 0）
//   6. 坏 JSONL / 缺字段事件 / 未配对 start / 孤儿 end 显式计数
//   7. selftest 过滤：run args sampleType / 事件 sample_type / legacy 明确名称特征；
//      --include-selftest 计入
//   8. --pi-agent-dir realpath 去重（同目录双路径只调一次 CLI）
//   9. run 按 backend+id 去重；--since/--until 透传 CLI
//  10. CLI 失败（exit 1 + 错误 JSON）→ 可操作错误；CLI 输出非 JSON → 可操作错误
//  11. 未知参数 fail-fast exit 2；--help exit 0
//  12. JSON / table 输出形态；--output 落盘；空数据 exit 1
//  13. --group skillVersion：observed 读事件自带 skill_version、estimated 读 run 参数
//      指向产物（execPlan / designDoc→meta.json）的 skillVersion；读不到归 unknown 桶
//      显式计数（老 JSONL 无字段不抛错），unknown 桶与 dataQuality 计数自洽；byTask 版本列
//
// 运行：node --test scripts/tests/skill-usage-stats.test.mjs
// 测试自足：假 agent-session-reader + 临时 HOME 观测事件，不读真实用户数据。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "skill-usage-stats.mjs");

// ── 假 agent-session-reader：按 --zcode / --pi= 选 fixture，调用记录进日志 ──
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) {
  fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(argv) + "\\n");
}
const mode = process.env.FAKE_CLI_MODE || "ok";
if (mode === "error") {
  console.log(JSON.stringify({ error: "db_read_failed", code: "db_read_failed", help: ["跑 agent-session-reader doctor --zcode"] }));
  process.exit(1);
}
if (mode === "gibberish") {
  console.log("this is not json at all");
  process.exit(0);
}
if (mode === "enoent") {
  process.exit(0);
}
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_FIXTURE_PATH, "utf8"));
const payload = argv.includes("--zcode") ? fixtures.zcode : fixtures.pi;
process.stdout.write(JSON.stringify(payload));
`;

function makeFakeCli(binDir) {
  const cliPath = join(binDir, "agent-session-reader");
  writeFileSync(cliPath, FAKE_CLI);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

// ── fixture 构造 ──
const T = (h, m, s = 0) => `2026-05-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
const MS = (h, m, s = 0) => Date.UTC(2026, 4, 1, h, m, s);

const ev = (overrides) => ({
  execution_id: "",
  task_id: "",
  skill: "dev-flow-v1",
  stage: "D1",
  step: "execution",
  round: null,
  attempt: null,
  event: "start",
  timestamp: "",
  sample_type: "production",
  ...overrides,
});

function actorRow(overrides) {
  return {
    site: "actor#1",
    ordinal: 1,
    name: "u-core",
    model: "m1",
    session: "sess-x",
    status: "completed",
    timeStart: "",
    timeEnd: "",
    durationMs: 0,
    messages: 3,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    tokensNoncacheInput: 0,
    tokensTotal: 0,
    ...overrides,
  };
}

function baseRun(overrides) {
  return {
    id: "",
    name: "",
    status: "completed",
    cwd: "/proj/demo",
    timeStart: T(10, 0),
    timeEnd: T(10, 45),
    durationMs: 2_700_000,
    actors: 0,
    messages: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    tokensNoncacheInput: 0,
    tokensTotal: 0,
    tokensReported: 12345, // 自报值：统计不得读它
    models: "m1",
    nodeWallMs: 0,
    nodesBrief: "",
    taskId: null,
    executionId: null,
    sampleType: null,
    args: {},
    nodesByKind: [],
    actorRows: [],
    nodes: [],
    ...overrides,
  };
}

function buildFixtures(artifacts) {
  const zcodeRuns = [
    // observed run：attempt 1，双 actor 并行 + world-run 节点落在 gate-a 窗口
    baseRun({
      id: "dwfrun-1",
      name: "task-a D1 开发循环",
      taskId: "task-a",
      executionId: "d1-att1",
      args: { execPlan: "/p/exec-plan.json", taskId: "task-a", executionId: "d1-att1" },
      tokensInput: 180,
      tokensOutput: 50,
      tokensCacheRead: 110,
      tokensCacheWrite: 5,
      tokensReasoning: 10,
      tokensNoncacheInput: 70,
      tokensTotal: 230,
      actorRows: [
        actorRow({
          name: "u-core",
          model: "m1",
          timeStart: T(10, 0),
          timeEnd: T(10, 30),
          durationMs: 1_800_000,
          tokensInput: 100,
          tokensOutput: 30,
          tokensCacheRead: 60,
          tokensCacheWrite: 5,
          tokensReasoning: 5,
          tokensNoncacheInput: 40,
          tokensTotal: 130,
        }),
        actorRow({
          site: "actor#2",
          name: "verify-core",
          model: "m2",
          session: "sess-y",
          timeStart: T(10, 15),
          timeEnd: T(10, 45),
          durationMs: 1_800_000,
          tokensInput: 80,
          tokensOutput: 20,
          tokensCacheRead: 50,
          tokensCacheWrite: 0,
          tokensReasoning: 5,
          tokensNoncacheInput: 30,
          tokensTotal: 100,
        }),
      ],
      nodes: [
        {
          site: "world-run#1",
          ordinal: 1,
          kind: "world-run",
          status: "completed",
          timeStart: T(10, 20),
          timeEnd: T(10, 25),
          durationMs: 300_000,
          op: null,
          command: "bash scripts/coverage-gate.sh",
          commandTruncated: false,
        },
      ],
    }),
    // observed run：attempt 2（同 taskId 跨 attempt 汇总）
    baseRun({
      id: "dwfrun-2",
      name: "task-a D1 开发循环（重发）",
      timeStart: T(11, 0),
      timeEnd: T(11, 10),
      durationMs: 600_000,
      taskId: "task-a",
      executionId: "d1-att2",
      tokensInput: 10,
      tokensOutput: 2,
      tokensCacheRead: 8,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      tokensNoncacheInput: 2,
      tokensTotal: 12,
      args: { execPlan: "/p/exec-plan.json", taskId: "task-a", executionId: "d1-att2" },
      actorRows: [
        actorRow({
          site: "actor#1",
          timeStart: T(11, 0),
          timeEnd: T(11, 10),
          durationMs: 600_000,
          tokensInput: 10,
          tokensOutput: 2,
          tokensCacheRead: 8,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 2,
          tokensTotal: 12,
        }),
      ],
    }),
    // observed run：跨技能（同 taskId 的 T2）
    baseRun({
      id: "dwfrun-3",
      name: "task-a T2 设计审查",
      timeStart: T(9, 0),
      timeEnd: T(9, 30),
      durationMs: 1_800_000,
      taskId: "task-a",
      executionId: "t2-att1",
      tokensInput: 40,
      tokensOutput: 10,
      tokensCacheRead: 30,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      tokensNoncacheInput: 10,
      tokensTotal: 50,
      args: { designDoc: "/p/design.md", taskId: "task-a", executionId: "t2-att1" },
      actorRows: [
        actorRow({
          site: "actor#1",
          name: "主审-r1",
          model: "m1",
          timeStart: T(9, 0),
          timeEnd: T(9, 30),
          durationMs: 1_800_000,
          tokensInput: 40,
          tokensOutput: 10,
          tokensCacheRead: 30,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 10,
          tokensTotal: 50,
        }),
      ],
    }),
    // legacy：D2（execPlan + 名称），无 executionId
    baseRun({
      id: "dwfrun-4",
      name: "task-b D2 一致性审查",
      timeStart: T(8, 0),
      timeEnd: T(9, 0),
      durationMs: 3_600_000,
      tokensInput: 32,
      tokensOutput: 9,
      tokensCacheRead: 23,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      tokensNoncacheInput: 9,
      tokensTotal: 41,
      args: { execPlan: artifacts.execPlanV010, maxRounds: 3 },
      actorRows: [
        actorRow({
          site: "actor#1",
          name: "一致性审查-docs",
          model: "m1",
          timeStart: T(8, 0),
          timeEnd: T(8, 40),
          durationMs: 2_400_000,
          tokensInput: 20,
          tokensOutput: 5,
          tokensCacheRead: 15,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 5,
          tokensTotal: 25,
        }),
        actorRow({
          site: "actor#2",
          name: "修复-docs-r1",
          model: "m3",
          session: "sess-z",
          timeStart: T(8, 30),
          timeEnd: T(9, 0),
          durationMs: 1_800_000,
          tokensInput: 12,
          tokensOutput: 4,
          tokensCacheRead: 8,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 4,
          tokensTotal: 16,
        }),
      ],
    }),
    // legacy：dev-merge branch-review（名称 + base），pi/zcode 双侧同 id 形态校验在 pi fixture
    baseRun({
      id: "dwfrun-5",
      name: "dev-merge branch-review：fix-demo",
      durationMs: 100_000,
      timeStart: T(7, 0),
      timeEnd: T(7, 2),
      tokensInput: 5,
      tokensOutput: 1,
      tokensCacheRead: 4,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      tokensNoncacheInput: 1,
      tokensTotal: 6,
      args: { base: "main", maxFixAttempts: 2 },
      actorRows: [
        actorRow({
          site: "actor#1",
          name: "reviewer-arch-boundary-r1",
          model: "m1",
          timeStart: T(7, 0),
          timeEnd: T(7, 1),
          durationMs: 60_000,
          tokensInput: 5,
          tokensOutput: 1,
          tokensCacheRead: 4,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 1,
          tokensTotal: 6,
        }),
      ],
      nodes: [
        {
          site: "world-run#1",
          ordinal: 1,
          kind: "world-run",
          status: "completed",
          timeStart: T(7, 1),
          timeEnd: T(7, 2),
          durationMs: 60_000,
          op: null,
          command: "bash scripts/pr-pre-merge.sh --skip-tests --quiet",
          commandTruncated: false,
        },
      ],
    }),
    // legacy unclassified：名称与 args 均无特征
    baseRun({
      id: "dwfrun-6",
      name: "随手探索一个想法",
      durationMs: 5_000,
      args: {},
    }),
    // legacy selftest：明确名称特征（冒烟）+ 可归类（D1）
    baseRun({
      id: "dwfrun-7",
      name: "引擎冒烟：D1 开发循环 inspect fail 不吞",
      durationMs: 1_000,
      args: {},
    }),
    // run 自报 sampleType=selftest（args 通道）
    baseRun({
      id: "dwfrun-8",
      name: "task-a D1 开发循环（自测样本）",
      durationMs: 2_000,
      sampleType: "selftest",
      args: { execPlan: "/p/exec-plan.json", sampleType: "selftest" },
    }),
    // 声明 executionId 但观测文件缺失 → 显式计数 + 回落 legacy
    baseRun({
      id: "dwfrun-9",
      name: "task-ghost D1 开发循环",
      durationMs: 60_000,
      timeStart: T(6, 0),
      timeEnd: T(6, 1),
      taskId: "task-ghost",
      executionId: "ghost-exec",
      args: { execPlan: artifacts.missingExecPlan, executionId: "ghost-exec" },
    }),
    // legacy：T2 方向审修复轮（名称词表，无 args）
    baseRun({
      id: "dwfrun-10",
      name: "doc2第8轮方向审修复",
      durationMs: 30_000,
      timeStart: T(4, 0),
      timeEnd: T(4, 1),
      args: {},
    }),
    // run 级 token 对账——缺失 actor：run 级有消耗但 actorRows 空（差额合成未归用量记录）
    baseRun({
      id: "dwfrun-11",
      name: "task-c D3 端到端验收",
      durationMs: 120_000,
      timeStart: T(12, 0),
      timeEnd: T(12, 2),
      tokensInput: 77,
      tokensNoncacheInput: 77,
      tokensTotal: 77,
      args: { execPlan: artifacts.missingExecPlan },
    }),
    // run 级 token 对账——重复 session：同 session 两行，第二行 token 不得重复累加
    baseRun({
      id: "dwfrun-12",
      name: "task-d D3 端到端验收（重复会话）",
      durationMs: 400_000,
      timeStart: T(12, 10),
      timeEnd: T(12, 16),
      tokensInput: 200,
      tokensOutput: 20,
      tokensCacheRead: 150,
      tokensNoncacheInput: 50,
      tokensTotal: 220,
      args: { execPlan: artifacts.execPlanNoVersion },
      actorRows: [
        actorRow({
          site: "actor#1",
          session: "s-dup",
          timeStart: T(12, 10),
          timeEnd: T(12, 15),
          durationMs: 300_000,
          tokensInput: 100,
          tokensOutput: 10,
          tokensCacheRead: 75,
          tokensNoncacheInput: 25,
          tokensTotal: 110,
        }),
        actorRow({
          site: "actor#2",
          session: "s-dup",
          timeStart: T(12, 12),
          timeEnd: T(12, 14),
          durationMs: 120_000,
          tokensInput: 50,
          tokensOutput: 5,
          tokensCacheRead: 30,
          tokensNoncacheInput: 20,
          tokensTotal: 55,
        }),
        // 空 session 行无法判重：按独立执行计（会话数 +1），token 照算
        actorRow({
          site: "actor#3",
          session: null,
          timeStart: T(12, 14),
          timeEnd: T(12, 15),
          durationMs: 5_000,
        }),
      ],
    }),
    // run 级 token 对账——正负混合差额：total 差 +10 但 input 差 -20，不得合成 reconcile
    //（否则 tokens 违反 total=input+output），保留 actor 合计并计 tokenReconcileNegative
    baseRun({
      id: "dwfrun-14",
      name: "task-e D5 终态同步",
      durationMs: 300_000,
      timeStart: T(14, 0),
      timeEnd: T(14, 5),
      tokensInput: 90,
      tokensOutput: 50,
      tokensNoncacheInput: 40,
      tokensTotal: 140,
      args: { designDoc: artifacts.designDoc, implPlan: "/p/impl-plan.md" },
      actorRows: [
        actorRow({
          site: "actor#1",
          session: "s-mix",
          timeStart: T(14, 0),
          timeEnd: T(14, 4),
          durationMs: 240_000,
          tokensInput: 110,
          tokensOutput: 20,
          tokensNoncacheInput: 90,
          tokensTotal: 130,
        }),
      ],
    }),
    // selftest run：观测事件 skill 写引擎名（tech-review-loop）→ 归一 tech-design-v1
    baseRun({
      id: "dwfrun-13",
      name: "观测自测：引擎名事件归一",
      timeStart: T(13, 0),
      timeEnd: T(13, 30),
      durationMs: 1_800_000,
      taskId: "task-alias",
      executionId: "alias-exec",
      sampleType: "selftest",
      tokensInput: 8,
      tokensNoncacheInput: 8,
      tokensTotal: 8,
      args: { designDoc: "/p/design.md", taskId: "task-alias", executionId: "alias-exec", sampleType: "selftest" },
      actorRows: [
        actorRow({
          site: "actor#1",
          name: "简洁审-r1",
          model: "m1",
          session: "s-alias",
          timeStart: T(13, 0),
          timeEnd: T(13, 30),
          durationMs: 1_800_000,
          tokensInput: 8,
          tokensNoncacheInput: 8,
          tokensTotal: 8,
        }),
      ],
    }),
    // attempt null→1 回填配对：setup start(null)/end(1) 是正常序列（观测契约的回填形态），
    // execution 运行中未闭合仍应报告
    baseRun({
      id: "dwfrun-15",
      name: "task-pair D4 收尾交付",
      timeStart: T(15, 0),
      timeEnd: T(15, 2),
      durationMs: 120_000,
      taskId: "task-pair",
      executionId: "pair-exec",
      args: {},
    }),
    // 重复 id（backend+id 去重）
    baseRun({
      id: "dwfrun-1",
      name: "task-a D1 开发循环（重复行）",
      durationMs: 999_999,
      tokensTotal: 999_999,
      actorRows: [actorRow({ tokensTotal: 999_999, timeStart: T(10, 0), timeEnd: T(10, 30), durationMs: 1_800_000 })],
    }),
  ];

  const piRuns = [
    // pi legacy：PR 生命周期（九步）+ args.base + args.taskId（arg: 前缀 taskKey）
    baseRun({
      id: "wf-1",
      name: "PR 生命周期 dev-0.12.1 → main",
      status: "done",
      durationMs: 400_000,
      timeStart: T(5, 0),
      timeEnd: T(5, 10),
      tokensInput: 7,
      tokensOutput: 3,
      tokensCacheRead: 4,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      tokensNoncacheInput: 3,
      tokensTotal: 10,
      taskId: "task-pi",
      args: { base: "main", simplifyMode: "apply", skipSteps: [], taskId: "task-pi" },
      actorRows: [
        actorRow({
          site: "task#0",
          name: "simplify-apply",
          model: "glm-x",
          session: "pi-sess-1",
          status: "done",
          timeStart: T(5, 0),
          timeEnd: T(5, 5),
          durationMs: 300_000,
          tokensInput: 7,
          tokensOutput: 3,
          tokensCacheRead: 4,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          tokensNoncacheInput: 3,
          tokensTotal: 10,
        }),
      ],
    }),
  ];

  return {
    zcode: {
      count: `${zcodeRuns.length} of ${zcodeRuns.length} total`,
      backend: "zcode",
      runs: zcodeRuns,
      totals: { runs: zcodeRuns.length, tokensTotal: 42, wallMs: 1 }, // 假 totals：统计不得用它当总量
      skipped: { runsUnreadable: 0 },
    },
    pi: {
      count: `${piRuns.length} of ${piRuns.length} total`,
      backend: "pi",
      runs: piRuns,
      totals: { runs: piRuns.length, tokensTotal: 7, wallMs: 1 },
      skipped: { runsUnreadable: 0 },
    },
  };
}

// 观测事件落盘（临时 HOME 下）
function writeObservations(home) {
  const root = join(home, ".agents", "skill-data", "workflow-observability");
  const write = (taskId, execId, rows) => {
    mkdirSync(join(root, taskId), { recursive: true });
    // 字符串行原样落盘（坏行样本），对象行序列化
    writeFileSync(join(root, taskId, `${execId}.jsonl`), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  };
  const common = (o) => ({ ...o, task_id: o.task_id ?? "task-a" });
  // 新版事件（带 skill_version）：observed 口径的版本来源；老 JSONL 用例保持无该字段
  const ver = (v, o) => common({ ...o, skill_version: v });

  // attempt 1：execution 窗口 + gate-a 窗口（与 world-run 节点对齐）
  write("task-a", "d1-att1", [
    ev(ver("0.2.0", { execution_id: "d1-att1", stage: "D1", step: "execution", attempt: 1, event: "start", timestamp: T(10, 0) })),
    ev(ver("0.2.0", { execution_id: "d1-att1", stage: "D1", step: "gate-a", attempt: 1, event: "start", timestamp: T(10, 20) })),
    ev(ver("0.2.0", { execution_id: "d1-att1", stage: "D1", step: "gate-a", attempt: 1, event: "end", timestamp: T(10, 25) })),
    ev(ver("0.2.0", { execution_id: "d1-att1", stage: "D1", step: "execution", attempt: 1, event: "end", timestamp: T(10, 44), outcome: "completed" })),
  ]);
  // attempt 2
  write("task-a", "d1-att2", [
    ev(ver("0.2.0", { execution_id: "d1-att2", stage: "D1", step: "execution", attempt: 2, event: "start", timestamp: T(11, 0) })),
    ev(ver("0.2.0", { execution_id: "d1-att2", stage: "D1", step: "execution", attempt: 2, event: "end", timestamp: T(11, 10), outcome: "completed" })),
  ]);
  // 跨技能 T2（不同技能版本：同 taskId 的版本列跨 0.1.0/0.2.0）
  write("task-a", "t2-att1", [
    ev(ver("0.1.0", { execution_id: "t2-att1", skill: "tech-design-v1", stage: "T2", step: "review", event: "start", timestamp: T(9, 0) })),
    ev(ver("0.1.0", { execution_id: "t2-att1", skill: "tech-design-v1", stage: "T2", step: "review", event: "end", timestamp: T(9, 30), outcome: "converged" })),
  ]);
  // 手工段：D0 compile（无 run 匹配 → 手工执行，token unknown）
  write("task-manual", "d0-manual", [
    ev(common({ task_id: "task-manual", execution_id: "d0-manual", stage: "D0", step: "compile", event: "start", timestamp: T(8, 0) })),
    ev(common({ task_id: "task-manual", execution_id: "d0-manual", stage: "D0", step: "compile", event: "end", timestamp: T(8, 10), outcome: "completed" })),
  ]);
  // 坏样本文件：坏 JSONL 行 + 缺字段事件 + 未配对 start + 孤儿 end
  write("task-bad", "bad-events", [
    '{"execution_id": "bad-events", broken',
    {
      execution_id: "bad-events",
      task_id: "task-bad",
      skill: "dev-flow-v1",
      stage: "D0",
      step: "compile",
      round: null,
      attempt: null,
      timestamp: T(7, 0),
      sample_type: "production",
    }, // 缺 event 字段
    ev(common({ task_id: "task-bad", execution_id: "bad-events", stage: "D0", step: "compile", event: "start", timestamp: T(7, 1) })), // 未配对 start
    ev(common({ task_id: "task-bad", execution_id: "bad-events", stage: "D0", step: "execution", event: "end", timestamp: T(7, 5), outcome: "setup-failure" })), // 孤儿 end
  ]);
  // selftest 执行（事件 sample_type=selftest）
  write("task-selftest", "d0-selftest", [
    ev(common({ task_id: "task-selftest", execution_id: "d0-selftest", stage: "D0", step: "compile", event: "start", timestamp: T(6, 0), sample_type: "selftest" })),
    ev(common({ task_id: "task-selftest", execution_id: "d0-selftest", stage: "D0", step: "compile", event: "end", timestamp: T(6, 5), sample_type: "selftest", outcome: "completed" })),
  ]);
  // 引擎名事件（历史形态 skill=tech-review-loop，非五技能名）——统计侧归一
  write("task-alias", "alias-exec", [
    ev(ver("0.1.0", { task_id: "task-alias", execution_id: "alias-exec", skill: "tech-review-loop", stage: "T2", step: "review", event: "start", timestamp: T(13, 0) })),
    ev(ver("0.1.0", { task_id: "task-alias", execution_id: "alias-exec", skill: "tech-review-loop", stage: "T2", step: "review", event: "end", timestamp: T(13, 30), outcome: "converged" })),
  ]);
  // 老 JSONL（无 skill_version）：attempt 回填形态 setup start(null)/end(1) 正常配对；
  // execution 运行中未闭合（RL6：老数据归 unknown 桶不抛错）
  write("task-pair", "pair-exec", [
    ev(common({ task_id: "task-pair", execution_id: "pair-exec", stage: "D4", step: "setup", event: "start", timestamp: T(15, 0) })),
    ev(common({ task_id: "task-pair", execution_id: "pair-exec", stage: "D4", step: "setup", event: "end", timestamp: T(15, 1), attempt: 1, outcome: "completed" })),
    ev(common({ task_id: "task-pair", execution_id: "pair-exec", stage: "D4", step: "execution", event: "start", timestamp: T(15, 0) })),
  ]);
  return root;
}

// 产物 fixture（estimated 口径版本来源）：execPlan / designDoc→meta.json 两种载体 +
// 读不到的两类（文件缺失、无 skillVersion 字段）
function makeArtifacts(home) {
  const dir = join(home, "artifacts");
  mkdirSync(dir, { recursive: true });
  const execPlanV010 = join(dir, "exec-plan-v010.json");
  writeFileSync(execPlanV010, JSON.stringify({ version: 1, skillVersion: "0.1.0", nodes: [] }));
  const execPlanNoVersion = join(dir, "exec-plan-no-version.json");
  writeFileSync(execPlanNoVersion, JSON.stringify({ version: 1, nodes: [] }));
  const missingExecPlan = join(dir, "gone", "exec-plan.json"); // 不创建 = 产物已迁移/删除
  const designPkg = join(dir, "design-pkg");
  mkdirSync(designPkg, { recursive: true });
  const designDoc = join(designPkg, "demo.rendered.md");
  writeFileSync(designDoc, "# demo\n");
  writeFileSync(join(designPkg, "meta.json"), JSON.stringify({ name: "demo", skillVersion: "0.3.0" }));
  return { execPlanV010, execPlanNoVersion, missingExecPlan, designDoc };
}

function setupEnv(t) {
  const home = mkdtempSync(join(tmpdir(), "sus-test-home-"));
  const binDir = mkdtempSync(join(tmpdir(), "sus-test-bin-"));
  makeFakeCli(binDir);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true }); // 缺省 pi agentDir
  const fixturePath = join(home, "fixtures.json");
  const artifacts = makeArtifacts(home);
  writeFileSync(fixturePath, JSON.stringify(buildFixtures(artifacts)));
  const obsRoot = writeObservations(home);
  const logPath = join(home, "cli-log.txt");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });
  const runScript = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_FIXTURE_PATH: fixturePath,
        FAKE_CLI_LOG: logPath,
        FAKE_CLI_MODE: "ok",
        ...extraEnv,
      },
    });
  return { home, binDir, obsRoot, logPath, runScript };
}

const readLog = (logPath) =>
  readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ── 1. executionId 精确关联 + 并行区间并集 + 步骤归属 ──
test("executionId 精确关联观测文件：attribution=observed、actor/node 按窗口归属、gate-a 步骤分列", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const run1 = report.runs.find((r) => r.id === "dwfrun-1");
  assert.ok(run1, "dwfrun-1 在 runs 明细");
  assert.equal(run1.attribution, "observed");
  assert.equal(run1.skill, "dev-flow-v1");
  assert.equal(run1.stage, "D1");
  assert.equal(run1.taskKey, "observed:task-a");

  // D1 桶：observed 2（att1+att2）+ estimated 1（ghost 回落）= 3 个 run
  const d1 = report.bySkill["dev-flow-v1"].stages["D1"];
  assert.equal(d1.metrics.attribution.observed, 2);
  assert.equal(d1.metrics.attribution.estimated, 1);

  // token 归 actor 重算值 + run 级差额补齐：D1 242；D2 41；T2 50；dev-merge 6+10(pi)；
  // D3 77（缺 actor 差额）+110（唯一 actor）+110（重复 session 差额补齐）= 297；
  // D5 130（正负混合差额不入账，只计 actor 合计）→ 合计 776
  assert.equal(report.totals.tokens.total, 776);
  assert.equal(report.totals.tokens.input, 100 + 80 + 10 + 20 + 12 + 40 + 5 + 7 + 77 + 100 + 100 + 110);
  // platformRaw 用 run 行重算字段直加（平台对账口径，未按 --skill 过滤、含被排除的 selftest），
  // 不读 totals 假值也不读 tokensReported
  assert.equal(report.platformRaw[0].sumOfRunRows.total, 230 + 12 + 50 + 41 + 6 + 77 + 220 + 8 + 140);
  assert.equal(report.platformRaw[0].cliTotals.tokensTotal, 42, "CLI 原始 totals 原样透传供对账");

  // 并行口径分开：D1 并集 6:00-6:01 + 10:00-10:45 + 11:00-11:10 = 56min，actor 相加 30+30+10 = 70min
  assert.equal(d1.metrics.elapsedMsUnion, 56 * 60_000);
  assert.equal(d1.metrics.actorDurationSum, 70 * 60_000);
  assert.ok(d1.metrics.elapsedMsUnion < d1.metrics.actorDurationSum);

  // gate-a 步骤桶：world-run 节点（与 gate-a 窗口完全重叠）归 step=gate-a
  assert.ok(d1.steps["gate-a"], "gate-a 步骤桶存在");
  assert.equal(d1.steps["gate-a"].nodeDurationSum, 300_000);
  // execution 步骤桶承接 actor（时间重叠最大窗口）
  assert.ok(d1.steps["execution"], "execution 步骤桶存在");
  assert.equal(d1.steps["execution"].actorSessions, 3);

  // T2：observed + 主审角色桶
  const t2 = report.bySkill["tech-design-v1"].stages["T2"];
  assert.equal(t2.metrics.attribution.observed, 1);
  assert.equal(t2.roles["主审"].actorSessions, 1);
});

// ── 2. taskId 跨技能 / 跨 attempt 汇总 ──
test("byTask：同 taskId 跨技能 + 跨 attempt 串联；arg: 前缀与 legacy 词干分开标注", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const taskA = report.byTask["observed:task-a"];
  assert.ok(taskA, "observed:task-a 任务组存在");
  assert.equal(taskA.source, "observed-taskid");
  assert.equal(taskA.runs, 3, "D1×2 + T2×1");
  assert.equal(taskA.attempts, 3, "三个 executionId");
  assert.ok(taskA.skills["dev-flow-v1"] > 0 && taskA.skills["tech-design-v1"] > 0, "跨技能串联");
  assert.ok(taskA.tokens.total > 0);

  const taskPi = report.byTask["arg:task-pi"];
  assert.ok(taskPi, "pi run args.taskId → arg: 前缀任务组");
  assert.equal(taskPi.source, "run-args-taskid");
  assert.equal(taskPi.runs, 1);

  const legacyTask = Object.entries(report.byTask).find(([k, v]) => k.startsWith("legacy-stem:"));
  assert.ok(legacyTask, "legacy 词干任务组存在");
  assert.match(legacyTask[1].attributionNote, /估算/);
});

// ── 3. legacy 分类器 ──
test("legacy 分类器：五技能与阶段映射 + estimated 标记 + unclassified 计数", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const d2 = report.runs.find((r) => r.id === "dwfrun-4");
  assert.equal(d2.skill, "dev-flow-v1");
  assert.equal(d2.stage, "D2");
  assert.equal(d2.attribution, "estimated");
  const d2Roles = report.bySkill["dev-flow-v1"].stages["D2"].roles;
  assert.ok(d2Roles["全面一致性审查"] && d2Roles["一致性修复"], "D2 角色映射（审查区 + 修复）");

  const dm = report.runs.find((r) => r.id === "dwfrun-5");
  assert.equal(dm.skill, "dev-merge");
  assert.equal(dm.stage, "branch-review");
  assert.equal(dm.attribution, "estimated");
  const dmStage = report.bySkill["dev-merge"].stages["branch-review"];
  assert.equal(dmStage.steps["pre-merge-gate"].nodeDurationSum, 60_000, "world-run pr-pre-merge 命令 → pre-merge-gate 步骤");

  const pi = report.runs.find((r) => r.id === "wf-1");
  assert.equal(pi.skill, "pr-cr-fix", "PR 生命周期（九步）归 pr-cr-fix");
  assert.equal(pi.stage, "pr-lifecycle");
  const piStage = report.bySkill["pr-cr-fix"].stages["pr-lifecycle"];
  assert.equal(piStage.roles["简化应用"].actorSessions, 1, "simplify actor → 简化应用角色");

  assert.equal(report.unclassified.count, 1);
  assert.equal(report.unclassified.runs[0].id, "dwfrun-6");
  assert.equal(report.dataQuality.unclassifiedRuns, 1);

  // 方向审是 tech-design-v1 T2 四席词表（flow/review.md）——名称修复轮归 T2
  const t2fix = report.runs.find((r) => r.id === "dwfrun-10");
  assert.ok(t2fix, "方向审修复轮在 runs 明细");
  assert.equal(t2fix.skill, "tech-design-v1");
  assert.equal(t2fix.stage, "T2");
  assert.equal(t2fix.attribution, "estimated");

  // 用量覆盖：unknown 计数来自 ghost run（无 actor 且 run token=0）与手工段
  assert.ok(report.totals.usageCoverage.unknown >= 1);
});

test("legacy 分类器：delivery-v1 三个 workflow 按 taskDir 与名称归阶段", (t) => {
  const { home, runScript } = setupEnv(t);
  const fixturePath = join(home, "fixtures.json");
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const name of ["contract-design", "candidate-build", "independent-assurance"]) {
    fixtures.zcode.runs.push(baseRun({ id: `dwfrun-${name}`, name, args: { taskDir: "/tmp/delivery-task" } }));
  }
  fixtures.zcode.count = `${fixtures.zcode.runs.length} of ${fixtures.zcode.runs.length} total`;
  writeFileSync(fixturePath, JSON.stringify(fixtures));
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  for (const [name, stage] of [["contract-design", "DESIGN"], ["candidate-build", "BUILD"], ["independent-assurance", "ASSURE"]]) {
    const run = report.runs.find((r) => r.id === `dwfrun-${name}`);
    assert.equal(run.skill, "delivery-v1");
    assert.equal(run.stage, stage);
    assert.equal(run.attribution, "estimated");
  }
});

// ── 3a. DEV 加固线 workflow 名（legacy estimated 兜底归类）──
test("legacy 分类器：DEV 加固线六 workflow 名归 dev 三技能与阶段（wave-executor-dev 按 mode 分 D1/D3 无法估，归 (未归) 桶）；design-code-sync-v2 不入 DEV 名单仍归 dev-flow-v1", (t) => {
  const { home, runScript } = setupEnv(t);
  const fixturePath = join(home, "fixtures.json");
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  const devNames = [
    ["tech-review-loop-dev", "tech-design-dev", "T2"],
    ["wave-executor-dev", "dev-flow-dev", null],
    ["dev-consistency-loop-dev", "dev-flow-dev", "D2"],
    ["acceptance-design-dev", "delivery-dev", "DESIGN"],
    ["candidate-build-dev", "delivery-dev", "BUILD"],
    ["independent-assurance-dev", "delivery-dev", "ASSURE"],
  ];
  for (const [name] of devNames) {
    fixtures.zcode.runs.push(baseRun({ id: `dwfrun-${name}`, name, args: {} }));
  }
  // design-code-sync 两引擎跨代共用（dev 名单排除注释见实现分支 0）：
  // -v2 名不得被 DEV 名单吸走，防误登记回归
  fixtures.zcode.runs.push(baseRun({ id: "dwfrun-design-code-sync-v2", name: "design-code-sync-v2", args: {} }));
  fixtures.zcode.count = `${fixtures.zcode.runs.length} of ${fixtures.zcode.runs.length} total`;
  writeFileSync(fixturePath, JSON.stringify(fixtures));
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  for (const [name, skill, stage] of devNames) {
    const run = report.runs.find((r) => r.id === `dwfrun-${name}`);
    assert.ok(run, `${name} 在 runs 明细（正则失配会静默落入 unclassified）`);
    assert.equal(run.skill, skill);
    assert.equal(run.stage, stage);
    assert.equal(run.attribution, "estimated");
    const bucket = stage ?? "(未归)";
    assert.ok(report.bySkill[skill].stages[bucket], `${skill}/${bucket} 聚合桶存在`);
  }

  const sync = report.runs.find((r) => r.id === "dwfrun-design-code-sync-v2");
  assert.ok(sync, "design-code-sync-v2 在 runs 明细");
  assert.equal(sync.skill, "dev-flow-v1", "跨代共用引擎不属 dev 技能");
  assert.equal(sync.stage, "D5");
  assert.equal(sync.attribution, "estimated");
});

// ── 3b. run 级 token 对账三类 ──
function assertTokenInvariant(obj, path = "$") {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertTokenInvariant(v, `${path}[${i}]`));
    return;
  }
  if (!obj || typeof obj !== "object") return;
  if (typeof obj.input === "number" && typeof obj.output === "number" && typeof obj.total === "number") {
    assert.equal(obj.total, obj.input + obj.output, `${path} 恒等式 total=input+output`);
  }
  for (const v of Object.values(obj)) assertTokenInvariant(v, path);
}

test("token 对账：缺 actor 补差额、重复 session 去重不计会话、正常相等无多余记录", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  // 缺失 actor：run 级 77，无 actorRows → 差额记录补齐，usageAttribution 不得标 unknown
  const missing = report.runs.find((r) => r.id === "dwfrun-11");
  assert.equal(missing.usageAttribution, "estimated");
  assert.equal(missing.tokens.total, 77);

  // 重复 session：唯一 actor 110 + 差额 110 = 220 = run 级；会话数 2（s-dup 1 + 空 session 1）；
  // 时长保留相加 425s
  const d3 = report.bySkill["dev-flow-v1"].stages["D3"];
  assert.equal(d3.metrics.tokens.total, 77 + 110 + 110);
  assert.equal(d3.metrics.tokens.input, 77 + 100 + 100);
  assert.equal(d3.metrics.actorSessions, 2, "重复 session 只计一次；空 session 行按独立执行计");
  assert.equal(d3.metrics.actorDurationSum, 425_000, "重复行执行时长保留");
  assert.equal(d3.metrics.usageCoverage.unknown, 0, "run 级有 token 时不算 unknown");
  assert.equal(d3.metrics.usageCoverage.estimated, 2);

  const dup = report.runs.find((r) => r.id === "dwfrun-12");
  assert.equal(dup.usageAttribution, "estimated");
  assert.equal(dup.tokens.total, 220);
  assert.equal(dup.actorSessions, 2, "run 明细 actorSessions 与聚合口径一致（唯一 session 数）");
  const normal = report.runs.find((r) => r.id === "dwfrun-1");
  assert.equal(normal.actorSessions, 2, "不同 session 各计一次");

  // 正负混合差额（dwfrun-14：total 差 +10 但 input 差 -20）：不合成 reconcile，保留 actor 合计
  const mixed = report.runs.find((r) => r.id === "dwfrun-14");
  assert.ok(mixed, "正负混合 run 在 runs 明细");
  const d5 = report.bySkill["dev-flow-v1"].stages["D5"];
  assert.equal(d5.metrics.tokens.total, 130, "只计 actor 合计，混合差额不入账");
  assert.equal(report.dataQuality.tokenReconcileNegative, 1, "正负混合计入不可对账");
  assert.ok(
    report.dataQuality.details.some((d) => d.includes("dwfrun-14") && d.includes("token 不可对账")),
    "不可对账明细含 run id 与差额数字",
  );

  // 正常相等（dwfrun-1：run 级 230 = 唯一 actor 合计）无差额——D1 token 精确断言在 test 1 覆盖
  const d1 = report.bySkill["dev-flow-v1"].stages["D1"];
  assert.equal(d1.metrics.tokens.total, 242);

  // 全报告 tokens 恒满足 total=input+output（totals/bySkill/byTask/pivot/runs 全遍历）
  assertTokenInvariant(report);
});

// ── 3c. 观测事件 skill 引擎名归一 ──
test("事件 skill=tech-review-loop 归一 tech-design-v1：--skill 过滤下 observed run 出现", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--skill", "tech-design-v1", "--include-selftest", "--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const alias = report.runs.find((r) => r.id === "dwfrun-13");
  assert.ok(alias, "引擎名事件的 selftest run 在 runs 明细");
  assert.equal(alias.attribution, "observed", "executionId 精确关联");
  assert.equal(alias.skill, "tech-design-v1", "tech-review-loop → tech-design-v1");
  assert.equal(alias.stage, "T2");

  const t2 = report.bySkill["tech-design-v1"].stages["T2"];
  assert.equal(t2.metrics.attribution.observed, 2, "dwfrun-3 + dwfrun-13 两条 observed");
  assert.equal(t2.roles["简洁审"].actorSessions, 1, "简洁审席位角色");
  assert.ok(t2.metrics.tokens.total >= 58, "alias actor token 8 入桶");

  // 默认口径（排除 selftest）下同一 run 不出现
  const res2 = runScript(["--skill", "tech-design-v1", "--format", "json"]);
  assert.equal(res2.status, 0, res2.stderr);
  const report2 = JSON.parse(res2.stdout);
  assert.ok(!report2.runs.some((r) => r.id === "dwfrun-13"));
  assert.equal(report2.dataQuality.selftestRunsExcluded, 3);
});

// ── 3d. attempt null→1 回填配对（观测契约的正常回填形态）──
test("attempt 回填配对：setup start(null)/end(1) 正常成窗不误报，运行中 execution 未闭合仍报", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const pair = report.runs.find((r) => r.id === "dwfrun-15");
  assert.ok(pair, "attempt 回填 run 在 runs 明细");
  assert.equal(pair.attribution, "observed", "executionId 精确关联");
  assert.equal(pair.stage, "D4");

  // setup end(1) 已与 start(null) 配对（attempt 不参与身份匹配），不产生任何未配对报告；
  // 运行中 execution start 无 end 仍报（bad 文件孤儿 start 共 2 条）
  assert.equal(report.dataQuality.unpairedStarts, 2);
  assert.equal(report.dataQuality.unpairedEnds, 1);
  assert.ok(
    !report.dataQuality.details.some((d) => d.includes("pair-exec") && d.includes("D4|setup")),
    "pair-exec 的 setup 回填配对无误报（execution 未闭合属合法报告）",
  );

  const d4 = report.bySkill["dev-flow-v1"].stages["D4"];
  assert.ok(d4, "D4 桶存在");
  assert.equal(d4.metrics.attribution.observed, 1);
});

// ── 4. 手工段：耗时照报、token unknown（null 不写 0）──
test("手工 D0 段（无 run 匹配）：manualExecs 计数、tokens=null、耗时为窗口差", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  const d0 = report.bySkill["dev-flow-v1"].stages["D0"];
  assert.ok(d0, "D0 桶存在");
  assert.equal(d0.metrics.manualExecs, 2, "d0-manual + bad-events 两个手工执行");
  assert.equal(d0.metrics.tokens, null, "无用量证据 → null 不是 0");
  assert.equal(d0.metrics.tokensKnown, false);
  assert.equal(d0.metrics.durationSum, 600_000 + 4 * 60_000, "窗口差相加（8:00-8:10 + 7:01-7:05）");
  assert.ok(d0.metrics.elapsedMsUnion > 0);
  assert.equal(d0.metrics.usageCoverage.unknown, 2);
});

// ── 5. 坏数据显式报告 ──
test("坏 JSONL / 缺字段事件 / 未配对 start / 孤儿 end 显式计数且不崩", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const q = JSON.parse(res.stdout).dataQuality;
  assert.equal(q.badLines, 1);
  assert.equal(q.malformedEvents, 1);
  assert.equal(q.unpairedStarts, 2, "bad 文件孤儿 start + pair 文件运行中 execution start（setup 已配对不误报）");
  assert.equal(q.unpairedEnds, 1);
  assert.equal(q.runsWithoutObservation, 1);
  assert.ok(q.details.some((d) => d.includes("坏 JSONL 行")));
  assert.ok(q.details.some((d) => d.includes("ghost-exec")));
});

// ── 6. selftest 过滤 ──
test("selftest 缺省排除（args/事件/legacy 名称三通道），--include-selftest 计入", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  let report = JSON.parse(res.stdout);
  assert.equal(report.dataQuality.selftestRunsExcluded, 3, "冒烟名称 + args sampleType ×2");
  assert.ok(report.runsExcludedSelftest.some((r) => r.id === "dwfrun-7" && r.sampleTypeSource === "legacy-name"));
  assert.ok(report.runsExcludedSelftest.some((r) => r.id === "dwfrun-8" && r.sampleTypeSource === "run-args"));
  assert.ok(report.runsExcludedSelftest.some((r) => r.id === "dwfrun-13" && r.sampleTypeSource === "run-args"));
  assert.equal(report.dataQuality.selftestWindowsExcluded, 1, "selftest 执行文件窗口排除");
  assert.ok(!JSON.stringify(report.bySkill).includes("task-selftest"), "selftest 手工段不进统计");
  assert.ok(!("observed:task-selftest" in report.byTask), "selftest 手工段不进 byTask");

  const res2 = runScript(["--format", "json", "--include-selftest"]);
  assert.equal(res2.status, 0, res2.stderr);
  report = JSON.parse(res2.stdout);
  assert.equal(report.dataQuality.selftestRunsExcluded, 0);
  assert.equal(report.scope.includeSelftest, true);
  const d0 = report.bySkill["dev-flow-v1"].stages["D0"];
  assert.equal(d0.metrics.manualExecs, 3, "selftest 手工段随开关计入");
});

// ── 7. agentDir 去重 + run 去重 + 参数透传 ──
test("--pi-agent-dir realpath 去重；run 按 backend+id 去重；--since/--until 透传", (t) => {
  const { runScript, home, logPath } = setupEnv(t);
  const alias = join(home, "pi-agent-alias");
  const realDir = join(home, ".pi", "agent");
  mkdirSync(dirname(alias), { recursive: true });
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, alias, "dir");

  const res = runScript(["--format", "json", "--pi-agent-dir", alias, "--pi-agent-dir", realDir, "--since", "2026-05-01", "--until", "2026-05-31"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.scope.backends.length, 2, "zcode + 一个去重后的 pi 目录");
  assert.equal(report.scope.piAgentDirs.length, 1);

  const invocations = readLog(logPath);
  assert.equal(invocations.length, 2, "只调两次 CLI（zcode + pi）");
  assert.ok(invocations[0].includes("--zcode"));
  const piInvocation = invocations.find((a) => a.some((tok) => String(tok).startsWith("--pi=")));
  assert.ok(piInvocation.includes("--since") && piInvocation.includes("2026-05-01"));
  assert.ok(piInvocation.includes("--until") && piInvocation.includes("2026-05-31"));
  assert.ok(piInvocation.includes("--all") && piInvocation.includes("--json"));

  assert.equal(report.dataQuality.duplicateRunsDropped, 1, "重复 dwfrun-1 行去重");
  // 去重后 D1 token 不含重复行的 999999
  const d1 = report.bySkill["dev-flow-v1"].stages["D1"];
  assert.equal(d1.metrics.tokens.total, 242);
});

// ── 8. CLI 失败与坏输出 → 可操作错误 ──
test("CLI exit 1 / 非法 JSON 输出都报可操作错误 exit 1", (t) => {
  const { runScript } = setupEnv(t);
  const resErr = runScript([], { FAKE_CLI_MODE: "error" });
  assert.equal(resErr.status, 1);
  assert.match(resErr.stderr, /db_read_failed/);
  assert.match(resErr.stderr, /恢复动作/);

  const resGib = runScript([], { FAKE_CLI_MODE: "gibberish" });
  assert.equal(resGib.status, 1);
  assert.match(resGib.stderr, /不是合法 JSON/);
  assert.match(resGib.stderr, /恢复动作/);
});

// ── 9. 用法错误 fail-fast ──
test("未知参数 / 非法 --skill / 缺值 fail-fast exit 2；--help exit 0", (t) => {
  const { runScript } = setupEnv(t);
  const resUnknown = runScript(["--bogus"]);
  assert.equal(resUnknown.status, 2);
  assert.match(resUnknown.stderr, /未知参数/);
  assert.match(resUnknown.stderr, /恢复动作/);

  const resSkill = runScript(["--skill", "nope"]);
  assert.equal(resSkill.status, 2);
  assert.match(resSkill.stderr, /--skill 值非法/);

  const resFormat = runScript(["--format", "yaml"]);
  assert.equal(resFormat.status, 2);

  const resMissing = runScript(["--since"]);
  assert.equal(resMissing.status, 2);
  assert.match(resMissing.stderr, /缺值/);

  const resHelp = runScript(["--help"]);
  assert.equal(resHelp.status, 0);
  assert.match(resHelp.stdout, /用法/);
});

// ── 10. 输出形态 ──
test("table 输出含透视表与数据质量行；--output 落盘 JSON；--skill 过滤 bySkill", (t) => {
  const { runScript, home } = setupEnv(t);
  const resTable = runScript(["--group", "stage"]);
  assert.equal(resTable.status, 0, resTable.stderr);
  assert.match(resTable.stdout, /按 stage 汇总/);
  assert.match(resTable.stdout, /数据质量/);
  assert.match(resTable.stdout, /unclassified run：1 个/);
  assert.match(resTable.stdout, /unknown/);

  const outPath = join(home, "report.json");
  const resOut = runScript(["--format", "table", "--output", outPath]);
  assert.equal(resOut.status, 0, resOut.stderr);
  const saved = JSON.parse(readFileSync(outPath, "utf8"));
  assert.ok(saved.totals && saved.bySkill && saved.pivot && saved.dataQuality);

  const resSkill = runScript(["--skill", "dev-flow-v1", "--format", "json"]);
  assert.equal(resSkill.status, 0, resSkill.stderr);
  const skillReport = JSON.parse(resSkill.stdout);
  assert.deepEqual(Object.keys(skillReport.bySkill), ["dev-flow-v1"]);
  // bySkill 过滤不影响 totals 之外的 unclassified 独立计数
  assert.equal(skillReport.unclassified.count, 1);
});

// ── 11. 空数据 exit 1 ──
test("两后端零匹配且观测根为空 → exit 1 带恢复动作", (t) => {
  const home = mkdtempSync(join(tmpdir(), "sus-test-empty-"));
  const binDir = mkdtempSync(join(tmpdir(), "sus-test-empty-bin-"));
  makeFakeCli(binDir);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const fixturePath = join(home, "fixtures.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      zcode: { count: "0 of 0 total", backend: "zcode", runs: [], totals: {}, skipped: {} },
      pi: { count: "0 of 0 total", backend: "pi", runs: [], totals: {}, skipped: {} },
    }),
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--format", "json"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}`, FAKE_FIXTURE_PATH: fixturePath, FAKE_CLI_LOG: "", FAKE_CLI_MODE: "ok" },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /没有任何数据/);
    assert.match(res.stderr, /恢复动作/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ── 12. 技能版本分组（--group skillVersion）与 unknown 桶自洽 ──
test("--group skillVersion：observed 读事件、estimated 读产物；老 JSONL 与产物缺失归 unknown 且与 dataQuality 自洽", (t) => {
  const { runScript } = setupEnv(t);
  const res = runScript(["--format", "json", "--group", "skillVersion"]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  // 分组键 = skillVersion；版本桶含两个 observed 版本、一个 estimated 版本与 unknown
  assert.deepEqual(report.pivot.groups, ["skillVersion"]);
  const row = (v) => report.pivot.rows.find((r) => r.dims.skillVersion === v);
  for (const v of ["0.1.0", "0.2.0", "0.3.0", "unknown"]) assert.ok(row(v), `版本桶 ${v} 应存在`);

  // observed 口径 = 事件自带 skill_version（D1 两次 attempt 0.2.0；T2 0.1.0）
  const d1 = report.runs.find((r) => r.id === "dwfrun-1");
  assert.equal(d1.skillVersion, "0.2.0");
  assert.equal(d1.skillVersionSource, "observed-event");
  const t2 = report.runs.find((r) => r.id === "dwfrun-3");
  assert.equal(t2.skillVersion, "0.1.0");

  // estimated 口径 = run 参数指向产物：execPlan 顶层字段 / designDoc 同级 meta.json
  const d2 = report.runs.find((r) => r.id === "dwfrun-4");
  assert.equal(d2.skillVersion, "0.1.0");
  assert.equal(d2.skillVersionSource, "artifact:execPlan");
  const d5 = report.runs.find((r) => r.id === "dwfrun-14");
  assert.equal(d5.skillVersion, "0.3.0");
  assert.equal(d5.skillVersionSource, "artifact:designDoc");

  // RL6 老 JSONL（无 skill_version）：observed run 与手工段都归 unknown 桶，不抛错
  const pair = report.runs.find((r) => r.id === "dwfrun-15");
  assert.equal(pair.skillVersion, "unknown");
  assert.equal(pair.skillVersionSource, "unknown-observed");
  assert.equal(report.dataQuality.skillVersionUnknownObserved, 1);
  assert.equal(report.dataQuality.skillVersionUnknownManualExecs, 2, "d0-manual + bad-events 两个老 JSONL 手工段");
  assert.ok(report.dataQuality.details.some((d) => d.includes("老 JSONL")), "老数据归桶向 dataQuality 披露");

  // estimated 读产物失败/缺字段：显式计数、不崩
  assert.equal(report.dataQuality.artifactVersionReadFailed, 2, "ghost-exec + dwfrun-11 的产物文件缺失");
  assert.equal(report.dataQuality.artifactVersionMissingField, 1, "dwfrun-12 的产物无 skillVersion 字段");
  assert.equal(report.dataQuality.skillVersionUnknownEstimated, 6, "无产物来源（含 pi 的 PR 生命周期 run）/读失败/缺字段共入 unknown 桶");
  const unknownRow = row("unknown");
  assert.equal(
    unknownRow.metrics.runs,
    report.dataQuality.skillVersionUnknownObserved + report.dataQuality.skillVersionUnknownEstimated,
    "unknown 桶的 run 数 = observed/estimated 两档 unknown 计数之和",
  );
  assert.equal(unknownRow.metrics.manualExecs, report.dataQuality.skillVersionUnknownManualExecs, "unknown 桶手工段数与 dataQuality 自洽");
  assert.ok(report.dataQuality.details.some((d) => d.includes("产物版本读取失败")), "读失败向 dataQuality 披露");
  assert.ok(report.dataQuality.details.some((d) => d.includes("缺 skillVersion 字段")), "缺字段向 dataQuality 披露");

  // 跨版本对比：byTask 同 taskId 含版本列（同任务的两次 D1 与 T2 跨 0.1.0/0.2.0）
  assert.deepEqual(report.byTask["observed:task-a"].skillVersions, ["0.1.0", "0.2.0"]);

  // table 形态输出版本分组列与版本 unknown 计数
  const resTable = runScript(["--group", "skillVersion"]);
  assert.equal(resTable.status, 0, resTable.stderr);
  assert.match(resTable.stdout, /按 skillVersion 汇总/);
  assert.match(resTable.stdout, /unknown/);
  assert.match(resTable.stdout, /技能版本 unknown/);
});

// ── 14. 继承（seed）口径：seed-only run = 已知零新生消耗；unknown run 全零 actor 不置 tokensKnown ──
test("seed-only run 不归 unknown 且继承量不双计；unknown run 的全零 actor 不污染桶 tokensKnown", (t) => {
  const home = mkdtempSync(join(tmpdir(), "sus-seed-home-"));
  const binDir = mkdtempSync(join(tmpdir(), "sus-seed-bin-"));
  makeFakeCli(binDir);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const fixturePath = join(home, "fixtures.json");
  // seed-only：重发后未产生新生成——新生 0、继承 500（继承只在 CLI 侧披露，stats 不得加回）
  const seedRun = baseRun({
    id: "dwfrun-seed",
    name: "task-seed D1 开发循环",
    args: { execPlan: "/p/exec-plan.json" },
    tokensTotal: 0,
    tokensTotalInherited: 500,
    actorRows: [
      actorRow({ name: "u-seed", session: "sess-seed", timeStart: T(10, 0), timeEnd: T(10, 1), durationMs: 60_000, tokensTotal: 0, tokensTotalInherited: 500 }),
    ],
  });
  // unknown：无继承、新生 0、actor 行全零——全零记录不是用量证据
  const zeroRun = baseRun({
    id: "dwfrun-zero",
    name: "task-zero D3 端到端验收",
    args: { execPlan: "/p/exec-plan.json" },
    tokensTotal: 0,
    actorRows: [
      actorRow({ name: "u-zero", session: "sess-zero", timeStart: T(12, 0), timeEnd: T(12, 1), durationMs: 60_000, tokensTotal: 0 }),
    ],
  });
  writeFileSync(fixturePath, JSON.stringify({
    zcode: { count: "2 of 2 total", backend: "zcode", runs: [seedRun, zeroRun], totals: { runs: 2, tokensTotal: 0 }, skipped: {} },
    pi: { count: "0 of 0 total", backend: "pi", runs: [], totals: {}, skipped: {} },
  }));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });
  const res = spawnSync(process.execPath, [SCRIPT, "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}`, FAKE_FIXTURE_PATH: fixturePath, FAKE_CLI_MODE: "ok" },
  });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);

  // seed-only：已知零新生消耗（estimated 非 unknown），继承 500 不进任何合计
  const seed = report.runs.find((r) => r.id === "dwfrun-seed");
  assert.equal(seed.usageAttribution, "estimated");
  const d1 = report.bySkill["dev-flow-v1"].stages["D1"];
  assert.equal(d1.metrics.tokensKnown, true, "seed-only 有继承证据 → 已知零新生，tokens 写 0 而非 null");
  assert.equal(d1.metrics.tokens.total, 0, "继承量 500 不得加回（跨 run 双计防线）");
  assert.equal(d1.metrics.usageCoverage.unknown, 0);
  assert.equal(report.totals.tokens.total, 0, "totals 不含继承量");

  // unknown：D3 桶只有全零 actor 的 unknown run → tokensKnown=false（JSON null），不得被写成 0
  const zero = report.runs.find((r) => r.id === "dwfrun-zero");
  assert.equal(zero.usageAttribution, "unknown");
  const d3 = report.bySkill["dev-flow-v1"].stages["D3"];
  assert.equal(d3.metrics.tokensKnown, false, "unknown run 的全零 actor 不置 tokensKnown");
  assert.equal(d3.metrics.tokens, null);
  assert.equal(d3.metrics.usageCoverage.unknown, 1);
});
