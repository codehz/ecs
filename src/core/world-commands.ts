import type { ComponentChangeset } from "../commands/changeset";
import type { Command } from "../commands/command-buffer";
import type { Archetype } from "./archetype";
import { normalizeComponentTypes } from "./component-type-utils";
import {
  getComponentIdFromRelationId,
  isDontFragmentComponent,
  isDontFragmentRelation,
  isDontFragmentWildcard,
  isWildcardRelationId,
  relation,
  type ComponentId,
  type EntityId,
} from "./entity";

export interface CommandProcessorContext {
  dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>;
  ensureArchetype: (componentTypes: Iterable<EntityId<any>>) => Archetype;
}

export function processCommands(
  entityId: EntityId,
  currentArchetype: Archetype,
  commands: Command[],
  changeset: ComponentChangeset,
  handleExclusiveRelation: (entityId: EntityId, archetype: Archetype, componentId: ComponentId<any>) => void,
): void {
  for (const command of commands) {
    if (command.type === "set") {
      // TypeScript knows command.componentType and command.component exist
      processSetCommand(
        entityId,
        currentArchetype,
        command.componentType,
        command.component,
        changeset,
        handleExclusiveRelation,
      );
    } else if (command.type === "delete") {
      // TypeScript knows command.componentType exists
      processDeleteCommand(entityId, currentArchetype, command.componentType, changeset);
    }
  }
}

function processSetCommand(
  entityId: EntityId,
  currentArchetype: Archetype,
  componentType: EntityId<any>,
  component: any,
  changeset: ComponentChangeset,
  handleExclusiveRelation: (entityId: EntityId, archetype: Archetype, componentId: ComponentId<any>) => void,
): void {
  // Extract componentId if it's a relation (fast path)
  const componentId = getComponentIdFromRelationId(componentType);
  if (componentId !== undefined) {
    // Handle exclusive relations by removing existing relations with the same base component
    handleExclusiveRelation(entityId, currentArchetype, componentId);

    // For dontFragment relations, ensure wildcard marker is in archetype signature
    if (isDontFragmentComponent(componentId)) {
      const wildcardMarker = relation(componentId, "*");
      // Add wildcard marker to changeset if not already in archetype
      if (!currentArchetype.componentTypeSet.has(wildcardMarker)) {
        changeset.set(wildcardMarker, undefined);
      }
    }
  }

  changeset.set(componentType, component);
}

function processDeleteCommand(
  entityId: EntityId,
  currentArchetype: Archetype,
  componentType: EntityId<any>,
  changeset: ComponentChangeset,
): void {
  const componentId = getComponentIdFromRelationId(componentType);

  if (isWildcardRelationId(componentType) && componentId !== undefined) {
    removeWildcardRelations(entityId, currentArchetype, componentId, changeset);
  } else {
    changeset.delete(componentType);
    maybeRemoveWildcardMarker(entityId, currentArchetype, componentType, componentId, changeset);
  }
}

export function removeMatchingRelations(
  entityId: EntityId,
  archetype: Archetype,
  baseComponentId: ComponentId<any>,
  changeset: ComponentChangeset,
): void {
  // Check archetype components
  for (const componentType of archetype.componentTypes) {
    // Skip wildcard markers - they should only be removed by maybeRemoveWildcardMarker
    if (isWildcardRelationId(componentType)) continue;

    if (getComponentIdFromRelationId(componentType) === baseComponentId) {
      changeset.delete(componentType);
    }
  }

  // Check dontFragment relations stored on entity
  const dontFragmentData = archetype.getEntityDontFragmentRelations(entityId);
  if (dontFragmentData) {
    for (const componentType of dontFragmentData.keys()) {
      if (getComponentIdFromRelationId(componentType) === baseComponentId) {
        changeset.delete(componentType);
      }
    }
  }
}

function removeWildcardRelations(
  entityId: EntityId,
  currentArchetype: Archetype,
  baseComponentId: ComponentId<any>,
  changeset: ComponentChangeset,
): void {
  removeMatchingRelations(entityId, currentArchetype, baseComponentId, changeset);

  // If removing dontFragment relations, also remove the wildcard marker
  if (isDontFragmentComponent(baseComponentId)) {
    changeset.delete(relation(baseComponentId, "*"));
  }
}

export function maybeRemoveWildcardMarker(
  entityId: EntityId,
  archetype: Archetype,
  removedComponentType: EntityId<any>,
  componentId: ComponentId<any> | undefined,
  changeset: ComponentChangeset,
): void {
  if (componentId === undefined || !isDontFragmentComponent(componentId)) {
    return;
  }

  const wildcardMarker = relation(componentId, "*");

  // Check if there are any other relations with the same component ID
  for (const otherComponentType of archetype.componentTypes) {
    if (otherComponentType === removedComponentType) continue;
    if (otherComponentType === wildcardMarker) continue;
    if (changeset.removes.has(otherComponentType)) continue;

    if (getComponentIdFromRelationId(otherComponentType) === componentId) {
      return; // Found another relation, keep the marker
    }
  }

  const dontFragmentData = archetype.getEntityDontFragmentRelations(entityId);
  if (dontFragmentData) {
    for (const otherComponentType of dontFragmentData.keys()) {
      if (otherComponentType === removedComponentType) continue;
      if (changeset.removes.has(otherComponentType)) continue;

      if (getComponentIdFromRelationId(otherComponentType) === componentId) {
        return; // Found another relation, keep the marker
      }
    }
  }

  changeset.delete(wildcardMarker);
}

function hasEntityComponent(archetype: Archetype, entityId: EntityId, componentType: EntityId<any>): boolean {
  if (archetype.componentTypeSet.has(componentType)) {
    return true;
  }

  return archetype.getEntityDontFragmentRelations(entityId)?.has(componentType) ?? false;
}

function pruneMissingRemovals(changeset: ComponentChangeset, archetype: Archetype, entityId: EntityId): void {
  // Collect to-prune entries first to avoid mutating the set during iteration
  let toPrune: EntityId<any>[] | undefined;
  for (const componentType of changeset.removes) {
    if (!hasEntityComponent(archetype, entityId, componentType)) {
      if (toPrune === undefined) toPrune = [];
      toPrune.push(componentType);
    }
  }
  if (toPrune !== undefined) {
    for (const componentType of toPrune) {
      changeset.removes.delete(componentType);
    }
  }
}

function hasArchetypeStructuralChange(changeset: ComponentChangeset, currentArchetype: Archetype): boolean {
  for (const componentType of changeset.removes) {
    if (!isDontFragmentRelation(componentType) && currentArchetype.componentTypeSet.has(componentType)) {
      return true;
    }
  }

  for (const componentType of changeset.adds.keys()) {
    if (!isDontFragmentRelation(componentType) && !currentArchetype.componentTypeSet.has(componentType)) {
      return true;
    }
  }

  return false;
}

function buildFinalRegularComponentTypes(currentArchetype: Archetype, changeset: ComponentChangeset): EntityId<any>[] {
  const finalRegularTypes = new Set(currentArchetype.componentTypes);

  for (const componentType of changeset.removes) {
    if (!isDontFragmentRelation(componentType)) {
      finalRegularTypes.delete(componentType);
    }
  }

  for (const componentType of changeset.adds.keys()) {
    if (!isDontFragmentRelation(componentType)) {
      finalRegularTypes.add(componentType);
    }
  }

  return Array.from(finalRegularTypes);
}

export function applyChangeset(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  changeset: ComponentChangeset,
  entityToArchetype: Map<EntityId, Archetype>,
): { removedComponents: Map<EntityId<any>, any>; newArchetype: Archetype } {
  const removedComponents = new Map<EntityId<any>, any>();
  pruneMissingRemovals(changeset, currentArchetype, entityId);
  const archetypeChanged = hasArchetypeStructuralChange(changeset, currentArchetype);

  if (archetypeChanged) {
    const finalRegularTypes = buildFinalRegularComponentTypes(currentArchetype, changeset);
    const newArchetype = moveEntityToNewArchetype(
      ctx,
      entityId,
      currentArchetype,
      finalRegularTypes,
      changeset,
      removedComponents,
      entityToArchetype,
    );
    return { removedComponents, newArchetype };
  }

  // No archetype move needed: only component payload updates and/or dontFragment relation updates.
  updateEntityInSameArchetype(ctx, entityId, currentArchetype, changeset, removedComponents);

  return { removedComponents, newArchetype: currentArchetype };
}

/**
 * Optimized variant of applyChangeset for when no lifecycle hooks are registered.
 * Skips creating the removedComponents map, reducing allocations in the hot path.
 */
export function applyChangesetNoHooks(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  changeset: ComponentChangeset,
  entityToArchetype: Map<EntityId, Archetype>,
): Archetype {
  pruneMissingRemovals(changeset, currentArchetype, entityId);
  const archetypeChanged = hasArchetypeStructuralChange(changeset, currentArchetype);

  if (archetypeChanged) {
    const finalRegularTypes = buildFinalRegularComponentTypes(currentArchetype, changeset);
    return moveEntityToNewArchetypeNoHooks(
      ctx,
      entityId,
      currentArchetype,
      finalRegularTypes,
      changeset,
      entityToArchetype,
    );
  }

  // No archetype move: only component payload updates and/or dontFragment relation updates.
  updateEntityInSameArchetypeNoHooks(ctx, entityId, currentArchetype, changeset);

  return currentArchetype;
}

function moveEntityToNewArchetype(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  finalComponentTypes: EntityId<any>[],
  changeset: ComponentChangeset,
  removedComponents: Map<EntityId<any>, any>,
  entityToArchetype: Map<EntityId, Archetype>,
): Archetype {
  const newArchetype = ctx.ensureArchetype(finalComponentTypes);
  const currentComponents = currentArchetype.removeEntity(entityId)!;

  // Track removed components
  for (const componentType of changeset.removes) {
    removedComponents.set(componentType, currentComponents.get(componentType));
  }

  // Add to new archetype with updated components
  newArchetype.addEntity(entityId, changeset.applyTo(currentComponents));
  entityToArchetype.set(entityId, newArchetype);
  return newArchetype;
}

function updateEntityInSameArchetype(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  changeset: ComponentChangeset,
  removedComponents: Map<EntityId<any>, any>,
): void {
  // Process dontFragment relation changes directly on World's storage
  applyDontFragmentChanges(ctx.dontFragmentRelations, entityId, changeset, removedComponents);

  // Direct update for regular components in archetype
  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      continue;
    }
    currentArchetype.set(entityId, componentType, component);
  }
}

/**
 * No-hooks variant: moves entity to new archetype without collecting removed component data.
 * Only called from applyChangesetNoHooks when no lifecycle hooks are registered.
 */
function moveEntityToNewArchetypeNoHooks(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  finalComponentTypes: EntityId<any>[],
  changeset: ComponentChangeset,
  entityToArchetype: Map<EntityId, Archetype>,
): Archetype {
  const newArchetype = ctx.ensureArchetype(finalComponentTypes);
  const currentComponents = currentArchetype.removeEntity(entityId)!;

  // Add to new archetype with updated components
  newArchetype.addEntity(entityId, changeset.applyTo(currentComponents));
  entityToArchetype.set(entityId, newArchetype);
  return newArchetype;
}

/**
 * No-hooks variant: updates entity in same archetype without tracking removed component data.
 * Only called from applyChangesetNoHooks when no lifecycle hooks are registered.
 */
function updateEntityInSameArchetypeNoHooks(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  changeset: ComponentChangeset,
): void {
  // Process dontFragment relation changes directly on World's storage
  applyDontFragmentChangesNoHooks(ctx.dontFragmentRelations, entityId, changeset);

  // Direct update for regular components in archetype
  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      continue;
    }
    currentArchetype.set(entityId, componentType, component);
  }
}

function applyDontFragmentChanges(
  dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>,
  entityId: EntityId,
  changeset: ComponentChangeset,
  removedComponents: Map<EntityId<any>, any>,
): void {
  // Get or create the entity's dontFragment relations map
  let entityRelations = dontFragmentRelations.get(entityId);

  for (const componentType of changeset.removes) {
    if (isDontFragmentRelation(componentType)) {
      if (entityRelations) {
        const removedValue = entityRelations.get(componentType);
        if (removedValue !== undefined || entityRelations.has(componentType)) {
          removedComponents.set(componentType, removedValue);
          entityRelations.delete(componentType);
        }
      }
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      if (!entityRelations) {
        entityRelations = new Map();
        dontFragmentRelations.set(entityId, entityRelations);
      }
      entityRelations.set(componentType, component);
    }
  }

  // Clean up empty map
  if (entityRelations && entityRelations.size === 0) {
    dontFragmentRelations.delete(entityId);
  }
}

/**
 * No-hooks variant of applyDontFragmentChanges that skips tracking removed component data.
 */
function applyDontFragmentChangesNoHooks(
  dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>,
  entityId: EntityId,
  changeset: ComponentChangeset,
): void {
  let entityRelations = dontFragmentRelations.get(entityId);

  for (const componentType of changeset.removes) {
    if (isDontFragmentRelation(componentType)) {
      if (entityRelations) {
        entityRelations.delete(componentType);
      }
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      if (!entityRelations) {
        entityRelations = new Map();
        dontFragmentRelations.set(entityId, entityRelations);
      }
      entityRelations.set(componentType, component);
    }
  }

  // Clean up empty map
  if (entityRelations && entityRelations.size === 0) {
    dontFragmentRelations.delete(entityId);
  }
}

export function filterRegularComponentTypes(componentTypes: Iterable<EntityId<any>>): EntityId<any>[] {
  const regularTypes: EntityId<any>[] = [];

  for (const componentType of componentTypes) {
    // Keep wildcard markers for dontFragment components (they mark the archetype)
    if (isDontFragmentWildcard(componentType)) {
      regularTypes.push(componentType);
      continue;
    }

    // Skip specific dontFragment relations from archetype signature
    if (isDontFragmentRelation(componentType)) {
      continue;
    }

    regularTypes.push(componentType);
  }

  return regularTypes;
}

export function areComponentTypesEqual(types1: EntityId<any>[], types2: EntityId<any>[]): boolean {
  if (types1.length !== types2.length) return false;
  const sorted1 = normalizeComponentTypes(types1);
  const sorted2 = normalizeComponentTypes(types2);
  return sorted1.every((v, i) => v === sorted2[i]);
}
