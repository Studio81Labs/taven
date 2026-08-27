import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function vueScripts(source) {
  const withoutHtmlComments = source.replace(/<!--[\s\S]*?-->/g, "");
  return Array.from(
    withoutHtmlComments.matchAll(
      /<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi,
    ),
    (match) => match[1],
  );
}

function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

function decodeEscape(source, start) {
  const character = source[start];
  if (character === undefined) return { end: start, value: "" };
  const simple = {
    0: "\0",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  if (character in simple) return { end: start + 1, value: simple[character] };
  if (character === "\r" || character === "\n") {
    return {
      end: source[start + 1] === "\n" ? start + 2 : start + 1,
      value: "",
    };
  }
  if (character === "x") {
    const value = source.slice(start + 1, start + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(value)) {
      return {
        end: start + 3,
        value: String.fromCodePoint(Number.parseInt(value, 16)),
      };
    }
  }
  if (character === "u") {
    const braced = source[start + 1] === "{";
    const end = braced ? source.indexOf("}", start + 2) : start + 5;
    const value = braced
      ? end === -1
        ? ""
        : source.slice(start + 2, end)
      : source.slice(start + 1, end);
    if (
      /^[0-9A-Fa-f]{4,6}$/.test(value) &&
      (!braced || Number.parseInt(value, 16) <= 0x10ffff)
    ) {
      return {
        end: braced ? end + 1 : end,
        value: String.fromCodePoint(Number.parseInt(value, 16)),
      };
    }
  }
  return { end: start + 1, value: character };
}

function readQuotedLiteral(source, start, quote) {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const escaped = decodeEscape(source, index + 1);
      value += escaped.value;
      index = escaped.end - 1;
    } else if (character === quote) {
      return { end: index + 1, value };
    } else {
      value += character;
    }
  }
  return { end: source.length, value: undefined };
}

function findTemplateExpressionEnd(source, start) {
  let depth = 1;
  const tokens = [];
  const braces = [];
  for (let index = start; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) return source.length;
    } else if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      index = readQuotedLiteral(source, index, character).end;
      tokens.push({ kind: "literal", value: "" });
    } else if (character === "`") {
      index = readTemplateLiteral(source, index).end;
      tokens.push({ kind: "template", value: "" });
    } else if (character === "/" && isRegexStart(tokens)) {
      index = skipRegexLiteral(source, index);
      tokens.push({ kind: "regex", value: "" });
    } else if (isIdentifierStart(character)) {
      let end = index + 1;
      while (isIdentifierPart(source[end] ?? "")) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
    } else if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9._]/.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "number", value: source.slice(index, end) });
      index = end;
    } else {
      if (character === "{") {
        const statementBlock = opensStatementBlock(tokens);
        braces.push(statementBlock ? "block" : "object");
        depth += 1;
        tokens.push({
          kind: "punctuation",
          value: "{",
          statementBlock,
        });
        index += 1;
        continue;
      }
      if (character === "}") {
        const kind = braces.pop();
        depth -= 1;
        if (depth === 0) return index;
        tokens.push({
          kind: "punctuation",
          value: "}",
          expressionEnding: kind === "object",
        });
        index += 1;
        continue;
      }
      const pair = source.slice(index, index + 2);
      const value = pair === "=>" || pair === "?." ? pair : character;
      tokens.push({ kind: "punctuation", value });
      index += value.length;
    }
  }
  return source.length;
}

function readTemplateLiteral(source, start) {
  let value = "";
  const expressions = [];
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const escaped = decodeEscape(source, index + 1);
      value += escaped.value;
      index = escaped.end - 1;
      continue;
    }
    if (character === "`") {
      return { end: index + 1, expressions, value };
    }
    if (character === "$" && source[index + 1] === "{") {
      const expressionStart = index + 2;
      const expressionEnd = findTemplateExpressionEnd(source, expressionStart);
      expressions.push(source.slice(expressionStart, expressionEnd));
      index = expressionEnd;
      continue;
    }
    value += character;
  }
  return { end: source.length, expressions, value: undefined };
}

function closesControlCondition(tokens) {
  let depth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    if (tokens[index].value === "(") {
      depth -= 1;
      if (depth === 0) {
        const keyword = tokens[index - 1];
        return (
          keyword?.kind === "identifier" &&
          new Set(["catch", "for", "if", "switch", "while", "with"]).has(
            keyword.value,
          )
        );
      }
    }
  }
  return false;
}

function isRegexStart(tokens) {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined) return true;
  if (previous.kind === "identifier") {
    return new Set([
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "of",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ]).has(previous.value);
  }
  if (previous.value === ")" && closesControlCondition(tokens)) return true;
  if (previous.value === "}" && previous.expressionEnding === false) {
    return true;
  }
  if (
    previous.kind === "literal" ||
    previous.kind === "template" ||
    previous.kind === "number" ||
    previous.kind === "regex"
  ) {
    return false;
  }
  return !new Set([")", "]", "}", "++", "--"]).has(previous.value);
}

function isStatementStart(tokens, index) {
  let previous = tokens[index];
  while (
    previous?.kind === "identifier" &&
    new Set(["abstract", "async", "declare", "default"]).has(previous.value)
  ) {
    index -= 1;
    previous = tokens[index];
  }
  return (
    previous === undefined ||
    previous.value === ";" ||
    (previous.value === "{" && previous.statementBlock === true) ||
    (previous.value === "}" && previous.expressionEnding === false) ||
    previous.value === "export"
  );
}

function functionDeclarationBody(tokens) {
  let depth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    if (tokens[index].value === "(") {
      depth -= 1;
      if (depth !== 0) continue;
      let functionIndex = index - 1;
      if (tokens[functionIndex]?.value !== "function") functionIndex -= 1;
      if (tokens[functionIndex]?.value === "*") functionIndex -= 1;
      const functionToken = tokens[functionIndex];
      if (functionToken?.value !== "function") return false;
      return isStatementStart(tokens, functionIndex - 1);
    }
  }
  return false;
}

function classDeclarationBody(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].value === ";" || tokens[index].value === "{") break;
    if (
      tokens[index].kind === "identifier" &&
      tokens[index].value === "class"
    ) {
      return isStatementStart(tokens, index - 1);
    }
  }
  return false;
}

function labelledStatementBlock(tokens) {
  const label = tokens[tokens.length - 2];
  return (
    tokens[tokens.length - 1]?.value === ":" &&
    label?.kind === "identifier" &&
    isStatementStart(tokens, tokens.length - 3)
  );
}

function opensStatementBlock(tokens) {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined || previous.value === ";") return true;
  if (previous.value === "=>") return false;
  if (previous.value === "{" && previous.statementBlock === true) return true;
  if (previous.value === ")") {
    return closesControlCondition(tokens) || functionDeclarationBody(tokens);
  }
  if (classDeclarationBody(tokens) || labelledStatementBlock(tokens))
    return true;
  if (previous.value === "}" && previous.expressionEnding === false) {
    return true;
  }
  return (
    previous.kind === "identifier" &&
    new Set(["catch", "do", "else", "finally", "try"]).has(previous.value)
  );
}

function skipRegexLiteral(source, start) {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      let end = index + 1;
      while (/[A-Za-z]/.test(source[end] ?? "")) end += 1;
      return end;
    }
  }
  return source.length;
}

function lexicalTokens(source) {
  const tokens = [];
  const braces = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
    } else if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      const literal = readQuotedLiteral(source, index, character);
      if (literal.value !== undefined) {
        tokens.push({ kind: "literal", value: literal.value });
      }
      index = literal.end;
    } else if (character === "`") {
      const literal = readTemplateLiteral(source, index);
      if (literal.value !== undefined && literal.expressions.length === 0) {
        tokens.push({ kind: "template", value: literal.value });
      }
      for (const expression of literal.expressions) {
        tokens.push(...lexicalTokens(expression));
      }
      index = literal.end;
    } else if (character === "/" && isRegexStart(tokens)) {
      index = skipRegexLiteral(source, index);
      tokens.push({ kind: "regex", value: "" });
    } else if (isIdentifierStart(character)) {
      let end = index + 1;
      while (isIdentifierPart(source[end] ?? "")) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
    } else if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9._]/.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "number", value: source.slice(index, end) });
      index = end;
    } else {
      const pair = source.slice(index, index + 2);
      const value = pair === "=>" || pair === "?." ? pair : character;
      if (value === "{") {
        const statementBlock = opensStatementBlock(tokens);
        braces.push(statementBlock ? "block" : "object");
        tokens.push({ kind: "punctuation", value, statementBlock });
      } else if (value === "}") {
        const kind = braces.pop();
        tokens.push({
          kind: "punctuation",
          value,
          expressionEnding: kind === "object",
        });
      } else {
        tokens.push({ kind: "punctuation", value });
      }
      index += value.length;
    }
  }
  return tokens;
}

function literalSpecifier(token) {
  return token?.kind === "literal" || token?.kind === "template"
    ? token.value
    : undefined;
}

function wrappedLiteralSpecifier(tokens, start) {
  let index = start;
  while (tokens[index]?.value === "(") index += 1;
  return literalSpecifier(tokens[index]);
}

function staticSpecifier(tokens, start) {
  const first = literalSpecifier(tokens[start + 1]);
  if (first !== undefined) return first;
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === ";") break;
    if (tokens[index].kind === "identifier" && tokens[index].value === "from") {
      const specifier = literalSpecifier(tokens[index + 1]);
      if (specifier !== undefined) return specifier;
    }
  }
  return undefined;
}

function importSpecifiers(source, file) {
  const specifiers = [];
  const scripts = file.endsWith(".vue") ? vueScripts(source) : [source];
  for (const script of scripts) {
    const tokens = lexicalTokens(script);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if (
        token.kind === "identifier" &&
        token.value === "import" &&
        previous?.value !== "." &&
        next?.value !== "."
      ) {
        const dynamic =
          next?.value === "("
            ? wrappedLiteralSpecifier(tokens, index + 2)
            : undefined;
        const specifier = dynamic ?? staticSpecifier(tokens, index);
        if (specifier !== undefined) specifiers.push(specifier);
      } else if (token.kind === "identifier" && token.value === "export") {
        const specifier = staticSpecifier(tokens, index);
        if (specifier !== undefined) specifiers.push(specifier);
      } else if (
        token.kind === "identifier" &&
        token.value === "require" &&
        previous?.value !== "." &&
        previous?.value !== "?."
      ) {
        const callIndex =
          next?.value === "("
            ? index + 1
            : next?.value === "?." && tokens[index + 2]?.value === "("
              ? index + 2
              : undefined;
        const specifier =
          callIndex === undefined
            ? undefined
            : wrappedLiteralSpecifier(tokens, callIndex + 1);
        if (specifier !== undefined) specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

export async function checkBoundaries(repoRoot = process.cwd()) {
  const violations = [];
  async function readJson(relativePath) {
    return JSON.parse(
      await readFile(path.join(repoRoot, relativePath), "utf8"),
    );
  }

  async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(entryPath);
        return /\.(?:ts|tsx|js|mjs|vue)$/.test(entry.name) ? [entryPath] : [];
      }),
    );
    return nested.flat();
  }

  const coreManifest = await readJson("packages/core/package.json");
  const coreDependencies = {
    ...coreManifest.dependencies,
    ...coreManifest.optionalDependencies,
    ...coreManifest.peerDependencies,
  };
  for (const dependency of Object.keys(coreDependencies)) {
    violations.push(
      `packages/core must not have runtime dependency '${dependency}'`,
    );
  }

  const forbidden = [
    /^@nestjs(?:\/|$)/,
    /^@prisma(?:\/|$)/,
    /^@taven\/(?:openapi(?:-client)?|slicer-contracts|ui-web|backend|web|admin|slicer-worker)(?:\/|$)/,
    /(?:^|\/)packages\/(?:openapi-client\/generated|slicer-contracts)(?:\/|$)/,
    /^(?:bullmq|ioredis|redis)(?:\/|$)/,
    /^@aws-sdk(?:\/|$)/,
    /^(?:prisma|@prisma\/client)(?:\/|$)/,
    /^(?:vue|@vue)(?:\/|$)/,
    /(?:^|\/)apps\/(?:backend|web|admin|slicer-worker)(?:\/|$)/,
    /(?:^|\/)storage(?:\/|$)/,
  ];
  for (const file of await sourceFiles(
    path.join(repoRoot, "packages/core/src"),
  )) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source, file)) {
      const candidates = [specifier];
      if (specifier.startsWith(".")) {
        candidates.push(
          path.relative(repoRoot, path.resolve(path.dirname(file), specifier)),
        );
      }
      if (
        candidates.some((candidate) =>
          forbidden.some((pattern) => pattern.test(candidate)),
        )
      ) {
        violations.push(
          `${path.relative(repoRoot, file)} imports forbidden '${specifier}'`,
        );
      }
    }
  }

  for (const relativePath of ["packages/openapi-client/generated/schema.ts"]) {
    const generated = await readFile(path.join(repoRoot, relativePath), "utf8");
    if (
      !generated.includes("This file was auto-generated by openapi-typescript")
    ) {
      violations.push(`${relativePath} is missing its generator marker`);
    }
  }

  const slicerFiles = await sourceFiles(
    path.join(repoRoot, "packages/slicer-contracts/src"),
  );
  const forbiddenSlicerImplementation = [
    /^@taven\/(?:backend|slicer-worker)(?:\/|$)/,
    /(?:^|\/)apps\/(?:backend|slicer-worker)(?:\/|$)/,
  ];
  for (const file of slicerFiles) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source, file)) {
      const candidates = [specifier];
      if (specifier.startsWith(".")) {
        candidates.push(
          path.relative(repoRoot, path.resolve(path.dirname(file), specifier)),
        );
      }
      if (
        candidates.some((candidate) =>
          forbiddenSlicerImplementation.some((pattern) =>
            pattern.test(candidate),
          ),
        )
      ) {
        violations.push(
          `${path.relative(repoRoot, file)} imports an application implementation`,
        );
      }
    }
  }

  return violations;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const violations = await checkBoundaries();
  if (violations.length > 0) {
    console.error(violations.map((violation) => `- ${violation}`).join("\n"));
    process.exit(1);
  }
  console.log("Workspace boundaries are valid.");
}
