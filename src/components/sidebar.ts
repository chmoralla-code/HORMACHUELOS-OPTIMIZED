import { api } from "../ipc";
import { icon } from "./icons";
import { clear, div, el, displayPlanLabel } from "./util";
import { SESSION_TOKEN_BUDGET, type Session } from "./session";
import type { ProjectWorkspace } from "./projects";

const PROJECTS_COLLAPSED_KEY = "ai-forge:sidebar-projects-collapsed";
const SESSIONS_COLLAPSED_KEY = "ai-forge:sidebar-sessions-collapsed";

function readCollapsedPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeCollapsedPreference(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? "1" : "0");
  } catch {
    // The sidebar still works when storage is unavailable (for example, in a
    // locked-down preview); only persistence is skipped.
  }
}

function normalizeSidebarSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export type UsageDisplayMeta = {
  /** Remaining plan % (for aria / empty styling). */
  percent?: number;
  poolLabel?: string;
  resetsIn?: string;
  blockedBy?: string;
  planRemaining?: number;
  planExpiresAt?: string;
  planName?: string;
  planActive?: boolean;
  tokensUsed?: number;
  tokenBudget?: number;
};

export type AccountStatusState =
  | { state: "checking" }
  | { state: "synced"; email: string; name?: string; plan?: string | null }
  | { state: "offline"; email?: string; detail?: string }
  | { state: "signed_out"; detail?: string };

export class Sidebar {
  node: HTMLElement;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSelectProject: (path: string) => void;
  /** Forget a remembered project; this never deletes its folder or files. */
  onRemoveProject: (path: string) => void;
  onAddAnotherProject: () => void;
  /** Open Hormachuelos' app-managed workspace (no folder picker required). */
  onOpenQuickSessions: () => void;
  onOpenSettings: () => void;
  /** Check the hosted release feed and offer the latest installer. */
  onCheckForUpdates: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteAllSessions: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  /** Export client pack zip for freelancers. */
  onExportClientPack: () => void;
  /** Open GCash top-up / pricing. */
  onTopUp: () => void;
  /** Open website account / re-link desktop login. */
  onManageAccount: () => void;
  /** Refresh website sync status. */
  onRefreshAccount: () => void;
  /** Current project path (composer chip shows it; left drawer does not). */
  private projectPath: string | null = null;
  private projectWorkspaces: ProjectWorkspace[] = [];
  private activeProjectPath: string | null = null;
  private quickSessionWorkspacePath: string | null = null;
  private quickSessionsActive = false;
  private runningProjectPaths = new Set<string>();
  private usageMeta: UsageDisplayMeta = {};
  private usageRoot: HTMLElement | null = null;
  private usageDisclosure: HTMLDetailsElement | null = null;
  private usageSummary: HTMLElement | null = null;
  private usageExpanded = false;
  private accountRoot: HTMLElement | null = null;
  private accountIdentityRoot: HTMLButtonElement | null = null;
  private accountStatus: AccountStatusState = { state: "checking" };
  private updateButton: HTMLButtonElement | null = null;
  private updateAvailable = false;
  private updateVersion = "";
  private projectsCollapsed = readCollapsedPreference(PROJECTS_COLLAPSED_KEY);
  private sessionsCollapsed = readCollapsedPreference(SESSIONS_COLLAPSED_KEY);
  private projectSearchOpen = false;
  private sessionSearchOpen = false;
  private projectSearchQuery = "";
  private sessionSearchQuery = "";

  constructor(handlers: {
    onNewProject: () => void;
    onOpenProject: () => void;
    onSelectProject: (path: string) => void;
    onRemoveProject: (path: string) => void;
    onAddAnotherProject: () => void;
    onOpenQuickSessions: () => void;
    onOpenSettings: () => void;
    onCheckForUpdates: () => void;
    onNewSession: () => void;
    onSelectSession: (id: string) => void;
    onDeleteAllSessions: () => void;
    onDeleteSession: (id: string) => void;
    onRenameSession: (id: string, title: string) => void;
    onExportClientPack: () => void;
    onTopUp: () => void;
    onManageAccount: () => void;
    onRefreshAccount: () => void;
  }) {
    this.onNewProject = handlers.onNewProject;
    this.onOpenProject = handlers.onOpenProject;
    this.onSelectProject = handlers.onSelectProject;
    this.onRemoveProject = handlers.onRemoveProject;
    this.onAddAnotherProject = handlers.onAddAnotherProject;
    this.onOpenQuickSessions = handlers.onOpenQuickSessions;
    this.onOpenSettings = handlers.onOpenSettings;
    this.onCheckForUpdates = handlers.onCheckForUpdates;
    this.onNewSession = handlers.onNewSession;
    this.onSelectSession = handlers.onSelectSession;
    this.onDeleteAllSessions = handlers.onDeleteAllSessions;
    this.onDeleteSession = handlers.onDeleteSession;
    this.onRenameSession = handlers.onRenameSession;
    this.onExportClientPack = handlers.onExportClientPack;
    this.onTopUp = handlers.onTopUp;
    this.onManageAccount = handlers.onManageAccount;
    this.onRefreshAccount = handlers.onRefreshAccount;
    this.node = document.getElementById("sidebar")!;
    this.render();
  }
  async render(sessions: Session[] = [], activeSessionId?: string | null, runningIds: Set<string> = new Set()) {
    const version = await api.appVersion().catch(() => "0.1.0");

    clear(this.node);
    this.usageRoot = null;
    this.usageDisclosure = null;
    this.usageSummary = null;
    this.accountRoot = null;
    this.accountIdentityRoot = null;

    this.node.appendChild(div("sb-brand",
      `<div class="sb-logo">H</div><div class="sb-title">Hormachuelos Optimized</div><div class="sb-version">FPS · v${version}</div>`));

    const actions = el("div", { class: "sb-actions" });
    const updateBtn = this.actionBtn("refresh", "Update", this.onCheckForUpdates);
    updateBtn.classList.add("sb-update-action");
    this.updateButton = updateBtn;
    this.paintUpdateNotification();
    actions.appendChild(updateBtn);
    // Keep the workspace list as the primary part of the sidebar. Less
    // frequent setup actions live in a compact, keyboard-accessible menu so
    // projects, sessions, and usage do not get pushed below the fold. The
    // update control remains above it, so it is never hidden by the menu.
    actions.appendChild(this.buildWorkspaceActionsMenu());
    this.node.appendChild(actions);

    const workspaceSections = el("div", { class: "sb-workspace-sections" });
    workspaceSections.appendChild(this.buildProjectsSection());

    // Sessions section — search and disclosure controls stay reachable even
    // when the list itself is collapsed.
    const sessionSection = el("div", {
      class: `sb-section sb-sessions-section${this.sessionsCollapsed ? " is-collapsed" : ""}`,
    });
    const sessionHeader = el("div", { class: "sb-section-row sb-sessions-head" });
    const sessionHeading = el("div", { class: "sb-section-heading" });
    sessionHeading.appendChild(el("div", { class: "sb-section-label" }, ["Sessions"]));
    sessionHeading.appendChild(el("span", {
      class: "sb-section-count",
      "aria-label": `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
    }, [String(sessions.length)]));
    sessionHeader.appendChild(sessionHeading);
    const sessionActions = el("div", { class: "sb-session-actions" });
    const newSessionBtn = el("button", { class: "sb-section-control sb-new-session", type: "button", "aria-label": "New session", title: "New session", html: icon("new", 14) });
    newSessionBtn.addEventListener("click", () => this.onNewSession());
    sessionActions.appendChild(newSessionBtn);
    const sessionSearchToggle = el("button", {
      class: `sb-section-control sb-section-search-toggle${this.sessionSearchOpen ? " is-active" : ""}`,
      type: "button",
      "aria-label": this.sessionSearchOpen ? "Close session search" : "Search sessions",
      title: this.sessionSearchOpen ? "Close session search" : "Search sessions",
      "aria-controls": "sidebar-session-search",
      "aria-expanded": String(this.sessionSearchOpen),
      html: icon("search", 14),
    }) as HTMLButtonElement;
    sessionActions.appendChild(sessionSearchToggle);
    if (sessions.length > 0) {
      const delAllBtn = el("button", { class: "sb-section-control sb-del-all-sessions", type: "button", "aria-label": "Delete all sessions", title: "Delete all sessions", html: icon("trash", 14) });
      delAllBtn.addEventListener("click", () => this.onDeleteAllSessions());
      sessionActions.appendChild(delAllBtn);
    }
    const sessionCollapse = el("button", {
      class: "sb-section-control sb-section-collapse",
      type: "button",
      "aria-label": this.sessionsCollapsed ? "Expand sessions" : "Collapse sessions",
      title: this.sessionsCollapsed ? "Expand sessions" : "Collapse sessions",
      "aria-controls": "sidebar-session-body",
      "aria-expanded": String(!this.sessionsCollapsed),
      html: icon("chevronDown", 13),
    }) as HTMLButtonElement;
    sessionActions.appendChild(sessionCollapse);
    sessionHeader.appendChild(sessionActions);
    sessionSection.appendChild(sessionHeader);

    const sessionBody = el("div", {
      class: "sb-section-body",
      id: "sidebar-session-body",
    });
    sessionBody.hidden = this.sessionsCollapsed;

    const sessionSearch = el("label", {
      class: "sb-list-search",
      id: "sidebar-session-search",
    });
    sessionSearch.hidden = !this.sessionSearchOpen;
    sessionSearch.appendChild(el("span", { class: "sb-list-search-icon", html: icon("search", 13) }));
    const sessionSearchInput = el("input", {
      class: "sb-list-search-input",
      type: "search",
      placeholder: "Search sessions",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search sessions",
    }) as HTMLInputElement;
    sessionSearchInput.value = this.sessionSearchQuery;
    sessionSearch.appendChild(sessionSearchInput);
    const sessionSearchStatus = el("span", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
    });
    sessionSearch.appendChild(sessionSearchStatus);
    sessionBody.appendChild(sessionSearch);

    const sessionList = el("div", { class: "sb-recent" });
    if (sessions.length === 0) {
      sessionList.appendChild(el("div", { class: "sb-recent-item empty" }, ["No sessions yet"]));
    } else {
      for (const s of sessions) {
        const isRunning = runningIds.has(s.id);
        const item = el("div", {
          class:
            "sb-recent-item sb-session-item" +
            (s.id === activeSessionId ? " active" : "") +
            (isRunning ? " running" : ""),
          title: isRunning
            ? `${s.title} — running (you can switch sessions)`
            : `${s.title} — double-click name to rename`,
          "aria-current": s.id === activeSessionId ? "page" : "false",
          role: "button",
          tabindex: "0",
        });
        item.dataset.searchText = normalizeSidebarSearch(s.title);
        item.appendChild(div("dot" + (isRunning ? " live" : "")));
        const label = el("span", { class: "sb-session-title" }, [s.title]);
        if (isRunning) {
          item.appendChild(el("span", { class: "sb-session-running", title: "Running" }, ["●"]));
        }
        label.title = "Double-click to rename";
        item.appendChild(label);

        const renameBtn = el("button", {
          class: "sb-session-rename",
          type: "button",
          "aria-label": "Rename session",
          title: "Rename",
          html: "✎",
        }) as HTMLButtonElement;
        renameBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.beginRename(s.id, s.title, label, item);
        });
        item.appendChild(renameBtn);

        const delBtn = el("button", {
          class: "sb-session-del", type: "button", "aria-label": "Delete session", title: "Delete session",
          html: "&times;",
        }) as HTMLButtonElement;
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.onDeleteSession(s.id);
        });
        item.appendChild(delBtn);

        const select = () => this.onSelectSession(s.id);
        item.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest("button")) return;
          if ((ev.target as HTMLElement).closest(".sb-session-rename-input")) return;
          select();
        });
        item.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            select();
          }
          if (ev.key === "F2") {
            ev.preventDefault();
            this.beginRename(s.id, s.title, label, item);
          }
        });
        label.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          this.beginRename(s.id, s.title, label, item);
        });
        sessionList.appendChild(item);
      }
    }
    const noSessionResults = el("div", { class: "sb-list-no-results" }, ["No matching sessions."]);
    noSessionResults.hidden = true;
    sessionList.appendChild(noSessionResults);
    sessionBody.appendChild(sessionList);
    sessionSection.appendChild(sessionBody);

    const applySessionFilter = () => {
      this.sessionSearchQuery = sessionSearchInput.value;
      const query = normalizeSidebarSearch(this.sessionSearchQuery);
      const rows = Array.from(sessionList.querySelectorAll<HTMLElement>(".sb-session-item"));
      let matches = 0;
      for (const row of rows) {
        const visible = !query || String(row.dataset.searchText || "").includes(query);
        row.hidden = !visible;
        if (visible) matches += 1;
      }
      noSessionResults.hidden = !query || matches > 0;
      sessionSearchStatus.textContent = query
        ? `${matches} of ${rows.length} sessions shown`
        : `${rows.length} sessions shown`;
    };

    const setSessionsCollapsed = (collapsed: boolean) => {
      this.sessionsCollapsed = collapsed;
      if (collapsed && this.sessionSearchOpen) {
        this.sessionSearchOpen = false;
        sessionSearch.hidden = true;
        sessionSearchToggle.classList.remove("is-active");
        sessionSearchToggle.setAttribute("aria-expanded", "false");
        sessionSearchToggle.setAttribute("aria-label", "Search sessions");
        sessionSearchToggle.setAttribute("title", "Search sessions");
        sessionSearchInput.value = "";
        applySessionFilter();
      }
      sessionSection.classList.toggle("is-collapsed", collapsed);
      sessionSection.parentElement?.classList.toggle("sessions-collapsed", collapsed);
      sessionBody.hidden = collapsed;
      sessionCollapse.setAttribute("aria-expanded", String(!collapsed));
      sessionCollapse.setAttribute("aria-label", collapsed ? "Expand sessions" : "Collapse sessions");
      sessionCollapse.setAttribute("title", collapsed ? "Expand sessions" : "Collapse sessions");
      writeCollapsedPreference(SESSIONS_COLLAPSED_KEY, collapsed);
    };

    const setSessionSearchOpen = (open: boolean) => {
      if (open && this.sessionsCollapsed) setSessionsCollapsed(false);
      this.sessionSearchOpen = open;
      sessionSearch.hidden = !open;
      sessionSearchToggle.classList.toggle("is-active", open);
      sessionSearchToggle.setAttribute("aria-expanded", String(open));
      sessionSearchToggle.setAttribute("aria-label", open ? "Close session search" : "Search sessions");
      sessionSearchToggle.setAttribute("title", open ? "Close session search" : "Search sessions");
      if (open) {
        sessionSearchInput.focus();
        sessionSearchInput.select();
      } else {
        sessionSearchInput.value = "";
        applySessionFilter();
      }
    };

    sessionSearchToggle.addEventListener("click", () => setSessionSearchOpen(!this.sessionSearchOpen));
    sessionCollapse.addEventListener("click", () => setSessionsCollapsed(!this.sessionsCollapsed));
    sessionSearchInput.addEventListener("input", applySessionFilter);
    sessionSearchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (sessionSearchInput.value) {
        sessionSearchInput.value = "";
        applySessionFilter();
      } else {
        setSessionSearchOpen(false);
        sessionSearchToggle.focus();
      }
    });
    applySessionFilter();
    workspaceSections.appendChild(sessionSection);
    workspaceSections.classList.toggle("sessions-collapsed", this.sessionsCollapsed);
    this.node.appendChild(workspaceSections);

    // Website account sync and a collapsed usage summary. Keeping usage inside
    // the account card leaves the flexible workspace region available to the
    // project and session lists.
    this.node.appendChild(this.buildAccountSection());

    const footer = el("div", { class: "sb-footer" });
    footer.appendChild(el("div", { class: "sb-status", id: "status-indicator", role: "status", "aria-live": "polite", html: `<span class="pulse"></span><span id="status-text">Ready</span>` }));
    this.node.appendChild(footer);

    this.paintUsage();
    this.paintAccount();
  }

  setAccountStatus(status: AccountStatusState) {
    this.accountStatus = status;
    this.paintAccount();
  }

  /** Show a durable sidebar notification when the hosted release feed has a newer build. */
  setUpdateNotification(available: boolean, version?: string | null) {
    this.updateAvailable = available;
    this.updateVersion = available
      ? String(version || "").trim().replace(/^v/i, "")
      : "";
    this.paintUpdateNotification();
  }

  private paintUpdateNotification() {
    const button = this.updateButton;
    if (!button) return;
    button.querySelector(".sb-update-badge")?.remove();
    button.classList.toggle("has-update", this.updateAvailable);
    button.dataset.updateAvailable = this.updateAvailable ? "true" : "false";
    // `icon()` also returns a span. Target the label explicitly so a status
    // update never overwrites the icon and leaves two visible Update labels.
    const label = button.querySelector<HTMLElement>(":scope > .sb-action-label");

    if (!this.updateAvailable) {
      if (label) label.textContent = "Update";
      button.removeAttribute("aria-label");
      button.setAttribute("title", "Check for updates");
      return;
    }

    const versionLabel = this.updateVersion ? `v${this.updateVersion}` : "New";
    if (label) label.textContent = "Update";
    button.setAttribute("aria-label", `Update available: ${versionLabel}. Install and restart`);
    button.setAttribute("title", `Install ${versionLabel} inside Hormachuelos and restart`);
    button.appendChild(
      el("span", {
        class: "sb-update-badge",
        role: "status",
        "aria-live": "polite",
        "aria-label": `New software update ${versionLabel}`,
      }, [`NEW · ${versionLabel}`]),
    );
  }

  /** Keep project path in sync (UI lives on the composer chip, not the left drawer). */
  setProject(path: string | null, options: { quickSession?: boolean } = {}) {
    this.projectPath = path;
    this.quickSessionsActive = options.quickSession === true;
    this.activeProjectPath = this.quickSessionsActive ? null : path;
  }

  /** Keep the folder-free Quick Sessions shortcut visible beside real projects. */
  setQuickSessionWorkspace(path: string | null, active = false) {
    this.quickSessionWorkspacePath = path;
    this.quickSessionsActive = active;
    if (active) this.activeProjectPath = null;
  }

  /** Render an active workspace plus every other project already open in the app. */
  setProjectWorkspaces(
    workspaces: ProjectWorkspace[],
    activePath: string | null,
    runningPaths: Iterable<string> = [],
  ) {
    this.projectWorkspaces = [...workspaces];
    this.activeProjectPath = activePath;
    this.runningProjectPaths = new Set(
      [...runningPaths]
        .filter(Boolean)
        .map((path) => String(path).replace(/[\\/]+$/, "").toLocaleLowerCase()),
    );
  }

  private buildProjectsSection(): HTMLElement {
    const section = el("div", {
      class: `sb-section sb-projects-section${this.projectsCollapsed ? " is-collapsed" : ""}`,
    });
    const header = el("div", { class: "sb-section-row sb-projects-head" });
    const totalProjects = this.projectWorkspaces.length + (this.quickSessionWorkspacePath ? 1 : 0);
    const heading = el("div", { class: "sb-section-heading" });
    heading.appendChild(el("div", { class: "sb-section-label" }, ["Projects"]));
    heading.appendChild(el("span", {
      class: "sb-section-count",
      "aria-label": `${totalProjects} project${totalProjects === 1 ? "" : "s"}`,
    }, [String(totalProjects)]));
    header.appendChild(heading);
    const actions = el("div", { class: "sb-project-actions" });
    const add = el(
      "button",
      {
        class: "sb-add-project",
        type: "button",
        title: "Add another project",
        "aria-label": "Add another project",
      },
      ["+ Add project"],
    ) as HTMLButtonElement;
    add.addEventListener("click", () => this.onAddAnotherProject());
    actions.appendChild(add);
    const searchToggle = el("button", {
      class: `sb-section-control sb-section-search-toggle${this.projectSearchOpen ? " is-active" : ""}`,
      type: "button",
      title: this.projectSearchOpen ? "Close project search" : "Search projects",
      "aria-label": this.projectSearchOpen ? "Close project search" : "Search projects",
      "aria-controls": "sidebar-project-search",
      "aria-expanded": String(this.projectSearchOpen),
      html: icon("search", 14),
    }) as HTMLButtonElement;
    actions.appendChild(searchToggle);
    const collapse = el("button", {
      class: "sb-section-control sb-section-collapse",
      type: "button",
      title: this.projectsCollapsed ? "Expand projects" : "Collapse projects",
      "aria-label": this.projectsCollapsed ? "Expand projects" : "Collapse projects",
      "aria-controls": "sidebar-project-body",
      "aria-expanded": String(!this.projectsCollapsed),
      html: icon("chevronDown", 13),
    }) as HTMLButtonElement;
    actions.appendChild(collapse);
    header.appendChild(actions);
    section.appendChild(header);

    const body = el("div", {
      class: "sb-section-body",
      id: "sidebar-project-body",
    });
    body.hidden = this.projectsCollapsed;
    const search = el("label", {
      class: "sb-list-search",
      id: "sidebar-project-search",
    });
    search.hidden = !this.projectSearchOpen;
    search.appendChild(el("span", { class: "sb-list-search-icon", html: icon("search", 13) }));
    const searchInput = el("input", {
      class: "sb-list-search-input",
      type: "search",
      placeholder: "Search projects",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search projects",
    }) as HTMLInputElement;
    searchInput.value = this.projectSearchQuery;
    search.appendChild(searchInput);
    const searchStatus = el("span", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
    });
    search.appendChild(searchStatus);
    body.appendChild(search);

    const list = el("div", { class: "sb-projects-list", role: "list", "aria-label": "Open projects" });
    if (this.quickSessionWorkspacePath) {
      const quickRow = el("div", {
        class: "sb-project-row is-quick",
        role: "listitem",
      });
      quickRow.dataset.searchText = normalizeSidebarSearch(`Quick sessions ${this.quickSessionWorkspacePath}`);
      const quick = el(
        "button",
        {
          class: `sb-project-workspace sb-quick-session${this.quickSessionsActive ? " active" : ""}`,
          type: "button",
          title: this.quickSessionsActive
            ? "Quick sessions are active — no folder was selected"
            : "Open Quick sessions — no folder is needed",
          "aria-current": this.quickSessionsActive ? "page" : "false",
        },
      ) as HTMLButtonElement;
      quick.appendChild(el("span", { class: "sb-project-mark", "aria-hidden": "true" }, ["Q"]));
      const copy = el("span", { class: "sb-project-copy" });
      copy.appendChild(el("strong", {}, ["Quick sessions"]));
      copy.appendChild(el("span", {}, [this.quickSessionsActive ? "No folder needed" : "App-managed workspace"]));
      quick.appendChild(copy);
      quick.addEventListener("click", () => this.onOpenQuickSessions());
      quickRow.appendChild(quick);
      list.appendChild(quickRow);
    }
    if (this.projectWorkspaces.length === 0 && !this.quickSessionWorkspacePath) {
      list.appendChild(el("div", { class: "sb-project-empty" }, ["Create or open a project to keep it here."]));
    } else if (this.projectWorkspaces.length > 0) {
      const activeKey = String(this.activeProjectPath || "").replace(/[\\/]+$/, "").toLocaleLowerCase();
      for (const workspace of this.projectWorkspaces) {
        const key = workspace.path.replace(/[\\/]+$/, "").toLocaleLowerCase();
        const active = key === activeKey;
        const running = this.runningProjectPaths.has(key);
        const row = el("div", {
          class: `sb-project-row${active ? " active" : ""}${running ? " running" : ""}`,
          role: "listitem",
        });
        row.dataset.searchText = normalizeSidebarSearch(`${workspace.name} ${workspace.path}`);
        const item = el(
          "button",
          {
            class: `sb-project-workspace${active ? " active" : ""}${running ? " running" : ""}`,
            type: "button",
            title: `${workspace.path}${running ? "\nAgent run in progress" : ""}`,
            "aria-current": active ? "page" : "false",
          },
        ) as HTMLButtonElement;
        item.appendChild(el("span", { class: "sb-project-mark", "aria-hidden": "true" }, [(workspace.name[0] || "P").toUpperCase()]));
        const copy = el("span", { class: "sb-project-copy" });
        copy.appendChild(el("strong", {}, [workspace.name]));
        copy.appendChild(el("span", {}, [active ? "Active workspace" : running ? "Running in background" : "Ready"]));
        item.appendChild(copy);
        if (running) item.appendChild(el("span", { class: "sb-project-live", title: "Agent run in progress" }, ["●"]));
        item.addEventListener("click", () => this.onSelectProject(workspace.path));
        const remove = el("button", {
          class: "sb-project-remove",
          type: "button",
          title: running
            ? `Stop the active agent before removing ${workspace.name}`
            : `Remove ${workspace.name} from Projects (files stay on disk)`,
          "aria-label": `Remove ${workspace.name} from Projects`,
          "aria-disabled": String(running),
          html: icon("close", 12),
        }) as HTMLButtonElement;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if (running) {
            this.onRemoveProject(workspace.path);
            return;
          }
          this.confirmProjectRemoval(workspace);
        });
        row.appendChild(item);
        row.appendChild(remove);
        list.appendChild(row);
      }
    }
    const noResults = el("div", { class: "sb-list-no-results" }, ["No matching projects."]);
    noResults.hidden = true;
    list.appendChild(noResults);
    body.appendChild(list);
    section.appendChild(body);

    const applyProjectFilter = () => {
      this.projectSearchQuery = searchInput.value;
      const query = normalizeSidebarSearch(this.projectSearchQuery);
      const rows = Array.from(list.querySelectorAll<HTMLElement>(".sb-project-row"));
      let matches = 0;
      for (const row of rows) {
        const visible = !query || String(row.dataset.searchText || "").includes(query);
        row.hidden = !visible;
        if (visible) matches += 1;
      }
      const empty = list.querySelector<HTMLElement>(".sb-project-empty");
      if (empty) empty.hidden = Boolean(query);
      noResults.hidden = !query || matches > 0;
      searchStatus.textContent = query
        ? `${matches} of ${rows.length} projects shown`
        : `${rows.length} projects shown`;
    };

    const setCollapsed = (collapsed: boolean) => {
      this.projectsCollapsed = collapsed;
      if (collapsed && this.projectSearchOpen) {
        this.projectSearchOpen = false;
        search.hidden = true;
        searchToggle.classList.remove("is-active");
        searchToggle.setAttribute("aria-expanded", "false");
        searchToggle.setAttribute("aria-label", "Search projects");
        searchToggle.setAttribute("title", "Search projects");
        searchInput.value = "";
        applyProjectFilter();
      }
      section.classList.toggle("is-collapsed", collapsed);
      section.parentElement?.classList.toggle("projects-collapsed", collapsed);
      body.hidden = collapsed;
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? "Expand projects" : "Collapse projects");
      collapse.setAttribute("title", collapsed ? "Expand projects" : "Collapse projects");
      writeCollapsedPreference(PROJECTS_COLLAPSED_KEY, collapsed);
    };

    const setSearchOpen = (open: boolean) => {
      if (open && this.projectsCollapsed) setCollapsed(false);
      this.projectSearchOpen = open;
      search.hidden = !open;
      searchToggle.classList.toggle("is-active", open);
      searchToggle.setAttribute("aria-expanded", String(open));
      searchToggle.setAttribute("aria-label", open ? "Close project search" : "Search projects");
      searchToggle.setAttribute("title", open ? "Close project search" : "Search projects");
      if (open) {
        searchInput.focus();
        searchInput.select();
      } else {
        searchInput.value = "";
        applyProjectFilter();
      }
    };

    searchToggle.addEventListener("click", () => setSearchOpen(!this.projectSearchOpen));
    collapse.addEventListener("click", () => setCollapsed(!this.projectsCollapsed));
    searchInput.addEventListener("input", applyProjectFilter);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (searchInput.value) {
        searchInput.value = "";
        applyProjectFilter();
      } else {
        setSearchOpen(false);
        searchToggle.focus();
      }
    });
    applyProjectFilter();
    return section;
  }

  private confirmProjectRemoval(workspace: ProjectWorkspace) {
    const root = document.getElementById("modal-root");
    const fallbackMessage = `Remove ${workspace.name} from the Projects list? Its folder, files, Git history, and saved sessions will stay on this computer.`;
    if (!root) {
      if (window.confirm(fallbackMessage)) this.onRemoveProject(workspace.path);
      return;
    }

    clear(root);
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", {
      class: "modal confirm-modal project-remove-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "remove-project-title",
      "aria-describedby": "remove-project-description",
    });

    const head = el("div", { class: "modal-head" });
    head.appendChild(el("div", { class: "modal-title", id: "remove-project-title" }, [`Remove ${workspace.name}?`]));
    const closeButton = el("button", {
      class: "modal-close",
      type: "button",
      "aria-label": "Cancel project removal",
      html: icon("close", 16),
    }) as HTMLButtonElement;
    head.appendChild(closeButton);
    modal.appendChild(head);

    const body = el("div", { class: "modal-body" });
    body.appendChild(el("p", {
      class: "confirm-modal-desc",
      id: "remove-project-description",
    }, ["This removes the shortcut from Hormachuelos so the Projects list stays focused."]));
    const safeNote = el("div", { class: "project-remove-safe-note" });
    safeNote.appendChild(el("span", { class: "project-remove-safe-icon", html: icon("folder", 15) }));
    const safeCopy = el("div", { class: "project-remove-safe-copy" });
    safeCopy.appendChild(el("strong", {}, ["Your project stays on this computer"]));
    safeCopy.appendChild(el("span", {}, ["Files, Git history, and saved sessions are not deleted."]));
    safeNote.appendChild(safeCopy);
    body.appendChild(safeNote);
    body.appendChild(el("code", { class: "project-remove-path", title: workspace.path }, [workspace.path]));
    modal.appendChild(body);

    const foot = el("div", { class: "modal-foot" });
    const cancelButton = el("button", { class: "btn", type: "button" }, ["Keep project"]) as HTMLButtonElement;
    const removeButton = el("button", { class: "btn danger", type: "button" }, ["Remove from list"]) as HTMLButtonElement;
    foot.appendChild(cancelButton);
    foot.appendChild(removeButton);
    modal.appendChild(foot);

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      clear(root);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    closeButton.addEventListener("click", close);
    cancelButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    removeButton.addEventListener("click", () => {
      close();
      this.onRemoveProject(workspace.path);
    });
    document.addEventListener("keydown", onKeyDown);
    overlay.appendChild(modal);
    root.appendChild(overlay);
    cancelButton.focus();
  }

  /**
   * Plan-period usage % (no hourly / weekly windows).
   * `tokens` / `contextLimit` kept for call-site compatibility; display uses meta.
   */
  setSessionUsage(
    _tokens: number,
    _contextLimit: number = SESSION_TOKEN_BUDGET,
    meta: UsageDisplayMeta = {},
  ) {
    this.usageMeta = meta || {};
    this.paintUsage();
  }

  private buildAccountSection(): HTMLElement {
    const section = el("div", { class: "sb-section sb-account-section" });
    const labelRow = el("div", { class: "sb-account-label-row" });
    labelRow.appendChild(el("div", { class: "sb-section-label", style: "margin:0" }, ["Account"]));
    const refreshBtn = el("button", {
      class: "sb-account-refresh",
      type: "button",
      title: "Refresh website sync",
      "aria-label": "Refresh website sync",
    }, ["↻"]) as HTMLButtonElement;
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onRefreshAccount();
    });
    labelRow.appendChild(refreshBtn);
    section.appendChild(labelRow);

    this.accountRoot = el("div", {
      class: "sb-account",
      role: "group",
      "aria-label": "Website account and usage",
    });
    this.accountIdentityRoot = el("button", {
      class: "sb-account-identity",
      type: "button",
      title: "Open website account",
      "aria-label": "Manage website account",
      "aria-live": "polite",
    }) as HTMLButtonElement;
    this.accountIdentityRoot.addEventListener("click", () => this.onManageAccount());
    this.accountRoot.appendChild(this.accountIdentityRoot);
    this.accountRoot.appendChild(this.buildUsageDisclosure());
    section.appendChild(this.accountRoot);
    return section;
  }

  private paintAccount() {
    if (!this.accountRoot || !this.accountIdentityRoot) return;
    const s = this.accountStatus;
    clear(this.accountIdentityRoot);
    this.accountRoot.classList.remove("is-synced", "is-offline", "is-signed-out", "is-checking");

    const row = (title: string, subtitle: string) => {
      const wrap = el("div", { class: "sb-account-row" });
      wrap.appendChild(el("span", { class: "sb-account-dot" }));
      const copy = el("div", { class: "sb-account-copy" });
      copy.appendChild(el("strong", {}, [title]));
      const sub = el("span", {}, [subtitle]);
      sub.title = subtitle;
      copy.appendChild(sub);
      wrap.appendChild(copy);
      return wrap;
    };

    if (s.state === "checking") {
      this.accountRoot.classList.add("is-checking");
      this.accountIdentityRoot.appendChild(row("Checking sync…", "hormachuelos.vercel.app"));
      return;
    }

    if (s.state === "synced") {
      const who = s.name?.trim() || s.email;
      this.accountRoot.classList.add("is-synced");
      this.accountIdentityRoot.appendChild(row("Synced · signed in", who));
      this.accountIdentityRoot.appendChild(el("div", { class: "sb-account-meta" }, ["Website account linked"]));
      return;
    }

    if (s.state === "offline") {
      this.accountRoot.classList.add("is-offline");
      this.accountIdentityRoot.appendChild(
        row("Can't verify sync", s.email || "Saved session · website unreachable"),
      );
      this.accountIdentityRoot.appendChild(
        el("div", { class: "sb-account-meta" }, [s.detail || "Click to open website"]),
      );
      return;
    }

    this.accountRoot.classList.add("is-signed-out");
    this.accountIdentityRoot.appendChild(
      row("Not signed in", s.detail || "Sign in on hormachuelos.vercel.app"),
    );
    this.accountIdentityRoot.appendChild(
      el("div", { class: "sb-account-meta" }, ["Click to link website account"]),
    );
  }

  private buildUsageDisclosure(): HTMLDetailsElement {
    const disclosure = el("details", {
      class: "sb-account-usage",
    }) as HTMLDetailsElement;
    disclosure.open = this.usageExpanded;
    this.usageDisclosure = disclosure;

    const toggle = el("summary", {
      class: "sb-account-usage-toggle",
      "aria-controls": "sidebar-usage-details",
    });
    toggle.appendChild(el("span", { class: "sb-account-usage-label" }, ["Usage"]));
    this.usageSummary = el("span", {
      class: "sb-account-usage-value",
      "data-usage-summary": "1",
    }, ["—"]);
    toggle.appendChild(this.usageSummary);
    toggle.appendChild(el("span", {
      class: "sb-account-usage-chevron",
      "aria-hidden": "true",
      html: icon("chevronDown", 12),
    }));
    disclosure.appendChild(toggle);

    this.usageRoot = el("div", {
      id: "sidebar-usage-details",
      class: "sb-usage",
      role: "group",
      "aria-label": "Subscription and usage limits",
    });

    // Subscription the client currently has
    const sub = el("div", { class: "sb-usage-sub", "data-sub": "1" });
    sub.appendChild(
      el("div", { class: "sb-usage-sub-top" }, [
        el("span", { class: "sb-usage-sub-name", "data-sub-name": "1" }, ["—"]),
        el("span", { class: "sb-usage-sub-badge", "data-sub-badge": "1" }, ["—"]),
      ]),
    );
    sub.appendChild(el("div", { class: "sb-usage-sub-meta", "data-sub-meta": "1" }, ["—"]));

    // Single plan-period meter
    const row = el("div", { class: "sb-usage-row", "data-window": "plan" });
    row.appendChild(
      el("div", { class: "sb-usage-row-head" }, [
        el("span", { class: "sb-usage-row-label", "data-row-label": "plan" }, ["Period"]),
        el("span", { class: "sb-usage-row-pct", "data-pct": "plan" }, ["—"]),
      ]),
    );
    const track = el("div", {
      class: "sb-usage-meter",
      role: "progressbar",
      "aria-label": "Hosted usage remaining",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    });
    track.appendChild(el("div", { class: "sb-usage-meter-fill", "data-fill": "plan" }));
    row.appendChild(track);
    row.appendChild(el("div", { class: "sb-usage-row-hint", "data-hint": "plan", "data-plan": "1" }, ["—"]));

    const status = el("div", { class: "sb-usage-status", "data-status": "1" }, [""]);

    const topUp = el("button", {
      class: "sb-usage-topup",
      type: "button",
      title: "Mag-load more usage via GCash",
    }, ["Mag-load via GCash"]) as HTMLButtonElement;
    topUp.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onTopUp();
    });

    this.usageRoot.appendChild(sub);
    this.usageRoot.appendChild(row);
    this.usageRoot.appendChild(status);
    this.usageRoot.appendChild(topUp);
    disclosure.appendChild(this.usageRoot);

    disclosure.addEventListener("toggle", () => {
      this.usageExpanded = disclosure.open;
      this.syncUsageDisclosureState();
    });
    this.syncUsageDisclosureState();
    return disclosure;
  }

  private syncUsageDisclosureState() {
    if (!this.usageDisclosure) return;
    const toggle = this.usageDisclosure.querySelector("summary");
    if (!toggle) return;
    const open = this.usageDisclosure.open;
    const value = this.usageSummary?.textContent?.trim() || "not available";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", `Usage, ${value}. ${open ? "Collapse" : "Expand"} details`);
    toggle.setAttribute("title", `${open ? "Collapse" : "Expand"} usage details`);
  }

  private formatPlanExpiry(isoDate: string): string {
    const raw = (isoDate || "").trim();
    if (!raw) return "";
    const t = Date.parse(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
    if (!Number.isFinite(t)) return raw;
    try {
      return new Date(t).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    } catch {
      return raw;
    }
  }

  private paintUsage() {
    if (!this.usageRoot) return;
    const m = this.usageMeta;
    const planPct = typeof m.planRemaining === "number"
      ? m.planRemaining
      : typeof m.percent === "number"
        ? m.percent
        : 100;
    const blocked = m.blockedBy || "";
    const planId = m.planName || "free";
    const name = displayPlanLabel(planId);
    const active = m.planActive === true && !["free", "expired", ""].includes(planId.toLowerCase());
    const clampedPct = Math.max(0, Math.min(100, planPct));

    if (this.usageSummary) {
      this.usageSummary.textContent = active
        ? `${clampedPct}% left`
        : planId.toLowerCase() === "expired"
          ? "Usage empty"
          : "No plan";
    }
    if (this.usageDisclosure) {
      this.usageDisclosure.classList.toggle("usage-low", active && planPct <= 20 && planPct > 5);
      this.usageDisclosure.classList.toggle("usage-critical", active && planPct <= 5 && planPct > 0);
      this.usageDisclosure.classList.toggle("usage-empty", active && planPct <= 0);
      this.usageDisclosure.classList.toggle("is-free", !active);
    }
    this.syncUsageDisclosureState();

    this.usageRoot.classList.toggle("usage-low", active && planPct <= 20 && planPct > 5);
    this.usageRoot.classList.toggle("usage-critical", active && planPct <= 5 && planPct > 0);
    this.usageRoot.classList.toggle("usage-empty", active && planPct <= 0);
    this.usageRoot.classList.toggle("is-free", !active);

    const fill = this.usageRoot.querySelector('[data-fill="plan"]') as HTMLElement | null;
    const pctEl = this.usageRoot.querySelector('[data-pct="plan"]');
    const hint = this.usageRoot.querySelector('[data-hint="plan"]');
    const row = this.usageRoot.querySelector('[data-window="plan"]');
    const rowLabel = this.usageRoot.querySelector('[data-row-label="plan"]');
    const meter = this.usageRoot.querySelector(".sb-usage-meter");
    if (fill) fill.style.width = active ? `${clampedPct}%` : "0%";
    if (pctEl) pctEl.textContent = active ? `${clampedPct}% left` : "—";
    if (rowLabel) rowLabel.textContent = active ? "Usage left" : "Plan";
    if (meter) {
      meter.setAttribute("aria-valuenow", active ? String(clampedPct) : "0");
      meter.setAttribute(
        "aria-valuetext",
        active ? `${clampedPct}% usage remaining` : "No active plan",
      );
    }
    if (hint) {
      if (!active) {
        hint.textContent =
          planId.toLowerCase() === "expired"
            ? "Usage empty · Mag-load to continue"
            : "No plan yet · Mag-load via GCash";
      } else if (planPct <= 0) {
        hint.textContent = "Usage empty · Mag-load to continue";
      } else {
        // Pay-as-you-go: wallet only — no calendar expiry line.
        hint.textContent = `${clampedPct}% left`;
      }
    }
    row?.classList.toggle("is-byok", !active);
    row?.classList.toggle("is-empty", active && planPct <= 0);
    row?.classList.toggle("is-low", active && planPct <= 20 && planPct > 0);

    const nameEl = this.usageRoot.querySelector("[data-sub-name]");
    const badgeEl = this.usageRoot.querySelector("[data-sub-badge]");
    const metaEl = this.usageRoot.querySelector("[data-sub-meta]");
    if (nameEl) nameEl.textContent = active ? name : planId.toLowerCase() === "expired" ? "Expired" : "No plan";
    if (badgeEl) {
      badgeEl.textContent = active ? "Active" : planId.toLowerCase() === "expired" ? "Expired" : "None";
      badgeEl.classList.toggle("is-free", !active);
    }
    if (metaEl) {
      if (!active) {
        metaEl.textContent = "Buy or renew a plan to unlock hosted usage";
      } else {
        metaEl.textContent = `${clampedPct}% usage remaining`;
      }
    }

    const status = this.usageRoot.querySelector("[data-status]");
    if (status) {
      if (blocked === "plan" || (active && planPct <= 0)) {
        status.textContent = "Paused · plan usage used up · Mag-load to continue";
      } else {
        status.textContent = "";
      }
    }

    const topUp = this.usageRoot.querySelector(".sb-usage-topup") as HTMLButtonElement | null;
    if (topUp) {
      topUp.textContent = active ? "Mag-load / upgrade" : "Mag-load via GCash";
    }

    this.usageRoot.title = active
      ? `${name} · ${clampedPct}% usage left`
      : "No active plan — Mag-load via GCash";
  }
  private actionBtn(
    iconName: "new" | "open" | "settings" | "export" | "refresh",
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el("button", {
      class: "sb-action",
      type: "button",
      html: icon(iconName) + `<span class="sb-action-label">${label}</span>`,
    }) as HTMLButtonElement;
    btn.addEventListener("click", onClick);
    return btn;
  }

  /**
   * Collapsible secondary workspace controls.  The update control intentionally
   * stays outside this menu: it must remain visible whenever a release is ready.
   */
  private buildWorkspaceActionsMenu(): HTMLDetailsElement {
    const menu = el("details", { class: "sb-action-menu" }) as HTMLDetailsElement;
    const toggle = el("summary", {
      class: "sb-action sb-actions-toggle",
      title: "Show workspace actions",
      "aria-label": "Workspace actions",
      "aria-expanded": "false",
      html:
        icon("menu") +
        '<span class="sb-action-label">Workspace actions</span>' +
        `<span class="sb-action-menu-chevron">${icon("chevronDown", 13)}</span>`,
    });
    const panel = el("div", {
      class: "sb-action-menu-panel",
      role: "group",
      "aria-label": "Workspace actions",
    });

    const addAction = (
      iconName: "new" | "open" | "settings" | "export",
      label: string,
      onClick: () => void,
    ) => {
      const action = this.actionBtn(iconName, label, () => {
        // Close before a picker or dialog receives focus, keeping the sidebar
        // clean when the user returns to their workspace.
        menu.open = false;
        onClick();
      });
      action.classList.add("sb-menu-action");
      panel.appendChild(action);
    };

    addAction("new", "New Build", this.onNewProject);
    addAction("open", "Open Project", this.onOpenProject);
    addAction("export", "Client Pack", this.onExportClientPack);
    // Settings is intentionally hidden from the product UI.

    const updateToggleState = () => {
      const open = menu.open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("title", open ? "Hide workspace actions" : "Show workspace actions");
    };
    menu.addEventListener("toggle", updateToggleState);
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      (toggle as HTMLElement).focus();
    });

    menu.appendChild(toggle);
    menu.appendChild(panel);
    return menu;
  }

  /** Inline rename: replace title with an input, commit on Enter/blur. */
  private beginRename(id: string, currentTitle: string, label: HTMLElement, item: HTMLElement) {
    if (item.querySelector(".sb-session-rename-input")) return;

    const input = el("input", {
      class: "sb-session-rename-input field",
      type: "text",
      value: currentTitle,
      "aria-label": "Session name",
      maxlength: "80",
    }) as HTMLInputElement;

    label.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== currentTitle) {
        this.onRenameSession(id, next);
      } else {
        // Restore label if cancelled or empty
        const restored = el("span", { class: "sb-session-title" }, [currentTitle]);
        restored.title = "Double-click to rename";
        input.replaceWith(restored);
        restored.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          this.beginRename(id, currentTitle, restored, item);
        });
      }
    };

    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
  }

  setStatus(text: string, live: boolean = false) {
    const ind = document.getElementById("status-indicator");
    if (!ind) return;
    ind.classList.toggle("live", live);
    const txt = ind.querySelector("#status-text");
    if (txt) txt.textContent = text;
  }
}
