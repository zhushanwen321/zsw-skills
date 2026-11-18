// helpers/node-stub.mjs — 测试内进程内执行 node 桩脚本的共享工具（非测试文件，不被
// node --test 的 *.test.mjs 收集模式匹配）
//
// 背景：被测脚本以 spawnSync 调 PATH 上的命令行桩（测试自写的 CJS 脚本）或 `node -e`
// 探针，单次 spawn 17-130ms。本工具把桩源码在测试进程内 vm 执行（mock process/env），
// 返回形态与 spawnSync 逐字段对齐；git 等非 node 命令仍走真实 spawnSync。
// 语义对齐点（与真实 spawn 子进程一致）：argv 形态（-e 无脚本槽位 / 文件形态 argv[1]=路径）、
// env 注入、os.homedir() 读 $HOME、未捕获异常退出码 1 + 堆栈进 stderr、process.exit 立即终止。

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

class StubExitSignal {}
const STUB_EXIT = new StubExitSignal();
// 桩源码高度复用（同一桩脚本被多次调用），编译结果按源码串缓存
const compileCache = new Map();

/**
 * 进程内等价执行一段 node 桩脚本（node -e 或 node <file> 语义）。
 * @param {string} script 桩源码（CJS 语法——vm.Script 不认 ESM import 语句）
 * @param {string[]} args 桩的命令行参数（不含 node 路径与脚本路径）
 * @param {{env?: object, cwd?: string, scriptPath?: string, nodeArgs?: string[]}} opts
 *   env = 桩可见环境（缺省继承测试进程）；scriptPath 给出时 argv[1] = 脚本路径（文件形态）
 * @returns {{status: number, stdout: string, stderr: string}} spawnSync 形态
 */
export function runNodeScript(script, args, { env = process.env, cwd = process.cwd(), scriptPath } = {}) {
  const argv = [process.execPath, ...(scriptPath !== undefined ? [scriptPath] : []), ...args];
  let stdout = "";
  let stderr = "";
  let status = 0;
  const ctx = {
    require: (id) => {
      if (id === "os" || id === "node:os") {
        // 子进程语义：os.homedir() 读 $HOME——env 注入 HOME 后 homedir() 要跟注值一致
        const mod = require(id);
        const wrapped = Object.create(mod);
        wrapped.homedir = () => env.HOME ?? mod.homedir();
        return wrapped;
      }
      return require(id);
    },
    console: {
      log: (...m) => { stdout += m.map(String).join(" ") + "\n"; },
      error: (...m) => { stderr += m.map(String).join(" ") + "\n"; },
    },
    process: {
      argv,
      env,
      platform: process.platform,
      cwd: () => cwd,
      stdout: { write: (s) => { stdout += String(s); return true; } },
      stderr: { write: (s) => { stderr += String(s); return true; } },
      exit: (c) => {
        status = typeof c === "number" ? c : 0;
        throw STUB_EXIT;
      },
    },
    module: { exports: {} },
    exports: {},
    __filename: scriptPath ?? "",
    __dirname: scriptPath !== undefined ? dirname(scriptPath) : cwd,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  };
  ctx.globalThis = ctx;
  // shebang 首行 strip：node 运行文件时自动去掉，vm.Script 不会（桩脚本常带 #! 头）
  const stripped = script.startsWith("#!") ? script.slice(script.indexOf("\n") + 1) : script;
  let fn = compileCache.get(stripped);
  if (fn === undefined) {
    // node -e 允许顶层 return——包一层函数使其在 vm 中合法（语义 = 从模块 wrapper 返回）
    fn = new vm.Script(`(function(){\n${stripped}\n})`);
    compileCache.set(stripped, fn);
  }
  try {
    fn.runInNewContext(ctx)();
  } catch (e) {
    if (e instanceof StubExitSignal) {
      // process.exit 模拟：退出码已在 ctx.process.exit 记录
    } else {
      // 未捕获异常对齐真实 node：退出码 1、堆栈进 stderr（不逃逸异常进测试进程）
      stderr += String(e && e.stack ? e.stack : e) + "\n";
      status = 1;
    }
  }
  return { status, stdout, stderr };
}

/**
 * 构造 spawnSync 形态的可调用桩分发器：cmd 命中 scripts 表时进程内执行桩源码，否则真实 spawnSync。
 * @param {Record<string, string|((cmd: string, args: string[]) => string|null)>} scripts
 *   cmd 名 → 桩源码，或按 cmd/args 返回桩源码（null = 回退真实 spawn）
 * @param {{env?: object, cwd?: string}} opts 真实 spawn 分支与桩 env/cwd 缺省值
 */
export function makeStubSpawn(scripts, { env = process.env, cwd } = {}) {
  return (cmd, args, opts = {}) => {
    const a = args ?? [];
    if (cmd === "node" || cmd === process.execPath) {
      if (a[0] === "-e" && typeof a[1] === "string") {
        const r = runNodeScript(a[1], a.slice(2), { env, cwd });
        return { ...r, error: undefined };
      }
    }
    const source = typeof scripts[cmd] === "function" ? scripts[cmd](cmd, a) : scripts[cmd];
    if (typeof source === "string") {
      // scriptPath 用合成占位（argv[1] = 桩路径槽位，对齐真实 CLI 调用形态）；桩不读
      // __filename，真实磁盘路径不可得也无消费者
      const r = runNodeScript(source, a, { env, cwd, scriptPath: `[stub] ${cmd}` });
      return { ...r, error: undefined };
    }
    const r = spawnSync(cmd, a, { encoding: "utf8", cwd, ...opts, env: { ...env, ...(opts.env ?? {}) } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}
