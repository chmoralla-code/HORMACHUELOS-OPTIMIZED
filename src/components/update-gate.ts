import { api, onAppUpdateProgress, type AppUpdateProgress } from "../ipc";
import { el } from "./util";

const UPDATE_MANIFEST_URL = "https://chmoralla-code.github.io/HORMACHUELOS OPTIMIZED-OPTIMIZED/latest.json";

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
};

export type UpdateInstallOptions = {
  /** Add current in-memory app state to the host-owned pre-update backup. */
  beforeInstall?: () => Record<string, string> | void | Promise<Record<string, string> | void>;
  /** Override the native progress source in browser harnesses. */
  progressSubscriber?: (
    callback: (event: AppUpdateProgress) => void,
  ) => Promise<(() => void) | null>;
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

function versionParts(value: string): [number, number, number] | null {
  const parts = value.trim().replace(/^v/, "").split(".");
  if (parts.length !== 3) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return numbers as [number, number, number];
}

function isVersionNewer(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

export async function checkDesktopUpdate(): Promise<UpdateCheck> {
  const currentVersion = await api.appVersion().catch(() => "0.0.0");
  const res = await fetch(UPDATE_MANIFEST_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({})) as Partial<AppRelease> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || "Optimized update check failed (" + res.status + ")");
  }
  const latest = typeof data.version === "string" ? data as AppRelease : null;
  const updateAvailable = Boolean(latest && isVersionNewer(latest.version, currentVersion));
  return {
    updateAvailable,
    forceUpdate: updateAvailable && Boolean(latest?.forceUpdate),
    latest: updateAvailable ? latest : null,
    currentVersion,
  };
}

function progressMessage(event: AppUpdateProgress): string {
  const percent = Number.isFinite(event.percent) && Number(event.percent) >= 0
    ? Math.min(100, Math.round(Number(event.percent)))
    : null;
  if (event.phase === "preparing") return "Securing your workspace…";
  if (event.phase === "downloading") {
    return `Downloading update${percent === null ? "" : ` ${percent}%`}…`;
  }
  if (event.phase === "verifying") return "Verifying secure package…";
  if (event.phase === "installing") {
    return /administrator approval/i.test(String(event.message || ""))
      ? "Approve the Windows administrator prompt…"
      : "Installing Hormachuelos Optimized…";
  }
  if (event.phase === "restarting") return "Relaunching Hormachuelos Optimized…";
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

const INSTALL_STAGES = [
  { phase: "downloading", label: "Download" },
  { phase: "verifying", label: "Verify" },
  { phase: "installing", label: "Install" },
  { phase: "restarting", label: "Relaunch" },
] as const;

const PHASE_DETAILS: Record<Exclude<AppUpdateProgress["phase"], "error">, string> = {
  preparing: "Saving a recovery snapshot before anything changes.",
  downloading: "Fetching the verified Windows installer.",
  verifying: "Matching the package against its published SHA-256 checksum.",
  installing: "Windows is replacing the app while your local data stays untouched.",
  restarting: "Your projects and sessions will return automatically.",
};

const PHASE_LABELS: Record<Exclude<AppUpdateProgress["phase"], "error">, string> = {
  preparing: "PRE-FLIGHT // 01",
  downloading: "TRANSFER // 01 OF 04",
  verifying: "INTEGRITY // 02 OF 04",
  installing: "INSTALL // 03 OF 04",
  restarting: "RELAUNCH // 04 OF 04",
};

const PHASE_TOKENS: Record<Exclude<AppUpdateProgress["phase"], "error">, string> = {
  preparing: "SAFE",
  downloading: "LIVE",
  verifying: "CHECK",
  installing: "APPLY",
  restarting: "100%",
};

type InstallProgressView = {
  root: HTMLElement;
  update: (message: string, event?: AppUpdateProgress) => void;
  fail: (message: string) => void;
};

function buildInstallProgress(): InstallProgressView {
  const root = el("section", {
    class: "update-install-progress",
    "aria-label": "Installer activity",
    hidden: "",
  });

  const hero = el("div", { class: "update-install-hero" });
  const emblem = el("div", { class: "update-install-emblem", "aria-hidden": "true" }, [
    el("span", { class: "update-install-orbit orbit-one" }),
    el("span", { class: "update-install-orbit orbit-two" }),
    el("span", { class: "update-install-core" }, ["H"]),
  ]);
  const copy = el("div", { class: "update-install-copy" });
  const phaseLabel = el("span", { class: "update-install-phase" }, ["PRE-FLIGHT // 01"]);
  const status = el("strong", {
    class: "update-install-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  }, ["Securing your workspace…"]);
  const detail = el("p", { class: "update-install-detail" }, [PHASE_DETAILS.preparing]);
  copy.append(phaseLabel, status, detail);
  hero.append(emblem, copy);
  root.appendChild(hero);

  const meterHeader = el("div", { class: "update-install-meter-head" });
  meterHeader.appendChild(el("span", {}, ["INSTALL SEQUENCE"]));
  const percent = el("strong", { class: "update-install-percent" }, ["SAFE"]);
  meterHeader.appendChild(percent);
  root.appendChild(meterHeader);

  const meter = el("div", {
    class: "update-install-meter is-indeterminate",
    role: "progressbar",
    "aria-label": "Update installation progress",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuetext": "Securing your workspace",
  });
  const fill = el("div", { class: "update-install-meter-fill" });
  meter.appendChild(fill);
  root.appendChild(meter);

  const stageList = el("ol", { class: "update-install-stages", "aria-label": "Installation stages" });
  const stageItems = INSTALL_STAGES.map((stage, index) => {
    const item = el("li", {
      class: `update-install-step${index === 0 ? " is-active" : ""}`,
      "data-stage": stage.phase,
    });
    item.append(
      el("span", { class: "update-install-step-marker", "aria-hidden": "true" }, [String(index + 1)]),
      el("span", { class: "update-install-step-label" }, [stage.label]),
    );
    stageList.appendChild(item);
    return item;
  });
  root.appendChild(stageList);
  root.appendChild(el("p", { class: "update-install-foot" }, [
    "Keep Hormachuelos Optimized open — it will relaunch itself when the handoff is complete.",
  ]));

  const update = (message: string, event?: AppUpdateProgress) => {
    const phase = event?.phase && event.phase !== "error" ? event.phase : "preparing";
    const stageIndex = phase === "preparing"
      ? 0
      : INSTALL_STAGES.findIndex((stage) => stage.phase === phase);
    const rawPercent = phase === "downloading" && Number.isFinite(event?.percent)
      ? Math.max(0, Math.min(100, Math.round(Number(event?.percent))))
      : phase === "restarting"
        ? 100
        : null;

    root.hidden = false;
    root.dataset.phase = phase;
    root.dataset.stageIndex = String(Math.max(0, stageIndex));
    root.classList.remove("is-error", "is-restarting");
    root.classList.toggle("is-restarting", phase === "restarting");
    status.classList.remove("is-error");
    phaseLabel.textContent = PHASE_LABELS[phase];
    status.textContent = message;
    detail.textContent = PHASE_DETAILS[phase];
    percent.textContent = rawPercent === null ? PHASE_TOKENS[phase] : `${rawPercent}%`;

    meter.classList.toggle("is-indeterminate", rawPercent === null);
    if (rawPercent === null) {
      meter.removeAttribute("aria-valuenow");
      meter.setAttribute("aria-valuetext", message.replace(/…$/, ""));
      fill.style.removeProperty("width");
    } else {
      meter.setAttribute("aria-valuenow", String(rawPercent));
      meter.setAttribute("aria-valuetext", `${rawPercent}% complete`);
      fill.style.width = `${rawPercent}%`;
    }

    for (let index = 0; index < stageItems.length; index += 1) {
      const item = stageItems[index];
      const complete = index < stageIndex;
      item.classList.toggle("is-complete", complete);
      item.classList.toggle("is-active", index === stageIndex);
      item.classList.remove("is-error");
      const marker = item.querySelector(".update-install-step-marker");
      if (marker) marker.textContent = complete ? "✓" : String(index + 1);
    }
  };

  const fail = (message: string) => {
    const stageIndex = Math.max(0, Number(root.dataset.stageIndex || 0));
    root.hidden = false;
    root.dataset.phase = "error";
    root.classList.remove("is-restarting");
    root.classList.add("is-error");
    phaseLabel.textContent = "UPDATE SAFE // PAUSED";
    status.textContent = message;
    status.classList.add("is-error");
    detail.textContent = "Your current installation is untouched. You can retry whenever you're ready.";
    percent.textContent = "SAFE";
    meter.classList.remove("is-indeterminate");
    meter.removeAttribute("aria-valuenow");
    meter.setAttribute("aria-valuetext", "Update stopped safely");
    fill.style.width = "0%";
    for (let index = 0; index < stageItems.length; index += 1) {
      stageItems[index].classList.toggle("is-active", index === stageIndex);
      stageItems[index].classList.toggle("is-error", index === stageIndex);
    }
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
      laterBtn.addEventListener("click", close);

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
        title.textContent = `Installing v${latest.version}`;
        subtitle.textContent = "Your workspace is protected. Keep this window open for the automatic relaunch.";
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
      ensureFocusInside();
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
    title.textContent = `Installing v${latest.version}`;
    subtitle.textContent = "Your local workspace is protected during the secure handoff.";
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
