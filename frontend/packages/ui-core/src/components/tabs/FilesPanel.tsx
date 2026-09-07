import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filesBackend, type FileContent } from "@ergatai/platform-core";
import { usePrefersLight } from "../../hooks/usePrefersLight";

const CodeEditor = lazy(() => import("../monaco/CodeEditor"));

function monacoLanguage(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const languageByExtension: Record<string, string> = {
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    less: "less",
    md: "markdown",
    scss: "scss",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
  };
  return languageByExtension[extension] ?? "plaintext";
}

export function FilesPanel({ path }: { path?: string }) {
  const { t } = useTranslation();
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefersLight = usePrefersLight();
  const requestRef = useRef(0);
  const activePath = path ?? defaultPath;

  const dirty = Boolean(content && draft !== content.data);
  const loading = !content;

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestRef.current;

    async function loadFile() {
      try {
        setError(null);
        if (activePath === null) {
        const resolvedPath = await filesBackend.getDefaultFile();
          if (!cancelled && requestId === requestRef.current) setDefaultPath(resolvedPath ?? "");
          return;
        }
        if (!activePath) {
          if (!cancelled) {
            setContent({
              path: "untitled",
              mediaType: "text/plain",
              encoding: "text",
              data: "",
            });
          }
          return;
        }
        const fileContent = await filesBackend.read(activePath);
        if (cancelled || requestId !== requestRef.current) return;
        setContent(fileContent);
        setDraft(fileContent.data);
      } catch (loadError) {
        if (!cancelled && requestId === requestRef.current) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setContent(null);
        }
      }
    }

    void loadFile();
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  const saveFile = useCallback(async () => {
    if (!activePath || !content || !dirty || actionBusy) return;
    setActionBusy(true);
    try {
      await filesBackend.write(activePath, draft);
      setContent({ ...content, data: draft });
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setActionBusy(false);
    }
  }, [activePath, actionBusy, content, dirty, draft]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-chat">
      {loading && !error ? (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">{t("files.loading")}</div>
      ) : content?.encoding === "text" ? (
        <Suspense fallback={<div className="h-full" />}>
          <CodeEditor
            path={content.path}
            language={monacoLanguage(content.path)}
            value={draft}
            theme={prefersLight ? "ergatai-light" : "ergatai-dark"}
            onChange={setDraft}
            onSave={saveFile}
          />
        </Suspense>
      ) : (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">{t("files.binary")}</div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-0 border-t border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      {actionBusy && <div className="absolute inset-0 cursor-progress" />}
    </div>
  );
}
