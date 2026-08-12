use anyhow::{bail, Context, Result};
#[cfg(not(test))]
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(all(unix, not(target_os = "linux")))]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REGISTRY_VERSION: u8 = 1;
const MAX_LEASES: usize = 64;
const MAX_REGISTRY_BYTES: u64 = 128 * 1024;
const COMMAND_FINGERPRINT_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerLease {
    pub lease_id: String,
    pub project_root: String,
    pub work_dir: String,
    pub command_fingerprint: String,
    pub port: Option<u16>,
    pub pid: u32,
    /// OS process-creation token. This prevents a recycled PID from inheriting a lease.
    pub process_instance: String,
    pub log_path: String,
    pub created_at: u64,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone)]
pub struct PreparedDevServer {
    pub lease_id: String,
    pub project_root: String,
    pub work_dir: PathBuf,
    pub work_dir_display: String,
    pub command_fingerprint: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone)]
pub enum PrepareDevServer {
    Reuse(DevServerLease),
    Start(PreparedDevServer),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LeaseRegistry {
    version: u8,
    leases: Vec<DevServerLease>,
}

impl Default for LeaseRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            leases: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OwnershipDecision {
    Reuse(usize),
    ManagedConflict,
    ManagedNotReady,
    UnknownConflict,
    Start,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn normalized_identity_path(path: &Path) -> String {
    let display = crate::workspace::display_project_root(path);
    #[cfg(windows)]
    {
        display.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        display
    }
}

fn command_fingerprint(command: &str) -> String {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

#[cfg(not(test))]
fn registry_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .map(|dirs| dirs.config_dir().join("dev-server-leases.json"))
}

#[cfg(test)]
fn registry_path() -> Option<PathBuf> {
    static TEST_REGISTRY_ROOT: OnceLock<PathBuf> = OnceLock::new();
    Some(
        TEST_REGISTRY_ROOT
            .get_or_init(|| {
                std::env::temp_dir().join(format!(
                    "hormachuelos-dev-server-tests-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4()
                ))
            })
            .join("dev-server-leases.json"),
    )
}

fn valid_lease(lease: &DevServerLease) -> bool {
    !lease.lease_id.is_empty()
        && lease.lease_id.len() <= 128
        && !lease.project_root.is_empty()
        && lease.project_root.len() <= 4096
        && !lease.work_dir.is_empty()
        && lease.work_dir.len() <= 4096
        && lease.command_fingerprint.len() == COMMAND_FINGERPRINT_LEN
        && lease
            .command_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        && lease.pid > 0
        && !lease.process_instance.is_empty()
        && lease.process_instance.len() <= 128
        && lease.port != Some(0)
        && lease.log_path.len() <= 4096
}

fn load_registry() -> LeaseRegistry {
    let Some(path) = registry_path() else {
        return LeaseRegistry::default();
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return LeaseRegistry::default();
    };
    if metadata.len() > MAX_REGISTRY_BYTES {
        return LeaseRegistry::default();
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return LeaseRegistry::default();
    };
    let Ok(mut registry) = serde_json::from_slice::<LeaseRegistry>(&bytes) else {
        return LeaseRegistry::default();
    };
    if registry.version != REGISTRY_VERSION {
        return LeaseRegistry::default();
    }
    registry.leases.retain(valid_lease);
    registry.leases.truncate(MAX_LEASES);
    registry
}

fn persist_registry(registry: &LeaseRegistry) -> Result<()> {
    let Some(path) = registry_path() else {
        bail!("Could not determine the Hormachuelos configuration directory.");
    };
    let parent = path
        .parent()
        .context("Development-server registry path has no parent directory.")?;
    std::fs::create_dir_all(parent).with_context(|| {
        format!(
            "Could not create development-server registry directory: {}",
            parent.display()
        )
    })?;
    let bytes = serde_json::to_vec(registry)?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        bail!("Development-server registry is unexpectedly large.");
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, bytes).with_context(|| {
        format!(
            "Could not write development-server registry: {}",
            temporary.display()
        )
    })?;
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| {
            format!(
                "Could not replace development-server registry: {}",
                path.display()
            )
        })?;
    }
    std::fs::rename(&temporary, &path).with_context(|| {
        format!(
            "Could not install development-server registry: {}",
            path.display()
        )
    })?;
    Ok(())
}

fn registry() -> &'static Mutex<LeaseRegistry> {
    static REGISTRY: OnceLock<Mutex<LeaseRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(load_registry()))
}

#[cfg(windows)]
fn process_instance(pid: u32) -> Option<String> {
    use std::ffi::c_void;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        let _ = CloseHandle(handle);
        ok.then(|| format!("windows:{:08x}{:08x}", creation.high, creation.low))
    }
}

#[cfg(target_os = "linux")]
fn process_instance(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(Path::new("/proc").join(pid.to_string()).join("stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    // The tail begins at field 3 (state); process start time is field 22.
    let start_time = fields.split_whitespace().nth(19)?;
    Some(format!("linux:{start_time}"))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_instance(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let start = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !start.is_empty()).then(|| format!("unix:{start}"))
}

fn lease_process_is_alive(lease: &DevServerLease) -> bool {
    process_instance(lease.pid).as_deref() == Some(lease.process_instance.as_str())
}

pub fn local_port_is_open(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

fn lease_matches(candidate: &PreparedDevServer, lease: &DevServerLease) -> bool {
    normalized_identity_path(Path::new(&lease.project_root))
        == normalized_identity_path(Path::new(&candidate.project_root))
        && normalized_identity_path(Path::new(&lease.work_dir))
            == normalized_identity_path(&candidate.work_dir)
        && lease.command_fingerprint == candidate.command_fingerprint
        && lease.port == candidate.port
}

fn decide_ownership_with<P, O>(
    leases: &[DevServerLease],
    candidate: &PreparedDevServer,
    pid_alive: P,
    port_open: O,
) -> OwnershipDecision
where
    P: Fn(&DevServerLease) -> bool,
    O: Fn(u16) -> bool,
{
    if let Some((index, lease)) = leases
        .iter()
        .enumerate()
        .find(|(_, lease)| lease_matches(candidate, lease) && pid_alive(lease))
    {
        if let Some(port) = candidate.port {
            if !port_open(port) {
                return OwnershipDecision::ManagedNotReady;
            }
        }
        return OwnershipDecision::Reuse(index);
    }

    if let Some(port) = candidate.port {
        if leases
            .iter()
            .any(|lease| lease.port == Some(port) && pid_alive(lease))
        {
            return OwnershipDecision::ManagedConflict;
        }
        if port_open(port) {
            return OwnershipDecision::UnknownConflict;
        }
    }
    OwnershipDecision::Start
}

fn suggested_free_port(requested: u16) -> Option<u16> {
    let end = requested.saturating_add(20);
    (requested.saturating_add(1)..=end).find(|port| *port > 0 && !local_port_is_open(*port))
}

fn conflict_suffix(port: u16) -> String {
    suggested_free_port(port)
        .map(|suggested| {
            format!(
                " Suggested free port: {suggested}. Update both the server command and the port argument."
            )
        })
        .unwrap_or_else(|| " Choose a different free port in both the server command and the port argument.".into())
}

fn canonical_scope(
    project_root: &Path,
    cwd: Option<&str>,
    command: &str,
    port: Option<u16>,
) -> Result<PreparedDevServer> {
    if command.trim().is_empty() {
        bail!("command must not be empty");
    }
    let root = project_root
        .canonicalize()
        .with_context(|| format!("Could not resolve project root: {}", project_root.display()))?;
    if !root.is_dir() {
        bail!("The active project root is not a directory.");
    }
    let requested = cwd
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| root.clone());
    let requested = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let work_dir = requested.canonicalize().with_context(|| {
        format!(
            "Could not resolve development-server working directory: {}",
            requested.display()
        )
    })?;
    if !work_dir.is_dir() {
        bail!("Development-server working directory is not a directory.");
    }
    if !work_dir.starts_with(&root) {
        bail!(
            "Development-server working directory must stay inside the active project root."
        );
    }
    let project_root = crate::workspace::display_project_root(&root);
    let work_dir_display = crate::workspace::display_project_root(&work_dir);
    Ok(PreparedDevServer {
        lease_id: format!("dev-server-{}", uuid::Uuid::new_v4()),
        project_root,
        work_dir,
        work_dir_display,
        command_fingerprint: command_fingerprint(command),
        port,
    })
}

pub fn prepare_dev_server(
    project_root: &Path,
    cwd: Option<&str>,
    command: &str,
    port: Option<u16>,
) -> Result<PrepareDevServer> {
    let candidate = canonical_scope(project_root, cwd, command, port)?;
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Development-server registry is unavailable."))?;
    let before = registry.leases.len();
    registry.leases.retain(lease_process_is_alive);
    if registry.leases.len() != before {
        persist_registry(&registry)?;
    }

    match decide_ownership_with(
        &registry.leases,
        &candidate,
        |_| true,
        local_port_is_open,
    ) {
        OwnershipDecision::Reuse(index) => {
            registry.leases[index].last_seen_at = now_secs();
            let lease = registry.leases[index].clone();
            persist_registry(&registry)?;
            Ok(PrepareDevServer::Reuse(lease))
        }
        OwnershipDecision::ManagedNotReady => {
            let port = candidate.port.unwrap_or_default();
            bail!(
                "Hormachuelos already owns this exact project server process, but port {port} is not ready. Inspect its lease log or stop that process before retrying; it will not be replaced or claimed as another website."
            )
        }
        OwnershipDecision::ManagedConflict => {
            let port = candidate.port.unwrap_or_default();
            bail!(
                "Port {port} belongs to a different Hormachuelos project/server lease and cannot be reused for the active project.{}",
                conflict_suffix(port)
            )
        }
        OwnershipDecision::UnknownConflict => {
            let port = candidate.port.unwrap_or_default();
            bail!(
                "Port {port} is already used by an unowned local process. Hormachuelos will not claim, reuse, or stop it.{}",
                conflict_suffix(port)
            )
        }
        OwnershipDecision::Start => {
            if registry.leases.len() >= MAX_LEASES {
                bail!(
                    "Hormachuelos is already tracking {MAX_LEASES} live development servers. Stop an old server before starting another."
                );
            }
            Ok(PrepareDevServer::Start(candidate))
        }
    }
}

pub fn register_started_server(
    prepared: PreparedDevServer,
    pid: u32,
    log_path: &Path,
) -> Result<DevServerLease> {
    if pid == 0 {
        bail!("Development-server launcher returned an invalid PID.");
    }
    let mut registry = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Development-server registry is unavailable."))?;
    registry.leases.retain(lease_process_is_alive);
    if let Some(port) = prepared.port {
        if registry
            .leases
            .iter()
            .any(|lease| lease.port == Some(port) && lease_process_is_alive(lease))
        {
            bail!(
                "Port {port} acquired another managed owner while the server was starting; refusing to overwrite its lease."
            );
        }
    }
    if registry.leases.len() >= MAX_LEASES {
        bail!("Development-server registry is full.");
    }
    let now = now_secs();
    let lease = DevServerLease {
        lease_id: prepared.lease_id,
        project_root: prepared.project_root,
        work_dir: prepared.work_dir_display,
        command_fingerprint: prepared.command_fingerprint,
        port: prepared.port,
        pid,
        process_instance: process_instance(pid).with_context(|| {
            format!("Could not establish an identity token for server process {pid}.")
        })?,
        log_path: log_path.to_string_lossy().to_string(),
        created_at: now,
        last_seen_at: now,
    };
    registry.leases.push(lease.clone());
    persist_registry(&registry)?;
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(root: &str, work_dir: &str, command: &str, port: u16) -> PreparedDevServer {
        PreparedDevServer {
            lease_id: "candidate".into(),
            project_root: root.into(),
            work_dir: PathBuf::from(work_dir),
            work_dir_display: work_dir.into(),
            command_fingerprint: command_fingerprint(command),
            port: Some(port),
        }
    }

    fn lease(candidate: &PreparedDevServer, pid: u32) -> DevServerLease {
        DevServerLease {
            lease_id: "lease-a".into(),
            project_root: candidate.project_root.clone(),
            work_dir: candidate.work_dir_display.clone(),
            command_fingerprint: candidate.command_fingerprint.clone(),
            port: candidate.port,
            pid,
            process_instance: format!("instance-{pid}"),
            log_path: "server.log".into(),
            created_at: 1,
            last_seen_at: 1,
        }
    }

    #[test]
    fn exact_live_project_lease_is_reusable() {
        let candidate = prepared("C:/Projects/A", "C:/Projects/A/web", "npm run dev", 3000);
        let leases = vec![lease(&candidate, 42)];
        assert_eq!(
            decide_ownership_with(&leases, &candidate, |lease| lease.pid == 42, |port| port == 3000),
            OwnershipDecision::Reuse(0)
        );
    }

    #[test]
    fn another_project_on_the_same_port_is_never_reused() {
        let candidate = prepared("C:/Projects/B", "C:/Projects/B", "npm run dev", 3000);
        let other = prepared("C:/Projects/A", "C:/Projects/A", "npm run dev", 3000);
        let leases = vec![lease(&other, 42)];
        assert_eq!(
            decide_ownership_with(&leases, &candidate, |_| true, |_| true),
            OwnershipDecision::ManagedConflict
        );
    }

    #[test]
    fn an_unknown_listener_is_never_claimed() {
        let candidate = prepared("C:/Projects/A", "C:/Projects/A", "npm run dev", 5173);
        assert_eq!(
            decide_ownership_with(&[], &candidate, |_| false, |port| port == 5173),
            OwnershipDecision::UnknownConflict
        );
    }

    #[test]
    fn dead_leases_do_not_block_a_fresh_start() {
        let candidate = prepared("C:/Projects/A", "C:/Projects/A", "npm run dev", 4173);
        let leases = vec![lease(&candidate, 99)];
        assert_eq!(
            decide_ownership_with(&leases, &candidate, |_| false, |_| false),
            OwnershipDecision::Start
        );
    }

    #[test]
    fn same_project_with_a_different_command_is_not_reused() {
        let candidate = prepared("C:/Projects/A", "C:/Projects/A", "npm run dev", 3000);
        let other = prepared("C:/Projects/A", "C:/Projects/A", "npm run preview", 3000);
        let leases = vec![lease(&other, 42)];
        assert_eq!(
            decide_ownership_with(&leases, &candidate, |_| true, |_| true),
            OwnershipDecision::ManagedConflict
        );
    }

    #[test]
    fn command_secrets_are_fingerprinted_not_persisted() {
        let secret_command = "npm run dev -- --token super-secret-value";
        let candidate = prepared("C:/Projects/A", "C:/Projects/A", secret_command, 3000);
        let encoded = serde_json::to_string(&lease(&candidate, 42)).unwrap();
        assert!(!encoded.contains("super-secret-value"));
        assert!(!encoded.contains(secret_command));
        assert_eq!(candidate.command_fingerprint.len(), COMMAND_FINGERPRINT_LEN);
    }

    #[test]
    fn dev_server_cwd_cannot_escape_the_project() {
        let base = std::env::temp_dir().join(format!("horma-dev-scope-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        let inside = root.join("web");
        let outside = base.join("other-project");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let accepted = canonical_scope(&root, Some("web"), "npm run dev", Some(3000)).unwrap();
        assert_eq!(accepted.work_dir, inside.canonicalize().unwrap());
        assert!(canonical_scope(
            &root,
            outside.to_str(),
            "npm run dev",
            Some(3000)
        )
        .is_err());

        std::fs::remove_dir_all(base).unwrap();
    }
}