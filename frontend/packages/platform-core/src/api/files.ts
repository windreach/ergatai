import { selectBackend } from "./backend";
import { runtime } from "../config/runtime";

export type FileKind = "file" | "directory";

export interface FileStat {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  mediaType: string;
  encoding: "text" | "data-url";
  data: string;
}

export interface FilesBackend {
  getDefaultWorkspace: () => Promise<string>;
  getDefaultFile: () => Promise<string | null>;
  list: (path: string) => Promise<FileStat[]>;
  read: (path: string) => Promise<FileContent>;
  write: (path: string, data: string) => Promise<FileStat>;
  createFile: (path: string, data?: string) => Promise<FileStat>;
  createDirectory: (path: string) => Promise<FileStat>;
  rename: (path: string, nextPath: string) => Promise<FileStat>;
  remove: (path: string) => Promise<void>;
  search: (workspace: string, query: string) => Promise<FileStat[]>;
}

const defaultWorkspace = runtime.filesDefaultWorkspace ?? "/workspace";

interface MockFileNode extends FileStat {
  children?: MockFileNode[];
  content?: string;
  encoding?: FileContent["encoding"];
  mediaType?: string;
}

function node(path: string, overrides: Partial<MockFileNode> = {}): MockFileNode {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    kind: "file",
    size: 0,
    mtime: Date.now(),
    ...overrides,
  };
}

function directory(path: string, children: MockFileNode[] = []): MockFileNode {
  return node(path, { kind: "directory", size: 0, children });
}

function textFile(path: string, content: string, mediaType = "text/plain"): MockFileNode {
  const bytes = new TextEncoder().encode(content).length;
  return node(path, { size: bytes, content, mediaType, encoding: "text" });
}

function initialFileSystem(): MockFileNode {
  return directory(defaultWorkspace, [
    textFile(
      `${defaultWorkspace}/README.md`,
      "# Ergatai\n\nA workspace for the multi-agent desktop application.\n\n## Panels\n\n- AI chat\n- Terminal\n- Files\n- Review\n",
      "text/markdown",
    ),
    textFile(
      `${defaultWorkspace}/package.json`,
      "{\n  \"name\": \"ergatai-workspace\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n",
      "application/json",
    ),
    directory(`${defaultWorkspace}/docs`, [
      textFile(
        `${defaultWorkspace}/docs/architecture.md`,
        "# Architecture\n\nThe desktop shell communicates with workspace services through typed backends.\n",
        "text/markdown",
      ),
    ]),
    directory(`${defaultWorkspace}/src`, [
      directory(`${defaultWorkspace}/src/components`, [
        textFile(
          `${defaultWorkspace}/src/components/App.tsx`,
          "export function App() {\n  return <main>Ergatai</main>;\n}\n",
          "text/typescript",
        ),
      ]),
      textFile(
        `${defaultWorkspace}/src/main.ts`,
        "import { App } from \"./components/App\";\n\nnew App();\n",
        "text/typescript",
      ),
    ]),
    directory(`${defaultWorkspace}/assets`, [
      node(`${defaultWorkspace}/assets/logo.svg`, {
        size: 246,
        mediaType: "image/svg+xml",
        encoding: "data-url",
        content:
          "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' rx='20' fill='%23e8590c'/><path d='M28 68V28h40v10H39v9h23v10H39v11z' fill='white'/></svg>",
      }),
    ]),
  ]);
}

function normalizePath(path: string) {
  const trimmed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return trimmed || "/";
}

function parentPath(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function mediaTypeFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  const mediaTypes: Record<string, string> = {
    html: "text/html",
    json: "application/json",
    md: "text/markdown",
    png: "image/png",
    svg: "image/svg+xml",
    ts: "text/typescript",
    tsx: "text/typescript",
  };
  return mediaTypes[extension ?? ""] ?? "text/plain";
}

export class MockFilesBackend implements FilesBackend {
  private root: MockFileNode;

  constructor() {
    this.root = initialFileSystem();
  }

  async getDefaultWorkspace() {
    return this.root.path;
  }

  async getDefaultFile() {
    return this.find(`${this.root.path}/README.md`)?.path ?? null;
  }

  async list(path: string) {
    const target = this.find(path);
    if (!target || target.kind !== "directory") return [];
    return [...(target.children ?? [])].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async read(path: string): Promise<FileContent> {
    const file = this.find(path);
    if (!file || file.kind !== "file") throw new Error(`File not found: ${path}`);
    return {
      path: file.path,
      mediaType: file.mediaType ?? mediaTypeFromPath(file.path),
      encoding: file.encoding ?? "text",
      data: file.content ?? "",
    };
  }

  async write(path: string, data: string): Promise<FileStat> {
    const normalized = normalizePath(path);
    const existing = this.find(normalized);
    if (existing && existing.kind === "file") {
      existing.content = data;
      existing.size = new TextEncoder().encode(data).length;
      existing.mtime = Date.now();
      return this.toStat(existing);
    }
    return this.createFile(normalized, data);
  }

  async createFile(path: string, data = "") {
    const normalized = normalizePath(path);
    const parent = this.find(parentPath(normalized));
    if (!parent || parent.kind !== "directory") throw new Error(`Directory not found: ${parentPath(normalized)}`);
    parent.children ??= [];
    if (parent.children?.some((child) => child.name === normalized.split("/").pop())) {
      throw new Error("An item with this name already exists");
    }
    const file = textFile(normalized, data, mediaTypeFromPath(normalized));
    parent.children.push(file);
    return this.toStat(file);
  }

  async createDirectory(path: string) {
    const normalized = normalizePath(path);
    const parent = this.find(parentPath(normalized));
    if (!parent || parent.kind !== "directory") throw new Error(`Directory not found: ${parentPath(normalized)}`);
    parent.children ??= [];
    const name = normalized.split("/").pop()!;
    if (parent.children?.some((child) => child.name === name)) throw new Error("An item with this name already exists");
    const created = directory(normalized);
    parent.children.push(created);
    return this.toStat(created);
  }

  async rename(path: string, nextPath: string) {
    const normalized = normalizePath(path);
    const nextNormalized = normalizePath(nextPath);
    const file = this.find(normalized);
    const nextParent = this.find(parentPath(nextNormalized));
    if (!file) throw new Error(`Item not found: ${normalized}`);
    if (!nextParent || nextParent.kind !== "directory") throw new Error(`Directory not found: ${parentPath(nextNormalized)}`);
    if (nextParent.children?.some((child) => child.path !== file.path && child.name === nextNormalized.split("/").pop())) {
      throw new Error("An item with this name already exists");
    }
    this.removeNode(file);
    file.path = nextNormalized;
    file.name = nextNormalized.split("/").pop()!;
    file.mtime = Date.now();
    this.renameDescendants(file, normalized, nextNormalized);
    nextParent.children?.push(file);
    return this.toStat(file);
  }

  async remove(path: string) {
    const file = this.find(path);
    if (!file) throw new Error(`Item not found: ${path}`);
    this.removeNode(file);
  }

  async search(workspace: string, query: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const root = this.find(workspace) ?? this.root;
    const results: FileStat[] = [];
    const visit = (item: MockFileNode) => {
      if (item.name.toLowerCase().includes(normalizedQuery)) results.push(this.toStat(item));
      item.children?.forEach(visit);
    };
    visit(root);
    return results.slice(0, 100);
  }

  private find(path: string): MockFileNode | undefined {
    const normalized = normalizePath(path);
    if (normalized === this.root.path) return this.root;
    if (!normalized.startsWith(`${this.root.path}/`)) return undefined;
    let current: MockFileNode | undefined = this.root;
    for (const segment of normalized.slice(this.root.path.length + 1).split("/")) {
      current = current?.children?.find((child) => child.name === segment);
      if (!current) return undefined;
    }
    return current;
  }

  private removeNode(target: MockFileNode) {
    const parent = this.find(parentPath(target.path));
    if (!parent?.children) return;
    parent.children = parent.children.filter((child) => child.path !== target.path);
  }

  private renameDescendants(target: MockFileNode, oldPath: string, newPath: string) {
    target.children?.forEach((child) => {
      child.path = `${newPath}${child.path.slice(oldPath.length)}`;
      this.renameDescendants(child, oldPath, newPath);
    });
  }

  private toStat(item: MockFileNode): FileStat {
    return { name: item.name, path: item.path, kind: item.kind, size: item.size, mtime: item.mtime };
  }
}

export const mockFilesBackend = new MockFilesBackend();

export const filesBackend = selectBackend(
  "files",
  runtime.filesMode,
  mockFilesBackend,
);
