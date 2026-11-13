# zsw-skills

Personal skills and agents repository.

[中文](README.md) | English

## Repository Layout

```
skills/
  self/            Original skills, grouped by domain
    dev-workflow/    Routine development workflow (includes dual-platform workflow scripts, see "Workflow Dual-Platform Build")
    code-optimize/   Code optimization
    thinking/        Complex problem solving
    prompting/       Prompts & wording
    tools/           Utilities
  external/        Collected third-party skills
agents/
  self/            Personal agents (registered via symlinks)
  external/        Reserved
scripts/           Dual-platform workflow build and validation scripts
```

## Skills

### dev-workflow/ — Routine Development Workflow

| Skill | Description |
|-------|-------------|
| tech-design-wf | Produces a complete design package in three stages: design document writing → adversarial review loop → implementation plan (impl-plan in dual formats) |
| dev-flow-wf | Turn the complete design package produced by tech-design-wf into accepted code |
| delivery-wf | Generic design and delivery skill: product contracts, candidate implementation, independent assurance, and a single delivery verdict; includes dual-platform workflows and risk-scaled execution |
| symbol-watchlist | Symbol watchlist generation and self-check tool (extract-backticks.mjs): shared contract carrier for tech-design-wf T3 watchlist production and dev-flow-wf D5 pre-launch self-check |
| design-code-sync | Keep code implementation and design documents in sync |
| architecture-clean-domain-design | Domain modeling and architecture analysis with DDD and hexagonal architecture as analysis lenses: ubiquitous language, bounded contexts, aggregate invariants, ring-nature mapping; records and maps only — never outputs structural transformation designs |
| workflow-authoring | Authoring and observability onboarding guide for dual-platform workflow scripts: single-source build layout, GUI lane constraints, five-step observability onboarding, check gates, and data layout |

Internal module `dev-workflow/conformance-plane/` — conformance control plane for design obligations (domain core of the D5 v2 reconciliation engine; module map and commands in `skills/self/dev-workflow/conformance-plane/README.md`):

| Subdirectory | Description |
|--------|------|
| kernel/ | State store (append-only event JSONL + snapshot + single-writer lock), deterministic fold, evidence hash invalidation, fact schema (sole authority for the full event vocabulary) |
| extractors/ + checkers/ | Conformance-binding obligation extraction (coverage denominator counts bound obligations only), checker registry (exit contract 0/10/20), semantic cache, backlog adoption loop |
| workspace/ + changeset/ + integration/ | Real-path repo inventory, isolated worktree sandbox (zero writes to formal repos), multi-repo patch manifest, integrator as the sole write gate (apply precheck + host hooks + two-phase commit), document-proposal ruling loop |
| reports/ | Four-layer outcome derivation (scriptStatus / engineOutcome / integrationOutcome / deliveryOutcome, all computed by folding the event stream) and five-view rendering (current/final/matrix/trajectory/ledger, written to the design package `<name>/v2/`) |
| migration/ | Legacy final import (alias + manual mapping rulings + four structural validations + idempotent replay) and per-package cutover (cutover marker, legacy-final rename archive + tombstone pointer, Unarchived revival channel) |

### code-optimize/ — Code Optimization

| Skill | Description |
|-------|-------------|
| code-simplify | Simplify code: remove duplication, dead code, and cleanup of recent changes |
| code-harden | Production readiness hardening: exception tiers, retry policy, failure semantics, error-handling policy adjudication |
| code-domain-review | Diff behavior-correctness review: adversarial verification of intent, boundary conditions, error paths, side effects, and aggregate-invariant checks; embeds a review-fix-loop compatible reviewer |
| code-arch-review | Single-pass architecture walkthrough (methodology body of improve-codebase-architecture): module depth, seams, testability, and dependency-health dual views; produces candidate cards, review only |
| code-overdesign-audit | Audit over-engineering and speculative abstractions; produce actionable simplification candidates |
| architecture-decay-audit | Audit architecture decay (compensation-mechanism buildup, convoluted designs); produce an actionable decay list and repair directions |
| architecture-improve-loop | Architecture improvement loop: review, fix, re-review; land improvement candidates directly instead of only reporting |
| test-quality | Test design and layering; maximize bug-catching value per unit of effort |

### thinking/ — Complex Problem Solving

| Skill | Description |
|-------|-------------|
| rethink | Thinking framework for escaping local patch loops and re-examining the problem |

### prompting/ — Prompts & Wording

| Skill | Description |
|-------|-------------|
| meta-prompt-guidance | Methodology for designing, writing, and reviewing AI agent prompts |
| meta-words-guidance | Wording review: remove jargon and hard-to-parse terms; ships with adjudicated word lists and a scan script |

### tools/ — Utilities

| Skill | Description |
|-------|-------------|
| anysearch | Unified search: general web, news, URL extraction/crawl, vertical structured search (stocks/CVE/papers/patents), and batch parallel queries |
| browser-automation | Web/Electron debugging: screenshots, element inspection, UI interaction, network monitoring |
| quota-wait | Suspend or stand by when model quota runs out; bundled CLI polls plan quota and returns on reset or deadline |
| user-memory | Record and recall user preferences and habits |
| worktree-manipulate | Single entry for bare repo + worktree workspace management |
| zsession-wait | Watch another zcode session until fully stopped (idle + all subagents / workflows / background bash finished); reports "stopped", not "succeeded" |

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

## Workflow Dual-Platform Build

Workflow scripts for the dev-workflow family of skills are maintained for two platforms (zcode and pi) from a single source:

- Source: `skills/self/dev-workflow/workflows/src/`, one `*.shared.ts` shared body plus per-platform shell templates per script pair
- Artifacts: zcode side `workflows/*.dwf.ts`, pi side `workflows/pi/*.js`

Validation scripts under `scripts/` run in pre-commit (with `core.hooksPath` pointing at `.githooks/`) when staged changes touch workflow sources or artifacts:

| Script | Description |
|--------|-------------|
| build-workflows.mjs | Build dual-platform artifacts from `workflows/src/` |
| check-workflow-parity.mjs | Reconciliation check between zcode/pi artifacts |
| check-workflow-types.mjs | Run tsc strict over zcode artifacts against the platform facade declaration (`wf-facade.d.ts`) |
| check-commit-contract.mjs | Commit-message structure contract check: renderer and reverse-lookup pinned to one real round trip (only when wave-executor files are staged) |

## Agents

Skill-embedded agents are registered in `agents/self/` via symlinks. The single source of truth lives inside the owning skill's directory; do not duplicate copies here. `agents/external/` is reserved.
