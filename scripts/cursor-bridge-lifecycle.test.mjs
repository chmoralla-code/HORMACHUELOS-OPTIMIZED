import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createDuplexProtocol,
  createHostTools,
  inspectionToolDeadline,
  isCursorInspectionTool,
  nextCursorStreamEvent,
  resolveExecutionPolicy,
  unresolvedCursorToolResult,
} from "./cursor-bridge.mjs";

test("an unresolved Cursor tool is always failed, even when the run says finished", () => {
  assert.equal(unresolvedCursorToolResult("finished", null).ok, false);
  assert.equal(unresolvedCursorToolResult("completed", null).ok, false);
  assert.match(
    unresolvedCursorToolResult("failed", "provider disconnected").content,
    /provider disconnected/,
  );
});

test("silent Cursor inspection tools use an absolute deadline", () => {
  assert.equal(isCursorInspectionTool("grep"), true);
  assert.equal(isCursorInspectionTool("ripgrep"), true);
  assert.equal(isCursorInspectionTool("read_file"), true);
  assert.equal(isCursorInspectionTool("write_file"), false);

  const openTools = new Map([
    ["search-1", { name: "grep", startedAt: 1_000 }],
    ["write-1", { name: "write_file", startedAt: 0 }],
  ]);
  assert.deepEqual(inspectionToolDeadline(openTools, 2_000, 45_000), {
    id: "search-1",
    name: "grep",
    waitMs: 44_000,
  });
  // Later reasoning/status events must not reset a search that has already
  // consumed its deadline.
  assert.deepEqual(inspectionToolDeadline(openTools, 46_001, 45_000), {
    id: "search-1",
    name: "grep",
    waitMs: 0,
  });
});

test("Cursor stream wait returns when an open search is already overdue", async () => {
  const neverEndingStream = {
    next() {
      return new Promise(() => {});
    },
  };
  const openTools = new Map([
    [
      "search-overdue",
      { name: "grep", startedAt: Date.now() - 45_001 },
    ],
  ]);

  const outcome = await nextCursorStreamEvent(neverEndingStream, openTools);
  assert.equal(outcome.kind, "inspection_timeout");
  assert.equal(outcome.tool.id, "search-overdue");
  assert.equal(outcome.tool.name, "grep");
});

test("duplex protocol survives a long run of native host tool responses", async () => {
  const input = new PassThrough();
  const events = [];
  const protocol = createDuplexProtocol(input, (event) => events.push(event));
  input.write(`${JSON.stringify({ apiKey: "test" })}\n`);
  assert.deepEqual(await protocol.readRequest(), { apiKey: "test" });

  const pending = protocol.requestHostTool({
    name: "grep",
    arguments: { pattern: "needle", path: "." },
  });
  const request = events.at(-1);
  assert.equal(request.type, "host_tool_request");
  assert.equal(request.name, "grep");
  input.write(
    `${JSON.stringify({
      type: "host_tool_response",
      requestId: request.requestId,
      ok: true,
      content: "src/main.ts:10:needle",
    })}\n`,
  );

  assert.deepEqual(await pending, {
    ok: true,
    content: "src/main.ts:10:needle",
  });

  for (let index = 0; index < 128; index += 1) {
    const next = protocol.requestHostTool({
      name: "read_file",
      arguments: { path: `src/feature-${index}.ts` },
    });
    const event = events.at(-1);
    input.write(
      `${JSON.stringify({
        type: "host_tool_response",
        requestId: event.requestId,
        ok: true,
        content: `feature-${index}`,
      })}\n`,
    );
    assert.deepEqual(await next, { ok: true, content: `feature-${index}` });
  }
  assert.equal(
    events.filter((event) => event.type === "host_tool_request").length,
    129,
  );
  protocol.close();
});

test("Ask mode preserves authorized Preview observe and action tools", async () => {
  const input = new PassThrough();
  const events = [];
  const protocol = createDuplexProtocol(input, (event) => events.push(event));
  input.write(`${JSON.stringify({ apiKey: "test" })}\n`);
  assert.deepEqual(await protocol.readRequest(), { apiKey: "test" });

  const schemas = [
    {
      name: "computer_observe",
      description: "Observe the active Preview tab",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "computer_actions",
      description: "Act inside the active Preview tab",
      inputSchema: {
        type: "object",
        properties: {
          actions: { type: "array" },
        },
        required: ["actions"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Write a project file",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  const outcomes = new Map();
  const tools = createHostTools(
    schemas,
    resolveExecutionPolicy("ask"),
    protocol,
    outcomes,
  );
  assert.deepEqual(
    Object.keys(tools).sort(),
    ["computer_actions", "computer_observe"],
  );

  const actions = [{ type: "click", ref: "p1" }];
  const pending = tools.computer_actions.execute(
    { actions },
    { toolCallId: "preview-action-1" },
  );
  const request = events.at(-1);
  assert.equal(request.type, "host_tool_request");
  assert.equal(request.name, "computer_actions");
  assert.deepEqual(request.arguments, { actions });

  input.write(
    `${JSON.stringify({
      type: "host_tool_response",
      requestId: request.requestId,
      ok: true,
      content: JSON.stringify({
        ok: true,
        scope: "active-preview-tab-only",
        completed: 1,
      }),
    })}\n`,
  );

  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(outcomes.get("preview-action-1"), true);
  protocol.close();
});

test("Cursor custom tools delegate to the native dispatcher and preserve failures", async () => {
  const calls = [];
  const protocol = {
    async requestHostTool(request) {
      calls.push(request);
      return { ok: false, content: "Error: invalid pattern" };
    },
  };
  const schemas = [
    {
      name: "grep",
      description: "Search files",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  const outcomes = new Map();
  const readOnlyTools = createHostTools(
    schemas,
    resolveExecutionPolicy("ask"),
    protocol,
    outcomes,
  );
  assert.deepEqual(Object.keys(readOnlyTools), ["grep"]);

  const result = await readOnlyTools.grep.execute(
    { pattern: "[", path: "" },
    { toolCallId: "native-call-1" },
  );
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Error: invalid pattern");
  assert.equal(outcomes.get("native-call-1"), false);
  assert.deepEqual(calls, [
    { name: "grep", arguments: { pattern: "[", path: "" } },
  ]);
});
