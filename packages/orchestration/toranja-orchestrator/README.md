# @deepseek-ai/dsh-toranja-orchestrator

Toranja-owned project lanes and role-based routing for the desktop harness.
The plugin registers configured directories as durable Workspaces, exposes a
model-readable project catalog, and delegates a role-scoped task to Codex,
Antigravity, or both providers concurrently in the selected directory.

The authenticated desktop controller exposes three routing modes for
delegations that omit an explicit provider:

- `codex`: route every role to Codex;
- `antigravity`: route every role to Antigravity;
- `team`: route each role to its `roleProviders` entry, or by default planning
  and review to Antigravity and implementation, testing, and release to Codex.
  A provider that is not registered is replaced by the first registered one in
  `fallbackOrder`, so a deployment with one connected provider routes every
  role to it.

## Stored choices

The controller's `setMode` changes the mode, execution profile, fallback order,
provider per role, cross-review setting, and team size. It stores the fields the request
names in the `toranja_orchestration` storage domain and changes the live routing
only after that write succeeds; a failed write rejects and leaves the routing in
force. On restart each stored field replaces the matching `Config` default; a
field the user never changed is not stored and keeps following the
configuration. Model routing (`routing`) and concurrency
limits stay configuration-only.

## Connected providers and team size

`probeProviders` on the controller looks for each provider CLI (`executables`,
by default `codex`, `agy`, and `claude` in `PATH`) and runs its official status
command: `codex login status`, `claude auth status`, and `agy models`, which
succeeds only for a signed-in account. Each provider then reports `connected`,
`signed-out`, `not-installed`, or `unknown` under `providers[].connection`.
Routing skips a provider that is signed out or not installed and keeps one that
is `unknown`, which is every provider before the first probe. OpenRouter has no
CLI: it is `connected` while the credential `openrouterKeyRef` (by default
`OPENROUTER_API_KEY`) is stored, and it stays out of routing until
`routing.openrouter.models` names a model. `probeOnStart` runs one probe when
the plugin starts.

`connectProvider` opens the provider's official sign-in command in a terminal
window: `codex login`, `claude auth login`, or `agy`, whose interactive start
begins its own sign-in. The user completes the sign-in in that window and the
client reads the result with `probeProviders`. The orchestrator never receives
account credentials. OpenRouter connects with an API key stored through
Settings, so `connectProvider` rejects it.

The team size is how many agents may work in one project at the same time. It
defaults to `maxConcurrentPerProject`, the user changes it with `teamSize` on
`setMode`, and it is stored like the other choices. The total and per-provider
limits never fall below it. In `delegate_project_task`, provider `both` runs a
task on the first two connected providers in `fallbackOrder` and `all` on every
connected provider up to the team size.

## Routing by role

Every delegation resolves a route: provider, model tier, concrete model and
reasoning effort, and filesystem access. `get_orchestration_status` and the
controller snapshot list the current route of each role under `routes`.

| Role | Access | `economico` | `equilibrado` | `qualidade` |
|---|---|---|---|---|
| `reader`, `searcher`, `inspector` | `read-only` | `light` | `light` | `light` |
| `planner`, `architect`, `reviewer` | `read-only` | `advanced` | `advanced` | `max` |
| `implementer` | `write` | `advanced` | `advanced` | `advanced` |
| `tester`, `release` | `execute` | `light` | `advanced` | `advanced` |

`routing.<provider>.models` maps each tier to `{ model, effort }`; `max` uses
the `advanced` entry when it has none, and an omitted field keeps the provider's
own default. `routing.<provider>.base` is the configuration of that provider's
plugin. With a `base`, Toranja starts its own provider instance per distinct
route and applies the route to it; without one, delegations use the
deployment's unrouted instance and no model is applied, so `models` without
`base` is rejected at load. `base` is supported for `codex`, `antigravity`, and `claude-code`. `openrouter`
takes `models` alone, because the internal agent receives its model per start.

| Provider | `read-only` enforcement |
|---|---|
| `codex` | Native `read-only` sandbox: writes are denied outside the model. |
| `antigravity` | `plan` mode without tool auto-approval. The CLI applies it as a directive to the model, so it is advisory. |
| `claude-code` | Native `plan` permission mode: Claude Code refuses edits and file creation. |
| `openrouter` | None. The task runs on the internal `spawn` agent (`openrouterProvider`) with `agentOptions` selecting `openrouterLlmProvider` and the routed model; only the working-tree check below applies. |

For `read-only` and `execute` roles Toranja also fingerprints the Git working
tree before and after the run: the diff against `HEAD`, plus the path, size, and
modification time of untracked and ignored entries. A `read-only` run that
changes either, or an `execute` run that changes tracked files, settles as
failed with that reason; in `run_delivery_gate` its verdict becomes `invalid`.
The check detects a change and does not revert it. Its limits:

- An ignored directory is fingerprinted as one entry, so a change deep inside
  it, such as in `node_modules`, is not detected.
- A directory that is not a Git work tree with a commit is not checked.
- An implementer running in the same project makes the comparison meaningless.
  `run_delivery_gate` refuses to start while one is active and turns the verdict
  `invalid` when one starts during the gate; any other delegation skips the
  check.

An explicit provider always wins. The `both` option remains available for
independent cross-provider read-only work; write isolation rejects two
implementers sharing one worktree.

The plugin never handles provider credentials. Codex and Antigravity keep using
their independently configured local authentication and safety boundaries.

## Fallback, cross-review, and replanning

A Team-mode delegation that names no provider may move to another connected
provider, in `fallbackOrder`. It moves when the routed provider refuses to
start, or when its run fails for a reason of the provider itself: quota or rate
limit, outage, timeout, or a missing or crashed process. The next provider
receives the identical task. A run that fails on its own merits stays where it
ran, and a named provider or a solo mode never falls back. An `implementer`
moves only when its provider refuses to start: once it has run it may have
written files, so a provider failure midway settles the task as failed instead
of rerunning it over a partly changed working tree. Each provider that
was left settles as a failed task and is listed under `fallbackFrom`.

`run_delivery_gate` accepts `implementationTaskId`, the `taskId` of the
delegated implementer run under review; it must be a completed implementer task
of the project. With `crossReview` (default `true`) the gate then routes the
reviewer to a provider other than that task's and reports `implementerProvider`
and `independentReview`. When no other provider is connected the implementing
provider reviews its own work and `independentReview` is `false`. Without the
task id the gate does not guess the implementer from project history: the
reviewer follows the normal route and neither field is reported.

With `replanOnGateFailure` (default `true`), a gate with an explicit `FAIL`
verdict starts a planner that receives each gate answer, the acceptance
criteria, and the implementation summary, each within its own share of
`maxTaskChars`. The gate returns immediately with the planner's `taskId` and
`subagentId` under `replan`; the plan itself arrives as that subtask's result.
An inconclusive gate does not replan.

`delegate_project_task` starts managed subagents and returns immediately with
their ids. Standard Harness completion notifications deliver final results to
the lead conversation. Admission limits cap total, per-project, and per-provider
concurrency. By default, two implementers cannot share one project worktree.

`get_orchestration_status` reports provider registration plus active, completed,
and failed run counts without spending provider credits. `run_delivery_gate`
waits for a reviewer and a tester, routed like any other role under the current
mode, and returns `ready` only when both independently emit an explicit pass
verdict without changing tracked files. The Agent Team task board
remains the durable source of task status, dependencies, ownership, and
write-scope warnings.

The process-local `ToranjaOrchestrator` service also supports the reverse lead
flow. A primary Antigravity turn can submit a validated Codex assignment,
await its managed child result, and continue the same main-chat turn with that
evidence. The service uses the same ledger and project lanes as
`delegate_project_task`, so reverse delegation does not bypass admission,
write-isolation, provider, or task-accounting rules.
