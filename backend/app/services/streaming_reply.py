"""Incremental extraction of the planner's ``reply_text`` from a streamed JSON
object (Phase 1b, "option B").

The local LLM is asked for a single JSON planner object whose FIRST field is
``reply_text``. When the response is streamed token-by-token we cannot json.loads
a partial object, so this state machine scans the stream for ``"reply_text": "``
and then emits the decoded characters of that string value (honoring JSON escape
sequences) until the closing unescaped quote. This lets TTS start on the first
sentence while the rest of the object (feeling/cues/memory) is still streaming;
the full object is still parsed at the end for the authoritative contract.

Pure and chunk-boundary safe so it can be unit-tested with adversarial splits.
"""

from __future__ import annotations

from typing import Iterable, Iterator


_KEY = '"reply_text"'
_WHITESPACE = " \t\r\n"
_ESCAPE_MAP = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "b": "\b",
    "f": "\f",
}


class ReplyTextStreamExtractor:
    """Feed raw streamed chunks; receive decoded ``reply_text`` characters."""

    def __init__(self) -> None:
        self._pending = ""
        self._in_value = False
        self._done = False
        self._escape = False
        self._unicode_remaining = 0
        self._unicode_acc = ""

    @property
    def done(self) -> bool:
        return self._done

    def feed(self, chunk: str) -> str:
        if self._done or not chunk:
            return ""

        if not self._in_value:
            self._pending += chunk
            self._try_open_value()
            if not self._in_value:
                return ""
            data = self._pending
            self._pending = ""
        else:
            data = chunk

        return self._consume_value(data)

    def _try_open_value(self) -> None:
        key_index = self._pending.find(_KEY)
        if key_index == -1:
            # Preserve only enough tail to match a key split across chunks.
            tail = len(_KEY) - 1
            if len(self._pending) > tail:
                self._pending = self._pending[-tail:]
            return

        cursor = key_index + len(_KEY)
        length = len(self._pending)

        while cursor < length and self._pending[cursor] in _WHITESPACE:
            cursor += 1
        if cursor >= length:
            return  # wait for ':'
        if self._pending[cursor] != ":":
            self._pending = self._pending[cursor:]
            return
        cursor += 1

        while cursor < length and self._pending[cursor] in _WHITESPACE:
            cursor += 1
        if cursor >= length:
            return  # wait for opening quote
        if self._pending[cursor] != '"':
            self._pending = self._pending[cursor:]
            return

        cursor += 1  # move past the opening quote
        self._in_value = True
        self._pending = self._pending[cursor:]

    def _consume_value(self, data: str) -> str:
        out: list[str] = []
        for ch in data:
            if self._done:
                break
            if self._unicode_remaining > 0:
                self._unicode_acc += ch
                self._unicode_remaining -= 1
                if self._unicode_remaining == 0:
                    try:
                        out.append(chr(int(self._unicode_acc, 16)))
                    except ValueError:
                        pass
                    self._unicode_acc = ""
                continue
            if self._escape:
                self._escape = False
                if ch == "u":
                    self._unicode_remaining = 4
                    self._unicode_acc = ""
                else:
                    out.append(_ESCAPE_MAP.get(ch, ch))
                continue
            if ch == "\\":
                self._escape = True
                continue
            if ch == '"':
                self._done = True
                break
            out.append(ch)
        return "".join(out)


def iter_reply_text_deltas(chunks: Iterable[str]) -> Iterator[str]:
    """Yield decoded ``reply_text`` deltas from an iterable of raw chunks."""
    extractor = ReplyTextStreamExtractor()
    for chunk in chunks:
        delta = extractor.feed(chunk)
        if delta:
            yield delta
        if extractor.done:
            break
