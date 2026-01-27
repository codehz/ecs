import { getComponentIdFromRelationId, isWildcardRelationId, relation, type EntityId } from "./entity";
import type { ComponentType, LifecycleHook, MultiLifecycleHook } from "./types";
import { isOptionalEntityId } from "./types";

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

export type HooksMap = Map<EntityId<any>, Set<LifecycleHook<any>>>;

export interface MultiHookEntry {
  componentTypes: readonly ComponentType<any>[];
  requiredComponents: EntityId<any>[];
  optionalComponents: EntityId<any>[];
  hook: MultiLifecycleHook<any>;
}

export interface HooksContext {
  hooks: HooksMap;
  multiHooks: Set<MultiHookEntry>;
  has: (entityId: EntityId, componentType: EntityId<any>) => boolean;
  get: <T>(entityId: EntityId, componentType: EntityId<T>) => T;
  getOptional: <T>(entityId: EntityId, componentType: EntityId<T>) => { value: T } | undefined;
}

export function triggerLifecycleHooks(
  ctx: HooksContext,
  entityId: EntityId,
  addedComponents: Map<EntityId<any>, any>,
  removedComponents: Map<EntityId<any>, any>,
): void {
  invokeHooksForComponents(ctx.hooks, entityId, addedComponents, "on_set");
  invokeHooksForComponents(ctx.hooks, entityId, removedComponents, "on_remove");
  triggerMultiComponentHooks(ctx, entityId, addedComponents, removedComponents);
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
): void {
  for (const { componentTypes, requiredComponents, optionalComponents, hook } of ctx.multiHooks) {
    // Support wildcard-relation matching: check if any added/removed component matches hook components
    const anyRequiredAdded = requiredComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyOptionalAdded = optionalComponents.some((c) => anyComponentMatches(addedComponents, c));
    const anyRequiredRemoved = requiredComponents.some((c) => anyComponentMatches(removedComponents, c));

    // Handle on_set: trigger if any required or optional component was added and entity has all required components now
    if (
      (anyRequiredAdded || anyOptionalAdded) &&
      hook.on_set &&
      entityHasAllComponents(ctx, entityId, requiredComponents)
    ) {
      hook.on_set(entityId, componentTypes, collectMultiHookComponents(ctx, entityId, componentTypes));
    }

    // Handle on_remove: trigger if any required component was removed and entity had all required components before
    if (
      anyRequiredRemoved &&
      hook.on_remove &&
      entityHadAllComponentsBefore(ctx, entityId, requiredComponents, removedComponents)
    ) {
      hook.on_remove(
        entityId,
        componentTypes,
        collectMultiHookComponentsWithRemoved(ctx, entityId, componentTypes, removedComponents),
      );
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

function collectMultiHookComponentsWithRemoved(
  ctx: HooksContext,
  entityId: EntityId,
  componentTypes: readonly ComponentType<any>[],
  removedComponents: Map<EntityId<any>, any>,
): any[] {
  return componentTypes.map((ct) => {
    if (isOptionalEntityId(ct)) {
      const optionalId = ct.optional;
      const match = findMatchingComponent(removedComponents, optionalId);
      return match ? { value: match[1] } : ctx.getOptional(entityId, optionalId);
    }
    const compId = ct as EntityId<any>;
    const match = findMatchingComponent(removedComponents, compId);
    return match ? match[1] : ctx.get(entityId, compId);
  });
}
