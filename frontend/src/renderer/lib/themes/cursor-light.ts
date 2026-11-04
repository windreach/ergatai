import type { VSCodeFullTheme } from "../atoms"

export const CURSOR_LIGHT: VSCodeFullTheme = {
  id: "cursor-light",
  name: "Cursor Light",
  type: "light",
  source: "builtin",
  colors: {
    "editor.background": "#FCFCFC",
    "editor.foreground": "#141414EB",
    foreground: "#141414EB",
    "sideBar.background": "#F3F3F3",
    "sideBar.foreground": "#141414AD",
    "sideBar.border": "#14141413",
    "activityBar.background": "#F3F3F3",
    "activityBar.foreground": "#141414AD",
    "activityBarBadge.background": "#206595",
    "activityBarBadge.foreground": "#F3F3F3",
    "panel.background": "#F3F3F3",
    "panel.border": "#14141413",
    "tab.activeBackground": "#FCFCFC",
    "tab.inactiveBackground": "#F3F3F3",
    "tab.inactiveForeground": "#141414AD",
    "tab.activeForeground": "#141414EB",
    "tab.border": "#1414141C",
    "editorGroupHeader.tabsBackground": "#F3F3F3",
    "dropdown.background": "#FCFCFC",
    "dropdown.foreground": "#141414EB",
    "dropdown.border": "#14141413",
    "input.background": "#FCFCFC",
    "input.border": "#14141426",
    "input.foreground": "#141414EB",
    "input.placeholderForeground": "#1414147A",
    focusBorder: "#14141426",
    "textLink.foreground": "#3C7CAB",
    "textLink.activeForeground": "#3C7CAB",
    "list.activeSelectionBackground": "#14141411",
    "list.activeSelectionForeground": "#141414EB",
    "list.hoverBackground": "#14141411",
    "list.hoverForeground": "#141414EB",
    "list.focusBackground": "#1414141E",
    "list.focusForeground": "#141414EB",
    "list.inactiveSelectionBackground": "#14141411",
    "list.inactiveSelectionForeground": "#141414EB",
    "list.highlightForeground": "#6F9BA6",
    "list.errorForeground": "#CF2D56",
    "list.warningForeground": "#C08532",
    "editor.selectionBackground": "#1414141E",
    "editor.selectionHighlightBackground": "#14141411",
    "editor.wordHighlightBackground": "#1414141E",
    "editor.wordHighlightStrongBackground": "#1414140A",
    "editor.findMatchBackground": "#6F9BA65C",
    "editor.findMatchHighlightBackground": "#6F9BA62E",
    "editor.lineHighlightBackground": "#EDEDED",
    "editorLineNumber.foreground": "#1414147A",
    "editorLineNumber.activeForeground": "#141414AD",
    "editorCursor.foreground": "#141414EB",
    "editorBracketMatch.background": "#1414141E",
    "editorIndentGuide.background1": "#14141413",
    "editorIndentGuide.activeBackground1": "#14141426",
    "editorRuler.foreground": "#14141426",
    "editorGutter.background": "#FCFCFC",
    "editorGutter.addedBackground": "#1F8A65",
    "editorGutter.modifiedBackground": "#C08532",
    "editorGutter.deletedBackground": "#CF2D56",
    "editorSuggestWidget.background": "#F3F3F3",
    "editorSuggestWidget.border": "#14141413",
    "editorSuggestWidget.foreground": "#141414AD",
    "editorSuggestWidget.selectedBackground": "#14141411",
    "editorHoverWidget.background": "#FCFCFC",
    "editorHoverWidget.border": "#1414141C",
    "editorHoverWidget.foreground": "#141414EB",
    "editorWidget.background": "#F3F3F3",
    "editorWidget.resizeBorder": "#14141426",
    "editorCodeLens.foreground": "#141414AD",
    "editorInlayHint.foreground": "#141414AD",
    "editorInlayHint.background": "#FCFCFC00",
    "diffEditor.insertedTextBackground": "#1F8A6524",
    "diffEditor.insertedLineBackground": "#1F8A651F",
    "diffEditor.removedTextBackground": "#CF2D561F",
    "diffEditor.removedLineBackground": "#CF2D5614",
    "statusBar.background": "#F3F3F3",
    "statusBar.foreground": "#1414147A",
    "statusBar.border": "#14141413",
    "statusBarItem.activeBackground": "#1414141E",
    "statusBarItem.hoverBackground": "#14141411",
    "titleBar.activeBackground": "#F3F3F3",
    "titleBar.activeForeground": "#141414AD",
    "titleBar.inactiveBackground": "#F3F3F3",
    "titleBar.inactiveForeground": "#1414147A",
    "menu.background": "#F3F3F3",
    "menu.foreground": "#141414AD",
    "menu.separatorBackground": "#14141413",
    "scrollbar.shadow": "#14141411",
    "scrollbarSlider.background": "#1414141E",
    "scrollbarSlider.hoverBackground": "#14141430",
    "scrollbarSlider.activeBackground": "#14141430",
    "gitDecoration.addedResourceForeground": "#1F8A65",
    "gitDecoration.modifiedResourceForeground": "#C08532",
    "gitDecoration.deletedResourceForeground": "#CF2D56",
    "gitDecoration.untrackedResourceForeground": "#4C7F8C",
    "gitDecoration.ignoredResourceForeground": "#1414147A",
    "notificationLink.foreground": "#6F9BA6",
    "notifications.background": "#F3F3F3",
    "notifications.foreground": "#141414EB",
    "progressBar.background": "#1F8A65",
    descriptionForeground: "#141414AD",
    errorForeground: "#CF2D56",
    "button.background": "#3C7CAB",
    "button.foreground": "#FCFCFC",
    "button.hoverBackground": "#055180",
    "button.secondaryBackground": "#1414141E",
    "button.secondaryForeground": "#141414EB",
    "button.secondaryHoverBackground": "#14141430",
    // Terminal colors
    "terminal.background": "#F3F3F3",
    "terminal.foreground": "#141414EB",
    "terminal.ansiBlack": "#141414EB",
    "terminal.ansiRed": "#CF2D56",
    "terminal.ansiGreen": "#1F8A65",
    "terminal.ansiYellow": "#A16900",
    "terminal.ansiBlue": "#3C7CAB",
    "terminal.ansiMagenta": "#B8448B",
    "terminal.ansiCyan": "#4C7F8C",
    "terminal.ansiWhite": "#FCFCFC",
    "terminal.ansiBrightBlack": "#141414AD",
    "terminal.ansiBrightRed": "#E75E78",
    "terminal.ansiBrightGreen": "#55A583",
    "terminal.ansiBrightYellow": "#C08532",
    "terminal.ansiBrightBlue": "#6299C3",
    "terminal.ansiBrightMagenta": "#D06BA6",
    "terminal.ansiBrightCyan": "#6F9BA6",
    "terminal.ansiBrightWhite": "#FFFFFF",
  },
  tokenColors: [
    { scope: "emphasis", settings: { fontStyle: "italic" } },
    { scope: "strong", settings: { fontStyle: "bold" } },
    {
      scope: "comment, punctuation.definition.comment",
      settings: { fontStyle: "italic", foreground: "#1414147A" },
    },
    {
      scope:
        "string, punctuation.definition.string.begin, punctuation.definition.string.end",
      settings: { foreground: "#9E94D5" },
    },
    {
      scope: "variable.parameter.function",
      settings: { foreground: "#141414EB" },
    },
    { scope: "constant.numeric", settings: { foreground: "#6F9BA6" } },
    { scope: "constant.language", settings: { foreground: "#6F9BA6" } },
    {
      scope: "constant.character, constant.character.escape",
      settings: { foreground: "#141414AD" },
    },
    { scope: "constant.other.color", settings: { foreground: "#6F9BA6" } },
    { scope: "keyword", settings: { foreground: "#206595" } },
    { scope: "keyword.control", settings: { foreground: "#206595" } },
    { scope: "keyword.operator", settings: { foreground: "#141414EB" } },
    {
      scope:
        "keyword.operator.new, keyword.operator.expression.typeof, keyword.operator.expression.instanceof, keyword.operator.expression.keyof, keyword.operator.expression.of, keyword.operator.expression.in, keyword.operator.expression.delete, keyword.operator.expression.void, keyword.operator.ternary, keyword.operator.optional",
      settings: { foreground: "#6F9BA6" },
    },
    { scope: "storage, token.storage", settings: { foreground: "#206595" } },
    { scope: "storage.type", settings: { foreground: "#206595" } },
    {
      scope:
        "entity.name.function, meta.require, support.function, variable.function",
      settings: { foreground: "#6049B3" },
    },
    { scope: "entity.name.type", settings: { foreground: "#B3003F" } },
    { scope: "entity.name.class", settings: { foreground: "#B3003F" } },
    {
      scope: "entity.other.inherited-class",
      settings: { foreground: "#B3003F" },
    },
    { scope: "entity.name.tag", settings: { foreground: "#B3003F" } },
    {
      scope: "entity.other.attribute-name",
      settings: { foreground: "#6049B3" },
    },
    {
      scope: "entity.other.attribute-name.id",
      settings: { foreground: "#6049B3" },
    },
    {
      scope: "entity.other.attribute-name.class.css",
      settings: { foreground: "#C08532" },
    },
    {
      scope: "support.class, entity.name.type.class",
      settings: { foreground: "#B3003F" },
    },
    { scope: "support.function", settings: { foreground: "#6049B3" } },
    { scope: "support.constant", settings: { foreground: "#6F9BA6" } },
    { scope: "support.type", settings: { foreground: "#6F9BA6" } },
    {
      scope:
        "support.type.primitive.ts, support.type.builtin.ts, support.type.primitive.tsx, support.type.builtin.tsx",
      settings: { foreground: "#206595" },
    },
    {
      scope: "support.variable.property, variable.other.property",
      settings: { foreground: "#6049B3" },
    },
    { scope: "variable", settings: { foreground: "#141414EB" } },
    { scope: "variable.other.constant", settings: { foreground: "#6F9BA6" } },
    { scope: "variable.language", settings: { foreground: "#B8448B" } },
    {
      scope:
        "variable.parameter.function.python, variable.parameter.function.language.python",
      settings: { foreground: "#DB704B" },
    },
    {
      scope: "meta.property-name.css, support.type.property-name.css",
      settings: { foreground: "#1F8A65" },
    },
    { scope: "meta.tag", settings: { foreground: "#C08532" } },
    {
      scope: "meta.function-call.generic.python",
      settings: { foreground: "#6049B3" },
    },
    {
      scope: "punctuation.definition.tag",
      settings: { foreground: "#141414AD" },
    },
    {
      scope: "punctuation.separator.delimiter",
      settings: { foreground: "#141414EB" },
    },
    {
      scope:
        "punctuation.definition.template-expression.begin, punctuation.definition.template-expression.end, punctuation.section.embedded",
      settings: { foreground: "#6F9BA6" },
    },
    {
      scope:
        "punctuation.definition.decorator.python, entity.name.function.decorator.python, meta.function.decorator.python",
      settings: { foreground: "#1F8A65" },
    },
    { scope: "string.regexp", settings: { foreground: "#141414EB" } },
    {
      scope: "string.quoted.binary.single.python",
      settings: { foreground: "#1F8A65" },
    },
    {
      scope: "support.type.property-name.json",
      settings: { foreground: "#1F8A65" },
    },
    {
      scope:
        "source.json meta.structure.dictionary.json > value.json > string.quoted.json, source.json meta.structure.array.json > value.json > string.quoted.json",
      settings: { foreground: "#9E94D5" },
    },
    { scope: "markup.heading", settings: { foreground: "#206595" } },
    {
      scope:
        "entity.name.section.markdown, punctuation.definition.heading.markdown, markup.heading.setext",
      settings: { foreground: "#141414EB" },
    },
    { scope: "markup.quote", settings: { foreground: "#141414AD" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.underline", settings: { fontStyle: "underline" } },
    {
      scope: "markup.strikethrough, punctuation.definition.strikethrough",
      settings: { foreground: "#1414147A", fontStyle: "strikethrough" },
    },
    { scope: "markup.inline.raw", settings: { foreground: "#1F8A65" } },
    {
      scope:
        "markup.underline.link.markdown, markup.underline.link.image.markdown",
      settings: { foreground: "#141414AD" },
    },
    {
      scope:
        "punctuation.definition.list.begin.markdown, punctuation.definition.list.markdown",
      settings: { foreground: "#141414AD" },
    },
    {
      scope:
        "string.other.link.title.markdown, string.other.link.description.markdown",
      settings: { foreground: "#141414AD" },
    },
    { scope: "keyword.other.unit", settings: { foreground: "#6F9BA6" } },
    {
      scope:
        "markup.deleted, meta.diff.header.from-file, punctuation.definition.deleted",
      settings: { foreground: "#B3003F" },
    },
    {
      scope:
        "markup.inserted, meta.diff.header.to-file, punctuation.definition.inserted",
      settings: { foreground: "#1F8A65" },
    },
    {
      scope: "markup.changed, punctuation.definition.changed",
      settings: { foreground: "#DB704B" },
    },
    {
      scope: "markup.ignored, markup.untracked",
      settings: { foreground: "#1414147A" },
    },
    { scope: "meta.diff.range", settings: { foreground: "#6049B3" } },
    { scope: "meta.diff.header", settings: { foreground: "#206595" } },
    {
      scope:
        "invalid.broken, invalid.deprecated, invalid.illegal, invalid.unimplemented",
      settings: { fontStyle: "italic", foreground: "#B3003F" },
    },
    { scope: "token.info-token", settings: { foreground: "#6F9BA6" } },
    { scope: "token.warn-token", settings: { foreground: "#C08532" } },
    { scope: "token.error-token", settings: { foreground: "#CF2D56" } },
    { scope: "token.debug-token", settings: { foreground: "#6049B3" } },
    // Python
    { scope: "support.type.python", settings: { foreground: "#6F9BA6" } },
    {
      scope: "variable.parameter.function.language.special.self.python",
      settings: { foreground: "#B8448B" },
    },
    {
      scope: "keyword.control.import.python, keyword.control.flow.python",
      settings: { fontStyle: "italic" },
    },
    // C/C++
    {
      scope:
        "storage.type.c, storage.type.cpp, support.type.posix-reserved.c, support.type.posix-reserved.cpp",
      settings: { foreground: "#206595" },
    },
    {
      scope: "constant.language.false.cpp, constant.language.true.cpp",
      settings: { foreground: "#6F9BA6" },
    },
    {
      scope: "variable.language.this.cpp",
      settings: { foreground: "#6F9BA6" },
    },
    {
      scope: "keyword.control.directive.include.cpp",
      settings: { foreground: "#1F8A65" },
    },
    {
      scope: "punctuation.separator.c, punctuation.separator.cpp",
      settings: { foreground: "#6F9BA6" },
    },
    // TypeScript/JavaScript
    {
      scope:
        "keyword.other.template.begin, keyword.other.template.end, keyword.other.substitution.begin, keyword.other.substitution.end",
      settings: { foreground: "#9E94D5" },
    },
    // Java
    {
      scope:
        "storage.modifier.package, storage.modifier.import, storage.type.java",
      settings: { foreground: "#141414EB" },
    },
    { scope: "variable.parameter.java", settings: { foreground: "#141414EB" } },
    {
      scope: "storage.modifier.import.java",
      settings: { foreground: "#B3003F" },
    },
    {
      scope: "storage.type.annotation.java, storage.type.object.array.java",
      settings: { foreground: "#206595" },
    },
    { scope: "storage.type.java", settings: { foreground: "#206595" } },
    {
      scope:
        "storage.modifier.import.java, storage.type.java, storage.type.generic.java",
      settings: { foreground: "#B3003F" },
    },
    // Go
    { scope: "entity.name.package.go", settings: { foreground: "#B3003F" } },
    // Vue
    {
      scope:
        "entity.name.tag.template, entity.name.tag.script, entity.name.tag.style",
      settings: { foreground: "#6049B3" },
    },
    // YAML
    {
      scope: "punctuation.definition.block.sequence.item.yaml",
      settings: { foreground: "#141414EB" },
    },
    // Elixir
    {
      scope: "constant.language.symbol.elixir",
      settings: { foreground: "#141414EB" },
    },
    // Misc
    {
      scope: "constant.character.escape",
      settings: { foreground: "#141414AD" },
    },
    {
      scope:
        "punctuation.section.embedded.begin, punctuation.section.embedded.end",
      settings: { foreground: "#6F9BA6" },
    },
  ],
}
