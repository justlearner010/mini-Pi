import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

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

export const tools: Tool[] = [scanProjectTool, readFileTool];
