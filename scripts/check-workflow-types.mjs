#!/usr/bin/env node
// check-workflow-types.mjs — 用真实平台 facade 声明对四个 zcode 产物跑 tsc strict
//
// 背景（2026-09-26）：自制 stub 曾把 agent().ask 声明为 Promise<T>，而真实 facade 返回
// Node<T>（仅 PromiseLike，无 catch/finally）——17 处 askValidated 调用点的 TS2739 被
// 漏检，saved workflow 发起即被平台编译拦截。本脚本以 scripts/wf-facade.d.ts 快照为准。
//
// 编译形态对齐平台：产物是顶层 await/return 的容器脚本，平台在函数体内编译——这里同样
// 包进 async 函数体；四个产物互为全局脚本（无 import/export），同程序会撞全局名，
// 须逐产物独立编译。
//
// 用法：node scripts/check-workflow-types.mjs（退出码非 0 = 有类型错误）

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, "skills/self/dev-workflow/workflows");
const NAMES = ["tech-review-loop", "wave-executor", "dev-consistency-loop", "design-code-sync-loop"];

const ts = createRequire(import.meta.url)("typescript");

const facade = readFileSync(join(ROOT, "scripts", "wf-facade.d.ts"), "utf8");
const tmp = join(tmpdir(), `dwf-typecheck-${process.pid}`);
mkdirSync(tmp, { recursive: true });

let failed = 0;
try {
  for (const name of NAMES) {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    const body = readFileSync(join(WF, `${name}.dwf.ts`), "utf8");
    writeFileSync(join(dir, "w.ts"), `async function __dwf_main() {\n${body}\n}\n`);
    writeFileSync(join(dir, "facade.d.ts"), facade);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2023"],
          types: [],
          skipLibCheck: false,
        },
        include: ["w.ts", "facade.d.ts"],
      }),
    );
    const raw = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length === 0) {
      console.log(`${name}: tsc strict OK`);
      continue;
    }
    failed += 1;
    for (const d of errors) {
      const pos = d.file
        ? `w.ts(${ts.getLineAndCharacterOfPosition(d.file, d.start ?? 0).line + 1})`
        : "(无位置)";
      console.error(`${name}: ${pos}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed > 0 ? 1 : 0);
