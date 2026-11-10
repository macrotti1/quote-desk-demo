// The simulated inventory service behind check_stock. Each attempt waits the configured delay,
// then succeeds or fails as stockAttemptFails decides. This file keeps no schedule of its own.
import { stockAttemptFails } from "../contracts.ts";
import type { StockFault } from "../contracts.ts";

export type StockBackend = { attempt(key: string): Promise<boolean> };

export type StockBackendOptions = { fault: StockFault; faultSeed: number; delayMs: number;
  sleep: (ms: number) => Promise<void> };

/**
 * A backend with one attempt counter per key, kept for the life of the backend (one per server process).
 * attempt() resolves true when the attempt succeeds.
 */
export function createStockBackend(o: StockBackendOptions): StockBackend {
  const attemptsByKey = new Map<string, number>();
  return {
    async attempt(key: string): Promise<boolean> {
      // Counted before the wait, so two overlapping attempts on one key never share a number.
      const attemptNo = (attemptsByKey.get(key) ?? 0) + 1;
      attemptsByKey.set(key, attemptNo);
      await o.sleep(o.delayMs);
      return !stockAttemptFails(o.fault, o.faultSeed, key, attemptNo);
    },
  };
}
