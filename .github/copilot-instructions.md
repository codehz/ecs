# @codehz/ecs AI Guide

## Project Overview

- High-performance ECS in TypeScript + Bun (Archetype storage + Query cache + CommandBuffer deferred structural changes).
- No built-in System/Scheduler; the game loop is recommended to use `@codehz/pipeline`, with `world.sync()` called in the last pass.

## Key Directories

- Source is a **flat domain layout** under `src/` (there is **no** `src/core` package):
  - `src/world/` — Facade (`world.ts`) + Core pieces (`archetype-manager`, `entity-access`, `command-executor`, …) + Relations (`relations-runtime`)
  - `src/archetype/` — Archetype columns + sparse store + helpers
  - `src/commands/` — CommandBuffer / Changeset
  - `src/entity/` — IDs, relations encoding, managers
  - `src/component/` — `component()` registry, component-entity store
  - `src/query/` — Query + QueryRegistry + filters
  - `src/storage/` — serialization ID helpers
  - `src/testing/` — test utilities (exported as `@codehz/ecs/testing`)
- Entry exports: `src/index.ts` unified external API.
- Examples: `examples/simple.ts`, `examples/advanced-scheduling.ts`, `examples/parent-child-hierarchy.ts`, etc.
- Build: `scripts/build.ts` (`bun run scripts/build.ts` / `bun run release`).
- Usage skill for app code: `skills/ecs/SKILL.md`.

## Internal Layering (Core / Relations / Facade)

When changing world internals, keep ownership clear:

| Layer         | Owner modules                                                 | Responsibilities                                     |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| **Core**      | `ArchetypeManager`, `EntityAccess`, `CommandExecutor`, stores | Structure, storage, command apply, dual-path has/get |
| **Relations** | `RelationsRuntime`, `references.ts`                           | Reverse refs, cascade destroy, hierarchy helpers     |
| **Facade**    | `World`                                                       | Public API, overloads, composition root only         |

Do **not** reintroduce algorithm bodies (destroy BFS, hierarchy DFS, has/get dispatch) into `World`.

## Running & Verification (Bun)

- Install: `bun install`
- Test: `bun test` (`src/__tests__/**/*.test.ts`, performance with `*.perf.test.ts`)
- Type check: `bunx tsc --noEmit`
- Example: `bun run examples/simple.ts`
- Build: `bun run scripts/build.ts`

## Design & Data Flow (Must Understand)

- Structural changes (`set`/`remove`/`delete`/`spawn`/`build`) enter the command buffer; **`world.sync()` must be called for them to take effect**.
- Queries should be reused long-term: pre-create and cache via `world.createQuery(...)`, then use `forEach` directly in the loop.
- Entity/Component ID rules: Component IDs 1–1023, Entity IDs 1024+, Relation IDs are negative-encoded (relation).

## Common Pitfalls & Conventions

- `world.get()` throws an error if the component does not exist; `undefined` is a valid value. Always use `has()` first or use `getOptional()`.
- Serialization is an "in-memory snapshot": `world.serialize()` returns an object, `new World(snapshot)` restores it; for persistence, custom encode/decode is needed.
- Relation components: `relation(componentId, targetId)`; wildcard relations use `relation(componentId, "*")` to listen to all targets.
- Exclusive relations: declare `exclusive: true` in the component definition; same-type relations automatically exclude each other.
- Prefer `sparse: true` for high-cardinality relations. Legacy `dontFragment` / `isDontFragment*` are **deprecated** (removed in next major).

## Example Patterns (from the codebase)

- Unified `world.sync()` at the end of a Pipeline: see `examples/simple.ts` / `examples/advanced-scheduling.ts`.
- Multi-component/optional component hooks: see README.md "Multi-Component Lifecycle Hooks".
- EntityBuilder: `world.spawn().with(...).build(); world.sync();`.
- Relation/hierarchy helpers on World (recommended):
  `world.getChildren(parent, ChildOf)`, `world.traverseDescendants(...)`, `world.getRelationSources(...)` etc.
  See `examples/parent-child-hierarchy.ts`. Standalone function forms were removed.

## Notes for Modifications

- Keep the public API: `World`, `component`, `relation`, etc. exports should not be renamed or removed in the current major.
- Entry is ESM; `.ts` extension imports are allowed.
- Prefer adding domain logic under the correct layer (`src/world/*`, `src/archetype/*`, …) and only expose new public APIs via `src/index.ts`.
- Hierarchy/relation tools stay as methods on `World` (facade); implement in `RelationsRuntime`.
- New tests: place under `src/__tests__/<domain>/` matching the source domain when practical (`relations/`, `world/`, `query/`, …). `src/__tests__/core/` historically holds archetype/bitset/changeset unit tests.
