import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import ignore from "ignore";
import ts from "typescript";

export interface ToolContext {
  rootDir: string;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
  historyContent?: string;
}

export type ToolPermission = "SAFE" | "SENSITIVE" | "DESTRUCTIVE";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: ToolPermission;
  reason: string;
  risk: string;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const SUPPORTED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([".py", ".rs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".rb", ".php", ".cs", ".swift", ".kt", ".scala"]);
const MAX_SCAN_FILES = 500;
const MAX_READ_LINES = 300;
const MAX_READ_BYTES = 256 * 1024;
const MAX_DEPENDENCY_EDGES = 500;
const MAX_DEPENDENCY_CYCLES = 500;
const MAX_DEPENDENCY_CYCLE_STEPS = 100_000;
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

export interface RepositoryIndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const REPOSITORY_INDEX_LIMITS: RepositoryIndexLimits = {
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 50 * 1024 * 1024
};

export type SourceKind = "ts" | "tsx" | "js" | "jsx" | "dts";
export interface DiscoveredSource { path: string; sourceKind: SourceKind; bytes: number; text: string; }
export interface RepositoryDiscovery {
  files: DiscoveredSource[];
  supportedFileCount: number;
  unsupportedLanguageFiles: number;
  nestedGitignoreFiles: number;
  inspectedBytes: number;
  skipped: { fileLimit: number; fileTooLarge: number; totalBytes: number; readError: number };
  truncated: boolean;
}

function sourceKind(path: string): SourceKind | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return "dts";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "js";
  return undefined;
}

export async function discoverRepositorySources(rootDir: string, limits: RepositoryIndexLimits = REPOSITORY_INDEX_LIMITS): Promise<RepositoryDiscovery> {
  if (![limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Repository index limits must be positive integers");
  const root = await realpath(rootDir);
  const matcher = ignore();
  try { matcher.add(await readFile(resolve(root, ".gitignore"), "utf8")); } catch { /* optional root ignore */ }
  const candidates: Array<{ path: string; absolutePath: string; sourceKind: SourceKind }> = [];
  let unsupportedLanguageFiles = 0, nestedGitignoreFiles = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      const path = relativePath(root, absolutePath);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name) || matcher.ignores(`${path}/`)) continue;
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === ".gitignore" && directory !== root) nestedGitignoreFiles += 1;
      if (matcher.ignores(path)) continue;
      const kind = sourceKind(path);
      if (kind) candidates.push({ path, absolutePath, sourceKind: kind });
      else if (UNSUPPORTED_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) unsupportedLanguageFiles += 1;
    }
  };
  await visit(root);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  const files: DiscoveredSource[] = [];
  const skipped = { fileLimit: 0, fileTooLarge: 0, totalBytes: 0, readError: 0 };
  let inspectedBytes = 0;
  for (const candidate of candidates) {
    if (files.length === limits.maxFiles) { skipped.fileLimit += 1; continue; }
    try {
      const bytes = await readFile(candidate.absolutePath);
      if (bytes.byteLength > limits.maxFileBytes) { skipped.fileTooLarge += 1; continue; }
      if (inspectedBytes + bytes.byteLength > limits.maxTotalBytes) { skipped.totalBytes += 1; continue; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      files.push({ path: candidate.path, sourceKind: candidate.sourceKind, bytes: bytes.byteLength, text });
      inspectedBytes += bytes.byteLength;
    } catch { skipped.readError += 1; }
  }
  const truncated = nestedGitignoreFiles > 0 || Object.values(skipped).some((value) => value > 0);
  return { files, supportedFileCount: candidates.length, unsupportedLanguageFiles, nestedGitignoreFiles, inspectedBytes, skipped, truncated };
}

export interface SourceLocation { line: number; column: number; }
export interface ImportInfo { specifier: string; kind: "relative" | "alias" | "package" | "dynamic"; resolvedPath?: string; exported: boolean; }
export interface SymbolInfo {
  name: string;
  kind: "class" | "function" | "interface" | "type" | "enum" | "variable" | "method";
  signature: string;
  exported: boolean;
  location: SourceLocation;
  signatureTruncated: boolean;
}
export type FileArea = "product" | "test" | "vendor" | "example" | "generated";
export interface PackageInfo { root: string; name?: string; workspace: boolean; }
export interface FileInfo {
  path: string; sourceKind: SourceKind; imports: ImportInfo[]; exports: string[];
  symbols: SymbolInfo[]; parseDiagnostics: number;
  area: FileArea; packageRoot: string; packageName?: string;
}
export interface RepositoryIndex {
  files: readonly FileInfo[];
  incoming: ReadonlyMap<string, readonly string[]>;
  outgoing: ReadonlyMap<string, readonly string[]>;
  entryCandidates: readonly string[];
  inspectedFileCount: number;
  inspectedBytes: number;
  skipped: Readonly<Record<string, number>>;
  truncated: boolean;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}
function declarationLocation(source: ts.SourceFile, node: ts.Node): SourceLocation {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: point.line + 1, column: point.character + 1 };
}
function cappedSignature(value: string): Pick<SymbolInfo, "signature" | "signatureTruncated"> {
  const normalized = value.replace(/\s+/g, " ").trim().replace(/\s*\{$/, "");
  return normalized.length <= 240 ? { signature: normalized, signatureTruncated: false } : { signature: `${normalized.slice(0, 239)}…`, signatureTruncated: true };
}
function declarationHeader(source: ts.SourceFile, node: ts.Node, body?: ts.Node): string {
  return source.text.slice(node.getStart(source), body ? body.getStart(source) : node.getEnd()).trim();
}
function symbol(source: ts.SourceFile, node: ts.Node, kind: SymbolInfo["kind"], name: string, exported: boolean, signature: string): SymbolInfo {
  return { name, kind, exported, location: declarationLocation(source, node), ...cappedSignature(signature) };
}
function scriptKind(kind: SourceKind): ts.ScriptKind {
  if (kind === "tsx") return ts.ScriptKind.TSX;
  if (kind === "jsx") return ts.ScriptKind.JSX;
  if (kind === "js") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
function importKind(specifier: string): ImportInfo["kind"] {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) return "alias";
  return "package";
}

export function classifyFileArea(path: string): FileArea {
  const segments = path.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  if (segments.some((segment) => ["test", "tests", "__tests__", "spec", "specs"].includes(segment)) || /\.(test|spec)\.[^.]+$/.test(name)) return "test";
  if (segments.some((segment) => ["vendor", "third_party", "third-party", "external"].includes(segment))) return "vendor";
  if (segments.some((segment) => ["example", "examples", "demo", "demos", "sample"].includes(segment))) return "example";
  if (segments.some((segment) => ["generated", "gen", "codegen"].includes(segment)) || /\.generated\.[^.]+$/.test(name)) return "generated";
  return "product";
}

const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
async function packageAt(root: string, directory: string, cache: Map<string, Promise<PackageInfo | undefined>>): Promise<PackageInfo | undefined> {
  const packageRoot = relativePath(root, directory) || ".";
  let entry = cache.get(packageRoot);
  if (!entry) {
    entry = (async () => {
      try {
        const manifest = resolve(directory, "package.json");
        const status = await lstat(manifest);
        if (!status.isFile() || status.isSymbolicLink()) return undefined;
        const bytes = await readFile(manifest);
        if (bytes.byteLength > MAX_PACKAGE_MANIFEST_BYTES) return undefined;
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const name = typeof (parsed as { name?: unknown }).name === "string" && (parsed as { name: string }).name.trim() ? (parsed as { name: string }).name : undefined;
        return { root: packageRoot, ...(name ? { name } : {}), workspace: packageRoot !== "." };
      } catch { return undefined; }
    })();
    cache.set(packageRoot, entry);
  }
  return entry;
}

async function packageForFile(root: string, path: string, cache: Map<string, Promise<PackageInfo | undefined>>): Promise<PackageInfo> {
  let directory = dirname(resolve(root, path));
  while (isWithin(root, directory)) {
    const found = await packageAt(root, directory, cache);
    if (found) return found;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return { root: ".", workspace: false };
}

async function indexFile(root: string, file: DiscoveredSource, metadata: Pick<FileInfo, "area" | "packageRoot" | "packageName">): Promise<FileInfo> {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind(file.sourceKind));
  const imports: ImportInfo[] = [], symbols: SymbolInfo[] = [], exportedNames: string[] = [];
  for (const statement of source.statements) {
    let specifier: string | undefined, exported = false;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifier = statement.moduleSpecifier.text;
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) { specifier = statement.moduleSpecifier.text; exported = true; }
    if (specifier) {
      const kind = importKind(specifier);
      const resolved = kind === "relative" ? await resolveImportPath(root, file.path, specifier) : {};
      imports.push({ specifier, kind, ...(resolved.path ? { resolvedPath: resolved.path } : {}), exported });
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) exportedNames.push(item.name.text);
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "default class";
      symbols.push(symbol(source, statement, "class", name, isExported, source.text.slice(statement.getStart(source), statement.members.pos)));
      if (isExported) {
        exportedNames.push(name);
        for (const member of statement.members) {
          if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
          if (ts.isConstructorDeclaration(member)) symbols.push(symbol(source, member, "method", "constructor", true, declarationHeader(source, member, member.body)));
          else if (ts.isMethodDeclaration(member) && member.name) symbols.push(symbol(source, member, "method", member.name.getText(source), true, declarationHeader(source, member, member.body)));
        }
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default function";
      symbols.push(symbol(source, statement, "function", name, isExported, declarationHeader(source, statement, statement.body)));
      if (isExported) exportedNames.push(name);
    } else if (ts.isInterfaceDeclaration(statement)) {
      symbols.push(symbol(source, statement, "interface", statement.name.text, isExported, statement.getText(source)));
      if (isExported) exportedNames.push(statement.name.text);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push(symbol(source, statement, "type", statement.name.text, isExported, statement.getText(source)));
      if (isExported) exportedNames.push(statement.name.text);
    } else if (ts.isEnumDeclaration(statement)) {
      symbols.push(symbol(source, statement, "enum", statement.name.text, isExported, source.text.slice(statement.getStart(source), statement.members.pos)));
      if (isExported) exportedNames.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : statement.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
        const signature = `${isExported ? "export " : ""}${keyword} ${declaration.name.text}${declaration.type ? `: ${declaration.type.getText(source)}` : ""}`;
        symbols.push(symbol(source, declaration, "variable", declaration.name.text, isExported, signature));
        if (isExported) exportedNames.push(declaration.name.text);
      }
    }
  }
  const visitDynamic = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push({ specifier: node.arguments[0].text, kind: "dynamic", exported: false });
    ts.forEachChild(node, visitDynamic);
  };
  ts.forEachChild(source, visitDynamic);
  imports.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.kind.localeCompare(right.kind));
  symbols.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  exportedNames.sort((left, right) => left.localeCompare(right));
  return { path: file.path, sourceKind: file.sourceKind, imports, exports: [...new Set(exportedNames)], symbols, parseDiagnostics: (source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length, ...metadata };
}

export async function buildRepositoryIndex(rootDir: string, limits: RepositoryIndexLimits = REPOSITORY_INDEX_LIMITS): Promise<RepositoryIndex> {
  const root = await realpath(rootDir);
  const discovery = await discoverRepositorySources(root, limits);
  const packageCache = new Map<string, Promise<PackageInfo | undefined>>();
  const files = await Promise.all(discovery.files.map(async (file) => {
    const packageInfo = await packageForFile(root, file.path, packageCache);
    return indexFile(root, file, { area: classifyFileArea(file.path), packageRoot: packageInfo.root, ...(packageInfo.name ? { packageName: packageInfo.name } : {}) });
  }));
  const fileNames = new Set(files.map((file) => file.path));
  const outgoing = new Map<string, string[]>(), incoming = new Map<string, string[]>();
  for (const file of files) { outgoing.set(file.path, []); incoming.set(file.path, []); }
  for (const file of files) for (const item of file.imports) if (item.resolvedPath && fileNames.has(item.resolvedPath)) {
    if (!outgoing.get(file.path)!.includes(item.resolvedPath)) outgoing.get(file.path)!.push(item.resolvedPath);
    if (!incoming.get(item.resolvedPath)!.includes(file.path)) incoming.get(item.resolvedPath)!.push(file.path);
  }
  for (const paths of [...outgoing.values(), ...incoming.values()]) paths.sort((left, right) => left.localeCompare(right));
  const entryCandidates = files.map((file) => file.path).filter((path) => ["index", "main", "server", "app", "cli"].includes(path.replace(/\.d\.ts$|\.[^.]+$/i, "").split("/").at(-1) ?? "")).sort((left, right) => left.localeCompare(right));
  return { files, incoming, outgoing, entryCandidates, inspectedFileCount: files.length, inspectedBytes: discovery.inspectedBytes, skipped: Object.freeze({ ...discovery.skipped, nestedGitignore: discovery.nestedGitignoreFiles, unsupportedLanguage: discovery.unsupportedLanguageFiles }), truncated: discovery.truncated };
}

export type QueryRole = "cli" | "adapter" | "loop" | "registry" | "config";
export interface QueryIntent {
  tokens: readonly string[];
  requestedAreas: readonly FileArea[];
  roles: readonly QueryRole[];
  implementationSeeking: boolean;
}
export interface RepoMapCandidate {
  path: string; area: FileArea; packageRoot: string; packageName?: string;
  reasons: string[]; symbols: SymbolInfo[]; incoming: string[]; outgoing: string[];
}
export interface RepoMapResult { query: string; candidates: RepoMapCandidate[]; text: string; confidence: "high" | "ambiguous" | "fallback"; mapTruncated: boolean; }

function tokens(value: string): string[] {
  return value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) if (right.has(item)) count += 1;
  return count;
}

const ROLE_LEXICON: Readonly<Record<QueryRole, { query: readonly string[]; match: readonly string[] }>> = {
  cli: { query: ["cli", "command", "terminal", "shell"], match: ["cli", "command", "bin", "terminal"] },
  adapter: { query: ["adapter", "provider", "llm", "model"], match: ["adapter", "provider", "llm", "client"] },
  loop: { query: ["loop", "agent", "run", "turn"], match: ["agent", "loop", "run", "turn"] },
  registry: { query: ["tool", "tools", "registry", "execute"], match: ["tool", "registry", "execute"] },
  config: { query: ["config", "configuration", "settings", "env"], match: ["config", "settings", "env", "option"] }
};
const AREA_TERMS: Readonly<Record<FileArea, readonly string[]>> = {
  product: [], test: ["test", "spec", "fixture"], vendor: ["vendor", "third", "party"],
  example: ["example", "demo"], generated: ["generated", "codegen"]
};

export function deriveQueryIntent(query: string): QueryIntent {
  const normalized = tokens(query);
  const values = new Set(normalized);
  const roles = (Object.keys(ROLE_LEXICON) as QueryRole[]).filter((role) => ROLE_LEXICON[role].query.some((term) => values.has(term)));
  const requestedAreas = (Object.keys(AREA_TERMS) as FileArea[]).filter((area) => area !== "product" && AREA_TERMS[area].some((term) => values.has(term)));
  return { tokens: normalized, requestedAreas, roles, implementationSeeking: roles.length > 0 && requestedAreas.length === 0 };
}

type CandidateScore = readonly [number, number, number, number, number, number, number, number];
function compareScore(left: CandidateScore, right: CandidateScore): number {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return right[index] - left[index];
  return 0;
}

export function queryRepositoryIndex(index: RepositoryIndex, query: string, options: { maxCharacters?: 4_000 | 8_000; limit?: number } = {}): RepoMapResult {
  const maxCharacters = options.maxCharacters ?? 8_000, limit = options.limit ?? 8;
  if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Repo Map query and limit are invalid");
  const intent = deriveQueryIntent(query);
  const queryTokens = new Set(intent.tokens);
  const ranked = index.files.map((file) => {
    const symbolTokens = new Set(file.symbols.flatMap((item) => tokens(item.name)).concat(file.exports.flatMap(tokens)));
    const pathTokens = new Set(tokens(file.path));
    const packageTokens = new Set(tokens(`${file.packageName ?? ""} ${file.packageRoot}`));
    const exact = file.symbols.some((item) => {
      const nameTokens = tokens(item.name);
      return nameTokens.length > 0 && nameTokens.every((term) => queryTokens.has(term));
    }) || file.exports.some((item) => {
      const nameTokens = tokens(item);
      return nameTokens.length > 0 && nameTokens.every((term) => queryTokens.has(term));
    });
    const symbolMatches = overlap(queryTokens, symbolTokens), pathMatches = overlap(queryTokens, pathTokens);
    const area = intent.requestedAreas.includes(file.area) || (intent.implementationSeeking && file.area === "product");
    const role = intent.roles.filter((item) => ROLE_LEXICON[item].match.some((term) => pathTokens.has(term) || symbolTokens.has(term))).length;
    const packageMatches = overlap(queryTokens, packageTokens);
    const entry = Number(intent.roles.includes("cli") && index.entryCandidates.includes(file.path));
    return { file, score: [Number(exact), Number(area), role, packageMatches, symbolMatches, pathMatches, entry, index.incoming.get(file.path)?.length ?? 0] as CandidateScore };
  });
  ranked.sort((left, right) => {
    return compareScore(left.score, right.score) || left.file.path.localeCompare(right.file.path);
  });
  const seeds = ranked.filter((item) => item.score[0] || item.score[2] || item.score[3] || item.score[4] || item.score[5]);
  const selected: Array<{ file: FileInfo; reasons: string[] }> = [];
  if (!seeds.length) {
    for (const path of index.entryCandidates) {
      const file = index.files.find((item) => item.path === path);
      if (file) selected.push({ file, reasons: ["fallback candidate"] });
    }
  } else {
    for (const item of seeds) {
      const roleReason = intent.roles.find((role) => ROLE_LEXICON[role].match.some((term) => {
        return tokens(item.file.path).includes(term) || item.file.symbols.some((symbol) => tokens(symbol.name).includes(term));
      })) ?? "match";
      const reasons = [
        item.score[0] ? "exact symbol match" : "",
        item.score[1] ? `scope: ${item.file.area}` : "",
        item.score[2] ? `role: ${roleReason}` : "",
        item.score[3] ? `package: ${item.file.packageName ?? item.file.packageRoot}` : "",
        item.score[4] ? "symbol match" : "",
        item.score[5] ? "path match" : "",
        item.score[6] ? "entry candidate" : "",
        item.score[7] ? "dependency" : ""
      ].filter(Boolean).slice(0, 3);
      selected.push({ file: item.file, reasons });
    }
    const seedPaths = new Set(selected.map((item) => item.file.path));
    const neighbors = new Set<string>();
    for (const path of seedPaths) for (const neighbor of [...(index.incoming.get(path) ?? []), ...(index.outgoing.get(path) ?? [])]) if (!seedPaths.has(neighbor)) neighbors.add(neighbor);
    for (const path of [...neighbors].sort((left, right) => left.localeCompare(right))) {
      const file = index.files.find((item) => item.path === path);
      if (file) selected.push({ file, reasons: ["one-hop dependency"] });
    }
  }
  const confidence = !seeds.length ? "fallback" : (() => {
    const top = seeds[0]!.score, next = seeds[1]?.score;
    const broadOnly = !top[0] && !top[1] && !top[2];
    return broadOnly || (next !== undefined && compareScore(top, next) === 0) ? "ambiguous" : "high";
  })();
  const eligibleCount = selected.length;
  const candidates = selected.slice(0, limit).map(({ file, reasons }) => ({ path: file.path, area: file.area, packageRoot: file.packageRoot, ...(file.packageName ? { packageName: file.packageName } : {}), reasons, symbols: file.symbols, incoming: [...(index.incoming.get(file.path) ?? [])], outgoing: [...(index.outgoing.get(file.path) ?? [])] }));
  let mapTruncated = eligibleCount > candidates.length;
  const label = (item: RepoMapCandidate) => `${item.path}  [${item.area} · package ${item.packageName ?? item.packageRoot}]`;
  const optional = ["REPO MAP", `query: ${query}`, `indexed: ${index.inspectedFileCount}/${index.inspectedFileCount + Object.values(index.skipped).reduce((sum, value) => sum + value, 0)} supported files · ${Math.ceil(index.inspectedBytes / 1024)} KiB`, "", "FILES", ...candidates.map(label), "", "DEPENDENCIES"];
  for (const candidate of candidates) for (const target of candidate.outgoing) if (candidates.some((item) => item.path === target)) optional.push(`${candidate.path} -> ${target}`);
  optional.push("", "SYMBOLS");
  for (const candidate of candidates) {
    optional.push(label(candidate));
    for (const item of candidate.symbols) optional.push(`  ${item.kind} ${item.signature} · line ${item.location.line}`);
    optional.push(`  reason: ${candidate.reasons.join("; ")}`);
  }
  const scope = () => ["", "SCOPE", `confidence: ${confidence}`, "source bodies not inspected", "unsupported import resolution: aliases, packages, dynamic imports", `index truncated: ${index.truncated ? "yes" : "no"}`, `map truncated: ${mapTruncated ? "yes" : "no"}`];
  const kept: string[] = [];
  for (const line of optional) {
    const candidateText = [...kept, line, ...scope()].join("\n");
    if (candidateText.length <= maxCharacters) kept.push(line);
    else mapTruncated = true;
  }
  let text = [...kept, ...scope()].join("\n");
  while (text.length > maxCharacters && kept.length) { kept.pop(); mapTruncated = true; text = [...kept, ...scope()].join("\n"); }
  return { query, candidates, text, confidence, mapTruncated };
}

function capCodePoints(value: string, limit: number): string { return [...value].slice(0, limit).join(""); }

export function createQueryRepoMapTool(index: RepositoryIndex): Tool {
  return {
    name: "query_repo_map",
    description: "Find candidate TypeScript and JavaScript files and declarations in the prebuilt repository index.",
    permission: "SAFE",
    reason: "Only queries bounded metadata already read from the configured project root.",
    risk: "low",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 8 } },
      required: ["query"],
      additionalProperties: false
    },
    async execute(args) {
      try {
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "query" && key !== "limit")) throw new Error("Arguments must contain only query and limit");
        const input = args as { query?: unknown; limit?: unknown };
        if (typeof input.query !== "string" || !input.query.trim()) throw new Error("Query must be a nonempty string");
        const limit = input.limit ?? 8;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 8) throw new Error("Limit must be an integer from 1 to 8");
        const content = queryRepositoryIndex(index, input.query, { maxCharacters: 8_000, limit: limit as number });
        const paths = content.candidates.map((candidate) => candidate.path).join(", ") || "none";
        const historyContent = capCodePoints(`Repo map candidates: ${paths}; index truncated: ${index.truncated ? "yes" : "no"}; map truncated: ${content.mapTruncated ? "yes" : "no"}`, 512);
        return { content, historyContent, isError: false };
      } catch (error) {
        return { content: error instanceof Error ? error.message : "Unable to query repository map", isError: true };
      }
    }
  };
}

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
  permission: "SAFE",
  reason: "Only lists files within the configured project root.",
  risk: "low",
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
  permission: "SAFE",
  reason: "Only reads bounded text from within the configured project root.",
  risk: "low",
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
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const imports: Dependency[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({ from: path, specifier: statement.moduleSpecifier.text, kind: "import", typeOnly: statement.importClause?.isTypeOnly ?? false });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({ from: path, specifier: statement.moduleSpecifier.text, kind: "export", typeOnly: statement.isTypeOnly });
    }
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

export function findCycles(files: string[], edges: DependencyEdge[]): { cycles: string[][]; truncated: boolean } {
  const adjacency = new Map(files.map((file) => [file, [] as string[]]));
  const adjacencyMembers = new Map(files.map((file) => [file, new Set<string>()]));
  for (const edge of edges) {
    const targets = adjacency.get(edge.from);
    const members = adjacencyMembers.get(edge.from);
    if (targets && members && !members.has(edge.to)) { targets.push(edge.to); members.add(edge.to); }
  }
  for (const targets of adjacency.values()) targets.sort((left, right) => left.localeCompare(right));
  const index = new Map<string, number>(), lowlink = new Map<string, number>(), stack: string[] = [], active = new Set<string>(), components: string[][] = [];
  let nextIndex = 0;
  const visitComponent = (file: string) => {
    index.set(file, nextIndex); lowlink.set(file, nextIndex); nextIndex += 1; stack.push(file); active.add(file);
    for (const next of adjacency.get(file) ?? []) {
      if (!index.has(next)) { visitComponent(next); lowlink.set(file, Math.min(lowlink.get(file)!, lowlink.get(next)!)); }
      else if (active.has(next)) lowlink.set(file, Math.min(lowlink.get(file)!, index.get(next)!));
    }
    if (lowlink.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let node: string;
    do { node = stack.pop()!; active.delete(node); component.push(node); } while (node !== file);
    if (component.length > 1 || (adjacency.get(file) ?? []).includes(file)) components.push(component.sort((left, right) => left.localeCompare(right)));
  };
  for (const file of files) if (!index.has(file)) visitComponent(file);
  const cycles = new Map<string, string[]>();
  let truncated = false, steps = 0;
  for (const component of components) {
    const members = new Set(component);
    for (const start of component) {
      const path = [start], pathNodes = new Set(path);
      const visit = (file: string) => {
        for (const next of adjacency.get(file) ?? []) {
          if (!members.has(next)) continue;
          if (++steps > MAX_DEPENDENCY_CYCLE_STEPS) { truncated = true; return; }
        if (next === start) {
          const cycle = canonicalCycle([...path, start]);
          const key = cycle.join("\0");
          if (!cycles.has(key)) {
            if (cycles.size === MAX_DEPENDENCY_CYCLES) { truncated = true; return; }
            cycles.set(key, cycle);
          }
        } else if (next.localeCompare(start) > 0 && !pathNodes.has(next)) {
          pathNodes.add(next); path.push(next); visit(next); path.pop(); pathNodes.delete(next);
          if (truncated) return;
        }
      }
    };
      visit(start);
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { cycles: [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0"))), truncated };
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
  permission: "SAFE",
  reason: "Only reads supported source files within the configured project root.",
  risk: "low",
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
      const cycleResult = findCycles(analyzedFiles, edges);
      return { content: {
        analyzedPath: relativePath(root, scanPath) || ".", entry: entry ?? null, analyzedFiles, unsupportedFiles, edges: returnedEdges, builtins, packages, unresolved,
        cycles: cycleResult.cycles, entryTree: entry ? buildEntryTree(entry, edges) : null,
        analyzedFileCount: analyzedFiles.length, totalEdgeCount: edges.length, returnedEdgeCount: returnedEdges.length, truncated: edges.length > returnedEdges.length || cycleResult.truncated
      }, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : "Unable to analyze dependencies", isError: true };
    }
  }
};

export const tools: Tool[] = [scanProjectTool, readFileTool, analyzeDependenciesTool];
