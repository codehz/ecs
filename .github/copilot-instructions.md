# @codehz/ecs AI 指南

## 项目概览

- TypeScript + Bun 的高性能 ECS（Archetype 存储 + Query 缓存 + CommandBuffer 延迟结构变更）。
- 无内置 System/Scheduler；游戏循环推荐使用 `@codehz/pipeline`，并在最后一个 pass 调用 `world.sync()`。

## 关键目录

- 核心实现：src/core（world、archetype、entity、query、command-buffer）。
- 入口导出：src/index.ts 统一对外 API。
- 示例：examples/simple/demo.ts 与 examples/advanced-scheduling/demo.ts。
- 构建/发布：scripts/build.ts、scripts/release.ts。

## 运行与验证（Bun）

- 安装：bun install
- 测试：bun test（_.test.ts，性能用 _.perf.test.ts）
- 类型检查：bunx tsc --noEmit
- 示例：bun run examples/simple/demo.ts
- 构建：bun run scripts/build.ts

## 设计与数据流（必须理解）

- 结构变更（set/remove/delete/spawn/build）会进入命令缓冲区，**必须调用 `world.sync()` 才生效**。
- Query 需长期复用：通过 `world.createQuery(...)` 预创建并缓存，循环内直接 `forEach`。
- Entity/Component ID 规则：组件 ID 1–1023，实体 ID 1024+，关系 ID 为负编码（relation）。

## 易踩坑与约定

- `world.get()` 在组件不存在时抛错；`undefined` 是合法值。务必先 `has()` 或使用 `getOptional()`。
- 序列化为“内存快照”：`world.serialize()` 返回对象，`new World(snapshot)` 复原；若要持久化需自定义编码/解码。
- 关系组件：`relation(componentId, targetId)`；通配符关系用 `relation(componentId, "*")` 监听所有目标。
- 独占关系：组件声明 `exclusive: true`，同类型关系会自动互斥。

## 示例模式（来自代码库）

- Pipeline 末尾统一 `world.sync()`：见 examples/simple/demo.ts。
- 多组件/可选组件钩子：见 README.md “多组件生命周期钩子”。
- EntityBuilder：`world.spawn().with(...).build(); world.sync();`。

## 修改时需注意

- 保持公共 API：`World`、`component`、`relation` 等导出不要改名/删除。
- 入口为 ESM；允许 `.ts` 扩展导入。
- 优先在 src/core 内补充核心逻辑，在 src/index.ts 暴露新 API。
