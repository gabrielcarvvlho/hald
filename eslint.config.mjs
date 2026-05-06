import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  eslintConfigPrettier,
  {
    ignores: ["dist/", "node_modules/", "tests/fixtures/", "benchmarks/", "src/viz/public/"],
  },
  {
    rules: {
      // Allow unused vars prefixed with _ (common pattern)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // These are too strict for a CLI tool
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Allow empty catch blocks (used in safeJsonParse, etc.)
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    // OpenCode loads plugins as CommonJS — keep require/module.exports allowed here.
    files: [".opencode/plugins/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
