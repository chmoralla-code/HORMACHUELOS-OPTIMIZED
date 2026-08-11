use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_VERSION: u32 = 1;
const MAX_FINGERPRINT_ENTRIES: usize = 600;
const MAX_TREE_LINES: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectIntelligence {
    version: u32,
    project_root: String,
    fingerprint: String,
    generated_at_ms: u64,
    context: String,
    last_successful_command: Option<String>,
}

static MEMORY_CACHE: OnceLock<Mutex<HashMap<String, StoredProjectIntelligence>>> = OnceLock::new();

fn memory_cache() -> &'static Mutex<HashMap<String, StoredProjectIntelligence>> {
    MEMORY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hash_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn project_key(root: &Path) -> String {
    hash_text(&crate::workspace::display_project_root(root).to_ascii_lowercase())
}

fn cache_path(root: &Path) -> Option<PathBuf> {
    let dirs = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")?;
    let dir = dirs.cache_dir().join("project-intelligence");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{}.json", project_key(root))))
}

fn ignored_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".hormachuelos"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".gradle"
            | ".idea"
            | ".cache"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | "vendor"
    )
}

fn project_fingerprint(root: &Path) -> String {
    let mut rows = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_str().is_some_and(ignored_directory)
        });
    for entry in walker.flatten().take(MAX_FINGERPRINT_ENTRIES) {
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or_default();
        rows.push(format!(
            "{}|{}|{}|{}",
            relative.to_string_lossy().replace('\\', "/"),
            metadata.is_dir(),
            metadata.len(),
            modified
        ));
    }
    rows.sort();

    // Key manifests are small and architecturally important. Hashing their
    // contents avoids stale cache hits on filesystems with coarse mtimes.
    for name in [
        "package.json",
        "Cargo.toml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "pubspec.yaml",
        "vite.config.ts",
        "next.config.js",
        "next.config.mjs",
    ] {
        let path = root.join(name);
        if let Ok(bytes) = std::fs::read(&path) {
            if bytes.len() <= 256 * 1024 {
                rows.push(format!("manifest:{name}:{:x}", Sha256::digest(&bytes)));
            }
        }
    }
    hash_text(&rows.join("\n"))
}

fn detected_stack(root: &Path) -> Vec<&'static str> {
    let mut stack = Vec::new();
    if root.join("package.json").is_file() {
        stack.push("Node.js / web");
    }
    if root.join("vite.config.ts").is_file()
        || root.join("vite.config.js").is_file()
        || root.join("vite.config.mjs").is_file()
    {
        stack.push("Vite");
    }
    if root.join("next.config.js").is_file()
        || root.join("next.config.mjs").is_file()
        || root.join("next.config.ts").is_file()
    {
        stack.push("Next.js");
    }
    if root.join("Cargo.toml").is_file() {
        stack.push("Rust / Cargo");
    }
    if root.join("src-tauri").join("tauri.conf.json").is_file()
        || root.join("src-tauri").join("tauri.conf.json5").is_file()
    {
        stack.push("Tauri");
    }
    if root.join("build.gradle").is_file()
        || root.join("build.gradle.kts").is_file()
        || root.join("settings.gradle").is_file()
        || root.join("settings.gradle.kts").is_file()
    {
        stack.push("Android / Gradle");
    }
    if root.join("pubspec.yaml").is_file() {
        stack.push("Flutter / Dart");
    }
    stack
}

fn package_context(root: &Path) -> String {
    let Ok(raw) = std::fs::read_to_string(root.join("package.json")) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return String::new();
    };
    let mut out = String::new();
    if let Some(scripts) = value.get("scripts").and_then(|value| value.as_object()) {
        let mut entries = scripts
            .iter()
            .filter_map(|(name, command)| command.as_str().map(|command| (name, command)))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(name, _)| *name);
        if !entries.is_empty() {
            out.push_str("Detected npm scripts:\n");
            for (name, command) in entries.into_iter().take(18) {
                out.push_str(&format!("- {name}: {command}\n"));
            }
        }
    }

    let mut packages = Vec::new();
    for field in ["dependencies", "devDependencies"] {
        if let Some(values) = value.get(field).and_then(|value| value.as_object()) {
            packages.extend(values.keys().cloned());
        }
    }
    packages.sort();
    packages.dedup();
    if !packages.is_empty() {
        out.push_str(&format!(
            "Key packages: {}\n",
            packages.into_iter().take(32).collect::<Vec<_>>().join(", ")
        ));
    }
    out
}

fn build_context(root: &Path, last_successful_command: Option<&str>) -> String {
    let mut out = String::from("=== PROJECT INTELLIGENCE (cached) ===\n");
    out.push_str(&format!(
        "Root: {}\n",
        crate::workspace::display_project_root(root)
    ));
    let stack = detected_stack(root);
    if !stack.is_empty() {
        out.push_str(&format!("Detected stack: {}\n", stack.join(", ")));
    }
    if let Some(command) = last_successful_command.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("Last successful check/build command: {command}\n"));
    }

    let package = package_context(root);
    if !package.is_empty() {
        out.push_str(&package);
    }

    match crate::workspace::list_project_files(root, 3) {
        Ok(tree) => {
            fn walk(
                nodes: &[crate::workspace::ProjectNode],
                depth: usize,
                lines: &mut Vec<String>,
            ) {
                for node in nodes {
                    if lines.len() >= MAX_TREE_LINES {
                        break;
                    }
                    let mark = if node.is_dir { "/" } else { "" };
                    lines.push(format!("{}{}{mark}", "  ".repeat(depth), node.name));
                    if node.is_dir && !node.children.is_empty() {
                        walk(&node.children, depth + 1, lines);
                    }
                }
            }
            let mut lines = Vec::new();
            walk(&tree.nodes, 0, &mut lines);
            if !lines.is_empty() {
                out.push_str("Project map (depth <= 3):\n");
                out.push_str(&lines.join("\n"));
                out.push('\n');
            }
            if tree.truncated || lines.len() >= MAX_TREE_LINES {
                out.push_str("(project map truncated; retrieve exact files with search tools)\n");
            }
        }
        Err(error) => out.push_str(&format!("Project map unavailable: {error}\n")),
    }

    for name in ["README.md", "readme.md", "README.txt", "README"] {
        if let Ok(preview) = crate::workspace::read_project_file(root, name) {
            let mut end = preview.content.len().min(2_500);
            while !preview.content.is_char_boundary(end) {
                end = end.saturating_sub(1);
            }
            out.push_str(&format!("\n--- {name} ---\n{}", &preview.content[..end]));
            if end < preview.content.len() {
                out.push_str("\n...(truncated)");
            }
            out.push('\n');
            break;
        }
    }
    out.push_str("=== END PROJECT INTELLIGENCE ===\n\n");
    out
}

fn load_disk(root: &Path) -> Option<StoredProjectIntelligence> {
    let raw = std::fs::read_to_string(cache_path(root)?).ok()?;
    let stored = serde_json::from_str::<StoredProjectIntelligence>(&raw).ok()?;
    (stored.version == CACHE_VERSION).then_some(stored)
}

fn persist(root: &Path, stored: &StoredProjectIntelligence) {
    let Some(path) = cache_path(root) else {
        return;
    };
    let Ok(raw) = serde_json::to_vec_pretty(stored) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, raw).is_ok() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::rename(temporary, path);
    }
}

fn load_or_build(root: &Path) -> StoredProjectIntelligence {
    let key = project_key(root);
    let fingerprint = project_fingerprint(root);
    if let Some(cached) = memory_cache().lock().unwrap().get(&key).cloned() {
        if cached.fingerprint == fingerprint {
            return cached;
        }
    }
    let disk = load_disk(root);
    if let Some(cached) = disk.as_ref() {
        if cached.fingerprint == fingerprint {
            memory_cache().lock().unwrap().insert(key, cached.clone());
            return cached.clone();
        }
    }
    let last_successful_command = disk.and_then(|value| value.last_successful_command);
    let stored = StoredProjectIntelligence {
        version: CACHE_VERSION,
        project_root: crate::workspace::display_project_root(root),
        fingerprint,
        generated_at_ms: now_ms(),
        context: build_context(root, last_successful_command.as_deref()),
        last_successful_command,
    };
    persist(root, &stored);
    memory_cache().lock().unwrap().insert(key, stored.clone());
    stored
}

pub fn context_block(root: &Path, max_bytes: usize) -> String {
    let stored = load_or_build(root);
    if stored.context.len() <= max_bytes {
        return stored.context;
    }
    let notice = "\n...(cached project intelligence truncated for this execution profile)\n";
    let mut end = max_bytes
        .saturating_sub(notice.len())
        .min(stored.context.len());
    while !stored.context.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}{}", &stored.context[..end], notice)
}

pub fn invalidate(root: &Path) {
    memory_cache().lock().unwrap().remove(&project_key(root));
}

pub fn record_successful_command(root: &Path, command: &str) {
    let normalized = command.trim();
    let lower = normalized.to_ascii_lowercase();
    if normalized.is_empty()
        || ![
            " test",
            "test ",
            " build",
            "build ",
            " check",
            "check ",
            " lint",
            "lint ",
            "clippy",
            "assembledebug",
            "gradlew",
            "tsc",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return;
    }
    let clipped = normalized.chars().take(500).collect::<String>();
    let key = project_key(root);
    let mut stored = memory_cache()
        .lock()
        .unwrap()
        .get(&key)
        .cloned()
        .or_else(|| load_disk(root))
        .unwrap_or_else(|| StoredProjectIntelligence {
            version: CACHE_VERSION,
            project_root: crate::workspace::display_project_root(root),
            // Force the next context request to build a fresh map while still
            // carrying this successful recipe across process restarts.
            fingerprint: String::new(),
            generated_at_ms: now_ms(),
            context: String::new(),
            last_successful_command: None,
        });
    stored.last_successful_command = Some(clipped.clone());
    stored.fingerprint.clear();
    stored.context.clear();
    persist(root, &stored);
    memory_cache().lock().unwrap().insert(key, stored);
}

#[cfg(test)]
mod tests {
    use super::{context_block, invalidate, project_fingerprint};
    use std::path::PathBuf;

    struct TempProject(PathBuf);

    impl TempProject {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ai-forge-project-intelligence-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(root.join("src")).unwrap();
            Self(root)
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cached_context_detects_stack_and_scripts() {
        let project = TempProject::new();
        std::fs::write(
            project.0.join("package.json"),
            r#"{"scripts":{"check":"tsc --noEmit"},"dependencies":{"vite":"1"}}"#,
        )
        .unwrap();
        std::fs::write(project.0.join("src/main.ts"), "export {};").unwrap();
        let context = context_block(&project.0, 20_000);
        assert!(context.contains("Node.js / web"));
        assert!(context.contains("check: tsc --noEmit"));
        assert!(context.contains("src/"));
    }

    #[test]
    fn fingerprint_changes_after_a_source_edit() {
        let project = TempProject::new();
        let source = project.0.join("src/main.ts");
        std::fs::write(&source, "a").unwrap();
        let before = project_fingerprint(&project.0);
        std::fs::write(&source, "a longer value").unwrap();
        let after = project_fingerprint(&project.0);
        assert_ne!(before, after);
        invalidate(&project.0);
    }
}
