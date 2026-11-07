# @deepseek-ai/dsh-toranja-orchestrator

Toranja-owned project lanes and role-based routing for the desktop harness.
The plugin registers configured directories as durable Workspaces, exposes a
model-readable project catalog, and delegates a role-scoped task to Codex,
Antigravity, or both providers concurrently in the selected directory.

The authenticated desktop controller exposes three routing modes for
delegations that omit an explicit provider:

- `codex`: route every role to Codex;
- `antigravity`: route every role to Antigravity;
- `team`: route planning and review to Antigravity, and implementation,
  testing, and release to Codex.

An explicit provider always wins. The `both` option remains available for
independent cross-provider read-only work; write isolation rejects two
implementers sharing one worktree.

The plugin never handles provider credentials. Codex and Antigravity keep using
their independently configured local authentication and safety boundaries.

`delegate_project_task` starts managed subagents and returns immediately with
their ids. Standard Harness completion notifications deliver final results to
the lead conversation. Admission limits cap total, per-project, and per-provider
concurrency. By default, two implementers cannot share one project worktree.

`get_orchestration_status` reports provider registration plus active, completed,
and failed run counts without spending provider credits. `run_delivery_gate`
waits for an Antigravity reviewer and a Codex tester and returns `ready` only
when both independently emit an explicit pass verdict. The Agent Team task board
remains the durable source of task status, dependencies, ownership, and
write-scope warnings.

The process-local `ToranjaOrchestrator` service also supports the reverse lead
flow. A primary Antigravity turn can submit a validated Codex assignment,
await its managed child result, and continue the same main-chat turn with that
evidence. The service uses the same ledger and project lanes as
`delegate_project_task`, so reverse delegation does not bypass admission,
write-isolation, provider, or task-accounting rules.
