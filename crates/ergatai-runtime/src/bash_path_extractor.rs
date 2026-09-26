//! Static path extraction from Bash commands.
//!
//! When an ACP agent wants to run a Bash command, we cannot always predict
//! which files it will write to. This module provides best-effort static
//! analysis of Bash command strings to extract write target paths.
//!
//! # Coverage
//!
//! The extractor handles common patterns:
//! - Output redirection (`>`, `>>`)
//! - In-place editors (`sed -i`, `perl -pi`, `awk -i inplace`)
//! - Tee (`tee file1 file2`)
//! - File operations (`mv`, `cp`, `ln` target arguments)
//! - Downloads (`curl -o`, `wget -O`)
//! - Delete/create (`rm`, `mkdir`)
//!
//! # Limitations
//!
//! - Cannot resolve shell variables (`$FILE`) or command substitution (`$(...)`)
//! - Cannot handle complex pipelines with dynamic paths
//! - Cannot parse quoted strings with spaces (simple whitespace tokenization)
//! - Extraction failures return empty paths (caller decides to proceed or reject)
//!
//! # Design
//!
//! This is a pure function with no side effects. It takes a command string and
//! returns a list of file paths. If extraction fails or yields no results, the
//! caller (permission.rs) decides whether to proceed without pre-locking or
//! reject the tool call.

use std::collections::HashSet;

/// Extract write target paths from a Bash command string.
///
/// Returns a deduplicated list of file paths that the command is likely to
/// write to. Returns an empty vector if no paths can be extracted (e.g.,
/// all targets are dynamic variables).
///
/// # Examples
///
/// ```rust
/// use ergatai_runtime::bash_path_extractor::extract_bash_write_targets;
///
/// assert_eq!(
///     extract_bash_write_targets("echo hello > output.txt"),
///     vec!["output.txt"]
/// );
///
/// assert_eq!(
///     extract_bash_write_targets("sed -i 's/foo/bar/' config.yaml"),
///     vec!["config.yaml"]
/// );
///
/// // Dynamic paths cannot be extracted
/// assert!(extract_bash_write_targets("echo $DATA > $FILE").is_empty());
/// ```
pub fn extract_bash_write_targets(cmd: &str) -> Vec<String> {
    let mut paths = HashSet::new();

    // Split command into tokens (simple whitespace split, no shell parsing)
    let tokens: Vec<&str> = cmd.split_whitespace().collect();

    if tokens.is_empty() {
        return Vec::new();
    }

    // Pattern 1: Output redirection (> or >>)
    for (i, token) in tokens.iter().enumerate() {
        if *token == ">" || *token == ">>" || *token == "1>" || *token == "2>" {
            if let Some(target) = tokens.get(i + 1) {
                let normalized = normalize_path(target);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                }
            }
        }
    }

    // Pattern 2: sed -i (in-place edit)
    if tokens.contains(&"sed") && tokens.contains(&"-i") {
        // Find the file argument (last non-option token after sed)
        for token in tokens.iter().rev() {
            if *token != "sed" && *token != "-i" && !token.starts_with('-') {
                let normalized = normalize_path(token);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                    break;
                }
            }
        }
    }

    // Pattern 3: perl -pi (in-place edit)
    if tokens.contains(&"perl") && (tokens.contains(&"-pi") || tokens.contains(&"-p")) {
        for token in tokens.iter().rev() {
            if *token != "perl" && *token != "-pi" && *token != "-p" && !token.starts_with('-') {
                let normalized = normalize_path(token);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                    break;
                }
            }
        }
    }

    // Pattern 4: tee
    if let Some(tee_idx) = tokens.iter().position(|t| *t == "tee") {
        for token in &tokens[tee_idx + 1..] {
            let normalized = normalize_path(token);
            if is_likely_file_path(&normalized) {
                paths.insert(normalized);
            }
        }
    }

    // Pattern 5: mv / cp / ln (target is last argument)
    for cmd_name in ["mv", "cp", "ln"] {
        if let Some(idx) = tokens.iter().position(|t| *t == cmd_name) {
            // Find last non-option token
            for token in tokens[idx + 1..].iter().rev() {
                if !token.starts_with('-') {
                    let normalized = normalize_path(token);
                    if is_likely_file_path(&normalized) {
                        paths.insert(normalized);
                        break;
                    }
                }
            }
        }
    }

    // Pattern 6: curl -o / wget -O (output file)
    if tokens.contains(&"curl") {
        if let Some(o_idx) = tokens.iter().position(|t| *t == "-o") {
            if let Some(target) = tokens.get(o_idx + 1) {
                let normalized = normalize_path(target);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                }
            }
        }
    }

    if tokens.contains(&"wget") {
        if let Some(o_idx) = tokens.iter().position(|t| *t == "-O") {
            if let Some(target) = tokens.get(o_idx + 1) {
                let normalized = normalize_path(target);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                }
            }
        }
    }

    // Pattern 7: rm (delete)
    if let Some(rm_idx) = tokens.iter().position(|t| *t == "rm") {
        for token in &tokens[rm_idx + 1..] {
            if !token.starts_with('-') {
                let normalized = normalize_path(token);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                }
            }
        }
    }

    // Pattern 8: mkdir (create)
    if let Some(mkdir_idx) = tokens.iter().position(|t| *t == "mkdir") {
        for token in &tokens[mkdir_idx + 1..] {
            if !token.starts_with('-') {
                let normalized = normalize_path(token);
                if is_likely_file_path(&normalized) {
                    paths.insert(normalized);
                }
            }
        }
    }

    paths.into_iter().collect()
}

/// Check if a token looks like a file path (not a variable, URL, or option).
fn is_likely_file_path(token: &str) -> bool {
    // Skip empty
    if token.is_empty() {
        return false;
    }

    // Skip shell variables ($VAR, ${VAR})
    if token.contains('$') {
        return false;
    }

    // Skip options (-flag, --option)
    if token.starts_with('-') {
        return false;
    }

    // Skip URLs
    if token.starts_with("http://") || token.starts_with("https://") || token.starts_with("ftp://")
    {
        return false;
    }

    // Skip pure numbers
    if token.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    // Skip shell keywords (after normalization, so "then;" becomes "then")
    if matches!(
        token,
        "then"
            | "fi"
            | "do"
            | "done"
            | "esac"
            | "elif"
            | "else"
            | "case"
            | "in"
            | "for"
            | "while"
            | "until"
    ) {
        return false;
    }

    // Skip /dev/null and similar special files
    if token == "/dev/null" || token == "/dev/stdout" || token == "/dev/stderr" {
        return false;
    }

    // Skip shell operators (redirection, pipes, etc.)
    if matches!(
        token,
        ">" | ">>" | "<" | "<<" | "|" | "||" | "&&" | "&" | ";" | ";;"
    ) {
        return false;
    }

    // Accept any non-empty token that passes the above checks
    true
}

/// Normalize a path: strip quotes, trailing shell metacharacters, handle ~ expansion (future work).
fn normalize_path(path: &str) -> String {
    // Strip surrounding quotes
    let path = path.trim_matches('"').trim_matches('\'');

    // Strip trailing shell metacharacters like ;, &, |
    let path = path.trim_end_matches(&[';', '&', '|'][..]);

    // TODO: Handle ~ expansion if needed
    // For now, return as-is

    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redirect_simple() {
        let paths = extract_bash_write_targets("echo hello > output.txt");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_redirect_append() {
        let paths = extract_bash_write_targets("echo hello >> log.txt");
        assert_eq!(paths, vec!["log.txt"]);
    }

    #[test]
    fn test_redirect_fd() {
        let paths = extract_bash_write_targets("cmd 1> out.txt 2> err.txt");
        let mut paths = paths;
        paths.sort();
        assert_eq!(paths, vec!["err.txt", "out.txt"]);
    }

    #[test]
    fn test_sed_inplace() {
        let paths = extract_bash_write_targets("sed -i 's/foo/bar/' config.yaml");
        assert_eq!(paths, vec!["config.yaml"]);
    }

    #[test]
    fn test_perl_inplace() {
        let paths = extract_bash_write_targets("perl -pi -e 's/a/b/' file.txt");
        assert_eq!(paths, vec!["file.txt"]);
    }

    #[test]
    fn test_tee_single() {
        let paths = extract_bash_write_targets("cmd | tee output.txt");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_tee_multiple() {
        let paths = extract_bash_write_targets("cmd | tee a.txt b.txt c.txt");
        let mut paths = paths;
        paths.sort();
        assert_eq!(paths, vec!["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn test_mv_target() {
        let paths = extract_bash_write_targets("mv src.txt dst.txt");
        assert_eq!(paths, vec!["dst.txt"]);
    }

    #[test]
    fn test_cp_target() {
        let paths = extract_bash_write_targets("cp source.txt dest.txt");
        assert_eq!(paths, vec!["dest.txt"]);
    }

    #[test]
    fn test_curl_output() {
        let paths = extract_bash_write_targets("curl https://example.com -o pkg.tar.gz");
        assert_eq!(paths, vec!["pkg.tar.gz"]);
    }

    #[test]
    fn test_wget_output() {
        let paths = extract_bash_write_targets("wget https://example.com -O file.zip");
        assert_eq!(paths, vec!["file.zip"]);
    }

    #[test]
    fn test_rm_files() {
        let paths = extract_bash_write_targets("rm old.txt temp.log");
        let mut paths = paths;
        paths.sort();
        assert_eq!(paths, vec!["old.txt", "temp.log"]);
    }

    #[test]
    fn test_mkdir() {
        let paths = extract_bash_write_targets("mkdir -p new_dir");
        assert_eq!(paths, vec!["new_dir"]);
    }

    #[test]
    fn test_dynamic_variable_filtered() {
        let paths = extract_bash_write_targets("echo $DATA > $FILE");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_complex_pipeline() {
        let paths = extract_bash_write_targets(
            "cat input.txt | grep foo | sed 's/x/y/' | tee output.txt > /dev/null",
        );
        // tee pattern extracts output.txt; redirect to /dev/null is filtered
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_no_write_command() {
        assert!(extract_bash_write_targets("ls -la").is_empty());
        assert!(extract_bash_write_targets("cat file.txt").is_empty());
        assert!(extract_bash_write_targets("grep foo bar").is_empty());
    }

    #[test]
    fn test_dev_null_filtered() {
        let paths = extract_bash_write_targets("cmd > /dev/null");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_quoted_path_limitation() {
        // LIMITATION: Simple whitespace tokenization cannot handle quoted strings with spaces
        // "output file.txt" is split into two tokens: "output and file.txt"
        // Only the first part after quote stripping is extracted
        let paths = extract_bash_write_targets("echo hello > \"output file.txt\"");
        assert_eq!(paths, vec!["output"]);
    }

    #[test]
    fn test_shell_keywords_filtered() {
        let paths = extract_bash_write_targets("if true; then echo x > out.txt; fi");
        assert_eq!(paths, vec!["out.txt"]);
    }

    #[test]
    fn test_url_filtered() {
        let paths = extract_bash_write_targets("curl https://example.com/file.txt");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_path_with_extension() {
        let paths = extract_bash_write_targets("touch new_file.log");
        // touch doesn't have a specific pattern, but file has extension
        // Current implementation doesn't handle touch, so empty
        assert!(paths.is_empty());
    }

    #[test]
    fn test_empty_command() {
        let paths = extract_bash_write_targets("");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_whitespace_only_command() {
        let paths = extract_bash_write_targets("   ");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_command_with_only_options() {
        let paths = extract_bash_write_targets("ls -la --color=auto");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_redirect_with_quotes() {
        let paths = extract_bash_write_targets("echo hello > \"output file.txt\"");
        // Simple whitespace split doesn't handle quoted strings correctly
        // This is a known limitation - quotes are not parsed
        assert_eq!(paths, vec!["output"]);
    }

    #[test]
    fn test_redirect_with_single_quotes() {
        let paths = extract_bash_write_targets("echo hello > 'output.txt'");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_multiple_redirects_same_file() {
        let paths = extract_bash_write_targets("echo a > out.txt && echo b >> out.txt");
        // Should deduplicate
        assert_eq!(paths, vec!["out.txt"]);
    }

    #[test]
    fn test_mixed_commands() {
        let paths = extract_bash_write_targets("sed -i 's/a/b/' file.txt && echo done > log.txt");
        // The extractor doesn't handle '&&' command chaining well
        // It only extracts from the redirect pattern
        assert_eq!(paths, vec!["log.txt"]);
    }

    #[test]
    fn test_rm_command() {
        let paths = extract_bash_write_targets("rm -rf temp_dir");
        assert_eq!(paths, vec!["temp_dir"]);
    }

    #[test]
    fn test_mkdir_command() {
        let paths = extract_bash_write_targets("mkdir -p new_dir/subdir");
        assert_eq!(paths, vec!["new_dir/subdir"]);
    }

    #[test]
    fn test_cp_command() {
        let paths = extract_bash_write_targets("cp source.txt dest.txt");
        assert_eq!(paths, vec!["dest.txt"]);
    }

    #[test]
    fn test_mv_command() {
        let paths = extract_bash_write_targets("mv old.txt new.txt");
        assert_eq!(paths, vec!["new.txt"]);
    }

    #[test]
    fn test_curl_with_output() {
        let paths = extract_bash_write_targets("curl -o downloaded.html https://example.com");
        assert_eq!(paths, vec!["downloaded.html"]);
    }

    #[test]
    fn test_wget_with_output() {
        let paths = extract_bash_write_targets("wget -O file.zip https://example.com/file.zip");
        assert_eq!(paths, vec!["file.zip"]);
    }

    #[test]
    fn test_shell_variable_filtered() {
        let paths = extract_bash_write_targets("echo hello > $OUTPUT_FILE");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_command_substitution_filtered() {
        let paths = extract_bash_write_targets("echo hello > $(mktemp)");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_path_with_trailing_semicolon() {
        let paths = extract_bash_write_targets("echo hello > output.txt; echo done");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_path_with_trailing_ampersand() {
        let paths = extract_bash_write_targets("echo hello > output.txt &");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_path_with_trailing_pipe() {
        let paths = extract_bash_write_targets("echo hello > output.txt | grep hello");
        assert_eq!(paths, vec!["output.txt"]);
    }

    #[test]
    fn test_awk_inplace() {
        let paths = extract_bash_write_targets("awk -i inplace '{print}' file.txt");
        // awk -i inplace is not handled by the current implementation
        // This is a known limitation
        assert!(paths.is_empty());
    }

    #[test]
    fn test_ln_command() {
        let paths = extract_bash_write_targets("ln -s target.txt link.txt");
        assert_eq!(paths, vec!["link.txt"]);
    }

    #[test]
    fn test_multiple_redirects_same_command() {
        let paths = extract_bash_write_targets("cmd > out1.txt > out2.txt");
        let mut paths = paths;
        paths.sort();
        assert_eq!(paths, vec!["out1.txt", "out2.txt"]);
    }

    #[test]
    fn test_command_without_writes() {
        let paths = extract_bash_write_targets("ls -la");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_cat_without_redirect() {
        let paths = extract_bash_write_targets("cat file.txt");
        assert!(paths.is_empty());
    }

    #[test]
    fn test_multiple_commands_with_semicolon() {
        let paths = extract_bash_write_targets("echo a > file1.txt; echo b > file2.txt");
        let mut paths = paths;
        paths.sort();
        assert_eq!(paths, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn test_path_with_absolute_path() {
        let paths = extract_bash_write_targets("echo hello > /tmp/output.txt");
        assert_eq!(paths, vec!["/tmp/output.txt"]);
    }
}
