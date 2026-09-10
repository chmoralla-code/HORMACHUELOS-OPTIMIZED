//! Stream recovery policy — port of FCC `core/anthropic/stream_recovery*.py`
//! plus the error-tail builders from `provider_stream_error.py` and
//! `emitted_sse_tracker.py`.
//!
//! Policy: holdback buffer (0.75s / 64KB) lets early failures retry invisibly
//! (≤5 attempts while nothing is committed). Once output commits, retryable
//! failures become midstream continuation/repair; otherwise a final error tail.
//! Retryable = truncated stream, 429, 5xx, timeout, network — never auth/400.

use super::sse::SseBuilder;

/// Holdback limits. Port of `RecoveryHoldbackBuffer(holdback=0.75s,
/// max=65536B)`.
pub const HOLDBACK_SECS: f64 = 0.75;
pub const HOLDBACK_MAX_BYTES: usize = 65_536;

/// Early transparent retry budget. Port of `EARLY_TRANSPARENT_TOTAL_ATTEMPTS`
/// / `MAX_RETRIES`.
pub const EARLY_TRANSPARENT_TOTAL_ATTEMPTS: u32 = 5;
pub const MAX_RETRIES: u32 = 4;

/// Classify an upstream failure as retryable. Auth and bad-request errors are
/// never retried.
pub fn is_retryable(kind: &StreamFailureKind) -> bool {
    matches!(
        kind,
        StreamFailureKind::Truncated
            | StreamFailureKind::RateLimited
            | StreamFailureKind::ServerError
            | StreamFailureKind::Timeout
            | StreamFailureKind::Network,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFailureKind {
    Truncated,
    RateLimited,
    ServerError,
    Timeout,
    Network,
    Authentication,
    BadRequest,
}

/// Recovery decision for a failed turn attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Retry invisibly: nothing committed yet.
    TransparentRetry,
    /// Continue/repair midstream: output already committed.
    MidstreamContinuation,
    /// End the turn with an error tail.
    FinalError,
}

pub fn decide_recovery(
    failure: &StreamFailureKind,
    committed_output: bool,
    attempts_used: u32,
) -> Recovery {
    if !is_retryable(failure) {
        return Recovery::FinalError;
    }
    if !committed_output && attempts_used < EARLY_TRANSPARENT_TOTAL_ATTEMPTS {
        return Recovery::TransparentRetry;
    }
    if committed_output {
        return Recovery::MidstreamContinuation;
    }
    Recovery::FinalError
}

/// Final error tail with no tool block started: text error block +
/// `message_delta(end_turn)` + `message_stop`. Port of
/// `provider_stream_error` + `emit_error_tail` (no-tool branch).
pub fn final_error_tail_no_tool(sse: &mut SseBuilder, message: &str, input_tokens: u64, output_tokens: u64) -> Vec<String> {
    let mut events = sse.emit_error_block(message);
    events.push(sse.message_delta("end_turn", output_tokens));
    let _ = input_tokens;
    events.push(SseBuilder::message_stop());
    events
}

/// Final error tail after a tool block started: close blocks, top-level
/// `event: error`, `message_delta` + `message_stop`. Port of
/// `emit_error_tail` (tool-started branch).
pub fn final_error_tail_after_tool(sse: &mut SseBuilder, message: &str, output_tokens: u64) -> Vec<String> {
    let mut events = sse.close_all_blocks();
    events.push(SseBuilder::emit_top_level_error(message));
    events.push(sse.message_delta("end_turn", output_tokens));
    events.push(SseBuilder::message_stop());
    events
}

/// User-facing message mapping. Port of FCC `core/anthropic/errors.py` safe
/// wording: never leak upstream bodies, keys, or internal shapes.
pub fn user_facing_error_message(kind: &StreamFailureKind) -> &'static str {
    match kind {
        StreamFailureKind::RateLimited => "The provider is rate-limited right now. The run will resume automatically.",
        StreamFailureKind::Timeout | StreamFailureKind::Network => "The provider connection dropped. The run will resume automatically.",
        StreamFailureKind::ServerError | StreamFailureKind::Truncated => "The provider returned an incomplete response. The run will resume automatically.",
        StreamFailureKind::Authentication => "The provider rejected the credentials. Check the saved API key in Settings.",
        StreamFailureKind::BadRequest => "The provider rejected the request. Try a shorter message or a different model.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_and_bad_request_never_retry() {
        assert_eq!(decide_recovery(&StreamFailureKind::Authentication, false, 0), Recovery::FinalError);
        assert_eq!(decide_recovery(&StreamFailureKind::BadRequest, false, 0), Recovery::FinalError);
        assert_eq!(decide_recovery(&StreamFailureKind::RateLimited, false, 0), Recovery::TransparentRetry);
        assert_eq!(decide_recovery(&StreamFailureKind::Timeout, true, 4), Recovery::MidstreamContinuation);
        assert_eq!(decide_recovery(&StreamFailureKind::ServerError, false, 5), Recovery::FinalError);
    }
}
