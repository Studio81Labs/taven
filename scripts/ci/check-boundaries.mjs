import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function vueScripts(source) {
  return Array.from(
    source.matchAll(
      /<!--[\s\S]*?-->|<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi,
    ),
    (match) => match[1],
  ).filter((script) => script !== undefined);
}

const identifierStartPattern = /^[$_\p{ID_Start}]$/u;
const identifierPartPattern = /^[$_\u200c\u200d\p{ID_Continue}]$/u;

function isIdentifierStart(character) {
  return identifierStartPattern.test(character);
}

function isIdentifierPart(character) {
  return identifierPartPattern.test(character);
}

function readIdentifierEscape(source, start) {
  if (source[start] !== "\\" || source[start + 1] !== "u") return undefined;
  if (source[start + 2] === "{") {
    const close = source.indexOf("}", start + 3);
    if (close === -1) return undefined;
    const digits = source.slice(start + 3, close);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return undefined;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) return undefined;
    return { end: close + 1, value: String.fromCodePoint(codePoint) };
  }
  const digits = source.slice(start + 2, start + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return undefined;
  return {
    end: start + 6,
    value: String.fromCodePoint(Number.parseInt(digits, 16)),
  };
}

function readIdentifier(source, start) {
  let index = start;
  let value = "";
  let escaped = false;
  while (index < source.length) {
    const escape = readIdentifierEscape(source, index);
    const codePoint = source.codePointAt(index);
    const character =
      escape?.value ??
      (codePoint === undefined ? undefined : String.fromCodePoint(codePoint));
    if (character === undefined) break;
    const valid =
      value.length === 0
        ? isIdentifierStart(character)
        : isIdentifierPart(character);
    if (!valid) break;
    value += character;
    if (escape !== undefined) {
      escaped = true;
      index = escape.end;
    } else {
      index += character.length;
    }
  }
  return index === start ? undefined : { end: index, escaped, value };
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
    const identifier = readIdentifier(source, index);
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
    } else if (identifier !== undefined) {
      tokens.push({
        kind: "identifier",
        value: identifier.value,
        escaped: identifier.escaped,
      });
      index = identifier.end;
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
  const head = statementHeadIndex(tokens);
  const functionIndex = tokens.findIndex(
    (token, index) => index >= head && rawIdentifier(token, "function"),
  );
  if (functionIndex === -1 || !isStatementStart(tokens, functionIndex - 1)) {
    return false;
  }
  let angleDepth = 0;
  let parameterStart = -1;
  for (let index = functionIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "<") angleDepth += 1;
    if (value === ">" && angleDepth > 0) angleDepth -= 1;
    if (value === "(" && angleDepth === 0) {
      parameterStart = index;
      break;
    }
  }
  if (parameterStart === -1) return false;
  let parameterDepth = 0;
  let parameterEnd = -1;
  for (let index = parameterStart; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") parameterDepth += 1;
    if (tokens[index].value === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parameterEnd = index;
        break;
      }
    }
  }
  if (parameterEnd === -1) return false;
  const tail = tokens.slice(parameterEnd + 1);
  if (tail.length === 0) return true;
  if (tail[0]?.value !== ":") return true;
  const returnType = tail.slice(1);
  if (returnType.length === 0) return false;
  const header = balancedDeclarationHeader(returnType, 0);
  const previous = returnType.at(-1)?.value;
  return (
    header.balanced &&
    !new Set(["&", ",", ":", "=", "=>", "?", "|"]).has(previous)
  );
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

function statementHeadIndex(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (
      token.value === ";" ||
      (token.value === "{" && token.statementBlock === true) ||
      (token.value === "}" && token.expressionEnding === false)
    ) {
      return index + 1;
    }
  }
  return 0;
}

function rawIdentifier(token, value) {
  return (
    token?.kind === "identifier" &&
    token.escaped !== true &&
    token.value === value
  );
}

function balancedDeclarationHeader(tokens, start) {
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let topLevelAssignment = false;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "<") angleDepth += 1;
    if (value === ">" && angleDepth > 0) angleDepth -= 1;
    if (value === "(") parenthesisDepth += 1;
    if (value === ")" && parenthesisDepth > 0) parenthesisDepth -= 1;
    if (value === "[") bracketDepth += 1;
    if (value === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (
      value === "=" &&
      angleDepth === 0 &&
      parenthesisDepth === 0 &&
      bracketDepth === 0
    ) {
      topLevelAssignment = true;
    }
  }
  return {
    balanced: angleDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0,
    topLevelAssignment,
  };
}

function typescriptDeclarationBody(tokens) {
  let cursor = statementHeadIndex(tokens);
  let declared = false;
  while (
    ["abstract", "async", "declare", "default", "export"].some((value) =>
      rawIdentifier(tokens[cursor], value),
    )
  ) {
    declared ||= rawIdentifier(tokens[cursor], "declare");
    cursor += 1;
  }
  if (
    rawIdentifier(tokens[cursor], "const") &&
    rawIdentifier(tokens[cursor + 1], "enum")
  ) {
    cursor += 1;
  }
  const keyword = tokens[cursor];
  const header = balancedDeclarationHeader(tokens, cursor + 1);
  if (!header.balanced) return false;
  if (rawIdentifier(keyword, "global")) {
    return declared && cursor === tokens.length - 1;
  }
  if (rawIdentifier(keyword, "type")) {
    return (
      tokens[cursor + 1]?.kind === "identifier" && header.topLevelAssignment
    );
  }
  return (
    !header.topLevelAssignment &&
    ["enum", "interface", "module", "namespace"].some((value) =>
      rawIdentifier(keyword, value),
    )
  );
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
  if (
    functionDeclarationBody(tokens) ||
    classDeclarationBody(tokens) ||
    typescriptDeclarationBody(tokens) ||
    labelledStatementBlock(tokens)
  )
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
    const identifier = readIdentifier(source, index);
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
    } else if (identifier !== undefined) {
      tokens.push({
        kind: "identifier",
        value: identifier.value,
        escaped: identifier.escaped,
      });
      index = identifier.end;
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

function matchingOpenParenthesis(tokens, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    if (tokens[index].value === "(") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function matchingCloseParenthesis(tokens, openIndex, end = tokens.length) {
  let depth = 0;
  for (let index = openIndex; index < end; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function stripCompleteParentheses(tokens, start, end) {
  while (tokens[start]?.value === "(") {
    const close = matchingCloseParenthesis(tokens, start, end);
    if (close !== end - 1) break;
    start += 1;
    end -= 1;
  }
  return { end, start };
}

function finalSequenceOperand(tokens, start, end) {
  while (start < end) {
    const expression = stripCompleteParentheses(tokens, start, end);
    start = expression.start;
    end = expression.end;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let finalComma = -1;
    for (let index = start; index < end; index += 1) {
      const value = tokens[index].value;
      if (value === "(") parenthesisDepth += 1;
      if (value === ")") parenthesisDepth -= 1;
      if (value === "[") bracketDepth += 1;
      if (value === "]") bracketDepth -= 1;
      if (value === "{") braceDepth += 1;
      if (value === "}") braceDepth -= 1;
      if (
        value === "," &&
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        finalComma = index;
      }
    }
    if (finalComma === -1) break;
    start = finalComma + 1;
  }
  return stripCompleteParentheses(tokens, start, end);
}

function exactLiteralSpecifier(tokens, start, end) {
  const expression = finalSequenceOperand(tokens, start, end);
  return expression.end - expression.start === 1
    ? literalSpecifier(tokens[expression.start])
    : undefined;
}

function wrappedLiteralSpecifier(tokens, start) {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let end = start;
  for (; end < tokens.length; end += 1) {
    const value = tokens[end].value;
    if (
      (value === ")" &&
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0) ||
      (value === "," &&
        parenthesisDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0)
    ) {
      break;
    }
    if (value === "(") parenthesisDepth += 1;
    if (value === ")") parenthesisDepth -= 1;
    if (value === "[") bracketDepth += 1;
    if (value === "]") bracketDepth -= 1;
    if (value === "{") braceDepth += 1;
    if (value === "}") braceDepth -= 1;
  }
  return exactLiteralSpecifier(tokens, start, end);
}

function groupingParenthesis(tokens, openIndex) {
  const previous = tokens[openIndex - 1];
  if (previous === undefined) return true;
  if (previous.kind === "identifier") {
    return new Set([
      "await",
      "case",
      "default",
      "delete",
      "do",
      "else",
      "extends",
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
  if (
    previous.kind === "literal" ||
    previous.kind === "template" ||
    previous.kind === "number" ||
    previous.kind === "regex"
  ) {
    return false;
  }
  if (previous.value === ")") {
    return closesControlCondition(tokens.slice(0, openIndex));
  }
  return !new Set(["#", ")", ".", "?.", "]", "}", "++", "--"]).has(
    previous.value,
  );
}

function exactRequireExpression(tokens, start, end, requireIndex) {
  const expression = finalSequenceOperand(tokens, start, end);
  return (
    expression.start === requireIndex && expression.end === requireIndex + 1
  );
}

function callOpening(tokens, index) {
  if (tokens[index]?.value === "(") return index;
  return tokens[index]?.value === "?." && tokens[index + 1]?.value === "("
    ? index + 1
    : undefined;
}

function requireCallOpening(tokens, requireIndex) {
  const direct = callOpening(tokens, requireIndex + 1);
  if (direct !== undefined) return direct;
  let cursor = requireIndex + 1;
  if (tokens[cursor]?.value !== ")") return undefined;
  while (tokens[cursor]?.value === ")") cursor += 1;
  const call = callOpening(tokens, cursor);
  if (call === undefined) return undefined;
  const closeIndex = cursor - 1;
  const openIndex = matchingOpenParenthesis(tokens, closeIndex);
  if (
    openIndex === undefined ||
    !groupingParenthesis(tokens, openIndex) ||
    !exactRequireExpression(tokens, openIndex + 1, closeIndex, requireIndex)
  ) {
    return undefined;
  }
  return call;
}

function staticSpecifier(tokens, start) {
  const first = literalSpecifier(tokens[start + 1]);
  if (first !== undefined) return first;
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === ";") break;
    if (
      tokens[index].kind === "identifier" &&
      tokens[index].escaped !== true &&
      tokens[index].value === "from"
    ) {
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
        token.escaped !== true &&
        token.value === "import" &&
        previous?.value !== "." &&
        previous?.value !== "?." &&
        previous?.value !== "#" &&
        next?.value !== "."
      ) {
        const dynamic =
          next?.value === "("
            ? wrappedLiteralSpecifier(tokens, index + 2)
            : undefined;
        const specifier = dynamic ?? staticSpecifier(tokens, index);
        if (specifier !== undefined) specifiers.push(specifier);
      } else if (
        token.kind === "identifier" &&
        token.escaped !== true &&
        token.value === "export"
      ) {
        const specifier = staticSpecifier(tokens, index);
        if (specifier !== undefined) specifiers.push(specifier);
      } else if (
        token.kind === "identifier" &&
        token.value === "require" &&
        previous?.value !== "." &&
        previous?.value !== "?." &&
        previous?.value !== "#"
      ) {
        const callIndex = requireCallOpening(tokens, index);
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
