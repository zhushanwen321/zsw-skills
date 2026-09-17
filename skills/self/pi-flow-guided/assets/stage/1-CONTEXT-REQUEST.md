# 阶段 1：构建 context-request

> **输入**：Pi 的提示 + 当前任务状态 + verdict 响应（如有）
> **输出**：结构化 JSON context-request
> **下一步**：[阶段 2：发送给 Pi](2-VERDICT-PARSE.md)

---

## 三种 action 类型

| action | 用途 | 触发条件 |
|--------|------|----------|
| `accept` | 接受结果，结束循环 | verdict = pass 且所有任务完成 |
| `next` | 继续执行，进入下一轮 | verdict = fail 但可修复，或任务未全部完成 |
| `reject` | 拒绝终止，需要人工介入 | 存在无法自动修复的阻塞问题 |

---

## accept 模板

### 完整 JSON

```json
{
  "action": "accept",
  "reason": "所有验收标准均已满足"
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | string | ✅ | 固定值 `"accept"` |
| `reason` | string | ✅ | 一句话说明为什么接受，引用验收标准 |

### 适用场景

- verdict 返回 pass，且所有计划任务已完成
- 用户明确要求结束循环
- 剩余工作超出当前任务范围，需要另开任务

### 示例

```json
{
  "action": "accept",
  "reason": "用户登录模块已实现并通过所有单元测试（覆盖率 92%），API 文档已更新"
}
```

---

## reject 模板

### 完整 JSON

```json
{
  "action": "reject",
  "reason": "存在无法自动修复的阻塞问题",
  "blockingIssues": [
    "issue-1: 描述问题",
    "issue-2: 描述问题"
  ]
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | string | ✅ | 固定值 `"reject"` |
| `reason` | string | ✅ | 一句话说明为什么拒绝 |
| `blockingIssues` | string[] | ✅ | 每个元素描述一个阻塞问题 |

### 适用场景

- 发现架构层面的问题，需要重新设计
- 依赖的外部服务/API 不可用
- 需求本身有歧义，需要用户澄清
- 连续多轮 fail 且无法收敛

### 示例

```json
{
  "action": "reject",
  "reason": "数据库连接配置依赖外部环境变量，当前无法自动获取",
  "blockingIssues": [
    "DATABASE_URL 环境变量未设置，无法建立数据库连接",
    "Redis 服务未启动，缓存层无法测试"
  ]
}
```

---

## next 模板

### 完整 JSON

```json
{
  "action": "next",
  "plan": {
    "step": 2,
    "totalSteps": 5,
    "currentTask": "实现用户登录模块",
    "nextTask": "实现权限校验中间件",
    "filesToModify": [
      "src/auth/login.ts",
      "src/middleware/auth.ts"
    ]
  },
  "context": {
    "completedWork": [
      "数据库 schema 设计",
      "API 路由定义"
    ],
    "pendingWork": [
      "权限中间件",
      "错误处理",
      "单元测试"
    ],
    "decisions": [
      "使用 JWT 而非 session"
    ]
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | string | ✅ | 固定值 `"next"` |
| `plan` | object | ✅ | 下一步的执行计划 |
| `plan.step` | number | ✅ | 当前步骤编号（从 1 开始） |
| `plan.totalSteps` | number | ✅ | 总步骤数 |
| `plan.currentTask` | string | ✅ | 当前正在做的任务 |
| `plan.nextTask` | string | ✅ | 下一轮要做的任务 |
| `plan.filesToModify` | string[] | ✅ | 需要修改的文件路径 |
| `context` | object | ✅ | 上下文信息 |
| `context.completedWork` | string[] | ✅ | 已完成的工作（只写真正完成的） |
| `context.pendingWork` | string[] | ✅ | 待完成的工作 |
| `context.decisions` | string[] | ⬜ | 已做出的技术决策 |

### 适用场景

- verdict 返回 fail，但有明确的修复计划
- verdict 返回 pass，但任务还有后续步骤
- 需要分多轮完成的大型任务

### 场景 A：verdict fail，需要修复

```json
{
  "action": "next",
  "plan": {
    "step": 1,
    "totalSteps": 1,
    "currentTask": "修复登录验证逻辑",
    "nextTask": "修复登录验证逻辑中的密码比对错误",
    "filesToModify": ["src/auth/login.ts"]
  },
  "context": {
    "completedWork": ["已定位问题：第 45 行密码比对逻辑错误"],
    "pendingWork": ["修复密码比对，使用 bcrypt.compare 替代 ==="],
    "decisions": []
  }
}
```

### 场景 B：verdict pass，继续后续任务

```json
{
  "action": "next",
  "plan": {
    "step": 3,
    "totalSteps": 5,
    "currentTask": "已完成用户登录模块",
    "nextTask": "实现权限校验中间件",
    "filesToModify": ["src/middleware/auth.ts"]
  },
  "context": {
    "completedWork": [
      "用户注册模块（Step 1）",
      "用户登录模块（Step 2）"
    ],
    "pendingWork": [
      "权限校验中间件（Step 3）",
      "错误处理统一（Step 4）",
      "集成测试（Step 5）"
    ],
    "decisions": ["使用 JWT 而非 session"]
  }
}
```

---

## 常见错误

### ❌ plan 写得太模糊

```json
{
  "plan": {
    "currentTask": "继续实现",
    "nextTask": "完善功能"
  }
}
```

**问题**：Pi 无法理解具体要做什么

**修正**：

```json
{
  "plan": {
    "currentTask": "实现用户登录模块",
    "nextTask": "在 src/auth/login.ts 中添加密码强度校验（至少 8 位，含大小写和数字）"
  }
}
```

### ❌ completedWork 虚报进度

```json
{
  "context": {
    "completedWork": ["用户登录模块已实现"]
  }
}
```

**问题**：如果登录模块实际只完成了一半，会导致后续步骤基于错误前提

**修正**：

```json
{
  "context": {
    "completedWork": ["登录 API 路由已定义", "密码哈希函数已实现"],
    "pendingWork": ["登录验证逻辑", "JWT token 生成", "错误处理"]
  }
}
```

### ❌ blockingIssues 不够具体

```json
{
  "blockingIssues": ["有问题"]
}
```

**问题**：无法帮助人工判断如何介入

**修正**：

```json
{
  "blockingIssues": [
    "DATABASE_URL 环境变量未设置，无法建立数据库连接",
    "Redis 服务未启动，缓存层无法测试"
  ]
}
```

---

## 下一步

构建好 context-request 后，发送给 Pi，然后进入 [阶段 2：解析 verdict](2-VERDICT-PARSE.md)。
