import type { Archetype } from "../archetype/archetype";
import {
  getComponentIdFromRelationId,
  getTargetIdFromRelationId,
  isWildcardRelationId,
  type EntityId,
} from "../entity";
import type { QueryFilter } from "../query/filter";
import {
  isOptionalEntityId,
  type ComponentType,
  type LifecycleCallback,
  type LifecycleHook,
  type LifecycleHookEntry,
} from "../types";

/**
 * Debug-only counter incremented on every invokeHook call when armed.
 * World reads and resets this during armed syncs.
 */
export const debugHookExecutionCounter = { value: 0 };

/**
 * Unified hook invocation: prefers entry.callback (callback style) over hook.on_* (object style).
 */
function invokeHook(
  entry: LifecycleHookEntry,
  event: "init" | "set" | "remove",
  entityId: EntityId,
  components: any[],
): void {
  debugHookExecutionCounter.value++;

  if (entry.callback) {
    entry.callback(event as any, entityId, ...components);
    return;
  }
  const hook = entry.hook;
  if (event === "init") hook.on_init?.(entityId, ...components);
  else if (event === "set") hook.on_set?.(entityId, ...components);
  else hook.on_remove?.(entityId, ...components);
}

/**
 * Check if a component change matches a hook component type.
 * Handles wildcard-relation matching: if hookComponent is a wildcard relation (e.g., relation(A, "*")),
 * it matches any concrete relation with the same component ID (e.g., relation(A, entity1)).
 */
function componentMatchesHookType(changedComponent: EntityId<any>, hookComponent: EntityId<any>): boolean {
  if (changedComponent === hookComponent) return true;

  // Check if hookComponent is a wildcard relation and changedComponent is a matching relation
  if (isWildcardRelationId(hookComponent)) {
    const hookComponentId = getComponentIdFromRelationId(hookComponent);
    const changedComponentId = getComponentIdFromRelationId(changedComponent);
    if (hookComponentId !== undefined && changedComponentId !== undefined) {
      return hookComponentId === changedComponentId;
    }
  }

  return false;
}

/**
 * Check if any component in the changes map matches a hook component type.
 */
function anyComponentMatches(changes: Map<EntityId<any>, any>, hookComponent: EntityId<any>): boolean {
  for (const changedComponent of changes.keys()) {
    if (componentMatchesHookType(changedComponent, hookComponent)) {
      return true;
    }
  }
  return false;
}

/**
 * Find a matching component in the changes map that matches the hook component type.
 * Returns [componentId, value] if found, undefined otherwise.
 */
function findMatchingComponent(
  changes: Map<EntityId<any>, any>,
  hookComponent: EntityId<any>,
): [EntityId<any>, any] | undefined {
  for (const [changedComponent, value] of changes.entries()) {
    if (componentMatchesHookType(changedComponent, hookComponent)) {
      return [changedComponent, value];
    }
  }
  return undefined;
}

export interface HooksContext {
  multiHooks: Set<LifecycleHookEntry>;
  has: (entityId: EntityId, componentType: EntityId<any>) => boolean;
  get: <T>(entityId: EntityId, componentType: EntityId<T>) => T;
  getOptional: <T>(entityId: EntityId, componentType: EntityId<T>) => { value: T } | undefined;
}

export function triggerLifecycleHooks(
  ctx: HooksContext,
  entityId: EntityId,
  addedComponents: Map<EntityId<any>, any>,
  removedComponents: Map<EntityId<any>, any>,
  oldArchetype: Archetype,
  newArchetype: Archetype,
): void {
  triggerMultiComponentHooks(ctx, entityId, addedComponents, removedComponents, oldArchetype, newArchetype);
}

/**
 * Fast path for triggering lifecycle hooks when an entity is being deleted.
 * This avoids unnecessary archetype lookups and on_set checks since the entity
 * is being completely removed.
 */
export function triggerRemoveHooksForEntityDeletion(
  entityId: EntityId,
  removedComponents: Map<EntityId<any>, any>,
  oldArchetype: Archetype,
): void {
  if (removedComponents.size === 0) return;

  // Trigger multi-component hooks - only on_remove since entity is being deleted
  for (const entry of oldArchetype.matchingMultiHooks) {
    const { requiredComponents, componentTypes } = entry;

    // Skip if neither callback-style nor hook-style on_remove is provided
    if (!entry.callback && !entry.hook.on_remove) continue;

    // Check if any required component was removed
    const anyRequiredRemoved = requiredComponents.some((c) => anyComponentMatches(removedComponents, c));
    if (!anyRequiredRemoved) continue;

    // For entity deletion, we know:
    // 1. All components are being removed, so entity "had" all required components
    // 2. Entity will no longer match after deletion
    // Just need to verify the entity actually had all required components before
    const hadAllRequired = requiredComponents.every((c) => anyComponentMatches(removedComponents, c));
    if (!hadAllRequired) continue;

    // Collect component values from removedComponents directly (no entity lookup needed)
    const components = collectComponentsFromRemoved(componentTypes, removedComponents);
    invokeHook(entry, "remove", entityId, components);
  }
}

function triggerMultiComponentHooks(
  ctx: HooksContext,
  entityId: EntityId,
  addedComponents: Map<EntityId<any>, any>,
  removedComponents: Map<EntityId<any>, any>,
  oldArchetype: Archetype,
  newArchetype: Archetype,
): void {
  // Handle on_set:
  // 1. Required/optional components changed while entity still matches
  // 2. Entity entered the matching set (e.g. removed a negative filter component)
  for (const entry of newArchetype.matchingMultiHooks) {
    const { requiredComponents, optionalComponents, componentTypes } = entry;

    // Skip if neither callback-style nor hook-style on_set is provided
    if (!entry.callback && !entry.hook.on_set) continue;

    const anyRequiredAdded = requiredComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyOptionalAdded = optionalComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyOptionalRemoved = optionalComponents.some((c) => anyComponentMatches(removedComponents, c));
    const enteredMatchingSet = !oldArchetype.matchingMultiHooks.has(entry);
    const hasRelevantComponentChange = anyRequiredAdded || anyOptionalAdded || anyOptionalRemoved;
    const shouldTriggerSet =
      enteredMatchingSet || (hasRelevantComponentChange && entityHasAllComponents(ctx, entityId, requiredComponents));

    if (shouldTriggerSet) {
      const components = collectMultiHookComponents(ctx, entityId, componentTypes);
      invokeHook(entry, "set", entityId, components);
    }
  }

  // Handle on_remove:
  // 1. Required component removal made the entity stop matching
  // 2. Entity exited the matching set (e.g. added a negative filter component)
  for (const entry of oldArchetype.matchingMultiHooks) {
    const { requiredComponents, componentTypes } = entry;

    // Skip if neither callback-style nor hook-style on_remove is provided
    if (!entry.callback && !entry.hook.on_remove) continue;

    const anyRequiredRemoved = requiredComponents.some((c) => anyComponentMatches(removedComponents, c));
    const lostRequiredMatch =
      anyRequiredRemoved &&
      entityHadAllComponentsBefore(ctx, entityId, requiredComponents, removedComponents) &&
      !entityHasAllComponents(ctx, entityId, requiredComponents);
    const exitedMatchingSet = !newArchetype.matchingMultiHooks.has(entry);
    const shouldTriggerRemove = lostRequiredMatch || exitedMatchingSet;

    if (shouldTriggerRemove) {
      const components = collectMultiHookComponentsWithRemoved(ctx, entityId, componentTypes, removedComponents);
      invokeHook(entry, "remove", entityId, components);
    }
  }
}

function entityHasAllComponents(ctx: HooksContext, entityId: EntityId, requiredComponents: EntityId<any>[]): boolean {
  return requiredComponents.every((c) => {
    // For wildcard relations, check if the entity has the wildcard relation data
    if (isWildcardRelationId(c)) {
      const wildcardResult = ctx.getOptional(entityId, c);
      if (!wildcardResult) return false;
      const wildcardData = wildcardResult.value;
      return Array.isArray(wildcardData) && wildcardData.length > 0;
    }
    return ctx.has(entityId, c);
  });
}

function entityHadAllComponentsBefore(
  ctx: HooksContext,
  entityId: EntityId,
  requiredComponents: EntityId<any>[],
  removedComponents: Map<EntityId<any>, any>,
): boolean {
  return requiredComponents.every((c) => {
    // Check if a matching component was removed
    if (anyComponentMatches(removedComponents, c)) return true;

    // For wildcard relations, check if the entity still has matching relations
    if (isWildcardRelationId(c)) {
      const wildcardResult = ctx.getOptional(entityId, c);
      if (!wildcardResult) return false;
      const wildcardData = wildcardResult.value;
      return Array.isArray(wildcardData) && wildcardData.length > 0;
    }
    return ctx.has(entityId, c);
  });
}

export function collectMultiHookComponents(
  ctx: HooksContext,
  entityId: EntityId,
  componentTypes: readonly ComponentType<any>[],
): any[] {
  return componentTypes.map((ct) =>
    isOptionalEntityId(ct) ? ctx.getOptional(entityId, ct.optional) : ctx.get(entityId, ct as EntityId<any>),
  );
}

/**
 * Reconstructs wildcard relation data by merging current data with removed components.
 * Returns an array of [targetId, value] tuples for the wildcard relation.
 *
 * This is used during "on_remove" hook invocation: the removed components have already
 * been taken out of the entity's archetype, but the hook callback expects to see the
 * full data as it existed *before* removal. We reconstruct that snapshot by taking the
 * current wildcard data (post-removal) and adding back the entries that were just removed.
 */
function reconstructWildcardWithRemoved(
  ctx: HooksContext,
  entityId: EntityId,
  wildcardId: EntityId<any>,
  removedComponents: Map<EntityId<any>, any>,
): [EntityId, any][] {
  // ctx.get() for a wildcard relation ID always returns [EntityId, any][] at runtime
  // (see Archetype.getWildcardRelations / ComponentEntityStore.getWildcard).
  // The HooksContext interface erases the WildcardRelationId overload for simplicity,
  // so we assert the expected shape here rather than silently falling back to [].
  const currentData = ctx.get(entityId, wildcardId);
  if (!Array.isArray(currentData)) {
    throw new Error(
      `Expected wildcard relation data to be an array, but got ${typeof currentData} ` +
        `for entity ${entityId} and wildcard ${wildcardId}. ` +
        `This indicates a HooksContext implementation that does not conform to the expected contract.`,
    );
  }

  // Spread-copy the array so that pushing removed entries below does not mutate
  // the archetype's internal storage. Without the copy, we would leak removed
  // component data back into the live entity data.
  const result = [...currentData];

  // Re-inject matching relations that were just removed, so the hook callback
  // sees the complete snapshot as it existed before the removal.
  for (const [removedCompId, removedValue] of removedComponents.entries()) {
    // Skip wildcard markers themselves — they encode WILDCARD_TARGET_ID=0 and
    // would produce spurious [0, undefined] entries in the hook callback.
    if (isWildcardRelationId(removedCompId)) continue;
    if (componentMatchesHookType(removedCompId, wildcardId)) {
      const targetId = getTargetIdFromRelationId(removedCompId);
      if (targetId !== undefined) {
        result.push([targetId, removedValue]);
      }
    }
  }

  return result;
}

function collectMultiHookComponentsWithRemoved(
  ctx: HooksContext,
  entityId: EntityId,
  componentTypes: readonly ComponentType<any>[],
  removedComponents: Map<EntityId<any>, any>,
): any[] {
  return componentTypes.map((ct) => {
    if (isOptionalEntityId(ct)) {
      const optionalId = ct.optional;

      if (isWildcardRelationId(optionalId)) {
        const result = reconstructWildcardWithRemoved(ctx, entityId, optionalId, removedComponents);
        return result.length > 0 ? { value: result } : undefined;
      }

      const match = findMatchingComponent(removedComponents, optionalId);
      return match ? { value: match[1] } : ctx.getOptional(entityId, optionalId);
    }

    const compId = ct as EntityId<any>;

    if (isWildcardRelationId(compId)) {
      return reconstructWildcardWithRemoved(ctx, entityId, compId, removedComponents);
    }

    const match = findMatchingComponent(removedComponents, compId);
    return match ? match[1] : ctx.get(entityId, compId);
  });
}

/**
 * Collect component values directly from removedComponents map.
 * Used for entity deletion fast path where the entity no longer exists.
 */
function collectComponentsFromRemoved(
  componentTypes: readonly ComponentType<any>[],
  removedComponents: Map<EntityId<any>, any>,
): any[] {
  return componentTypes.map((ct) => {
    if (isOptionalEntityId(ct)) {
      const optionalId = ct.optional;

      if (isWildcardRelationId(optionalId)) {
        const result = collectWildcardFromRemoved(optionalId, removedComponents);
        return result.length > 0 ? { value: result } : undefined;
      }

      const match = findMatchingComponent(removedComponents, optionalId);
      return match ? { value: match[1] } : undefined;
    }

    const compId = ct as EntityId<any>;

    if (isWildcardRelationId(compId)) {
      return collectWildcardFromRemoved(compId, removedComponents);
    }

    const match = findMatchingComponent(removedComponents, compId);
    return match ? match[1] : undefined;
  });
}

/**
 * Collect all matching wildcard relation data from removed components.
 */
function collectWildcardFromRemoved(
  wildcardId: EntityId<any>,
  removedComponents: Map<EntityId<any>, any>,
): [EntityId, any][] {
  const result: [EntityId, any][] = [];

  for (const [removedCompId, removedValue] of removedComponents.entries()) {
    // Skip wildcard markers themselves — they encode WILDCARD_TARGET_ID=0.
    if (isWildcardRelationId(removedCompId)) continue;
    if (componentMatchesHookType(removedCompId, wildcardId)) {
      const targetId = getTargetIdFromRelationId(removedCompId);
      if (targetId !== undefined) {
        result.push([targetId, removedValue]);
      }
    }
  }

  return result;
}

/**
 * Dependencies for lifecycle hook registration (owned by World composition root).
 */
export interface RegisterHookDeps {
  hooks: Set<LifecycleHookEntry>;
  archetypes: Iterable<Archetype>;
  hooksContext: HooksContext;
  archetypeMatchesHook: (archetype: Archetype, entry: LifecycleHookEntry) => boolean;
}

/**
 * Register a multi-component lifecycle hook, wire matching archetypes, and fire on_init.
 * Returns an unsubscribe function.
 */
export function registerLifecycleHook(
  deps: RegisterHookDeps,
  componentTypes: readonly ComponentType<any>[],
  hook: LifecycleHook<any> | LifecycleCallback<any>,
  filter?: QueryFilter,
): () => void {
  const isCallback = typeof hook === "function";
  const callback = isCallback ? (hook as LifecycleCallback<any>) : undefined;

  const requiredComponents: EntityId<any>[] = [];
  const optionalComponents: EntityId<any>[] = [];
  for (const ct of componentTypes) {
    if (!isOptionalEntityId(ct)) {
      requiredComponents.push(ct as EntityId<any>);
    } else {
      optionalComponents.push(ct.optional);
    }
  }

  if (requiredComponents.length === 0) {
    throw new Error("Hook must have at least one required component");
  }

  const entry: LifecycleHookEntry = {
    componentTypes,
    requiredComponents,
    optionalComponents,
    filter: filter || {},
    hook: isCallback ? ({} as LifecycleHook<any>) : (hook as LifecycleHook<any>),
    callback,
    matchedArchetypes: new Set(),
  };
  deps.hooks.add(entry);

  const matchedArchetypes: Archetype[] = [];
  for (const archetype of deps.archetypes) {
    if (deps.archetypeMatchesHook(archetype, entry)) {
      archetype.matchingMultiHooks.add(entry);
      entry.matchedArchetypes!.add(archetype);
      matchedArchetypes.push(archetype);
    }
  }

  const shouldFireInit = isCallback || (hook as LifecycleHook<any>).on_init !== undefined;
  if (shouldFireInit) {
    for (const archetype of matchedArchetypes) {
      for (const entityId of archetype.getEntities()) {
        const components = collectMultiHookComponents(deps.hooksContext, entityId, componentTypes);
        if (isCallback) {
          (callback as LifecycleCallback<any>)("init", entityId, ...components);
        } else {
          (hook as LifecycleHook<any>).on_init!(entityId, ...components);
        }
      }
    }
  }

  return () => {
    deps.hooks.delete(entry);
    if (entry.matchedArchetypes) {
      for (const archetype of entry.matchedArchetypes) {
        archetype.matchingMultiHooks.delete(entry);
      }
    }
  };
}
