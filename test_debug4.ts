import { component, relation, getDetailedIdType, isDontFragmentComponent } from "./src/entity";
import { World } from "./src/world";
import { ComponentChangeset } from "./src/changeset";

const world = new World();

const ChildOf = component({ dontFragment: true, exclusive: true });
const PositionId = component();

const parent1 = world.new();
const parent2 = world.new();
const child = world.new();

world.set(child, PositionId);
world.set(child, relation(ChildOf, parent1));
world.sync();

console.log("=== Before setting parent2 ===");
const archetype1 = (world as any).entityToArchetype.get(child);
console.log("Archetype componentTypes:", archetype1.componentTypes);
const entityData1 = archetype1.getEntity(child);
console.log("Entity data keys:", Array.from(entityData1.keys()));

// Manually simulate what should happen in executeEntityCommands
const changeset = new ComponentChangeset();
const rel1 = relation(ChildOf, parent1);
const rel2 = relation(ChildOf, parent2);

// The exclusive logic should add both delete and set
changeset.delete(rel1);
changeset.set(rel2, undefined);

console.log("\nChangeset:");
console.log("  removes:", Array.from(changeset.removes));
console.log("  adds:", Array.from(changeset.adds.keys()));

// Check if they're detected as dontFragment
for (const ct of changeset.removes) {
  const dt = getDetailedIdType(ct);
  console.log(`  ${ct} is dontFragment:`, isDontFragmentComponent(dt.componentId!));
}

world.set(child, relation(ChildOf, parent2));
world.sync();

console.log("\n=== After setting parent2 ===");
const archetype2 = (world as any).entityToArchetype.get(child);
console.log("Archetype componentTypes:", archetype2.componentTypes);
const entityData2 = archetype2.getEntity(child);
console.log("Entity data keys:", Array.from(entityData2.keys()));
