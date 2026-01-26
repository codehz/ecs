import { World, component } from "../index";

// 定义组件类型
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// 创建组件ID
const positionComponent = component<Position>();
const velocityComponent = component<Velocity>();
const healthComponent = component<Health>();

// 创建世界
const world = new World();

// 创建一些实体
const player = world.new();
const enemy1 = world.new();
const enemy2 = world.new();

// 添加组件
world.set(player, positionComponent, { x: 0, y: 0 });
world.set(player, velocityComponent, { x: 1, y: 1 });
world.set(player, healthComponent, { value: 100 });

world.set(enemy1, positionComponent, { x: 10, y: 10 });
world.set(enemy1, velocityComponent, { x: -0.5, y: -0.5 });

world.set(enemy2, positionComponent, { x: 20, y: 20 });
world.set(enemy2, healthComponent, { value: 50 });

// 创建查询
const movingEntitiesQuery = world.createQuery([positionComponent, velocityComponent]);
const healthEntitiesQuery = world.createQuery([healthComponent]);

console.log("=== 移动实体查询 ===");

// 方法1: 获取实体ID列表
const movingEntityIds = movingEntitiesQuery.getEntities();
console.log("移动实体IDs:", movingEntityIds);

// 方法2: 获取实体及其组件数据
const movingEntitiesWithData = movingEntitiesQuery.getEntitiesWithComponents([positionComponent, velocityComponent]);
console.log("移动实体及数据:");
movingEntitiesWithData.forEach(({ entity, components }) => {
  const [position, velocity] = components;
  console.log(`实体 ${entity}: 位置(${position.x}, ${position.y}), 速度(${velocity.x}, ${velocity.y})`);
});

// 方法3: 使用forEach遍历
console.log("\n使用forEach遍历:");
movingEntitiesQuery.forEach([positionComponent, velocityComponent], (entity, position, velocity) => {
  console.log(`实体 ${entity}: 位置(${position.x}, ${position.y}), 速度(${velocity.x}, ${velocity.y})`);
});

// 方法4: 获取特定组件的所有数据
const allPositions = movingEntitiesQuery.getComponentData(positionComponent);
const allVelocities = movingEntitiesQuery.getComponentData(velocityComponent);
console.log("\n所有位置:", allPositions);
console.log("所有速度:", allVelocities);

console.log("\n=== 生命值实体查询 ===");

// 查询有生命值的实体
const healthEntities = healthEntitiesQuery.getEntitiesWithComponents([healthComponent]);
console.log("有生命值的实体:");
healthEntities.forEach(({ entity, components }) => {
  const [health] = components;
  console.log(`实体 ${entity}: 生命值 ${health.value}`);
});

// 清理查询
movingEntitiesQuery.dispose();
healthEntitiesQuery.dispose();

console.log("\n查询已清理完毕");
