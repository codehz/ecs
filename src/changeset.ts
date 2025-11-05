import type { EntityId } from "./entity";

/**
 * @internal Represents a set of component changes to be applied to an entity
 */
export class ComponentChangeset {
  readonly adds = new Map<EntityId<any>, any>();
  readonly removes = new Set<EntityId<any>>();

  /**
   * Add a component to the changeset
   */
  addComponent<T>(componentType: EntityId<T>, component: T): void {
    this.adds.set(componentType, component);
    this.removes.delete(componentType); // Remove from removes if it was going to be removed
  }

  /**
   * Remove a component from the changeset
   */
  removeComponent<T>(componentType: EntityId<T>): void {
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
   * Apply the changeset to existing components and return the final state
   */
  applyTo(existingComponents: Map<EntityId<any>, any>): Map<EntityId<any>, any> {
    const finalComponents = new Map(existingComponents);

    // Apply removals
    for (const componentType of this.removes) {
      finalComponents.delete(componentType);
    }

    // Apply additions/updates
    for (const [componentType, component] of this.adds) {
      finalComponents.set(componentType, component);
    }

    return finalComponents;
  }

  /**
   * Get the final component types after applying changes
   */
  getFinalComponentTypes(existingComponents: Map<EntityId<any>, any>): EntityId<any>[] {
    const finalComponents = this.applyTo(existingComponents);
    return Array.from(finalComponents.keys()).sort((a, b) => a - b);
  }
}
