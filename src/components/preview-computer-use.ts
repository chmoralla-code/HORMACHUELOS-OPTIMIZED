import {
  choosePreviewScrollCandidate,
  previewScrollMoved,
  type PreviewScrollCandidate,
  type PreviewScrollPosition,
} from "./preview-scroll-policy";

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
    | "wait"
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
  keys?: string;
  button?: "left" | "right" | "middle";
  clicks?: number;
  delta_x?: number;
  delta_y?: number;
  duration_ms?: number;
  clear?: boolean;
  /** Safe http(s) address for Preview-native open_tab and navigate actions. */
  url?: string;
  /** Exact Preview tab id returned by computer_observe. */
  tab_id?: string;
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
};

const controllers = new WeakMap<Document, PreviewFrameComputerController>();
const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "textarea", "select", "option", "summary",
  "[contenteditable='true']", "[role='button']", "[role='link']", "[role='checkbox']",
  "[role='radio']", "[role='tab']", "[role='menuitem']", "[role='option']",
  "[tabindex]:not([tabindex='-1'])", "canvas", "video",
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

function isScrollableElement(element: Element, view: Window): element is HTMLElement {
  if (!isHtmlElement(element)) return false;
  const position = elementScrollPosition(element);
  if (position.maxX <= 1 && position.maxY <= 1) return false;
  const style = view.getComputedStyle(element);
  return (position.maxX > 1 && /^(auto|scroll|overlay)$/.test(style.overflowX))
    || (position.maxY > 1 && /^(auto|scroll|overlay)$/.test(style.overflowY));
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
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

class PreviewFrameComputerController {
  private refs = new Map<string, Element>();
  private abortController: AbortController | null = null;
  private cursor: HTMLElement | null = null;
  private cursorCore: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private cursorPoint: Point = { x: 32, y: 32 };

  constructor(private readonly document: Document, private readonly view: Window) {}

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.setStatus("Stopped", false);
    if (this.cursor) this.cursor.dataset.state = "idle";
  }

  observe(): Record<string, unknown> {
    const elements: ObservedElement[] = [];
    this.refs.clear();
    const candidates = Array.from(new Set<Element>([
      ...Array.from(this.document.querySelectorAll(INTERACTIVE_SELECTOR)),
      ...Array.from(this.document.querySelectorAll("*"))
        .filter((element) => isScrollableElement(element, this.view)),
    ]));
    for (const element of candidates) {
      if (elements.length >= 80 || !isVisible(element, this.view)) continue;
      const rect = element.getBoundingClientRect();
      const ref = `p${elements.length + 1}`;
      this.refs.set(ref, element);
      const input = element as HTMLInputElement;
      const observed: ObservedElement = {
        ref,
        tag: element.tagName.toLowerCase(),
        role: compact(element.getAttribute("role") || element.tagName.toLowerCase(), 48),
        name: elementName(element),
        selector: selectorFor(element, this.document),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        disabled: "disabled" in input && Boolean(input.disabled),
      };
      if (isScrollableElement(element, this.view)) {
        observed.scrollable = true;
        observed.scroll = elementScrollPosition(element);
        if (!observed.name) observed.name = "Scrollable region";
      }
      if ("checked" in input && typeof input.checked === "boolean") observed.checked = input.checked;
      if ("value" in input && input.type !== "password" && compact(input.value)) {
        observed.value = compact(input.value, 120);
      }
      elements.push(observed);
    }
    this.ensureOverlay();
    this.setStatus(`Observed ${elements.length} target${elements.length === 1 ? "" : "s"}`, false);
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
      hint: "Use element refs with computer_actions. Scrollable regions include scroll x/y/maxX/maxY; use their ref for nested panes. viewport.scrollY is page-only. Coordinates are relative to this preview viewport.",
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
      return {
        ok: true,
        scope: "active-preview-tab-only",
        completed: actions.length,
        results,
        cursor: { x: Math.round(this.cursorPoint.x), y: Math.round(this.cursorPoint.y) },
      };
    } finally {
      if (this.abortController === abortController) this.abortController = null;
      if (this.cursor) this.cursor.dataset.state = "idle";
    }
  }

  private ensureOverlay(): void {
    if (this.cursor?.isConnected) return;
    const style = this.document.createElement("style");
    style.dataset.hormaComputerUse = "true";
    style.textContent = `
      #__horma-ai-cursor{position:fixed;z-index:2147483646;left:0;top:0;width:48px;height:48px;pointer-events:none;transform:translate3d(32px,32px,0);will-change:transform,opacity;contain:layout style paint;isolation:isolate;transition:opacity .14s ease;}
      #__horma-ai-cursor::before{content:"";position:absolute;inset:2px 14px 14px 2px;border-radius:6px 55% 55% 55%;background:linear-gradient(145deg,#fff 0%,#69e9ff 38%,#775cff 100%);clip-path:polygon(0 0,100% 68%,55% 73%,38% 100%);box-shadow:0 0 0 2px rgba(0,9,20,.86),0 0 18px 4px rgba(79,224,255,.78),0 0 34px rgba(126,92,255,.58);}
      #__horma-ai-cursor::after{content:"";position:absolute;left:-11px;top:-11px;width:58px;height:58px;border:2px solid rgba(105,234,255,.56);border-radius:50%;box-shadow:inset 0 0 14px rgba(111,227,255,.18),0 0 22px rgba(103,100,255,.3);opacity:.72;transform:scale(.88);}
      #__horma-ai-cursor[data-state="active"]::after{animation:__horma-pulse 1s cubic-bezier(.2,.8,.2,1) infinite alternate;}
      #__horma-ai-cursor-core{position:absolute;left:7px;top:7px;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(83,224,255,.55),0 0 14px #fff;}
      #__horma-ai-cursor-label{position:absolute;left:30px;top:30px;padding:3px 6px;border:1px solid rgba(123,230,255,.72);border-radius:999px;background:rgba(4,12,24,.94);color:#effdff;font:800 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;box-shadow:0 4px 14px rgba(0,0,0,.42),0 0 12px rgba(91,220,255,.34);}
      #__horma-ai-status{position:fixed;z-index:2147483647;left:18px;bottom:18px;max-width:min(360px,calc(100vw - 36px));pointer-events:none;padding:9px 13px;border:1px solid rgba(102,218,255,.44);border-radius:999px;background:rgba(5,13,22,.94);color:#e9fcff;font:700 12px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.05em;box-shadow:0 10px 28px rgba(0,0,0,.32),inset 0 0 20px rgba(82,192,255,.08);opacity:.9;transition:opacity .16s ease,border-color .16s ease;}
      #__horma-ai-status[data-active="true"]{opacity:1;border-color:rgba(126,104,255,.82);}
      .__horma-ai-ripple{position:fixed;z-index:2147483645;width:18px;height:18px;margin:-9px 0 0 -9px;border:3px solid #79efff;border-radius:50%;pointer-events:none;will-change:transform,opacity;box-shadow:0 0 18px rgba(105,103,255,.7);animation:__horma-ripple .54s cubic-bezier(.2,.8,.2,1) forwards;}
      .__horma-ai-trail{position:fixed;z-index:2147483644;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;pointer-events:none;will-change:transform,opacity;background:#8bf0ff;box-shadow:0 0 15px #6d8cff;animation:__horma-trail .46s ease-out forwards;}
      @keyframes __horma-pulse{from{opacity:.42;transform:scale(.78)}to{opacity:.95;transform:scale(1.08)}}
      @keyframes __horma-ripple{from{opacity:.95;transform:scale(.2)}to{opacity:0;transform:scale(4.2)}}
      @keyframes __horma-trail{from{opacity:.9;transform:scale(1)}to{opacity:0;transform:scale(.08)}}
      @media(prefers-reduced-motion:reduce){#__horma-ai-cursor[data-state="active"]::after{animation:none}.__horma-ai-ripple,.__horma-ai-trail{animation-duration:.01ms!important}}
    `;
    this.document.head?.appendChild(style);
    this.cursor = this.document.createElement("div");
    this.cursor.id = "__horma-ai-cursor";
    this.cursor.setAttribute("aria-hidden", "true");
    this.cursorCore = this.document.createElement("span");
    this.cursorCore.id = "__horma-ai-cursor-core";
    const cursorLabel = this.document.createElement("span");
    cursorLabel.id = "__horma-ai-cursor-label";
    cursorLabel.textContent = "AI";
    this.cursor.append(this.cursorCore, cursorLabel);
    this.status = this.document.createElement("div");
    this.status.id = "__horma-ai-status";
    this.status.setAttribute("aria-hidden", "true");
    this.status.textContent = "AI cursor · Preview only";
    (this.document.body || this.document.documentElement).append(this.cursor, this.status);
    this.placeCursor(this.cursorPoint);
  }

  private setStatus(text: string, active: boolean): void {
    this.ensureOverlay();
    if (this.status) {
      this.status.textContent = `AI cursor · ${text}`;
      this.status.dataset.active = String(active);
    }
    if (this.cursor) this.cursor.dataset.state = active ? "active" : "idle";
  }

  private placeCursor(point: Point): void {
    this.cursorPoint = {
      x: clamp(point.x, 0, Math.max(0, this.view.innerWidth - 1)),
      y: clamp(point.y, 0, Math.max(0, this.view.innerHeight - 1)),
    };
    if (this.cursor) this.cursor.style.transform = `translate3d(${this.cursorPoint.x}px,${this.cursorPoint.y}px,0)`;
  }

  private async animateTo(point: Point, signal: AbortSignal, duration = 180): Promise<void> {
    this.ensureOverlay();
    if (signal.aborted) throw abortError();
    const target = {
      x: clamp(point.x, 0, Math.max(0, this.view.innerWidth - 1)),
      y: clamp(point.y, 0, Math.max(0, this.view.innerHeight - 1)),
    };
    const start = this.cursorPoint;
    const reduced = this.view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const actualDuration = reduced ? 0 : clamp(duration, 0, 900);
    if (this.cursor && actualDuration > 0 && typeof this.cursor.animate === "function") {
      const trail = this.document.createElement("i");
      trail.className = "__horma-ai-trail";
      trail.style.left = `${start.x}px`;
      trail.style.top = `${start.y}px`;
      (this.document.body || this.document.documentElement).appendChild(trail);
      this.view.setTimeout(() => trail.remove(), 500);
      const animation = this.cursor.animate([
        { transform: `translate3d(${start.x}px,${start.y}px,0)` },
        { transform: `translate3d(${target.x}px,${target.y}px,0)` },
      ], { duration: actualDuration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
      const onAbort = () => animation.cancel();
      signal.addEventListener("abort", onAbort, { once: true });
      try { await animation.finished; } catch { if (signal.aborted) throw abortError(); }
      finally { signal.removeEventListener("abort", onAbort); }
    }
    this.placeCursor(target);
  }

  private resolve(action: PreviewComputerAction, end = false): ResolvedTarget {
    const ref = end ? action.end_ref : action.ref;
    const selector = end ? action.end_selector : action.selector;
    const x = end ? action.end_x : action.x;
    const y = end ? action.end_y : action.y;
    let element: Element | null = null;
    if (ref) element = this.refs.get(ref) || null;
    if (!element && selector) {
      try { element = this.document.querySelector(selector); }
      catch { throw new Error(`Invalid preview selector: ${selector}`); }
    }
    if (!element && Number.isFinite(x) && Number.isFinite(y)) {
      element = this.document.elementFromPoint(Number(x), Number(y));
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
      if (!seen.has(node) && isScrollableElement(node, this.view)) {
        seen.add(node);
        candidates.push({ target: node, position: elementScrollPosition(node) });
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

  private async runAction(action: PreviewComputerAction, signal: AbortSignal): Promise<Record<string, unknown>> {
    const duration = clamp(Number(action.duration_ms ?? 180), 0, 900);
    if (action.type === "wait") {
      await delay(clamp(Number(action.duration_ms ?? 250), 0, 10_000), signal);
      return {};
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
      await this.animateTo(target.point, signal, duration);
      const deltaX = clamp(Number(action.delta_x ?? 0), -4_000, 4_000);
      const deltaY = clamp(Number(action.delta_y ?? 520), -4_000, 4_000);
      const candidate = choosePreviewScrollCandidate(this.scrollCandidates(target.element), deltaX, deltaY, explicitTarget);
      if (!candidate) throw new Error("No scrollable region is available in the active Preview tab.");
      const before = this.scrollPosition(candidate.target);
      const wheelTarget = target.element || this.document.elementFromPoint(target.point.x, target.point.y);
      wheelTarget?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: target.point.x, clientY: target.point.y, deltaX, deltaY }));
      candidate.target.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
      await delay(90, signal);
      const after = this.scrollPosition(candidate.target);
      const moved = previewScrollMoved(before, after);
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
      await this.animateTo(start.point, signal, duration);
      this.pointerEvent(start.element, "pointerdown", start.point, 0);
      start.element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
      await this.animateTo(end.point, signal, Math.max(220, duration));
      const endElement = end.element || this.document.elementFromPoint(end.point.x, end.point.y) || start.element;
      this.pointerEvent(endElement, "pointermove", end.point, 0);
      endElement.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: end.point.x, clientY: end.point.y }));
      endElement.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: end.point.x, clientY: end.point.y }));
      this.pointerEvent(endElement, "pointerup", end.point, 0);
      start.element.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      return {};
    }

    const target = this.resolve(action);
    await this.animateTo(target.point, signal, duration);
    if (!target.element) return {};
    if (action.type === "move" || action.type === "hover") {
      for (const type of ["pointerover", "pointerenter", "pointermove"]) this.pointerEvent(target.element, type, target.point);
      return {};
    }
    if (action.type === "click") {
      const buttonName = action.button || "left";
      const button = buttonName === "right" ? 2 : buttonName === "middle" ? 1 : 0;
      const html = target.element as HTMLElement;
      this.pointerEvent(target.element, "pointerover", target.point, button);
      this.pointerEvent(target.element, "pointerdown", target.point, button);
      html.focus?.({ preventScroll: true });
      this.pointerEvent(target.element, "pointerup", target.point, button);
      if (button === 0) {
        const clicks = action.clicks === 2 ? 2 : 1;
        for (let index = 0; index < clicks; index += 1) html.click();
        if (clicks === 2) target.element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: target.point.x, clientY: target.point.y }));
      } else if (button === 2) {
        target.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: target.point.x, clientY: target.point.y, button: 2 }));
      } else {
        target.element.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, clientX: target.point.x, clientY: target.point.y, button: 1 }));
      }
      this.ripple(target.point);
      return {};
    }
    if (action.type === "type") {
      const active = isEditable(target.element) ? target.element : this.document.activeElement;
      if (!isEditable(active)) throw new Error("Type action target is not an editable field in the active Preview tab.");
      active.focus({ preventScroll: true });
      this.insertText(active, String(action.text ?? ""), Boolean(action.clear));
      return {};
    }
    if (action.type === "key") {
      const element = target.element as HTMLElement;
      element.focus?.({ preventScroll: true });
      this.pressKey(element, String(action.keys || ""));
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
    if (key === "Enter") {
      if (isButtonElement(element) || isAnchorElement(element)) element.click();
      else if (isEditable(element)) element.closest("form")?.requestSubmit();
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

  private ripple(point: Point): void {
    const ripple = this.document.createElement("i");
    ripple.className = "__horma-ai-ripple";
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    (this.document.body || this.document.documentElement).appendChild(ripple);
    this.view.setTimeout(() => ripple.remove(), 520);
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

export function stopFrameComputerUse(frame?: HTMLIFrameElement | null): void {
  if (!frame) return;
  try {
    const document = frame.contentDocument;
    if (document) controllers.get(document)?.stop();
  } catch { /* Cross-origin frames are stopped through their isolated Browser command. */ }
}