import type { Archetype } from "../archetype/archetype";
import type { DontFragmentStore } from "../archetype/store";
import type { Command } from "../commands/buffer";
import type { ComponentChangeset } from "../commands/changeset";
import { normalizeComponentTypes } from "../component/type-utils";
import {
  getComponentIdFromRelationId,
  getComponentMerge,
  isDontFragmentComponent,
  isDontFragmentRelation,
  isDontFragmentWildcard,
  isWildcardRelationId,
  relation,
  type ComponentId,
  type EntityId,
} from "../entity";

export interface CommandProcessorContext {
  dontFragmentStore: DontFragmentStore;
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

  const merge = getComponentMerge(componentType);
  if (merge !== undefined && changeset.adds.has(componentType)) {
    const prev = changeset.adds.get(componentType);
    changeset.set(componentType, merge(prev, component));
    return;
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

  // Also check if this changeset itself is adding another relation of the same kind
  // (common in exclusive dontFragment flips: remove old target + add new target in one batch)
  for (const addedType of changeset.adds.keys()) {
    if (addedType === removedComponentType) continue;
    if (getComponentIdFromRelationId(addedType) === componentId) {
      return; // Replacement is being added in the same changeset, keep the marker
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

  for (const [componentType] of changeset.adds) {
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
  removedComponents: Map<EntityId<any>, any> | null,
): Archetype {
  pruneMissingRemovals(changeset, currentArchetype, entityId);
  const archetypeChanged = hasArchetypeStructuralChange(changeset, currentArchetype);

  if (archetypeChanged) {
    const finalRegularTypes = buildFinalRegularComponentTypes(currentArchetype, changeset);
    const newArchetype = ctx.ensureArchetype(finalRegularTypes);
    const currentComponents = currentArchetype.removeEntity(entityId)!;

    if (removedComponents !== null) {
      for (const componentType of changeset.removes) {
        removedComponents.set(componentType, currentComponents.get(componentType));
      }
    }

    newArchetype.addEntity(entityId, changeset.applyTo(currentComponents));
    entityToArchetype.set(entityId, newArchetype);
    return newArchetype;
  }

  // No archetype move needed: only component payload updates and/or dontFragment relation updates.
  if (removedComponents !== null) {
    applyDontFragmentChanges(ctx.dontFragmentStore, entityId, changeset, removedComponents);
  } else {
    applyDontFragmentChangesNoHooks(ctx.dontFragmentStore, entityId, changeset);
  }

  // Direct update for regular components in archetype
  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      continue;
    }
    currentArchetype.set(entityId, componentType, component);
  }

  return currentArchetype;
}

/**
 * No-hooks variant of applyDontFragmentChanges that skips tracking removed component data.
 *
 * Rewritten for the new DontFragmentStore interface (ComponentId-primary storage).
 */
function applyDontFragmentChanges(
  dontFragmentRelations: DontFragmentStore,
  entityId: EntityId,
  changeset: ComponentChangeset,
  removedComponents: Map<EntityId<any>, any>,
): void {
  for (const componentType of changeset.removes) {
    if (isDontFragmentRelation(componentType)) {
      const removedValue = dontFragmentRelations.getValue(entityId, componentType);
      // Record for hooks if we are actually removing something
      if (
        removedValue !== undefined ||
        dontFragmentRelations.getAllForEntity(entityId).some(([t]) => t === componentType)
      ) {
        removedComponents.set(componentType, removedValue);
      }
      dontFragmentRelations.deleteValue(entityId, componentType);
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      dontFragmentRelations.setValue(entityId, componentType, component);
    }
  }
}

function applyDontFragmentChangesNoHooks(
  dontFragmentRelations: DontFragmentStore,
  entityId: EntityId,
  changeset: ComponentChangeset,
): void {
  for (const componentType of changeset.removes) {
    if (isDontFragmentRelation(componentType)) {
      dontFragmentRelations.deleteValue(entityId, componentType);
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isDontFragmentRelation(componentType)) {
      dontFragmentRelations.setValue(entityId, componentType, component);
    }
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
