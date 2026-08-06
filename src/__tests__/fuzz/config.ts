import type fc from "fast-check";

/** Default runs for PR / local `bun test` — keep under a second per file. */
export const PBT_NUM_RUNS = 100;

/** Shared assert options: seed is printed on failure for replay. */
export const pbtAssertOptions: Parameters<typeof fc.assert>[1] = {
  numRuns: PBT_NUM_RUNS,
};
