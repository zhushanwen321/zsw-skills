// fake-agent-simulator.mjs — 脚本化 reporter/fixer/arbiter/integrator/main-agent 模拟器（U1/M1 测试基座）
//
// 职责（设计 OPT1 / V11）：按脚本回放观察/补丁/判断为命令序列，替代真实模型——
// 不发起任何网络调用、不读模型凭据、纯同步确定性；同脚本重复回放产出逐字节相同。
// 消费方式：simulator.run().commands 交 kernel/state-repo.appendCommands（或测试内 commandToFact）。
// M4 引擎端到端复跑（V1-V15 场景）复用本模拟器驱动。

import { validateCommand } from "../kernel/facts.mjs";

/**
 * 构造模拟器。script 步骤形态：
 *   { role: "reporter"|"fixer"|"arbiter"|"checker"|"integrator"|"main-agent",
 *     actor: 非空字符串（缺省取 role）,
 *     command: { type: <COMMAND_TYPES 词表>, payload: {...} } }
 * run() 返回 { commands, calls }：
 *   commands — 词表命令数组（actor 已装配），可直接进 appendCommands
 *   calls    — 调用轨迹 [{ index, role, actor, type }]（供断言「派发了几次、发给谁」）
 */
export function createSimulator(script) {
  if (!Array.isArray(script) || script.length === 0) {
    const err = new Error("模拟器脚本必须是非空步骤数组。恢复动作：检查夹具 script 字段形态。");
    err.code = "invalid-simulator-script";
    throw err;
  }
  let started = false;
  return {
    run() {
      if (started) {
        // 防御共享脚本对象被并发回放污染：每次回放通过独立实例进行
        started = false;
      }
      const commands = [];
      const calls = [];
      script.forEach((step, index) => {
        if (!step || typeof step !== "object" || !step.command) {
          const err = new Error(`脚本步骤 ${index} 缺 command 字段。恢复动作：每步形如 { role, command: { type, payload } }。`);
          err.code = "invalid-simulator-step";
          throw err;
        }
        const cmd = {
          type: step.command.type,
          actor: step.actor ?? step.command.actor ?? step.role,
          payload: step.command.payload ?? {},
        };
        const check = validateCommand(cmd);
        if (!check.ok) {
          const err = new Error(`模拟器步骤 ${index}（role=${step.role}）命令未过词表校验：${check.errors.join("；")}`);
          err.code = "invalid-simulator-command";
          throw err;
        }
        commands.push(cmd);
        calls.push({ index, role: step.role, actor: cmd.actor, type: cmd.type });
      });
      started = true;
      return { commands, calls };
    },
  };
}
