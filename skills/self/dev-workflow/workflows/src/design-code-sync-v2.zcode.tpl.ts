/* zcode-workflow
description: dev-flow-wf 技能 W4 v2 一致性对账引擎（sync-conformance-plane M4）：设计义务
  表（章节 JSON conformance 绑定）→ checker 派发（deterministic 内建优先 / semantic agent
  按义务摘要+输入哈希+版本缓存）→ 差距地址聚合（AX2 派生地址，重复报告只追加证据）→
  worktree sandbox 隔离变更集（禁产对象命令）→ 集成器唯一写入门径 → 四层结论
  （scriptStatus/engineOutcome/integrationOutcome/deliveryOutcome）。全部状态经
  conformance-state 状态仓事件流（agent 无状态、禁自报身份与终态）；文档侧差距走
  doc-proposals 提案 + RulingRequested/RulingRecorded 裁决停回。旧引擎（design-code-sync-loop）
  只读期并存：已 cutover 的设计包由本引擎管辖
whenToUse: dev-flow-wf 技能 D5 终态同步段——设计包已具备 conformance 绑定（章节 JSON §9b）
  时的义务对账。必传 designPkg / projectRoot / declaredRepos。旧 issue 循环引擎
  （design-code-sync-loop）用于未绑定 legacy 包只读期收尾；带 cutover 标记的包旧引擎拒启
args:
  designPkg:
    type: string
    description: 设计包目录绝对路径（含 meta.json / s1-context.json … s5-breakdown.json——
      义务提取数据源；tech-design 段 <name>/）
    required: true
  projectRoot:
    type: string
    description: 目标项目根绝对路径（workspace 清单扫描基准 + evidenceInputs 相对路径基准）
    required: true
  declaredRepos:
    type: string
    description: "workspace 登记清单 JSON（数组 [{repoId, path, editableRoot?}]，path 相对
      projectRoot 或绝对——inventory 提案输入；传参即主 agent 确认（M4 形态），未确认仓库
      拒启。绑定 repoId 必须全部在确认清单内（AX9 未登记仓库是非法目标）"
    required: true
  confirmedRepoIds:
    type: string
    description: 已确认 repoId 集 JSON（数组；缺省 = 提案全部确认）
  sandboxRoot:
    type: string
    description: sandbox 子段根绝对路径（缺省 = dev-flow 段产物根/sandbox——目标仓外固定段）
  stateRoot:
    type: string
    description: conformance-state 状态仓根绝对路径（缺省 = tech-design 段 <name>/conformance-state）；
      续跑 = 同根重发（事件流续跑，身份与结论由事件派生）
  confRoot:
    type: string
    description: "conformance-plane 模块根绝对路径（缺省 <projectRoot>/skills/self/dev-workflow/conformance-plane——仓库内模块直读）；
      按路径直读消费（引擎经 node 子进程动态 import 其 kernel/extractors/checkers/changeset/integration 模块）"
  reviewerTemplate:
    type: string
    description: 语义检查 agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/conformance-reviewer.md）
  fixerTemplate:
    type: string
    description: 补丁生成 agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/changeset-fixer.md）
  maxRounds:
    type: number
    description: 对账轮次上限（缺省 8；耗尽仍有 open = engineOutcome stopped）
  rulingsFile:
    type: string
    description: "用户裁决记录 json 绝对路径（续跑通道；元素 address 为对象 {bindingId,
      repoId, violationKind}，direction 为 code-right|doc-right|waived，respondsTo 取
      上次终态 message 的在案锚点；发起时装载入流（RecordRuling），awaiting-ruling 解除）"
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）
  executionId:
    type: string
    description: 本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）
  sampleType:
    type: string
    description: 观测样本类型（可选）——production = 真实执行（缺省）／selftest = 测试执行
*/

// ── G 区平台恢复指引（机制词 pi 语境化；措辞沿 W4 旧引擎同款——parity 白名单已登记同文） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起；若修订续跑（AmendWorkflow）：args 不透传、attempt 留空会自动递增使节点缓存零命中从头重跑——参数值与 attempt 原值一并固化进脚本常量再 amend";

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
