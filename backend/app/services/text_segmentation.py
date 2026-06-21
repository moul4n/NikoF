"""Sentence segmentation for streaming TTS (Phase 1a).

Splits an assistant reply into ordered, speakable segments so synthesis can run
sentence-by-sentence and the avatar can start speaking the first sentence while
later ones synthesize. Pure and deterministic so it can be unit-tested without
models, and reused in Phase 1b over a streaming token source.

Segmentation rules:
- Break at sentence boundaries (. ! ? … and newlines), keeping terminal marks.
- Merge short trailing fragments forward until a segment reaches ``min_chars``.
- Never exceed ``max_chars``: long sentences are split on word boundaries (and,
  as a last resort, hard-sliced) so the first segment's latency stays bounded.
"""

from __future__ import annotations

import re


_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?…])\s+|\n+")


def _split_long(sentence: str, max_chars: int) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]

    chunks: list[str] = []
    current = ""
    for word in sentence.split():
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= max_chars:
            current = f"{current} {word}"
        else:
            chunks.append(current)
            current = word
    if current:
        chunks.append(current)

    # A single word longer than max_chars still has to be cut.
    capped: list[str] = []
    for chunk in chunks:
        while len(chunk) > max_chars:
            capped.append(chunk[:max_chars])
            chunk = chunk[max_chars:]
        if chunk:
            capped.append(chunk)
    return capped


class StreamingSentenceSegmenter:
    """Online sentence segmenter for Phase 1b.

    Feed reply-text deltas as they stream; ``feed`` returns the segments that are
    now definitely complete (every segment except the still-growing tail), and
    ``flush`` returns whatever remains at end-of-stream. Delegates to
    ``iter_sentence_segments`` so streamed and batch segmentation agree.
    """

    def __init__(self, *, min_chars: int, max_chars: int, eager_first: bool = True) -> None:
        self._buffer = ""
        self._min_chars = min_chars
        self._max_chars = max_chars
        self._eager_first = eager_first
        self._emitted_any = False

    def feed(self, text: str) -> list[str]:
        if not text:
            return []
        self._buffer += text
        # Sentence-start offsets in the RAW buffer (so spacing is preserved).
        starts = [match.end() for match in _SENTENCE_BOUNDARY.finditer(self._buffer)]

        if self._eager_first and not self._emitted_any:
            # First audio dominates perceived latency, so dispatch the opening
            # sentence(s) as soon as a boundary appears and there is enough text
            # to be worth a synthesis call — don't wait for a second boundary.
            if not starts:
                return []
            split = starts[-1]
            stable = self._buffer[:split]
            if len(stable.strip()) < self._min_chars:
                return []  # too short; let it merge forward instead
            emitted = iter_sentence_segments(
                stable, min_chars=self._min_chars, max_chars=self._max_chars
            )
            if not emitted:
                return []
            self._buffer = self._buffer[split:]
            self._emitted_any = True
            return emitted

        # Subsequent segments: hold back the last *complete* sentence plus the
        # trailing partial, so a short fragment can still merge forward.
        if len(starts) < 2:
            return []
        split = starts[-2]
        stable = self._buffer[:split]
        self._buffer = self._buffer[split:]
        emitted = iter_sentence_segments(
            stable, min_chars=self._min_chars, max_chars=self._max_chars
        )
        if emitted:
            self._emitted_any = True
        return emitted

    def flush(self) -> list[str]:
        segments = iter_sentence_segments(
            self._buffer, min_chars=self._min_chars, max_chars=self._max_chars
        )
        self._buffer = ""
        if segments:
            self._emitted_any = True
        return segments


def iter_sentence_segments(text: str, *, min_chars: int, max_chars: int) -> list[str]:
    """Return ordered speakable segments for ``text``.

    Returns an empty list for empty/whitespace input, and a single-element list
    when the whole reply is one short sentence.
    """
    normalized = (text or "").strip()
    if not normalized:
        return []

    pieces: list[str] = []
    for sentence in _SENTENCE_BOUNDARY.split(normalized):
        sentence = sentence.strip()
        if sentence:
            pieces.extend(_split_long(sentence, max_chars))

    segments: list[str] = []
    buffer = ""
    for piece in pieces:
        if not buffer:
            buffer = piece
        elif len(buffer) >= min_chars:
            segments.append(buffer)
            buffer = piece
        elif len(buffer) + 1 + len(piece) <= max_chars:
            buffer = f"{buffer} {piece}"
        else:
            segments.append(buffer)
            buffer = piece
    if buffer:
        segments.append(buffer)
    return segments
