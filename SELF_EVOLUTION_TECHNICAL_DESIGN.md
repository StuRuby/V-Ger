# V-Ger Self-Evolution Harness Technical Design (v1.1)

Date: 2026-03-30  
Branch: `feat/init`  
Status: Draft for discussion

## 1. Context and Product Goal

We are building V-Ger as a self-evolving coding agent on Pi + Kimi.  
The immediate objective is to prove real self-iteration under Harness Engineering constraints, not manual optimization by Codex.

North star:

`Under strict safety and quality constraints, continuously improve delivery capability without regressing existing behavior.`

External open-source promise:

`A reproducible self-evolution harness baseline for Chinese LLM coding agents, with explicit safety and measurable progress.`

## 2. Core Principles Agreed

1. Codex/Human is responsible for Harness Engineering, not agent feature coding.
2. Agent is responsible for improving its own functional code.
3. Every evolution round must be measurable and gate-validated.
4. No quality regression is acceptable as a tradeoff for new capability.

## 3. Responsibility Split

### 3.1 Codex/Human scope (Harness only)

- Safety policies and extension rules (`.pi/extensions/*`)
- Evolution orchestrators (`scripts/*`)
- Benchmarks and evaluation pipeline
- CI/CD automation and branch strategy

### 3.2 Agent scope (self-improvement)

- Functional implementation in `src/*`
- Tests in `tests/*`
- Small, focused capability increments per evolution cycle

### 3.3 Enforcement direction

Move from "policy by instruction" to "policy by technical enforcement":

- Add writable-scope guard in pragmatic mode:
  - allow: `src/**`, `tests/**`, `benchmarks/**`
  - allow: `docs/**`
  - deny: `.pi/**`, `scripts/**`, `.github/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `AGENTS.md`, `.env*`
- Explicitly block harness/config areas by default and require explicit override logging for exceptions.

## 4. First Single Task for Self-Evolution

Priority capability: **tool-calling reliability**.

Why first:

- It is foundational for all later autonomous improvements (testing, refactoring, bug fixing).
- It is directly measurable.
- It aligns with current architecture and available harness controls.

Task statement:

`Given coding objectives, the agent reliably selects and executes required tool chains (read/find/edit/bash) and recovers from failures without capability regression.`

## 5. Acceptance Metrics (Phase-A)

Benchmark set: fixed 100-task suite with split:

- Dev set: 80 tasks (used for iterative optimization)
- Holdout set: 20 tasks (never used in optimization prompts)

Phase-A pass criteria (must pass on holdout):

- Tool-call success rate: `>= 99%`
- Task-level success rate: `>= 95%`
- Safety violations: `0`

Anti-overfitting guard:

- Dev vs holdout task success gap must be `<= 2%`

Safety violation examples:

- Protected path modification bypass
- Dangerous command execution bypass

## 6. Benchmark Design Direction (Complex Standardized Set)

Proposed composition:

- 30 tasks: single-tool correctness (read/find/edit/bash)
- 30 tasks: multi-tool chains (find -> read -> edit -> test)
- 20 tasks: failure recovery (bad path, command failure, test failure and retry)
- 10 tasks: safety adversarial cases (path tricks and dangerous command variants)
- 10 tasks: long-chain modifications across multiple files with verification

Benchmark hygiene policy:

- Keep a static v1 seed for reproducibility.
- Rotate 10-20 holdout tasks every 2 weeks.
- Add failed real-world cases into adversarial bucket after anonymization.

## 7. Generation Model (N -> N+1)

To avoid runtime self-corruption, evolution runs in generation rounds:

1. Launch generation N process from current built artifact.
2. Agent modifies source (`src/`, `tests/`) via tools.
3. End round and run gates (`typecheck`, `test`, benchmark).
4. If pass, persist as N+1 (commit/PR candidate).
5. Next round restarts process from N+1.

Important:

- Runtime process is isolated from the next generation source changes.
- No "edit live process memory" pattern is used.

## 8. Controlled Release Surface

Autonomous edits must never land directly to `main`.

Required release boundary:

- Evolution writes to a single rolling branch: `evolve/auto`.
- Every accepted round creates one commit with machine-readable metadata.
- Merge to `main` only through PR checks:
  - `npm run typecheck`
  - `npm test`
  - benchmark gate
- Branch protection required for `main` (no direct push).

## 9. Runtime Modes

### 9.1 Local-first (recommended now)

Use local scheduled/manual evolution first for stability learning:

- Start with low frequency (e.g., daily once)
- Observe failures and refine harness before unattended cloud loops

### 9.2 GitHub Actions (next stage)

Adopt after local stability:

- Trigger mode first: `workflow_dispatch`
- Then optional `schedule`
- Target schedule after stabilization: once every 3 hours
- Always run on isolated evolution branch (not direct `main`)
- Always require gate pass before merge
- Enable workflow `concurrency` to prevent overlapping runs

## 10. Cost Budget and Circuit Breakers

Each round must have hard budget caps:

- Max round duration: 2 hours
- Max model token budget per round: no hard cap
- Max retries per failed objective: 5

Automatic stop conditions:

- `>= 5` consecutive failed rounds
- Any safety violation
- Budget breach

Scheduler safety:

- Keep single-flight execution (`concurrency`) so a new run never starts while the previous run is still active.

Recovery policy:

- Freeze autonomous evolution
- Keep latest known-good commit as active baseline
- Require human approval to resume

## 11. Observability and Artifacts

Every round must emit a structured artifact (JSON/Markdown):

- round id, objective, branch, commit sha
- changed files
- test results
- benchmark scores (dev/holdout)
- safety intercept events
- token/time cost
- pass/fail reason

Without this artifact, the round is invalid for trend analysis.

## 12. Current Project Status Snapshot

Already in place:

- Kimi + Pi bootstrap and one-shot run path
- Safety harness extensions:
  - protected-paths
  - permission-gate
  - git-checkpoint
- Manual single evolution cycle script (`evolve:cycle`)
- Post-check gates (`typecheck` + `test`)

Not yet completed for autonomous phase:

- Writable scope enforcement extension
- Multi-round orchestrator (`evolve-loop`)
- Full benchmark execution framework for 100-task suite with holdout split
- Round artifact logger
- GitHub Actions evolution workflow with branch protection assumptions

## 13. Immediate Next Implementation Items (M0/M1/M2)

### M0 (must-have before unattended automation)

1. Add writable-scope extension to enforce role boundary in code edits.
2. Implement `scripts/evolve-loop.ts` for controlled multi-round evolution.
3. Build benchmark scaffold under `benchmarks/tool-calling/v1` with dev/holdout split.
4. Add benchmark gate into evolution pipeline.
5. Add round artifact logger.

### M1 (stability and economics)

1. Add token/time budget enforcement.
2. Add circuit breaker and freeze/resume mechanism.
3. Add holdout rotation tooling.

### M2 (automation and community)

1. Add initial Actions workflow with manual trigger only.
2. Add protected evolution branch strategy and PR templates.
3. Add README section for open-source value proposition and reproducibility.

## 14. Open Decisions for Next Discussion

No blocking configuration decisions remain for the current v1.1 scope.

## 15. Definition of "Self-Evolution Success" (Current Stage)

V-Ger is considered to have reached stage success when:

- It can run multiple generations continuously.
- It improves holdout benchmark score without safety violations.
- It keeps baseline tests green across iterations.
- It stays within configured cost budgets.
- It does this primarily through agent-generated code changes, with humans/Codex only evolving the harness.
