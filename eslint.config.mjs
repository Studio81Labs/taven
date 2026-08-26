// Shared, type-unaware lint baseline. Every workspace imports this file and
// adds only the framework rules it needs.
import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export const commonIgnores = [
  "**/dist/**",
  "**/build/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/generated/**",
  "eslint.config.mjs",
];

export const base = tseslint.config(
  { ignores: commonIgnores },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);

export default base;
