import { DiffEditor as MonacoDiffEditor } from "@monaco-editor/react";
import { defineErgataiThemes } from "./setup";

interface DiffEditorProps {
  id: string;
  original: string;
  modified: string;
  language: string;
  theme: "ergatai-light" | "ergatai-dark";
  splitView: boolean;
}

export default function DiffEditor({
  id,
  original,
  modified,
  language,
  theme,
  splitView,
}: DiffEditorProps) {
  const modelPrefix = `inmemory://review/${encodeURIComponent(id)}`;

  return (
    <MonacoDiffEditor
      original={original}
      modified={modified}
      language={language}
      originalModelPath={`${modelPrefix}/original`}
      modifiedModelPath={`${modelPrefix}/modified`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      theme={theme}
      beforeMount={defineErgataiThemes}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: splitView,
        automaticLayout: true,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.65,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderOverviewRuler: false,
        padding: { top: 4, bottom: 8 },
        diffWordWrap: "off",
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: false,
        renderLineHighlight: "none",
        scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      }}
    />
  );
}
