# @codehz/ecs - AI Coding Guidelines

## Project Overview

This is a high-performance Entity Component System (ECS) library built with TypeScript and Bun runtime. The library implements an archetype-based architecture for optimal memory layout and query performance, with support for entity relationships, lifecycle hooks, and deferred command execution.

## Runtime & Environment

- **Runtime**: Bun (not Node.js) - use `bun` commands instead of `npm`/`yarn`
- **Language**: TypeScript with ESNext target and strict mode enabled
- **Module System**: ES modules with `"module": "Preserve"` and bundler resolution
- **Type Checking**: Strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, and other advanced checks

## Development Workflow

- **Install**: `bun install` (not `npm install`)
- **Run**: `bun run src/index.ts` (direct execution, no build step required)
- **TypeScript**: `bunx tsc --noEmit` (validates code with modern TypeScript features)
- **Testing**: `bun test` (runs all `*.test.ts` files)
- **Demo**: `bun run demo` (runs `examples/simple/demo.ts`)
- **Build**: `bun run scripts/build.ts` (generates dist/ with bundled JS and .d.ts files)
- **Release**: `bun run scripts/release.ts` (automated versioning from git tags)

## Architecture Patterns

### Core ECS Components

- **World**: Central coordinator managing entities, components, archetypes, and systems
- **Archetype**: Groups entities with identical component combinations for contiguous memory access
- **Entity**: Unique identifiers (starting from 1024) representing game objects
- **Component**: Data structures attached to entities (IDs 1-1023)
- **Query**: Cached entity queries with `forEach()` and `getEntitiesWithComponents()` methods
- **System**: Update logic implementing `System` interface with `update(world, deltaTime)` method
- **CommandBuffer**: Deferred execution system for batched structural changes

### Key Design Patterns

**Component Creation**:

```typescript
const PositionId = component<Position>(1);
const VelocityId = component<Velocity>(2);
```

**Deferred Operations** (always call `world.flushCommands()` after):

```typescript
world.addComponent(entity, PositionId, { x: 0, y: 0 });
world.removeComponent(entity, VelocityId);
world.flushCommands(); // Execute queued changes
```

**Query Usage**:

```typescript
const query = world.createQuery([PositionId, VelocityId]);
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  // Direct component access - no undefined checks needed
});
```

**System Implementation**:

```typescript
class MovementSystem implements System {
  private query: Query;

  constructor(world: World) {
    this.query = world.createQuery([PositionId, VelocityId]); // Cache query
  }

  update(world: World, deltaTime: number): void {
    this.query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * deltaTime;
    });
  }
}
```

**Entity Relationships**:

```typescript
// Direct relation: Position component targeting entity2
const positionRelation = relation(PositionId, entity2);
world.addComponent(entity1, positionRelation, { x: 10, y: 20 });

// Wildcard relation: Listen to all Position relations
const wildcardPosition = relation(PositionId, "*");
world.registerLifecycleHook(wildcardPosition, { onAdded: callback });
```

### Component ID Constraints

- Component IDs: 1-1023 (allocated via `component<T>(id)`)
- Entity IDs: 1024+ (auto-generated)
- Relation IDs: Negative encoded values (created via `relation()`)

### Memory Optimization

- Archetypes group entities by component signatures for cache-friendly iteration
- Command buffer batches structural changes to minimize archetype transitions
- Queries automatically cache matching archetypes and update on world changes

## Code Patterns

### Imports & Exports

- Use ES module syntax with `.ts` extensions allowed due to `"allowImportingTsExtensions": true`
- Main entry point: `src/index.ts` re-exports all public APIs
- Import from source: `import { World, component } from "@codehz/ecs"` (library consumers)

### Error Handling

- Entity operations validate existence before modification
- Component operations check type validity and entity existence
- Command buffer prevents infinite loops with iteration limits

### Testing Conventions

- Use Bun's test framework: `import { describe, expect, it } from "bun:test"`
- Test files: `*.test.ts` alongside implementation files
- Performance tests: `*.perf.test.ts` for benchmark validation

## Integration Points

### Build System

- **Primary Build**: `scripts/build.ts` uses `Bun.build()` for bundling
- **Type Generation**: `tsconfig.build.json` generates `.d.ts` files only
- **Release Process**: `scripts/release.ts` handles versioning and packaging

### Development Tools

- **Formatting**: Prettier with lint-staged (auto-formats on commit)
- **Git Hooks**: Husky manages pre-commit validation
- **Type Validation**: Typia transform plugin for runtime type checking

## Key Files Reference

- `src/world.ts`: Core World class with archetype management and command execution
- `src/archetype.ts`: Archetype implementation for contiguous component storage
- `src/entity.ts`: Entity/component ID system with relation encoding
- `src/query.ts`: Query caching and iteration over matching entities
- `src/command-buffer.ts`: Deferred execution for structural changes
- `examples/simple/demo.ts`: Basic usage example with movement system
- `tsconfig.json`: Modern TypeScript config with bundler mode
- `package.json`: Library configuration with Bun-specific settings
