import { pipeline } from "@codehz/pipeline";
import { World, component, type EntityId, type Query } from "../../src";

// =============================================================================
// Component Type Definitions
// =============================================================================

type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type GridCell = { cellX: number; cellY: number };
type SpatialGrid = { cells: Map<string, EntityId[]>; cellSize: number };

// =============================================================================
// Component ID Definitions
// =============================================================================

const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const GridCellId = component<GridCell>();
const EnemyId = component(); // void tag
const PlayerId = component(); // void tag
const ProjectileId = component(); // void tag
const DeadId = component(); // void tag (negative filter to exclude dead entities)
const SpatialGridId = component<SpatialGrid>(); // singleton component

// =============================================================================
// World & Queries
// =============================================================================

const world = new World();

// Pre-cache all queries (long-term reuse)
const movementQuery: Query = world.createQuery([PositionId, VelocityId], {
  negativeComponentTypes: [DeadId],
});
const enemyQuery: Query = world.createQuery([PositionId, EnemyId], {
  negativeComponentTypes: [DeadId],
});
const playerQuery: Query = world.createQuery([PositionId, PlayerId], {
  negativeComponentTypes: [DeadId],
});
const projectileQuery: Query = world.createQuery([PositionId, ProjectileId, VelocityId], {
  negativeComponentTypes: [DeadId],
});
const gridCellQuery: Query = world.createQuery([PositionId, GridCellId], {
  negativeComponentTypes: [DeadId],
});

// =============================================================================
// Per-frame dead-entity tracking (Dead component is buffered; sync happens at
// the end of the frame, so we use a local set for same-frame cleanup).
// =============================================================================

const newlyDead = new Set<EntityId>();

// =============================================================================
// Pipeline Passes
// =============================================================================

const gameLoop = pipeline<{ deltaTime: number }>()
  // ---------------------------------------------------------------------------
  // MovementPass — move all entities by velocity * deltaTime
  // ---------------------------------------------------------------------------
  .addPass((env) => {
    console.log("[MovementPass] Updating positions...");
    let count = 0;
    movementQuery.forEach([PositionId, VelocityId], (_entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      count++;
    });
    console.log(`  Moved ${count} entities`);
  })

  // ---------------------------------------------------------------------------
  // GridUpdatePass — rebuild spatial grid
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log("[GridUpdatePass] Rebuilding spatial grid...");
    const grid = world.get(SpatialGridId);
    const { cellSize } = grid;
    grid.cells.clear();

    let count = 0;
    gridCellQuery.forEach([PositionId, GridCellId], (_entity, position, gridCell) => {
      const cx = Math.floor(position.x / cellSize);
      const cy = Math.floor(position.y / cellSize);
      gridCell.cellX = cx;
      gridCell.cellY = cy;

      const key = `${cx},${cy}`;
      const bucket = grid.cells.get(key);
      if (bucket) {
        bucket.push(_entity);
      } else {
        grid.cells.set(key, [_entity]);
      }
      count++;
    });
    console.log(`  Grid rebuilt: ${grid.cells.size} cell(s), ${count} entity/ies`);
  })

  // ---------------------------------------------------------------------------
  // ProximityCheckPass — check if any enemy is near the player (grid-based)
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log("[ProximityCheckPass] Checking enemy-player proximity...");
    const playerEntities = playerQuery.getEntities();
    if (playerEntities.length === 0) {
      console.log("  No player found — skipping");
      return;
    }

    const playerEntity = playerEntities[0]!;
    const playerPos = world.get(playerEntity, PositionId);
    const grid = world.get(SpatialGridId);
    const { cellSize } = grid;
    const pcx = Math.floor(playerPos.x / cellSize);
    const pcy = Math.floor(playerPos.y / cellSize);

    let alerts = 0;
    enemyQuery.forEach([PositionId, EnemyId], (enemyEntity, enemyPos, _enemy) => {
      const ecx = Math.floor(enemyPos.x / cellSize);
      const ecy = Math.floor(enemyPos.y / cellSize);

      // Same or adjacent cell (3x3 neighborhood)
      if (Math.abs(ecx - pcx) <= 1 && Math.abs(ecy - pcy) <= 1) {
        console.log(
          `  ⚠ Player detected! Enemy ${enemyEntity} is nearby ` +
            `(player cell: ${pcx},${pcy} | enemy cell: ${ecx},${ecy})`,
        );
        alerts++;
      }
    });
    console.log(`  Proximity check done: ${alerts} alert(s)`);
  })

  // ---------------------------------------------------------------------------
  // ProjectileCheckPass — projectiles hit enemies in the same grid cell
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log("[ProjectileCheckPass] Checking projectile-enemy collisions...");
    const grid = world.get(SpatialGridId);
    let hits = 0;

    projectileQuery.forEach([PositionId, ProjectileId, VelocityId], (projectileEntity, _pos, _proj, _vel) => {
      const cx = Math.floor(_pos.x / grid.cellSize);
      const cy = Math.floor(_pos.y / grid.cellSize);
      const key = `${cx},${cy}`;
      const bucket = grid.cells.get(key);

      if (!bucket || bucket.length === 0) return;

      // Find an enemy in the same cell
      for (const otherEntity of bucket) {
        if (!world.has(otherEntity, EnemyId)) continue;
        if (newlyDead.has(otherEntity as EntityId)) continue; // already dead this frame

        // Hit! Mark both projectile and enemy as Dead
        world.set(projectileEntity, DeadId);
        world.set(otherEntity, DeadId);
        newlyDead.add(projectileEntity as EntityId);
        newlyDead.add(otherEntity as EntityId);
        console.log(
          `  💥 Hit! Projectile ${projectileEntity} destroyed Enemy ${otherEntity} ` + `in cell (${cx},${cy})`,
        );
        hits++;
        break; // one projectile hits at most one enemy per frame
      }
    });
    console.log(`  Projectile check done: ${hits} hit(s)`);
  })

  // ---------------------------------------------------------------------------
  // CleanupPass — delete all entities marked as Dead this frame
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log("[CleanupPass] Removing dead entities...");
    for (const entity of newlyDead) {
      world.delete(entity);
    }
    const count = newlyDead.size;
    if (count > 0) {
      console.log(`  Cleaned up ${count} dead entity/ies`);
    } else {
      console.log("  No dead entities to clean up");
    }
    newlyDead.clear();
  })

  // ---------------------------------------------------------------------------
  // RenderPass — log counts of each entity type
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log("[RenderPass] Entity counts:");
    const enemies = enemyQuery.getEntities().length;
    const players = playerQuery.getEntities().length;
    const projectiles = projectileQuery.getEntities().length;
    console.log(`  Enemies: ${enemies} | Players: ${players} | Projectiles: ${projectiles}`);
  })

  // ---------------------------------------------------------------------------
  // SyncPass — execute all buffered structural changes
  // ---------------------------------------------------------------------------
  .addPass(() => {
    world.sync();
  })
  .build();

// =============================================================================
// Setup & Main
// =============================================================================

function main() {
  console.log("ECS Spatial Grid Demo — Grid-based Proximity & Collision");
  console.log("=========================================================\n");

  // Create singleton SpatialGrid
  world.set(SpatialGridId, { cells: new Map(), cellSize: 64 });
  console.log("SpatialGrid singleton created (cellSize=64)");

  // Create 1 player near the center
  world.spawn().with(PositionId, { x: 128, y: 128 }).with(GridCellId, { cellX: 0, cellY: 0 }).with(PlayerId).build();
  console.log("Player spawned at (128, 128)");

  // Create ~5 enemies scattered across grid cells
  const enemyPositions: [number, number][] = [
    [64, 64],
    [200, 60],
    [50, 180],
    [192, 192],
    [256, 100],
  ];
  for (const [x, y] of enemyPositions) {
    world
      .spawn()
      .with(PositionId, { x, y })
      .with(GridCellId, { cellX: 0, cellY: 0 })
      .with(VelocityId, { x: Math.random() * 20 - 10, y: Math.random() * 20 - 10 })
      .with(EnemyId)
      .build();
    console.log(`Enemy spawned at (${x}, ${y})`);
  }

  // Create ~3 projectiles with velocity
  const projectileData: [number, number, number, number][] = [
    [64, 70, 30, 0],
    [128, 128, -40, 0],
    [30, 180, 50, 10],
  ];
  for (const [x, y, vx, vy] of projectileData) {
    world
      .spawn()
      .with(PositionId, { x, y })
      .with(GridCellId, { cellX: 0, cellY: 0 })
      .with(VelocityId, { x: vx, y: vy })
      .with(ProjectileId)
      .build();
    console.log(`Projectile spawned at (${x}, ${y}) with velocity (${vx}, ${vy})`);
  }

  // Execute initial sync to materialize all entities
  world.sync();
  console.log("\nInitial sync complete. Starting simulation...\n");

  // Run 4 frames
  for (let frame = 1; frame <= 4; frame++) {
    console.log(`--- Frame ${frame} ---`);
    gameLoop({ deltaTime: 1.0 });
    console.log();
  }

  console.log("Demo completed!");
}

main();
