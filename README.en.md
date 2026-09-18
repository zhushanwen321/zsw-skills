# zsw-skills

Personal skills and agents repository.

[中文](README.md) | English

## Repository Layout

```
skills/
  self/            Original skills, grouped by domain
    dev-workflow/    Routine development workflow
    code-optimize/   Code optimization
    thinking/        Complex problem solving
    prompting/       Prompt engineering
    tools/           Utilities
  external/        Collected third-party skills
agents/
  self/            Personal agents
  external/        Reserved
```

## Skills

### dev-workflow/ — Routine Development Workflow

| Skill | Description |
|-------|-------------|
| tech-design | Technical design document writing with adversarial review; embeds 3 review agents |
| dev-flow | Turn an approved design document into runnable code |
| design-code-sync | Keep code implementation and design documents in sync |

### code-optimize/ — Code Optimization

| Skill | Description |
|-------|-------------|
| code-simplify | Simplify code: remove duplication, dead code, and cleanup of recent changes |
| code-harden | Production readiness hardening: exception tiers, retry policy, failure semantics, error-handling policy adjudication |
| code-overdesign-audit | Audit over-engineering and speculative abstractions; produce actionable simplification candidates |
| test-quality | Test design and layering; maximize bug-catching value per unit of effort |

### thinking/ — Complex Problem Solving

| Skill | Description |
|-------|-------------|
| rethink | Thinking framework for escaping local patch loops and re-examining the problem |

### prompting/ — Prompt Engineering

| Skill | Description |
|-------|-------------|
| meta-prompt-guidance | Methodology for designing, writing, and reviewing AI agent prompts |

### tools/ — Utilities

| Skill | Description |
|-------|-------------|
| anysearch | Unified search: general web, news, URL extraction/crawl, vertical structured search (stocks/CVE/papers/patents), and batch parallel queries |
| browser-automation | Web/Electron debugging: screenshots, element inspection, UI interaction, network monitoring |
| code-link | Trace call chains from entry points (HTTP routes, WebSocket, IPC) to related files |
| quota-wait | Suspend tasks when model quota runs out and resume on schedule |
| user-memory | Record and recall user preferences and habits |
| worktree-manipulate | Single entry for bare repo + worktree workspace management |

### external/ — Collected

| Skill | Upstream | Description |
|-------|----------|-------------|
| drawio-skill | [Agents365-ai/drawio-skill](https://github.com/Agents365-ai/drawio-skill) | drawio diagrams: flowcharts, architecture, ER diagrams |
| emil-animate-designer | [emilkowalski/skills](https://github.com/emilkowalski/skills) | Routing entry for motion design methodology; 9 sub-skills vendored in `sub-skills/` |
| handoff | collected | Compress the current session into a handoff document |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Frontend interface design, polish, and review |
| improve-codebase-architecture | collected | Architecture improvement and refactoring opportunities |
| teach | collected | Interactive teaching |
| visual-explainer | collected | Self-contained HTML visual artifacts: diagrams, diff reviews, project recaps |

## Agents

Skill-embedded agents are registered in `agents/self/` via symlinks (e.g. tech-design's tech-design-review, tech-design-impact-review, tech-design-simplicity-review). The single source of truth lives inside the owning skill's directory; do not duplicate copies here. `agents/external/` is reserved.
