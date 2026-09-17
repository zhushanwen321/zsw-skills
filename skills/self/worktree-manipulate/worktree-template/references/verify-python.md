# Python/Docker 交付物验证

适用于：Python FastAPI/Flask 项目、Docker 镜像项目。

## 验证命令

### PyPI 包
```bash
pip index versions <package> 2>/dev/null | grep "$VERSION" || \
  pip install <package>==$VERSION --dry-run 2>/dev/null | grep -q "Would install"
```

### Docker 镜像
```bash
docker manifest inspect <image>:$VERSION 2>/dev/null && echo "镜像存在" || echo "镜像缺失"
```

## 交付物清单

- [ ] PyPI 包已发布（或 Docker 镜像已推送）
- [ ] 镜像 tag 可拉取
- [ ] 可选：GitHub Release 含源码包
