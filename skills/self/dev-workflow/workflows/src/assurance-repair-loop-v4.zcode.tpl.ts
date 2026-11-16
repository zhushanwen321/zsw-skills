/* zcode-workflow
description: delivery-v4 技能 ASSURE 段受控修复循环：独立聚合给出来源阶段、受影响断言和
  回归测试，builder 修复产品代码与测试，独立 reviewer 做受影响一致性复核，最后以
  recheck 重跑确定性测试并生成当前版本证据。RepairRoundRecorded 记录实现性修复，
  第 4 轮或第 11 条不同 must-fix 进入 process-failed；不默认重新开放探索
whenToUse: 最终保证出现实现缺陷时使用；必传 projectRoot / taskDir /
  assuranceCredentialId / builderCredentialId / allowCommit。候选开放探索用
  independent-assurance-v4；验收修订与用户风险接受留在主会话
args:
  projectRoot:
    type: string
    description: 项目根绝对路径（assurance 角色运行验证命令的工作目录；与 task.json 的
      projectRoot 一致性核对输入）
    required: true
  taskDir:
    type: string
    description: 任务目录绝对路径（delivery-gate init 创建；读取 acceptance.json /
      increments.json / events.jsonl / verdict.json，证据与报告写入 evidence/）
    required: true
  assuranceCredentialId:
    type: string
    description: assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——
      复核、证据与解决事件只能由 assurance 签署；凭据私钥本体不进参数与 prompt
    required: true
  builderCredentialId:
    type: string
    description: builder 角色凭据 id（init 输出，形态 <分组>/<任务id>/builder）——
      实现性修复与 RepairRoundRecorded 只能由 builder 签署；凭据私钥本体不进参数与 prompt
    required: true
  allowCommit:
    type: boolean
    description: 是否允许 workflow 按 builder 申报的精确文件路径提交修复笔——必须由主会话
      确认 worktree 归属后显式传 true；缺省 false，未授权时拒绝修复派发
    required: true
  fixSuggestions:
    type: boolean
    description: must-fix 清零后是否再统一修一批 suggestion（可选，缺省 false）
  runId:
    type: string
    description: 写事务租约运行标识（可选；传入时 setup 执行 lease-acquire、finalize
      执行 lease-release，append 带 --run-id 做代次复核——projectRoot 级写入互斥）
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其
      一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，仅含字母、数字、点、
      连字符、下划线，≤128 字符，禁「..」
  executionId:
    type: string
    description: 本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测
      JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId
  sampleType:
    type: string
    description: 观测样本类型（可选）——production = 真实执行（缺省）／selftest = 测试执行
*/

// ── O 区观测平台钩子：写通道 = world.run journal 语义（resume 重放回放首次记录值，
// 时间戳与事件序列跨 resume 稳定）。shared 观测层调用 obsNow/obsAppend；换平台只换
// 钩子实现，事件契约在 shared ──
const OBS_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
const OBS_APPEND_LINE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
async function obsNow(): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_PROBE_NOW]);
    const t = r.exitCode === 0 ? r.stdout.trim() : "";
    return t !== "" ? t : null;
  } catch {
    // 执行器故障（spawn 失败/超时）：观测降级为不记录该事件，业务不受影响
    return null;
  }
}
async function obsAppend(filePath: string, line: string): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_APPEND_LINE, filePath, line]);
    return r.exitCode === 0 ? null : `exit ${r.exitCode}：${r.stderr.trim() || r.stdout.trim()}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

@@STITCH@@
