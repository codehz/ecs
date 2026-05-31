import type { DebugStatsCollector, SyncDebugStats } from "../types";
import { debugHookExecutionCounter } from "./hooks";

/**
 * Manages debug stats collectors and transient activity counters for World#sync().
 *
 * Extracted from World to shrink the main class while keeping the entire debug/observability
 * path isolated, zero-cost when no collectors are active, and easy to test/maintain.
 *
 * Follows the same context/callback injection style as ArchetypeManager, CommandProcessorContext,
 * and HooksContext to avoid tight coupling.
 *
 * All collectors receive the *exact same* stats object for a given sync (as before).
 * Exceptions in user callbacks are swallowed (as before).
 */
export class DebugStatsManager {
  private readonly collectors = new Set<(stats: SyncDebugStats) => void>();

  // Transient activity counters for the current armed sync (reset each time collectors are present)
  private migrations = 0;
  private archetypesCreated = 0;
  private archetypesRemoved = 0;

  /** Fast check used to arm timing + reset + counting in hot paths. */
  hasActiveCollectors(): boolean {
    return this.collectors.size > 0;
  }

  /**
   * Registers a collector. Returns a disposable handle (supports `using`).
   * Collection stops when the handle is disposed.
   */
  createCollector(callback: (stats: SyncDebugStats) => void): DebugStatsCollector {
    this.collectors.add(callback);

    return {
      [Symbol.dispose]: () => {
        this.collectors.delete(callback);
      },
    };
  }

  // ------------------------------------------------------------------
  // Recording hooks (called from ArchetypeManager ctx and command apply paths)
  // These are cheap no-ops when no collectors are active.
  // ------------------------------------------------------------------

  recordArchetypeCreated(): void {
    if (this.hasActiveCollectors()) {
      this.archetypesCreated++;
    }
  }

  recordArchetypeRemoved(): void {
    if (this.hasActiveCollectors()) {
      this.archetypesRemoved++;
    }
  }

  incrementMigrations(): void {
    if (this.hasActiveCollectors()) {
      this.migrations++;
    }
  }

  /** Reset all activity counters + the shared hook execution counter. Called at start of an armed sync. */
  resetActivity(): void {
    this.migrations = 0;
    this.archetypesCreated = 0;
    this.archetypesRemoved = 0;
    debugHookExecutionCounter.value = 0;
  }

  /**
   * Build and deliver a SyncDebugStats payload to every active collector.
   * World supplies the pre-computed snapshot numbers (keeps debug manager decoupled from
   * internal World maps/registries while preserving exact original stats shape and values).
   */
  deliver(
    timings: {
      syncStart: number;
      syncEnd: number;
      commandBufferStart: number;
      commandBufferEnd: number;
      commandIterations: number;
    },
    data: {
      entityCount: number;
      freelistSize: number;
      nextId: number;
      archetypeCount: number;
      emptyArchetypes: number;
      archetypesByComponentSize: number;
      cachedQueryCount: number;
      registeredQueryCount: number;
      hookCount: number;
      entityReferencesSize: number;
      entityToReferencingArchetypesSize: number;
    },
  ): void {
    const stats: SyncDebugStats = {
      timestamps: {
        syncStart: timings.syncStart,
        syncEnd: timings.syncEnd,
        commandBufferStart: timings.commandBufferStart,
        commandBufferEnd: timings.commandBufferEnd,
      },
      commandIterations: timings.commandIterations,

      entities: {
        total: data.entityCount,
        freelistSize: data.freelistSize,
        nextId: data.nextId,
      },
      archetypes: {
        total: data.archetypeCount,
        empty: data.emptyArchetypes,
      },
      queries: {
        cached: data.cachedQueryCount,
        registered: data.registeredQueryCount,
      },
      hooks: {
        total: data.hookCount,
      },
      indices: {
        entityReferences: data.entityReferencesSize,
        entityToReferencingArchetypes: data.entityToReferencingArchetypesSize,
        archetypesByComponent: data.archetypesByComponentSize,
      },
      activity: {
        migrations: this.migrations,
        hooksExecuted: debugHookExecutionCounter.value,
        archetypesCreated: this.archetypesCreated,
        archetypesRemoved: this.archetypesRemoved,
      },
    };

    for (const cb of this.collectors) {
      try {
        cb(stats);
      } catch {
        // Intentionally ignore user callback errors (preserves original behavior)
      }
    }
  }
}
