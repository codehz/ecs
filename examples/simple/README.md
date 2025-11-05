# ECS Simple Demo

这是一个简单的Entity Component System (ECS) 演示，展示了基本的ECS概念：

- **实体 (Entities)**: 游戏对象的基本单位
- **组件 (Components)**: 实体的属性数据
- **系统 (Systems)**: 处理组件数据的逻辑
- **世界 (World)**: 管理所有实体、组件和系统的容器

## 演示内容

这个demo创建了两个实体，每个实体都有位置(Position)和速度(Velocity)组件：

- 实体1: 从 (0, 0) 开始，以 (1, 0.5) 的速度移动
- 实体2: 从 (10, 10) 开始，以 (-0.5, 1) 的速度移动

移动系统每帧更新实体的位置，并打印当前位置。

## 运行方法

确保你已经安装了Bun运行时，然后在项目根目录运行：

```bash
bun run examples/simple/demo.ts
```

## 优化说明

为了提高性能和代码简洁性，demo使用了以下优化：

- **预先缓存Query**: 在系统初始化时创建查询并缓存，而不是在每次update中重新创建。这避免了重复的查询创建开销。
- **使用forEach接口**: 使用Query的`forEach`方法直接获取组件数据，避免手动调用`world.get()`，减少函数调用开销并提高代码可读性。

## 输出示例

```
ECS Simple Demo

Update 1:
Entity 1024: Position (1.00, 0.50)
Entity 1025: Position (9.50, 11.00)

Update 2:
Entity 1024: Position (2.00, 1.00)
Entity 1025: Position (9.00, 12.00)

...
```
