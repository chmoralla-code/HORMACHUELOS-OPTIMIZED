import { api, onAppUpdateProgress, type AppUpdateProgress } from "../ipc";
import { isVersionNewer } from "../update-version";
import { el } from "./util";

export const UPDATE_MANIFEST_URL = "https://chmoralla-code.github.io/HORMACHUELOS-OPTIMIZED/latest.json";
const UPDATE_PROMPT_STORAGE_KEY = "ai-forge:update-prompted";

export type AppRelease = {
  version: string;
  title?: string;
  whatsNew?: string;
  msiUrl?: string;
  exeUrl?: string;
  msiSha256?: string;
  exeSha256?: string;
  forceUpdate?: boolean;
  publishedAt?: string;
};

export type UpdateCheck = {
  updateAvailable: boolean;
  forceUpdate: boolean;
  latest: AppRelease | null;
  currentVersion: string;
  localDebugBuild?: boolean;
  publishedVersion?: string | null;
};

export type UpdateInstallOptions = {
  /** Add current in-memory app state to the host-owned pre-update backup. */
  beforeInstall?: () => Record<string, string> | void | Promise<Record<string, string> | void>;
  /** Override the native progress source in browser harnesses. */
  progressSubscriber?: (
    callback: (event: AppUpdateProgress) => void,
  ) => Promise<(() => void) | null>;
  /** Sidebar Update starts the download as soon as a newer release is found. */
  autoInstall?: boolean;
};

type UpdateStateBackup = {
  format: 1;
  savedAt: string;
  entries: Record<string, string>;
};

const SESSION_STORAGE_KEY = "ai-forge:sessions";

function serializeUpdateState(overrides?: Record<string, string> | void): string {
  const entries: Record<string, string> = {};
  try {
    const length = localStorage.length;
    for (let index = 0; index < length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("ai-forge:")) continue;
      try {
        const value = localStorage.getItem(key);
        if (value !== null) entries[key] = value;
      } catch {
        // A single unreadable key must not hide readable app state or the
        // in-memory session snapshot supplied by `beforeInstall`.
      }
    }
  } catch {
    // Some WebView profiles deny storage access entirely. The native backup
    // can still safely carry the explicitly supplied in-memory entries.
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key.startsWith("ai-forge:") && typeof value === "string") entries[key] = value;
    }
  }
  return JSON.stringify({
    format: 1,
    savedAt: new Date().toISOString(),
    entries,
  } satisfies UpdateStateBackup);
}

function mergeSessionBackup(current: string | null, backup: string): string {
  const merged = new Map<string, unknown>();
  const add = (raw: string | null) => {
    if (!raw) return;
    let sessions: unknown;
    try {
      sessions = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(sessions)) return;
    for (const candidate of sessions) {
      if (!candidate || typeof candidate !== "object") continue;
      const id = String((candidate as { id?: unknown }).id || "").trim();
      if (id) merged.set(id, candidate);
    }
  };
  add(current);
  // The native backup is captured after the live chat has been synchronized,
  // so it deliberately wins for duplicate session ids.
  add(backup);
  return merged.size > 0 ? JSON.stringify([...merged.values()]) : backup;
}

/** Restore missing keys and merge the fresher session snapshot after relaunch. */
export async function restoreUpdateState(): Promise<number> {
  const raw = await api.loadUpdateBackup();
  if (!raw) return 0;
  const backup = JSON.parse(raw) as Partial<UpdateStateBackup>;
  if (backup.format !== 1 || !backup.entries || typeof backup.entries !== "object") {
    throw new Error("The saved pre-update data has an unsupported format.");
  }
  let restored = 0;
  let storageFailure = false;
  for (const [key, value] of Object.entries(backup.entries)) {
    if (!key.startsWith("ai-forge:") || typeof value !== "string") continue;
    try {
      const current = localStorage.getItem(key);
      const next = key === SESSION_STORAGE_KEY
        ? mergeSessionBackup(current, value)
        : value;
      if (current !== null && (key !== SESSION_STORAGE_KEY || current === next)) continue;
      localStorage.setItem(key, next);
      restored += 1;
    } catch {
      storageFailure = true;
    }
  }
  if (storageFailure) {
    throw new Error("The pre-update backup is safe, but WebView storage is still unavailable.");
  }
  await api.clearUpdateBackup();
  return restored;
}

export function shouldPromptUpdate(version: string): boolean {
  const next = String(version || "").trim().replace(/^v/i, "");
  if (!next) return false;
  try {
    return localStorage.getItem(UPDATE_PROMPT_STORAGE_KEY) !== next;
  } catch {
    return true;
  }
}

export function markUpdatePrompted(version: string): void {
  const next = String(version || "").trim().replace(/^v/i, "");
  if (!next) return;
  try {
    localStorage.setItem(UPDATE_PROMPT_STORAGE_KEY, next);
  } catch {
    // Private-mode WebView storage must not block the sidebar badge.
  }
}

export async function checkDesktopUpdate(): Promise<UpdateCheck> {
  const currentVersion = await api.appVersion().catch(() => "0.0.0");
  const localDebugBuild = await api.appIsDevBuild().catch(() => false);
  const res = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({})) as Partial<AppRelease> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || "Optimized update check failed (" + res.status + ")");
  }
  const latest = typeof data.version === "string" ? data as AppRelease : null;
  if (localDebugBuild) {
    return {
      updateAvailable: false,
      forceUpdate: false,
      latest: null,
      currentVersion,
      localDebugBuild: true,
      publishedVersion: latest?.version ?? null,
    };
  }
  const updateAvailable = Boolean(latest && isVersionNewer(latest.version, currentVersion));
  return {
    updateAvailable,
    forceUpdate: updateAvailable && Boolean(latest?.forceUpdate),
    latest: updateAvailable ? latest : null,
    currentVersion,
  };
}

function progressPercent(event?: AppUpdateProgress): number {
  if (event && Number.isFinite(event.percent) && Number(event.percent) >= 0) {
    return Math.min(100, Math.round(Number(event.percent)));
  }
  switch (event?.phase) {
    case "downloading":
      return 8;
    case "verifying":
      return 85;
    case "installing":
      return 92;
    case "restarting":
      return 100;
    default:
      return 0;
  }
}

function progressMessage(event: AppUpdateProgress): string {
  const percent = progressPercent(event);
  if (event.phase === "preparing") return "Saving your workspace…";
  if (event.phase === "downloading") return `Downloading… ${percent}%`;
  if (event.phase === "verifying") return "Checking the installer…";
  if (event.phase === "installing") {
    return /administrator approval/i.test(String(event.message || ""))
      ? "Approve the Windows administrator prompt…"
      : "Installing…";
  }
  if (event.phase === "restarting") return "Restarting…";
  const fallback = String(event.message || "Update paused").replace(/…$/, "");
  return `${fallback}…`;
}

function updateFailureMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message || "")
        : "";
  const message = raw.replace(/\s+/g, " ").trim().slice(0, 420);
  return message ? `Update failed: ${message}` : "Update failed. Please try again.";
}

function buildVersionSummary(currentVersion: string, latestVersion: string): HTMLElement {
  const summary = el("div", {
    class: "update-version-summary",
    "aria-label": `Installed version ${currentVersion}; update version ${latestVersion}`,
  });
  summary.append(
    el("div", { class: "update-version-cell" }, [
      el("span", { class: "update-version-label" }, ["Installed"]),
      el("strong", { class: "update-version-value" }, [`v${currentVersion}`]),
    ]),
    el("span", { class: "update-version-arrow", "aria-hidden": "true" }, ["→"]),
    el("div", { class: "update-version-cell is-ready" }, [
      el("span", { class: "update-version-label" }, ["Ready to install"]),
      el("strong", { class: "update-version-value" }, [`v${latestVersion}`]),
    ]),
  );
  return summary;
}

function buildReleaseNotes(release: AppRelease): HTMLElement {
  const group = el("section", { class: "update-notes-group", "aria-label": "What's new" });
  group.appendChild(el("p", { class: "update-section-label" }, ["What's new"]));
  const notes = el("div", { class: "update-notes auth-gate-sub" });
  notes.style.whiteSpace = "pre-wrap";
  notes.textContent = release.whatsNew || release.title || "Bug fixes and improvements.";
  group.appendChild(notes);
  return group;
}

type InstallProgressView = {
  root: HTMLElement;
  update: (message: string, event?: AppUpdateProgress) => void;
  fail: (message: string) => void;
};

function buildInstallProgress(): InstallProgressView {
  const root = el("section", {
    class: "update-install-progress",
    "aria-label": "Update progress",
    hidden: "",
  });
  const percent = el("strong", {
    class: "update-install-percent",
    "aria-hidden": "true",
  }, ["0%"]);
  const meter = el("div", {
    class: "update-install-meter",
    role: "progressbar",
    "aria-label": "Update installation progress",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": "0",
    "aria-valuetext": "0 percent",
  });
  const fill = el("div", { class: "update-install-meter-fill" });
  meter.appendChild(fill);
  const status = el("p", {
    class: "update-install-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  }, ["Saving your workspace…"]);
  const hint = el("p", { class: "update-install-hint" }, [
    "Keep this window open. The app will restart itself.",
  ]);
  root.append(percent, meter, status, hint);

  const paint = (value: number, message: string) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    percent.textContent = `${clamped}%`;
    fill.style.width = `${clamped}%`;
    meter.setAttribute("aria-valuenow", String(clamped));
    meter.setAttribute("aria-valuetext", `${clamped} percent. ${message.replace(/…$/, "")}`);
    status.textContent = message;
  };

  const update = (message: string, event?: AppUpdateProgress) => {
    const phase = event?.phase && event.phase !== "error" ? event.phase : "preparing";
    root.hidden = false;
    root.dataset.phase = phase;
    root.classList.remove("is-error", "is-restarting");
    root.classList.toggle("is-restarting", phase === "restarting");
    status.classList.remove("is-error");
    hint.textContent = phase === "restarting"
      ? "Opening the new build now."
      : "Keep this window open. The app will restart itself.";
    paint(progressPercent(event), message);
  };

  const fail = (message: string) => {
    root.hidden = false;
    root.dataset.phase = "error";
    root.classList.remove("is-restarting");
    root.classList.add("is-error");
    status.classList.add("is-error");
    percent.textContent = "—";
    fill.style.width = "0%";
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", "Update stopped");
    status.textContent = message;
    hint.textContent = "Your current installation is untouched.";
  };

  return { root, update, fail };
}

function buildUpdatePreflight(): HTMLElement {
  const preflight = el("div", { class: "update-preflight", "aria-label": "Update safeguards" });
  const addSignal = (title: string, detail: string) => {
    const item = el("div", { class: "update-preflight-item" });
    item.append(
      el("span", { class: "update-preflight-mark", "aria-hidden": "true" }, ["✓"]),
      el("span", { class: "update-preflight-copy" }, [
        el("strong", {}, [title]),
        el("small", {}, [detail]),
      ]),
    );
    preflight.appendChild(item);
  };
  addSignal("Local workspace protected", "A recovery snapshot is saved first.");
  addSignal("SHA-256 verification", "The package is checked before launch.");
  return preflight;
}

async function installInsideApp(
  release: AppRelease,
  options: UpdateInstallOptions,
  onProgress: (message: string, event?: AppUpdateProgress) => void,
): Promise<void> {
  const installKind = await api.appInstallKind().catch(() => "unknown" as const);
  const msi = { url: release.msiUrl, sha256: release.msiSha256 };
  const nsis = { url: release.exeUrl, sha256: release.exeSha256 };
  const installer = (installKind === "nsis" ? [nsis, msi] : [msi, nsis])
    .find((candidate) => candidate.url && candidate.sha256);
  if (!installer?.url || !installer.sha256) {
    if (release.exeUrl || release.msiUrl) {
      throw new Error("This release is missing its installer checksum.");
    }
    throw new Error("This release has no Windows installer.");
  }
  const preparingEvent: AppUpdateProgress = {
    phase: "preparing",
    percent: 0,
    message: "Preparing the secure update",
  };
  onProgress(progressMessage(preparingEvent), preparingEvent);
  const inMemoryEntries = await options.beforeInstall?.();
  await api.saveUpdateBackup(serializeUpdateState(inMemoryEntries));
  const subscribeToProgress = options.progressSubscriber || onAppUpdateProgress;
  const unlisten = await subscribeToProgress(
    (event) => onProgress(progressMessage(event), event),
  ).catch(() => null);
  try {
    await api.installAppUpdate(installer.url, release.version, installer.sha256);
    const restartingEvent: AppUpdateProgress = {
      phase: "restarting",
      percent: 100,
      message: "Restarting Hormachuelos Optimized",
    };
    onProgress(progressMessage(restartingEvent), restartingEvent);
  } finally {
    unlisten?.();
  }
}

/** Dismissible manual update checker opened from the desktop sidebar. */
export function showUpdateDialog(options: UpdateInstallOptions = {}): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".update-dialog-overlay");
  if (existing) {
    if (existing.getAttribute("aria-busy") === "true") return existing;
    existing.dispatchEvent(new Event("update-dialog-dismiss"));
    if (existing.isConnected) existing.remove();
  }
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const inertSiblings = Array.from(document.body.children)
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => ({ node, wasInert: node.inert }));
  for (const { node } of inertSiblings) node.inert = true;

  const overlay = el("div", {
    class: "auth-gate-overlay update-dialog-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "update-dialog-title",
  });
  const card = el("div", { class: "auth-gate-card update-dialog-card" });
  const top = el("div", { class: "update-dialog-top" });
  const brandRail = el("div", { class: "update-dialog-brand-rail" });
  brandRail.append(
    el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS OPTIMIZED"]),
    el("div", { class: "update-dialog-channel" }, [
      el("span", { class: "update-dialog-channel-dot", "aria-hidden": "true" }),
      "SECURE UPDATE",
    ]),
  );
  top.appendChild(brandRail);
  const closeBtn = el("button", {
    class: "update-dialog-close",
    type: "button",
    title: "Close",
    "aria-label": "Close update checker",
  }, ["×"]) as HTMLButtonElement;
  top.appendChild(closeBtn);
  card.appendChild(top);
  const content = el("div", { class: "update-dialog-content", "aria-live": "polite" });
  card.appendChild(content);
  overlay.appendChild(card);

  let closed = false;
  let installing = false;
  const close = () => {
    if (closed || installing) return;
    closed = true;
    overlay.remove();
    for (const { node, wasInert } of inertSiblings) node.inert = wasInert;
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    });
  };
  overlay.addEventListener("update-dialog-dismiss", close);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) {
      event.preventDefault();
      card.tabIndex = -1;
      card.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  const ensureFocusInside = () => {
    const focusCloseButton = () => {
      if (overlay.isConnected && !overlay.contains(document.activeElement)) {
        closeBtn.focus({ preventScroll: true });
      }
    };
    if (overlay.isConnected) focusCloseButton();
    else window.requestAnimationFrame(focusCloseButton);
  };

  const addTitle = (title: string) => {
    content.appendChild(el("h1", { class: "auth-gate-title", id: "update-dialog-title" }, [title]));
  };
  const addSub = (message: string) => {
    content.appendChild(el("p", { class: "auth-gate-sub" }, [message]));
  };
  const renderCheck = (check: UpdateCheck) => {
    content.replaceChildren();
    content.classList.remove("is-installing", "is-error");
    overlay.classList.remove("is-installing", "is-error");
    card.classList.remove("is-installing", "is-error");
    const latest = check.latest;
    if (check.localDebugBuild) {
      addTitle("Local debug build");
      const published = check.publishedVersion || check.currentVersion;
      addSub(
        `This window is running current source (v${check.currentVersion} debug), not the GitHub installer. The published release is still v${published} and would show the older shipped notes.`,
      );
      const doneBtn = el("button", { class: "btn primary", type: "button" }, ["Done"]);
      doneBtn.addEventListener("click", close);
      content.appendChild(doneBtn);
      ensureFocusInside();
      return;
    }
    if (check.updateAvailable && latest) {
      const kicker = el("div", { class: "update-dialog-kicker" }, [
        el("span", { "aria-hidden": "true" }, ["◆"]),
        "VERIFIED DESKTOP RELEASE",
      ]);
      const title = el("h1", {
        class: "auth-gate-title update-dialog-title",
        id: "update-dialog-title",
      }, ["Update available"]);
      const subtitle = el("p", { class: "auth-gate-sub update-dialog-subtitle" }, [
        "A fresh build is ready. Install it here and Hormachuelos Optimized will reopen on its own.",
      ]);
      content.append(kicker, title, subtitle);

      const readyView = el("div", { class: "update-ready-view" });
      readyView.append(
        buildVersionSummary(check.currentVersion, latest.version),
        buildReleaseNotes(latest),
        buildUpdatePreflight(),
      );
      content.appendChild(readyView);

      const progress = buildInstallProgress();
      content.appendChild(progress.root);
      const installBtn = el("button", { class: "btn primary", type: "button" }, [
        `Install v${latest.version}`,
      ]) as HTMLButtonElement;
      const laterBtn = el("button", { class: "btn update-later-btn", type: "button" }, ["Not now"]);
      const actions = el("div", { class: "update-dialog-actions" }, [installBtn, laterBtn]);
      laterBtn.addEventListener("click", () => {
        markUpdatePrompted(latest.version);
        close();
      });

      const startInstall = () => {
        if (installing) return;
        installing = true;
        overlay.setAttribute("aria-busy", "true");
        overlay.classList.remove("is-error");
        overlay.classList.add("is-installing");
        card.classList.remove("is-error");
        card.classList.add("is-installing");
        content.classList.remove("is-error");
        content.classList.add("is-installing");
        closeBtn.disabled = true;
        installBtn.disabled = true;
        laterBtn.disabled = true;
        readyView.hidden = true;
        actions.hidden = true;
        kicker.hidden = true;
        title.textContent = `Updating to v${latest.version}`;
        subtitle.textContent = "Keep this window open. The app will restart itself.";
        const preparingEvent: AppUpdateProgress = {
          phase: "preparing",
          percent: 0,
          message: "Preparing the secure update",
        };
        progress.update(progressMessage(preparingEvent), preparingEvent);
        void installInsideApp(latest, options, (message, event) => {
          progress.update(message, event);
        }).catch((error) => {
          installing = false;
          overlay.removeAttribute("aria-busy");
          overlay.classList.remove("is-installing");
          overlay.classList.add("is-error");
          card.classList.remove("is-installing");
          card.classList.add("is-error");
          content.classList.remove("is-installing");
          content.classList.add("is-error");
          closeBtn.disabled = false;
          installBtn.disabled = false;
          laterBtn.disabled = false;
          actions.hidden = false;
          title.textContent = "Update paused";
          subtitle.textContent = "Hormachuelos Optimized stayed open and no installed files were changed.";
          progress.fail(updateFailureMessage(error));
          installBtn.textContent = "Try installation again";
          laterBtn.textContent = "Close";
          installBtn.focus({ preventScroll: true });
        });
      };
      installBtn.addEventListener("click", startInstall);
      content.appendChild(actions);
      if (options.autoInstall) startInstall();
      else ensureFocusInside();
      return;
    }

    addTitle("You're up to date");
    addSub(`Hormachuelos Optimized v${check.currentVersion} is the latest version.`);
    const doneBtn = el("button", { class: "btn primary", type: "button" }, ["Done"]);
    doneBtn.addEventListener("click", close);
    content.appendChild(doneBtn);
    ensureFocusInside();
  };

  const runCheck = async () => {
    content.replaceChildren();
    addTitle("Checking for updates…");
    addSub("Looking for the latest Hormachuelos Optimized release.");
    try {
      renderCheck(await checkDesktopUpdate());
    } catch {
      content.replaceChildren();
      addTitle("Couldn't check for updates");
      addSub("Check your internet connection, then try again.");
      const retryBtn = el("button", { class: "btn primary", type: "button" }, ["Try again"]);
      retryBtn.addEventListener("click", () => void runCheck());
      content.appendChild(retryBtn);
      ensureFocusInside();
    }
  };

  void runCheck();
  ensureFocusInside();
  return overlay;
}

/** Non-dismissible gate when a forced update is published. */
export function showUpdateGate(
  check: UpdateCheck,
  options: UpdateInstallOptions = {},
): HTMLElement {
  const latest = check.latest!;
  const overlay = el("div", {
    class: "auth-gate-overlay update-required-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "required-update-title",
  });
  const card = el("div", { class: "auth-gate-card update-dialog-card update-required-card" });
  card.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS OPTIMIZED"]));
  card.appendChild(el("div", { class: "update-dialog-kicker" }, [
    el("span", { "aria-hidden": "true" }, ["◆"]),
    "REQUIRED SECURE RELEASE",
  ]));
  const title = el("h1", {
    class: "auth-gate-title update-dialog-title",
    id: "required-update-title",
  }, ["Update required"]);
  const subtitle = el("p", { class: "auth-gate-sub update-dialog-subtitle" }, [
    "This build is required before agents can run again.",
  ]);
  card.append(title, subtitle);

  const readyView = el("div", { class: "update-ready-view" }, [
    buildVersionSummary(check.currentVersion, latest.version),
    buildReleaseNotes(latest),
    buildUpdatePreflight(),
  ]);
  card.appendChild(readyView);
  const progress = buildInstallProgress();
  card.appendChild(progress.root);

  const actions = el("div", { class: "update-dialog-actions is-required" });
  const updateBtn = el("button", { class: "btn primary", type: "button" }, [
    `Install v${latest.version}`,
  ]) as HTMLButtonElement;
  updateBtn.addEventListener("click", () => {
    if (updateBtn.disabled) return;
    updateBtn.disabled = true;
    overlay.setAttribute("aria-busy", "true");
    overlay.classList.remove("is-error");
    overlay.classList.add("is-installing");
    card.classList.remove("is-error");
    card.classList.add("is-installing");
    readyView.hidden = true;
    actions.hidden = true;
    title.textContent = `Updating to v${latest.version}`;
    subtitle.textContent = "Keep this window open. The app will restart itself.";
    const preparingEvent: AppUpdateProgress = {
      phase: "preparing",
      percent: 0,
      message: "Preparing the secure update",
    };
    progress.update(progressMessage(preparingEvent), preparingEvent);
    void installInsideApp(latest, options, (message, event) => {
      progress.update(message, event);
    }).catch((error) => {
      overlay.removeAttribute("aria-busy");
      overlay.classList.remove("is-installing");
      overlay.classList.add("is-error");
      card.classList.remove("is-installing");
      card.classList.add("is-error");
      updateBtn.disabled = false;
      actions.hidden = false;
      title.textContent = "Update paused";
      subtitle.textContent = "The current installation is still safe. Retry to continue.";
      progress.fail(updateFailureMessage(error));
      updateBtn.textContent = "Try installation again";
      updateBtn.focus({ preventScroll: true });
    });
  });
  actions.appendChild(updateBtn);
  card.appendChild(actions);
  overlay.appendChild(card);
  return overlay;
}
