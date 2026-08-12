// Always hide the OS console for the GUI app on Windows.
// Agent PowerShell tools still run headless and stream into the in-app Console.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    ai_forge_lib::run()
}
