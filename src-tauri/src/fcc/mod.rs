//! FCC backbone: Anthropic-Messages wire core ported from free-claude-code.
//!
//! Canonical internal stream = Anthropic SSE strings; Tauri `agent` events
//! project from it. Messages-only: no `/v1/responses` adapter.
//!
//! Source semantics: `core/anthropic/sse.py`, `stream_contracts.py`,
//! `conversion.py` (tool_choice/system subset), `thinking.py`,
//! `native_messages_request.py`, `native_sse_block_policy.py`,
//! `stream_recovery*.py`, `provider_stream_error.py`,
//! `emitted_sse_tracker.py`, `tokens.py`, `errors.py`,
//! `transports/openai_chat/{stream,tool_calls}.py`,
//! `api/{request_pipeline,model_router,gateway_model_ids,model_catalog}.py`.

pub mod assemble;
pub mod contracts;
pub mod recover;
pub mod router;
pub mod sse;
pub mod thinking;
pub mod tokens;
