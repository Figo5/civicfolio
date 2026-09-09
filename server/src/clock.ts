// Injectable clock. Production callers use Date.now() as before; the fund
// run-history code takes an optional clock parameter so tests can freeze or
// advance time deterministically without monkey-patching globals.

export type Clock = () => number;

/** Real UTC clock (default production seam). */
export const systemClock: Clock = () => Date.now();

/** Advance-time helper for tests: returns a mutable, settable clock. */
export function manualClock(startIso: string): { clock: Clock; set: (iso: string) => void; advanceMs: (ms: number) => void } {
  let t = Date.parse(startIso);
  return {
    clock: () => t,
    set: (iso: string) => { t = Date.parse(iso); },
    advanceMs: (ms: number) => { t += ms; },
  };
}