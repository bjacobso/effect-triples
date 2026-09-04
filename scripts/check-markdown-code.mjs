import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".turbo", "dist", "node_modules"]);

const markdownFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : markdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
};

const snippetsIn = async (path) => {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const snippets = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^```(?:ts|typescript)\s+check\s*$/.test(lines[index])) continue;
    const start = index + 2;
    const body = [];
    index++;
    while (index < lines.length && lines[index] !== "```") {
      body.push(lines[index]);
      index++;
    }
    if (index === lines.length) {
      throw new Error(`${relative(root, path)}:${start}: unterminated checked TypeScript fence`);
    }
    snippets.push({ path, start, body: body.join("\n") });
  }
  return snippets;
};

const invalidYieldDelegationsIn = async (path) => {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const failures = [];

  for (let index = 0; index < lines.length; index++) {
    if (!/^```(?:ts|typescript)(?:\s+.*)?$/.test(lines[index])) continue;
    const start = index + 2;
    const body = [];
    index++;
    while (index < lines.length && lines[index] !== "```") {
      body.push(lines[index]);
      index++;
    }
    if (index === lines.length) continue;

    const source = ts.createSourceFile(
      "markdown-fence.ts",
      body.join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === "yield"
      ) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${relative(root, path)}:${start + location.line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return failures;
};

const files = await markdownFiles(root);
const invalidYieldDelegations = (await Promise.all(files.map(invalidYieldDelegationsIn))).flat();
if (invalidYieldDelegations.length > 0) {
  throw new Error(
    "Markdown TypeScript fences must place yield* inside a generator; " +
      `invalid delegated yields found at:\n${invalidYieldDelegations.join("\n")}`,
  );
}

const snippets = (await Promise.all(files.map(snippetsIn))).flat();
if (snippets.length === 0) {
  throw new Error(
    "No checked Markdown snippets found; mark self-contained fences with ```ts check",
  );
}

// Keep virtual consumers below a workspace package so normal Node resolution finds
// its workspace-linked dependencies and the built package export maps.
const temporaryRoot = await mkdtemp(join(root, "test/integration/.markdown-snippets-"));
const origins = new Map();

try {
  const sourceFiles = [];
  for (const [index, snippet] of snippets.entries()) {
    const source = join(temporaryRoot, `${index}-${basename(snippet.path, ".md")}.mts`);
    await writeFile(source, snippet.body, "utf8");
    sourceFiles.push(source);
    origins.set(source, { path: relative(root, snippet.path), start: snippet.start });
  }

  const program = ts.createProgram(sourceFiles, {
    allowImportingTsExtensions: true,
    exactOptionalPropertyTypes: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const formatted = diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const origin = origins.get(diagnostic.file.fileName);
      if (origin === undefined) {
        return `${relative(root, diagnostic.file.fileName)}:${location.line + 1}:${location.character + 1}: ${message}`;
      }
      return `${origin.path}:${origin.start + location.line}:${location.character + 1}: ${message}`;
    });
    throw new Error(`Markdown TypeScript check failed:\n${formatted.join("\n")}`);
  }

  console.log(`Typechecked ${snippets.length} Markdown TypeScript snippets.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
