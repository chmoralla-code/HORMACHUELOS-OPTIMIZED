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

  const sessionSandbox = {
    module: { exports: {} },
    exports: null,
    require: (specifier) => {
      if (specifier === "./util") return utilSandbox.module.exports;
      throw new Error(`Unexpected session dependency: ${specifier}`);
    },
  };
  sessionSandbox.exports = sessionSandbox.module.exports;
  vm.runInNewContext(transpileModule("../src/components/session.ts"), sessionSandbox, { filename: "session.ts" });

  return {
    normalizeAssistantMarkdown: utilSandbox.module.exports.normalizeAssistantMarkdown,
    renderMarkdown: utilSandbox.module.exports.renderMarkdown,
    stripProcessPreamble: utilSandbox.module.exports.stripProcessPreamble,
    compactVisibleReply: utilSandbox.module.exports.compactVisibleReply,
    appendVisibleAssistantChunk: utilSandbox.module.exports.appendVisibleAssistantChunk,
    looksLikeProvisionalToolNarration: utilSandbox.module.exports.looksLikeProvisionalToolNarration,
    deliveryLeadFromReply: utilSandbox.module.exports.deliveryLeadFromReply,
    looksLikeDeliveryEssay: utilSandbox.module.exports.looksLikeDeliveryEssay,
    mergeReasoningStream: utilSandbox.module.exports.mergeReasoningStream,
    repairGluedProse: utilSandbox.module.exports.repairGluedProse,
    appendAssistantTranscriptChunk: sessionSandbox.module.exports.appendAssistantTranscriptChunk,
    appendThinkingTranscriptEvent: sessionSandbox.module.exports.appendThinkingTranscriptEvent,
    appendThinkingReasoningChunk: sessionSandbox.module.exports.appendThinkingReasoningChunk,
    appendMultiAgentBatchSnapshot: sessionSandbox.module.exports.appendMultiAgentBatchSnapshot,
    compactSessionMessagesForStorage: sessionSandbox.module.exports.compactSessionMessagesForStorage,
    coalesceSessionTurnLayout: sessionSandbox.module.exports.coalesceSessionTurnLayout,
    normalizeSessionPermissionMode: sessionSandbox.module.exports.normalizeSessionPermissionMode,
  };
}

const {
  normalizeAssistantMarkdown,
  renderMarkdown,
  stripProcessPreamble,
  compactVisibleReply,
  appendVisibleAssistantChunk,
  looksLikeProvisionalToolNarration,
  deliveryLeadFromReply,
  looksLikeDeliveryEssay,
  mergeReasoningStream,
  repairGluedProse,
  appendAssistantTranscriptChunk,
  appendThinkingTranscriptEvent,
  appendThinkingReasoningChunk,
  appendMultiAgentBatchSnapshot,
  compactSessionMessagesForStorage,
  coalesceSessionTurnLayout,
  normalizeSessionPermissionMode,
} = loadReplyModules();

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
// cut-off prefix and its suffix. Later prose in the same run stays one bubble.
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
  true,
);
assert.equal(
  recoveryTranscript.filter((message) => message.type === "assistant").length,
  1,
);
assert.equal(
  recoveryTranscript[2].text,
  "The globals.css update is complete.\n\nA separate verified result.",
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

const thoughtSplitTranscript = [
  { type: "user", text: "keep going" },
  { type: "run_start", permissionMode: "multi_agent" },
  { type: "assistant", text: "The" },
  { type: "thinking", iteration: 2, text: "Need to check Preview." },
];
assert.equal(
  appendAssistantTranscriptChunk(
    thoughtSplitTranscript,
    " Preview window isn't open yet. Let me check the server log and try observing.",
    70,
    false,
  ),
  true,
);
assert.equal(
  thoughtSplitTranscript.filter((message) => message.type === "assistant").length,
  1,
);
assert.equal(
  thoughtSplitTranscript[2].text,
  "The Preview window isn't open yet. Let me check the server log and try observing.",
);

assert.equal(
  stripProcessPreamble(
    "The user wants me to describe the attached images. The auto-view timed out. Let me call view_image on the three images to get a closer look. Here's what I see in the three images:",
  ),
  "Here's what I see in the three images:",
);

assert.equal(
  compactVisibleReply("Let me verify the files are in place.\n\nThe snake game is ready in Preview."),
  "The snake game is ready in Preview.",
);
assert.equal(
  compactVisibleReply(
    "A few decisions before I lock the plan:\nThe user confirmed Apply. I'll implement the plan as described: in-app bell.\nLet me set up tasks and read the remaining reference files.",
  ),
  "A few decisions before I lock the plan:",
);
assert.equal(
  compactVisibleReply("HR can open Applications (`src/app/employee/(app)/applications/page.tsx` / `src/lib/nav.ts`)."),
  "HR can open Applications.",
);
assert.equal(
  compactVisibleReply("Applications (`Application` type in `src/lib/data.ts`) live in localStorage."),
  "Applications live in localStorage.",
);
assert.equal(
  compactVisibleReply("`sendAnnouncementEmails` (`src/lib/announcements/resend.ts`) can email staff."),
  "`sendAnnouncementEmails` can email staff.",
);
assert.equal(
  compactVisibleReply("Add `src/lib/application-notify.ts` for SMS."),
  "Add `application-notify.ts` for SMS.",
);
assert.equal(
  compactVisibleReply("Keep planning (this is just a proposal yet)."),
  "Keep planning (this is just a proposal yet).",
);
assert.match(
  compactVisibleReply("The file is at C:\\Users\\Cyrhiel\\proj\\src\\lib\\nav.ts"),
  /C:\\Users\\Cyrhiel\\proj\\src\\lib\\nav.ts/,
);
assert.doesNotMatch(
  renderMarkdown("HR can open Applications (`src/app/employee/(app)/applications/page.tsx` / `src/lib/nav.ts`)."),
  /src\/app\/employee/,
);
assert.equal(
  compactVisibleReply("Let me check the server log.\n\nLet me start the game."),
  "",
);
assert.equal(
  compactVisibleReply(
    "The glob patterns returned empty—let me explore the source tree directly. security/auth/config files and key libraries.",
  ),
  "The glob patterns returned empty",
);
assert.equal(
  looksLikeProvisionalToolNarration("The glob patterns returned empty—let me explore the source tree."),
  true,
);
assert.equal(
  looksLikeProvisionalToolNarration(
    "## Proposed plan\n\n1. Inspect the current flow.\n2. Implement the approved change.\n3. Verify it.",
  ),
  false,
);

const resultEssay = [
  "Let me verify everything still works.",
  "",
  "The snake game is ready in Preview. Open snake/index.html to play.",
  "",
  "## Result — Serpent snake game",
  "- Canvas controls",
  "### Highlights",
  "- Particles",
  "### Files",
  "- `snake/index.html`",
  "### Technology",
  "- HTML5 Canvas",
].join("\n");
assert.equal(looksLikeDeliveryEssay(resultEssay), true);
assert.equal(
  deliveryLeadFromReply(resultEssay),
  "The snake game is ready in Preview. Open snake/index.html to play.",
);
assert.equal(
  deliveryLeadFromReply("## Result — Serpent snake game\n- Canvas controls\n### Files\n- `snake/index.html`"),
  "",
);

const ordinaryAudit = [
  "# Crispy King Audit",
  "",
  "## 1. Architecture",
  "",
  "### Technology",
  "Next.js and Supabase.",
  "",
  "### Files",
  "`src/app/page.tsx` owns the entry route.",
].join("\n");
assert.equal(looksLikeDeliveryEssay(ordinaryAudit), false);

let streamedAudit = { source: "", visible: "" };
for (const chunk of [
  "Let me verify the final evidence.",
  "\n\n# Crispy King Audit\n\n## 1. Architecture\n\nThe app uses Next.js",
  " with Supabase.\n\n### Technology\nNext.js and TypeScript.",
  "\n\n### Files\n- `src/app/page.tsx`\n\n## 2. Findings\nThe report is complete.",
]) {
  streamedAudit = appendVisibleAssistantChunk(streamedAudit.source, chunk);
}
assert.match(streamedAudit.source, /^Let me verify/);
assert.match(streamedAudit.visible, /^# Crispy King Audit/);
assert.match(streamedAudit.visible, /## 1\. Architecture/);
assert.match(streamedAudit.visible, /## 2\. Findings/);

const numberedReport = renderMarkdown([
  "## Five improvements",
  "",
  "1. Fix authentication.",
  "",
  "1. Audit admin access.",
  "",
  "1. Add E2E coverage.",
].join("\n"));
assert.equal((numberedReport.match(/<ol class="md-list">/g) || []).length, 1);
assert.equal((numberedReport.match(/<li>/g) || []).length, 3);

assert.equal(
  compactVisibleReply("I'll explore the project structure to understand and analyze it."),
  "",
);
assert.equal(
  compactVisibleReply("Let me look at the app routes, mobile folder, and remaining docs."),
  "",
);
assert.equal(
  repairGluedProse("structure.Let me explore"),
  "structure. Let me explore",
);
assert.equal(
  repairGluedProse("**What it is**Crispy King HR #2"),
  "**What it is** Crispy King HR #2",
);
const looped = "The user wants me to understand and analyze the project. Let me explore the src structure. The user wants me to understand and analyze the project. Let me explore the src structure.";
assert.equal(
  mergeReasoningStream("", looped),
  "The user wants me to understand and analyze the project. Let me explore the src structure.",
);
assert.match(
  normalizeAssistantMarkdown("**Tech stack-**\n\nNext.js 15 and React 19."),
  /^### Tech stack/m,
);

const oversizedTranscript = [
  { type: "user", text: "Analyze the project." },
  { type: "run_start", permissionMode: "ask" },
];
for (let index = 0; index < 240; index += 1) {
  oversizedTranscript.push({ type: "thinking", iteration: index, text: `Inspecting ${index} ${"r".repeat(8_000)}` });
  oversizedTranscript.push({ type: "tool_call", id: `read-${index}`, name: "read_file", arguments: { path: `src/${index}.ts` } });
  oversizedTranscript.push({ type: "tool_result", id: `read-${index}`, name: "read_file", ok: true, content: `${index} ${"x".repeat(20_000)}` });
}
const finalStoredAnswer = "# Complete audit\n\nThe full user-facing answer must survive telemetry compaction.";
oversizedTranscript.push({ type: "assistant", text: finalStoredAnswer });
oversizedTranscript.push({ type: "end", reason: "completed" });
const compactedTranscript = compactSessionMessagesForStorage(oversizedTranscript);
assert.equal(compactedTranscript.find((message) => message.type === "user")?.text, "Analyze the project.");
assert.equal(compactedTranscript.find((message) => message.type === "assistant")?.text, finalStoredAnswer);
assert.equal(compactedTranscript.at(-1)?.type, "end");
assert.ok(compactedTranscript.filter((message) => ["thinking", "tool_call", "tool_result", "multi_agent_batch"].includes(message.type)).length <= 161);
assert.ok(JSON.stringify(compactedTranscript).length < 1_000_000);

const splitRestoreTranscript = [
  { type: "user", text: "Open the website and inspect it." },
  { type: "run_start", permissionMode: "ask" },
  { type: "thinking", iteration: 1, text: "I should look at the app shell first." },
  { type: "assistant", text: "Let me inspect the project structure first." },
  { type: "tool_call", id: "read-1", name: "read_file", arguments: { path: "package.json" } },
  { type: "tool_result", id: "read-1", name: "read_file", ok: true, content: "{}" },
  { type: "thinking", iteration: 2, text: "Next I will start the local server." },
  { type: "tool_call", id: "dev-1", name: "start_dev_server", arguments: {} },
  { type: "tool_result", id: "dev-1", name: "start_dev_server", ok: true, content: "http://localhost:3000" },
  { type: "assistant", text: "The site is running on localhost:3000." },
  { type: "end", reason: "completed" },
];
const restoredTurn = coalesceSessionTurnLayout(splitRestoreTranscript);
assert.equal(restoredTurn.filter((message) => message.type === "thinking").length, 1);
assert.equal(restoredTurn.filter((message) => message.type === "assistant").length, 1);
assert.match(restoredTurn.find((message) => message.type === "thinking")?.text || "", /app shell/);
assert.match(restoredTurn.find((message) => message.type === "thinking")?.text || "", /local server/);
assert.equal(
  restoredTurn.find((message) => message.type === "assistant")?.text,
  "The site is running on localhost:3000.",
);
assert.equal(
  restoredTurn.map((message) => message.type).join(","),
  "user,run_start,thinking,tool_call,tool_result,tool_call,tool_result,assistant,end",
);

const liveThoughts = [
  { type: "user", text: "Inspect it." },
  { type: "run_start", permissionMode: "ask" },
];
appendThinkingTranscriptEvent(liveThoughts, 1, 10);
appendThinkingTranscriptEvent(liveThoughts, 2, 20);
appendThinkingReasoningChunk(liveThoughts, "Checking the routes.", 2, 30);
appendThinkingReasoningChunk(liveThoughts, " Then the layout.", 2, 40);
assert.equal(liveThoughts.filter((message) => message.type === "thinking").length, 1);
assert.match(liveThoughts.find((message) => message.type === "thinking")?.text || "", /Checking the routes/);

const twoTurns = coalesceSessionTurnLayout([
  { type: "user", text: "First" },
  { type: "thinking", iteration: 0, text: "Thought A" },
  { type: "assistant", text: "Answer A" },
  { type: "end", reason: "completed" },
  { type: "user", text: "Second" },
  { type: "thinking", iteration: 0, text: "Thought B" },
  { type: "thinking", iteration: 1, text: "More B" },
  { type: "assistant", text: "Answer B" },
  { type: "end", reason: "completed" },
]);
assert.equal(twoTurns.filter((message) => message.type === "thinking").length, 2);
assert.equal(twoTurns.filter((message) => message.type === "assistant").length, 2);

const activityTranscript = [
  { type: "user", text: "Build the dashboard." },
  { type: "run_start", permissionMode: "multi_agent" },
];
appendMultiAgentBatchSnapshot(activityTranscript, [
  { id: "read-1", name: "read_file", arguments: { path: "package.json" } },
  { id: "grep-1", name: "grep", arguments: { pattern: "auth" } },
]);
appendMultiAgentBatchSnapshot(activityTranscript, [
  { id: "grep-1", name: "grep", arguments: { pattern: "auth" } },
  { id: "read-2", name: "read_file", arguments: { path: "src/main.ts" } },
]);
assert.equal(activityTranscript.filter((message) => message.type === "multi_agent_batch").length, 1);
assert.equal(
  Array.from(activityTranscript.at(-1).tools, (tool) => tool.id).join("|"),
  "read-1|grep-1|read-2",
);
assert.equal(normalizeSessionPermissionMode("ask"), "ask");
assert.equal(normalizeSessionPermissionMode("research"), "ask");

assert.equal(
  compactVisibleReply("Let me dig into the app structure and key libraries.\n\nHere's my analysis of your project."),
  "Here's my analysis of your project.",
);
assert.equal(
  compactVisibleReply("Let me dig into the app structure and key libraries.\n\nroute structure and key entry points."),
  "",
);
assert.equal(compactVisibleReply("-based answer."), "");
assert.equal(
  compactVisibleReply("Let me give a source-based answer.\n\nThe flow is employee to supervisor."),
  "The flow is employee to supervisor.",
);

const chatSource = readFileSync(new URL("../src/components/chat.ts", import.meta.url), "utf8");
assert.ok(chatSource.includes("loadSession(msgs: SessionMessage[], opts?: { running?: boolean })"), "session restore must know when a run is still live");
assert.doesNotMatch(chatSource, /const reusable = !this\.replaying/);
assert.doesNotMatch(chatSource, /const existing = !this\.replaying/);
for (const requiredReplyStitch of [
  "const mergedAssistantChunk = !this.replaying && this.recordEvent(e);",
  "private renderEvent(e: AgentEvent, mergedAssistantChunk = false)",
  "e.payload.continuation === true || mergedAssistantChunk",
  "shouldResumeOpenAssistant",
  "insertBefore(wrap, before)",
  "scheduleStableMessageVirtualization",
  "--history-item-height",
  "collapseDeliveryEssayInLatestReply",
  "latestActivityAfterLastUser",
  "hostLineFromLatestTools",
  "compactLatestAssistantTranscript",
  "mergeReasoningStream",
  "discardProvisionalAssistantBeforeTools",
  "if (!shouldDiscard) return",
  "insertToolCardInBatch",
  "placeTurnChromeInOrder",
  "showPostChooserActivity",
  "Waiting for your choice",
  "Choose an option above, or queue another message",
  "mergeCurrentTurnAssistantBubbles",
  "coalesceSessionTurnLayout",
  "resumeOpenRunAfterLoad",
  "coalesceAllTurnsChrome",
  "insertionPointAfterCurrentTools",
  "Multi-Agent activity",
  "structured-reply",
]) {
  assert.ok(chatSource.includes(requiredReplyStitch), `missing live reply-layout guard: ${requiredReplyStitch}`);
}

const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
assert.match(appCss, /#chat > \.msg\.history-virtualized\s*\{/);
assert.doesNotMatch(appCss, /#chat > \.msg,\s*\n#chat > \.thinking-wrap/);
assert.match(appCss, /font-size:\s*14\.25px/);
assert.match(appCss, /\.msg\.assistant\.structured-reply/);
assert.match(appCss, /width:\s*fit-content/);
assert.doesNotMatch(appCss, /\.tool-batch-wrap\.collapsed\s*~\s*\.tool-card-wrap/);
assert.match(appCss, /\.multi-agent-batch:not\(\.is-open\) \.multi-agent-tool:not\(\.working\):not\(\.failed\)/);

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
