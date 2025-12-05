import { component } from "../../src/entity";
import type { Query } from "../../src/query";
import type { System } from "../../src/system";
import { World } from "../../src/world";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// 定义组件ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const HealthId = component<Health>();

// 输入系统 - 处理用户输入
class InputSystem implements System<[deltaTime: number]> {
  readonly dependencies: readonly System<[deltaTime: number]>[] = [];

  update(_deltaTime: number): void {
    console.log(`[InputSystem] Processing input at ${Date.now()}`);
    // 这里可以处理键盘/鼠标输入等
  }
}

// 移动系统 - 依赖输入系统
class MovementSystem implements System<[deltaTime: number]> {
  readonly dependencies: readonly System<[deltaTime: number]>[];
  private query: Query;

  constructor(world: World<[deltaTime: number]>, inputSystem: InputSystem) {
    this.dependencies = [inputSystem];
    this.query = world.createQuery([PositionId, VelocityId]);
  }

  update(deltaTime: number): void {
    console.log(`[MovementSystem] Updating positions`);

    this.query.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * deltaTime;
      position.y += velocity.y * deltaTime;
      console.log(`  Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  }
}

// 伤害系统 - 依赖移动系统
class DamageSystem implements System<[deltaTime: number]> {
  readonly dependencies: readonly System<[deltaTime: number]>[];
  private query: Query;

  constructor(world: World<[deltaTime: number]>, movementSystem: MovementSystem) {
    this.dependencies = [movementSystem];
    this.query = world.createQuery([PositionId, HealthId]);
  }

  update(_deltaTime: number): void {
    console.log(`[DamageSystem] Applying damage based on position`);

    this.query.forEach([PositionId, HealthId], (entity, position, health) => {
      // 根据位置计算伤害（示例逻辑）
      const damage = Math.abs(position.x) * 0.1;
      health.value -= damage;
      console.log(`  Entity ${entity}: Health reduced by ${damage.toFixed(2)}, now ${health.value.toFixed(2)}`);
    });
  }
}

// 渲染系统 - 依赖所有其他系统最后执行
class RenderSystem implements System<[deltaTime: number]> {
  readonly dependencies: readonly System<[deltaTime: number]>[];
  private query: Query;

  constructor(world: World<[deltaTime: number]>, damageSystem: DamageSystem) {
    this.dependencies = [damageSystem];
    this.query = world.createQuery([PositionId]);
  }

  update(_deltaTime: number): void {
    console.log(`[RenderSystem] Rendering entities`);

    this.query.forEach([PositionId], (entity, position) => {
      console.log(`  Rendering Entity ${entity} at (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  }
}

function main() {
  console.log("ECS Advanced Scheduling Demo - System Dependencies");
  console.log("=================================================");

  const world = new World<[deltaTime: number]>();

  // 创建系统实例
  const inputSystem = new InputSystem();
  const movementSystem = new MovementSystem(world, inputSystem);
  const damageSystem = new DamageSystem(world, movementSystem);
  const renderSystem = new RenderSystem(world, damageSystem);

  // 注册系统并指定依赖关系
  // 输入系统没有依赖
  world.registerSystem(inputSystem);

  // 移动系统依赖输入系统
  world.registerSystem(movementSystem);

  // 伤害系统依赖移动系统
  world.registerSystem(damageSystem);

  // 渲染系统依赖伤害系统（确保所有更新都完成后才渲染）
  world.registerSystem(renderSystem);

  // 创建一些实体
  const entity1 = world.new();
  world.set(entity1, PositionId, { x: 0, y: 0 });
  world.set(entity1, VelocityId, { x: 2, y: 1 });
  world.set(entity1, HealthId, { value: 100 });

  const entity2 = world.new();
  world.set(entity2, PositionId, { x: 5, y: 3 });
  world.set(entity2, VelocityId, { x: -1, y: 0.5 });
  world.set(entity2, HealthId, { value: 80 });

  // 运行几帧
  console.log("\n--- Frame 1 ---");
  world.update(1.0);

  console.log("\n--- Frame 2 ---");
  world.update(1.0);

  console.log("\nDemo completed!");
}

if (import.meta.main) {
  main();
}
