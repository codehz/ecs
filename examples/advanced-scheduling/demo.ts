import { pipeline } from "@codehz/pipeline";
import { World, component, type Query } from "../../src";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// 定义组件ID
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const HealthId = component<Health>();

// 创建世界
const world = new World();

// 缓存查询
const movementQuery: Query = world.createQuery([PositionId, VelocityId]);
const damageQuery: Query = world.createQuery([PositionId, HealthId]);
const renderQuery: Query = world.createQuery([PositionId]);

// 使用 pipeline 构建游戏循环
// Pass 的执行顺序由添加顺序决定，无需手动管理依赖关系
const gameLoop = pipeline<{ deltaTime: number }>()
  // Input pass - 处理用户输入
  .addPass(() => {
    console.log(`[InputPass] Processing input at ${Date.now()}`);
    // 这里可以处理键盘/鼠标输入等
  })
  // Movement pass - 更新位置
  .addPass((env) => {
    console.log(`[MovementPass] Updating positions`);
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      console.log(`  Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Damage pass - 根据位置计算伤害
  .addPass(() => {
    console.log(`[DamagePass] Applying damage based on position`);
    damageQuery.forEach([PositionId, HealthId], (entity, position, health) => {
      // 根据位置计算伤害（示例逻辑）
      const damage = Math.abs(position.x) * 0.1;
      health.value -= damage;
      console.log(`  Entity ${entity}: Health reduced by ${damage.toFixed(2)}, now ${health.value.toFixed(2)}`);
    });
  })
  // Render pass - 渲染实体
  .addPass(() => {
    console.log(`[RenderPass] Rendering entities`);
    renderQuery.forEach([PositionId], (entity, position) => {
      console.log(`  Rendering Entity ${entity} at (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Sync pass - 必须作为最后一个 pass 调用以执行所有延迟命令
  .addPass(() => {
    world.sync();
  })
  .build();

function main() {
  console.log("ECS Advanced Scheduling Demo - Pipeline-based Execution");
  console.log("========================================================");

  // 创建一些实体
  const entity1 = world.new();
  world.set(entity1, PositionId, { x: 0, y: 0 });
  world.set(entity1, VelocityId, { x: 2, y: 1 });
  world.set(entity1, HealthId, { value: 100 });

  const entity2 = world.new();
  world.set(entity2, PositionId, { x: 5, y: 3 });
  world.set(entity2, VelocityId, { x: -1, y: 0.5 });
  world.set(entity2, HealthId, { value: 80 });

  // 执行初始同步
  world.sync();

  // 运行几帧
  console.log("\n--- Frame 1 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\n--- Frame 2 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\nDemo completed!");
}

if (import.meta.main) {
  main();
}
