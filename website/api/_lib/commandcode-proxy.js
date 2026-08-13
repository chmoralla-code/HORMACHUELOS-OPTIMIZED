/**
 * Command Code hosted adapter.
 *
 * Command Code's gateway (`/alpha/generate`) is NOT OpenAI-compatible: it
 * wraps parameters in a `{ config, memory, params }` envelope, uses content
 * blocks for messages (text / tool-call / tool-result / reasoning), requires
 * Anthropic-style tool schemas, and streams NDJSON lines instead of SSE.
 *
 * This module translates the desktop's OpenAI-style `/chat/completions`
 * request into that envelope and back, so clients can use the shared
 * server-side key through the normal hosted proxy.
 */

const GENERATE_ENDPOINT = "/alpha/generate";
const CLIENT_VERSION = "1.14.1";

/** Content blocks for the wire format, mirroring the official CLI. */
function wireMessages(openaiMessages) {
  const out = [];
  for (const message of Array.isArray(openaiMessages) ? openaiMessages : []) {
    const role = String(message.role || "").toLowerCase();
    if (role === "assistant") {
      const blocks = [];
      const text = message.content;
      if (typeof text === "string" && text.trim()) {
        blocks.push({ type: "text", text });
      }
      if (Array.isArray(message.reasoning_content)) {
        for (const chunk of message.reasoning_content) {
          if (typeof chunk === "string" && chunk.trim()) {
            blocks.push({ type: "reasoning", text: chunk });
          }
        }
      } else if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        blocks.push({ type: "reasoning", text: message.reasoning_content });
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        blocks.push({
          type: "tool-call",
          toolCallId: String(call.id || "call"),
          toolName: String(call.function?.name || ""),
          input: typeof call.function?.arguments === "string"
            ? safeJson(call.function.arguments)
            : (call.function?.arguments || {}),
        });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (role === "tool") {
      const content = typeof message.content === "string" ? message.content : "";
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: String(message.tool_call_id || "tool"),
          toolName: String(message.name || ""),
          output: { type: "text", value: content },
        }],
      });
      continue;
    }
    if (role === "user" || role === "system") {
      // System messages are carried in the top-level `system` field. User
      // content may be a string or an array of parts (text + image_url for
      // vision). Image parts are forwarded as Command Code `image` blocks.
      const parts = Array.isArray(message.content) ? message.content : [];
      const blocks = [];
      for (const part of parts) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          blocks.push({ type: "text", text: part.text });
        } else if (part?.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (typeof url === "string" && url.startsWith("data:")) {
            const mime = (url.match(/^data:([^;,]+)/) || [])[1] || "image/png";
            blocks.push({ type: "image", image: url, mimeType: mime });
          }
        }
      }
      if (!blocks.length) {
        const text = typeof message.content === "string" ? message.content : "";
        if (text.trim()) blocks.push({ type: "text", text });
      }
      if (blocks.length) out.push({ role: "user", content: blocks });
    }
  }
  return out;
}

/** OpenAI `tools` array → Command Code `{name, description, input_schema}`. */
function wireTools(openaiTools) {
  return (Array.isArray(openaiTools) ? openaiTools : [])
    .map((tool) => {
      const fn = tool?.function || {};
      return {
        name: String(fn.name || ""),
        description: String(fn.description || ""),
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    })
    .filter((tool) => tool.name);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function buildConfig() {
  return {
    workingDir: "/",
    date: new Date().toISOString().split("T")[0],
    environment: "linux",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

/** Build the /alpha/generate request from an OpenAI-style chat request. */
export function buildCommandCodeRequest({ model, messages, tools, system, maxTokens, temperature, reasoningEffort }) {
  return {
    config: buildConfig(),
    memory: "",
    params: {
      model: String(model || ""),
      messages: wireMessages(messages),
      tools: wireTools(tools),
      system: String(system || ""),
      max_tokens: Math.max(1, Number(maxTokens) || 64_000),
      stream: true,
      ...(typeof temperature === "number" && Number.isFinite(temperature)
        ? { temperature }
        : {}),
      ...(typeof reasoningEffort === "string" && reasoningEffort.trim()
        ? { reasoning_effort: reasoningEffort.trim() }
        : {}),
    },
  };
}

export function commandCodeHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "User-Agent": "cli",
    "x-command-code-version": CLIENT_VERSION,
    "x-cli-environment": "production",
    "x-taste-learning": "false",
    "x-co-flag": "false",
    "x-session-id": crypto.randomUUID(),
    Authorization: `Bearer ${apiKey}`,
  };
}

export function commandCodeGenerateUrl(baseUrl) {
  return `${String(baseUrl || "https://api.commandcode.ai").replace(/\/+$/, "")}${GENERATE_ENDPOINT}`;
}

/**
 * Translate Command Code NDJSON events into an OpenAI SSE payload and emit it.
 * Returns the total usage tokens seen in the stream.
 */
function eventText(event) {
  if (typeof event?.text === "string" && event.text) return event.text;
  if (typeof event?.delta === "string" && event.delta) return event.delta;
  if (typeof event?.content === "string" && event.content) return event.content;
  if (event?.delta && typeof event.delta === "object") {
    return String(event.delta.text || event.delta.content || "");
  }
  return "";
}

export async function relayCommandCodeStream({ reader, onSse }) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usageRaw = 0;

  function emit(payload) {
    onSse(`data: ${JSON.stringify(payload)}\n\n`);
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // keepalive / partial
    }
    const type = String(event.type || "");
    switch (type) {
      case "text-delta":
      case "text":
      case "content-delta":
      case "output-text-delta": {
        emit({
          choices: [{
            delta: { content: eventText(event) },
            index: 0,
          }],
        });
        break;
      }
      case "reasoning-delta":
      case "reasoning": {
        emit({
          choices: [{
            delta: { reasoning_content: eventText(event) },
            index: 0,
          }],
        });
        break;
      }
      case "tool-call": {
        const name = String(event.toolName || "");
        const id = String(event.toolCallId || "call");
        emit({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(event.input || {}),
                },
              }],
            },
            index: 0,
          }],
        });
        break;
      }
      case "finish": {
        const raw = String(event.rawFinishReason || event.finishReason || "stop");
        const finishReason = raw === "tool_calls" ? "tool_calls" : raw === "length" ? "length" : "stop";
        const usage = event.totalUsage || {};
        const inputTokens = Number(usage.inputTokens || 0);
        const outputTokens = Number(usage.outputTokens || 0);
        if (inputTokens || outputTokens) {
          usageRaw = Math.max(usageRaw, inputTokens + outputTokens);
        }
        emit({
          choices: [{
            delta: {},
            index: 0,
            finish_reason: finishReason,
          }],
          usage: { total_tokens: inputTokens + outputTokens },
        });
        break;
      }
      case "error": {
        const message =
          (typeof event.error === "string" ? event.error : event.error?.message) ||
          "Command Code stream error";
        emit({ error: { message: String(message), type: "commandcode_error" } });
        break;
      }
      default:
        // start / start-step / text-start / text-end / finish-step /
        // provider-metadata / tool-result are not forwarded.
        break;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) await handleLine(line);
  }
  if (buffer.trim()) await handleLine(buffer);
  return usageRaw;
}
