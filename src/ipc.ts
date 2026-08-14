// Typed wrappers for Tauri invoke + event listening
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type Settings = {
  provider: string;
  model: string;
  base_url: string | null;
  /** Legacy setting retained for older desktop releases; agent runs are unbounded. */
  max_iterations: number;
  command_timeout_secs: number;
  auto_approve: boolean;
  /** plan | auto | ask | full | multi_agent (research is a legacy alias for ask) */
  permission_mode: string;
  /** thinking | guided | agent | balanced | investigate | brief | autonomous | max */
  capability_mode: string;
  /** Reply in Taglish when enabled */
  taglish: boolean;
  /** Keep Preview Computer Use available for every request. */
  computer_use_enabled: boolean;
  /** Allow explicit chat prompts to activate Preview Computer Use for one request. */
  computer_use_prompt_activation: boolean;
  /** Opt-in native Windows Desktop Computer Use. Off by default. */
  desktop_computer_use_enabled: boolean;
  /** Optional process names the Desktop agent may control. Empty = all ordinary apps except the blocklist. */
  desktop_computer_use_allowed_apps: string[];
  /** Keep long build tasks on a durable plan and request a final verification pass. */
  smart_agent_enabled: boolean;
  /** Recall bounded project preferences and private per-session working memory. */
  flavour_enabled: boolean;
  /** Cursor SDK effort: light | medium | high | xhigh | ultra */
  model_effort?: string;
};

/** Non-secret provider/model/effort selection imported from the standard app. */
export type OriginalModelSelection = {
  provider: string;
  model: string;
  model_effort: string;
};

/** Host-side execution profile selected by an in-app surface. */
export type AgentTaskProfile =
  | "default"
  | "design_edit"
  | "design_edit_fast";

/** Speed, verification, and rollback policy; Auto is resolved by the host. */
export type AgentExecutionProfile = "auto" | "fast" | "balanced" | "thorough" | "safe";

export type CheckpointSummary = {
  id: string;
  sessionId: string;
  projectRoot: string;
  profile: Exclude<AgentExecutionProfile, "auto">;
  status: string;
  actionCount: number;
  protectedPaths: number;
  conflictCount: number;
  commandSideEffectsUnprotected: boolean;
  unprotectedActions: number;
  createdAtMs: number;
  finishedAtMs: number | null;
};

export type RollbackResult = {
  checkpointId: string;
  rolledBackActions: number;
  restoredPaths: number;
  conflicts: string[];
  status: string;
  message: string;
};

export type Provider = "deepseek" | "openrouter" | "glm" | "openai" | "cursor" | "hormachuelos_free" | "anthropic" | "gemini" | "ollama" | "pollinations";

export type ConnectionTestResult = {
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string;
};

/** Safe, server-issued hosted provider catalog. It never contains API keys or upstream URLs. */
export type HostedProviderCatalogModel = {
  id: string;
  label: string;
};

export type HostedProviderCatalogEntry = {
  id: string;
  label: string;
  models: HostedProviderCatalogModel[];
};

export type HostedProviderCatalogResult = {
  data: HostedProviderCatalogEntry[];
  restricted?: boolean;
};

export type ComputerUseStatus = {
  supported: boolean;
  paused: boolean;
  emergencyShortcut: string;
  emergencyShortcutAvailable: boolean;
  scope: "active-preview-tab-only";
  autoApproved: boolean;
};

export type DesktopComputerUseStatus = {
  supported: boolean;
  paused: boolean;
  emergencyShortcut: string;
  emergencyShortcutAvailable: boolean;
};

export type ComputerUseTarget = {
  id: string;
  title: string;
  processName: string;
  processId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isForeground: boolean;
  isMinimized: boolean;
};

export type PreviewComputerRequest = {
  requestId: string;
  protocolVersion: number;
  operation: "observe" | "actions";
  args: Record<string, unknown>;
};

export type PreviewComputerStop = {
  requestId?: string;
  reason?: string;
};

export type ComputerUseFxEvent = {
  kind: string;
  x: number;
  y: number;
  text?: string | null;
  charIndex?: number | null;
  totalChars?: number | null;
  gesture?: string | null;
  width?: number | null;
  height?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
};

export type AppUpdateProgress = {
  phase: "preparing" | "downloading" | "verifying" | "installing" | "restarting" | "error";
  percent?: number | null;
  message?: string | null;
};

export type ProjectNode = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
  children: ProjectNode[];
  truncated: boolean;
};

export type ProjectTree = {
  nodes: ProjectNode[];
  truncated: boolean;
};

export type FilePreview = {
  path: string;
  content: string;
  size: number;
  language: string;
};

export type DesignDomContext = {
  id: string;
  classes: string[];
  role: string;
  ariaLabel: string;
  testId: string;
  name: string;
  href: string;
  html: string;
};

export type DesignTargetProbe = {
  previewUrl: string;
  point?: { x: number; y: number } | null;
  tag?: string;
  text?: string;
  selector?: string;
  domContext?: DesignDomContext | null;
  styleSelectors?: string[];
  sourceFile?: string;
  sourceLine?: number | null;
  sourceColumn?: number | null;
};

export type DesignSourceLocation = {
  path: string;
  line: number;
  column?: number | null;
  kind: "frontend" | "style" | "backend";
  confidence: "exact" | "strong" | "likely";
  symbol?: string | null;
};

export type DesignTargetResolution = {
  tag: string;
  text: string;
  selector: string;
  domContext: DesignDomContext;
  rect?: { x: number; y: number; width: number; height: number } | null;
  sources: DesignSourceLocation[];
  inspectedBy: "webview" | "dom" | "visual";
  indexPartial: boolean;
};

export type PreviewBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PreviewBrowserTarget = {
  tag: string;
  text: string;
  selector: string;
  domContext: DesignDomContext;
  rect: { x: number; y: number; width: number; height: number };
  styleSelectors: string[];
  sourceFile: string;
  sourceLine?: number | null;
  sourceColumn?: number | null;
};

export type PreviewBrowserFeedback = {
  selector: string;
  lines: Array<{
    kind: "frontend" | "style" | "backend" | "likely" | "target";
    text: string;
  }>;
};

export type PreviewBrowserEvent = {
  label: string;
  kind:
    | "loading"
    | "ready"
    | "title"
    | "popup"
    | "blocked"
    | "inspect-hover"
    | "inspect-select"
    | "inspect-cancel";
  url?: string | null;
  title?: string | null;
  target?: PreviewBrowserTarget | null;
};

export type ClientPackResult = {
  zipPath: string;
  filesCount: number;
  handoffPath: string;
};

export type ClipboardVideoImportResult = {
  /** Private attachment paths already copied out of Explorer/Snipping Tool storage. */
  paths: string[];
  /** Per-file validation/import failures safe to surface in the composer. */
  errors: string[];
};

export type ProjectTemplate = {
  id: string;
  label: string;
  blurb: string;
};

export type LicenseStatus = {
  plan: string;
  active: boolean;
  expiresAt: string;
  email: string;
  tokenBudget: number;
  tokensUsed: number;
  topUpUrl: string;
  message: string;
  /** Recent activity telemetry; these fields never enforce a usage limit. */
  window4hUsed?: number;
  window4hStartedAt?: string;
  window4hBudget?: number;
  window4hResetsAt?: string;
  windowWeekUsed?: number;
  windowWeekStartedAt?: string;
  windowWeekBudget?: number;
  windowWeekResetsAt?: string;
  /** "" | "plan" — only an empty hosted plan wallet blocks use. */
  blockedBy?: string;
  /** Dev bypass — limits not enforced (debug builds). */
  limitsDisabled?: boolean;
  /** True when entitlement was verified against the hosted API. */
  hosted?: boolean;
  /** Server-issued HORMA-… key used as Bearer for the hosted proxy. */
  licenseKey?: string;
};

export const api = {
  getProjectRoot: (): Promise<string | null> => invoke("get_project_root"),
  setProjectRoot: (path: string): Promise<void> => invoke("set_project_root", { path }),
  listRecentProjects: (): Promise<string[]> => invoke("list_recent_projects"),
  /** Forget one recent project without deleting its folder or files. */
  removeRecentProject: (path: string): Promise<boolean> => invoke("remove_recent_project", { path }),
  getSettings: (): Promise<Settings> => invoke("get_settings"),
  /** Copies only provider, model, and effort from the standard app; never credentials. */
  getOriginalModelSelection: (): Promise<OriginalModelSelection | null> =>
    invoke("get_original_model_selection"),
  saveSettings: (settings: Settings): Promise<void> => invoke("save_settings", { settings }),
  getComputerUseStatus: (): Promise<ComputerUseStatus> => invoke("get_computer_use_status"),
  setComputerUsePaused: (paused: boolean): Promise<ComputerUseStatus> =>
    invoke("set_computer_use_paused", { paused }),
  getDesktopComputerUseStatus: (): Promise<DesktopComputerUseStatus> =>
    invoke("get_desktop_computer_use_status"),
  listComputerUseTargets: (): Promise<{ windows?: ComputerUseTarget[] }> =>
    invoke("list_computer_use_targets"),
  respondPreviewComputer: (
    requestId: string,
    ok: boolean,
    result?: Record<string, unknown> | null,
    error?: string | null,
  ): Promise<void> => invoke("respond_preview_computer", {
    requestId,
    ok,
    result: result ?? null,
    error: error ?? null,
  }),
  setApiKey: (provider: string, key: string): Promise<void> => invoke("set_api_key", { provider, key }),
  hasApiKey: (provider: string): Promise<boolean> => invoke("has_api_key", { provider }),
  clearApiKey: (provider: string): Promise<void> => invoke("clear_api_key", { provider }),
  setWebsiteSession: (token: string): Promise<void> => invoke("set_website_session", { token }),
  getWebsiteSession: (): Promise<string | null> => invoke("get_website_session"),
  clearWebsiteSession: (): Promise<void> => invoke("clear_website_session"),
  openExternalUrl: (url: string): Promise<void> => invoke("open_external_url", { url }),
  respondToQuestion: (answer: string, sessionId: string): Promise<void> =>
    invoke("respond_to_question", { answer, sessionId }),
  respondToConfirm: (approved: boolean, sessionId: string): Promise<void> =>
    invoke("respond_to_confirm", { approved, sessionId }),
  testProviderConnection: (provider: string, model: string, baseUrl: string | null): Promise<ConnectionTestResult> =>
    invoke("test_provider_connection", { provider, model, baseUrl }),
  listProviderModels: (provider: string, baseUrl: string | null): Promise<string[]> =>
    invoke("list_provider_models", { provider, baseUrl }),
  listHostedProviderCatalog: (): Promise<HostedProviderCatalogResult | HostedProviderCatalogEntry[]> =>
    invoke("list_hosted_provider_catalog"),
  createProjectDir: (path: string, templateId?: string): Promise<void> =>
    invoke("create_project_dir", { path, templateId: templateId ?? null }),
  /** True when a parent folder is itself an existing source project (manifest + layout/.git). */
  checkProjectParentIsExistingProject: (path: string): Promise<boolean> =>
    invoke("check_project_parent_is_existing_project", { path }),
  /** Create or reopen Hormachuelos' private no-folder workspace for quick sessions. */
  ensureQuickSessionWorkspace: (): Promise<string> => invoke("ensure_quick_session_workspace"),
  listProjectTemplates: (): Promise<ProjectTemplate[]> => invoke("list_project_templates"),
  listProjectFiles: (maxDepth = 8): Promise<ProjectTree> => invoke("list_project_files", { maxDepth }),
  readProjectFile: (relativePath: string): Promise<FilePreview> => invoke("read_project_file", { relativePath }),
  /** Permanently delete one regular file inside the active project. */
  deleteProjectFile: (relativePath: string): Promise<void> =>
    invoke("delete_project_file", { relativePath }),
  writePreviewComputerSpec: (relativePath: string, contents: string): Promise<string> =>
    invoke("write_preview_computer_spec", { relativePath, contents }),
  /** Clear active-project contents while keeping the project directory and .git history. */
  clearProjectFiles: (): Promise<number> => invoke("clear_project_files"),
  /** Durable agent-owned workspace checkpoints, newest first. */
  listRunCheckpoints: (projectRoot?: string | null): Promise<CheckpointSummary[]> =>
    invoke("list_run_checkpoints", { projectRoot: projectRoot ?? null }),
  /** Conflict-aware undo; newer user edits are preserved instead of overwritten. */
  rollbackRunCheckpoint: (
    checkpointId: string,
    scope: "last_action" | "run" = "run",
  ): Promise<RollbackResult> =>
    invoke("rollback_run_checkpoint", { checkpointId, scope }),
  exportClientPack: (destPath?: string, handoffSummary?: string): Promise<ClientPackResult> =>
    invoke("export_client_pack", {
      destPath: destPath ?? null,
      handoffSummary: handoffSummary ?? null,
    }),
  getLicenseStatus: (): Promise<LicenseStatus> => invoke("get_license_status"),
  applyLicenseKey: (key: string): Promise<LicenseStatus> => invoke("apply_license_key", { key }),
  /** Account-wide token burn (persisted in license.json — not per project). */
  recordLicenseUsage: (tokens: number): Promise<LicenseStatus> =>
    invoke("record_license_usage", { tokens: Math.max(0, Math.floor(tokens || 0)) }),
  /** Save a clipboard/drag-drop image to a temp file; returns absolute path. */
  savePastedImage: (dataBase64: string, mime?: string | null): Promise<string> =>
    invoke("save_pasted_image", { dataBase64, mime: mime ?? null }),
  /** Save a WebView-provided video Blob without base64/JSON expansion. */
  savePastedVideo: (data: Uint8Array, extension: string): Promise<string> =>
    invoke("save_pasted_video", data, {
      headers: { "x-ai-forge-video-extension": extension },
    }),
  /**
   * Capture only a user-selected rectangle inside the current preview. The
   * native command is deliberately scoped to the calling app window; it cannot
   * enumerate or capture arbitrary desktop windows.
   */
  capturePreviewSelection: (region: {
    x: number;
    y: number;
    width: number;
    height: number;
    devicePixelRatio: number;
  }): Promise<string> => invoke("capture_preview_selection", { region }),
  /** Mount an isolated native webview over one Browser tab in the preview panel. */
  createPreviewBrowser: (
    label: string,
    url: string,
    bounds: PreviewBrowserBounds,
    visible: boolean,
  ): Promise<void> => invoke("create_preview_browser", { label, url, bounds, visible }),
  /** Keep a native Browser tab aligned with its responsive DOM placeholder. */
  setPreviewBrowserBounds: (
    label: string,
    bounds: PreviewBrowserBounds,
    visible: boolean,
  ): Promise<void> => invoke("set_preview_browser_bounds", { label, bounds, visible }),
  /** Enable the narrow in-page selector used by Design Mode and Source Lens. */
  setPreviewBrowserInspection: (
    label: string,
    mode: "off" | "design" | "source",
    feedback?: PreviewBrowserFeedback | null,
  ): Promise<void> => invoke("set_preview_browser_inspection", {
    label,
    mode,
    feedback: feedback ?? null,
  }),
  /** Hide only temporary inspection chrome while making a bounded screenshot. */
  setPreviewBrowserInspectionChrome: (label: string, visible: boolean): Promise<void> =>
    invoke("set_preview_browser_inspection_chrome", { label, visible }),
  /** Capture a bounded target directly from the isolated native Browser webview. */
  capturePreviewBrowserSelection: (
    label: string,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<string> => invoke("capture_preview_browser_selection", { label, region }),
  navigatePreviewBrowser: (label: string, url: string): Promise<void> =>
    invoke("navigate_preview_browser", { label, url }),
  previewBrowserAction: (
    label: string,
    action: "back" | "forward" | "reload" | "focus",
  ): Promise<void> => invoke("preview_browser_action", { label, action }),
  /** Run observe/actions/stop only inside the named isolated Preview Browser tab. */
  previewBrowserComputer: (
    label: string,
    operation: "observe" | "actions" | "stop",
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => invoke("preview_browser_computer", { label, operation, args }),
  closePreviewBrowser: (label: string): Promise<void> =>
    invoke("close_preview_browser", { label }),
  onPreviewBrowserEvent: (
    cb: (payload: PreviewBrowserEvent) => void,
  ): Promise<UnlistenFn> => listen<PreviewBrowserEvent>("preview-browser-event", (event) => cb(event.payload)),
  /** Warm the bounded project index used by Source Lens hover inspection. */
  warmDesignSourceIndex: (): Promise<number> => invoke("warm_design_source_index"),
  /** Drop cached source data after a preview reload or project write. */
  invalidateDesignSourceIndex: (): Promise<void> => invoke("invalidate_design_source_index"),
  /** Resolve a visible preview target to ranked frontend/style/backend file locations. */
  resolveDesignTarget: (probe: DesignTargetProbe): Promise<DesignTargetResolution> =>
    invoke("resolve_design_target", { probe }),
  /** Copy an on-disk image into the paste dir (Explorer paste / file picker). */
  importImagePath: (path: string): Promise<string> =>
    invoke("import_image_path", { path }),
  /** Copy a user-selected video into the private attachment directory. */
  importVideoPath: (path: string): Promise<string> =>
    invoke("import_video_path", { path }),
  /** Import videos held in the native Windows file-drop clipboard. */
  importClipboardVideos: (): Promise<ClipboardVideoImportResult> =>
    invoke("import_clipboard_videos"),
  agentRun: (
    prompt: string,
    userRequest: string,
    sessionId: string,
    history: Array<{
      role: string;
      content: string;
      tool_calls?: { id: string; name: string; arguments: unknown }[];
      tool_call_id?: string;
      name?: string;
    }> = [],
    projectRoot?: string,
    cursorAgentId?: string | null,
    taskProfile: AgentTaskProfile = "default",
    executionProfile: AgentExecutionProfile = "auto",
    runSettings?: Settings,
  ): Promise<string | null> =>
    invoke("agent_run", {
      prompt,
      userRequest,
      sessionId,
      history,
      projectRoot,
      cursorAgentId: cursorAgentId ?? null,
      taskProfile,
      executionProfile,
      runSettings: runSettings ?? null,
    }),
  agentStop: (sessionId: string): Promise<void> => invoke("agent_stop", { sessionId }),
  /** Native source of truth for cross-project/session busy indicators. */
  activeAgentSessions: (): Promise<string[]> => invoke("active_agent_sessions"),
  openProjectInExplorer: (relativePath: string | null = null): Promise<void> =>
    invoke("open_project_in_explorer", { relativePath }),
  ensureProjectDevServer: (projectRoot: string): Promise<string> =>
    invoke("ensure_project_dev_server", { projectRoot }),
  appVersion: (): Promise<string> => invoke("app_version"),
  /** Match in-app updates to the installer family already present on Windows. */
  appInstallKind: (): Promise<"msi" | "nsis" | "unknown"> => invoke("app_install_kind"),
  /** Persist WebView state outside its cache before an installer replaces the app. */
  saveUpdateBackup: (stateJson: string): Promise<void> =>
    invoke("save_update_backup", { stateJson }),
  /** Load the safety snapshot; it remains until restoration is confirmed. */
  loadUpdateBackup: (): Promise<string | null> => invoke("load_update_backup"),
  clearUpdateBackup: (): Promise<void> => invoke("clear_update_backup"),
  /** Download, verify, install, and restart without leaving the desktop app. */
  installAppUpdate: (downloadUrl: string, version: string, sha256: string): Promise<void> =>
    invoke("install_app_update", { downloadUrl, version, sha256 }),
  openFolderPicker: async (): Promise<string | null> => {
    const sel = await openDialog({ directory: true, multiple: false, title: "Select folder" });
    if (typeof sel === "string") return sel;
    return null;
  },
  openImagePicker: async (): Promise<string[]> => {
    const sel = await openDialog({
      multiple: true,
      title: "Attach images",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
      ],
    });
    if (typeof sel === "string") return [sel];
    if (Array.isArray(sel)) return sel.filter((p): p is string => typeof p === "string");
    return [];
  },
  openVideoPicker: async (): Promise<string[]> => {
    const sel = await openDialog({
      multiple: true,
      title: "Attach videos",
      filters: [
        {
          name: "Videos",
          extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg", "3gp"],
        },
      ],
    });
    if (typeof sel === "string") return [sel];
    if (Array.isArray(sel)) return sel.filter((p): p is string => typeof p === "string");
    return [];
  },
  openFilePicker: async (): Promise<string[]> => {
    const sel = await openDialog({
      multiple: true,
      title: "Attach files",
    });
    if (typeof sel === "string") return [sel];
    if (Array.isArray(sel)) return sel.filter((p): p is string => typeof p === "string");
    return [];
  },
  /** Connected accounts (GitHub, Supabase, Vercel, …) */
  listIntegrations: (): Promise<IntegrationStatus[]> => invoke("list_integrations"),
  setIntegrationToken: (id: string, token: string): Promise<void> =>
    invoke("set_integration_token", { id, token }),
  clearIntegrationToken: (id: string): Promise<void> =>
    invoke("clear_integration_token", { id }),
  setIntegrationExtras: (id: string, fields: Record<string, string>): Promise<void> =>
    invoke("set_integration_extras", { id, fields }),
  testIntegration: (id: string): Promise<IntegrationTestResult> =>
    invoke("test_integration", { id }),
  /** Open OS browser for device/token auth (GitHub web login, etc.) */
  startIntegrationBrowserAuth: (id: string): Promise<IntegrationTestResult> =>
    invoke("start_integration_browser_auth", { id }),
};

export type AgentSkill = {
  id: string;
  name: string;
  path: string;
  source: string;
};

export type IntegrationStatus = {
  id: string;
  label: string;
  description: string;
  tokenLabel: string;
  docsUrl: string;
  connected: boolean;
  envKeys: string[];
  testHint: string;
  extras: Record<string, string>;
};

export type IntegrationTestResult = {
  ok: boolean;
  message: string;
  detail: string | null;
};

export type AgentEventPayload =
  | { kind: "start"; payload: { prompt: string; permission_mode?: string; smart_agent_enabled?: boolean; flavour_enabled?: boolean; task_profile?: AgentTaskProfile; execution_profile?: Exclude<AgentExecutionProfile, "auto">; repair_budget?: number; checkpoint_id?: string | null } }
  | { kind: "task_plan"; payload: { title: string; summary: string; steps: { id: string; label: string; state: string }[]; active_step: number; status: string; detail?: string } }
  | { kind: "task_progress"; payload: { step: number; phase: string; status: string; detail: string; completed_before?: number; complete_all?: boolean } }
  | { kind: "thinking"; payload: { iteration: number } }
  | { kind: "status"; payload: { message: string; attempt?: number; detail?: string } }
  | { kind: "reasoning"; payload: { text: string; iteration?: number } }
  | { kind: "text"; payload: { text: string; continuation?: boolean } }
  | { kind: "tool_preview"; payload: { id: string; name: string; arguments_delta?: string } }
  | { kind: "tool_preview_end"; payload: { id: string; name: string; reason: string } }
  | {
      kind: "multi_agent_batch";
      payload: {
        tools: { id: string; name: string; arguments: any }[];
      };
    }
  | { kind: "tool_call"; payload: { id: string; name: string; arguments: any; preview_id?: string } }
  | { kind: "integration_auth"; payload: { service: string; secure_entry: boolean } }
  | { kind: "tool_args_truncated"; payload: { id: string; preview: string } }
  | { kind: "tool_result"; payload: { id: string; name: string; ok: boolean; content: string; streamed?: boolean } }
  | { kind: "tool_confirm"; payload: { id: string; name: string; arguments: any; summary: string } }
  | { kind: "console_chunk"; payload: { stream: string; text: string } }
  | { kind: "usage"; payload: { iteration: number; turn_tokens: number; total_tokens: number; raw_tokens?: number; license?: LicenseStatus | null } }
  | { kind: "question"; payload: { id: string; question: string; options: string[]; allow_other: boolean } }
  | { kind: "done"; payload: { summary: string; title: string; description: string; files: string[]; tech: string[]; features: string[]; kind?: string; total_tokens?: number } }
  | { kind: "cancelled"; payload: { iteration: number } }
  | { kind: "end"; payload: { reason: string; iteration: number; total_tokens?: number } };

/** Wire event from backend — always includes the session that owns the run. */
export type AgentEvent = AgentEventPayload & { session_id: string };

export function onAgentEvent(cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent", (ev) => cb(ev.payload));
}

export function onPreviewComputerRequest(
  cb: (request: PreviewComputerRequest) => void,
): Promise<UnlistenFn> {
  return listen<PreviewComputerRequest>("preview-computer-request", (event) => cb(event.payload));
}

export function onPreviewComputerStop(
  cb: (request: PreviewComputerStop) => void,
): Promise<UnlistenFn> {
  return listen<PreviewComputerStop>("preview-computer-stop", (event) => cb(event.payload));
}

export function onComputerUseStatus(
  cb: (status: ComputerUseStatus) => void,
): Promise<UnlistenFn> {
  return listen<ComputerUseStatus>("computer-use-status", (ev) => cb(ev.payload));
}

export function onComputerUseFx(
  cb: (event: ComputerUseFxEvent) => void,
): Promise<UnlistenFn> {
  return listen<ComputerUseFxEvent>("computer-use-fx", (ev) => cb(ev.payload));
}

export function onAppUpdateProgress(
  cb: (event: AppUpdateProgress) => void,
): Promise<UnlistenFn> {
  return listen<AppUpdateProgress>("app-update-progress", (ev) => cb(ev.payload));
}
