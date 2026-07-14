import { Archetype } from "../archetype/archetype";
import type { SparseStore } from "../archetype/store";
import { normalizeComponentTypes } from "../component/type-utils";
import type { EntityId } from "../entity";
import {
  getComponentIdFromRelationId,
  getDetailedIdType,
  isSparseRelation,
  isSparseWildcard,
  isWildcardRelationId,
  relation,
} from "../entity";
import { matchesFilter } from "../query/filter";
import type { QueryRegistry } from "../query/registry";
import type { LifecycleHookEntry } from "../types";
import { getOrCompute } from "../utils/utils";
import { filterRegularComponentTypes } from "./commands";

/**
 * Context provided to ArchetypeManager for notifying dependent systems
 * (query caching and lifecycle hooks) without creating tight coupling or cycles.
 * Follows the same callback/context injection pattern used by CommandProcessorContext,
 * HooksContext, and WorldDeserializationContext.
 */
export interface ArchetypeManagerContext {
  queryRegistry: QueryRegistry;
  hooks: Set<LifecycleHookEntry>;
  /** Called only when debug collectors are active (mirrors original guard in World) */
  recordArchetypeCreated?: () => void;
  recordArchetypeRemoved?: () => void;
}

/**
 * Encapsulates all archetype storage, indexing, creation, removal, and reverse
 * referencing logic that was previously scattered as private methods + maps
 * directly on the World class.
 *
 * Responsibilities:
 * - Archetype memoization by signature
 * - Component-type reverse index (archetypesByComponent)
 * - Entity → current Archetype map
 * - Reverse "who references this entity via component/relation" index
 * - Creation + removal with proper notifications to QueryRegistry + hook matching
 * - Cleanup of empty archetypes after entity cascades
 *
 * This extraction shrinks World while keeping the same behavior and hot-path characteristics.
 */
export class ArchetypeManager {
  // Public for performance (hot paths access these maps frequently).
  // This intentionally breaks encapsulation a bit for speed, as requested.
  readonly archetypes: Archetype[] = [];
  readonly archetypeBySignature = new Map<string, Archetype>();
  readonly entityToArchetype = new Map<EntityId, Archetype>();
  readonly archetypesByComponent = new Map<EntityId<any>, Set<Archetype>>();
  readonly entityToReferencingArchetypes = new Map<EntityId, Set<Archetype>>();

  private readonly sparseStore: SparseStore;
  private readonly ctx: ArchetypeManagerContext;

  constructor(ctx: ArchetypeManagerContext, sparseStore: SparseStore) {
    this.ctx = ctx;
    this.sparseStore = sparseStore;
  }

  // ------------------------------------------------------------------
  // Public / package-internal surface used by World and its close collaborators
  // (commands.ts applyChangeset, serialization deserialization context, etc.)
  // ------------------------------------------------------------------

  /** Primary entry point — memoized archetype creation/lookup. */
  ensureArchetype(componentTypes: Iterable<EntityId<any>>): Archetype {
    const regularTypes = filterRegularComponentTypes(componentTypes);
    const sortedTypes = normalizeComponentTypes(regularTypes);
    const hashKey = this.createArchetypeSignature(sortedTypes);

    return getOrCompute(this.archetypeBySignature, hashKey, () => this.createNewArchetype(sortedTypes));
  }

  getArchetypeForEntity(entityId: EntityId): Archetype | undefined {
    return this.entityToArchetype.get(entityId);
  }

  setEntityToArchetype(entityId: EntityId, archetype: Archetype): void {
    this.entityToArchetype.set(entityId, archetype);
  }

  // Query helpers (moved from World for cohesion)
  getMatchingArchetypes(componentTypes: EntityId<any>[]): Archetype[] {
    if (componentTypes.length === 0) {
      return [...this.archetypes];
    }

    const regularComponents: EntityId<any>[] = [];
    // Both wildcard and specific sparse relations resolve via the wildcard marker on the archetype.
    // Specific sparse targets are refined later at the entity level by Query.
    const markerRelations: { componentId: EntityId<any>; relationId: EntityId<any> }[] = [];

    for (const componentType of componentTypes) {
      if (isWildcardRelationId(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId !== undefined) {
          markerRelations.push({ componentId, relationId: componentType });
        }
      } else if (isSparseRelation(componentType)) {
        const componentId = getComponentIdFromRelationId(componentType);
        if (componentId !== undefined) {
          // Index key is always relation(componentId, "*") for sparse relations
          markerRelations.push({ componentId, relationId: relation(componentId, "*") });
        }
      } else {
        regularComponents.push(componentType);
      }
    }

    let matchingArchetypes = this.getArchetypesWithComponents(regularComponents);

    for (const { componentId, relationId } of markerRelations) {
      const markerSet = this.archetypesByComponent.get(relationId);
      const archetypesWithMarker = markerSet ? Array.from(markerSet) : [];
      matchingArchetypes =
        matchingArchetypes.length === 0
          ? archetypesWithMarker
          : matchingArchetypes.filter((a) => markerSet?.has(a) || a.hasRelationWithComponentId(componentId));
    }

    return matchingArchetypes;
  }

  getArchetypesWithComponents(componentTypes: EntityId<any>[]): Archetype[] {
    if (componentTypes.length === 0) return [...this.archetypes];
    if (componentTypes.length === 1) {
      const set = this.archetypesByComponent.get(componentTypes[0]!);
      return set ? Array.from(set) : [];
    }

    // Sort by Set size, intersect starting from the smallest
    const sets = componentTypes
      .map((type) => this.archetypesByComponent.get(type))
      .filter((s): s is Set<Archetype> => s !== undefined && s.size > 0)
      .sort((a, b) => a.size - b.size);

    if (sets.length === 0) return [];
    if (sets.length < componentTypes.length) return []; // One component has no matching archetypes

    const smallest = sets[0]!;

    // 2-component fast path
    if (sets.length === 2) {
      const other = sets[1]!;
      return Array.from(smallest).filter((a) => other.has(a));
    }

    // Multi-component intersection
    let result = new Set(smallest);
    for (let i = 1; i < sets.length; i++) {
      for (const item of result) {
        if (!sets[i]!.has(item)) result.delete(item);
      }
      if (result.size === 0) return [];
    }
    return Array.from(result);
  }

  // ------------------------------------------------------------------
  // Internal creation / removal (core of the original cluster)
  // ------------------------------------------------------------------

  private createArchetypeSignature(componentTypes: EntityId<any>[]): string {
    return componentTypes.join(",");
  }

  /** Deduplicated version of the original pair of methods. */
  private updateReferencingIndex(componentType: EntityId<any>, archetype: Archetype, isAdd: boolean): void {
    const detailedType = getDetailedIdType(componentType);
    let entityId: EntityId | undefined;

    if (detailedType.type === "entity") {
      entityId = componentType as EntityId;
    } else if (detailedType.type === "entity-relation") {
      entityId = detailedType.targetId;
    }

    if (entityId !== undefined) {
      let refs = this.entityToReferencingArchetypes.get(entityId);
      if (isAdd) {
        if (!refs) {
          refs = new Set();
          this.entityToReferencingArchetypes.set(entityId, refs);
        }
        refs.add(archetype);
      } else {
        if (refs) {
          refs.delete(archetype);
          if (refs.size === 0) {
            this.entityToReferencingArchetypes.delete(entityId);
          }
        }
      }
    }
  }

  private createNewArchetype(componentTypes: EntityId<any>[]): Archetype {
    const newArchetype = new Archetype(componentTypes, this.sparseStore);
    this.archetypes.push(newArchetype);

    this.ctx.recordArchetypeCreated?.();

    for (const componentType of componentTypes) {
      let archetypes = this.archetypesByComponent.get(componentType);
      if (!archetypes) {
        archetypes = new Set();
        this.archetypesByComponent.set(componentType, archetypes);
      }
      archetypes.add(newArchetype);

      // Update reverse index (deduped)
      this.updateReferencingIndex(componentType, newArchetype, true);
    }

    this.ctx.queryRegistry.onNewArchetype(newArchetype);
    this.updateArchetypeHookMatches(newArchetype);

    return newArchetype;
  }

  private updateArchetypeHookMatches(archetype: Archetype): void {
    for (const entry of this.ctx.hooks) {
      if (this.archetypeMatchesHook(archetype, entry)) {
        archetype.matchingMultiHooks.add(entry);
        if (entry.matchedArchetypes) {
          entry.matchedArchetypes.add(archetype);
        }
      }
    }
  }

  public archetypeMatchesHook(archetype: Archetype, entry: LifecycleHookEntry): boolean {
    return (
      entry.requiredComponents.every((c: EntityId<any>) => {
        if (isWildcardRelationId(c)) {
          if (isSparseWildcard(c)) return true;
          const componentId = getComponentIdFromRelationId(c);
          return componentId !== undefined && archetype.hasRelationWithComponentId(componentId);
        }
        return archetype.componentTypeSet.has(c) || isSparseRelation(c);
      }) && matchesFilter(archetype, entry.filter)
    );
  }

  /** Called during cascade deletion cleanup. */
  cleanupArchetypesReferencingEntity(entityId: EntityId): void {
    const refs = this.entityToReferencingArchetypes.get(entityId);
    if (!refs) return;

    for (const archetype of refs) {
      if (archetype.getEntities().length === 0) {
        this.removeArchetype(archetype);
      }
    }
    // removeArchetype already cleans up the reverse index entries for the archetypes themselves
    this.entityToReferencingArchetypes.delete(entityId);
  }

  private removeArchetype(archetype: Archetype): void {
    const index = this.archetypes.indexOf(archetype);
    if (index !== -1) {
      // swap-and-pop: O(1) removal
      const last = this.archetypes[this.archetypes.length - 1]!;
      this.archetypes[index] = last;
      this.archetypes.pop();
    }

    this.ctx.recordArchetypeRemoved?.();

    this.archetypeBySignature.delete(this.createArchetypeSignature(archetype.componentTypes));

    for (const componentType of archetype.componentTypes) {
      const archetypes = this.archetypesByComponent.get(componentType);
      if (archetypes) {
        archetypes.delete(archetype);
        if (archetypes.size === 0) {
          this.archetypesByComponent.delete(componentType);
        }
      }

      // Clean up reverse index (deduped)
      this.updateReferencingIndex(componentType, archetype, false);
    }

    this.ctx.queryRegistry.onArchetypeRemoved(archetype);
  }
}
