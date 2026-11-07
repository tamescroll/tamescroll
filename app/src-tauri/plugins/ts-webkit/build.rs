// Commands are called from Rust (run_mobile_plugin), never from page JS,
// so the plugin exposes no JS commands and needs no permissions.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
