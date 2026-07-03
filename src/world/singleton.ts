import type { ComponentId } from "../entity";

export interface SingletonHandleOps<T> {
  has(): boolean;
  get(): T;
  getOptional(): { value: T } | undefined;
  remove(): void;
  set(value: T | undefined): void;
}

/**
 * Explicit handle for a singleton component (component-as-entity).
 *
 * This is the preferred API for singleton components.
 * `world.set(componentId, value)` remains available only as a deprecated
 * compatibility shorthand.
 *
 * @example
 * const config = world.singleton(Config);
 * config.set({ debug: true });
 * world.sync();
 * console.log(config.get());
 */
export class SingletonHandle<T = void> {
  readonly componentId: ComponentId<T>;
  private readonly ops: SingletonHandleOps<T>;

  constructor(componentId: ComponentId<T>, ops: SingletonHandleOps<T>) {
    this.componentId = componentId;
    this.ops = ops;
  }

  has(): boolean {
    return this.ops.has();
  }

  get(): T {
    return this.ops.get();
  }

  getOptional(): { value: T } | undefined {
    return this.ops.getOptional();
  }

  remove(): void {
    this.ops.remove();
  }

  set(...args: T extends void ? [] : [value: NoInfer<T>]): void {
    this.ops.set(args[0] as T | undefined);
  }
}
