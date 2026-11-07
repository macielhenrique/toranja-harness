/** Process-local orchestration service shared by model adapters and tools. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Role } from './policy.ts'
import type { ToranjaOrchestrationStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toranjaOrchestrator: ToranjaOrchestrator
  }
}

/** One project lane exposed to an external primary agent. */
export interface ToranjaProjectLane {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** Validated request for a direct Antigravity-to-Codex delegation. */
export interface ToranjaCodexDelegationRequest {
  readonly project: string
  readonly role: Role
  readonly description: string
  readonly task: string
  readonly parent: Agent
  readonly signal: AbortSignal
}

/** Settled Codex result returned to the requesting primary agent. */
export interface ToranjaCodexDelegationResult {
  readonly project: string
  readonly role: Role
  readonly taskId: string
  readonly subagentId: string
  readonly stopReason: string
  readonly output: string
  readonly diagnostic?: string
}

/** Process-local service provider for Toranja project orchestration. */
export class ToranjaOrchestrator extends Service {
  constructor(
    ctx: Context,
    private readonly readLanes: () => readonly ToranjaProjectLane[],
    private readonly readStatus: () => ToranjaOrchestrationStatus,
    private readonly runCodex: (request: ToranjaCodexDelegationRequest) => Promise<ToranjaCodexDelegationResult>,
  ) {
    super(ctx, 'toranjaOrchestrator')
  }

  /**
   * List configured project lanes without exposing mutable configuration.
   * @returns Immutable snapshot of available project lanes.
   */
  lanes(): readonly ToranjaProjectLane[] {
    return this.readLanes().map(lane => ({ ...lane }))
  }

  /**
   * Read current provider, capacity, and task state.
   * @returns Current Toranja orchestration status snapshot.
   */
  status(): ToranjaOrchestrationStatus {
    return this.readStatus()
  }

  /**
   * Run one managed Codex task and return its settled output to the caller.
   * @param request - Validated delegation parameters and parent agent.
   * @returns Settled Codex delegation result.
   */
  delegateCodex(request: ToranjaCodexDelegationRequest): Promise<ToranjaCodexDelegationResult> {
    return this.runCodex(request)
  }
}
