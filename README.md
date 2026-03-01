# @codehz/ecs

一个高性能的Entity Component System (ECS) 库，使用 TypeScript 和 Bun 运行时构建。

## 特性

- 🚀 高性能：基于 Archetype 的组件存储和高效的查询系统
- 🔧 类型安全：完整的 TypeScript 支持
- 🏗️ 模块化：清晰的架构，支持自定义组件
- 📦 轻量级：零依赖，易于集成
- ⚡ 内存高效：连续内存布局，优化的迭代性能
- 🎣 生命周期钩子：支持组件和通配符关系的事件监听

## 安装

```bash
bun install
```

## 用法

### 基本示例

```typescript
import { World } from "@codehz/ecs";
import { component } from "@codehz/ecs";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>(1);
const VelocityId = component<Velocity>(2);

// 创建世界
const world = new World();

// 创建实体
const entity = world.new();
world.set(entity, PositionId, { x: 0, y: 0 });
world.set(entity, VelocityId, { x: 1, y: 0.5 });

// 应用更改
world.sync();

// 创建查询并更新
const query = world.createQuery([PositionId, VelocityId]);
const deltaTime = 1.0 / 60.0; // 假设60FPS
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  position.x += velocity.x * deltaTime;
  position.y += velocity.y * deltaTime;
});
```

### 组件生命周期钩子

ECS 支持监听组件的生命周期事件。可以监听单个组件或多个组件同时存在于实体时的事件。

```typescript
// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();

// 注册生命周期钩子，返回卸载函数
const unhook = world.hook([PositionId, VelocityId], {
  on_init: (entityId, position, velocity) => {
    // 当钩子注册时，为已同时拥有 Position 和 Velocity 组件的实体调用
    console.log(`实体 ${entityId} 同时拥有 Position 和 Velocity 组件`);
  },
  on_set: (entityId, position, velocity) => {
    // 当实体同时拥有 Position 和 Velocity 组件时调用
    console.log(
      `实体 ${entityId} 现在同时拥有 Position (${position.x}, ${position.y}) 和 Velocity (${velocity.x}, ${velocity.y})`,
    );
  },
  on_remove: (entityId, position, velocity) => {
    // 当实体失去 Position 或 Velocity 组件之一时调用（如果之前同时拥有两者）
    console.log(`实体 ${entityId} 失去了 Position 或 Velocity 组件`);
  },
});

// 添加组件
const entity = world.new();
world.set(entity, PositionId, { x: 0, y: 0 });
world.set(entity, VelocityId, { x: 1, y: 0.5 });
world.sync(); // 钩子在这里被调用

// 不再需要时，调用卸载函数移除钩子
unhook();
```

`hook()` 也支持只监听单个组件：

```typescript
// 监听单个组件
const unhook = world.hook([PositionId], {
  on_set: (entityId, position) => {
    console.log(`组件 Position 被添加到实体 ${entityId}`);
  },
  on_remove: (entityId, position) => {
    console.log(`组件 Position 被从实体 ${entityId} 移除`);
  },
});
```

还可以使用可选组件，这样即使某些组件不存在也会触发钩子：

```typescript
// 注册包含可选组件的生命周期钩子
const unhook = world.hook([PositionId, { optional: VelocityId }], {
  on_set: (entityId, position, velocity) => {
    // 当实体拥有 Position 组件时调用，Velocity 组件可选
    if (velocity !== undefined) {
      console.log(`实体 ${entityId} 拥有 Position 和 Velocity 组件`);
    } else {
      console.log(`实体 ${entityId} 仅拥有 Position 组件`);
    }
  },
});
```

多组件 `hook()` 还支持第三个可选参数 `filter`（与 `createQuery()` 的过滤语义一致），可用于排除带有某些负面组件的实体：

```typescript
const DisabledId = component<void>();

const unhook = world.hook(
  [PositionId, VelocityId],
  {
    on_set: (entityId, position, velocity) => {
      // 实体进入匹配集合时触发（包括移除 Disabled 后重新进入）
      console.log("active", entityId, position, velocity);
    },
    on_remove: (entityId, position, velocity) => {
      // 实体退出匹配集合时触发（包括新增 Disabled 后退出）
      console.log("inactive", entityId, position, velocity);
    },
  },
  {
    negativeComponentTypes: [DisabledId],
  },
);
```

### 通配符关系钩子

ECS 支持通配符关系钩子，可以监听特定组件的所有关系变化：

```typescript
import { World, component, relation } from "@codehz/ecs";

// 定义组件类型
type Position = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>(1);

// 创建世界
const world = new World();

// 创建实体
const entity = world.new();

// 创建通配符关系ID，用于监听所有 Position 相关的关系
const wildcardPositionRelation = relation(PositionId, "*");

// 注册通配符关系钩子，返回卸载函数
const unhook = world.hook([wildcardPositionRelation], {
  on_set: (entityId, relations) => {
    console.log(`实体 ${entityId} 添加了 Position 关系`);
    for (const [targetId, position] of relations) {
      console.log(`  -> 目标实体 ${targetId}:`, position);
    }
  },
  on_remove: (entityId, relations) => {
    console.log(`实体 ${entityId} 移除了 Position 关系`);
  },
});

// 创建实体间的关系
const entity2 = world.new();
const positionRelation = relation(PositionId, entity2);
world.set(entity, positionRelation, { x: 10, y: 20 });
world.sync(); // 通配符钩子会被触发

// 不再需要时移除钩子
unhook();
```

### Exclusive Relations

ECS 支持 Exclusive Relations，确保实体对于指定的组件类型最多只能有一个关系。当添加新的关系时，会自动移除之前的所有同类型关系：

```typescript
import { World, component, relation } from "@codehz/ecs";

// 定义组件ID，设置为独占关系
const ChildOf = component({ exclusive: true }); // 空组件，用于关系

// 创建世界
const world = new World();

// 创建实体
const child = world.new();
const parent1 = world.new();
const parent2 = world.new();

// 添加第一个关系
world.set(child, relation(ChildOf, parent1));
world.sync();
console.log(world.has(child, relation(ChildOf, parent1))); // true

// 添加第二个关系 - 会自动移除第一个
world.set(child, relation(ChildOf, parent2));
world.sync();
console.log(world.has(child, relation(ChildOf, parent1))); // false
console.log(world.has(child, relation(ChildOf, parent2))); // true
```

### 运行示例

```bash
bun run demo
```

或者直接运行：

```bash
bun run examples/simple/demo.ts
```

## API 概述

### World

- `new()`: 创建新实体
- `spawn()`: 创建 EntityBuilder 用于流式实体创建
- `spawnMany(count, configure)`: 批量创建多个实体
- `exists(entity)`: 检查实体是否存在
- `set(entity, componentId, data)`: 向实体添加组件
- `get(entity, componentId)`: 获取实体的组件数据（注意：只能获取已设置的组件，使用前请先用 `has()` 检查组件是否存在）
- `has(entity, componentId)`: 检查实体是否拥有指定组件
- `remove(entity, componentId)`: 从实体移除组件
- `delete(entity)`: 销毁实体及其所有组件
- `query(componentIds)`: 快速查询具有指定组件的实体
- `createQuery(componentIds)`: 创建可重用的查询对象
- `hook(componentIds, hook, filter?)`: 注册生命周期钩子，返回卸载函数（数组形式支持可选 filter）
- `serialize()`: 序列化世界状态为快照对象
- `sync()`: 执行所有延迟命令

### 序列化（快照）

库提供了对世界状态的「内存快照」序列化接口，用于保存/恢复实体与组件的数据。注意关键点：

- `world.serialize()` 返回一个内存中的快照对象（snapshot），快照会按引用保存组件的实际值；它不会对数据做 JSON.stringify 操作，也不会尝试把组件值转换为可序列化格式。
- `new World(snapshot)` 通过构造函数接受由 `world.serialize()` 生成的快照对象并重建世界状态。它期望一个内存对象（非 JSON 字符串）。

为什么采用这种设计？很多情况下组件值可能包含函数、类实例、循环引用或其他无法用 JSON 表示的值。库不对组件值强行进行序列化/字符串化，以避免数据丢失或不可信的自动转换。

示例：内存回环（component 值可为任意对象）

```ts
// 获取快照（内存对象）
const snapshot = world.serialize();

// 在同一进程内直接恢复
const restored = new World(snapshot);
```

持久化到磁盘或跨进程传输

如果你需要把世界保存到文件或通过网络传输，需要自己实现组件值的编码/解码策略：

1. 使用 `World.serialize()` 得到 snapshot。
2. 对 snapshot 中的组件值逐项进行可自定义的编码（例如将类实例转成纯数据、把函数替换为标识符，或使用自定义二进制编码）。
3. 将编码后的对象字符串化并持久化。恢复时执行相反的解码步骤，得到与 `World.serialize()` 兼容的快照对象，然后调用 `World.deserialize(decodedSnapshot)`。

简单示例：当组件值都是 JSON-友好时

```ts
const snapshot = world.serialize();
// 如果组件值都可 JSON 化，可以直接 stringify
const text = JSON.stringify(snapshot);
// 写入文件或发送到网络

// 恢复：parse -> deserialize
const parsed = JSON.parse(text);
const restored = new World(parsed);
```

示例：带自定义编码的持久化（伪代码）

```ts
const snapshot = world.serialize();

// 将组件值编码为可持久化格式
const encoded = {
  ...snapshot,
  entities: snapshot.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myEncode(c.value) })),
  })),
};

// 持久化 encoded（JSON.stringify / 二进制写入等）

// 恢复时解码回原始组件值
const decoded = /* parse file and decode */ encoded;
const readySnapshot = {
  ...decoded,
  entities: decoded.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myDecode(c.value) })),
  })),
};

const restored = new World(readySnapshot);
```

注意事项

- **重要警告**：`get()` 方法只能获取实体已设置的组件。如果尝试获取不存在的组件，会抛出错误。由于 `undefined` 是组件的有效值，不能使用 `get()` 的返回值是否为 `undefined` 来判断组件是否存在。请在使用 `get()` 之前先用 `has()` 方法检查组件是否存在。
- 快照只包含实体、组件、以及 `EntityIdManager` 的分配器状态（用于保留下一次分配的 ID）；并不会自动恢复查询缓存或生命周期钩子。恢复后应由应用负责重新注册钩子。
- 若需要跨版本兼容，建议在持久化格式中包含 `version` 字段，并在恢复时进行格式兼容性检查与迁移。

### Entity

- `component<T>(id)`: 分配类型安全的组件ID（上限：1022个）

### Query

- `forEach(componentIds, callback)`: 遍历匹配的实体，为每个实体调用回调函数
- `getEntities()`: 获取所有匹配实体的ID列表
- `getEntitiesWithComponents(componentIds)`: 获取实体及其组件数据的对象数组
- `iterate(componentIds)`: 返回一个生成器，用于遍历匹配的实体及其组件数据
- `getComponentData(componentType)`: 获取指定组件类型的所有匹配实体的数据数组
- `dispose()`: 释放查询资源，停止接收世界更新通知

### EntityBuilder

EntityBuilder 提供流式 API 用于便捷的实体创建：

- `with(componentId, value?)`: 添加组件到构建器（对于 `void` 类型组件，value 参数可省略）
- `withRelation(componentId, targetEntity, value?)`: 添加关系组件到构建器（对于 `void` 类型关系，value 参数可省略）
- `build()`: 创建实体并应用所有组件（需要手动调用 `world.sync()`）

### World

从 v0.4.0 开始，本库移除了内置的 `System` 和 `SystemScheduler` 功能。推荐使用 `@codehz/pipeline` 作为替代方案来组织游戏循环逻辑。

### 为什么移除 System？

- **简化库的维护**：System 调度器增加了代码复杂度，但其功能可以通过更通用的 pipeline 模式实现
- **更灵活的执行控制**：Pipeline 模式允许更细粒度的控制，支持异步操作和条件执行
- **更好的关注点分离**：ECS 库专注于实体和组件管理，系统调度由外部库处理

### 迁移示例

**旧代码（使用 System）**：

```typescript
import { World, component } from "@codehz/ecs";
import type { System } from "@codehz/ecs";

class MovementSystem implements System<[deltaTime: number]> {
  private query: Query;

  constructor(world: World<[deltaTime: number]>) {
    this.query = world.createQuery([PositionId, VelocityId]);
  }

  update(deltaTime: number): void {
    this.query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * deltaTime;
      position.y += velocity.y * deltaTime;
    });
  }
}

const world = new World<[deltaTime: number]>();
world.registerSystem(new MovementSystem(world));
world.update(0.016); // 自动调用 sync()
```

**新代码（使用 Pipeline）**：

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
  // 重要：world.sync() 必须作为最后一个 pass 调用，以还原之前 world.update() 的自动提交行为
  .addPass(() => {
    world.sync();
  })
  .build();

gameLoop({ deltaTime: 0.016 });
```

### 关键变化

1. **移除泛型参数**：`World` 不再需要 `UpdateParams` 泛型参数
2. **移除的方法**：`registerSystem()` 和 `update()` 方法已移除
3. **手动调用 sync()**：之前 `world.update()` 会自动调用 `sync()`，现在需要在 pipeline 末尾显式调用
4. **执行顺序**：Pass 的执行顺序由添加顺序决定，无需手动声明依赖关系

### 安装 Pipeline

```bash
bun add @codehz/pipeline
```

## 性能特点

- **Archetype 系统**：实体按组件组合分组，实现连续内存访问
- **缓存查询**：查询结果自动缓存，减少重复计算
- **命令缓冲区**：延迟执行组件添加/移除，提高批处理效率
- **类型安全**：编译时类型检查，无运行时开销

## 开发

### 运行测试

```bash
bun test
```

### 类型检查

```bash
bunx tsc --noEmit
```

## 项目结构

```
src/
├── index.ts              # 入口文件
├── entity.ts             # 实体和组件管理
├── world.ts              # 世界管理
├── archetype.ts          # Archetype 系统（高效组件存储）
├── query.ts              # 查询系统
├── query-filter.ts       # 查询过滤器
├── command-buffer.ts     # 命令缓冲区
├── types.ts              # 类型定义
├── utils.ts              # 工具函数
├── *.test.ts             # 单元测试
├── query.example.ts      # 查询示例
└── *.perf.test.ts        # 性能测试

examples/
├── simple/
│   ├── demo.ts           # 基本示例
│   └── README.md         # 示例说明
└── advanced-scheduling/
    └── demo.ts           # Pipeline 调度示例

scripts/
├── build.ts             # 构建脚本
└── release.ts           # 发布脚本
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
