// Embeds the application manifest and, when WEBVIEW_SHELL_ICON names one, the
// program's icon as icon resource 1 (the window loads it from its own module).
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=WEBVIEW_SHELL_ICON");
    let quote = |path: &str| format!("\"{}\"", path.replace('\\', "\\\\"));
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("app.manifest");
    let mut script = format!("1 24 {}\n", quote(manifest.to_str().unwrap()));
    if let Some(icon) = env::var("WEBVIEW_SHELL_ICON").ok().filter(|icon| !icon.is_empty()) {
        println!("cargo:rerun-if-changed={icon}");
        script += &format!("1 ICON {}\n", quote(&icon));
    }
    let resources = PathBuf::from(env::var("OUT_DIR").unwrap()).join("shell.rc");
    fs::write(&resources, script).unwrap();
    embed_resource::compile(&resources, embed_resource::NONE).manifest_required().unwrap();
}
