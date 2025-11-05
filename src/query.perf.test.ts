import { World, component } from "./index";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// 创建组件ID
const positionComponent = component<Position>();
const velocityComponent = component<Velocity>();
const healthComponent = component<Health>();

// 性能测试函数
function performanceTest() {
  console.log("=== Query Performance Test ===");

  const world = new World();

  // 创建大量实体
  console.log("Creating 1000 entities...");
  const startCreate = performance.now();

  for (let i = 0; i < 1000; i++) {
    const entity = world.new();

    // 添加位置组件
    world.set(entity, positionComponent, {
      x: Math.random() * 100,
      y: Math.random() * 100,
    });

    // 50%的实体有速度组件
    if (i % 2 === 0) {
      world.set(entity, velocityComponent, {
        x: Math.random() - 0.5,
        y: Math.random() - 0.5,
      });
    }

    // 25%的实体有生命值组件
    if (i % 4 === 0) {
      world.set(entity, healthComponent, {
        value: Math.floor(Math.random() * 100) + 1,
      });
    }
  }

  world.sync();

  const endCreate = performance.now();
  console.log(`Entity creation time: ${(endCreate - startCreate).toFixed(2)}ms`);

  // 创建查询
  const positionVelocityQuery = world.createQuery([positionComponent, velocityComponent]);
  const healthQuery = world.createQuery([healthComponent]);

  // 测试getEntitiesWithComponents性能
  console.log("\nTesting getEntitiesWithComponents performance...");
  const iterations = 100;

  let totalTime = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const entities = positionVelocityQuery.getEntitiesWithComponents([positionComponent, velocityComponent]);
    const end = performance.now();
    totalTime += end - start;
  }
  console.log(`Average getEntitiesWithComponents time: ${(totalTime / iterations).toFixed(4)}ms`);

  // 测试forEach性能
  totalTime = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    positionVelocityQuery.forEach([positionComponent, velocityComponent], (entity, position, velocity) => {
      // 空操作，只是为了测量遍历性能
    });
    const end = performance.now();
    totalTime += end - start;
  }
  console.log(`Average forEach time: ${(totalTime / iterations).toFixed(4)}ms`);

  // 验证结果正确性
  const entitiesWithData = positionVelocityQuery.getEntitiesWithComponents([positionComponent, velocityComponent]);
  console.log(`\nFound ${entitiesWithData.length} entities with position and velocity`);

  let forEachCount = 0;
  positionVelocityQuery.forEach([positionComponent, velocityComponent], () => {
    forEachCount++;
  });
  console.log(`forEach iterated over ${forEachCount} entities`);

  // 清理
  positionVelocityQuery.dispose();
  healthQuery.dispose();

  console.log("\nPerformance test completed!");
}

performanceTest();
