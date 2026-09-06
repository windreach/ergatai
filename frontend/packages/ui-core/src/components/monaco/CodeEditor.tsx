import { useEffect, useRef } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import { defineErgataiThemes } from "./setup";

interface CodeEditorProps {
  path: string;
  language: string;
  value: string;
  theme: "ergatai-light" | "ergatai-dark";
  onChange: (value: string) => void;
  onSave: () => void;
}

export default function CodeEditor({
  path,
  language,
  value,
  theme,
  onChange,
  onSave,
}: CodeEditorProps) {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  const handleMount: OnMount = (editor, currentMonaco) => {
    editor.addCommand(
      currentMonaco.KeyMod.CtrlCmd | currentMonaco.KeyCode.KeyS,
      () => saveRef.current(),
    );
  };

  return (
    <Editor
      path={path}
      language={language}
      value={value}
      theme={theme}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      onMount={handleMount}
      beforeMount={(currentMonaco) => {
        defineErgataiThemes(currentMonaco);
      }}
      options={{
        automaticLayout: true,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.65,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        renderWhitespace: "selection",
        padding: { top: 16, bottom: 24 },
        tabSize: 2,
      }}
    />
  );
}
