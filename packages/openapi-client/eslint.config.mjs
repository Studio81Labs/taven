import globals from "globals";
import { base } from "../../eslint.config.mjs";

export default [
  ...base,
  {
    ignores: ["generated/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
