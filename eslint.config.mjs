import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierPlugin from "eslint-plugin-prettier";

/**
 * ESLint flat config for the project.
 * - TypeScript parser + plugin for typed linting
 * - Prettier plugin to keep formatting enforced by ESLint
 * - Basic overrides for test files and generated or output folders
 */
export default [
  // ignore common build/artifact folders
  {
    ignores: ["dist/**", "build/**", "node_modules/**"],
  },

  // General JS/TS settings
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: new URL(".", import.meta.url).pathname,
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        // Bun testing / runtime globals (Bun provides `Bun` as global runtime)
        Bun: "readonly",
      },
    },
    // Plugins are loaded by name in the flat config as objects
    plugins: {
      "@typescript-eslint": tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      // Prettier enforces formatting — run prettier as part of linting
      "prettier/prettier": "error",

      // Replace core ESLint `no-unused-vars` with TypeScript-aware rule
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

      "@typescript-eslint/no-unused-private-class-members": "error",

      // Type-only import enforcement for consistency
      "@typescript-eslint/consistent-type-imports": "error",

      // Allow some pragmatic leniency for lib code (disable if you want stricter checks)
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Test files — bun.test uses describe/it/expect (similar to Jest), mark them as known
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
    rules: {
      // Tests often include non-null assertions and other patterns that are okay
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
