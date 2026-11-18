// Shared set of file extensions treated as text for content attachment.
export const TEXT_FILE_EXTENSIONS = new Set([
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".lua", ".r", ".m", ".mm", ".scala", ".clj", ".ex", ".exs",
  ".hs", ".elm", ".erl", ".fs", ".fsx", ".ml", ".v", ".vhdl", ".zig",
  // Config/Data
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env", ".conf", ".cfg",
  ".properties", ".plist",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  // Documentation
  ".md", ".mdx", ".rst", ".txt", ".text",
  // Graphics (text-based)
  ".svg",
  // Shell/Scripts
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  // Other
  ".sql", ".graphql", ".gql", ".prisma", ".dockerfile", ".makefile",
  ".gitignore", ".gitattributes", ".editorconfig", ".eslintrc", ".prettierrc",
])
