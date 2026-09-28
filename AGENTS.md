# zsw-skills 项目约定

个人 skills 与 agents 管理仓库（skills/agents 的唯一管理仓库）。

## 提交纪律 [MANDATORY]

- **提交前必须同步 README**：新增 / 删除 / 改名 skill 或 agent，或技能定位发生实质变化时，提交前更新 `README.md` 与 `README.en.md`——两份 README 是中英同构双源，改必须同步改，只改一份 = 未完成
- 完成即提交：变更验证通过后汇报完成前必须 git commit，不留脏工作区；push 须用户授权

## Skill 结构约定 [MANDATORY]

- skill 目录名必须与 SKILL.md frontmatter 的 `name` 完全一致；frontmatter 必须含 `name`、`description`
- 安装形态：`ln -s <repo>/skills/self/<category>/<name> ~/.agents/skills/<name>`（禁止装到 `~/.pi/agent/skills/`）
- 跨技能引用写安装后路径（`~/.agents/skills/<name>/...`），不写本机绝对路径或仓库相对路径
- 写入本仓库的任何内容禁止含本机绝对路径（`/Users/<user>/...`）——引用位置用占位形态或安装后路径

## 用语纪律 [MANDATORY]

- 产出 / 修改任何 skill 文档的会话，收尾前跑 `python3 ~/.agents/skills/meta-words-guidance/scripts/word-scan.py <文档路径>`，命中逐项修
- 遵守全局 AGENTS.md「用语纪律」四张词表；新技能文档遵守 meta-words-guidance 审查清单
