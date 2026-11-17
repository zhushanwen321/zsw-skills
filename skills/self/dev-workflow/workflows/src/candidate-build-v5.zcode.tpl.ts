/* zcode-workflow
description: delivery-v5 技能 BUILD 段候选实现引擎：前置 evaluate 拒绝 state=draft；
  读取验收、增量清单、当前 verdict 与未决发现，逐增量派 builder。已实现增量按
  acceptanceVersion 判定（不因 revision 变化全量重做），仅命中未决发现或当前失败证据的
  增量进入修复轮（无关联需求的 blocker 发现触发全部增量修复）。每增量 builder 只 ask
  一次（实现并写实现报告），脚本随后执行 testCommand、把测试摘要追加进报告，并以
  append --credential 追加带合并回执（起始/合并后指纹 + 补丁哈希）的
  ImplementationRecorded 与带 defect|boundary 分类的 FindingRaised。基础设施失败不登记
  FindingRaised，返回 build-failed 前重新 evaluate。全部增量完成后 evaluate 并返回
  implemented（候选，不是交付）。builder 不改 acceptance/increments/events/verdict，
  不做 Git 写操作；builder 的测试输出不是 verified 证据，本 workflow 不手编 accepted
  agent 调用结构校验与修正重问、CLI spawn 级失败重试（只读/幂等命令）、自修复
  记录（taskDir/self-repairs.jsonl）随终态 message 上报主 agent（DEV 韧性层）
whenToUse: delivery-v5 技能候选实现段——验收已获用户批准（evaluate state 非 draft）、
  需要形成候选实现或按未决发现/失败证据修复增量时调用；必传 projectRoot / taskDir /
  builderCredentialId。不用于验收设计（用 acceptance-design-v5）或证据核对与探索审查
  （用 independent-assurance-v5）
args:
  projectRoot:
    type: string
    description: 项目根绝对路径（builder 改产品代码与测试的工作目录；testCommand 的
      执行 cwd；与 task.json 的 projectRoot 一致性核对输入）
    required: true
  taskDir:
    type: string
    description: 任务目录绝对路径（delivery-gate init 创建；读取 acceptance.json /
      increments.json / events.jsonl / verdict.json，写入实现报告与测试日志）
    required: true
  builderCredentialId:
    type: string
    description: builder 角色凭据 id（init 输出，形态 <分组>/<任务id>/builder）——
      append --credential 以 builder 身份签名追加实现与发现事件；凭据私钥本体不进参数与 prompt
    required: true
  assuranceCredentialId:
    type: string
    description: assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——
      候选反例审查与探索事件只能由 assurance 签署；凭据私钥本体不进参数与 prompt
    required: true
  runId:
    type: string
    description: 写事务租约运行标识（可选；传入时 setup 获取、finalize 释放，append 做代次复核）
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
