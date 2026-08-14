import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Ask mode defaults to Answer Max and requires a visible response", async () => {
  const [agent, config, modelbar, settings, tools] = await Promise.all([
    read("src-tauri/src/agent.rs"),
    read("src-tauri/src/config.rs"),
    read("src/components/modelbar.ts"),
    read("src/components/settings.ts"),
    read("src-tauri/src/tools.rs"),
  ]);

  assert.match(agent, /AutomaticContinuationReason::EmptyAnswer/);
  assert.match(agent, /response_has_visible_answer/);
  assert.match(agent, /maximum answer reliability/i);
  assert.match(agent, /Every turn must end with a substantive visible answer/i);
  assert.match(agent, /Never end on thinking only/);
  assert.match(agent, /VISIBLE_REPLY_CONTRACT/);
  assert.match(agent, /last_resort_visible_reply/);
  assert.match(agent, /tokio::task::spawn_blocking/);
  assert.match(agent, /Viewing attached image/);
  assert.match(agent, /auto_view_attached_images/);
  assert.match(tools, /xai\/grok-4\.5/);
  assert.match(tools, /google\/gemini-2\.0-flash-001/);
  assert.match(tools, /Describe every attached image/);
  assert.match(tools, /commandcode\/grok/);
  assert.match(agent, /Keep image answers short/);
  assert.match(agent, /Do not call done for a description-only/);
  assert.match(agent, /full path \/ full directory/);
  assert.match(agent, /asks_for_file_location/);
  assert.match(agent, /asks_to_simplify_or_rephrase/);
  assert.match(agent, /2-5 short everyday sentences/);
  assert.match(agent, /host Completed card is the delivery layout/);
  assert.match(agent, /1-2 short sentences/);
  assert.match(agent, /absolute filesystem path/);
  assert.doesNotMatch(agent, /You may retry with view_image/);
  assert.match(agent, /fn infer_permission_mode/);
  assert.match(agent, /ask_research_should_synthesize/);
  assert.match(agent, /Evidence gathered — composing the final answer/);
  assert.match(config, /"ask" \| "research" => "answer_max"/);
  assert.match(modelbar, /id: "answer_max"/);
  assert.match(modelbar, /applyIntentMode/);
  assert.match(settings, /ask: \["answer_max", "investigate", "brief"\]/);
  assert.match(agent, /call start_dev_server and open it in Preview/);
  assert.match(tools, /pub fn ensure_project_dev_server/);
});

test("Cursor bridge reports and recovers blank assistant completions", async () => {
  const [rustBridge, sourceBridge, runtimeBridge] = await Promise.all([
    read("src-tauri/src/cursor_bridge.rs"),
    read("scripts/cursor-bridge.mjs"),
    read("src-tauri/runtime/scripts/cursor-bridge.mjs"),
  ]);

  assert.equal(runtimeBridge, sourceBridge, "packaged Cursor bridge must match source");
  assert.match(sourceBridge, /answered: sawText/);
  assert.match(sourceBridge, /conclusionFromReasoning/);
  assert.match(rustBridge, /CURSOR_EMPTY_REPLY_PROMPT/);
  assert.match(rustBridge, /answer_text_seen/);
  assert.match(rustBridge, /Cursor returned no visible answer/);
});

test("Preview Computer Use exposes Off Auto On and prompt-intent activation", async () => {
  const [main, preview, ipc, config, css] = await Promise.all([
    read("src/main.ts"),
    read("src/components/site-preview.ts"),
    read("src/ipc.ts"),
    read("src-tauri/src/config.rs"),
    read("src/theme/workspace.css"),
  ]);

  assert.match(main, /resolvePreviewComputerUsePromptIntent/);
  assert.match(main, /playwright\|browser automation/);
  assert.match(main, /\(browserTask\.test\(prompt\) && \(previewTarget\.test\(prompt\) \|\| webAddress\.test\(prompt\)\)\)/);
  assert.match(main, /informationalOnly/);
  assert.match(main, /computer_use_enabled: computerUseForRun/);
  assert.match(main, /openForComputerUse/);
  assert.match(main, /extractPreviewBrowserUrlFromPrompt/);
  assert.match(preview, /async openForComputerUse/);
  assert.match(preview, /ensureOpenForComputerUse/);
  assert.doesNotMatch(preview, /Open the Preview window before using the AI cursor/);

  const start = main.indexOf("export type PreviewComputerUsePromptIntent");
  const end = main.indexOf("export type InferredPermissionMode", start);
  assert.ok(start >= 0 && end > start);
  const executable = main.slice(start, end)
    .replace(/export type PreviewComputerUsePromptIntent[\s\S]*?;\s*/, "")
    .replace("export function", "function")
    .replace("value: string", "value")
    .replace(/\): PreviewComputerUsePromptIntent/, ")");
  const resolveIntent = new Function(`${executable}; return resolvePreviewComputerUsePromptIntent;`)();
  for (const prompt of [
    "can you playwright my website",
    "QA every feature in this preview",
    "audit the dashboard UI",
    "use the keyboard to play the browser game",
    "reproduce this UI bug on the web app",
    "search for youtube.com",
  ]) {
    assert.equal(resolveIntent(prompt), "auto", prompt);
  }
  assert.equal(resolveIntent("can you use computer use and search for youtube.com"), "enable");
  assert.equal(resolveIntent("what is Playwright?"), null);
  assert.equal(resolveIntent("do not use computer use to test my website"), "disable");
  assert.match(preview, /PreviewComputerUseMode = "off" \| "auto" \| "on"/);
  assert.match(preview, /site-preview-computer-mode/);
  assert.match(preview, /ACTIVE PREVIEW TAB ONLY/);
  assert.match(ipc, /computer_use_prompt_activation: boolean/);
  assert.match(config, /default_computer_use_prompt_activation/);
  assert.match(css, /\.site-preview-computer-modes/);
});

test("Preview sandwich exposes Desktop mode next to Computer Use", async () => {
  const [preview, css, main] = await Promise.all([
    read("src/components/site-preview.ts"),
    read("src/theme/workspace.css"),
    read("src/main.ts"),
  ]);
  assert.match(preview, /site-preview-desktop-use/);
  assert.match(preview, /\["Desktop mode"\]/);
  assert.match(preview, /desktop_computer_use_enabled/);
  assert.match(preview, /desktop_computer_use_allowed_apps/);
  assert.match(preview, /WINDOWS APPS OUTSIDE PREVIEW/);
  assert.match(preview, /horma:desktop-computer-use-changed/);
  assert.match(css, /\.site-preview-desktop-use/);
  assert.match(css, /\.site-preview-desktop-modes/);
  assert.match(main, /horma:desktop-computer-use-changed/);
  assert.match(main, /desktop_computer_use_enabled = event\.detail\?\.enabled === true/);
});

test("client intent auto-switches Ask, Plan, and Multi-Agent", async () => {
  const main = await read("src/main.ts");
  assert.match(main, /export function inferPermissionMode/);
  assert.match(main, /applyIntentMode\(inferredMode\)/);
  const start = main.indexOf("export type InferredPermissionMode");
  const end = main.indexOf("async function sendPrompt", start);
  assert.ok(start >= 0 && end > start);
  const executable = main.slice(start, end)
    .replace(/export type InferredPermissionMode[\s\S]*?;\s*/, "")
    .replace("export function", "function")
    .replace("value: string", "value")
    .replace(/\): InferredPermissionMode \| null/, ")");
  const infer = new Function(`${executable}; return inferPermissionMode;`)();
  assert.equal(infer("what does this form do?"), "ask");
  assert.equal(infer("can you explain this screenshot"), "ask");
  assert.equal(infer("make a plan for the HR module"), "plan");
  assert.equal(
    infer("can you add this form after the final interview if employee passed the interview"),
    "multi_agent",
  );
  assert.equal(infer("add a login page to this app"), "multi_agent");
  assert.equal(infer("implement the plan"), "multi_agent");
  assert.equal(infer("yes"), null);
  assert.equal(infer("React + Vite"), null);
  assert.equal(infer("how do I add a form?"), "ask");
  assert.equal(infer("can you describe what this images are"), "ask");
  assert.equal(
    infer("can you simplify your explanation regarding back to work process"),
    "ask",
  );
  assert.equal(infer("can you make it simpler"), "ask");
  assert.equal(infer("analyze the architecture and report the main risks"), "ask");
  assert.equal(infer("review the architecture and provide a security assessment"), "ask");
  assert.equal(infer("review the architecture and fix the login bug"), "multi_agent");
  assert.equal(infer("make a responsive dashboard"), "multi_agent");
  assert.equal(
    infer(
      "Analyze this Crispy King project in read-only mode. Do not change any files. " +
      "Inspect the architecture, security, and tests. Give a thorough final report, " +
      "make reasonable assumptions, and finish with a complete answer.",
    ),
    "ask",
  );
  assert.equal(
    infer("[Attached image: a.png]\ncan you describe what this images are"),
    "ask",
  );
});

test("all modes share a visible-reply contract and chat last-resort", async () => {
  const [agent, director, chat, bridge] = await Promise.all([
    read("src-tauri/src/agent.rs"),
    read("src-tauri/src/smart_agent.rs"),
    read("src/components/chat.ts"),
    read("scripts/cursor-bridge.mjs"),
  ]);
  assert.match(agent, /VISIBLE REPLY \(all modes\)/);
  assert.match(agent, /\[Ask mode active\]/);
  assert.match(agent, /\[Plan mode active\]/);
  assert.match(agent, /\[Auto mode active\]/);
  assert.match(agent, /\[Full mode active\]/);
  assert.match(agent, /\[Multi-Agent mode active\]/);
  assert.match(agent, /never thinking only/i);
  assert.match(chat, /visibleAnswerFromThought/);
  assert.match(chat, /latestSealedThoughtAfterLastUser/);
  assert.match(chat, /ensureVisibleReplyAfterEnd/);
  assert.match(chat, /question-card/);
  assert.doesNotMatch(chat, /thinking-done\[data-thought\]:last-of-type/);
  assert.match(bridge, /conclusionFromReasoning\(thinkingSeen\)/);
  assert.match(director, /DIRECTOR JOB: ANSWER/);
  assert.match(agent, /infer_director_job/);
});
