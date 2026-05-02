# @codehz/ecs

> **中文版本:** [README.md](./README.md)

A high-performance Entity Component System (ECS) library built with TypeScript and the Bun runtime.

## Features

- 🚀 High performance: Archetype-based component storage and efficient query system
- 🔧 Type-safe: Full TypeScript support
- 🏗️ Modular: Clean architecture with custom component support
- 📦 Lightweight: Zero dependencies, easy to integrate
- ⚡ Memory efficient: Contiguous memory layout, optimized iteration performance
- 🎣 Lifecycle hooks: Multi-component and wildcard relation event listening

## Installation

```bash
bun install
```

## Usage

### Basic Example

```typescript
import { World, component } from "@codehz/ecs";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// Define component IDs (auto-assigned)
const PositionId = component<Position>();
const VelocityId = component<Velocity>();

// Create world
const world = new World();

// Create entity and set components (all changes buffered until sync())
const entity = world.new();
world.set(entity, PositionId, { x: 0, y: 0 });
world.set(entity, VelocityId, { x: 1, y: 0.5 });
world.sync();

// Create reusable query
const query = world.createQuery([PositionId, VelocityId]);

// Update loop
const deltaTime = 1.0 / 60.0;
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  position.x += velocity.x * deltaTime;
  position.y += velocity.y * deltaTime;
});
```

### Defining Components (Auto-assigned IDs)

`component()` automatically assigns a unique ID from a global allocator. You can also specify a name or options:

```typescript
import { component } from "@codehz/ecs";

// Auto-assign ID with no arguments
const Position = component<Position>();

// Specify a name (readable in serialization)
const Velocity = component<Velocity>("Velocity");

// With options (for relation components)
const ChildOf = component({ exclusive: true, name: "ChildOf" });
```

**`ComponentOptions` options:**

| Option          | Type                | Description                                                                                                                             |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | `string`            | Component name, used for serialization/debugging                                                                                        |
| `exclusive`     | `boolean`           | Relation components only: an entity can have at most one relation of the same base component                                            |
| `cascadeDelete` | `boolean`           | Entity relations only: when the target entity is deleted, entities referencing it are also deleted (cascade delete)                     |
| `dontFragment`  | `boolean`           | Relation components only: relations with different target entities are stored in the same Archetype, preventing excessive fragmentation |
| `merge`         | `(prev, next) => T` | Merge strategy when `set()` is called multiple times on the same component within a single sync batch                                   |

### Lifecycle Hooks

`world.hook()` registers multi-component lifecycle hooks using a component array:

```typescript
// Returns an unlisten function
const unhook = world.hook([PositionId, VelocityId], {
  on_init: (entityId, position, velocity) => {
    // Called for every entity that already matches when the hook is registered
  },
  on_set: (entityId, position, velocity) => {
    // Called when an entity "enters" the matching set (after adding/updating components)
  },
  on_remove: (entityId, position, velocity) => {
    // Called when an entity "exits" the matching set (after removing components or deleting entity)
  },
});
// Unlisten the hook
unhook();
```

A shorthand callback form is also supported:

```typescript
const unhook = world.hook([PositionId, VelocityId], (type, entityId, position, velocity) => {
  if (type === "init") console.log("init");
  if (type === "set") console.log("set");
  if (type === "remove") console.log("remove");
});
```

Optional components and filters:

```typescript
// Optional component: the hook fires even if Velocity is absent
world.hook([PositionId, { optional: VelocityId }], {
  on_set: (entityId, position, velocity) => {
    if (velocity !== undefined) {
      console.log("has velocity and position");
    } else {
      console.log("has position only");
    }
  },
});

// Filter: exclude entities with specified negative components
const DisabledId = component<void>();
world.hook(
  [PositionId, VelocityId],
  {
    on_set: (entityId, position, velocity) => console.log("entered matching set"),
    on_remove: (entityId, position, velocity) => console.log("exited matching set"),
  },
  { negativeComponentTypes: [DisabledId] },
);
```

### Relation Components

```typescript
import { World, component, relation } from "@codehz/ecs";

const ChildOf = component<void>({ exclusive: true });
const world = new World();
const child = world.new();
const parent1 = world.new();
const parent2 = world.new();

// Add relation
world.set(child, relation(ChildOf, parent1));
world.sync();

// Exclusive relations: adding a new relation automatically removes the old one
world.set(child, relation(ChildOf, parent2));
world.sync();
console.log(world.has(child, relation(ChildOf, parent1))); // false
console.log(world.has(child, relation(ChildOf, parent2))); // true
```

### Wildcard Relation Hooks

```typescript
import { World, component, relation } from "@codehz/ecs";
const PositionId = component<Position>();

const world = new World();
const wildcardPos = relation(PositionId, "*");

// Listen for changes to all relations of this type
world.hook([wildcardPos], {
  on_set: (entityId, relations) => {
    for (const [targetId, position] of relations) {
      console.log(`entity ${entityId} -> target ${targetId}:`, position);
    }
  },
  on_remove: (entityId, relations) => {
    console.log(`entity ${entityId} removed all Position relations`);
  },
});
```

### EntityBuilder Fluent Creation

```typescript
const entity = world
  .spawn()
  .with(Position, { x: 0, y: 0 })
  .with(Marker) // void components don't need a value
  .withRelation(ChildOf, parentEntity)
  .build();
world.sync(); // apply all at once
```

### Batch Creation

```typescript
const entities = world.spawnMany(100, (builder, index) => builder.with(Position, { x: index * 10, y: 0 }));
world.sync();
```

### Running Examples

```bash
bun run examples/simple/demo.ts
bun run examples/advanced-scheduling/demo.ts
```

## API Overview

### World

| Method                                | Description                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `new<T>()`                            | Create a new entity, returns `EntityId<T>`                                                                   |
| `create<T>()`                         | Semantic alias for `new()`                                                                                   |
| `spawn()`                             | Returns an `EntityBuilder` for fluent creation                                                               |
| `spawnMany(count, configure)`         | Batch create multiple entities                                                                               |
| `exists(entity)`                      | Check if an entity exists                                                                                    |
| `set(entity, componentId, data?)`     | Add/update a component (buffered, takes effect after `sync()`). For `void` components, `data` can be omitted |
| `set(componentId, data)`              | Singleton component shorthand: `world.set(GlobalConfig, { ... })`                                            |
| `get(entity, componentId?)`           | Get component data. **Throws if the component does not exist**; use `has()` first or use `getOptional()`     |
| `getOptional(entity, componentId?)`   | Safely get a component, returns `{ value: T } \| undefined`                                                  |
| `has(entity, componentId?)`           | Check if a component exists                                                                                  |
| `remove(entity, componentId?)`        | Remove a component (buffered), also has a singleton shorthand                                                |
| `delete(entity)`                      | Destroy an entity and all its components (buffered)                                                          |
| `query(componentIds)`                 | Fast ad-hoc query (not cached)                                                                               |
| `query(componentIds, true)`           | Fast ad-hoc query returning entities and component data                                                      |
| `createQuery(componentIds, filter?)`  | Create a reusable, cached query                                                                              |
| `releaseQuery(query)`                 | Release a query (optional cleanup)                                                                           |
| `hook(componentTypes, hook, filter?)` | Register a lifecycle hook, returns an unlisten function                                                      |
| `serialize()`                         | Serialize world state as a snapshot object                                                                   |
| `sync()`                              | Execute all deferred commands                                                                                |

### Query

Queries are created via `world.createQuery()` and should be **reused across frames** for best performance.

| Method                              | Description                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `forEach(componentTypes, callback)` | Iterate over matching entities                                         |
| `getEntities()`                     | Get the list of all matching entity IDs                                |
| `getEntitiesWithComponents(types)`  | Get an array of entities with component data objects                   |
| `iterate(types)`                    | Return a generator for `for...of` iteration                            |
| `getComponentData(type)`            | Get a single component's data array for all matching entities          |
| `dispose()`                         | Release the query (decrements reference count; fully released at zero) |
| `get disposed()`                    | Check if the query has been released                                   |

### QueryFilter

```typescript
interface QueryFilter {
  negativeComponentTypes?: EntityId<any>[]; // Components to exclude
}
```

### EntityBuilder

| Method                                       | Description                                                    |
| -------------------------------------------- | -------------------------------------------------------------- |
| `with(componentId, ...args)`                 | Add a regular component. No value for `void` types             |
| `withRelation(componentId, target, ...args)` | Add a relation component. No value for `void` types            |
| `build()`                                    | Create the entity and return `EntityId` (still needs `sync()`) |

### component()

```typescript
// Auto-assigned ID
component<T>();
// With a name
component<T>("Name");
// With options
component<T>({ name?: string, exclusive?: boolean, cascadeDelete?: boolean, dontFragment?: boolean, merge?: (prev, next) => T });
```

### relation()

```typescript
// Create a relation ID
relation(componentId, targetEntity);
// Wildcard (query all targets)
relation(componentId, "*");
// Singleton target (associate with another component)
relation(componentId, otherComponentId);
```

### Component / Entity ID Rules

- Component ID: `1` – `1023`
- Entity ID: `1024+`
- Relation ID: negative encoded as `-(componentId * 2^42 + targetId)`

## Serialization (Snapshot)

The library provides an "in-memory snapshot" serialization interface for saving/restoring entity and component data.

```typescript
// Create a snapshot (in-memory object)
const snapshot = world.serialize();

// Restore directly within the same process
const restored = new World(snapshot);
```

**Design notes:**

- `world.serialize()` returns an in-memory snapshot object. It does **not** call `JSON.stringify` on component values, nor does it attempt to convert component values to a serializable format.
- `new World(snapshot)` is the sole entry point for deserialization (there is no `World.deserialize()` static method).
- The snapshot includes entities, components, and the `EntityIdManager` allocator state (preserving the next ID to assign). It does **not** automatically restore query caches or lifecycle hooks.

**Persistence example (when component values are JSON-friendly):**

```typescript
const snapshot = world.serialize();
const json = JSON.stringify(snapshot);
// Write to file or send over network ...

const parsed = JSON.parse(json);
const restored = new World(parsed);
```

**Custom encoding example:**

```typescript
const snapshot = world.serialize();
const encoded = {
  ...snapshot,
  entities: snapshot.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myEncode(c.value) })),
  })),
};
// Persist encoded ...

// Decode in reverse when restoring
const decodedSnapshot = {
  ...decoded,
  entities: decoded.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myDecode(c.value) })),
  })),
};
const restored = new World(decodedSnapshot);
```

**Important:** `get()` throws an error when the component does not exist. Since `undefined` is a valid component value, you cannot use `get()`'s return value being `undefined` to determine whether a component exists. Use `has()` or `getOptional()` instead.

## System / Pipeline Integration

Starting from v0.4.0, the library removed the built-in `System` and `SystemScheduler`. It is recommended to use `@codehz/pipeline` to organize the game loop, and **always call `world.sync()` in the last pass**.

```bash
bun add @codehz/pipeline
```

```typescript
import { pipeline } from "@codehz/pipeline";
import { World, component } from "@codehz/ecs";

const world = new World();
const movementQuery = world.createQuery([PositionId, VelocityId]);

const gameLoop = pipeline<{ deltaTime: number }>()
  .addPass((env) => {
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
    });
  })
  .addPass(() => {
    world.sync(); // must be the last pass
  })
  .build();

gameLoop({ deltaTime: 0.016 });
```

## Project Structure

```
src/
├── index.ts                 # Entry point (unified exports)
├── core/                    # Core implementation
│   ├── world.ts             # World management
│   ├── archetype.ts         # Archetype system (efficient component storage)
│   ├── builder.ts           # EntityBuilder fluent creation
│   ├── component-registry.ts # Component registry
│   ├── component-entity-store.ts # Singleton component storage
│   ├── component-type-utils.ts   # Component type utilities
│   ├── dont-fragment-store.ts    # DontFragment storage
│   ├── entity.ts            # Entity/component/relation type exports (aggregate)
│   ├── entity-types.ts      # Entity ID type definitions & constants
│   ├── entity-relation.ts   # Relation ID encoding/decoding
│   ├── entity-manager.ts    # ID allocator
│   ├── query-registry.ts    # Query registry
│   ├── serialization.ts     # Serialization ID encoding/decoding
│   ├── world-serialization.ts # World serialization/deserialization
│   ├── world-commands.ts    # World commands
│   ├── world-hooks.ts       # Hook execution logic
│   ├── world-references.ts  # Entity reference tracking
│   └── types.ts             # Type definitions
├── query/                   # Query system
│   ├── query.ts             # Query class
│   └── filter.ts            # Query filter
├── commands/                # Command buffer
├── utils/                   # Utility functions
├── testing/                 # Test utilities
└── __tests__/               # Unit tests & performance tests

examples/
├── simple/
│   ├── demo.ts              # Basic example
│   └── README.md            # Example documentation
└── advanced-scheduling/
    └── demo.ts              # Pipeline scheduling example

scripts/
├── build.ts                 # Build script
└── release.ts               # Release script
```

## Development

```bash
bun install
bun test                    # Run tests
bunx tsc --noEmit           # Type check
bun run examples/simple/demo.ts  # Run example
bun run scripts/build.ts    # Build
```

## License

MIT

## Contributing

Issues and Pull Requests are welcome!
