import type { Archetype } from "./archetype";
import {
  getComponentIdFromRelationId,
  getTargetIdFromRelationId,
  isWildcardRelationId,
  relation,
  type EntityId,
} from "./entity";
import { isOptionalEntityId, type ComponentType, type LegacyLifecycleHook, type LifecycleHookEntry } from "./types";

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

export type HooksMap = Map<EntityId<any>, Set<LegacyLifecycleHook<any>>>;

export interface HooksContext {
  hooks: HooksMap;
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
  invokeHooksForComponents(ctx.hooks, entityId, addedComponents, "on_set");
  invokeHooksForComponents(ctx.hooks, entityId, removedComponents, "on_remove");
  triggerMultiComponentHooks(ctx, entityId, addedComponents, removedComponents, oldArchetype, newArchetype);
}

/**
 * Fast path for triggering lifecycle hooks when an entity is being deleted.
 * This avoids unnecessary archetype lookups and on_set checks since the entity
 * is being completely removed.
 */
export function triggerRemoveHooksForEntityDeletion(
  ctx: HooksContext,
  entityId: EntityId,
  removedComponents: Map<EntityId<any>, any>,
  oldArchetype: Archetype,
): void {
  if (removedComponents.size === 0) return;

  // Trigger legacy hooks for removed components
  invokeHooksForComponents(ctx.hooks, entityId, removedComponents, "on_remove");

  // Trigger multi-component hooks - only on_remove since entity is being deleted
  for (const entry of oldArchetype.matchingMultiHooks) {
    const { hook, requiredComponents, componentTypes } = entry;
    if (!hook.on_remove) continue;

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
    hook.on_remove(entityId, ...components);
  }
}

function invokeHooksForComponents(
  hooks: HooksMap,
  entityId: EntityId,
  components: Map<EntityId<any>, any>,
  hookType: "on_set" | "on_remove",
): void {
  for (const [componentType, component] of components) {
    // Trigger direct component hooks
    const directHooks = hooks.get(componentType);
    if (directHooks) {
      for (const hook of directHooks) {
        hook[hookType]?.(entityId, componentType, component);
      }
    }

    // Trigger wildcard relation hooks
    const componentId = getComponentIdFromRelationId(componentType);
    if (componentId !== undefined) {
      const wildcardHooks = hooks.get(relation(componentId, "*"));
      if (wildcardHooks) {
        for (const hook of wildcardHooks) {
          hook[hookType]?.(entityId, componentType, component);
        }
      }
    }
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
  // Handle on_set: triggers if any required or optional component was added/removed and entity still matches
  for (const entry of newArchetype.matchingMultiHooks) {
    const { hook, requiredComponents, optionalComponents, componentTypes } = entry;
    if (!hook.on_set) continue;

    const anyRequiredAdded = requiredComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyOptionalAdded = optionalComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyOptionalRemoved = optionalComponents.some((c) => anyComponentMatches(removedComponents, c));

    if (
      (anyRequiredAdded || anyOptionalAdded || anyOptionalRemoved) &&
      entityHasAllComponents(ctx, entityId, requiredComponents)
    ) {
      hook.on_set(entityId, ...collectMultiHookComponents(ctx, entityId, componentTypes));
    }
  }

  // Handle on_remove: triggers if any required component was removed and entity no longer matches
  if (removedComponents.size > 0) {
    for (const entry of oldArchetype.matchingMultiHooks) {
      const { hook, requiredComponents, componentTypes } = entry;
      if (!hook.on_remove) continue;

      const anyRequiredRemoved = requiredComponents.some((c) => anyComponentMatches(removedComponents, c));

      // Only trigger if:
      // 1. A required component was removed
      // 2. Entity matched before (had all required components)
      // 3. Entity no longer matches after removal
      if (
        anyRequiredRemoved &&
        entityHadAllComponentsBefore(ctx, entityId, requiredComponents, removedComponents) &&
        !entityHasAllComponents(ctx, entityId, requiredComponents)
      ) {
        hook.on_remove(
          entityId,
          ...collectMultiHookComponentsWithRemoved(ctx, entityId, componentTypes, removedComponents),
        );
      }
    }
  }
}

function entityHasAllComponents(ctx: HooksContext, entityId: EntityId, requiredComponents: EntityId<any>[]): boolean {
  return requiredComponents.every((c) => {
    // For wildcard relations, check if the entity has the wildcard relation data
    // (ctx.get will return an array of matching relations, empty if none exist)
    if (isWildcardRelationId(c)) {
      try {
        const wildcardData = ctx.get(entityId, c);
        return Array.isArray(wildcardData) && wildcardData.length > 0;
      } catch {
        return false;
      }
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
      try {
        const wildcardData = ctx.get(entityId, c);
        return Array.isArray(wildcardData) && wildcardData.length > 0;
      } catch {
        return false;
      }
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
 */
function reconstructWildcardWithRemoved(
  ctx: HooksContext,
  entityId: EntityId,
  wildcardId: EntityId<any>,
  removedComponents: Map<EntityId<any>, any>,
): [EntityId, any][] {
  const currentData = ctx.get(entityId, wildcardId);
  const result = Array.isArray(currentData) ? [...currentData] : [];

  // Add removed matching relations
  for (const [removedCompId, removedValue] of removedComponents.entries()) {
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
    if (componentMatchesHookType(removedCompId, wildcardId)) {
      const targetId = getTargetIdFromRelationId(removedCompId);
      if (targetId !== undefined) {
        result.push([targetId, removedValue]);
      }
    }
  }

  return result;
}
