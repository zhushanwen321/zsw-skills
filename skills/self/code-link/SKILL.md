---
name: code-link
description: "从入口点（HTTP 路由、WebSocket 消息、IPC 通道、类/方法名）追踪调用链到所有相关文件。用 code-review-graph 的 AST 图遍历替代 batch-tracer、code-trace、issue-trace、review-tracer。触发词：追踪链路、调用链、相关文件、trace code、call chain、code-link、find callers、trace route、analyze data flow、linked files。不用于通用代码审查或 lint。"
---

# Code Link — AST-based Code Tracer

## Overview

从入口点出发，利用 code-review-graph 的持久化 AST 图数据库，BFS 追踪调用链，串联前后端所有相关文件。替代手写的 batch-tracer / code-trace / issue-trace / review-tracer。

## When to Use

- 用户说"追踪链路"、"trace code"、"调用链"、"find callers"、"相关文件"
- 需要知道某个 HTTP 路由/WS 消息/IPC 通道涉及哪些代码文件
- 需要从后端 API 桥接到前端组件
- 需要理解某个类/方法的所有下游调用

**When NOT to use:**
- 通用代码审查 → `code-review-worktree`
- 分析审查工具质量 → 直接在对话中评估
- 验证 bug → `diagnose`

## Quick Start

```bash
# 脚本位于 skill 目录的 scripts/ 下，通过 --project 指定目标项目
# 首次使用自动 build graph.db + 启动 watch 后台监听
SKILL_DIR="~/.pi/agent/skills/code-link"
python3 "$SKILL_DIR/scripts/code_link.py" --project /path/to/project --entry "/api/task/runs"
python3 "$SKILL_DIR/scripts/code_link.py" --project /path/to/project --entry "session.create"
python3 "$SKILL_DIR/scripts/code_link.py" --project /path/to/project --entry "TaskRunService.cancel_run" --bridge backend
```

## Graph DB 生命周期

脚本自动管理 `.code-review-graph/graph.db`：

| 场景 | 行为 |
|------|------|
| graph.db 不存在 | 自动全量 build + 启动 watch |
| graph.db 为空（0 nodes） | 重新 build + 启动 watch |
| graph.db 有数据 + watch 未运行 | 启动 watch 后台监听 |
| graph.db 有数据 + watch 运行中 | 直接使用 |

watch 进程通过 PID 文件 (`.code-review-graph/.watch.pid`) 跟踪，使用 watchdog 监听文件变化并增量更新。

## 解析策略（Resolver → Direct Fallback）

code-link 使用**两层解析策略**，确保所有语言和框架都能工作：

### 第一层：框架特定 Resolver

针对已知框架，解析路由装饰器/注册调用，精确定位入口函数：

| 框架 | Resolver | 识别模式 | 语言 |
|------|----------|---------|------|
| FastAPI | `FastAPIResolver` | `@router.get("/path")` + `APIRouter(prefix=...)` | Python |
| Fastify | `FastifyResolver` | `fastify.get/post(...)` + `fastify.route({...})` + `register(prefix=...)` | TS/JS |
| WebSocket | `WSMessageResolver` | `switch(msg.type) { case "xxx": }` | TS/JS |
| Electron IPC | `IPCResolver` | `ipcMain.handle("channel", ...)` | TS/JS |

`auto_detect` 扫描项目文件，按特征串自动选择 Resolver 组合。

### 第二层：Direct 模式（通用 Fallback）

**当没有 Resolver 命中时，自动退化为 direct 模式。** 不依赖任何框架知识，直接在 graph.db 的 AST 节点中搜索：

- 支持所有 tree-sitter 能解析的语言（306 种，涵盖 Go/Rust/Java/C++/Python/Ruby/PHP/Swift/Kotlin/Dart/Zig 等）
- 搜索 `ClassName.method`、函数名、qualified name
- BFS 追踪 callees 调用链，最大深度可配（默认 4 层）

触发 fallback 的场景：
1. 项目不使用任何已注册框架（如纯 Go/Gin、Rust/Actix、Java/Spring）
2. 使用了已注册框架但路由模式未被识别（如路由定义在 YAML/JSON 配置文件中）
3. 入口点是类名或方法名（`UserService.create`），不走 Resolver

fallback 时输出 JSON 会包含 `"fallback": "direct"` 字段，表示未通过框架特定解析。

### 路径选择流程

```
query 输入
  │
  ├─ classify_query 按格式判断 entry_type
  │   ├─ "/xxx"       → http
  │   ├─ "xxx.yyy"    → ws_message 或 direct（首字母大写=类名→direct）
  │   ├─ "xxx-yyy"    → ipc
  │   └─ 其他         → direct
  │
  ├─ entry_type 有对应 resolver？
  │   ├─ 是 → resolver.resolve() 匹配到入口点？
  │   │   ├─ 是 → Resolver 路径（精确入口 + BFS 追踪）
  │   │   └─ 否 → ↓ Fallback to Direct
  │   └─ 否 → ↓ Fallback to Direct
  │
  └─ Direct 路径：在 graph.db 搜索名字 → BFS 追踪
```

## Entry Types

CLI 自动检测入口类型，无需手动指定：

| 查询格式 | 检测类型 | 说明 |
|---------|---------|------|
| `/api/task/runs` | http | 优先走 Resolver，未命中则 fallback direct |
| `session.create` | ws_message | 优先走 WS Resolver，未命中则 fallback direct |
| `channel:window/api` | ipc | 优先走 IPC Resolver，未命中则 fallback direct |
| `TaskRunService.cancel_run` | direct | 直接在 graph.db 搜索 |

## Output

JSON 格式，包含：

```json
{
  "entry_type": "http",
  "backend": { "files": [...], "entry_points": [...], "trace_nodes": 34 },
  "frontend": { "files": [...], "matches": [...] },
  "all_files": ["sorted", "list"],
  "stats": { "total_files": 13 }
}
```

当发生 fallback 时，额外包含：

```json
{
  "entry_type": "http",
  "fallback": "direct",
  "backend": { ... },
  ...
}
```

## Bridge Mode

| Mode | 说明 |
|------|------|
| `--bridge both` | 后端追踪 + 前端桥接（默认） |
| `--bridge backend` | 仅后端追踪 |
| `--bridge frontend` | 仅前端桥接 |

## Common Patterns

read `references/patterns.md` for detailed usage patterns including:
- 单入口追踪
- 批量入口扫描
- 问题验证（替代 issue-trace）
- 审查质量评估（替代 review-tracer）
- 非 FastAPI/Fastify 项目的使用方式
