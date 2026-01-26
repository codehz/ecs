import { MISSING_COMPONENT } from "./archetype";
import type { ComponentId, EntityId, WildcardRelationId } from "./entity";
import { getComponentIdFromRelationId, getDetailedIdType, getIdType, getTargetIdFromRelationId } from "./entity";
import { isOptionalEntityId, type ComponentType } from "./types";

type DetailedIdType = ReturnType<typeof getDetailedIdType>;

type RelationDetailedType =
  | { type: "entity-relation"; componentId: ComponentId<any>; targetId: EntityId<any> }
  | { type: "component-relation"; componentId: ComponentId<any>; targetId: ComponentId<any> };

/**
 * Check if a detailed type represents a relation (entity or component)
 */
export function isRelationType(detailedType: DetailedIdType): detailedType is RelationDetailedType {
  return detailedType.type === "entity-relation" || detailedType.type === "component-relation";
}

/**
 * Check if a component type matches a given component ID for relations
 */
export function matchesRelationComponentId(componentType: EntityId<any>, componentId: EntityId<any>): boolean {
  const detailedType = getDetailedIdType(componentType);
  return isRelationType(detailedType) && detailedType.componentId === componentId;
}

/**
 * Find all relations in dontFragment data that match a component ID
 */
export function findMatchingDontFragmentRelations(
  dontFragmentData: Map<EntityId<any>, any> | undefined,
  componentId: EntityId<any>,
): [EntityId<unknown>, any][] {
  const relations: [EntityId<unknown>, any][] = [];
  if (!dontFragmentData) return relations;

  for (const [relType, data] of dontFragmentData) {
    const relDetailed = getDetailedIdType(relType);
    if (isRelationType(relDetailed) && relDetailed.componentId === componentId) {
      relations.push([relDetailed.targetId, data]);
    }
  }
  return relations;
}

/**
 * Build cache key for component types
 */
export function buildCacheKey(componentTypes: readonly ComponentType<any>[]): string {
  return componentTypes.map((id) => (isOptionalEntityId(id) ? `opt(${id.optional})` : `${id}`)).join(",");
}

/**
 * Get data source for wildcard relations from component types
 */
export function getWildcardRelationDataSource(
  componentTypes: EntityId<any>[],
  componentId: EntityId<any>,
  optional: boolean,
): EntityId<any>[] | undefined {
  const matchingRelations = componentTypes.filter((ct) => matchesRelationComponentId(ct, componentId));
  return optional ? (matchingRelations.length > 0 ? matchingRelations : undefined) : matchingRelations;
}

/**
 * Build wildcard relation value from matching relations
 */
export function buildWildcardRelationValue(
  wildcardRelationType: WildcardRelationId<any>,
  matchingRelations: EntityId<any>[] | undefined,
  getDataAtIndex: (relType: EntityId<any>) => any,
  dontFragmentData: Map<EntityId<any>, any> | undefined,
  entityId: EntityId,
  optional: boolean,
): any {
  const relations: [EntityId<unknown>, any][] = [];
  const targetComponentId = getComponentIdFromRelationId(wildcardRelationType);

  // Add regular archetype relations
  for (const relType of matchingRelations || []) {
    const data = getDataAtIndex(relType);
    const targetId = getTargetIdFromRelationId(relType)!;
    relations.push([targetId, data === MISSING_COMPONENT ? undefined : data]);
  }

  // Add dontFragment relations
  if (targetComponentId !== undefined) {
    relations.push(...findMatchingDontFragmentRelations(dontFragmentData, targetComponentId));
  }

  if (relations.length === 0) {
    if (!optional) {
      const componentId = getComponentIdFromRelationId(wildcardRelationType);
      throw new Error(
        `No matching relations found for mandatory wildcard relation component ${componentId} on entity ${entityId}`,
      );
    }
    return undefined;
  }

  return optional ? { value: relations } : relations;
}

/**
 * Build regular component value from data source
 */
export function buildRegularComponentValue(dataSource: any[] | undefined, entityIndex: number, optional: boolean): any {
  if (dataSource === undefined) {
    if (optional) return undefined;
    throw new Error(`Component data not found for mandatory component type`);
  }

  const data = dataSource[entityIndex];
  const result = data === MISSING_COMPONENT ? undefined : data;
  return optional ? { value: result } : result;
}

/**
 * Build a single component value based on its type
 */
export function buildSingleComponent(
  compType: ComponentType<any>,
  dataSource: any[] | EntityId<any>[] | undefined,
  entityIndex: number,
  entityId: EntityId,
  getComponentData: (type: EntityId<any>) => any[],
  dontFragmentRelations: Map<EntityId, Map<EntityId<any>, any>>,
): any {
  const optional = isOptionalEntityId(compType);
  const actualType = optional ? compType.optional : compType;

  if (getIdType(actualType) === "wildcard-relation") {
    return buildWildcardRelationValue(
      actualType as WildcardRelationId<any>,
      dataSource as EntityId<any>[] | undefined,
      (relType) => getComponentData(relType)[entityIndex],
      dontFragmentRelations.get(entityId),
      entityId,
      optional,
    );
  } else {
    return buildRegularComponentValue(dataSource as any[] | undefined, entityIndex, optional);
  }
}
