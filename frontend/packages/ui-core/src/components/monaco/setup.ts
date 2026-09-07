import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "../../monaco/cssWorker?worker";
import htmlWorker from "../../monaco/htmlWorker?worker";
import jsonWorker from "../../monaco/jsonWorker?worker";
import tsWorker from "../../monaco/tsWorker?worker";
import editorWorker from "../../monaco/editorWorker?worker";

interface MonacoEnvironment {
  getWorker(workerId: string, label: string): Worker;
}

const monacoEnvironment: MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

Object.assign(globalThis, { MonacoEnvironment: monacoEnvironment });
loader.config({ monaco });

function defineErgataiThemes(instance: typeof monaco) {
  instance.editor.defineTheme("ergatai-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1a1a1a",
      "editor.lineHighlightBackground": "#2f2f2f",
      "editorLineNumber.foreground": "#555555",
      "editorLineNumber.activeForeground": "#e8833a",
      "editorCursor.foreground": "#e8833a",
      "editor.selectionBackground": "#e8833a44",
    },
  });
  instance.editor.defineTheme("ergatai-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#f7f7f8",
      "editor.lineHighlightBackground": "#f0f0f1",
      "editorLineNumber.foreground": "#c4c4c6",
      "editorLineNumber.activeForeground": "#e8590c",
      "editorCursor.foreground": "#e8590c",
      "editor.selectionBackground": "#e8590c33",
    },
  });
}

export { defineErgataiThemes, monaco };
