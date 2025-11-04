import type { World } from "./world";

/**
 * Base System interface
 */
export interface System<ExtraParams extends any[] = [deltaTime: number]> {
  /**
   * Update the system
   */
  update(world: World<ExtraParams>, ...params: ExtraParams): void;
}
