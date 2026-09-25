# D1 开发循环 — W2 wave-executor 契约与手工降级路径

> 输入：D0 编译产物齐备（exec-plan + prompts + 初始 status.json）。不变量：subagent 零 git；每单元双锁——领地 diff 干净 + 测试真实跑绿；**调度只看依赖边（wave 仅展示标签，不是边界）**；**每单元核验通过瞬间独立 commit**（不等批、不等 wave、不等尾）。

## W2 workflow 契约（zcode 环境默认动作）

```
CreateWorkflow saved: wave-executor
args: { execPlan: "<项目根>/.tmp/dev-flow/<name>.exec-plan.json" }
```

引擎内循环（每节点四节拍，全部确定性代码 + 一次 agent 会话）：

1. 就绪集 = deps 全 done 的节点，批内并行（≤5），完成即重算（谁先提交谁的后继先开跑）
2. `agent(node-<unitId>)` 读 promptFile 全文执行（prompt 编译期已构造，引擎零拼接）
3. world.run 核验：`git status --porcelain` + diff 归属核对（files_changed ⊆ territory；**并行单元共享工作区时 = dev 自报精确路径 + 引擎按并集粗粒度复核两级判定**）+ 重跑 testCommand 断言退出码
4. 核验过 → world.run commit（`git add -- <files_changed>` + commitTemplate 渲染）→ status.json 回写 → 解锁下游

打回（核验不过）：原节点 agent 会话续聊定向修（贴 diff/失败输出/违反条款），≤2 轮；agent 不可用 → 接替程序（新 agent + 前任证据包：状态表该单元最后一轮 files_changed/test_evidence/deviations + 当前 `git diff --stat`，令其先核验现状再续作）。超 2 轮 → 节点 blocked，后继自动挂起（deps 不满足），无依赖节点照常推进 → 全场无可调度且存在 blocked → 终态 `blocked`（+清单+已试方案）→ 主 agent 升级用户。全节点 done → 终态 `completed` → 进 D2。

worktree 单元：节点 cwd 字段生效——派发/核验/commit 在该 worktree 内执行；集成性质下游单元在其合并回主分支后才绪。

## 手工降级路径（workflow 未就绪/失败时，语义等价）

八步循环：

1. **算就绪集**：read status.json，前驱全 done 的节点为就绪
2. **分批派发**：就绪节点并发 ≤5 全部后台异步派发（领地互斥由 T3 DAG 自检保证）；worktree 单元单独派发（cwd = worktree 目录）
3. **派发**：task = 该节点 promptFile 全文（三段式，模型按全局路由表编码档、thinking max）
4. **完成通知到达即硬核验**（每节点，防假完成唯一闸口；先到先验不等同批）：`git status --short` + `git diff --stat` 核对改动集合 == files_changed 且 ⊆ 领地；重跑核心测试比对输出；有疑点打回重验
5. **流转 commit**：核验过 → 按 files_changed 精确 add → commit（英文 message 含 unit id、对应设计章节、测试结论一行）→ status.json 回写（state=done + 证据指针）
6. **失败打回**：续聊定向修或接替程序；轮次 +1；超 2 轮冻结该单元升级用户（附已尝试方案）；打回前后都重算就绪集——修单元不阻塞其他就绪节点
7. **流式推进**：任一 done 即重算就绪集，解锁后继在并发余量内立即补派
8. **循环至全 done** → 转 `flow/consistency-review.md`

## 中断恢复

回到第 1 步；以 git log 与工作区实物校准 status.json（**冲突以 git 为准**：标 done 无 commit → pending；有 commit 未写 → 补写 done）。
