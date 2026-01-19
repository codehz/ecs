# @codehz/ecs - AI Coding Guidelines

## Project Overview

This is a high-performance Entity Component System (ECS) library built with TypeScript and Bun runtime. The library implements an archetype-based architecture for optimal memory layout and query performance, with support for entity relationships, lifecycle hooks, and deferred command execution.

**Note**: This library does not include a built-in system scheduler. For game loop organization, use `@codehz/pipeline` (dev dependency) or any similar pattern.

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

- **World**: Central coordinator managing entities, components, and archetypes
- **Archetype**: Groups entities with identical component combinations for contiguous memory access
- **Entity**: Unique identifiers (starting from 1024) representing game objects
- **Component**: Data structures attached to entities (IDs 1-1023)
- **Query**: Cached entity queries with `forEach()` and `getEntitiesWithComponents()` methods
- **CommandBuffer**: Deferred execution system for batched structural changes

### Key Design Patterns

**Component Creation** (IDs are auto-allocated, see [src/entity.ts](src/entity.ts)):

```typescript
// Simple component with auto-allocated ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();

// Component with name (for serialization/debugging)
const HealthId = component<Health>("Health");

// Component with options
const ChildOf = component({ name: "ChildOf", exclusive: true, cascadeDelete: true });
```

**Deferred Operations** (always call `world.sync()` after):

```typescript
world.set(entity, PositionId, { x: 0, y: 0 });
world.delete(entity, VelocityId);
world.sync(); // Execute queued changes
```

**Query Usage**:

```typescript
const query = world.createQuery([PositionId, VelocityId]);
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  // Direct component access - no undefined checks needed
});
```

**Pipeline-based Game Loop** (using `@codehz/pipeline`):

```typescript
import { pipeline } from "@codehz/pipeline";

const world = new World();
const movementQuery = world.createQuery([PositionId, VelocityId]);

const gameLoop = pipeline<{ deltaTime: number }>()
  .addPass((env) => {
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
    });
  })
  // IMPORTANT: world.sync() must be called as the last pass to execute deferred commands
  .addPass(() => {
    world.sync();
  })
  .build();

// Run game loop
gameLoop({ deltaTime: 0.016 });
```

**Entity Relationships**:

```typescript
// Direct relation: Position component targeting entity2
const positionRelation = relation(PositionId, entity2);
world.set(entity1, positionRelation, { x: 10, y: 20 });

// Wildcard relation: Listen to all Position relations
const wildcardPosition = relation(PositionId, "*");
world.hook(wildcardPosition, {
  on_set: (entityId, componentType, component) => {
    /* ... */
  },
  on_remove: (entityId, componentType, component) => {
    /* ... */
  },
});
```

### Component ID Constraints

See [src/entity.ts](src/entity.ts) and [README.md](README.md) for details:

- Component IDs: 1-1023 (auto-allocated via `component<T>()` or `component(options)`, max 1022 components)
- Entity IDs: 1024+ (auto-generated via `world.new()`)
- Relation IDs: Negative encoded values (created via `relation(componentId, targetId)`)

### 重要警告：get() 方法使用须知

参见 [src/world.ts](src/world.ts) 第 376-400 行：

- **调用 `get()` 前必须确认组件存在**：若实体没有该组件，`get()` 会抛出异常
- **`undefined` 是有效的组件值**：不能用返回值判断组件是否存在
- **推荐做法**：使用 `has()` 检查，或使用 `getOptional()` 返回 `{ value: T } | undefined`

```typescript
// ❌ 错误用法：直接 get() 可能抛异常
const pos = world.get(entity, PositionId); // 若无 PositionId 则报错

// ✅ 正确用法：先检查，再获取
if (world.has(entity, PositionId)) {
  const pos = world.get(entity, PositionId);
}

// ✅ 或使用 getOptional
const result = world.getOptional(entity, PositionId);
if (result) {
  const pos = result.value;
}
```

### 序列化与快照

参见 [src/world.ts](src/world.ts) 第 1333-1353 行：

- **导出快照**：`world.serialize()` 返回内存结构（非 JSON 字符串）
- **恢复世界**：`new World(snapshot)` 从快照创建新实例
- **注意**：组件必须有名称（`component<T>("Name")`）才能正确序列化

```typescript
// 保存快照
const snapshot = world.serialize();
const json = JSON.stringify(snapshot); // 自行转换为 JSON 字符串

// 恢复快照
const restored = new World(JSON.parse(json));
```

### EntityBuilder / 流式创建

参见 [src/world.ts](src/world.ts) 第 1384-1433 行：

- **流式 API**：`world.spawn().with(...).build()` 链式创建实体
- **同步要求**：`build()` 只入队命令，必须调用 `world.sync()` 才能生效

```typescript
const entity = world
  .spawn()
  .with(PositionId, { x: 0, y: 0 })
  .with(VelocityId, { x: 1, y: 0 })
  .withRelation(ChildOf, parentEntity, {})
  .build();

world.sync(); // 必须调用才能应用组件
```

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

- **Primary Build**: [scripts/build.ts](scripts/build.ts) uses `tsdown` for bundling and type generation
- **Release Process**: [scripts/release.ts](scripts/release.ts) handles versioning and packaging

### Development Tools

- **Linting**: ESLint with TypeScript parser (`@typescript-eslint/eslint-plugin`)
- **Formatting**: Prettier with lint-staged (auto-formats on commit)
- **Git Hooks**: Husky manages pre-commit validation

## Key Files Reference

- `src/world.ts`: Core World class with archetype management and command execution
- `src/archetype.ts`: Archetype implementation for contiguous component storage
- `src/entity.ts`: Entity/component ID system with relation encoding
- `src/query.ts`: Query caching and iteration over matching entities
- `src/command-buffer.ts`: Deferred execution for structural changes
- `examples/simple/demo.ts`: Basic usage example with pipeline-based game loop
- `examples/advanced-scheduling/demo.ts`: Advanced pipeline scheduling example
- `tsconfig.json`: Modern TypeScript config with bundler mode (no emit, type checking only)
- `eslint.config.mjs`: ESLint flat config with TypeScript and Prettier integration
- `package.json`: Library configuration with Bun-specific settings

## 注意事项

在为此项目编写或修改代码时，**请避免**以下行为：

- **不要硬编码敏感信息**：如 API 密钥、密码、令牌等，应使用环境变量
- **不要修改生产配置**：如 `package.json` 的 `name`/`version` 字段，除非明确要求
- **不要删除或重命名公共 API**：如 `World`、`component`、`relation` 等导出，避免破坏兼容性
- **不要跳过类型检查**：禁止使用 `@ts-ignore` 或 `any` 来绕过 TypeScript 错误
- **不要在测试中使用真实外部服务**：测试应保持独立、可重复运行
