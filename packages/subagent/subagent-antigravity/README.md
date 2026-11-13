---
description: "Run a local Antigravity CLI subscription as a one-shot Harness subagent."
kind: "package-bundle"
---

# Toranja Harness Antigravity subagent

## Summary

This private bundle connects the locally installed `agy` executable to the
Harness subagent seam. The lead agent can call `delegate_antigravity` from the
same conversation and receives only Antigravity's final answer. Authentication,
models, and subscription limits remain owned by the installed Antigravity CLI.

## Use this package

The bundle registers the `antigravity` provider and its global delegation tool.
Each call starts a fresh non-interactive Antigravity conversation in the child
working directory. The default mode accepts workspace edits while Antigravity's
own sandbox remains enabled.

Configuration supports `executable`, `timeoutMs`, `sandbox`,
`autoApproveTools`, `mode`, `disableSlashCommands`, `model`, `effort`, `env`, and `disposeGraceMs`.

`mode: plan` returns a plan without changing files. The CLI implements it through slash-command expansion and ignores it under `--disable-slash-commands`, so the plugin rejects `mode: plan` unless `disableSlashCommands` is `false`, and rejects it together with `autoApproveTools`. Plan mode is a directive to the model, not a sandbox.
Headless Antigravity cannot display permission prompts; `autoApproveTools`
passes its non-interactive approval flag and is therefore accepted only while
the Antigravity sandbox remains enabled. Omitting `model` and `effort`
preserves the user's native Antigravity defaults.

## Model Experience

### Delegated request

#### What the model sees

The Antigravity child receives only the self-contained text task and the selected
working directory. It does not inherit the lead conversation.

#### Token effect

The child uses the Antigravity subscription independently. Its final answer is
added to the lead's context; intermediate output is not.

#### KV Cache effect

The child is a fresh one-shot conversation, so cache behavior is owned entirely
by Antigravity. The lead's existing prefix is unchanged until the result arrives.

## Known Limitations and Deferred Work

- One fresh Antigravity process is created per delegation; continuation is not
  yet exposed.
- Only text prompts and text final responses are supported.
- The CLI's JSON envelope is treated as the stable integration boundary.
