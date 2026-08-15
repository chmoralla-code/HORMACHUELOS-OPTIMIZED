import type { AgentExecutionProfile } from "../ipc";
import { icon } from "./icons";
import { redactChatCredentials } from "./session";
import { clear, el } from "./util";

const STORAGE_KEY = "ai-forge:client-success-center:v1";
const FIELD_LIMIT = 1_200;

export type OutcomeBrief = {
  goal: string;
  audience: string;
  nonNegotiables: string;
  done: string;
  updatedAt: number;
};

export type MissionDepth = "focused" | "balanced" | "maximum";
export type MissionApprovalPolicy = "risk_gates" | "every_change" | "project_autonomous";

export type MissionPolicy = {
  depth: MissionDepth;
  approvalPolicy: MissionApprovalPolicy;
  allowProjectEdits: boolean;
  allowCommands: boolean;
  allowPreviewComputerUse: boolean;
};

export type DeliveryChecklist = {
  brief: boolean;
  build: boolean;
  qa: boolean;
  handoff: boolean;
};

export type ProjectSuccessState = {
  version: 2;
  brief: OutcomeBrief;
  mission: MissionPolicy;
  checklist: DeliveryChecklist;
  updatedAt: number;
};

export type ClientSuccessDispatch =
  | "sent"
  | "queued"
  | "needs_project"
  | "usage_exhausted"
  | "stopping";

export type ClientPackExportResult = {
  zipPath: string;
  filesCount: number;
};

type RecipeId = "blueprint" | "build" | "qa" | "handoff";
type OperationId = "mission" | RecipeId;

export type MissionRunRequest = {
  id: OperationId;
  prompt: string;
  visibleText: string;
  titleHint: string;
  requestedMode: "adaptive" | "plan" | "build";
  executionProfile: AgentExecutionProfile;
  enableComputerUse: boolean;
};

type ClientSuccessHandlers = {
  getProjectPath: () => string | null;
  onRunRecipe: (request: MissionRunRequest) => ClientSuccessDispatch | Promise<ClientSuccessDispatch>;
  onExportClientPack: (handoffSummary: string) => Promise<ClientPackExportResult | null>;
};

type MissionInputs = {
  goal: HTMLTextAreaElement;
  audience: HTMLInputElement;
  nonNegotiables: HTMLTextAreaElement;
  done: HTMLTextAreaElement;
  depth: HTMLSelectElement;
  approvalPolicy: HTMLSelectElement;
  allowProjectEdits: HTMLInputElement;
  allowCommands: HTMLInputElement;
  allowPreviewComputerUse: HTMLInputElement;
};

const recipeDetails: Record<RecipeId, { title: string; eyebrow: string; description: string; iconName: "planList" | "spark" | "bug" | "export"; checklist: keyof DeliveryChecklist }> = {
  blueprint: {
    title: "Blueprint",
    eyebrow: "Clarify scope",
    description: "Inspect the project and produce a practical build plan, risks, and acceptance checks before implementation.",
    iconName: "planList",
    checklist: "brief",
  },
  build: {
    title: "Build & prove",
    eyebrow: "Ship with evidence",
    description: "Implement the outcome, run the right checks, and keep working until the result can be demonstrated.",
    iconName: "spark",
    checklist: "build",
  },
  qa: {
    title: "Test & Fix Everything",
    eyebrow: "Closed quality loop",
    description: "Discover the real checks, exercise the primary UI, repair failures, and retest until verified or genuinely blocked.",
    iconName: "bug",
    checklist: "qa",
  },
  handoff: {
    title: "Client handoff",
    eyebrow: "Ready to deliver",
    description: "Prepare concise launch notes, setup instructions, and a client-safe project package without secrets.",
    iconName: "export",
    checklist: "handoff",
  },
};

function projectKey(path: string): string {
  return String(path || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function projectName(path: string): string {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || "Current project";
}

function cleanText(value: unknown, max = FIELD_LIMIT): string {
  return redactChatCredentials(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function normalizeDepth(value: unknown): MissionDepth {
  return value === "focused" || value === "maximum" ? value : "balanced";
}

function normalizeApprovalPolicy(value: unknown): MissionApprovalPolicy {
  return value === "every_change" || value === "project_autonomous" ? value : "risk_gates";
}

function emptyState(): ProjectSuccessState {
  return {
    version: 2,
    brief: { goal: "", audience: "", nonNegotiables: "", done: "", updatedAt: 0 },
    mission: {
      depth: "balanced",
      approvalPolicy: "risk_gates",
      allowProjectEdits: true,
      allowCommands: true,
      allowPreviewComputerUse: true,
    },
    checklist: { brief: false, build: false, qa: false, handoff: false },
    updatedAt: 0,
  };
}

function normalizeState(value: unknown): ProjectSuccessState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawBrief = raw.brief && typeof raw.brief === "object" ? raw.brief as Partial<OutcomeBrief> : {};
  const rawMission = raw.mission && typeof raw.mission === "object"
    ? raw.mission as Partial<MissionPolicy>
    : {};
  const rawChecklist = raw.checklist && typeof raw.checklist === "object"
    ? raw.checklist as Partial<DeliveryChecklist>
    : {};
  const goal = cleanText(rawBrief.goal);
  return {
    version: 2,
    brief: {
      goal,
      audience: cleanText(rawBrief.audience, 280),
      nonNegotiables: cleanText(rawBrief.nonNegotiables),
      done: cleanText(rawBrief.done),
      updatedAt: Math.max(0, Number(rawBrief.updatedAt) || 0),
    },
    mission: {
      depth: normalizeDepth(rawMission.depth),
      approvalPolicy: normalizeApprovalPolicy(rawMission.approvalPolicy),
      allowProjectEdits: rawMission.allowProjectEdits !== false,
      allowCommands: rawMission.allowCommands !== false,
      allowPreviewComputerUse: rawMission.allowPreviewComputerUse !== false,
    },
    checklist: {
      brief: Boolean(rawChecklist.brief) || Boolean(goal),
      build: Boolean(rawChecklist.build),
      qa: Boolean(rawChecklist.qa),
      handoff: Boolean(rawChecklist.handoff),
    },
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

function readStore(): Record<string, ProjectSuccessState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, normalizeState(value)]),
    );
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ProjectSuccessState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Project context is an enhancement. The active run still works if storage is unavailable.
  }
}

export function loadProjectSuccessState(path: string): ProjectSuccessState {
  const key = projectKey(path);
  if (!key) return emptyState();
  return normalizeState(readStore()[key]);
}

export function saveProjectSuccessState(path: string, next: ProjectSuccessState): ProjectSuccessState {
  const key = projectKey(path);
  const normalized = normalizeState({ ...next, updatedAt: Date.now() });
  if (!key) return normalized;
  const store = readStore();
  store[key] = normalized;
  writeStore(store);
  return normalized;
}

function approvalInstruction(policy: MissionApprovalPolicy): string {
  if (policy === "every_change") {
    return "Ask before project edits or commands; group related approvals so progress remains understandable.";
  }
  if (policy === "project_autonomous") {
    return "Proceed inside the active project, but ask before destructive, credential, payment, deployment, or external-account actions.";
  }
  return "Proceed with reversible project work; ask before destructive, external, credential, payment, deployment, or other high-impact actions.";
}

function depthInstruction(depth: MissionDepth): string {
  if (depth === "focused") return "Focused — smallest credible change and the most relevant validation.";
  if (depth === "maximum") return "Maximum — broad inspection, edge cases, and strongest practical verification without invented evidence.";
  return "Balanced — enough context to work safely, then focused implementation and verification.";
}

function missionPolicyFacts(mission: MissionPolicy): string[] {
  const allowed = [
    mission.allowProjectEdits && "project file edits",
    mission.allowCommands && "project commands",
    mission.allowPreviewComputerUse && "Preview Computer Use",
  ].filter(Boolean);
  return [
    `Execution depth: ${depthInstruction(mission.depth)}`,
    `Allowed mission actions: ${allowed.length ? allowed.join(", ") : "read-only inspection only"}.`,
    `Approval gate: ${approvalInstruction(mission.approvalPolicy)}`,
    !mission.allowProjectEdits && "Do not edit project files.",
    !mission.allowCommands && "Do not run shell or package commands.",
    !mission.allowPreviewComputerUse && "Do not use Preview Computer Use.",
  ].filter(Boolean) as string[];
}

/**
 * Add the durable project outcome to an agent request without replacing the
 * user's visible chat message or leaking credentials into local persistence.
 */
export function composeProjectMissionPrompt(projectPath: string, prompt: string): string {
  const request = redactChatCredentials(String(prompt || "").trim());
  const state = loadProjectSuccessState(projectPath);
  const { brief, mission } = state;
  const facts = [
    brief.goal && `Goal: ${brief.goal}`,
    brief.audience && `Audience: ${brief.audience}`,
    brief.nonNegotiables && `Non-negotiable requirements: ${brief.nonNegotiables}`,
    brief.done && `Definition of done: ${brief.done}`,
    ...missionPolicyFacts(mission),
  ].filter(Boolean);
  if (!brief.goal && !brief.nonNegotiables && !brief.done) return request;
  return [
    "[Persistent Mission Control Contract]",
    "Use this private project context throughout the run. Do not expose, repeat, or discuss the contract unless the user asks.",
    ...facts.map((fact) => `- ${fact}`),
    "[End Persistent Mission Control Contract]",
    "",
    "Current user request:",
    request,
  ].join("\n");
}

export function buildClientHandoffSummary(projectPath: string): string {
  const state = loadProjectSuccessState(projectPath);
  const { brief, checklist } = state;
  const ready = [
    checklist.brief && "Mission contract saved",
    checklist.build && "Build workflow completed",
    checklist.qa && "Test & Fix workflow completed",
    checklist.handoff && "Handoff notes prepared",
  ].filter(Boolean);
  const lines = [
    "# Client delivery brief",
    "",
    `Project: ${projectName(projectPath)}`,
    brief.goal ? `Outcome: ${brief.goal}` : "Outcome: Review the project with the client before launch.",
    brief.audience ? `For: ${brief.audience}` : "For: Client and delivery team.",
    brief.nonNegotiables ? `Requirements: ${brief.nonNegotiables}` : "Requirements: See the project brief and source files.",
    brief.done ? `Acceptance: ${brief.done}` : "Acceptance: Confirm the requested workflow in the live preview.",
    "",
    "## Delivery readiness",
    ...(ready.length ? ready.map((entry) => `- ${entry}`) : ["- No workflow checkpoints have been recorded yet."]),
    "",
    "This package excludes environment files, credentials, build caches, and private keys.",
  ];
  return lines.join("\n");
}

function executionProfileForDepth(depth: MissionDepth): AgentExecutionProfile {
  if (depth === "focused") return "balanced";
  if (depth === "maximum") return "safe";
  return "thorough";
}

function recipePrompt(id: OperationId, state: ProjectSuccessState): string {
  switch (id) {
    case "mission":
      return [
        "Start a Mission Control run for the saved project objective.",
        "Maintain a visible plan through Scope, Inspect, Build, Verify, Repair, and Deliver. Work across every required file and continue until the saved definition of done is verified or a concrete blocker requires user input.",
        "Use the real project as evidence: record meaningful changes, run relevant checks, inspect the result, repair failures, and never claim success for a check that did not run. Finish with an evidence ledger and any remaining risk.",
      ].join("\n");
    case "blueprint":
      return [
        "Run the Mission Control Blueprint workflow for this project.",
        "Inspect the existing implementation first. Produce a short plan with affected files, dependencies, risks, validation steps, and measurable acceptance criteria tied to the saved definition of done.",
        "Do not make project changes in this workflow. Ask one focused question only when missing information would materially change the plan.",
      ].join("\n");
    case "build":
      return [
        "Run the Build & Prove workflow for this project.",
        "Inspect the current implementation, carry the requested outcome through to working code, and keep going across all required files. Use tools rather than merely describing the next step.",
        "Run the most relevant checks or preview verification before completion. Repair failures you can safely fix, preserve existing behavior, and finish with concise evidence of what works.",
      ].join("\n");
    case "qa":
      return [
        "Run Test & Fix Everything for this project as a closed-loop quality mission.",
        "Inspect the repository and discover its actual package scripts, test framework, type checker, linter, build command, runtime entry points, and primary user journeys. Create a concise test matrix before changing code.",
        "Run every relevant existing check that is safe locally. For UI projects, start or reuse the real preview and exercise the primary journey at desktop and narrow/mobile widths, including loading, empty, error, keyboard-focus, overflow, contrast, and responsive states when applicable.",
        "When a check fails, identify the root cause, make the smallest safe repair, and rerun the failed check plus nearby regression checks. Repeat inspect → test → fix → retest until important paths pass or a real blocker cannot be resolved locally.",
        "Never fabricate a pass, screenshot, command result, or coverage claim. Label every check Passed, Fixed then passed, Blocked, or Not applicable, and end with exact evidence and remaining risks.",
        state.mission.allowPreviewComputerUse
          ? "Use Preview Computer Use for this run, limited to the active project preview."
          : "Preview Computer Use is disabled by the mission contract; report visual verification as blocked when non-interactive checks cannot replace it.",
      ].join("\n");
    case "handoff":
      return [
        "Run the Client Handoff workflow for this project.",
        "Prepare the project for a non-technical client: concise README or launch notes, setup/run steps, what was verified, known limits, and a short change summary. Never include secrets, API keys, local machine paths, or generated build caches.",
        "Use the client-pack export tool when the project is ready, and report the delivered files and any client action still required.",
      ].join("\n");
  }
}

function operationRequest(id: OperationId, state: ProjectSuccessState): MissionRunRequest {
  const title = id === "mission" ? "Mission" : recipeDetails[id].title;
  return {
    id,
    prompt: recipePrompt(id, state),
    visibleText: id === "mission" ? `Start Mission: ${state.brief.goal}` : `Run ${title}`,
    titleHint: id === "qa" ? "Test & Fix Everything" : `${title} — ${state.brief.goal || "current project"}`,
    requestedMode: id === "blueprint" ? "plan" : id === "qa" ? "build" : "adaptive",
    executionProfile: id === "qa" ? "safe" : executionProfileForDepth(state.mission.depth),
    enableComputerUse: id === "qa" && state.mission.allowPreviewComputerUse,
  };
}

function dispatchMessage(result: ClientSuccessDispatch, id: OperationId): string {
  const label = id === "mission" ? "Mission" : recipeDetails[id].title;
  switch (result) {
    case "queued":
      return `${label} queued behind the current run. It will start automatically.`;
    case "sent":
      return `${label} launched with the saved mission contract.`;
    case "usage_exhausted":
      return `${label} could not start because the current plan has reached its usage limit.`;
    case "stopping":
      return "The current run is stopping. Start this workflow once it is ready.";
    case "needs_project":
      return "Open a project before starting a workflow.";
  }
}

export class ClientSuccessCenter {
  private projectPath: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private status = "";

  constructor(
    private root: HTMLElement,
    private handlers: ClientSuccessHandlers,
  ) {}

  open(): void {
    const path = this.handlers.getProjectPath();
    if (!path) return;
    this.projectPath = path;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.status = "";
    this.render();
  }

  close(): void {
    clear(this.root);
    this.projectPath = null;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private saveBrief(state: ProjectSuccessState, inputs: MissionInputs): ProjectSuccessState {
    if (!this.projectPath) return state;
    const goal = cleanText(inputs.goal.value);
    const next = saveProjectSuccessState(this.projectPath, {
      ...state,
      brief: {
        goal,
        audience: cleanText(inputs.audience.value, 280),
        nonNegotiables: cleanText(inputs.nonNegotiables.value),
        done: cleanText(inputs.done.value),
        updatedAt: Date.now(),
      },
      mission: {
        depth: normalizeDepth(inputs.depth.value),
        approvalPolicy: normalizeApprovalPolicy(inputs.approvalPolicy.value),
        allowProjectEdits: inputs.allowProjectEdits.checked,
        allowCommands: inputs.allowCommands.checked,
        allowPreviewComputerUse: inputs.allowPreviewComputerUse.checked,
      },
      checklist: { ...state.checklist, brief: Boolean(goal) },
    });
    return next;
  }

  private async startRecipe(id: OperationId, state: ProjectSuccessState, inputs: MissionInputs): Promise<void> {
    const saved = this.saveBrief(state, inputs);
    if (id === "mission" && !saved.brief.goal) {
      this.status = "Add a clear mission objective before launch.";
      this.render();
      window.setTimeout(() => document.getElementById("client-success-goal")?.focus({ preventScroll: true }), 0);
      return;
    }
    const result = await this.handlers.onRunRecipe(operationRequest(id, saved));
    this.status = dispatchMessage(result, id);
    this.render();
    if (result === "sent") window.setTimeout(() => this.projectPath && this.close(), 500);
  }

  private async exportPack(state: ProjectSuccessState, inputs: MissionInputs): Promise<void> {
    const saved = this.saveBrief(state, inputs);
    if (!this.projectPath) return;
    this.status = "Creating a client-safe delivery package…";
    this.render();
    try {
      const result = await this.handlers.onExportClientPack(buildClientHandoffSummary(this.projectPath));
      if (!result) {
        this.status = "Client pack was not created because no active project is available.";
      } else {
        saveProjectSuccessState(this.projectPath, {
          ...saved,
          checklist: { ...saved.checklist, handoff: true },
        });
        this.status = `Client pack saved: ${result.zipPath} (${result.filesCount} files).`;
      }
    } catch (error) {
      this.status = `Client pack failed: ${String(error)}`;
    }
    this.render();
  }

  private render(): void {
    const path = this.projectPath;
    if (!path) return;
    const state = loadProjectSuccessState(path);
    clear(this.root);

    const overlay = el("div", { class: "modal-overlay client-success-overlay" });
    const modal = el("section", {
      class: "modal client-success-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "client-success-title",
      tabindex: "-1",
      "data-client-success-center": "true",
      "data-mission-control": "true",
    });

    const head = el("header", { class: "client-success-head" });
    const headCopy = el("div", { class: "client-success-title-wrap" });
    headCopy.append(
      el("div", { class: "client-success-eyebrow" }, ["ADAPTIVE DIRECTOR · MISSION DOSSIER"]),
      el("h2", { class: "client-success-title", id: "client-success-title" }, ["Mission Control"]),
      el("p", { class: "client-success-subtitle" }, ["Give the Director one durable objective, explicit boundaries, and a measurable finish line—then watch it plan, build, verify, repair, and deliver."]),
    );
    const closeButton = el("button", {
      class: "client-success-close",
      type: "button",
      "aria-label": "Close Mission Control",
      html: icon("close", 17),
    }) as HTMLButtonElement;
    closeButton.addEventListener("click", () => this.close());
    head.append(headCopy, closeButton);
    modal.appendChild(head);

    const body = el("div", { class: "client-success-body" });
    const projectStrip = el("div", { class: "client-success-project" });
    const projectState = el("span", { class: "client-success-project-state" }, [state.brief.goal ? "CONTRACT READY" : "OBJECTIVE NEEDED"]);
    projectStrip.append(
      el("span", { class: "client-success-project-mark", html: icon("folder", 15) }),
      el("span", { class: "client-success-project-label" }, ["Mission target"]),
      el("strong", { class: "client-success-project-name" }, [projectName(path)]),
      projectState,
    );
    body.appendChild(projectStrip);

    const completed = Object.values(state.checklist).filter(Boolean).length;
    const readiness = el("section", { class: "client-success-readiness", "aria-label": "Delivery readiness" });
    const readinessHead = el("div", { class: "client-success-section-head" });
    readinessHead.append(
      el("div", {}, [
        el("div", { class: "client-success-kicker" }, ["EVIDENCE GATES"]),
        el("h3", { class: "client-success-section-title" }, [`${completed}/4 delivery signals recorded`]),
      ]),
      el("span", { class: "client-success-score", "data-readiness-score": String(completed) }, [`${Math.round((completed / 4) * 100)}%`]),
    );
    readiness.appendChild(readinessHead);
    const meters = el("div", { class: "client-success-meters" });
    const labels: Record<keyof DeliveryChecklist, string> = {
      brief: "Contract",
      build: "Built",
      qa: "Verified",
      handoff: "Delivered",
    };
    (Object.keys(labels) as (keyof DeliveryChecklist)[]).forEach((key) => {
      const item = el("button", {
        class: `client-success-meter${state.checklist[key] ? " is-ready" : ""}`,
        type: "button",
        "aria-pressed": String(state.checklist[key]),
        "data-readiness-item": key,
      });
      item.append(
        el("span", { class: "client-success-meter-dot", "aria-hidden": "true" }),
        el("span", {}, [labels[key]]),
      );
      item.addEventListener("click", () => {
        if (!this.projectPath) return;
        saveProjectSuccessState(this.projectPath, {
          ...state,
          checklist: { ...state.checklist, [key]: !state.checklist[key] },
        });
        this.status = `${labels[key]} marked ${state.checklist[key] ? "not ready" : "ready"}.`;
        this.render();
      });
      meters.appendChild(item);
    });
    readiness.appendChild(meters);
    body.appendChild(readiness);

    const briefSection = el("section", { class: "client-success-brief", "aria-labelledby": "client-success-brief-title" });
    briefSection.append(
      el("div", { class: "client-success-section-head compact" }, [
        el("div", {}, [
          el("div", { class: "client-success-kicker" }, ["MISSION CONTRACT"]),
          el("h3", { class: "client-success-section-title", id: "client-success-brief-title" }, ["Define the outcome and finish line"]),
        ]),
        el("p", { class: "client-success-section-note" }, ["Saved privately per project and added to each run as hidden context."]),
      ]),
    );
    const form = el("div", { class: "client-success-form" });
    const goal = el("textarea", {
      class: "client-success-field client-success-goal",
      id: "client-success-goal",
      placeholder: "Objective: what must be true when this mission is complete?",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "goal",
    }) as HTMLTextAreaElement;
    goal.value = state.brief.goal;
    const audience = el("input", {
      class: "client-success-field",
      id: "client-success-audience",
      type: "text",
      placeholder: "Who is this for? e.g. restaurant customers on mobile",
      maxlength: "280",
      "data-client-brief": "audience",
    }) as HTMLInputElement;
    audience.value = state.brief.audience;
    const nonNegotiables = el("textarea", {
      class: "client-success-field",
      id: "client-success-requirements",
      placeholder: "Constraints: brand, stack, security, scope, deadline, behavior to preserve",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "requirements",
    }) as HTMLTextAreaElement;
    nonNegotiables.value = state.brief.nonNegotiables;
    const done = el("textarea", {
      class: "client-success-field",
      id: "client-success-done",
      placeholder: "Observable acceptance checks and proof required",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "done",
    }) as HTMLTextAreaElement;
    done.value = state.brief.done;
    const fields = [
      ["Mission objective", goal],
      ["Audience", audience],
      ["Non-negotiables", nonNegotiables],
      ["Definition of done", done],
    ] as const;
    for (const [label, field] of fields) {
      const labelNode = el("label", { class: "client-success-field-wrap", for: field.id });
      labelNode.append(el("span", { class: "client-success-field-label" }, [label]), field);
      form.appendChild(labelNode);
    }
    briefSection.appendChild(form);

    const depth = el("select", {
      class: "client-success-field client-success-select",
      id: "mission-depth",
      "data-mission-depth": "true",
    }) as HTMLSelectElement;
    [
      ["focused", "Focused · smallest credible path"],
      ["balanced", "Balanced · thorough where it matters"],
      ["maximum", "Maximum · broad verification + safe snapshots"],
    ].forEach(([value, label]) => depth.appendChild(el("option", { value }, [label])));
    depth.value = state.mission.depth;

    const approvalPolicy = el("select", {
      class: "client-success-field client-success-select",
      id: "mission-approval",
      "data-mission-approval": "true",
    }) as HTMLSelectElement;
    [
      ["risk_gates", "Risk gates · ask before high-impact work"],
      ["every_change", "Review gates · ask before edits and commands"],
      ["project_autonomous", "Project-autonomous · stop at external boundaries"],
    ].forEach(([value, label]) => approvalPolicy.appendChild(el("option", { value }, [label])));
    approvalPolicy.value = state.mission.approvalPolicy;

    const policyGrid = el("div", { class: "client-success-policy-grid" });
    const depthWrap = el("label", { class: "client-success-policy-control", for: depth.id });
    depthWrap.append(
      el("span", { class: "client-success-field-label" }, ["Execution depth"]),
      depth,
      el("span", { class: "client-success-field-hint" }, ["Controls inspection and verification intensity."]),
    );
    const approvalWrap = el("label", { class: "client-success-policy-control", for: approvalPolicy.id });
    approvalWrap.append(
      el("span", { class: "client-success-field-label" }, ["Approval policy"]),
      approvalPolicy,
      el("span", { class: "client-success-field-hint" }, ["Destructive and external actions always remain gated."]),
    );
    policyGrid.append(depthWrap, approvalWrap);

    const permissions = el("fieldset", { class: "client-success-permissions" });
    permissions.appendChild(el("legend", {}, ["Allowed mission actions"]));
    const allowProjectEdits = el("input", { type: "checkbox", "data-mission-permission": "project-edits" }) as HTMLInputElement;
    const allowCommands = el("input", { type: "checkbox", "data-mission-permission": "commands" }) as HTMLInputElement;
    const allowPreviewComputerUse = el("input", { type: "checkbox", "data-mission-permission": "preview-computer-use" }) as HTMLInputElement;
    allowProjectEdits.checked = state.mission.allowProjectEdits;
    allowCommands.checked = state.mission.allowCommands;
    allowPreviewComputerUse.checked = state.mission.allowPreviewComputerUse;
    const permissionRows: Array<[HTMLInputElement, string, string]> = [
      [allowProjectEdits, "Edit project files", "Required for Build and repair loops"],
      [allowCommands, "Run project commands", "Tests, type checks, builds, and local servers"],
      [allowPreviewComputerUse, "Use Preview Computer Use", "Only inside this project’s active preview"],
    ];
    for (const [input, label, note] of permissionRows) {
      const row = el("label", { class: "client-success-permission" });
      row.append(
        input,
        el("span", { class: "client-success-permission-check", "aria-hidden": "true", html: icon("check", 12) }),
        el("span", {}, [el("strong", {}, [label]), el("small", {}, [note])]),
      );
      permissions.appendChild(row);
    }
    policyGrid.appendChild(permissions);
    briefSection.appendChild(policyGrid);

    const inputs: MissionInputs = {
      goal,
      audience,
      nonNegotiables,
      done,
      depth,
      approvalPolicy,
      allowProjectEdits,
      allowCommands,
      allowPreviewComputerUse,
    };
    const briefActions = el("div", { class: "client-success-brief-actions" });
    const saveBrief = el("button", { class: "btn client-success-save", type: "button", "data-client-success-save": "true" }, ["Save mission contract"]);
    saveBrief.addEventListener("click", () => {
      this.saveBrief(state, inputs);
      this.status = "Mission contract saved. Future project runs will inherit it automatically.";
      this.render();
    });
    briefActions.append(
      el("span", { class: "client-success-field-hint" }, ["Credentials are redacted before local storage and model dispatch."]),
      saveBrief,
    );
    briefSection.appendChild(briefActions);
    body.appendChild(briefSection);

    const launch = el("section", { class: "client-success-launch", "aria-labelledby": "mission-launch-title" });
    const launchCopy = el("div", { class: "client-success-launch-copy" });
    const launchTitle = el("h3", { class: "client-success-launch-title", id: "mission-launch-title" }, [state.brief.goal || "Objective required before launch"]);
    launchCopy.append(
      el("div", { class: "client-success-kicker" }, ["PRIMARY CONTROL"]),
      launchTitle,
      el("p", { class: "client-success-launch-note" }, ["Adaptive Director chooses the right work pattern per phase. Mutating runs receive durable Time Machine coverage."]),
    );
    const launchActions = el("div", { class: "client-success-launch-actions" });
    const testFix = el("button", { class: "client-success-test-fix", type: "button", "data-start-test-fix": "true" });
    testFix.append(el("span", { html: icon("bug", 16) }), document.createTextNode("Test & Fix Everything"));
    testFix.addEventListener("click", () => void this.startRecipe("qa", state, inputs));
    const startMission = el("button", { class: "client-success-start", type: "button", "data-start-mission": "true" });
    startMission.append(el("span", { html: icon("spark", 17) }), document.createTextNode("Start Mission"));
    startMission.addEventListener("click", () => void this.startRecipe("mission", state, inputs));
    launchActions.append(testFix, startMission);
    launch.append(launchCopy, launchActions);
    body.insertBefore(launch, readiness);
    goal.addEventListener("input", () => {
      const value = cleanText(goal.value, 240);
      launchTitle.textContent = value || "Objective required before launch";
      projectState.textContent = value ? "CONTRACT READY" : "OBJECTIVE NEEDED";
    });

    const workflows = el("section", { class: "client-success-workflows", "aria-labelledby": "client-success-workflows-title" });
    workflows.appendChild(el("div", { class: "client-success-section-head compact" }, [
      el("div", {}, [
        el("div", { class: "client-success-kicker" }, ["SPECIALIZED RUNS"]),
        el("h3", { class: "client-success-section-title", id: "client-success-workflows-title" }, ["Launch one controlled phase"]),
      ]),
      el("p", { class: "client-success-section-note" }, ["Selected model, normal queue, mission contract, and rollback policy stay intact."]),
    ]));
    const workflowGrid = el("div", { class: "client-success-workflow-grid" });
    (Object.keys(recipeDetails) as RecipeId[]).forEach((id) => {
      const recipe = recipeDetails[id];
      const card = el("article", { class: `client-success-workflow${id === "qa" ? " featured" : ""}`, "data-client-workflow": id });
      const cardTop = el("div", { class: "client-success-workflow-top" });
      cardTop.append(
        el("span", { class: "client-success-workflow-icon", html: icon(recipe.iconName, 16) }),
        el("span", { class: "client-success-workflow-eyebrow" }, [recipe.eyebrow]),
      );
      const run = el("button", {
        class: "client-success-workflow-run",
        type: "button",
        "data-run-workflow": id,
      }, [id === "qa" ? "Run safe quality loop" : "Run phase"]);
      run.addEventListener("click", () => void this.startRecipe(id, state, inputs));
      card.append(
        cardTop,
        el("h4", { class: "client-success-workflow-title" }, [recipe.title]),
        el("p", { class: "client-success-workflow-copy" }, [recipe.description]),
        run,
      );
      workflowGrid.appendChild(card);
    });
    workflows.appendChild(workflowGrid);
    body.appendChild(workflows);

    const handoff = el("section", { class: "client-success-handoff", "aria-labelledby": "client-success-handoff-title" });
    const handoffCopy = el("div", { class: "client-success-handoff-copy" });
    handoffCopy.append(
      el("div", { class: "client-success-kicker" }, ["CLIENT-READY DELIVERY"]),
      el("h3", { class: "client-success-section-title", id: "client-success-handoff-title" }, ["Create a safe client pack"]),
      el("p", { class: "client-success-handoff-note" }, ["Includes a tailored delivery brief and excludes environment files, credentials, private keys, and build caches."]),
    );
    const packButton = el("button", {
      class: "btn client-success-pack",
      type: "button",
      "data-export-client-pack": "true",
    });
    packButton.append(el("span", { html: icon("export", 15) }), document.createTextNode("Create client pack"));
    packButton.addEventListener("click", () => void this.exportPack(state, inputs));
    handoff.append(handoffCopy, packButton);
    body.appendChild(handoff);

    if (this.status) {
      body.appendChild(el("p", { class: "client-success-status", role: "status", "data-client-success-status": "true" }, [this.status]));
    }
    modal.appendChild(body);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    this.root.appendChild(overlay);
    overlay.style.pointerEvents = "auto";
    window.setTimeout(() => goal.focus({ preventScroll: true }), 0);
  }
}
