import { api, type Settings } from "../ipc";
import { PROVIDERS, effortOptionsForProvider, displayModelName, getProviderMeta, getSettingsSafe, hasStaticModelCatalog, isHostedCatalogRestricted, isUltraEffort, mergeProviderModelCatalog, normalizeEffortForProvider, refreshHostedProviderCatalog, uiProviderId, usesReasoningEffort, visibleProviders } from "./settings";
import { clear, el, escapeHtml } from "./util";
import { icon, icons } from "./icons";

export type PermissionMode = "plan" | "auto" | "ask" | "full" | "multi_agent";

/** Agent permission modes (OpenCode-style chip labels). */
const MODES: {
  id: PermissionMode;
  chip: string;
  label: string;
  title: string;
  capability: string;
}[] = [
  {
    id: "plan",
    chip: "plan",
    label: "Plan",
    title:
      "Plan — refine request, suggest options, numbered plan; wait for Apply before any file changes.",
    capability: "Thinking",
  },
  {
    id: "auto",
    chip: "build",
    label: "Auto",
    title:
      "Auto — build with defaults; high-risk actions still need Approve.",
    capability: "Agent",
  },
  {
    id: "ask",
    chip: "ask",
    label: "Ask",
    title:
      "Ask — maximum answer reliability with evidence; reads free, writes need Approve.",
    capability: "Answer Max",
  },
  {
    id: "full",
    chip: "ship",
    label: "Full",
    title: "Full — maximum autonomy, no approval prompts.",
    capability: "Autonomous",
  },
  {
    id: "multi_agent",
    chip: "🌈 Multi-Agent",
    label: "Multi-Agent",
    title:
      "Multi-Agent — Ship-level permission; independent workspace checks run together.",
    capability: "Autonomous",
  },
];

/** Capability labels per mode (what the agent is allowed to do). */
const CAPABILITIES: Record<
  PermissionMode,
  { id: string; label: string; title: string }[]
> = {
  plan: [
    { id: "thinking", label: "Thinking", title: "Plan first, then ask before tools" },
    { id: "guided", label: "Guided", title: "Step-by-step with approvals" },
  ],
  auto: [
    { id: "agent", label: "Agent", title: "Tools on by default; high-risk asks" },
    { id: "balanced", label: "Balanced", title: "Build with smart defaults" },
  ],
  ask: [
    {
      id: "answer_max",
      label: "Answer Max",
      title: "Reliable, complete answers with evidence and automatic recovery",
    },
    {
      id: "investigate",
      label: "Investigate",
      title: "Deep multi-file dig — tools-heavy reads",
    },
    {
      id: "brief",
      label: "Brief",
      title: "Short answer with key paths; fewer tool loops",
    },
  ],
  full: [
    { id: "autonomous", label: "Autonomous", title: "Full tools, no prompts" },
    { id: "max", label: "Max", title: "Maximum autonomy" },
  ],
  multi_agent: [
    { id: "autonomous", label: "Autonomous", title: "Full tools with parallel discovery" },
    { id: "max", label: "Max", title: "Maximum autonomy with parallel discovery" },
  ],
};

/** OpenCode-style dock: mode / model / capability chips for the composer toolbar. */
export class ModelBar {
  node: HTMLElement;
  settings!: Settings;
  private onChange: () => void;
  private statusEl: HTMLElement | null = null;
  /** Mounted into composer toolbar (chips + menus). */
  providerRail: HTMLElement;
  private onProviderChange: (() => void) | null = null;
  private capabilityId = "thinking";
  private openMenu: HTMLElement | null = null;
  private outsideClose: ((e: MouseEvent) => void) | null = null;
  private providerSelectionGeneration = 0;
  /** Full model catalogs per provider (auto-fetched when key/connection is ready). */
  private discoveredModels: Record<string, string[]> = {};
  /** Provider ids supplied by the most recent hosted alias catalog. */
  private hostedCatalogProviderIds = new Set<string>();
  /**
   * The model that actually owns the visible in-flight run. Keeping this
   * separate from global Settings lets a user work in another session without
   * making a busy session look like it changed providers halfway through.
   */
  private activeRunProfile: { provider: string; model: string; effort?: string } | null = null;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    // Keep a lightweight host; real UI lives in providerRail inside the composer
    this.node = el("div", { class: "dock-toolbar dock-toolbar-hidden", "aria-hidden": "true" });
    this.providerRail = el("div", {
      class: "composer-chips",
      role: "toolbar",
      "aria-label": "Chat controls",
    });
  }

  async load() {
    await this.refreshHostedModelCatalog();
    this.settings = await getSettingsSafe();
    this.normalizeMode();
    this.syncCapabilityDefault();
    this.render();
    this.renderProviderRail();
    void this.ensureModelsLoaded(this.settings.provider);
  }

  async refresh() {
    try {
      await this.refreshHostedModelCatalog();
      this.settings = await getSettingsSafe();
      this.normalizeMode();
      this.syncCapabilityDefault();
      this.render();
      this.renderProviderRail();
      void this.ensureModelsLoaded(this.settings.provider);
    } catch (e) {
      console.error("modelbar refresh failed", e);
    }
  }

  /** Lock provider/model/effort controls while the visible session is running. */
  setActiveSessionRunProfile(profile: { provider: string; model: string; effort?: string } | null) {
    const next = profile
      ? {
          provider: String(profile.provider || "").trim(),
          model: String(profile.model || "").trim(),
          effort: String(profile.effort || "").trim(),
        }
      : null;
    const current = this.activeRunProfile;
    if (
      current?.provider === next?.provider &&
      current?.model === next?.model &&
      current?.effort === next?.effort
    ) {
      return;
    }
    this.activeRunProfile = next;
    // Invalidate a slow provider-discovery selection that began before the
    // session became busy. It must not save a different model mid-run.
    this.providerSelectionGeneration += 1;
    this.closeMenus();
    if (typeof this.settings !== "undefined") this.renderProviderRail();
  }

  /** Current provider/model/effort shown to the user (locked run wins while busy). */
  currentProfile(): { provider: string; model: string; effort: string } | null {
    if (!this.settings) return null;
    const locked = this.activeRunProfile;
    return {
      provider: locked?.provider || this.settings.provider,
      model: locked?.model || this.settings.model,
      effort: locked?.effort || this.settings.model_effort || "medium",
    };
  }

  /**
   * Restore another session's remembered model into the shared composer and
   * settings file so the next agent_run uses that conversation's selection.
   */
  async applySessionProfile(profile: {
    provider: string;
    model: string;
    effort?: string;
  }): Promise<boolean> {
    if (!this.settings) return false;
    if (this.modelSelectionLocked()) return false;
    const provider = String(profile.provider || "").trim();
    const model = String(profile.model || "").trim();
    if (!provider || !model) return false;
    const effort = profile.effort
      ? normalizeEffortForProvider(provider, profile.effort)
      : normalizeEffortForProvider(provider, this.settings.model_effort);
    const meta = getProviderMeta(provider);
    const same =
      this.settings.provider === provider &&
      this.settings.model === model &&
      this.settings.model_effort === effort;
    if (same) {
      this.renderProviderRail();
      return true;
    }
    const selectionGeneration = ++this.providerSelectionGeneration;
    this.settings.provider = provider;
    this.settings.model = model;
    this.settings.model_effort = effort;
    if (meta?.defaultBaseUrl) {
      this.settings.base_url = meta.defaultBaseUrl;
    }
    try {
      await api.saveSettings(this.settings);
      if (selectionGeneration !== this.providerSelectionGeneration) return false;
      this.settings = await api.getSettings();
      this.normalizeMode();
      this.syncCapabilityDefault();
      this.renderProviderRail();
      void this.ensureModelsLoaded(this.settings.provider);
      this.onChange();
      return true;
    } catch (e) {
      console.error(e);
      this.setStatus("Could not restore this session's model", true);
      return false;
    }
  }

  /** Match the original app's non-secret model choice without sharing credentials. */
  private async matchOriginalAppModel() {
    if (!this.settings || !this.allowModelSelection()) return;
    try {
      const selection = await api.getOriginalModelSelection();
      if (!selection) {
        this.setStatus("Original Hormachuelos model selection was not found on this computer.", true);
        return;
      }
      const applied = await this.applySessionProfile({
        provider: selection.provider,
        model: selection.model,
        effort: selection.model_effort,
      });
      if (!applied) return;
      const provider = getProviderMeta(selection.provider)?.label || selection.provider;
      this.setStatus(
        `Matched original app: ${provider} · ${this.shortModel(selection.model, selection.provider)}. API keys and sign-in stay separate.`,
      );
    } catch (error) {
      console.error(error);
      this.setStatus("Could not read the original app model selection.", true);
    }
  }

  private modelSelectionLocked(): boolean {
    return this.activeRunProfile !== null;
  }

  private modelLockMessage(): string {
    return "Model is locked while this session is working. Stop or wait for it to finish before switching.";
  }

  private allowModelSelection(): boolean {
    if (!this.modelSelectionLocked()) return true;
    this.closeMenus();
    this.setStatus(this.modelLockMessage());
    return false;
  }

  /** Load administrator-managed aliases before rendering the provider picker. */
  private async refreshHostedModelCatalog() {
    try {
      const catalog = await refreshHostedProviderCatalog();
      const nextProviderIds = new Set(catalog.map((provider) => provider.id));
      for (const providerId of this.hostedCatalogProviderIds) {
        if (!nextProviderIds.has(providerId)) delete this.discoveredModels[providerId];
      }
      // Drop any previously discovered BYOK catalogs when this account is under
      // an admin allowlist — otherwise prohibited providers stay selectable.
      if (isHostedCatalogRestricted()) {
        for (const providerId of Object.keys(this.discoveredModels)) {
          if (!nextProviderIds.has(providerId)) delete this.discoveredModels[providerId];
        }
      }
      for (const provider of catalog) {
        const models = mergeProviderModelCatalog(
          provider.id,
          provider.models.map((model) => model.id),
        );
        if (models.length) this.discoveredModels[provider.id] = models;
      }
      this.hostedCatalogProviderIds = nextProviderIds;
      await this.enforceHostedAllowlist();
    } catch {
      // Keep the last known picker and built-in providers when the account is
      // offline, unsigned, or the hosted catalog is temporarily unavailable.
    }
  }

  /** If admin restricted this account, force the picker onto an allowed model. */
  private async enforceHostedAllowlist() {
    if (!isHostedCatalogRestricted() || !this.settings) return;
    const allowed = visibleProviders();
    if (!allowed.length) return;
    const currentOk = allowed.some((provider) => provider.id === this.settings!.provider);
    if (!currentOk) {
      const next = allowed[0]!;
      this.settings.provider = next.id;
      this.settings.model = next.defaultModel || next.models[0] || this.settings.model;
      if (next.defaultBaseUrl) this.settings.base_url = next.defaultBaseUrl;
      await api.saveSettings(this.settings).catch(() => {});
      this.renderProviderRail();
      this.onChange();
      return;
    }
    const models = this.modelsForProvider(this.settings.provider);
    if (models.length && !models.includes(this.settings.model)) {
      this.settings.model = models[0]!;
      await api.saveSettings(this.settings).catch(() => {});
      this.renderProviderRail();
      this.onChange();
    }
  }

  /** Load full model list from the provider API (no manual pick of which models appear). */
  private async ensureModelsLoaded(providerId: string) {
    if (this.discoveredModels[providerId]?.length) return;
    if (isHostedCatalogRestricted() && !this.hostedCatalogProviderIds.has(providerId)) return;
    const meta = getProviderMeta(providerId);
    if (!meta) return;
    if (hasStaticModelCatalog(providerId)) return;
    try {
      // Keyless providers always; others need a saved key (backend enforces).
      const modelsRaw = await api.listProviderModels(
        providerId,
        this.settings.provider === providerId
          ? this.settings.base_url?.trim() || null
          : meta.defaultBaseUrl || null,
      );
      const discovered =
        providerId === "openrouter" ? ["openrouter/free"] : modelsRaw;
      const models = mergeProviderModelCatalog(providerId, discovered);
      if (models.length) {
        this.discoveredModels[providerId] = models;
        if (
          this.settings.provider === providerId &&
          !models.includes(this.settings.model)
        ) {
          this.settings.model = models[0];
          await api.saveSettings(this.settings).catch(() => {});
        }
        this.renderProviderRail();
      }
    } catch {
      // Keep preset fallbacks if discovery fails (e.g. no key yet)
    }
  }

  private modelsForProvider(providerId: string): string[] {
    const discovered = this.discoveredModels[providerId];
    if (discovered?.length) return discovered;
    const meta = getProviderMeta(providerId);
    return meta ? [...meta.models] : [];
  }

  setOnProviderChange(cb: () => void) {
    this.onProviderChange = cb;
  }

  getMode(): PermissionMode {
    this.normalizeMode();
    return (this.settings.permission_mode || "plan") as PermissionMode;
  }

  private normalizeMode() {
    const m = String(this.settings.permission_mode || "").toLowerCase().trim();
    if (m === "research" || m === "ask") {
      this.settings.permission_mode = "ask";
    } else if (m === "plan" || m === "auto" || m === "full" || m === "multi_agent") {
      this.settings.permission_mode = m;
    } else {
      this.settings.permission_mode = this.settings.auto_approve ? "auto" : "plan";
    }
    this.settings.auto_approve =
      this.settings.permission_mode === "auto" ||
      this.settings.permission_mode === "full" ||
      this.settings.permission_mode === "multi_agent";
  }

  private syncCapabilityDefault() {
    const mode = this.getMode();
    const caps = CAPABILITIES[mode];
    const saved = String(this.settings.capability_mode || "").toLowerCase().trim();
    if (caps.some((c) => c.id === saved)) {
      this.capabilityId = saved;
    } else if (!caps.some((c) => c.id === this.capabilityId)) {
      this.capabilityId = caps[0].id;
    }
    this.settings.capability_mode = this.capabilityId;
  }

  private async saveCapability(id: string) {
    const mode = this.getMode();
    const caps = CAPABILITIES[mode];
    const next = caps.find((c) => c.id === id)?.id || caps[0].id;
    this.capabilityId = next;
    this.settings.capability_mode = next;
    this.renderProviderRail();
    try {
      await api.saveSettings(this.settings);
      this.settings = await api.getSettings();
      this.normalizeMode();
      this.syncCapabilityDefault();
      this.renderProviderRail();
      const title = caps.find((c) => c.id === next)?.title || next;
      this.setStatus(title);
      this.onChange();
    } catch (e) {
      console.error("Failed to save capability", e);
      this.setStatus("Could not save capability", true);
    }
  }

  private async saveEffort(id: string) {
    if (!this.allowModelSelection()) return;
    const next = normalizeEffortForProvider(this.settings.provider, id);
    const prev = normalizeEffortForProvider(this.settings.provider, this.settings.model_effort);
    this.settings.model_effort = next;
    this.renderProviderRail();
    try {
      await api.saveSettings(this.settings);
      this.settings = await api.getSettings();
      this.renderProviderRail();
      const opts = effortOptionsForProvider(this.settings.provider);
      const label = opts.find((e) => e.id === next)?.label || next;
      this.setStatus(`Effort: ${label}`);
      this.onChange();
      if (next === "ultra" && prev !== "ultra") {
        window.dispatchEvent(new CustomEvent("horma:ultra-effort"));
      }
    } catch (e) {
      console.error("Failed to save effort", e);
      this.setStatus("Could not save effort", true);
    }
  }

  private setStatus(text: string, isError = false) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
    this.statusEl.classList.toggle("error", isError);
    if (text && !isError) {
      window.setTimeout(() => {
        if (this.statusEl && this.statusEl.textContent === text) {
          this.statusEl.hidden = true;
          this.statusEl.textContent = "";
        }
      }, 2200);
    }
  }

  private async saveMode(mode: PermissionMode) {
    const prev = this.getMode();
    this.settings.permission_mode = mode;
    this.settings.auto_approve =
      mode === "auto" || mode === "full" || mode === "multi_agent";
    this.syncCapabilityDefault();
    this.renderProviderRail();
    try {
      await api.saveSettings(this.settings);
      const saved = await api.getSettings();
      this.settings = saved;
      this.normalizeMode();
      this.syncCapabilityDefault();
      this.renderProviderRail();
      const labels: Record<PermissionMode, string> = {
        plan: "Plan — refine first; Apply to change files",
        auto: "Auto — build with defaults",
        ask: "Ask — Answer Max reliability",
        full: "Full — max autonomy",
        multi_agent: "Multi-Agent — parallel discovery",
      };
      this.setStatus(labels[this.getMode()]);
      this.onChange();
    } catch (e) {
      console.error("Failed to save permission mode", e);
      this.settings.permission_mode = prev;
      this.normalizeMode();
      this.renderProviderRail();
      this.setStatus("Could not save mode", true);
    }
  }

  private closeMenus() {
    this.providerRail.querySelectorAll(".chip-menu").forEach((n) => n.remove());
    this.providerRail.querySelectorAll(".chip-btn.menu-open").forEach((n) => {
      n.classList.remove("menu-open");
      n.setAttribute("aria-expanded", "false");
    });
    this.openMenu = null;
    if (this.outsideClose) {
      document.removeEventListener("mousedown", this.outsideClose, true);
      this.outsideClose = null;
    }
  }

  private openChipMenu(btn: HTMLElement, menu: HTMLElement) {
    this.closeMenus();
    btn.classList.add("menu-open");
    btn.setAttribute("aria-expanded", "true");
    const wrap = btn.closest(".chip-wrap") || btn.parentElement;
    wrap?.appendChild(menu);
    this.openMenu = menu;
    this.outsideClose = (e: MouseEvent) => {
      if (!this.providerRail.contains(e.target as Node)) this.closeMenus();
    };
    window.setTimeout(() => {
      if (this.outsideClose) document.addEventListener("mousedown", this.outsideClose, true);
    }, 0);
  }

  private shortModel(id: string, providerId?: string): string {
    return displayModelName(id, providerId);
  }

  private chipBtn(
    label: string,
    title: string,
    aria: string,
    extraClass = "",
    logoSrc?: string,
  ): HTMLButtonElement {
    const logo = logoSrc
      ? `<img class="chip-logo" src="${logoSrc}" alt="" width="14" height="14" draggable="false" />`
      : "";
    return el("button", {
      class: "chip-btn" + (extraClass ? ` ${extraClass}` : ""),
      type: "button",
      title,
      "aria-label": aria,
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      html: `${logo}<span class="chip-label">${escapeHtml(label)}</span><span class="chip-caret" aria-hidden="true">▾</span>`,
    }) as HTMLButtonElement;
  }

  /** Build OpenCode-style chips into the composer toolbar. */
  renderProviderRail() {
    if (!this.settings) return;
    this.closeMenus();
    clear(this.providerRail);

    const mode = this.getMode();
    const lockedProfile = this.activeRunProfile;
    const displaySettings = lockedProfile || this.settings;
    const modelIsLocked = this.modelSelectionLocked();
    const modeMeta = MODES.find((m) => m.id === mode) || MODES[0];
    const uiProvId = uiProviderId(displaySettings.provider, displaySettings.model);
    const provider = PROVIDERS.find((p) => p.id === uiProvId) || visibleProviders()[0] || PROVIDERS[0];
    const meta = getProviderMeta(uiProvId) || provider;

    // + menu: Plan / Debug / Multitask / Ask · Image / Video / Files
    const plusWrap = el("div", { class: "chip-wrap" });
    const plus = el("button", {
      class: "chip-btn chip-icon",
      type: "button",
      title: "Add — Plan, Debug, Multitask, Ask, Image, Video, Files",
      "aria-label": "Add modes and attachments",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      html: `<span class="chip-plus" aria-hidden="true">+</span>`,
    }) as HTMLButtonElement;
    plus.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (plus.classList.contains("menu-open")) {
        this.closeMenus();
        return;
      }
      void this.openPlusMenu(plus);
    });
    plusWrap.appendChild(plus);
    this.providerRail.appendChild(plusWrap);

    // Mode chip (build / plan / ship style)
    const modeWrap = el("div", { class: "chip-wrap" });
    const modeBtn = this.chipBtn(
      modeMeta.chip,
      modeMeta.title,
      `Mode: ${modeMeta.label}`,
      "chip-mode" + (mode === "multi_agent" ? " chip-mode-multi-agent" : ""),
    );
    modeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (modeBtn.classList.contains("menu-open")) {
        this.closeMenus();
        return;
      }
      const menu = el("div", { class: "chip-menu", role: "listbox", "aria-label": "Permission mode" });
      for (const m of MODES) {
        const item = el("button", {
          class: "chip-menu-item" + (m.id === mode ? " active" : ""),
          type: "button",
          role: "option",
          "aria-selected": String(m.id === mode),
          title: m.title,
        }, [
          m.id === "multi_agent"
            ? "🌈 Multi-Agent — parallel workspace discovery"
            : `${m.chip} — ${m.label}`,
        ]) as HTMLButtonElement;
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.closeMenus();
          if (m.id !== mode) void this.saveMode(m.id);
        });
        menu.appendChild(item);
      }
      this.openChipMenu(modeBtn, menu);
    });
    modeWrap.appendChild(modeBtn);
    this.providerRail.appendChild(modeWrap);

    // Model chip (shows provider logo + model display name)
    const modelWrap = el("div", { class: "chip-wrap" });
    const modelBtn = this.chipBtn(
      this.shortModel(displaySettings.model, uiProvId),
      modelIsLocked
        ? `${provider.label} · ${this.shortModel(displaySettings.model, uiProvId)} · ${this.modelLockMessage()}`
        : `${provider.label} · ${this.shortModel(displaySettings.model, uiProvId)}`,
      modelIsLocked
        ? `Model locked: ${this.shortModel(displaySettings.model, uiProvId)}`
        : `Model: ${this.shortModel(displaySettings.model, uiProvId)}`,
      "chip-model" + (modelIsLocked ? " chip-model-locked" : ""),
      provider.logoSrc,
    );
    if (modelIsLocked) {
      modelBtn.disabled = true;
      modelBtn.setAttribute("aria-disabled", "true");
      modelBtn.setAttribute("data-model-locked", "true");
    }
    modelBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this.allowModelSelection()) return;
      if (modelBtn.classList.contains("menu-open")) {
        this.closeMenus();
        return;
      }
      const menu = el("div", { class: "chip-menu chip-menu-wide", role: "listbox", "aria-label": "Model" });

      const syncHead = el("div", { class: "chip-menu-head" }, ["Quick action"]);
      const syncOriginal = el("button", {
        class: "chip-menu-item chip-menu-sync",
        type: "button",
        role: "option",
        "aria-selected": "false",
        title: "Copy the original app's provider, model, and effort. API keys and sign-in are not copied.",
      }, ["↻ Match original app model"]) as HTMLButtonElement;
      syncOriginal.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.matchOriginalAppModel();
      });
      menu.append(syncHead, syncOriginal);

      // Provider rows
      const provHead = el("div", { class: "chip-menu-head" }, ["Provider"]);
      menu.appendChild(provHead);
      for (const p of visibleProviders()) {
        const item = el("button", {
          class: "chip-menu-item chip-menu-provider" + (p.id === provider.id ? " active" : ""),
          type: "button",
          role: "option",
          "aria-selected": String(p.id === provider.id),
          html:
            `<img class="chip-menu-logo" src="${p.logoSrc}" alt="" width="16" height="16" draggable="false" />` +
            `<span>${escapeHtml(p.label)}</span>`,
        }) as HTMLButtonElement;
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.selectProvider(p.id);
        });
        menu.appendChild(item);
      }

      const modelHead = el("div", { class: "chip-menu-head" }, ["Model"]);
      menu.appendChild(modelHead);
      void this.ensureModelsLoaded(this.settings.provider);
      let models = this.modelsForProvider(uiProvId);
      if (!models.length) {
        models = meta.models.includes(this.settings.model)
          ? meta.models
          : [...meta.models, this.settings.model];
      }
      for (const m of models) {
        const item = el("button", {
          class: "chip-menu-item" + (m === this.settings.model ? " active" : ""),
          type: "button",
          role: "option",
          "aria-selected": String(m === this.settings.model),
          title: displayModelName(m, uiProvId),
        }, [this.shortModel(m, uiProvId)]) as HTMLButtonElement;
        item.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!this.allowModelSelection()) return;
          this.closeMenus();
          this.settings.model = m;
          try {
            await api.saveSettings(this.settings);
            this.settings = await api.getSettings();
            this.normalizeMode();
            this.renderProviderRail();
            this.onChange();
          } catch (err) {
            console.error(err);
            this.setStatus("Could not save model", true);
          }
        });
        menu.appendChild(item);
      }
      this.openChipMenu(modelBtn, menu);
    });
    modelWrap.appendChild(modelBtn);
    this.providerRail.appendChild(modelWrap);

    // Cursor and native Grok expose an effort control. For Grok this maps to
    // xAI's supported reasoning_effort values (low / medium / high).
    if (usesReasoningEffort(provider.id)) {
      const effortOpts = effortOptionsForProvider(provider.id);
      const effort = normalizeEffortForProvider(
        provider.id,
        lockedProfile?.effort || this.settings.model_effort,
      );
      const effortMeta = effortOpts.find((e) => e.id === effort) || effortOpts[effortOpts.length - 1];
      const effortWrap = el("div", { class: "chip-wrap" });
      const isUltra = isUltraEffort(effort);
      const effortBtn = this.chipBtn(
        effortMeta.label,
        `Effort: ${effortMeta.label}`,
        `Model effort: ${effortMeta.label}`,
        "chip-cap chip-effort" + (isUltra ? " chip-effort-ultra" : ""),
      );
      if (isUltra) {
        const label = effortBtn.querySelector(".chip-label");
        if (label) {
          label.classList.add("chip-effort-ultra-label");
          label.textContent = "Ultra";
        }
      }
      if (modelIsLocked) {
        effortBtn.disabled = true;
        effortBtn.classList.add("chip-model-locked");
        effortBtn.setAttribute("aria-disabled", "true");
        effortBtn.title = this.modelLockMessage();
      }
      effortBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.allowModelSelection()) return;
        if (effortBtn.classList.contains("menu-open")) {
          this.closeMenus();
          return;
        }
        const menu = el("div", { class: "chip-menu", role: "listbox", "aria-label": "Effort" });
        for (const opt of effortOpts) {
          const item = el("button", {
            class:
              "chip-menu-item" +
              (opt.id === effort ? " active" : "") +
              (opt.id === "ultra" ? " chip-menu-effort-ultra" : ""),
            type: "button",
            role: "option",
            "aria-selected": String(opt.id === effort),
          }, [opt.label]) as HTMLButtonElement;
          item.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.saveEffort(opt.id);
          });
          menu.appendChild(item);
        }
        this.openChipMenu(effortBtn, menu);
      });
      effortWrap.appendChild(effortBtn);
      this.providerRail.appendChild(effortWrap);
    } else {
      // Capability chip (Thinking / Agent / …)
      const caps = CAPABILITIES[mode];
      const cap = caps.find((c) => c.id === this.capabilityId) || caps[0];
      const capWrap = el("div", { class: "chip-wrap" });
      const agentic = mode === "auto" || mode === "full" || mode === "multi_agent";
      const capBtn = this.chipBtn(
        cap.label,
        cap.title,
        `Capability: ${cap.label}`,
        "chip-cap" + (agentic ? " chip-cap-agentic" : ""),
      );
      capBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (capBtn.classList.contains("menu-open")) {
          this.closeMenus();
          return;
        }
        const menu = el("div", { class: "chip-menu", role: "listbox", "aria-label": "Capability" });
        for (const c of caps) {
          const item = el("button", {
            class: "chip-menu-item" + (c.id === this.capabilityId ? " active" : ""),
            type: "button",
            role: "option",
            "aria-selected": String(c.id === this.capabilityId),
            title: c.title,
          }, [c.label]) as HTMLButtonElement;
          item.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.saveCapability(c.id);
          });
          menu.appendChild(item);
        }
        this.openChipMenu(capBtn, menu);
      });
      capWrap.appendChild(capBtn);
      this.providerRail.appendChild(capWrap);
    }

    if (modelIsLocked) {
      this.providerRail.appendChild(
        el("span", {
          class: "chip-lock-note",
          role: "status",
          title: this.modelLockMessage(),
        }, ["Model locked"]),
      );
    }

    this.statusEl = el("span", { class: "mode-status chip-status" });
    this.statusEl.hidden = true;
    this.providerRail.appendChild(this.statusEl);
  }

  /** + menu: Plan / Debug / Multitask / Ask · Image / Video / Files. */
  private async openPlusMenu(btn: HTMLButtonElement) {
    const menu = el("div", {
      class: "chip-menu chip-menu-plus",
      role: "menu",
      "aria-label": "Add",
    });

    const mode = this.getMode();
    const cap = this.capabilityId;

    const addItem = (
      label: string,
      iconName: keyof typeof icons,
      opts: {
        title?: string;
        active?: boolean;
        onClick?: (e: MouseEvent) => void;
      } = {},
    ) => {
      const item = el("button", {
        class: "chip-menu-item chip-menu-row" + (opts.active ? " active" : ""),
        type: "button",
        role: "menuitem",
        title: opts.title || label,
        html:
          `<span class="chip-menu-ico">${icon(iconName, 14)}</span>` +
          `<span class="chip-menu-text">${label}</span>`,
      }) as HTMLButtonElement;
      if (opts.onClick) {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          opts.onClick!(e);
        });
      }
      menu.appendChild(item);
      return item;
    };

    addItem("Plan", "planList", {
      title: "Plan — refine request; wait for Apply before file changes",
      active: mode === "plan",
      onClick: () => {
        this.closeMenus();
        void this.applyPlusMode("plan", undefined, "Plan mode");
      },
    });
    addItem("Debug", "bug", {
      title: "Debug — investigate bugs with evidence",
      active: mode === "ask" && cap === "investigate",
      onClick: () => {
        this.closeMenus();
        void this.applyPlusMode("ask", "investigate", "Debug mode");
        this.insertComposer("Debug this:\n");
      },
    });
    addItem("Multitask", "multitask", {
      title: "Multitask — start a parallel session",
      onClick: () => {
        this.closeMenus();
        window.dispatchEvent(new CustomEvent("horma:new-session"));
        this.setStatus("New session for multitask");
      },
    });
    addItem("Ask", "ask", {
      title: "Ask — reliable complete answer with evidence",
      active: mode === "ask" && cap === "answer_max",
      onClick: () => {
        this.closeMenus();
        void this.applyPlusMode("ask", "answer_max", "Ask · Answer Max");
      },
    });

    addItem(
      `Flavour memory — ${this.settings.flavour_enabled !== false ? "On" : "Off"}`,
      "spark",
      {
        title: "Recall bounded project preferences and private session working memory before, during, and after AI work",
        active: this.settings.flavour_enabled !== false,
        onClick: () => {
          const enabled = this.settings.flavour_enabled === false;
          this.settings.flavour_enabled = enabled;
          this.closeMenus();
          void api.saveSettings(this.settings)
            .then(async () => {
              this.settings = await api.getSettings();
              this.normalizeMode();
              this.renderProviderRail();
              this.setStatus(`Flavour memory ${enabled ? "on" : "off"}`);
              this.onChange();
            })
            .catch((error) => {
              console.error("Failed to toggle Flavour memory", error);
              this.setStatus("Could not change Flavour memory", true);
            });
        },
      },
    );

    menu.appendChild(el("div", { class: "chip-menu-sep", role: "separator" }));

    addItem("Image", "image", {
      title: "Attach an image to the message",
      onClick: () => {
        this.closeMenus();
        void this.attachImage();
      },
    });
    addItem("Video", "video", {
      title: "Attach a video — all models receive a visual frame summary",
      onClick: () => {
        this.closeMenus();
        void this.attachVideo();
      },
    });
    addItem("Files", "file", {
      title: "Attach files to the message",
      onClick: () => {
        this.closeMenus();
        void this.attachFiles();
      },
    });

    this.openChipMenu(btn, menu);
  }

  private async applyPlusMode(
    mode: PermissionMode,
    capability: string | undefined,
    status: string,
  ) {
    this.settings.permission_mode = mode;
    this.settings.auto_approve =
      mode === "auto" || mode === "full" || mode === "multi_agent";
    this.syncCapabilityDefault();
    if (capability && CAPABILITIES[mode].some((c) => c.id === capability)) {
      this.capabilityId = capability;
      this.settings.capability_mode = capability;
    }
    this.renderProviderRail();
    try {
      await api.saveSettings(this.settings);
      this.settings = await api.getSettings();
      this.normalizeMode();
      this.syncCapabilityDefault();
      this.renderProviderRail();
      this.setStatus(status);
      this.onChange();
    } catch (e) {
      console.error("Failed to apply plus mode", e);
      this.setStatus("Could not switch mode", true);
    }
  }

  private insertComposer(text: string) {
    window.dispatchEvent(
      new CustomEvent("horma:composer-insert", { detail: { text } }),
    );
  }

  private async attachImage() {
    try {
      const paths = await api.openImagePicker();
      if (!paths.length) return;
      let ok = 0;
      for (const path of paths) {
        try {
          const imported = await api.importImagePath(path);
          window.dispatchEvent(
            new CustomEvent("horma:composer-attach-image", { detail: { path: imported } }),
          );
          ok += 1;
        } catch (err) {
          console.error(err);
        }
      }
      this.setStatus(ok === 1 ? "Image attached" : ok > 1 ? `${ok} images attached` : "Could not attach images", ok === 0);
    } catch (e) {
      console.error(e);
      this.setStatus("Could not attach images", true);
    }
  }

  private async attachVideo() {
    try {
      const paths = await api.openVideoPicker();
      if (!paths.length) return;
      let ok = 0;
      for (const path of paths) {
        try {
          const imported = await api.importVideoPath(path);
          window.dispatchEvent(
            new CustomEvent("horma:composer-attach-video", { detail: { path: imported } }),
          );
          ok += 1;
        } catch (err) {
          console.error(err);
        }
      }
      this.setStatus(ok === 1 ? "Video attached" : ok > 1 ? `${ok} videos attached` : "Could not attach videos", ok === 0);
    } catch (e) {
      console.error(e);
      this.setStatus("Could not attach videos", true);
    }
  }

  private async attachFiles() {
    try {
      const paths = await api.openFilePicker();
      if (!paths.length) return;
      const block = paths.map((p) => `[Attached file: ${p}]`).join("\n") + "\n";
      this.insertComposer(block);
      this.setStatus(paths.length === 1 ? "File attached" : `${paths.length} files attached`);
    } catch (e) {
      console.error(e);
      this.setStatus("Could not attach files", true);
    }
  }

  private async selectProvider(id: string) {
    if (!this.allowModelSelection()) return;
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    const selectionGeneration = ++this.providerSelectionGeneration;
    this.closeMenus();
    const already =
      uiProviderId(this.settings.provider, this.settings.model) === p.id;
    if (already) {
      this.renderProviderRail();
      return;
    }
    // Ollama's static fallback may not exist on this machine. Discover its
    // actual local/cloud handles before persisting a selection so a fast send
    // cannot race against model discovery with an unavailable fallback model.
    if (p.id === "ollama" && !this.discoveredModels[p.id]?.length) {
      await this.ensureModelsLoaded(p.id);
      if (selectionGeneration !== this.providerSelectionGeneration) return;
    }
    const known = this.discoveredModels[p.id];
    this.settings.provider = p.id;
    this.settings.model = known?.[0] || p.defaultModel;
    this.settings.base_url = p.defaultBaseUrl || null;
    try {
      await api.saveSettings(this.settings);
      this.settings = await api.getSettings();
      this.normalizeMode();
      if (known?.length && !known.includes(this.settings.model)) {
        this.settings.model = known[0];
        await api.saveSettings(this.settings).catch(() => {});
      }
      this.renderProviderRail();
      this.onChange();
      this.onProviderChange?.();
      void this.ensureModelsLoaded(p.id);
    } catch (e) {
      console.error(e);
      this.setStatus("Could not switch provider", true);
    }
  }

  /** Status host only — chips render into providerRail. */
  private render() {
    clear(this.node);
    this.normalizeMode();
  }
}
