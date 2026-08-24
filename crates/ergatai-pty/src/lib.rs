//! ergatai-pty — PTY-based agent runtime for Ergatai
//!
//! This crate provides precise control over agent processes via PTY (pseudo-terminal),
//! enabling:
//! - Direct stdin/stdout control (no tmux dependency)
//! - Exact output capture (raw bytes before terminal rendering)
//! - ANSI parsing (extract clean text from agent output)
//! - Precise process lifecycle management (waitpid, signal forwarding)
//!
//! # Architecture
//!
//! ```text
//! Agent process (e.g., opencode)
//!     │
//!     ▼
//! PTY slave (/dev/pts/N)
//!     │
//!     ▼
//! PTY master (fd)
//!     │
//!     ├─→ ANSI parser → clean text → @mention extraction → routing
//!     │
//!     └─→ Terminal display (optional)
//! ```
//!
//! # Example
//!
//! ```rust,no_run
//! use ergatai_pty::{PtyProcess, PtyConfig};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     // Spawn an agent
//!     let config = PtyConfig {
//!         command: "opencode".into(),
//!         args: vec![],
//!         rows: 24,
//!         cols: 80,
//!     };
//!
//!     let mut process = PtyProcess::spawn(config)?;
//!
//!     // Write a message to the agent
//!     process.write(b"Hello, agent!\n").await?;
//!
//!     // Read output (raw bytes)
//!     let mut buf = [0u8; 4096];
//!     let n = process.read(&mut buf).await?;
//!     let raw_output = &buf[..n];
//!
//!     // Parse ANSI to extract clean text
//!     let clean_text = ergatai_pty::ansi::strip_ansi(raw_output);
//!     println!("Agent said: {}", clean_text);
//!
//!     Ok(())
//! }
//! ```

pub mod ansi;
pub mod process;
pub mod pty;

pub use process::{PtyConfig, PtyProcess};
pub use pty::Pty;
