import {
  api,
  onAgentEvent,
  onComputerUseStatus,
  onPreviewComputerRequest,
  onPreviewComputerStop,
  type AgentEvent,
} from "./ipc";
import { Sidebar } from "./components/sidebar";
import { Chat, type ChatPromptSubmission } from "./components/chat";
import { ConsolePanel } from "./components/console";
import { displayModelName, displayProviderName, getProviderMeta, getSettingsSafe, isHostedCatalogRestricted, visibleProviders } from "./components/settings";
import { ModelBar } from "./components/modelbar";
import { ProjectPicker } from "./components/picker";
import { WorkspacePanel } from "./components/workspace";
import { SmartAgentPanel, applySmartAgentEvent } from "./components/smart-agent";
import { ClientSuccessCenter, composeProjectMissionPrompt } from "./components/client-success-center";
import {
  SitePreview,
  extractPreviewBrowserUrlFromPrompt,
  isExternalPreviewUrl,
  isPreviewableBuild,
  mergePreviewSessionState,
  pickPreviewEntry,
  promptWantsLocalWebsite,
} from "./components/site-preview";

import {
  ensureWebsiteSession,
  fetchWebsiteAccount,
  isWebsiteSessionRejected,
  showAuthGate,
  type WebsiteAccount,
} from "./components/auth-gate";
import {
  checkDesktopUpdate,
  markUpdatePrompted,
  restoreUpdateState,
  shouldPromptUpdate,
  showUpdateDialog,
  showUpdateGate,
} from "./components/update-gate";
import { basename, cancelDoneWorkingCue, clear, div, el, speakDoneWorking } from "./components/util";
import {
  activeProjectWorkspacePath,
  activateProjectWorkspace,
  listProjectWorkspaces,
  rememberRecentProjectWorkspaces,
  removeProjectWorkspace,
  replaceProjectWorkspacePath,
} from "./components/projects";
import {
  loadSessions, saveSession, scheduleSessionSave, snapshotSessionsForUpdate,
  flushSessionSaves,
  deleteSession, deleteAllSessions, newSessionId, sessionTitle,
  recordAgentEvent, buildLlmHistory, redactChatCredentials, addSessionTokens, SESSION_TOKEN_BUDGET,
  rehomeSessionsToProjectRoot,
  coalesceSessionTurnLayout,
  type Session,
} from "./components/session";
import { icon } from "./components/icons";
import { reconcileRunIds } from "./components/run-lifecycle";
import { initializeAppearance, mountAppearanceControl } from "./theme/appearance";

let sidebar: Sidebar;
let chat: Chat;
let consolePanel: ConsolePanel;
let modelBar: ModelBar;
let workspacePanel: WorkspacePanel;
let sitePreview: SitePreview;
let smartAgentPanel: SmartAgentPanel | null = null;
let clientSuccessCenter: ClientSuccessCenter | null = null;
let currentProjectPath: string | null = null;
/** Quick Sessions use an app-managed workspace, never a user-selected folder. */
type WorkspaceMode = "project" | "quick";
let currentWorkspaceMode: WorkspaceMode = "project";
let quickSessionWorkspacePath: string | null = null;
let sessions: Session[] = [];
let activeSessionId: string | null = null;
/** Loaded sessions remain addressable after switching to another project. */
const sessionRegistry = new Map<string, Session>();
/** Session ids with an in-flight agent run (multiple can run at once). */
const runningSessions = new Set<string>();
/** Runs reserved in the UI but not yet acknowledged by the native registry. */
const startingSessions = new Set<string>();
/** Delayed native reconciliation after terminal events closes event/IPC races. */
const terminalReconcileTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
let runReconcileGeneration = 0;
/** Runs that emitted an explicit completion handshake before agent_run returned. */
const verifiedRunCompletions = new Set<string>();
/** Coalesce done+end and hold the audible cue while queued/background work remains. */
let completionCuePending = false;
let completionCueTimer: ReturnType<typeof setTimeout> | null = null;
/** Queue dispatch can await provider readiness before it appears in runningSessions. */
let pendingPromptStarts = 0;
/** Exact provider/model profile captured when each in-flight run starts. */
const runModelProfiles = new Map<
  string,
  { provider: string; model: string; effort?: string }
>();
/** Each run keeps its original workspace even when the visible project changes. */
const runProjectPaths = new Map<string, string>();
/** The user's prompt for each in-flight run — used to gate auto-opening the preview. */
const runPrompts = new Map<string, string>();
/** Files created/edited during a run — used to auto-open the build preview. */
const runTouchedFiles = new Map<string, Set<string>>();
/** Snapshot of project files at run start (relative paths). */
const runBaselineFiles = new Map<string, Set<string>>();
/** Sessions that already auto-opened preview this run (avoid double open on done+end). */
const previewOpenedForRun = new Set<string>();
/** Pending tool approvals while a session may be in the background. */
const pendingConfirms = new Map<
  string,
  { id: string; name: string; summary: string; arguments: any }
>();

function normalizeProjectPath(path: string | null | undefined): string {
  let value = String(path || "").trim().replace(/\//g, "\\");
  value = value
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  return value.replace(/[\\/]+$/, "");
}

function projectPathKey(path: string | null | undefined): string {
  return normalizeProjectPath(path).toLocaleLowerCase();
}

function sameProjectPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const aKey = projectPathKey(a);
  return !!aKey && aKey === projectPathKey(b);
}

function isQuickSessionWorkspace(path: string | null | undefined): boolean {
  return sameProjectPath(path, quickSessionWorkspacePath);
}

function normalizeToolName(name: string): string {
  return (name || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

const PREVIEW_WRITE_TOOLS = new Set([
  "write_file",
  "write",
  "writefile",
  "edit_file",
  "edit",
  "strreplace",
  "str_replace",
  "apply_patch",
  "applypatch",
  "copy_file",
  "copy",
  "move_file",
  "move",
  "download_file",
  "download",
  "shell",
  "bash",
  "run_command",
  "run_terminal_cmd",
  "shelltool",
  "terminal",
]);

const PREVIEW_OPEN_TOOLS = new Set([
  "open_path",
  "openpath",
  "open_url",
  "openurl",
  "open_file",
  "openfile",
]);

function toProjectRelPath(path: string, projectRoot = currentProjectPath): string {
  let p = path.trim();
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ""));
    if (/^[a-zA-Z]:/.test(p) === false && /^[a-zA-Z]%3A/i.test(path)) {
      /* keep decoded */
    }
  }
  p = normalizeProjectPath(p).replace(/\\/g, "/");
  const root = normalizeProjectPath(projectRoot).replace(/\\/g, "/");
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, "");
}

function walkProjectFiles(nodes: { path: string; isDir: boolean; children?: any[] }[], out: string[] = []): string[] {
  for (const n of nodes || []) {
    if (n.isDir) walkProjectFiles(n.children || [], out);
    else out.push(String(n.path).replace(/\\/g, "/"));
  }
  return out;
}

async function snapshotProjectFiles(projectRoot = currentProjectPath): Promise<Set<string>> {
  // The IPC file tree is rooted in the currently selected workspace. Do not
  // accidentally snapshot a second project after the user has switched views.
  if (!sameProjectPath(projectRoot, currentProjectPath)) return new Set();
  try {
    const tree = await api.listProjectFiles(16);
    return new Set(walkProjectFiles(tree.nodes || []));
  } catch {
    return new Set();
  }
}

function trackRunTouchedFile(sessionId: string | undefined, name: string, args: Record<string, unknown> | undefined) {
  if (!sessionId || !args) return;
  const projectRoot = runProjectPaths.get(sessionId) || currentProjectPath;
  const tool = normalizeToolName(name);
  if (!PREVIEW_WRITE_TOOLS.has(tool)) return;
  const keys = ["path", "file_path", "target", "dst", "destination", "src", "source", "filename"];
  let bucket = runTouchedFiles.get(sessionId);
  if (!bucket) {
    bucket = new Set();
    runTouchedFiles.set(sessionId, bucket);
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      bucket.add(toProjectRelPath(value, projectRoot));
    }
  }
  // Shell-ish tools sometimes pass a command string containing an .html path
  const blob = JSON.stringify(args);
  for (const m of blob.matchAll(/[A-Za-z0-9_./\\-]+\.(?:html?|css|js|mjs|tsx?|jsx|apk|exe)/gi)) {
    bucket.add(toProjectRelPath(m[0], projectRoot));
  }
}

function htmlPathFromOpenArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  projectRoot = currentProjectPath,
): string | null {
  if (!args) return null;
  const tool = normalizeToolName(name);
  if (!PREVIEW_OPEN_TOOLS.has(tool)) return null;
  const raw =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.url === "string" && args.url) ||
    "";
  if (!raw) return null;
  // A live dev server (localhost) can be previewed directly in the iframe.
  if (isExternalPreviewUrl(raw)) return raw.trim();
  const rel = toProjectRelPath(raw.replace(/^file:\/\/\/?/i, ""), projectRoot);
  if (/\.html?$/i.test(rel) || /\.html?$/i.test(raw)) return rel;
  return null;
}

async function openBuildPreview(opts: {
  entryPath?: string | null;
  files?: string[];
  title?: string;
  sessionId?: string;
  projectRoot?: string | null;
  /** When false, open a blank preview shell (no auto-picked HTML). Default true. */
  autoPickEntry?: boolean;
}) {
  if (!currentProjectPath || !sitePreview) return;
  if (opts.projectRoot && !sameProjectPath(opts.projectRoot, currentProjectPath)) return;
  const projectRoot = opts.projectRoot || currentProjectPath;
  const targetSessionId = opts.sessionId || activeSessionId || undefined;
  if (opts.sessionId) {
    const storedPreview = sessionForId(opts.sessionId)?.preview;
    const targetAlreadyOpen = opts.sessionId === activeSessionId
      ? sitePreview.isOpen
      : Boolean(storedPreview && sameProjectPath(storedPreview.projectRoot, projectRoot));
    if (previewOpenedForRun.has(opts.sessionId) && targetAlreadyOpen) return;
    previewOpenedForRun.add(opts.sessionId);
  }
  let files = opts.files || [];
  if (!files.length) {
    files = [...(await snapshotProjectFiles(projectRoot))];
  }
  const autoPick = opts.autoPickEntry !== false;
  const entry = opts.entryPath || (autoPick ? pickPreviewEntry(files) : null);
  const targetSession = sessionForId(targetSessionId);

  // A background agent may finish a game or app while the user is reading a
  // different session. Store its preview on its own session, but never mount it
  // into the currently visible session's iframe panel.
  if (targetSessionId && targetSessionId !== activeSessionId) {
    if (!targetSession || !sameProjectPath(targetSession.projectId, projectRoot)) return;
    targetSession.preview = mergePreviewSessionState(targetSession.preview, {
      projectRoot,
      files,
      entryPath: entry,
      title: opts.title || "Build preview",
    });
    sessionRegistry.set(targetSession.id, targetSession);
    saveSession(targetSession);
    return;
  }

  await sitePreview.open({
    projectRoot,
    files,
    entryPath: entry,
    title: opts.title || "Build preview",
    autoPickEntry: autoPick,
  });
  // The component emits this itself for regular UI actions. Persist here too so
  // an automatically opened preview is durable even if a view transition raced it.
  if (targetSessionId && targetSessionId === activeSessionId) {
    persistPreviewForSession(targetSessionId, sitePreview.captureSessionState());
  }
}

/**
 * A build only auto-opens the preview when the user's own request points at
 * something previewable (a website, page, app, game, UI, etc.). Plain code
 * tasks ("fix this bug", "add a function") must never pop the preview open.
 */
function promptAsksForPreview(prompt: string | undefined): boolean {
  const text = (prompt || "").toLowerCase();
  if (!text) return false;
  const previewIntent = [
    "website",
    "web site",
    "webpage",
    "web page",
    "site",
    "landing",
    "homepage",
    "home page",
    "page",
    "preview",
    "html",
    "css",
    "frontend",
    "front-end",
    "ui",
    "interface",
    "dashboard",
    "portfolio",
    "game",
    "app",
    "application",
    "screen",
    "form",
    "design",
    "template",
    "mockup",
    "blog",
    "store",
    "shop",
    "ecommerce",
    "e-commerce",
    "pos",
    "booking",
    "crm",
    "landing page",
  ];
  return previewIntent.some((word) => text.includes(word));
}

async function maybeOpenBuildPreview(sessionId: string | undefined, reason: string) {
  if (!sessionId || reason === "cancelled" || !currentProjectPath) return;
  // Only auto-open when the user explicitly asked for something previewable.
  if (!promptAsksForPreview(runPrompts.get(sessionId))) return;
  const runProjectPath = runProjectPaths.get(sessionId);
  if (runProjectPath && !sameProjectPath(runProjectPath, currentProjectPath)) {
    runTouchedFiles.delete(sessionId);
    runBaselineFiles.delete(sessionId);
    return;
  }
  const storedPreview = sessionForId(sessionId)?.preview;
  const sessionPreviewOpen = sessionId === activeSessionId
    ? sitePreview?.isOpen
    : Boolean(storedPreview && sameProjectPath(storedPreview.projectRoot, runProjectPath || currentProjectPath));
  if (previewOpenedForRun.has(sessionId) && sessionPreviewOpen) {
    runTouchedFiles.delete(sessionId);
    runBaselineFiles.delete(sessionId);
    return;
  }

  const touched = [...(runTouchedFiles.get(sessionId) || [])];
  const baseline = runBaselineFiles.get(sessionId);
  runTouchedFiles.delete(sessionId);
  runBaselineFiles.delete(sessionId);

  const now = await snapshotProjectFiles();
  const added = baseline
    ? [...now].filter((f) => !baseline.has(f))
    : [];
  const candidates = [...new Set([...touched, ...added])];

  // Prefer HTML written/added this run; fall back to any previewable touch
  const htmlEntry = pickPreviewEntry(candidates) || pickPreviewEntry([...now]);
  const shouldOpen =
    !!pickPreviewEntry(candidates) ||
    isPreviewableBuild(candidates) ||
    (touched.length > 0 && !!htmlEntry && candidates.some((f) => /\.(html?|css|js|mjs|tsx?|jsx)$/i.test(f)));

  if (!shouldOpen && !pickPreviewEntry(candidates)) return;

  await openBuildPreview({
    sessionId,
    files: [...now],
    entryPath: pickPreviewEntry(candidates) || htmlEntry,
    title: "Build preview",
    projectRoot: runProjectPath,
  });
}

/**
 * `end` only means that an agent turn stopped. It may be an ordinary prose
 * answer, a timeout, an error, a cancellation, or a continuation safety
 * guard. The audible cue is reserved for a real completion handshake.
 */
function isVerifiedAgentCompletion(e: AgentEvent): boolean {
  return e.kind === "done" || (e.kind === "end" && e.payload.reason === "completed");
}

function isTerminalAgentEvent(e: AgentEvent): boolean {
  return e.kind === "done" || e.kind === "end" || e.kind === "cancelled";
}

function scheduleCompletionCueWhenIdle(): void {
  if (!completionCuePending) return;
  if (completionCueTimer !== null) window.clearTimeout(completionCueTimer);
  completionCueTimer = window.setTimeout(() => {
    completionCueTimer = null;
    if (!completionCuePending) return;
    if (runningSessions.size > 0 || pendingPromptStarts > 0 || chat?.running) return;
    completionCuePending = false;
    speakDoneWorking();
  }, 180);
}

function refreshSidebar() {
  const runningProjectPaths = new Set(
    [...runningSessions]
      .map((sessionId) => sessionRegistry.get(sessionId)?.projectId || runProjectPaths.get(sessionId) || "")
      .filter(Boolean),
  );
  sidebar.setProjectWorkspaces(
    listProjectWorkspaces(),
    currentWorkspaceMode === "quick" ? null : currentProjectPath,
    runningProjectPaths,
  );
  sidebar.setQuickSessionWorkspace(quickSessionWorkspacePath, currentWorkspaceMode === "quick");
  sidebar.render(sessions, activeSessionId, runningSessions).catch((e) => console.error("sidebar render failed", e));
}

function updateGlobalRunStatus() {
  syncActiveSessionModelLock();
  const n = runningSessions.size;
  if (n === 0) sidebar.setStatus("Ready", false);
  else if (n === 1) sidebar.setStatus("Running", true);
  else sidebar.setStatus(`${n} runs`, true);
}

function clearTerminalReconcileTimers(sessionId: string) {
  const timers = terminalReconcileTimers.get(sessionId) || [];
  for (const timer of timers) window.clearTimeout(timer);
  terminalReconcileTimers.delete(sessionId);
}

/** Clear every frontend-only artifact belonging to one released run. */
function releaseFrontendRun(sessionId: string): boolean {
  const wasTracked = runningSessions.delete(sessionId);
  startingSessions.delete(sessionId);
  clearTerminalReconcileTimers(sessionId);
  if (verifiedRunCompletions.delete(sessionId)) completionCuePending = true;
  runModelProfiles.delete(sessionId);
  runProjectPaths.delete(sessionId);
  runPrompts.delete(sessionId);
  runTouchedFiles.delete(sessionId);
  runBaselineFiles.delete(sessionId);
  previewOpenedForRun.delete(sessionId);
  pendingConfirms.delete(sessionId);
  return wasTracked;
}

/**
 * Reconcile display state with the native run map. The native command owns the
 * actual future, cancellation flag, and process handle; the Set above is only a
 * fast UI cache and must never keep the model locked after native cleanup.
 */
async function reconcileActiveAgentSessions(options: { processQueue?: boolean } = {}) {
  const generation = ++runReconcileGeneration;
  let nativeIds: string[];
  try {
    nativeIds = await api.activeAgentSessions();
  } catch (error) {
    console.warn("active agent reconciliation unavailable", error);
    return;
  }
  if (generation !== runReconcileGeneration) return;

  const acknowledgedNativeIds = nativeIds.filter(
    (id) => typeof id === "string" && id.trim(),
  );
  for (const id of acknowledgedNativeIds) startingSessions.delete(id);
  const snapshot = reconcileRunIds(runningSessions, acknowledgedNativeIds, startingSessions);
  let changed = false;
  for (const id of snapshot.activeIds) {
    if (!runningSessions.has(id)) {
      runningSessions.add(id);
      changed = true;
    }
  }
  for (const id of snapshot.releasedIds) {
    changed = releaseFrontendRun(id) || changed;
  }

  const activeRunning = !!activeSessionId && runningSessions.has(activeSessionId);
  if (typeof chat !== "undefined" && chat.running !== activeRunning) {
    chat.setRunning(activeRunning, {
      processQueue: !activeRunning && options.processQueue === true,
    });
    if (!activeRunning && typeof workspacePanel !== "undefined") {
      void workspacePanel.finishRun();
    }
    if (!activeRunning && activeSessionId) persistCurrentSession();
    changed = true;
  }
  if (changed) {
    void restoreActiveSessionModelPreference();
    updateGlobalRunStatus();
    refreshSidebar();
    scheduleCompletionCueWhenIdle();
  }
}

function scheduleTerminalRunReconciliation(sessionId: string) {
  clearTerminalReconcileTimers(sessionId);
  const timers = [250, 1000, 3000].map((delay) => window.setTimeout(() => {
    void reconcileActiveAgentSessions({ processQueue: true });
  }, delay));
  terminalReconcileTimers.set(sessionId, timers);
}

/**
 * The model selector is shared UI, but each session remembers its own
 * provider/model. While the selected session is busy, lock to the model that
 * started that run. Idle sessions restore their preferred model on switch.
 */
function syncActiveSessionModelLock() {
  if (typeof modelBar === "undefined" || typeof chat === "undefined") return;
  const profile = activeSessionId ? runModelProfiles.get(activeSessionId) || null : null;
  modelBar.setActiveSessionRunProfile(profile);
  if (profile) {
    chat.setReplyProfile({
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
    });
  } else if (modelBar.settings) {
    chat.setReplyProfile({
      provider: modelBar.settings.provider,
      model: modelBar.settings.model,
      effort: modelBar.settings.model_effort,
    });
  }
}

/** Save the composer's current model onto the active idle session. */
let sessionModelRestoreGeneration = 0;
let sessionModelRestoring = false;

function persistActiveSessionModelPreference() {
  if (typeof modelBar === "undefined") return;
  const session = sessionForId(activeSessionId);
  if (!session) return;
  // A busy session already recorded its run profile; don't overwrite with a
  // different session's restored settings while that run is still locked.
  if (runningSessions.has(session.id) && runModelProfiles.has(session.id)) return;
  // Skip while a session switch is still restoring the composer — the UI may
  // still show the previous conversation's model for a tick.
  if (sessionModelRestoring) return;
  const profile = modelBar.currentProfile();
  if (!profile) return;
  const changed =
    session.preferredProvider !== profile.provider ||
    session.preferredModel !== profile.model ||
    session.preferredEffort !== profile.effort;
  session.preferredProvider = profile.provider;
  session.preferredModel = profile.model;
  session.preferredEffort = profile.effort;
  sessionRegistry.set(session.id, session);
  if (changed) saveSession(session);
}

/** Restore the active session's remembered model into the shared composer. */
async function restoreActiveSessionModelPreference() {
  if (typeof modelBar === "undefined") return;
  const session = sessionForId(activeSessionId);
  if (!session) {
    syncActiveSessionModelLock();
    return;
  }
  if (runningSessions.has(session.id) && runModelProfiles.has(session.id)) {
    syncActiveSessionModelLock();
    return;
  }
  const expectedSessionId = session.id;
  const generation = ++sessionModelRestoreGeneration;
  sessionModelRestoring = true;
  try {
    const provider = String(session.preferredProvider || "").trim();
    const model = String(session.preferredModel || "").trim();
    if (provider && model) {
      await modelBar.applySessionProfile({
        provider,
        model,
        effort: session.preferredEffort,
      });
    } else {
      // First visit / older session: seed preference from the current composer.
      const profile = modelBar.currentProfile();
      if (profile) {
        session.preferredProvider = profile.provider;
        session.preferredModel = profile.model;
        session.preferredEffort = profile.effort;
        sessionRegistry.set(session.id, session);
        saveSession(session);
      }
    }
  } finally {
    if (generation === sessionModelRestoreGeneration) {
      sessionModelRestoring = false;
    }
  }
  if (generation !== sessionModelRestoreGeneration || activeSessionId !== expectedSessionId) {
    return;
  }
  syncActiveSessionModelLock();
}

function sessionForId(id: string | null | undefined): Session | undefined {
  if (!id) return undefined;
  return sessionRegistry.get(id) || sessions.find((session) => session.id === id);
}

/** Keep the visible Director ledger scoped to the currently selected session. */
function syncSmartAgentPanel() {
  smartAgentPanel?.setSession(activeSessionId, sessionForId(activeSessionId)?.smartAgent);
}

function syncVisiblePreviewIntoSession(session: Session) {
  if (!sitePreview || sitePreview.isRestoring) return;
  const preview = sitePreview.captureSessionState();
  if (preview && sameProjectPath(preview.projectRoot, session.projectId)) {
    session.preview = preview;
  } else {
    delete session.preview;
  }
}

function persistPreviewForSession(
  sessionId: string | null | undefined,
  preview: ReturnType<SitePreview["captureSessionState"]>,
) {
  const session = sessionForId(sessionId);
  if (!session) return;
  if (preview && !sameProjectPath(preview.projectRoot, session.projectId)) return;
  if (preview) session.preview = preview;
  else delete session.preview;
  sessionRegistry.set(session.id, session);
  saveSession(session);
}

function restoreActiveSessionPreview() {
  if (!sitePreview) return;
  const sessionId = activeSessionId;
  const session = sessionForId(sessionId);
  const preview = session?.preview;
  if (
    !sessionId ||
    !session ||
    !currentProjectPath ||
    !preview ||
    !sameProjectPath(session.projectId, currentProjectPath) ||
    !sameProjectPath(preview.projectRoot, currentProjectPath)
  ) {
    sitePreview.clearSessionView();
    renderWorkspaceMenu();
    return;
  }
  void sitePreview.restoreSessionState(preview).then(
    () => {
      if (activeSessionId === sessionId) renderWorkspaceMenu();
    },
    (error) => {
      if (activeSessionId !== sessionId) return;
      sitePreview.clearSessionView();
      renderWorkspaceMenu();
      reportError(`Could not restore this session's preview: ${String(error)}`);
    },
  );
}

function persistCurrentSession(deferred = false) {
  if (!activeSessionId || !currentProjectPath) return;
  const s = sessionForId(activeSessionId);
  if (!s) return;
  syncVisiblePreviewIntoSession(s);
  sessionRegistry.set(s.id, s);
  s.messages = coalesceSessionTurnLayout(chat.getMessages());
  chat.messages = s.messages;
  if (deferred) scheduleSessionSave(s);
  else saveSession(s);
}

function prepareForAppUpdate(): Record<string, string> {
  if (runningSessions.size > 0) {
    throw new Error("Stop active AI runs before updating so their latest work can be saved safely.");
  }
  if (activeSessionId && currentProjectPath) {
    const session = sessions.find((candidate) => candidate.id === activeSessionId);
    if (session) {
      syncVisiblePreviewIntoSession(session);
      sessionRegistry.set(session.id, session);
      session.messages = coalesceSessionTurnLayout(chat.getMessages());
      chat.messages = session.messages;
      // Keep ordinary persistence best-effort. If WebView storage is full, the
      // pending queue is included in the native snapshot returned below.
      saveSession(session);
    }
  }
  flushSessionSaves();
  return snapshotSessionsForUpdate([
    ...sessions,
    ...sessionRegistry.values(),
  ]);
}

/** Tokens already used across all sessions in this project. */
/** Active subscription token budget + burn (account-wide via license.json). */
let activeTokenBudget = SESSION_TOKEN_BUDGET;
let accountTokensUsed = 0;
/** "" | "plan" — legacy 4h/week values must never lock the composer. */
let usageBlockedBy = "";
/** Dev bypass — usage limits disabled in debug builds. */
let usageLimitsDisabled = false;
let planExpiresAt = "";
let planName = "";
let planActive = false;
/** True after the signed-in website has supplied the current paid wallet. */
let websiteUsageAuthoritative = false;
/** Installed by init once browser-account sync is available. */
let refreshAuthoritativeUsage: (() => void) | null = null;

function remainingPct(used: number, budget: number): number {
  if (budget <= 0) return 100;
  const remaining = Math.max(0, budget - used);
  return Math.max(0, Math.min(100, Math.round((remaining / budget) * 100)));
}

function applyLicenseSnapshot(lic: {
  plan?: string;
  active?: boolean;
  expiresAt?: string;
  tokenBudget?: number;
  tokensUsed?: number;
  blockedBy?: string;
  limitsDisabled?: boolean;
  hosted?: boolean;
}) {
  // A local license mirror is useful while offline, but it can lag behind a
  // top-up or usage from another computer. Once the signed-in website has
  // supplied the account wallet, never let that cache overwrite it.
  if (websiteUsageAuthoritative) {
    usageLimitsDisabled = lic.limitsDisabled === true;
    return;
  }
  activeTokenBudget = Math.max(1, Math.floor(Number(lic.tokenBudget) || SESSION_TOKEN_BUDGET));
  accountTokensUsed = Math.max(0, Math.floor(Number(lic.tokensUsed) || 0));
  usageLimitsDisabled = lic.limitsDisabled === true;
  const reportedBlock = String(lic.blockedBy || "").trim().toLowerCase();
  const walletEmpty = accountTokensUsed >= activeTokenBudget;
  // Older installations saved `4h` / `week` in blockedBy. Treat those as
  // informational history only; a client is blocked exclusively when the
  // authoritative snapshot says their actual plan wallet is empty.
  usageBlockedBy =
    !usageLimitsDisabled && reportedBlock === "plan" && walletEmpty ? "plan" : "";
  planExpiresAt = String(lic.expiresAt || "");
  planName = String(lic.plan || "free");
  planActive = lic.active !== false && planName.toLowerCase() !== "free";
}

async function refreshLicenseBudget() {
  try {
    const lic = await api.getLicenseStatus();
    applyLicenseSnapshot(lic);
  } catch {
    activeTokenBudget = SESSION_TOKEN_BUDGET;
  }
}

/** Serialize license refreshes so concurrent session usage events never apply out of order. */
let licenseSyncTail: Promise<void> = Promise.resolve();

function enqueueLicenseSync(opts: { haltIfExhausted?: boolean } = {}) {
  const haltIfExhausted = opts.haltIfExhausted !== false;
  licenseSyncTail = licenseSyncTail
    .then(async () => {
      await refreshLicenseBudget();
      syncUsageBar();
      if (haltIfExhausted && isUsageExhausted()) haltRunsForUsageLimit();
    })
    .catch((err) => console.warn("license sync failed", err));
  return licenseSyncTail;
}

/** True when plan period budget is exhausted. */
function isUsageExhausted(): boolean {
  if (usageLimitsDisabled) return false;
  return planActive && usageBlockedBy === "plan";
}

function usageBlockMessage(): string {
  return "You've used up this plan period. Mag-load via GCash or upgrade to continue.";
}

/** Sync left-drawer usage from the active hosted plan. */
function syncUsageBar(_session?: Session | null) {
  const pct = remainingPct(accountTokensUsed, activeTokenBudget);
  sidebar?.setSessionUsage(accountTokensUsed, activeTokenBudget, {
    percent: pct,
    poolLabel: "plan",
    resetsIn: "",
    blockedBy: usageLimitsDisabled ? "" : usageBlockedBy,
    planRemaining: pct,
    planExpiresAt,
    planName,
    planActive,
    tokensUsed: accountTokensUsed,
    tokenBudget: activeTokenBudget,
  });
  if (chat) {
    chat.setUsageExhausted(isUsageExhausted(), usageBlockMessage());
  }
}

/** Prefer live website license usage (source of truth for bought plans). */
function applyWebsitePlanUsage(user: WebsiteAccount) {
  const plan = String(user.plan || "free");
  const active = user.licenseActive === true && !["free", "expired", ""].includes(plan.toLowerCase());
  const budget = Math.max(0, Math.floor(Number(user.tokenBudget) || 0));
  const used = Math.max(0, Math.floor(Number(user.tokensUsed) || 0));
  planName = plan || "free";
  planActive = active;
  websiteUsageAuthoritative = active && budget > 0;
  planExpiresAt = String(user.expiresAt || "");
  if (active && budget > 0) {
    activeTokenBudget = budget;
    accountTokensUsed = used;
    usageBlockedBy = used >= budget ? "plan" : "";
  } else if (!active) {
    activeTokenBudget = SESSION_TOKEN_BUDGET;
    accountTokensUsed = 0;
    usageBlockedBy = plan.toLowerCase() === "expired" ? "plan" : "";
  }
  syncUsageBar();
}

/** Stop every in-flight run + clear queues the moment usage hits 0%. */
function haltRunsForUsageLimit() {
  if (!isUsageExhausted()) return;
  chat?.clearPendingQueue();
  const ids = [...runningSessions];
  for (const id of ids) {
    api.agentStop(id).catch(() => {});
  }
  if (ids.length > 0) {
    reportError(usageBlockMessage());
  }
  syncUsageBar();
  updateGlobalRunStatus();
  refreshSidebar();
}

/**
 * Usage event from agent/bridge. Rust already persisted tokens — prefer the
 * embedded license snapshot (fresh after the write) so parallel sessions stay
 * accurate; otherwise reconcile from disk in order.
 */
function applyUsageToSession(
  sessionId: string,
  payload: {
    turn_tokens?: number;
    total_tokens?: number;
    iteration?: number;
    license?: {
      plan?: string;
      active?: boolean;
      expiresAt?: string;
      tokenBudget?: number;
      tokensUsed?: number;
      blockedBy?: string;
      limitsDisabled?: boolean;
      hosted?: boolean;
    } | null;
  },
) {
  const s = sessionRegistry.get(sessionId) || sessions.find((x) => x.id === sessionId);
  const add = Math.max(0, Math.floor(payload.turn_tokens ?? 0));
  if (s && add > 0) {
    addSessionTokens(s, add);
    saveSession(s);
  }
  if (payload.license && typeof payload.license === "object") {
    applyLicenseSnapshot(payload.license);
    syncUsageBar();
    if (isUsageExhausted()) haltRunsForUsageLimit();
    return;
  }
  void enqueueLicenseSync({ haltIfExhausted: true });
}

function persistSessionById(id: string, deferred = false) {
  const s = sessionForId(id);
  if (!s) return;
  if (id === activeSessionId) {
    syncVisiblePreviewIntoSession(s);
    s.messages = coalesceSessionTurnLayout(chat.getMessages());
    chat.messages = s.messages;
  } else {
    s.messages = coalesceSessionTurnLayout(s.messages);
  }
  sessionRegistry.set(s.id, s);
  if (deferred) scheduleSessionSave(s);
  else saveSession(s);
}

async function createNewSession() {
  if (!currentProjectPath) {
    try {
      await openQuickSessionWorkspace();
    } catch (error) {
      reportError(`Could not start a Quick session: ${String(error)}`);
      return;
    }
  }
  if (!currentProjectPath) return;
  // Other sessions may keep running in the background
  persistCurrentSession();
  persistActiveSessionModelPreference();
  const profile = typeof modelBar !== "undefined" ? modelBar.currentProfile() : null;
  const s: Session = {
    id: newSessionId(),
    title: "New session",
    projectId: currentProjectPath,
    messages: [],
    createdAt: Date.now(),
    sessionTokens: 0,
    preferredProvider: profile?.provider,
    preferredModel: profile?.model,
    preferredEffort: profile?.effort,
    // Fresh chat — never inherit another session's Cursor agent memory.
  };
  sessions.unshift(s);
  sessionRegistry.set(s.id, s);
  activeSessionId = s.id;
  syncSmartAgentPanel();
  restoreActiveSessionPreview();
  chat.startSession("");
  // Clear the empty user message that startSession pushes for a blank session
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false);
  saveSession(s);
  // Shared project budget — do not reset when opening another session
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
  void restoreActiveSessionModelPreference();
}

function switchSession(id: string) {
  if (id === activeSessionId) return;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  // Keep background runs alive — just switch the visible transcript
  persistCurrentSession();
  persistActiveSessionModelPreference();
  activeSessionId = id;
  syncSmartAgentPanel();
  restoreActiveSessionPreview();
  if (s.messages.length === 0) {
    chat.messages = [];
    chat.renderEmpty();
  } else {
    chat.loadSession(s.messages, { running: runningSessions.has(id) });
  }
  chat.setRunning(runningSessions.has(id));
  // Restore this conversation's model (or lock to its in-flight run profile).
  void restoreActiveSessionModelPreference();
  // Restore a tool-approval prompt if this run is waiting in the background
  const conf = pendingConfirms.get(id);
  if (conf) {
    chat.showToolConfirm(conf.id, conf.name, conf.summary);
  }
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
  void reconcileActiveAgentSessions({ processQueue: false });
}

function renameSession(id: string, title: string) {
  const name = title.trim().replace(/\s+/g, " ");
  if (!name) return;
  const s = sessions.find((x) => x.id === id);
  if (!s || s.title === name) {
    refreshSidebar();
    return;
  }
  s.title = name.length > 80 ? name.slice(0, 80) : name;
  saveSession(s);
  refreshSidebar();
}

function removeSession(id: string) {
  // Stop this session's run if active; other sessions keep running
  if (runningSessions.has(id)) {
    api.agentStop(id).catch(() => {});
    releaseFrontendRun(id);
  }
  deleteSession(id);
  sessionRegistry.delete(id);
  sessions = sessions.filter((s) => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = null;
    if (sessions.length > 0) {
      switchSession(sessions[0].id);
    } else {
      chat.messages = [];
      chat.renderEmpty();
      chat.setRunning(false);
      sitePreview?.clearSessionView();
      refreshSidebar();
    }
  } else {
    refreshSidebar();
  }
  syncSmartAgentPanel();
  updateGlobalRunStatus();
}
function removeAllSessions() {
  if (sessions.length === 0) return;
  const count = sessions.length;
  const root = document.getElementById("modal-root");
  if (!root) {
    // Fallback if modal host is missing
    if (!window.confirm(`Delete all ${count} session${count === 1 ? "" : "s"}? This cannot be undone.`)) return;
    doRemoveAllSessions();
    return;
  }

  clear(root);
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", {
    class: "modal confirm-modal",
    role: "alertdialog",
    "aria-modal": "true",
    "aria-labelledby": "delete-all-title",
    "aria-describedby": "delete-all-desc",
  });

  const head = el("div", { class: "modal-head" });
  head.appendChild(el("div", { class: "modal-title", id: "delete-all-title" }, ["Delete all sessions?"]));
  const closeBtn = el("button", {
    class: "modal-close",
    type: "button",
    "aria-label": "Cancel",
    html: icon("close", 16),
  }) as HTMLButtonElement;
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el("div", { class: "modal-body" });
  body.appendChild(
    el("p", { class: "confirm-modal-desc", id: "delete-all-desc" }, [
      `This will permanently delete ${count} session${count === 1 ? "" : "s"}. Usage remaining will stay as it is. This cannot be undone.`,
    ]),
  );
  modal.appendChild(body);

  const foot = el("div", { class: "modal-foot" });
  const cancelBtn = el("button", { class: "btn", type: "button" }, ["Cancel"]) as HTMLButtonElement;
  const deleteBtn = el("button", { class: "btn danger", type: "button" }, ["Delete all"]) as HTMLButtonElement;
  foot.appendChild(cancelBtn);
  foot.appendChild(deleteBtn);
  modal.appendChild(foot);

  const close = () => clear(root);
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  deleteBtn.addEventListener("click", () => {
    close();
    doRemoveAllSessions();
  });

  overlay.appendChild(modal);
  root.appendChild(overlay);
  deleteBtn.focus();
}

function doRemoveAllSessions() {
  if (sessions.length === 0) return;
  // Remove only the current project's work; other project runs stay alive.
  const ids = sessions.map((session) => session.id);
  for (const id of ids.filter((id) => runningSessions.has(id))) {
    api.agentStop(id).catch(() => {});
    releaseFrontendRun(id);
  }
  deleteAllSessions(currentProjectPath!);
  for (const id of ids) sessionRegistry.delete(id);
  // Keep project token usage — do not reset the meter to 100%
  sessions = [];
  activeSessionId = null;
  syncSmartAgentPanel();
  sitePreview?.clearSessionView();
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false);
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
}


function loadProjectSessions() {
  if (!currentProjectPath) {
    sessions = [];
    activeSessionId = null;
    syncSmartAgentPanel();
    syncUsageBar();
    return;
  }
  sessions = loadSessions(currentProjectPath);
  for (const session of sessions) sessionRegistry.set(session.id, session);
  if (sessions.length > 0) {
    activeSessionId = sessions[0].id;
    if (sessions[0].messages.length > 0) {
      chat.loadSession(sessions[0].messages, {
        running: runningSessions.has(sessions[0].id),
      });
    } else {
      chat.messages = [];
      chat.renderEmpty();
    }
  } else {
    activeSessionId = null;
    chat.messages = [];
    chat.renderEmpty();
  }
  // Project switching is allowed during a run. Reflect only the selected
  // session's activity instead of leaving the previous project in the UI.
  chat.setRunning(!!activeSessionId && runningSessions.has(activeSessionId), { processQueue: false });
  // Restore this project's active session model (or lock if that run is busy).
  void restoreActiveSessionModelPreference();
  // Shared budget across every session in this project
  syncUsageBar();
  syncSmartAgentPanel();
  restoreActiveSessionPreview();
  void reconcileActiveAgentSessions({ processQueue: false });
}

function showFatalError(msg: string) {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";
  app.style.cssText = "display:flex;align-items:center;justify-content:center;height:100vh;width:100vw;background:#0a0a0a;color:#fafafa;font-family:monospace;font-size:13px;padding:40px;text-align:center;white-space:pre-wrap;";
  app.textContent = "Hormachuelos failed to start.\n\n" + msg + "\n\nCheck DevTools (F12) for details.";
}

// Non-destructive error banner — logs the error and shows a small notice
// in the corner. Use this for runtime errors so the UI stays usable.
function reportError(msg: string) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 6000);
}

// Only wipe the UI for the rare *boot* error (no DOM yet, nothing to lose).
window.addEventListener("error", (e) => {
  const app = document.getElementById("app");
  if (app && app.children.length > 0) {
    console.error("runtime error:", e.message || e.error);
    reportError(e.message || String(e.error));
  } else {
    showFatalError(e.message || String(e.error));
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const app = document.getElementById("app");
  if (app && app.children.length > 0) {
    console.error("unhandled rejection:", e.reason);
    reportError(e.reason?.message || String(e.reason));
    e.preventDefault();
  } else {
    showFatalError(e.reason?.message || String(e.reason));
  }
});

const LEFT_DRAWER_KEY = "ai-forge:left-drawer-open";
const RIGHT_DRAWER_KEY = "ai-forge:right-drawer-open";

function isDrawerOpen(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function setDrawerOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Apply left/right drawer open state to #app classes. */
function applyDrawers() {
  const app = document.getElementById("app");
  if (!app) return;
  const leftOpen = isDrawerOpen(LEFT_DRAWER_KEY, true);
  const rightOpen = isDrawerOpen(RIGHT_DRAWER_KEY, true);
  app.classList.toggle("left-drawer-closed", !leftOpen);
  app.classList.toggle("right-drawer-closed", !rightOpen);
  // Legacy class cleanup
  app.classList.remove("drawer-closed");
}

function toggleLeftDrawer() {
  const open = !isDrawerOpen(LEFT_DRAWER_KEY, true);
  setDrawerOpen(LEFT_DRAWER_KEY, open);
  applyDrawers();
  syncDrawerButtons();
}

function toggleRightDrawer() {
  // The right sandwich collapses/uncollapses the whole right side: when the
  // build preview is open, closing the right side also closes the preview.
  // Reopening restores whichever right panel was visible before collapsing.
  const open = !isDrawerOpen(RIGHT_DRAWER_KEY, true);
  setDrawerOpen(RIGHT_DRAWER_KEY, open);
  if (!open && sitePreview?.isOpen) {
    rightSideWasPreview = true;
    sitePreview.close();
  } else if (open && !sitePreview?.isOpen && rightSideWasPreview) {
    // Reopen the preview that was closed together with the right side.
    if (currentProjectPath) {
      void openBuildPreview({ title: "Build preview", autoPickEntry: false });
    }
  }
  rightSideWasPreview = false;
  applyDrawers();
  syncDrawerButtons();
  renderWorkspaceMenu();
}

/** True when any right-side panel (inspector or preview) is visible. */
function rightSideVisible(): boolean {
  if (sitePreview?.isOpen) return true;
  return isDrawerOpen(RIGHT_DRAWER_KEY, true);
}

/** Set when collapsing the right side while the preview was open. */
let rightSideWasPreview = false;

function syncDrawerButtons() {
  const leftOpen = isDrawerOpen(LEFT_DRAWER_KEY, true);
  const leftBtn = document.getElementById("drawer-left-btn");
  if (leftBtn) {
    leftBtn.classList.toggle("active", leftOpen);
    leftBtn.setAttribute("aria-pressed", String(leftOpen));
    leftBtn.setAttribute("title", leftOpen ? "Hide left panel" : "Show left panel");
    leftBtn.setAttribute("aria-label", leftOpen ? "Hide left panel" : "Show left panel");
  }
  const rightVisible = rightSideVisible();
  const rightBtn = document.getElementById("drawer-right-btn");
  if (rightBtn) {
    rightBtn.classList.toggle("active", rightVisible);
    rightBtn.setAttribute("aria-pressed", String(rightVisible));
    rightBtn.setAttribute(
      "title",
      rightVisible ? "Hide right panels" : "Show right panels",
    );
    rightBtn.setAttribute(
      "aria-label",
      rightVisible ? "Hide right panels" : "Show right panels",
    );
  }
}

let workspaceMenuCleanup: (() => void) | null = null;

function workspaceMenuItems(): HTMLButtonElement[] {
  const menu = document.getElementById("workspace-menu");
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".workspace-menu-item:not(:disabled)"));
}

function closeWorkspaceMenu(restoreFocus = false) {
  const menu = document.getElementById("workspace-menu");
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  if (!menu || !button || menu.hidden) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.classList.remove("is-open");
  const cleanup = workspaceMenuCleanup;
  workspaceMenuCleanup = null;
  cleanup?.();
  if (restoreFocus) button.focus({ preventScroll: true });
}

function renderWorkspaceMenu() {
  const menu = document.getElementById("workspace-menu");
  if (!menu) return;
  clear(menu);

  const hasProject = !!currentProjectPath;
  const previewOpen = !!sitePreview?.isOpen;
  menu.appendChild(el("div", { class: "workspace-menu-title" }, ["Workspace"]));

  const appendAction = (
    action: string,
    label: string,
    iconName: "folder" | "globe" | "panelRight" | "spark",
    onClick: () => void,
    disabled = false,
  ) => {
    const item = el("button", {
      class: "workspace-menu-item",
      type: "button",
      role: "menuitem",
      "data-workspace-action": action,
    }) as HTMLButtonElement;
    item.disabled = disabled;
    item.append(
      el("span", { class: "workspace-menu-icon", html: icon(iconName, 15) }),
      el("span", { class: "workspace-menu-label" }, [label]),
    );
    item.addEventListener("click", () => {
      if (item.disabled) return;
      closeWorkspaceMenu();
      onClick();
    });
    menu.appendChild(item);
  };

  appendAction(
    "preview",
    previewOpen ? "Close build preview" : "Open build preview",
    "globe",
    () => {
      if (!currentProjectPath) return;
      if (sitePreview?.isOpen) sitePreview.close();
      else void openBuildPreview({ title: "Build preview", autoPickEntry: false });
    },
    !hasProject,
  );
  appendAction(
    "explorer",
    "Reveal project in Explorer",
    "folder",
    () => {
      if (currentProjectPath) void api.openProjectInExplorer();
    },
    !hasProject,
  );
  appendAction(
    "client-success",
    "Open Client Success Center",
    "spark",
    () => openClientSuccessCenter(),
    !hasProject,
  );
  menu.appendChild(el("div", { class: "workspace-menu-divider", role: "separator" }));
  appendAction(
    "inspector",
    rightSideVisible() ? "Hide right panels" : "Show right panels",
    "panelRight",
    () => toggleRightDrawer(),
  );
}

function openWorkspaceMenu() {
  const menu = document.getElementById("workspace-menu");
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  const anchor = document.getElementById("workspace-menu-anchor");
  if (!menu || !button || !anchor) return;
  renderWorkspaceMenu();
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  button.classList.add("is-open");

  const onPointerDown = (event: PointerEvent) => {
    if (!anchor.contains(event.target as Node)) closeWorkspaceMenu();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspaceMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = workspaceMenuItems();
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (offset > 0 ? 0 : items.length - 1)
      : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus({ preventScroll: true });
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  workspaceMenuCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  requestAnimationFrame(() => workspaceMenuItems()[0]?.focus({ preventScroll: true }));
}

function bindWorkspaceMenuButton() {
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  if (!button || (button as any).__bound) return;
  button.addEventListener("click", () => {
    const menu = document.getElementById("workspace-menu");
    if (menu?.hidden) openWorkspaceMenu();
    else closeWorkspaceMenu();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openWorkspaceMenu();
    requestAnimationFrame(() => {
      const items = workspaceMenuItems();
      const target = event.key === "ArrowUp" ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
    });
  });
  (button as any).__bound = true;
}

/** Wire permanent header controls once (they live in index.html). */
function bindDrawerButtons() {
  const leftBtn = document.getElementById("drawer-left-btn");
  if (leftBtn && !(leftBtn as any).__bound) {
    leftBtn.addEventListener("click", () => toggleLeftDrawer());
    (leftBtn as any).__bound = true;
  }
  const rightBtn = document.getElementById("drawer-right-btn");
  if (rightBtn && !(rightBtn as any).__bound) {
    rightBtn.addEventListener("click", () => toggleRightDrawer());
    (rightBtn as any).__bound = true;
  }
  bindWorkspaceMenuButton();
  applyDrawers();
  syncDrawerButtons();
}

async function refreshHeader() {
  const quickSession = currentWorkspaceMode === "quick";
  sidebar?.setProject(currentProjectPath, { quickSession });
  sidebar?.setQuickSessionWorkspace(quickSessionWorkspacePath, quickSession);
  chat?.setComposerProject(currentProjectPath, { quickSession });
  bindDrawerButtons();
  renderWorkspaceMenu();
}

async function openQuickSessionWorkspace() {
  const path = await api.ensureQuickSessionWorkspace();
  quickSessionWorkspacePath = path;
  await selectProject(path, { quickSession: true });
}

function repairProjectRootReferences(requestedPath: string, canonicalPath: string): void {
  if (sameProjectPath(requestedPath, canonicalPath)) return;
  const migrated = rehomeSessionsToProjectRoot(requestedPath, canonicalPath);
  for (const session of migrated) sessionRegistry.set(session.id, session);
  replaceProjectWorkspacePath(requestedPath, canonicalPath);

  const emptyFolder = basename(normalizeProjectPath(requestedPath)) || "the empty folder";
  const projectFolder = basename(normalizeProjectPath(canonicalPath)) || canonicalPath;
  reportError(`Opened ${projectFolder} because ${emptyFolder} is empty and its parent contains the project files.`);
}

async function selectProject(path: string, options: { quickSession?: boolean } = {}) {
  const quickSession = options.quickSession === true || isQuickSessionWorkspace(path);
  const nextMode: WorkspaceMode = quickSession ? "quick" : "project";
  persistCurrentSession();
  flushSessionSaves();
  if (!quickSession) await api.setProjectRoot(path);
  const canonicalPath = quickSession ? path : (await api.getProjectRoot()) || path;
  const wasRepaired = !quickSession && !sameProjectPath(path, canonicalPath);

  if (sameProjectPath(currentProjectPath, canonicalPath) && currentWorkspaceMode === nextMode) {
    if (wasRepaired) repairProjectRootReferences(path, canonicalPath);
    if (currentProjectPath !== canonicalPath) {
      currentProjectPath = canonicalPath;
      activateProjectWorkspace(canonicalPath);
      await workspacePanel.setProject(canonicalPath);
      await refreshHeader();
    }
    return;
  }

  if (wasRepaired) repairProjectRootReferences(path, canonicalPath);
  currentProjectPath = canonicalPath;
  currentWorkspaceMode = nextMode;
  if (!quickSession) activateProjectWorkspace(canonicalPath);
  loadProjectSessions();
  refreshSidebar();
  chat.setProjectReady(true);
  await workspacePanel.setProject(canonicalPath);
  await refreshHeader();
}

function projectHasActiveRun(path: string): boolean {
  const key = projectPathKey(path);
  if (!key) return false;
  return [...runningSessions].some((sessionId) => {
    const runPath = sessionRegistry.get(sessionId)?.projectId
      || runProjectPaths.get(sessionId)
      || "";
    return projectPathKey(runPath) === key;
  });
}

/**
 * Forget a sidebar shortcut without touching the project directory or its
 * saved sessions. Native persistence is updated first so a failed disk write
 * cannot leave the in-memory list disagreeing with the next app launch.
 */
async function removeProjectFromList(path: string) {
  if (projectHasActiveRun(path)) {
    reportError("Stop the active agent before removing this project from the list.");
    return;
  }

  const wasActive = currentWorkspaceMode === "project"
    && sameProjectPath(currentProjectPath, path);
  await api.removeRecentProject(path);
  const remaining = removeProjectWorkspace(path);

  if (!wasActive) {
    refreshSidebar();
    return;
  }

  const nextProject = remaining[0]?.path;
  if (nextProject) {
    await selectProject(nextProject);
  } else if (quickSessionWorkspacePath) {
    await selectProject(quickSessionWorkspacePath, { quickSession: true });
  } else {
    // Startup normally prepares Quick Sessions. Keep the open folder usable
    // if that preparation failed, while still removing its remembered row.
    refreshSidebar();
  }
}

async function createProject(path: string, templateId?: string) {
  persistCurrentSession();
  flushSessionSaves();
  await api.createProjectDir(path, templateId);
  const canonicalPath = (await api.getProjectRoot()) || path;
  currentProjectPath = canonicalPath;
  currentWorkspaceMode = "project";
  activateProjectWorkspace(canonicalPath);
  sessions = [];
  activeSessionId = null;
  sitePreview?.clearSessionView();
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false, { processQueue: false });
  refreshSidebar();
  chat.setProjectReady(true);
  await workspacePanel.setProject(canonicalPath);
  await refreshHeader();
}

function openNewProjectPicker() {
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(
    root,
    "new",
    async (path, templateId) => {
      clear(root);
      await createProject(path, templateId);
    },
    () => clear(root),
    // Escape hatch from the "parent is already a project" guard: open the
    // existing folder directly instead of nesting a blank project inside it.
    async (parentPath) => {
      await selectProject(parentPath);
    }
  );
  void picker.render();
}

function openOpenProjectPicker() {
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(root, "open", async (path) => {
    clear(root);
    await selectProject(path);
  }, () => clear(root));
  void picker.render();
}

function openSettings(_integrationId?: string) {
  // Settings is hidden from the product UI.
}

async function refreshProviderReadiness(
  providerOverride?: string,
  reflectInActiveComposer = true,
): Promise<boolean> {
  const settings = await getSettingsSafe();
  const providerId = String(providerOverride || settings.provider).trim();
  const provider = getProviderMeta(providerId);
  const label = displayProviderName(providerId);
  const finish = (ready: boolean) => {
    if (reflectInActiveComposer) chat?.setProviderReady(ready, label);
    return ready;
  };
  if (!provider) {
    return finish(false);
  }

  // Keyless local providers, or hosted-managed aliases, are ready immediately.
  if (provider.id === "ollama" || provider.hostedManaged || provider.id === "hormachuelos_free") {
    return finish(true);
  }

  if (await api.hasApiKey(providerId).catch(() => false)) {
    return finish(true);
  }

  // Active Hormachuelos plans unlock cloud providers (including OpenAI branding
  // without a local Cursor key, and OpenRouter Free Models Router).
  if (providerId !== "ollama") {
    const lic = await api.getLicenseStatus().catch(() => null);
    const hostedReady = Boolean(
      lic?.hosted && lic.active && String(lic.licenseKey || "").trim(),
    );
    if (hostedReady) {
      return finish(true);
    }
  }

  if (!provider.keyRequired && provider.id !== "openrouter" && provider.id !== "cursor") {
    return finish(true);
  }

  return finish(false);
}

async function openGCashTopUp() {
  try {
    const lic = await api.getLicenseStatus();
    window.open(lic.topUpUrl || "https://hormachuelos.com/#/pricing", "_blank", "noopener");
  } catch {
    window.open("https://hormachuelos.com/#/pricing", "_blank", "noopener");
  }
}

async function exportClientPack() {
  if (!currentProjectPath) {
    reportError("Open or create a project before exporting a client pack.");
    openNewProjectPicker();
    return;
  }
  try {
    const result = await api.exportClientPack();
    reportError(`Client pack saved: ${result.zipPath} (${result.filesCount} files)`);
  } catch (e) {
    reportError("Client pack failed: " + String(e));
  }
}

function openClientSuccessCenter() {
  if (!currentProjectPath) {
    reportError("Open or create a project before using Client Success Center.");
    openNewProjectPicker();
    return;
  }
  clientSuccessCenter?.open();
}

export type PreviewComputerUsePromptIntent = "enable" | "disable" | "auto" | null;

/**
 * Convert only clear user intent into Preview Computer Use policy. This runs in
 * the trusted desktop host before tools are advertised, so a model cannot grant
 * itself broader access or escape the active Preview tab.
 */
export function resolvePreviewComputerUsePromptIntent(
  value: string,
): PreviewComputerUsePromptIntent {
  const prompt = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!prompt) return null;

  const directDisable =
    /\b(?:disable|turn off|switch off|stop|block|never use|do not use|don't use|dont use)\b.{0,48}\b(?:computer use|ai cursor|preview cursor)\b/
      .test(prompt) ||
    /\b(?:computer use|ai cursor|preview cursor)\b.{0,24}\b(?:off|disabled|blocked)\b/
      .test(prompt);
  if (directDisable) return "disable";

  const directEnable =
    /\b(?:enable|turn on|switch on|start|activate|use)\b.{0,48}\b(?:computer use|ai cursor|preview cursor)\b/
      .test(prompt) ||
    /\b(?:computer use|ai cursor|preview cursor)\b.{0,24}\b(?:on|enabled|active)\b/
      .test(prompt);
  if (directEnable) return "enable";

  const previewTarget =
    /\b(?:website|site|web app|webpage|page|preview|browser tab|ui|interface|form|dashboard|modal|menu|table|game)\b/;
  const webAddress =
    /\bhttps?:\/\/|\b(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|dev|app|ai|tv|co|gg|me|info|edu|gov|uk|us|ph)\b/;
  const browserTask =
    /\b(?:debug|test|qa|audit|inspect|check|browse|navigate|interact|click|type|fill|select|submit|scroll|hover|open|verify|reproduce|play|try|run through|walk through|exercise|search|visit|look up|go to)\b/;
  const playwrightRequest =
    /\b(?:playwright|browser automation|automate the browser)\b/.test(prompt);
  const informationalOnly =
    /\b(?:what is|what's|explain|tell me about|how does)\b.{0,40}\b(?:playwright|browser automation|computer use)\b/
      .test(prompt) &&
    !browserTask.test(prompt.replace(/\b(?:what is|what's|explain|tell me about|how does)\b.{0,40}/, ""));
  if (informationalOnly) return null;

  const previewAction =
    (browserTask.test(prompt) && (previewTarget.test(prompt) || webAddress.test(prompt))) ||
    /\b(?:test|qa|audit|check|verify|exercise)\b.{0,48}\b(?:every|all)\b.{0,32}\b(?:feature|flow|button|control|screen)\b/
      .test(prompt) ||
    /\b(?:keyboard|mouse|cursor)\b.{0,48}\b(?:test|use|play|type|control)\b.{0,48}\b(?:preview|browser|website|site|game)\b/
      .test(prompt);
  return playwrightRequest || previewAction ? "auto" : null;
}

export type InferredPermissionMode =
  | "ask"
  | "research"
  | "plan"
  | "build"
  | "multi_agent";

export type AdaptiveRoute = {
  mode: InferredPermissionMode;
  reason: string;
  complexity: "low" | "medium" | "high";
  risk: "low" | "guarded" | "high";
  confidence: "medium" | "high";
};

/**
 * Host-owned Adaptive Director. It classifies intent before any model call so
 * permissions never depend on a model correctly interpreting a prose hint.
 * Explicit modes bypass this router; only Adaptive uses it.
 */
export function inferAdaptiveRoute(
  value: string,
  previousMode: InferredPermissionMode | null = null,
): AdaptiveRoute | null {
  const hadAttachment = /\[Attached (?:image|video):[^\]]*\]/i.test(String(value || ""));
  const prompt = String(value || "")
    .replace(/\[Attached (?:image|video):[^\]]*\]/gi, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const route = (
    mode: InferredPermissionMode,
    reason: string,
    complexity: AdaptiveRoute["complexity"],
    risk: AdaptiveRoute["risk"],
    confidence: AdaptiveRoute["confidence"] = "high",
  ): AdaptiveRoute => ({ mode, reason, complexity, risk, confidence });
  if (!prompt) {
    if (hadAttachment) return route("ask", "attached media question", "low", "low");
    return previousMode
      ? route(previousMode, "continuing the active workflow", "medium", "guarded", "medium")
      : null;
  }

  const isPlan =
    /\bkeep planning\b/.test(prompt) ||
    /\bjust the plan\b/.test(prompt) ||
    /\bplan only\b/.test(prompt) ||
    /\b(make|draft|propose|write) a plan\b/.test(prompt) ||
    /\bplanning first\b/.test(prompt) ||
    /\bplann(?:ing|ign)\b/.test(prompt) ||
    /\bproposal\b/.test(prompt) ||
    /\bjust a proposal\b/.test(prompt) ||
    (/\bplan\b/.test(prompt) && !/\b(implement|apply) (this|the) plan\b/.test(prompt));
  if (isPlan) return route("plan", "planning requested without implementation", "medium", "low");

  const isSimplify =
    /\bsimplif/i.test(prompt) ||
    /\bsimply (explain|put|tell|describe)\b/.test(prompt) ||
    /\bcan you simply\b/.test(prompt) ||
    /\bexplain\b.{0,24}\bsimply\b/.test(prompt) ||
    /\b(in simple terms|in plain english|in plain language|eli5|make it shorter|make it simpler|make this simpler|make this shorter|shorter explanation|shorter version|less technical|explain it simply|explain simply|simpler explanation)\b/.test(
      prompt,
    );
  if (isSimplify) return route("ask", "direct explanation or rewrite", "low", "low");

  // How-to questions mention add/change but still want an answer, not an edit.
  const isHowTo =
    /^(how do i|how to|how can i|how should i|how would i)\b/.test(prompt) ||
    /\bhow (do|can|should|would) (i|you|we)\b/.test(prompt);
  if (isHowTo) return route("ask", "how-to question", "low", "low");

  // A non-mutating constraint is an Answer/Ask contract, not a planning
  // request. Keep this ahead of generic build verbs: phrases such as
  // "make reasonable assumptions" must never grant write-level autonomy.
  const isExplicitReadOnly =
    /\bread[- ]only\b/.test(prompt) ||
    /\b(analysis|review|audit|assessment|report)[- ]only\b/.test(prompt) ||
    /\b(don't|don’t|dont|do not)\s+(make\s+)?(any\s+)?(changes?|edits?|modifications?)\b/.test(prompt) ||
    /\b(don't|don’t|dont|do not)\s+(change|modify|edit|write|create|delete|touch)\s+(any\s+|the\s+)?files?\b/.test(prompt) ||
    /\bwithout\s+(changing|modifying|editing|writing|creating)\b/.test(prompt) ||
    /\bno\s+(file\s+)?(changes?|edits?|modifications?)\b/.test(prompt);
  const wantsDeepEvidence =
    /\b(deep|thorough|comprehensive|exhaustive|in-depth)\s+(research|analysis|review|audit|assessment|investigation)\b/.test(prompt) ||
    /\b(research|investigate|benchmark|cross-check|cross check|fact-check|fact check|compare alternatives|compare options)\b/.test(prompt) ||
    /\b(security|architecture|performance|accessibility|dependency|codebase)\s+(audit|review|assessment|analysis)\b/.test(prompt) ||
    /\bmultiple sources\b|\bcite sources\b|\bverify (?:the )?(?:claims|facts|evidence)\b/.test(prompt) ||
    (/\b(analyze|analyse|inspect|review|audit|assess|examine)\b/.test(prompt) &&
      /\b(architecture|security|tests?|risks?|performance|dependencies|entire|whole|project|codebase)\b/.test(prompt));
  if (isExplicitReadOnly) {
    return wantsDeepEvidence
      ? route("research", "deep read-only evidence requested", "high", "low")
      : route("ask", "read-only answer requested", "medium", "low");
  }

  const isFileWrite =
    /\b(make|create|write|save|export|generate|put)\b[\s\S]{0,48}\b(md|markdown|\.md|notes?|files?|document|txt)\b/.test(prompt) ||
    /\b(md|markdown)\s+files?\b/.test(prompt) ||
    /\bsave\s+(this|it|the(?:\s+(?:session|conversation|chat|notes?))?)\s+(as|to|into)\b/.test(prompt) ||
    /\bwrite\s+(this|it|the(?:\s+(?:session|conversation|chat))?)\s+(to|into|as)\b/.test(prompt);
  const isImplementPlan =
    /\b(apply|implement|execute) (this|the) plan\b/.test(prompt) ||
    /\bgo ahead and (implement|apply)\b/.test(prompt) ||
    /\bstart implementing\b/.test(prompt);
  const isApplySuggestions =
    /\bokay,? apply\b/.test(prompt) ||
    /\bok,? apply\b/.test(prompt) ||
    /\bapply all\b/.test(prompt) ||
    /\bapply (your|these|the|my) suggestions\b/.test(prompt) ||
    /\bapply .{0,48}suggestions\b/.test(prompt);
  const isPoliteBuild =
    /\b(can|could) you (add|create|build|implement|fix|scaffold|generate|repair|refactor|change|changing|update|updating|rename|renaming|edit|editing|replace|replacing|rewrite|rewriting|modify|modifying|delete|remove|patch|tweak|adjust)\b/.test(prompt) ||
    /\bplease (add|create|build|implement|fix|repair|refactor|change|update|rename|edit|replace|rewrite|modify|delete|remove|patch|tweak|adjust)\b/.test(prompt);
  const isContextualMake =
    /\bmake\s+(?:(?:a|an|the)\s+)?((new|responsive|polished|modern|simple|production[- ]ready)\s+){0,3}(app|application|website|site|page|component|feature|form|dashboard|game|project|file|folder|module|api|database|script|button|md|markdown|notes?|document)\b/.test(prompt) ||
    /\bmake\s+(this|that|it)\s+(work|better|faster|responsive|accessible|production[- ]ready)\b/.test(prompt) ||
    /\bmake\s+(this|that|it)\s+(say|read|display|titled)\b/.test(prompt) ||
    /\bmake\s+(this|that|the|my)\s+(title|heading|header|label|text|name)\b/.test(prompt) ||
    /\bturn\s+(this|that|it|the)\s+into\b/.test(prompt) ||
    /\bmake\s+me\s+(a|an|the)\s+((new|responsive|polished|modern|simple)\s+){0,3}(app|application|website|site|page|component|feature|form|dashboard|game|project|file|folder|module|api|database|script|button)\b/.test(prompt);
  const isEditAction =
    /\b(change|changing)\s+(this|that|it)\b/.test(prompt) ||
    /\b(change|changing)\s+(the|my)\s+(title|heading|header|label|text|name|button|color|colour|copy|placeholder|caption)\b/.test(prompt) ||
    /^(please\s+)?(change|changing|rename|renaming|update|updating|edit|editing|replace|replacing|rewrite|rewriting|modify|modifying|delete|remove|patch|tweak|adjust)\b/.test(prompt) ||
    /\b(rename|renaming|update|updating|edit|editing|replace|replacing|rewrite|rewriting|modify|modifying|patch|tweak|adjust)\s+(this|that|it|the|my)\b/.test(prompt) ||
    /\b(delete|remove)\s+(this|that|it|the|my)\b/.test(prompt) ||
    /\bset\s+(the\s+)?(title|heading|label|text|name)\b/.test(prompt);
  const isApplyNow =
    /^(do it|go ahead and (do|apply|implement|make)|yes,?\s+(do it|apply|make the change)|apply (it|this|the change|the edit)|make the (change|edit)|implement (it|this|that))\b/.test(prompt) ||
    /\b(apply|make) (this|the) (change|edit|fix)\b/.test(prompt);
  const mutatesProject =
    isImplementPlan ||
    isApplySuggestions ||
    isPoliteBuild ||
    isContextualMake ||
    isEditAction ||
    isApplyNow ||
    isFileWrite;

  const explicitlyParallel =
    /\b(multi[- ]agent|parallel(?:ize|ise| work)?|concurrent(?:ly)?|in parallel|multiple agents?|agent team|split (?:this|the work|work) into|independent workstreams?)\b/.test(prompt);
  const broadChange =
    /\b(entire|whole|all major|every)\s+(app|application|project|codebase|system|module|mode|screen|flow)s?\b/.test(prompt) ||
    /\b(end[- ]to[- ]end|full[- ]stack|from scratch|large[- ]scale|major)\s+(build|rewrite|refactor|overhaul|migration|upgrade)\b/.test(prompt) ||
    /\bacross\s+(the\s+)?(frontend|backend|database|tests?|app|project|codebase)\b/.test(prompt);
  const workAreas = [
    /\b(frontend|ui|ux|layout|styles?|css)\b/,
    /\b(backend|server|api|tauri|rust)\b/,
    /\b(database|schema|migration|sql)\b/,
    /\b(tests?|qa|playwright|verification)\b/,
    /\b(auth|security|permissions?)\b/,
    /\b(build|release|deploy|ci|installer)\b/,
  ].filter((pattern) => pattern.test(prompt)).length;
  const highRisk =
    /\b(delete|migration|auth(?:entication|orization)?|security|payments?|production|deploy(?:ment)?)\b/.test(prompt);

  if (mutatesProject) {
    if (explicitlyParallel || broadChange || workAreas >= 3) {
      return route(
        "multi_agent",
        explicitlyParallel ? "parallel work explicitly requested" : "several independent workstreams detected",
        "high",
        highRisk ? "high" : "guarded",
      );
    }
    return route(
      "build",
      "focused implementation request",
      workAreas >= 2 ? "medium" : "low",
      highRisk ? "high" : "guarded",
    );
  }

  const isQuestion =
    prompt.includes("?") ||
    /^(what|why|who|where|which|how|is|are|does|do|explain|tell me)\b/.test(prompt) ||
    /\b(can|could) you (see|read|tell|describe|explain|look|simplif)\b/.test(prompt) ||
    /\b(please describe|describe this|describe these|describe the image|describe what)\b/.test(prompt) ||
    /\b(what is this|what are these|what this image|what these image|what's in this|whats in this)\b/.test(prompt) ||
    /\b(look at this|what does this)\b/.test(prompt);
  if (isQuestion) return route("ask", "direct question", "low", "low");

  const isAnalysisRequest =
    /^(analyze|analyse|inspect|review|audit|assess|examine|summarize|understand|report on)\b/.test(prompt) ||
    /\b(give|provide|write)\b.{0,56}\b(report|analysis|assessment|review|summary)\b/.test(prompt);

  const isBuildAction =
    /\b(add|create|build|implement|scaffold|generate|fix|debug|repair|refactor|upgrade|rename)\b/.test(prompt);
  // "Review and fix" is implementation; a plain architecture/security review
  // is an answer. Evaluate the explicit mutation before the analysis fallback.
  if (isBuildAction) {
    return explicitlyParallel || broadChange || workAreas >= 3
      ? route("multi_agent", "broad implementation with independent workstreams", "high", highRisk ? "high" : "guarded")
      : route("build", "focused implementation request", "medium", highRisk ? "high" : "guarded");
  }
  if (isAnalysisRequest) {
    return wantsDeepEvidence
      ? route("research", "deep analysis needs evidence gathering", "high", "low")
      : route("ask", "bounded analysis request", "medium", "low");
  }

  if (hadAttachment) return route("ask", "attached media question", "low", "low");

  if (/^(continue|keep going|proceed|carry on|resume|do it|go ahead|apply it|implement it)\b/.test(prompt)) {
    const continuation = previousMode && previousMode !== "ask" && previousMode !== "research"
      ? previousMode
      : "build";
    return route(continuation, "continuing the previous task", "medium", "guarded", "medium");
  }
  if (previousMode && /^(yes|okay|ok|sure|that one|the first|the second|react \+ vite)\b/.test(prompt)) {
    return route(previousMode, "short follow-up keeps the active workflow", "medium", "guarded", "medium");
  }
  return null;
}

/** Backward-compatible mode-only view used by tests and non-UI callers. */
export function inferPermissionMode(value: string): InferredPermissionMode | null {
  return inferAdaptiveRoute(value)?.mode ?? null;
}

async function sendPrompt(submission: ChatPromptSubmission) {
  let prompt = redactChatCredentials(submission.modelText);
  const visiblePrompt = redactChatCredentials(submission.visibleText || submission.modelText);
  const titlePrompt = redactChatCredentials(submission.titleHint || visiblePrompt || prompt);
  const taskProfile = submission.taskProfile || "default";
  if (!prompt.trim() || !visiblePrompt.trim()) return;
  cancelDoneWorkingCue();
  if (!currentProjectPath) {
    reportError("Open or create a project before starting.");
    openNewProjectPicker();
    return;
  }
  const projectRoot = currentProjectPath;
  const runProfile = modelBar.currentProfile() || (modelBar.settings ? {
    provider: modelBar.settings.provider,
    model: modelBar.settings.model,
    effort: modelBar.settings.model_effort,
  } : null);
  if (!runProfile?.provider || !runProfile.model) {
    reportError("Choose an AI provider and model before sending a request.");
    return;
  }
  const computerUseIntent = resolvePreviewComputerUsePromptIntent(visiblePrompt);
  let promptSettings = modelBar.settings;
  const selectedMode = modelBar.getMode();
  const previousRunMode = [...chat.getMessages()]
    .reverse()
    .find((message) => message.type === "run_start")?.permissionMode ?? null;
  const adaptiveRoute = taskProfile === "default" && selectedMode === "adaptive"
    ? inferAdaptiveRoute(visiblePrompt, previousRunMode)
      ?? {
        mode: "ask" as const,
        reason: "ambiguous request; safest useful route",
        complexity: "low" as const,
        risk: "low" as const,
        confidence: "medium" as const,
      }
    : null;
  if (adaptiveRoute) modelBar.showAdaptiveRoute(adaptiveRoute);
  if (promptSettings && (computerUseIntent === "enable" || computerUseIntent === "disable")) {
    const updatedSettings = {
      ...promptSettings,
      computer_use_enabled: computerUseIntent === "enable",
      computer_use_prompt_activation: computerUseIntent === "enable",
    };
    try {
      await api.saveSettings(updatedSettings);
      promptSettings = await api.getSettings();
      modelBar.settings = promptSettings;
      void sitePreview.refreshComputerUseControl();
    } catch (error) {
      // The current prompt is itself explicit user authorization, so preserve
      // its one-run policy even if persistence is temporarily unavailable.
      console.warn("Could not persist Preview Computer Use policy", error);
      promptSettings = updatedSettings;
      modelBar.settings = updatedSettings;
    }
  }
  const promptActivationAllowed =
    promptSettings?.computer_use_prompt_activation !== false;
  const computerUseForRun = computerUseIntent === "disable"
    ? false
    : computerUseIntent === "enable"
      ? true
      : computerUseIntent === "auto" && promptActivationAllowed
        ? true
        : !!promptSettings?.computer_use_enabled;
  const runSettings = promptSettings ? {
    ...promptSettings,
    provider: runProfile.provider,
    model: runProfile.model,
    model_effort: runProfile.effort || promptSettings.model_effort,
    computer_use_enabled: computerUseForRun,
    ...(adaptiveRoute
      ? {
          permission_mode: adaptiveRoute.mode,
          capability_mode:
            adaptiveRoute.mode === "ask"
              ? "answer_max"
              : adaptiveRoute.mode === "research"
                ? "investigate"
                : adaptiveRoute.mode === "plan"
                  ? "thinking"
                  : adaptiveRoute.mode === "build"
                    ? "agent"
                    : "autonomous",
        }
      : {}),
  } : undefined;
  if (isHostedCatalogRestricted()) {
    const allowed = visibleProviders();
    const providerId = String(runProfile.provider).trim();
    const modelId = String(runProfile.model).trim();
    const provider = allowed.find((entry) => entry.id === providerId);
    if (!provider || (provider.models.length > 0 && !provider.models.includes(modelId))) {
      reportError("This AI provider or model is not enabled for your account.");
      return;
    }
  }
  if (isUsageExhausted()) {
    reportError(usageBlockMessage());
    syncUsageBar();
    return;
  }
  // Backend still holds this session until agent_run returns — never double-start.
  // Chat UI queues follow-ups; drain happens only after the IPC fully completes.
  if (activeSessionId && runningSessions.has(activeSessionId)) {
    return;
  }
  // A credential accidentally entered in chat must never reach local history,
  // model prompts, tool arguments, or results. The replacement keeps enough
  // intent for the backend to open the secure integration form.
  prompt = redactChatCredentials(prompt);
  // The durable project brief guides the agent without polluting the user's
  // visible chat bubble, session title, or the preview-detection prompt.
  const agentPrompt = composeProjectMissionPrompt(projectRoot, prompt);

  let existing = activeSessionId ? sessions.find((x) => x.id === activeSessionId) : null;
  const hasMessages = existing && existing.messages.length > 0;

  if (!existing || !hasMessages) {
    // Fresh session — create one and start clean
    if (existing) {
      existing.title = sessionTitle(titlePrompt);
    } else {
      const s: Session = {
        id: newSessionId(),
        title: sessionTitle(titlePrompt),
        projectId: projectRoot,
        messages: [],
        createdAt: Date.now(),
        sessionTokens: 0,
        preferredProvider: runProfile.provider,
        preferredModel: runProfile.model,
        preferredEffort: runProfile.effort,
      };
      sessions.unshift(s);
      sessionRegistry.set(s.id, s);
      activeSessionId = s.id;
      existing = s;
    }
    chat.startSession(visiblePrompt, prompt);
  } else {
    // Continuing an existing conversation — append, don't clear
    chat.continueSession(visiblePrompt, prompt);
  }

  const sessionId = activeSessionId!;
  // Send compact memory from this session only (never other chats).
  const history = buildLlmHistory(chat.getMessages(), prompt);
  runModelProfiles.set(sessionId, runProfile);
  const owning = sessionForId(sessionId);
  if (owning) {
    owning.preferredProvider = runProfile.provider;
    owning.preferredModel = runProfile.model;
    owning.preferredEffort = runProfile.effort;
    sessionRegistry.set(owning.id, owning);
    saveSession(owning);
  }
  // Persist the user turn and reserve its exact owner before the first await.
  // Switching sessions after this point only moves the view; it cannot move the run.
  persistCurrentSession();
  startingSessions.add(sessionId);
  runningSessions.add(sessionId);
  syncActiveSessionModelLock();
  runProjectPaths.set(sessionId, projectRoot);
  runPrompts.set(sessionId, prompt);
  runTouchedFiles.set(sessionId, new Set());
  previewOpenedForRun.delete(sessionId);
  void snapshotProjectFiles(projectRoot).then((snap) => {
    if (sameProjectPath(runProjectPaths.get(sessionId), projectRoot)) runBaselineFiles.set(sessionId, snap);
  });
  if (activeSessionId === sessionId) {
    chat.setRunning(true);
  }
  updateGlobalRunStatus();
  // Shared project budget — continues across all sessions
  syncUsageBar();
  refreshSidebar();
  try {
    pendingPromptStarts += 1;
    let providerReady = false;
    try {
      // Check the provider captured above. A later session switch may update
      // settings.json, but must not change this request's readiness decision.
      providerReady = await refreshProviderReadiness(runProfile.provider, false);
    } finally {
      pendingPromptStarts = Math.max(0, pendingPromptStarts - 1);
      scheduleCompletionCueWhenIdle();
    }
    if (activeSessionId === sessionId) {
      chat.setProviderReady(providerReady, displayProviderName(runProfile.provider));
    }
    if (!providerReady) {
      throw new Error("Connect the selected provider before sending a request.");
    }
    if (isUsageExhausted()) throw new Error(usageBlockMessage());

    if (
      (computerUseIntent === "enable" || computerUseIntent === "auto" || promptWantsLocalWebsite(visiblePrompt))
      && sameProjectPath(projectRoot, currentProjectPath)
    ) {
      try {
        let previewUrl = extractPreviewBrowserUrlFromPrompt(visiblePrompt);
        if (!previewUrl && promptWantsLocalWebsite(visiblePrompt)) {
          previewUrl = await api.ensureProjectDevServer(projectRoot);
        }
        await sitePreview.openForComputerUse({
          projectRoot,
          url: previewUrl,
        });
        persistPreviewForSession(sessionId, sitePreview.captureSessionState());
      } catch (error) {
        console.warn("Could not open Preview for Computer Use", error);
      }
    }

    // Only touch workspace/console UI while this owning session is visible.
    if (sameProjectPath(projectRoot, currentProjectPath) && activeSessionId === sessionId) {
      await workspacePanel.beginRun(sessionId);
    }
    const resumeAgentId = sessionForId(sessionId)?.cursorAgentId || null;
    const nextAgentId = await api.agentRun(
      agentPrompt,
      prompt,
      sessionId,
      history,
      projectRoot,
      resumeAgentId,
      taskProfile,
      workspacePanel.getExecutionProfile(),
      runSettings,
      selectedMode,
    );
    if (typeof nextAgentId === "string" && nextAgentId.trim()) {
      const owning = sessionForId(sessionId);
      if (owning && owning.cursorAgentId !== nextAgentId) {
        owning.cursorAgentId = nextAgentId.trim();
        sessionRegistry.set(owning.id, owning);
        saveSession(owning);
      }
    } else if (nextAgentId === null || nextAgentId === "") {
      // Run finished without a Cursor agent — fine for non-Cursor models.
    }
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    // Stale Cursor agent ids from before per-session stores break continue.
    // Drop them so the next send creates a clean agent for this chat only.
    if (
      /agent not found|failed to resume|checkpoint|cursor bridge|sdk/i.test(msg) ||
      /network_error|connection_failed|provider_timeout|provider_unavailable/i.test(msg)
    ) {
      const owning = sessionForId(sessionId);
      if (owning?.cursorAgentId) {
        owning.cursorAgentId = undefined;
        sessionRegistry.set(owning.id, owning);
        saveSession(owning);
      }
    }
    // The hosted API returns this only when its own wallet check says empty.
    // Refresh immediately so the drawer cannot keep showing an old, high
    // percentage after a request made from another device has consumed usage.
    if (/\busage_exhausted\b/i.test(msg)) {
      refreshAuthoritativeUsage?.();
    }
    // Don't dump "already running" into the transcript — queue handles that path
    const isBusy =
      /already running/i.test(msg) || /wait for it to finish/i.test(msg);
    if (!isBusy) {
      if (activeSessionId === sessionId) {
        chat.appendAssistantText(`Error: ${msg}`);
        chat.appendEnd("no_tool_calls");
      } else {
        const s = sessionRegistry.get(sessionId) || sessions.find((x) => x.id === sessionId);
        if (s) {
          recordAgentEvent(s.messages, { kind: "text", payload: { text: `Error: ${msg}` } });
          recordAgentEvent(s.messages, { kind: "end", payload: { reason: "no_tool_calls" } });
          saveSession(s);
          sessionRegistry.set(s.id, s);
        }
      }
      reportError(msg);
    }
  } finally {
    // The backend future is the final owner of this run. Terminal events normally
    // clear Computer Use first; this fallback also covers provider/start failures.
    if (activeSessionId === sessionId) sitePreview.stopComputerUse();
    // Only drop the busy flag here — after backend finish_run. Early deletes on
    // cancelled/done events race a follow-up send ("session already running").
    releaseFrontendRun(sessionId);
    if (activeSessionId === sessionId) {
      void restoreActiveSessionModelPreference();
    } else {
      syncActiveSessionModelLock();
    }
    const allowQueue = !isUsageExhausted();
    if (!allowQueue) {
      chat.clearPendingQueue();
    }
    if (activeSessionId === sessionId) {
      await workspacePanel.finishRun();
      // Never auto-start queued prompts once usage is at 0%
      chat.setRunning(false, { processQueue: allowQueue });
      persistCurrentSession();
    } else {
      persistSessionById(sessionId);
      if (!runningSessions.has(activeSessionId || "")) {
        chat.setRunning(false, { processQueue: allowQueue });
      }
    }
    if (isUsageExhausted()) {
      haltRunsForUsageLimit();
    }
    updateGlobalRunStatus();
    syncUsageBar();
    refreshSidebar();
    scheduleCompletionCueWhenIdle();
  }
}

function handleAgentEvent(e: AgentEvent) {
  const sid = e.session_id;
  const isActive = !!sid && sid === activeSessionId;
  // Any event proves the native command registered this run. Terminal events
  // are emitted slightly before the command future returns, so reconcile after
  // short grace periods instead of unlocking on the event itself.
  if (sid) startingSessions.delete(sid);
  if (sid && isTerminalAgentEvent(e)) scheduleTerminalRunReconciliation(sid);
  const owningSession = sid ? sessionForId(sid) : undefined;
  const smartStateChanged = owningSession ? applySmartAgentEvent(owningSession, e) : false;
  if (e.kind === "start") cancelDoneWorkingCue();
  if (sid && isVerifiedAgentCompletion(e)) verifiedRunCompletions.add(sid);
  if (smartStateChanged && isActive) syncSmartAgentPanel();

  // UI-only secure handoff. Inline chat form — never persist credentials to transcript.
  if (e.kind === "integration_auth") {
    if (isActive) {
      void chat.showIntegrationAuth(e.payload.service, e.payload.secure_entry);
    }
    return;
  }

  // Live reconnect / progress status — UI only, never persisted.
  if (e.kind === "status") {
    if (isActive) {
      chat.handleEvent(e);
      if (/reconnect/i.test(e.payload.message || "")) {
        sidebar.setStatus("Reconnecting", true);
      }
    }
    return;
  }

  // Track approval prompts for every session (active or background)
  if (e.kind === "tool_confirm" && sid) {
    pendingConfirms.set(sid, {
      id: e.payload.id,
      name: e.payload.name,
      summary: e.payload.summary,
      arguments: e.payload.arguments,
    });
  }
  if ((e.kind === "tool_result" || e.kind === "done" || e.kind === "end" || e.kind === "cancelled") && sid) {
    pendingConfirms.delete(sid);
  }

  // Background session: only update stored transcript (run continues)
  if (sid && !isActive) {
    if (e.kind === "usage") {
      applyUsageToSession(sid, e.payload);
      return;
    }
    // Skip UI-only streams
    if (e.kind === "console_chunk" || e.kind === "tool_confirm") {
      return;
    }
    if (e.kind === "tool_call") {
      trackRunTouchedFile(sid, e.payload.name, e.payload.arguments);
      const htmlOpen = htmlPathFromOpenArgs(e.payload.name, e.payload.arguments, runProjectPaths.get(sid));
      if (htmlOpen) {
        void openBuildPreview({
          sessionId: sid,
          entryPath: htmlOpen,
          title: "Build preview",
          projectRoot: runProjectPaths.get(sid),
        });
      }
    }
    const s = sessionRegistry.get(sid) || sessions.find((x) => x.id === sid);
    if (s) {
      recordAgentEvent(s.messages, e);
      if (
        smartStateChanged ||
        e.kind === "text" ||
        e.kind === "tool_result" ||
        e.kind === "done" ||
        e.kind === "end" ||
        e.kind === "cancelled" ||
        e.kind === "reasoning" ||
        e.kind === "thinking" ||
        e.kind === "start" ||
        e.kind === "multi_agent_batch" ||
        e.kind === "tool_call" ||
        e.kind === "question"
      ) {
        if (e.kind === "text" || e.kind === "reasoning") {
          scheduleSessionSave(s);
        } else {
          saveSession(s);
        }
      }
      sessionRegistry.set(s.id, s);
    }
    // Background run end events: do NOT remove from runningSessions here.
    // sendPrompt's finally owns that set (avoids "already running" races).
    if (isTerminalAgentEvent(e)) {
      updateGlobalRunStatus();
      refreshSidebar();
      void maybeOpenBuildPreview(sid, e.kind);
    }
    return;
  }

  // Active session — live UI
  if (e.kind === "console_chunk") {
    consolePanel.handleConsoleChunk(e.payload.stream, e.payload.text);
    return;
  }
  if (e.kind === "usage") {
    if (sid) applyUsageToSession(sid, e.payload);
    return;
  }

  const isSmartAgentEvent = e.kind === "task_plan" || e.kind === "task_progress";
  if (!isSmartAgentEvent) {
    chat.handleEvent(e);
    workspacePanel.handleAgentEvent(e);
  }
  // Clear Reconnecting sidebar once the model is producing work again.
  if (
    e.kind === "thinking" ||
    e.kind === "reasoning" ||
    e.kind === "text" ||
    e.kind === "tool_call" ||
    e.kind === "tool_preview"
  ) {
    updateGlobalRunStatus();
  }
  if (e.kind === "tool_call") {
    trackRunTouchedFile(sid, e.payload.name, e.payload.arguments);
    const htmlOpen = htmlPathFromOpenArgs(
      e.payload.name,
      e.payload.arguments,
      sid ? runProjectPaths.get(sid) : currentProjectPath,
    );
    if (htmlOpen) {
      void openBuildPreview({
        sessionId: sid || undefined,
        entryPath: htmlOpen,
        title: "Build preview",
        projectRoot: sid ? runProjectPaths.get(sid) : currentProjectPath,
      });
    }
    consolePanel.handleToolCall(e.payload.name, e.payload.arguments);
  } else if (e.kind === "tool_result") {
    consolePanel.handleToolResult(
      e.payload.name,
      e.payload.ok,
      e.payload.content,
      !!e.payload.streamed,
    );
  } else if (isTerminalAgentEvent(e)) {
    // The visible run is genuinely terminal: remove the Preview cursor, status,
    // particles, target frame, and active perimeter immediately.
    sitePreview.stopComputerUse();
    // Keep runningSessions + chat.running true until sendPrompt's agentRun
    // await finishes. Early setRunning(false) / runningSessions.delete races
    // the next send (backend still in start_run → "already running").
    // chat.handleEvent already cleared pending + marked userCancelled.
    updateGlobalRunStatus();
    syncUsageBar();
    refreshSidebar();
    void maybeOpenBuildPreview(sid, e.kind);
  }
  // Persist session after meaningful events
  if (smartStateChanged || e.kind === "text" || e.kind === "tool_result" || e.kind === "done" || e.kind === "end" || e.kind === "cancelled" || e.kind === "reasoning" || e.kind === "start" || e.kind === "multi_agent_batch") {
    persistCurrentSession(e.kind === "text" || e.kind === "reasoning");
  }
}

async function init() {
  let restoredUpdateKeys = 0;
  try {
    restoredUpdateKeys = await restoreUpdateState();
  } catch (error) {
    console.warn("Pre-update backup is retained because restoration did not complete.", error);
  }
  if (restoredUpdateKeys > 0) {
    console.info(`Restored ${restoredUpdateKeys} persisted value(s) after the app update.`);
  }
  // Sandwich buttons are in HTML — bind them and restore open/closed state first
  bindDrawerButtons();

  workspacePanel = new WorkspacePanel();
  consolePanel = new ConsolePanel();
  sitePreview = new SitePreview(document.getElementById("site-preview-slot"));
  smartAgentPanel = new SmartAgentPanel(document.getElementById("smart-agent-status")!);
  syncSmartAgentPanel();
  sitePreview.setStateChangeHandler((preview) => {
    // The preview component only emits user-driven changes, never a restore of
    // another session. Keep the serialized preview alongside the active chat.
    persistPreviewForSession(activeSessionId, preview);
    renderWorkspaceMenu();
  });
  chat = new Chat({
    onSend: sendPrompt,
    onStop: () => {
      sitePreview.stopComputerUse();
      if (activeSessionId) api.agentStop(activeSessionId).catch((e) => reportError(String(e)));
    },
    onNeedProject: openNewProjectPicker,
    onOpenProject: openOpenProjectPicker,
    onNewProject: openNewProjectPicker,
    onRevealProject: () => {
      if (currentProjectPath) api.openProjectInExplorer().catch((e) => reportError(String(e)));
    },
    getSessionId: () => activeSessionId,
    onOpenSettings: openSettings,
  });
  clientSuccessCenter = new ClientSuccessCenter(document.getElementById("modal-root")!, {
    getProjectPath: () => currentProjectPath,
    onRunRecipe: (prompt) => chat.submitPreviewPrompt(prompt),
    onExportClientPack: async (handoffSummary) => {
      if (!currentProjectPath) return null;
      const result = await api.exportClientPack(undefined, handoffSummary);
      reportError(`Client pack saved: ${result.zipPath} (${result.filesCount} files)`);
      return result;
    },
  });
  // Preview actions use Chat's normal send/queue rules. That means a Build
  // choice always reaches the selected model, even when another task is still
  // running, instead of being silently dropped by a direct agent_run call.
  sitePreview.setDescribeHandler((request) => chat.submitPreviewPrompt(request));
  chat.setProjectReady(false);
  const HOSTED_SITE = "https://hormachuelos.vercel.app";
  let websiteUser: WebsiteAccount | null = null;

  async function syncHostedPlan(user: WebsiteAccount | null) {
    if (!user) return;
    applyWebsitePlanUsage(user);
    if (user.licenseKey) {
      try {
        const lic = await api.applyLicenseKey(user.licenseKey);
        applyLicenseSnapshot(lic);
        // Website account plan and wallet are the source of truth
        // (including administrator edits and top-ups). Re-apply them after
        // local activation so an older license.json cannot turn a healthy
        // server balance into a false limit.
        const mergedPlan = String(user.plan || lic.plan || "free");
        applyWebsitePlanUsage({
          ...user,
          plan: mergedPlan,
          tokenBudget:
            Number(user.tokenBudget) > 0
              ? Number(user.tokenBudget)
              : Number(lic.tokenBudget) || user.tokenBudget,
          tokensUsed:
            Number.isFinite(Number(user.tokensUsed)) && Number(user.tokensUsed) >= 0
              ? Number(user.tokensUsed)
              : Number(lic.tokensUsed) || 0,
          licenseActive:
            user.licenseActive === true || (lic.active !== false && mergedPlan.toLowerCase() !== "free"),
          expiresAt: user.expiresAt || lic.expiresAt || "",
        });
        sidebar?.setAccountStatus({
          state: "synced",
          email: user.email,
          name: user.name,
          plan: mergedPlan,
        });
      } catch (e) {
        console.warn("license sync from website account failed", e);
        syncUsageBar();
      }
    } else {
      syncUsageBar();
    }
  }

  async function refreshWebsiteAccountStatus(opts: { quiet?: boolean } = {}) {
    if (!opts.quiet) sidebar.setAccountStatus({ state: "checking" });
    const token = await api.getWebsiteSession().catch(() => null);
    if (!token) {
      websiteUser = null;
      websiteUsageAuthoritative = false;
      sidebar.setAccountStatus({
        state: "signed_out",
        detail: "Sign in on hormachuelos.vercel.app",
      });
      return null;
    }
    try {
      const user = await fetchWebsiteAccount(token);
      websiteUser = user;
      sidebar.setAccountStatus({
        state: "synced",
        email: user.email,
        name: user.name,
        plan: user.plan,
      });
      await syncHostedPlan(user);
      return user;
    } catch (e) {
      if (isWebsiteSessionRejected(e)) {
        await api.clearWebsiteSession().catch(() => {});
        websiteUser = null;
        websiteUsageAuthoritative = false;
        sidebar.setAccountStatus({
          state: "signed_out",
          detail: "Session expired — sign in again",
        });
        return null;
      }
      sidebar.setAccountStatus({
        state: "offline",
        detail: "Can't reach website — click to open",
      });
      return null;
    }
  }

  refreshAuthoritativeUsage = () => {
    void refreshWebsiteAccountStatus({ quiet: true });
  };

  async function manageWebsiteAccount() {
    const current = await refreshWebsiteAccountStatus({ quiet: true });
    if (current) {
      void api.openExternalUrl(`${HOSTED_SITE}/#/`).catch(() => window.open(`${HOSTED_SITE}/#/`, "_blank"));
      return;
    }
    await new Promise<void>((resolve) => {
      const gate = showAuthGate((user) => {
        websiteUser = user;
        sidebar.setAccountStatus({
          state: "synced",
          email: user.email,
          name: user.name,
          plan: user.plan,
        });
        resolve();
      });
      document.body.appendChild(gate);
    });
    await syncHostedPlan(websiteUser);
    // A just-linked browser account may unlock administrator-managed provider
    // aliases. Refresh the picker immediately instead of requiring a restart.
    if (typeof modelBar !== "undefined") {
      await modelBar.refresh().catch(() => {});
      await refreshProviderReadiness().catch(() => false);
    }
  }

  sidebar = new Sidebar({
    onNewProject: openNewProjectPicker,
    onOpenProject: openOpenProjectPicker,
    onSelectProject: (path) => void selectProject(path, {
      quickSession: isQuickSessionWorkspace(path),
    }).catch((error) => reportError(String(error))),
    onRemoveProject: (path) => void removeProjectFromList(path)
      .catch((error) => reportError(String(error))),
    onAddAnotherProject: openNewProjectPicker,
    onOpenQuickSessions: () => void openQuickSessionWorkspace().catch((error) => reportError(String(error))),
    onOpenSettings: openSettings,
    onCheckForUpdates: () => document.body.appendChild(showUpdateDialog({
      beforeInstall: prepareForAppUpdate,
    })),
    onNewSession: () => void createNewSession(),
    onSelectSession: switchSession,
    onDeleteSession: removeSession,
    onDeleteAllSessions: removeAllSessions,
    onRenameSession: renameSession,
    onExportClientPack: () => void exportClientPack(),
    onTopUp: () => void openGCashTopUp(),
    onManageAccount: () => void manageWebsiteAccount(),
    onRefreshAccount: () => void refreshWebsiteAccountStatus(),
  });
  await sidebar.render().catch((e) => console.error("sidebar render failed", e));
  await refreshHeader().catch((e) => console.error("refreshHeader failed", e));

  // New releases get a visible sidebar badge. Required releases still block
  // the app, while the background refresh keeps long-running clients informed.
  let forcedUpdateGateVisible = false;
  const refreshUpdateNotification = async ({ prompt = false }: { prompt?: boolean } = {}) => {
    try {
      const update = await checkDesktopUpdate();
      const available = update.updateAvailable || update.forceUpdate;
      sidebar.setUpdateNotification(available, update.latest?.version);
      if (update.forceUpdate && update.latest && !forcedUpdateGateVisible) {
        forcedUpdateGateVisible = true;
        document.body.appendChild(showUpdateGate(update, {
          beforeInstall: prepareForAppUpdate,
        }));
        return true;
      }
      if (
        prompt
        && available
        && update.latest
        && !update.forceUpdate
        && shouldPromptUpdate(update.latest.version)
        && !document.querySelector(".auth-gate-overlay")
      ) {
        markUpdatePrompted(update.latest.version);
        document.body.appendChild(showUpdateDialog({
          beforeInstall: prepareForAppUpdate,
        }));
      }
    } catch (e) {
      // Keep an already-shown notification rather than hiding it due to a
      // transient offline error.
      console.warn("update check failed", e);
    }
    return false;
  };
  if (await refreshUpdateNotification()) return;
  window.setInterval(() => {
    void refreshUpdateNotification({ prompt: true });
  }, 15 * 60 * 1000);
  window.addEventListener("online", () => {
    void refreshUpdateNotification({ prompt: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshUpdateNotification({ prompt: true });
  });

  // Website account required — desktop signs in automatically after browser login/signup.
  websiteUser = await ensureWebsiteSession().catch(() => null);
  if (!websiteUser) {
    sidebar.setAccountStatus({
      state: "signed_out",
      detail: "Sign in on hormachuelos.vercel.app",
    });
    await new Promise<void>((resolve) => {
      const gate = showAuthGate((user) => {
        websiteUser = user;
        resolve();
      });
      document.body.appendChild(gate);
    });
  }
  if (websiteUser) {
    sidebar.setAccountStatus({
      state: "synced",
      email: websiteUser.email,
      name: websiteUser.name,
      plan: websiteUser.plan,
    });
    applyWebsitePlanUsage(websiteUser);
  }
  await refreshWebsiteAccountStatus({ quiet: true }).catch(() => {});
  if (await refreshUpdateNotification({ prompt: true })) return;

  // OpenCode-style chips inside the composer card
  modelBar = new ModelBar(() => {
    refreshHeader().catch(() => {});
    void refreshProviderReadiness();
    persistActiveSessionModelPreference();
    syncActiveSessionModelLock();
  });
  await modelBar.load().catch((e) => console.error("modelbar load failed", e));
  window.addEventListener("horma:computer-use-mode-changed", ((event: CustomEvent<{
    enabled?: boolean;
    promptActivation?: boolean;
  }>) => {
    if (!modelBar.settings) return;
    modelBar.settings.computer_use_enabled = event.detail?.enabled === true;
    modelBar.settings.computer_use_prompt_activation =
      event.detail?.promptActivation !== false;
  }) as EventListener);
  window.addEventListener("horma:desktop-computer-use-changed", ((event: CustomEvent<{
    enabled?: boolean;
    allowedApps?: string[];
  }>) => {
    if (!modelBar.settings) return;
    modelBar.settings.desktop_computer_use_enabled = event.detail?.enabled === true;
    if (Array.isArray(event.detail?.allowedApps)) {
      modelBar.settings.desktop_computer_use_allowed_apps = event.detail.allowedApps;
    }
  }) as EventListener);
  await refreshProviderReadiness().catch(() => false);
  // Prefer website plan usage; fall back to local license.json if website had none.
  if (!planActive) {
    await refreshLicenseBudget().catch(() => {});
    syncUsageBar();
  }
  chat.attachComposerSide(modelBar.providerRail);
  if (modelBar.settings) {
    chat.setReplyProfile({
      provider: modelBar.settings.provider,
      model: modelBar.settings.model,
      effort: modelBar.settings.model_effort,
    });
  }
  persistActiveSessionModelPreference();
  await restoreActiveSessionModelPreference();
  syncActiveSessionModelLock();
  window.addEventListener("horma:ultra-effort", () => {
    chat.applyUltraChrome();
  });
  window.addEventListener("horma:new-session", () => void createNewSession());
  window.addEventListener("horma:run-permission-mode", ((e: CustomEvent<{
    mode?: string;
    persist?: boolean;
    reason?: string;
    complexity?: "low" | "medium" | "high";
    risk?: "low" | "guarded" | "high";
  }>) => {
    const mode = String(e.detail?.mode || "").trim().toLowerCase();
    if (
      e.detail?.reason &&
      (mode === "ask" || mode === "research" || mode === "plan" || mode === "build" || mode === "multi_agent")
    ) {
      modelBar.showAdaptiveRoute({
        mode,
        reason: e.detail.reason,
        complexity: e.detail.complexity,
        risk: e.detail.risk,
        confidence: "high",
      });
    } else {
      modelBar.showRunRoute(mode);
    }
    if (
      e.detail?.persist === true &&
      (mode === "adaptive" ||
        mode === "ask" ||
        mode === "research" ||
        mode === "plan" ||
        mode === "build" ||
        mode === "multi_agent")
    ) {
      void modelBar.applyIntentMode(mode);
    }
  }) as EventListener);
  window.addEventListener("horma:composer-insert", ((e: CustomEvent<{ text?: string }>) => {
    const text = e.detail?.text;
    if (typeof text === "string" && text) chat.insertComposerText(text);
  }) as EventListener);
  window.addEventListener("horma:composer-attach-image", ((e: CustomEvent<{ path?: string }>) => {
    const path = e.detail?.path;
    if (typeof path === "string" && path.trim()) chat.addComposerAttachment(path.trim());
  }) as EventListener);
  window.addEventListener("horma:composer-attach-video", ((e: CustomEvent<{ path?: string }>) => {
    const path = e.detail?.path;
    if (typeof path === "string" && path.trim()) chat.addComposerVideoAttachment(path.trim());
  }) as EventListener);
  window.addEventListener("horma:open-settings", ((e: CustomEvent<{ integrationId?: string }>) => {
    openSettings(e.detail?.integrationId);
  }) as EventListener);
  // New/renewed key already resets tokensUsed in license.json — just reload meter.
  window.addEventListener("horma:license-updated", () => {
    void enqueueLicenseSync({ haltIfExhausted: false });
  });
  window.addEventListener("beforeunload", flushSessionSaves);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSessionSaves();
  });

  // Restore every known workspace. Runs keep their own root, so opening or
  // adding another project never interrupts an existing project run.
  try {
    const recent = await api.listRecentProjects();
    const workspaces = rememberRecentProjectWorkspaces(recent);
    const rememberedActive = activeProjectWorkspacePath();
    const initialProject =
      workspaces.find((workspace) => workspace.path === rememberedActive)?.path ||
      recent[0] ||
      workspaces[0]?.path;
    // Prepare the app-managed option even when a real project is restored, so
    // the user can switch to a folder-free session at any time.
    const quickWorkspace = await api.ensureQuickSessionWorkspace().catch((error) => {
      console.warn("Quick Sessions workspace is unavailable", error);
      return null;
    });
    if (quickWorkspace) quickSessionWorkspacePath = quickWorkspace;
    if (initialProject) {
      await selectProject(initialProject);
    } else if (quickWorkspace) {
      await selectProject(quickWorkspace, { quickSession: true });
    } else {
      refreshSidebar();
    }
  } catch (e) {
    console.error("restore recent project failed", e);
    refreshSidebar();
  }

  syncUsageBar();

  // Refresh license so plan expiry / usage stay in sync.
  window.setInterval(() => {
    void enqueueLicenseSync({ haltIfExhausted: true });
  }, 60_000);

  // Re-verify website account sync periodically.
  window.setInterval(() => {
    void refreshWebsiteAccountStatus({ quiet: true });
  }, 90_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshWebsiteAccountStatus({ quiet: true });
    }
  });

  onAgentEvent(handleAgentEvent).catch((error) => console.warn("agent event bridge unavailable", error));
  const syncWindowActivity = () => {
    const backgrounded = document.visibilityState !== "visible";
    document.documentElement.classList.toggle("app-backgrounded", backgrounded);
    if (!backgrounded) void reconcileActiveAgentSessions({ processQueue: true });
  };
  document.addEventListener("visibilitychange", syncWindowActivity);
  window.addEventListener("focus", () => {
    void reconcileActiveAgentSessions({ processQueue: true });
  });
  syncWindowActivity();
  void reconcileActiveAgentSessions({ processQueue: true });

  onPreviewComputerRequest((request) => {
    void (async () => {
      try {
        const result = await sitePreview.handleComputerUseRequest(request);
        await api.respondPreviewComputer(request.requestId, true, result);
      } catch (error) {
        sitePreview.stopComputerUse();
        const message = error instanceof Error ? error.message : String(error);
        await api.respondPreviewComputer(request.requestId, false, null, message).catch(() => undefined);
      }
    })();
  }).catch((error) => console.warn("preview computer bridge unavailable", error));
  onPreviewComputerStop(() => sitePreview.stopComputerUse())
    .catch((error) => console.warn("preview computer stop bridge unavailable", error));
  onComputerUseStatus((status) => {
    if (status.paused) sitePreview.stopComputerUse();
  }).catch((error) => console.warn("computer use status bridge unavailable", error));
}

initializeAppearance();
mountAppearanceControl(document.getElementById("appearance-control"));
init().catch((e) => console.error("init failed", e));
