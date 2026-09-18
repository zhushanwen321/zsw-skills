---
name: workspace-worktree
# 由 worktree-manipulate 路由调用，不直接暴露给模型自动加载
disable-model-invocation: true
description: >
  Manage git worktrees in a bare-repo workspace pattern (e.g. ~/Code/project-workspace/ with .bare/).
  Handles worktree creation with automatic githook installation, listing, cleanup, and branch-based directory naming.
  Use when user mentions "worktree", "workspace", "创建worktree", "切换分支", "工作区管理",
  or when starting feature work that needs a separate worktree.
  Also use when user says "workspace-worktree" or asks about managing multiple branches simultaneously.
---

# Workspace Worktree Manager

Manage git worktrees in a bare-repo workspace layout where `.bare/` sits alongside worktree directories.

## Workspace Layout Convention

```
~/Code/project-workspace/
├── .bare/                          # Bare git repository (shared)
│   ├── config
│   ├── hooks/
│   │   └── post-checkout           # Auto-installs githooks for new worktrees
│   └── worktrees/
│       ├── main/
│       ├── feat-auth/
│       └── fix-bug/
├── main/                           # worktree for main branch
├── feat-auth/                      # worktree for feat/auth
└── fix-bug/                        # worktree for fix/bug
```

**Convention:** worktree directory name = branch name with `/` replaced by `-`.
Example: branch `feat/auth` → directory `feat-auth/`.

## Commands

### 1. Create Worktree

When user says: "创建worktree", "new worktree", "start feature", "开新分支"

**Steps:**

1. Determine branch name. Ask user if not specified.
2. Derive directory name: replace `/` with `-` in branch name.
3. Check if directory already exists.
4. Create worktree from an existing worktree:

```bash
# From any existing worktree (e.g. main/)
cd <existing-worktree>
git worktree add ../<dir-name> -b <branch-name> <base-ref>
```

5. Run project setup in new worktree:

```bash
cd ../<dir-name>
# Node.js
[ -f package.json ] && npm install
# Frontend
[ -f frontend/package.json ] && cd frontend && npm install && cd ..
```

6. Verify githooks were installed by `post-checkout`:

```bash
git_dir=$(git rev-parse --git-dir)
[ -f "$git_dir/hooks/pre-commit" ] && echo "hooks OK" || echo "hooks MISSING"
```

7. Report result to user.

**Common base refs:**
- `main` — start from main branch
- `HEAD` — start from current worktree's HEAD
- `<other-branch>` — start from specific branch

### 2. List Worktrees

When user says: "list worktrees", "查看worktree", "工作区列表"

```bash
cd <any-worktree>
git worktree list
```

Also show directory status:

```bash
for dir in ../*/; do
  dir="${dir%/}"
  name=$(basename "$dir")
  [ "$name" = ".bare" ] && continue
  branch=$(cd "$dir" && git branch --show-current 2>/dev/null || echo "detached")
  hooks=$([ -f "$(cd "$dir" && git rev-parse --git-dir)/hooks/pre-commit" ] && echo "✓ hooks" || echo "✗ no hooks")
  echo "$name → $branch ($hooks)"
done
```

### 3. Remove Worktree

When user says: "remove worktree", "删除worktree", "clean up"

**Safety checks before removal:**

1. Check for uncommitted changes:

```bash
cd <worktree-dir>
git status --short
```

2. If dirty, warn user and ask for confirmation.

3. Check for unmerged branches (branch only exists in this worktree):

```bash
git branch --list <branch-name>
```

4. Remove:

```bash
cd <any-other-worktree>
git worktree remove ../<dir-name>
# Optionally delete the branch too
git branch -d <branch-name>  # or -D if force needed
```

### 4. Install/Reinstall Githooks

When user says: "install hooks", "安装hooks", "hooks missing"

```bash
cd <worktree-dir>
bash .githooks/install-hooks.sh
```

**Note:** `post-checkout` hook in `.bare/hooks/` does this automatically on `git worktree add`.
But for existing worktrees or after hook script changes, manual reinstall is needed.

## Post-Checkout Hook (Bare Repo)

The `.bare/hooks/post-checkout` hook is responsible for automatic githook installation:

```bash
#!/bin/bash
# Triggered by: git worktree add, git checkout
# PWD = new worktree root

INSTALLER=".githooks/install-hooks.sh"
if [ -f "$INSTALLER" ]; then
    bash "$INSTALLER" 2>/dev/null
fi
```

**This hook lives outside git tracking** (in `.bare/hooks/`), not in any branch.
On a new machine, it must be created manually or via a setup script.

### One-Time Setup (New Machine)

When cloning into a bare repo workspace for the first time:

```bash
# 1. Create bare clone
git clone --bare <repo-url> project-workspace/.bare

# 2. Create main worktree
cd project-workspace
git worktree add main main

# 3. Install post-checkout hook
cat > .bare/hooks/post-checkout << 'EOF'
#!/bin/bash
INSTALLER=".githooks/install-hooks.sh"
if [ -f "$INSTALLER" ]; then
    bash "$INSTALLER" 2>/dev/null
fi
EOF
chmod +x .bare/hooks/post-checkout

# 4. Setup main worktree
cd main
npm install
bash .githooks/install-hooks.sh
```

## Integration with Pre-Commit Hook

The `.githooks/install-hooks.sh` generates a pre-commit hook that runs:
1. **Prettier** — auto-format `.ts`/`.vue`/`.css` files
2. **ESLint** — lint + auto-fix frontend code
3. **vue-tsc** — type checking
4. **Code rules** — custom Vue component checks

Each branch may have its own version of `.githooks/install-hooks.sh`.
The `post-checkout` hook always runs the version in the new worktree,
so hooks evolve with the code.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `post-checkout` not triggering | Hook not executable | `chmod +x .bare/hooks/post-checkout` |
| Hooks not installed in new worktree | `.githooks/` missing on that branch | Merge from branch that has it |
| `install-hooks.sh` fails with "未找到 .git" | Old script version, no worktree support | Merge latest version from main |
| Worktree dir name ≠ branch name | Manual creation with custom path | `git worktree list` shows actual mapping |
| `pre-commit` not found after npm install | `npm prepare` didn't run | `bash .githooks/install-hooks.sh` manually |
