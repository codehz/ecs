# @codehz/ecs

一个高性能的Entity Component System (ECS) 库，使用 TypeScript 和 Bun 运行时构建。

## 特性

- 🚀 高性能：基于 Archetype 的组件存储和高效的查询系统
- 🔧 类型安全：完整的 TypeScript 支持
- 🏗️ 模块化：清晰的架构，支持自定义系统和组件
- 📦 轻量级：零依赖，易于集成
- ⚡ 内存高效：连续内存布局，优化的迭代性能
- 🎣 生命周期钩子：支持组件和通配符关系的事件监听
- 🔄 系统调度：支持系统依赖关系和拓扑排序执行

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
const entity = world.createEntity();
world.addComponent(entity, PositionId, { x: 0, y: 0 });
world.addComponent(entity, VelocityId, { x: 1, y: 0.5 });

// 应用更改
world.flushCommands();

// 创建查询并更新
const query = world.createQuery([PositionId, VelocityId]);
const deltaTime = 1.0 / 60.0; // 假设60FPS
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  position.x += velocity.x * deltaTime;
  position.y += velocity.y * deltaTime;
});
```

### 组件生命周期钩子

ECS 支持在组件添加或移除时执行回调函数：

```typescript
// 注册组件生命周期钩子
world.registerLifecycleHook(PositionId, {
  onAdded: (entityId, componentType, component) => {
    console.log(`组件 ${componentType} 被添加到实体 ${entityId}`);
  },
  onRemoved: (entityId, componentType) => {
    console.log(`组件 ${componentType} 被从实体 ${entityId} 移除`);
  },
});

// 你也可以只注册其中一个钩子
world.registerLifecycleHook(VelocityId, {
  onRemoved: (entityId, componentType) => {
    console.log(`组件 ${componentType} 被从实体 ${entityId} 移除`);
  },
});

// 添加组件时会触发钩子
world.addComponent(entity, PositionId, { x: 0, y: 0 });
world.flushCommands(); // 钩子在这里被调用
```

### 通配符关系生命周期钩子

ECS 还支持通配符关系生命周期钩子，可以监听特定组件的所有关系变化：

```typescript
import { World, component, relation } from "@codehz/ecs";

// 定义组件类型
type Position = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>(1);

// 创建世界
const world = new World();

// 创建实体
const entity = world.createEntity();

// 创建通配符关系ID，用于监听所有 Position 相关的关系
const wildcardPositionRelation = relation(PositionId, "*");

// 注册通配符关系钩子
world.registerLifecycleHook(wildcardPositionRelation, {
  onAdded: (entityId, componentType, component) => {
    console.log(`关系组件 ${componentType} 被添加到实体 ${entityId}`);
  },
  onRemoved: (entityId, componentType) => {
    console.log(`关系组件 ${componentType} 被从实体 ${entityId} 移除`);
  },
});

// 创建实体间的关系
const entity2 = world.createEntity();
const positionRelation = relation(PositionId, entity2);
world.addComponent(entity, positionRelation, { x: 10, y: 20 });
world.flushCommands(); // 通配符钩子会被触发
```

### Exclusive Relations

ECS 支持 Exclusive Relations，确保实体对于指定的组件类型最多只能有一个关系。当添加新的关系时，会自动移除之前的所有同类型关系：

```typescript
import { World, component, relation } from "@codehz/ecs";

// 定义组件ID
const ChildOf = component(); // 空组件，用于关系

// 创建世界
const world = new World();

// 设置 ChildOf 为独占关系
world.setExclusive(ChildOf);

// 创建实体
const child = world.createEntity();
const parent1 = world.createEntity();
const parent2 = world.createEntity();

// 添加第一个关系
world.addComponent(child, relation(ChildOf, parent1));
world.flushCommands();
console.log(world.hasComponent(child, relation(ChildOf, parent1))); // true

// 添加第二个关系 - 会自动移除第一个
world.addComponent(child, relation(ChildOf, parent2));
world.flushCommands();
console.log(world.hasComponent(child, relation(ChildOf, parent1))); // false
console.log(world.hasComponent(child, relation(ChildOf, parent2))); // true
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

- `createEntity()`: 创建新实体
- `addComponent(entity, componentId, data)`: 向实体添加组件
- `removeComponent(entity, componentId)`: 从实体移除组件
- `setExclusive(componentId)`: 将组件标记为独占关系
- `createQuery(componentIds)`: 创建查询
- `registerSystem(system)`: 注册系统
- `registerLifecycleHook(componentId, hook)`: 注册组件或通配符关系生命周期钩子
- `unregisterLifecycleHook(componentId, hook)`: 注销组件或通配符关系生命周期钩子
- `update(deltaTime)`: 更新世界
- `flushCommands()`: 应用命令缓冲区

### Entity

- `component<T>(id)`: 分配类型安全的组件ID（上限：1022个）

### Query

- `forEach(componentIds, callback)`: 遍历匹配的实体
- `getEntities()`: 获取所有匹配实体的ID列表
- `getEntitiesWithComponents(componentIds)`: 获取实体及其组件数据

### System

实现 `System` 接口来创建自定义系统：

```typescript
class MySystem implements System {
  update(world: World, deltaTime: number): void {
    // 系统逻辑
  }
}
```

系统支持依赖关系排序，确保正确的执行顺序：

```typescript
// 注册系统时指定依赖
world.registerSystem(inputSystem);
world.registerSystem(movementSystem, [inputSystem]); // movementSystem 依赖 inputSystem
world.registerSystem(renderSystem, [movementSystem]); // renderSystem 依赖 movementSystem
```

系统将按照拓扑排序执行，依赖系统始终在被依赖系统之前运行。

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
├── system.ts             # 系统接口
├── system-scheduler.ts   # 系统调度器
├── command-buffer.ts     # 命令缓冲区
├── types.ts              # 类型定义
├── utils.ts              # 工具函数
├── *.test.ts             # 单元测试
├── query.example.ts      # 查询示例
└── *.perf.test.ts        # 性能测试

examples/
└── simple/
    ├── demo.ts           # 基本示例
    └── README.md         # 示例说明

scripts/
├── build.ts             # 构建脚本
└── release.ts           # 发布脚本
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
