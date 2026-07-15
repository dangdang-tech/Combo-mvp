export const GATE_TTL_MS = 60_000;
export const GATE_RENEW_MS = 15_000;
export const INTERRUPT_FLAG_TTL_MS = 600_000;

export interface TurnGateStore {
  acquire(sessionId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewAndReadInterrupt(
    sessionId: string,
    owner: string,
    ttlMs: number,
  ): Promise<{ owned: boolean; interrupted: boolean }>;
  release(sessionId: string, owner: string): Promise<void>;
  isHeld(sessionId: string): Promise<boolean>;
  requestInterrupt(sessionId: string, flagTtlMs: number): Promise<void>;
  subscribeInterrupts(cb: (sessionId: string) => void): () => void;
}
