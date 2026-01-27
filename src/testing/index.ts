/**
 * @module testing
 * Testing utilities for ECS-based game logic
 *
 * This module provides framework-agnostic testing helpers that work with
 * bun:test, vitest, jest, or any other testing framework.
 *
 * @example
 * ```typescript
 * import { describe, expect, it } from "bun:test";
 * import { component } from "@codehz/ecs";
 * import { WorldFixture, EntityBuilder, Assertions } from "@codehz/ecs/testing";
 *
 * const PositionId = component<{ x: number; y: number }>();
 * const VelocityId = component<{ x: number; y: number }>();
 *
 * describe("Movement System", () => {
 *   it("should update position based on velocity", () => {
 *     const fixture = new WorldFixture();
 *     const entity = fixture
 *       .spawn()
 *       .with(PositionId, { x: 0, y: 0 })
 *       .with(VelocityId, { x: 1, y: 2 })
 *       .build();
 *
 *     // Run your game logic here
 *     movementSystem(fixture.world, 1.0);
 *
 *     expect(Assertions.hasComponent(fixture.world, entity, PositionId)).toBe(true);
 *     expect(Assertions.getComponent(fixture.world, entity, PositionId)).toEqual({ x: 1, y: 2 });
 *   });
 * });
 * ```
 */

import type { ComponentId, EntityId, WildcardRelationId } from "../core/entity";
import { isWildcardRelationId, relation } from "../core/entity";
import { World } from "../core/world";
import type { Query } from "../query/query";
export { EntityBuilder } from "../core/builder";
export type { ComponentDef } from "../core/builder";

// =============================================================================
// Types
// =============================================================================

/**
 * A component definition for entity building, supporting both regular components and relations
 */
import type { EntityBuilder } from "../core/builder";

/**
 * Snapshot of a single entity's component state
 */
export interface EntitySnapshot {
  entity: EntityId;
  components: Map<EntityId<any>, unknown>;
}

/**
 * Snapshot of multiple entities' component state
 */
export interface WorldSnapshot {
  entities: EntitySnapshot[];
}

/**
 * Result of comparing two snapshots
 */
export interface SnapshotDiff {
  /** Entities that exist in 'after' but not in 'before' */
  addedEntities: EntityId[];
  /** Entities that exist in 'before' but not in 'after' */
  removedEntities: EntityId[];
  /** Changes to components on existing entities */
  componentChanges: Array<{
    entity: EntityId;
    componentId: EntityId<any>;
    before: unknown | undefined;
    after: unknown | undefined;
    changeType: "added" | "removed" | "modified";
  }>;
}

// =============================================================================
// WorldFixture - Test World Factory
// =============================================================================

/**
 * A test fixture that manages a World instance and provides convenient
 * methods for setting up test scenarios.
 *
 * @example
 * ```typescript
 * const fixture = new WorldFixture();
 *
 * // Spawn entities with fluent API
 * const player = fixture
 *   .spawn()
 *   .with(PositionId, { x: 0, y: 0 })
 *   .with(HealthId, { current: 100, max: 100 })
 *   .build();
 *
 * // Access the world for running systems
 * movementSystem(fixture.world);
 *
 * // Clean up (optional - creates a fresh world)
 * fixture.reset();
 * ```
 */
export class WorldFixture {
  private _world: World;
  private _queries: Query[] = [];

  constructor() {
    this._world = new World();
  }

  /**
   * Get the underlying World instance
   */
  get world(): World {
    return this._world;
  }

  /**
   * Create a new EntityBuilder for spawning an entity with components
   */
  spawn(): EntityBuilder {
    return this._world.spawn();
  }

  /**
   * Spawn multiple entities with the same component configuration
   * @param count Number of entities to spawn
   * @param configure Function to configure each entity builder
   * @returns Array of created entity IDs
   */
  spawnMany(count: number, configure: (builder: EntityBuilder, index: number) => EntityBuilder): EntityId[] {
    return this._world.spawnMany(count, configure);
  }

  /**
   * Create a query and track it for automatic cleanup
   * @param componentTypes Component types to query for
   * @returns Query instance
   */
  createQuery(componentTypes: EntityId<any>[]): Query {
    const query = this._world.createQuery(componentTypes);
    this._queries.push(query);
    return query;
  }

  /**
   * Execute pending commands (alias for world.sync())
   */
  sync(): void {
    this._world.sync();
  }

  /**
   * Reset the fixture with a fresh World instance
   * Disposes all tracked queries
   */
  reset(): void {
    for (const query of this._queries) {
      query.dispose();
    }
    this._queries = [];
    this._world = new World();
  }

  /**
   * Capture a snapshot of specified entities and their components
   * @param entities Entities to capture
   * @param componentIds Components to include in the snapshot
   */
  captureSnapshot(entities: EntityId[], componentIds: EntityId<any>[]): WorldSnapshot {
    return Snapshot.capture(this._world, entities, componentIds);
  }

  /**
   * Symbol.dispose implementation for automatic resource management
   */
  [Symbol.dispose](): void {
    this.reset();
  }
}

// =============================================================================
// EntityBuilder - Fluent Entity Creation
// =============================================================================

/**
 * Fluent builder for creating entities with components.
 * Supports both regular components and entity relations.
 *
 * @example
 * ```typescript
 * // Basic usage
 * // Note: build() will enqueue component commands but will NOT call world.sync().
 * // You must call world.sync() or fixture.sync() manually to apply commands.
 * const entity = new EntityBuilder(world)
 *   .with(PositionId, { x: 10, y: 20 })
 *   .with(VelocityId, { x: 1, y: 0 })
 *   .build();
 *   // Apply pending changes
 *   world.sync();
 *
 * // With relations
 * const child = new EntityBuilder(world)
 *   .with(PositionId, { x: 0, y: 0 })
 *   .withRelation(ParentId, parentEntity, { offset: { x: 5, y: 5 } })
 *   .build();
 *   world.sync();
 *
 * // Tag component (void type)
 * const tagged = new EntityBuilder(world)
 *   .withTag(PlayerTagId)
 *   .build();
 * ```
 */
// EntityBuilder is exported from world.ts; testing utilities will use world.spawn()

// =============================================================================
// Assertions - Test Assertion Helpers
// =============================================================================

/**
 * Test assertion utilities that return boolean values or throw descriptive errors.
 * These work with any testing framework's expect() function.
 *
 * @example
 * ```typescript
 * // With bun:test or vitest
 * expect(Assertions.hasComponent(world, entity, PositionId)).toBe(true);
 * expect(Assertions.getComponent(world, entity, PositionId)).toEqual({ x: 10, y: 20 });
 *
 * // Direct assertion (throws on failure)
 * Assertions.assertHasComponent(world, entity, PositionId);
 * Assertions.assertComponentEquals(world, entity, PositionId, { x: 10, y: 20 });
 * ```
 */
export const Assertions = {
  /**
   * Check if an entity has a specific component
   */
  hasComponent<T>(world: World, entity: EntityId, componentId: EntityId<T>): boolean {
    return world.exists(entity) && world.has(entity, componentId);
  },

  /**
   * Check if an entity does not have a specific component
   */
  lacksComponent<T>(world: World, entity: EntityId, componentId: EntityId<T>): boolean {
    return !world.exists(entity) || !world.has(entity, componentId);
  },

  /**
   * Get a component value (returns undefined if entity doesn't exist or doesn't have the component)
   */
  getComponent<T>(world: World, entity: EntityId, componentId: EntityId<T>): T | undefined {
    if (!world.exists(entity) || !world.has(entity, componentId)) {
      return undefined;
    }
    return world.get(entity, componentId);
  },

  /**
   * Get all relation instances for a wildcard relation
   */
  getRelations<T>(world: World, entity: EntityId, componentId: ComponentId<T>): [EntityId<unknown>, T][] | undefined {
    if (!world.exists(entity)) {
      return undefined;
    }
    const wildcardId = relation(componentId, "*");
    try {
      return world.get(entity, wildcardId);
    } catch {
      return [];
    }
  },

  /**
   * Check if an entity has a relation to a specific target
   */
  hasRelation<T>(world: World, entity: EntityId, componentId: ComponentId<T>, targetEntity: EntityId<any>): boolean {
    if (!world.exists(entity)) {
      return false;
    }
    const relationId = relation(componentId, targetEntity);
    return world.has(entity, relationId);
  },

  /**
   * Check if an entity exists in the world
   */
  entityExists(world: World, entity: EntityId): boolean {
    return world.exists(entity);
  },

  /**
   * Check if a query contains specific entities
   */
  queryContains(query: Query, ...entities: EntityId[]): boolean {
    const queryEntities = query.getEntities();
    return entities.every((e) => queryEntities.includes(e));
  },

  /**
   * Check if a query contains exactly the specified entities (no more, no less)
   */
  queryContainsExactly(query: Query, ...entities: EntityId[]): boolean {
    const queryEntities = query.getEntities();
    if (queryEntities.length !== entities.length) {
      return false;
    }
    return entities.every((e) => queryEntities.includes(e));
  },

  /**
   * Get the count of entities in a query
   */
  queryCount(query: Query): number {
    return query.getEntities().length;
  },

  // === Throwing assertions ===

  /**
   * Assert that an entity has a component (throws if not)
   */
  assertHasComponent<T>(world: World, entity: EntityId, componentId: EntityId<T>): void {
    if (!world.exists(entity)) {
      throw new AssertionError(`Entity ${entity} does not exist`);
    }
    if (!world.has(entity, componentId)) {
      throw new AssertionError(`Entity ${entity} does not have component ${componentId}`);
    }
  },

  /**
   * Assert that an entity lacks a component (throws if it has the component)
   */
  assertLacksComponent<T>(world: World, entity: EntityId, componentId: EntityId<T>): void {
    if (world.exists(entity) && world.has(entity, componentId)) {
      throw new AssertionError(`Entity ${entity} unexpectedly has component ${componentId}`);
    }
  },

  /**
   * Assert that a component equals an expected value (throws if not)
   */
  assertComponentEquals<T>(world: World, entity: EntityId, componentId: EntityId<T>, expected: T): void {
    this.assertHasComponent(world, entity, componentId);
    const actual = world.get(entity, componentId);
    if (!deepEquals(actual, expected)) {
      throw new AssertionError(
        `Component ${componentId} on entity ${entity} does not match expected value.\n` +
          `Expected: ${JSON.stringify(expected)}\n` +
          `Actual: ${JSON.stringify(actual)}`,
      );
    }
  },

  /**
   * Assert that an entity exists (throws if not)
   */
  assertEntityExists(world: World, entity: EntityId): void {
    if (!world.exists(entity)) {
      throw new AssertionError(`Entity ${entity} does not exist`);
    }
  },

  /**
   * Assert that an entity does not exist (throws if it exists)
   */
  assertEntityNotExists(world: World, entity: EntityId): void {
    if (world.exists(entity)) {
      throw new AssertionError(`Entity ${entity} unexpectedly exists`);
    }
  },

  /**
   * Assert that a query contains specific entities (throws if not)
   */
  assertQueryContains(query: Query, ...entities: EntityId[]): void {
    const queryEntities = query.getEntities();
    for (const entity of entities) {
      if (!queryEntities.includes(entity)) {
        throw new AssertionError(
          `Query does not contain entity ${entity}.\n` + `Query entities: [${queryEntities.join(", ")}]`,
        );
      }
    }
  },

  /**
   * Assert that a query does not contain specific entities (throws if it does)
   */
  assertQueryNotContains(query: Query, ...entities: EntityId[]): void {
    const queryEntities = query.getEntities();
    for (const entity of entities) {
      if (queryEntities.includes(entity)) {
        throw new AssertionError(
          `Query unexpectedly contains entity ${entity}.\n` + `Query entities: [${queryEntities.join(", ")}]`,
        );
      }
    }
  },
};

// =============================================================================
// Snapshot - State Capture and Comparison
// =============================================================================

/**
 * Utilities for capturing and comparing world state snapshots.
 * Useful for testing that systems produce expected state changes.
 *
 * @example
 * ```typescript
 * const before = Snapshot.capture(world, [entity], [PositionId, VelocityId]);
 *
 * // Run game logic
 * movementSystem(world, deltaTime);
 * world.sync();
 *
 * const after = Snapshot.capture(world, [entity], [PositionId, VelocityId]);
 * const diff = Snapshot.compare(before, after);
 *
 * expect(diff.componentChanges).toHaveLength(1);
 * expect(diff.componentChanges[0].changeType).toBe("modified");
 * ```
 */
export const Snapshot = {
  /**
   * Capture a snapshot of specified entities and their components
   * @param world The world to capture from
   * @param entities Entities to include in the snapshot
   * @param componentIds Components to capture for each entity
   */
  capture(world: World, entities: EntityId[], componentIds: EntityId<any>[]): WorldSnapshot {
    const entitySnapshots: EntitySnapshot[] = [];

    for (const entity of entities) {
      if (!world.exists(entity)) {
        continue;
      }

      const components = new Map<EntityId<any>, unknown>();

      for (const componentId of componentIds) {
        if (isWildcardRelationId(componentId)) {
          // For wildcard relations, capture all relation instances
          try {
            const relations = world.get(entity, componentId as WildcardRelationId<any>);
            if (relations && relations.length > 0) {
              components.set(componentId, deepClone(relations));
            }
          } catch {
            // Entity doesn't have this relation type
          }
        } else if (world.has(entity, componentId)) {
          components.set(componentId, deepClone(world.get(entity, componentId)));
        }
      }

      entitySnapshots.push({ entity, components });
    }

    return { entities: entitySnapshots };
  },

  /**
   * Compare two snapshots and return the differences
   * @param before The 'before' snapshot
   * @param after The 'after' snapshot
   */
  compare(before: WorldSnapshot, after: WorldSnapshot): SnapshotDiff {
    const beforeEntities = new Set(before.entities.map((e) => e.entity));
    const afterEntities = new Set(after.entities.map((e) => e.entity));

    const addedEntities: EntityId[] = [];
    const removedEntities: EntityId[] = [];
    const componentChanges: SnapshotDiff["componentChanges"] = [];

    // Find added entities
    for (const entity of afterEntities) {
      if (!beforeEntities.has(entity)) {
        addedEntities.push(entity);
      }
    }

    // Find removed entities
    for (const entity of beforeEntities) {
      if (!afterEntities.has(entity)) {
        removedEntities.push(entity);
      }
    }

    // Find component changes on existing entities
    const beforeMap = new Map(before.entities.map((e) => [e.entity, e]));
    const afterMap = new Map(after.entities.map((e) => [e.entity, e]));

    for (const entity of beforeEntities) {
      if (!afterEntities.has(entity)) continue; // Skip removed entities

      const beforeEntity = beforeMap.get(entity)!;
      const afterEntity = afterMap.get(entity)!;

      // Check for component changes
      const allComponentIds = new Set([...beforeEntity.components.keys(), ...afterEntity.components.keys()]);

      for (const componentId of allComponentIds) {
        const beforeValue = beforeEntity.components.get(componentId);
        const afterValue = afterEntity.components.get(componentId);

        if (beforeValue === undefined && afterValue !== undefined) {
          componentChanges.push({
            entity,
            componentId,
            before: undefined,
            after: afterValue,
            changeType: "added",
          });
        } else if (beforeValue !== undefined && afterValue === undefined) {
          componentChanges.push({
            entity,
            componentId,
            before: beforeValue,
            after: undefined,
            changeType: "removed",
          });
        } else if (!deepEquals(beforeValue, afterValue)) {
          componentChanges.push({
            entity,
            componentId,
            before: beforeValue,
            after: afterValue,
            changeType: "modified",
          });
        }
      }
    }

    return { addedEntities, removedEntities, componentChanges };
  },

  /**
   * Check if two snapshots are equal
   */
  equals(a: WorldSnapshot, b: WorldSnapshot): boolean {
    const diff = this.compare(a, b);
    return diff.addedEntities.length === 0 && diff.removedEntities.length === 0 && diff.componentChanges.length === 0;
  },
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Custom assertion error for testing utilities
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Deep equality check for comparing component values
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepEquals(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Deep clone a value for snapshot isolation
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepClone) as T;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return result as T;
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

export { component, relation } from "../core/entity";
export type { ComponentId, EntityId, RelationId, WildcardRelationId } from "../core/entity";
export type { LifecycleCallback, LifecycleHook, MultiLifecycleCallback, MultiLifecycleHook } from "../core/types";
export { World } from "../core/world";
export type { Query } from "../query/query";
