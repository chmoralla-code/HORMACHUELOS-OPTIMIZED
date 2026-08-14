// Shared render helpers
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

export function div(cls: string = "", html = "", kids: Node[] = []): HTMLDivElement {
  const node = document.createElement("div");
  if (cls) node.className = cls;
  if (html) node.innerHTML = html;
  for (const k of kids) node.appendChild(k);
  return node;
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

/**
 * Paint one lightweight live-activity label.
 *
 * Older builds wrapped every character in its own infinitely animated span.
 * A long agent transcript could therefore leave thousands of independent CSS
 * animations behind. Keep the same provider tone on one compositor-friendly
 * element instead; terminal cleanup can stop it with a single class change.
 */
export function setShimmerText(el: HTMLElement | null, text: string, shimmer: boolean) {
  if (!el) return;
  const pinkOpenAi = !!el.closest("#chat.chat-sol");
  const toneClass = pinkOpenAi ? "shine-pink" : "shine-blue";
  if (!shimmer) {
    el.removeAttribute("data-shimmer");
    el.removeAttribute("aria-label");
    el.classList.remove("activity-shimmer", "shine-blue", "shine-red", "shine-pink");
    el.textContent = text;
    return;
  }
  if (
    el.getAttribute("data-shimmer") === text &&
    el.classList.contains("activity-shimmer") &&
    el.classList.contains(toneClass) &&
    el.textContent === text
  ) {
    return;
  }
  el.setAttribute("data-shimmer", text);
  el.setAttribute("aria-label", text);
  el.classList.remove("shine-blue", "shine-red", "shine-pink");
  el.classList.add("activity-shimmer", toneClass);
  el.textContent = text;
}

export function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Short stamp under chat, e.g. "14 Jul · 23:06". */
export function formatChatTime(ms?: number | null): string {
  const d = new Date(ms && ms > 0 ? ms : Date.now());
  try {
    const day = d.getDate();
    const mon = d.toLocaleString(undefined, { month: "short" });
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${mon} · ${hh}:${mm}`;
  } catch {
    const iso = d.toISOString();
    return `${iso.slice(8, 10)} ${iso.slice(5, 7)} · ${iso.slice(11, 16)}`;
  }
}

/** Format token counts for the usage chip (e.g. 12400 → "12.4k"). */
export function formatTokens(n: number): string {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** User-facing plan names — must match website plan ids (starter ≠ pro). */
export function displayPlanLabel(plan: string): string {
  const p = (plan || "").trim().toLowerCase();
  if (p === "proplus" || p === "pro+" || p === "pro_plus") return "Pro+";
  if (p === "max20") return "Max 20×";
  if (p === "max10") return "Max 10×";
  if (p === "max5" || p === "max" || p === "ultra" || p === "agency") return "Max 5×";
  if (p === "pro" || p === "fifteen" || p === "15day" || p === "15-day") return "Pro";
  if (p === "starter" || p === "start") return "Starter";
  if (p === "free" || p === "expired" || !p) return p === "expired" ? "Expired" : p === "free" ? "Free" : "Plan";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

type MarkdownTableAlignment = "left" | "center" | "right";

function isEscapedAt(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/** Split a Markdown table row without treating escaped pipes as columns. */
function splitMarkdownTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !isEscapedAt(row, row.length - 1)) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "|" && !isEscapedAt(row, index)) {
      cells.push(cell);
      cell = "";
    } else {
      cell += row[index];
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim().replace(/\\\|/g, "|"));
}

function isMarkdownTableDivider(cells: string[]): boolean {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function markdownTableAlignment(marker: string): MarkdownTableAlignment {
  const value = marker.trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

/**
 * Converts standard Markdown tables into an accessible, scrollable table.
 * This is intentionally run after escaping user text, so table cells cannot
 * introduce raw HTML into the chat transcript.
 */
function renderMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index];
    const dividerLine = lines[index + 1];
    if (!headerLine.includes("|") || !dividerLine?.includes("|")) {
      output.push(headerLine);
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine);
    const dividers = splitMarkdownTableRow(dividerLine);
    if (
      headers.length < 2 ||
      headers.length !== dividers.length ||
      !isMarkdownTableDivider(dividers)
    ) {
      output.push(headerLine);
      continue;
    }

    const hasOuterPipes = headerLine.trim().startsWith("|");
    const alignments = dividers.map(markdownTableAlignment);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor];
      if (
        !rowLine.trim() ||
        !rowLine.includes("|") ||
        (hasOuterPipes && !rowLine.trim().startsWith("|"))
      ) {
        break;
      }
      const cells = splitMarkdownTableRow(rowLine);
      if (cells.length < 2) break;
      rows.push(headers.map((_header, cellIndex) => cells[cellIndex] || ""));
      cursor += 1;
    }

    const headerHtml = headers
      .map((header, cellIndex) => (
        `<th scope="col" data-align="${alignments[cellIndex]}">${header}</th>`
      ))
      .join("");
    const bodyHtml = rows
      .map((row) => `<tr>${row.map((cell, cellIndex) => `<td data-align="${alignments[cellIndex]}">${cell}</td>`).join("")}</tr>`)
      .join("");

    // Blank separators ensure surrounding prose still receives paragraph markup.
    output.push("");
    output.push(
      `<div class="md-table-wrap" role="region" aria-label="Response table" tabindex="0"><table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    );
    output.push("");
    index = cursor - 1;
  }

  return output.join("\n");
}

type CompletionField = "title" | "description" | "summary" | "features" | "technology" | "files" | "nextSteps";

function completionField(line: string): { field: CompletionField; value: string } | null {
  const match = line.match(
    /^\s*(?:[-*]\s*)?(title|description|summary|result|features?|tech(?:nology|nologies)?|files?|next\s*steps?)\s*:\s*(.*?)\s*$/i,
  );
  if (!match) return null;
  const label = match[1].replace(/\s+/g, "").toLowerCase();
  const field: CompletionField =
    label === "title"
      ? "title"
      : label === "description"
        ? "description"
        : label === "summary" || label === "result"
          ? "summary"
          : label.startsWith("feature")
            ? "features"
            : label.startsWith("tech")
              ? "technology"
              : label.startsWith("file")
                ? "files"
                : "nextSteps";
  return { field, value: match[2].trim() };
}

function splitInlineCompletionItems(value: string): string[] {
  return value
    .split(/\s*(?:[,;]|\s+·\s+)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCompletionBlock(lines: string[]): string[] {
  const fields = lines.map(completionField).filter(Boolean);
  // Two labelled fields is enough to distinguish an agent's structured delivery
  // from an ordinary sentence that happens to contain a colon.
  if (fields.length < 2) return lines;

  const output: string[] = [];
  const separate = () => {
    if (output.length && output[output.length - 1] !== "") output.push("");
  };

  for (const line of lines) {
    const entry = completionField(line);
    if (!entry) {
      // Models occasionally type a literal "done" before trying to call the
      // structured completion tool. It adds no user-facing information.
      if (/^\s*(?:done|complete(?:d)?)\s*[.!]?\s*$/i.test(line)) continue;
      output.push(line);
      continue;
    }

    const value = entry.value;
    switch (entry.field) {
      case "title":
        separate();
        output.push(`## ${value || "Result"}`);
        output.push("");
        break;
      case "description":
      case "summary":
        if (value) {
          separate();
          output.push(value);
          output.push("");
        }
        break;
      case "features":
      case "nextSteps": {
        separate();
        output.push(entry.field === "features" ? "### Highlights" : "### Next steps");
        const items = splitInlineCompletionItems(value);
        if (items.length) output.push(...items.map((item) => `- ${item}`));
        output.push("");
        break;
      }
      case "technology":
        separate();
        output.push("### Technology");
        if (value) output.push(value);
        output.push("");
        break;
      case "files": {
        separate();
        output.push("### Files");
        const files = splitInlineCompletionItems(value);
        if (files.length) {
          output.push(
            ...files.map((file) => `- \`${file.replace(/^`+|`+$/g, "")}\``),
          );
        }
        output.push("");
        break;
      }
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").split("\n");
}

function trimStructuredPunctuation(value: string): string {
  return value
    .trim()
    .replace(/^[\s`"'\[\]{}(),]+|[\s`"'\[\]{}(),]+$/g, "")
    .trim();
}

function standalonePathSeparator(value: string): string {
  const candidate = trimStructuredPunctuation(value);
  return /^[./\\]+$/.test(candidate) ? candidate : "";
}

function looksLikePathPart(value: string): boolean {
  return /^[a-z0-9_@][a-z0-9_@.-]{0,127}$/i.test(value);
}

function looksLikePathValue(value: string): boolean {
  return /^[a-z0-9_@][a-z0-9_@./\\-]{0,255}$/i.test(value);
}

function isStructuredPunctuationOnly(value: string): boolean {
  return /^[\s`"'\[\]{}(),;]+$/.test(value);
}

/**
 * A few low-cost/free tool-capable models stream function arguments through
 * their prose channel one token per line. Rejoin only clear file-path shapes
 * (for example `index`, `.`, `html`), leaving normal prose and all code fences
 * untouched.
 */
function repairFragmentedPaths(lines: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const raw = lines[index];
    const first = trimStructuredPunctuation(raw);
    let candidate = first;
    let cursor = index;
    let joins = 0;

    while (looksLikePathValue(candidate) && cursor + 2 < lines.length) {
      const separator = standalonePathSeparator(lines[cursor + 1]);
      const next = trimStructuredPunctuation(lines[cursor + 2]);
      if (!separator || !looksLikePathPart(next)) break;
      candidate += separator + next;
      cursor += 2;
      joins += 1;
    }

    if (joins > 0 && (/[\\/]/.test(candidate) || /\.[a-z0-9]{1,12}$/i.test(candidate))) {
      const indent = raw.match(/^\s*/)?.[0] || "";
      output.push(indent + candidate);
      index = cursor + 1;
      continue;
    }

    // A comma/backtick-only line left beside a repaired argument is never
    // readable user prose. Drop it rather than leaving a vertical punctuation
    // trail in the final answer.
    if (isStructuredPunctuationOnly(raw)) {
      index += 1;
      continue;
    }
    output.push(raw);
    index += 1;
  }
  return output;
}

function normalizePlainAssistantMarkdown(src: string): string {
  const withoutToolMarkup = src
    .replace(/<\s*(?:tool_call|function_call|tool_use)\b[^>]*>[\s\S]*?<\/\s*(?:tool_call|function_call|tool_use)\s*>/gi, "")
    .replace(/^\s*<\/?\s*(?:tool_call|function_call|tool_use)\b[^>]*>\s*$/gim, "");
  const repaired = promoteStandaloneBoldHeadings(repairGluedProse(withoutToolMarkup))
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");
  const lines = repairFragmentedPaths(repaired.split("\n"));
  return normalizeCompletionBlock(lines).join("\n");
}

function isProcessSentence(sentence: string): boolean {
  const lower = sentence.trim().replace(/^["'`*]+/, "").toLowerCase();
  if (!lower) return false;
  if (
    lower.includes("auto-view timed out") ||
    lower.includes("autoview timed out") ||
    lower.includes("let me call view_image") ||
    lower.includes("call view_image on") ||
    lower.includes("pure description request") ||
    lower.includes("no tools needed")
  ) {
    return true;
  }
  return [
    "the user wants",
    "the user just wants",
    "the user asked",
    "the user is asking",
    "this is a pure",
    "let me describe",
    "i'll describe",
    "i will describe",
    "let me call",
    "let me look",
    "let me explore",
    "i'll explore",
    "i will explore",
    "let me inspect",
    "i'll look",
    "i will look",
    "let and explore",
    "let me also",
    "i'll also",
    "next i'll",
    "now i'll",
    "let me simplify",
    "let me give",
    "let me write",
    "i'll write",
    "i will write",
    "let me provide",
    "i'll provide",
    "i will provide",
    "let me compose",
    "let me verify",
    "let me check",
    "let me start",
    "let me dig",
    "i'll dig",
    "i will dig",
    "okay, the user",
    "ok, the user",
  ].some((prefix) => lower.startsWith(prefix));
}

/** Drop a trailing "Let me…" / "I'll…" promise so the visible bubble keeps the answer. */
export function stripTrailingPendingAction(text: string): string {
  let out = String(text || "").trim();
  const pending = out.match(
    /(?:\s+|[—–;:]\s*)(?:let me|i(?:'|’)ll|i will)\s+(?:verify|check|start|run|open|inspect|look|find|try|read|continue|deliver|explore|analy[sz]e|examine|review|investigate|search|scan|dig)\b[\s\S]*$/i,
  );
  if (pending?.index != null) {
    const before = out.slice(0, pending.index).trim();
    if ([...before].length >= 12) out = before;
  }
  return out;
}

/** Turn a sealed thought into the user-facing reply when the model never posted one. */
export function visibleAnswerFromThought(thought: string): string {
  const stripped = compactVisibleReply(thought);
  return [...stripped].length >= 12 ? stripped : "";
}

const PROGRESS_ACTION =
  /\blet me (verify|check|start|run|open|inspect|look|find|try|read|continue|deliver|explore|analyze|dig)\b/i;

function isProgressOnlyBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return true;
  const sentences = trimmed.split(/(?<=[.!?…])\s+/).map((part) => part.trim()).filter(Boolean);
  if (!sentences.length) return true;
  return sentences.every((sentence) => {
    const lower = sentence.toLowerCase();
    return (
      /^(let me (verify|check|start|run|open|inspect|look|find|try|read|continue|deliver|call|describe|explore|analyze|dig|write|provide|compose)\b)/i.test(sentence) ||
      /^(let and explore\b)/i.test(sentence) ||
      /^(i'll |i will |next i'll |now i'll )(verify|check|start|run|open|inspect|look|find|try|read|continue|deliver|call|explore|analyze|dig)\b/i.test(sentence) ||
      (PROGRESS_ACTION.test(lower) && sentence.length < 180 && /^(let me |i'll |i will )/i.test(sentence))
    );
  });
}

/** Insert a missing space when stream chunks glue "word.Word" or "**bold**Next". */
export function repairGluedProse(text: string): string {
  return String(text || "")
    .split(/(```[\s\S]*?```)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/([a-z0-9])([.!?…])([A-Z])/g, "$1$2 $3")
        .replace(/(\*\*[^*]+?\*\*)(?=[A-Za-z(])/g, "$1 ");
    })
    .join("");
}

function streamJoinGap(left: string, right: string): string {
  if (/\s$/.test(left) || /^\s/.test(right)) return "";
  const a = left.slice(-1);
  const b = right.charAt(0);
  if (!a || !b) return "";
  if (/[.!?…]/.test(a) && /[A-Za-z]/.test(b)) return " ";
  if (/[a-z0-9*]/.test(a) && /[A-Z]/.test(b)) return " ";
  return "";
}

/** Merge a reasoning/prose delta without duplicating a full snapshot. */
export function joinStreamChunks(left: string, right: string): string {
  if (!right) return left || "";
  if (!left) return right;
  if (right.startsWith(left)) return right;
  if (left.startsWith(right)) return left;
  if (left.endsWith(right)) return left;
  const max = Math.min(left.length, right.length, 240);
  for (let n = max; n >= 12; n -= 1) {
    if (left.slice(-n) === right.slice(0, n)) return left + right.slice(n);
  }
  return left + streamJoinGap(left, right) + right;
}

/** Cut a reasoning loop that reprints its opening paragraph. */
export function dedupeLoopedReasoning(text: string): string {
  const src = String(text || "");
  if (src.length < 80) return src;
  const probeLen = Math.min(140, Math.floor(src.length / 2));
  const probe = src.slice(0, probeLen);
  const second = src.indexOf(probe, Math.max(24, probeLen - 16));
  if (second >= probeLen - 16) return src.slice(0, second).trimEnd();
  return src;
}

export function mergeReasoningStream(existing: string, chunk: string): string {
  return dedupeLoopedReasoning(repairGluedProse(joinStreamChunks(String(existing || ""), String(chunk || ""))));
}

function promoteStandaloneBoldHeadings(src: string): string {
  return String(src || "").replace(
    /^(?:\*\*|__)([^\n*.]{2,56}?)(?:-)?(?:\*\*|__)\s*-{0,3}\s*$/gm,
    "### $1",
  );
}

function dropOrphanContinuations(text: string, dropLowercase = false): string {
  let remaining = String(text || "").trimStart();
  while (remaining) {
    const match = remaining.match(/^[\s\S]*?(?:[.!?…]|\n|$)/);
    const sentence = match?.[0] || remaining;
    if (!sentence) break;
    if (!sentence.trim()) {
      remaining = remaining.slice(sentence.length);
      continue;
    }
    const trimmed = sentence.trim();
    const danglingLead = /^-based\b|^based answer\.?$/i.test(trimmed);
    const lowercaseFragment =
      dropLowercase &&
      /^[a-z]/.test(trimmed) &&
      trimmed.length < 140 &&
      !/^`|^[-*] |^#{1,3}\s/.test(trimmed);
    if (danglingLead || lowercaseFragment) {
      remaining = remaining.slice(sentence.length);
      continue;
    }
    break;
  }
  return remaining.trim();
}

/** Drop mid-reply "Let me verify…" progress lines so the bubble stays the answer. */
export function compactVisibleReply(text: string): string {
  const repaired = repairGluedProse(String(text || ""));
  const stripped = stripProcessPreamble(repaired);
  const afterOrphans = dropOrphanContinuations(
    stripped,
    stripped !== repaired.trimStart(),
  );
  const prepared = stripTrailingPendingAction(afterOrphans);
  return prepared
    .split(/\n{2,}/)
    .map((block) => stripTrailingPendingAction(block.trim()))
    .filter((block) => block && !isProgressOnlyBlock(block))
    .join("\n\n")
    .trim();
}

/**
 * Accumulate provider deltas without ever replacing the lossless source with a
 * presentation-cleaned snapshot. Streaming cleanup can temporarily hide an
 * unfinished preamble; retaining `source` guarantees later chunks can restore
 * the complete answer instead of continuing from a truncated rendering.
 */
export function appendVisibleAssistantChunk(
  source: string,
  chunk: string,
): { source: string; visible: string } {
  const nextSource = String(source || "") + String(chunk || "");
  return {
    source: nextSource,
    visible: compactVisibleReply(nextSource),
  };
}

/**
 * Tool-call responses often contain short process narration rather than the
 * answer. Preserve structured plans and substantive prose, but suppress the
 * "let me inspect…" fragments that would otherwise become permanent bubbles.
 */
export function looksLikeProvisionalToolNarration(text: string): boolean {
  const raw = repairGluedProse(String(text || "")).trim();
  const visible = compactVisibleReply(raw);
  if (!visible) return true;
  if (
    visible.length >= 420 ||
    /(?:^|\n)#{1,3}\s+/.test(visible) ||
    /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/.test(visible) ||
    /\|[^\n]+\|/.test(visible) ||
    /```/.test(visible)
  ) {
    return false;
  }
  if (/^[a-z]/.test(visible)) return true;
  return /(?:^|[\s—–;:])(?:let me|i(?:'|’)ll|i will)\s+(?:verify|check|start|run|open|inspect|look|find|try|read|continue|deliver|explore|analy[sz]e|examine|review|investigate|search|scan|dig)\b/i
    .test(raw);
}

export function looksLikeDeliveryEssay(text: string): boolean {
  const src = String(text || "");
  if (/(?:^|\n)#{1,3}\s*result\b/i.test(src)) return true;
  if (/(?:^|\n)result\s*[—–-]/i.test(src)) return true;
  const labels = src.match(/(?:^|\n)\s*(?:title|description|summary|features|tech|files)\s*:/gim);
  return (labels?.length || 0) >= 2;
}

/** Keep one or two lead sentences when the host Completed card owns the result. */
export function deliveryLeadFromReply(text: string): string {
  const compact = compactVisibleReply(text)
    .split(/\n(?=#{1,3}\s*result\b|(?:\*\*)?result\s*[—–-])/i)[0]
    .replace(/\n#{1,3}\s*(highlights|technology|files|next steps)\b[\s\S]*$/i, "")
    .replace(/^#{1,3}\s*result\b[^\n]*\n?/i, "")
    .replace(/^(?:\*\*)?result\s*[—–-][^\n]*\n?/i, "")
    .trim();
  if (!compact || looksLikeDeliveryEssay(compact)) return "";
  const sentences = compact.split(/(?<=[.!?…])\s+/).filter((part) => {
    const trimmed = part.trim();
    return trimmed && !/^[-*]\s/.test(trimmed) && !/^#{1,3}\s/.test(trimmed);
  });
  const lead = sentences.slice(0, 2).join(" ").trim();
  if (!lead || looksLikeDeliveryEssay(lead)) return "";
  if ([...lead].length <= 280) return lead;
  return `${lead.slice(0, 277).replace(/\s+\S*$/, "")}…`;
}

/** Drop leading thought/tool narration so the bubble starts on the real answer. */
export function stripProcessPreamble(text: string): string {
  let remaining = String(text || "");
  while (remaining) {
    const match = remaining.match(/^[\s\S]*?(?:[.!?…]|\n|$)/);
    const sentence = match?.[0] || remaining;
    if (!sentence) break;
    if (!sentence.trim()) {
      remaining = remaining.slice(sentence.length);
      continue;
    }
    if (!isProcessSentence(sentence)) return remaining.trimStart();
    remaining = remaining.slice(sentence.length);
  }
  return remaining.trim();
}

/**
 * Make an assistant response pleasant to scan without changing meaningful
 * Markdown. This deliberately skips fenced code blocks, where exact content
 * matters more than presentation.
 */
export function normalizeAssistantMarkdown(src: string): string {
  if (!src) return "";
  const stripped = compactVisibleReply(src);
  const normalized = stripped.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  return normalized
    .split(/(```[\s\S]*?```)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : normalizePlainAssistantMarkdown(segment)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Safe subset markdown → HTML.
 * Escapes all HTML first, then applies only controlled substitutions (no raw HTML passthrough).
 */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  src = normalizeAssistantMarkdown(src);
  // Extract fenced code blocks first (protect from other transforms)
  const fences: string[] = [];
  let text = src.replace(/```([\w-]*)\r?\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const i = fences.length;
    const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    fences.push(`<pre class="md-code"><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });

  // Escape remaining text
  text = escapeHtml(text);

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, "<code class=\"md-inline\">$1</code>");

  // Bold / italic (order matters)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");

  // Headings
  text = text.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  text = text.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  text = text.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Models commonly put a blank line between Markdown list items. Collapse
  // only gaps whose next non-empty line is another marker of the same kind so
  // one semantic list renders with continuous bullets/numbers.
  text = text
    .replace(/(^[-*+] .+)\n[\t ]*\n(?=[-*+] )/gm, "$1\n")
    .replace(/(^\d+\. .+)\n[\t ]*\n(?=\d+\. )/gm, "$1\n");

  // Unordered lists (consecutive lines)
  text = text.replace(/(?:^[-*+] .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => line.replace(/^[-*+] /, "").trim())
      .filter(Boolean)
      .map((item) => `<li>${item}</li>`)
      .join("");
    return `<ul class="md-list">${items}</ul>\n`;
  });

  // Ordered lists
  text = text.replace(/(?:^\d+\. .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\d+\. /, "").trim())
      .filter(Boolean)
      .map((item) => `<li>${item}</li>`)
      .join("");
    return `<ol class="md-list">${items}</ol>\n`;
  });

  // Links [text](https://...)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer"><span class="md-link-ico" aria-hidden="true"></span>$1</a>',
  );

  // Bare URLs (after markdown links so we don't double-wrap)
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g,
    '$1<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer"><span class="md-link-ico" aria-hidden="true"></span>$2</a>',
  );

  // Tables must be converted before generic paragraph splitting.
  text = renderMarkdownTables(text);

  // Paragraphs / line breaks for remaining plain lines
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|pre|blockquote|div|table)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  // Restore fences
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] || "");

  return text;
}

/** Prefer a female system voice for the “done working” cue. */
function pickFemaleVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const scored = voices.map((v) => {
    const name = `${v.name} ${v.lang}`.toLowerCase();
    let score = 0;
    if (/female|woman|zira|samantha|susan|karen|moira|tessa|fiona|victoria|hazel|aria|jenny|sara|eva|linda|heather/.test(name)) {
      score += 5;
    }
    if (/en[-_]?(us|gb|au|ph)/i.test(v.lang) || /english/i.test(name)) score += 2;
    if (v.localService) score += 1;
    return { v, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].v : voices.find((v) => /en/i.test(v.lang)) || voices[0] || null;
}

let voicesReady = false;
let doneWorkingCueGeneration = 0;
function ensureVoices(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (window.speechSynthesis.getVoices().length) {
    voicesReady = true;
    return;
  }
  window.speechSynthesis.addEventListener(
    "voiceschanged",
    () => {
      voicesReady = true;
    },
    { once: true },
  );
}

/** Cancel both active speech and a delayed voices-ready completion cue. */
export function cancelDoneWorkingCue(): void {
  doneWorkingCueGeneration += 1;
  try {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch {
    // Voice is optional.
  }
}

/** Speak a short female “done working” cue when all agent work finishes. */
export function speakDoneWorking(): void {
  try {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const generation = ++doneWorkingCueGeneration;
    ensureVoices();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance("done working");
    utter.rate = 1;
    utter.pitch = 1.05;
    utter.volume = 1;
    const voice = pickFemaleVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang || "en-US";
    } else {
      utter.lang = "en-US";
    }
    // If voices haven't loaded yet, retry once shortly after
    if (!voicesReady && !voice) {
      window.setTimeout(() => {
        if (generation !== doneWorkingCueGeneration) return;
        const v2 = pickFemaleVoice();
        if (v2) utter.voice = v2;
        window.speechSynthesis.speak(utter);
      }, 120);
      return;
    }
    window.speechSynthesis.speak(utter);
  } catch {
    // Voice is a nicety — never break the UI
  }
}
