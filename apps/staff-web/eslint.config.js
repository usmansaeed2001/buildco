/**
 * ESLint flat config.
 *
 * ESLint 9 requires this file to exist — without it `npm run lint` fails outright
 * rather than reporting no problems, which is how it sat broken while every plugin
 * was installed and declared.
 *
 * Type-aware rules are deliberately not enabled. `tsc -b` already runs in `build` and
 * `typecheck` with a far stricter compiler config than any lint rule would replicate
 * (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), so turning on the
 * type-checked preset would double the lint time to re-derive what the compiler
 * already proves.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "test-results", "src/api/schema.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The compiler flags genuinely unused values; the lint rule only duplicates it
      // and disagrees about deliberately-ignored parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node context, not browser.
    files: ["*.config.{ts,js}", "e2e/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
