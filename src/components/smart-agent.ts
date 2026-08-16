import type { AgentEvent } from "../ipc";
import { clear, div, el } from "./util";
import { icon } from "./icons";
import {
  redactChatCredentials,
  sanitizeSmartAgentTaskState,
  type Session,
  type SmartAgentStepState,
  type SmartAgentTaskState,
} from "./session";

const FALLBACK_STEPS = [
  ["scope", "Scope"],
  ["inspect", "Inspect"],
  ["implement", "Build"],
  ["validate", "Check"],
  ["debug", "Debug"],
  ["deliver", "Done"],
] as const;

/** Map verbose/legacy step labels to short UI words. */
function shortStepLabel(id: string, label: string): string {
  const supplied = label.trim();
  if (supplied && supplied.length <= 14 && !supplied.includes(" ")) return supplied;
  const byId: Record<string, string> = {
    scope: "Scope",
    inspect: "Inspect",
    implement: "Build",
    validate: "Check",
    debug: "Debug",
    deliver: "Done",
  };
  if (byId[id]) return byId[id];
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return label.slice(0, 12) || "Step";
  // Prefer the first meaningful word for unknown custom steps.
  return words[0]!.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "Step";
}

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = redactChatCredentials(value.trim()).replace(/\s+/g, " ");
  return text.slice(0, 300) || fallback;
}

function stepState(value: unknown): SmartAgentStepState {
  return value === "active" || value === "completed" || value === "paused" ? value : "pending";
}

function makePlan(payload: Record<string, unknown>): SmartAgentTaskState {
  const supplied = Array.isArray(payload.steps) ? payload.steps : [];
  const steps = supplied.length
    ? supplied.map((candidate, index) => {
        const raw = candidate && typeof candidate === "object"
          ? candidate as Record<string, unknown>
          : {};
        const fallback = FALLBACK_STEPS[index] || ["implement", "Build"];
        const id = cleanText(raw.id, fallback[0]).toLowerCase();
        return {
          id,
          label: shortStepLabel(id, cleanText(raw.label, fallback[1])),
          state: stepState(raw.state),
        };
      })
    : FALLBACK_STEPS.map(([id, label], index) => ({
        id,
        label,
        state: index === 0 ? "active" as const : "pending" as const,
      }));
  const activeStep = Math.max(0, Math.min(steps.length - 1, Math.floor(Number(payload.active_step) || 0)));
  return sanitizeSmartAgentTaskState({
    version: 1,
    title: cleanText(payload.title, "Director"),
    summary: cleanText(payload.summary),
    steps,
    activeStep,
    status: payload.status === "completed" || payload.status === "paused" ? payload.status : "working",
    detail: cleanText(payload.detail, "Preparing a focused task plan..."),
    updatedAt: Date.now(),
  }) || {
    version: 1,
    title: "Director",
    summary: "Keeping this task focused and verified.",
    steps: FALLBACK_STEPS.map(([id, label], index) => ({
      id,
      label,
      state: index === 0 ? "active" as const : "pending" as const,
    })),
    activeStep: 0,
    status: "working",
    detail: "Preparing a focused task plan...",
    updatedAt: Date.now(),
  };
}

function updateProgress(
  state: SmartAgentTaskState,
  payload: Record<string, unknown>,
): SmartAgentTaskState {
  const step = Math.max(0, Math.min(state.steps.length - 1, Math.floor(Number(payload.step) || 0)));
  const status = payload.status === "completed" || payload.status === "paused" ? payload.status : "working";
  const completeAll = payload.complete_all === true || status === "completed";
  const nextSteps = state.steps.map((entry, index) => {
    if (completeAll || index < step) return { ...entry, state: "completed" as const };
    if (index === step) {
      return {
        ...entry,
        state: status === "paused" ? "paused" as const : "active" as const,
      };
    }
    return entry.state === "completed" ? entry : { ...entry, state: "pending" as const };
  });
  return {
    ...state,
    steps: nextSteps,
    activeStep: completeAll ? nextSteps.length - 1 : step,
    status,
    detail: cleanText(payload.detail, state.detail),
    updatedAt: Date.now(),
  };
}

function complete(state: SmartAgentTaskState, detail: string): SmartAgentTaskState {
  return {
    ...state,
    steps: state.steps.map((step) => ({ ...step, state: "completed" as const })),
    activeStep: Math.max(0, state.steps.length - 1),
    status: "completed",
    detail,
    updatedAt: Date.now(),
  };
}

function pause(state: SmartAgentTaskState, detail: string): SmartAgentTaskState {
  const current = Math.max(0, Math.min(state.steps.length - 1, state.activeStep));
  return {
    ...state,
    steps: state.steps.map((step, index) => (
      index === current && step.state !== "completed"
        ? { ...step, state: "paused" as const }
        : step
    )),
    status: "paused",
    detail,
    updatedAt: Date.now(),
  };
}

/** Apply only public, bounded task state events to the owning session. */
export function applySmartAgentEvent(session: Session, event: AgentEvent): boolean {
  if (event.kind === "start") {
    // A task ledger belongs to one backend run. Without this reset, an ordinary
    // follow-up keeps showing the previous run's green "Done" state while the
    // new model turn is still thinking or streaming a tool preview.
    const hadState = sanitizeSmartAgentTaskState(session.smartAgent) != null;
    delete session.smartAgent;
    return hadState;
  }
  if (event.kind === "task_plan") {
    session.smartAgent = makePlan(event.payload as Record<string, unknown>);
    return true;
  }
  const current = sanitizeSmartAgentTaskState(session.smartAgent);
  if (!current) return false;
  if (event.kind === "task_progress") {
    session.smartAgent = updateProgress(current, event.payload as Record<string, unknown>);
    return true;
  }
  if (event.kind === "done") {
    session.smartAgent = complete(current, "Task complete and ready to deliver.");
    return true;
  }
  if (event.kind === "cancelled") {
    session.smartAgent = pause(current, "Stopped by the user. Session progress is preserved.");
    return true;
  }
  if (event.kind === "end") {
    const payload = event.payload as Record<string, unknown>;
    const reason = String(payload.reason || "").trim().toLowerCase();
    if (reason === "completed") {
      session.smartAgent = complete(current, "Task complete and ready to deliver.");
    } else if (current.status !== "completed") {
      session.smartAgent = pause(current, "Run stopped before the task was confirmed complete. Session progress is preserved.");
    }
    return true;
  }
  return false;
}

function statusLabel(status: SmartAgentTaskState["status"]): string {
  if (status === "completed") return "Done";
  if (status === "paused") return "Paused";
  return "On";
}

function stepMark(status: SmartAgentStepState): string {
  if (status === "completed") return "✓";
  if (status === "active") return "•";
  if (status === "paused") return "!";
  return "–";
}

type SmartAgentPanelHandlers = {
  onStop?: () => void;
  onReviewChanges?: () => void;
  onOpenMission?: () => void;
};

/** Compact, session-scoped task ledger mounted above the chat transcript. */
export class SmartAgentPanel {
  private currentSessionId: string | null = null;
  private state: SmartAgentTaskState | undefined;

  constructor(
    private readonly node: HTMLElement,
    private readonly handlers: SmartAgentPanelHandlers = {},
  ) {
    this.node.hidden = true;
  }

  setSession(sessionId: string | null, state: SmartAgentTaskState | undefined): void {
    this.currentSessionId = sessionId;
    this.state = sanitizeSmartAgentTaskState(state);
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!this.currentSessionId || !state) {
      this.node.hidden = true;
      clear(this.node);
      return;
    }
    this.node.hidden = false;
    clear(this.node);
    const card = div(`smart-agent-card smart-agent-${state.status}`);
    const head = div("smart-agent-head");
    head.appendChild(el("span", { class: "smart-agent-signal", "aria-hidden": "true" }));
    head.appendChild(el("span", { class: "smart-agent-title" }, [state.title || "Director"]));
    head.appendChild(el("span", { class: `smart-agent-badge ${state.status}`, role: "status" }, [
      statusLabel(state.status),
    ]));
    const completed = state.steps.filter((step) => step.state === "completed").length;
    const percent = state.status === "completed"
      ? 100
      : Math.max(4, Math.round((completed / Math.max(1, state.steps.length)) * 100));
    head.appendChild(el("span", { class: "smart-agent-percent", "aria-label": `${percent}% complete` }, [`${percent}%`]));
    card.appendChild(head);

    const list = el("ol", { class: "smart-agent-steps", "aria-label": "Task progress" });
    for (const step of state.steps) {
      const item = el("li", {
        class: `smart-agent-step ${step.state}`,
        title: step.label,
      });
      item.appendChild(el("span", { class: "smart-agent-step-mark", "aria-hidden": "true" }, [stepMark(step.state)]));
      item.appendChild(el("span", { class: "smart-agent-step-label" }, [
        shortStepLabel(step.id, step.label),
      ]));
      list.appendChild(item);
    }
    card.appendChild(list);

    const lower = div("smart-agent-lower");
    const detail = el("div", { class: "smart-agent-detail" });
    detail.append(
      el("span", { class: "smart-agent-detail-label" }, [state.status === "working" ? "NOW" : "STATUS"]),
      el("span", { class: "smart-agent-detail-text", title: state.detail }, [state.detail || state.summary || "Mission progress is being recorded."]),
    );
    const actions = el("div", { class: "smart-agent-actions" });
    if (this.handlers.onReviewChanges) {
      const review = el("button", { type: "button", title: "Open Time Machine", "aria-label": "Open Time Machine", html: icon("planList", 13) });
      review.addEventListener("click", this.handlers.onReviewChanges);
      actions.appendChild(review);
    }
    if (this.handlers.onOpenMission) {
      const mission = el("button", { type: "button", title: "Open Mission Control", "aria-label": "Open Mission Control", html: icon("spark", 13) });
      mission.addEventListener("click", this.handlers.onOpenMission);
      actions.appendChild(mission);
    }
    if (state.status === "working" && this.handlers.onStop) {
      const stop = el("button", { class: "danger", type: "button", title: "Stop mission", "aria-label": "Stop mission", html: icon("stop", 12) });
      stop.addEventListener("click", this.handlers.onStop);
      actions.appendChild(stop);
    }
    lower.append(detail, actions);
    card.appendChild(lower);
    const progress = el("div", { class: "smart-agent-progress", "aria-hidden": "true" });
    progress.appendChild(el("span", { style: `width:${percent}%` }));
    card.appendChild(progress);
    this.node.appendChild(card);
  }
}
