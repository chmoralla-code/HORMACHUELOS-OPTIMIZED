import {
  assignPreviewFileInput,
  installPreviewProbes,
  isPreviewUploadFixture,
  previewFixtureFile,
  previewNetworkIdle,
  previewProbeSnapshot,
  scanPreviewA11y,
} from "./preview-computer-qa";
import {
  choosePreviewScrollCandidate,
  previewScrollMoved,
  type PreviewScrollCandidate,
  type PreviewScrollPosition,
} from "./preview-scroll-policy";
import {
  aiCursorFireCss,
  aiCursorHandBeforeCss,
  attachAiCursorFire,
  replayAiCursorFire,
} from "../computer-cursor";

export type PreviewComputerRequest = {
  requestId: string;
  protocolVersion: number;
  operation: "observe" | "actions";
  args: Record<string, unknown>;
};

export type PreviewComputerAction = {
  type:
    | "move"
    | "hover"
    | "click"
    | "type"
    | "key"
    | "scroll"
    | "drag"
    | "set_value"
    | "check"
    | "wait"
    | "wait_for"
    | "upload"
    | "set_viewport"
    | "save_spec"
    | "record"
    | "replay"
    | "open_tab"
    | "navigate"
    | "activate_tab";
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  end_ref?: string;
  end_selector?: string;
  end_x?: number;
  end_y?: number;
  text?: string;
  value?: string;
  keys?: string;
  button?: "left" | "right" | "middle";
  clicks?: number;
  delta_x?: number;
  delta_y?: number;
  duration_ms?: number;
  clear?: boolean;
  match?: "contains" | "equals";
  expect?: {
    visible?: boolean;
    enabled?: boolean;
    checked?: boolean;
    text?: string;
    value?: string;
    url?: string;
    title?: string;
  };
  /** Safe http(s) address for Preview-native open_tab and navigate actions. */
  url?: string;
  /** Exact Preview tab id returned by computer_observe. */
  tab_id?: string;
  /** Preview-safe upload fixture: tiny.png, sample.csv, or note.txt. */
  fixture?: string;
  /** Device frame for set_viewport: mobile, tablet, or desktop. */
  viewport?: string;
  /** record start/stop. */
  state?: "start" | "stop";
  /** Optional title for save_spec. */
  title?: string;
};

type Point = { x: number; y: number };
type ResolvedTarget = { element: Element | null; point: Point };

type ObservedElement = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  disabled: boolean;
  scrollable?: boolean;
  scroll?: PreviewScrollPosition;
  checked?: boolean;
  value?: string;
  inputType?: string;
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
};

const controllers = new WeakMap<Document, PreviewFrameComputerController>();
const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "textarea", "select", "option", "summary",
  "[contenteditable='true']", "[role='button']", "[role='link']", "[role='checkbox']",
  "[role='radio']", "[role='tab']", "[role='menuitem']", "[role='option']",
  "[tabindex]:not([tabindex='-1'])", "canvas", "video",
].join(",");
const MAX_OBSERVED_ELEMENTS = 80;
const MAX_INTERACTIVE_SCAN = 320;
const MAX_ANCESTOR_SCAN = 480;
const MAX_SEMANTIC_SCAN = 240;
const MAX_VISIBLE_CONTENT = 32;
const MAX_VISIBLE_CONTENT_CHARS = 6_000;
const MAX_CURSOR_TRAIL_SPARKS = 3;
const MAX_CURSOR_TRANSIENTS = 8;
const FEATURE_SELECTOR = [
  "button", "a[href]", "input", "textarea", "select", "summary",
  "[contenteditable='true']", "[role='button']", "[role='link']", "[role='checkbox']",
  "[role='radio']", "[role='tab']", "[role='menuitem']", "[role='option']",
  "tr", "[role='row']", "[role='listitem']",
].join(",");
const ACTIVATE_SELECTOR = [
  "a[href]", "button", "summary",
  "input[type='button']", "input[type='submit']", "input[type='reset']", "input[type='image']",
  "[role='button']", "[role='link']", "[role='menuitem']", "[role='tab']", "[role='option']",
].join(",");
const ROW_HOST_SELECTOR = "tr, [role='row'], [role='listitem'], [role='gridcell'], li, article, [data-href]";
const MAX_CLICKABLE_ROW_SCAN = 48;
const SEMANTIC_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "label", "legend", "th", "td",
  "[role='heading']", "[role='alert']", "[role='status']", "[role='dialog']",
].join(",");

function elementScrollPosition(element: Element): PreviewScrollPosition {
  const html = element as HTMLElement;
  return {
    x: Math.round(html.scrollLeft || 0),
    y: Math.round(html.scrollTop || 0),
    maxX: Math.max(0, Math.round(html.scrollWidth - html.clientWidth)),
    maxY: Math.max(0, Math.round(html.scrollHeight - html.clientHeight)),
  };
}

function scrollableElementPosition(element: Element, view: Window): PreviewScrollPosition | null {
  if (!isHtmlElement(element)
    || element === view.document.body
    || element === view.document.documentElement) return null;
  const position = elementScrollPosition(element);
  if (position.maxX <= 1 && position.maxY <= 1) return null;
  const style = view.getComputedStyle(element);
  const scrollable = (position.maxX > 1 && /^(auto|scroll|overlay)$/.test(style.overflowX))
    || (position.maxY > 1 && /^(auto|scroll|overlay)$/.test(style.overflowY));
  return scrollable ? position : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function compact(value: string | null | undefined, max = 160): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (part) => `\\${part}`);
}

function selectorFor(element: Element, document: Document): string {
  if (element.id) {
    const selector = `#${cssEscape(element.id)}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch { /* fall through */ }
  }
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
  if (testId) {
    const key = element.hasAttribute("data-testid") ? "data-testid" : "data-test";
    const selector = `[${key}="${testId.replace(/["\\]/g, "\\$&")}"]`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch { /* fall through */ }
  }
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.documentElement && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const peers = Array.from(parent.children).filter((child) => child.tagName === node?.tagName);
      if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch { /* keep building */ }
    node = parent;
  }
  return parts.join(" > ") || element.tagName.toLowerCase();
}

function isVisible(element: Element, view: Window): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > view.innerHeight || rect.left > view.innerWidth) return false;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
}

function isEffectivelyVisible(element: Element, view: Window): boolean {
  if (!isVisible(element, view)) return false;
  let rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(view.innerWidth, rect.right);
  let bottom = Math.min(view.innerHeight, rect.bottom);
  if (right - left < 1 || bottom - top < 1) return false;

  let ancestor = element.parentElement;
  for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
    if (ancestor.getAttribute("aria-hidden") === "true" || ancestor.hasAttribute("inert")) return false;
    if (ancestor.tagName.toLowerCase() === "details" && !ancestor.hasAttribute("open")) return false;
    const style = view.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0.01) return false;
    const bounds = ancestor.getBoundingClientRect();
    if (/^(hidden|clip|auto|scroll|overlay)$/.test(style.overflowX)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (/^(hidden|clip|auto|scroll|overlay)$/.test(style.overflowY)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
    if (right - left < 1 || bottom - top < 1) return false;
  }
  return true;
}

function visibleSemanticContent(document: Document, view: Window): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const root = document.body || document.documentElement;
  if (!root || typeof document.createTreeWalker !== "function") return output;
  const nodeFilter = view as Window & { NodeFilter?: { SHOW_ELEMENT?: number } };
  const showElement = nodeFilter.NodeFilter?.SHOW_ELEMENT ?? 1;
  const walker = document.createTreeWalker(root, showElement);
  let scanned = 0;
  let totalChars = 0;
  while (scanned < MAX_SEMANTIC_SCAN && output.length < MAX_VISIBLE_CONTENT) {
    const node = walker.nextNode();
    if (!node) break;
    scanned += 1;
    const element = node as Element;
    try {
      if (!element.matches(SEMANTIC_SELECTOR) || !isEffectivelyVisible(element, view)) continue;
    } catch {
      continue;
    }
    const text = compact((element as HTMLElement).innerText || element.textContent, 240);
    if (!text || seen.has(text)) continue;
    if (totalChars + text.length > MAX_VISIBLE_CONTENT_CHARS) break;
    seen.add(text);
    totalChars += text.length;
    const rect = element.getBoundingClientRect();
    output.push({
      tag: element.tagName.toLowerCase(),
      role: compact(element.getAttribute("role") || element.tagName.toLowerCase(), 48),
      text,
      selector: selectorFor(element, document),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
    });
  }
  return output;
}

function elementName(element: Element): string {
  const html = element as HTMLElement;
  const input = element as HTMLInputElement;
  return compact(
    element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("alt")
      || input.placeholder
      || html.innerText
      || element.textContent
      || input.name
      || input.id,
  );
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  return Boolean(element && typeof (element as HTMLElement).focus === "function");
}

function isInputElement(element: Element | null): element is HTMLInputElement {
  return element?.tagName.toLowerCase() === "input";
}

function isTextAreaElement(element: Element | null): element is HTMLTextAreaElement {
  return element?.tagName.toLowerCase() === "textarea";
}

function isButtonElement(element: Element | null): element is HTMLButtonElement {
  return element?.tagName.toLowerCase() === "button";
}

function isAnchorElement(element: Element | null): element is HTMLAnchorElement {
  return element?.tagName.toLowerCase() === "a";
}

function isClickableHost(element: Element, view: Window): boolean {
  const html = element as HTMLElement;
  if (
    html.getAttribute("onclick")
    || html.getAttribute("href")
    || html.getAttribute("data-href")
    || html.getAttribute("data-url")
  ) return true;
  if (html.hasAttribute("tabindex") && html.tabIndex >= 0) return true;
  try {
    return view.getComputedStyle(html).cursor === "pointer";
  } catch {
    return false;
  }
}

function clickActivationTarget(seed: Element, point: Point, document: Document, view: Window): HTMLElement {
  const hit = (document.elementFromPoint(point.x, point.y) as Element | null) || seed;
  try {
    const direct = hit.closest(ACTIVATE_SELECTOR);
    if (direct && isVisible(direct, view)) return direct as HTMLElement;
  } catch { /* page selector engines can throw on exotic compounds */ }
  let host: Element = seed;
  try {
    host = hit.closest(ROW_HOST_SELECTOR) || seed;
  } catch { /* keep the resolved seed */ }
  try {
    for (const link of host.querySelectorAll("a[href], [role='link']")) {
      if (isVisible(link, view)) return link as HTMLElement;
    }
  } catch { /* ignore an exotic page querySelectorAll */ }
  let node: Element | null = hit;
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    if (isClickableHost(node, view)) return node as HTMLElement;
  }
  return (isHtmlElement(hit) ? hit : seed) as HTMLElement;
}

function isEditable(element: Element | null): element is HTMLElement {
  return isHtmlElement(element)
    && (isInputElement(element) || isTextAreaElement(element) || element.isContentEditable);
}

function abortError(): DOMException {
  return new DOMException("Preview Computer Use stopped.", "AbortError");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class PreviewFrameComputerController {
  private refs = new Map<string, Element>();
  private abortController: AbortController | null = null;
  private overlayStyle: HTMLStyleElement | null = null;
  private cursor: HTMLElement | null = null;
  private cursorCore: HTMLElement | null = null;
  private cursorLabel: HTMLElement | null = null;
  private targetFrame: HTMLElement | null = null;
  private targetPlate: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private cursorPoint: Point = { x: 32, y: 32 };
  private transientFx: HTMLElement[] = [];
  private humanTakeoverHandler: ((event: Event) => void) | null = null;
  private recording: PreviewComputerAction[] | null = null;
  private recordCleanup: (() => void) | null = null;

  constructor(private readonly document: Document, private readonly view: Window) {
    installPreviewProbes(view);
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.destroyOverlay();
  }

  observe(): Record<string, unknown> {
    const elements: ObservedElement[] = [];
    this.refs.clear();

    // Keep observation work strictly bounded. The pane under the AI cursor is
    // inspected first, and scrollable ancestors are emitted before controls so
    // a busy page cannot push its actual scroll target past the 80-ref limit.
    const interactive: Element[] = [];
    const scrollables: Element[] = [];
    const scrollPositions = new Map<Element, PreviewScrollPosition>();
    const inspectedAncestors = new Set<Element>();
    const addScrollableAncestors = (seed: Element | null) => {
      let node = seed;
      while (node && inspectedAncestors.size < MAX_ANCESTOR_SCAN) {
        if (inspectedAncestors.has(node)) break;
        inspectedAncestors.add(node);
        const position = scrollableElementPosition(node, this.view);
        if (position && !scrollPositions.has(node)) {
          scrollPositions.set(node, position);
          scrollables.push(node);
        }
        node = node.parentElement;
      }
    };

    addScrollableAncestors(this.document.elementFromPoint(this.cursorPoint.x, this.cursorPoint.y));
    let scanned = 0;
    for (const element of this.document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (scanned >= MAX_INTERACTIVE_SCAN || interactive.length >= MAX_OBSERVED_ELEMENTS) break;
      scanned += 1;
      if (!isVisible(element, this.view)) continue;
      interactive.push(element);
      addScrollableAncestors(element);
    }
    let rowScan = 0;
    for (const element of this.document.querySelectorAll(ROW_HOST_SELECTOR)) {
      if (rowScan >= MAX_CLICKABLE_ROW_SCAN || interactive.length >= MAX_OBSERVED_ELEMENTS) break;
      rowScan += 1;
      if (!isVisible(element, this.view)) continue;
      let nestedLink = false;
      try { nestedLink = Boolean(element.querySelector("a[href], [role='link']")); } catch { nestedLink = false; }
      if (!nestedLink && !isClickableHost(element, this.view)) continue;
      interactive.push(element);
      addScrollableAncestors(element);
    }

    const emitted = new Set<Element>();
    for (const element of [...scrollables, ...interactive]) {
      if (elements.length >= MAX_OBSERVED_ELEMENTS) break;
      if (emitted.has(element) || !isVisible(element, this.view)) continue;
      emitted.add(element);
      const rect = element.getBoundingClientRect();
      const ref = `p${elements.length + 1}`;
      this.refs.set(ref, element);
      const input = element as HTMLInputElement;
      const scrollPosition = scrollPositions.get(element);
      const scrollableName = compact(
        element.getAttribute("aria-label")
          || element.getAttribute("title")
          || element.id,
      );
      const observed: ObservedElement = {
        ref,
        tag: element.tagName.toLowerCase(),
        role: compact(element.getAttribute("role") || element.tagName.toLowerCase(), 48),
        name: scrollPosition ? (scrollableName || "Scrollable region") : elementName(element),
        selector: selectorFor(element, this.document),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        disabled: "disabled" in input && Boolean(input.disabled),
      };
      if (scrollPosition) {
        observed.scrollable = true;
        observed.scroll = scrollPosition;
      }
      if ("checked" in input && typeof input.checked === "boolean") observed.checked = input.checked;
      if (element.tagName.toLowerCase() === "input") {
        observed.inputType = compact(input.type || "text", 32);
        observed.required = Boolean(input.required);
        if (compact(input.min)) observed.min = compact(input.min, 80);
        if (compact(input.max)) observed.max = compact(input.max, 80);
        if (compact(input.step)) observed.step = compact(input.step, 40);
      }
      if ("value" in input && input.type !== "password" && compact(input.value)) {
        observed.value = compact(input.value, 120);
      }
      elements.push(observed);
    }
    const a11y = scanPreviewA11y(this.document, this.view, isVisible).map((issue) => {
      let ref = "";
      for (const [existingRef, element] of this.refs) {
        if (element === issue.element) {
          ref = existingRef;
          break;
        }
      }
      if (!ref && elements.length < MAX_OBSERVED_ELEMENTS) {
        ref = `p${elements.length + 1}`;
        this.refs.set(ref, issue.element);
        const rect = issue.element.getBoundingClientRect();
        elements.push({
          ref,
          tag: issue.tag,
          role: "a11y",
          name: issue.message,
          selector: issue.selector,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          disabled: false,
        });
      }
      return {
        ref: ref || undefined,
        rule: issue.rule,
        message: issue.message,
        selector: issue.selector,
        tag: issue.tag,
      };
    });
    const probes = previewProbeSnapshot(this.view);
    this.ensureOverlay();
    this.setGesture("idle", "WATCH");
    if (this.cursor) this.cursor.dataset.visible = "true";
    this.setStatus(`Observed ${elements.length} target${elements.length === 1 ? "" : "s"}`, true);
    return {
      scope: "active-preview-tab-only",
      tabKind: "project-preview",
      title: compact(this.document.title, 200),
      url: this.document.location.href,
      viewport: {
        width: this.view.innerWidth,
        height: this.view.innerHeight,
        scrollX: Math.round(this.view.scrollX),
        scrollY: Math.round(this.view.scrollY),
        devicePixelRatio: this.view.devicePixelRatio,
      },
      cursor: { x: Math.round(this.cursorPoint.x), y: Math.round(this.cursorPoint.y) },
      elements,
      content: visibleSemanticContent(this.document, this.view),
      a11y,
      console: probes.console,
      network: probes.network,
      hint: "Use element refs with computer_actions. Clicking a table/list row activates its inner link or pointer-row host. a11y lists bounded accessibility hits with the same refs. console/network are page errors and failed fetches only. Prefer wait_for over wait. upload uses Preview fixtures tiny.png, sample.csv, or note.txt. viewport.scrollY is page-only.",
    };
  }

  async runActions(actions: PreviewComputerAction[]): Promise<Record<string, unknown>> {
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.ensureOverlay();
    if (this.refs.size === 0) this.observe();
    const results: Array<Record<string, unknown>> = [];
    try {
      for (let index = 0; index < actions.length; index += 1) {
        if (abortController.signal.aborted) throw abortError();
        const action = actions[index];
        this.setStatus(`${index + 1}/${actions.length} · ${action.type}`, true);
        const detail = await this.runAction(action, abortController.signal);
        results.push({ index, type: action.type, ok: true, ...detail });
      }
      this.setStatus(`Complete · ${actions.length} action${actions.length === 1 ? "" : "s"}`, false);
      const failedChecks = results.filter((result) => result.type === "check" && result.passed === false);
      if (failedChecks.length > 0) this.setStatus(`Checks failed · ${failedChecks.length}`, false);
      return {
        ok: failedChecks.length === 0,
        passed: failedChecks.length === 0,
        scope: "active-preview-tab-only",
        completed: actions.length,
        failedChecks: failedChecks.length,
        results,
        cursor: { x: Math.round(this.cursorPoint.x), y: Math.round(this.cursorPoint.y) },
      };
    } catch (error) {
      // An action error is terminal for this controller batch; never leave a
      // misleading cursor or status badge over the user's page.
      this.destroyOverlay();
      throw error;
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  private ensureOverlay(): void {
    if (this.cursor?.isConnected && this.targetFrame?.isConnected) return;
    const style = this.document.createElement("style");
    style.dataset.hormaComputerUse = "true";
    style.textContent = `
      #__horma-ai-cursor,#__horma-ai-target,#__horma-ai-status,.__horma-ai-fx{box-sizing:border-box!important;pointer-events:none!important;user-select:none!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important}
      #__horma-ai-cursor{position:fixed!important;z-index:2147483646!important;left:0!important;top:0!important;width:0!important;height:0!important;opacity:0;transform:translate3d(32px,32px,0);transform-origin:0 0;will-change:transform,opacity;contain:layout style;overflow:visible;isolation:isolate;transition:opacity .16s ease}
      #__horma-ai-cursor[data-visible="true"]{opacity:1}
      ${aiCursorHandBeforeCss("#__horma-ai-cursor", "::before")}
      ${aiCursorFireCss("#__horma-ai-cursor")}
      #__horma-ai-cursor::after{content:"";position:absolute;left:-10px;top:-10px;width:20px;height:20px;border:1px solid rgba(255,176,64,.7);border-radius:50%;opacity:.18;transform:scale(.72);transition:transform .16s cubic-bezier(.16,1,.3,1),opacity .16s ease}
      #__horma-ai-cursor[data-gesture="approach"]::after{opacity:.8;transform:scale(1)}
      #__horma-ai-cursor[data-gesture="hover"]::before{transform:scale(1.04)}
      #__horma-ai-cursor[data-gesture="hover"]::after,#__horma-ai-cursor[data-gesture="press"]::after,#__horma-ai-cursor[data-gesture="click"]::after{opacity:1;transform:scale(1.22);border-color:#ff7a18;box-shadow:0 0 16px #ff8a1a}
      #__horma-ai-cursor[data-gesture="press"]::before{transform:scale(.94)}
      #__horma-ai-cursor[data-gesture="click"]::before{animation:__horma-click-pop .22s cubic-bezier(.16,1,.3,1)}
      #__horma-ai-cursor[data-gesture="type"]::after,#__horma-ai-cursor[data-gesture="key"]::after{border-color:#ffb020;opacity:.85;transform:scale(.92)}
      #__horma-ai-cursor[data-gesture="scroll"]::after,#__horma-ai-cursor[data-gesture="drag"]::after{border-color:#ffb020;opacity:.9;transform:scale(1)}
      #__horma-ai-cursor-core{position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px #000,0 0 8px #ff7a18;opacity:.95}
      #__horma-ai-cursor-label{position:absolute;left:22px;top:44px;white-space:nowrap;padding:4px 7px;border:1px solid rgba(123,230,255,.76);border-radius:999px;background:#07121ef2;color:#effdff;font:800 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.08em;box-shadow:0 4px 12px rgba(0,0,0,.38);opacity:0;transform:translate3d(0,4px,0);transition:transform .14s cubic-bezier(.16,1,.3,1),opacity .14s ease}
      #__horma-ai-cursor[data-label-x="left"] #__horma-ai-cursor-label{left:auto;right:32px}
      #__horma-ai-cursor[data-label-y="up"] #__horma-ai-cursor-label{top:auto;bottom:32px}
      #__horma-ai-cursor[data-busy="true"] #__horma-ai-cursor-label{opacity:1;transform:translate3d(0,0,0)}
      #__horma-ai-target{position:fixed!important;z-index:2147483644!important;left:0!important;top:0!important;opacity:0;border:1px solid rgba(108,234,255,.94);border-radius:12px;background:linear-gradient(135deg,rgba(108,234,255,.06),rgba(123,97,255,.045));box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 4px rgba(108,234,255,.11),0 0 18px rgba(92,133,255,.22);transform:translate3d(0,0,0) scale(.97);transform-origin:center;will-change:transform,opacity;contain:layout style paint;transition:opacity .14s ease,transform .16s cubic-bezier(.16,1,.3,1)}
      #__horma-ai-target::before{content:"";position:absolute;inset:-3px;border-radius:inherit;background:linear-gradient(#6ceaff,#6ceaff) left top/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) left top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/2px 14px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/2px 14px no-repeat}
      #__horma-ai-target[data-visible="true"]{opacity:.9;transform:translate3d(var(--horma-target-x),var(--horma-target-y),0) scale(1)}
      #__horma-ai-target[data-gesture="press"]{opacity:1;transform:translate3d(var(--horma-target-x),var(--horma-target-y),0) scale(.985)}
      #__horma-ai-target[data-gesture="click"]{border-color:#a58bff;box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 5px rgba(141,115,255,.18),0 0 22px rgba(108,234,255,.28)}
      #__horma-ai-target[data-gesture="boundary"]{border-color:#ffbf69;box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 4px rgba(255,191,105,.18)}
      #__horma-ai-target-label{position:absolute;right:8px;top:-11px;padding:3px 7px;border-radius:999px;background:#07121ef2;color:#dffcff;border:1px solid rgba(108,234,255,.65);font:800 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.08em}
      #__horma-ai-status{position:fixed!important;z-index:2147483647!important;left:18px!important;bottom:18px!important;max-width:min(360px,calc(100vw - 36px));padding:9px 13px;border:1px solid rgba(102,218,255,.44);border-radius:999px;background:#05101cf2;color:#e9fcff;font:700 12px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.05em;box-shadow:0 10px 28px rgba(0,0,0,.32);opacity:.88;transition:opacity .16s ease,border-color .16s ease}
      #__horma-ai-status[data-active="true"]{opacity:1;border-color:rgba(126,104,255,.82)}
      .__horma-ai-trail{position:fixed!important;z-index:2147483643!important;left:0!important;top:0!important;width:7px!important;height:7px!important;border-radius:50%;background:#8bf0ff;box-shadow:0 0 8px #6d8cff;will-change:transform,opacity;contain:strict}
      .__horma-ai-shockwave{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;width:20px!important;height:20px!important;margin:-10px 0 0 -10px;border:2px solid #79efff;border-radius:50%;box-shadow:0 0 0 2px rgba(126,92,255,.42),0 0 16px rgba(105,103,255,.55);will-change:transform,opacity;contain:strict}
      .__horma-ai-scroll-cue{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;color:#effdff;background:#07121ee8;border:1px solid #6ceaff;border-radius:999px;padding:5px 8px;font:900 13px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;will-change:transform,opacity;contain:layout style paint}
      @keyframes __horma-click-pop{0%{transform:scale(.86)}55%{transform:scale(1.08)}100%{transform:scale(1)}}
      @media(prefers-reduced-motion:reduce){#__horma-ai-cursor::before,#__horma-ai-cursor::after,#__horma-ai-target,#__horma-ai-cursor-label,.__horma-ai-fire i{animation:none!important;transition-duration:.01ms!important}.__horma-ai-trail,.__horma-ai-shockwave,.__horma-ai-fire{display:none!important}}
    `;
    this.document.head?.appendChild(style);
    this.overlayStyle = style;
    this.cursor = this.document.createElement("div");
    this.cursor.id = "__horma-ai-cursor";
    this.cursor.setAttribute("aria-hidden", "true");
    this.cursorCore = this.document.createElement("span");
    this.cursorCore.id = "__horma-ai-cursor-core";
    this.cursorLabel = this.document.createElement("span");
    this.cursorLabel.id = "__horma-ai-cursor-label";
    this.cursorLabel.textContent = "AI";
    this.cursor.append(this.cursorCore, this.cursorLabel);
    attachAiCursorFire(this.cursor, (tag) => this.document.createElement(tag));
    this.targetFrame = this.document.createElement("div");
    this.targetFrame.id = "__horma-ai-target";
    this.targetFrame.setAttribute("aria-hidden", "true");
    this.targetPlate = this.document.createElement("span");
    this.targetPlate.id = "__horma-ai-target-label";
    this.targetPlate.textContent = "TARGET";
    this.targetFrame.append(this.targetPlate);
    this.status = this.document.createElement("div");
    this.status.id = "__horma-ai-status";
    this.status.setAttribute("aria-hidden", "true");
    this.status.textContent = "AI cursor · Preview only";
    (this.document.body || this.document.documentElement).append(
      this.targetFrame, this.cursor, this.status,
    );
    this.placeCursor(this.cursorPoint);
    this.installHumanTakeover();
  }

  private installHumanTakeover(): void {
    if (this.humanTakeoverHandler) return;
    this.humanTakeoverHandler = (event: Event) => {
      if ("isTrusted" in event && !(event as Event & { isTrusted: boolean }).isTrusted) return;
      this.hideVisuals();
    };
    if (typeof this.document.addEventListener === "function") {
      for (const type of ["pointermove", "pointerdown", "wheel", "keydown"]) {
        this.document.addEventListener(type, this.humanTakeoverHandler, true);
      }
    }
  }

  private destroyOverlay(): void {
    if (this.humanTakeoverHandler && typeof this.document.removeEventListener === "function") {
      for (const type of ["pointermove", "pointerdown", "wheel", "keydown"]) {
        this.document.removeEventListener(type, this.humanTakeoverHandler, true);
      }
    }
    this.humanTakeoverHandler = null;
    for (const effect of this.transientFx.splice(0)) effect.remove();
    this.targetFrame?.remove();
    this.cursor?.remove();
    this.status?.remove();
    this.overlayStyle?.remove();
    this.targetFrame = null;
    this.targetPlate = null;
    this.cursor = null;
    this.cursorCore = null;
    this.cursorLabel = null;
    this.status = null;
    this.overlayStyle = null;
  }

  private reducedMotion(): boolean {
    return Boolean(this.view.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }

  private setGesture(gesture: string, label = gesture.toUpperCase()): void {
    this.ensureOverlay();
    if (this.cursor) {
      this.cursor.dataset.visible = "true";
      this.cursor.dataset.gesture = gesture;
      this.cursor.dataset.busy = String(gesture !== "idle");
    }
    if (this.cursorLabel) this.cursorLabel.textContent = `AI · ${label}`;
    replayAiCursorFire(this.cursor, gesture);
  }

  private setStatus(text: string, active: boolean): void {
    this.ensureOverlay();
    if (this.status) {
      this.status.textContent = `AI cursor · ${text}`;
      this.status.dataset.active = String(active);
    }
    if (this.cursor) {
      this.cursor.dataset.visible = "true";
      this.cursor.dataset.busy = String(active || this.cursor.dataset.gesture !== "idle");
    }
  }

  private hideVisuals(): void {
    if (this.cursor) {
      this.cursor.dataset.visible = "false";
      this.cursor.dataset.busy = "false";
      this.cursor.dataset.gesture = "idle";
    }
    if (this.targetFrame) this.targetFrame.dataset.visible = "false";
  }

  private registerTransient(element: HTMLElement, ttl: number): void {
    element.dataset.hormaAiFx = "transient";
    this.transientFx.push(element);
    while (this.transientFx.length > MAX_CURSOR_TRANSIENTS) this.transientFx.shift()?.remove();
    this.view.setTimeout(() => {
      element.remove();
      this.transientFx = this.transientFx.filter((candidate) => candidate !== element);
    }, ttl);
  }

  private visualTarget(element: Element | null): Element | null {
    let node = element;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (node === this.document.body || node === this.document.documentElement) break;
      try {
        if (node.matches(FEATURE_SELECTOR)) return node;
      } catch { /* ignore an exotic page selector implementation */ }
    }
    return element && element !== this.document.body && element !== this.document.documentElement
      ? element
      : null;
  }

  private showTarget(element: Element | null, gesture: string): void {
    const target = this.visualTarget(element);
    if (!target || !this.targetFrame) {
      if (this.targetFrame) this.targetFrame.dataset.visible = "false";
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const padding = 6;
    const x = clamp(rect.left - padding, 2, Math.max(2, this.view.innerWidth - 6));
    const y = clamp(rect.top - padding, 2, Math.max(2, this.view.innerHeight - 6));
    const width = clamp(rect.width + padding * 2, 8, Math.max(8, this.view.innerWidth - x - 2));
    const height = clamp(rect.height + padding * 2, 8, Math.max(8, this.view.innerHeight - y - 2));
    const targetStyle = this.targetFrame.style as CSSStyleDeclaration & Record<string, string>;
    if (typeof targetStyle.setProperty === "function") {
      targetStyle.setProperty("--horma-target-x", `${x}px`);
      targetStyle.setProperty("--horma-target-y", `${y}px`);
    } else {
      targetStyle["--horma-target-x"] = `${x}px`;
      targetStyle["--horma-target-y"] = `${y}px`;
    }
    this.targetFrame.style.width = `${width}px`;
    this.targetFrame.style.height = `${height}px`;
    this.targetFrame.dataset.gesture = gesture;
    this.targetFrame.dataset.visible = "true";
    if (this.targetPlate) this.targetPlate.textContent = gesture.toUpperCase();
  }

  private async flashPress(signal: AbortSignal): Promise<void> {
    this.setGesture("press", "CLICK");
    if (!this.reducedMotion()) await delay(58, signal);
  }

  private emitTrail(start: Point, target: Point): void {
    if (this.reducedMotion()) return;
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    if (distance < 52) return;
    const count = Math.min(MAX_CURSOR_TRAIL_SPARKS, Math.max(2, Math.round(distance / 180) + 1));
    for (let index = 1; index <= count; index += 1) {
      const ratio = index / (count + 1);
      const x = start.x + (target.x - start.x) * ratio;
      const y = start.y + (target.y - start.y) * ratio;
      const trail = this.document.createElement("i");
      trail.className = "__horma-ai-trail";
      (this.document.body || this.document.documentElement).appendChild(trail);
      this.registerTransient(trail, 340);
      trail.animate?.([
        { opacity: .72, transform: `translate3d(${x}px,${y}px,0) scale(1)` },
        { opacity: 0, transform: `translate3d(${x - 4}px,${y - 4}px,0) scale(.12)` },
      ], { duration: 300, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
    }
  }

  private shockwave(point: Point): void {
    if (this.reducedMotion()) return;
    const wave = this.document.createElement("i");
    wave.className = "__horma-ai-shockwave";
    (this.document.body || this.document.documentElement).appendChild(wave);
    this.registerTransient(wave, 520);
    wave.animate?.([
      { opacity: .9, transform: `translate3d(${point.x}px,${point.y}px,0) scale(.35)` },
      { opacity: 0, transform: `translate3d(${point.x}px,${point.y}px,0) scale(3.5)` },
    ], { duration: 460, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
  }

  private scrollCue(point: Point, x: number, y: number, boundary: boolean): void {
    const cue = this.document.createElement("i");
    cue.className = "__horma-ai-scroll-cue";
    const horizontal = Math.abs(x) > Math.abs(y);
    const label = horizontal ? (x >= 0 ? "→" : "←") : (y >= 0 ? "↓" : "↑");
    cue.textContent = boundary ? `!${label}` : label;
    (this.document.body || this.document.documentElement).appendChild(cue);
    this.registerTransient(cue, 380);
    const tx = horizontal ? Math.sign(x || 1) * 11 : 0;
    const ty = horizontal ? 0 : Math.sign(y || 1) * 11;
    cue.animate?.([
      { opacity: .92, transform: `translate3d(${point.x + 18}px,${point.y + 18}px,0)` },
      { opacity: 0, transform: `translate3d(${point.x + 18 + tx}px,${point.y + 18 + ty}px,0)` },
    ], { duration: this.reducedMotion() ? 1 : 340, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
  }

  private placeCursor(point: Point): void {
    this.cursorPoint = {
      x: clamp(point.x, 0, Math.max(0, this.view.innerWidth - 1)),
      y: clamp(point.y, 0, Math.max(0, this.view.innerHeight - 1)),
    };
    if (this.cursor) {
      this.cursor.style.transform = `translate3d(${this.cursorPoint.x}px,${this.cursorPoint.y}px,0)`;
      this.cursor.dataset.labelX = this.cursorPoint.x > this.view.innerWidth - 150 ? "left" : "right";
      this.cursor.dataset.labelY = this.cursorPoint.y > this.view.innerHeight - 56 ? "up" : "down";
    }
  }

  private async animateTo(point: Point, signal: AbortSignal, duration?: number): Promise<void> {
    this.ensureOverlay();
    if (signal.aborted) throw abortError();
    const target = {
      x: clamp(point.x, 0, Math.max(0, this.view.innerWidth - 1)),
      y: clamp(point.y, 0, Math.max(0, this.view.innerHeight - 1)),
    };
    const start = this.cursorPoint;
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const requested = duration == null ? 45 + distance * .22 : duration;
    const actualDuration = this.reducedMotion() || distance < 2
      ? 0
      : (requested === 0 ? 0 : clamp(requested, 45, 120));
    this.setGesture("approach", "TARGET");
    this.emitTrail(start, target);
    if (this.cursor && actualDuration > 0 && typeof this.cursor.animate === "function") {
      const animation = this.cursor.animate([
        { transform: `translate3d(${start.x}px,${start.y}px,0)` },
        { transform: `translate3d(${(start.x + target.x) / 2}px,${Math.min(start.y, target.y) - Math.min(18, distance * .06)}px,0)` },
        { transform: `translate3d(${target.x}px,${target.y}px,0)` },
      ], { duration: actualDuration, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" });
      const onAbort = () => animation.cancel();
      signal.addEventListener("abort", onAbort, { once: true });
      try { await animation.finished; } catch { if (signal.aborted) throw abortError(); }
      finally {
        signal.removeEventListener("abort", onAbort);
        animation.cancel();
      }
    }
    this.placeCursor(target);
  }

  private resolve(action: PreviewComputerAction, end = false): ResolvedTarget {
    const ref = end ? action.end_ref : action.ref;
    const selector = end ? action.end_selector : action.selector;
    const hadExplicitTarget = Boolean(ref || selector);
    const x = end ? action.end_x : action.x;
    const y = end ? action.end_y : action.y;
    let element: Element | null = null;
    if (ref) {
      element = this.refs.get(ref) || null;
      if (element && !element.isConnected) {
        this.refs.delete(ref);
        element = null;
      }
      if (!element && !selector) {
        throw new Error(`Stale Preview ref "${ref}". Call computer_observe again before continuing.`);
      }
    }
    if (!element && selector) {
      try { element = this.document.querySelector(selector); }
      catch { throw new Error(`Invalid preview selector: ${selector}`); }
    }
    if (!element && Number.isFinite(x) && Number.isFinite(y)) {
      element = this.document.elementFromPoint(Number(x), Number(y));
    }
    if (!element && hadExplicitTarget) {
      throw new Error("The requested Preview target is no longer available. Call computer_observe again.");
    }
    if (!element && !end) element = this.document.activeElement;
    if (element) {
      const rect = element.getBoundingClientRect();
      return {
        element,
        point: {
          x: Number.isFinite(x) ? Number(x) : rect.left + rect.width / 2,
          y: Number.isFinite(y) ? Number(y) : rect.top + rect.height / 2,
        },
      };
    }
    if (Number.isFinite(x) && Number.isFinite(y)) return { element: null, point: { x: Number(x), y: Number(y) } };
    throw new Error(`Preview action needs a current element ref, selector, or x/y coordinates.`);
  }

  private scrollCandidates(element: Element | null): Array<PreviewScrollCandidate<Element | Window>> {
    const candidates: Array<PreviewScrollCandidate<Element | Window>> = [];
    const seen = new Set<Element>();
    let node: Element | null = element;
    while (node) {
      const position = scrollableElementPosition(node, this.view);
      if (!seen.has(node) && position) {
        seen.add(node);
        candidates.push({ target: node, position });
      }
      node = node.parentElement;
    }
    const page = this.document.scrollingElement;
    if (page && !seen.has(page)) candidates.push({ target: this.view, position: elementScrollPosition(page) });
    return candidates;
  }

  private scrollPosition(target: Element | Window): PreviewScrollPosition {
    if (target === this.view) {
      const page = this.document.scrollingElement;
      if (page) return elementScrollPosition(page);
      return {
        x: Math.round(this.view.scrollX),
        y: Math.round(this.view.scrollY),
        maxX: Math.max(0, Math.round(this.document.documentElement.scrollWidth - this.view.innerWidth)),
        maxY: Math.max(0, Math.round(this.document.documentElement.scrollHeight - this.view.innerHeight)),
      };
    }
    return elementScrollPosition(target as Element);
  }

  private pointerEvent(element: Element, type: string, point: Point, button = 0): void {
    const options: PointerEventInit = {
      bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y,
      button, buttons: type.endsWith("down") ? 1 << button : 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    try { element.dispatchEvent(new PointerEvent(type, options)); }
    catch { element.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), options)); }
  }

  private mouseEvent(element: Element, type: string, point: Point, button = 0, extra: MouseEventInit = {}): void {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this.view,
      clientX: point.x,
      clientY: point.y,
      screenX: point.x,
      screenY: point.y,
      button,
      buttons: type === "mousedown" ? 1 << button : 0,
      detail: type === "click" || type === "dblclick" ? 1 : 0,
      ...extra,
    }));
  }

  private hoverEvents(element: Element, point: Point, button = 0): void {
    for (const type of ["pointerover", "pointerenter", "pointermove"]) {
      this.pointerEvent(element, type, point, button);
    }
    const options: MouseEventInit = {
      bubbles: true, cancelable: true, composed: true,
      clientX: point.x, clientY: point.y, button,
    };
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      element.dispatchEvent(new MouseEvent(type, options));
    }
  }

  private setControlValue(element: Element, value: string): Record<string, unknown> {
    const tag = element.tagName.toLowerCase();
    const html = element as HTMLElement;
    html.focus?.({ preventScroll: true });
    if (tag === "select") {
      const select = element as HTMLSelectElement;
      const desired = String(value);
      const option = Array.from(select.options).find((candidate) =>
        candidate.value === desired
        || compact(candidate.label || candidate.textContent) === compact(desired)
      );
      if (!option) throw new Error(`Select option "${desired}" was not found in the active Preview field.`);
      select.value = option.value;
    } else if (isInputElement(element) || isTextAreaElement(element)) {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const constructor = Object.getPrototypeOf(input)?.constructor as { prototype?: object } | undefined;
      const descriptor = constructor?.prototype
        ? Object.getOwnPropertyDescriptor(constructor.prototype, "value")
        : undefined;
      descriptor?.set?.call(input, String(value));
      if (input.value !== String(value)) input.value = String(value);
    } else if (html.isContentEditable) {
      html.textContent = String(value);
    } else {
      throw new Error("set_value requires an input, textarea, select, or contenteditable target.");
    }
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true, composed: true, inputType: "insertReplacementText", data: String(value),
    }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const control = element as HTMLInputElement;
    const actualValue = "value" in control ? String(control.value) : compact(html.textContent, 240);
    const sensitiveValue = isInputElement(element) && control.type.toLowerCase() === "password";
    const valid = typeof control.checkValidity === "function" ? control.checkValidity() : true;
    return {
      value: sensitiveValue ? "[redacted]" : actualValue,
      inputType: isInputElement(element) ? control.type : tag,
      valid,
      validationMessage: valid ? "" : compact(control.validationMessage, 240),
    };
  }

  private checkExpectation(action: PreviewComputerAction, target: ResolvedTarget): Record<string, unknown> {
    const expected = action.expect || {};
    const element = target.element as HTMLElement | null;
    const actual = {
      visible: Boolean(element && isEffectivelyVisible(element, this.view)),
      enabled: Boolean(element && !((element as HTMLInputElement).disabled)),
      checked: Boolean(element && "checked" in (element as HTMLInputElement)
        ? (element as HTMLInputElement).checked
        : false),
      text: compact(element?.innerText || element?.textContent, 500),
      value: element && isInputElement(element) && element.type.toLowerCase() === "password"
        ? "[redacted]"
        : element && "value" in (element as HTMLInputElement)
          ? String((element as HTMLInputElement).value)
          : "",
      url: this.document.location.href,
      title: this.document.title,
    };
    const match = action.match === "equals"
      ? (actualValue: unknown, expectedValue: unknown) => String(actualValue) === String(expectedValue)
      : (actualValue: unknown, expectedValue: unknown) =>
        String(actualValue).toLocaleLowerCase().includes(String(expectedValue).toLocaleLowerCase());
    const failures: string[] = [];
    for (const key of ["visible", "enabled", "checked"] as const) {
      if (typeof expected[key] === "boolean" && actual[key] !== expected[key]) failures.push(key);
    }
    for (const key of ["text", "value", "url", "title"] as const) {
      if (expected[key] != null && !match(actual[key], expected[key])) failures.push(key);
    }
    const rect = element?.getBoundingClientRect();
    return {
      passed: failures.length === 0,
      failures,
      expected,
      actual,
      rect: rect && rect.width > 0 && rect.height > 0
        ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
        : null,
    };
  }

  private async settleScroll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    if (typeof this.view.requestAnimationFrame !== "function") return;
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        frame += 1;
        if (frame >= 2) {
          signal.removeEventListener("abort", onAbort);
          resolve();
        } else {
          this.view.requestAnimationFrame(tick);
        }
      };
      this.view.requestAnimationFrame(tick);
    });
  }

  private async runAction(action: PreviewComputerAction, signal: AbortSignal): Promise<Record<string, unknown>> {
    const explicitDuration = action.duration_ms == null ? undefined : clamp(Number(action.duration_ms), 0, 900);
    if (action.type === "wait") {
      await delay(clamp(Number(action.duration_ms ?? 180), 0, 10_000), signal);
      return {};
    }
    if (action.type === "wait_for") {
      const timeout = clamp(Number(action.duration_ms ?? 4_000), 50, 10_000);
      const started = Date.now();
      this.setGesture("hover", "WAIT");
      let last: Record<string, unknown> = { passed: false };
      while (Date.now() - started <= timeout) {
        if (signal.aborted) throw abortError();
        if (action.expect && Object.keys(action.expect).length > 0) {
          last = this.checkExpectation(action, this.resolve(action));
        } else {
          last = { passed: previewNetworkIdle(this.view), expected: { network_idle: true } };
        }
        if (last.passed === true) {
          return { ...last, waitedMs: Date.now() - started, timedOut: false };
        }
        await delay(48, signal);
      }
      return { ...last, waitedMs: Date.now() - started, timedOut: true, passed: false };
    }
    if (action.type === "upload") {
      const fixture = String(action.fixture || "tiny.png");
      if (!isPreviewUploadFixture(fixture)) {
        throw new Error("Preview upload fixtures are tiny.png, sample.csv, or note.txt.");
      }
      const target = this.resolve(action);
      const input = target.element as HTMLInputElement | null;
      if (!input || input.tagName.toLowerCase() !== "input" || input.type.toLowerCase() !== "file") {
        throw new Error("upload requires an observed <input type=file> in the active Preview tab.");
      }
      this.showTarget(input, "click");
      this.setGesture("click", "UPLOAD");
      await this.animateTo(target.point, signal, 0);
      assignPreviewFileInput(input, previewFixtureFile(fixture));
      return { fixture, files: input.files?.length ?? 0, name: fixture };
    }
    if (action.type === "scroll") {
      const explicitTarget = Boolean(action.ref || action.selector);
      let target: ResolvedTarget;
      if (explicitTarget || (Number.isFinite(action.x) && Number.isFinite(action.y))) {
        target = this.resolve(action);
      } else {
        target = {
          element: this.document.elementFromPoint(this.cursorPoint.x, this.cursorPoint.y)
            || this.document.scrollingElement,
          point: this.cursorPoint,
        };
      }
      this.showTarget(target.element, "scroll");
      this.setGesture("scroll", "SCROLL");
      await this.animateTo(target.point, signal, explicitDuration);
      const deltaX = clamp(Number(action.delta_x ?? 0), -4_000, 4_000);
      const deltaY = clamp(Number(action.delta_y ?? 520), -4_000, 4_000);
      const candidate = choosePreviewScrollCandidate(this.scrollCandidates(target.element), deltaX, deltaY, explicitTarget);
      if (!candidate) throw new Error("No scrollable region is available in the active Preview tab.");
      const visualScroller = candidate.target === this.view ? target.element : candidate.target as Element;
      this.showTarget(visualScroller, "scroll");
      const before = this.scrollPosition(candidate.target);
      const wheelTarget = target.element || this.document.elementFromPoint(target.point.x, target.point.y);
      wheelTarget?.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, clientX: target.point.x, clientY: target.point.y, deltaX, deltaY,
      }));
      candidate.target.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
      let after = this.scrollPosition(candidate.target);
      if (!previewScrollMoved(before, after)) {
        await this.settleScroll(signal);
        after = this.scrollPosition(candidate.target);
      }
      const moved = previewScrollMoved(before, after);
      this.showTarget(visualScroller, moved ? "scroll" : "boundary");
      this.scrollCue(target.point, after.x - before.x || deltaX, after.y - before.y || deltaY, !moved);
      return {
        target: candidate.target === this.view ? "page" : "nested",
        selector: candidate.target === this.view ? null : selectorFor(candidate.target as Element, this.document),
        requested: { x: deltaX, y: deltaY }, before, after,
        applied: { x: after.x - before.x, y: after.y - before.y },
        moved, boundary: !moved,
      };
    }
    if (action.type === "drag") {
      const start = this.resolve(action);
      const end = this.resolve(action, true);
      if (!start.element) throw new Error("Drag start target was not found in the active Preview tab.");
      this.showTarget(start.element, "drag");
      this.setGesture("drag", "DRAG");
      await this.animateTo(start.point, signal, explicitDuration);
      this.pointerEvent(start.element, "pointerdown", start.point, 0);
      start.element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
      await this.animateTo(end.point, signal, explicitDuration ?? 220);
      const endElement = end.element || this.document.elementFromPoint(end.point.x, end.point.y) || start.element;
      this.showTarget(endElement, "drag");
      this.pointerEvent(endElement, "pointermove", end.point, 0);
      endElement.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: end.point.x, clientY: end.point.y }));
      endElement.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: end.point.x, clientY: end.point.y }));
      this.pointerEvent(endElement, "pointerup", end.point, 0);
      start.element.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      return {};
    }

    const target = this.resolve(action);
    this.showTarget(target.element, action.type);
    const keyboardLike = action.type === "type" || action.type === "key" || action.type === "set_value";
    await this.animateTo(target.point, signal, keyboardLike && explicitDuration == null ? 0 : explicitDuration);
    if (!target.element) return {};
    if (action.type === "move" || action.type === "hover") {
      this.setGesture("hover", "HOVER");
      this.showTarget(target.element, "hover");
      this.hoverEvents(target.element, target.point);
      return {};
    }
    if (action.type === "click") {
      const buttonName = action.button || "left";
      const button = buttonName === "right" ? 2 : buttonName === "middle" ? 1 : 0;
      const html = clickActivationTarget(target.element, target.point, this.document, this.view);
      this.setGesture("hover", "CLICK");
      this.showTarget(html, "hover");
      this.hoverEvents(html, target.point, button);
      await this.flashPress(signal);
      this.showTarget(html, "press");
      this.pointerEvent(html, "pointerdown", target.point, button);
      this.mouseEvent(html, "mousedown", target.point, button);
      html.focus?.({ preventScroll: true });
      this.pointerEvent(html, "pointerup", target.point, button);
      this.mouseEvent(html, "mouseup", target.point, button);
      if (button === 0) {
        const clicks = action.clicks === 2 ? 2 : 1;
        for (let index = 0; index < clicks; index += 1) html.click();
        if (clicks === 2) this.mouseEvent(html, "dblclick", target.point, button, { detail: 2 });
      } else if (button === 2) {
        this.mouseEvent(html, "contextmenu", target.point, 2);
      } else {
        this.mouseEvent(html, "auxclick", target.point, 1);
      }
      this.setGesture("click", "DONE");
      this.showTarget(html, "click");
      this.shockwave(target.point);
      if (action.clicks === 2) this.view.setTimeout(() => this.shockwave(target.point), 110);
      return {};
    }
    if (action.type === "set_value") {
      this.setGesture("type", "SET");
      this.showTarget(target.element, "type");
      return this.setControlValue(target.element, String(action.value ?? action.text ?? ""));
    }
    if (action.type === "type") {
      const active = isEditable(target.element) ? target.element : this.document.activeElement;
      if (!isEditable(active)) throw new Error("Type action target is not an editable field in the active Preview tab.");
      this.setGesture("type", "TYPE");
      this.showTarget(active, "type");
      active.focus({ preventScroll: true });
      this.insertText(active, String(action.text ?? ""), Boolean(action.clear));
      return {
        value: isInputElement(active) && active.type.toLowerCase() === "password"
          ? "[redacted]"
          : isInputElement(active) || isTextAreaElement(active)
            ? active.value
            : compact(active.textContent, 240),
      };
    }
    if (action.type === "key") {
      const element = target.element as HTMLElement;
      this.setGesture("key", "KEY");
      this.showTarget(element, "key");
      element.focus?.({ preventScroll: true });
      this.pressKey(element, String(action.keys || ""));
      return {};
    }
    if (action.type === "check") {
      this.setGesture("hover", "CHECK");
      this.showTarget(target.element, "hover");
      return this.checkExpectation(action, target);
    }
    return {};
  }

  private insertText(element: HTMLElement, text: string, clear: boolean): void {
    if (isInputElement(element) || isTextAreaElement(element)) {
      const current = element.value;
      const start = clear ? 0 : (element.selectionStart ?? current.length);
      const end = clear ? current.length : (element.selectionEnd ?? start);
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      element.setRangeText(text, start, end, "end");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (clear) {
      const range = this.document.createRange();
      range.selectNodeContents(element);
      const selection = this.view.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    if (!this.document.execCommand("insertText", false, text)) element.textContent = clear ? text : `${element.textContent || ""}${text}`;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  private pressKey(element: HTMLElement, chord: string): void {
    const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop() || chord;
    const lower = parts.map((part) => part.toLowerCase());
    const init: KeyboardEventInit = {
      key: key === "Space" ? " " : key,
      code: key === "Space" ? "Space" : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: lower.includes("ctrl") || lower.includes("control"),
      altKey: lower.includes("alt"),
      shiftKey: lower.includes("shift"),
    };
    const allowed = element.dispatchEvent(new KeyboardEvent("keydown", init));
    if (allowed) this.applyKeyDefault(element, key, init);
    element.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  private applyKeyDefault(element: HTMLElement, key: string, init: KeyboardEventInit): void {
    if ((init.ctrlKey || init.metaKey) && key.toLowerCase() === "a" && isEditable(element)) {
      if (isInputElement(element) || isTextAreaElement(element)) element.select();
      else {
        const range = this.document.createRange();
        range.selectNodeContents(element);
        const selection = this.view.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    }
    if (key === "Tab") {
      const focusable = Array.from(this.document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter((item) => isVisible(item, this.view) && item.tabIndex >= 0);
      const index = Math.max(0, focusable.indexOf(element));
      focusable[(index + (init.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      return;
    }
    if (key === "Enter" || key === "Space") {
      if (isButtonElement(element) || isAnchorElement(element)) element.click();
      else if (key === "Enter" && isEditable(element)) element.closest("form")?.requestSubmit();
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)
      && isInputElement(element) && ["number", "range", "date", "time", "datetime-local"].includes(element.type)) {
      if (key === "ArrowUp") element.stepUp?.();
      if (key === "ArrowDown") element.stepDown?.();
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText" }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    if ((key === "Backspace" || key === "Delete") && (isInputElement(element) || isTextAreaElement(element))) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      const from = start === end && key === "Backspace" ? Math.max(0, start - 1) : start;
      const to = start === end && key === "Delete" ? Math.min(element.value.length, end + 1) : end;
      element.setRangeText("", from, to, "end");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: key === "Backspace" ? "deleteContentBackward" : "deleteContentForward" }));
    }
  }

  startRecording(): void {
    this.stopRecording();
    this.recording = [];
    const record = (action: PreviewComputerAction) => {
      if (this.recording && this.recording.length < 48) this.recording.push(action);
    };
    const click = (event: Event) => {
      const target = event.target as Element | null;
      if (!target || !("isTrusted" in event) || !(event as Event & { isTrusted: boolean }).isTrusted) return;
      record({ type: "click", selector: selectorFor(target, this.document) });
    };
    const change = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || !("isTrusted" in event) || !(event as Event & { isTrusted: boolean }).isTrusted) return;
      if (target.type === "file") {
        record({ type: "upload", selector: selectorFor(target, this.document), fixture: "tiny.png" });
        return;
      }
      if (isEditable(target)) {
        record({
          type: "set_value",
          selector: selectorFor(target, this.document),
          value: target.type === "password" ? "" : String(target.value || "").slice(0, 512),
        });
      }
    };
    const keydown = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (!keyEvent.isTrusted) return;
      if (!["Enter", "Tab", "Escape"].includes(keyEvent.key)) return;
      const target = (event.target as Element) || this.document.body;
      record({ type: "key", selector: selectorFor(target, this.document), keys: keyEvent.key });
    };
    this.document.addEventListener("click", click, true);
    this.document.addEventListener("change", change, true);
    this.document.addEventListener("keydown", keydown, true);
    this.recordCleanup = () => {
      this.document.removeEventListener("click", click, true);
      this.document.removeEventListener("change", change, true);
      this.document.removeEventListener("keydown", keydown, true);
    };
  }

  stopRecording(): PreviewComputerAction[] {
    this.recordCleanup?.();
    this.recordCleanup = null;
    const recorded = this.recording || [];
    this.recording = null;
    return recorded;
  }

}

function controllerFor(frame: HTMLIFrameElement): PreviewFrameComputerController {
  let document: Document | null;
  let view: Window | null;
  try {
    document = frame.contentDocument;
    view = frame.contentWindow;
    // Accessing location is the reliable same-origin check for a live-server iframe.
    void view?.location.href;
  } catch {
    throw new Error("This project iframe is cross-origin. Open its URL in a Preview Browser tab so the AI cursor stays isolated inside Preview.");
  }
  if (!document || !view || !document.documentElement) throw new Error("The active Preview tab is not ready yet.");
  let controller = controllers.get(document);
  if (!controller) {
    controller = new PreviewFrameComputerController(document, view);
    controllers.set(document, controller);
  }
  return controller;
}

export async function runFrameComputerUse(
  frame: HTMLIFrameElement,
  request: PreviewComputerRequest,
): Promise<Record<string, unknown>> {
  const controller = controllerFor(frame);
  if (request.operation === "observe") return controller.observe();
  const actions = Array.isArray(request.args.actions)
    ? request.args.actions as PreviewComputerAction[]
    : [];
  if (actions.length === 0) throw new Error("No Preview Computer Use actions were provided.");
  return controller.runActions(actions);
}

export function startFrameRecording(frame?: HTMLIFrameElement | null): void {
  if (!frame) return;
  controllerFor(frame).startRecording();
}

export function stopFrameRecording(frame?: HTMLIFrameElement | null): PreviewComputerAction[] {
  if (!frame) return [];
  try {
    return controllerFor(frame).stopRecording();
  } catch {
    return [];
  }
}

export function stopFrameComputerUse(frame?: HTMLIFrameElement | null): void {
  if (!frame) return;
  try {
    const document = frame.contentDocument;
    if (document) controllers.get(document)?.stop();
  } catch { /* Cross-origin frames are stopped through their isolated Browser command. */ }
}