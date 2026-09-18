# Electron 交付物验证

适用于：Electron + GitHub Release 项目。

## 验证命令

```bash
TAG="v$VERSION"

# 检查 Release 存在
gh release view "$TAG" --json tagName

# 检查各平台产物
ASSETS=$(gh release view "$TAG" --json assets -q '.assets[].name')

echo "$ASSETS" | grep -q "\.dmg$"      && echo "macOS .dmg"      || echo "MISSING .dmg"
echo "$ASSETS" | grep -q "\.exe$"     && echo "Windows .exe"    || echo "MISSING .exe"
echo "$ASSETS" | grep -q "\.AppImage" && echo "Linux AppImage"  || echo "MISSING AppImage"
```

## 交付物清单

- [ ] GitHub Release 存在
- [ ] macOS .dmg（文件大小 > 50MB）
- [ ] Windows .exe 安装包
- [ ] Linux .AppImage
- [ ] 可选：.tar.gz / .zip 压缩包
