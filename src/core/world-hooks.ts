import { getComponentIdFromRelationId, relation, type EntityId } from "./entity";
import type { ComponentType, LifecycleHook, MultiLifecycleHook } from "./types";
import { isOptionalEntityId } from "./types";

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
    const anyRequiredAdded = requiredComponents.some((c) => addedComponents.has(c));
    const anyOptionalAdded = optionalComponents.some((c) => addedComponents.has(c));
    const anyRequiredRemoved = requiredComponents.some((c) => removedComponents.has(c));

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
  return requiredComponents.every((c) => ctx.has(entityId, c));
}

function entityHadAllComponentsBefore(
  ctx: HooksContext,
  entityId: EntityId,
  requiredComponents: EntityId<any>[],
  removedComponents: Map<EntityId<any>, any>,
): boolean {
  return requiredComponents.every((c) => removedComponents.has(c) || ctx.has(entityId, c));
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
      return removedComponents.has(optionalId)
        ? { value: removedComponents.get(optionalId) }
        : ctx.getOptional(entityId, optionalId);
    }
    const compId = ct as EntityId<any>;
    return removedComponents.has(compId) ? removedComponents.get(compId) : ctx.get(entityId, compId);
  });
}
