# Code Link — 详细使用模式

## 1. 单入口追踪（替代 code-trace）

追踪一个 API 路由涉及的所有文件：

```bash
python3 scripts/code_link.py --project /path/to/project --entry "/api/task/runs"
```

结果中 `all_files` 就是需要审查/理解的完整文件列表。

## 2. 批量入口扫描（替代 batch-tracer）

对项目中所有入口点逐一追踪，汇总文件覆盖率：

```bash
# 1. 列出所有入口点
python3 -c "
from scripts.entry_resolvers import auto_detect
resolvers = auto_detect('/path/to/project')
for r in resolvers:
    for ep in r.discover_all('/path/to/project'):
        print(f'{r.__class__.__name__}\t{ep.name}\t{ep.handler}')
"

# 2. 逐个追踪（可配合 xargs -P 并行）
python3 scripts/code_link.py --project ... --entry "/api/xxx" --bridge backend
```

## 3. 问题验证（替代 issue-trace）

用户报告 bug 时，从相关入口追踪到所有文件，定位问题所在：

1. 确定入口（API 路由 / WS 消息 / 类名）
2. `--bridge both` 获取完整前后端文件
3. 在返回的文件列表中搜索问题关键词

## 4. 审查质量评估（替代 review-tracer）

审查工具输出质量评估的方法：

1. 用 code-link 追踪出正确的文件列表（ground truth）
2. 对比审查工具输出的文件列表与 ground truth 的重叠度
3. 覆盖率低 = 审查工具遗漏多

## 5. 架构理解

理解模块边界和依赖关系：

```bash
# 追踪一个 service 的所有下游
python3 scripts/code_link.py --project ... --entry "TaskRunService" --bridge backend

# 追踪 WS 消息的前后端完整链路
python3 scripts/code_link.py --project ... --entry "message.send" --bridge both
```

## 6. 非特定框架项目的使用方式

code-link 不局限于 FastAPI / Fastify / Electron。对于任何 tree-sitter 支持的语言，都可以直接用类名/方法名追踪：

```bash
# Go 项目：追踪一个 handler 函数
python3 scripts/code_link.py --project /path/to/go-project --entry "HandleGetUsers"

# Rust 项目：追踪一个 service 方法
python3 scripts/code_link.py --project /path/to/rust-project --entry "UserService.create_user"

# Java 项目：追踪一个 Controller 方法
python3 scripts/code_link.py --project /path/to/java-project --entry "UserController.getProfile"

# 即使入口是 URL 格式，没有 Resolver 命中也会自动 fallback 到 direct 搜索
python3 scripts/code_link.py --project /path/to/go-project --entry "/api/users"
# → Gin/Echo 没有专用 Resolver，自动 fallback 到 direct，搜索 graph.db
```

只要项目运行过 `code-review-graph build`（code-link 首次使用会自动执行），AST 图就会包含所有语言的函数/类/调用关系。

## 前置条件

项目必须有 `.code-review-graph/graph.db`。首次使用时自动构建，也可手动：

```bash
cd /path/to/project && code-review-graph build
```

**纯 CLI 操作，不依赖 MCP server。** code-review-graph 虽然提供 `serve` 子命令（MCP stdio），但 code-link 全部通过 CLI + SQLite 直读完成。

### 语言支持

底层 tree-sitter-language-pack 提供 **306 种语言**的 AST 解析，主流语言全覆盖：

Go, Rust, Java, Kotlin, Scala, C, C++, C#, Python, Ruby, PHP, Swift, Dart, TypeScript, JavaScript, TSX, Elixir, Erlang, Haskell, Lua, R, Perl, Zig, Odin, Nim, Julia, OCaml, F#, Clojure, Bash, SQL, HTML, CSS, Vue, Svelte 等。

### 框架特定 Resolver

| 框架 | 语言 | 入口识别模式 |
|------|------|------------|
| FastAPI | Python | `@router.get/post/...` 装饰器 + `APIRouter(prefix=...)` |
| Fastify | TS/JS | `fastify.get/post(...)` + `fastify.route({...})` + `register(prefix=...)` |
| WebSocket | TS/JS | `switch(msg.type) { case "xxx": }` |
| Electron IPC | TS/JS | `ipcMain.handle("channel", ...)` |

不在此表的框架/语言，自动走 **direct fallback**（在 AST 图中按名字搜索）。
