export interface TerminalCreateOptions {
  cwd: string;
  cols: number;
  rows: number;
}

export interface TerminalSession {
  readonly id: string;
  readonly cwd: string;
  onData: (listener: (data: string) => void) => () => void;
  onClose: (listener: (reason: string) => void) => () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface TerminalBackend {
  getDefaultCwd: () => Promise<string>;
  create: (options: TerminalCreateOptions) => Promise<TerminalSession>;
}

import { runtime, websocketUrl } from "../config/runtime";

export const fallbackUserHome = runtime.terminalDefaultCwd ?? "/home/yubing";

export async function getDefaultTerminalCwd(): Promise<string> {
  return fallbackUserHome;
}

function createSessionId(prefix: string): string {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uniqueId}`;
}

class MockTerminalSession implements TerminalSession {
  readonly id: string;
  readonly cwd: string;
  private outputListeners = new Set<(data: string) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private pendingOutput: string[] = [];
  private input = "";
  private running = true;

  constructor(id: string, cwd: string, cols: number, rows: number) {
    this.id = id;
    this.cwd = cwd;
    this.emit([
      "Ergatai Terminal — mock transport\r\n",
      `Workspace: ${cwd}\r\n`,
      "PTY backend not connected; type help for available commands.\r\n\r\n",
    ].join(""));
    this.writePrompt();
    this.resize(cols, rows);
  }

  onData(listener: (data: string) => void) {
    this.outputListeners.add(listener);
    if (this.pendingOutput.length > 0) {
      const bufferedOutput = this.pendingOutput.join("");
      this.pendingOutput = [];
      listener(bufferedOutput);
    }
    return () => this.outputListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  write(data: string) {
    if (!this.running) return;
    for (const char of data) {
      if (char === "\r") {
        this.emit("\r\n");
        this.runCommand(this.input.trim());
        this.input = "";
        continue;
      }
      if (char === "\u007f") {
        if (this.input.length > 0) {
          this.input = this.input.slice(0, -1);
          this.emit("\b \b");
        }
        continue;
      }
      if (char === "\u0003") {
        this.input = "";
        this.emit("^C\r\n");
        this.writePrompt();
        continue;
      }
      if (char === "\u0015") {
        this.emit("\r".padEnd(this.input.length + 1, " ") + "\r");
        this.input = "";
        this.writePrompt();
        continue;
      }
      if (char >= " ") {
        this.input += char;
        this.emit(char);
      }
    }
  }

  resize(_cols: number, _rows: number) {}

  kill() {
    if (!this.running) return;
    this.running = false;
    this.emit("\r\nSession closed.\r\n");
    for (const listener of this.closeListeners) listener("killed");
  }

  private emit(data: string) {
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(data);
      return;
    }
    for (const listener of this.outputListeners) listener(data);
  }

  private promptText() {
    const directory = this.cwd === fallbackUserHome ? "~" : this.cwd.split("/").at(-1) || this.cwd;
    return `${runtime.terminalUser}@ergatai:${directory}$ `;
  }

  private writePrompt() {
    this.emit(this.promptText());
  }

  private runCommand(input: string) {
    const [command, ...args] = input.split(/\s+/).filter(Boolean);
    if (!command) {
      this.writePrompt();
      return;
    }
    switch (command) {
      case "help":
        this.emit([
          "Commands:\r\n",
          "  help       Show this help\r\n",
          "  pwd        Print workspace\r\n",
          "  ls         List mock workspace files\r\n",
          "  echo TEXT  Print text\r\n",
          "  whoami     Print current user\r\n",
          "  date       Print current time\r\n",
          "  clear      Clear terminal\r\n",
          "  exit       Close this session\r\n\r\n",
        ].join(""));
        break;
      case "pwd":
        this.emit(`${this.cwd}\r\n`);
        break;
      case "ls":
        this.emit("Desktop  Documents  Downloads  Projects  agent-workspace\r\n");
        break;
      case "echo":
        this.emit(`${args.join(" ")}\r\n`);
        break;
      case "whoami":
        this.emit("yubing\r\n");
        break;
      case "date":
        this.emit(`${new Date().toString()}\r\n`);
        break;
      case "clear":
        this.emit("\x1b[2J\x1b[H");
        break;
      case "exit":
        this.kill();
        return;
      default:
        this.emit(`command not found: ${command}\r\n`);
    }
    this.writePrompt();
  }
}

export const mockTerminalBackend: TerminalBackend = {
  getDefaultCwd: getDefaultTerminalCwd,
  async create(options) {
    return new MockTerminalSession(
      createSessionId("terminal"),
      options.cwd,
      options.cols,
      options.rows,
    );
  },
};

type PtyClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

class PtyTerminalSession implements TerminalSession {
  readonly id: string;
  readonly cwd: string;
  private readonly socket: WebSocket;
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private pendingOutput: string[] = [];
  private closed = false;

  constructor(id: string, cwd: string, socket: WebSocket) {
    this.id = id;
    this.cwd = cwd;
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      const output = typeof event.data === "string" ? event.data : String(event.data);
      this.emitOutput(output);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const listener of this.closeListeners) listener("closed");
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) {
        for (const listener of this.closeListeners) listener("connection error");
      }
    });
  }

  onData(listener: (data: string) => void) {
    this.outputListeners.add(listener);
    if (this.pendingOutput.length > 0) {
      const bufferedOutput = this.pendingOutput.join("");
      this.pendingOutput = [];
      listener(bufferedOutput);
    }
    return () => this.outputListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  write(data: string) {
    this.send({ type: "input", data });
  }

  resize(cols: number, rows: number) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send({ type: "resize", cols, rows });
    }
  }

  kill() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.closed = true;
  }

  private send(message: PtyClientMessage) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private emitOutput(data: string) {
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(data);
      return;
    }
    for (const listener of this.outputListeners) listener(data);
  }
}

export const ptyTerminalBackend: TerminalBackend = {
  getDefaultCwd: getDefaultTerminalCwd,
  create(options) {
    return new Promise((resolve) => {
      const url = new URL(websocketUrl(runtime.terminalApiUrl));
      url.searchParams.set("cwd", options.cwd);
      url.searchParams.set("cols", String(options.cols));
      url.searchParams.set("rows", String(options.rows));

      const socket = new WebSocket(url);
      const id = createSessionId("pty");
      let settled = false;

      function fallbackToMock() {
        if (settled) return;
        settled = true;
        socket.close();
        resolve(new MockTerminalSession(
          createSessionId("terminal-fallback"),
          options.cwd,
          options.cols,
          options.rows,
        ));
      }

      socket.addEventListener("open", () => {
        settled = true;
        resolve(new PtyTerminalSession(id, options.cwd, socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        fallbackToMock();
      }, { once: true });
      socket.addEventListener("close", () => {
        fallbackToMock();
      }, { once: true });
    });
  },
};

export const terminalBackend: TerminalBackend = runtime.terminalMode === "mock"
  ? mockTerminalBackend
  : ptyTerminalBackend;
