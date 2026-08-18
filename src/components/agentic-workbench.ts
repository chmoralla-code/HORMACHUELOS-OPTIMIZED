import { icon } from "./icons";
import { setShimmerText } from "./util";
import type {
  AgenticAgent,
  AgenticCompletion,
  AgenticPhase,
  AgenticPhaseState,
} from "../ipc";

type PlanEvent = {
  run_id: string;
  phases: { phase: AgenticPhase; state: AgenticPhaseState }[];
  max_workers: number;
};
type PhaseEvent = {
  run_id: string;
  phase: AgenticPhase;
  state: AgenticPhaseState;
  detail?: string;
};
type ToolState = "queued" | "running" | "passed" | "failed" | "cancelled";
type ToolItem = {
  id: string;
  name: string;
  arguments: unknown;
  result?: string;
  state: ToolState;
  agentId: string;
  phase: AgenticPhase;
};
type Lane = "progress" | "tools" | "agents";

const PHASES: { id: AgenticPhase; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "research", label: "Research" },
  { id: "multi_agent", label: "Multi-Agent" },
  { id: "build", label: "Build" },
];
const LANES: Lane[] = ["progress", "tools", "agents"];

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function bound(value: unknown, limit = 1_200): string {
  const chars = Array.from(String(value ?? "").replace(/\0/g, "").trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}
function label(value: string): string {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}
function tokens(value: number): string {
  if (!value) return "0";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}
const TOOL_TITLES: Record<string, string> = {
  read_file: "File look", read: "File look",
  glob: "File find", glob_file_search: "File find",
  grep: "Code search", ripgrep: "Code search",
  run_command: "Shell run", shell: "Shell run", bash: "Shell run",
  write_file: "File craft", edit_file: "Patch edit",
  list_dir: "Folder scan",
};
function toolKey(name: string): string {
  return String(name || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}
function friendlyTool(name: string): string {
  const key = toolKey(name);
  return TOOL_TITLES[key] || String(name || "tool").replace(/[_-]+/g, " ");
}
function clipHint(value: string, size = 42): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > size ? `${text.slice(0, size - 1)}…` : text;
}
function argHint(args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
  const take = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const path = take(record?.path) || take(record?.file_path) || take(record?.src);
  const usefulPath = path && path !== "." && path !== "./" ? path : "";
  const command = take(record?.command);
  const pattern = take(record?.pattern) || take(record?.query);
  if (usefulPath) return clipHint(usefulPath);
  if (command) return clipHint(command, 36);
  if (pattern) return clipHint(pattern, 36);
  if (typeof args === "string") return clipHint(args);
  return "";
}
function toolLine(tool: ToolItem): string {
  const title = friendlyTool(tool.name);
  const hint = argHint(tool.arguments);
  const body = hint ? `${title} · ${hint}` : title;
  if (tool.state === "queued") return `Queued ${body}`;
  if (tool.state === "running") return `Running ${body}`;
  if (tool.state === "failed") return `Failed ${body}`;
  if (tool.state === "cancelled") return `Cancelled ${body}`;
  return `Ran ${body}`;
}

type ToolCardView = {
  card: HTMLDetailsElement;
  name: HTMLElement;
  state: HTMLElement;
  meta: HTMLElement;
  args: HTMLElement;
  result: HTMLElement;
};

/** One host-owned, replayable execution surface for an AGENTIC turn. */
export class AgenticWorkbench {
  readonly root = make("section", "agentic-workbench");
  private readonly startedAt: number;
  private readonly phaseNodes = new Map<AgenticPhase, HTMLElement>();
  private readonly agents = new Map<string, AgenticAgent>();
  private readonly tools = new Map<string, ToolItem>();
  private readonly toolViews = new Map<string, ToolCardView>();
  private readonly agentNodes = new Map<string, HTMLDetailsElement>();
  private readonly filterChips = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<Lane, HTMLElement>();
  private readonly progress = make("ol", "agentic-progress-list");
  private readonly toolsList = make("div", "agentic-tool-list");
  private readonly emptyTools = make("p", "agentic-empty", "Tool evidence will appear here.");
  private readonly batchToggle = make("button", "agentic-tool-batch tool-batch-head");
  private readonly batchLabel = make("span", "agentic-tool-batch-label tool-batch-label", "Running 0 tools");
  private readonly agentsList = make("div", "agentic-agent-list");
  private readonly filter = make("div", "agentic-tool-filter");
  private readonly lanes = make("div", "agentic-lanes");
  private readonly delivery = make("section", "agentic-delivery-board");
  private readonly inspect = make("button", "agentic-inspect-button", "Inspect run");
  private readonly currentPhase = make("strong", "agentic-current-phase", "Ask");
  private readonly elapsedFact = make("dd", "", "0s");
  private readonly workersFact = make("dd", "", "0");
  private readonly toolsFact = make("dd", "", "0");
  private readonly statusFact = make("dd", "", "Running");
  private readonly live = make("div", "agentic-live-region");
  private readonly tabs: HTMLButtonElement[] = [];
  private phase: AgenticPhase = "ask";
  private lane: Lane = "tools";
  private selectedAgent = "all";
  private toolsCollapsed = false;
  private timer: ReturnType<typeof setInterval> | null;
  private terminal = false;

  constructor(
    runId: string,
    startedAt = Date.now(),
    private readonly onExport?: (summary: string) => Promise<void>,
  ) {
    this.startedAt = startedAt;
    this.root.dataset.runId = runId;
    this.root.setAttribute("aria-label", "AGENTIC execution workbench");

    const header = make("header", "agentic-workbench-header");
    const identity = make("div", "agentic-workbench-identity");
    identity.append(make("span", "agentic-badge", "AGENTIC"), this.currentPhase);
    header.append(identity);
    const facts = make("dl", "agentic-live-facts");
    const fact = (name: string, value: HTMLElement, extra = "") => {
      const item = make("div", extra ? `agentic-live-fact ${extra}` : "agentic-live-fact");
      item.append(make("dt", "", name), value);
      facts.append(item);
    };
    fact("Elapsed", this.elapsedFact, "agentic-live-fact-elapsed");
    fact("Workers", this.workersFact, "agentic-sr-only");
    fact("Tools", this.toolsFact, "agentic-sr-only");
    fact("Status", this.statusFact, "agentic-sr-only");
    header.append(facts);
    this.root.append(header);

    const strip = make("ol", "agentic-phase-strip");
    strip.setAttribute("aria-label", "AGENTIC phases");
    for (const item of PHASES) {
      const phase = make("li", "agentic-phase");
      phase.dataset.phase = item.id;
      phase.dataset.state = item.id === "ask" ? "active" : "pending";
      phase.append(make("span", "agentic-phase-marker"), make("span", "", item.label));
      strip.append(phase);
      this.phaseNodes.set(item.id, phase);
    }
    this.root.append(strip);

    const tablist = make("div", "agentic-lane-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Execution lanes");
    for (const lane of LANES) {
      const button = make("button", "agentic-lane-tab", label(lane));
      button.type = "button";
      button.id = `agentic-tab-${runId}-${lane}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `agentic-panel-${runId}-${lane}`);
      button.addEventListener("click", () => this.selectLane(lane, true));
      button.addEventListener("keydown", (event) => this.moveTab(event, lane));
      tablist.append(button);
      this.tabs.push(button);
    }
    this.root.append(tablist);

    this.createPanel(runId, "progress", "Progress", this.progress);
    const toolsBody = make("div", "agentic-tools-body");
    this.batchToggle.type = "button";
    this.batchToggle.hidden = true;
    this.batchToggle.setAttribute("aria-expanded", "true");
    this.batchToggle.title = "Show or hide tool activity";
    const batchChev = make("span", "tool-batch-chev");
    batchChev.innerHTML = icon("chevronDown", 12);
    this.batchToggle.append(this.batchLabel, batchChev);
    this.batchToggle.addEventListener("click", () => this.toggleTools());
    this.toolsList.append(this.emptyTools);
    toolsBody.append(this.batchToggle, this.filter, this.toolsList);
    this.createPanel(runId, "tools", "Tools", toolsBody);
    this.createPanel(runId, "agents", "Agents", this.agentsList);
    this.root.append(this.lanes);

    this.inspect.type = "button";
    this.inspect.hidden = true;
    this.inspect.setAttribute("aria-expanded", "false");
    this.inspect.addEventListener("click", () => this.toggleInspect());
    const controls = make("div", "agentic-terminal-controls");
    controls.append(this.inspect);
    this.root.append(controls);

    this.delivery.hidden = true;
    this.delivery.setAttribute("aria-label", "AGENTIC Delivery Board");
    this.root.append(this.delivery);
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.root.append(this.live);

    this.addProgress("ask", "Director captured the request and permission boundary.", "active");
    this.selectLane("tools", false);
    this.paintAgents();
    this.paintFilter();
    this.paintTools();
    this.elapsedFact.textContent = elapsed(Date.now() - this.startedAt);
    this.timer = setInterval(() => {
      this.elapsedFact.textContent = elapsed(Date.now() - this.startedAt);
    }, 1_000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  updatePlan(event: PlanEvent): void {
    for (const phase of event.phases || []) this.setPhase(phase.phase, phase.state);
    this.announce(`Path prepared with up to ${event.max_workers} workers.`);
  }

  updatePhase(event: PhaseEvent): void {
    this.phase = event.phase;
    this.currentPhase.textContent = label(event.phase);
    this.setPhase(event.phase, event.state);
    if (event.detail) this.addProgress(event.phase, event.detail, event.state);
    this.statusFact.textContent =
      event.state === "failed" ? "Needs attention" :
      event.state === "cancelled" ? "Cancelled" :
      event.state === "active" ? "Running" : label(event.state);
    this.announce(event.detail || `${label(event.phase)} ${label(event.state)}`);
  }

  updateAgent(agent: AgenticAgent): void {
    if (!agent?.id) return;
    this.agents.set(agent.id, {
      ...agent,
      assignment: bound(agent.assignment, 600),
      resultSummary: agent.resultSummary ? bound(agent.resultSummary, 1_400) : undefined,
    });
    this.workersFact.textContent = String(
      [...this.agents.values()].filter((value) => value.id !== "director").length,
    );
    this.paintAgents();
    this.paintFilter();
    this.refreshToolOwners();
    this.announce(`${agent.name} ${label(agent.status)}`);
  }

  previewTool(event: {
    id: string; name: string; arguments_delta?: string;
    agent_id?: string; phase?: AgenticPhase;
  }): void {
    if (this.tools.has(event.id)) return;
    this.tools.set(event.id, {
      id: event.id,
      name: event.name,
      arguments: event.arguments_delta || "",
      state: "queued",
      agentId: event.agent_id || "director",
      phase: event.phase || this.phase,
    });
    this.syncTools();
  }

  queueTool(event: {
    id: string; name: string; arguments: unknown;
    agent_id?: string; phase?: AgenticPhase;
  }): void {
    const old = this.tools.get(event.id);
    this.tools.set(event.id, {
      id: event.id,
      name: event.name,
      arguments: event.arguments ?? old?.arguments ?? {},
      result: old?.result,
      state: "running",
      agentId: event.agent_id || old?.agentId || "director",
      phase: event.phase || old?.phase || this.phase,
    });
    this.syncTools();
    this.announce(`${label(event.name)} started`);
  }

  finishTool(event: {
    id: string; name: string; ok: boolean; content: string;
    agent_id?: string; phase?: AgenticPhase;
  }): void {
    const old = this.tools.get(event.id);
    this.tools.set(event.id, {
      id: event.id,
      name: event.name || old?.name || "tool",
      arguments: old?.arguments ?? {},
      result: bound(event.content, 4_000),
      state: event.ok ? "passed" : "failed",
      agentId: event.agent_id || old?.agentId || "director",
      phase: event.phase || old?.phase || this.phase,
    });
    this.syncTools();
    this.announce(`${label(event.name)} ${event.ok ? "passed" : "failed"}`);
  }

  addStatus(message: string): void {
    if (message.trim()) this.addProgress(this.phase, bound(message, 360), "active");
  }

  complete(value: AgenticCompletion): void {
    this.terminal = true;
    this.dispose();
    this.statusFact.textContent = value.status === "needs_attention"
      ? "Needs attention" : label(value.status);
    this.elapsedFact.textContent = elapsed(value.facts?.elapsedMs || Date.now() - this.startedAt);
    this.renderDelivery(value);
    this.delivery.hidden = false;
    this.inspect.hidden = false;
    this.inspect.textContent = "Inspect run";
    this.inspect.setAttribute("aria-expanded", "false");
    const restoreFocus = this.root.contains(document.activeElement);
    this.lanes.classList.add("is-collapsed");
    this.root.classList.add("is-terminal");
    if (restoreFocus) this.inspect.focus();
    this.announce(`Run ${label(value.status)}. ${value.outcome}`);
  }

  finish(reason: string): void {
    if (this.terminal) return;
    const failedTools = [...this.tools.values()].filter((tool) => tool.state === "failed").length;
    const successful = ["completed", "no_tool_calls"].includes(reason.trim().toLowerCase());
    this.complete({
      status: successful && failedTools === 0 ? "partial" : "needs_attention",
      outcome: successful
        ? "The answer finished, but the provider did not return a structured Delivery Board."
        : `The run ended with ${label(reason)} before structured delivery evidence was available.`,
      changes: [],
      verification: [],
      contributions: [...this.agents.values()].map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        result: agent.resultSummary || "No final contribution was recorded.",
      })),
      risks: ["Structured completion evidence is unavailable for this run."],
      nextActions: successful ? [] : ["Inspect the run details and retry the incomplete phase."],
      facts: {
        elapsedMs: Date.now() - this.startedAt,
        totalTokens: [...this.agents.values()].reduce(
          (sum, agent) => sum + (agent.usage?.totalTokens || 0), 0,
        ),
        workers: [...this.agents.values()].filter((agent) => agent.id !== "director").length,
        tools: this.tools.size,
        changedFiles: 0,
      },
    });
  }

  cancel(): void {
    if (this.terminal) return;
    for (const { id } of PHASES) {
      const state = this.phaseNodes.get(id)?.dataset.state;
      if (state === "active" || state === "pending") this.setPhase(id, "cancelled");
    }
    for (const tool of this.tools.values()) {
      if (tool.state === "running" || tool.state === "queued") tool.state = "cancelled";
    }
    this.paintTools();
    this.complete({
      status: "cancelled",
      outcome: "The run was cancelled. Completed evidence remains available under Inspect run.",
      changes: [],
      verification: [],
      contributions: [...this.agents.values()].map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        result: agent.resultSummary || "Cancelled before a final conclusion was recorded.",
      })),
      risks: [],
      nextActions: [],
      facts: {
        elapsedMs: Date.now() - this.startedAt,
        totalTokens: [...this.agents.values()].reduce(
          (sum, agent) => sum + (agent.usage?.totalTokens || 0), 0,
        ),
        workers: [...this.agents.values()].filter((agent) => agent.id !== "director").length,
        tools: this.tools.size,
        changedFiles: 0,
      },
    });
  }

  private createPanel(runId: string, lane: Lane, title: string, body: HTMLElement): void {
    const panel = make("section", `agentic-lane agentic-lane-${lane}`);
    panel.id = `agentic-panel-${runId}-${lane}`;
    panel.dataset.lane = lane;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `agentic-tab-${runId}-${lane}`);
    panel.append(make("h3", "agentic-lane-title agentic-sr-only", title), body);
    this.lanes.append(panel);
    this.panels.set(lane, panel);
  }

  private setPhase(phase: AgenticPhase, state: AgenticPhaseState): void {
    const node = this.phaseNodes.get(phase);
    if (!node) return;
    node.dataset.state = state;
    node.setAttribute("aria-label", `${label(phase)}: ${label(state)}`);
  }

  private addProgress(
    phase: AgenticPhase,
    detail: string,
    state: AgenticPhaseState | "active",
  ): void {
    const item = make("li", "agentic-progress-item");
    item.dataset.state = state;
    item.append(
      make("span", "agentic-progress-phase", label(phase)),
      make("span", "agentic-progress-detail", detail),
    );
    this.progress.append(item);
    while (this.progress.children.length > 24) this.progress.firstElementChild?.remove();
  }

  private syncTools(): void {
    this.toolsFact.textContent = String(this.tools.size);
    this.paintTools();
  }

  private toggleTools(): void {
    this.toolsCollapsed = !this.toolsCollapsed;
    this.batchToggle.classList.toggle("collapsed", this.toolsCollapsed);
    this.batchToggle.setAttribute("aria-expanded", String(!this.toolsCollapsed));
    this.paintTools();
  }

  private ownerName(agentId: string): string {
    return this.agents.get(agentId)?.name
      || (agentId === "director" ? "Director" : label(agentId));
  }

  private refreshToolOwners(): void {
    for (const [id, view] of this.toolViews) {
      const tool = this.tools.get(id);
      if (!tool) continue;
      view.meta.textContent = `${this.ownerName(tool.agentId)} · ${label(tool.phase)}`;
    }
  }

  private selectAgent(id: string): void {
    this.selectedAgent = id;
    this.paintFilter();
    this.paintAgents();
    this.paintTools();
  }

  private paintTools(): void {
    const count = this.tools.size;
    const running = [...this.tools.values()].some(
      (tool) => tool.state === "running" || tool.state === "queued",
    );
    const labelText = count === 0
      ? "Running 0 tools"
      : running
        ? `Running ${count} tool${count === 1 ? "" : "s"}`
        : `Ran ${count} tool${count === 1 ? "" : "s"}`;
    this.batchToggle.hidden = count === 0;
    this.batchToggle.classList.toggle("is-running", running);
    this.batchToggle.classList.toggle("collapsed", this.toolsCollapsed);
    setShimmerText(this.batchLabel, labelText, running);

    for (const tool of this.tools.values()) {
      let view = this.toolViews.get(tool.id);
      if (!view) {
        view = this.createToolCard(tool);
        this.toolViews.set(tool.id, view);
        this.toolsList.append(view.card);
      } else {
        this.updateToolCard(view, tool);
      }
      const match = this.selectedAgent === "all" || tool.agentId === this.selectedAgent;
      view.card.hidden = this.toolsCollapsed || !match;
    }

    const visible = [...this.tools.values()].filter(
      (tool) => this.selectedAgent === "all" || tool.agentId === this.selectedAgent,
    );
    this.emptyTools.hidden = this.toolsCollapsed || visible.length > 0;
    this.emptyTools.textContent = this.tools.size
      ? "No tools match this agent filter."
      : "Tool evidence will appear here.";
    this.filter.hidden = this.toolsCollapsed || this.agents.size <= 1;
  }

  private createToolCard(tool: ToolItem): ToolCardView {
    const card = make("details", "agentic-tool-card tool-card tool-spawn");
    const head = make("summary", "agentic-tool-summary tool-card-head");
    const name = make("span", "agentic-tool-name tool-name");
    const chev = make("span", "chev");
    chev.innerHTML = icon("chevronDown", 12);
    const state = make("span", "agentic-tool-state agentic-sr-only");
    head.append(name, chev, state);
    const body = make("div", "agentic-tool-body");
    const meta = make("div", "agentic-tool-meta");
    const args = this.toolBlock("Arguments", "");
    const result = this.toolBlock("Result", "");
    args.classList.add("agentic-tool-args");
    result.classList.add("agentic-tool-result");
    body.append(meta, args, result);
    card.append(head, body);
    card.addEventListener("animationend", (event) => {
      if (event.target === card) card.classList.remove("tool-spawn");
    });
    const view: ToolCardView = {
      card,
      name,
      state,
      meta,
      args: args.querySelector("pre") as HTMLElement,
      result,
    };
    this.updateToolCard(view, tool);
    return view;
  }

  private updateToolCard(view: ToolCardView, tool: ToolItem): void {
    const live = tool.state === "queued" || tool.state === "running";
    view.card.dataset.state = tool.state;
    view.card.classList.toggle("pending", live);
    view.card.classList.toggle("err", tool.state === "failed");
    view.card.classList.toggle("ok", tool.state === "passed");
    view.card.classList.toggle("cancelled", tool.state === "cancelled");
    setShimmerText(view.name, toolLine(tool), live);
    view.name.setAttribute("data-tool", tool.name);
    view.state.textContent = label(tool.state);
    view.meta.textContent = `${this.ownerName(tool.agentId)} · ${label(tool.phase)}`;
    view.args.textContent = bound(
      typeof tool.arguments === "string"
        ? tool.arguments
        : JSON.stringify(tool.arguments ?? {}, null, 2),
      4_000,
    );
    view.result.hidden = tool.result === undefined;
    const resultPre = view.result.querySelector("pre");
    if (resultPre) resultPre.textContent = bound(tool.result ?? "", 4_000);
  }

  private toolBlock(title: string, value: string): HTMLElement {
    const block = make("div", "agentic-tool-block");
    const pre = make("pre");
    pre.textContent = bound(value, 4_000);
    block.append(make("strong", "", title), pre);
    return block;
  }

  private paintAgents(): void {
    const values = [...this.agents.values()].sort((left, right) =>
      left.id === "director" ? -1 : right.id === "director" ? 1 : left.id.localeCompare(right.id));
    if (!values.length) {
      this.agentNodes.clear();
      this.agentsList.replaceChildren(
        make("p", "agentic-empty", "The Director is preparing assignments."),
      );
      return;
    }
    this.agentsList.querySelector(".agentic-empty")?.remove();
    for (const [id, node] of this.agentNodes) {
      if (!this.agents.has(id)) {
        node.remove();
        this.agentNodes.delete(id);
      }
    }
    for (const agent of values) {
      let card = this.agentNodes.get(agent.id);
      if (!card) {
        card = this.createAgentCard(agent);
        this.agentNodes.set(agent.id, card);
      } else {
        this.updateAgentCard(card, agent);
      }
      this.agentsList.append(card);
    }
  }

  private createAgentCard(agent: AgenticAgent): HTMLDetailsElement {
    const card = make("details", "agentic-agent-card tool-spawn");
    const head = make("summary", "agentic-agent-summary");
    head.append(
      make("strong", "agentic-agent-name"),
      make("span", "agentic-agent-status"),
    );
    const chev = make("span", "chev");
    chev.innerHTML = icon("chevronDown", 12);
    head.append(chev);
    const body = make("div", "agentic-agent-body");
    body.append(
      make("span", "agentic-agent-role"),
      make("span", "agentic-agent-assignment"),
      make("span", "agentic-agent-meta"),
      make("span", "agentic-agent-result"),
    );
    card.append(head, body);
    card.addEventListener("animationend", (event) => {
      if (event.target === card) card.classList.remove("tool-spawn");
    });
    this.updateAgentCard(card, agent);
    return card;
  }

  private updateAgentCard(card: HTMLDetailsElement, agent: AgenticAgent): void {
    card.dataset.status = agent.status;
    card.classList.toggle("is-selected", this.selectedAgent === agent.id);
    const name = card.querySelector(".agentic-agent-name");
    const status = card.querySelector(".agentic-agent-status");
    const role = card.querySelector(".agentic-agent-role");
    const assignment = card.querySelector(".agentic-agent-assignment");
    const meta = card.querySelector(".agentic-agent-meta");
    const result = card.querySelector(".agentic-agent-result") as HTMLElement | null;
    if (name) name.textContent = agent.name;
    if (status) status.textContent = label(agent.status);
    if (role) role.textContent = agent.role;
    if (assignment) assignment.textContent = agent.assignment;
    if (meta) {
      meta.textContent =
        `${agent.toolCount || 0} tools · ${tokens(agent.usage?.totalTokens || 0)} tokens`;
    }
    if (result) {
      result.hidden = !agent.resultSummary;
      result.textContent = agent.resultSummary || "";
    }
  }

  private paintFilter(): void {
    const choices = [
      { id: "all", name: "All tools" },
      ...[...this.agents.values()].map((agent) => ({ id: agent.id, name: agent.name })),
    ];
    this.filter.hidden = this.toolsCollapsed || this.agents.size <= 1;
    for (const [id, button] of this.filterChips) {
      if (!choices.some((choice) => choice.id === id)) {
        button.remove();
        this.filterChips.delete(id);
      }
    }
    for (const choice of choices) {
      let button = this.filterChips.get(choice.id);
      if (!button) {
        button = make("button", "agentic-filter-chip", choice.name);
        button.type = "button";
        button.addEventListener("click", () => this.selectAgent(choice.id));
        this.filter.append(button);
        this.filterChips.set(choice.id, button);
      } else if (button.textContent !== choice.name) {
        button.textContent = choice.name;
      }
      button.classList.toggle("is-selected", choice.id === this.selectedAgent);
      button.setAttribute("aria-pressed", String(choice.id === this.selectedAgent));
    }
  }

  private selectLane(lane: Lane, focus: boolean): void {
    this.lane = lane;
    LANES.forEach((value, index) => {
      const selected = value === lane;
      this.tabs[index].setAttribute("aria-selected", String(selected));
      this.tabs[index].tabIndex = selected ? 0 : -1;
      this.panels.get(value)?.classList.toggle("is-selected", selected);
      if (selected && focus) this.tabs[index].focus();
    });
  }

  private moveTab(event: KeyboardEvent, lane: Lane): void {
    const index = LANES.indexOf(lane);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % LANES.length;
    else if (event.key === "ArrowLeft") next = (index + LANES.length - 1) % LANES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = LANES.length - 1;
    else return;
    event.preventDefault();
    this.selectLane(LANES[next], true);
  }

  private toggleInspect(): void {
    const open = this.lanes.classList.contains("is-collapsed");
    this.lanes.classList.toggle("is-collapsed", !open);
    this.inspect.textContent = open ? "Hide run" : "Inspect run";
    this.inspect.setAttribute("aria-expanded", String(open));
    const active = document.activeElement;
    if (
      !open &&
      active instanceof HTMLElement &&
      this.lanes.contains(active) &&
      !active.closest(".agentic-lane-tools")
    ) {
      this.inspect.focus();
    }
  }

  private renderDelivery(value: AgenticCompletion): void {
    this.delivery.replaceChildren();
    const header = make("header", "agentic-delivery-header");
    const status = make("span", "agentic-outcome-status", label(value.status));
    status.dataset.status = value.status;
    header.append(status, make("h3", "", "Delivery Board"));
    this.delivery.append(header, make("p", "agentic-outcome-copy", bound(value.outcome, 900)));

    if (value.changes?.length) {
      this.delivery.append(this.section("Changes", value.changes.map((change) =>
        `${change.behavior}${change.files?.length ? ` — ${change.files.join(", ")}` : ""}`)));
    }

    const verification = make("section", "agentic-delivery-section");
    verification.append(make("h4", "", "Verification"));
    const checks = make("ul", "agentic-verification-list");
    if (!value.verification?.length) {
      const item = make("li", "agentic-verification-item", "No host-observed checks were recorded.");
      item.dataset.status = "not_run";
      checks.append(item);
    } else {
      for (const check of value.verification) {
        const item = make("li", "agentic-verification-item");
        item.dataset.status = check.status;
        item.append(make("strong", "", check.name), make("span", "", check.evidence));
        checks.append(item);
      }
    }
    verification.append(checks);
    this.delivery.append(verification);

    if (value.contributions?.length) {
      const section = make("section", "agentic-delivery-section");
      section.append(make("h4", "", "Agent Contributions"));
      const list = make("dl", "agentic-contribution-list");
      for (const item of value.contributions) {
        list.append(make("dt", "", item.name), make("dd", "", bound(item.result, 700)));
      }
      section.append(list);
      this.delivery.append(section);
    }
    if (value.risks?.length || value.nextActions?.length) {
      const section = make("section", "agentic-delivery-section agentic-risk-section");
      section.append(make("h4", "", "Risks & Next Actions"));
      if (value.risks?.length) section.append(this.list(value.risks, "agentic-risk-list"));
      if (value.nextActions?.length) section.append(this.list(value.nextActions, "agentic-next-list"));
      this.delivery.append(section);
    }

    const facts = make("dl", "agentic-run-facts");
    const values: [string, string][] = [
      ["Elapsed", elapsed(value.facts?.elapsedMs || Date.now() - this.startedAt)],
      ["Model usage", `${tokens(value.facts?.totalTokens || 0)} tokens`],
      ["Workers", String(value.facts?.workers || 0)],
      ["Tools", String(value.facts?.tools || this.tools.size)],
      ["Changed files", String(value.facts?.changedFiles || 0)],
    ];
    for (const [name, result] of values) {
      const pair = make("div");
      pair.append(make("dt", "", name), make("dd", "", result));
      facts.append(pair);
    }
    this.delivery.append(facts);

    if (value.changes?.length && this.onExport) {
      const button = make("button", "agentic-export-button", "Export Client Pack");
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Packing…";
        try {
          await this.onExport?.(value.outcome);
          button.textContent = "Pack ready";
        } catch (error) {
          console.error(error);
          button.textContent = "Export failed";
        } finally {
          window.setTimeout(() => {
            button.disabled = false;
            button.textContent = "Export Client Pack";
          }, 1_600);
        }
      });
      const actions = make("div", "agentic-delivery-actions");
      actions.append(button);
      this.delivery.append(actions);
    }
  }

  private section(title: string, entries: string[]): HTMLElement {
    const section = make("section", "agentic-delivery-section");
    section.append(make("h4", "", title), this.list(entries, "agentic-delivery-list"));
    return section;
  }

  private list(entries: string[], className: string): HTMLElement {
    const list = make("ul", className);
    for (const entry of entries) list.append(make("li", "", bound(entry, 900)));
    return list;
  }

  private announce(message: string): void {
    this.live.textContent = bound(message, 240);
  }
}
