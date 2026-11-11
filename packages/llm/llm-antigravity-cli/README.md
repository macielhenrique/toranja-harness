---
description: "Use the local Antigravity subscription as the primary Toranja Harness chat model."
kind: "package-bundle"
---

# Toranja Harness — Antigravity direto

Este adaptador registra `antigravity-local` no seletor de modelos. O catálogo
inclui a seleção automática e os modelos disponibilizados pelo `agy 1.4.12`,
como Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5 e
GPT-OSS 120B, com seus níveis de esforço disponíveis. Quando o usuário escolhe
um desses modelos, as mensagens da conversa
são enviadas diretamente ao processo `agy`; nenhuma chamada ao Codex é
necessária para iniciar ou responder um turno simples. Quando a solicitação se
beneficia de colaboração, o Antigravity pode pedir uma tarefa gerenciada ao
Codex. O Harness aguarda o resultado, devolve a evidência ao Antigravity e
mostra no chat principal somente a resposta consolidada pelo agente escolhido.

Cada conversa do Harness mantém uma sessão contínua do Antigravity por NDJSON
em `stdin`/`stdout`. A sessão roda no diretório ativo do projeto, usa o login e
os limites da instalação local do `agy` e é encerrada junto com o plugin. Ao
alternar de outro provedor para Antigravity, o adaptador reinicia a sessão e
envia um recorte da conversa como transição de contexto. Trocar o modelo na
mesma conversa também reinicia somente o processo `agy` daquela conversa e
preserva o contexto pelo mesmo mecanismo.

O adaptador entrega texto e métricas de uso ao protocolo de LLM do Harness.
As ferramentas de edição são as ferramentas nativas do Antigravity; ele não
emite chamadas de ferramenta no formato interno do Harness. A colaboração com
Codex usa um protocolo JSON validado e o mesmo catálogo de projetos, limites de
concorrência, isolamento de escrita e registro de tarefas do orquestrador.

`maxCodexDelegationsPerTurn` limita quantas tarefas Codex o Antigravity pode
solicitar em um único turno; o padrão é `3`. Nenhuma credencial é copiada pelo
adaptador: cada provedor continua usando seu próprio login local e seus próprios
limites.

O modo selecionado no painel **Agentes** é uma trava de execução. Em **Só
Antigravity**, o adaptador nunca inicia Codex. Em **Equipe**, o Antigravity pode
liderar e delegar ao Codex; o resultado volta para ele revisar e consolidar.

## Esgotamento de cota

Quando um modelo Gemini Argon responde com esgotamento de cota, a conversa continua no `gemini-3.8-flash-high` com effort `high`. O novo processo recebe o histórico recente da conversa, porque começa sem contexto. A conversa permanece no modelo alternativo por `quotaFallbackRetryMs` (padrão de 15 minutos) ou até outro modelo ser selecionado; depois disso o modelo selecionado é tentado de novo.
