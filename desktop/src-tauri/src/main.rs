// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_builds), windows_subsystem = "windows")]

fn main() {
    ergatai_desktop::run()
}
