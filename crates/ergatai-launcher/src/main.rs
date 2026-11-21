use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::thread;
use std::time::Duration;

fn base_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn server_path(base: &Path) -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ergatai-server.exe"
    } else {
        "ergatai-server"
    };
    base.join("bin").join(name)
}

fn app_path(base: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        // Prefer the bundled .app
        let entries = std::fs::read_dir(base.join("app")).ok();
        if let Some(entries) = entries {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("app") {
                    return p;
                }
            }
        }
        base.join("app").join("Ergatai.app")
    }
    #[cfg(target_os = "linux")]
    {
        base.join("app").join("ergatai")
    }
    #[cfg(target_os = "windows")]
    {
        base.join("app").join("ergatai.exe")
    }
}

fn wait_for_server() -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    for _ in 0..60 {
        if client.get("http://127.0.0.1:3000/health").send().is_ok() {
            return true;
        }
        thread::sleep(Duration::from_secs(1));
    }
    false
}

fn main() {
    let base = base_dir();
    let server = server_path(&base);
    if !server.exists() {
        eprintln!("Backend not found: {}", server.display());
        std::process::exit(1);
    }

    println!("Starting Ergatai backend...");
    let mut server_child: Option<Child> = match Command::new(&server)
        .arg("--port")
        .arg("3000")
        .spawn()
    {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("Failed to start backend: {e}");
            std::process::exit(1);
        }
    };

    if !wait_for_server() {
        eprintln!("Backend did not become healthy in time.");
        if let Some(c) = server_child.as_mut() {
            let _ = c.kill();
        }
        std::process::exit(1);
    }

    println!("Starting Ergatai desktop...");
    let app = app_path(&base);
    #[cfg(target_os = "macos")]
    let mut app_child = Command::new("open").arg(&app).spawn().ok();
    #[cfg(not(target_os = "macos"))]
    let mut app_child = Command::new(&app).spawn().ok();

    // Wait for the app to exit, then stop the server.
    if let Some(child) = app_child.as_mut() {
        let _ = child.wait();
    }

    if let Some(c) = server_child.as_mut() {
        let _ = c.kill();
        let _ = c.wait();
    }
}