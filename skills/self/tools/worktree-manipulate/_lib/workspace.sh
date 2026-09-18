#!/bin/bash
# 共享函数库：workspace 操作相关
# 被 create-worktree.sh, merge-worktree.sh 等脚本 source 使用

# 从当前目录向上查找 workspace 根（包含 .bare/ 的目录）
find_workspace_root() {
    local dir="$1"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.bare" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(cd "$dir/.." && pwd)"
    done
    return 1
}

# 获取当前分支名
get_current_branch() {
    git rev-parse --abbrev-ref HEAD 2>/dev/null
}

# 清理 worktree + 可选删除分支
# Usage: remove_worktree <workspace_root> <branch_name> [delete_branch=true] [force=false]
#   delete_branch: 是否删除本地分支（默认 true）
#   force: 跳过 dirty 拦截（销毁前列出内容），删除用 --force；分支删除直接 -D
remove_worktree() {
    local workspace_root="$1"
    local branch_name="$2"
    local delete_branch="${3:-true}"
    local force="${4:-false}"
    local dir_name="${branch_name//\//-}"
    local worktree_path="$workspace_root/$dir_name"
    local bare="$workspace_root/.bare"

    if [[ ! -d "$worktree_path" ]]; then
        echo "Error: worktree '$dir_name' 不存在。"
        return 1
    fi

    # 检查未提交/未跟踪的更改（ignored 文件不算 dirty，如 node_modules）
    # 半删除态（记录已注销、.git 指针悬空）下 git 命令会报错，跳过检查交给调用方前置检查
    local has_changes=false
    local is_git_wt=true
    git -C "$worktree_path" rev-parse --git-dir >/dev/null 2>&1 || is_git_wt=false
    if $is_git_wt; then
        if ! git -C "$worktree_path" diff --quiet 2>/dev/null || \
           ! git -C "$worktree_path" diff --cached --quiet 2>/dev/null; then
            has_changes=true
        fi
        local untracked
        untracked=$(git -C "$worktree_path" ls-files --others --exclude-standard 2>/dev/null)
        if [[ -n "$untracked" ]]; then
            has_changes=true
        fi
    fi
    if $has_changes; then
        if [[ "$force" != "true" ]]; then
            echo "Error: '$dir_name' 有未提交/未跟踪的更改，请先提交或 stash。"
            git -C "$worktree_path" status --short
            return 1
        fi
        echo "Warning: '$dir_name' 有未提交/未跟踪的更改，以下内容将随 worktree 一并销毁（--force）:"
        git -C "$worktree_path" status --short
    fi

    # 删除 worktree —— 三级兜底，根治 ignored 文件（node_modules 等）导致的半删除态：
    # git worktree remove 遇 ignored 文件会先注销记录、再删目录时失败（Directory not empty），
    # 留下「记录没了、文件还在」的半完成态；此兜底链保证最终目录与记录都被清干净
    echo "删除 worktree '$dir_name'..."
    local registered=false
    if git -C "$bare" worktree list --porcelain 2>/dev/null | grep -qx "worktree $worktree_path"; then
        registered=true
    fi

    if $registered; then
        local remove_ok=false
        if [[ "$force" == "true" ]]; then
            git -C "$bare" worktree remove --force "$worktree_path" 2>/dev/null && remove_ok=true
        else
            git -C "$bare" worktree remove "$worktree_path" 2>/dev/null && remove_ok=true
        fi
        if [[ "$remove_ok" != "true" ]]; then
            echo "  worktree remove 失败（常见原因：含 node_modules 等 ignored 文件），--force 重试..."
            git -C "$bare" worktree remove --force "$worktree_path" 2>/dev/null || true
        fi
    fi

    # 兜底：记录已注销（或本就丢失）但目录文件残留 —— rm -rf + prune 收尾
    if [[ -e "$worktree_path" ]]; then
        echo "  目录文件残留，rm -rf 兜底清理 + prune..."
        rm -rf "$worktree_path"
        git -C "$bare" worktree prune
    fi

    # 可选删除分支
    if $delete_branch; then
        if git -C "$bare" rev-parse --verify --quiet "$branch_name" >/dev/null 2>&1; then
            echo "删除本地分支 '$branch_name'..."
            if git -C "$bare" branch -d "$branch_name" 2>/dev/null; then
                :
            elif [[ "$force" == "true" ]]; then
                git -C "$bare" branch -D "$branch_name"
            else
                # -d 拒删可能因本地默认分支落后于远程；验证已并入远程默认分支后再删，否则保留
                local default_branch
                default_branch=$(git -C "$bare" symbolic-ref --short HEAD 2>/dev/null || echo main)
                if git -C "$bare" merge-base --is-ancestor "$branch_name" "origin/$default_branch" 2>/dev/null; then
                    git -C "$bare" branch -D "$branch_name"
                else
                    echo "Warning: 分支 '$branch_name' 未检出已合并到 origin/$default_branch，保留分支。"
                    echo "  确认不需要后可手动: git --git-dir=$bare branch -D $branch_name"
                fi
            fi
        fi
    fi
}

# 检查 worktree 是否干净（无未提交变更）
is_worktree_clean() {
    local workspace_root="$1"
    local branch_name="$2"
    local dir_name="${branch_name//\//-}"
    git -C "$workspace_root/$dir_name" diff --quiet 2>/dev/null && \
    git -C "$workspace_root/$dir_name" diff --cached --quiet 2>/dev/null
}

# 获取所有 worktree 目录（排除 .bare 和 node_modules）
list_worktrees() {
    local workspace_root="$1"
    for wt in "$workspace_root"/*/; do
        local name
        name="$(basename "$wt")"
        [[ "$name" == ".bare" || "$name" == "node_modules" ]] && continue
        echo "$name"
    done
}
