use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MANIFEST_VERSION: u32 = 1;
const MAX_DIRECT_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PROJECT_SNAPSHOT_BYTES: u64 = 160 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES: usize = 24_000;
const MAX_CHECKPOINTS_PER_PROJECT: usize = 24;
const MAX_ACTION_SUMMARIES_PER_CHECKPOINT: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointActionSummary {
    pub id: u64,
    pub tool: String,
    pub status: String,
    pub tool_ok: Option<bool>,
    pub targets: Vec<String>,
    pub project_wide: bool,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSummary {
    pub id: String,
    pub session_id: String,
    pub project_root: String,
    pub profile: String,
    pub status: String,
    pub action_count: usize,
    pub protected_paths: usize,
    pub conflict_count: usize,
    pub command_side_effects_unprotected: bool,
    pub unprotected_actions: usize,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub actions: Vec<CheckpointActionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub checkpoint_id: String,
    pub rolled_back_actions: usize,
    pub restored_paths: usize,
    pub conflicts: Vec<String>,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub struct MutationTicket(u64);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    path: String,
    blob: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotState {
    kind: String,
    fingerprint: String,
    directories: Vec<String>,
    files: Vec<SnapshotFile>,
}

impl SnapshotState {
    fn missing() -> Self {
        let mut state = Self {
            kind: "missing".into(),
            fingerprint: String::new(),
            directories: Vec::new(),
            files: Vec::new(),
        };
        state.fingerprint = state.calculate_fingerprint();
        state
    }

    fn calculate_fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.kind.as_bytes());
        hasher.update([0]);
        for directory in &self.directories {
            hasher.update(b"d:");
            hasher.update(directory.as_bytes());
            hasher.update([0]);
        }
        for file in &self.files {
            hasher.update(b"f:");
            hasher.update(file.path.as_bytes());
            hasher.update([0]);
            hasher.update(file.blob.as_bytes());
            hasher.update([0]);
            hasher.update(file.size.to_le_bytes());
        }
        format!("{:x}", hasher.finalize())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotScope {
    target: String,
    project_scope: bool,
    before: SnapshotState,
    after: Option<SnapshotState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointAction {
    id: u64,
    tool: String,
    status: String,
    tool_ok: Option<bool>,
    created_at_ms: u64,
    scopes: Vec<SnapshotScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointManifest {
    version: u32,
    id: String,
    session_id: String,
    project_root: String,
    profile: String,
    status: String,
    created_at_ms: u64,
    finished_at_ms: Option<u64>,
    next_action_id: u64,
    command_side_effects_unprotected: bool,
    unprotected_action_count: usize,
    actions: Vec<CheckpointAction>,
}

pub struct RunCheckpoint {
    directory: PathBuf,
    project_root: PathBuf,
    manifest: Mutex<CheckpointManifest>,
}

#[derive(Clone)]
pub struct CheckpointStore {
    base_directory: PathBuf,
    checkpoints: Arc<Mutex<HashMap<String, Arc<RunCheckpoint>>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn checkpoint_base_directory() -> PathBuf {
    directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .map(|dirs| dirs.data_local_dir().join("run-checkpoints"))
        .unwrap_or_else(|| std::env::temp_dir().join("ai-forge-run-checkpoints"))
}

impl Default for CheckpointStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CheckpointStore {
    pub fn new() -> Self {
        Self::at(checkpoint_base_directory())
    }

    fn at(base_directory: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&base_directory);
        let mut checkpoints = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&base_directory) {
            for entry in entries.flatten() {
                let directory = entry.path();
                if !directory.is_dir() {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(directory.join("manifest.json")) else {
                    continue;
                };
                let Ok(mut manifest) = serde_json::from_str::<CheckpointManifest>(&raw) else {
                    continue;
                };
                if manifest.version != MANIFEST_VERSION {
                    continue;
                }
                if manifest.status == "active" {
                    manifest.status = "interrupted".into();
                    manifest.finished_at_ms = Some(now_ms());
                    for action in &mut manifest.actions {
                        if action.status == "pending" {
                            action.status = "uncertain".into();
                        }
                    }
                    let _ = persist_manifest_to(&directory, &manifest);
                }
                let project_root = PathBuf::from(&manifest.project_root);
                if !project_root.is_dir() {
                    continue;
                }
                let checkpoint = Arc::new(RunCheckpoint {
                    directory,
                    project_root,
                    manifest: Mutex::new(manifest.clone()),
                });
                checkpoints.insert(manifest.id, checkpoint);
            }
        }
        Self {
            base_directory,
            checkpoints: Arc::new(Mutex::new(checkpoints)),
        }
    }

    pub fn begin_run(
        &self,
        session_id: &str,
        project_root: &Path,
        profile: &str,
    ) -> Result<Arc<RunCheckpoint>, String> {
        let project_root = project_root
            .canonicalize()
            .map_err(|error| format!("Could not checkpoint the project root: {error}"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let directory = self.base_directory.join(&id);
        std::fs::create_dir_all(directory.join("blobs"))
            .map_err(|error| format!("Could not create the rollback checkpoint: {error}"))?;
        let manifest = CheckpointManifest {
            version: MANIFEST_VERSION,
            id: id.clone(),
            session_id: session_id.to_string(),
            project_root: crate::workspace::display_project_root(&project_root),
            profile: profile.to_string(),
            status: "active".into(),
            created_at_ms: now_ms(),
            finished_at_ms: None,
            next_action_id: 1,
            command_side_effects_unprotected: false,
            unprotected_action_count: 0,
            actions: Vec::new(),
        };
        persist_manifest_to(&directory, &manifest).map_err(|error| error.to_string())?;
        let checkpoint = Arc::new(RunCheckpoint {
            directory,
            project_root,
            manifest: Mutex::new(manifest),
        });
        self.checkpoints
            .lock()
            .unwrap()
            .insert(id, checkpoint.clone());
        self.prune_finished();
        Ok(checkpoint)
    }

    pub fn list(&self, project_root: Option<&str>) -> Vec<CheckpointSummary> {
        let filter = project_root.map(normalized_project_key);
        let mut summaries =
            self.checkpoints
                .lock()
                .unwrap()
                .values()
                .filter_map(|checkpoint| {
                    let summary = checkpoint.summary();
                    if filter.as_ref().is_some_and(|filter| {
                        normalized_project_key(&summary.project_root) != *filter
                    }) {
                        None
                    } else {
                        Some(summary)
                    }
                })
                .collect::<Vec<_>>();
        summaries.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        summaries
    }

    pub fn get(&self, id: &str) -> Option<Arc<RunCheckpoint>> {
        self.checkpoints.lock().unwrap().get(id).cloned()
    }

    fn prune_finished(&self) {
        let mut grouped: HashMap<String, Vec<(String, u64)>> = HashMap::new();
        for checkpoint in self.checkpoints.lock().unwrap().values() {
            let summary = checkpoint.summary();
            if summary.status != "active" {
                grouped
                    .entry(normalized_project_key(&summary.project_root))
                    .or_default()
                    .push((summary.id, summary.created_at_ms));
            }
        }
        let mut remove = Vec::new();
        for checkpoints in grouped.values_mut() {
            checkpoints.sort_by(|left, right| right.1.cmp(&left.1));
            remove.extend(
                checkpoints
                    .iter()
                    .skip(MAX_CHECKPOINTS_PER_PROJECT)
                    .map(|(id, _)| id.clone()),
            );
        }
        if remove.is_empty() {
            return;
        }
        let mut registry = self.checkpoints.lock().unwrap();
        for id in remove {
            if let Some(checkpoint) = registry.remove(&id) {
                let _ = std::fs::remove_dir_all(&checkpoint.directory);
            }
        }
    }
}

impl RunCheckpoint {
    pub fn id(&self) -> String {
        self.manifest.lock().unwrap().id.clone()
    }

    pub fn mark_finished(&self, outcome: &str) {
        let mut manifest = self.manifest.lock().unwrap();
        if manifest.status == "active" {
            manifest.status = match outcome {
                "cancelled" => "cancelled",
                "error" => "failed",
                _ => "finished",
            }
            .into();
            manifest.finished_at_ms = Some(now_ms());
            let _ = persist_manifest_to(&self.directory, &manifest);
        }
    }

    pub fn summary(&self) -> CheckpointSummary {
        let manifest = self.manifest.lock().unwrap();
        let changed_actions = manifest
            .actions
            .iter()
            .filter(|action| {
                matches!(
                    action.status.as_str(),
                    "recorded" | "rolled_back" | "conflict" | "uncertain"
                )
            })
            .collect::<Vec<_>>();
        let protected_paths = changed_actions
            .iter()
            .flat_map(|action| action.scopes.iter().map(|scope| scope.target.clone()))
            .collect::<HashSet<_>>()
            .len();
        // The UI receives a bounded, display-safe action ledger. Never expose
        // tool arguments, file contents, shell commands, or snapshot blobs.
        let action_start = manifest
            .actions
            .len()
            .saturating_sub(MAX_ACTION_SUMMARIES_PER_CHECKPOINT);
        let actions = manifest.actions[action_start..]
            .iter()
            .map(|action| CheckpointActionSummary {
                id: action.id,
                tool: action.tool.clone(),
                status: action.status.clone(),
                tool_ok: action.tool_ok,
                targets: action
                    .scopes
                    .iter()
                    .map(|scope| scope.target.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
                project_wide: action.scopes.iter().any(|scope| scope.project_scope),
                created_at_ms: action.created_at_ms,
            })
            .collect();
        CheckpointSummary {
            id: manifest.id.clone(),
            session_id: manifest.session_id.clone(),
            project_root: manifest.project_root.clone(),
            profile: manifest.profile.clone(),
            status: manifest.status.clone(),
            action_count: changed_actions.len(),
            protected_paths,
            conflict_count: manifest
                .actions
                .iter()
                .filter(|action| matches!(action.status.as_str(), "conflict" | "uncertain"))
                .count(),
            command_side_effects_unprotected: manifest.command_side_effects_unprotected,
            unprotected_actions: manifest.unprotected_action_count,
            created_at_ms: manifest.created_at_ms,
            finished_at_ms: manifest.finished_at_ms,
            actions,
        }
    }

    pub fn prepare_tool_action(
        &self,
        tool: &str,
        args: &Value,
        protect_command_changes: bool,
    ) -> Result<Option<MutationTicket>> {
        let tool = tool.trim();
        if tool == "run_command" && !protect_command_changes {
            let mut manifest = self.manifest.lock().unwrap();
            manifest.command_side_effects_unprotected = true;
            persist_manifest_to(&self.directory, &manifest)?;
            return Ok(None);
        }

        let mut requested = Vec::<(String, bool)>::new();
        let string_arg = |name: &str| args.get(name).and_then(Value::as_str);
        match tool {
            "write_file" | "edit_file" | "delete_file" | "make_dir" | "download_file" => {
                if let Some(path) = string_arg("path") {
                    requested.push((path.to_string(), false));
                }
            }
            "move_file" => {
                if let Some(path) = string_arg("src") {
                    requested.push((path.to_string(), false));
                }
                if let Some(path) = string_arg("dst") {
                    requested.push((path.to_string(), false));
                }
            }
            "copy_file" => {
                if let Some(path) = string_arg("dst") {
                    requested.push((path.to_string(), false));
                }
            }
            "run_command" if protect_command_changes => requested.push((".".into(), true)),
            _ => return Ok(None),
        }

        let mut unique = HashSet::new();
        let mut scopes = Vec::new();
        let mut unprotected = 0usize;
        for (path, project_scope) in requested {
            let Some(target) = self.project_relative_target(&path)? else {
                unprotected += 1;
                continue;
            };
            if !unique.insert((target.clone(), project_scope)) {
                continue;
            }
            let before = self.capture(&target, project_scope)?;
            scopes.push(SnapshotScope {
                target,
                project_scope,
                before,
                after: None,
            });
        }

        if scopes.is_empty() {
            if unprotected > 0 {
                let mut manifest = self.manifest.lock().unwrap();
                manifest.unprotected_action_count += unprotected;
                persist_manifest_to(&self.directory, &manifest)?;
            }
            return Ok(None);
        }

        let mut manifest = self.manifest.lock().unwrap();
        if manifest.status != "active" {
            bail!("Rollback checkpoint is no longer active.");
        }
        let id = manifest.next_action_id;
        manifest.next_action_id = manifest.next_action_id.saturating_add(1);
        manifest.unprotected_action_count += unprotected;
        manifest.actions.push(CheckpointAction {
            id,
            tool: tool.to_string(),
            status: "pending".into(),
            tool_ok: None,
            created_at_ms: now_ms(),
            scopes,
        });
        persist_manifest_to(&self.directory, &manifest)?;
        Ok(Some(MutationTicket(id)))
    }

    /// Capture the tool's post-state. A warning is returned instead of
    /// changing a successful tool result into a failure: the UI must know that
    /// rollback coverage is incomplete, but retrying the mutation could be
    /// more damaging than the missing checkpoint evidence.
    pub fn finish_tool_action(&self, ticket: MutationTicket, tool_ok: bool) -> Option<String> {
        let scopes = {
            let manifest = self.manifest.lock().unwrap();
            manifest
                .actions
                .iter()
                .find(|action| action.id == ticket.0)
                .map(|action| action.scopes.clone())
        };
        let Some(mut scopes) = scopes else {
            return Some("Rollback checkpoint lost the pending action record.".into());
        };

        for scope in &mut scopes {
            match self.capture(&scope.target, scope.project_scope) {
                Ok(after) => scope.after = Some(after),
                Err(error) => {
                    let mut manifest = self.manifest.lock().unwrap();
                    if let Some(action) = manifest
                        .actions
                        .iter_mut()
                        .find(|action| action.id == ticket.0)
                    {
                        action.status = "uncertain".into();
                        action.tool_ok = Some(tool_ok);
                    }
                    let _ = persist_manifest_to(&self.directory, &manifest);
                    return Some(format!(
                        "The tool completed, but its final rollback state could not be recorded: {error}"
                    ));
                }
            }
        }
        let changed = scopes.iter().any(|scope| {
            scope
                .after
                .as_ref()
                .is_some_and(|after| after.fingerprint != scope.before.fingerprint)
        });
        let mut manifest = self.manifest.lock().unwrap();
        if let Some(action) = manifest
            .actions
            .iter_mut()
            .find(|action| action.id == ticket.0)
        {
            action.scopes = scopes;
            action.tool_ok = Some(tool_ok);
            action.status = if changed { "recorded" } else { "no_change" }.into();
        }
        if let Err(error) = persist_manifest_to(&self.directory, &manifest) {
            return Some(format!("Could not persist rollback metadata: {error}"));
        }
        None
    }

    pub fn rollback(&self, last_action_only: bool) -> Result<RollbackResult, String> {
        let (checkpoint_id, status, mut actions) = {
            let manifest = self.manifest.lock().unwrap();
            (
                manifest.id.clone(),
                manifest.status.clone(),
                manifest
                    .actions
                    .iter()
                    .filter(|action| action.status == "recorded")
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        if status == "active" {
            return Err("Stop or wait for this run before rolling it back.".into());
        }
        actions.reverse();
        if last_action_only {
            actions.truncate(1);
        }
        if actions.is_empty() {
            return Ok(RollbackResult {
                checkpoint_id,
                rolled_back_actions: 0,
                restored_paths: 0,
                conflicts: Vec::new(),
                status,
                message: "No recorded agent changes remain to roll back.".into(),
            });
        }

        let mut rolled_back_actions = 0usize;
        let mut restored_paths = 0usize;
        let mut conflicts = Vec::new();
        for action in actions {
            let mut action_conflicts = Vec::new();
            for scope in &action.scopes {
                let Some(after) = scope.after.as_ref() else {
                    action_conflicts.push(format!("{} (final state unavailable)", scope.target));
                    continue;
                };
                match self.capture(&scope.target, scope.project_scope) {
                    Ok(current) if current.fingerprint == after.fingerprint => {}
                    Ok(_) => action_conflicts.push(format!(
                        "{} changed after the agent recorded it",
                        scope.target
                    )),
                    Err(error) => action_conflicts.push(format!("{}: {error}", scope.target)),
                }
            }
            if !action_conflicts.is_empty() {
                conflicts.extend(action_conflicts);
                let mut manifest = self.manifest.lock().unwrap();
                if let Some(stored) = manifest
                    .actions
                    .iter_mut()
                    .find(|item| item.id == action.id)
                {
                    stored.status = "conflict".into();
                }
                let _ = persist_manifest_to(&self.directory, &manifest);
                continue;
            }

            let restore_result = action
                .scopes
                .iter()
                .rev()
                .try_for_each(|scope| self.restore_scope(scope));
            if let Err(error) = restore_result {
                conflicts.push(format!("{} rollback failed: {error}", action.tool));
                let mut manifest = self.manifest.lock().unwrap();
                if let Some(stored) = manifest
                    .actions
                    .iter_mut()
                    .find(|item| item.id == action.id)
                {
                    stored.status = "conflict".into();
                }
                let _ = persist_manifest_to(&self.directory, &manifest);
                continue;
            }
            rolled_back_actions += 1;
            restored_paths += action.scopes.len();
            let mut manifest = self.manifest.lock().unwrap();
            if let Some(stored) = manifest
                .actions
                .iter_mut()
                .find(|item| item.id == action.id)
            {
                stored.status = "rolled_back".into();
            }
            let _ = persist_manifest_to(&self.directory, &manifest);
        }

        crate::project_intelligence::invalidate(&self.project_root);
        let mut manifest = self.manifest.lock().unwrap();
        let remaining = manifest
            .actions
            .iter()
            .any(|action| action.status == "recorded");
        let has_conflicts = manifest
            .actions
            .iter()
            .any(|action| action.status == "conflict");
        if !remaining {
            manifest.status = if has_conflicts {
                "partial_rollback"
            } else {
                "rolled_back"
            }
            .into();
        }
        let final_status = manifest.status.clone();
        let _ = persist_manifest_to(&self.directory, &manifest);
        drop(manifest);

        let message = if !conflicts.is_empty() {
            format!(
                "Rolled back {rolled_back_actions} action(s); {} conflict(s) were preserved for safety.",
                conflicts.len()
            )
        } else if last_action_only {
            format!("Undid {rolled_back_actions} agent action(s).")
        } else {
            format!("Rolled back {rolled_back_actions} agent action(s).")
        };
        Ok(RollbackResult {
            checkpoint_id,
            rolled_back_actions,
            restored_paths,
            conflicts,
            status: final_status,
            message,
        })
    }

    fn project_relative_target(&self, raw: &str) -> Result<Option<String>> {
        let raw_path = Path::new(raw.trim().trim_matches('"'));
        let candidate = if raw_path.is_absolute() {
            lexical_normalize(raw_path)
        } else {
            lexical_normalize(&self.project_root.join(raw_path))
        };
        let inside = if candidate.exists() {
            let canonical = candidate
                .canonicalize()
                .with_context(|| format!("Could not resolve checkpoint target: {raw}"))?;
            canonical
                .strip_prefix(&self.project_root)
                .ok()
                .map(PathBuf::from)
        } else {
            candidate
                .strip_prefix(&self.project_root)
                .ok()
                .map(PathBuf::from)
        };
        let Some(relative) = inside else {
            return Ok(None);
        };
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        }) {
            return Ok(None);
        }
        let display = relative.to_string_lossy().replace('\\', "/");
        Ok(Some(if display.is_empty() {
            ".".into()
        } else {
            display
        }))
    }

    fn capture(&self, target: &str, project_scope: bool) -> Result<SnapshotState> {
        let absolute = if target == "." {
            self.project_root.clone()
        } else {
            self.project_root.join(Path::new(target))
        };
        let metadata = match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SnapshotState::missing())
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            bail!("Symbolic links cannot be checkpointed safely: {target}");
        }

        let byte_limit = if project_scope {
            MAX_PROJECT_SNAPSHOT_BYTES
        } else {
            MAX_DIRECT_SNAPSHOT_BYTES
        };
        let mut total_bytes = 0u64;
        let mut entry_count = 0usize;
        let mut directories = Vec::new();
        let mut files = Vec::new();
        if metadata.is_file() {
            files.push(self.capture_file(&absolute, &mut total_bytes, byte_limit)?);
        } else if metadata.is_dir() {
            let walker = walkdir::WalkDir::new(&absolute)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| {
                    !project_scope
                        || entry.depth() == 0
                        || !entry
                            .file_name()
                            .to_str()
                            .is_some_and(ignored_project_snapshot_directory)
                });
            for entry in walker {
                let entry = entry.with_context(|| format!("Could not snapshot {target}"))?;
                if entry.depth() == 0 {
                    continue;
                }
                entry_count += 1;
                if entry_count > MAX_SNAPSHOT_ENTRIES {
                    bail!(
                        "Rollback snapshot exceeds {MAX_SNAPSHOT_ENTRIES} entries. Use a smaller target or a Git-backed isolated build."
                    );
                }
                let file_type = entry.file_type();
                if file_type.is_symlink() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&self.project_root)
                    .context("Checkpoint path escaped the project root")?
                    .to_string_lossy()
                    .replace('\\', "/");
                if file_type.is_dir() {
                    directories.push(relative);
                } else if file_type.is_file() {
                    files.push(self.capture_file(entry.path(), &mut total_bytes, byte_limit)?);
                }
            }
        } else {
            bail!("Unsupported checkpoint target: {target}");
        }
        directories.sort();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let mut state = SnapshotState {
            kind: if metadata.is_file() {
                "file"
            } else {
                "directory"
            }
            .into(),
            fingerprint: String::new(),
            directories,
            files,
        };
        state.fingerprint = state.calculate_fingerprint();
        Ok(state)
    }

    fn capture_file(
        &self,
        path: &Path,
        total_bytes: &mut u64,
        byte_limit: u64,
    ) -> Result<SnapshotFile> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("Could not read checkpoint file: {}", path.display()))?;
        *total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if *total_bytes > byte_limit {
            bail!(
                "Rollback snapshot exceeds {} MiB. Use a smaller target or an isolated Git worktree.",
                byte_limit / (1024 * 1024)
            );
        }
        let blob = format!("{:x}", Sha256::digest(&bytes));
        let blob_path = self.directory.join("blobs").join(&blob);
        if !blob_path.is_file() {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&blob_path)
            {
                Ok(mut file) => file.write_all(&bytes)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let relative = path
            .strip_prefix(&self.project_root)
            .context("Checkpoint file escaped the project root")?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(SnapshotFile {
            path: relative,
            blob,
            size: bytes.len() as u64,
        })
    }

    fn restore_scope(&self, scope: &SnapshotScope) -> Result<()> {
        if scope.project_scope {
            self.restore_project_tree(&scope.before, scope.after.as_ref())
        } else {
            self.restore_direct_target(&scope.target, &scope.before)
        }
    }

    fn restore_direct_target(&self, target: &str, before: &SnapshotState) -> Result<()> {
        if target == "." {
            bail!("Refusing direct removal of the project root.");
        }
        let absolute = self.project_root.join(Path::new(target));
        remove_existing(&absolute)?;
        match before.kind.as_str() {
            "missing" => Ok(()),
            "file" => {
                let file = before
                    .files
                    .first()
                    .context("Checkpoint file blob is missing")?;
                self.restore_file(file)
            }
            "directory" => {
                std::fs::create_dir_all(&absolute)?;
                for directory in &before.directories {
                    std::fs::create_dir_all(self.project_root.join(directory))?;
                }
                for file in &before.files {
                    self.restore_file(file)?;
                }
                Ok(())
            }
            other => bail!("Unknown checkpoint state: {other}"),
        }
    }

    fn restore_project_tree(
        &self,
        before: &SnapshotState,
        after: Option<&SnapshotState>,
    ) -> Result<()> {
        let after = after.context("Project checkpoint has no final state")?;
        let before_files = before
            .files
            .iter()
            .map(|file| (file.path.clone(), file))
            .collect::<BTreeMap<_, _>>();
        let after_files = after
            .files
            .iter()
            .map(|file| (file.path.clone(), file))
            .collect::<BTreeMap<_, _>>();
        let before_dirs = before.directories.iter().cloned().collect::<BTreeSet<_>>();
        let after_dirs = after.directories.iter().cloned().collect::<BTreeSet<_>>();

        // Remove files introduced by the command, and remove paths whose type
        // changed before reconstructing the original tree.
        for path in after_files.keys() {
            if !before_files.contains_key(path) || before_dirs.contains(path) {
                remove_existing(&self.project_root.join(path))?;
            }
        }
        let mut removable_dirs = after_dirs
            .difference(&before_dirs)
            .cloned()
            .collect::<Vec<_>>();
        removable_dirs.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
        for path in removable_dirs {
            let absolute = self.project_root.join(path);
            if absolute.is_dir() {
                let _ = std::fs::remove_dir(&absolute);
            }
        }

        for directory in &before.directories {
            let absolute = self.project_root.join(directory);
            if absolute.is_file() {
                std::fs::remove_file(&absolute)?;
            }
            std::fs::create_dir_all(&absolute)?;
        }
        for file in before_files.values() {
            self.restore_file(file)?;
        }
        Ok(())
    }

    fn restore_file(&self, file: &SnapshotFile) -> Result<()> {
        let destination = self.project_root.join(Path::new(&file.path));
        if destination.is_dir() {
            std::fs::remove_dir_all(&destination)?;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let blob = self.directory.join("blobs").join(&file.blob);
        std::fs::copy(&blob, &destination).with_context(|| {
            format!(
                "Could not restore {} from checkpoint blob {}",
                file.path, file.blob
            )
        })?;
        Ok(())
    }
}

fn persist_manifest_to(directory: &Path, manifest: &CheckpointManifest) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    let path = directory.join("manifest.json");
    let temporary = directory.join("manifest.json.tmp");
    let raw = serde_json::to_vec_pretty(manifest)?;
    std::fs::write(&temporary, raw)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    std::fs::rename(&temporary, &path)?;
    Ok(())
}

fn normalized_project_key(path: &str) -> String {
    path.trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn remove_existing(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(path)?;
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        bail!("Unsupported path during rollback: {}", path.display());
    }
    Ok(())
}

fn ignored_project_snapshot_directory(name: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::CheckpointStore;
    use serde_json::json;
    use std::path::PathBuf;

    struct TempTree {
        root: PathBuf,
        cache: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("ai-forge-checkpoint-test-{}", uuid::Uuid::new_v4()));
            let root = base.join("project");
            let cache = base.join("cache");
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::create_dir_all(&cache).unwrap();
            Self { root, cache }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    #[test]
    fn direct_file_change_rolls_back_to_original_bytes() {
        let tree = TempTree::new();
        let source = tree.root.join("src/main.ts");
        std::fs::write(&source, "before").unwrap();
        let store = CheckpointStore::at(tree.cache.clone());
        let checkpoint = store.begin_run("session", &tree.root, "balanced").unwrap();
        let ticket = checkpoint
            .prepare_tool_action("write_file", &json!({"path":"src/main.ts"}), false)
            .unwrap()
            .unwrap();
        std::fs::write(&source, "after").unwrap();
        assert!(checkpoint.finish_tool_action(ticket, true).is_none());
        checkpoint.mark_finished("finished");
        let summary = checkpoint.summary();
        assert_eq!(summary.actions.len(), 1);
        assert_eq!(summary.actions[0].tool, "write_file");
        assert_eq!(summary.actions[0].targets, vec!["src/main.ts"]);
        assert_eq!(summary.actions[0].status, "recorded");
        assert_eq!(summary.actions[0].tool_ok, Some(true));
        let result = checkpoint.rollback(false).unwrap();
        assert_eq!(result.rolled_back_actions, 1);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before");
    }

    #[test]
    fn rollback_preserves_a_newer_user_edit_as_a_conflict() {
        let tree = TempTree::new();
        let source = tree.root.join("src/main.ts");
        std::fs::write(&source, "before").unwrap();
        let store = CheckpointStore::at(tree.cache.clone());
        let checkpoint = store.begin_run("session", &tree.root, "balanced").unwrap();
        let ticket = checkpoint
            .prepare_tool_action("edit_file", &json!({"path":"src/main.ts"}), false)
            .unwrap()
            .unwrap();
        std::fs::write(&source, "agent").unwrap();
        checkpoint.finish_tool_action(ticket, true);
        checkpoint.mark_finished("finished");
        std::fs::write(&source, "user edit").unwrap();
        let result = checkpoint.rollback(false).unwrap();
        assert_eq!(result.rolled_back_actions, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "user edit");
    }

    #[test]
    fn safe_command_snapshot_restores_changed_and_created_source_files() {
        let tree = TempTree::new();
        let source = tree.root.join("src/main.ts");
        let created = tree.root.join("src/generated.ts");
        std::fs::write(&source, "before").unwrap();
        let store = CheckpointStore::at(tree.cache.clone());
        let checkpoint = store.begin_run("session", &tree.root, "safe").unwrap();
        let ticket = checkpoint
            .prepare_tool_action("run_command", &json!({"command":"generator"}), true)
            .unwrap()
            .unwrap();
        std::fs::write(&source, "after").unwrap();
        std::fs::write(&created, "generated").unwrap();
        checkpoint.finish_tool_action(ticket, true);
        checkpoint.mark_finished("finished");
        let result = checkpoint.rollback(false).unwrap();
        assert_eq!(result.rolled_back_actions, 1);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before");
        assert!(!created.exists());
    }

    #[test]
    fn undo_last_action_then_full_rollback_walks_the_journal_backwards() {
        let tree = TempTree::new();
        let source = tree.root.join("src/main.ts");
        std::fs::write(&source, "original").unwrap();
        let store = CheckpointStore::at(tree.cache.clone());
        let checkpoint = store.begin_run("session", &tree.root, "balanced").unwrap();

        let first = checkpoint
            .prepare_tool_action("write_file", &json!({"path":"src/main.ts"}), false)
            .unwrap()
            .unwrap();
        std::fs::write(&source, "first").unwrap();
        checkpoint.finish_tool_action(first, true);

        let second = checkpoint
            .prepare_tool_action("write_file", &json!({"path":"src/main.ts"}), false)
            .unwrap()
            .unwrap();
        std::fs::write(&source, "second").unwrap();
        checkpoint.finish_tool_action(second, true);
        checkpoint.mark_finished("finished");

        let undo = checkpoint.rollback(true).unwrap();
        assert_eq!(undo.rolled_back_actions, 1);
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "first");
        let full = checkpoint.rollback(false).unwrap();
        assert_eq!(full.rolled_back_actions, 1);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "original");
    }

    #[test]
    fn finished_checkpoint_can_be_reloaded_after_restart() {
        let tree = TempTree::new();
        let source = tree.root.join("src/main.ts");
        std::fs::write(&source, "before").unwrap();
        let checkpoint_id = {
            let store = CheckpointStore::at(tree.cache.clone());
            let checkpoint = store.begin_run("session", &tree.root, "balanced").unwrap();
            let ticket = checkpoint
                .prepare_tool_action("write_file", &json!({"path":"src/main.ts"}), false)
                .unwrap()
                .unwrap();
            std::fs::write(&source, "after").unwrap();
            checkpoint.finish_tool_action(ticket, true);
            checkpoint.mark_finished("finished");
            checkpoint.id()
        };

        let reloaded = CheckpointStore::at(tree.cache.clone());
        let checkpoint = reloaded.get(&checkpoint_id).expect("persisted checkpoint");
        let result = checkpoint.rollback(false).unwrap();
        assert_eq!(result.rolled_back_actions, 1);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "before");
    }
}
