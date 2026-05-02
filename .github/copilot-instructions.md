# @codehz/ecs AI Guide

## Project Overview

- High-performance ECS in TypeScript + Bun (Archetype storage + Query cache + CommandBuffer deferred structural changes).
- No built-in System/Scheduler; the game loop is recommended to use `@codehz/pipeline`, with `world.sync()` called in the last pass.

## Key Directories

- Core implementation: `src/core` (world, archetype, entity, query, command-buffer).
- Entry exports: `src/index.ts` unified external API.
- Examples: `examples/simple/demo.ts` and `examples/advanced-scheduling/demo.ts`.
- Build/Release: `scripts/build.ts`, `scripts/release.ts`.

## Running & Verification (Bun)

- Install: `bun install`
- Test: `bun test` (`*.test.ts`, performance with `*.perf.test.ts`)
- Type check: `bunx tsc --noEmit`
- Example: `bun run examples/simple/demo.ts`
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

## Example Patterns (from the codebase)

- Unified `world.sync()` at the end of a Pipeline: see `examples/simple/demo.ts`.
- Multi-component/optional component hooks: see README.md "Multi-Component Lifecycle Hooks".
- EntityBuilder: `world.spawn().with(...).build(); world.sync();`.

## Notes for Modifications

- Keep the public API: `World`, `component`, `relation`, etc. exports should not be renamed or removed.
- Entry is ESM; `.ts` extension imports are allowed.
- Prioritize adding core logic in `src/core`, and expose new APIs in `src/index.ts`.
