import { pipeline } from "@codehz/pipeline";

import { World, component, type EntityId, type Query } from "../src";

// =============================================================================
// Component type definitions
// =============================================================================
type Position = { x: number; y: number };
type Health = { value: number };
type Damage = { value: number };
type Team = { id: number }; // 1 = ally, 2 = enemy

// =============================================================================
// Component IDs — void components (tags) use component() with no type arg
// =============================================================================
const Position = component<Position>({ name: "Position" });
const Health = component<Health>({ name: "Health" });
const Damage = component<Damage>({ name: "Damage" });
const Team = component<Team>({ name: "Team" });
const Alive = component({ name: "Alive" }); // void tag — living entities
const Stunned = component({ name: "Stunned" }); // void tag — CC'd entities
const Invisible = component({ name: "Invisible" }); // void tag — stealthed entities

// =============================================================================
// World & pre-cached queries
// =============================================================================
const world = new World();

// livingAllies: [Position, Health, Team] — allies that are alive but NOT stunned
const livingAllies: Query = world.createQuery([Position, Health, Team], {
  negativeComponentTypes: [Stunned],
});

// visibleEnemies: [Position, Team] — all enemies (for detection/rendering)
const visibleEnemies: Query = world.createQuery([Position, Team]);

// damageableAllies: [Position, Health, Team] — allies that can be healed
const damageableAllies: Query = world.createQuery([Position, Health, Team]);

// threats: [Position, Damage, Team] — enemies that deal damage
const threats: Query = world.createQuery([Position, Damage, Team]);

// ccTargets: [Position, Team] — valid CC targets (exclude stunned + invisible)
const ccTargets: Query = world.createQuery([Position, Team], {
  negativeComponentTypes: [Stunned, Invisible],
});

// =============================================================================
// Helper: distance between two positions
// =============================================================================
function dist(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// =============================================================================
// Game loop built with @codehz/pipeline
// =============================================================================
const gameLoop = pipeline()
  // ---------------------------------------------------------------------------
  // DamagePass: threats find nearest livingAlly and deal damage
  // ---------------------------------------------------------------------------
  .addPass(() => {
    // Collect all living ally positions for target selection
    const allyEntries: Array<{ entity: EntityId; pos: Position; hp: Health }> = [];
    livingAllies.forEach([Position, Health, Team], (entity, pos, hp, team) => {
      if (team.id === 1) {
        allyEntries.push({ entity, pos, hp });
      }
    });

    if (allyEntries.length === 0) return;

    threats.forEach([Position, Damage, Team], (entity, pos, dmg, team) => {
      if (team.id !== 2) return; // only enemies

      // Find nearest ally
      let nearest: (typeof allyEntries)[0] | null = null;
      let nearestDist = Infinity;
      for (const ally of allyEntries) {
        const d = dist(pos, ally.pos);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = ally;
        }
      }

      if (nearest) {
        nearest.hp.value -= dmg.value;
        console.log(
          `[DamagePass] Enemy ${entity} hits Ally ${nearest.entity} ` +
            `for ${dmg.value} damage (HP: ${nearest.hp.value})`,
        );

        // If health depleted, mark for cleanup: remove Alive, add Invisible
        if (nearest.hp.value <= 0) {
          nearest.hp.value = 0;
          world.remove(nearest.entity, Alive);
          world.set(nearest.entity, Invisible);
          console.log(`[DamagePass] Ally ${nearest.entity} has fallen! (Alive removed, Invisible added)`);
        }
      }
    });
  })

  // ---------------------------------------------------------------------------
  // HealPass: heal all damageable allies for a small amount
  // ---------------------------------------------------------------------------
  .addPass(() => {
    damageableAllies.forEach([Position, Health, Team], (entity, _pos, hp, team) => {
      if (team.id !== 1) return;
      const healAmount = 5;
      const oldHp = hp.value;
      hp.value = Math.min(hp.value + healAmount, 100);
      if (hp.value !== oldHp) {
        console.log(`[HealPass] Ally ${entity} healed by ${healAmount} ` + `(HP: ${oldHp} -> ${hp.value})`);
      }
    });
  })

  // ---------------------------------------------------------------------------
  // CCApplicationPass: apply Stunned to a random valid ccTarget (if any exist)
  // ---------------------------------------------------------------------------
  .addPass(() => {
    const targets: Array<{ entity: EntityId; team: Team }> = [];
    ccTargets.forEach([Position, Team], (entity, _pos, team) => {
      targets.push({ entity, team });
    });

    const target = targets[0];
    if (target) {
      // Pick the first valid target (deterministic for demo)
      world.set(target.entity, Stunned);
      console.log(`[CCApplicationPass] Stunned applied to Entity ${target.entity} ` + `(Team ${target.team.id})`);
    } else {
      console.log(`[CCApplicationPass] No valid CC targets available`);
    }
  })

  // ---------------------------------------------------------------------------
  // CCExpiryPass: remove Stunned from all currently-stunned entities
  // ---------------------------------------------------------------------------
  .addPass(() => {
    // Use getEntities on a query that just checks for Stunned presence.
    // We don't have a dedicated "stunnedOnly" query, so iterate via allTeams.
    // Better: iterate all livingAllies + visibleEnemies and check has(Stunned).
    const allEntities = world.createQuery([Position]);
    const stunnedEntities: EntityId[] = [];
    allEntities.forEach([Position], (entity) => {
      if (world.has(entity, Stunned)) {
        stunnedEntities.push(entity);
      }
    });
    allEntities.dispose(); // one-shot query — release immediately

    for (const entity of stunnedEntities) {
      world.remove(entity, Stunned);
      console.log(`[CCExpiryPass] Stunned expired on Entity ${entity}`);
    }
  })

  // ---------------------------------------------------------------------------
  // CleanupPass: delete entities that are dead (no Alive tag)
  // ---------------------------------------------------------------------------
  .addPass(() => {
    const deadEntities: EntityId[] = [];
    // Use a temporary query to find entities with Position (our marker for
    // "active entity") that lack the Alive tag.
    const allPosQuery = world.createQuery([Position]);
    allPosQuery.forEach([Position], (entity) => {
      if (!world.has(entity, Alive)) {
        deadEntities.push(entity);
      }
    });
    allPosQuery.dispose();

    for (const entity of deadEntities) {
      world.delete(entity);
      console.log(`[CleanupPass] Deleted dead Entity ${entity}`);
    }
  })

  // ---------------------------------------------------------------------------
  // StatusPass: log counts of each query result set
  // ---------------------------------------------------------------------------
  .addPass(() => {
    console.log(`[StatusPass] === Frame Summary ===`);
    console.log(`  livingAllies:     ${livingAllies.getEntities().length}`);
    console.log(`  visibleEnemies:   ${visibleEnemies.getEntities().length}`);
    console.log(`  damageableAllies: ${damageableAllies.getEntities().length}`);
    console.log(`  threats:          ${threats.getEntities().length}`);
    console.log(`  ccTargets:        ${ccTargets.getEntities().length}`);
    console.log(`[StatusPass] ========================`);
  })

  // ---------------------------------------------------------------------------
  // SyncPass: materialise all deferred structural changes
  // ---------------------------------------------------------------------------
  .addPass(() => {
    world.sync();
  })
  .build();

// =============================================================================
// Setup: create entities with different tag/team combinations
// =============================================================================
function setup() {
  console.log("=== Tag Filtering Demo Setup ===\n");

  // --- 2 ally soldiers (Team 1, Alive, Position, Health=100) ---
  world.spawn().with(Position, { x: 0, y: 0 }).with(Health, { value: 100 }).with(Team, { id: 1 }).with(Alive).build();

  world.spawn().with(Position, { x: 5, y: 5 }).with(Health, { value: 100 }).with(Team, { id: 1 }).with(Alive).build();

  // --- 3 enemy soldiers (Team 2, Alive, Position, Health=80, Damage=10) ---
  for (let i = 0; i < 3; i++) {
    world
      .spawn()
      .with(Position, { x: 20 + i * 10, y: 20 + i * 5 })
      .with(Health, { value: 80 })
      .with(Damage, { value: 10 })
      .with(Team, { id: 2 })
      .with(Alive)
      .build();
  }

  // --- 1 enemy mage (Team 2, Alive, Position, Health=50, Damage=25, Invisible) ---
  world
    .spawn()
    .with(Position, { x: 50, y: 50 })
    .with(Health, { value: 50 })
    .with(Damage, { value: 25 })
    .with(Team, { id: 2 })
    .with(Alive)
    .with(Invisible) // starts stealthed — excluded from ccTargets
    .build();

  // --- 1 pre-stunned ally (Team 1, Alive, Position, Health=60, Stunned) ---
  world
    .spawn()
    .with(Position, { x: -10, y: -10 })
    .with(Health, { value: 60 })
    .with(Team, { id: 1 })
    .with(Alive)
    .with(Stunned) // starts CC'd — excluded from livingAllies until expiry
    .build();

  world.sync();
  console.log("Setup complete. Starting simulation...\n");
}

// =============================================================================
// Main entry point
// =============================================================================
function main() {
  setup();

  for (let frame = 1; frame <= 4; frame++) {
    console.log(`\n--- Frame ${frame} ---`);
    gameLoop({});
  }

  console.log("\n=== Demo completed! ===");
}

main();
