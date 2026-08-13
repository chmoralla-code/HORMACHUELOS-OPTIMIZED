// Session storage and types — persisted to localStorage per project.

import { normalizeAssistantMarkdown } from "./util";

export type SessionMessage =
  | {
      type: "user";
      /** Text rendered in the transcript. */
      text: string;
      /** Optional private model context, never rendered or copied from the chat bubble. */
      agentText?: string;
      at?: number;
    }
  /** Restores the visual run mode when a transcript is opened again. */
  | {
      type: "run_start";
      permissionMode: "plan" | "multi_agent";
      executionProfile?: "fast" | "balanced" | "thorough" | "safe";
      at?: number;
    }
  /** Keeps the visual Multi-Agent activity batch with the session it belongs to. */
  | { type: "multi_agent_batch"; tools: SessionMultiAgentTool[]; at?: number }
  | { type: "thinking"; iteration: number; text: string; at?: number }
  | { type: "assistant"; text: string; at?: number }
  | { type: "tool_call"; id: string; name: string; arguments: any; at?: number }
  | { type: "tool_result"; id: string; name: string; ok: boolean; content: string; at?: number }
  | { type: "question"; id: string; question: string; options: string[]; allow_other: boolean; answer: string | null; at?: number }
  | { type: "done"; summary: string; title: string; description: string; files: string[]; tech: string[]; features: string[]; at?: number; workMs?: number }
  | { type: "end"; reason: string; at?: number; workMs?: number }
  | { type: "cancelled"; at?: number; workMs?: number };

/** Safe, replayable description of one tool announced in a Multi-Agent batch. */
export type SessionMultiAgentTool = {
  id: string;
  name: string;
  arguments: unknown;
};

/**
 * True when the latest assistant prose is still mid-sentence / mid-list so a
 * later chunk (after a thought or tool row) must stitch into the same bubble.
 */
export function assistantReplyLooksOpen(text: string): boolean {
  const trimmed = String(text || "").replace(/\s+$/u, "");
  if (!trimmed) return true;
  const fenceCount = (trimmed.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return true;
  const lastLine = trimmed.split("\n").pop() || "";
  if (/^\s*(?:[-*]|[\d]+[.)])\s+\S/.test(lastLine) && !/[.!?…]["'”’)\]}]*$/.test(lastLine.trim())) {
    return true;
  }
  const visible = trimmed.replace(/[*_`]+$/g, "").trimEnd();
  if (/[:：—–]$/.test(visible)) return true;
  if (/[.!?…]["'”’)\]}]*$/.test(visible)) return false;
  return true;
}

function latestAssistantIndexInRun(messages: SessionMessage[], fromIndex: number): number {
  for (let index = fromIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === "assistant") return index;
    if (
      message.type === "user" ||
      message.type === "run_start" ||
      message.type === "question" ||
      message.type === "done" ||
      message.type === "end" ||
      message.type === "cancelled"
    ) {
      break;
    }
  }
  return -1;
}

/**
 * Store one streamed assistant chunk while preserving intentional transcript
 * boundaries. Provider recovery can insert thinking/status events between a
 * cut-off prefix and its resumed suffix; `resumePrevious` reconnects only that
 * explicitly marked suffix to the latest assistant message in the same run.
 * Returns true when the chunk joined an existing transcript reply.
 */
export function appendAssistantTranscriptChunk(
  messages: SessionMessage[],
  text: string,
  at?: number,
  resumePrevious = false,
): boolean {
  if (!text) return false;

  let assistantIndex = -1;
  const lastIndex = messages.length - 1;
  if (lastIndex >= 0 && messages[lastIndex].type === "assistant") {
    assistantIndex = lastIndex;
  } else {
    const found = latestAssistantIndexInRun(messages, lastIndex);
    if (found >= 0) {
      const previous = messages[found] as Extract<SessionMessage, { type: "assistant" }>;
      if (resumePrevious || assistantReplyLooksOpen(previous.text)) {
        assistantIndex = found;
      }
    }
  }

  if (assistantIndex >= 0) {
    const message = messages[assistantIndex] as Extract<SessionMessage, { type: "assistant" }>;
    message.text += text;
    message.at = at;
    return true;
  }

  messages.push({ type: "assistant", text, at });
  return false;
}

/**
 * The preview workspace belongs to a conversation, rather than to the whole
 * project.  Only file-relative paths are kept here; live iframe DOM is always
 * recreated when that session becomes visible again.
 */
export interface SessionPreviewTab {
  /** Missing on older sessions, where every tab was a project preview. */
  kind?: "preview" | "browser";
  entryPath: string;
  title: string;
  history: string[];
  historyIndex: number;
}

export interface SessionPreviewState {
  version: 1;
  projectRoot: string;
  tabs: SessionPreviewTab[];
  activeTabIndex: number;
  designMode: boolean;
  /** Separate source-aware selection mode; absent in sessions from older releases. */
  sourceLensMode?: boolean;
  androidMode: boolean;
  softwareMode: boolean;
}

export type SmartAgentStepState = "pending" | "active" | "completed" | "paused";

export interface SmartAgentTaskStep {
  id: string;
  label: string;
  state: SmartAgentStepState;
}

/**
 * Per-session orchestration state. Unlike a project preview, this reflects the
 * current task in one conversation and must never leak into another session.
 */
export interface SmartAgentTaskState {
  version: 1;
  title: string;
  summary: string;
  steps: SmartAgentTaskStep[];
  activeStep: number;
  status: "working" | "completed" | "paused";
  detail: string;
  updatedAt: number;
}

export interface Session {
  id: string;
  title: string;
  projectId: string;
  messages: SessionMessage[];
  createdAt: number;
  /** Cumulative tokens eaten in this session (all runs). */
  sessionTokens?: number;
  /** Per-session build preview, restored only while this session is selected. */
  preview?: SessionPreviewState;
  /** Per-session Smart Agent plan and its latest progress. */
  smartAgent?: SmartAgentTaskState;
  /**
   * Model chosen for this conversation. The composer is shared UI, but each
   * session remembers its own provider/model so switching sessions restores it.
   */
  preferredProvider?: string;
  preferredModel?: string;
  preferredEffort?: string;
  /**
   * Cursor SDK agent id for this conversation only. Never reused across
   * sessions in the same project — keeps chat memory isolated.
   */
  cursorAgentId?: string;
}

/** Keep a background session's saved reply as tidy as the live chat renderer. */
function normalizeLatestAssistantMessage(messages: SessionMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "assistant") continue;
    const normalized = normalizeAssistantMarkdown(message.text);
    if (normalized) message.text = normalized;
    return;
  }
}

/**
 * Default project-wide token budget when no license is loaded.
 * Live budget comes from license.tokenBudget (Pro / Pro+ / Max).
 */
export const SESSION_TOKEN_BUDGET = 5_500_000;

/** Add tokens to a session total (non-negative). Returns new total. */
export function addSessionTokens(session: Session, n: number): number {
  const add = Math.max(0, Math.floor(Number(n) || 0));
  const next = Math.max(0, Math.floor(session.sessionTokens || 0) + add);
  session.sessionTokens = next;
  return next;
}

const STORAGE_KEY = "ai-forge:sessions";
/** Project-wide token usage — shared across all sessions in a project. */
const PROJECT_USAGE_KEY = "ai-forge:project-usage";
/** Coalesce streamed transcript updates before touching synchronous localStorage. */
const SESSION_SAVE_DELAY_MS = 1_500;
const SESSION_SAVE_MAX_BACKOFF_MS = 60_000;
const pendingSessionSaves = new Map<string, Session>();
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSaveFailureCount = 0;
let sessionSaveBlockedUntil = 0;
const CREDENTIAL_REDACTION = "[credential removed — enter it only in Settings → Integrations]";
const PREFIXED_CREDENTIAL =
  /\b(?:gh[pousr]_[a-z0-9_]{16,}|github_pat_[a-z0-9_]{16,}|glpat-[a-z0-9_-]{16,}|vercel_[a-z0-9_-]{16,}|sk-[a-z0-9_-]{16,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi;
const CONTEXTUAL_CREDENTIAL =
  /\b((?:access[\s_-]*)?token|api[\s_-]*key|client[\s_-]*secret|secret|password|bearer)\b(\s*(?:is|=|:)?\s*["']?)[a-z0-9._~+/=-]{12,}["']?/gi;
const SESSION_PREVIEW_MAX_TABS = 12;
const SESSION_PREVIEW_MAX_HISTORY = 32;
const SESSION_PREVIEW_PATH_MAX = 768;
const SESSION_PREVIEW_URL_MAX = 4_096;
const SESSION_PREVIEW_ROOT_MAX = 2_048;

function projectPathKey(value: unknown): string {
  let path = String(value || "").trim().replace(/\//g, "\\");
  path = path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  return path.replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function sameProjectPath(left: unknown, right: unknown): boolean {
  const key = projectPathKey(left);
  return !!key && key === projectPathKey(right);
}

/** Keep credentials out of local chat history and provider prompts. */
export function redactChatCredentials(text: string): string {
  return String(text || "")
    .replace(PREFIXED_CREDENTIAL, CREDENTIAL_REDACTION)
    .replace(
      CONTEXTUAL_CREDENTIAL,
      (_match, label: string, separator: string) =>
        `${label}${separator}${CREDENTIAL_REDACTION}`,
    );
}

function redactCredentialValue(value: unknown): unknown {
  if (typeof value === "string") return redactChatCredentials(value);
  if (Array.isArray(value)) return value.map(redactCredentialValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCredentialValue(entry)]),
    );
  }
  return value;
}

function typedCharacterCount(args: Record<string, unknown>): number {
  const declared = args.characters;
  if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) {
    return Math.floor(declared);
  }
  const text = typeof args.text === "string" ? args.text : "";
  const redactedCount = text.match(/^\[hidden · (\d+) characters\]$/)?.[1];
  if (redactedCount) return Number(redactedCount);
  return Array.from(text).length;
}

/** Redact tool arguments before UI display, transcript storage, or history replay. */
export function redactToolArguments(name: string, value: unknown): unknown {
  const redacted = redactCredentialValue(value);
  if (!name.trim().toLowerCase().startsWith("computer_")) return redacted;

  const args =
    redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? { ...(redacted as Record<string, unknown>) }
      : {};
  if ("observation_token" in args) args.observation_token = "[fresh observation]";
  if (name.trim().toLowerCase() === "computer_type_text") {
    const characters = typedCharacterCount(args);
    args.text = `[hidden · ${characters} characters]`;
    args.characters = characters;
    delete args.text_preview;
  }
  return args;
}

const MULTI_AGENT_BATCH_MAX_TOOLS = 24;
const MULTI_AGENT_TOOL_ID_MAX = 160;
const MULTI_AGENT_TOOL_NAME_MAX = 120;

function safeMultiAgentToolText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Store only safe, bounded tool descriptors.  This snapshot is UI metadata,
 * not an additional tool invocation, so it can safely be replayed after a
 * project or session switch.
 */
export function snapshotMultiAgentTools(value: unknown): SessionMultiAgentTool[] {
  if (!Array.isArray(value)) return [];
  const tools: SessionMultiAgentTool[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value.slice(0, MULTI_AGENT_BATCH_MAX_TOOLS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const id = safeMultiAgentToolText(raw.id, MULTI_AGENT_TOOL_ID_MAX);
    const name = safeMultiAgentToolText(raw.name, MULTI_AGENT_TOOL_NAME_MAX);
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    tools.push({
      id,
      name,
      arguments: redactToolArguments(name, raw.arguments),
    });
  }
  return tools;
}

export function normalizeSessionPermissionMode(value: unknown): "plan" | "multi_agent" {
  return String(value || "").trim().toLowerCase() === "multi_agent"
    ? "multi_agent"
    : "plan";
}

function redactSessionMessage(message: SessionMessage): SessionMessage {
  switch (message.type) {
    case "user":
      return {
        ...message,
        text: redactChatCredentials(message.text),
        agentText: message.agentText
          ? redactChatCredentials(message.agentText)
          : undefined,
      };
    case "assistant":
    case "thinking":
      return { ...message, text: redactChatCredentials(message.text) };
    case "tool_call":
      return {
        ...message,
        arguments: redactToolArguments(message.name, message.arguments),
      };
    case "multi_agent_batch":
      return {
        ...message,
        tools: snapshotMultiAgentTools(message.tools),
      };
    case "tool_result":
      return { ...message, content: redactChatCredentials(message.content) };
    case "question":
      return {
        ...message,
        question: redactChatCredentials(message.question),
        options: message.options.map(redactChatCredentials),
        answer: message.answer ? redactChatCredentials(message.answer) : null,
      };
    case "done":
      return {
        ...message,
        summary: redactChatCredentials(message.summary),
        title: redactChatCredentials(message.title),
        description: redactChatCredentials(message.description),
        files: message.files.map(redactChatCredentials),
        tech: message.tech.map(redactChatCredentials),
        features: message.features.map(redactChatCredentials),
      };
    default:
      return { ...message };
  }
}

/** Keep persisted preview entries relative to their project and bounded in size. */
function sanitizePreviewPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.length > SESSION_PREVIEW_PATH_MAX || raw.includes("\0")) return null;
  // A live dev server (localhost) can be previewed directly in the iframe.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw)) return raw;
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (part.includes(":")) return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Persist only ordinary credential-free web URLs for native Browser tabs. */
function sanitizeBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > SESSION_PREVIEW_URL_MAX || raw.includes("\0")) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeSessionPreview(value: unknown): SessionPreviewState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const projectRoot = typeof raw.projectRoot === "string" ? raw.projectRoot.trim() : "";
  if (!projectRoot || projectRoot.length > SESSION_PREVIEW_ROOT_MAX || projectRoot.includes("\0")) {
    return undefined;
  }

  const tabs: SessionPreviewTab[] = [];
  const seenEntries = new Set<string>();
  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs.slice(0, SESSION_PREVIEW_MAX_TABS) : [];
  for (const candidate of rawTabs) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const tab = candidate as Record<string, unknown>;
    const kind = tab.kind === "browser" ? "browser" : "preview";
    const sanitizeEntry = kind === "browser" ? sanitizeBrowserUrl : sanitizePreviewPath;
    const rawHistory = Array.isArray(tab.history)
      ? tab.history.slice(0, SESSION_PREVIEW_MAX_HISTORY)
      : [];
    const history = rawHistory
      .map(sanitizeEntry)
      .filter((path): path is string => Boolean(path));
    const entryPath = sanitizeEntry(tab.entryPath) || history[0];
    const entryKey = `${kind}:${entryPath || ""}`;
    if (!entryPath || seenEntries.has(entryKey)) continue;
    seenEntries.add(entryKey);
    if (!history.length) history.push(entryPath);
    const requestedIndex = Math.floor(Number(tab.historyIndex) || 0);
    const historyIndex = Math.max(0, Math.min(history.length - 1, requestedIndex));
    const title = typeof tab.title === "string" && tab.title.trim()
      ? redactChatCredentials(tab.title.trim()).slice(0, 160)
      : entryPath.split("/").pop() || entryPath;
    tabs.push({
      kind,
      entryPath: history[historyIndex] || entryPath,
      title,
      history,
      historyIndex,
    });
  }

  const requestedActive = Math.floor(Number(raw.activeTabIndex) || 0);
  return {
    version: 1,
    projectRoot,
    tabs,
    activeTabIndex: tabs.length
      ? Math.max(0, Math.min(tabs.length - 1, requestedActive))
      : 0,
    designMode: raw.designMode === true,
    sourceLensMode: raw.sourceLensMode === true,
    androidMode: raw.androidMode === true,
    softwareMode: raw.softwareMode === true,
  };
}

const SMART_AGENT_MAX_STEPS = 8;
const SMART_AGENT_MAX_TEXT = 300;
const SMART_AGENT_STEP_IDS = new Set([
  "scope",
  "inspect",
  "implement",
  "validate",
  "debug",
  "deliver",
]);

function clipSmartAgentText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = redactChatCredentials(value.trim()).replace(/\s+/g, " ");
  return text.slice(0, SMART_AGENT_MAX_TEXT) || fallback;
}

/** Bound and sanitize persisted Smart Agent state before restoring it into the UI. */
export function sanitizeSmartAgentTaskState(value: unknown): SmartAgentTaskState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, SMART_AGENT_MAX_STEPS) : [];
  const steps: SmartAgentTaskStep[] = [];
  const seen = new Set<string>();
  for (const candidate of rawSteps) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const step = candidate as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id.trim().toLowerCase() : "";
    if (!SMART_AGENT_STEP_IDS.has(id) || seen.has(id)) continue;
    const label = clipSmartAgentText(step.label, id);
    const requested = typeof step.state === "string" ? step.state : "pending";
    const state: SmartAgentStepState =
      requested === "active" || requested === "completed" || requested === "paused"
        ? requested
        : "pending";
    seen.add(id);
    steps.push({ id, label, state });
  }
  if (!steps.length) return undefined;
  const requestedStatus = typeof raw.status === "string" ? raw.status : "working";
  const status: SmartAgentTaskState["status"] =
    requestedStatus === "completed" || requestedStatus === "paused" ? requestedStatus : "working";
  const requestedStep = Math.floor(Number(raw.activeStep) || 0);
  return {
    version: 1,
    title: clipSmartAgentText(raw.title, "Smart Agent"),
    summary: clipSmartAgentText(raw.summary),
    steps,
    activeStep: Math.max(0, Math.min(steps.length - 1, requestedStep)),
    status,
    detail: clipSmartAgentText(raw.detail),
    updatedAt: Math.max(0, Math.floor(Number(raw.updatedAt) || 0)),
  };
}

type ProjectUsageMap = Record<string, number>;

function loadProjectUsageMap(): ProjectUsageMap {
  try {
    const raw = localStorage.getItem(PROJECT_USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveProjectUsageMap(map: ProjectUsageMap): void {
  try {
    localStorage.setItem(PROJECT_USAGE_KEY, JSON.stringify(map));
  } catch {
    // non-fatal
  }
}

/** Tokens eaten across all sessions for this project. */
export function getProjectUsage(projectId: string): number {
  if (!projectId) return 0;
  const map = loadProjectUsageMap();
  return Math.max(0, Math.floor(Number(map[projectId]) || 0));
}

/** Add tokens to the project-wide pool (all sessions share this). Returns new total. */
export function addProjectUsage(projectId: string, n: number): number {
  if (!projectId) return 0;
  const add = Math.max(0, Math.floor(Number(n) || 0));
  const map = loadProjectUsageMap();
  const next = Math.max(0, Math.floor(Number(map[projectId]) || 0) + add);
  map[projectId] = next;
  saveProjectUsageMap(map);
  return next;
}

/** Set absolute project usage (e.g. reset). */
export function setProjectUsage(projectId: string, tokens: number): number {
  if (!projectId) return 0;
  const map = loadProjectUsageMap();
  const next = Math.max(0, Math.floor(Number(tokens) || 0));
  map[projectId] = next;
  saveProjectUsageMap(map);
  return next;
}

/** Clear project-wide usage (e.g. delete all sessions). */
export function clearProjectUsage(projectId: string): void {
  if (!projectId) return;
  const map = loadProjectUsageMap();
  delete map[projectId];
  saveProjectUsageMap(map);
}

/** Reset every project's token meter to 100% remaining (0 tokens used). */
export function resetAllProjectUsage(): void {
  saveProjectUsageMap({});
}

export function loadSessions(projectId: string): Session[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const all: Session[] = JSON.parse(raw);
    const safeAll = all.map(safeSessionForStorage);
    // Migrate legacy transcripts that may contain raw Computer Use typing arguments.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(safeAll));
    } catch {
      // Keep the sanitized in-memory transcript even if storage is unavailable.
    }
    return safeAll
      .filter((s) => sameProjectPath(s.projectId, projectId))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function rehomeProjectUsage(previousProjectId: string, nextProjectId: string): void {
  try {
    const map = loadProjectUsageMap();
    let usage = 0;
    let moved = false;
    for (const [projectId, value] of Object.entries(map)) {
      if (!sameProjectPath(projectId, previousProjectId) && !sameProjectPath(projectId, nextProjectId)) {
        continue;
      }
      // Equivalent path spellings can coexist after an older release. Keep
      // the highest recorded value rather than double-counting the same work.
      usage = Math.max(usage, Math.max(0, Math.floor(Number(value) || 0)));
      if (projectId !== nextProjectId) delete map[projectId];
      moved = true;
    }
    if (moved) {
      map[nextProjectId] = usage;
      saveProjectUsageMap(map);
    }
  } catch {
    // The repaired workspace remains usable even if an old usage cache is corrupt.
  }
}

/**
 * Move local sessions when an empty child folder is repaired to the verified
 * direct-parent project root. Preview state tied to the empty folder is
 * deliberately discarded; it cannot safely represent the repaired project.
 */
export function rehomeSessionsToProjectRoot(previousProjectId: string, nextProjectId: string): Session[] {
  const next = String(nextProjectId || "").trim();
  if (!projectPathKey(previousProjectId) || !projectPathKey(next) || sameProjectPath(previousProjectId, next)) {
    return [];
  }
  rehomeProjectUsage(previousProjectId, next);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const moved: Session[] = [];
    const all: Session[] = JSON.parse(raw);
    const updated = all.map((candidate) => {
      const session = safeSessionForStorage(candidate);
      if (!sameProjectPath(session.projectId, previousProjectId)) return session;
      const repaired: Session = { ...session, projectId: next };
      if (!repaired.preview || !sameProjectPath(repaired.preview.projectRoot, next)) {
        delete repaired.preview;
      }
      moved.push(repaired);
      return repaired;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    for (const session of pendingSessionSaves.values()) {
      if (!sameProjectPath(session.projectId, previousProjectId)) continue;
      session.projectId = next;
      if (!session.preview || !sameProjectPath(session.preview.projectRoot, next)) {
        delete session.preview;
      }
    }
    return moved;
  } catch {
    return [];
  }
}

function safeSessionForStorage(session: Session): Session {
  const preview = sanitizeSessionPreview(session.preview);
  const smartAgent = sanitizeSmartAgentTaskState(session.smartAgent);
  const preferredProvider = sanitizeSessionModelId(session.preferredProvider, 64);
  const preferredModel = sanitizeSessionModelId(session.preferredModel, 200);
  const preferredEffort = sanitizeSessionModelId(session.preferredEffort, 32);
  const cursorAgentId = sanitizeSessionModelId(session.cursorAgentId, 128);
  return {
    ...session,
    title: redactChatCredentials(session.title),
    messages: session.messages.map(redactSessionMessage),
    preview,
    smartAgent,
    preferredProvider,
    preferredModel,
    preferredEffort,
    cursorAgentId,
  };
}

/**
 * Build the session portion of the native pre-update backup without requiring
 * another localStorage write. A full or temporarily unavailable WebView store
 * must not prevent the already in-memory transcript from being handed to the
 * host-owned recovery file.
 */
export function snapshotSessionsForUpdate(currentSessions: Iterable<Session>): Record<string, string> {
  const merged = new Map<string, Session>();
  const add = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const session = candidate as Partial<Session>;
    if (
      typeof session.id !== "string" || !session.id.trim() ||
      typeof session.title !== "string" ||
      typeof session.projectId !== "string" || !session.projectId.trim() ||
      !Array.isArray(session.messages) ||
      !Number.isFinite(session.createdAt)
    ) {
      return;
    }
    try {
      const safe = safeSessionForStorage(session as Session);
      merged.set(safe.id, safe);
    } catch {
      // One corrupt legacy session must not prevent the remaining sessions
      // from reaching the native update backup.
    }
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(stored)) stored.forEach(add);
  } catch {
    // Reads can also be denied by a damaged WebView profile. The in-memory
    // registry and pending-save queue below remain enough to protect live work.
  }
  for (const session of pendingSessionSaves.values()) add(session);
  for (const session of currentSessions) add(session);

  return { [STORAGE_KEY]: JSON.stringify([...merged.values()]) };
}

function sanitizeSessionModelId(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

/** Write one or more sessions with a single parse/stringify/localStorage cycle. */
function writeSessions(nextSessions: Iterable<Session>): boolean {
  if (Date.now() < sessionSaveBlockedUntil) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all: Session[] = raw ? JSON.parse(raw) : [];
    for (const session of nextSessions) {
      const safeSession = safeSessionForStorage(session);
      const idx = all.findIndex((s) => s.id === safeSession.id);
      if (idx >= 0) all[idx] = safeSession;
      else all.push(safeSession);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    sessionSaveFailureCount = 0;
    sessionSaveBlockedUntil = 0;
    return true;
  } catch {
    sessionSaveFailureCount = Math.min(6, sessionSaveFailureCount + 1);
    sessionSaveBlockedUntil = Date.now() + Math.min(
      SESSION_SAVE_MAX_BACKOFF_MS,
      1_000 * (2 ** (sessionSaveFailureCount - 1)),
    );
    return false;
  }
}

function clearSessionSaveTimerIfIdle(): void {
  if (pendingSessionSaves.size > 0 || sessionSaveTimer === null) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
}

/** Persist immediately for explicit user actions and completed agent events. */
export function saveSession(session: Session): void {
  pendingSessionSaves.delete(session.id);
  clearSessionSaveTimerIfIdle();
  if (!writeSessions([session])) pendingSessionSaves.set(session.id, session);
}

/** Debounced persistence for high-frequency streamed text/reasoning events. */
export function scheduleSessionSave(session: Session): void {
  pendingSessionSaves.set(session.id, session);
  if (sessionSaveTimer !== null) return;
  const delay = Math.max(SESSION_SAVE_DELAY_MS, sessionSaveBlockedUntil - Date.now());
  sessionSaveTimer = setTimeout(() => {
    flushSessionSaves();
  }, delay);
}

/** Flush queued saves before project/session transitions or app shutdown. */
export function flushSessionSaves(): void {
  if (sessionSaveTimer !== null) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  if (pendingSessionSaves.size === 0) return;
  const queued = [...pendingSessionSaves.values()];
  if (!writeSessions(queued)) return;
  for (const session of queued) pendingSessionSaves.delete(session.id);
}

export function deleteSession(id: string): void {
  pendingSessionSaves.delete(id);
  clearSessionSaveTimerIfIdle();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const all: Session[] = JSON.parse(raw);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(all.filter((s) => s.id !== id)),
    );
  } catch {
    // non-fatal
  }
}
export function deleteAllSessions(projectId: string): void {
  for (const [id, session] of pendingSessionSaves) {
    if (sameProjectPath(session.projectId, projectId)) pendingSessionSaves.delete(id);
  }
  clearSessionSaveTimerIfIdle();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const all: Session[] = JSON.parse(raw);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(all.filter((s) => !sameProjectPath(s.projectId, projectId))),
    );
  } catch {
    // non-fatal
  }
}


export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Derive a short title from the first user message. */
export function sessionTitle(prompt: string): string {
  const hasVideo = /\[Attached video:\s*.+?\]/i.test(prompt);
  const cleaned = prompt
    .replace(/\[Attached image:\s*.+?\]/gi, "")
    .replace(/\[Attached video:\s*.+?\]/gi, "")
    .replace(/\[Video [^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const trimmed = cleaned || (hasVideo ? "Video chat" : "Image chat");
  return trimmed.length > 48 ? trimmed.slice(0, 48) + "…" : trimmed;
}

/** One turn sent to the agent as session memory. */
export type LlmHistoryTurn = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  tool_call_id?: string;
  name?: string;
};

/**
 * Keep follow-up requests responsive. The backend applies a final compact
 * history window too, but limiting the IPC payload here prevents old command
 * output from making desktop sessions slow before the provider is contacted.
 */
const HISTORY_MAX_CHARS = 24_000;
const TOOL_RESULT_MAX = 1_800;
const ASSISTANT_MAX = 3_000;

function clip(text: string, max: number): string {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function toolArgHint(args: any): string {
  if (!args || typeof args !== "object") return "";
  const path = args.path || args.src || args.command || args.pattern || args.url || args.question;
  if (typeof path === "string" && path.trim()) return clip(path, 160);
  try {
    return clip(JSON.stringify(args), 200);
  } catch {
    return "";
  }
}

/**
 * Build maximized conversation memory for the LLM from the session transcript.
 * Excludes the trailing user message that matches the prompt about to be sent.
 * Keeps user/assistant text, tool actions, Q&A, and done summaries; drops pure UI noise.
 */
export function buildLlmHistory(messages: SessionMessage[], currentPrompt: string): LlmHistoryTurn[] {
  const turns: LlmHistoryTurn[] = [];
  let pendingTool: { id: string; name: string; args: any } | null = null;

  // Drop trailing user bubble for the message we're about to send again as `prompt`
  let list = messages.slice();
  if (list.length > 0) {
    const last = list[list.length - 1];
    if (
      last.type === "user" &&
      (last.agentText || last.text).trim() === currentPrompt.trim()
    ) {
      list = list.slice(0, -1);
    }
  }

  const pushUser = (text: string) => {
    const c = clip(redactChatCredentials(text), ASSISTANT_MAX);
    if (!c) return;
    turns.push({ role: "user", content: c });
  };
  const pushAssistant = (
    text: string,
    toolCalls?: { id: string; name: string; arguments: unknown }[],
  ) => {
    const c = clip(redactChatCredentials(text), ASSISTANT_MAX);
    if (!c && !(toolCalls && toolCalls.length)) return;
    turns.push({
      role: "assistant",
      content: c || "",
      ...(toolCalls?.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              ...call,
              arguments: redactToolArguments(call.name, call.arguments),
            })),
          }
        : {}),
    });
  };
  const pushTool = (id: string, name: string, content: string) => {
    const body = clip(redactChatCredentials(content || ""), TOOL_RESULT_MAX);
    turns.push({
      role: "tool",
      content: body || "(empty)",
      tool_call_id: id,
      name,
    });
  };

  for (const msg of list) {
    switch (msg.type) {
      case "user":
        pendingTool = null;
        pushUser(msg.agentText || msg.text);
        break;
      case "assistant":
        pendingTool = null;
        pushAssistant(msg.text);
        break;
      case "thinking":
        if (msg.text?.trim()) {
          pushAssistant(`[Earlier reasoning]\n${clip(msg.text, 3_000)}`);
        }
        break;
      case "tool_call":
        pendingTool = { id: msg.id, name: msg.name, args: msg.arguments };
        pushAssistant("", [
          {
            id: msg.id,
            name: msg.name,
            arguments: msg.arguments ?? {},
          },
        ]);
        break;
      case "tool_result": {
        const name = msg.name || pendingTool?.name || "tool";
        const id = msg.id || pendingTool?.id || `call_${turns.length}`;
        pushTool(id, name, msg.content || (msg.ok ? "ok" : "failed"));
        pendingTool = null;
        break;
      }
      case "question": {
        const ans = msg.answer ? `\nUser chose: ${msg.answer}` : "";
        pushAssistant(`[Asked user] ${clip(msg.question, 800)}${ans}`);
        if (msg.answer) pushUser(msg.answer);
        break;
      }
      case "done": {
        const parts = [
          msg.title && `Title: ${msg.title}`,
          msg.description && `Description: ${msg.description}`,
          msg.summary && `Summary: ${msg.summary}`,
          msg.tech?.length ? `Tech: ${msg.tech.join(", ")}` : "",
          msg.files?.length ? `Files: ${msg.files.slice(0, 40).join(", ")}` : "",
          msg.features?.length ? `Features: ${msg.features.slice(0, 12).join("; ")}` : "",
        ].filter(Boolean);
        if (parts.length) {
          pushAssistant(`[Task completed]\n${parts.join("\n")}`);
        }
        break;
      }
      case "end":
      case "cancelled":
        break;
      case "run_start":
      case "multi_agent_batch":
        break;
    }
  }

  let total = turns.reduce((n, t) => n + t.content.length + 16, 0);
  while (total > HISTORY_MAX_CHARS && turns.length > 2) {
    const removed = turns.shift()!;
    total -= removed.content.length + 16;
  }

  if (total > HISTORY_MAX_CHARS && turns.length) {
    const budget = Math.floor(HISTORY_MAX_CHARS / turns.length);
    for (const t of turns) {
      t.content = clip(t.content, Math.max(800, budget));
    }
  }

  return turns.map((turn) => ({
    ...turn,
    content: redactChatCredentials(turn.content),
  }));
}

/** Append an agent event into a session transcript (no DOM). Used for background sessions. */
export function recordAgentEvent(
  messages: SessionMessage[],
  e: {
    kind: string;
    payload: any;
  },
): void {
  const at = Date.now();
  switch (e.kind) {
    case "start":
      messages.push({
        type: "run_start",
        permissionMode: normalizeSessionPermissionMode(e.payload?.permission_mode),
        executionProfile: e.payload?.execution_profile,
        at,
      });
      break;
    case "multi_agent_batch": {
      const tools = snapshotMultiAgentTools(e.payload?.tools);
      if (tools.length) messages.push({ type: "multi_agent_batch", tools, at });
      break;
    }
    case "thinking":
      messages.push({ type: "thinking", iteration: e.payload.iteration ?? 0, text: "", at });
      break;
    case "reasoning": {
      const safeText = redactChatCredentials(e.payload.text || "");
      const last = messages[messages.length - 1];
      if (last && last.type === "thinking") {
        last.text = last.text ? last.text + safeText : safeText;
      } else {
        messages.push({
          type: "thinking",
          iteration: e.payload.iteration ?? 0,
          text: safeText,
          at,
        });
      }
      break;
    }
    case "text": {
      const safeText = redactChatCredentials(e.payload.text || "");
      appendAssistantTranscriptChunk(
        messages,
        safeText,
        at,
        e.payload.continuation === true,
      );
      break;
    }
    case "tool_call":
      messages.push({
        type: "tool_call",
        id: e.payload.id,
        name: e.payload.name,
        arguments: redactToolArguments(e.payload.name, e.payload.arguments),
        at,
      });
      break;
    case "tool_result": {
      const qIdx = messages.findIndex((m) => m.type === "question" && m.id === e.payload.id);
      if (qIdx >= 0) {
        (messages[qIdx] as any).answer = e.payload.content;
      }
      messages.push({
        type: "tool_result",
        id: e.payload.id,
        name: e.payload.name,
        ok: e.payload.ok,
        content: redactChatCredentials(e.payload.content || ""),
        at,
      });
      break;
    }
    case "done":
      messages.push({
        type: "done",
        summary: redactChatCredentials(e.payload.summary || ""),
        title: redactChatCredentials(e.payload.title || ""),
        description: redactChatCredentials(e.payload.description || ""),
        files: (e.payload.files || []).map(redactChatCredentials),
        tech: (e.payload.tech || []).map(redactChatCredentials),
        features: (e.payload.features || []).map(redactChatCredentials),
        at,
      });
      normalizeLatestAssistantMessage(messages);
      break;
    case "end":
      messages.push({ type: "end", reason: e.payload.reason, at });
      normalizeLatestAssistantMessage(messages);
      break;
    case "cancelled":
      messages.push({ type: "cancelled", at });
      normalizeLatestAssistantMessage(messages);
      break;
    case "question":
      messages.push({
        type: "question",
        id: e.payload.id,
        question: redactChatCredentials(e.payload.question || ""),
        options: (e.payload.options || []).map(redactChatCredentials),
        allow_other: !!e.payload.allow_other,
        answer: null,
        at,
      });
      break;
    default:
      break;
  }
}
