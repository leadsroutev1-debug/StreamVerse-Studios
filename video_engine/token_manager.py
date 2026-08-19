"""
Hugging Face token manager.

Behavior (see refactor spec §14/§15):
  - A token stays ACTIVE across many shots. It is NOT rotated after every
    successful generation.
  - A token is only marked exhausted when ZeroGPU quota is genuinely
    exhausted, or the token is invalid/rate-limited.
  - An ordinary HTTP 500 / transient failure does NOT exhaust a token.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

from . import config


@dataclass
class TokenState:
    token: str
    status: str = "active"  # active | exhausted | rate-limited | invalid
    exhausted_until: float = 0.0
    last_error: str | None = None


class TokenManager:
    def __init__(self, tokens: list[str], cooldown_ms: int):
        self._lock = threading.Lock()
        self._states = [TokenState(token=t) for t in tokens]
        self._index = 0
        self._cooldown_s = cooldown_ms / 1000.0

    def _is_available(self, state: TokenState, now: float) -> bool:
        if state.status == "active":
            return True
        if state.status in ("exhausted", "rate-limited") and now >= state.exhausted_until:
            state.status = "active"
            return True
        return False

    def get_active_token(self) -> str:
        """Return the current active token, advancing past unavailable ones."""
        with self._lock:
            if not self._states:
                raise RuntimeError("No Hugging Face tokens configured (HF_TOKENS).")
            now = time.time()
            for _ in range(len(self._states)):
                state = self._states[self._index]
                if self._is_available(state, now):
                    return state.token
                self._index = (self._index + 1) % len(self._states)
            # Nothing available — return the least-recently-exhausted token
            # rather than hard-failing; the caller will surface the real
            # upstream error if it still fails.
            soonest = min(self._states, key=lambda s: s.exhausted_until)
            return soonest.token

    def mark_exhausted(self, token: str, reason: str) -> None:
        with self._lock:
            for state in self._states:
                if state.token == token:
                    state.status = "exhausted"
                    state.exhausted_until = time.time() + self._cooldown_s
                    state.last_error = reason
                    break
            self._advance()

    def mark_invalid(self, token: str, reason: str) -> None:
        with self._lock:
            for state in self._states:
                if state.token == token:
                    state.status = "invalid"
                    state.exhausted_until = time.time() + self._cooldown_s
                    state.last_error = reason
                    break
            self._advance()

    def mark_active(self, token: str) -> None:
        """Confirm a token is healthy. Does NOT rotate — the same token
        keeps being used for subsequent shots."""
        with self._lock:
            for state in self._states:
                if state.token == token:
                    state.status = "active"
                    state.last_error = None
                    break

    def _advance(self) -> None:
        if self._states:
            self._index = (self._index + 1) % len(self._states)

    def slot_index(self, token: str) -> int | None:
        for i, state in enumerate(self._states):
            if state.token == token:
                return i
        return None

    def snapshot(self) -> list[dict]:
        """Dashboard-facing status of every configured token. Never exposes
        the raw secret — only enough of it to tell tokens apart (first 6 /
        last 4 chars), plus status/cooldown info so the UI can highlight
        exhausted tokens in red and show when they'll come back active.

        `active` here reflects the sticky/linear pointer: exactly the token
        `get_active_token()` would currently hand out (index 0 unless it has
        rotated forward past an exhausted one), not "the token most recently
        used" — a token stays flagged active across many shots until it is
        actually marked exhausted/invalid.
        """
        with self._lock:
            now = time.time()
            out = []
            for i, state in enumerate(self._states):
                masked = (
                    f"{state.token[:6]}…{state.token[-4:]}"
                    if len(state.token) > 12 else "••••"
                )
                cooldown_remaining_s = max(0.0, state.exhausted_until - now)
                out.append({
                    "index": i,
                    "masked_token": masked,
                    "status": state.status,
                    "is_current": i == self._index,
                    "cooldown_remaining_s": round(cooldown_remaining_s, 1),
                    "exhausted_until": state.exhausted_until or None,
                    "last_error": state.last_error,
                })
            return out


_ZERO_GPU_PATTERNS = [
    r"zerogpu",
    r"zero gpu",
    r"gpu quota",
    r"quota.*exceeded",
    r"quota.*exhausted",
    r"you have exceeded your gpu quota",
    r"exceeded.*quota",
]


def is_zero_gpu_quota_error(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return any(re.search(p, lowered) for p in _ZERO_GPU_PATTERNS)


# The newer /gradio_api/call/{api_name} REST endpoint used by gradio_client
# is known (per the Lightricks Space maintainer's own commit log, and HF
# forum reports of "API of working gradio App responding with empty error")
# to sometimes fail to relay the real exception message and instead surface
# a blank or generic boilerplate SSE error — plumbing noise, unrelated to
# why the underlying call actually failed. We treat that specific shape as
# presumed-quota (so the token gets rotated and the job retried) rather than
# presumed-fatal. A real, distinctly-worded error is left completely alone.
_BOILERPLATE_ERROR_MARKERS = (
    "none",
    "unknown error",
    "has not enabled verbose error reporting",
)


def is_blank_or_boilerplate_error(text: str) -> bool:
    if text is None:
        return True
    stripped = str(text).strip()
    if not stripped:
        return True
    lowered = stripped.lower()
    return any(marker in lowered for marker in _BOILERPLATE_ERROR_MARKERS)


token_manager = TokenManager(config.HF_TOKENS, config.HF_COOLDOWN_MS)