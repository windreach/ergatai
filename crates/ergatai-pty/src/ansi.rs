//! ANSI escape sequence parser
//!
//! Uses the `vte` crate (from alacritty) to parse ANSI/ECMA-48 sequences
//! and extract clean text from agent output.
//!
//! Reference: <https://github.com/alacritty/vte> (Apache-2.0 / MIT)

use vte::{Parser, Perform};

/// Extract clean text from raw terminal output (strip ANSI sequences)
///
/// This parser collects only printable characters, ignoring:
/// - Cursor movement (CSI sequences)
/// - Color codes (SGR sequences)
/// - Screen clearing (ED sequences)
/// - Other control sequences
///
/// # Example
///
/// ```
/// use ergatai_pty::ansi::strip_ansi;
///
/// let raw = "\x1b[32mHello\x1b[0m \x1b[1mWorld\x1b[0m";
/// let clean = strip_ansi(raw.as_bytes());
/// assert_eq!(clean, "Hello World");
/// ```
pub fn strip_ansi(input: &[u8]) -> String {
    let mut parser = Parser::new();
    let mut performer = TextPerformer {
        text: String::new(),
    };

    for &byte in input {
        parser.advance(&mut performer, byte);
    }

    performer.text
}

/// vte Performer that collects only printable text
struct TextPerformer {
    text: String,
}

impl Perform for TextPerformer {
    /// Called for printable characters
    fn print(&mut self, c: char) {
        self.text.push(c);
    }

    /// Called for C1 control characters (0x80-0x9F)
    fn execute(&mut self, byte: u8) {
        // Ignore control characters (bell, backspace, etc.)
        // Exception: newline, tab, carriage return
        match byte {
            b'\n' | b'\r' | b'\t' => self.text.push(byte as char),
            _ => {} // Ignore other control chars
        }
    }

    /// Called when a CSI (Control Sequence Introducer) sequence starts
    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        // Ignore DCS sequences
    }

    /// Called for OSC (Operating System Command) sequences
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {
        // Ignore OSC sequences (title changes, etc.)
    }

    /// Called for CSI sequences (cursor movement, colors, etc.)
    fn csi_dispatch(
        &mut self,
        _params: &vte::Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
        // Ignore CSI sequences (we only want printable text)
    }

    /// Called for escape sequences
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        // Ignore escape sequences
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi_colors() {
        let raw = b"\x1b[32mHello\x1b[0m \x1b[1mWorld\x1b[0m";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "Hello World");
    }

    #[test]
    fn test_strip_ansi_cursor() {
        let raw = b"\x1b[2J\x1b[HHello"; // Clear screen + home + "Hello"
        let clean = strip_ansi(raw);
        assert_eq!(clean, "Hello");
    }

    #[test]
    fn test_strip_ansi_complex() {
        let raw = b"\x1b[?25l\x1b[1;1H\x1b[31mError\x1b[0m\x1b[?25h";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "Error");
    }

    #[test]
    fn test_strip_ansi_newlines() {
        let raw = b"Line 1\nLine 2\r\nLine 3";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "Line 1\nLine 2\r\nLine 3");
    }

    #[test]
    fn test_strip_ansi_empty() {
        let raw = b"";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "");
    }

    #[test]
    fn test_strip_ansi_no_ansi() {
        let raw = b"Plain text";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "Plain text");
    }
}
