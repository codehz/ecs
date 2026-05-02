// Build script

import { $ } from "bun";
import { build as tsdownBuild } from "tsdown";

export async function build() {
  const startTime = Date.now();

  // Clean dist directory
  console.log("🧹 Cleaning dist directory...");
  await $`rm -rf dist`;

  const entrypoints = ["src/index.ts"];
  console.log(`📋 Found ${entrypoints.length} entrypoints to build`);

  // Build all entry points with tsdown
  console.log("🔨 Building workflow library...");
  await tsdownBuild({
    entry: entrypoints,
    outDir: "dist",
    dts: true,
    sourcemap: true,
  });

  // Output build result
  const buildTime = Date.now() - startTime;
  console.log(`✅ Build successful in ${buildTime}ms!`);

  // Generate type declarations
  console.log("📝 Generating TypeScript declarations...");
  await $`bunx tsc --project tsconfig.build.json`;
  console.log("✅ TypeScript declarations generated!");
}

// If this script is run directly, execute build
if (import.meta.main) {
  await build();
}
