export interface ActiveAgent {
  id: string;
  role: string;
  taskSlug?: string;
  startedAt: Date;
  controller: AbortController;
}

/** Safe JSON snapshot of an agent — no AbortController. */
export interface AgentSnapshot {
  id: string;
  role: string;
  taskSlug?: string;
  startedAt: Date;
}

export class AgentPool {
  private active = new Map<string, ActiveAgent>();
  private onChange?: (agents: AgentSnapshot[]) => void;

  constructor(private maxConcurrent: number = 0) {} // 0 = unlimited

  /** Register a callback fired whenever pool state changes. */
  setOnChange(cb: (agents: AgentSnapshot[]) => void): void {
    this.onChange = cb;
  }

  /** Register an agent as active. Throws if at capacity. */
  register(agent: ActiveAgent): void {
    if (this.maxConcurrent > 0 && this.active.size >= this.maxConcurrent) {
      throw new Error(`Pool at capacity (${this.maxConcurrent}). Cannot register agent ${agent.id}.`);
    }
    this.active.set(agent.id, agent);
    this.onChange?.(this.snapshot());
  }

  /** Remove an agent from the pool. */
  release(agentId: string): void {
    this.active.delete(agentId);
    this.onChange?.(this.snapshot());
  }

  /** Abort a running agent and remove from pool. */
  kill(agentId: string): void {
    const agent = this.active.get(agentId);
    if (agent) {
      agent.controller.abort();
      this.active.delete(agentId);
      this.onChange?.(this.snapshot());
    }
  }

  /** List all active agents. */
  list(): ActiveAgent[] {
    return Array.from(this.active.values());
  }

  get size(): number {
    return this.active.size;
  }

  private snapshot(): AgentSnapshot[] {
    return Array.from(this.active.values()).map(({ id, role, taskSlug, startedAt }) => ({
      id,
      role,
      taskSlug,
      startedAt,
    }));
  }
}
