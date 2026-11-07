# Codex credential import

Toranja Harness uses this Host plugin to seed the `openai-codex` OAuth record
from an existing local Codex CLI login. The import is one-time: an existing
Harness record always wins, so normal token refresh remains owned by the LLM
adapter and a later desktop start cannot replace it with an older CLI grant.

No token value is logged. `CODEX_AUTH_JSON_PATH` wins when set; otherwise the
source defaults to `%CODEX_HOME%/auth.json` when `CODEX_HOME` is set, then to
`~/.codex/auth.json`.
