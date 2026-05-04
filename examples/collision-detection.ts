import { pipeline } from "@codehz/pipeline";
import { World, component, type EntityId, type Query } from "../src";

// =============================================================================
// Component Types
// =============================================================================

type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Radius = number;
type Health = { value: number };
type CollisionEvent = { other: EntityId; overlap: number };

// =============================================================================
// Component IDs
// =============================================================================

const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const RadiusId = component<Radius>();
const HealthId = component<Health>();
const CollisionEventId = component<CollisionEvent>();

// =============================================================================
// World & Pre-cached Queries
// =============================================================================

const world = new World();

const movementQuery: Query = world.createQuery([PositionId, VelocityId]);
const collidableQuery: Query = world.createQuery([PositionId, RadiusId]);
const damagedQuery: Query = world.createQuery([HealthId]);
const collisionEventQuery: Query = world.createQuery([CollisionEventId]);

// =============================================================================
// Game Loop (Pipeline Passes)
// =============================================================================

const gameLoop = pipeline<{ deltaTime: number }>()
  // ---------------------------------------------------------------------------
  // MovementPass: Move entities by velocity * deltaTime
  // ---------------------------------------------------------------------------
  .addPass((env) => {
    console.log(`[MovementPass] deltaTime=${env.deltaTime}`);
    movementQuery.forEach([PositionId, VelocityId], (_entity, pos, vel) => {
      pos.x += vel.x * env.deltaTime;
      pos.y += vel.y * env.deltaTime;
    });
  })

  // ---------------------------------------------------------------------------
  // CollisionDetectionPass: O(n^2) pair check
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log(`[CollisionDetectionPass]`);
    const collidables = collidableQuery.getEntitiesWithComponents([PositionId, RadiusId]);
    let collisionCount = 0;

    for (let i = 0; i < collidables.length; i++) {
      const a = collidables[i]!;
      for (let j = i + 1; j < collidables.length; j++) {
        const b = collidables[j]!;
        const dx = a.components[0].x - b.components[0].x;
        const dy = a.components[0].y - b.components[0].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const overlap = a.components[1] + b.components[1] - dist;

        if (overlap > 0) {
          console.log(`  Collision: Entity ${a.entity} <-> Entity ${b.entity} ` + `(overlap: ${overlap.toFixed(2)})`);
          world.set(a.entity, CollisionEventId, { other: b.entity, overlap });
          world.set(b.entity, CollisionEventId, { other: a.entity, overlap });
          collisionCount++;
        }
      }
    }

    if (collisionCount === 0) {
      console.log(`  No collisions detected`);
    }

    // Sync so CollisionEvents are visible to the response pass
    world.sync();
  })

  // ---------------------------------------------------------------------------
  // CollisionResponsePass: Apply damage & remove transient CollisionEvent
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log(`[CollisionResponsePass]`);
    collisionEventQuery.forEach([CollisionEventId], (entity, event) => {
      if (world.has(entity, HealthId)) {
        const health = world.get(entity, HealthId);
        health.value -= event.overlap;
        console.log(
          `  Entity ${entity}: took ${event.overlap.toFixed(2)} damage ` +
            `from Entity ${event.other}, health now ${health.value.toFixed(2)}`,
        );
      } else {
        console.log(
          `  Entity ${entity}: collision with Entity ${event.other} ` + `(no Health component, skipping damage)`,
        );
      }
      world.remove(entity, CollisionEventId);
    });
  })

  // ---------------------------------------------------------------------------
  // CleanupPass: Delete dead entities (health <= 0)
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log(`[CleanupPass]`);
    const toDelete: EntityId[] = [];

    damagedQuery.forEach([HealthId], (entity, health) => {
      if (health.value <= 0) {
        console.log(`  Entity ${entity}: destroyed (health: ${health.value.toFixed(2)})`);
        toDelete.push(entity);
      }
    });

    for (const entity of toDelete) {
      world.delete(entity);
    }

    if (toDelete.length === 0) {
      console.log(`  No entities to clean up`);
    }
  })

  // ---------------------------------------------------------------------------
  // RenderPass: Log positions and health of all living entities
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log(`[RenderPass]`);
    movementQuery.forEach([PositionId, VelocityId], (entity, pos) => {
      const healthOpt = world.getOptional(entity, HealthId);
      const healthStr = healthOpt ? healthOpt.value.value.toFixed(2) : "N/A";
      console.log(`  Entity ${entity}: pos=(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}) ` + `health=${healthStr}`);
    });
  })

  // ---------------------------------------------------------------------------
  // SyncPass: Apply all remaining buffered commands
  // ---------------------------------------------------------------------------
  .addPass(() => {
    world.sync();
  })
  .build();

// =============================================================================
// Setup & Main
// =============================================================================

function main() {
  console.log("ECS Collision Detection Demo");
  console.log("============================\n");

  // Spawn ~6 entities with diverse properties
  console.log("Spawning entities...\n");

  // Entity 1: Fast mover, small radius, moderate health
  world
    .spawn()
    .with(PositionId, { x: 0, y: 0 })
    .with(VelocityId, { x: 3, y: 1 })
    .with(RadiusId, 10)
    .with(HealthId, { value: 50 })
    .build();

  // Entity 2: Slow mover, large radius, high health
  world
    .spawn()
    .with(PositionId, { x: 30, y: 10 })
    .with(VelocityId, { x: -1.5, y: 2 })
    .with(RadiusId, 18)
    .with(HealthId, { value: 120 })
    .build();

  // Entity 3: Stationary, medium radius, low health
  world
    .spawn()
    .with(PositionId, { x: 15, y: 20 })
    .with(VelocityId, { x: 0, y: 0 })
    .with(RadiusId, 14)
    .with(HealthId, { value: 25 })
    .build();

  // Entity 4: Diagonal mover, small radius, moderate health
  world
    .spawn()
    .with(PositionId, { x: 40, y: 5 })
    .with(VelocityId, { x: -3, y: -2 })
    .with(RadiusId, 8)
    .with(HealthId, { value: 60 })
    .build();

  // Entity 5: Opposite diagonal, medium radius, high health
  world
    .spawn()
    .with(PositionId, { x: 10, y: 35 })
    .with(VelocityId, { x: 2.5, y: -1.5 })
    .with(RadiusId, 16)
    .with(HealthId, { value: 100 })
    .build();

  // Entity 6: Slow vertical mover, large radius, moderate health
  world
    .spawn()
    .with(PositionId, { x: 50, y: 25 })
    .with(VelocityId, { x: -0.5, y: 3 })
    .with(RadiusId, 20)
    .with(HealthId, { value: 80 })
    .build();

  // Apply initial spawns
  world.sync();
  console.log("All entities spawned and synced.\n");

  // Run 5 frames
  for (let frame = 1; frame <= 5; frame++) {
    console.log(`--- Frame ${frame} ---`);
    gameLoop({ deltaTime: 1.0 });
    console.log();
  }

  console.log("Demo completed!");
}

main();
