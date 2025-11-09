import { component, relation } from "../../src/entity";
import type { Query } from "../../src/query";
import type { System } from "../../src/system";
import { World } from "../../src/world";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// 定义组件ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const ChildOf = component(); // Exclusive relation component

// 移动系统
class MovementSystem implements System<[deltaTime: number]> {
  private query: Query; // 缓存查询

  constructor(world: World<[deltaTime: number]>) {
    // 在构造函数中预先创建并缓存查询
    this.query = world.createQuery([PositionId, VelocityId]);
  }

  update(deltaTime: number): void {
    // 使用缓存的查询的forEach方法，直接获取组件数据
    this.query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      // 更新位置
      position.x += velocity.x * deltaTime;
      position.y += velocity.y * deltaTime;

      console.log(`Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  }
}

function main() {
  console.log("ECS Simple Demo");

  // 创建世界
  const world = new World<[deltaTime: number]>();

  // 注册系统（传递world参数）
  world.registerSystem(new MovementSystem(world));

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

  // 设置ChildOf为exclusive relation
  world.setExclusive(ChildOf);

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
    world.update(deltaTime);
  }

  // 演示组件移除钩子
  console.log("\n移除组件演示:");
  world.remove(entity1, VelocityId);
  world.sync();

  console.log("\nDemo completed!");
}

// 运行demo
main();
