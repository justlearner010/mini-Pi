import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export interface ToolContext {
  rootDir: string;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const SUPPORTED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([".py", ".rs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".rb", ".php", ".cs", ".swift", ".kt", ".scala"]);
const MAX_SCAN_FILES = 500;
const MAX_READ_LINES = 300;
const MAX_READ_BYTES = 256 * 1024;
const MAX_DEPENDENCY_EDGES = 500;
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

type ScanContent = {
  scannedPath: string;
  readmePath: string | null;
  manifestPaths: string[];
  sourceFiles: string[];
  unsupportedFiles: string[];
  tree: string;
  totalRelevantFiles: number;
  returnedFileCount: number;
  truncated: boolean;
};

function isWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative));
}

async function safeProjectPath(rootDir: string, input: string): Promise<{ root: string; path: string }> {
  if (!input || isAbsolute(input)) throw new Error("Path must be relative to the project root");
  const root = await realpath(rootDir);
  const path = resolve(root, input);
  if (!isWithin(root, path)) throw new Error("Path escapes the project root");

  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symlink paths are not allowed");
  }

  const resolvedPath = await realpath(path);
  if (!isWithin(root, resolvedPath)) throw new Error("Path escapes the project root");
  return { root, path };
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function decodeText(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if ([...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  })) throw new Error("Binary files cannot be read");
  return text;
}

function relevantKind(path: string): "readme" | "manifest" | "source" | "unsupported" | "document" | undefined {
  const name = basename(path).toLowerCase();
  if (name === "readme.md" || name === "readme") return "readme";
  if (name === "package.json" || /^tsconfig.*\.json$/.test(name)) return "manifest";
  const extension = extname(name);
  if (SUPPORTED_SOURCE_EXTENSIONS.has(extension)) return "source";
  if (UNSUPPORTED_SOURCE_EXTENSIONS.has(extension)) return "unsupported";
  if (extension === ".md" || extension === ".json") return "document";
  return undefined;
}

async function collectFiles(root: string, directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) await collectFiles(root, entryPath, files);
    } else if (entry.isFile() && relevantKind(entryPath)) {
      files.push(relativePath(root, entryPath));
    }
  }
}

export const scanProjectTool: Tool = {
  name: "scan_project",
  description: "List relevant project files without leaving the project root.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Optional relative directory to scan" } },
    additionalProperties: false
  },
  async execute(args, context) {
    try {
      const root = await realpath(context.rootDir);
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "path")) throw new Error("Arguments must be an object with an optional path");
      const requestedPath = "path" in args ? args.path : ".";
      if (requestedPath !== undefined && typeof requestedPath !== "string") throw new Error("Scan path must be a string");
      const { path: scanPath } = await safeProjectPath(root, requestedPath ?? ".");
      if (!(await lstat(scanPath)).isDirectory()) throw new Error("Scan path is not a directory");
      const files: string[] = [];
      await collectFiles(root, scanPath, files);
      files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const returnedFiles = files.slice(0, MAX_SCAN_FILES);
      const pick = (kind: ReturnType<typeof relevantKind>) => returnedFiles.filter((file) => relevantKind(file) === kind);
      const content: ScanContent = {
        scannedPath: relativePath(root, scanPath) || ".",
        readmePath: pick("readme")[0] ?? null,
        manifestPaths: pick("manifest"),
        sourceFiles: pick("source"),
        unsupportedFiles: pick("unsupported"),
        tree: returnedFiles.join("\n"),
        totalRelevantFiles: files.length,
        returnedFileCount: returnedFiles.length,
        truncated: files.length > returnedFiles.length
      };
      return { content, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : "Unable to scan project", isError: true };
    }
  }
};

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a text file safely from the project root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, context) {
    try {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "path" && key !== "startLine" && key !== "endLine") || !("path" in args) || typeof args.path !== "string") throw new Error("Arguments must contain only path, startLine, and endLine");
      const { path: requestedPath, startLine, endLine } = args as { path: string; startLine?: unknown; endLine?: unknown };
      const { root, path } = await safeProjectPath(context.rootDir, requestedPath);
      const file = await lstat(path);
      if (!file.isFile()) throw new Error("Path is not a file");
      const bytes = await readFile(path);
      const text = decodeText(bytes);
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const totalLines = lines.length;
      const from = startLine === undefined ? 1 : startLine;
      const requestedEnd = endLine === undefined ? undefined : endLine;
      if (!Number.isInteger(from) || !Number.isInteger(requestedEnd) && requestedEnd !== undefined || (from as number) < 1 || (requestedEnd !== undefined && (requestedEnd as number) < (from as number))) throw new Error("Line ranges must be positive integers");
      const start = Math.min(from as number, Math.max(totalLines, 1));
      const maximumEnd = Math.min(totalLines, start + MAX_READ_LINES - 1);
      const end = requestedEnd === undefined ? maximumEnd : Math.min(requestedEnd as number, maximumEnd);
      const selectedLines = lines.slice(start - 1, end);
      let content = "";
      let contentBytes = 0;
      let byteTruncated = false;
      for (const line of selectedLines) {
        const separator = content ? "\n" : "";
        const addition = separator + line;
        const additionBytes = Buffer.byteLength(addition, "utf8");
        if (contentBytes + additionBytes <= MAX_READ_BYTES) {
          content += addition;
          contentBytes += additionBytes;
          continue;
        }
        byteTruncated = true;
        for (const character of addition) {
          const characterBytes = Buffer.byteLength(character, "utf8");
          if (contentBytes + characterBytes > MAX_READ_BYTES) break;
          content += character;
          contentBytes += characterBytes;
        }
        break;
      }
      return {
        content: {
          path: relativePath(root, path),
          startLine: start,
          endLine: end,
          totalLines,
          content,
          truncated: byteTruncated || (end < totalLines && (requestedEnd === undefined || (requestedEnd as number) > end))
        },
        isError: false
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : "Unable to read file", isError: true };
    }
  }
};

type DependencyKind = "import" | "export";
type Dependency = { from: string; specifier: string; kind: DependencyKind; typeOnly: boolean };
type DependencyEdge = Dependency & { to: string };
type UnresolvedDependency = Dependency & { reason: "alias" | "missing" | "unsupported" };

function isSourcePath(path: string): boolean {
  return SUPPORTED_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function compareDependency(left: Dependency, right: Dependency): number {
  return left.from.localeCompare(right.from) || left.specifier.localeCompare(right.specifier) || left.kind.localeCompare(right.kind) || Number(left.typeOnly) - Number(right.typeOnly);
}

function extractImports(path: string, text: string): Dependency[] {
  const imports: Dependency[] = [];
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    if (kind !== SyntaxKind.ImportKeyword && kind !== SyntaxKind.ExportKeyword) { kind = scanner.scan(); continue; }
    const dependencyKind: DependencyKind = kind === SyntaxKind.ImportKeyword ? "import" : "export";
    let typeOnly = false;
    let next = scanner.scan();
    if (next === SyntaxKind.TypeKeyword) { typeOnly = true; next = scanner.scan(); }
    const sideEffectImport = dependencyKind === "import" && next === SyntaxKind.StringLiteral;
    let sawFrom = false;
    while (next !== SyntaxKind.EndOfFile && next !== SyntaxKind.SemicolonToken) {
      if (next === SyntaxKind.FromKeyword) sawFrom = true;
      if (next === SyntaxKind.StringLiteral) {
        if (sideEffectImport || sawFrom) imports.push({ from: path, specifier: scanner.getTokenValue(), kind: dependencyKind, typeOnly });
        break;
      }
      next = scanner.scan();
    }
    kind = scanner.scan();
  }
  return imports;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveImportPath(root: string, from: string, specifier: string): Promise<{ path?: string; reason?: "alias" | "missing" | "unsupported" }> {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return { reason: "alias" };
  const base = resolve(root, from, "..");
  const target = resolve(base, specifier);
  if (!isWithin(root, target)) return { reason: "missing" };
  const extension = extname(target).toLowerCase();
  if (extension && !SUPPORTED_SOURCE_EXTENSIONS.has(extension)) return { reason: "unsupported" };
  const candidates = extension
    ? [target, ...(extension === ".js" ? [target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx"] : [])]
    : [...RESOLVABLE_EXTENSIONS.map((item) => target + item), ...RESOLVABLE_EXTENSIONS.map((item) => resolve(target, "index" + item))];
  for (const candidate of candidates) if (await fileExists(candidate)) return isSourcePath(candidate) ? { path: relativePath(root, candidate) } : { reason: "unsupported" };
  return { reason: "missing" };
}

function canonicalCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  const variants = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)]);
  variants.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...variants[0], variants[0][0]];
}

function findCycles(files: string[], edges: DependencyEdge[]): string[][] {
  const adjacency = new Map(files.map((file) => [file, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const paths of adjacency.values()) paths.sort((left, right) => left.localeCompare(right));
  const visited = new Set<string>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycles = new Map<string, string[]>();
  const visit = (file: string) => {
    visited.add(file); active.add(file); stack.push(file);
    for (const next of adjacency.get(file) ?? []) {
      if (active.has(next)) {
        const cycle = canonicalCycle([...stack.slice(stack.indexOf(next)), next]);
        cycles.set(cycle.join("\0"), cycle);
      } else if (!visited.has(next)) visit(next);
    }
    stack.pop(); active.delete(file);
  };
  for (const file of files) if (!visited.has(file)) visit(file);
  return [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function buildEntryTree(entry: string, edges: DependencyEdge[]): string {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge.to);
  for (const paths of adjacency.values()) paths.sort((left, right) => left.localeCompare(right));
  const shown = new Set<string>();
  const lines: string[] = [];
  const visit = (file: string, depth: number, ancestors: Set<string>) => {
    const indent = "  ".repeat(depth);
    if (ancestors.has(file)) { lines.push(`${indent}${file} [cycle]`); return; }
    if (shown.has(file)) { lines.push(`${indent}${file} [already shown]`); return; }
    shown.add(file); lines.push(`${indent}${file}`);
    const nextAncestors = new Set(ancestors); nextAncestors.add(file);
    for (const child of adjacency.get(file) ?? []) visit(child, depth + 1, nextAncestors);
  };
  visit(entry, 0, new Set());
  return lines.join("\n");
}

export const analyzeDependenciesTool: Tool = {
  name: "analyze_dependencies",
  description: "Analyze static TypeScript and JavaScript dependency relationships safely.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, entry: { type: "string" } },
    additionalProperties: false
  },
  async execute(args, context) {
    try {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "path" && key !== "entry")) throw new Error("Arguments must be an object with optional path and entry");
      const input = args as { path?: unknown; entry?: unknown };
      if (input.path !== undefined && typeof input.path !== "string" || input.entry !== undefined && typeof input.entry !== "string") throw new Error("Path and entry must be strings");
      const root = await realpath(context.rootDir);
      const { path: scanPath } = await safeProjectPath(root, (input.path as string | undefined) ?? ".");
      if (!(await lstat(scanPath)).isDirectory()) throw new Error("Scan path is not a directory");
      const discovered: string[] = [];
      await collectFiles(root, scanPath, discovered);
      discovered.sort((left, right) => left.localeCompare(right));
      const analyzedFiles = discovered.filter(isSourcePath);
      const unsupportedFiles = discovered.filter((file) => relevantKind(file) === "unsupported");
      let entry: string | undefined;
      if (input.entry !== undefined) {
        const entryResult = await safeProjectPath(root, input.entry as string);
        if (!(await lstat(entryResult.path)).isFile() || !isSourcePath(entryResult.path) || !isWithin(scanPath, entryResult.path)) throw new Error("Entry must be a supported source file within the analysis path");
        entry = relativePath(root, entryResult.path);
      }
      const edges: DependencyEdge[] = [], builtins: { from: string; specifier: string }[] = [], packages: { from: string; packageName: string; specifier: string }[] = [], unresolved: UnresolvedDependency[] = [];
      for (const file of analyzedFiles) {
        const imports = extractImports(file, await readFile(resolve(root, file), "utf8"));
        for (const dependency of imports) {
          const bareSpecifier = dependency.specifier.replace(/^node:/, "");
          if (BUILTINS.has(bareSpecifier)) builtins.push({ from: file, specifier: dependency.specifier });
          else if (!dependency.specifier.startsWith(".") && !dependency.specifier.startsWith("/")) {
            if (dependency.specifier.startsWith("@/")) unresolved.push({ ...dependency, reason: "alias" });
            else {
              const parts = dependency.specifier.split("/");
              packages.push({ from: file, packageName: dependency.specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0], specifier: dependency.specifier });
            }
          } else {
            const resolved = await resolveImportPath(root, file, dependency.specifier);
            if (resolved.path) edges.push({ ...dependency, to: resolved.path });
            else unresolved.push({ ...dependency, reason: resolved.reason ?? "missing" });
          }
        }
      }
      edges.sort((left, right) => compareDependency(left, right) || left.to.localeCompare(right.to));
      builtins.sort((left, right) => left.from.localeCompare(right.from) || left.specifier.localeCompare(right.specifier));
      packages.sort((left, right) => left.from.localeCompare(right.from) || left.packageName.localeCompare(right.packageName) || left.specifier.localeCompare(right.specifier));
      unresolved.sort(compareDependency);
      const returnedEdges = edges.slice(0, MAX_DEPENDENCY_EDGES);
      return { content: {
        analyzedPath: relativePath(root, scanPath) || ".", entry: entry ?? null, analyzedFiles, unsupportedFiles, edges: returnedEdges, builtins, packages, unresolved,
        cycles: findCycles(analyzedFiles, edges), entryTree: entry ? buildEntryTree(entry, edges) : null,
        analyzedFileCount: analyzedFiles.length, totalEdgeCount: edges.length, returnedEdgeCount: returnedEdges.length, truncated: edges.length > returnedEdges.length
      }, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : "Unable to analyze dependencies", isError: true };
    }
  }
};

export const tools: Tool[] = [scanProjectTool, readFileTool, analyzeDependenciesTool];
