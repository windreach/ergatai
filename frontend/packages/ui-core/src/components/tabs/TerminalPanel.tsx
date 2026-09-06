import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { fallbackUserHome, terminalBackend, runtime, type TerminalSession } from "@ergatai/platform-core";

type TerminalStatus = "connecting" | "ready" | "closed" | "error";

export function TerminalPanel() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const disposersRef = useRef<Array<() => void>>([]);
  const [cwd, setCwd] = useState(fallbackUserHome);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [statusText, setStatusText] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prefersLight, setPrefersLight] = useState(() => window.matchMedia("(prefers-color-scheme: light)").matches);

  const theme = useMemo(() => {
    return prefersLight
      ? { background: "#f7f7f8", foreground: "#1a1a1a", cursor: "#e8590c", selectionBackground: "#e8590c33" }
      : { background: "#1a1a1a", foreground: "#ececec", cursor: "#e8833a", selectionBackground: "#e8833a44" };
  }, [prefersLight]);

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | null = null;

    async function connect() {
      try {
        const resolvedCwd = await terminalBackend.getDefaultCwd();
        if (disposed) return;
        setCwd(resolvedCwd);

        terminal = new Terminal({
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.25,
          cursorBlink: true,
          allowProposedApi: true,
          scrollback: 5000,
          theme,
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        terminal.open(containerRef.current!);
        fitAddon.fit();

        const session = await terminalBackend.create({
          cwd: resolvedCwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) {
          session.kill();
          return;
        }
        sessionRef.current = session;
        setSessionId(session.id);
        setStatus("ready");
        setStatusText(session.id);
        disposersRef.current.push(session.onData((data) => terminal?.write(data)));
        disposersRef.current.push(session.onClose((reason) => {
          setStatus("closed");
          setStatusText(reason);
        }));
        const inputListener = terminal.onData((data) => session.write(data));
        disposersRef.current.push(() => inputListener.dispose());
      } catch (error) {
        if (!disposed) {
          setStatus("error");
          setStatusText(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void connect();

    return () => {
      disposed = true;
      for (const dispose of disposersRef.current) dispose();
      disposersRef.current = [];
      sessionRef.current?.kill();
      sessionRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        sessionRef.current?.resize(terminalRef.current?.cols ?? 80, terminalRef.current?.rows ?? 24);
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setPrefersLight(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function restart() {
    sessionRef.current?.kill();
    terminalRef.current?.reset();
    disposersRef.current.forEach((dispose) => dispose());
    disposersRef.current = [];
    setStatus("connecting");
    setStatusText("");
    void (async () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const session = await terminalBackend.create({
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      sessionRef.current = session;
      setSessionId(session.id);
      setStatus("ready");
      setStatusText(session.id);
      disposersRef.current.push(session.onData((data) => terminal.write(data)));
      disposersRef.current.push(session.onClose((reason) => {
        setStatus("closed");
        setStatusText(reason);
      }));
      const inputListener = terminal.onData((data) => session.write(data));
      disposersRef.current.push(() => inputListener.dispose());
    })().catch((error) => {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : String(error));
    });
  }

  function clearTerminal() {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
  }

  const statusColor = status === "ready" ? "bg-success" : status === "connecting" ? "bg-warning" : status === "error" ? "bg-danger" : "bg-muted";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-chat">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3">
        <Folder className="h-3.5 w-3.5 text-muted" />
        <span className="min-w-0 truncate font-mono text-[12px] text-text" title={cwd}>{cwd}</span>
        <span className="ml-2 hidden items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted sm:flex">
          <span className={cn("h-1.5 w-1.5 rounded-full", statusColor)} />
          {t(`terminal.status.${status}`)}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={restart} disabled={status === "connecting"} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40" aria-label={t("terminal.restart")} title={t("terminal.restart")}>
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={clearTerminal} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text" aria-label={t("terminal.clear")} title={t("terminal.clear")}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-2 py-2" role="terminal" aria-label={t("tabs.terminal")} />
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border-subtle bg-surface px-3 font-mono text-[11px] text-faint">
        <span>
          {t("terminal.backend")}: {runtime.terminalMode === "mock" ? "mock" : "pty"}
        </span>
        {sessionId && <span>{sessionId}</span>}
        {statusText && <span className="min-w-0 truncate">{statusText}</span>}
      </footer>
    </div>
  );
}
