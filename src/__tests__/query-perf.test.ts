import { World, component } from "../index";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// Create component IDs
const positionComponent = component<Position>();
const velocityComponent = component<Velocity>();
const healthComponent = component<Health>();

// Performance test function
function performanceTest() {
  console.log("=== Query Performance Test ===");

  const world = new World();

  // Create many entities
  console.log("Creating 1000 entities...");
  const startCreate = performance.now();

  for (let i = 0; i < 1000; i++) {
    const entity = world.new();

    // Add position component
    world.set(entity, positionComponent, {
      x: Math.random() * 100,
      y: Math.random() * 100,
    });

    // 50% of entities have velocity component
    if (i % 2 === 0) {
      world.set(entity, velocityComponent, {
        x: Math.random() - 0.5,
        y: Math.random() - 0.5,
      });
    }

    // 25% of entities have health component
    if (i % 4 === 0) {
      world.set(entity, healthComponent, {
        value: Math.floor(Math.random() * 100) + 1,
      });
    }
  }

  world.sync();

  const endCreate = performance.now();
  console.log(`Entity creation time: ${(endCreate - startCreate).toFixed(2)}ms`);

  // Create queries
  const positionVelocityQuery = world.createQuery([positionComponent, velocityComponent]);
  const healthQuery = world.createQuery([healthComponent]);

  // Test getEntitiesWithComponents performance
  console.log("\nTesting getEntitiesWithComponents performance...");
  const iterations = 100;

  let totalTime = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    positionVelocityQuery.getEntitiesWithComponents([positionComponent, velocityComponent]);
    const end = performance.now();
    totalTime += end - start;
  }
  console.log(`Average getEntitiesWithComponents time: ${(totalTime / iterations).toFixed(4)}ms`);

  // Test forEach performance
  totalTime = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    positionVelocityQuery.forEach([positionComponent, velocityComponent], (_entity, _position, _velocity) => {
      // No-op, just for measuring iteration performance
    });
    const end = performance.now();
    totalTime += end - start;
  }
  console.log(`Average forEach time: ${(totalTime / iterations).toFixed(4)}ms`);

  // Verify result correctness
  const entitiesWithData = positionVelocityQuery.getEntitiesWithComponents([positionComponent, velocityComponent]);
  console.log(`\nFound ${entitiesWithData.length} entities with position and velocity`);

  let forEachCount = 0;
  positionVelocityQuery.forEach([positionComponent, velocityComponent], () => {
    forEachCount++;
  });
  console.log(`forEach iterated over ${forEachCount} entities`);

  // Cleanup
  positionVelocityQuery.dispose();
  healthQuery.dispose();

  console.log("\nPerformance test completed!");
}

performanceTest();
