import { icon } from "./icons";
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

const PHASES: { id: AgenticPhase; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "research", label: "Research" },
  { id: "multi_agent", label: "Multi-Agent" },
  { id: "build", label: "Build" },
];

/** One thought block holds up to this many characters before it is truncated. */
const THOUGHT_CHAR_LIMIT = 8_000;

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

/**
 * One linear THOUGHT → TOOL → THOUGHT transcript for an AGENTIC turn.
 * Everything renders in arrival order inside a single feed: no lanes, no
 * tabs, no filters, no animation — just the plain reasoning/tool rhythm.
 */
export class AgenticWorkbench {
  readonly root = make("section", "agentic-workbench");
  private readonly startedAt: number;
  private readonly agents = new Map<string, AgenticAgent>();
  private readonly tools = new Map<string, ToolItem>();
  private readonly toolViews = new Map<string, ToolCardView>();
  private readonly agentNodes = new Map<string, HTMLElement>();
  private readonly feed = make("div", "agentic-feed");
  private readonly currentPhase = make("strong", "agentic-current-phase", "Ask");
  private readonly elapsedFact = make("dd", "", "0s");
  private readonly workersFact = make("dd", "", "0");
  private readonly toolsFact = make("dd", "", "0");
  private readonly statusFact = make("dd", "", "Running");
  private readonly live = make("div", "agentic-live-region");
  private readonly delivery = make("section", "agentic-delivery-board");
  private phase: AgenticPhase = "ask";
  private thoughtNode: HTMLElement | null = null;
  private thoughtBody: HTMLElement | null = null;
  private thoughtText = "";
  private thoughtClosed = true;
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

    this.feed.setAttribute("role", "log");
    this.feed.setAttribute("aria-label", "Thought and tool transcript");
    this.root.append(this.feed);

    this.delivery.hidden = true;
    this.delivery.setAttribute("aria-label", "AGENTIC summary");
    this.root.append(this.delivery);
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.root.append(this.live);

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
    this.paintAgent(agent.id);
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

  appendThinking(text: string): void {
    const chunk = String(text || "").trim();
    if (!chunk) return;
    if (!this.thoughtNode || this.thoughtClosed) {
      this.thoughtNode = make("div", "agentic-thought");
      this.thoughtNode.append(make("span", "agentic-thought-kind", "THOUGHT"));
      this.thoughtBody = make("div", "agentic-thought-text");
      this.thoughtNode.append(this.thoughtBody);
      this.feed.append(this.thoughtNode);
      this.thoughtText = "";
      this.thoughtClosed = false;
    }
    const merged = this.thoughtText ? `${this.thoughtText}\n${chunk}` : chunk;
    this.thoughtText = bound(merged, THOUGHT_CHAR_LIMIT);
    this.thoughtBody!.textContent = this.thoughtText;
  }

  complete(value: AgenticCompletion): void {
    this.terminal = true;
    this.dispose();
    this.statusFact.textContent = value.status === "needs_attention"
      ? "Needs attention" : label(value.status);
    this.elapsedFact.textContent = elapsed(value.facts?.elapsedMs || Date.now() - this.startedAt);
    this.closeThought();
    this.renderDelivery(value);
    this.delivery.hidden = false;
    this.announce(`Run ${label(value.status)}. ${value.outcome}`);
  }

  finish(reason: string): void {
    if (this.terminal) return;
    const failedTools = [...this.tools.values()].filter((tool) => tool.state === "failed").length;
    const successful = ["completed", "no_tool_calls"].includes(reason.trim().toLowerCase());
    this.complete({
      status: successful && failedTools === 0 ? "partial" : "needs_attention",
      outcome: successful
        ? "The answer finished, but the provider did not return a structured summary."
        : `The run ended with ${label(reason)} before structured summary evidence was available.`,
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
    for (const tool of this.tools.values()) {
      if (tool.state === "running" || tool.state === "queued") tool.state = "cancelled";
    }
    for (const [id, view] of this.toolViews) {
      const tool = this.tools.get(id);
      if (tool) this.updateToolCard(view, tool);
    }
    this.complete({
      status: "cancelled",
      outcome: "The run was cancelled. Completed evidence remains available in the transcript.",
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

  private setPhase(_phase: AgenticPhase, _state: AgenticPhaseState): void {
    // Phase state is reflected through the header label and progress lines.
  }

  private closeThought(): void {
    this.thoughtClosed = true;
  }

  private addProgress(
    phase: AgenticPhase,
    detail: string,
    state: AgenticPhaseState | "active",
  ): void {
    this.closeThought();
    const item = make("div", "agentic-progress-line");
    item.dataset.state = state;
    item.append(
      make("span", "agentic-progress-phase", label(phase)),
      make("span", "agentic-progress-detail", detail),
    );
    this.feed.append(item);
    while (this.feed.querySelectorAll(".agentic-progress-line").length > 24) {
      this.feed.querySelector(".agentic-progress-line")?.remove();
    }
  }

  private syncTools(): void {
    this.closeThought();
    this.toolsFact.textContent = String(this.tools.size);
    for (const tool of this.tools.values()) {
      let view = this.toolViews.get(tool.id);
      if (!view) {
        view = this.createToolCard(tool);
        this.toolViews.set(tool.id, view);
        this.feed.append(view.card);
      } else {
        this.updateToolCard(view, tool);
      }
    }
  }

  private ownerName(agentId: string): string {
    return this.agents.get(agentId)?.name
      || (agentId === "director" ? "Director" : label(agentId));
  }

  private createToolCard(tool: ToolItem): ToolCardView {
    const card = make("details", "agentic-tool-card");
    const head = make("summary", "agentic-tool-summary");
    const kind = make("span", "agentic-tool-kind", "TOOL");
    const name = make("span", "agentic-tool-name");
    const chev = make("span", "chev");
    chev.innerHTML = icon("chevronDown", 12);
    const state = make("span", "agentic-tool-state agentic-sr-only");
    head.append(kind, name, chev, state);
    const body = make("div", "agentic-tool-body");
    const meta = make("div", "agentic-tool-meta");
    const args = this.toolBlock("Arguments", "");
    const result = this.toolBlock("Result", "");
    args.classList.add("agentic-tool-args");
    result.classList.add("agentic-tool-result");
    body.append(meta, args, result);
    card.append(head, body);
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
    view.name.textContent = toolLine(tool);
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

  /** One compact status line per agent, updated in place inside the feed. */
  private paintAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.closeThought();
    let line = this.agentNodes.get(agentId);
    if (!line) {
      line = make("div", "agentic-agent-line");
      line.append(
        make("span", "agentic-agent-kind", "AGENT"),
        make("strong", "agentic-agent-name"),
        make("span", "agentic-agent-status"),
      );
      this.agentNodes.set(agentId, line);
      this.feed.append(line);
    }
    const name = line.querySelector(".agentic-agent-name");
    const status = line.querySelector(".agentic-agent-status");
    if (name) name.textContent = `${agent.name} · ${agent.role}`;
    if (status) {
      const bits = [label(agent.status)];
      if (agent.toolCount) bits.push(`${agent.toolCount} tools`);
      if (agent.usage?.totalTokens) bits.push(`${tokens(agent.usage.totalTokens)} tokens`);
      status.textContent = bits.join(" · ");
    }
  }

  private renderDelivery(value: AgenticCompletion): void {
    this.delivery.replaceChildren();
    const header = make("header", "agentic-delivery-header");
    const status = make("span", "agentic-outcome-status", label(value.status));
    status.dataset.status = value.status;
    header.append(status, make("h3", "", "SUMMARY"));
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
