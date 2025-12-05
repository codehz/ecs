/**
 * Base System interface
 */
export interface System<UpdateParams extends any[] = []> {
  /**
   * Update the system
   */
  update(...params: UpdateParams): void | Promise<void>;

  /**
   * Dependencies of this system (systems that must run before this one)
   */
  readonly dependencies?: readonly System<UpdateParams>[];
}
