use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_DEPTH: u32 = 10;
const MAX_CHILDREN: usize = 200;
const MAX_NODES: usize = 5_000;
const MAX_PREVIEW_BYTES: u64 = 1_048_576;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
];
const SECRET_DIRS: &[&str] = &[".ssh", ".gnupg", ".aws"];
const SECRET_FILE_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".dockercfg",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "application_default_credentials.json",
    "service-account.json",
    "service_account.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];
const SECRET_FILE_EXTENSIONS: &[&str] =
    &["pem", "key", "p8", "p12", "pfx", "jks", "keystore", "kdbx"];
/// A project opened from an empty accidental child folder can safely be
/// repaired only when its direct parent has both a real build manifest and a
/// source-control/layout signal. This deliberately does not guess across
/// multiple ancestors or accept a README alone.
const PROJECT_MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "composer.json",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
];
const PROJECT_LAYOUT_DIRS: &[&str] = &[
    "src", "app", "pages", "public", "lib", "frontend", "backend", "mobile",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub children: Vec<ProjectNode>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    pub nodes: Vec<ProjectNode>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub language: String,
}

pub fn canonical_project_root(path: &Path) -> Result<PathBuf> {
    let root = path
        .canonicalize()
        .with_context(|| format!("Could not open project: {}", path.display()))?;
    if !root.is_dir() {
        bail!("Project path must be a directory.");
    }
    Ok(root)
}

/// Return a stable user-facing Windows path without the internal `\\\\?\\`
/// verbatim prefix emitted by `canonicalize`. The native filesystem APIs still
/// canonicalize paths before using them, so this only improves matching and
/// display across the frontend, sessions, and provider prompts.
pub fn display_project_root(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(plain) = value.strip_prefix(r"\\?\") {
            return plain.to_string();
        }
    }
    value.to_string()
}

fn directory_is_empty(path: &Path) -> Result<bool> {
    let mut entries = std::fs::read_dir(path)
        .with_context(|| format!("Could not inspect project folder: {}", path.display()))?;
    Ok(entries.next().transpose()?.is_none())
}

pub fn looks_like_project_root(path: &Path) -> bool {
    let has_manifest = PROJECT_MANIFESTS
        .iter()
        .any(|name| path.join(name).is_file());
    if !has_manifest {
        return false;
    }
    path.join(".git").is_dir()
        || PROJECT_LAYOUT_DIRS
            .iter()
            .any(|name| path.join(name).is_dir())
}

/// Resolve a folder selected through **Open Project**. When that selection is
/// completely empty and its direct parent is unmistakably a source project,
/// adopt the parent. This fixes a common accidental "one folder too deep"
/// selection without broadening access beyond one verified parent.
///
/// New projects deliberately call `canonical_project_root` directly, so an
/// intentionally blank project is never redirected.
pub fn resolve_open_project_root(path: &Path) -> Result<PathBuf> {
    let selected = canonical_project_root(path)?;
    if !directory_is_empty(&selected)? {
        return Ok(selected);
    }
    let Some(parent) = selected.parent() else {
        return Ok(selected);
    };
    let parent = match parent.canonicalize() {
        Ok(parent) if parent.is_dir() => parent,
        _ => return Ok(selected),
    };
    if looks_like_project_root(&parent) {
        Ok(parent)
    } else {
        Ok(selected)
    }
}

fn validate_relative_path(relative: &str) -> Result<PathBuf> {
    if relative.chars().any(char::is_control) {
        bail!("Project path contains invalid characters.");
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        bail!("Project paths must be relative.");
    }
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let segment = value.to_string_lossy();
                if segment.contains(':') {
                    bail!("Project path contains an invalid segment.");
                }
                safe.push(value);
            }
            Component::CurDir if safe.as_os_str().is_empty() => {}
            _ => bail!("Project path traversal is not allowed."),
        }
    }
    Ok(safe)
}

pub fn resolve_project_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = canonical_project_root(root)?;
    let safe = validate_relative_path(relative)?;
    let target = root.join(safe);
    let metadata = std::fs::symlink_metadata(&target)
        .with_context(|| format!("Project item not found: {relative}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
        let is_directory = metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0;
        if is_directory && metadata.file_type().is_symlink() {
            bail!(
                "Directory junctions and symbolic links are not available in the workspace viewer."
            );
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        bail!("Symbolic links are not available in the workspace viewer.");
    }
    let canonical = target
        .canonicalize()
        .with_context(|| format!("Could not resolve project item: {relative}"))?;
    if !canonical.starts_with(&root) {
        bail!("Project item resolves outside the active project.");
    }
    Ok(canonical)
}

fn skip_workspace_tree_entry(file_type: &std::fs::FileType) -> bool {
    if !file_type.is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        !file_type.is_file()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn relative_display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn list_directory(
    directory: &Path,
    relative: &Path,
    depth: u32,
    max_depth: u32,
    count: &mut usize,
    tree_truncated: &mut bool,
) -> Result<Vec<ProjectNode>> {
    let mut entries = std::fs::read_dir(directory)
        .with_context(|| format!("Could not read project folder: {}", relative.display()))?
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if skip_workspace_tree_entry(&file_type) {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() && IGNORED_DIRS.contains(&name.as_str()) {
                return None;
            }
            Some((entry, file_type, name))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.1.is_dir()
            .cmp(&a.1.is_dir())
            .then_with(|| a.2.to_lowercase().cmp(&b.2.to_lowercase()))
    });
    if entries.len() > MAX_CHILDREN {
        entries.truncate(MAX_CHILDREN);
        *tree_truncated = true;
    }

    let mut nodes = Vec::new();
    for (entry, file_type, name) in entries {
        if *count >= MAX_NODES {
            *tree_truncated = true;
            break;
        }
        *count += 1;
        let child_relative = relative.join(&name);
        let metadata = entry.metadata().ok();
        let mut node = ProjectNode {
            name,
            path: relative_display(&child_relative),
            is_dir: file_type.is_dir(),
            size: if file_type.is_file() {
                metadata.as_ref().map(std::fs::Metadata::len).unwrap_or(0)
            } else {
                0
            },
            modified_ms: metadata.as_ref().map(modified_ms).unwrap_or(0),
            children: Vec::new(),
            truncated: false,
        };
        if file_type.is_dir() {
            if depth < max_depth {
                node.children = list_directory(
                    &entry.path(),
                    &child_relative,
                    depth + 1,
                    max_depth,
                    count,
                    tree_truncated,
                )?;
            } else {
                node.truncated = true;
                *tree_truncated = true;
            }
        }
        nodes.push(node);
    }
    Ok(nodes)
}

pub fn list_project_files(root: &Path, max_depth: u32) -> Result<ProjectTree> {
    let root = canonical_project_root(root)?;
    let mut count = 0;
    let mut truncated = false;
    let nodes = list_directory(
        &root,
        Path::new(""),
        0,
        max_depth.clamp(1, MAX_DEPTH),
        &mut count,
        &mut truncated,
    )?;
    Ok(ProjectTree { nodes, truncated })
}

fn language_for(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("text")
        .to_ascii_lowercase()
}

pub fn read_project_file(root: &Path, relative: &str) -> Result<FilePreview> {
    let path = resolve_project_path(root, relative)?;
    let metadata = path.metadata().context("Could not inspect project file.")?;
    if !metadata.is_file() {
        bail!("Only regular project files can be previewed.");
    }
    let language = language_for(&path);
    if crate::document_inspect::is_spreadsheet_ext(&language)
        || crate::document_inspect::is_presentation_ext(&language)
        || crate::document_inspect::is_word_ext(&language)
        || crate::document_inspect::is_pdf_ext(&language)
    {
        let content = crate::document_inspect::read_inspectable_file(&path, 80_000)
            .context("Could not extract document text.")?;
        return Ok(FilePreview {
            path: relative_display(&validate_relative_path(relative)?),
            content,
            size: metadata.len(),
            language,
        });
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        bail!("File is larger than the 1 MiB preview limit.");
    }
    let bytes = std::fs::read(&path).context("Could not read project file.")?;
    let content = String::from_utf8(bytes)
        .map_err(|_| anyhow!("Binary or non-UTF-8 files cannot be previewed."))?;
    Ok(FilePreview {
        path: relative_display(&validate_relative_path(relative)?),
        content,
        size: metadata.len(),
        language,
    })
}

/// Permanently remove one regular file from the active project.  The caller
/// can only address a path relative to the project root; `resolve_project_path`
/// rejects traversal, absolute paths, symlinks, and paths that resolve outside
/// that root before anything is removed.
pub fn delete_project_file(root: &Path, relative: &str) -> Result<()> {
    let path = resolve_project_path(root, relative)?;
    let metadata = path
        .metadata()
        .context("Could not inspect project file for deletion.")?;
    if !metadata.is_file() {
        bail!("Only regular project files can be deleted from the file list.");
    }
    std::fs::remove_file(&path)
        .with_context(|| format!("Could not delete project file: {relative}"))?;
    Ok(())
}

/// Write a Playwright spec produced from Preview Computer Use. Only
/// `tests/*.spec.ts` or `tests/*.spec.js` inside the active project are allowed.
pub fn write_preview_computer_spec(root: &Path, relative: &str, contents: &str) -> Result<String> {
    if contents.len() > 64 * 1024 {
        bail!("Preview spec is too large.");
    }
    let normalized = relative.replace('\\', "/");
    let slash_count = normalized.chars().filter(|ch| *ch == '/').count();
    if !(normalized.starts_with("tests/")
        && slash_count == 1
        && (normalized.ends_with(".spec.ts") || normalized.ends_with(".spec.js")))
    {
        bail!("Preview specs must be written to tests/*.spec.ts.");
    }
    let root = canonical_project_root(root)?;
    let safe = validate_relative_path(&normalized)?;
    let target = root.join(safe);
    if !target.starts_with(&root) {
        bail!("Preview spec resolves outside the active project.");
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .context("Could not create the tests folder for the Preview spec.")?;
    }
    std::fs::write(&target, contents)
        .with_context(|| format!("Could not write Preview spec: {normalized}"))?;
    Ok(normalized)
}

fn remove_project_entry(path: &Path, file_type: std::fs::FileType) -> Result<()> {
    if file_type.is_symlink() {
        // Do not traverse a link when clearing a project. Removing the link
        // itself is safe even if it points outside the project.
        std::fs::remove_file(path)
            .or_else(|_| std::fs::remove_dir(path))
            .with_context(|| format!("Could not remove project link: {}", path.display()))?;
    } else if file_type.is_dir() {
        std::fs::remove_dir_all(path)
            .with_context(|| format!("Could not remove project folder: {}", path.display()))?;
    } else if file_type.is_file() {
        std::fs::remove_file(path)
            .with_context(|| format!("Could not remove project file: {}", path.display()))?;
    } else {
        bail!("Unsupported project entry: {}", path.display());
    }
    Ok(())
}

/// Clear the active project's contents while retaining the project directory
/// itself and its Git history. This is intentionally rooted in a canonical
/// project directory and refuses to operate on a filesystem root.
pub fn clear_project_files(root: &Path) -> Result<u64> {
    let root = canonical_project_root(root)?;
    if root.parent().is_none() {
        bail!("The filesystem root cannot be cleared as a project.");
    }

    let mut removed = 0_u64;
    for entry in std::fs::read_dir(&root)
        .with_context(|| format!("Could not read project folder: {}", root.display()))?
    {
        let entry = entry.context("Could not inspect project entry.")?;
        let name = entry.file_name();
        // Preserve the repository metadata so a clear can be recovered with
        // Git and never turns into an accidental repository deletion.
        if name.to_string_lossy().eq_ignore_ascii_case(".git") {
            continue;
        }
        remove_project_entry(
            &entry.path(),
            entry.file_type().with_context(|| {
                format!(
                    "Could not inspect project entry: {}",
                    entry.path().display()
                )
            })?,
        )?;
        removed += 1;
    }
    Ok(removed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPackResult {
    pub zip_path: String,
    pub files_count: usize,
    pub handoff_path: String,
}

fn should_skip_pack_entry(path: &Path) -> bool {
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name = name.to_string_lossy().to_ascii_lowercase();
            if IGNORED_DIRS
                .iter()
                .chain(SECRET_DIRS.iter())
                .any(|ignored| name == *ignored)
            {
                return true;
            }
        }
    }
    let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    if name == ".env"
        || (name.starts_with(".env.")
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ))
        || SECRET_FILE_NAMES.contains(&name.as_str())
        || name.ends_with("-credentials.json")
        || name.ends_with("_credentials.json")
    {
        return true;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| SECRET_FILE_EXTENSIONS.contains(&extension.as_str()))
}

/// Zip the project for client handoff and write CLIENT_HANDOFF.md inside the archive.
pub fn export_client_pack(
    root: &Path,
    dest_zip: &Path,
    handoff_summary: Option<&str>,
) -> Result<ClientPackResult> {
    let root = canonical_project_root(root)?;
    if let Some(parent) = dest_zip.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create folder for {}", dest_zip.display()))?;
    }
    let handoff_beside = if let Some(stem) = dest_zip.file_stem() {
        dest_zip
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{}_CLIENT_HANDOFF.md", stem.to_string_lossy()))
    } else {
        dest_zip.with_extension("CLIENT_HANDOFF.md")
    };

    let project_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());

    let summary = handoff_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Project ready for client handoff.");

    let handoff = format!(
        "# Client handoff — {project_name}\n\n\
Prepared with Hormachuelos.\n\n\
## Summary\n\n{summary}\n\n\
## How to open\n\n\
1. Unzip this archive.\n\
2. Open the folder in your editor or browser as needed.\n\
3. If there is a `package.json`, run `npm install` then `npm run dev` / `npm start`.\n\
4. If there is a `README.md`, follow it for stack-specific steps.\n\n\
## Deploy checklist (PH freelancers)\n\n\
- [ ] Test on phone (Chrome / Facebook in-app browser)\n\
- [ ] Replace placeholder contact / GCash / FB links\n\
- [ ] Deploy (Vercel, Netlify, or shared hosting)\n\
- [ ] Send client the live URL + this zip as backup\n\
- [ ] Keep a copy of the OR / receipt for your records\n\n\
## Notes\n\n\
`node_modules`, `.git`, build folders, environment files, credential files, and private-key material were excluded.\n"
    );

    let file = std::fs::File::create(dest_zip)
        .with_context(|| format!("Could not create zip: {}", dest_zip.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("CLIENT_HANDOFF.md", options)?;
    use std::io::Write;
    zip.write_all(handoff.as_bytes())?;
    let destination = dest_zip
        .canonicalize()
        .unwrap_or_else(|_| dest_zip.to_path_buf());
    let handoff_destination = handoff_beside
        .canonicalize()
        .unwrap_or_else(|_| handoff_beside.clone());

    let mut files_count = 1usize;
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = match path.strip_prefix(&root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if canonical_path == destination
            || canonical_path == handoff_destination
            || should_skip_pack_entry(rel)
        {
            continue;
        }
        let name_in_zip = relative_display(rel);
        if entry.file_type().is_dir() {
            let dir_name = if name_in_zip.ends_with('/') {
                name_in_zip
            } else {
                format!("{name_in_zip}/")
            };
            let _ = zip.add_directory(dir_name, options);
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let mut source = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        zip.start_file(&name_in_zip, options)?;
        std::io::copy(&mut source, &mut zip)?;
        files_count += 1;
    }

    zip.finish().context("Could not finish client pack zip.")?;

    // Also leave a copy of the handoff next to the zip for easy reading.
    let _ = std::fs::write(&handoff_beside, &handoff);

    Ok(ClientPackResult {
        zip_path: dest_zip.to_string_lossy().to_string(),
        files_count,
        handoff_path: handoff_beside.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        clear_project_files, delete_project_file, export_client_pack, list_project_files,
        looks_like_project_root, read_project_file, resolve_open_project_root,
        write_preview_computer_spec, ProjectNode,
    };
    use std::path::{Path, PathBuf};

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("ai-forge-workspace-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create test workspace");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn flatten_paths(nodes: &[ProjectNode], output: &mut Vec<String>) {
        for node in nodes {
            output.push(node.path.clone());
            flatten_paths(&node.children, output);
        }
    }

    #[test]
    fn rejects_parent_traversal_and_absolute_paths() {
        let workspace = TestWorkspace::new();
        assert!(read_project_file(workspace.path(), "../outside.txt").is_err());
        assert!(read_project_file(workspace.path(), "C:\\Windows\\win.ini").is_err());
    }

    #[test]
    fn opening_an_empty_child_of_a_real_project_uses_the_parent_root() {
        let workspace = TestWorkspace::new();
        std::fs::write(workspace.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        let empty_child = workspace.path().join("accidentally-selected-folder");
        std::fs::create_dir_all(&empty_child).unwrap();

        let resolved = resolve_open_project_root(&empty_child).expect("resolve project root");
        assert_eq!(resolved, workspace.path().canonicalize().unwrap());
    }

    #[test]
    fn opening_an_intentionally_nonempty_child_never_promotes_to_its_parent() {
        let workspace = TestWorkspace::new();
        std::fs::write(workspace.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        let child = workspace.path().join("new-project");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join(".gitkeep"), "").unwrap();

        let resolved = resolve_open_project_root(&child).expect("resolve project root");
        assert_eq!(resolved, child.canonicalize().unwrap());
    }

    #[test]
    fn empty_child_is_not_promoted_when_parent_is_not_a_verified_project() {
        let workspace = TestWorkspace::new();
        let child = workspace.path().join("empty-project");
        std::fs::create_dir_all(&child).unwrap();

        let resolved = resolve_open_project_root(&child).expect("resolve project root");
        assert_eq!(resolved, child.canonicalize().unwrap());
    }

    #[test]
    fn project_parent_guard_detects_existing_project_roots() {
        let workspace = TestWorkspace::new();
        // A real source project (manifest + layout dir).
        std::fs::write(workspace.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        assert!(looks_like_project_root(workspace.path()));

        // A nested folder inside that project is not itself a project root.
        let nested = workspace.path().join("subfolder");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(!looks_like_project_root(&nested));

        // A plain folder with no manifest/layout signal is not a project root.
        let plain = TestWorkspace::new();
        assert!(!looks_like_project_root(plain.path()));
    }

    #[test]
    fn lists_relative_paths_and_ignores_dependency_folders() {
        let workspace = TestWorkspace::new();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::create_dir_all(workspace.path().join("node_modules/pkg")).unwrap();
        std::fs::write(workspace.path().join("src/main.ts"), "export {};").unwrap();
        std::fs::write(workspace.path().join("node_modules/pkg/index.js"), "hidden").unwrap();

        let tree = list_project_files(workspace.path(), 8).expect("list project");
        let mut paths = Vec::new();
        flatten_paths(&tree.nodes, &mut paths);

        assert!(paths.contains(&"src/main.ts".to_string()));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
    }

    #[test]
    fn rejects_binary_and_oversized_file_previews() {
        let workspace = TestWorkspace::new();
        std::fs::write(workspace.path().join("binary.bin"), [0xff, 0xfe, 0xfd]).unwrap();
        std::fs::write(workspace.path().join("large.txt"), vec![b'a'; 1_048_577]).unwrap();

        assert!(read_project_file(workspace.path(), "binary.bin").is_err());
        assert!(read_project_file(workspace.path(), "large.txt").is_err());
    }

    #[test]
    fn lists_and_previews_office_spreadsheets() {
        let workspace = TestWorkspace::new();
        let (bytes, _) =
            crate::document_inspect::xlsx_from_tabular_text("Role,Count\nPayroll,12").unwrap();
        std::fs::write(workspace.path().join("payroll.xlsx"), bytes).unwrap();
        std::fs::write(workspace.path().join("legacy.xls"), b"fake-xls").unwrap();

        let tree = list_project_files(workspace.path(), 8).expect("list project");
        let mut paths = Vec::new();
        flatten_paths(&tree.nodes, &mut paths);
        assert!(paths.contains(&"payroll.xlsx".to_string()));
        assert!(paths.contains(&"legacy.xls".to_string()));

        let preview = read_project_file(workspace.path(), "payroll.xlsx").expect("preview xlsx");
        assert!(preview.content.contains("Payroll"), "{}", preview.content);
    }

    #[test]
    fn deletes_a_regular_project_file_without_escaping_the_project() {
        let workspace = TestWorkspace::new();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        let file = workspace.path().join("src/main.ts");
        std::fs::write(&file, "export {};").unwrap();

        delete_project_file(workspace.path(), "src/main.ts").expect("delete project file");

        assert!(!file.exists());
        assert!(delete_project_file(workspace.path(), "../outside.txt").is_err());
        assert!(delete_project_file(workspace.path(), "src").is_err());
    }

    #[test]
    fn writes_preview_specs_only_into_the_tests_folder() {
        let workspace = TestWorkspace::new();
        let written = write_preview_computer_spec(
            workspace.path(),
            "tests/horma-preview.spec.ts",
            "import { test } from '@playwright/test';\ntest('ok', async () => {});",
        )
        .expect("write preview spec");
        assert_eq!(written, "tests/horma-preview.spec.ts");
        assert!(workspace
            .path()
            .join("tests/horma-preview.spec.ts")
            .is_file());
        assert!(write_preview_computer_spec(workspace.path(), "src/evil.spec.ts", "nope").is_err());
        assert!(
            write_preview_computer_spec(workspace.path(), "tests/../secret.spec.ts", "nope")
                .is_err()
        );
        assert!(write_preview_computer_spec(
            workspace.path(),
            "tests/horma-preview.spec.ts",
            &"a".repeat(64 * 1024 + 1)
        )
        .is_err());
    }

    #[test]
    fn clears_project_contents_but_keeps_the_root_and_git_metadata() {
        let workspace = TestWorkspace::new();
        std::fs::create_dir_all(workspace.path().join(".git")).unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::create_dir_all(workspace.path().join("node_modules/pkg")).unwrap();
        std::fs::write(workspace.path().join(".git/config"), "[core]").unwrap();
        std::fs::write(workspace.path().join("src/main.ts"), "export {};").unwrap();
        std::fs::write(
            workspace.path().join("node_modules/pkg/index.js"),
            "module.exports = {};",
        )
        .unwrap();
        std::fs::write(workspace.path().join("README.md"), "Project").unwrap();

        let removed = clear_project_files(workspace.path()).expect("clear project files");

        assert_eq!(removed, 3);
        assert!(workspace.path().is_dir());
        assert!(workspace.path().join(".git/config").is_file());
        assert!(!workspace.path().join("src").exists());
        assert!(!workspace.path().join("node_modules").exists());
        assert!(!workspace.path().join("README.md").exists());
    }

    #[test]
    fn client_pack_excludes_credentials_key_material_and_its_own_outputs() {
        let workspace = TestWorkspace::new();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::create_dir_all(workspace.path().join(".ssh")).unwrap();
        std::fs::write(workspace.path().join("src/main.txt"), "safe").unwrap();
        std::fs::write(workspace.path().join(".env"), "TOKEN=secret").unwrap();
        std::fs::write(workspace.path().join(".env.local"), "TOKEN=secret").unwrap();
        std::fs::write(workspace.path().join(".env.example"), "TOKEN=").unwrap();
        std::fs::write(
            workspace.path().join(".npmrc"),
            "//registry/:_authToken=secret",
        )
        .unwrap();
        std::fs::write(workspace.path().join("server.key"), "private-key").unwrap();
        std::fs::write(workspace.path().join(".ssh/id_rsa"), "private-key").unwrap();
        let destination = workspace.path().join("client-pack.zip");
        let companion = workspace.path().join("client-pack_CLIENT_HANDOFF.md");
        std::fs::write(&companion, "old handoff").unwrap();

        export_client_pack(workspace.path(), &destination, Some("test pack")).unwrap();

        let file = std::fs::File::open(&destination).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names = Vec::new();
        for index in 0..archive.len() {
            names.push(archive.by_index(index).unwrap().name().to_string());
        }
        assert!(names.contains(&"CLIENT_HANDOFF.md".to_string()));
        assert!(names.contains(&"src/main.txt".to_string()));
        assert!(names.contains(&".env.example".to_string()));
        for excluded in [
            ".env",
            ".env.local",
            ".npmrc",
            "server.key",
            ".ssh/id_rsa",
            "client-pack.zip",
            "client-pack_CLIENT_HANDOFF.md",
        ] {
            assert!(!names.contains(&excluded.to_string()), "packed {excluded}");
        }
    }
}
