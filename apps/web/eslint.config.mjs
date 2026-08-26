import globals from "globals";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";
import { base } from "../../eslint.config.mjs";

export default [
  ...base,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,vue}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      "vue/singleline-html-element-content-newline": "off",
    },
  },
  {
    files: ["pages/**/*.vue"],
    rules: { "vue/multi-word-component-names": "off" },
  },
];
