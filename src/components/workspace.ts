import {
  api,
  type AgentEvent,
  type AgentExecutionProfile,
  type CheckpointSummary,
  type RollbackResult,
  type FilePreview,
  type ProjectNode,
  type ProjectTree,
} from "../ipc";
import { clear, el } from "./util";
import { icon } from "./icons";

type InspectorTab = "files" | "changes" | "console";
type ChangeKind = "added" | "modified" | "deleted" | "touched" | "command";
type ChangeItem = { path: string; kind: ChangeKind; detail: string };
type ToolCall = { name: string; args: Record<string, unknown> };

export type WorkspaceRollbackOutcome =
  | { kind: "completed"; result: RollbackResult }
  | { kind: "cancelled" }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

const MUTATING_TOOLS = new Set([
  "write_file", "edit_file", "move_file", "copy_file", "delete_file",
  "make_dir", "download_file", "git_commit", "git_add_all",
]);

const EXECUTION_PROFILE_STORAGE_KEY = "hormachuelos.execution-profile.v1";
const EXECUTION_PROFILES: {
  id: AgentExecutionProfile;
  label: string;
  description: string;
}[] = [
  { id: "auto", label: "Auto", description: "Routes small edits to Fast and risky work to Safe." },
  { id: "fast", label: "Fast", description: "Smallest context, cheapest check, one focused repair." },
  { id: "balanced", label: "Balanced", description: "Focused implementation with relevant validation." },
  { id: "thorough", label: "Thorough", description: "Deeper inspection and stronger verification." },
  { id: "safe", label: "Safe", description: "Also snapshots relevant project files around commands." },
];

function loadExecutionProfile(): AgentExecutionProfile {
  try {
    const value = localStorage.getItem(EXECUTION_PROFILE_STORAGE_KEY) as AgentExecutionProfile | null;
    if (EXECUTION_PROFILES.some((profile) => profile.id === value)) return value!;
  } catch {
    // WebView storage can be unavailable in isolated test harnesses.
  }
  return "auto";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatTimelineTime(value: number): string {
  const date = new Date(Number(value) || Date.now());
  try {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatTimelineDuration(start: number, finish: number | null): string {
  if (!finish) return "live";
  if (finish <= start) return "<1s";
  const seconds = Math.max(1, Math.round((finish - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function humanToolName(value: string): string {
  const labels: Record<string, string> = {
    write_file: "Write file",
    edit_file: "Edit file",
    delete_file: "Delete file",
    move_file: "Move file",
    copy_file: "Copy file",
    make_dir: "Create folder",
    download_file: "Download file",
    run_command: "Project command",
  };
  return labels[value] || value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    pending: "capturing",
    recorded: "protected",
    no_change: "no change",
    rolled_back: "restored",
    conflict: "preserved conflict",
    uncertain: "needs review",
  };
  return labels[value] || value.replaceAll("_", " ");
}

function flattenTree(nodes: ProjectNode[], output = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    if (!node.isDir) output.set(node.path, `${node.size}:${node.modifiedMs}`);
    flattenTree(node.children, output);
  }
  return output;
}

function nodeMatches(node: ProjectNode, query: string): boolean {
  return node.path.toLowerCase().includes(query) || node.children.some((child) => nodeMatches(child, query));
}

function countProjectItems(nodes: ProjectNode[]): { files: number; folders: number } {
  return nodes.reduce(
    (total, node) => {
      if (node.isDir) {
        total.folders += 1;
        const childTotals = countProjectItems(node.children);
        total.files += childTotals.files;
        total.folders += childTotals.folders;
      } else {
        total.files += 1;
      }
      return total;
    },
    { files: 0, folders: 0 },
  );
}

export class WorkspacePanel {
  private inspector = document.getElementById("inspector")!;
  private filesPanel = document.getElementById("files-panel")!;
  private changesPanel = document.getElementById("changes-panel")!;
  private viewer = document.getElementById("file-viewer")!;
  private chat = document.getElementById("chat")!;
  private treeRoot!: HTMLElement;
  private changesRoot!: HTMLElement;
  private checkpointRoot!: HTMLElement;
  private checkpointNotice!: HTMLElement;
  private executionProfileRoot!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private fileCount!: HTMLElement;
  private fileNotice!: HTMLElement;
  private clearFilesButton!: HTMLButtonElement;
  private projectPath: string | null = null;
  private tree: ProjectTree | null = null;
  private expanded = new Set<string>();
  private pendingCalls = new Map<string, ToolCall>();
  private changes = new Map<string, ChangeItem>();
  private baseline: Map<string, string> | null = null;
  private refreshTimer: number | null = null;
  private finishing = false;
  private fileActionInFlight = false;
  private checkpointActionInFlight = false;
  private activePreview: FilePreview | null = null;
  private executionProfile: AgentExecutionProfile = loadExecutionProfile();
  private checkpoints: CheckpointSummary[] = [];
  private expandedCheckpoints = new Set<string>();
  private activeRunSessionId: string | null = null;

  constructor() {
    this.buildFilesPanel();
    this.buildChangesPanel();
    this.buildViewer();
    const tabs = Array.from(
      this.inspector.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]"),
    );
    tabs.forEach((button, index) => {
      button.addEventListener("click", () => this.activateTab(button.dataset.inspectorTab as InspectorTab));
      button.addEventListener("keydown", (event) => {
        let nextIndex: number | null = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        const next = tabs[nextIndex];
        this.activateTab(next.dataset.inspectorTab as InspectorTab);
        next.focus();
      });
    });
    this.activateTab("files");
    this.renderNoProject();
  }

  private buildFilesPanel() {
    clear(this.filesPanel);
    const toolbar = el("div", { class: "project-toolbar" });
    const toolbarTop = el("div", { class: "project-toolbar-top" });
    const identity = el("div", { class: "project-toolbar-identity" });
    identity.appendChild(el("div", { class: "project-toolbar-title" }, ["Project files"]));
    this.fileCount = el("div", { class: "project-file-count", "aria-live": "polite" }, ["No project selected"]);
    identity.appendChild(this.fileCount);
    const actions = el("div", { class: "project-toolbar-actions" });
    const refresh = el("button", {
      class: "inspector-action", type: "button", "aria-label": "Refresh project files", title: "Refresh project files", html: icon("refresh", 14),
    }) as HTMLButtonElement;
    refresh.addEventListener("click", () => void this.refresh());
    this.clearFilesButton = el("button", {
      class: "project-clear-files", type: "button", disabled: "", "aria-label": "Clear all project files", title: "Clear all project files", html: `${icon("trash", 13)}<span>Clear files</span>`,
    }) as HTMLButtonElement;
    this.clearFilesButton.addEventListener("click", () => void this.requestClearProjectFiles());
    actions.append(refresh, this.clearFilesButton);
    toolbarTop.append(identity, actions);
    this.searchInput = el("input", {
      class: "project-filter", type: "search", placeholder: "Filter project files", "aria-label": "Filter project files",
    }) as HTMLInputElement;
    this.searchInput.addEventListener("input", () => this.renderTree());
    toolbar.append(toolbarTop, this.searchInput);
    this.fileNotice = el("div", { class: "project-file-notice", role: "status", hidden: "" });
    this.treeRoot = el("div", { class: "project-tree", role: "tree", "aria-label": "Project files" });
    this.filesPanel.append(toolbar, this.fileNotice, this.treeRoot);
  }

  private buildChangesPanel() {
    clear(this.changesPanel);
    const profile = el("section", { class: "execution-profile-card", "aria-label": "Agent execution profile" });
    const profileHead = el("div", { class: "execution-profile-head" });
    profileHead.append(
      el("div", { class: "execution-profile-title" }, ["Execution profile"]),
      el("div", { class: "execution-profile-current", "aria-live": "polite" }),
    );
    this.executionProfileRoot = el("div", { class: "execution-profile-options", role: "group", "aria-label": "Execution profile" });
    for (const option of EXECUTION_PROFILES) {
      const button = el("button", {
        class: "execution-profile-option",
        type: "button",
        title: option.description,
        "data-execution-profile": option.id,
        "aria-pressed": String(option.id === this.executionProfile),
      }, [option.label]) as HTMLButtonElement;
      button.addEventListener("click", () => this.setExecutionProfile(option.id));
      this.executionProfileRoot.appendChild(button);
    }
    profile.append(profileHead, this.executionProfileRoot, el("p", { class: "execution-profile-description" }));

    const checkpointSection = el("section", { class: "checkpoint-section", "aria-label": "Workspace Time Machine" });
    const checkpointHead = el("div", { class: "checkpoint-section-head" });
    checkpointHead.append(
      el("div", {}, [
        el("div", { class: "checkpoint-section-kicker" }, ["FLIGHT RECORDER"]),
        el("div", { class: "checkpoint-section-title" }, ["Workspace Time Machine"]),
      ]),
      el("span", { class: "checkpoint-safe-label" }, ["CONFLICT-SAFE"]),
    );
    checkpointSection.append(
      checkpointHead,
      el("p", { class: "checkpoint-section-copy" }, ["Inspect protected agent actions and restore one action or an entire finished run. Newer manual edits are preserved."]),
    );
    this.checkpointNotice = el("div", { class: "checkpoint-notice", role: "status", hidden: "" });
    this.checkpointRoot = el("div", { class: "checkpoint-root", "aria-live": "polite" });
    checkpointSection.append(this.checkpointNotice, this.checkpointRoot);

    const intro = el("div", { class: "changes-intro" }, ["Files touched during the current or most recent run."]);
    this.changesRoot = el("div", { class: "changes-list", "aria-live": "polite" });
    this.changesPanel.append(profile, checkpointSection, intro, this.changesRoot);
    this.renderExecutionProfile();
    this.renderCheckpoint();
    this.renderChanges();
  }

  private buildViewer() {
    clear(this.viewer);
    const head = el("header", { class: "viewer-head" });
    const close = el("button", { class: "viewer-back", "aria-label": "Return to build ledger", html: icon("chevron", 15) });
    close.addEventListener("click", () => this.closeViewer());
    const identity = el("div", { class: "viewer-identity" });
    identity.append(el("div", { class: "viewer-path", id: "viewer-path" }, ["No file selected"]));
    identity.append(el("div", { class: "viewer-meta", id: "viewer-meta" }));
    const copy = el("button", { class: "btn sm", id: "viewer-copy" }, ["Copy content"]);
    copy.addEventListener("click", () => void this.copyPreview());
    head.append(close, identity, copy);
    const content = el("pre", { class: "viewer-content", id: "viewer-content", tabindex: "0" });
    this.viewer.append(head, content);
  }

  getExecutionProfile(): AgentExecutionProfile {
    return this.executionProfile;
  }

  /** Bring the durable run ledger into view from Mission Control or the live Director strip. */
  showTimeMachine(): void {
    this.activateTab("changes");
    void this.refreshCheckpoints();
  }

  private setExecutionProfile(profile: AgentExecutionProfile) {
    this.executionProfile = profile;
    try {
      localStorage.setItem(EXECUTION_PROFILE_STORAGE_KEY, profile);
    } catch {
      // Keep the in-memory selection when persistence is unavailable.
    }
    this.renderExecutionProfile();
  }

  private renderExecutionProfile() {
    if (!this.executionProfileRoot) return;
    const selected = EXECUTION_PROFILES.find((profile) => profile.id === this.executionProfile) || EXECUTION_PROFILES[0];
    this.executionProfileRoot.querySelectorAll<HTMLButtonElement>("[data-execution-profile]").forEach((button) => {
      const active = button.dataset.executionProfile === selected.id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const current = this.changesPanel.querySelector<HTMLElement>(".execution-profile-current");
    const description = this.changesPanel.querySelector<HTMLElement>(".execution-profile-description");
    if (current) current.textContent = selected.label;
    if (description) description.textContent = selected.description;
  }

  async setProject(path: string | null) {
    this.projectPath = path;
    document.body.classList.toggle("has-project", Boolean(path));
    this.closeViewer();
    this.tree = null;
    this.setFileNotice();
    this.expanded.clear();
    this.changes.clear();
    this.checkpoints = [];
    this.expandedCheckpoints.clear();
    this.activeRunSessionId = null;
    this.setCheckpointNotice();
    this.renderCheckpoint();
    this.renderChanges();
    if (path) {
      await Promise.all([this.refresh(), this.refreshCheckpoints()]);
    }
    else this.renderNoProject();
  }

  async refresh() {
    if (!this.projectPath) return this.renderNoProject();
    this.treeRoot.setAttribute("aria-busy", "true");
    this.treeRoot.replaceChildren(el("div", { class: "inspector-state" }, ["Indexing project…"]));
    try {
      this.tree = await api.listProjectFiles(8);
      this.renderTree();
    } catch (error) {
      this.treeRoot.replaceChildren(el("div", { class: "inspector-state error", role: "alert" }, [String(error)]));
    } finally {
      this.treeRoot.removeAttribute("aria-busy");
    }
  }

  private renderNoProject() {
    this.treeRoot.replaceChildren(el("div", { class: "inspector-state" }, ["Open or create a project to inspect its files."]));
    this.fileCount.textContent = "No project selected";
    this.clearFilesButton.disabled = true;
  }

  private renderTree() {
    if (!this.tree) return this.renderNoProject();
    this.updateFilesToolbar();
    clear(this.treeRoot);
    const query = this.searchInput.value.trim().toLowerCase();
    const visible = query ? this.tree.nodes.filter((node) => nodeMatches(node, query)) : this.tree.nodes;
    if (!visible.length) {
      this.treeRoot.appendChild(el("div", { class: "inspector-state" }, [query ? "No matching project files." : "This project is empty."]));
      return;
    }
    this.appendNodes(visible, this.treeRoot, 0, query);
    if (this.tree.truncated) {
      this.treeRoot.appendChild(el("div", { class: "tree-limit", role: "status" }, ["Large project: showing a bounded file index."]));
    }
  }

  private appendNodes(nodes: ProjectNode[], parent: HTMLElement, depth: number, query: string) {
    for (const node of nodes) {
      if (query && !nodeMatches(node, query)) continue;
      const row = el("div", { class: "tree-row", style: `--tree-depth:${depth}` });
      const button = el("button", {
        class: `tree-item ${node.isDir ? "directory" : "file"}`,
        role: "treeitem", title: node.path,
      });
      button.appendChild(el("span", { class: "tree-disclosure", html: node.isDir ? icon("chevron", 11) : "" }));
      button.appendChild(el("span", { class: "tree-icon", html: icon(node.isDir ? "folder" : "file", 14) }));
      button.appendChild(el("span", { class: "tree-name" }, [node.name]));
      if (node.isDir) {
        const open = query.length > 0 || this.expanded.has(node.path);
        button.setAttribute("aria-expanded", String(open));
        row.classList.toggle("open", open);
        button.addEventListener("click", () => {
          this.expanded.has(node.path) ? this.expanded.delete(node.path) : this.expanded.add(node.path);
          this.renderTree();
        });
      } else {
        button.addEventListener("click", () => void this.openFile(node.path));
      }
      row.appendChild(button);
      if (!node.isDir) {
        const remove = el("button", {
          class: "tree-delete",
          type: "button",
          "aria-label": `Delete ${node.path}`,
          title: `Delete ${node.path}`,
          html: icon("trash", 13),
        }) as HTMLButtonElement;
        remove.disabled = this.fileActionInFlight;
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.requestDeleteFile(node.path);
        });
        row.appendChild(remove);
      }
      parent.appendChild(row);
      if (node.isDir && (query || this.expanded.has(node.path))) this.appendNodes(node.children, parent, depth + 1, query);
    }
  }

  async openFile(relativePath: string) {
    this.activePreview = null;
    this.chat.hidden = true;
    this.viewer.hidden = false;
    document.body.classList.add("viewer-open");
    document.getElementById("viewer-path")!.textContent = relativePath;
    document.getElementById("viewer-meta")!.textContent = "Loading preview…";
    document.getElementById("viewer-content")!.textContent = "";
    try {
      const preview = await api.readProjectFile(relativePath);
      this.activePreview = preview;
      document.getElementById("viewer-path")!.textContent = preview.path;
      document.getElementById("viewer-meta")!.textContent = `${formatBytes(preview.size)} · ${preview.language.toUpperCase()} · read only`;
      document.getElementById("viewer-content")!.textContent = preview.content;
    } catch (error) {
      document.getElementById("viewer-meta")!.textContent = "Preview unavailable";
      document.getElementById("viewer-content")!.textContent = String(error);
    }
  }

  closeViewer() {
    this.viewer.hidden = true;
    this.chat.hidden = false;
    document.body.classList.remove("viewer-open");
  }

  private async copyPreview() {
    if (!this.activePreview) return;
    await navigator.clipboard.writeText(this.activePreview.content).catch(() => undefined);
  }

  private updateFilesToolbar() {
    if (!this.tree || !this.projectPath) {
      this.fileCount.textContent = "No project selected";
      this.clearFilesButton.disabled = true;
      return;
    }
    const { files, folders } = countProjectItems(this.tree.nodes);
    const parts = [`${files} file${files === 1 ? "" : "s"}`];
    if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    this.fileCount.textContent = parts.join(" · ");
    this.clearFilesButton.disabled = this.fileActionInFlight || this.tree.nodes.length === 0;
    this.treeRoot.querySelectorAll<HTMLButtonElement>(".tree-delete").forEach((button) => {
      button.disabled = this.fileActionInFlight;
    });
  }

  private setFileNotice(message = "", kind: "success" | "error" = "success") {
    this.fileNotice.hidden = !message;
    this.fileNotice.className = `project-file-notice${message ? ` ${kind}` : ""}`;
    this.fileNotice.textContent = message;
  }

  private confirmProjectFileAction(options: {
    title: string;
    description: string;
    confirmLabel: string;
  }): Promise<boolean> {
    const root = document.getElementById("modal-root");
    if (!root || root.childElementCount > 0) {
      return Promise.resolve(window.confirm(`${options.title}\n\n${options.description}`));
    }

    return new Promise((resolve) => {
      const overlay = el("div", { class: "modal-overlay" });
      const modal = el("div", {
        class: "modal confirm-modal",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "project-files-confirm-title",
        "aria-describedby": "project-files-confirm-description",
        tabindex: "-1",
      });
      const head = el("div", { class: "modal-head" });
      head.appendChild(el("div", { class: "modal-title", id: "project-files-confirm-title" }, [options.title]));
      const closeButton = el("button", {
        class: "modal-close", type: "button", "aria-label": "Cancel", html: icon("close", 16),
      }) as HTMLButtonElement;
      head.appendChild(closeButton);
      const body = el("div", { class: "modal-body" });
      body.appendChild(el("p", { class: "confirm-modal-desc", id: "project-files-confirm-description" }, [options.description]));
      const foot = el("div", { class: "modal-foot" });
      const cancelButton = el("button", { class: "btn", type: "button" }, ["Cancel"]) as HTMLButtonElement;
      const confirmButton = el("button", { class: "btn danger", type: "button" }, [options.confirmLabel]) as HTMLButtonElement;
      foot.append(cancelButton, confirmButton);
      modal.append(head, body, foot);
      overlay.appendChild(modal);

      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clear(root);
        resolve(confirmed);
      };
      closeButton.addEventListener("click", () => finish(false));
      cancelButton.addEventListener("click", () => finish(false));
      confirmButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(false);
      });
      modal.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(false);
      });
      root.appendChild(overlay);
      cancelButton.focus();
    });
  }

  private async requestDeleteFile(relativePath: string) {
    if (this.fileActionInFlight) return;
    const confirmed = await this.confirmProjectFileAction({
      title: "Delete this project file?",
      description: `“${relativePath}” will be permanently removed from the active project. This cannot be undone.`,
      confirmLabel: "Delete file",
    });
    if (!confirmed) return;

    this.fileActionInFlight = true;
    this.updateFilesToolbar();
    try {
      await api.deleteProjectFile(relativePath);
      if (this.activePreview?.path === relativePath) this.closeViewer();
      this.addChange(relativePath, "deleted", "Deleted from project files");
      this.setFileNotice(`Deleted ${relativePath}.`);
      await this.refresh();
    } catch (error) {
      this.setFileNotice(`Could not delete ${relativePath}: ${String(error)}`, "error");
    } finally {
      this.fileActionInFlight = false;
      this.updateFilesToolbar();
    }
  }

  private async requestClearProjectFiles() {
    if (this.fileActionInFlight || !this.projectPath || !this.tree?.nodes.length) return;
    const confirmed = await this.confirmProjectFileAction({
      title: "Clear all project files?",
      description: "This permanently removes every file and folder in the active project. The project folder and its .git history stay in place. This cannot be undone.",
      confirmLabel: "Clear files",
    });
    if (!confirmed) return;

    this.fileActionInFlight = true;
    this.updateFilesToolbar();
    try {
      const removed = await api.clearProjectFiles();
      this.closeViewer();
      this.changes.clear();
      this.addChange("Project files", "deleted", `Cleared ${removed} project item${removed === 1 ? "" : "s"}`);
      this.setFileNotice(`Cleared ${removed} project item${removed === 1 ? "" : "s"}.`);
      await this.refresh();
    } catch (error) {
      this.setFileNotice(`Could not clear project files: ${String(error)}`, "error");
    } finally {
      this.fileActionInFlight = false;
      this.updateFilesToolbar();
    }
  }

  private setCheckpointNotice(message = "", kind: "success" | "error" = "success") {
    if (!this.checkpointNotice) return;
    this.checkpointNotice.hidden = !message;
    this.checkpointNotice.className = `checkpoint-notice${message ? ` ${kind}` : ""}`;
    this.checkpointNotice.textContent = message;
  }

  private async refreshCheckpoints() {
    if (!this.projectPath) {
      this.checkpoints = [];
      this.renderCheckpoint();
      return;
    }
    try {
      this.checkpoints = await api.listRunCheckpoints(this.projectPath);
    } catch (error) {
      this.checkpoints = [];
      this.setCheckpointNotice(`Could not load rollback checkpoints: ${String(error)}`, "error");
    }
    this.renderCheckpoint();
  }

  private renderCheckpoint() {
    if (!this.checkpointRoot) return;
    clear(this.checkpointRoot);
    if (!this.checkpoints.length) {
      this.checkpointRoot.appendChild(el("div", { class: "inspector-state compact" }, [
        this.projectPath ? "The next mutating agent run will appear here with protected actions." : "Open a project to use Time Machine.",
      ]));
      return;
    }

    const relevant = this.checkpoints
      .filter((item) => item.actionCount > 0 || item.status === "active" || (item.actions?.length || 0) > 0)
      .slice(0, 8);
    const checkpoints = relevant.length ? relevant : this.checkpoints.slice(0, 8);
    if (!this.expandedCheckpoints.size && checkpoints[0]) this.expandedCheckpoints.add(checkpoints[0].id);
    const timeline = el("div", { class: "checkpoint-timeline" });

    checkpoints.forEach((checkpoint, index) => {
      const expanded = this.expandedCheckpoints.has(checkpoint.id);
      const card = el("article", {
        class: `checkpoint-card status-${checkpoint.status.replaceAll("_", "-")}${expanded ? " expanded" : ""}`,
        "data-checkpoint-id": checkpoint.id,
      });
      const head = el("button", {
        class: "checkpoint-card-head",
        type: "button",
        "aria-expanded": String(expanded),
        "aria-controls": `checkpoint-body-${checkpoint.id}`,
      });
      const rail = el("span", { class: "checkpoint-rail", "aria-hidden": "true" });
      rail.appendChild(el("span", { class: "checkpoint-rail-dot" }));
      const identity = el("span", { class: "checkpoint-card-identity" });
      const runLabel = `${checkpoint.profile.slice(0, 1).toUpperCase()}${checkpoint.profile.slice(1)} run`;
      identity.append(
        el("strong", {}, [index === 0 && checkpoint.status === "active" ? `Live · ${runLabel}` : runLabel]),
        el("span", {}, [`${formatTimelineTime(checkpoint.createdAtMs)} · ${formatTimelineDuration(checkpoint.createdAtMs, checkpoint.finishedAtMs)}`]),
      );
      const summary = el("span", { class: "checkpoint-head-summary" });
      const count = checkpoint.actionCount === 1 ? "1 protected action" : `${checkpoint.actionCount} protected actions`;
      summary.append(
        el("span", { class: `checkpoint-status status-${checkpoint.status.replaceAll("_", "-")}` }, [checkpoint.status.replaceAll("_", " ")]),
        el("span", { class: "checkpoint-count" }, [count]),
        el("span", { class: "checkpoint-expand-mark", "aria-hidden": "true" }, [expanded ? "−" : "+"]),
      );
      head.append(rail, identity, summary);
      head.addEventListener("click", () => {
        if (expanded) this.expandedCheckpoints.delete(checkpoint.id);
        else this.expandedCheckpoints.add(checkpoint.id);
        this.renderCheckpoint();
      });
      card.appendChild(head);

      const body = el("div", {
        class: "checkpoint-card-body",
        id: `checkpoint-body-${checkpoint.id}`,
        ...(expanded ? {} : { hidden: "" }),
      });
      const detailParts = [`${checkpoint.protectedPaths} path${checkpoint.protectedPaths === 1 ? "" : "s"} covered`];
      if (checkpoint.conflictCount) detailParts.push(`${checkpoint.conflictCount} conflict${checkpoint.conflictCount === 1 ? "" : "s"} preserved`);
      body.appendChild(el("div", { class: "checkpoint-detail" }, [detailParts.join(" · ")]));

      const recordedActions = Array.isArray(checkpoint.actions) ? checkpoint.actions : [];
      const operationList = el("ol", { class: "checkpoint-operation-list", "aria-label": "Protected action history" });
      if (!recordedActions.length) {
        operationList.appendChild(el("li", { class: "checkpoint-operation-empty" }, ["No display-safe action details were recorded for this older run."]));
      } else {
        recordedActions.forEach((action) => {
          const item = el("li", { class: `checkpoint-operation status-${action.status.replaceAll("_", "-")}` });
          const target = action.projectWide
            ? "Whole project snapshot"
            : action.targets?.length
              ? action.targets.join(", ")
              : "Project path";
          item.append(
            el("span", { class: "checkpoint-operation-mark", "aria-hidden": "true" }),
            el("span", { class: "checkpoint-operation-copy" }, [
              el("strong", {}, [humanToolName(action.tool)]),
              el("small", { title: target }, [target]),
            ]),
            el("span", { class: "checkpoint-operation-meta" }, [
              el("span", {}, [actionStatusLabel(action.status)]),
              el("time", { datetime: new Date(action.createdAtMs).toISOString() }, [formatTimelineTime(action.createdAtMs)]),
            ]),
          );
          operationList.appendChild(item);
        });
      }
      body.appendChild(operationList);

      if (checkpoint.commandSideEffectsUnprotected || checkpoint.unprotectedActions > 0) {
        const caveat = checkpoint.unprotectedActions > 0
          ? `${checkpoint.unprotectedActions} action${checkpoint.unprotectedActions === 1 ? "" : "s"} targeted paths outside this project and cannot be restored here.`
          : "Direct file changes are protected. Shell-command side effects need Safe profile coverage.";
        body.appendChild(el("div", { class: "checkpoint-caveat" }, [caveat]));
      }

      const actions = el("div", { class: "checkpoint-actions" });
      const unavailable = this.checkpointActionInFlight
        || checkpoint.status === "active"
        || checkpoint.actionCount === 0
        || checkpoint.status === "rolled_back";
      const undoLast = el("button", { class: "btn sm", type: "button" }, ["Undo last"]) as HTMLButtonElement;
      const rollback = el("button", { class: "btn sm danger", type: "button" }, ["Roll back run"]) as HTMLButtonElement;
      undoLast.disabled = unavailable;
      rollback.disabled = unavailable;
      undoLast.addEventListener("click", () => void this.requestCheckpointRollback(checkpoint, "last_action"));
      rollback.addEventListener("click", () => void this.requestCheckpointRollback(checkpoint, "run"));
      actions.append(undoLast, rollback);
      body.appendChild(actions);
      card.appendChild(body);
      timeline.appendChild(card);
    });
    this.checkpointRoot.appendChild(timeline);
    if (this.checkpoints.length > checkpoints.length) {
      this.checkpointRoot.appendChild(el("p", { class: "checkpoint-retention" }, [
        `Showing the newest ${checkpoints.length} of ${this.checkpoints.length} retained runs.`,
      ]));
    }
  }

  async rollbackLatestCheckpoint(
    scope: "last_action" | "run",
  ): Promise<WorkspaceRollbackOutcome> {
    if (this.checkpointActionInFlight) return { kind: "busy" };
    if (!this.projectPath) return { kind: "unavailable" };

    await this.refreshCheckpoints();
    const checkpoint = this.checkpoints.find(
      (item) =>
        item.status !== "active" &&
        item.status !== "rolled_back" &&
        item.actions?.some((action) => action.status === "recorded"),
    );
    if (!checkpoint) return { kind: "unavailable" };

    this.activateTab("changes");
    return this.requestCheckpointRollback(checkpoint, scope);
  }

  private async requestCheckpointRollback(
    checkpoint: CheckpointSummary,
    scope: "last_action" | "run",
  ): Promise<WorkspaceRollbackOutcome> {
    if (this.checkpointActionInFlight) return { kind: "busy" };
    const entireRun = scope === "run";
    const confirmed = await this.confirmProjectFileAction({
      title: entireRun ? "Roll back this agent run?" : "Undo the latest agent action?",
      description: entireRun
        ? "Agent-owned file changes will be restored from the checkpoint. Files edited afterward are preserved as conflicts. Shell commands and external services may have effects outside this checkpoint."
        : "Only the most recent recorded file action will be restored. Newer user edits are preserved as conflicts.",
      confirmLabel: entireRun ? "Roll back run" : "Undo last action",
    });
    if (!confirmed) return { kind: "cancelled" };

    this.checkpointActionInFlight = true;
    this.renderCheckpoint();
    this.setCheckpointNotice(entireRun ? "Rolling back protected changes…" : "Undoing the latest protected action…");
    try {
      const result = await api.rollbackRunCheckpoint(checkpoint.id, scope);
      const conflictDetail = result.conflicts.length ? " " + result.conflicts.slice(0, 3).join("; ") : "";
      this.setCheckpointNotice(
        result.message + conflictDetail,
        result.conflicts.length ? "error" : "success",
      );
      this.changes.clear();
      this.addChange("Rollback", "command", result.message);
      await Promise.all([this.refresh(), this.refreshCheckpoints()]);
      return { kind: "completed", result };
    } catch (error) {
      const message = String(error);
      this.setCheckpointNotice("Rollback could not be completed: " + message, "error");
      return { kind: "error", message };
    } finally {
      this.checkpointActionInFlight = false;
      this.renderCheckpoint();
    }
  }

  private activateTab(tab: InspectorTab) {
    this.inspector.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]").forEach((button) => {
      const active = button.dataset.inspectorTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    this.filesPanel.hidden = tab !== "files";
    this.changesPanel.hidden = tab !== "changes";
    document.getElementById("console-panel")!.hidden = tab !== "console";
  }

  async beginRun(sessionId?: string) {
    this.activeRunSessionId = sessionId || null;
    if (!this.tree && this.projectPath) await this.refresh();
    this.baseline = flattenTree(this.tree?.nodes || []);
    this.changes.clear();
    this.pendingCalls.clear();
    this.renderChanges();
  }

  handleAgentEvent(event: AgentEvent) {
    if (event.kind === "start") {
      this.activeRunSessionId = event.session_id || this.activeRunSessionId;
      void this.refreshCheckpoints();
    } else if (event.kind === "tool_call") {
      this.pendingCalls.set(event.payload.id, { name: event.payload.name, args: event.payload.arguments || {} });
    } else if (event.kind === "tool_result") {
      const call = this.pendingCalls.get(event.payload.id);
      if (call && event.payload.ok) this.recordToolEffect(call);
      if (!event.payload.ok && call?.name === "run_command") this.activateTab("console");
    } else if (["done", "end", "cancelled"].includes(event.kind)) {
      void this.finishRun();
    }
  }

  private recordToolEffect(call: ToolCall) {
    if (call.name === "run_command") {
      this.addChange("Command activity", "command", "Workspace refreshed after shell execution");
      this.scheduleRefresh();
      return;
    }
    if (!MUTATING_TOOLS.has(call.name)) return;
    const paths = ["path", "file_path", "src", "dst", "source", "destination"]
      .map((key) => call.args[key])
      .filter((value): value is string => typeof value === "string")
      .map((path) => this.toProjectRelative(path))
      .filter((path): path is string => Boolean(path));
    for (const path of paths.length ? paths : [call.name]) this.addChange(path, "touched", call.name);
    this.scheduleRefresh();
  }

  private toProjectRelative(path: string): string | null {
    const normalized = path.replaceAll("\\", "/");
    const root = this.projectPath?.replaceAll("\\", "/").replace(/\/$/, "");
    if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
    if (/^[a-zA-Z]:|^\/|^\.\./.test(normalized)) return null;
    return normalized.replace(/^\.\//, "");
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 350);
  }

  async finishRun() {
    if (this.finishing) return;
    this.finishing = true;
    try {
      if (this.baseline) {
        await this.refresh();
        const current = flattenTree(this.tree?.nodes || []);
        for (const [path, signature] of current) {
          if (!this.baseline.has(path)) this.addChange(path, "added", "Created during run");
          else if (this.baseline.get(path) !== signature) this.addChange(path, "modified", "Changed during run");
        }
        for (const path of this.baseline.keys()) if (!current.has(path)) this.addChange(path, "deleted", "Deleted during run");
        this.baseline = null;
        this.renderChanges();
      }
      await this.refreshCheckpoints();
      this.activeRunSessionId = null;
    } finally {
      this.finishing = false;
    }
  }

  private addChange(path: string, kind: ChangeKind, detail: string) {
    this.changes.set(`${kind}:${path}`, { path, kind, detail });
    this.renderChanges();
  }

  private renderChanges() {
    clear(this.changesRoot);
    const items = [...this.changes.values()];
    if (!items.length) {
      this.changesRoot.appendChild(el("div", { class: "inspector-state" }, ["No workspace changes recorded yet."]));
      return;
    }
    const summary = el("div", { class: "changes-summary" }, [`${items.length} recorded change${items.length === 1 ? "" : "s"}`]);
    this.changesRoot.appendChild(summary);
    for (const item of items) {
      const button = el("button", { class: `change-item ${item.kind}`, title: item.detail });
      button.append(el("span", { class: "change-kind" }, [item.kind.slice(0, 1).toUpperCase()]));
      button.append(el("span", { class: "change-path" }, [item.path]));
      if (!["deleted", "command"].includes(item.kind)) button.addEventListener("click", () => void this.openFile(item.path));
      else button.setAttribute("aria-disabled", "true");
      this.changesRoot.appendChild(button);
    }
  }
}
