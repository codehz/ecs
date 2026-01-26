import type { EntityId } from "../core/entity";

/**
 * @internal Represents a set of component changes to be applied to an entity
 */
export class ComponentChangeset {
  readonly adds = new Map<EntityId<any>, any>();
  readonly removes = new Set<EntityId<any>>();

  /**
   * Add a component to the changeset
   */
  set<T>(componentType: EntityId<T>, component: T): void {
    this.adds.set(componentType, component);
    this.removes.delete(componentType); // Remove from removes if it was going to be removed
  }

  /**
   * Remove a component from the changeset
   */
  delete<T>(componentType: EntityId<T>): void {
    this.removes.add(componentType);
    this.adds.delete(componentType); // Remove from adds if it was going to be added
  }

  /**
   * Check if the changeset has any changes
   */
  hasChanges(): boolean {
    return this.adds.size > 0 || this.removes.size > 0;
  }

  /**
   * Clear all changes
   */
  clear(): void {
    this.adds.clear();
    this.removes.clear();
  }

  /**
   * Merge another changeset into this one
   */
  merge(other: ComponentChangeset): void {
    // Merge additions
    for (const [componentType, component] of other.adds) {
      this.adds.set(componentType, component);
      this.removes.delete(componentType);
    }
    // Merge removals
    for (const componentType of other.removes) {
      this.removes.add(componentType);
      this.adds.delete(componentType);
    }
  }

  /**
   * Apply the changeset to existing components and return the final state
   */
  applyTo(existingComponents: Map<EntityId<any>, any>): Map<EntityId<any>, any> {
    // Apply removals
    for (const componentType of this.removes) {
      existingComponents.delete(componentType);
    }

    // Apply additions/updates
    for (const [componentType, component] of this.adds) {
      existingComponents.set(componentType, component);
    }

    return existingComponents;
  }

  /**
   * Get the final component types after applying the changeset
   * @param existingComponentTypes - The current component types on the entity
   * @returns The final component types or undefined if no changes
   */
  getFinalComponentTypes(existingComponentTypes: EntityId<any>[]): EntityId<any>[] | undefined {
    const finalComponentTypes = new Set<EntityId<any>>(existingComponentTypes);
    let changed = false;

    // Apply removals
    for (const componentType of this.removes) {
      if (!finalComponentTypes.has(componentType)) {
        this.removes.delete(componentType);
        continue; // Component not present, skip
      }
      changed = true;
      finalComponentTypes.delete(componentType);
    }

    // Apply additions
    for (const componentType of this.adds.keys()) {
      if (finalComponentTypes.has(componentType)) {
        continue; // Component already present, skip
      }
      changed = true;
      finalComponentTypes.add(componentType);
    }

    return changed ? Array.from(finalComponentTypes) : undefined;
  }
}
