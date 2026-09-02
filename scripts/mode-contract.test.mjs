import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("each public mode has a distinct job, reply shape, and host wiring", async () => {
  const [contract, agent, config, modelbar, settings, profile] = await Promise.all([
    read("src-tauri/src/mode_contract.rs"),
    read("src-tauri/src/agent.rs"),
    read("src-tauri/src/config.rs"),
    read("src/components/modelbar.ts"),
    read("src/components/settings.ts"),
    read("src-tauri/src/execution_profile.rs"),
  ]);

  assert.match(config, /fn default_permission_mode\(\) -> String \{\s*"adaptive"/);
  assert.doesNotMatch(config, /default_permission_mode[\s\S]{0,80}"agentic"/);

  const jobs = {
    ask: ["ACTIVE MODE: ASK", "Lead with the answer", "Time Machine", "FILE CREATE / WRITE / EDIT TOOLS ARE LOCKED"],
    plan: ["ACTIVE MODE: PLAN", "Do not start building", "ask_user TOOL"],
    research: ["ACTIVE MODE: RESEARCH", "Cite what you actually found", "Never invent verification", "Do not silently start writing production code"],
    build: ["ACTIVE MODE: BUILD", "report what shipped"],
    multi_agent: ["ACTIVE MODE: PARALLEL / MULTI-AGENT", "not duplicate chatter"],
  };
  for (const [mode, phrases] of Object.entries(jobs)) {
    for (const phrase of phrases) {
      assert.ok(contract.includes(phrase), `${mode} missing: ${phrase}`);
    }
  }
  assert.doesNotMatch(contract, /You may use every other tool, including search, browser, computer, and agents/);

  assert.match(agent, /mode_contract::permission_mode_prompt/);
  assert.match(agent, /mode_contract::user_turn_suffix/);
  assert.match(agent, /mode_contract::capability_rules/);
  assert.match(contract, /VOICE: lead with the result/);
  assert.match(contract, /No help-desk filler/);
  assert.match(contract, /\[Adaptive Director\]/);
  assert.match(contract, /\[AGENTIC Director\]/);
  assert.match(modelbar, /Adaptive Director \(Auto\) — default/);
  assert.match(modelbar, /AGENTIC Workbench \(opt-in\)/);
  assert.match(settings, /Adaptive is the default/);
  assert.match(settings, /Cursor SDK grok-4\.5/);
  assert.match(profile, /not extra permission/);
  assert.match(profile, /not AGENTIC Thorough/);
  assert.match(profile, /not a permission mode/);
});

test("recommended reply voice stays mode-correct and filler-free", async () => {
  const contract = await read("src-tauri/src/mode_contract.rs");
  assert.match(contract, /REPLY SHAPE: answer first/);
  assert.match(contract, /REPLY SHAPE: goal → numbered plan/);
  assert.match(contract, /REPLY SHAPE: lead with the finding/);
  assert.match(contract, /REPLY SHAPE: 1-2 short sentences of what shipped/);
  assert.match(contract, /REPLY SHAPE: one synthesis of distinct workstream findings/);
  assert.match(contract, /Taglish only when the user enabled it/);
});
