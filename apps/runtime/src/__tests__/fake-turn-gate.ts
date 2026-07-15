import type { TurnGateStore } from '../modules/agent/turn-gate.js';

export class FakeTurnGateStore implements TurnGateStore {
  private readonly gates = new Map<string, { owner: string; expiresAt: number }>();
  private readonly interruptFlags = new Map<string, number>();
  private readonly listeners = new Set<(sessionId: string) => void>();
  requestInterruptCalls = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private gate(sessionId: string): { owner: string; expiresAt: number } | undefined {
    const gate = this.gates.get(sessionId);
    if (gate && gate.expiresAt <= this.now()) {
      this.gates.delete(sessionId);
      return undefined;
    }
    return gate;
  }

  async acquire(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    if (this.gate(sessionId)) return false;
    this.gates.set(sessionId, { owner, expiresAt: this.now() + ttlMs });
    this.interruptFlags.delete(sessionId);
    return true;
  }

  async renewAndReadInterrupt(sessionId: string, owner: string, ttlMs: number) {
    const gate = this.gate(sessionId);
    if (!gate || gate.owner !== owner) return { owned: false, interrupted: false };
    gate.expiresAt = this.now() + ttlMs;
    const expiresAt = this.interruptFlags.get(sessionId);
    const interrupted = expiresAt !== undefined && expiresAt > this.now();
    this.interruptFlags.delete(sessionId);
    return { owned: true, interrupted };
  }

  async release(sessionId: string, owner: string): Promise<void> {
    if (this.gate(sessionId)?.owner === owner) this.gates.delete(sessionId);
  }

  async isHeld(sessionId: string): Promise<boolean> {
    return this.gate(sessionId) !== undefined;
  }

  async requestInterrupt(sessionId: string, flagTtlMs: number): Promise<void> {
    this.requestInterruptCalls += 1;
    this.interruptFlags.set(sessionId, this.now() + flagTtlMs);
    this.listeners.forEach((listener) => listener(sessionId));
  }

  subscribeInterrupts(cb: (sessionId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
