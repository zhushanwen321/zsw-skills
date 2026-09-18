"""自动探测项目类型，返回合适的 EntryResolver 组合。"""

from __future__ import annotations

from .base import EntryResolver, PYTHON_EXTS, TS_EXTS, walk_source_files
from .fastapi import FastAPIResolver
from .fastify import FastifyResolver
from .ws_message import WSMessageResolver
from .ipc import IPCResolver


def auto_detect(project: str) -> list[EntryResolver]:
    """根据项目特征自动选择 EntryResolver 组合。"""
    has_fastapi = False
    has_fastify = False
    has_ws = False
    has_ipc = False

    ws_indicators = {"msg.type", "message.type", "ClientMessageType"}

    # Python: FastAPI 检测
    if not has_fastapi:
        for _, _, source in walk_source_files(project, PYTHON_EXTS, content_filter="APIRouter"):
            has_fastapi = True
            break

    # TypeScript: Fastify / WS / IPC 检测（单次遍历）
    fastify_indicators = ("fastify.get", "fastify.post", "fastify.route",
                          "app.get", "app.post", "app.route",
                          "require(\"fastify\")", "from \"fastify\"", "from 'fastify'")
    for _, _, content in walk_source_files(project, TS_EXTS):
        if not has_fastify and any(ind in content for ind in fastify_indicators):
            has_fastify = True
        if not has_ws and any(ind in content for ind in ws_indicators):
            has_ws = True
        if not has_ipc and "ipcMain" in content:
            has_ipc = True
        if has_fastify and has_ws and has_ipc:
            break

    resolvers: list[EntryResolver] = []
    if has_fastapi:
        resolvers.append(FastAPIResolver())
    if has_fastify:
        resolvers.append(FastifyResolver())
    if has_ws:
        resolvers.append(WSMessageResolver())
    if has_ipc:
        resolvers.append(IPCResolver())
    return resolvers


def classify_query(query: str, resolvers: list[EntryResolver]) -> str:
    """判断用户查询的入口类型。"""
    if query.startswith("/"):
        return "http"

    if "." in query and "/" not in query:
        if any(query.endswith(ext) for ext in (".py", ".ts", ".vue", ".js", ".java", ".go", ".rs")):
            return "direct"
        first_part = query.split(".")[0]
        if first_part and first_part[0].isupper():
            return "direct"
        return "ws_message"

    if "-" in query and " " not in query and "." not in query:
        return "ipc"

    return "direct"
