# npm 交付物验证

适用于：npm monorepo 项目、单个 npm 包项目。

## 验证命令

```bash
# 检查包版本是否已发布
npm view <package>@<version> version

# 验证包内容（可选）
npm pack --dry-run 2>/dev/null | head -20

# monorepo：检查所有子包
for pkg in $(node -e "
  const ws = require('./package.json').workspaces || [];
  ws.forEach(w => console.log(w.replace('/*', '')));
"); do
  for sub in $pkg/*/package.json; do
    name=$(node -p "require('$sub').name")
    ver=$(node -p "require('$sub').version")
    npm view "$name@$ver" version 2>/dev/null && echo "  $name@$ver" || echo "  MISSING: $name@$ver"
  done
done
```

## 交付物清单

- [ ] GitHub Release 存在（如有）
- [ ] npm 包已发布（`npm view` 返回版本号）
- [ ] monorepo 所有子包均已发布
