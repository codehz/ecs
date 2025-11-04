// scripts/dist.ts - 构建脚本

import { $ } from "bun";
import { readdirSync } from "fs";

export async function build() {
  const startTime = Date.now();

  // 清空 dist 目录
  console.log("🧹 Cleaning dist directory...");
  await $`rm -rf dist`;

  const entrypoints = ["src/index.ts"];
  console.log(`📋 Found ${entrypoints.length} entrypoints to build`);

  // 使用 Bun.build 构建所有入口点
  console.log("🔨 Building workflow library...");
  const result = await Bun.build({
    entrypoints,
    outdir: "dist",
    root: "src",
    target: "node",
    splitting: true,
  });

  if (!result.success) {
    console.error("❌ Build failed:");
    for (const log of result.logs) {
      console.error(`  ${log.level}: ${log.message}`);
    }
    throw new Error("Build failed");
  }

  // 输出构建结果
  const buildTime = Date.now() - startTime;
  console.log(`✅ Build successful in ${buildTime}ms!`);
  console.log(`📦 Generated ${result.outputs.length} files:`);
  for (const output of result.outputs) {
    const size = output.size
      ? `${(output.size / 1024).toFixed(1)} KB`
      : "unknown";
    console.log(`  ${output.path} (${size})`);
  }
  console.log();

  // 生成类型定义
  console.log("📝 Generating TypeScript declarations...");
  await $`bunx tsc --project tsconfig.build.json`;
  console.log("✅ TypeScript declarations generated!");
}

// 如果直接运行此脚本，执行构建
if (import.meta.main) {
  await build();
}
