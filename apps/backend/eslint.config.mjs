import globals from "globals";
import { base } from "../../eslint.config.mjs";

export default [
  ...base,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
];
