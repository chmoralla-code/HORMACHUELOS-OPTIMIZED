import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("AGENTIC is an opt-in public mode while Adaptive remains the default", async () => {
  const [ipc, modelbar, settings, rustConfig] = await Promise.all([
    read("src/ipc.ts"),
    read("src/components/modelbar.ts"),
    read("src/components/settings.ts"),
    read("src-tauri/src/config.rs"),
  ]);

  assert.match(ipc, /"adaptive"\s*\|\s*"agentic"/);
  assert.match(ipc, /export type AgenticPhase\s*=/);
  assert.match(ipc, /export type AgenticPhaseState\s*=/);
  assert.match(ipc, /export interface AgenticAgent/);
  assert.match(modelbar, /value:\s*"agentic"/);
  assert.match(modelbar, /label:\s*"AGENTIC"/);
  assert.ok(modelbar.indexOf('value: "adaptive"') < modelbar.indexOf('value: "agentic"'));
  assert.match(settings, /"agentic"/);
  assert.match(rustConfig, /"agentic"/);
  assert.doesNotMatch(settings, /default[^\n]{0,80}"agentic"/i);
});

test("Director phase classifier and one-writer worker invariant are deterministic", async () => {
  const source = await read("src-tauri/src/agentic.rs");

  assert.match(source, /pub const MAX_AGENTIC_WORKERS:\s*usize\s*=\s*3/);
  assert.match(source, /AgenticPlan::classify/);
  for (const request of [
    "What does this component do?",
    "Create a plan, do not implement",
    "Audit architecture, security, and tests",
    "Fix this one heading",
    "Improve frontend, backend, and tests",
  ]) {
    assert.ok(source.includes(request), `missing routing regression for: ${request}`);
  }

  assert.match(source, /pub fn worker_tool_allowed/);
  for (const denied of [
    "write_file",
    "edit_file",
    "delete_file",
    "run_command",
    "connect_account",
    "ask_user",
    "computer_actions",
    "done",
  ]) {
    assert.ok(source.includes(`"${denied}"`), `worker deny regression does not cover ${denied}`);
  }
  assert.match(source, /if !worker_tool_allowed\(&spec\.id, &call\.name\)/);
  assert.match(source, /schemas_with\(false, false\)/);
  assert.match(source, /JoinSet::new\(\)/);
  assert.match(source, /specs\.truncate\(MAX_AGENTIC_WORKERS\)/);
  assert.match(source, /is_transient_provider_error/);
  assert.match(source, /retrying affected workers serially/i);
  assert.match(source, /run\.cancel\.load\(Ordering::SeqCst\)/);
  assert.match(source, /redact_sensitive_(text|value)/);
});

test("native and Cursor workers preserve selected provider/model and parent ownership", async () => {
  const [native, cursor, agent] = await Promise.all([
    read("src-tauri/src/agentic.rs"),
    read("src-tauri/src/cursor_bridge.rs"),
    read("src-tauri/src/agent.rs"),
  ]);

  assert.match(native, /build_provider_with_effort\([\s\S]*?&config\.provider[\s\S]*?&config\.model/);
  assert.match(cursor, /run_cursor_agentic_workers/);
  assert.match(cursor, /specs\.iter\(\)\.take\(crate::agentic::MAX_AGENTIC_WORKERS\)/);
  assert.match(cursor, /worker_tool_allowed\(&scope\.agent_id, &name\)/);
  assert.match(cursor, /payload\["run_id"\]/);
  assert.match(cursor, /payload\["agent_id"\]/);
  assert.match(cursor, /payload\["phase"\]/);
  assert.match(cursor, /suppress_reasoning/);
  assert.match(agent, /run_cursor_agentic_workers/);
  assert.match(agent, /CursorAgenticMetrics::default/);
  assert.match(agent, /completion_payload/);
});

test("AGENTIC persistence excludes public reasoning and retains scoped evidence", async () => {
  const [session, chat] = await Promise.all([
    read("src/components/session.ts"),
    read("src/components/chat.ts"),
  ]);

  assert.match(session, /message\.permissionMode === "agentic"/);
  assert.match(session, /const thinking = agentic \? null/);
  assert.match(session, /agentId\?: string/);
  assert.match(session, /phase\?: AgenticPhase/);
  assert.match(session, /redactAgenticCompletion/);
  assert.match(chat, /if \(!this\.agenticRun\)[\s\S]{0,120}appendThinkingTranscriptEvent/);
  assert.match(chat, /case "reasoning":[\s\S]{0,120}if \(!this\.agenticRun\)/);
  assert.match(chat, /startAgenticWorkbench/);
  assert.match(chat, /completeAgenticWorkbench/);
});

test("Execution Workbench and Delivery Board meet the responsive accessibility contract", async () => {
  const [component, css, harness, spec] = await Promise.all([
    read("src/components/agentic-workbench.ts"),
    read("src/theme/agentic-workbench.css"),
    read("src/agentic-layout-harness.html"),
    read("tests/agentic-layout.spec.mjs"),
  ]);

  for (const lane of ["progress", "tools", "agents"]) {
    assert.ok(component.includes(`data-lane="${lane}"`) || component.includes(`agentic-lane-${lane}`));
  }
  for (const phase of ["ask", "plan", "research", "multi_agent", "build"]) {
    assert.ok(component.includes(`"${phase}"`), `missing phase ${phase}`);
  }
  assert.match(component, /role="tablist"/);
  assert.match(component, /aria-controls/);
  assert.match(component, /ArrowLeft|ArrowRight/);
  assert.match(component, /aria-live/);
  assert.match(component, /Inspect run/);
  assert.match(component, /Delivery Board/);
  assert.match(component, /Verification/);
  assert.match(component, /Agent Contributions/);
  assert.match(css, /@media\s*\(max-width:\s*959px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(harness, /scenario/);
  assert.match(spec, /width:\s*390/);
  assert.match(spec, /scrollWidth/);
  assert.match(spec, /toBeFocused/);
  assert.match(spec, /reducedMotion/);
});
