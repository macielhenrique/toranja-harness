# Segurança

Não publique vulnerabilidades, credenciais, tokens, arquivos `auth.json`,
conteúdo de `.env` ou dados privados de projetos em uma issue pública.

Enquanto o repositório Toranja Tech ainda não possui um canal privado de
segurança configurado, reporte o problema diretamente ao mantenedor do
repositório e inclua apenas o mínimo necessário para reproduzi-lo. Ao ativar o
GitHub Security Advisories, esse canal passa a ser o meio preferencial.

## Escopo sensível

O Toranja Harness executa clientes de agentes, comandos e alterações de
arquivos localmente. Relatos envolvendo escape de sandbox, vazamento de
credenciais, execução fora do projeto selecionado, elevação de privilégios ou
confusão entre contas/provedores devem ser tratados como vulnerabilidades.

## Publicação responsável

Dê tempo razoável para correção e validação antes de divulgar detalhes. Não
inclua credenciais reais em provas de conceito; use valores sintéticos.
