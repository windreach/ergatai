//! LD_PRELOAD library for transparent snapshot-based file reads.
//!
//! When loaded via `LD_PRELOAD`, this library intercepts `open()` and `openat()`
//! system calls. For read-only opens of files that have an active WRITE lock
//! (held by another agent), the library redirects the read to a Git snapshot
//! — the file content as it was before the WRITE lock was acquired.
//!
//! # Architecture
//!
//! ```text
//! Agent process (with LD_PRELOAD=libergatai_preload.so)
//!   │  open("src/foo.rs", O_RDONLY)
//!   ▼
//! ┌──────────────────────────────────────────────────────────────┐
//! │ ergatai_preload::open()                                      │
//! │   1. Check if file has WRITE lock via Unix socket IPC        │
//! │   2. If locked: query snapshot hash, read from temp file     │
//! │   3. If not locked / IPC fails: fall through to real open()  │
//! └──────────────────────────────────────────────────────────────┘
//!   │
//!   ▼
//! libc::open()  (real implementation via dlsym(RTLD_NEXT))
//! ```
//!
//! # Fail-open contract
//!
//! If the IPC socket is unavailable, the query times out, or any other error
//! occurs, the library falls through to the real `open()`. A broken preload
//! library must never prevent normal file operations.
//!
//! # Safety
//!
//! This crate is fundamentally unsafe: it replaces libc symbols via dlsym.
//! All FFI boundaries are documented with SAFETY comments. The library avoids
//! heap allocation in the hot path where possible, but snapshot content must
//! be written to a temp file (unavoidable: the fd must reference real bytes).

#![deny(unsafe_op_in_unsafe_fn)]

use libc::{c_char, c_int, c_void, O_CREAT, O_RDWR, O_WRONLY};
use once_cell::sync::OnceCell;
use std::ffi::{CStr, CString};
use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};

/// IPC socket path. Set via `ERGATAI_LOCK_SOCKET` env var, or defaults to
/// `/tmp/ergatai-lock-{uid}.sock` where `{uid}` is the current user's UID.
fn socket_path() -> String {
    static CACHED: OnceCell<String> = OnceCell::new();
    CACHED
        .get_or_init(|| {
            std::env::var("ERGATAI_LOCK_SOCKET").unwrap_or_else(|_| {
                let uid = unsafe { libc::getuid() };
                format!("/tmp/ergatai-lock-{}.sock", uid)
            })
        })
        .clone()
}

/// Real `open` function pointer (resolved via dlsym).
/// Note: using fixed 3-arg signature — see `open()` for rationale.
type OpenFn = unsafe extern "C" fn(*const c_char, c_int, c_int) -> c_int;
type OpenatFn = unsafe extern "C" fn(c_int, *const c_char, c_int, c_int) -> c_int;

static REAL_OPEN: OnceCell<OpenFn> = OnceCell::new();
static REAL_OPENAT: OnceCell<OpenatFn> = OnceCell::new();

/// Resolve the real libc function via dlsym(RTLD_NEXT, ...).
///
/// # Safety
/// `name` must be a valid C string. The returned pointer is cast to the
/// requested function type — caller must ensure the libc signature matches.
unsafe fn resolve_symbol(name: &[u8]) -> *mut c_void {
    // SAFETY: name is a valid NUL-terminated C string provided by the caller.
    unsafe { libc::dlsym(libc::RTLD_NEXT, name.as_ptr() as *const c_char) }
}

fn ensure_real_open() -> OpenFn {
    *REAL_OPEN.get_or_init(|| {
        // SAFETY: "open\0" is a valid NUL-terminated C string.
        let ptr = unsafe { resolve_symbol(b"open\0") };
        if ptr.is_null() {
            panic!("dlsym: failed to resolve 'open'");
        }
        // SAFETY: libc `open` signature matches `unsafe extern "C" fn(*const c_char, c_int, ...) -> c_int`.
        unsafe { std::mem::transmute(ptr) }
    })
}

fn ensure_real_openat() -> OpenatFn {
    *REAL_OPENAT.get_or_init(|| {
        // SAFETY: "openat\0" is a valid NUL-terminated C string.
        let ptr = unsafe { resolve_symbol(b"openat\0") };
        if ptr.is_null() {
            panic!("dlsym: failed to resolve 'openat'");
        }
        // SAFETY: libc `openat` signature matches.
        unsafe { std::mem::transmute(ptr) }
    })
}

/// Check whether a file has an active WRITE lock via Unix socket IPC.
///
/// Returns `Some(git_hash)` if the file is locked and a snapshot exists,
/// `None` otherwise (including any IPC error — fail-open).
fn query_snapshot_hash(path: &str) -> Option<String> {
    // SECURITY: Reject paths containing JSON-significant control characters
    // (U+0000–U+001F). On Linux, filenames can contain anything except / and NUL.
    // A path with \n, \t, \r etc. could produce malformed JSON or allow injection
    // when manually escaped below. Fail-open: return None (skip redirect).
    if path.bytes().any(|b| b < 0x20) {
        return None;
    }

    let sock_path = socket_path();

    // Connect with timeout to avoid blocking the process on a dead socket.
    let mut stream = UnixStream::connect(&sock_path).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .ok()?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_millis(100)))
        .ok()?;

    // Send JSON query: {"action":"check_lock","file_path":"..."}
    let request = format!(
        r#"{{"action":"check_lock","file_path":"{}"}}"#,
        path.replace('\\', "\\\\").replace('"', "\\\"")
    );
    stream.write_all(request.as_bytes()).ok()?;

    // Read response (up to 4 KiB — snapshots hashes are short).
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).ok()?;
    let response = std::str::from_utf8(&buf[..n]).ok()?;

    // Minimal JSON parsing without serde dependency:
    // Expected: {"is_locked":true,"snapshot_hash":"abc123..."}
    // or:       {"is_locked":false}
    // Tolerate whitespace around ':' and after ',' (e.g. pretty-printed JSON).
    // Strip all whitespace to normalize before matching.
    let normalized = response.replace([' ', '\t', '\n', '\r'], "");
    if !normalized.contains(r#""is_locked":true"#) {
        return None;
    }

    // Extract snapshot_hash value from the NORMALIZED response (not the original).
    // Previously, extraction ran on the raw response, which would fail silently if
    // the server inserted whitespace around ':' (e.g., `"snapshot_hash": "abc"`).
    // Using the normalized response ensures consistency with the is_locked check.
    let key = r#""snapshot_hash":""#;
    let start = normalized.find(key)? + key.len();
    let rest = &normalized[start..];
    let end = rest.find('"')?;
    let hash = &rest[..end];

    if hash.is_empty() {
        None
    } else {
        Some(hash.to_string())
    }
}

/// Query snapshot content via Unix socket IPC.
///
/// Returns the file content as bytes, or `None` on any error (fail-open).
fn query_snapshot_content(git_hash: &str) -> Option<Vec<u8>> {
    let sock_path = socket_path();
    let mut stream = UnixStream::connect(&sock_path).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .ok()?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_millis(500)))
        .ok()?;

    let request = format!(r#"{{"action":"get_snapshot","git_hash":"{}"}}"#, git_hash);
    stream.write_all(request.as_bytes()).ok()?;

    // Read response length prefix (4 bytes, big-endian) followed by content.
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).ok()?;
    let content_len = u32::from_be_bytes(len_buf) as usize;

    // Cap at 100 MiB to prevent OOM from a malicious/buggy server.
    const MAX_SNAPSHOT_SIZE: usize = 100 * 1024 * 1024;
    if content_len > MAX_SNAPSHOT_SIZE {
        return None;
    }

    let mut content = vec![0u8; content_len];
    stream.read_exact(&mut content).ok()?;

    Some(content)
}

/// Check if open flags indicate a write operation.
///
/// Returns `true` for O_WRONLY, O_RDWR, or any flag that implies writing
/// (O_APPEND, O_TRUNC, O_CREAT).
fn is_write_flags(flags: c_int) -> bool {
    let access_mode = flags & libc::O_ACCMODE;
    access_mode == O_WRONLY
        || access_mode == O_RDWR
        || (flags & O_CREAT) != 0
        || (flags & libc::O_TRUNC) != 0
        || (flags & libc::O_APPEND) != 0
}

/// Atomic counter for unique temp file names (lock-free).
static SNAP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Redirect a read to a snapshot: write snapshot content to an anonymous memfd,
/// and return the fd. This avoids predictable temp file paths on disk.
///
/// Returns the fd, or `-1` on failure.
#[cfg(target_os = "linux")]
fn redirect_to_snapshot(_path: &str, git_hash: &str) -> c_int {
    let content = match query_snapshot_content(git_hash) {
        Some(c) => c,
        None => return -1,
    };

    // Create an anonymous memory file descriptor (memfd) to avoid filesystem race conditions.
    // memfd_create is available on Linux 3.17+ and creates a file in RAM with no filesystem path.
    let name = CString::new("ergatai-snapshot").unwrap_or_else(|_| CString::new("x").unwrap());
    // SAFETY: memfd_create with MFD_CLOEXEC flag. name is a valid C string.
    let fd = unsafe { libc::syscall(libc::SYS_memfd_create, name.as_ptr(), libc::MFD_CLOEXEC) };

    if fd < 0 {
        // Fallback: if memfd_create fails (e.g., old kernel), use a secure temp file.
        return redirect_to_snapshot_fallback(&content);
    }

    let fd = fd as c_int;

    // Write snapshot content to the memfd.
    let content_ptr = content.as_ptr() as *const c_void;
    let content_len = content.len();
    // SAFETY: fd is valid, content_ptr is valid for content_len bytes.
    let written = unsafe { libc::write(fd, content_ptr, content_len) };
    if written < 0 || written as usize != content_len {
        unsafe { libc::close(fd) };
        return -1;
    }

    // Seek back to start so the reader can read from the beginning.
    // SAFETY: fd is valid.
    unsafe { libc::lseek(fd, 0, libc::SEEK_SET) };

    fd
}

/// Non-Linux fallback: skip memfd, use secure temp file directly.
#[cfg(not(target_os = "linux"))]
fn redirect_to_snapshot(_path: &str, git_hash: &str) -> c_int {
    let content = match query_snapshot_content(git_hash) {
        Some(c) => c,
        None => return -1,
    };
    redirect_to_snapshot_fallback(&content)
}

/// Fallback for systems without memfd_create: use O_CREAT | O_EXCL for atomic creation.
fn redirect_to_snapshot_fallback(content: &[u8]) -> c_int {
    let pid = unsafe { libc::getpid() };
    let tid = unsafe { libc::pthread_self() };
    let counter = SNAP_COUNTER.fetch_add(1, Ordering::Relaxed);
    // pid + tid + counter is collision-resistant for temp file names.
    // Avoid libc::rand() — it uses process-global state and is not thread-safe,
    // causing data races when LD_PRELOAD is called from multiple threads.
    let tmp_path = format!("/tmp/ergatai-snap-{}-{}-{}", pid, tid as u64, counter);

    let tmp_cstr = match CString::new(tmp_path.as_bytes()) {
        Ok(s) => s,
        Err(_) => return -1,
    };

    let real_open = ensure_real_open();
    // SAFETY: tmp_cstr is valid. O_CREAT | O_EXCL | O_RDWR for atomic creation.
    let fd = unsafe { real_open(tmp_cstr.as_ptr(), O_CREAT | libc::O_EXCL | O_RDWR, 0o600) };
    if fd < 0 {
        return -1;
    }

    // Write content.
    let content_ptr = content.as_ptr() as *const c_void;
    let written = unsafe { libc::write(fd, content_ptr, content.len()) };
    if written < 0 || written as usize != content.len() {
        unsafe { libc::close(fd) };
        let _ = std::fs::remove_file(&tmp_path);
        return -1;
    }

    // Seek back to start.
    unsafe { libc::lseek(fd, 0, libc::SEEK_SET) };

    // Unlink immediately — the fd remains valid until close().
    let _ = std::fs::remove_file(&tmp_path);

    fd
}

/// Intercepted `open()`.
///
/// For read-only opens of locked files, redirects to a Git snapshot.
/// All other opens (writes, unknown files, IPC failures) fall through to libc.
///
/// # Safety
/// This is a C ABI function. `path` must be a valid C string pointer.
///
/// Note: `open()` is variadic in C (mode is only used when O_CREAT is set).
/// We use a fixed 3-arg signature because on x86_64 Linux the third arg is
/// always passed in rdx — we simply ignore it when O_CREAT is not set.
#[no_mangle]
pub unsafe extern "C" fn open(path: *const c_char, flags: c_int, mode: c_int) -> c_int {
    // Only intercept read-only opens. Writes are handled by fanotify auto-lock.
    if !is_write_flags(flags) {
        // SAFETY: caller guarantees `path` is a valid C string.
        if let Ok(cstr) = unsafe { CStr::from_ptr(path) }.to_str() {
            if let Some(git_hash) = query_snapshot_hash(cstr) {
                let fd = redirect_to_snapshot(cstr, &git_hash);
                if fd >= 0 {
                    return fd;
                }
                // Fall through to real open on redirect failure.
            }
        }
    }

    let real_open = ensure_real_open();
    // SAFETY: forwarding to the real libc open with the original arguments.
    // When O_CREAT is set, mode contains the file mode; otherwise it's ignored.
    unsafe { real_open(path, flags, mode) }
}

/// Intercepted `openat()`.
///
/// Same logic as `open()` but with a directory fd prefix. Relative paths are
/// resolved to absolute via `/proc/self/fd/{dirfd}` before the IPC query.
///
/// # Safety
/// This is a C ABI function. `path` must be a valid C string pointer.
///
/// Note: same variadic → fixed-signature trick as `open()` above.
#[no_mangle]
pub unsafe extern "C" fn openat(
    dirfd: c_int,
    path: *const c_char,
    flags: c_int,
    mode: c_int,
) -> c_int {
    if !is_write_flags(flags) {
        // SAFETY: caller guarantees `path` is a valid C string.
        if let Ok(cstr) = unsafe { CStr::from_ptr(path) }.to_str() {
            // For absolute paths, query directly.
            // For relative paths with AT_FDCWD, prepend cwd.
            // For relative paths with other dirfd, resolve via /proc/self/fd.
            let abs_path = if cstr.starts_with('/') {
                cstr.to_string()
            } else if dirfd == libc::AT_FDCWD {
                let cwd = std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                format!("{}/{}", cwd, cstr)
            } else {
                // Resolve dirfd via /proc/self/fd/{dirfd}
                let link = format!("/proc/self/fd/{}", dirfd);
                match std::fs::read_link(&link) {
                    Ok(dir_path) => {
                        format!("{}/{}", dir_path.to_string_lossy(), cstr)
                    }
                    Err(_) => {
                        // Can't resolve — fall through to real openat.
                        let real_openat = ensure_real_openat();
                        return unsafe { real_openat(dirfd, path, flags, mode) };
                    }
                }
            };

            if let Some(git_hash) = query_snapshot_hash(&abs_path) {
                let fd = redirect_to_snapshot(&abs_path, &git_hash);
                if fd >= 0 {
                    return fd;
                }
            }
        }
    }

    let real_openat = ensure_real_openat();
    // SAFETY: forwarding to the real libc openat.
    unsafe { real_openat(dirfd, path, flags, mode) }
}
