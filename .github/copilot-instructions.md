# @codehz/ecs - AI Coding Guidelines

## Project Overview
This is an Entity Component System (ECS) library built with TypeScript and Bun runtime. The project follows modern TypeScript practices with strict type checking and ESNext features.

## Runtime & Environment
- **Runtime**: Bun (not Node.js) - use `bun` commands instead of `npm`/`yarn`
- **Language**: TypeScript with ESNext target and strict mode enabled
- **Module System**: ES modules with `"module": "Preserve"` and bundler resolution

## Development Workflow
- **Install**: `bun install` (not `npm install`)
- **Run**: `bun run src/index.ts` (direct execution, no build step)
- **TypeScript**: `bunx tsc --noEmit` (Configured for modern features with strict checking - noEmit mode for bundler compatibility)
- **Testing**: `bun test` (set up tests as needed)

## Code Patterns
- **Imports**: Use ES module syntax with `.ts` extensions allowed due to `"allowImportingTsExtensions": true`
- **Type Checking**: Strict mode with additional checks like `noUncheckedIndexedAccess` and `noImplicitOverride`

## Architecture Notes
- **Entry Point**: `src/index.ts` - single file currently, expand with ECS components/systems
- **Dependencies**: Minimal setup - add peer dependencies for TypeScript integration

## Key Files
- `tsconfig.json`: Modern TypeScript config with bundler mode
- `package.json`: Module configuration with Bun-specific settings
- `src/index.ts`: Main entry point (currently minimal)</content>
<parameter name="filePath">d:\Developer\ecs\.github\copilot-instructions.md