use crate::config::Settings;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub type QuestionResponder = tokio::sync::oneshot::Sender<String>;
pub type ConfirmResponder = tokio::sync::oneshot::Sender<bool>;
type SessionRuns = Arc<Mutex<HashMap<String, Arc<SessionRun>>>>;

/// Owns one registry entry. Dropping the command future (or unwinding after a
/// panic) releases the session just as reliably as an ordinary return.
pub struct ActiveRunGuard {
    runs: SessionRuns,
    session_id: String,
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        self.runs.lock().unwrap().remove(&self.session_id);
    }
}

/// Per-session agent run handles — allows multiple sessions to run concurrently.
pub struct SessionRun {
    pub cancel: Arc<AtomicBool>,
    pub question_tx: Mutex<Option<QuestionResponder>>,
    pub confirm_tx: Mutex<Option<ConfirmResponder>>,
    pub active_pid: Arc<Mutex<Option<u32>>>,
    checkpoint: Mutex<Option<Arc<crate::checkpoint::RunCheckpoint>>>,
    protect_command_changes: AtomicBool,
    project_root: Mutex<Option<String>>,
}

impl SessionRun {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            question_tx: Mutex::new(None),
            confirm_tx: Mutex::new(None),
            active_pid: Arc::new(Mutex::new(None)),
            checkpoint: Mutex::new(None),
            protect_command_changes: AtomicBool::new(false),
            project_root: Mutex::new(None),
        }
    }

    pub fn set_checkpoint(
        &self,
        checkpoint: Arc<crate::checkpoint::RunCheckpoint>,
        protect_command_changes: bool,
    ) {
        *self.checkpoint.lock().unwrap() = Some(checkpoint);
        self.protect_command_changes
            .store(protect_command_changes, Ordering::SeqCst);
    }

    pub fn checkpoint(&self) -> Option<Arc<crate::checkpoint::RunCheckpoint>> {
        self.checkpoint.lock().unwrap().clone()
    }

    pub fn protect_command_changes(&self) -> bool {
        self.protect_command_changes.load(Ordering::SeqCst)
    }

    pub fn set_project_root(&self, project_root: String) {
        *self.project_root.lock().unwrap() = Some(project_root);
    }

    fn owns_project(&self, project_root: &str) -> bool {
        self.project_root
            .lock()
            .unwrap()
            .as_deref()
            .is_some_and(|value| project_path_key(value) == project_path_key(project_root))
    }

    pub fn request_stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(pid) = self.active_pid.lock().unwrap().take() {
            crate::tools::kill_process_tree(pid);
        }
        // Unblock any waiters so the loop can exit promptly
        if let Some(tx) = self.confirm_tx.lock().unwrap().take() {
            let _ = tx.send(false);
        }
        if let Some(tx) = self.question_tx.lock().unwrap().take() {
            let _ = tx.send("User cancelled.".into());
        }
    }
}

impl Default for SessionRun {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AppState {
    pub project_root: Mutex<Option<String>>,
    pub settings: Mutex<Settings>,
    pub recent_projects: Mutex<Vec<String>>,
    /// Active agent runs keyed by frontend session id.
    runs: SessionRuns,
    /// Durable copy-on-write checkpoints survive the run so the Changes panel
    /// can safely undo agent-owned file mutations.
    pub checkpoints: crate::checkpoint::CheckpointStore,
    /// Cursor SDK local agent ids keyed by session (for multi-turn resume).
    pub cursor_agent_ids: Mutex<HashMap<String, String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let settings = Settings::load().unwrap_or_default();
        crate::desktop_computer_use::set_allowed_apps(
            settings.desktop_computer_use_allowed_apps.clone(),
        );
        let recent = load_recent().unwrap_or_default();
        Self {
            project_root: Mutex::new(None),
            settings: Mutex::new(settings),
            recent_projects: Mutex::new(recent),
            runs: Arc::new(Mutex::new(HashMap::new())),
            checkpoints: crate::checkpoint::CheckpointStore::new(),
            cursor_agent_ids: Mutex::new(HashMap::new()),
        }
    }

    pub fn cursor_agent_id(&self, session_id: &str) -> Option<String> {
        self.cursor_agent_ids
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
    }

    pub fn set_cursor_agent_id(&self, session_id: &str, agent_id: Option<String>) {
        let mut map = self.cursor_agent_ids.lock().unwrap();
        match agent_id {
            Some(id) if !id.is_empty() => {
                map.insert(session_id.to_string(), id);
            }
            _ => {
                map.remove(session_id);
            }
        }
    }

    pub fn start_run(&self, session_id: &str) -> Result<(Arc<SessionRun>, ActiveRunGuard), String> {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(session_id) {
            return Err(
                "This session is already running. Stop it or wait for it to finish.".into(),
            );
        }
        let run = Arc::new(SessionRun::new());
        runs.insert(session_id.to_string(), run.clone());
        let guard = ActiveRunGuard {
            runs: self.runs.clone(),
            session_id: session_id.to_string(),
        };
        Ok((run, guard))
    }

    pub fn get_run(&self, session_id: &str) -> Option<Arc<SessionRun>> {
        self.runs.lock().unwrap().get(session_id).cloned()
    }

    pub fn active_run_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.runs.lock().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn has_active_run_for_project(&self, project_root: &str) -> bool {
        self.runs
            .lock()
            .unwrap()
            .values()
            .any(|run| run.owns_project(project_root))
    }

    pub fn stop_run(&self, session_id: &str) -> bool {
        if let Some(run) = self.runs.lock().unwrap().get(session_id).cloned() {
            run.request_stop();
            true
        } else {
            false
        }
    }

    pub fn stop_all_runs(&self) {
        let runs: Vec<Arc<SessionRun>> = self.runs.lock().unwrap().values().cloned().collect();
        for run in runs {
            run.request_stop();
        }
    }

    /// When any session hits usage limit, stop every concurrent run (all models).
    pub fn halt_all_for_usage_limit(app: &AppHandle) {
        if let Some(state) = app.try_state::<AppState>() {
            state.stop_all_runs();
        }
    }

    pub fn add_recent_project(&self, path: String) {
        let mut list = self.recent_projects.lock().unwrap();
        let key = project_path_key(&path);
        list.retain(|p| project_path_key(p) != key);
        list.insert(0, path);
        if list.len() > 20 {
            list.truncate(20);
        }
        let _ = save_recent(list.clone());
    }

    /// Forget a recent project without deleting or modifying anything inside
    /// the project directory.
    pub fn remove_recent_project(&self, path: &str) -> Result<bool, String> {
        let mut list = self.recent_projects.lock().unwrap();
        let mut next = list.clone();
        let removed = remove_recent_project_path(&mut next, path);
        if removed {
            save_recent(next.clone())
                .map_err(|error| format!("Could not save the recent-project list: {error}"))?;
            *list = next;
        }
        Ok(removed)
    }

    /// Replace an accidentally selected empty child with the verified parent
    /// project so startup never reintroduces the stale workspace.
    pub fn replace_recent_project(&self, previous: &str, replacement: String) {
        let previous_key = project_path_key(previous);
        let replacement_key = project_path_key(&replacement);
        let mut list = self.recent_projects.lock().unwrap();
        list.retain(|path| {
            let key = project_path_key(path);
            key != previous_key && key != replacement_key
        });
        list.insert(0, replacement);
        if list.len() > 20 {
            list.truncate(20);
        }
        let _ = save_recent(list.clone());
    }
}

fn project_path_key(path: &str) -> String {
    let mut value = path.trim().replace('/', "\\");
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{unc}");
    } else if let Some(plain) = value.strip_prefix(r"\\?\") {
        value = plain.to_string();
    }
    value.trim_end_matches('\\').to_ascii_lowercase()
}

fn remove_recent_project_path(list: &mut Vec<String>, path: &str) -> bool {
    let key = project_path_key(path);
    let previous_len = list.len();
    list.retain(|entry| project_path_key(entry) != key);
    list.len() != previous_len
}

fn recent_path() -> Option<std::path::PathBuf> {
    let proj = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")?;
    let dir = proj.config_dir().to_path_buf();
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("recent.json"))
}

fn load_recent() -> anyhow::Result<Vec<String>> {
    let p = recent_path().ok_or_else(|| anyhow::anyhow!("no config dir"))?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_recent(list: Vec<String>) -> anyhow::Result<()> {
    let p = recent_path().ok_or_else(|| anyhow::anyhow!("no config dir"))?;
    let raw = serde_json::to_string_pretty(&list)?;
    std::fs::write(&p, raw)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{remove_recent_project_path, AppState};

    #[test]
    fn active_run_guard_releases_the_session_on_drop() {
        let state = AppState::new();
        state.runs.lock().unwrap().clear();

        let (run, guard) = state.start_run("session-b").expect("run should start");
        run.set_project_root(r"C:\Projects\Atlas".into());
        assert_eq!(state.active_run_ids(), vec!["session-b"]);
        assert!(state.has_active_run_for_project(r"c:/projects/atlas/"));
        assert!(!state.has_active_run_for_project(r"C:\Projects\Beacon"));
        assert!(state.start_run("session-b").is_err());

        let (_other, other_guard) = state
            .start_run("session-a")
            .expect("other run should start");
        assert_eq!(state.active_run_ids(), vec!["session-a", "session-b"]);

        drop(guard);
        assert_eq!(state.active_run_ids(), vec!["session-a"]);
        drop(other_guard);
        assert!(state.active_run_ids().is_empty());
    }

    #[test]
    fn removing_a_recent_project_normalizes_windows_paths_without_touching_others() {
        let mut projects = vec![
            r"C:\Projects\Atlas".to_string(),
            r"C:\Projects\Beacon".to_string(),
            r"\\server\share\Cinder".to_string(),
        ];

        assert!(remove_recent_project_path(
            &mut projects,
            r"\\?\c:\projects\atlas\"
        ));
        assert_eq!(
            projects,
            vec![
                r"C:\Projects\Beacon".to_string(),
                r"\\server\share\Cinder".to_string()
            ]
        );
        assert!(!remove_recent_project_path(
            &mut projects,
            r"C:\Projects\Missing"
        ));
    }
}
