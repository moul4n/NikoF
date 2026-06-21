from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.streaming_reply import ReplyTextStreamExtractor, iter_reply_text_deltas


def extract(chunks: list[str]) -> str:
    return "".join(iter_reply_text_deltas(chunks))


class ReplyTextStreamExtractorTests(unittest.TestCase):
    def test_extracts_value_from_single_chunk(self) -> None:
        chunk = '{"reply_text": "Hello there.", "feeling": {"name": "warm"}}'
        self.assertEqual(extract([chunk]), "Hello there.")

    def test_value_split_across_arbitrary_chunks(self) -> None:
        chunks = ['{"reply_te', 'xt": "Hel', "lo ", 'there.", "feeling": {}}']
        self.assertEqual(extract(chunks), "Hello there.")

    def test_handles_escaped_quotes_and_backslashes(self) -> None:
        chunk = '{"reply_text": "She said \\"hi\\" and left\\\\done", "x": 1}'
        self.assertEqual(extract([chunk]), 'She said "hi" and left\\done')

    def test_decodes_escape_sequences(self) -> None:
        chunk = '{"reply_text": "line1\\nline2\\ttab", "x": 1}'
        self.assertEqual(extract([chunk]), "line1\nline2\ttab")

    def test_decodes_unicode_escape_split_across_chunks(self) -> None:
        chunks = ['{"reply_text": "caf\\u00', 'e9 time"}']
        self.assertEqual(extract(chunks), "café time")

    def test_stops_at_closing_quote_ignoring_later_reply_text(self) -> None:
        # A later "reply_text" inside other fields must not extend the value.
        chunk = '{"reply_text": "Done.", "note": "reply_text appears here too"}'
        self.assertEqual(extract([chunk]), "Done.")

    def test_reports_done_after_value_closes(self) -> None:
        extractor = ReplyTextStreamExtractor()
        extractor.feed('{"reply_text": "Hi."')
        self.assertTrue(extractor.done)
        # Further feeds are ignored once done.
        self.assertEqual(extractor.feed(', "feeling": {}}'), "")

    def test_whitespace_between_key_and_value(self) -> None:
        chunk = '{ "reply_text"   :    "Spaced out.", "x": 1}'
        self.assertEqual(extract([chunk]), "Spaced out.")

    def test_incremental_deltas_arrive_before_completion(self) -> None:
        extractor = ReplyTextStreamExtractor()
        first = extractor.feed('{"reply_text": "First part ')
        self.assertEqual(first, "First part ")
        self.assertFalse(extractor.done)
        second = extractor.feed('second part."}')
        self.assertEqual(second, "second part.")
        self.assertTrue(extractor.done)


if __name__ == "__main__":
    unittest.main()
