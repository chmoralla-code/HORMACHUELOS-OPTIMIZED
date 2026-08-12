import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function transpileModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}

function loadReplyModules() {
  const utilSandbox = { module: { exports: {} }, exports: null };
  utilSandbox.exports = utilSandbox.module.exports;
  vm.runInNewContext(transpileModule("../src/components/util.ts"), utilSandbox, { filename: "util.ts" });

  const policySandbox = { module: { exports: {} }, exports: null };
  policySandbox.exports = policySandbox.module.exports;
  vm.runInNewContext(
    transpileModule("../src/components/preview-url-policy.ts"),
    policySandbox,
    { filename: "preview-url-policy.ts" },
  );

  const sessionSandbox = {
    module: { exports: {} },
    exports: null,
    require: (specifier) => {
      if (specifier === "./util") return utilSandbox.module.exports;
      if (specifier === "./preview-url-policy") return policySandbox.module.exports;
      throw new Error(`Unexpected session dependency: ${specifier}`);
    },
  };
  sessionSandbox.exports = sessionSandbox.module.exports;
  vm.runInNewContext(transpileModule("../src/components/session.ts"), sessionSandbox, { filename: "session.ts" });

  return {
    normalizeAssistantMarkdown: utilSandbox.module.exports.normalizeAssistantMarkdown,
    appendAssistantTranscriptChunk: sessionSandbox.module.exports.appendAssistantTranscriptChunk,
  };
}

const { normalizeAssistantMarkdown, appendAssistantTranscriptChunk } = loadReplyModules();

const malformedCompletion = [
  "done",
  "Title: Enhanced Snake Game",
  "Description: A polished snake game with responsive controls.",
  "Features:",
  "- Smooth particle effects",
  "- Dynamic difficulty scaling",
  "Tech: HTML5 Canvas, JavaScript",
  "Files: snake/game.js",
  "",
  "index",
  ".",
  "html`,",
  "`,",
  "snake",
  "/",
  "style",
  ".",
  "css`,",
].join("\n");

const cleaned = normalizeAssistantMarkdown(malformedCompletion);
assert.match(cleaned, /^## Enhanced Snake Game/m);
assert.match(cleaned, /^### Highlights$/m);
assert.match(cleaned, /^### Technology$/m);
assert.match(cleaned, /^### Files$/m);
assert.match(cleaned, /- `snake\/game\.js`/);
assert.match(cleaned, /index\.html/);
assert.match(cleaned, /snake\/style\.css/);
assert.doesNotMatch(cleaned, /^done$/im);

const fenced = "```json\n{\"files\":[\"index\",\".\",\"html\"]}\n```";
assert.equal(normalizeAssistantMarkdown(fenced), fenced);
assert.equal(
  normalizeAssistantMarkdown('Before\n<tool_call>{"name":"done"}</tool_call>\nAfter'),
  "Before\n\nAfter",
);

// A provider output-limit recovery can insert thought/tool events between a
// cut-off prefix and its suffix. The explicit continuation marker must keep
// that as one assistant reply without merging ordinary later prose.
const recoveryTranscript = [
  { type: "user", text: "Please finish the build." },
  { type: "run_start", permissionMode: "multi_agent" },
  { type: "assistant", text: "The glob" },
  { type: "thinking", iteration: 2, text: "Resuming after the output limit." },
];
assert.equal(
  appendAssistantTranscriptChunk(recoveryTranscript, "als.css update is complete.", 20, true),
  true,
);
assert.equal(
  recoveryTranscript.filter((message) => message.type === "assistant").length,
  1,
);
assert.equal(recoveryTranscript[2].text, "The globals.css update is complete.");

recoveryTranscript.push({ type: "tool_result", id: "build", name: "run_command", ok: true, content: "ok" });
assert.equal(
  appendAssistantTranscriptChunk(recoveryTranscript, "A separate verified result.", 30, false),
  false,
);
assert.equal(
  recoveryTranscript.filter((message) => message.type === "assistant").length,
  2,
);

const priorRunBoundary = [
  { type: "assistant", text: "Prior answer." },
  { type: "end", reason: "completed" },
  { type: "run_start", permissionMode: "plan" },
  { type: "thinking", iteration: 0, text: "" },
];
assert.equal(
  appendAssistantTranscriptChunk(priorRunBoundary, "Fresh answer.", 40, true),
  false,
);
assert.equal(priorRunBoundary[0].text, "Prior answer.");
assert.equal(priorRunBoundary.at(-1).text, "Fresh answer.");

// Tool previews are intentionally not persisted. If one temporarily clears the
// live DOM pointer, the transcript merge result tells Chat to resume the same
// rendered reply so Markdown markers cannot split across placeholder messages.
const previewInterruptedTranscript = [
  { type: "user", text: "Inspect this project." },
  { type: "run_start", permissionMode: "multi_agent" },
];
assert.equal(
  appendAssistantTranscriptChunk(previewInterruptedTranscript, "A company-owned **HR /", 50, false),
  false,
);
assert.equal(
  appendAssistantTranscriptChunk(previewInterruptedTranscript, " payroll portal** for staff.", 60, false),
  true,
);
assert.equal(
  previewInterruptedTranscript.at(-1).text,
  "A company-owned **HR / payroll portal** for staff.",
);

const chatSource = readFileSync(new URL("../src/components/chat.ts", import.meta.url), "utf8");
for (const requiredReplyStitch of [
  "const mergedAssistantChunk = !this.replaying && this.recordEvent(e);",
  "private renderEvent(e: AgentEvent, mergedAssistantChunk = false)",
  "e.payload.continuation === true || mergedAssistantChunk",
  "scheduleStableMessageVirtualization",
  "--history-item-height",
]) {
  assert.ok(chatSource.includes(requiredReplyStitch), `missing live reply-layout guard: ${requiredReplyStitch}`);
}

const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
assert.match(appCss, /#chat > \.msg\.history-virtualized\s*\{/);
assert.doesNotMatch(appCss, /#chat > \.msg,\s*\n#chat > \.thinking-wrap/);

// Keep the session-bound lock intact even if the toolbar is refactored.
const modelBar = readFileSync(new URL("../src/components/modelbar.ts", import.meta.url), "utf8");
for (const requiredGuard of [
  "setActiveSessionRunProfile",
  "modelSelectionLocked",
  "allowModelSelection",
  "modelBtn.disabled = true",
  "effortBtn.disabled = true",
]) {
  assert.ok(modelBar.includes(requiredGuard), `missing model-lock guard: ${requiredGuard}`);
}

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
for (const requiredLifecycleHook of [
  "const runModelProfiles",
  "runModelProfiles.set(sessionId",
  "runModelProfiles.delete(sessionId)",
  "syncActiveSessionModelLock();",
]) {
  assert.ok(main.includes(requiredLifecycleHook), `missing session-lock lifecycle hook: ${requiredLifecycleHook}`);
}

console.log("reply formatting and session model-lock checks passed");
