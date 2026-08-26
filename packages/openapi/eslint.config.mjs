import globals from "globals";
import { base } from "../../eslint.config.mjs";

export default [
  ...base,
  {
    languageOptions: { globals: { ...globals.node } },
  },
];
