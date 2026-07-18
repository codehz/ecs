import type { Archetype } from "../archetype/archetype";
import type { SparseStore } from "../archetype/store";
import type { Command } from "../commands/buffer";
import type { ComponentChangeset } from "../commands/changeset";
import {
  getComponentIdFromRelationId,
  getComponentMerge,
  isSparseComponent,
  isSparseRelation,
  isWildcardRelationId,
  relation,
  type ComponentId,
  type EntityId,
} from "../entity";

// Re-export signature helpers from archetype domain for existing importers.
export { areComponentTypesEqual, filterRegularComponentTypes } from "../archetype/helpers";

export interface CommandProcessorContext {
  sparseStore: SparseStore;
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

    // For sparse relations, ensure wildcard marker is in archetype signature
    if (isSparseComponent(componentId)) {
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
  // Sparse exclusive (the common ChildOf path): only touch that component's store entry.
  // Avoids getAllForEntity + intermediate Map allocation.
  if (isSparseComponent(baseComponentId)) {
    archetype.forEachSparseRelationTypeOfComponent(entityId, baseComponentId, (componentType) => {
      changeset.delete(componentType);
    });
    return;
  }

  // Dense (non-sparse) exclusive relations live in the archetype signature.
  for (const componentType of archetype.componentTypes) {
    // Skip wildcard markers - they should only be removed by maybeRemoveWildcardMarker
    if (isWildcardRelationId(componentType)) continue;

    if (getComponentIdFromRelationId(componentType) === baseComponentId) {
      changeset.delete(componentType);
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

  // If removing sparse relations, also remove the wildcard marker
  if (isSparseComponent(baseComponentId)) {
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
  if (componentId === undefined || !isSparseComponent(componentId)) {
    return;
  }

  // Fast path for exclusive sparse flips: if the same batch is adding a replacement
  // of the same component kind, the marker must stay. Check adds first (tiny Map).
  for (const addedType of changeset.adds.keys()) {
    if (addedType === removedComponentType) continue;
    if (getComponentIdFromRelationId(addedType) === componentId) {
      return;
    }
  }

  // Also keep the marker if another sparse relation of this kind remains on the entity
  // (and is not itself scheduled for removal in this changeset).
  let keepMarker = false;
  archetype.forEachSparseRelationTypeOfComponent(entityId, componentId, (otherComponentType) => {
    if (keepMarker) return;
    if (otherComponentType === removedComponentType) return;
    if (changeset.removes.has(otherComponentType)) return;
    keepMarker = true;
  });
  if (keepMarker) return;

  changeset.delete(relation(componentId, "*"));
}

function hasEntityComponent(archetype: Archetype, entityId: EntityId, componentType: EntityId<any>): boolean {
  if (archetype.componentTypeSet.has(componentType)) {
    return true;
  }

  return archetype.getEntitySparseRelations(entityId)?.has(componentType) ?? false;
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
    if (!isSparseRelation(componentType) && currentArchetype.componentTypeSet.has(componentType)) {
      return true;
    }
  }

  for (const componentType of changeset.adds.keys()) {
    if (!isSparseRelation(componentType) && !currentArchetype.componentTypeSet.has(componentType)) {
      return true;
    }
  }

  return false;
}

function buildFinalRegularComponentTypes(currentArchetype: Archetype, changeset: ComponentChangeset): EntityId<any>[] {
  const finalRegularTypes = new Set(currentArchetype.componentTypes);

  for (const componentType of changeset.removes) {
    if (!isSparseRelation(componentType)) {
      finalRegularTypes.delete(componentType);
    }
  }

  for (const [componentType] of changeset.adds) {
    if (!isSparseRelation(componentType)) {
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
    // Column-to-column move: no intermediate Map, surviving sparse edges stay put.
    currentArchetype.migrateEntityTo(newArchetype, entityId, changeset.adds, changeset.removes, removedComponents);
    entityToArchetype.set(entityId, newArchetype);
    return newArchetype;
  }

  // No archetype move needed: only component payload updates and/or sparse relation updates.
  if (removedComponents !== null) {
    applySparseChanges(ctx.sparseStore, entityId, changeset, removedComponents);
  } else {
    applySparseChangesNoHooks(ctx.sparseStore, entityId, changeset);
  }

  // Direct update for regular components in archetype
  for (const [componentType, component] of changeset.adds) {
    if (isSparseRelation(componentType)) {
      continue;
    }
    currentArchetype.set(entityId, componentType, component);
  }

  return currentArchetype;
}

function applySparseChanges(
  sparseStore: SparseStore,
  entityId: EntityId,
  changeset: ComponentChangeset,
  removedComponents: Map<EntityId<any>, any>,
): void {
  for (const componentType of changeset.removes) {
    if (isSparseRelation(componentType)) {
      // hasValue is independent of payload (void tags store undefined).
      if (sparseStore.hasValue(entityId, componentType)) {
        removedComponents.set(componentType, sparseStore.getValue(entityId, componentType));
      }
      sparseStore.deleteValue(entityId, componentType);
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isSparseRelation(componentType)) {
      sparseStore.setValue(entityId, componentType, component);
    }
  }
}

function applySparseChangesNoHooks(sparseStore: SparseStore, entityId: EntityId, changeset: ComponentChangeset): void {
  for (const componentType of changeset.removes) {
    if (isSparseRelation(componentType)) {
      sparseStore.deleteValue(entityId, componentType);
    }
  }

  for (const [componentType, component] of changeset.adds) {
    if (isSparseRelation(componentType)) {
      sparseStore.setValue(entityId, componentType, component);
    }
  }
}
