import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ComputerUseFxEvent } from "./ipc";

const MAX_CURSOR_TRAIL_SPARKS = 3;
const MAX_CURSOR_TRANSIENTS = 8;
const IDLE_HIDE_MS = 1400;
const HUMAN_DIVERGE_PX = 28;

const root = document.getElementById("fx-root") as HTMLDivElement;
const overlayWindow = getCurrentWindow();

let cursor: HTMLElement | null = null;
let cursorLabel: HTMLElement | null = null;
let targetFrame: HTMLElement | null = null;
let targetPlate: HTMLElement | null = null;
let status: HTMLElement | null = null;
let hideTimer: number | null = null;
let lastX = 32;
let lastY = 32;
const transients: HTMLElement[] = [];

function reducedMotion(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureOverlay(): void {
  if (cursor?.isConnected && targetFrame?.isConnected) return;
  const style = document.createElement("style");
  style.textContent = `
    #__horma-ai-cursor,#__horma-ai-target,#__horma-ai-status,.__horma-ai-fx{box-sizing:border-box!important;pointer-events:none!important;user-select:none!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important}
    #__horma-ai-cursor{position:fixed!important;z-index:2147483646!important;left:0!important;top:0!important;width:52px!important;height:52px!important;opacity:0;transform:translate3d(32px,32px,0);will-change:transform,opacity;contain:layout style paint;isolation:isolate;transition:opacity .16s ease}
    #__horma-ai-cursor[data-visible="true"]{opacity:1}
    #__horma-ai-cursor::before{content:"";position:absolute;inset:1px 17px 15px 1px;border-radius:7px 58% 58% 58%;background:linear-gradient(145deg,#f7feff 0%,#68e7ff 42%,#7b61ff 100%);clip-path:polygon(0 0,100% 69%,57% 74%,39% 100%);box-shadow:0 0 0 2px #03101ee6,0 0 12px rgba(87,221,255,.82);transform-origin:7px 7px;transition:transform .12s cubic-bezier(.16,1,.3,1),opacity .12s ease}
    #__horma-ai-cursor::after{content:"";position:absolute;left:-12px;top:-12px;width:48px;height:48px;border:1px solid rgba(108,234,255,.7);border-radius:50%;opacity:.2;transform:scale(.72);transition:transform .16s cubic-bezier(.16,1,.3,1),opacity .16s ease}
    #__horma-ai-cursor[data-gesture="approach"]::after{opacity:.82;transform:scale(1)}
    #__horma-ai-cursor[data-gesture="hover"]::before{transform:scale(1.06) rotate(-2deg)}
    #__horma-ai-cursor[data-gesture="press"]::before{transform:scale(.86) rotate(-3deg)}
    #__horma-ai-cursor[data-gesture="click"]::before{animation:__horma-click-pop .22s cubic-bezier(.16,1,.3,1)}
    #__horma-ai-cursor[data-gesture="type"]::after,#__horma-ai-cursor[data-gesture="key"]::after{border-color:#a693ff;opacity:.85;transform:scale(.92)}
    #__horma-ai-cursor[data-gesture="scroll"]::after,#__horma-ai-cursor[data-gesture="drag"]::after{border-color:#6ceaff;opacity:.9;transform:scale(1)}
    #__horma-ai-cursor-core{position:absolute;left:5px;top:5px;width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(83,224,255,.5),0 0 12px #fff}
    #__horma-ai-cursor-label{position:absolute;left:28px;top:30px;white-space:nowrap;padding:4px 7px;border:1px solid rgba(123,230,255,.76);border-radius:999px;background:#07121ef2;color:#effdff;font:800 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.08em;box-shadow:0 4px 12px rgba(0,0,0,.38);opacity:0;transform:translate3d(0,4px,0);transition:transform .14s cubic-bezier(.16,1,.3,1),opacity .14s ease}
    #__horma-ai-cursor[data-busy="true"] #__horma-ai-cursor-label{opacity:1;transform:translate3d(0,0,0)}
    #__horma-ai-target{position:fixed!important;z-index:2147483644!important;left:0!important;top:0!important;opacity:0;border:1px solid rgba(108,234,255,.94);border-radius:12px;background:linear-gradient(135deg,rgba(108,234,255,.06),rgba(123,97,255,.045));box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 4px rgba(108,234,255,.11),0 0 18px rgba(92,133,255,.22);transform:translate3d(0,0,0) scale(.97);transform-origin:center;will-change:transform,opacity;contain:layout style paint;transition:opacity .14s ease,transform .16s cubic-bezier(.16,1,.3,1)}
    #__horma-ai-target::before{content:"";position:absolute;inset:-3px;border-radius:inherit;background:linear-gradient(#6ceaff,#6ceaff) left top/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) left top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/2px 14px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/2px 14px no-repeat}
    #__horma-ai-target[data-visible="true"]{opacity:.9;transform:translate3d(var(--horma-target-x),var(--horma-target-y),0) scale(1)}
    #__horma-ai-target[data-gesture="press"]{opacity:1;transform:translate3d(var(--horma-target-x),var(--horma-target-y),0) scale(.985)}
    #__horma-ai-target[data-gesture="click"]{border-color:#a58bff;box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 5px rgba(141,115,255,.18),0 0 22px rgba(108,234,255,.28)}
    #__horma-ai-target-label{position:absolute;right:8px;top:-11px;padding:3px 7px;border-radius:999px;background:#07121ef2;color:#dffcff;border:1px solid rgba(108,234,255,.65);font:800 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.08em}
    #__horma-ai-status{position:fixed!important;z-index:2147483647!important;left:18px!important;bottom:18px!important;max-width:min(360px,calc(100vw - 36px));padding:9px 13px;border:1px solid rgba(102,218,255,.44);border-radius:999px;background:#05101cf2;color:#e9fcff;font:700 12px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace!important;letter-spacing:.05em;box-shadow:0 10px 28px rgba(0,0,0,.32);opacity:.88}
    .__horma-ai-trail{position:fixed!important;z-index:2147483643!important;left:0!important;top:0!important;width:7px!important;height:7px!important;border-radius:50%;background:#8bf0ff;box-shadow:0 0 8px #6d8cff;will-change:transform,opacity;contain:strict}
    .__horma-ai-shockwave{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;width:20px!important;height:20px!important;margin:-10px 0 0 -10px;border:2px solid #79efff;border-radius:50%;box-shadow:0 0 0 2px rgba(126,92,255,.42),0 0 16px rgba(105,103,255,.55);will-change:transform,opacity;contain:strict}
    .__horma-ai-scroll-cue{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;color:#effdff;background:#07121ee8;border:1px solid #6ceaff;border-radius:999px;padding:5px 8px;font:900 13px/1 ui-monospace,SFMono-Regular,Consolas,monospace!important;will-change:transform,opacity;contain:layout style paint}
    @keyframes __horma-click-pop{0%{transform:scale(.86)}55%{transform:scale(1.08)}100%{transform:scale(1)}}
    @media(prefers-reduced-motion:reduce){#__horma-ai-cursor::before,#__horma-ai-cursor::after,#__horma-ai-target,#__horma-ai-cursor-label{animation:none!important;transition-duration:.01ms!important}.__horma-ai-trail,.__horma-ai-shockwave{display:none!important}}
  `;
  document.head.appendChild(style);
  cursor = document.createElement("div");
  cursor.id = "__horma-ai-cursor";
  cursor.setAttribute("aria-hidden", "true");
  const core = document.createElement("span");
  core.id = "__horma-ai-cursor-core";
  cursorLabel = document.createElement("span");
  cursorLabel.id = "__horma-ai-cursor-label";
  cursorLabel.textContent = "AI";
  cursor.append(core, cursorLabel);
  targetFrame = document.createElement("div");
  targetFrame.id = "__horma-ai-target";
  targetFrame.setAttribute("aria-hidden", "true");
  targetPlate = document.createElement("span");
  targetPlate.id = "__horma-ai-target-label";
  targetPlate.textContent = "TARGET";
  targetFrame.append(targetPlate);
  status = document.createElement("div");
  status.id = "__horma-ai-status";
  status.setAttribute("aria-hidden", "true");
  status.textContent = "AI cursor · Desktop";
  root.append(targetFrame, cursor, status);
}

function setGesture(gesture: string, label = gesture.toUpperCase()): void {
  ensureOverlay();
  if (cursor) {
    cursor.dataset.visible = "true";
    cursor.dataset.gesture = gesture;
    cursor.dataset.busy = String(gesture !== "idle");
  }
  if (cursorLabel) cursorLabel.textContent = `AI · ${label}`;
  if (status) status.textContent = `AI cursor · Desktop · ${label}`;
}

function placeCursor(x: number, y: number): void {
  ensureOverlay();
  lastX = x;
  lastY = y;
  if (!cursor) return;
  cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
  cursor.dataset.labelX = x > window.innerWidth - 120 ? "left" : "right";
  cursor.dataset.labelY = y > window.innerHeight - 80 ? "up" : "down";
}

function showTarget(x: number, y: number, width: number, height: number, gesture: string): void {
  ensureOverlay();
  if (!targetFrame) return;
  const pad = 6;
  const left = clamp(x - pad, 2, Math.max(2, window.innerWidth - 8));
  const top = clamp(y - pad, 2, Math.max(2, window.innerHeight - 8));
  targetFrame.style.setProperty("--horma-target-x", `${left}px`);
  targetFrame.style.setProperty("--horma-target-y", `${top}px`);
  targetFrame.style.width = `${clamp(width + pad * 2, 8, Math.max(8, window.innerWidth - left - 2))}px`;
  targetFrame.style.height = `${clamp(height + pad * 2, 8, Math.max(8, window.innerHeight - top - 2))}px`;
  targetFrame.dataset.gesture = gesture;
  targetFrame.dataset.visible = "true";
  if (targetPlate) targetPlate.textContent = gesture.toUpperCase();
}

function registerTransient(element: HTMLElement, ttl: number): void {
  transients.push(element);
  while (transients.length > MAX_CURSOR_TRANSIENTS) transients.shift()?.remove();
  window.setTimeout(() => {
    element.remove();
    const index = transients.indexOf(element);
    if (index >= 0) transients.splice(index, 1);
  }, ttl);
}

function emitTrail(startX: number, startY: number, x: number, y: number): void {
  if (reducedMotion()) return;
  const distance = Math.hypot(x - startX, y - startY);
  if (distance < 52) return;
  const count = Math.min(MAX_CURSOR_TRAIL_SPARKS, Math.max(2, Math.round(distance / 180) + 1));
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / (count + 1);
    const trailX = startX + (x - startX) * ratio;
    const trailY = startY + (y - startY) * ratio;
    const trail = document.createElement("i");
    trail.className = "__horma-ai-trail";
    root.appendChild(trail);
    registerTransient(trail, 340);
    trail.animate?.(
      [
        { opacity: 0.72, transform: `translate3d(${trailX}px,${trailY}px,0) scale(1)` },
        { opacity: 0, transform: `translate3d(${trailX - 4}px,${trailY - 4}px,0) scale(.12)` },
      ],
      { duration: 300, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
    );
  }
}

function shockwave(x: number, y: number): void {
  if (reducedMotion()) return;
  const wave = document.createElement("i");
  wave.className = "__horma-ai-shockwave";
  root.appendChild(wave);
  registerTransient(wave, 520);
  wave.animate?.(
    [
      { opacity: 0.9, transform: `translate3d(${x}px,${y}px,0) scale(.35)` },
      { opacity: 0, transform: `translate3d(${x}px,${y}px,0) scale(3.5)` },
    ],
    { duration: 460, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
  );
}

function scrollCue(x: number, y: number, deltaX: number, deltaY: number): void {
  const cue = document.createElement("i");
  cue.className = "__horma-ai-scroll-cue";
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
  const label = horizontal ? (deltaX >= 0 ? "→" : "←") : (deltaY >= 0 ? "↓" : "↑");
  cue.textContent = label;
  root.appendChild(cue);
  registerTransient(cue, 380);
  const tx = horizontal ? Math.sign(deltaX || 1) * 11 : 0;
  const ty = horizontal ? 0 : Math.sign(deltaY || 1) * 11;
  cue.animate?.(
    [
      { opacity: 0.92, transform: `translate3d(${x + 18}px,${y + 18}px,0)` },
      { opacity: 0, transform: `translate3d(${x + 18 + tx}px,${y + 18 + ty}px,0)` },
    ],
    { duration: reducedMotion() ? 1 : 340, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
  );
}

function hideVisuals(): void {
  if (cursor) {
    cursor.dataset.visible = "false";
    cursor.dataset.busy = "false";
    cursor.dataset.gesture = "idle";
  }
  if (targetFrame) targetFrame.dataset.visible = "false";
  for (const effect of transients.splice(0)) effect.remove();
}

function scheduleIdleHide(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideVisuals();
    void overlayWindow.hide();
  }, IDLE_HIDE_MS);
}

function clearFx(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = null;
  hideVisuals();
  void overlayWindow.hide();
}

function handleFx(event: ComputerUseFxEvent): void {
  const x = Number(event.x || 0);
  const y = Number(event.y || 0);
  const gesture = String(event.gesture || event.kind || "hover");
  if (event.kind === "clear") {
    clearFx();
    return;
  }
  ensureOverlay();
  const previousX = lastX;
  const previousY = lastY;
  if (
    event.kind !== "target"
    && Math.hypot(x - lastX, y - lastY) > HUMAN_DIVERGE_PX
    && (event.kind === "hover" || event.kind === "press" || event.kind === "click")
  ) {
    emitTrail(previousX, previousY, x, y);
  }
  if (event.kind !== "target") placeCursor(x, y);
  switch (event.kind) {
    case "target":
      showTarget(x, y, Number(event.width || 48), Number(event.height || 48), gesture);
      break;
    case "cursor_move":
    case "approach":
      setGesture("approach", "MOVE");
      emitTrail(previousX, previousY, x, y);
      break;
    case "hover":
      setGesture("hover", "HOVER");
      break;
    case "press":
      setGesture("press", "CLICK");
      if (targetFrame?.dataset.visible === "true") targetFrame.dataset.gesture = "press";
      break;
    case "click":
      setGesture("click", "DONE");
      if (targetFrame?.dataset.visible === "true") targetFrame.dataset.gesture = "click";
      shockwave(x, y);
      break;
    case "drag":
      setGesture("drag", "DRAG");
      emitTrail(previousX, previousY, x, y);
      break;
    case "scroll":
      setGesture("scroll", "SCROLL");
      scrollCue(x, y, Number(event.deltaX || 0), Number(event.deltaY || 0));
      break;
    case "type_char":
    case "type_done":
      setGesture("type", "TYPE");
      break;
    case "key":
      setGesture("key", "KEY");
      break;
    default:
      setGesture(gesture);
  }
  scheduleIdleHide();
}

listen<ComputerUseFxEvent>("computer-use-fx", (ev) => handleFx(ev.payload)).catch(console.error);
