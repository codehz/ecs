import type { World } from "./world";

/**
 * Base System interface
 */
export interface System<ExtraParams extends any[] = [deltaTime: number]> {
  /**
   * Update the system
   */
  update(world: World<ExtraParams>, ...params: ExtraParams): void;

  /**
   * Dependencies of this system (systems that must run before this one)
   */
  readonly dependencies?: readonly System<ExtraParams>[];
}
