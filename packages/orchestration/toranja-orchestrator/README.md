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

The controller's `setMode` changes the routing mode, and `updateSettings`
changes the execution profile, fallback order, provider per role, cross-review
setting, team size, and tier models without naming the mode, so a client
holding an older snapshot does not undo a mode chosen meanwhile. Both store the
fields the request names in the `toranja_orchestration` storage domain and
change the live routing only after that write succeeds; a failed write rejects
and leaves the routing in force. On restart each stored field replaces the
matching `Config` default; a field the user never changed is not stored and
keeps following the configuration. A change applies to tasks started
afterwards: a running task keeps the provider, model, and effort it started
with. `fallbackOrder` rejects an unknown or repeated provider, in a request and
in the configuration alike. `onboarded` records that the user finished or
dismissed the first-run setup.

Stored values are held to the configuration in force when they are read: a
stored team size above a lowered `maxTeamSize` is brought down to it, and stored
tier models a provider's current configuration no longer accepts are ignored
with a warning, leaving the deployment table in force for that provider.

`tierModels` sets the model and effort of a tier per provider. Each provider the
request names has its table replaced: a tier it omits follows
`routing.<provider>.models`, and an empty table drops what the user set for that
provider. The request is validated against every provider instance the table
can lead to before it is stored. It is accepted only for a provider whose tasks
a model can reach: one with `routing.<provider>.base`, so Toranja owns its
instances, and OpenRouter, which takes the model per task. Each provider reports
the result under `providers[]`: `tierModels` is the table in force,
`tierModelOverrides` the tiers the user set, `tierModelsEditable` whether the
deployment allows setting them, and `readOnlyEnforcement` how a `read-only`
task is kept from writing there (`none` when Toranja owns no instance of the
provider). `roles` lists the roles the provider may take: every role, except
that OpenRouter takes only the writing role unless `openrouterUnenforcedAccess`
is set. Provider instances (`routing.<provider>.base`), executables,
credential references, and the concurrency limits stay configuration-only.

## Connected providers and team size

`probeProviders` on the controller looks for each provider CLI (`executables`,
by default `codex`, `agy`, and `claude` in `PATH`) and runs its official status
command: `codex login status`, `claude auth status`, and `agy models`, which
succeeds only for a signed-in account. Each provider then reports `connected`,
`signed-out`, `not-installed`, or `unknown` under `providers[].connection`.
A status that could not be read reports `probe-failed`. Routing uses only
providers that are `connected` or `unknown`, which is every provider before the
first probe. OpenRouter has no
CLI: it is `connected` while the credential `openrouterKeyRef` (by default
`OPENROUTER_API_KEY`) is stored, and it stays out of routing until
`routing.openrouter.models` or the user's `tierModels` names a model. `probeOnStart` runs one probe when
the plugin starts.

`connectProvider` opens the provider's official sign-in command in a terminal
window: `codex login`, `claude auth login`, or `agy`, whose interactive start
begins its own sign-in. The user completes the sign-in in that window and the
client reads the result with `probeProviders`. The orchestrator never receives
account credentials. OpenRouter connects with an API key stored through
Settings, so `connectProvider` rejects it.

The team size is how many agents may work in one project at the same time. It
defaults to `maxConcurrentPerProject`, the user changes it with `teamSize` up to
`maxTeamSize` (8 by default, reported as `limits.maxTeamSize`), and it is stored
like the other choices. The total and per-provider limits never fall below it. In `delegate_project_task`, provider `both` runs a
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
| `openrouter` | None. The task runs on the internal `spawn` agent (`openrouterProvider`) with `agentOptions` selecting `openrouterLlmProvider` and the routed model, and nothing keeps that agent from writing. OpenRouter therefore takes only the `write` role; `openrouterUnenforcedAccess` lets it take the others with the working-tree check below as the sole safeguard. |

For `read-only` and `execute` roles Toranja also fingerprints the Git working
tree before and after the run: the diff against `HEAD`, plus the path, size, and
modification time of untracked and ignored entries. A `read-only` run that
changes either, or an `execute` run that changes tracked files, settles as
failed with that reason; in `run_delivery_gate` its verdict becomes `invalid`.
The check detects a change and does not revert it. Its limits:

- An ignored directory is fingerprinted as one entry, so a change deep inside
  it, such as in `node_modules`, is not detected.
- A directory that is not a Git work tree with a commit cannot be checked. A delegated task then runs unchecked; the delivery gate, which is strict, reports that access could not be verified and does not pass.
- The repository belongs to the agents being checked, so the check runs nothing its Git configuration names: Git is resolved once from `PATH`, the file-system monitor is off, hooks are looked up in an empty directory the Host owns, external diff and textconv drivers are off, submodules are not entered, and every content filter (`filter.*.clean`, `smudge`, `process`) defined in any configuration scope is switched off for the check's commands. `required` is switched off with it, so a Git LFS repository is still read; its files are then compared as stored, the same way before and after the run. A filter whose name contains `=` cannot be switched off from the command line, so such a tree counts as unreadable.
- A file Git was told to skip (`assume-unchanged` or `skip-worktree`) is invisible to `git diff`. The check compares those index flags, the content of each regular file under them, and the set of configured filters, and reports `changed Git state that hides file changes` when a non-writing role altered any of them.
- Untracked files are compared by content, up to 5 MB each and 64 MB in one reading, in path order. Ignored files and directories, and larger untracked files, are compared by path, size, and modification time: there a same-size rewrite that restores the modification time is not seen, and a change deep inside an ignored directory is not either.
- A reading that fails is tried once more before the check counts as unreadable, since Git can refuse for a moment while another command changes the repository.

## Implementer worktrees

With `implementerWorktrees`, `delegate_project_task` gives each implementer a Git
worktree and branch of its own (`toranja/<id>`, created from the project's
current commit under `worktreeRoot`, by default `.toranja-worktrees` beside the
project) instead of the project's working tree:

- Implementers can then work at the same time, up to the team size, and
  `both` or `all` gives each provider its own worktree. An isolated implementer
  does not hold the project's tree, so readers running meanwhile are still
  checked.
- The activation reports `worktree` and `branch`. A worktree with changes,
  commits on its branch, a nested repository, files Git ignores, or a file Git
  was told to skip is kept for review and merge, and its task
  keeps both fields in the status; one the implementer left untouched is
  removed with its branch once the implementer settles. When the plugin stops
  while an implementer is running, its worktree is left in place, never removed
  under it.
- When the plugin starts with isolation on, it looks in each project for
  worktrees an earlier run left under the worktree root on a `toranja/*`
  branch. One older than a day that holds no work is removed with its branch:
  no changes, and a commit some branch or tag outside `toranja/*` also holds.
  Every other one is kept and listed in the status as `leftoverWorktrees`,
  for review, merge, or `git worktree remove` by hand. A worktree younger than
  a day is never removed, since another running Toranja may be using it.
- The checkout runs with the repository's content filters off, so a Git LFS
  file is its pointer in the worktree. The worktree is later inspected through
  the Git directory recorded when it was created, not through the `.git` entry
  the implementer could have replaced. `worktreeRoot` must be absolute.
- `run_delivery_gate` with that task's `implementationTaskId` runs the reviewer
  and tester in the worktree.
- Uncommitted changes in the project's tree are not in the worktree: it starts
  from the commit. Merging the branch back is left to the leader or the user.
- When the project is not a Git work tree with a commit, or Git refuses, the
  implementer runs in the project's own tree under the one-at-a-time rule.

The option is off by default.
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
