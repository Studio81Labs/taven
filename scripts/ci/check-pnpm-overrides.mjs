import { readFile } from "node:fs/promises";
import process from "node:process";

const file = "pnpm-workspace.yaml";
const source = await readFile(file, "utf8");
const lines = source.split(/\r?\n/);
const overridesStart = lines.findIndex((line) => line === "overrides:");

if (overridesStart === -1) {
  console.error(`- ${file} does not declare an overrides block`);
  process.exit(1);
}

const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2").trim();

const parseMajor = (value) => {
  const match = value.match(/^(?:\^|~|>=\s*)?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : undefined;
};

const parseKey = (key) => {
  const separator = key.lastIndexOf("@");
  if (separator <= 0) return { name: key };
  const selector = key.slice(separator + 1);
  return {
    name: key.slice(0, separator),
    selector,
    selectorMajor: parseMajor(selector),
  };
};

const crossMajorErrors = ({
  key,
  name,
  value,
  selectorMajor,
  valueMajor,
  comments,
}) => {
  const upperBound = value.match(/<\s*(\d+)/)?.[1];
  const crossesMajor =
    valueMajor !== selectorMajor ||
    (upperBound !== undefined && Number(upperBound) !== selectorMajor + 1);

  if (!crossesMajor) return [];

  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    return [
      `${file}: override '${key}' has a non-exact range outside ${name}'s selected major; cross-major targets must pin one exact release`,
    ];
  }

  const reason = comments.join(" ");
  if (!/\b(?:GHSA-[a-z0-9-]+|CVE-\d{4}-\d+)\b/i.test(reason)) {
    return [
      `${file}: cross-major override '${key}: ${value}' must name its advisory directly above the entry`,
    ];
  }

  return [];
};

if (process.argv.includes("--self-test")) {
  const cases = [
    ["same-major caret", "^7.1.0", 7, [], 0],
    ["same-major bounded", ">=7.1.0 <8", 7, [], 0],
    ["cross-major caret", "^8.0.0", 7, [], 1],
    ["cross-major bounded", ">=8.0.0 <9", 7, [], 1],
    ["cross-major exact without advisory", "8.0.0", 7, [], 1],
    ["cross-major exact with advisory", "8.0.0", 7, ["# CVE-2026-1"], 0],
  ];

  for (const [label, value, selectorMajor, comments, expected] of cases) {
    const actual = crossMajorErrors({
      key: `fixture@${selectorMajor}`,
      name: "fixture",
      value,
      selectorMajor,
      valueMajor: parseMajor(value),
      comments,
    }).length;
    if (actual !== expected) {
      console.error(
        `self-test '${label}' expected ${expected}, received ${actual}`,
      );
      process.exit(1);
    }
  }

  console.log("pnpm override self-tests passed.");
  process.exit(0);
}

const errors = [];
let comments = [];

for (const line of lines.slice(overridesStart + 1)) {
  if (/^\S/.test(line)) break;
  const trimmed = line.trim();

  if (trimmed === "") {
    comments = [];
    continue;
  }
  if (trimmed.startsWith("#")) {
    comments.push(trimmed);
    continue;
  }
  if (!line.startsWith("  ") || line.startsWith("    ")) continue;

  const separator = trimmed.indexOf(": ");
  if (separator === -1) {
    errors.push(`${file}: cannot parse override '${trimmed}'`);
    comments = [];
    continue;
  }

  const key = unquote(trimmed.slice(0, separator));
  const value = unquote(trimmed.slice(separator + 2));
  const { name, selector, selectorMajor } = parseKey(key);
  const valueMajor = parseMajor(value);

  if (selector && selector === value) {
    errors.push(`${file}: override '${key}' redirects a release to itself`);
  }

  if (selectorMajor === undefined || valueMajor === undefined) {
    errors.push(
      `${file}: override '${key}: ${value}' uses an unsupported version form`,
    );
    comments = [];
    continue;
  }

  errors.push(
    ...crossMajorErrors({
      key,
      name,
      value,
      selectorMajor,
      valueMajor,
      comments,
    }),
  );

  comments = [];
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("pnpm overrides are internally consistent.");
