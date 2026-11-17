// ESLint for the shim, the phone layer and the Node tools. Run: npm run lint
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["vendor/**", "build/**", "android/**", "shim/vendor/**", "node_modules/**", "dist/**"] },
  js.configs.recommended,
  {
    // Browser scripts that run in the WebView before/alongside the UHC bundle
    files: ["shim/**/*.js", "android/app/src/main/assets/**/*.js"],
    languageOptions: { ecmaVersion: 2020, sourceType: "script", globals: { ...globals.browser } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["tools/**/*.mjs", "test/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }], eqeqeq: ["error", "smart"] },
  },
  {
    files: ["tools/**/*.cjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
  },
];
