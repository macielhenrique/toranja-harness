# Toranja Harness

Toranja Harness is a Brazilian, local-first composition of the MIT-licensed
DeepSeek Harness runtime. It does not use a DeepSeek account or paid DeepSeek
model route. Its product language defaults to Brazilian Portuguese and its
visual identity belongs to Toranja Tech.

## Product goal

Toranja Harness is evolving into a desktop manager for simultaneous agents. A
single conversation can plan work, delegate independent tasks to Codex and
Antigravity, keep those tasks attached to the correct project, review results,
run verification, and present one consolidated delivery to the user.

The design combines three deliberately separate layers:

- the DeepSeek Harness open-source runtime for sessions, plugins, tools,
  workspaces, permissions, persistence, and the desktop shell;
- the provider/profile and agent-routing concepts studied in OpenClaude for
  reusing Codex CLI authentication and assigning agents by role;
- Toranja-owned product composition, orchestration policy, UI, and branding.

The single chat currently uses:

- **Codex** as the lead model through `openai-codex` OAuth. On the first Toranja
  start, a Host plugin can seed the Harness credential record from the existing
  local Codex CLI `auth.json`; an existing Harness record always wins;
- **Antigravity** as either the primary model or an external
  implementation/review specialist through the installed `agy` CLI and its
  existing local authentication;
- **Agent Teams** for parallel Codex teammates, direct messages, and a shared
  task board.

The model picker configures the primary agent. Its `openai-codex` group uses
the existing Codex OAuth session, while `Antigravity local` maintains a direct
continuous `agy` session over NDJSON and consumes only the local Antigravity
account for those turns. The **Agentes** panel separately controls delegation
routing and shows both roles, activity, recent managed tasks, and project lanes
in one place.

When Antigravity is primary, it can request a managed Codex collaborator through
a validated structured protocol. The orchestrator starts Codex in the selected
project lane, waits for its result, records the child task, and returns the
evidence to Antigravity before the final answer appears in the same chat. Simple
turns do not invoke Codex, and each provider remains subject to its own local
subscription limits.

The same panel controls real routing for delegations that do not name a
provider: **Só Codex**, **Só Antigravity**, or **Equipe**. Team mode routes
planning and review to Antigravity and implementation, testing, and release to
Codex. The desktop remembers the selection locally across restarts.

## Verified capabilities

The packaged Windows application is designed to work end to end with the local
accounts already present on the user's machine:

- the lead conversation answers through the imported Codex OAuth session or
  directly through the local Antigravity CLI;
- `delegate_codex` launches the packaged native Codex binary and returns its
  result to the lead conversation;
- `delegate_antigravity` launches `agy` with its existing local authentication
  and returns its result to the lead conversation;
- one lead turn can start both delegation tools together. Each child is tracked
  as a separate subtask and the lead conversation consolidates their results;
- the Toranja orchestrator automatically discovers every Workspace added in the
  UI (plus any optional static `projects` entries configured in
  `cordis.patch.yml`), derives a normalized project lane ID (`slugifyProjectId`),
  exposes their exact directories through `list_project_lanes`, and routes
  `delegate_project_task` by project, role, and provider. Selecting `both`
  starts Codex and Antigravity concurrently in the chosen repository;
- Toranja-owned admission limits cap total, per-project, and per-provider
  concurrency. Write isolation prevents two implementers from editing the same
  worktree simultaneously, and `get_orchestration_status` exposes provider
  availability plus active/completed/failed counters without consuming provider
  credits;
- `run_delivery_gate` starts an Antigravity reviewer and a Codex tester in
  parallel, waits for both, and returns `ready` only when both independently
  emit an explicit pass verdict (`TORANJA_GATE: PASS`);
- Antigravity headless tool approval is enabled only together with its sandbox
  and the project directory selected by the Toranja catalog;
- the desktop header exposes a Toranja-owned multi-agent dashboard (**Agentes**)
  with Codex and Antigravity health, concurrency capacity, active/recent
  delegated tasks, dynamic project lane metrics, and the active write-isolation
  policy;
- the primary desktop experience uses a dedicated `pt-BR` language pack. Any
  untranslated extension key falls back safely to English while the Brazilian
  catalog continues to expand.

## Development launch & Windows installer

From this repository:

```powershell
corepack pnpm install
corepack pnpm run build
corepack pnpm dsh web --patch .\toranja-harness.patch.yml
```

To build the unsigned Windows x64 desktop installer (`.exe` NSIS installer and
`.zip` portable archive):

```powershell
corepack pnpm run package:desktop:win:x64:unsigned
```

Generated artifacts are written to:

`apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`

When the Codex CLI is already signed in (`~/.codex/auth.json`), Toranja imports
that local OAuth grant once and the Models page is immediately configured. If no
reusable login is available, the standard OpenAI Codex browser sign-in remains
the fallback. Antigravity uses the account already configured in `agy`.

## Project lanes configuration

Project workspaces can be added directly in the UI (**Adicionar projeto** in the
sidebar). Every registered Workspace automatically becomes an orchestration lane
available to `list_project_lanes`, `delegate_project_task`, `run_delivery_gate`,
and the **Agentes** header panel.

Optionally, static project lanes can also be pre-declared in
`packages/bundle/toranja-harness/cordis.patch.yml` (or your profile's
`cordis.patch.yml`) under `@deepseek-ai/dsh-toranja-orchestrator`:

```yaml
projects:
  - id: portal-web
    title: Portal Web
    path: C:/path/to/portal-web
  - id: api-pedidos
    title: API Pedidos
    path: C:/path/to/api-pedidos
```

Only existing directories on disk are materialized as initial Workspaces at
startup.

## Orchestration architecture

1. **Provider foundation:** Codex subscription auth, Codex CLI delegation, and
   Antigravity delegation are integrated and runtime-verified. Provider
   registration and run health are available through `get_orchestration_status`
   and the visual **Agentes** panel.
2. **Agent routing:** planner, implementer, reviewer, tester, and release roles
   have explicit task contracts and provider defaults. Global, per-project,
   per-provider, and prompt-size limits are configurable in the product bundle.
3. **Concurrent project lanes:** Workspaces registered in the UI or via optional
   configuration receive simultaneous delegated work in their own directories.
   Concurrent implementers in one directory are blocked by default unless
   `allowParallelImplementation` is enabled.
4. **Delivery gate:** independent Antigravity review and Codex verification run
   in parallel. Failed checks are returned to an implementer before completion.
5. **Efficiency controls:** concurrency limits, context budgets, and
   provider-aware routing reduce duplicated work and unnecessary credit use.

## Safety boundary

The composition invokes official local clients and existing login flows. The
Codex import reads only the fields needed for the local OAuth grant, never logs
their values, and stores them in the Harness credential plane on the same
machine. It does not bypass subscriptions or modify vendor billing checks.

## Open-source governance

Preserve the [MIT License](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when distributing copies or
derivatives. Keep generated installers (`apps/desktop/.desktop-build/`), local
profiles, `.env` files, and OAuth credentials out of Git commits.
