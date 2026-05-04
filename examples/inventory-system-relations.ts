import { World, component, relation, type EntityId, type Query } from "../src";

type ItemName = { name: string };
type Stackable = { count: number; maxCount: number };
type Gold = { amount: number };
type EquipmentSlot = { slot: string };

const ItemName = component<ItemName>({ name: "ItemName" });
const Stackable = component<Stackable>({ name: "Stackable" });
const Gold = component<Gold>({ name: "Gold" });
const EquipmentSlot = component<EquipmentSlot>({ name: "EquipmentSlot" });
const InInventory = component<void>({ name: "InInventory", dontFragment: true });

const world = new World();

const inventoryOwners: Query = world.createQuery([relation(InInventory, "*")]);

function formatItem(item: EntityId): string {
  const itemName = world.get(item, ItemName);
  const stack = world.getOptional(item, Stackable)?.value;
  const slot = world.getOptional(item, EquipmentSlot)?.value;

  const details: string[] = [];
  if (stack) {
    details.push(`stack ${stack.count}/${stack.maxCount}`);
  }
  if (slot) {
    details.push(`slot=${slot.slot}`);
  }

  return details.length > 0 ? `${itemName.name} (${details.join(", ")})` : itemName.name;
}

function printInventory(owner: EntityId, label: string): void {
  if (!world.has(owner, relation(InInventory, "*"))) {
    console.log(`${label}: empty inventory`);
    return;
  }

  const entries = world.get(owner, relation(InInventory, "*"));
  const itemLines = entries.map(([item]) => `  - Item ${item}: ${formatItem(item)}`);
  console.log(`${label}:\n${itemLines.join("\n")}`);
}

function countInventoryItems(owner: EntityId): number {
  return world.getOptional(owner, relation(InInventory, "*"))?.value.length ?? 0;
}

function printInventorySummary(): void {
  console.log("\n[InventorySummary]");
  inventoryOwners.forEach([relation(InInventory, "*")], (owner, items) => {
    const gold = world.getOptional(owner, Gold)?.value;
    console.log(`Owner ${owner}: ${items.length} item(s), gold=${gold?.amount ?? 0}`);
  });
}

function main() {
  console.log("ECS Inventory System Demo - Non-exclusive Relations");
  console.log("===================================================");

  const player = world.spawn().with(Gold, { amount: 125 }).build();

  const sword = world.spawn().with(ItemName, { name: "Iron Sword" }).with(EquipmentSlot, { slot: "weapon" }).build();
  const armor = world.spawn().with(ItemName, { name: "Leather Armor" }).with(EquipmentSlot, { slot: "armor" }).build();
  const potion = world
    .spawn()
    .with(ItemName, { name: "Health Potion" })
    .with(Stackable, { count: 3, maxCount: 20 })
    .build();
  const arrows = world
    .spawn()
    .with(ItemName, { name: "Arrow Bundle" })
    .with(Stackable, { count: 48, maxCount: 99 })
    .build();

  world.set(player, relation(InInventory, sword));
  world.set(player, relation(InInventory, armor));
  world.set(player, relation(InInventory, potion));
  world.set(player, relation(InInventory, arrows));
  world.sync();

  console.log(`\nPlayer ${player} starts with ${world.get(player, Gold).amount} gold.`);
  printInventory(player, "Initial inventory");

  const potionStack = world.get(potion, Stackable);
  potionStack.count += 2;
  console.log(`\nPicked up more potions. Potion stack is now ${potionStack.count}/${potionStack.maxCount}.`);

  const swordSlot = world.get(sword, EquipmentSlot);
  console.log(`Equipped ${world.get(sword, ItemName).name} to ${swordSlot.slot}.`);

  world.remove(player, relation(InInventory, armor));
  world.set(player, Gold, { amount: world.get(player, Gold).amount + 35 });
  world.sync();

  console.log(`\nSold ${world.get(armor, ItemName).name} for 35 gold.`);
  console.log(`Player ${player} now has ${world.get(player, Gold).amount} gold.`);
  printInventory(player, "Inventory after selling armor");

  console.log(`\nInventory count via wildcard relation: ${countInventoryItems(player)}`);
  printInventorySummary();

  console.log("\nDemo completed!");
}

main();
