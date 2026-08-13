import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTER_PAUSE_SENTINEL_ENV,
  boundedHistory,
  buildAgentPrompt,
  computerApprovalSummary,
  createComputerUseTools,
  createProgressTools,
  helperEnvironment,
  isToolAllowed,
  mergeHostCustomTools,
  progressTrackingPrompt,
  resolveExecutionPolicy,
  resolveModelSelection,
  resolveSandboxOptions,
  sanitizeComputerToolArguments,
  summarizeTodoWrite,
} from "./cursor-bridge.mjs";
import { redactToolArguments } from "../src/components/session.ts";

test("model selections preserve the configured provider model id", () => {
  assert.equal(resolveModelSelection("default", "high"), undefined);
  assert.deepEqual(resolveModelSelection("grok-4.5", "max"), {
    id: "grok-4.5",
    params: [{ id: "effort", value: "high" }],
  });
  assert.deepEqual(resolveModelSelection("composer-2.5", "ultra"), {
    id: "composer-2.5",
    params: [{ id: "effort", value: "high" }],
  });
  assert.equal(resolveModelSelection("gpt-5.6-sol", "medium").id, "gpt-5.6-sol");
});

test("execution policy maps modes to SDK permissions", () => {
  assert.deepEqual(resolveExecutionPolicy("plan"), {
    requestedMode: "plan",
    sdkMode: "agent",
    autoReview: false,
    readOnly: false,
  });
  assert.deepEqual(resolveExecutionPolicy("ask"), {
    requestedMode: "ask",
    sdkMode: "plan",
    autoReview: false,
    readOnly: true,
  });
  assert.deepEqual(resolveExecutionPolicy("research"), {
    requestedMode: "ask",
    sdkMode: "plan",
    autoReview: false,
    readOnly: true,
  });
  assert.equal(resolveExecutionPolicy("auto").autoReview, true);
  assert.equal(resolveExecutionPolicy("full").sdkMode, "agent");
  assert.deepEqual(resolveExecutionPolicy("multi_agent"), {
    requestedMode: "multi_agent",
    sdkMode: "agent",
    autoReview: false,
    readOnly: false,
  });
  assert.equal(resolveExecutionPolicy("unexpected").readOnly, true);
});

test("sandbox is disabled because the bundled runtime lacks sandbox helpers", () => {
  assert.deepEqual(resolveSandboxOptions(), { enabled: false });
});

test("ask/research stay read-only; plan and full allow mutating tools", () => {
  const ask = resolveExecutionPolicy("ask");
  assert.equal(isToolAllowed(ask, "read"), true);
  assert.equal(isToolAllowed(ask, "grep"), true);
  assert.equal(isToolAllowed(ask, "TodoWrite"), true);
  assert.equal(isToolAllowed(ask, "todo_write"), true);
  assert.equal(isToolAllowed(ask, "update_todos"), true);
  assert.equal(isToolAllowed(ask, "write"), false);
  assert.equal(isToolAllowed(ask, "shell"), false);
  assert.equal(isToolAllowed(ask, "third_party_tool"), false);
  assert.equal(isToolAllowed(resolveExecutionPolicy("research"), "shell"), false);
  assert.equal(isToolAllowed(resolveExecutionPolicy("plan"), "shell"), true);
  assert.equal(isToolAllowed(resolveExecutionPolicy("plan"), "write"), true);
  assert.equal(isToolAllowed(resolveExecutionPolicy("full"), "shell"), true);
});

test("progress tools are always registered for Cursor agents", () => {
  const tools = createProgressTools();
  assert.ok(tools.TodoWrite);
  assert.ok(tools.todo_write);
  assert.ok(tools.UpdateTodos);
  assert.ok(tools.update_todos);
  assert.match(progressTrackingPrompt(), /TodoWrite/);
  assert.match(progressTrackingPrompt(), /never say the todo\/task-list tool is unavailable/i);
  assert.equal(
    summarizeTodoWrite({
      todos: [
        { id: "1", content: "Add IR types", status: "completed" },
        { id: "2", content: "Build HR page", status: "in_progress" },
        { id: "3", content: "Verify build", status: "pending" },
      ],
    }),
    "Task list updated: 3 item(s) — 1 in progress, 1 pending, 1 completed, 0 cancelled.\n- [completed] 1: Add IR types\n- [in_progress] 2: Build HR page\n- [pending] 3: Verify build",
  );
  const merged = mergeHostCustomTools(createProgressTools(), {});
  assert.equal(Object.keys(merged).includes("TodoWrite"), true);
});

test("fresh agents receive only bounded recent transcript context", () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index}`,
  }));
  const bounded = boundedHistory(history);
  assert.equal(bounded.length, 24);
  assert.equal(bounded[0].content, "turn-16");
  assert.equal(bounded.at(-1).content, "turn-39");

  const prompt = buildAgentPrompt("Current request", bounded);
  assert.match(prompt, /turn-16/);
  assert.match(prompt, /turn-39/);
  assert.doesNotMatch(prompt, /turn-0\b/);
  assert.match(prompt, /Current request$/);
});

test("computer use keeps ask observational; plan/full expose action tools", () => {
  const req = {
    computerUseEnabled: true,
    computerHelperPath: "C:\\Program Files\\AI-Forge\\ai-forge.exe",
    computerSessionSecret: "test-session-secret-1234",
  };
  const protocol = { requestApproval: async () => false };

  const askTools = createComputerUseTools(req, resolveExecutionPolicy("ask"), protocol);
  assert.equal(typeof askTools.computer_observe.execute, "function");
  assert.equal(askTools.computer_click, undefined);
  assert.equal(askTools.computer_game_sequence, undefined);

  const planTools = createComputerUseTools(req, resolveExecutionPolicy("plan"), protocol);
  assert.equal(typeof planTools.computer_click.execute, "function");
  assert.equal(typeof planTools.computer_game_sequence.execute, "function");

  const fullTools = createComputerUseTools(req, resolveExecutionPolicy("full"), protocol);
  assert.equal(typeof fullTools.computer_click.execute, "function");
  assert.equal(typeof fullTools.computer_scroll.execute, "function");
  assert.equal(typeof fullTools.computer_game_sequence.execute, "function");
  assert.ok(fullTools.computer_click.inputSchema.required.includes("observation_token"));
  assert.ok(
    fullTools.computer_game_sequence.inputSchema.required.includes("observation_token"),
  );
  assert.equal(
    fullTools.computer_game_sequence.inputSchema.properties.steps.maxItems,
    128,
  );
  assert.equal(
    fullTools.computer_type_text.inputSchema.properties.text.maxLength,
    512,
  );
  assert.equal(
    fullTools.computer_type_text.inputSchema.properties.submit.type,
    "boolean",
  );
});

test("computer use redacts persisted text and forwards the emergency pause sentinel", () => {
  const typedSentinel = "typed-secret-SENTINEL-bridge-28c1";
  const persisted = sanitizeComputerToolArguments("computer_type_text", {
    window_id: "42",
    observation_token: "signed-secret-token",
    text: typedSentinel,
  });
  assert.equal(persisted.observation_token, "[fresh observation token]");
  assert.equal(persisted.text, `[hidden · ${Array.from(typedSentinel).length} characters]`);
  assert.equal(persisted.characters, Array.from(typedSentinel).length);
  assert.doesNotMatch(JSON.stringify(persisted), /typed-secret-SENTINEL|signed-secret-token/);

  const approval = sanitizeComputerToolArguments(
    "computer_type_text",
    { window_id: "42", text: typedSentinel },
    { approval: true },
  );
  const summary = computerApprovalSummary("computer_type_text", {
    window_id: "42",
    text: typedSentinel,
  });
  assert.doesNotMatch(JSON.stringify({ approval, summary }), /typed-secret-SENTINEL/);

  const transcriptArguments = redactToolArguments("computer_type_text", {
    window_id: "42",
    observation_token: "signed-secret-token",
    text: typedSentinel,
  });
  assert.doesNotMatch(
    JSON.stringify(transcriptArguments),
    /typed-secret-SENTINEL|signed-secret-token/,
  );

  const previous = process.env[COMPUTER_PAUSE_SENTINEL_ENV];
  process.env[COMPUTER_PAUSE_SENTINEL_ENV] = "C:\\Temp\\ai-forge-paused";
  try {
    const env = helperEnvironment("session-secret-1234");
    assert.equal(env[COMPUTER_PAUSE_SENTINEL_ENV], "C:\\Temp\\ai-forge-paused");
    assert.equal(env.AI_FORGE_COMPUTER_SESSION, "session-secret-1234");
  } finally {
    if (previous === undefined) delete process.env[COMPUTER_PAUSE_SENTINEL_ENV];
    else process.env[COMPUTER_PAUSE_SENTINEL_ENV] = previous;
  }
});
