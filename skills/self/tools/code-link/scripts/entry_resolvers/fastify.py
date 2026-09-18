"""Fastify 路由解析器 — 从 fastify.get/post/... 和 fastify.route() 发现 HTTP 端点。"""

from __future__ import annotations

import re

from .base import EntryResolver, EntryPoint, TS_EXTS, walk_source_files


class FastifyResolver(EntryResolver):
    """发现 Fastify 项目中所有 HTTP 端点。

    解析以下模式：
    1. fastify.get/post/put/delete/patch/head/options('/path', ...)
    2. fastify.route({ method: 'GET', url: '/path', handler: ... })
    3. app.get/post/...（别名）
    4. register(routes, { prefix: '/api' }) 带前缀
    """

    HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options"}

    # fastify/app/server 实例名（用于匹配方法调用）
    _INSTANCE_RE = re.compile(
        r"^(?:fastify|app|server|instance)\s*\.\s*("
        + "|".join(HTTP_METHODS)
        + r")\s*\("
    )

    def discover_all(self, project: str) -> list[EntryPoint]:
        entries: list[EntryPoint] = []
        # 预过滤：文件必须包含 fastify 路由关键字
        content_filter = "fastify"
        for _, rel_path, source in walk_source_files(project, TS_EXTS, content_filter=content_filter):
            entries.extend(self._parse_file(rel_path, source))
        return entries

    def match(self, query: str, entries: list[EntryPoint]) -> list[EntryPoint]:
        matched: list[tuple[int, EntryPoint]] = []
        for ep in entries:
            score = _match_score(ep.name, query)
            if score > 0:
                matched.append((score, ep))

        if not matched:
            # 回退：前缀或子串匹配
            return [
                ep
                for ep in entries
                if ep.name.startswith(query) or query.startswith(ep.name.rstrip("/"))
            ]

        matched.sort(key=lambda x: x[0], reverse=True)
        return [ep for _, ep in matched]

    # ── 内部方法 ──────────────────────────────────────────────────────

    def _parse_file(self, rel_path: str, source: str) -> list[EntryPoint]:
        lines = source.split("\n")
        prefix = _extract_prefix(source)
        results: list[EntryPoint] = []

        for i, line in enumerate(lines):
            stripped = line.strip()

            # 1. 快捷方法: fastify.get('/path', ...) 或 app.get('/path', ...)
            m = re.match(
                r"(?:fastify|app|server|instance)\s*\.("
                + "|".join(self.HTTP_METHODS)
                + r")\s*\(\s*['\"`]([^'\"`]+)['\"`]",
                stripped,
            )
            if m:
                method = m.group(1).upper()
                path = m.group(2)
                handler = _find_handler_in_line(stripped) or _find_handler_below(lines, i)
                full_path = _normalize_path(prefix + path)
                results.append(
                    EntryPoint(
                        name=full_path,
                        entry_type="http",
                        file=rel_path,
                        handler=handler,
                        method=method,
                    )
                )
                continue

            # 2. fastify.route({ method: 'GET', url: '/path', handler: xxx })
            m = re.match(
                r"(?:fastify|app|server|instance)\s*\.route\s*\(",
                stripped,
            )
            if m:
                route_block = _collect_block(lines, i)
                method = _extract_route_method(route_block)
                path = _extract_route_url(route_block)
                handler = _extract_route_handler(route_block)
                if method and path:
                    full_path = _normalize_path(prefix + path)
                    results.append(
                        EntryPoint(
                            name=full_path,
                            entry_type="http",
                            file=rel_path,
                            handler=handler,
                            method=method.upper(),
                        )
                    )
                continue

        return results


# ── 模块级工具函数 ──────────────────────────────────────────────────────

# 匹配路径参数: /users/:id → /users/{id}
_PARAM_RE = re.compile(r":(\w+)")
# 匹配正则参数: /users/<id> → /users/{id}
_REGEX_PARAM_RE = re.compile(r"<(\w+)>")
# 匹配花括号参数: /users/{id}（已是标准形式，保留）
_BRACE_PARAM_RE = re.compile(r"\{(\w+)\}")


def _normalize_path(path: str) -> str:
    """归一化路径：合并连续斜杠，标准化参数格式。"""
    # :param → {param}
    path = _PARAM_RE.sub(r"{\1}", path)
    # <param> → {param}
    path = _REGEX_PARAM_RE.sub(r"{\1}", path)
    # 合并连续斜杠
    path = re.sub(r"/+", "/", path)
    return path


def _extract_prefix(source: str) -> str:
    """从 register 调用中提取 prefix。

    匹配模式：
      fastify.register(routes, { prefix: '/api' })
      app.register(plugin, { prefix: '/v1' })
      fastify.register(require('./routes'), { prefix: '/api/v1' })
    """
    m = re.search(
        r"(?:fastify|app|server|instance)\s*\.register\s*\(.+?prefix\s*:\s*['\"`]([^'\"`]+)['\"`]",
        source,
        re.DOTALL,
    )
    return m.group(1) if m else ""


def _find_handler_in_line(line: str) -> str:
    """从同一行提取 handler 函数名。

    匹配模式：
      fastify.get('/path', handler)
      fastify.get('/path', { handler: fn }, ...)
      fastify.get('/path', async function name(...) {})
      fastify.get('/path', (req, reply) => { ... })
    """
    # handler 选项: { handler: someName }
    m = re.search(r"handler\s*:\s*(\w+)", line)
    if m:
        return m.group(1)

    # 第二个参数是标识符: fastify.get('/path', someHandler)
    m = re.match(
        r"(?:fastify|app|server|instance)\s*\.\w+\s*\(\s*['\"`][^'\"`]+['\"`]\s*,\s*(\w+)",
        line,
    )
    if m:
        name = m.group(1)
        # 排除选项对象和匿名函数
        if name not in ("async", "function", "{", "(", "options", "opts"):
            return name

    return ""


def _find_handler_below(lines: list[str], start: int) -> str:
    """从当前行下方搜索 handler 函数名。

    用于多行写法：
      fastify.get('/path', async (req, reply) => { ... })
      fastify.get('/path', {
        handler: someFunction
      })
    """
    for i in range(start + 1, min(start + 10, len(lines))):
        line = lines[i].strip()
        m = re.search(r"handler\s*:\s*(\w+)", line)
        if m:
            return m.group(1)
    return ""


def _collect_block(lines: list[str], start: int) -> str:
    """从 start 行收集完整的花括号块（用于 fastify.route({...})）。"""
    depth = 0
    parts: list[str] = []
    for i in range(start, min(start + 30, len(lines))):
        line = lines[i]
        parts.append(line)
        depth += line.count("{") - line.count("}")
        if depth <= 0 and "{" in "".join(parts):
            break
    return "\n".join(parts)


def _extract_route_method(block: str) -> str | None:
    """从 route 配置块提取 method。"""
    # method: 'GET' 或 method: ['GET']
    m = re.search(r"method\s*:\s*['\"`](\w+)['\"`]", block)
    if m:
        return m.group(1)
    # method: ['GET', 'POST']
    m = re.search(r"method\s*:\s*\[\s*['\"`](\w+)['\"`]", block)
    if m:
        return m.group(1)
    return None


def _extract_route_url(block: str) -> str | None:
    """从 route 配置块提取 url/path。"""
    m = re.search(r"(?:url|path)\s*:\s*['\"`]([^'\"`]+)['\"`]", block)
    return m.group(1) if m else None


def _extract_route_handler(block: str) -> str:
    """从 route 配置块提取 handler 名。"""
    m = re.search(r"handler\s*:\s*(\w+)", block)
    return m.group(1) if m else ""


def _match_score(pattern: str, query: str) -> int:
    """匹配评分：精确 > 参数化匹配 > 前缀。"""
    if pattern == query:
        return 10
    if pattern.rstrip("/") == query.rstrip("/"):
        return 3
    # 参数化匹配: /users/{id} 匹配 /users/123
    regex_parts: list[str] = []
    for seg in pattern.split("/"):
        if not seg:
            regex_parts.append("")
            continue
        if re.match(r"^\{\w+\}$", seg):
            regex_parts.append("[^/]+")
        else:
            regex_parts.append(re.escape(seg))
    regex = "/".join(regex_parts)
    if re.fullmatch(regex, query):
        return 5
    return 0
