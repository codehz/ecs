import type { EntityId, SerializedWorld } from "../../src";
import { World, component } from "../../src";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number; maxValue: number };
type Name = { value: string };

// Define component IDs
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const HealthId = component<Health>();
const NameId = component<Name>();

// Helper: print world state by iterating entities that have given components
function printWorldState(world: World, label: string): void {
  console.log(`\n=== ${label} ===`);

  // Query all entities that have Position (our "base" component)
  const results = world.query([PositionId], true);

  if (results.length === 0) {
    console.log("  (no entities found)");
    return;
  }

  for (const {
    entity,
    components: [pos],
  } of results) {
    const parts: string[] = [`Entity ${entity}:`, `  Position: (${pos.x}, ${pos.y})`];

    if (world.has(entity, VelocityId)) {
      const vel = world.get(entity, VelocityId);
      parts.push(`  Velocity: (${vel.x}, ${vel.y})`);
    }

    if (world.has(entity, HealthId)) {
      const hp = world.get(entity, HealthId);
      parts.push(`  Health: ${hp.value}/${hp.maxValue}`);
    }

    if (world.has(entity, NameId)) {
      const name = world.get(entity, NameId);
      parts.push(`  Name: "${name.value}"`);
    }

    console.log(parts.join("\n"));
  }
}

// Helper: verify two worlds have equivalent state
function verifyWorldsMatch(original: World, restored: World): boolean {
  const origResults = original.query([PositionId], true);
  const restResults = restored.query([PositionId], true);

  if (origResults.length !== restResults.length) {
    console.error(`  Entity count mismatch: ${origResults.length} vs ${restResults.length}`);
    return false;
  }

  for (let i = 0; i < origResults.length; i++) {
    const orig = origResults[i]!;
    const rest = restResults[i]!;

    if (orig.entity !== rest.entity) {
      console.error(`  Entity ID mismatch at index ${i}: ${orig.entity} vs ${rest.entity}`);
      return false;
    }

    const posMatch = orig.components[0].x === rest.components[0].x && orig.components[0].y === rest.components[0].y;
    if (!posMatch) {
      console.error(`  Position mismatch for entity ${orig.entity}`);
      return false;
    }

    // Check optional components
    const checkComp = (compId: EntityId<any>): boolean => {
      const origHas = original.has(orig.entity, compId);
      const restHas = restored.has(rest.entity, compId);
      if (origHas !== restHas) {
        console.error(`  Component presence mismatch for entity ${orig.entity}`);
        return false;
      }
      if (origHas && restHas) {
        const origVal = JSON.stringify(original.get(orig.entity, compId));
        const restVal = JSON.stringify(restored.get(rest.entity, compId));
        if (origVal !== restVal) {
          console.error(`  Component value mismatch for entity ${orig.entity}: ${origVal} vs ${restVal}`);
          return false;
        }
      }
      return true;
    };
    if (!checkComp(VelocityId) || !checkComp(HealthId) || !checkComp(NameId)) {
      return false;
    }
  }

  return true;
}

// Bonus: Custom encode/decode pattern
// Instead of relying on JSON.stringify/parse, you can manually build
// a serialized format. This is useful when you need to:
// - Integrate with a binary format or custom protocol
// - Add versioning/metadata beyond the snapshot structure
// - Transform data during serialization (e.g., compress coordinates)
interface CustomSaveFormat {
  meta: {
    version: number;
    timestamp: number;
    entityCount: number;
  };
  entities: Array<{
    id: number;
    position: { x: number; y: number };
    velocity?: { x: number; y: number };
    health?: { value: number; maxValue: number };
    name?: string;
  }>;
}

function customEncode(world: World): CustomSaveFormat {
  const results = world.query([PositionId], true);
  const entities: CustomSaveFormat["entities"] = [];

  for (const {
    entity,
    components: [pos],
  } of results) {
    const entry: CustomSaveFormat["entities"][number] = {
      id: entity as number,
      position: { x: pos.x, y: pos.y },
    };

    if (world.has(entity, VelocityId)) {
      const vel = world.get(entity, VelocityId);
      entry.velocity = { x: vel.x, y: vel.y };
    }

    if (world.has(entity, HealthId)) {
      const hp = world.get(entity, HealthId);
      entry.health = { value: hp.value, maxValue: hp.maxValue };
    }

    if (world.has(entity, NameId)) {
      const name = world.get(entity, NameId);
      entry.name = name.value;
    }

    entities.push(entry);
  }

  return {
    meta: {
      version: 1,
      timestamp: Date.now(),
      entityCount: entities.length,
    },
    entities,
  };
}

function customDecode(data: CustomSaveFormat): World {
  const world = new World();

  for (const entry of data.entities) {
    const entity = world.new();
    world.set(entity, PositionId, entry.position);

    if (entry.velocity) {
      world.set(entity, VelocityId, entry.velocity);
    }

    if (entry.health) {
      world.set(entity, HealthId, entry.health);
    }

    if (entry.name !== undefined) {
      world.set(entity, NameId, { value: entry.name });
    }
  }

  world.sync();
  return world;
}

function main() {
  console.log("ECS Serialization Demo - Save/Load Roundtrip");
  console.log("==============================================");

  // =========================================================================
  // Part 1: Build the original world
  // =========================================================================
  console.log("\n[1] Creating original world and spawning entities...");

  const world = new World();

  // Spawn a player entity
  const player = world.new();
  world.set(player, PositionId, { x: 0, y: 0 });
  world.set(player, VelocityId, { x: 1, y: 0.5 });
  world.set(player, HealthId, { value: 100, maxValue: 100 });
  world.set(player, NameId, { value: "Player" });

  // Spawn an enemy entity
  const enemy = world.new();
  world.set(enemy, PositionId, { x: 50, y: 30 });
  world.set(enemy, VelocityId, { x: -0.5, y: 0.2 });
  world.set(enemy, HealthId, { value: 50, maxValue: 50 });
  world.set(enemy, NameId, { value: "Goblin" });

  // Spawn a static prop (no velocity, no health)
  const prop = world.new();
  world.set(prop, PositionId, { x: 100, y: 200 });
  world.set(prop, NameId, { value: "TreasureChest" });

  // Apply all deferred commands
  world.sync();

  printWorldState(world, "Original World State");

  // =========================================================================
  // Part 2: Serialize to snapshot
  // =========================================================================
  console.log("\n[2] Serializing world to snapshot...");

  const snapshot: SerializedWorld = world.serialize();

  console.log("\n=== Snapshot Structure ===");
  console.log(`  version: ${snapshot.version}`);
  console.log(`  entityManager.nextId: ${snapshot.entityManager.nextId}`);
  console.log(`  entities count: ${snapshot.entities.length}`);
  console.log("  entity IDs:", snapshot.entities.map((e) => e.id).join(", "));
  console.log(
    "  components per entity:",
    snapshot.entities.map((e) => `${e.id}: [${e.components.map((c) => c.type).join(", ")}]`).join(" | "),
  );

  // =========================================================================
  // Part 3: JSON roundtrip
  // =========================================================================
  console.log("\n[3] JSON serialization roundtrip...");

  const json = JSON.stringify(snapshot);
  console.log(`  JSON size: ${json.length} bytes`);

  // Print abbreviated JSON
  if (json.length > 300) {
    console.log(`  JSON (first 300 chars): ${json.slice(0, 300)}...`);
  } else {
    console.log(`  JSON: ${json}`);
  }

  const parsed = JSON.parse(json);
  console.log("  Parsed back successfully.");

  // =========================================================================
  // Part 4: Restore from snapshot
  // =========================================================================
  console.log("\n[4] Restoring world from parsed snapshot...");

  const restoredWorld = new World(parsed);

  printWorldState(restoredWorld, "Restored World State");

  // =========================================================================
  // Part 5: Verify roundtrip integrity
  // =========================================================================
  console.log("\n[5] Verifying roundtrip integrity...");

  const match = verifyWorldsMatch(world, restoredWorld);
  if (match) {
    console.log("  ✅ Original and restored worlds match exactly!");
  } else {
    console.log("  ❌ Mismatch detected between original and restored worlds!");
  }

  // =========================================================================
  // Part 6: Bonus - Custom encode/decode pattern
  // =========================================================================
  console.log("\n[6] Bonus: Custom encode/decode pattern...");

  // Demonstrate custom encoding (e.g., for a hand-rolled save format)
  const customData = customEncode(world);
  console.log("\n=== Custom Save Format ===");
  console.log(`  Meta: v${customData.meta.version}, ${customData.meta.entityCount} entities`);
  for (const entry of customData.entities) {
    const extras: string[] = [];
    if (entry.velocity) extras.push(`velocity`);
    if (entry.health) extras.push(`health`);
    if (entry.name) extras.push(`name`);
    console.log(
      `  Entity ${entry.id}: pos(${entry.position.x}, ${entry.position.y})` +
        (extras.length > 0 ? ` [${extras.join(", ")}]` : ""),
    );
  }

  // Restore from custom format
  const customRestoredWorld = customDecode(customData);

  printWorldState(customRestoredWorld, "Custom-Decoded World State");

  // Verify custom roundtrip (self-consistency: re-encode and compare component data)
  // Note: entity IDs may differ, so we compare only component content
  const reEncoded = customEncode(customRestoredWorld);
  const customMatch =
    reEncoded.entities.length === customData.entities.length &&
    reEncoded.entities.every((entry, i) => {
      const orig = customData.entities[i]!;
      return (
        entry.position.x === orig.position.x &&
        entry.position.y === orig.position.y &&
        JSON.stringify(entry.velocity) === JSON.stringify(orig.velocity) &&
        JSON.stringify(entry.health) === JSON.stringify(orig.health) &&
        entry.name === orig.name
      );
    });
  if (customMatch) {
    console.log("  ✅ Custom encode/decode roundtrip preserves all component data!");
  } else {
    console.log("  ❌ Custom encode/decode mismatch detected!");
  }

  console.log("\n==============================================");
  console.log("Serialization demo completed successfully!");
}

main();
