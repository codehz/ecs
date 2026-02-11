import type { ComponentChangeset } from "../commands/changeset";
import type { Command } from "../commands/command-buffer";
import type { Archetype } from "./archetype";
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
  const entityData = archetype.getEntity(entityId);
  if (entityData) {
    for (const [componentType] of entityData) {
      if (archetype.componentTypeSet.has(componentType)) continue;
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
  const entityData = archetype.getEntity(entityId);
  if (!entityData) {
    changeset.delete(wildcardMarker);
    return;
  }

  // Check if there are any other relations with the same component ID
  for (const [otherComponentType] of entityData) {
    if (otherComponentType === removedComponentType) continue;
    if (otherComponentType === wildcardMarker) continue;
    if (changeset.removes.has(otherComponentType)) continue;

    if (getComponentIdFromRelationId(otherComponentType) === componentId) {
      return; // Found another relation, keep the marker
    }
  }

  changeset.delete(wildcardMarker);
}

export function applyChangeset(
  ctx: CommandProcessorContext,
  entityId: EntityId,
  currentArchetype: Archetype,
  changeset: ComponentChangeset,
  entityToArchetype: Map<EntityId, Archetype>,
): { removedComponents: Map<EntityId<any>, any>; newArchetype: Archetype } {
  const currentEntityData = currentArchetype.getEntity(entityId);
  const allCurrentComponentTypes = currentEntityData
    ? Array.from(currentEntityData.keys())
    : currentArchetype.componentTypes;

  const finalComponentTypes = changeset.getFinalComponentTypes(allCurrentComponentTypes);
  const removedComponents = new Map<EntityId<any>, any>();

  if (finalComponentTypes) {
    // Check if archetype-affecting components actually changed
    // (dontFragment components don't affect archetype signature)
    const currentRegularTypes = filterRegularComponentTypes(allCurrentComponentTypes);
    const finalRegularTypes = filterRegularComponentTypes(finalComponentTypes);
    const archetypeChanged = !areComponentTypesEqual(currentRegularTypes, finalRegularTypes);

    if (archetypeChanged) {
      // Move to new archetype (regular components changed)
      const newArchetype = moveEntityToNewArchetype(
        ctx,
        entityId,
        currentArchetype,
        finalComponentTypes,
        changeset,
        removedComponents,
        entityToArchetype,
      );
      return { removedComponents, newArchetype };
    } else {
      // Only dontFragment components changed, stay in same archetype
      updateEntityInSameArchetype(ctx, entityId, currentArchetype, changeset, removedComponents);
    }
  } else {
    // Update in same archetype
    updateEntityInSameArchetype(ctx, entityId, currentArchetype, changeset, removedComponents);
  }

  return { removedComponents, newArchetype: currentArchetype };
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
  const sorted1 = [...types1].sort((a, b) => a - b);
  const sorted2 = [...types2].sort((a, b) => a - b);
  return sorted1.every((v, i) => v === sorted2[i]);
}
