import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  eslintConfigPrettier,
  {
    // Vendored, minified third-party bundles are not ours to lint.
    ignores: ["dist/", "node_modules/", "tests/fixtures/", "benchmarks/", "src/viz/public/vendor/"],
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
    // Browser ESM modules for the graph visualizer. These are plain .js files
    // loaded directly in the browser (no bundler), so they need browser globals
    // plus the two vendored UMD libraries (graphology, Sigma).
    files: ["src/viz/public/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        // DOM / window surface
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        location: "readonly",
        history: "readonly",
        getComputedStyle: "readonly",
        devicePixelRatio: "readonly",
        matchMedia: "readonly",
        performance: "readonly",
        // Timers / animation frame
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        // Network / web APIs
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Image: "readonly",
        Blob: "readonly",
        CustomEvent: "readonly",
        console: "readonly",
        // DOM constructors used in instanceof checks
        Node: "readonly",
        HTMLElement: "readonly",
        // Vendored UMD globals (graphology.umd.min.js, sigma.min.js)
        graphology: "readonly",
        Sigma: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // These browser modules are plain JS — TS-specific rules don't apply.
      "@typescript-eslint/no-unused-vars": "off",
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
