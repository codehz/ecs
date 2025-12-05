import { pipeline } from "@codehz/pipeline";
import { component, relation } from "../../src/entity";
import type { Query } from "../../src/query";
import { World } from "../../src/world";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const ChildOf = component({ exclusive: true }); // Exclusive relation component

// 创建世界
const world = new World();

// 预先缓存查询
const movementQuery: Query = world.createQuery([PositionId, VelocityId]);

// 使用 pipeline 构建游戏循环
const gameLoop = pipeline<{ deltaTime: number }>()
  // Movement pass
  .addPass((env) => {
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      console.log(`Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Sync pass - 必须作为最后一个 pass 调用以执行所有延迟命令
  .addPass(() => {
    world.sync();
  })
  .build();

function main() {
  console.log("ECS Simple Demo");

  // 创建实体1
  const entity1 = world.new();
  world.set(entity1, PositionId, { x: 0, y: 0 });
  world.set(entity1, VelocityId, { x: 1, y: 0.5 });

  // 创建实体2
  const entity2 = world.new();
  world.set(entity2, PositionId, { x: 10, y: 10 });
  world.set(entity2, VelocityId, { x: -0.5, y: 1 });

  // 演示Exclusive Relations
  console.log("\nExclusive Relations Demo:");
  const parent1 = world.new();
  const parent2 = world.new();
  const child = world.new();

  // ChildOf is already marked as exclusive in component definition

  // 添加第一个parent relation
  world.set(child, relation(ChildOf, parent1));
  world.sync();
  console.log(`Child has ChildOf(parent1): ${world.has(child, relation(ChildOf, parent1))}`);
  console.log(`Child has ChildOf(parent2): ${world.has(child, relation(ChildOf, parent2))}`);

  // 添加第二个parent relation - 应该替换第一个
  world.set(child, relation(ChildOf, parent2));
  world.sync();
  console.log(`After adding ChildOf(parent2):`);
  console.log(`Child has ChildOf(parent1): ${world.has(child, relation(ChildOf, parent1))}`);
  console.log(`Child has ChildOf(parent2): ${world.has(child, relation(ChildOf, parent2))}`);

  // 注册组件钩子
  world.hook(PositionId, {
    on_set: (entityId, componentType, component) => {
      console.log(
        `组件添加钩子触发: 实体 ${entityId} 添加了 ${componentType} 组件，值为 (${component.x}, ${component.y})`,
      );
    },
  });

  world.hook(VelocityId, {
    on_remove: (entityId, componentType) => {
      console.log(`组件移除钩子触发: 实体 ${entityId} 移除了 ${componentType} 组件`);
    },
  });

  // 执行命令以应用组件添加
  world.sync();

  // 运行几个更新循环
  const deltaTime = 1.0; // 1秒
  for (let i = 0; i < 5; i++) {
    console.log(`\nUpdate ${i + 1}:`);
    gameLoop({ deltaTime });
  }

  // 演示组件移除钩子
  console.log("\n移除组件演示:");
  world.remove(entity1, VelocityId);
  world.sync();

  console.log("\nDemo completed!");
}

// 运行demo
main();
