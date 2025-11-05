import type { World } from "./world";

/**
 * Base System interface
 */
export interface System<ExtraParams extends any[] = []> {
  /**
   * Update the system
   */
  update(...params: ExtraParams): void;

  /**
   * Dependencies of this system (systems that must run before this one)
   */
  readonly dependencies?: readonly System<ExtraParams>[];
}
