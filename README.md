# @codehz/ecs

> **English version:** [README.en.md](./README.en.md)

一个高性能的 Entity Component System (ECS) 库，使用 TypeScript 和 Bun 运行时构建。

## 特性

- 🚀 高性能：基于 Archetype 的组件存储和高效的查询系统
- 🔧 类型安全：完整的 TypeScript 支持
- 🏗️ 模块化：清晰的架构，支持自定义组件
- 📦 轻量级：零依赖，易于集成
- ⚡ 内存高效：连续内存布局，优化的迭代性能
- 🎣 生命周期钩子：支持多组件和通配符关系的事件监听

## 安装

```bash
bun install
```

## 用法

### 基本示例

```typescript
import { World, component } from "@codehz/ecs";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件 ID（自动分配）
const PositionId = component<Position>();
const VelocityId = component<Velocity>();

// 创建世界
const world = new World();

// 创建实体并设置组件（所有更改缓冲到 sync() 时应用）
const entity = world.new();
world.set(entity, PositionId, { x: 0, y: 0 });
world.set(entity, VelocityId, { x: 1, y: 0.5 });
world.sync();

// 创建可重用的查询
const query = world.createQuery([PositionId, VelocityId]);

// 更新循环
const deltaTime = 1.0 / 60.0;
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  position.x += velocity.x * deltaTime;
  position.y += velocity.y * deltaTime;
});
```

### 定义组件（ID 自动分配）

`component()` 自动从全局分配器中分配一个唯一 ID，也可以指定名称或选项：

```typescript
import { component } from "@codehz/ecs";

// 无参自动分配 ID
const Position = component<Position>();

// 指定名称（序列化时可读）
const Velocity = component<Velocity>("Velocity");

// 带选项的组件（关系专用）
const ChildOf = component({ exclusive: true, name: "ChildOf" });
```

**`ComponentOptions` 选项：**

| 选项            | 类型                | 说明                                                                           |
| --------------- | ------------------- | ------------------------------------------------------------------------------ |
| `name`          | `string`            | 组件名称，用于序列化/调试                                                      |
| `exclusive`     | `boolean`           | 仅关系组件：同一实体对同一基础组件最多只能有一个关系                           |
| `cascadeDelete` | `boolean`           | 仅实体关系：删除目标实体时，引用该实体的实体也会被删除（级联删除）             |
| `dontFragment`  | `boolean`           | 仅关系组件：不同目标实体的关系存放在同一 Archetype，防止因目标不同而过度碎片化 |
| `merge`         | `(prev, next) => T` | 在同一 sync 批次中对同一组件反复 `set()` 时的合并策略                          |

### 生命周期钩子

`world.hook()` 使用组件数组注册多组件生命周期钩子：

```typescript
// 返回卸载函数
const unhook = world.hook([PositionId, VelocityId], {
  on_init: (entityId, position, velocity) => {
    // 钩子注册时，为每个已同时满足条件的实体调用
  },
  on_set: (entityId, position, velocity) => {
    // 当实体「进入」匹配集合时调用（添加/更新组件后）
  },
  on_remove: (entityId, position, velocity) => {
    // 当实体「退出」匹配集合时调用（移除组件或删除实体后）
  },
});
// 卸载钩子
unhook();
```

也支持回调简写形式：

```typescript
const unhook = world.hook([PositionId, VelocityId], (type, entityId, position, velocity) => {
  if (type === "init") console.log("初始化");
  if (type === "set") console.log("设置");
  if (type === "remove") console.log("移除");
});
```

可选组件与过滤器：

```typescript
// 可选组件：即使 Velocity 不存在也会触发钩子
world.hook([PositionId, { optional: VelocityId }], {
  on_set: (entityId, position, velocity) => {
    if (velocity !== undefined) {
      console.log("拥有速度和位置");
    } else {
      console.log("仅拥有位置");
    }
  },
});

// 过滤器：排除带有指定负面组件的实体
const DisabledId = component<void>();
world.hook(
  [PositionId, VelocityId],
  {
    on_set: (entityId, position, velocity) => console.log("进入匹配集合"),
    on_remove: (entityId, position, velocity) => console.log("退出匹配集合"),
  },
  { negativeComponentTypes: [DisabledId] },
);
```

### 关系组件

```typescript
import { World, component, relation } from "@codehz/ecs";

const ChildOf = component<void>({ exclusive: true });
const world = new World();
const child = world.new();
const parent1 = world.new();
const parent2 = world.new();

// 添加关系
world.set(child, relation(ChildOf, parent1));
world.sync();

// 独占关系：添加新关系时自动移除旧关系
world.set(child, relation(ChildOf, parent2));
world.sync();
console.log(world.has(child, relation(ChildOf, parent1))); // false
console.log(world.has(child, relation(ChildOf, parent2))); // true
```

### 通配符关系钩子

```typescript
import { World, component, relation } from "@codehz/ecs";
const PositionId = component<Position>();

const world = new World();
const wildcardPos = relation(PositionId, "*");

// 监听所有该类型关系的变动
world.hook([wildcardPos], {
  on_set: (entityId, relations) => {
    for (const [targetId, position] of relations) {
      console.log(`实体 ${entityId} -> 目标 ${targetId}:`, position);
    }
  },
  on_remove: (entityId, relations) => {
    console.log(`实体 ${entityId} 移除了所有 Position 关系`);
  },
});
```

### EntityBuilder 流式创建

```typescript
const entity = world
  .spawn()
  .with(Position, { x: 0, y: 0 })
  .with(Marker) // void 组件无需传值
  .withRelation(ChildOf, parentEntity)
  .build();
world.sync(); // 统一应用
```

### 批量创建

```typescript
const entities = world.spawnMany(100, (builder, index) => builder.with(Position, { x: index * 10, y: 0 }));
world.sync();
```

### 运行示例

```bash
bun run examples/simple/demo.ts
bun run examples/advanced-scheduling/demo.ts
```

## API 概述

### World

| 方法                                  | 说明                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `new<T>()`                            | 创建新实体，返回 `EntityId<T>`                                                      |
| `create<T>()`                         | `new()` 的语义别名                                                                  |
| `spawn()`                             | 返回 `EntityBuilder` 用于流式创建                                                   |
| `spawnMany(count, configure)`         | 批量创建多个实体                                                                    |
| `exists(entity)`                      | 检查实体是否存在                                                                    |
| `set(entity, componentId, data?)`     | 添加/更新组件（缓冲，`sync()` 后生效）。对 `void` 组件可不传 data                   |
| `set(componentId, data)`              | 单例组件简写：`world.set(GlobalConfig, { ... })`                                    |
| `get(entity, componentId?)`           | 获取组件数据。**若组件不存在会抛出异常**，请先用 `has()` 检查或使用 `getOptional()` |
| `getOptional(entity, componentId?)`   | 安全获取组件，返回 `{ value: T } \| undefined`                                      |
| `has(entity, componentId?)`           | 检查组件是否存在                                                                    |
| `remove(entity, componentId?)`        | 移除组件（缓冲），也有单例简写                                                      |
| `delete(entity)`                      | 销毁实体及其所有组件（缓冲）                                                        |
| `query(componentIds)`                 | 快速查询（不缓存）                                                                  |
| `query(componentIds, true)`           | 快速查询并返回实体及组件数据                                                        |
| `createQuery(componentIds, filter?)`  | 创建可重用的缓存查询                                                                |
| `releaseQuery(query)`                 | 释放查询（可选清理）                                                                |
| `hook(componentTypes, hook, filter?)` | 注册生命周期钩子，返回卸载函数                                                      |
| `serialize()`                         | 序列化世界状态为快照对象                                                            |
| `sync()`                              | 执行所有延迟命令                                                                    |

### Query

查询通过 `world.createQuery()` 创建，应**跨帧复用**以获得最佳性能。

| 方法                                | 说明                                     |
| ----------------------------------- | ---------------------------------------- |
| `forEach(componentTypes, callback)` | 遍历匹配实体                             |
| `getEntities()`                     | 获取所有匹配实体的 ID 列表               |
| `getEntitiesWithComponents(types)`  | 获取实体及组件数据的对象数组             |
| `iterate(types)`                    | 返回生成器，用于 `for...of` 遍历         |
| `getComponentData(type)`            | 获取所有匹配实体的单组件数据数组         |
| `dispose()`                         | 释放查询（引用计数减一，归零时完全释放） |
| `get disposed()`                    | 检查查询是否已释放                       |

### QueryFilter

```typescript
interface QueryFilter {
  negativeComponentTypes?: EntityId<any>[]; // 排除的组件
}
```

### EntityBuilder

| 方法                                         | 说明                                         |
| -------------------------------------------- | -------------------------------------------- |
| `with(componentId, ...args)`                 | 添加普通组件。`void` 类型不传值              |
| `withRelation(componentId, target, ...args)` | 添加关系组件。`void` 类型不传值              |
| `build()`                                    | 创建实体并返回 `EntityId`（仍需要 `sync()`） |

### component()

```typescript
// 自动分配 ID
component<T>();
// 指定名称
component<T>("Name");
// 带选项
component<T>({ name?: string, exclusive?: boolean, cascadeDelete?: boolean, dontFragment?: boolean, merge?: (prev, next) => T });
```

### relation()

```typescript
// 创建关系 ID
relation(componentId, targetEntity);
// 通配符（查询所有目标）
relation(componentId, "*");
// 单例目标（关联到另一个组件）
relation(componentId, otherComponentId);
```

### 组件 / 实体 ID 规则

- 组件 ID：`1` ~ `1023`
- 实体 ID：`1024+`
- 关系 ID：负数编码 `-(componentId * 2^42 + targetId)`

## 序列化（快照）

库提供对世界状态的「内存快照」序列化接口，用于保存/恢复实体与组件数据。

```typescript
// 创建快照（内存对象）
const snapshot = world.serialize();

// 在同一进程内直接恢复
const restored = new World(snapshot);
```

**设计要点：**

- `world.serialize()` 返回内存快照对象，**不会**对组件值执行 `JSON.stringify`，也不会尝试将组件值转换为可序列化格式。
- `new World(snapshot)` 是反序列化的唯一入口（没有 `World.deserialize()` 静态方法）。
- 快照包含实体、组件以及 `EntityIdManager` 分配器状态（保留下一次分配的 ID）；**不会**自动恢复查询缓存或生命周期钩子。

**持久化示例（组件值为 JSON 友好时）：**

```typescript
const snapshot = world.serialize();
const json = JSON.stringify(snapshot);
// 写入文件或发送到网络 ...

const parsed = JSON.parse(json);
const restored = new World(parsed);
```

**自定义编码示例：**

```typescript
const snapshot = world.serialize();
const encoded = {
  ...snapshot,
  entities: snapshot.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myEncode(c.value) })),
  })),
};
// 持久化 encoded ...

// 恢复时反向解码
const decodedSnapshot = {
  ...decoded,
  entities: decoded.entities.map((e) => ({
    id: e.id,
    components: e.components.map((c) => ({ type: c.type, value: myDecode(c.value) })),
  })),
};
const restored = new World(decodedSnapshot);
```

**重要：** `get()` 在组件不存在时会抛出异常。由于 `undefined` 是组件的有效值，不能用 `get()` 的返回值是否为 `undefined` 来判断组件是否存在。请使用 `has()` 或 `getOptional()`。

## System / Pipeline 集成

从 v0.4.0 开始，库移除了内置的 `System` 和 `SystemScheduler`。推荐使用 `@codehz/pipeline` 来组织游戏循环，**务必在最后一个 pass 调用 `world.sync()`**。

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
    world.sync(); // 必须作为最后一个 pass
  })
  .build();

gameLoop({ deltaTime: 0.016 });
```

## 项目结构

```
src/
├── index.ts                 # 入口文件（统一导出）
├── core/                    # 核心实现
│   ├── world.ts             # 世界管理
│   ├── archetype.ts         # Archetype 系统（高效组件存储）
│   ├── builder.ts           # EntityBuilder 流式创建
│   ├── component-registry.ts # 组件注册表
│   ├── component-entity-store.ts # 单例组件存储
│   ├── component-type-utils.ts   # 组件类型工具
│   ├── dont-fragment-store.ts    # DontFragment 存储
│   ├── entity.ts            # 实体/组件/关系类型导出（聚合）
│   ├── entity-types.ts      # 实体 ID 类型定义与常量
│   ├── entity-relation.ts   # 关系 ID 编码/解码
│   ├── entity-manager.ts    # ID 分配器
│   ├── query-registry.ts    # 查询注册表
│   ├── serialization.ts     # 序列化 ID 编解码
│   ├── world-serialization.ts # 世界序列化/反序列化
│   ├── world-commands.ts    # 世界命令
│   ├── world-hooks.ts       # 钩子执行逻辑
│   ├── world-references.ts  # 实体引用追踪
│   └── types.ts             # 类型定义
├── query/                   # 查询系统
│   ├── query.ts             # Query 类
│   └── filter.ts            # 查询过滤器
├── commands/                # 命令缓冲区
├── utils/                   # 工具函数
├── testing/                 # 测试工具
└── __tests__/               # 单元测试 & 性能测试

examples/
├── simple/
│   ├── demo.ts              # 基本示例
│   └── README.md            # 示例说明
└── advanced-scheduling/
    └── demo.ts              # Pipeline 调度示例

scripts/
├── build.ts                 # 构建脚本
└── release.ts               # 发布脚本
```

## 开发

```bash
bun install
bun test                    # 运行测试
bunx tsc --noEmit           # 类型检查
bun run examples/simple/demo.ts  # 运行示例
bun run scripts/build.ts    # 构建
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
