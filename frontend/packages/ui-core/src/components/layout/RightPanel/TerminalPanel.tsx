import { useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";

interface TerminalLine {
  id: string;
  type: "input" | "output" | "error";
  content: string;
  timestamp: Date;
}

export function TerminalPanel() {
  const [lines, setLines] = useState<TerminalLine[]>([
    {
      id: "1",
      type: "output",
      content: "Ergatai Terminal v1.0",
      timestamp: new Date(),
    },
    {
      id: "2",
      type: "output",
      content: "输入 'help' 查看可用命令",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");

  const handleCommand = () => {
    if (!input.trim()) return;

    const inputLine: TerminalLine = {
      id: Date.now().toString(),
      type: "input",
      content: input,
      timestamp: new Date(),
    };

    setLines((prev) => [...prev, inputLine]);

    // Process command
    let output: TerminalLine;
    const cmd = input.trim().toLowerCase();

    if (cmd === "help") {
      output = {
        id: (Date.now() + 1).toString(),
        type: "output",
        content: "可用命令：help, clear, status, version",
        timestamp: new Date(),
      };
    } else if (cmd === "clear") {
      setLines([]);
      setInput("");
      return;
    } else if (cmd === "status") {
      output = {
        id: (Date.now() + 1).toString(),
        type: "output",
        content: "系统状态：正常运行",
        timestamp: new Date(),
      };
    } else if (cmd === "version") {
      output = {
        id: (Date.now() + 1).toString(),
        type: "output",
        content: "Ergatai Desktop v0.1.0",
        timestamp: new Date(),
      };
    } else {
      output = {
        id: (Date.now() + 1).toString(),
        type: "error",
        content: `未知命令：${input}`,
        timestamp: new Date(),
      };
    }

    setLines((prev) => [...prev, output]);
    setInput("");
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCommand();
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg font-mono text-sm">
      {/* Terminal Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle bg-surface px-4 py-2">
        <TerminalIcon className="h-4 w-4 text-muted" />
        <span className="text-xs text-muted">终端</span>
      </div>

      {/* Terminal Output */}
      <div className="flex-1 overflow-y-auto p-4">
        {lines.map((line) => (
          <div key={line.id} className="mb-1">
            {line.type === "input" ? (
              <div className="text-green-400">
                <span className="text-blue-400">$ </span>
                {line.content}
              </div>
            ) : line.type === "output" ? (
              <div className="text-text">{line.content}</div>
            ) : (
              <div className="text-red-400">{line.content}</div>
            )}
          </div>
        ))}
      </div>

      {/* Terminal Input */}
      <div className="border-t border-border-subtle p-4">
        <div className="flex items-center gap-2">
          <span className="text-blue-400">$</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1 bg-transparent text-text outline-none placeholder:text-muted"
            placeholder="输入命令..."
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}
