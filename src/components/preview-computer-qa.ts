export type PreviewSpecAction = {
  type: string;
  selector?: string;
  ref?: string;
  text?: string;
  value?: string;
  keys?: string;
  expect?: {
    visible?: boolean;
    enabled?: boolean;
    checked?: boolean;
    text?: string;
    value?: string;
    url?: string;
    title?: string;
  };
  fixture?: string;
  viewport?: string;
  delta_y?: number;
  button?: string;
  clicks?: number;
};

export const PREVIEW_DEVICE_FRAMES = {
  desktop: { id: "desktop", label: "Desktop", width: 0, height: 0 },
  tablet: { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  mobile: { id: "mobile", label: "Mobile", width: 390, height: 844 },
} as const;

export type PreviewDeviceFrame = keyof typeof PREVIEW_DEVICE_FRAMES;

export const PREVIEW_UPLOAD_FIXTURES = ["tiny.png", "sample.csv", "note.txt"] as const;
export type PreviewUploadFixture = (typeof PREVIEW_UPLOAD_FIXTURES)[number];

export type PreviewA11yIssue = {
  ref?: string;
  rule: string;
  message: string;
  selector: string;
  tag: string;
};

type ProbeBuffers = {
  console: Array<{ level: string; text: string }>;
  network: Array<{ method: string; url: string; status: number; ok: boolean }>;
  inflight: number;
  lastNetworkMs: number;
};

type ProbeView = {
  console?: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  addEventListener: Window["addEventListener"];
};

const probes = new WeakMap<object, ProbeBuffers>();
const MAX_PROBE = 16;

function compact(value: string | null | undefined, max = 180): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buffersFor(view: object): ProbeBuffers {
  let buffers = probes.get(view);
  if (!buffers) {
    buffers = { console: [], network: [], inflight: 0, lastNetworkMs: Date.now() };
    probes.set(view, buffers);
  }
  return buffers;
}

function pushBounded<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_PROBE) list.shift();
}

export function installPreviewProbes(view: Window): ProbeBuffers {
  const host = view as Window & ProbeView & { __hormaPreviewProbes?: boolean };
  const buffers = buffersFor(host);
  if (host.__hormaPreviewProbes) return buffers;
  host.__hormaPreviewProbes = true;

  const wrap = (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      pushBounded(buffers.console, {
        level,
        text: compact(args.map((value) => {
          try { return typeof value === "string" ? value : JSON.stringify(value); }
          catch { return String(value); }
        }).join(" ")),
      });
      original.apply(host.console, args);
    };
  try {
    if (host.console) {
      host.console.error = wrap("error", host.console.error.bind(host.console));
      host.console.warn = wrap("warn", host.console.warn.bind(host.console));
    }
  } catch { /* page may freeze console */ }

  host.addEventListener("error", (event) => {
    const error = event as ErrorEvent;
    pushBounded(buffers.console, {
      level: "error",
      text: compact(error.message || "Uncaught error"),
    });
  });
  host.addEventListener("unhandledrejection", (event) => {
    const rejection = event as PromiseRejectionEvent;
    pushBounded(buffers.console, {
      level: "error",
      text: compact(String(rejection.reason || "Unhandled rejection")),
    });
  });

  const recordNetwork = (method: string, url: string, status: number) => {
    buffers.lastNetworkMs = Date.now();
    pushBounded(buffers.network, {
      method: compact(method, 12).toUpperCase() || "GET",
      url: compact(url, 180),
      status,
      ok: status >= 200 && status < 400,
    });
  };

  const fetchImpl = host.fetch?.bind(host);
  if (typeof fetchImpl === "function") {
    host.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      buffers.inflight += 1;
      try {
        const response = await fetchImpl(input, init);
        recordNetwork(
          init?.method || (input instanceof Request ? input.method : "GET"),
          String(input instanceof Request ? input.url : input),
          response.status,
        );
        return response;
      } catch (error) {
        recordNetwork(
          init?.method || "GET",
          String(input instanceof Request ? input.url : input),
          0,
        );
        throw error;
      } finally {
        buffers.inflight = Math.max(0, buffers.inflight - 1);
        buffers.lastNetworkMs = Date.now();
      }
    };
  }

  return buffers;
}

export function previewProbeSnapshot(view: Window): {
  console: ProbeBuffers["console"];
  network: ProbeBuffers["network"];
  inflight: number;
} {
  const buffers = installPreviewProbes(view);
  return {
    console: buffers.console.slice(-MAX_PROBE),
    network: buffers.network.filter((entry) => !entry.ok).slice(-MAX_PROBE),
    inflight: buffers.inflight,
  };
}

export function previewNetworkIdle(view: Window, quietMs = 220): boolean {
  const buffers = installPreviewProbes(view);
  return buffers.inflight === 0 && Date.now() - buffers.lastNetworkMs >= quietMs;
}

export function isPreviewUploadFixture(value: string): value is PreviewUploadFixture {
  return (PREVIEW_UPLOAD_FIXTURES as readonly string[]).includes(value);
}

export function previewFixtureFile(name: PreviewUploadFixture): File {
  if (name === "tiny.png") {
    const png = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
      120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0, 24, 221, 141, 176, 0, 0, 0,
      0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    return new File([png], "tiny.png", { type: "image/png" });
  }
  if (name === "sample.csv") {
    return new File(["name,value\npreview,1\n"], "sample.csv", { type: "text/csv" });
  }
  return new File(["Hormachuelos Preview fixture\n"], "note.txt", { type: "text/plain" });
}

export function assignPreviewFileInput(input: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function accessibleName(element: Element): string {
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled && element.ownerDocument) {
    const text = labelled.split(/\s+/).map((id) =>
      compact(element.ownerDocument.getElementById(id)?.textContent, 80)
    ).filter(Boolean).join(" ");
    if (text) return text;
  }
  const input = element as HTMLInputElement;
    if (input.id && element.ownerDocument) {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(input.id)
        : input.id.replace(/["\\]/g, "\\$&");
      const label = element.ownerDocument.querySelector(`label[for="${escaped}"]`);
    if (label) return compact(label.textContent, 80);
  }
  return compact(
    element.getAttribute("aria-label")
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || input.placeholder
      || (element as HTMLElement).innerText,
    80,
  );
}

export function scanPreviewA11y(
  document: Document,
  view: Window,
  isVisible: (element: Element, view: Window) => boolean,
  max = 16,
): Array<PreviewA11yIssue & { element: Element }> {
  const issues: Array<PreviewA11yIssue & { element: Element }> = [];
  const push = (element: Element, rule: string, message: string) => {
    if (issues.length >= max) return;
    issues.push({
      element,
      rule,
      message,
      selector: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
      tag: element.tagName.toLowerCase(),
    });
  };

  if (!compact(document.documentElement.getAttribute("lang"), 16)) {
    push(document.documentElement, "html-has-lang", "The document html element has no lang attribute.");
  }

  const images = Array.from(document.querySelectorAll("img")).slice(0, 80);
  for (const image of images) {
    if (!isVisible(image, view)) continue;
    if (!accessibleName(image) && image.getAttribute("role") !== "presentation") {
      push(image, "image-alt", "Visible image is missing an accessible name.");
    }
  }

  const controls = Array.from(document.querySelectorAll(
    "button, a[href], [role='button'], [role='link'], summary",
  )).slice(0, 120);
  for (const control of controls) {
    if (!isVisible(control, view)) continue;
    if (!accessibleName(control)) {
      push(control, "control-name", "Interactive control is missing an accessible name.");
    }
  }

  const fields = Array.from(document.querySelectorAll("input, select, textarea")).slice(0, 80);
  for (const field of fields) {
    if (!isVisible(field, view)) continue;
    const input = field as HTMLInputElement;
    if (["hidden", "submit", "button", "image"].includes((input.type || "").toLowerCase())) continue;
    if (!accessibleName(field) && !input.closest("label")) {
      push(field, "label", "Form control is missing an associated label.");
    }
  }

  return issues;
}

export function isPreviewDeviceFrame(value: string): value is PreviewDeviceFrame {
  return value === "desktop" || value === "tablet" || value === "mobile";
}

export function previewPlaywrightSpec(options: {
  title?: string;
  url: string;
  viewport?: { width: number; height: number };
  actions: PreviewSpecAction[];
}): string {
  const title = compact(options.title, 80) || "Preview Computer Use scenario";
  const lines = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test(${JSON.stringify(title)}, async ({ page }) => {`,
  ];
  if (options.viewport && options.viewport.width > 0 && options.viewport.height > 0) {
    lines.push(`  await page.setViewportSize({ width: ${options.viewport.width}, height: ${options.viewport.height} });`);
  }
  lines.push(`  await page.goto(${JSON.stringify(options.url)});`);
  for (const action of options.actions) {
    const locator = action.selector
      ? `page.locator(${JSON.stringify(action.selector)})`
      : action.ref
        ? `page.getByRole('button') /* ${action.ref} */`
        : "page.locator('body')";
    if (action.type === "click") {
      lines.push(`  await ${locator}.click();`);
    } else if (action.type === "type") {
      lines.push(`  await ${locator}.fill(${JSON.stringify(action.text || "")});`);
    } else if (action.type === "set_value") {
      lines.push(`  await ${locator}.fill(${JSON.stringify(action.value || action.text || "")});`);
    } else if (action.type === "key") {
      lines.push(`  await page.keyboard.press(${JSON.stringify(action.keys || "Enter")});`);
    } else if (action.type === "check" && action.expect) {
      if (action.expect.visible === true) lines.push(`  await expect(${locator}).toBeVisible();`);
      if (action.expect.text) {
        lines.push(`  await expect(${locator}).toContainText(${JSON.stringify(action.expect.text)});`);
      }
      if (action.expect.url) {
        lines.push(`  await expect(page).toHaveURL(/${escapeRegExp(action.expect.url)}/i);`);
      }
    } else if (action.type === "wait_for") {
      if (action.expect?.visible === true) lines.push(`  await expect(${locator}).toBeVisible();`);
      else lines.push("  await page.waitForLoadState('networkidle');");
    } else if (action.type === "upload") {
      lines.push(`  await ${locator}.setInputFiles(${JSON.stringify(action.fixture || "tiny.png")});`);
    } else if (action.type === "scroll") {
      lines.push(`  await ${locator}.evaluate((node) => node.scrollBy?.(0, ${Number(action.delta_y || 400)}));`);
    }
  }
  lines.push("});", "");
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 120);
}

export function sanitizePreviewRecording(actions: PreviewSpecAction[]): PreviewSpecAction[] {
  return actions.slice(0, 48).map((action) => {
    const next: PreviewSpecAction = { type: action.type };
    if (action.selector) next.selector = action.selector;
    if (action.ref) next.ref = action.ref;
    if (action.text) next.text = action.text.slice(0, 512);
    if (action.value) next.value = action.value.slice(0, 512);
    if (action.keys) next.keys = action.keys;
    if (action.expect) next.expect = action.expect;
    if (action.fixture) next.fixture = action.fixture;
    if (action.viewport) next.viewport = action.viewport;
    if (action.delta_y != null) next.delta_y = action.delta_y;
    if (action.button) next.button = action.button;
    if (action.clicks) next.clicks = action.clicks;
    return next;
  });
}
