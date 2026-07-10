import { pipeline } from "@codehz/pipeline";

import { World, component, type Query } from "../src";

// ── Component Type Definitions ───────────────────────────────────────────────

type State = { current: "idle" | "patrol" | "flee"; timer: number };
type Health = { value: number; maxValue: number };
type Speed = { value: number };
type Target = { x: number; y: number };
type Position = { x: number; y: number };

// Void component: presence of this marks an entity as AI-controlled
type AIEnabled = void;

// ── Component ID Registration ────────────────────────────────────────────────

const State = component<State>({ name: "State" });
const Health = component<Health>({ name: "Health" });
const Speed = component<Speed>({ name: "Speed" });
const Target = component<Target>({ name: "Target" });
const Position = component<Position>({ name: "Position" });
const AIEnabled = component<AIEnabled>({ name: "AIEnabled" });

// ── Helpers ──────────────────────────────────────────────────────────────────

function distance(a: Position, b: Target): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function randomTarget(): Target {
  return {
    x: Math.round((Math.random() * 20 - 10) * 100) / 100,
    y: Math.round((Math.random() * 20 - 10) * 100) / 100,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("ECS State Machine & AI Demo - Lifecycle Hooks");
  console.log("=============================================\n");

  const world = new World();

  // ── Queries (pre-cached for performance) ─────────────────────────────────

  const aiQuery: Query = world.createQuery([State, Position, Speed, Target, AIEnabled]);
  const healthQuery: Query = world.createQuery([Health]);

  // ── Lifecycle Hooks ──────────────────────────────────────────────────────

  // Log health changes
  const unsubHealth = world.hook([Health], (type, entityId, health) => {
    const marker = type === "init" ? "[INIT]" : type === "set" ? "[SET]" : "[REMOVE]";
    console.log(`  ${marker} Health | entity=${entityId} | value=${health.value.toFixed(1)}/${health.maxValue}`);
  });

  // Log state transitions
  const unsubState = world.hook([State], (type, entityId, state) => {
    const marker = type === "init" ? "[INIT]" : type === "set" ? "[SET]" : "[REMOVE]";
    console.log(`  ${marker} State  | entity=${entityId} | current=${state.current} | timer=${state.timer.toFixed(2)}`);
  });

  // ── Pass 1: AI State Machine ────────────────────────────────────────────

  const aiStatePass = (env: { deltaTime: number }) => {
    const dt = env.deltaTime;

    aiQuery.forEach([State, Position, Speed, Target], (entity, state, position, speed, target) => {
      switch (state.current) {
        case "idle": {
          state.timer -= dt;
          if (state.timer <= 0) {
            // Switch to patrol with a fresh random target
            state.current = "patrol";
            state.timer = 0;
            const newTarget = randomTarget();
            world.set(entity, Target, newTarget);
            console.log(`  [AI] Entity ${entity}: idle → patrol | new target (${newTarget.x}, ${newTarget.y})`);
          }
          break;
        }

        case "patrol": {
          const dist = distance(position, target);
          const moveSpeed = speed.value * dt;

          if (dist <= moveSpeed) {
            // Arrived at target → switch back to idle
            position.x = target.x;
            position.y = target.y;
            world.set(entity, Position, { x: position.x, y: position.y });
            state.current = "idle";
            state.timer = 1.0 + Math.random() * 2.0; // idle for 1–3 seconds
            console.log(
              `  [AI] Entity ${entity}: patrol → idle | arrived at (${target.x}, ${target.y}) | idle ${state.timer.toFixed(2)}s`,
            );
          } else {
            // Move toward target
            const dx = (target.x - position.x) / dist;
            const dy = (target.y - position.y) / dist;
            position.x += dx * moveSpeed;
            position.y += dy * moveSpeed;
            world.set(entity, Position, { x: position.x, y: position.y });
          }
          break;
        }

        case "flee": {
          // Move away from target at 2x speed (panicked retreat)
          const dist = distance(position, target);
          const fleeSpeed = speed.value * 2.0 * dt;

          if (dist > 0.001) {
            const dx = (position.x - target.x) / dist;
            const dy = (position.y - target.y) / dist;
            position.x += dx * fleeSpeed;
            position.y += dy * fleeSpeed;
          } else {
            // Exactly on target — pick arbitrary direction
            position.x += fleeSpeed;
          }
          world.set(entity, Position, { x: position.x, y: position.y });

          state.timer += dt;
          // Flee for at least 3 seconds, then try going back to idle
          if (state.timer >= 3.0) {
            state.current = "idle";
            state.timer = 1.0;
            console.log(`  [AI] Entity ${entity}: flee → idle | recovered after ${state.timer.toFixed(2)}s`);
          }
          break;
        }
      }

      // Commit state changes (timer always updates)
      world.set(entity, State, { current: state.current, timer: state.timer });
    });
  };

  // ── Pass 2: Health Check → Trigger Flee ─────────────────────────────────

  const healthCheckPass = () => {
    healthQuery.forEach([Health], (entity, health) => {
      if (health.value < health.maxValue * 0.3) {
        // Entity is low-health; switch to flee
        const state = world.get(entity, State);
        if (state && state.current !== "flee") {
          console.log(`  [HealthCheck] Entity ${entity}: health ${health.value.toFixed(1)} < 30% → switching to flee`);
          world.set(entity, State, { current: "flee", timer: 0 });
        }
      }
    });
  };

  // ── Pass 3: Status Log ──────────────────────────────────────────────────

  const statusLogPass = () => {
    console.log("  --- Status ---");
    aiQuery.forEach([State, Position, Health], (entity, state, position, health) => {
      // Health is optional for AI entities (some may not have it)
      const hp = health ? `${health.value.toFixed(1)}/${health.maxValue}` : "N/A";
      console.log(
        `  Entity ${entity}: state=${state.current} | pos=(${position.x.toFixed(2)}, ${position.y.toFixed(2)}) | hp=${hp}`,
      );
    });
    console.log("");
  };

  // ── Pass 4: Sync ────────────────────────────────────────────────────────

  const syncPass = () => {
    world.sync();
  };

  // ── Build Pipeline ──────────────────────────────────────────────────────

  const gameLoop = pipeline<{ deltaTime: number }>()
    .addPass(aiStatePass)
    .addPass(healthCheckPass)
    .addPass(statusLogPass)
    .addPass(syncPass)
    .build();

  // ── Setup Entities ──────────────────────────────────────────────────────

  // Entity 1: Starts in "idle", healthy
  const e1 = world
    .spawn()
    .with(State, { current: "idle", timer: 0.5 })
    .with(Position, { x: 0, y: 0 })
    .with(Speed, { value: 3.0 })
    .with(Target, { x: 0, y: 0 })
    .with(Health, { value: 100, maxValue: 100 })
    .with(AIEnabled)
    .build();

  // Entity 2: Starts in "patrol", already moving toward a target
  const e2 = world
    .spawn()
    .with(State, { current: "patrol", timer: 0 })
    .with(Position, { x: 10, y: 0 })
    .with(Speed, { value: 5.0 })
    .with(Target, { x: 10, y: 10 })
    .with(Health, { value: 40, maxValue: 100 }) // will drop below 30% soon
    .with(AIEnabled)
    .build();

  // Entity 3: Starts in "idle", somewhat wounded
  const e3 = world
    .spawn()
    .with(State, { current: "idle", timer: 1.0 })
    .with(Position, { x: -5, y: 5 })
    .with(Speed, { value: 2.0 })
    .with(Target, { x: -5, y: 5 })
    .with(Health, { value: 25, maxValue: 100 }) // already below 30%
    .with(AIEnabled)
    .build();

  // Initial sync — applies all buffered commands and fires "init" hooks
  console.log("--- Initial Sync (init hooks fire) ---\n");
  world.sync();

  // ── Run Frames ──────────────────────────────────────────────────────────

  console.log("\n=== Frame 1 (dt=1.0) ===");
  gameLoop({ deltaTime: 1.0 });

  console.log("=== Frame 2 (dt=1.0) ===");
  gameLoop({ deltaTime: 1.0 });

  console.log("=== Frame 3 (dt=1.0) ===");
  // Deplete entity 2's health to trigger flee
  {
    const h2 = world.get(e2, Health);
    world.set(e2, Health, { value: h2.value - 20, maxValue: h2.maxValue });
    const h3 = world.get(e3, Health);
    world.set(e3, Health, { value: h3.value - 5, maxValue: h3.maxValue });
  }
  gameLoop({ deltaTime: 1.0 });

  console.log("=== Frame 4 (dt=1.0) ===");
  // Further deplete entity 1 to get it low too
  {
    const h1 = world.get(e1, Health);
    world.set(e1, Health, { value: h1.value - 40, maxValue: h1.maxValue });
  }
  gameLoop({ deltaTime: 1.0 });

  console.log("=== Frame 5 (dt=1.0) ===");
  // Entity 1 now gets very low
  {
    const h1 = world.get(e1, Health);
    world.set(e1, Health, { value: h1.value - 40, maxValue: h1.maxValue });
  }
  gameLoop({ deltaTime: 1.0 });

  console.log("=== Frame 6 (dt=1.0) ===");
  gameLoop({ deltaTime: 1.0 });

  // ── Cleanup ─────────────────────────────────────────────────────────────

  unsubHealth();
  unsubState();

  console.log("Demo completed!");
}

// ── Entry Point ──────────────────────────────────────────────────────────────

main();
