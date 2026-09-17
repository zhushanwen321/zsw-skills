# changeset 独立版本发布流程

适用于：pnpm monorepo 使用 changeset 管理独立版本的项目。

## 关键差异

| | 统一版本模式 | changeset 独立版本 |
|---|---|---|
| bump 方式 | `npm version patch` | `pnpm changeset version` |
| 子包版本 | 全部同步 | 各自独立 |
| PR 要求 | 无 | 必须包含 changeset 文件 |
| tag | `v{版本}` | `v{根版本}`（仅触发 CI） |
| 交付物 | GitHub Release | npm registry |

## 项目必须提供

`scripts/publish.sh`：消费 changeset → bump 子包 → bump 根版本 → commit + tag + push

```bash
#!/bin/bash
set -euo pipefail
VERSION_TYPE="${1:-patch}"

# 消费 changeset
pnpm changeset version

# bump 根版本
CURRENT=$(node -p "require('./package.json').version")
NEW=$(npm version $VERSION_TYPE --no-git-tag-version | sed 's/^v//')

# commit + tag
git add -A
git commit -m "chore: bump versions"
git tag "v$NEW"
git push origin HEAD:refs/heads/main --tags
```

## AI 约束

[MANDATORY] PR 中必须包含 `pnpm changeset` 创建的 changeset 文件。无 changeset → merge 后无包可发。

[MANDATORY] 阶段 6 用 `npm view` 验证 registry 包，不验证 GitHub Release assets。
