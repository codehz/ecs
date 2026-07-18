---
name: ecs
description: "Guide for using @codehz/ecs — a high-performance ECS (Entity Component System) library in TypeScript. Use when: writing application code with @codehz/ecs; understanding deferred command buffering, archetype storage, queries, relations, lifecycle hooks, and sync() semantics; avoiding common ECS pitfalls like stale reads, dangling EntityId references, or sync() inside iteration."
---

# @codehz/ecs — User Guide for AI Coding Assistants

**Purpose**: This document defines the strict usage contract for `@codehz/ecs`. Follow these rules when writing application code. Violating them is the most common source of subtle, hard-to-debug errors.

The library uses **archetype storage + deferred command buffering**. All structural changes are queued and applied only on `sync()`.

---

## The Single Most Important Concept

**Every structural change is deferred.**

- `world.set()`, `world.remove()`, `world.delete()`, `world.new()`, `world.spawn().build()`, `world.spawnMany()`
- These calls **never** take effect immediately.
- They are only applied when `world.sync()` is called.

**Reading state after a mutation without calling `sync()` will see stale data.**

---

## Golden Rules (Memorize)

1. **MUST** call `world.sync()` to make any structural change visible.
2. **MUST** treat `world.sync()` as the very last operation in a frame / pipeline pass.
3. **NEVER** call `world.get()` without first confirming the component exists on that entity.
4. **NEVER** store raw `EntityId` values inside normal component data.
5. **MUST** create queries once via `createQuery()` at startup and reuse them.
6. **MUST** only pass required (non-optional) components to `createQuery()`.
7. **NEVER** call `sync()` inside `forEach`, hooks, or while iterating query results.
8. **NEVER** confuse `remove(entity, Component)` with `delete(entity)`.
9. **MUST** use relation components (`relation(Comp, target)`) instead of storing `EntityId` in data when you need to reference other entities.
10. **MUST** understand the three relation flags (`exclusive`, `cascadeDelete`, `sparse` / legacy `dontFragment`) before using relations.

---

## Detailed Rules & Danger Zones

### 1. Deferred Execution & `sync()`

- All mutations are buffered in the command buffer.
- `world.sync()` executes the entire buffer in one batch.
- After `sync()`, queries, hooks, and direct access will see the new state.

**Correct pattern**:

```ts
world.set(e, Position, { x: 10, y: 20 });
world.set(e, Velocity, { x: 1, y: 0 });
world.sync(); // Changes become visible here

const pos = world.get(e, Position); // Safe
```

**Anti-pattern**:

```ts
world.set(e, Position, { x: 10, y: 20 });
const pos = world.get(e, Position); // Still sees old data (or throws)
```

### 2. Accessing Component Data Safely

**Both `get()` and `getOptional()` throw if the entity does not exist.**

- `world.get(entity, Comp)` — throws if component is absent on an existing entity.
- `world.getOptional(entity, Comp)` — returns `undefined` only when the component is missing (entity must exist).
- `world.has(entity, Comp)` — safe existence check.

**Correct pattern**:

```ts
if (world.has(e, Health)) {
  const h = world.get(e, Health); // Safe
  // or
  const opt = world.getOptional(e, Health);
  if (opt) {
    /* ... */
  }
}
```

**Anti-pattern**:

```ts
const val = world.get(e, SomeComp); // May throw even if value could be undefined
```

**Rule**: Prefer `has()` + `get()`, or `getOptional()`, never bare `get()`.

### 3. Queries — Creation, Caching, Optional Components

- `createQuery()` builds a cached query that is kept up-to-date by the world.
- Queries are **expensive to create** and **must be reused** across frames.

**Critical rule for optional components**:

- Only put **required** components in `createQuery([...])`.
- Supply optional components **only at iteration time**.

**Correct pattern**:

```ts
const q = world.createQuery([Position]); // Only required components here

q.forEach([Position, { optional: Velocity }], (e, pos, vel) => {
  // vel may be undefined
});
```

**Anti-pattern**:

```ts
const q = world.createQuery([Position, { optional: Velocity }]); // Wrong
```

**Performance rule**: Create all queries once during initialization. Store them in variables or a container. Never call `createQuery` inside a loop or per-frame logic.

### 4. Lifecycle Hooks

- `world.hook([CompA, CompB], { on_init, on_set, on_remove })`
- `on_init` is called **at registration time** for every entity that already matches.
- `on_set` / `on_remove` fire **after `sync()`** when an entity enters or leaves the set.
- Optional components and negative filters are supported.

**Correct pattern**:

```ts
world.hook([Position, { optional: Velocity }], {
  on_set: (e, pos, vel) => {
    /* ... */
  },
});
```

**Rule**: Do not assume hooks run synchronously with the `set()` call.

### 5. Structural Changes Inside Iteration / Hooks

You **may** queue structural changes inside `forEach` and hook callbacks.

**You MUST NOT**:

- Call `world.sync()` inside them.
- Read data expecting the queued changes to be visible.

**Correct pattern**:

```ts
movementQuery.forEach([Position, Velocity], (e, pos, vel) => {
  if (shouldDestroy(e)) {
    world.delete(e); // Queued safely
  } else if (needsNewComp) {
    world.set(e, NewComp, data);
  }
});
world.sync(); // Apply everything after iteration
```

**Anti-pattern**:

```ts
query.forEach([A], (e, a) => {
  world.set(e, B, data);
  world.sync(); // Extremely dangerous
  const b = world.get(e, B); // Undefined behavior
});
```

### 6. `remove()` vs `delete()` — Do Not Confuse Them

| Method                  | Effect                                                |
| ----------------------- | ----------------------------------------------------- |
| `world.remove(e, Comp)` | Removes **one component** from the entity             |
| `world.delete(e)`       | Destroys the **entire entity** and all its components |

**Anti-pattern** (very common):

```ts
world.remove(e, Enemy); // This does NOT destroy the entity!
```

**Correct pattern for destroying an entity**:

```ts
world.delete(e);
world.sync();
```

### 7. Relations — The Three Important Flags

Use `relation(Component, target)` to create entity-to-entity references.

**`exclusive: true`** (on the component definition)

- An entity can have at most one relation of this base component.
- Setting a new target automatically removes the previous one during `sync()`.

**`cascadeDelete: true`**

- When the target entity is deleted, **the entire referencing entity is deleted**.
- This is transitive and powerful. Use deliberately.

**`sparse: true`** (preferred)

- Prevents archetype fragmentation when many different targets exist.
- **Required** for relations with high cardinality or frequent target changes (e.g. `ChildOf` with thousands of children, AI targeting, inventory).
- Legacy key `dontFragment` still works but is **deprecated** and will be removed in the next major. Always write `sparse` in new code.
- Legacy helpers `isDontFragmentComponent` / `isDontFragmentRelation` / `isDontFragmentWildcard` are deprecated aliases of `isSparse*`.

**Correct definition patterns**:

```ts
const ChildOf = component({ exclusive: true, cascadeDelete: true });
const Targeting = component({ exclusive: true, sparse: true });
const InventorySlot = component({ sparse: true });
```

### 8. Referencing Other Entities — Never Store Raw EntityId

**Strong rule**: Do **not** put `EntityId` values inside normal component data.

Reasons:

- Entities can be deleted.
- Entity IDs are reused after deletion.
- You will create dangling references and extremely subtle bugs.

**Correct approach** — always use a relation component:

```ts
const Owner = component({ exclusive: true });

world.set(item, relation(Owner, player));
world.sync();

// Later the relation is automatically cleaned up if player is deleted
```

**Anti-pattern**:

```ts
type Item = { owner: EntityId }; // Dangerous
world.set(item, ItemComp, { owner: player });
```

### 9. Singletons (Component-as-Entity)

You can use a component ID itself as a singleton:

```ts
world.set(GlobalConfig, { debug: true, maxEntities: 10000 });
world.sync();

const cfg = world.get(GlobalConfig); // Note: no entity argument
```

This is useful for global configuration, time, resources, etc.

### 10. Serialization

- `world.serialize()` produces an **in-memory snapshot**.
- `new World(snapshot)` restores entities and component data.
- **Not restored**: cached queries, lifecycle hooks, command buffer state.
- `undefined` is a valid component value and is preserved.
- For real persistence you must implement custom encode/decode.

**Rule**: Treat serialization as "save the current world state for later in this process or for network transfer", not as a general-purpose save file format.

### 11. Entity / Component ID Rules (Quick Reference)

- Component IDs: `1` – `1023`
- Entity IDs: `1024` and above
- Relation IDs: negative (encoded as `-(componentId * 2^42 + targetId)`)
- Do not rely on specific numeric values in application code.

---

## Recommended Patterns (Copy These Shapes)

**Game loop with @codehz/pipeline**:

```ts
const gameLoop = pipeline<{ deltaTime: number }>()
  .addPass(() => {
    /* read-only systems */
  })
  .addPass(() => {
    /* systems that queue mutations */
  })
  .addPass(() => {
    world.sync();
  }) // Always last
  .build();
```

**Standard query + mutation pattern**:

```ts
const query = world.createQuery([Position, Velocity]);

function update(dt: number) {
  query.forEach([Position, Velocity], (e, pos, vel) => {
    pos.x += vel.x * dt;
    if (shouldDestroy(e)) world.delete(e);
  });
  world.sync();
}
```

**Safe entity creation**:

```ts
const e = world.spawn().with(Position, { x: 0, y: 0 }).withRelation(ChildOf, parent).build();
world.sync();
```

---

## Common Anti-Patterns

- Calling `get()` immediately after `set()` without `sync()`
- Creating queries inside the update loop
- Putting optional wrappers inside `createQuery()`
- Storing `EntityId` in component payloads
- Using `remove()` when `delete()` was intended
- Calling `sync()` inside `forEach` or hook callbacks
- Assuming `on_set` fires synchronously with `set()`
- Forgetting that `exclusive` relations silently remove the previous target
- Using `cascadeDelete` without understanding it deletes whole entities

---

**Follow these rules. They exist because the architecture deliberately trades immediate visibility for performance and cache efficiency.**

When in doubt, ask: "Has `sync()` been called since the last structural change, and am I allowed to see the result?"
