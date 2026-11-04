import type { VSCodeFullTheme } from "../atoms"

export const CURSOR_DARK: VSCodeFullTheme = {
  id: "cursor-dark",
  name: "Cursor Dark",
  type: "dark",
  source: "builtin",
  colors: {
    "editor.background": "#181818",
    "editor.foreground": "#E4E4E4EB",
    foreground: "#E4E4E4EB",
    "sideBar.background": "#141414",
    "sideBar.foreground": "#E4E4E48D",
    "sideBar.border": "#E4E4E413",
    "activityBar.background": "#141414",
    "activityBar.foreground": "#E4E4E48D",
    "activityBarBadge.background": "#88C0D0",
    "activityBarBadge.foreground": "#141414",
    "panel.background": "#141414",
    "panel.border": "#E4E4E413",
    "tab.activeBackground": "#181818",
    "tab.inactiveBackground": "#242424",
    "tab.inactiveForeground": "#E4E4E442",
    "tab.activeForeground": "#E4E4E4EB",
    "tab.border": "#E4E4E413",
    "editorGroupHeader.tabsBackground": "#141414",
    "dropdown.background": "#181818",
    "dropdown.foreground": "#E4E4E4EB",
    "dropdown.border": "#E4E4E413",
    "input.background": "#E4E4E40A",
    "input.border": "#E4E4E413",
    "input.foreground": "#E4E4E4EB",
    "input.placeholderForeground": "#E4E4E45E",
    focusBorder: "#E4E4E426",
    "textLink.foreground": "#81A1C1",
    "textLink.activeForeground": "#87A6C4",
    "list.activeSelectionBackground": "#E4E4E41E",
    "list.activeSelectionForeground": "#E4E4E4EB",
    "list.hoverBackground": "#E4E4E411",
    "list.hoverForeground": "#E4E4E4EB",
    "list.focusBackground": "#E4E4E41E",
    "list.focusForeground": "#E4E4E4EB",
    "list.inactiveSelectionBackground": "#E4E4E411",
    "list.inactiveSelectionForeground": "#E4E4E4EB",
    "list.highlightForeground": "#88C0D0",
    "list.errorForeground": "#FC6B83",
    "list.warningForeground": "#F1B467",
    "editor.selectionBackground": "#40404099",
    "editor.selectionHighlightBackground": "#404040CC",
    "editor.wordHighlightBackground": "#E4E4E41E",
    "editor.wordHighlightStrongBackground": "#E4E4E430",
    "editor.findMatchBackground": "#88C0D066",
    "editor.findMatchHighlightBackground": "#88C0D044",
    "editor.lineHighlightBackground": "#262626",
    "editorLineNumber.foreground": "#E4E4E442",
    "editorLineNumber.activeForeground": "#E4E4E4EB",
    "editorCursor.foreground": "#E4E4E4EB",
    "editorBracketMatch.background": "#E4E4E41E",
    "editorIndentGuide.background1": "#E4E4E413",
    "editorIndentGuide.activeBackground1": "#E4E4E430",
    "editorRuler.foreground": "#E4E4E442",
    "editorGutter.background": "#181818",
    "editorGutter.addedBackground": "#3FA266",
    "editorGutter.modifiedBackground": "#D2943E",
    "editorGutter.deletedBackground": "#E34671",
    "editorSuggestWidget.background": "#141414",
    "editorSuggestWidget.border": "#E4E4E413",
    "editorSuggestWidget.foreground": "#E4E4E4EB",
    "editorSuggestWidget.selectedBackground": "#343434",
    "editorHoverWidget.background": "#181818",
    "editorHoverWidget.border": "#E4E4E413",
    "editorHoverWidget.foreground": "#E4E4E4EB",
    "editorWidget.background": "#141414",
    "editorWidget.resizeBorder": "#E4E4E426",
    "editorCodeLens.foreground": "#E4E4E442",
    "editorInlayHint.foreground": "#E4E4E442",
    "editorInlayHint.background": "#00000000",
    "peekView.border": "#E4E4E442",
    "peekViewEditor.background": "#141414",
    "peekViewResult.background": "#141414",
    "peekViewTitle.background": "#242424",
    "peekViewEditor.matchHighlightBackground": "#88C0D044",
    "peekViewResult.matchHighlightBackground": "#88C0D044",
    "diffEditor.insertedTextBackground": "#3FA26622",
    "diffEditor.insertedLineBackground": "#3FA26633",
    "diffEditor.removedTextBackground": "#B8004922",
    "diffEditor.removedLineBackground": "#B8004933",
    "statusBar.background": "#141414",
    "statusBar.foreground": "#E4E4E45E",
    "statusBar.border": "#E4E4E413",
    "statusBar.debuggingBackground": "#E4E4E41C",
    "statusBar.debuggingForeground": "#E4E4E4EB",
    "statusBarItem.activeBackground": "#E4E4E41E",
    "statusBarItem.hoverBackground": "#E4E4E411",
    "titleBar.activeBackground": "#141414",
    "titleBar.activeForeground": "#E4E4E484",
    "titleBar.inactiveBackground": "#141414",
    "titleBar.inactiveForeground": "#E4E4E45E",
    "titleBar.border": "#E4E4E413",
    "menu.background": "#141414",
    "menu.foreground": "#E4E4E4EB",
    "menu.separatorBackground": "#E4E4E413",
    "menu.border": "#E4E4E413",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#E4E4E411",
    "scrollbarSlider.hoverBackground": "#E4E4E41E",
    "scrollbarSlider.activeBackground": "#E4E4E41E",
    "minimap.background": "#181818",
    "minimap.findMatchHighlight": "#88C0D044",
    "minimap.selectionHighlight": "#E4E4E411",
    "minimapGutter.addedBackground": "#3FA266",
    "minimapGutter.modifiedBackground": "#D2943E",
    "minimapGutter.deletedBackground": "#E34671",
    "gitDecoration.addedResourceForeground": "#70B489",
    "gitDecoration.modifiedResourceForeground": "#F1B467",
    "gitDecoration.deletedResourceForeground": "#FC6B83",
    "gitDecoration.untrackedResourceForeground": "#88C0D0",
    "gitDecoration.ignoredResourceForeground": "#E4E4E45E",
    "notificationLink.foreground": "#88C0D0",
    "notifications.background": "#141414",
    "notifications.foreground": "#E4E4E4EB",
    "progressBar.background": "#3FA266",
    descriptionForeground: "#E4E4E48D",
    errorForeground: "#E34671",
    "button.background": "#81A1C1",
    "button.foreground": "#191c22",
    "button.hoverBackground": "#87A6C4",
    "button.secondaryBackground": "#626262",
    "button.secondaryForeground": "#E4E4E4EB",
    "button.secondaryHoverBackground": "#818181",
    // Terminal colors
    "terminal.background": "#141414",
    "terminal.foreground": "#E4E4E4EB",
    "terminal.ansiBlack": "#242424",
    "terminal.ansiRed": "#FC6B83",
    "terminal.ansiGreen": "#3FA266",
    "terminal.ansiYellow": "#D2943E",
    "terminal.ansiBlue": "#81A1C1",
    "terminal.ansiMagenta": "#B48EAD",
    "terminal.ansiCyan": "#88C0D0",
    "terminal.ansiWhite": "#E4E4E4",
    "terminal.ansiBrightBlack": "#E4E4E442",
    "terminal.ansiBrightRed": "#FC6B83",
    "terminal.ansiBrightGreen": "#70B489",
    "terminal.ansiBrightYellow": "#F1B467",
    "terminal.ansiBrightBlue": "#87A6C4",
    "terminal.ansiBrightMagenta": "#B48EAD",
    "terminal.ansiBrightCyan": "#88C0D0",
    "terminal.ansiBrightWhite": "#E4E4E4",
    "terminalCursor.foreground": "#E4E4E4EB",
    "terminalCursor.background": "#141414",
  },
  tokenColors: [
    { scope: "emphasis", settings: { fontStyle: "italic" } },
    { scope: "strong", settings: { fontStyle: "bold" } },
    {
      scope:
        "comment, punctuation.definition.comment, comment.line.double-slash, comment.block.documentation",
      settings: { fontStyle: "italic", foreground: "#E4E4E45E" },
    },
    {
      scope:
        "string, punctuation.definition.string.begin, punctuation.definition.string.end",
      settings: { foreground: "#e394dc" },
    },
    {
      scope: "variable.parameter.function",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "constant.numeric", settings: { foreground: "#ebc88d" } },
    { scope: "constant.language", settings: { foreground: "#82d2ce" } },
    {
      scope: "constant.character, constant.character.escape",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "constant.other.color", settings: { foreground: "#ebc88d" } },
    { scope: "constant.other.symbol", settings: { foreground: "#d6d6dd" } },
    { scope: "keyword", settings: { foreground: "#82D2CE" } },
    { scope: "keyword.control", settings: { foreground: "#82D2CE" } },
    { scope: "keyword.operator", settings: { foreground: "#d6d6dd" } },
    {
      scope: "keyword.operator.assignment.compound",
      settings: { foreground: "#82D2CE" },
    },
    { scope: "keyword.operator.logical", settings: { foreground: "#d6d6dd" } },
    {
      scope:
        "keyword.operator.new, keyword.operator.expression.typeof, keyword.operator.expression.instanceof, keyword.operator.expression.keyof, keyword.operator.expression.of, keyword.operator.expression.in, keyword.operator.expression.delete, keyword.operator.expression.void, keyword.operator.ternary, keyword.operator.optional",
      settings: { foreground: "#82D2CE" },
    },
    { scope: "storage, token.storage", settings: { foreground: "#82d2ce" } },
    { scope: "storage.type", settings: { foreground: "#82d2ce" } },
    {
      scope: "storage.modifier.reference, storage.modifier.pointer",
      settings: { foreground: "#CCCCCC" },
    },
    {
      scope:
        "entity.name.function, meta.require, support.function, variable.function",
      settings: { foreground: "#efb080" },
    },
    { scope: "entity.name.type", settings: { foreground: "#efb080" } },
    {
      scope: "entity.name.type.namespace",
      settings: { foreground: "#efb080" },
    },
    {
      scope:
        "entity.name.class, variable.other.class.js, variable.other.class.ts",
      settings: { foreground: "#efb080" },
    },
    {
      scope: "entity.other.inherited-class",
      settings: { foreground: "#efb080" },
    },
    { scope: "entity.name.tag", settings: { foreground: "#87c3ff" } },
    {
      scope: "entity.other.attribute-name",
      settings: { foreground: "#aaa0fa" },
    },
    {
      scope: "entity.other.attribute-name.id",
      settings: { foreground: "#aaa0fa" },
    },
    {
      scope: "entity.other.attribute-name.class.css",
      settings: { foreground: "#f8c762" },
    },
    {
      scope: "support.class, entity.name.type.class",
      settings: { foreground: "#87c3ff" },
    },
    { scope: "support.function", settings: { foreground: "#efb080" } },
    { scope: "support.constant", settings: { foreground: "#f8c762" } },
    { scope: "support.type", settings: { foreground: "#efb080" } },
    {
      scope:
        "support.type.primitive.ts, support.type.builtin.ts, support.type.primitive.tsx, support.type.builtin.tsx",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope:
        "support.variable.property, variable.other.property, variable.other.property.ts, meta.definition.property.ts",
      settings: { foreground: "#AAA0FA" },
    },
    { scope: "variable, variable.c", settings: { foreground: "#d6d6dd" } },
    { scope: "variable.other.readwrite", settings: { foreground: "#87C3FF" } },
    { scope: "variable.other.constant", settings: { foreground: "#AAA0FA" } },
    { scope: "variable.language", settings: { foreground: "#CC7C8A" } },
    {
      scope:
        "variable.parameter.function.js, variable.parameter.function.python, variable.parameter.function.language.python",
      settings: { foreground: "#f8c762" },
    },
    { scope: "meta.property-name.css", settings: { foreground: "#87c3ff" } },
    { scope: "meta.property-value.css", settings: { foreground: "#e394dc" } },
    { scope: "meta.tag", settings: { foreground: "#fad075" } },
    {
      scope: "meta.function-call.generic.python",
      settings: { foreground: "#aaa0fa" },
    },
    {
      scope: "punctuation.definition.tag",
      settings: { foreground: "#A4A4A4" },
    },
    {
      scope: "punctuation.separator.delimiter",
      settings: { foreground: "#d6d6dd" },
    },
    {
      scope:
        "punctuation.definition.template-expression.begin, punctuation.definition.template-expression.end, punctuation.section.embedded",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope:
        "punctuation.definition.decorator.python, entity.name.function.decorator.python, meta.function.decorator.python",
      settings: { foreground: "#a8cc7c" },
    },
    { scope: "string.regexp", settings: { foreground: "#d6d6dd" } },
    {
      scope: "string.quoted.binary.single.python",
      settings: { foreground: "#a8cc7c" },
    },
    {
      scope: "support.type.property-name.json",
      settings: { foreground: "#82d2ce" },
    },
    {
      scope:
        "source.json meta.structure.dictionary.json > value.json > string.quoted.json, source.json meta.structure.array.json > value.json > string.quoted.json",
      settings: { foreground: "#e394dc" },
    },
    { scope: "markup.heading", settings: { foreground: "#d6d6dd" } },
    {
      scope:
        "markup.heading punctuation.definition.heading, entity.name.section",
      settings: { foreground: "#aaa0fa" },
    },
    { scope: "markup.bold, todo.bold", settings: { foreground: "#f8c762" } },
    {
      scope: "markup.italic, punctuation.definition.italic, todo.emphasis",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope: "markup.inline.raw.markdown, markup.inline.raw.string.markdown",
      settings: { foreground: "#e394dc" },
    },
    {
      scope:
        "markup.underline.link.markdown, markup.underline.link.image.markdown",
      settings: { foreground: "#82D2CE" },
    },
    { scope: "markup.quote.markdown", settings: { foreground: "#E4E4E45E" } },
    {
      scope:
        "punctuation.definition.list.begin.markdown, punctuation.definition.list.markdown, beginning.punctuation.definition.list.markdown",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "keyword.other.unit", settings: { foreground: "#ebc88d" } },
    {
      scope:
        "invalid.illegal, invalid.broken, invalid.deprecated, invalid.unimplemented",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "token.info-token", settings: { foreground: "#aaa0fa" } },
    { scope: "token.warn-token", settings: { foreground: "#f8c762" } },
    { scope: "token.error-token", settings: { foreground: "#F14C4C" } },
    { scope: "token.debug-token", settings: { foreground: "#82D2CE" } },
    // Python
    { scope: "support.type.python", settings: { foreground: "#82d2ce" } },
    {
      scope: "variable.parameter.function.language.special.self.python",
      settings: { foreground: "#efb080" },
    },
    {
      scope: "support.variable.magic.python",
      settings: { foreground: "#d6d6dd" },
    },
    {
      scope: "constant.other.ellipsis.python",
      settings: { foreground: "#CCCCCC" },
    },
    {
      scope: "keyword.control.import.python, keyword.control.flow.python",
      settings: { fontStyle: "italic" },
    },
    // C/C++
    {
      scope: "constant.language.false.cpp, constant.language.true.cpp",
      settings: { foreground: "#82d2ce" },
    },
    {
      scope: "variable.language.this.cpp",
      settings: { foreground: "#82d2ce" },
    },
    { scope: "keyword.control.directive", settings: { foreground: "#a8cc7c" } },
    {
      scope: "keyword.control.directive.include.cpp",
      settings: { foreground: "#a8cc7c" },
    },
    {
      scope: "support.type.posix-reserved.c, support.type.posix-reserved.cpp",
      settings: { foreground: "#d6d6dd" },
    },
    {
      scope: "keyword.operator.sizeof.c, keyword.operator.sizeof.cpp",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope: "punctuation.separator.c, punctuation.separator.cpp",
      settings: { foreground: "#82D2CE" },
    },
    // Rust
    {
      scope: "storage.modifier.lifetime.rust",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "entity.name.lifetime.rust", settings: { foreground: "#efb080" } },
    { scope: "variable.language.rust", settings: { foreground: "#d6d6dd" } },
    { scope: "support.function.std.rust", settings: { foreground: "#aaa0fa" } },
    {
      scope: "keyword.operator.sigil.rust",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope: "support.constant.core.rust",
      settings: { foreground: "#f8c762" },
    },
    // TypeScript/JavaScript
    {
      scope: "entity.name.function.js, support.function.console.js",
      settings: { foreground: "#ebc88d" },
    },
    {
      scope: "support.type.object.console",
      settings: { foreground: "#d6d6dd" },
    },
    { scope: "support.constant.math", settings: { foreground: "#efb080" } },
    {
      scope: "support.constant.property.math",
      settings: { foreground: "#f8c762" },
    },
    {
      scope: "keyword.operator.expression.import",
      settings: { foreground: "#aaa0fa" },
    },
    {
      scope:
        "keyword.other.template.begin, keyword.other.template.end, keyword.other.substitution.begin, keyword.other.substitution.end",
      settings: { foreground: "#e394dc" },
    },
    { scope: "meta.template.expression", settings: { foreground: "#d6d6dd" } },
    // Java
    {
      scope: "storage.type.annotation.java, storage.type.object.array.java",
      settings: { foreground: "#efb080" },
    },
    { scope: "source.java", settings: { foreground: "#d6d6dd" } },
    {
      scope:
        "storage.modifier.import.java, storage.type.java, storage.type.generic.java",
      settings: { foreground: "#efb080" },
    },
    {
      scope: "keyword.operator.instanceof.java",
      settings: { foreground: "#82D2CE" },
    },
    { scope: "meta.method.java", settings: { foreground: "#aaa0fa" } },
    {
      scope: "meta.definition.variable.name.java",
      settings: { foreground: "#d6d6dd" },
    },
    // Go
    { scope: "entity.name.package.go", settings: { foreground: "#efb080" } },
    {
      scope: "keyword.operator.assignment.go",
      settings: { foreground: "#efb080" },
    },
    {
      scope: "keyword.operator.arithmetic.go, keyword.operator.address.go",
      settings: { foreground: "#82D2CE" },
    },
    // Vue
    {
      scope:
        "entity.name.tag.template, entity.name.tag.script, entity.name.tag.style",
      settings: { foreground: "#AAA0FA" },
    },
    // HTML
    { scope: "entity.name.tag.html", settings: { foreground: "#87c3ff" } },
    // YAML
    {
      scope: "punctuation.definition.block.sequence.item.yaml",
      settings: { foreground: "#d6d6dd" },
    },
    // Elixir
    {
      scope: "constant.language.symbol.elixir",
      settings: { foreground: "#d6d6dd" },
    },
    // Diff
    { scope: "markup.changed.diff", settings: { foreground: "#efb080" } },
    {
      scope:
        "meta.diff.header.from-file, meta.diff.header.to-file, punctuation.definition.from-file.diff, punctuation.definition.to-file.diff",
      settings: { foreground: "#aaa0fa" },
    },
    { scope: "markup.inserted.diff", settings: { foreground: "#e394dc" } },
    { scope: "markup.deleted.diff", settings: { foreground: "#d6d6dd" } },
    // PHP
    {
      scope:
        "support.other.namespace.use.php, support.other.namespace.use-as.php, support.other.namespace.php, entity.other.alias.php, meta.interface.php",
      settings: { foreground: "#efb080" },
    },
    {
      scope: "keyword.operator.error-control.php, keyword.operator.type.php",
      settings: { foreground: "#82D2CE" },
    },
    {
      scope:
        "storage.type.php, meta.other.type.phpdoc.php, keyword.other.type.php, keyword.other.array.phpdoc.php",
      settings: { foreground: "#efb080" },
    },
    {
      scope:
        "meta.function-call.php, meta.function-call.object.php, meta.function-call.static.php",
      settings: { foreground: "#aaa0fa" },
    },
    {
      scope:
        "support.constant.ext.php, support.constant.std.php, support.constant.core.php, support.constant.parser-token.php",
      settings: { foreground: "#f8c762" },
    },
    // CSS
    {
      scope:
        "keyword.operator.css, keyword.operator.scss, keyword.operator.less",
      settings: { foreground: "#d6d6dd" },
    },
    {
      scope:
        "support.constant.color.w3c-standard-color-name.css, support.constant.color.w3c-standard-color-name.scss",
      settings: { foreground: "#f8c762" },
    },
    {
      scope: "punctuation.separator.list.comma.css",
      settings: { foreground: "#d6d6dd" },
    },
    // C#
    { scope: "storage.type.cs", settings: { foreground: "#efb080" } },
    {
      scope: "entity.name.variable.local.cs",
      settings: { foreground: "#d6d6dd" },
    },
    {
      scope:
        "entity.name.label.cs, entity.name.scope-resolution.function.call, entity.name.scope-resolution.function.definition",
      settings: { foreground: "#efb080" },
    },
    // Ruby
    {
      scope: "constant.language.symbol.ruby",
      settings: { foreground: "#d6d6dd" },
    },
    // Haskell
    {
      scope: "variable.other.generic-type.haskell",
      settings: { foreground: "#82D2CE" },
    },
    { scope: "storage.type.haskell", settings: { foreground: "#f8c762" } },
    // RegExp
    {
      scope: "keyword.operator.quantifier.regexp",
      settings: { foreground: "#f8c762" },
    },
    // Misc
    { scope: "support.constant.edge", settings: { foreground: "#82D2CE" } },
    {
      scope:
        "entity.name.type.module, support.module.node, support.type.object.module",
      settings: { foreground: "#efb080" },
    },
  ],
  semanticHighlighting: true,
  semanticTokenColors: {
    enumMember: { foreground: "#d6d6dd" },
    "variable.constant": { foreground: "#82D2CE" },
    "variable.defaultLibrary": { foreground: "#d6d6dd" },
    "method.declaration": { foreground: "#efb080", fontStyle: "bold" },
    "function.declaration": { foreground: "#efb080", fontStyle: "bold" },
    function: "#ebc88d",
    "function.builtin": "#82d2ce",
    "class.builtin": "#82d2ce",
    "class.declaration:python": "#87c3ff",
    "class:python": { foreground: "#ebc88d" },
    "*.decorator:python": { foreground: "#a8cc7c" },
    "method:python": { foreground: "#ebc88d" },
    selfParameter: "#cc7c8a",
    macro: "#a8cc7c",
    "namespace:cpp": "#87c3ff",
    "type:cpp": "#87c3ff",
    "type:c": "#87c3ff",
    "variable.global:cpp": "#a8cc7c",
    "variable.global:c": "#a8cc7c",
    "property:cpp": "#AAA0FA",
    "property:c": "#AAA0FA",
    "property.declaration:cpp": "#AAA0FA",
    "property.declaration:c": "#AAA0FA",
    "function:cpp": { foreground: "#E4E4E4EB", fontStyle: "bold" },
    "function:c": { foreground: "#E4E4E4EB", fontStyle: "bold" },
    "method:cpp": { foreground: "#87c3ff" },
    "variable:javascript": "#CCCCCC",
    "support.variable.property": "#AAA0FA",
    "builtinConstant.readonly.builtin:python": "#82d2ce",
  },
}
