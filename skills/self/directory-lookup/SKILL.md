---
name: directory-lookup
description: "查找 ~/Code、~/GitApp、~/Stock 下的项目和文件位置。触发词：找文件、定位项目、Code 目录有什么、GitApp 有哪些、Stock 下的 X、~/Code 里有吗、directory-lookup、目录索引。不用于通用文件搜索（用 bash find/rg）。"
---

# 目录索引查询

读取 `~/.agents/lessons/directory-index.md`（73 行完整索引），按用户关键词检索目标文件/项目的位置。

## 流程

1. `read ~/.agents/lessons/directory-index.md`
2. 按关键词匹配（项目名、包名、目录名、文件名）
3. 返回匹配结果（含完整路径）
4. 未找到时告知用户并要求补充上下文（关键词、所属项目、用途）

## 禁止

- 禁止手工递归 `ls -R` 扫读 `~/Code` 或 `~/GitApp`（输出截断、慢、易误判）
- 禁止凭记忆回答路径，必须从索引文件读取
