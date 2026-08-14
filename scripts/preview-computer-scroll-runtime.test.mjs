import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

class FakeElement {
  constructor(tag, options = {}) {
    const {
      id = "", parent = null, top = 0, left = 0, width = 300, height = 40,
      clientWidth = width, clientHeight = height, scrollWidth = clientWidth,
      scrollHeight = clientHeight, scrollLeft = 0, scrollTop = 0,
      overflowX = "visible", overflowY = "visible", text = "",
      type = "text", value = "", disabled = false, checked = false,
      required = false, min = "", max = "", step = "", name = "", placeholder = "",
    } = options;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.parentElement = parent;
    this.children = [];
    if (parent) parent.children.push(this);
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;
    this.scrollWidth = scrollWidth;
    this.scrollHeight = scrollHeight;
    this.scrollLeft = scrollLeft;
    this.scrollTop = scrollTop;
    this.innerText = text;
    this.textContent = text;
    this.style = {};
    this.dataset = {};
    this.isConnected = Boolean(parent);
    this.attributes = new Map();
    this.type = type;
    this.value = value;
    this.disabled = disabled;
    this.checked = checked;
    this.required = required;
    this.min = min;
    this.max = max;
    this.step = step;
    this.name = name;
    this.placeholder = placeholder;
    this.validationMessage = "";
    this.isContentEditable = false;
    this.computedStyle = {
      overflowX, overflowY, display: "block", visibility: "visible", opacity: "1",
    };
    this.rect = {
      x: left, y: top, left, top, width, height,
      right: left + width, bottom: top + height,
    };
  }

  focus() { this.focused = true; }
  click() { this.clicked = (this.clicked || 0) + 1; }
  checkValidity() { return this.validationMessage === ""; }
  matches(selector) {
    return String(selector).split(",").some((part) => {
      const value = part.trim().toLowerCase();
      if (value.startsWith("#")) return value.slice(1) === this.id.toLowerCase();
      if (value === "input" || value.startsWith("input[")) return this.tagName === "INPUT";
      if (value === "textarea") return this.tagName === "TEXTAREA";
      if (value === "select") return this.tagName === "SELECT";
      if (value === "button") return this.tagName === "BUTTON";
      if (value === "a[href]") return this.tagName === "A";
      return false;
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === "function" && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  getBoundingClientRect() { return { ...this.rect }; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  dispatchEvent(event) { this.lastEvent = event; return true; }
  addEventListener() {}
  removeEventListener() {}

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      node.isConnected = true;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    }
  }

  scrollBy(arg, top) {
    const left = typeof arg === "object" ? Number(arg.left || 0) : Number(arg || 0);
    const deltaTop = typeof arg === "object" ? Number(arg.top || 0) : Number(top || 0);
    this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + deltaTop));
    this.afterScroll?.();
  }
}

function makeScene() {
  const page = new FakeElement("html", {
    clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1800, scrollTop: 65,
  });
  page.isConnected = true;
  const head = new FakeElement("head", { parent: page });
  const body = new FakeElement("body", {
    parent: page, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1800,
  });
  const pane = new FakeElement("div", {
    id: "roles-table", parent: body, top: 150, left: 100, width: 600, height: 300,
    clientWidth: 600, clientHeight: 300, scrollWidth: 600, scrollHeight: 1200,
    overflowY: "auto", text: "Role Management",
  });
  const cell = new FakeElement("td", {
    parent: pane, top: 220, left: 140, width: 300, height: 40, text: "EMPLOYEE",
  });
  const deadline = new FakeElement("input", {
    id: "deadline", type: "date", parent: body, top: 500, left: 100,
    width: 220, height: 40, value: "", required: true,
  });
  const password = new FakeElement("input", {
    id: "password", type: "password", parent: body, top: 545, left: 100,
    width: 220, height: 36, value: "",
  });

  const hitPane = (x, y) => x >= 100 && x <= 700 && y >= 150 && y <= 450;
  const document = {
    documentElement: page,
    head,
    body,
    scrollingElement: page,
    activeElement: body,
    title: "Role Management",
    location: { href: "http://localhost:3100/supervisor/users" },
    elementFromPoint: (x, y) => hitPane(Number(x), Number(y)) ? cell : body,
    querySelector: (selector) => selector === "#roles-table"
      ? pane
      : selector === "#deadline"
        ? deadline
        : selector === "#password"
          ? password
          : null,
    querySelectorAll: (selector) => {
      if (selector === "#roles-table") return [pane];
      if (selector === "#deadline") return [deadline];
      if (selector === "#password") return [password];
      if (String(selector).includes("input")) return [deadline, password];
      if (selector === "[data-horma-ai-ref]") {
        return pane.hasAttribute("data-horma-ai-ref") ? [pane] : [];
      }
      return [];
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  return { page, head, body, pane, cell, deadline, password, document };
}

function setRootScroll(scene, y, mirror) {
  scene.page.scrollTop = y;
  mirror(y);
}

function request(operation, actions = []) {
  return {
    requestId: "scroll-runtime-test",
    protocolVersion: 1,
    operation,
    args: operation === "actions" ? { actions } : {},
  };
}

async function exerciseScrollRuntime({ scene, drive, observe, setPageY }) {
  let result = await drive([
    { type: "scroll", x: 200, y: 240, delta_y: 520, duration_ms: 0 },
  ]);
  assert.equal(scene.pane.scrollTop, 520, "coordinate scrolling must move the nested roles table");
  assert.equal(scene.page.scrollTop, 65, "nested scrolling must not move the page root");
  assert.equal(result.results[0].target, "nested");
  assert.equal(result.results[0].applied.y, 520);
  assert.equal(result.results[0].moved, true);

  result = await drive([
    { type: "scroll", x: 200, y: 240, delta_y: -220, duration_ms: 0 },
  ]);
  assert.equal(scene.pane.scrollTop, 300, "negative delta_y must scroll the nested pane upward");
  assert.equal(scene.page.scrollTop, 65);
  assert.equal(result.results[0].applied.y, -220);

  scene.pane.scrollTop = 900;
  setPageY(65);
  result = await drive([
    { type: "scroll", x: 200, y: 240, delta_y: 520, duration_ms: 0 },
  ]);
  assert.equal(scene.pane.scrollTop, 900, "the nested pane must stay clamped at its boundary");
  assert.equal(scene.page.scrollTop, 585, "scrolling must chain to the page at the nested boundary");
  assert.equal(result.results[0].target, "page");
  assert.equal(result.results[0].moved, true);

  const observation = await observe();
  const paneTarget = observation.elements.find((element) =>
    element.scrollable === true && element.selector === "#roles-table"
  );
  assert.ok(paneTarget?.ref, "observation must expose the visible nested scroller as a ref");

  scene.pane.scrollTop = 0;
  setPageY(65);
  result = await drive([
    { type: "scroll", ref: paneTarget.ref, delta_y: 140, duration_ms: 0 },
  ]);
  assert.equal(scene.pane.scrollTop, 140, "an observed scroller ref must drive the nested pane");
  assert.equal(result.results[0].target, "nested");

  scene.pane.scrollTop = 0;
  result = await drive([
    { type: "scroll", selector: "#roles-table", delta_y: 160, duration_ms: 0 },
  ]);
  assert.equal(scene.pane.scrollTop, 160, "a selector must drive the nested pane");
  assert.equal(result.results[0].selector, "#roles-table");

  scene.pane.scrollTop = 0;
  result = await drive([{ type: "scroll", delta_y: 180, duration_ms: 0 }]);
  assert.equal(scene.pane.scrollTop, 180, "an untargeted scroll must hit-test beneath the AI cursor");
  assert.equal(scene.page.scrollTop, 65);
  assert.equal(result.results[0].target, "nested");
}


async function exerciseNativeControlRuntime({ scene, drive, observe }) {
  let result = await drive([
    { type: "set_value", selector: "#deadline", value: "2026-08-31" },
    {
      type: "check",
      selector: "#deadline",
      match: "equals",
      expect: { visible: true, enabled: true, value: "2026-08-31" },
    },
  ]);
  assert.equal(scene.deadline.value, "2026-08-31", "native date values must be filled directly");
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
  assert.equal(result.results[0].inputType, "date");
  assert.equal(result.results[0].valid, true);
  assert.equal(result.results[1].passed, true);
  assert.deepEqual(Array.from(result.results[1].failures), []);

  result = await drive([
    {
      type: "check",
      selector: "#deadline",
      match: "equals",
      expect: { value: "2027-01-01" },
    },
  ]);
  assert.equal(result.ok, false, "a failed evidence check must fail the batch");
  assert.equal(result.passed, false);
  assert.equal(result.failedChecks, 1);
  assert.deepEqual(Array.from(result.results[0].failures), ["value"]);

  result = await drive([
    { type: "set_value", selector: "#password", value: "never-expose-this-secret" },
    {
      type: "check",
      selector: "#password",
      match: "equals",
      expect: { value: "[redacted]" },
    },
  ]);
  assert.equal(scene.password.value, "never-expose-this-secret");
  assert.equal(result.results[0].value, "[redacted]");
  assert.equal(result.results[1].actual.value, "[redacted]");
  assert.equal(result.results[1].passed, true);
  assert.doesNotMatch(JSON.stringify(result), /never-expose-this-secret/);

  const observation = await observe();
  const passwordTarget = observation.elements.find((element) => element.selector === "#password");
  assert.equal(passwordTarget?.inputType, "password");
  assert.equal(Object.hasOwn(passwordTarget || {}, "value"), false);
}

function compileTypeScript(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

async function loadSameOriginController() {
  const policyUrl = `data:text/javascript;base64,${Buffer.from(
    compileTypeScript(read("src/components/preview-scroll-policy.ts")),
  ).toString("base64")}`;
  const qaUrl = `data:text/javascript;base64,${Buffer.from(
    compileTypeScript(read("src/components/preview-computer-qa.ts")),
  ).toString("base64")}`;
  const cursorUrl = `data:text/javascript;base64,${Buffer.from(
    compileTypeScript(read("src/computer-cursor.ts")),
  ).toString("base64")}`;
  const controller = compileTypeScript(read("src/components/preview-computer-use.ts"))
    .replace(
      /from\s+["']\.\/preview-scroll-policy["']/,
      `from ${JSON.stringify(policyUrl)}`,
    )
    .replace(
      /from\s+["']\.\/preview-computer-qa["']/,
      `from ${JSON.stringify(qaUrl)}`,
    )
    .replace(
      /from\s+["']\.\.\/computer-cursor["']/,
      `from ${JSON.stringify(cursorUrl)}`,
    );
  const controllerUrl = `data:text/javascript;base64,${Buffer.from(controller).toString("base64")}`;
  return import(controllerUrl);
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function installGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

test("same-origin controller scrolls nested panes and chains at their boundary", async (t) => {
  const scene = makeScene();
  const view = {
    document: scene.document,
    location: scene.document.location,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 65,
    devicePixelRatio: 1,
    getComputedStyle: (element) => element.computedStyle,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    scrollBy: ({ left = 0, top = 0 }) => scene.page.scrollBy({ left, top }),
  };
  scene.page.afterScroll = () => {
    view.scrollX = scene.page.scrollLeft;
    view.scrollY = scene.page.scrollTop;
  };
  const frame = { contentDocument: scene.document, contentWindow: view };
  installGlobal(t, "window", view);
  installGlobal(t, "CSS", { escape: (value) => String(value) });
  installGlobal(t, "WheelEvent", FakeEvent);
  installGlobal(t, "InputEvent", FakeEvent);
  installGlobal(t, "Event", FakeEvent);

  const { runFrameComputerUse } = await loadSameOriginController();
  const drive = (actions) => runFrameComputerUse(frame, request("actions", actions));
  await exerciseScrollRuntime({
    scene,
    drive,
    observe: () => runFrameComputerUse(frame, request("observe")),
    setPageY: (y) => setRootScroll(scene, y, (value) => { view.scrollY = value; }),
  });
  await exerciseNativeControlRuntime({
    scene,
    drive,
    observe: () => runFrameComputerUse(frame, request("observe")),
  });
});

function extractNativeBrowserController() {
  const rust = read("src-tauri/src/preview_browser.rs");
  const marker = 'const BROWSER_COMPUTER_SCRIPT: &str = r###"';
  const markerIndex = rust.indexOf(marker);
  assert.ok(markerIndex >= 0, "native Preview Browser controller marker must exist");
  const start = markerIndex + marker.length;
  const end = rust.indexOf('"###;', start);
  assert.ok(end > start, "native Preview Browser controller must have a bounded raw string");
  return rust.slice(start, end);
}

test("native Preview Browser script scrolls nested panes and chains at their boundary", async () => {
  const scene = makeScene();
  const context = {
    document: scene.document,
    location: scene.document.location,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 65,
    devicePixelRatio: 1,
    CSS: { escape: (value) => String(value) },
    getComputedStyle: (element) => element.computedStyle,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    console,
    WheelEvent: FakeEvent,
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    DragEvent: FakeEvent,
    Event: FakeEvent,
  };
  context.window = context;
  context.top = context;
  scene.page.afterScroll = () => {
    context.scrollX = scene.page.scrollLeft;
    context.scrollY = scene.page.scrollTop;
  };

  vm.createContext(context);
  vm.runInContext(extractNativeBrowserController(), context, { timeout: 1_000 });
  const controller = context.__hormaPreviewComputerUse;
  assert.ok(controller, "native Preview Browser controller must install in the page context");

  const drive = (actions) => controller.actions({ actions });
  await exerciseScrollRuntime({
    scene,
    drive,
    observe: () => controller.observe(),
    setPageY: (y) => setRootScroll(scene, y, (value) => { context.scrollY = value; }),
  });
  await exerciseNativeControlRuntime({
    scene,
    drive,
    observe: () => controller.observe(),
  });
});