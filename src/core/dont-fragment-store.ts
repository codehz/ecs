import type { EntityId } from "./entity";

/**
 * Minimal interface for storing dontFragment relation data keyed by entity ID.
 *
 * Using an interface here decouples `Archetype` (and `world-commands.ts`) from
 * the concrete `Map` used by `World`, making archetypes independently testable.
 */
export interface DontFragmentStore {
  get(entityId: EntityId): Map<EntityId<any>, any> | undefined;
  set(entityId: EntityId, data: Map<EntityId<any>, any>): void;
  delete(entityId: EntityId): void;
}

/**
 * Default implementation backed by a plain `Map`.
 * Created once by `World` and shared with every `Archetype`.
 */
export class DontFragmentStoreImpl implements DontFragmentStore {
  private readonly data: Map<EntityId, Map<EntityId<any>, any>> = new Map();

  get(entityId: EntityId): Map<EntityId<any>, any> | undefined {
    return this.data.get(entityId);
  }

  set(entityId: EntityId, data: Map<EntityId<any>, any>): void {
    this.data.set(entityId, data);
  }

  delete(entityId: EntityId): void {
    this.data.delete(entityId);
  }
}
