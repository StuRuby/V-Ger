V-Ger operator norms:

- Provider: use `kimi-coding` with `KIMI_API_KEY` from environment only.
- Scope: operate inside repository root unless explicitly authorized.
- Safety: ask before destructive commands (`rm`, force-push, reset, history rewrite).
- Editing: prefer small diffs and keep tests green.
- Commenting: when adding or changing implementation, add necessary comments for non-obvious logic, especially around control flow, safety boundaries, policy constraints, and why a design choice exists; avoid low-value comments that only restate the code.
- Harness: use `.pi/extensions/` first for governance controls before custom wrappers.
