# @codehz/ecs

一个高性能的Entity Component System (ECS) 库，使用 TypeScript 和 Bun 运行时构建。

## 特性

- 🚀 高性能：基于原型的组件存储和高效的查询系统
- 🔧 类型安全：完整的 TypeScript 支持
- 🏗️ 模块化：清晰的架构，支持自定义系统和组件
- 📦 轻量级：零依赖，易于集成

## 安装

```bash
bun install
```

## 用法

### 基本示例

```typescript
import { World } from "@codehz/ecs";
import { createComponentId } from "@codehz/ecs";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件ID
const PositionId = createComponentId<Position>(1);
const VelocityId = createComponentId<Velocity>(2);

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
query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
  position.x += velocity.x * deltaTime;
  position.y += velocity.y * deltaTime;
});
```

### 运行示例

```bash
bun run examples/simple/demo.ts
```

## API 概述

### World

- `createEntity()`: 创建新实体
- `addComponent(entity, componentId, data)`: 向实体添加组件
- `removeComponent(entity, componentId)`: 从实体移除组件
- `createQuery(componentIds)`: 创建查询
- `registerSystem(system)`: 注册系统
- `update(deltaTime)`: 更新世界
- `flushCommands()`: 应用命令缓冲区

### Entity

- `createComponentId<T>(id)`: 创建类型安全的组件ID

### Query

- `forEach(componentIds, callback)`: 遍历匹配的实体

### System

实现 `System` 接口来创建自定义系统：

```typescript
class MySystem implements System {
  update(world: World, deltaTime: number): void {
    // 系统逻辑
  }
}
```

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
├── index.ts          # 入口文件
├── entity.ts         # 实体和组件管理
├── world.ts          # 世界管理
├── archetype.ts      # 原型系统
├── query.ts          # 查询系统
├── system.ts         # 系统接口
├── command-buffer.ts # 命令缓冲区
├── types.ts          # 类型定义
└── utils.ts          # 工具函数

examples/
└── simple/
    ├── demo.ts       # 基本示例
    └── README.md     # 示例说明
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
