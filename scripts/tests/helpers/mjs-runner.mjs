// helpers/mjs-runner.mjs — ESM CLI 脚本进程内执行器（非测试文件，不被 node --test 收集）
//
// 背景：v6 消费方脚本（compile-exec-plan / check-exec-plan / gen-acceptance-wrapper /
// verification-index / render-impl-plan 等）是 ESM 单文件 CLI，测试逐用例 spawn 每次
// 40-130ms，且脚本内部还嵌套 spawn 子脚本（校验器 / wrapper 生成器 / 索引构建器）。
// 本执行器把 ESM 源码转译为 CJS 后在 vm 沙箱内跑：零改动被测脚本，语义对齐点——
//   argv 形态（argv[1] = 脚本真实路径）、env 注入（HOME 重定向）、os.homedir() 读 $HOME、
//   import.meta.url = 脚本真实路径（模块尾 isMain 判定照常成立）、未捕获异常退出码 1 +
//   堆栈进 stderr、process.exit 立即终止（异常模拟，退出码契约不变）、process.exitCode
//   属性赋值退出（delivery-gate v4/v5 整包 catch 的失败路径，桩上承载该语义）。
// 脚本内部 require("./xxx.mjs") 走 Node 的 require(esm) 同步加载（脚本均无顶层 await）。
// 适用边界：process.exit 以异常模拟——若脚本 main 为整包 catch（业务失败与 exit 模拟
// 异常无法区分），退出语义失真，此类脚本不可转译（migrate-skill-data 先例），只能保留 spawn。
// 顶层 await（TLA）脚本走 runMjsScriptAsync 第二路径：静态 import 文本转 require + 整包
// async IIFE 包裹 + await 求值（v5 delivery-core 顶层分发先例）。

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { spawnSync as realSpawnSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

class RunnerExitSignal {}
const RUNNER_EXIT = new RunnerExitSignal();
// 同一脚本被多用例重复执行，转译结果按文件路径缓存（测试进程生命周期内脚本只读）
const compileCache = new Map();

/** 转译并编译一次，返回 vm.Script（每次执行在独立沙箱求值——裸全局引用（process/console）
 *  必须落在注入沙箱，不能用 runInThisContext：其求值函数的作用域链指向主进程真实全局）。
 *  含顶层 await 的脚本（CJS 化后非法）缓存 null，调用方回退真实 spawnSync */
function compileMjs(file) {
  let script = compileCache.get(file);
  if (script === undefined) {
    const src = readFileSync(file, "utf8");
    const stripped = src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
    // import.meta 在 CJS 输出中是语法错误——脚本全部使用 .url 形态，替换为注入桩
    const replaced = stripped.split("import.meta.url").join("__stubImportMeta.url");
    const js = ts.transpileModule(replaced, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const wrapper = `(function (exports, require, module, __filename, __dirname, __stubImportMeta) {\n${js}\n})`;
    try {
      script = new vm.Script(wrapper, { filename: file });
    } catch (e) {
      // 顶层 await（如 isMain 块内的 await main()）CJS 化后非法——标记不可转译，回退 spawn
      if (String(e && e.message).includes("await is only valid")) script = null;
      else throw e;
    }
    compileCache.set(file, script);
  }
  return script;
}

/** 构建一次执行用的沙箱上下文（同步/TLA 两路径共用）。
 *  退出语义优先级：stub exit()（立即终止，异常模拟）＞ 脚本显式 process.exitCode 赋值
 *  （整包 catch 的正常失败路径）＞ 未捕获异常（退出码 1）＞ 0 */
function buildExecutionContext(fileReal, args, { env = process.env, cwd = process.cwd(), spawn } = {}) {
  let stdout = "";
  let stderr = "";
  let status = 0;
  let exitCodeValue;
  let exited = false;
  let failed = false;
  const mergedEnv = { ...process.env, ...env };
  const localRequire = createRequire(pathToFileURL(fileReal).href);
  const ctxRequire = (id) => {
    if (id === "node:child_process" || id === "child_process") {
      const mod = localRequire(id);
      const wrapped = Object.create(mod);
      wrapped.spawnSync = spawn ?? mod.spawnSync;
      return wrapped;
    }
    if (id === "node:os" || id === "os") {
      // 子进程语义：os.homedir() 读 $HOME（env 注入 HOME 后跟注值一致）
      const mod = localRequire(id);
      const wrapped = Object.create(mod);
      wrapped.homedir = () => mergedEnv.HOME ?? mod.homedir();
      return wrapped;
    }
    const mod = localRequire(id);
    // ESM→CJS 互操作：TS 转译的默认导入（import x from "node:vm"）直接访问 .default——
    // 内置模块经 require 返回 CJS 对象无 default，补原型链包装（命名属性走原型链不变）
    if (id.startsWith("node:") && !("default" in mod)) {
      const wrapped = Object.create(mod);
      wrapped.default = mod;
      return wrapped;
    }
    return mod;
  };
  const ctx = {
    __stubImportMeta: { url: pathToFileURL(fileReal).href },
    require: ctxRequire,
    console: {
      log: (...m) => { stdout += m.map(String).join(" ") + "\n"; },
      error: (...m) => { stderr += m.map(String).join(" ") + "\n"; },
    },
    process: {
      argv: [process.execPath, fileReal, ...args],
      env: mergedEnv,
      execPath: process.execPath,
      platform: process.platform,
      // 脚本登记进程身份用（租约/锁 owner/原子写临时文件名），真实主进程 pid——
      // delivery-gate 的 readLease 以 Number.isInteger(pid) 校验记录完整性，缺桩会让
      // 写入的 undefined 被 JSON.stringify 丢弃、租约被判损坏
      pid: process.pid,
      cwd: () => cwd,
      get exitCode() { return exitCodeValue; },
      // 脚本整包 catch 用属性赋值退出（如 delivery-gate 的 process.exitCode = exitCode）
      set exitCode(v) { exitCodeValue = typeof v === "number" ? v : 0; },
      stdout: { write: (s) => { stdout += String(s); return true; } },
      stderr: { write: (s) => { stderr += String(s); return true; } },
      exit: (c) => {
        status = typeof c === "number" ? c : 0;
        exited = true;
        throw RUNNER_EXIT;
      },
    },
    module: { exports: {} },
    exports: {},
    __filename: fileReal,
    __dirname: dirname(fileReal),
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  ctx.globalThis = ctx;
  return {
    ctx,
    ctxRequire,
    reportError(e) {
      failed = true;
      stderr += String(e && e.stack ? e.stack : e) + "\n";
    },
    finish() {
      if (failed) status = 1;
      else if (!exited) status = exitCodeValue ?? 0;
      return { status, stdout, stderr };
    },
  };
}

/**
 * 注入 env 的宿主临时应用：把调用方显式传入的 env 键值写到真实 process.env，返回恢复函数。
 * 为什么需要：沙箱内脚本经 require(esm) 加载的本地依赖（如 v6 复扫库）运行在真实模块层，
 * 其内部 spawnSync 启动的孙进程继承的是真实 process.env——沙箱 mergedEnv 的注入变量到不了
 * 那里（contract-rescan detector 继承真实 HOME、丢失 fixture 注入的失真先例）。宿主临时应用
 * 后孙进程继承链恢复真实 CLI 语义（CLI 流程里这些变量本来就在子进程 env 中）。
 * node:test 同文件串行执行（默认并发关闭），窗口内无并发读取方；脚本全部同步 spawn，无跨恢复点泄漏。
 */
function applyEnvToHost(envOverrides) {
  const saved = [];
  for (const [k, v] of Object.entries(envOverrides)) {
    saved.push([k, Object.hasOwn(process.env, k) ? process.env[k] : undefined]);
    process.env[k] = v;
  }
  return () => {
    for (const [k, old] of saved) {
      if (old === undefined) delete process.env[k];
      else process.env[k] = old;
    }
  };
}

/**
 * 进程内等价执行一个 ESM CLI 脚本（同步脚本；TLA 脚本用 runMjsScriptAsync）。
 * @param {string} file 脚本绝对路径
 * @param {string[]} args 命令行参数（不含 node 路径与脚本路径）
 * @param {{env?: object, cwd?: string, spawn?: (cmd, args, opts) => spawnSync 形态}} opts
 *   spawn 注入脚本内部的 child_process.spawnSync（缺省真实 spawnSync）
 * @returns {{status: number, stdout: string, stderr: string}} spawnSync 形态
 */
export function runMjsScript(file, args, opts = {}) {
  const fileReal = realpathSync(file);
  const script = compileMjs(fileReal);
  // 顶层 await 脚本不可 CJS 化——正常应走 runMjsScriptAsync；此处保底回退真实 spawn
  if (script === null) {
    const r = realSpawnSync(process.execPath, [fileReal, ...args], {
      encoding: "utf8", cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...(opts.env ?? process.env) },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  }
  const ex = buildExecutionContext(fileReal, args, opts);
  const restoreEnv = opts.env !== undefined ? applyEnvToHost(opts.env) : null;
  try {
    const fn = script.runInNewContext(ex.ctx);
    fn(ex.ctx.exports, ex.ctxRequire, ex.ctx.module, fileReal, ex.ctx.__dirname, ex.ctx.__stubImportMeta);
  } catch (e) {
    if (!(e instanceof RunnerExitSignal)) ex.reportError(e);
  } finally {
    restoreEnv?.();
  }
  return ex.finish();
}

// ── TLA（顶层 await）脚本路径 ──
// TS 的 CommonJS 转译对顶层 await 直接报错。第二路径：静态 import 文本转 require（行首
// 锚定语句位置，不碰模板字符串/注释里的 import 字样）+ 整包 async IIFE 包裹（顶层 await
// 在 async 函数体内合法）+ await 求值 Promise。ctxRequire 注入与同步路径完全一致。
// 适用边界：发现 export 声明或转换后仍编译失败即放弃（回退真实 spawnSync）；process.exit
// 的异常模拟若被脚本整包 catch 吞掉，退出码失真——此类用例保留 spawn 锚。
const compileAsyncCache = new Map();
function compileMjsAsync(file) {
  let script = compileAsyncCache.get(file);
  if (script === undefined) {
    const src = readFileSync(file, "utf8");
    const stripped = src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
    const replaced = stripped.split("import.meta.url").join("__stubImportMeta.url")
      // 动态 import 在 vm 经典 Script 里无 importModuleDynamically 回调会抛错——字面量描述符
      // 场景转 Promise+require（delivery-core v5 的 await import("node:child_process") 先例）
      .replace(/await\s+import\(\s*("[^"]+"|'[^']+')\s*\)/g, "Promise.resolve().then(() => require($1))");
    const converted = replaced.replace(
      /(^|\n)(import\s*\{[\s\S]*?\}\s*from\s*"[^"]+"\s*;?|import\s*\*\s*as\s*\w+\s*from\s*"[^"]+"\s*;?|import\s*\w+\s*,\s*\{[\s\S]*?\}\s*from\s*"[^"]+"\s*;?|import\s*\w+\s*from\s*"[^"]+"\s*;?)/g,
      (whole, lead, stmt) => {
        const m = stmt.match(/^import\s+([\s\S]*?)\s*from\s*("[^"]+")\s*;?$/);
        const clause = m[1];
        const req = `require(${m[2]});`;
        if (clause.startsWith("{")) return `${lead}const ${clause} = ${req}`;
        const ns = clause.match(/^\*\s*as\s+(\w+)$/);
        if (ns) return `${lead}const ${ns[1]} = ${req}`;
        const both = clause.match(/^(\w+)\s*,\s*\{([\s\S]*?)\}$/);
        if (both) return `${lead}const ${both[1]} = ${req}\n${lead}const {${both[2]}} = ${req}`;
        return `${lead}const ${clause} = ${req}`;
      },
    );
    if (/^\s*(import|export)\b/m.test(converted)) {
      script = null; // 转换面之外仍有 import/export 声明——放弃
    } else {
      const wrapper = `(async function (exports, require, module, __filename, __dirname, __stubImportMeta) {\n${converted}\n})`;
      try {
        script = new vm.Script(wrapper, { filename: file });
      } catch {
        script = null;
      }
    }
    compileAsyncCache.set(file, script);
  }
  return script;
}

/** TLA 脚本进程内执行（spawnSync 形态结果同 runMjsScript）。不可转换时回退真实 spawnSync。 */
export async function runMjsScriptAsync(file, args, opts = {}) {
  const fileReal = realpathSync(file);
  const script = compileMjsAsync(fileReal);
  if (script === null) {
    const r = realSpawnSync(process.execPath, [fileReal, ...args], {
      encoding: "utf8", cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...(opts.env ?? process.env) },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  }
  const ex = buildExecutionContext(fileReal, args, opts);
  const restoreEnv = opts.env !== undefined ? applyEnvToHost(opts.env) : null;
  try {
    const fn = script.runInNewContext(ex.ctx);
    const p = fn(ex.ctx.exports, ex.ctxRequire, ex.ctx.module, fileReal, ex.ctx.__dirname, ex.ctx.__stubImportMeta);
    if (p && typeof p.then === "function") await p;
  } catch (e) {
    if (!(e instanceof RunnerExitSignal)) ex.reportError(e);
  } finally {
    restoreEnv?.();
  }
  return ex.finish();
}

/**
 * spawnSync 形态分发器：node 调用（-e 探针 / .mjs 子脚本）进程内执行，git 等真实 spawn。
 * @param {{mjs?: string[], env?: object, cwd?: string}} opts mjs = 允许进程内执行的
 *   .mjs 子脚本绝对路径白名单（COMPILER 内部 spawn 的 CHECKER/GEN_WRAPPER/VERIFY_INDEX）；
 *   不在白名单的 .mjs 与非 node 命令回退真实 spawnSync
 */
export function makeMjsStubSpawn({ mjs = [], env = process.env, cwd } = {}) {
  const mjsSet = new Set(mjs);
  return (cmd, args, opts = {}) => {
    const a = args ?? [];
    if (cmd === "node" || cmd === process.execPath) {
      if (a[0] === "-e" && typeof a[1] === "string") {
        const r = runNodeProbe(a[1], a.slice(2), { env, cwd: cwd ?? process.cwd() });
        return { ...r, error: undefined };
      }
      const target = a[0];
      if (typeof target === "string" && target.endsWith(".mjs") && mjsSet.has(target)) {
        const r = runMjsScript(target, a.slice(1), { env, cwd: cwd ?? process.cwd(), spawn: makeMjsStubSpawn({ mjs, env, cwd }) });
        return { ...r, error: undefined };
      }
    }
    const r = realSpawnSync(cmd, a, { encoding: "utf8", cwd, ...opts, env: { ...env, ...(opts.env ?? {}) } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

// node -e 探针进程内执行（与 node-stub.mjs 的 runNodeScript 同语义；此处内联一份避免
// helper 相互依赖——探针形态简单，env 沿用合并后的环境）
const probeCache = new Map();
function runNodeProbe(script, restArgs, { env, cwd }) {
  let stdout = "";
  let stderr = "";
  let status = 0;
  const ctx = {
    require: createRequire(pathToFileURL(joinPath(cwd, "x")).href),
    console: {
      log: (...m) => { stdout += m.map(String).join(" ") + "\n"; },
      error: (...m) => { stderr += m.map(String).join(" ") + "\n"; },
    },
    process: {
      argv: [process.execPath, ...restArgs],
      env,
      platform: process.platform,
      cwd: () => cwd,
      stdout: { write: (s) => { stdout += String(s); return true; } },
      stderr: { write: (s) => { stderr += String(s); return true; } },
      exit: (c) => {
        status = typeof c === "number" ? c : 0;
        throw RUNNER_EXIT;
      },
    },
    Buffer,
  };
  ctx.globalThis = ctx;
  let fn = probeCache.get(script);
  if (fn === undefined) {
    fn = new vm.Script(`(function(){\n${script}\n})`);
    probeCache.set(script, fn);
  }
  try {
    fn.runInNewContext(ctx)();
  } catch (e) {
    if (!(e instanceof RunnerExitSignal)) {
      stderr += String(e && e.stack ? e.stack : e) + "\n";
      status = 1;
    }
  }
  return { status, stdout, stderr };
}
