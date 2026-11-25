//! Build script: pre-download nats-server into the crate's bundled resources
//! so development builds and `cargo run` work without a system-installed
//! nats-server.
//!
//! The download is best-effort: if the network is unavailable or the platform
//! is unsupported, the build still succeeds and the runtime falls back to
//! `PATH` / `ERGATAI_NATS_BINARY`.
//!
//! Set `ERGATAI_SKIP_NATS_DOWNLOAD=1` to disable.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const NATS_VERSION: &str = "2.10.27";

fn main() {
    if env::var("ERGATAI_SKIP_NATS_DOWNLOAD").is_ok() {
        return;
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    // Map to (release-os, release-arch, platform_dir_name used by finder).
    let (rel_os, rel_arch, platform_dir) = match (target_os.as_str(), target_arch.as_str()) {
        ("linux", "x86_64") => ("linux", "amd64", "linux-x86_64"),
        ("linux", "aarch64") => ("linux", "arm64", "linux-arm64"),
        ("macos", "x86_64") => ("darwin", "amd64", "darwin-x86_64"),
        ("macos", "aarch64") => ("darwin", "arm64", "darwin-arm64"),
        ("windows", "x86_64") => ("windows", "amd64", "win32-x86_64"),
        _ => {
            println!(
                "cargo:warning=ergatai-binary: unsupported target for nats pre-download ({}/{})",
                target_os, target_arch
            );
            return;
        }
    };

    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => return,
    };

    // Matches `resource_subdir_pattern = "nats-server-{platform}"` with the
    // arch-specific platform name produced by finder::platform_arch_dir_name().
    let resource_dir = manifest_dir
        .join("resources")
        .join(format!("nats-server-{}", platform_dir));
    let binary_name = if target_os == "windows" {
        "nats-server.exe"
    } else {
        "nats-server"
    };
    let binary_path = resource_dir.join(binary_name);

    if binary_path.exists() {
        // Already present (checked in / committed / previously downloaded).
        return;
    }

    // Windows ships a .zip; Unix ships a .tar.gz.
    let (ext, download_name) = if target_os == "windows" {
        (
            "zip",
            format!("nats-server-v{}-{}-{}.zip", NATS_VERSION, rel_os, rel_arch),
        )
    } else {
        (
            "tar.gz",
            format!(
                "nats-server-v{}-{}-{}.tar.gz",
                NATS_VERSION, rel_os, rel_arch
            ),
        )
    };

    let url = format!(
        "https://github.com/nats-io/nats-server/releases/download/v{}/{}",
        NATS_VERSION, download_name
    );

    if let Err(e) = download_and_extract(&url, ext, &resource_dir, binary_name) {
        println!("cargo:warning=ergatai-binary: failed to pre-download nats-server ({}); runtime will fall back to PATH / ERGATAI_NATS_BINARY", e);
        // Clean up partial directory.
        let _ = fs::remove_dir_all(&resource_dir);
    } else {
        println!(
            "cargo:warning=ergatai-binary: pre-downloaded nats-server v{} into {}",
            NATS_VERSION,
            resource_dir.display()
        );
    }
}

fn download_and_extract(
    url: &str,
    ext: &str,
    resource_dir: &Path,
    binary_name: &str,
) -> Result<(), String> {
    fs::create_dir_all(resource_dir).map_err(|e| e.to_string())?;

    let tmp_base = std::env::temp_dir().join("ergatai-nats-download");
    let _ = fs::remove_dir_all(&tmp_base);
    fs::create_dir_all(&tmp_base).map_err(|e| e.to_string())?;

    let archive_path = tmp_base.join(if ext == "zip" {
        "nats-server.zip"
    } else {
        "nats-server.tar.gz"
    });

    // Download with curl (available on Linux/macOS/Windows via Git Bash).
    let status = Command::new("curl")
        .args(["-sSL", "-o", archive_path.to_str().unwrap(), url])
        .status()
        .map_err(|e| format!("curl: {}", e))?;
    if !status.success() {
        return Err(format!("curl exited with {}", status));
    }

    let extract_dir = tmp_base.join("extracted");
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    if ext == "zip" {
        let status = Command::new("unzip")
            .args([
                "-q",
                archive_path.to_str().unwrap(),
                "-d",
                extract_dir.to_str().unwrap(),
            ])
            .status()
            .map_err(|e| format!("unzip: {}", e))?;
        if !status.success() {
            return Err(format!("unzip exited with {}", status));
        }
    } else {
        let status = Command::new("tar")
            .args([
                "-xzf",
                archive_path.to_str().unwrap(),
                "-C",
                extract_dir.to_str().unwrap(),
            ])
            .status()
            .map_err(|e| format!("tar: {}", e))?;
        if !status.success() {
            return Err(format!("tar exited with {}", status));
        }
    }

    // Find the nats-server binary inside the extracted tree.
    let mut found: Option<PathBuf> = None;
    for entry in walk_files(&extract_dir) {
        if entry.file_name().and_then(|n| n.to_str()) == Some(binary_name) {
            found = Some(entry);
            break;
        }
    }
    let src = found.ok_or_else(|| "nats-server binary not found in archive".to_string())?;

    let dst = resource_dir.join(binary_name);
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;

    // Ensure executable bit on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dst).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dst, perms).map_err(|e| e.to_string())?;
    }

    // Cleanup.
    let _ = fs::remove_dir_all(&tmp_base);
    Ok(())
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk_files(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}
