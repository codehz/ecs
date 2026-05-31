import type { Archetype } from "../archetype/archetype";
import type { SparseStore } from "../archetype/store";
import type { Command } from "../commands/buffer";
import { ComponentChangeset } from "../commands/changeset";
import type { ComponentEntityStore } from "../component/entity-store";
import {
  getComponentIdFromRelationId,
  getTargetIdFromRelationId,
  isEntityRelation,
  isExclusiveComponent,
  type EntityId,
} from "../entity";
import type { LifecycleHookEntry } from "../types";
import {
  applyChangeset,
  maybeRemoveWildcardMarker,
  processCommands,
  removeMatchingRelations,
  type CommandProcessorContext,
} from "./commands";
import type { triggerLifecycleHooks } from "./hooks";
import { type HooksContext } from "./hooks";
import { trackEntityReference, untrackEntityReference, type EntityReferencesMap } from "./references";

/**
 * Dependencies provided by World to the CommandExecutor.
 * Keeps the executor decoupled while allowing efficient hot-path access
 * (maps passed by reference where hot code already expects them).
 */
export interface CommandExecutorContext {
  /** For component-entity (singleton) fast path in execute */
  componentEntities: ComponentEntityStore;

  /** Reverse reference index for cascades and entity-valued components */
  entityReferences: EntityReferencesMap;

  /** For the no-hooks fast path guard */
  hooks: Set<LifecycleHookEntry>;

  /** Direct map access (hot path in applyChangeset and various places) */
  entityToArchetype: Map<EntityId, Archetype>;

  /** Archetype creation/lookup (passed through CommandProcessorContext) */
  ensureArchetype: (componentTypes: Iterable<EntityId<any>>) => Archetype;

  /** Sparse store (needed for CommandProcessorContext) */
  sparseStore: SparseStore;

  /** Factories for the HooksContext (used by triggerLifecycleHooks) */
  has: (entityId: EntityId, componentType: EntityId<any>) => boolean;
  get: <T>(entityId: EntityId, componentType: EntityId<T>) => T;
  getOptional: <T>(entityId: EntityId, componentType: EntityId<T>) => { value: T } | undefined;

  /** Destroy fast-path delegation (BFS + cascade logic stays in World) */
  destroyEntityImmediate: (entityId: EntityId) => void;

  /** Debug migration counter (now routed through DebugStatsManager) */
  incrementMigrations: () => void;

  /** Hook triggering (the function from hooks.ts) */
  triggerLifecycleHooks: typeof triggerLifecycleHooks;

  /** Remove hook fast path for full entity deletion (used by destroy paths in World) */
  triggerRemoveHooksForEntityDeletion: (
    entityId: EntityId,
    removedComponents: Map<EntityId<any>, any>,
    oldArchetype: Archetype,
  ) => void;
}

/**
 * Encapsulates the command execution pipeline, reusable changesets,
 * and related orchestration that was previously private methods + fields on World.
 *
 * Responsibilities:
 * - executeEntityCommands (routing for singletons / destroy / structural changes)
 * - applyEntityCommands (changeset processing + exclusive relations + apply + refs + hooks)
 * - removeComponentImmediate (used by cascade deletion)
 * - updateEntityReferences (keeps the reverse index in sync)
 *
 * This extraction significantly reduces World line count while preserving
 * every fast-path branch and allocation-avoidance characteristic.
 */
export class CommandExecutor {
  private readonly _changeset = new ComponentChangeset();
  private readonly _removeChangeset = new ComponentChangeset();

  private readonly _commandCtx: CommandProcessorContext;
  private readonly _hooksCtx: HooksContext;

  constructor(private readonly ctx: CommandExecutorContext) {
    this._commandCtx = {
      sparseStore: ctx.sparseStore,
      ensureArchetype: ctx.ensureArchetype,
    };

    this._hooksCtx = {
      multiHooks: ctx.hooks,
      has: ctx.has,
      get: ctx.get,
      getOptional: ctx.getOptional,
    };
  }

  /**
   * Entry point used by the CommandBuffer.
   * Routes to singleton handling, destroy fast path, or structural apply.
   */
  executeEntityCommands(entityId: EntityId, commands: Command[]): void {
    this._changeset.clear();

    // 1. Route: component entities use flat-map storage
    if (this.ctx.componentEntities.exists(entityId)) {
      this.ctx.componentEntities.executeCommands(entityId, commands);
      return;
    }

    // 2. Route: destroy uses fast path (BFS/cascade stays in World)
    if (commands.some((cmd) => cmd.type === "destroy")) {
      this.ctx.destroyEntityImmediate(entityId);
      return;
    }

    // 3. Apply structural changes
    this.applyEntityCommands(entityId, commands);
  }

  private applyEntityCommands(entityId: EntityId, commands: Command[]): void {
    const currentArchetype = this.ctx.entityToArchetype.get(entityId);
    if (!currentArchetype) return;

    const changeset = this._changeset;
    processCommands(entityId, currentArchetype, commands, changeset, (eid, arch, compId) => {
      if (isExclusiveComponent(compId)) {
        removeMatchingRelations(eid, arch, compId, changeset);
      }
    });

    const hasStructuralChange = changeset.removes.size > 0 || changeset.adds.size > 0;

    if (this.ctx.hooks.size === 0) {
      // Fast path: no hooks, skip removedComponents map allocation and hook triggering
      const newArchetype = applyChangeset(
        this._commandCtx,
        entityId,
        currentArchetype,
        changeset,
        this.ctx.entityToArchetype,
        null,
      );
      if (hasStructuralChange) {
        this.updateEntityReferences(entityId, changeset);
      }
      if (newArchetype !== currentArchetype) {
        this.ctx.incrementMigrations();
      }
      return;
    }

    const removedComponents = new Map<EntityId<any>, any>();
    const newArchetype = applyChangeset(
      this._commandCtx,
      entityId,
      currentArchetype,
      changeset,
      this.ctx.entityToArchetype,
      removedComponents,
    );

    if (hasStructuralChange) {
      this.updateEntityReferences(entityId, changeset);
    }

    if (newArchetype !== currentArchetype) {
      this.ctx.incrementMigrations();
    }

    this.ctx.triggerLifecycleHooks(
      this._hooksCtx,
      entityId,
      changeset.adds,
      removedComponents,
      currentArchetype,
      newArchetype,
    );
  }

  /**
   * Immediate (non-buffered) component removal used during cascade deletion.
   * Called from destroy* paths (which remain in World).
   */
  removeComponentImmediate(entityId: EntityId, componentType: EntityId<any>, targetEntityId: EntityId): void {
    const sourceArchetype = this.ctx.entityToArchetype.get(entityId);
    if (!sourceArchetype) return;

    const changeset = this._removeChangeset;
    changeset.clear();
    changeset.delete(componentType);
    maybeRemoveWildcardMarker(
      entityId,
      sourceArchetype,
      componentType,
      getComponentIdFromRelationId(componentType),
      changeset,
    );

    const removedComponent = sourceArchetype.get(entityId, componentType);
    const newArchetype = applyChangeset(
      this._commandCtx,
      entityId,
      sourceArchetype,
      changeset,
      this.ctx.entityToArchetype,
      null,
    );
    untrackEntityReference(this.ctx.entityReferences, entityId, componentType, targetEntityId);

    this.ctx.triggerLifecycleHooks(
      this._hooksCtx,
      entityId,
      new Map(),
      new Map([[componentType, removedComponent]]),
      sourceArchetype,
      newArchetype,
    );
  }

  /**
   * Keeps the entity reference reverse index in sync after structural changes.
   * Called from apply paths.
   */
  updateEntityReferences(entityId: EntityId, changeset: ComponentChangeset): void {
    for (const componentType of changeset.removes) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        untrackEntityReference(this.ctx.entityReferences, entityId, componentType, targetId);
      } else if (componentType >= 1024) {
        untrackEntityReference(this.ctx.entityReferences, entityId, componentType, componentType);
      }
    }

    for (const [componentType] of changeset.adds) {
      if (isEntityRelation(componentType)) {
        const targetId = getTargetIdFromRelationId(componentType)!;
        trackEntityReference(this.ctx.entityReferences, entityId, componentType, targetId);
      } else if (componentType >= 1024) {
        trackEntityReference(this.ctx.entityReferences, entityId, componentType, componentType);
      }
    }
  }

  /**
   * Exposed for any future direct needs (currently not required outside the executor).
   */
  getHooksContext(): HooksContext {
    return this._hooksCtx;
  }
}
