---
name: pi-flow-guided
description: |
  当 pi 提示"Please continue - send the next message (or attach-seed) to keep going"
  时自动加载。提供可视化流程图（Mermaid）和结构化决策表，指导：
  (1) 构建 context-request JSON
  (2) 解析 verdict 响应
  (3) 基于 pass/fail 决定下一步
  适用于所有使用三层执行流程（VERDICT_PROMPT → REVIEW_AGENT → CONTEXT_REQUEST）
  的 workflow/review-loop 场景。
  不用于普通对话或不涉及结构化审查的任务。
---

# Pi Flow Guided

> **类型**：执行流程指导 · **受众**：AI Agent · **格式**：流程图 + 决策表

## 速查入口

| 需求 | 去哪 |
|------|------|
| 看流程全貌 | [流程图](assets/flow.html) |
| 构建 context-request | [阶段 1 详解](assets/stage/1-CONTEXT-REQUEST.md) |
| 解析 verdict | [阶段 2 详解](assets/stage/2-VERDICT-PARSE.md) |
| 决定下一步 | [阶段 3 详解](assets/stage/3-NEXT-MOVE.md) |
| 看真实例子 | [典型循环](assets/examples/typical-cycle.md) / [边界情况](assets/examples/edge-cases.md) |
| 快速复制模板 | [速查表](quick-reference.md) |

---

## 核心流程（精简版）

```
Pi 发出提示 "Please continue..."
    │
    ▼
┌─────────────────────────────────┐
│  阶段 1：构建 context-request    │
│  三种类型：accept / reject / next │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  阶段 2：发送给 Pi，解析 verdict  │
│  Pi 返回：pass / fail / error    │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  阶段 3：决策下一步               │
│  pass → 推进 / fail → 修复重试   │
│  error → 报错终止                │
└─────────────────────────────────┘
```

---

## 三种 context-request 类型速览

### accept（通过，接受结果）

```json
{
  "action": "accept",
  "reason": "所有验收标准均已满足"
}
```

**何时用**：verdict 为 pass，或用户明确要求结束循环

---

### reject（拒绝，终止流程）

```json
{
  "action": "reject",
  "reason": "存在无法自动修复的阻塞问题",
  "blockingIssues": ["issue-1", "issue-2"]
}
```

**何时用**：发现无法修复的阻塞问题，需要人工介入

---

### next（继续，进入下一轮）

```json
{
  "action": "next",
  "plan": {
    "step": 1,
    "totalSteps": 5,
    "currentTask": "实现用户登录模块",
    "nextTask": "实现权限校验中间件",
    "filesToModify": ["src/auth/login.ts", "src/middleware/auth.ts"]
  },
  "context": {
    "completedWork": ["数据库 schema 设计", "API 路由定义"],
    "pendingWork": ["权限中间件", "错误处理", "单元测试"],
    "decisions": ["使用 JWT 而非 session"]
  }
}
```

**何时用**：verdict 为 fail 且有明确修复计划，或 verdict 为 pass 但任务未全部完成

---

## 决策树（快速判断）

```
收到 verdict 响应
    │
    ├─ 是 pass？
    │   ├─ 所有任务都完成了？ → accept
    │   └─ 还有后续任务？ → next（描述下一步）
    │
    ├─ 是 fail？
    │   ├─ 能自动修复？ → next（描述修复计划）
    │   └─ 不能自动修复？ → reject（列出阻塞问题）
    │
    └─ 是 error / 无法解析？
        └─ reject（报告错误详情）
```

---

## 关键原则

1. **plan 必须具体**：不要写"继续实现"，要写"修改 src/auth/login.ts 的 validateUser 函数，增加密码强度校验"
2. **completedWork 如实记录**：只写真正完成的，不要虚报进度
3. **blockingIssues 量化**：写清楚问题是什么、为什么阻塞、需要什么才能继续
4. **reason 简洁有力**：一句话说明为什么做这个决定

---

## 相关资源

- [Pi 主文档](../../node_modules/@earendil-works/pi-coding-agent/README.md)
- [Workflow 脚本格式](../../node_modules/@earendil-works/pi-coding-agent/docs/workflow-script-format.md)
