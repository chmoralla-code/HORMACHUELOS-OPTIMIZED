import assert from "node:assert/strict";
import test from "node:test";

import { createCompletionMarkerFilter, conclusionFromReasoning } from "./cursor-bridge.mjs";

const MARKER = "[[HORMACHUELOS_TASK_COMPLETE]]";

test("completion marker is hidden when it spans streamed chunks", () => {
  const visible = [];
  const filter = createCompletionMarkerFilter(MARKER, (text) => visible.push(text));

  filter.push("Implemented and verified the build. [[HORMACHUELOS_TASK_");
  filter.push("COMPLETE]]");
  filter.flush();

  assert.equal(visible.join(""), "Implemented and verified the build. ");
  assert.equal(filter.completed, true);
});

test("missing completion marker remains eligible for automatic follow-up", () => {
  const visible = [];
  const filter = createCompletionMarkerFilter(MARKER, (text) => visible.push(text));

  filter.push("Still running verification.");
  filter.flush();

  assert.equal(visible.join(""), "Still running verification.");
  assert.equal(filter.completed, false);
});

test("conclusionFromReasoning promotes a finished thought and skips meta narration", () => {
  assert.match(
    conclusionFromReasoning(
      "This screenshot is an employee onboarding form with name, email, and start date fields.",
    ),
    /onboarding form/,
  );
  assert.equal(
    conclusionFromReasoning(
      "The user just wants a description of the images. Let me describe them.",
    ),
    "",
  );
  assert.match(
    conclusionFromReasoning(
      "The user wants me to describe the attached images. The auto-view timed out. Here's what I see in the three images: a COMMAND logo.",
    ),
    /COMMAND logo/,
  );
  assert.doesNotMatch(
    conclusionFromReasoning(
      "The user wants me to describe the attached images. The auto-view timed out. Here's what I see in the three images: a COMMAND logo.",
    ),
    /auto-view timed out/i,
  );
  const simplified = conclusionFromReasoning(
    "the user wants me to simplify the back to work process explanation again. From history, the shortest version was: 'Back to Work = \"I'm back\"' 1. You say you're back 2. Your boss approves it 3. It's saved to your record Done. Let me give an even simpler version...",
  );
  assert.match(simplified, /You say you're back/);
  assert.doesNotMatch(simplified, /Let me give an even simpler version/i);
});
