# Toranja Harness

O **Toranja Harness** é um gerenciador desktop brasileiro e local-first para
coordenar agentes de programação em uma única interface. Ele reutiliza os
clientes oficiais e as autenticações que já existem na máquina, sem intermediar
assinaturas e sem depender de uma assinatura DeepSeek.

> Projeto em desenvolvimento ativo. Ainda não há uma versão estável para uso
> em produção.

## O que já funciona

- conversa principal alternável entre Codex e Antigravity, cada um usando seu
  próprio login local e seus próprios limites;
- delegação para Codex e Antigravity, isoladamente ou em equipe;
- modos **Equipe**, **Só Codex** e **Só Antigravity**, persistidos entre
  reinicializações;
- tarefas simultâneas em projetos diferentes;
- funções de planejador, implementador, revisor, testador e entrega;
- limites de concorrência e bloqueio de escrita paralela no mesmo worktree;
- portões de entrega com revisão e testes independentes;
- painel em português brasileiro com estado dos agentes e dos projetos;
- aplicativo e instalador do Windows com identidade visual Toranja Tech.

O seletor ao lado do botão de enviar escolhe o agente principal. O grupo
**openai-codex** usa a assinatura do Codex; o grupo **Antigravity local** envia
o turno diretamente ao `agy`. Uma conversa simples usa somente o provedor
selecionado. No modo de colaboração, o Antigravity também pode delegar uma
tarefa ao Codex, aguardar o resultado e consolidá-lo na mesma resposta, sem o
usuário sair do Toranja Harness. O painel **Agentes** configura separadamente
como o agente principal delega tarefas e acompanha os trabalhos filhos.

## Arquitetura e atribuição

Este projeto é uma composição derivada do
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), distribuído
sob licença MIT. A base fornece sessões, ferramentas, plugins, permissões,
persistência e o shell desktop. A Toranja Tech mantém a composição do produto,
a política de orquestração, os adaptadores locais, a interface em pt-BR e a
identidade visual.

Conceitos de perfis e roteamento de agentes também foram estudados no projeto
[OpenClaude](https://github.com/Twigpine/openclaude). Nenhum código ou serviço
proprietário da DeepSeek é necessário para executar o Toranja Harness.

Veja [TORANJA_HARNESS.md](TORANJA_HARNESS.md) para arquitetura, capacidades
verificadas, limites atuais e roteiro técnico.

## Como funcionam os projetos (Lanes)

- Qualquer projeto adicionado na barra lateral (**Adicionar projeto**) passa
  automaticamente a integrar o catálogo do orquestrador Toranja com um ID
  normalizado, ficando imediato para `list_project_lanes`,
  `delegate_project_task`, `run_delivery_gate` e para o painel **Agentes**;
- Opcionalmente, você também pode pré-declarar projetos fixos no arquivo
  `packages/bundle/toranja-harness/cordis.patch.yml` (ou no `cordis.patch.yml`
  do perfil local) em `@deepseek-ai/dsh-toranja-orchestrator`:

```yaml
projects:
  - id: portal-web
    title: Portal Web
    path: C:/caminho/para/portal-web
```

## Instalação (Windows Desktop)

Para gerar o instalador desktop do Windows x64 (`.exe` NSIS e `.zip` portátil):

```powershell
corepack pnpm install
corepack pnpm run build
corepack pnpm run package:desktop:win:x64:unsigned
```

Os artefatos gerados ficam em
`apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`:

- `toranja-harness-0.2.1-alpha.4-win-x64-unsigned.exe` (instalador desktop NSIS)
- `toranja-harness-0.2.1-alpha.4-win-x64-unsigned.zip` (pacote portátil)

Esses binários gerados são ignorados pelo Git e devem ser publicados via
**GitHub Releases**.

## Desenvolvimento a partir do código-fonte

Requisitos:

- Windows 10/11 (ou macOS/Linux para execução web/headless);
- Node.js `^22.19 || >=24`;
- Corepack / `pnpm`;
- Codex CLI autenticado (`~/.codex/auth.json`) e/ou `agy` autenticado no `PATH`
  para usar os respectivos agentes locais.

```powershell
corepack pnpm install
corepack pnpm run build
corepack pnpm dsh web --patch .\toranja-harness.patch.yml
```

## Segurança e privacidade

O projeto chama clientes oficiais instalados localmente e respeita seus fluxos
de login. Credenciais, arquivos `.env`, perfis locais e tokens não pertencem ao
repositório. Antes de publicar uma cópia, faça uma varredura de segredos no
histórico e na árvore de trabalho.

Leia também [SECURITY.md](SECURITY.md) e [SAFETY.md](SAFETY.md).

## Licença

Código sob a [licença MIT](LICENSE). O aviso original do DeepSeek Harness e os
avisos das dependências devem ser preservados. Consulte
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) e [NOTICE](NOTICE).

“Toranja Tech” e seus elementos de marca não são concedidos como licença de
marca pelo simples uso do código.
