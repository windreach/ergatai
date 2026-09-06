import { isValidElement, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const childProps = isValidElement(child) ? child.props as { className?: unknown } : null;
  const language = typeof childProps?.className === "string"
    ? childProps.className.replace(/language-/, "")
    : "";

  async function copyCode() {
    await navigator.clipboard.writeText(codeRef.current?.textContent ?? "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="group/code relative my-3 min-w-0">
      {language && (
        <span className="absolute left-3 top-2 font-mono text-[10px] uppercase tracking-wide text-faint">{language}</span>
      )}
      <button
        type="button"
        onClick={copyCode}
        aria-label={t("chat.copyCode")}
        title={t("chat.copyCode")}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-muted opacity-0 transition group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-text"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
      <pre
        ref={codeRef}
        className="overflow-x-auto rounded-xl border border-border bg-elevated p-3 pt-8 font-mono text-[12px] leading-relaxed text-text"
      >
        {children}
      </pre>
    </div>
  );
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn("markdown-body min-w-0 break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-elevated px-3 py-2 font-medium text-text">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border-subtle px-3 py-2 align-top text-text">{children}</td>
          ),
          pre: ({ children }) => (
            <CodeBlock>{children}</CodeBlock>
          ),
          code: ({ children, className }) => (
            <code className={cn("font-mono text-[0.92em]", className)}>{children}</code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
