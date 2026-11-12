# Toranja Control

Conversation-header dashboard for Toranja Harness. It reads the authenticated
`toranja` Remote status surface and shows provider availability, concurrency
capacity, project lanes, and completed/failed run counters. Opening the panel
does not start agents or consume provider credits.

## Orchestrator settings page

The package also registers the **Orquestrador** page in Settings (slot
`settings.section`, after Models). It reads the same status surface and changes
it through the controller, never starting an agent:

- **Provedores**: the sign-in state of each provider, a button that opens the
  provider's official sign-in command in a terminal (`connectProvider`), and
  **Verificar conexões** (`probeProviders`). OpenRouter signs in with an API key
  set on the Models page, so it has no button; a missing CLI has none either.
- **Modo de trabalho**: Team or one provider (`setMode`), the team size up to
  `limits.maxTeamSize`, and the cost and quality profile.
- **Papéis**: the preferred provider per role, offered only among providers that
  may take the role, with the route in use (provider, model, effort) and, for
  read-only roles, how that provider keeps the task from writing.
- **Ordem de fallback** and **Revisão cruzada**.
- **Modelos por nível**: model and effort of each tier per provider, saved per
  provider, with **Restaurar padrão** to drop what the user set. A provider the
  deployment gives Toranja no instance of shows why its models cannot be set.

Every change except the mode goes through `updateSettings`, which names only the
field that changed, so the page never restates a mode it read earlier. The page
reads the Host again every five seconds and after each change, never while a
change is still being stored; a model the user is still typing is kept across
those reads, and a rejected change shows the
Host's reason and leaves the stored value on screen. Changes apply to tasks
started afterwards.

## First-run setup

The package registers a step with the settings onboarding coordinator (slot
`settings.onboarding`, after the product's own steps). It shows until the Host
reports `onboarded`:

1. **Conecte seus agentes**: the same provider list as the settings page, read
   fresh with `probeProviders`. Any provider can be left unconnected; the step
   warns when none is connected.
2. **Como você quer trabalhar**: Team or one provider, and the team size in Team
   mode.

Each control stores its change as it is used, so closing the app midway loses
nothing and the setup opens again on the next start. **Concluir** and **Pular
por agora** both store `onboarded` and end the step; if that cannot be stored,
the dialog stays open with the Host's reason. The step ends itself without
showing when the setup was already finished, and also when the Host cannot be
read, so it never blocks the app.

Still set in the deployment configuration, not on this page: the provider
instances (`routing.<provider>.base`), CLI executables, the OpenRouter credential
reference and its opt-in for non-writing roles, the concurrency limits, and the
project lanes. The access of each role is fixed and shown, not edited.
