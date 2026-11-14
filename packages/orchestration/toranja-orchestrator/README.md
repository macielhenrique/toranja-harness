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
setting, team size, tier models, and approval policy without naming the mode, so a client
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
- A file Git was told to skip (`assume-unchanged` or `skip-worktree`) is invisible to `git diff`. The check compares those index flags, the content of each regular file under them up to 5 MB (a larger one by size, modification time, and change time), and the set of configured filters, and reports `changed Git state that hides file changes` when a non-writing role altered any of them.
- Untracked files are compared by content, up to 5 MB each and 64 MB in one reading, in path order. Ignored files and directories, and untracked files past either limit, are compared by path, size, modification time, and change time. The change time moves on every write and is not restored with the modification time, so a same-size rewrite is seen wherever the file system records it; a change deep inside an ignored directory is not seen.
- A reading that fails is tried once more before the check counts as unreadable, since Git can refuse for a moment while another command changes the repository.
- Every Git command of the Host runs with replacement objects off (`--no-replace-objects`), so a `refs/replace/` ref cannot make one commit read as another, and is stopped after 60 seconds; a stopped command is a reading that failed.

## Task classification

`classify_project_task` predicts how a task will be classified, without starting agents. It takes `project`, `task`, `writeScope`, and an optional `level` that can only raise the result, and returns `level` (`simple`, `moderate`, or `complex`), `path` (`direct`, `investigate`, or `approve`), the `reasons` that fired, the normalized `writeScope`, and the `limits` in force. It counts the project's direct budget like a delegation does (see [Approval policy](#approval-policy)); the Host classifies again when a plan is submitted and when the implementer is delegated.

The rules are deterministic and run on the Host. A task is `complex` when its text contains a risk term, its scope touches a protected path, its scope has any directory entry (including `./`, the whole project), or it lists more than `maxInvestigatedFiles` files. Otherwise it is `moderate` when it lists more than `maxDirectFiles` files, and `simple` when none of these holds. A directory always needs approval because it can hold protected paths its entry never names: `db/` holds `db/migrations/`, and `apps/web/` holds `apps/web/.env`; the reason reads `directory scope <entry> needs approval`.

The risk terms are stems matched at the start of a word. The task text and each term are first normalized the same way (Unicode NFKC, invisible format characters removed, camelCase split, lower case), so a configured `deleteUser` matches `deleteUser now`; then a term matches where it begins the text or follows a character that is not a letter, with anything after it: `delet` matches `deleted`, `delete_user`, and `deleteUser`, and `token` matches `auth_token`. A space inside a term matches any run of white space, so `rm -r` matches `rm   -rf`. The list is a heuristic and false positives are intentional: `author` matches `auth` and `dropdown` matches `drop`, and the error falls on the side of asking for approval. `classification` in the configuration sets `maxDirectFiles` (3), `maxInvestigatedFiles` (10), `riskTerms`, and `protectedPaths`; a value left out keeps its default, an explicit empty list `[]` is the operator's decision to have no terms or no protected paths, `null` is rejected, and an invalid value fails at load.

`writeScope` lists project-relative paths. An entry ending in `/` (or `/**`) is a directory and covers that directory by whole path segments, so `src/app/` does not cover `src/application/x.ts`. Any other entry is one file. `./` is the whole project. Paths are held in Unicode NFC. On every platform, absolute paths, `.`, `..`, and `.git` segments (in any case), wildcards other than the `/**` suffix, and segments Windows reads as another name are rejected: a segment that ends in a dot or a space, holds `:`, a control character, or an invisible format character, is a `~1`-style short name, or is a reserved device name such as `NUL`, `con.txt`, or `con .txt`. Scope containment compares without regard to case on Windows and macOS; a path that does not normalize is never contained.

A protected path pattern without a `**/` prefix is anchored at the project root; with it, the pattern matches at any depth. A final `/` marks a directory, and a final `*` on the last segment matches a name prefix, so `**/.env*` matches `.env` and `apps/x/.env.prod`. Protected paths compare without regard to case on every platform, and a path that does not normalize counts as protected. Case is folded through upper case, so `ſ` meets `s` in scopes and protected paths. A pattern must be written in its normal form (`/` separators, no leading `./`, no surrounding spaces); a pattern such as `.github\` or `./.github/` fails at load with the form to use. The exported `isProtectedPath` brings each pattern it receives to that form itself, and a pattern that does not normalize protects every path. The default protected paths are `.github/`, `.vscode/`, `.idea/`, `.husky/`, `.claude/`, `.cursor/`, `**/.env*`, `**/.envrc`, `**/.npmrc`, `**/.gitattributes`, `**/.gitmodules`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`, and `**/migrations/`. Besides making a task complex, a protected path keeps an entry Git ignores from being exempt in the write-scope check (see [Approval policy](#approval-policy)).

## Approval policy

`approvalPolicy` decides what a writing role (`implementer`) needs before it starts. `off`, the default, changes nothing: `writeScope` and `planId` are ignored. `auto` and `always` turn on everything below; the bundle sets `auto`. The user changes the policy with `updateSettings({ approvalPolicy })`, stored like the other choices, and the status reports it with `classification` (`maxDirectFiles`, `maxInvestigatedFiles`) and the recent `plans`, newest first.

While the policy is on, `delegate_project_task` for the implementer requires `writeScope` and classifies the task from its text and scope. Under `auto` a `simple` task runs at once and its files are taken from the project's direct budget; every other task, and every task under `always`, needs the `planId` of an approved plan. The plan must belong to the same project, be approved and not closed, have been decided under the classification rules and policy in force, cover the delegated `writeScope`, and have a level no lower than the task's. A refused delegation starts and reserves nothing. The admission records the policy it was decided under, and right before the task is reserved the Host compares it with the policy in force: when the policy changed while the task was starting (for example while its worktree was made), the worktrees made for it are given back and the delegation fails with `the approval policy changed while the task was starting; delegate it again`.

The direct budget counts the files that simple tasks wrote directly in a project since its last reset. A simple task whose files, together with those already spent and those of simple delegations still starting, exceed `maxDirectFiles` is `moderate` (`direct budget of N files exceeded`). The files are held when the delegation is admitted and spent only once its first agent starts; a delegation that starts no agent (no worktree, no reservation, every provider refusing) spends nothing. A `simple` plan the policy approves spends its files from the same budget when it is approved, and the implementer delegated under its `planId` spends nothing more; a plan the user approves spends nothing.

Every writing task (`implementer`) that starts in a project joins the project's unreviewed writers; one that settles as failed leaves them at once, though what it spent stays spent until the next reset. A delivery gate that passes for `implementationTaskId`, a completed implementer of the same project, marks that implementer reviewed. The gate resets the project's budgets and closes its approved plans only when that leaves no unreviewed writer and, at that moment, no writer of the project is running or still starting. So each implementer started since the last reset, including one started while the gate ran, needs a passing gate of its own, and a gate over one trivial implementer does not reset what others spent. A gate that passes without `implementationTaskId`, or for an implementer already reviewed, decides as usual but resets and closes nothing. The gate reports which happened in `budgetReset`.

`submit_project_plan` takes `project`, a markdown `plan` starting with a `#` heading, `writeScope`, optional `evidenceTaskIds`, and an optional `level` that only raises the classification. The Host classifies the plan with the direct budget. Moderate plans the policy approves share an investigated budget: when the files of such plans since the project's last reset, with this plan's, exceed `maxInvestigatedFiles`, the plan is `complex` (`investigated budget of N files exceeded`) and goes to the user. A plan the user approves spends nothing from it. A `moderate` or `complex` plan needs at least one piece of evidence, and every id given must be a completed `reader`, `searcher`, `inspector`, `planner`, or `architect` task of the same project still in the task history. A task that changed files it may not change settles as failed and does not count. Each investigation backs one plan: an id another plan already used, approved or rejected, is refused (`evidence task <id> already supports plan <planId>`); once the investigation leaves the task history, it is refused as any task not in the history. Under `auto` a `simple` or `moderate` plan is approved by the policy and a `complex` one is put to the user; under `always` every plan is put to the user. The question goes through `userQuestions` with the `plan-review` intent. It names the level and where the plan writes: how many whole directories and files (`Aprovar este plano complexo que escreve em 1 diretório inteiro e 2 arquivos no projeto …?`), or the whole project for `./` (`… que escreve no projeto … inteiro?`), and its detail starts with the decision (level, reasons, the whole write scope, and evidence) before the plan text, so a long plan cannot push the decision out of view. Only one answer to that question selecting exactly the approving option, without words of its own, approves it. Any other answer rejects the plan and returns the user's words, if any. No user-questions service, a question that fails (for example `NO_PROVIDER`, or a caller that is a child agent), or a dismissed review (`ASK_CANCELLED`) each reject it with its own reason; an aborted turn leaves the plan undecided. A rejected plan stays in the status with its `error`, and the tool fails with that reason.

After an implementer runs, the Host lists every path it changed and fails the task when one lies outside its `writeScope` (`implementer wrote outside the approved scope: …`, naming at most five paths) or when one is a link or submodule (`implementer changed a link or submodule: …`). Nothing is undone, and a worktree with changes is kept as usual. In the project's tree the Host compares, before and after the run, the index entries, the content of tracked files changed against `HEAD`, of untracked files, and of files Git was told to skip, and the size and times of ignored entries, with the precautions of the working-tree check above; a commit adds the paths it changed. In an implementer worktree it compares the same through the worktree's recorded Git directory, and also the commits on the worktree's branch, so a commit left there after stepping back is seen. A path counts as a link when its index or commit mode is a link or submodule, or when it or a directory above it is a link on disk. A file is opened without following a link (where the platform has `O_NOFOLLOW`; Windows has none) or blocking on a pipe, and read only when the opened descriptor is a regular file, at most up to the size limit; anything else, including an entry swapped after it was looked at, is compared by its facts. A reading that fails twice fails the task with `write scope could not be verified`.

The check also guards the repository itself:

- Before the run the Host finds the Git directory, work tree, and common Git directory once, and reads through them afterwards, so a `.git` entry or `core.worktree` the run changes cannot redirect the reading. When Git finds a different one after the run, the task fails with `implementer changed the Git directory`. In an implementer worktree, which is read through the Git directory recorded for it, the worktree's `.git` entry is compared too (its type, and its content when it is a small regular file), and a change fails the task the same way.
- It compares the common Git directory's `config`, `config.worktree`, `info/exclude`, `info/attributes`, the `hooks` directory itself, and every entry under `hooks/`, and the `config.worktree` of an implementer worktree's own Git directory, each read as data and never run or followed: a regular file up to 1 MB by mode and content, anything else by type, mode, size, times, and a link's target. A change fails the task with `implementer changed Git configuration or hooks: …`. A `hooks/` that exists but cannot be listed, or holds more than 256 entries, fails the reading.
- It compares every ref (`for-each-ref`, including `refs/replace/`, tags, and `refs/stash`). A ref created, moved, or deleted fails the task with `implementer changed other branches or refs: …`, except the branch the tree had checked out, the worktree's own branch, and the branch of another implementer worktree in use during the run, which that worktree's own check answers for.
- An entry Git ignores does not count as a write outside the scope, so build output such as `dist/` or a cache under `node_modules/` does not fail the task. It still counts when it is protected (it or a directory above it matches a protected pattern, or a pattern anchored at the root names a path inside the ignored directory) and when the run changed any `.gitignore`, which could have made a new file ignored. Ignore rules are read from the repository only: the user's global excludes file is left out of this check, since a run could write it too. A link created or changed under an ignored name is never exempt and fails the task as a link (`implementer changed a link or submodule: …`); a link deep inside an ignored directory is not seen, as the limits below say.

Limits of the policy:

- A write outside the project's work tree is not seen, apart from the Git files and refs listed above; other files of the Git directory, such as `objects/info/alternates`, are not compared.
- The content of ignored directories, nested repositories, and submodules is not inspected: an ignored directory is compared as one entry, and a `**/` protected pattern is not looked for inside it. A change deep inside it is not seen, as in the working-tree check. An implementer worktree reduces that risk, since what it leaves there stays out of the project's tree until merged.
- A process the agent leaves running in the background can write after the check ran; such a write is not seen.
- Changes can be attributed only with one writer per tree: while the policy is on, two implementers never share the project's tree, even with `allowParallelImplementation`, which the status then reports as `false`; implementers in worktrees of their own still run side by side. A reader that writes during an implementer's run is blamed on the implementer.
- Implementer worktrees share one object store and one set of refs. Each lane's branch is attributed to the implementer that owns it: the commits between where it started and its tip are checked against the owner's scope. A lane is in use until its owner's check has read its branch, or, when that check never ran, until the Host reads the branch to release the lane. While it is in use, another implementer can move its branch without being blamed, and what it puts there is checked as the owner's work: outside the owner's scope the owner fails, inside it the owner passes. Where strict attribution is needed, run one implementer at a time. Once the lane has ended, the owner's check reads the branch again and fails with `implementer branch changed while it was being checked` when it is no longer at the tip that check read and compared. From then on, moving the branch fails the run that did it, when that run is one whose write scope is checked (a read-only run is checked for its working tree only): the branch must stay at the tip the lane ended at. Its disappearance is exempt only when the Host removed it with a lane that left nothing behind, and only once Git confirmed the Host's own deletion, made only while the branch is at that tip; a check waits for any Host deletion still pending when it decides whom to blame. Any other deletion fails the run that did it, including one made just before the Host's, whose deletion then fails, so the lane is not reported as removed. The branch of a lane that ended before the run began may not change at all apart from that removal, and one kept from an earlier task may not change at all.
- The project must be the top level of a Git work tree with a commit; otherwise the implementer is refused.
- Evidence proves that an investigation of the project finished, not what it was about.
- Plans, both budgets, the unreviewed writers, and which investigation backs which plan live in memory and are lost on restart, and the plan list is bounded like the task history; an approved plan is never dropped from it. An implementer that leaves the task history before a passing gate names it can no longer be named and stays unreviewed, so the project's budgets do not reset again until a restart.
- The process-local `ToranjaOrchestrator` service carries no scope or plan, so it refuses a writing role while the policy is on.

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
  removed with its branch once the implementer settles, unless its branch is
  no longer at the tip its lane ended at. When the plugin stops
  while an implementer is running, its worktree is left in place, never removed
  under it.
- A worktree is locked (`git worktree lock`) while its implementer runs, with
  a reason naming the machine and process that own it. It is unlocked when the
  implementer settles.
- When the plugin starts with isolation on, it looks in each project for
  worktrees an earlier run left under the worktree root on a `toranja/*`
  branch. One whose lock names a process still running on this machine is in
  use: it is left alone and listed with `inUse`. One whose owning process is gone and that holds no
  work is removed with its branch: no changes, and a commit some branch or tag
  outside `toranja/*` also holds. Every other one is kept, unlocked, and listed
  in the status as `leftoverWorktrees`, for review, merge, or
  `git worktree remove` by hand: it holds work, it carries no lock from this
  machine, or it or its Git directory is reached through a link. An entry
  without `worktree` is a branch alone: the directory was removed but Git could
  not delete the branch.
- The change time also moves when another program renames a file or changes
  its permissions, so such a change made during a `read-only` or `execute`
  task to a file compared without reading it counts against that task.
- A process id can be reused: a leftover whose old owner's id now belongs to
  another process counts as in use until that process ends.
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
