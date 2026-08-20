//! Host-owned Director: job contracts that replace the old Smart Agent pipeline.
//!
//! The host classifies each run as Answer, Change, Ship, or Operate. Answer jobs
//! never show a ledger, never call for a final review, and never accept `done`.
//! Ship/Change keep a verification gate so mutating work cannot finish on talk.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

const STEP_IDS: [&str; 6] = [
    "scope",
    "inspect",
    "implement",
    "validate",
    "debug",
    "deliver",
];
const STEP_LABELS: [&str; 6] = ["Scope", "Inspect", "Build", "Check", "Debug", "Done"];
const CHANGE_STEP_IDS: [&str; 3] = ["inspect", "implement", "validate"];
const CHANGE_STEP_LABELS: [&str; 3] = ["Inspect", "Patch", "Check"];
const OPERATE_STEP_IDS: [&str; 3] = ["inspect", "implement", "validate"];
const OPERATE_STEP_LABELS: [&str; 3] = ["Observe", "Act", "Check"];
pub const PUBLIC_PROGRESS_MAX: usize = 480;

/// True when the effective permission mode should use the Build activity timeline.
pub fn is_build_timeline_mode(mode: &str) -> bool {
    matches!(mode.trim().to_ascii_lowercase().as_str(), "build" | "full")
}

/// Build (and Plan after Apply) must not stream private provider chain-of-thought.
pub fn hide_provider_reasoning(mode: &str, plan_implementation_unlocked: bool) -> bool {
    let mode = mode.trim().to_ascii_lowercase();
    is_build_timeline_mode(&mode) || (mode == "plan" && plan_implementation_unlocked)
}

/// Compact host-authored progress so the UI never stores raw model reasoning.
pub fn bound_public_progress(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.replace('`', "");
    if compact.chars().count() <= PUBLIC_PROGRESS_MAX {
        return compact;
    }
    let mut out = String::new();
    for ch in compact.chars() {
        if out.chars().count() + 1 >= PUBLIC_PROGRESS_MAX {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

pub fn emit_mode_transition(app: &AppHandle, session_id: &str, from: &str, to: &str, reason: &str) {
    emit(
        app,
        session_id,
        "mode_transition",
        json!({
            "from": from,
            "to": to,
            "reason": reason,
        }),
    );
}

pub fn emit_build_progress(
    app: &AppHandle,
    session_id: &str,
    iteration: u32,
    phase: &str,
    status: &str,
    text: &str,
    final_summary: bool,
) {
    let text = bound_public_progress(text);
    if text.is_empty() {
        return;
    }
    emit(
        app,
        session_id,
        "build_progress",
        json!({
            "segment": iteration,
            "iteration": iteration,
            "phase": phase,
            "status": status,
            "text": text,
            "final": final_summary,
        }),
    );
}

const ANSWER_DIRECTOR: &str = "\nDIRECTOR JOB: ANSWER\n\
- This is a question or a simplify/rephrase request. Write a short visible reply now.\n\
- Do not call done. Do not open a delivery card. Do not list the whole project.\n\
- If the user asked to simplify, rewrite the previous answer in 2-5 short everyday sentences.\n\
- Never finish with only thinking or \"let me give a simpler version\".\n";

const CHANGE_DIRECTOR: &str = "\nDIRECTOR JOB: CHANGE\n\
- Apply the smallest coherent patch, run one relevant check, then stop.\n\
- Do not turn this into a broad audit. Call done only after the patch exists.\n";

const SHIP_DIRECTOR: &str = "\nDIRECTOR JOB: SHIP\n\
- Treat this as one durable task: inspect, implement focused changes, validate, debug failures, then deliver.\n\
- Take concrete tool actions instead of stopping at a plan. Before done, inspect changed files and run the most relevant check.\n\
- The desktop host shows task progress separately. Keep user-facing updates concise and never ask the user to type \"continue\".\n";

const OPERATE_DIRECTOR: &str = "\nDIRECTOR JOB: OPERATE\n\
- Drive Preview or Desktop with observe → act → check. A failed check is not completion.\n\
- Do not write a delivery essay. Stop when the requested UI evidence exists.\n";

/// Host-owned job for this run. Answer never uses the build ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectorJob {
    Answer,
    Change,
    Ship,
    Operate,
}

impl DirectorJob {
    pub const fn uses_ledger(self) -> bool {
        !matches!(self, Self::Answer)
    }

    pub const fn allows_done(self) -> bool {
        !matches!(self, Self::Answer)
    }
}

pub fn infer_director_job(
    prompt: &str,
    permission_mode: &str,
    computer_use_enabled: bool,
    requires_project_completion: bool,
    fast_execution: bool,
) -> DirectorJob {
    let text = prompt.trim().to_ascii_lowercase();
    if matches!(permission_mode, "ask" | "research" | "plan") {
        return DirectorJob::Answer;
    }
    if is_answer_prompt(&text) && !looks_like_code_change(&text) {
        return DirectorJob::Answer;
    }
    if computer_use_enabled && is_operate_prompt(&text) {
        return DirectorJob::Operate;
    }
    if fast_execution {
        return DirectorJob::Change;
    }
    if requires_project_completion {
        return DirectorJob::Ship;
    }
    if permission_mode == "multi_agent" || permission_mode == "build" {
        return DirectorJob::Change;
    }
    DirectorJob::Answer
}

fn looks_like_code_change(text: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "can you change",
        "could you change",
        "please change",
        "can you add",
        "can you create",
        "can you make",
        "could you make",
        "please make",
        "make md",
        "make a file",
        "save this as",
        "save it as",
        "can you build",
        "can you implement",
        "can you fix",
        "can you update",
        "can you rename",
        "can you edit",
        "can you replace",
        "can you delete",
        "can you remove",
        "change this",
        "change that",
        "change it",
        "changing this",
        "update this",
        "rename this",
        "edit this",
        "replace this",
        "delete this",
        "remove this",
        "fix this",
        "add this",
        "change the title",
        "change the heading",
        "change the header",
        "make this say",
        "make it say",
        "apply this change",
        "apply the change",
        "make the change",
        "make the edit",
    ];
    if NEEDLES.iter().any(|needle| text.contains(needle)) {
        return true;
    }
    [
        "change ",
        "changing ",
        "rename ",
        "update ",
        "edit ",
        "replace ",
        "modify ",
        "delete ",
        "remove ",
        "add ",
        "fix ",
        "implement ",
        "create ",
        "build ",
        "patch ",
        "tweak ",
        "adjust ",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn is_answer_prompt(text: &str) -> bool {
    text.contains("simplif")
        || text.contains("make it simpler")
        || text.contains("make it shorter")
        || text.contains("make this simpler")
        || text.contains("in simple terms")
        || text.contains("shorter explanation")
        || text.starts_with("what ")
        || text.starts_with("why ")
        || text.starts_with("where ")
        || text.starts_with("how ")
        || text.starts_with("explain")
        || text.contains("can you explain")
        || text.contains("can you simplify")
        || text.contains("could you simplify")
        || text.contains("describe ")
        || text.contains("full path")
        || text.contains("full directory")
        || text.contains("tell me about")
        || text.contains("tell me where")
}

fn is_operate_prompt(text: &str) -> bool {
    text.contains("computer use")
        || text.contains("desktop mode")
        || text.contains("playwright")
        || text.contains("click the")
        || text.contains("type in the")
        || text.contains("open preview")
}

#[derive(Clone, Serialize)]
struct SmartAgentEvent {
    kind: String,
    session_id: String,
    payload: Value,
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    let _ = app.emit(
        "agent",
        SmartAgentEvent {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            payload,
        },
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Scope,
    Inspect,
    Implement,
    Validate,
    Debug,
    Deliver,
}

impl Phase {
    const fn index(self) -> usize {
        match self {
            Self::Scope => 0,
            Self::Inspect => 1,
            Self::Implement => 2,
            Self::Validate => 3,
            Self::Debug => 4,
            Self::Deliver => 5,
        }
    }

    const fn id(self) -> &'static str {
        STEP_IDS[self.index()]
    }
}

/// A short-lived ledger for one agent run. Its public events contain only
/// fixed UI labels and a status message; prompts, commands, file contents, and
/// credentials never enter this telemetry channel.
#[derive(Debug)]
pub struct SmartAgentRun {
    job: DirectorJob,
    settings_enabled: bool,
    enabled: bool,
    fast_execution: bool,
    phase: Phase,
    final_review_requested: bool,
    saw_validation: bool,
    saw_debug: bool,
    saw_successful_change: bool,
    validation_tool_ids: HashSet<String>,
    debug_tool_ids: HashSet<String>,
    change_tool_ids: HashSet<String>,
    iteration: u32,
    timeline_enabled: bool,
}

pub type DirectorRun = SmartAgentRun;

impl SmartAgentRun {
    pub fn new(enabled: bool, fast_execution: bool) -> Self {
        Self::for_job(
            if fast_execution {
                DirectorJob::Change
            } else {
                DirectorJob::Ship
            },
            enabled,
            fast_execution,
        )
    }

    pub fn for_job(job: DirectorJob, settings_enabled: bool, fast_execution: bool) -> Self {
        Self {
            job,
            settings_enabled,
            enabled: settings_enabled && job.uses_ledger(),
            fast_execution,
            phase: match job {
                DirectorJob::Change | DirectorJob::Operate => Phase::Inspect,
                _ => Phase::Scope,
            },
            final_review_requested: false,
            saw_validation: false,
            saw_debug: false,
            saw_successful_change: false,
            validation_tool_ids: HashSet::new(),
            debug_tool_ids: HashSet::new(),
            change_tool_ids: HashSet::new(),
            iteration: 0,
            timeline_enabled: false,
        }
    }

    pub fn set_iteration(&mut self, iteration: u32) {
        self.iteration = iteration;
    }

    pub fn enable_build_timeline(&mut self) {
        self.timeline_enabled = true;
    }

    pub const fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub const fn job(&self) -> DirectorJob {
        self.job
    }

    pub const fn allows_done(&self) -> bool {
        self.job.allows_done()
    }

    /// Plan → Apply must be allowed to call `done`, otherwise the Completed
    /// card never appears after implementation.
    pub fn promote_to_change(&mut self, app: &AppHandle, session_id: &str) {
        let iteration = self.iteration;
        *self = Self::for_job(
            DirectorJob::Change,
            self.settings_enabled,
            self.fast_execution,
        );
        self.iteration = iteration;
        self.timeline_enabled = true;
        self.emit_plan(app, session_id);
    }

    fn ledger_ids_labels(&self) -> (&'static [&'static str], &'static [&'static str]) {
        match self.job {
            DirectorJob::Change => (&CHANGE_STEP_IDS, &CHANGE_STEP_LABELS),
            DirectorJob::Operate => (&OPERATE_STEP_IDS, &OPERATE_STEP_LABELS),
            _ => (&STEP_IDS, &STEP_LABELS),
        }
    }

    fn ledger_step(&self) -> usize {
        match self.job {
            DirectorJob::Change | DirectorJob::Operate => match self.phase {
                Phase::Scope | Phase::Inspect => 0,
                Phase::Implement => 1,
                Phase::Validate | Phase::Debug | Phase::Deliver => 2,
            },
            _ => self.phase.index(),
        }
    }

    /// Provider-facing instruction that makes the reasoning process more
    /// deliberate without asking the model to expose private chain-of-thought.
    pub fn system_instructions(enabled: bool, fast_execution: bool) -> &'static str {
        if !enabled {
            return "";
        }
        Self::job_instructions(
            if fast_execution {
                DirectorJob::Change
            } else {
                DirectorJob::Ship
            },
            true,
            fast_execution,
        )
    }

    pub fn job_instructions(
        job: DirectorJob,
        settings_enabled: bool,
        fast_execution: bool,
    ) -> &'static str {
        match job {
            DirectorJob::Answer => ANSWER_DIRECTOR,
            DirectorJob::Change if settings_enabled && fast_execution => {
                "\nFAST EXECUTION LEDGER:\n\
- Treat this as one short, selected-target change when source hints exist; otherwise keep it equally focused. Use cached project intelligence, apply the smallest coherent patch, and run only the cheapest relevant check.\n\
- Do not turn the task into a broad audit or a multi-stage redesign. Expand discovery once only when the focused target is wrong.\n\
- After a successful focused check (or a targeted source re-read when no quick validator exists), call done immediately with a concise result.\n"
            }
            DirectorJob::Change if settings_enabled => CHANGE_DIRECTOR,
            DirectorJob::Ship if settings_enabled => SHIP_DIRECTOR,
            DirectorJob::Operate if settings_enabled => OPERATE_DIRECTOR,
            _ => "",
        }
    }

    pub fn emit_plan(&self, app: &AppHandle, session_id: &str) {
        if !self.enabled {
            return;
        }
        let (ids, labels) = self.ledger_ids_labels();
        let steps = ids
            .iter()
            .zip(labels.iter())
            .enumerate()
            .map(|(index, (id, label))| {
                json!({
                    "id": id,
                    "label": label,
                    "state": if index == 0 { "active" } else { "pending" },
                })
            })
            .collect::<Vec<_>>();
        let summary = match self.job {
            DirectorJob::Change => {
                "Applying a focused patch and checking only the requested result."
            }
            DirectorJob::Operate => {
                "Observing Preview or Desktop, acting, then checking the result."
            }
            _ => "Keeping this task focused, verified, and moving without manual continue prompts.",
        };
        emit(
            app,
            session_id,
            "task_plan",
            json!({
                "title": "Director",
                "summary": summary,
                "steps": steps,
                "active_step": 0,
                "status": "working",
            }),
        );
    }

    fn transition(&mut self, app: &AppHandle, session_id: &str, phase: Phase, detail: &str) {
        if !self.enabled || phase < self.phase {
            return;
        }
        self.phase = phase;
        let step = self.ledger_step();
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": step,
                "phase": phase.id(),
                "status": "active",
                "detail": detail,
                "completed_before": step,
            }),
        );
        if self.timeline_enabled {
            emit_build_progress(
                app,
                session_id,
                self.iteration,
                phase.id(),
                "active",
                detail,
                false,
            );
        }
    }

    /// A successful check only applies to the exact workspace state that was
    /// checked. If a later tool can change that state, require fresh evidence
    /// before allowing the run to finish.
    fn reset_validation_after_change(&mut self) {
        if self.phase >= Phase::Validate {
            self.phase = Phase::Implement;
            self.saw_validation = false;
            self.saw_debug = false;
            self.validation_tool_ids.clear();
            self.debug_tool_ids.clear();
        }
    }

    fn begin_implementation(&mut self, app: &AppHandle, session_id: &str, detail: &str) {
        self.reset_validation_after_change();
        self.transition(app, session_id, Phase::Implement, detail);
    }

    fn begin_debug(&mut self, app: &AppHandle, session_id: &str, tool_id: &str, detail: &str) {
        if !tool_id.trim().is_empty() {
            self.debug_tool_ids.insert(tool_id.to_string());
        }
        self.transition(app, session_id, Phase::Debug, detail);
    }

    pub fn on_tool_call(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        tool_id: &str,
        name: &str,
        arguments: &Value,
    ) {
        if !self.enabled {
            return;
        }

        let name = name.trim();
        match name {
            "read_file" | "list_dir" | "glob" | "grep" | "file_info" | "git_status" => {
                if self.phase >= Phase::Validate {
                    self.begin_debug(
                        app,
                        session_id,
                        tool_id,
                        "Debugging failures and inspecting runtime evidence...",
                    );
                } else {
                    self.transition(
                        app,
                        session_id,
                        Phase::Inspect,
                        "Inspecting the current workspace...",
                    );
                }
            }
            "write_file" | "edit_file" | "make_dir" | "move_file" | "copy_file"
            | "download_file" | "git_init" | "apply_patch" | "create_file" | "delete_file"
            | "rename_file" => {
                if !tool_id.trim().is_empty() {
                    self.change_tool_ids.insert(tool_id.to_string());
                }
                if self.phase >= Phase::Validate {
                    // Fixing issues found during Check stays in Debug, but the
                    // previous Check no longer covers this new workspace state.
                    self.saw_validation = false;
                    self.saw_debug = false;
                    self.validation_tool_ids.clear();
                    self.begin_debug(app, session_id, tool_id, "Applying a focused debug fix...");
                } else {
                    self.begin_implementation(app, session_id, "Applying the requested changes...");
                }
            }
            name if is_command_tool(name) => {
                let command = ["command", "cmd", "script"]
                    .iter()
                    .find_map(|key| arguments.get(*key).and_then(Value::as_str))
                    .unwrap_or("");
                if is_debug_command(command) {
                    self.begin_debug(app, session_id, tool_id, "Running a focused debug pass...");
                } else if is_validation_command(command) {
                    if !tool_id.trim().is_empty() {
                        self.validation_tool_ids.insert(tool_id.to_string());
                    }
                    // Re-checking after a debug fix stays in Debug once Check
                    // has already happened; otherwise enter Check.
                    if self.phase >= Phase::Debug || self.saw_validation {
                        self.begin_debug(
                            app,
                            session_id,
                            tool_id,
                            "Re-checking after a debug fix...",
                        );
                    } else {
                        self.transition(
                            app,
                            session_id,
                            Phase::Validate,
                            "Running a focused validation check...",
                        );
                    }
                } else {
                    if is_mutating_command(command) && !tool_id.trim().is_empty() {
                        self.change_tool_ids.insert(tool_id.to_string());
                    }
                    self.begin_implementation(
                        app,
                        session_id,
                        "Working through the requested implementation...",
                    );
                }
            }
            "open_path" => {
                if self.phase >= Phase::Validate {
                    self.begin_debug(
                        app,
                        session_id,
                        tool_id,
                        "Debugging the generated result in preview...",
                    );
                } else if self.phase >= Phase::Implement {
                    if !tool_id.trim().is_empty() {
                        self.validation_tool_ids.insert(tool_id.to_string());
                    }
                    self.transition(
                        app,
                        session_id,
                        Phase::Validate,
                        "Checking the generated result in preview...",
                    );
                }
            }
            "done" => {
                if self.saw_validation || self.phase >= Phase::Validate {
                    self.transition(
                        app,
                        session_id,
                        Phase::Debug,
                        "Final debug review before delivery...",
                    );
                } else {
                    self.transition(
                        app,
                        session_id,
                        Phase::Validate,
                        "Reviewing the result before delivery...",
                    );
                }
            }
            _ => {
                if self.phase <= Phase::Inspect {
                    self.begin_implementation(
                        app,
                        session_id,
                        "Taking the next concrete task step...",
                    );
                } else if self.phase >= Phase::Validate {
                    self.begin_debug(app, session_id, tool_id, "Debugging the current issue...");
                }
            }
        }
    }

    pub fn on_tool_result(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        tool_id: &str,
        _name: &str,
        ok: bool,
    ) {
        if !self.enabled {
            return;
        }
        let was_change = self.change_tool_ids.remove(tool_id);
        if was_change && ok {
            self.saw_successful_change = true;
        }
        let was_validation = self.validation_tool_ids.remove(tool_id);
        let was_debug = self.debug_tool_ids.remove(tool_id);
        if was_validation {
            if ok {
                self.saw_validation = true;
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Validation passed — debugging and hardening the result...",
                );
            } else {
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Validation failed — investigating and fixing issues...",
                );
            }
            return;
        }
        if was_debug {
            if ok {
                self.saw_debug = true;
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Debug pass completed successfully.",
                );
            } else {
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Debug evidence found issues — continuing the fix loop...",
                );
            }
        }
    }

    /// A single review pass catches the common case where a model emits done
    /// after edits but before testing. It is deliberately bounded so a weak
    /// provider cannot be trapped in an endless self-review loop.
    pub fn needs_final_review(&self) -> bool {
        self.enabled
            && !self.final_review_requested
            && !self.saw_validation
            && (!self.fast_execution || !self.saw_successful_change)
    }

    pub fn request_final_review(&mut self, app: &AppHandle, session_id: &str) -> bool {
        if !self.needs_final_review() {
            return false;
        }
        self.final_review_requested = true;
        self.transition(
            app,
            session_id,
            Phase::Validate,
            "Checking changed files and completion evidence before delivery...",
        );
        true
    }

    pub fn final_review_instruction() -> &'static str {
        "[System - Director verification]\n\
Before declaring this task complete, inspect the actual workspace state and perform the most relevant validation now (build, test, check, lint, preview, or a targeted file inspection when no validator exists).\n\
If checks fail or the runtime looks wrong, debug the failure (read errors/logs, reproduce, fix, and re-check) before delivering.\n\
Fix any issue you find. Do not repeat completed work or ask the user to type \"continue\".\n\
When the requested work is genuinely complete, call done with a concise, evidence-based summary."
    }

    pub fn complete(&mut self, app: &AppHandle, session_id: &str) {
        if !self.enabled {
            return;
        }
        self.phase = Phase::Deliver;
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": self.ledger_step(),
                "phase": Phase::Deliver.id(),
                "status": "completed",
                "detail": "Task complete and ready to deliver.",
                "complete_all": true,
            }),
        );
    }

    pub fn pause(&self, app: &AppHandle, session_id: &str, detail: &str) {
        if !self.enabled {
            return;
        }
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": self.ledger_step(),
                "phase": self.phase.id(),
                "status": "paused",
                "detail": detail,
            }),
        );
        if self.timeline_enabled {
            emit_build_progress(
                app,
                session_id,
                self.iteration,
                self.phase.id(),
                "paused",
                detail,
                false,
            );
        }
    }
}

fn is_validation_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        " test",
        "test ",
        "npm test",
        "pnpm test",
        "yarn test",
        "cargo test",
        "cargo check",
        "npm run build",
        "pnpm build",
        "yarn build",
        "npm run check",
        "pnpm check",
        "yarn check",
        " typecheck",
        " lint",
        "pytest",
        "vitest",
        "jest",
        "playwright",
        "verify",
        "validate",
        "compile",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn is_debug_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    // Prefer explicit debug tooling tokens. Avoid matching path segments like
    // `target/debug/app`, which are common during normal builds.
    [
        "debugger",
        "--debug",
        "stacktrace",
        "stack trace",
        "traceback",
        "console.error",
        "console error",
        "rust-gdb",
        "lldb",
        "gdb ",
        "strace",
        "journalctl",
        "node --inspect",
        "--inspect-brk",
        "--inspect ",
        "chrome://inspect",
        "npm run debug",
        "pnpm debug",
        "yarn debug",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn is_mutating_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        "set-content",
        "add-content",
        "out-file",
        "tee-object",
        "new-item",
        "copy-item",
        "move-item",
        "remove-item",
        "apply_patch",
        "npm install",
        "pnpm add",
        "yarn add",
        "bun add",
        "cargo add",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn is_command_tool(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    matches!(
        name.as_str(),
        "run_command"
            | "start_dev_server"
            | "run_terminal"
            | "run_terminal_cmd"
            | "execute_command"
            | "shell"
    ) || name.contains("command")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_review_is_requested_without_validation() {
        let run = SmartAgentRun::new(true, false);
        assert!(run.needs_final_review());
    }

    #[test]
    fn validation_command_is_detected_without_matching_plain_inspection() {
        assert!(is_validation_command("npm run build"));
        assert!(is_validation_command("cargo test --locked"));
        assert!(!is_validation_command("npm install"));
        assert!(!is_validation_command("Get-Content README.md"));
    }

    #[test]
    fn debug_command_is_detected() {
        assert!(is_debug_command("node --inspect server.js"));
        assert!(is_debug_command("lldb ./target/release/app"));
        assert!(is_debug_command("python -m traceback runner.py"));
        assert!(is_debug_command("npm run debug"));
        assert!(!is_debug_command("npm install"));
        assert!(!is_debug_command("npm run build"));
        assert!(!is_debug_command("./target/debug/app"));
    }

    #[test]
    fn mutating_commands_are_distinct_from_read_only_inspection() {
        assert!(is_mutating_command(
            "Set-Content -Path src/app.css -Value $css"
        ));
        assert!(is_mutating_command("npm install lucide-react"));
        assert!(!is_mutating_command("rg -n status src"));
        assert!(!is_mutating_command("Get-Content src/app.css"));
    }

    #[test]
    fn build_timeline_hides_provider_reasoning_and_bounds_progress() {
        assert!(is_build_timeline_mode("build"));
        assert!(is_build_timeline_mode("FULL"));
        assert!(!is_build_timeline_mode("ask"));
        assert!(hide_provider_reasoning("build", false));
        assert!(hide_provider_reasoning("plan", true));
        assert!(!hide_provider_reasoning("plan", false));
        assert!(!hide_provider_reasoning("ask", false));
        let long = "Inspecting the workspace. ".repeat(80);
        let bounded = bound_public_progress(&long);
        assert!(bounded.chars().count() <= PUBLIC_PROGRESS_MAX);
        assert!(bounded.ends_with('…'));
        assert_eq!(
            bound_public_progress("  Inspecting   the\ncurrent workspace.  "),
            "Inspecting the current workspace."
        );
    }

    #[test]
    fn disabled_smart_agent_never_requests_review() {
        let run = SmartAgentRun::new(false, false);
        assert!(!run.needs_final_review());
        assert!(!run.is_enabled());
    }

    #[test]
    fn successful_fast_design_change_skips_a_second_model_review() {
        let mut fast = SmartAgentRun::new(true, true);
        fast.saw_successful_change = true;
        assert!(!fast.needs_final_review());

        let mut regular = SmartAgentRun::new(true, false);
        regular.saw_successful_change = true;
        assert!(regular.needs_final_review());
    }

    #[test]
    fn fast_design_instructions_stay_targeted() {
        let instructions = SmartAgentRun::system_instructions(true, true);
        assert!(instructions.contains("one short, selected-target change"));
        assert!(instructions.contains("call done immediately"));
        assert!(!instructions.contains("actively debug failures"));
    }

    #[test]
    fn later_changes_invalidate_an_earlier_successful_check() {
        let mut run = SmartAgentRun::new(true, false);
        run.phase = Phase::Validate;
        run.saw_validation = true;
        run.validation_tool_ids.insert("previous-check".into());

        run.reset_validation_after_change();

        assert_eq!(run.phase, Phase::Implement);
        assert!(!run.saw_validation);
        assert!(!run.saw_debug);
        assert!(run.validation_tool_ids.is_empty());
        assert!(run.debug_tool_ids.is_empty());
        assert!(run.needs_final_review());
    }

    #[test]
    fn successful_validation_advances_into_debug() {
        let mut run = SmartAgentRun::new(true, false);
        run.phase = Phase::Validate;
        run.validation_tool_ids.insert("check-1".into());
        // AppHandle is unavailable in unit tests; only assert ledger fields.
        let was_validation = run.validation_tool_ids.remove("check-1");
        assert!(was_validation);
        run.saw_validation = true;
        run.phase = Phase::Debug;
        assert_eq!(run.phase, Phase::Debug);
        assert!(run.saw_validation);
        assert_eq!(Phase::Debug.index(), 4);
        assert_eq!(Phase::Deliver.index(), 5);
        assert_eq!(STEP_IDS[4], "debug");
        assert_eq!(STEP_LABELS[4], "Debug");
    }

    #[test]
    fn cursor_terminal_commands_are_classified_as_commands() {
        assert!(is_command_tool("run_terminal_cmd"));
        assert!(is_command_tool("execute_command"));
        assert!(is_command_tool("start_dev_server"));
        assert!(!is_command_tool("read_file"));
    }

    #[test]
    fn director_classifies_questions_as_answer_jobs() {
        let simplify = infer_director_job(
            "can you simplify your explaination regarding back to work process",
            "multi_agent",
            false,
            true,
            false,
        );
        assert_eq!(simplify, DirectorJob::Answer);
        assert!(!simplify.uses_ledger());
        assert!(!simplify.allows_done());

        let answer = SmartAgentRun::for_job(DirectorJob::Answer, true, false);
        assert!(!answer.is_enabled());
        assert!(!answer.needs_final_review());
        assert!(!answer.allows_done());
        assert!(
            SmartAgentRun::job_instructions(DirectorJob::Answer, true, false).contains("ANSWER")
        );
    }

    #[test]
    fn director_keeps_ship_verification_for_build_work() {
        let ship = infer_director_job(
            "build a payroll dashboard and keep working until it is verified",
            "multi_agent",
            false,
            true,
            false,
        );
        assert_eq!(ship, DirectorJob::Ship);
        let run = SmartAgentRun::for_job(ship, true, false);
        assert!(run.is_enabled());
        assert!(run.needs_final_review());
        assert!(run.allows_done());
    }

    #[test]
    fn director_maps_fast_edits_to_change_and_computer_use_to_operate() {
        assert_eq!(
            infer_director_job("change the header color", "build", false, true, true),
            DirectorJob::Change
        );
        assert_eq!(
            infer_director_job(
                "change this title to atindans",
                "multi_agent",
                false,
                false,
                false,
            ),
            DirectorJob::Change
        );
        assert_eq!(
            infer_director_job(
                "click the submit button in preview",
                "multi_agent",
                true,
                true,
                false,
            ),
            DirectorJob::Operate
        );
        assert_eq!(
            infer_director_job(
                "im planning to add sms for approvals",
                "plan",
                false,
                false,
                false,
            ),
            DirectorJob::Answer
        );
        assert!(!SmartAgentRun::for_job(DirectorJob::Answer, true, false).allows_done());
        assert!(SmartAgentRun::for_job(DirectorJob::Change, true, false).allows_done());
    }
}
