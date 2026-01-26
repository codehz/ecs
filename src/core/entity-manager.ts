import type { ComponentId, EntityId } from "./entity-types";
import { COMPONENT_ID_MAX, ENTITY_ID_START, isEntityId } from "./entity-types";

/**
 * Entity ID Manager for automatic allocation and freelist recycling
 */
export class EntityIdManager {
  private nextId: number = ENTITY_ID_START;
  private freelist: Set<EntityId> = new Set();

  /**
   * Allocate a new entity ID
   * Uses freelist if available, otherwise increments counter
   */
  allocate(): EntityId {
    if (this.freelist.size > 0) {
      const id = this.freelist.values().next().value!;
      this.freelist.delete(id);
      return id;
    } else {
      const id = this.nextId;
      this.nextId++;
      // Check for overflow (though unlikely in practice)
      if (this.nextId >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Entity ID overflow: reached maximum safe integer");
      }
      return id as EntityId;
    }
  }

  /**
   * Deallocate an entity ID, adding it to the freelist for reuse
   * @param id The entity ID to deallocate
   */
  deallocate(id: EntityId<any>): void {
    if (!isEntityId(id)) {
      throw new Error("Can only deallocate valid entity IDs");
    }
    if (id >= this.nextId) {
      throw new Error("Cannot deallocate an ID that was never allocated");
    }
    this.freelist.add(id);
  }

  /**
   * Get the current freelist size (for debugging/monitoring)
   */
  getFreelistSize(): number {
    return this.freelist.size;
  }

  /**
   * Get the next ID that would be allocated (for debugging)
   */
  getNextId(): number {
    return this.nextId;
  }

  /**
   * Serialize internal state for persistence.
   * Returns a plain object representing allocator state. Values may be non-JSON-serializable.
   */
  serializeState(): { nextId: number; freelist: number[] } {
    return { nextId: this.nextId, freelist: Array.from(this.freelist) };
  }

  /**
   * Restore internal state from a previously-serialized object.
   * Overwrites the current nextId and freelist.
   */
  deserializeState(state: { nextId: number; freelist?: number[] }): void {
    if (typeof state.nextId !== "number") {
      throw new Error("Invalid state for EntityIdManager.deserializeState");
    }
    this.nextId = state.nextId;
    this.freelist = new Set((state.freelist || []) as EntityId[]);
  }
}

/**
 * Component ID Manager for automatic allocation
 * Components are typically registered once and not recycled
 */
export class ComponentIdAllocator {
  private nextId: number = 1;

  /**
   * Allocate a new component ID
   * Increments counter sequentially from 1
   */
  allocate<T = void>(): ComponentId<T> {
    if (this.nextId > COMPONENT_ID_MAX) {
      throw new Error(`Component ID overflow: maximum ${COMPONENT_ID_MAX} components allowed`);
    }
    const id = this.nextId;
    this.nextId++;
    return id as ComponentId<T>;
  }

  /**
   * Get the next ID that would be allocated (for debugging)
   */
  getNextId(): number {
    return this.nextId;
  }

  /**
   * Check if more component IDs are available
   */
  hasAvailableIds(): boolean {
    return this.nextId <= COMPONENT_ID_MAX;
  }
}
