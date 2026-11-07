import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ACTION_SCHEMA,
  coordinateAntigravityTurn,
  parseAntigravityAction,
  requestsCodexDelegation,
} from '../src/protocol.ts'

describe('AntigravityAction protocol', () => {
  it('accepts a final answer and a bounded Codex delegation', () => {
    expect(parseAntigravityAction(JSON.stringify({ kind: 'answer', text: '  pronto  ' })))
      .toEqual({ kind: 'answer', text: 'pronto' })
    expect(parseAntigravityAction(JSON.stringify({
      kind: 'delegate_codex',
      project: 'portal-web',
      role: 'reviewer',
      description: 'Revisar autenticação',
      task: 'Revise o fluxo e reporte riscos.',
    }))).toEqual({
      kind: 'delegate_codex',
      project: 'portal-web',
      role: 'reviewer',
      description: 'Revisar autenticação',
      task: 'Revise o fluxo e reporte riscos.',
    })
  })

  it('uses the last protocol object when the CLI surrounds it with progress text', () => {
    const noisy = [
      'PROTOCOLO_TORANJA_OK',
      JSON.stringify({ toolAction: 'Finishing the task', toolSummary: 'Task completion' }),
      JSON.stringify({ kind: 'answer', text: 'resultado final' }),
    ].join('\n')
    expect(parseAntigravityAction(noisy)).toEqual({ kind: 'answer', text: 'resultado final' })
  })

  it('rejects unknown actions, roles, empty values, and non-JSON responses', () => {
    expect(() => parseAntigravityAction('texto livre')).toThrow(/protocolo estruturado/u)
    expect(() => parseAntigravityAction(JSON.stringify({ kind: 'delegate_codex', project: 'p', role: 'owner', description: 'x', task: 'y' })))
      .toThrow(/função inválida/u)
    expect(() => parseAntigravityAction(JSON.stringify({ kind: 'answer', text: '  ' }))).toThrow(/vazio/u)
    expect(() => parseAntigravityAction(JSON.stringify({ kind: 'other' }))).toThrow(/ação desconhecida/u)
  })

  it('publishes a schema with only answer and Codex delegation actions', () => {
    const schema = JSON.parse(ANTIGRAVITY_ACTION_SCHEMA) as { oneOf: { properties: { kind: { const: string } } }[] }
    expect(schema.oneOf.map(branch => branch.properties.kind.const)).toEqual(['answer', 'delegate_codex'])
  })

  it('detects explicit Codex delegation requests without forcing ordinary turns', () => {
    expect(requestsCodexDelegation('Delegue obrigatoriamente ao Codex para revisar.')).toBe(true)
    expect(requestsCodexDelegation('Responda diretamente, sem usar ferramentas.')).toBe(false)
  })

  it('rejects a premature answer and completes the required real delegation', async () => {
    const responses = [
      JSON.stringify({ kind: 'answer', text: 'feito sem delegar' }),
      JSON.stringify({
        kind: 'delegate_codex',
        project: 'portal-web',
        role: 'reviewer',
        description: 'Revisar resultado',
        task: 'Confira o diretório e reporte CODEX OK.',
      }),
      JSON.stringify({ kind: 'answer', text: 'resultado revisado' }),
    ]
    let delegated = 0
    const result = await coordinateAntigravityTurn({
      initialPrompt: 'Delegue ao Codex e revise.',
      maxDelegations: 2,
      requireDelegation: true,
      ask: () => Promise.resolve({
        text: responses.shift()!,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      delegateCodex: (action) => {
        delegated += 1
        return Promise.resolve({
          project: action.project,
          role: action.role,
          taskId: 'toranja-required',
          subagentId: 'codex-required',
          stopReason: 'completed',
          output: 'CODEX OK',
        })
      },
    })
    expect(delegated).toBe(1)
    expect(result.text).toBe('resultado revisado')
  })

  it('returns a settled Codex result to Antigravity before publishing the final answer', async () => {
    const prompts: string[] = []
    const responses = [
      JSON.stringify({
        kind: 'delegate_codex',
        project: 'api-pedidos',
        role: 'tester',
        description: 'Executar testes',
        task: 'Execute os testes focados e reporte o resultado.',
      }),
      JSON.stringify({ kind: 'answer', text: 'Codex confirmou que os testes passaram.' }),
    ]
    const delegated: string[] = []
    const result = await coordinateAntigravityTurn({
      initialPrompt: 'Verifique com o Codex.',
      maxDelegations: 2,
      ask: (prompt) => {
        prompts.push(prompt)
        const text = responses.shift()
        if (text === undefined) throw new Error('unexpected extra Antigravity turn')
        return Promise.resolve({
          text,
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        })
      },
      delegateCodex: (action) => {
        delegated.push(action.task)
        return Promise.resolve({
          project: action.project,
          role: action.role,
          taskId: 'toranja-1',
          subagentId: 'codex-1',
          stopReason: 'completed',
          output: 'TESTES OK',
        })
      },
    })

    expect(delegated).toEqual(['Execute os testes focados e reporte o resultado.'])
    expect(prompts[1]).toContain('TESTES OK')
    expect(result).toEqual({
      text: 'Codex confirmou que os testes passaram.',
      usage: {
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        totalTokens: 24,
      },
    })
  })
})
