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
| tech-design-v1 | Produces a complete design package in three stages: design document writing → adversarial review loop → implementation plan (impl-plan in dual formats); frozen v1 line, use v2 for new tasks |
| dev-flow-v1 | Turns a design package into accepted code (D0-D5 pipeline: compile & execute / consistency review / final-state sync); frozen v1 line, use v2 for new tasks |
| delivery-v1 | Delivery verdict skill: product contracts, candidate implementation, independent assurance, and a single delivery verdict; frozen v1 line, use v2 for new tasks |
| tech-design-v2 | Solution design under an approved acceptance package (produced by delivery-v2): design document → adversarial review loop → full solution package (bound to the acceptance package hash, registered as DesignApproved afterwards) |
| dev-flow-v2 | Executes the candidate implementation under the acceptance package + solution package: entry gate checks the acceptance package hash and DesignApproved; finish yields a candidate handed to delivery-v2 for verdict, never self-declares delivery |
| delivery-v2 | Acceptance (referee) skill: acceptance design → independent assurance → machine gate as the only delivery verdict; three-role signed event stream + policy packages + raw-intent anti-narrowing |
| tech-design-dev | DEV hardening line forked from the v2 trio: design semantics identical to tech-design-v2; workflow execution resilience added (agent-call structure validation with corrective re-ask, CLI failure correction hints, self-repair journal with end-of-run reporting) |
| dev-flow-dev | DEV hardening line forked from the v2 trio: execution semantics identical to dev-flow-v2; W2/W3 workflow resilience added; the W4 conformance engine is shared across generations with v2 |
| delivery-dev | DEV hardening line forked from the v2 trio: verdict semantics fully compatible with delivery-v2 (events and verdicts interoperate); three workflows gain execution resilience plus a self-repair journal (self-repairs.jsonl) surfaced in the final report |
| tech-design-v3 | Baseline copy of tech-design-dev: preserves DEV design and review semantics for comparison and rollback; no V4 mechanisms |
| dev-flow-v3 | Baseline copy of dev-flow-dev: preserves DEV execution and consistency-review semantics for comparison and rollback; no V4 mechanisms |
| delivery-v3 | Baseline copy of delivery-dev: preserves DEV acceptance, verdict, and assurance semantics for comparison and rollback; no V4 mechanisms |
| tech-design-v4 | Adds quality transfer to the V3 baseline: assertion-to-mechanism reconciliation, adversarial-form test bindings, zero-conflict T2 completion, and complete T3 reference checks |
| dev-flow-v4 | Adds three-way consistency review, candidate adversarial review after D3, current-revision exploration and zero-must-fix gates before D4, and controlled repair paths |
| delivery-v4 | Adds schema-2 acceptance assertions and adversarial forms, assertion-level verdicts, full/recheck modes, a unified repair loop, and process-failed on repair round 4 or unique must-fix 11 |
| symbol-watchlist | Symbol watchlist generation and self-check tool (extract-backticks.mjs): shared contract carrier for tech-design-v2 T3 watchlist production and dev-flow-v2 D5 pre-launch self-check |
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
