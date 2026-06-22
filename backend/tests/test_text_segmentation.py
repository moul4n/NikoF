from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.text_segmentation import iter_sentence_segments


class SentenceSegmentationTests(unittest.TestCase):
    def seg(self, text: str, *, min_chars: int = 12, max_chars: int = 240) -> list[str]:
        return iter_sentence_segments(text, min_chars=min_chars, max_chars=max_chars)

    def test_empty_or_whitespace_returns_empty(self) -> None:
        self.assertEqual(self.seg(""), [])
        self.assertEqual(self.seg("   \n  "), [])

    def test_single_short_sentence_is_one_segment(self) -> None:
        self.assertEqual(self.seg("Hello there friend."), ["Hello there friend."])

    def test_short_leading_fragment_merges_forward(self) -> None:
        # "Sure." is below min_chars, so it merges into the next sentence.
        self.assertEqual(
            self.seg("Sure. I can wave once I finish speaking."),
            ["Sure. I can wave once I finish speaking."],
        )

    def test_multiple_full_sentences_split_one_each(self) -> None:
        self.assertEqual(
            self.seg("Hello there friend. How are you doing today? I am quite well."),
            ["Hello there friend.", "How are you doing today?", "I am quite well."],
        )

    def test_newlines_are_boundaries(self) -> None:
        self.assertEqual(
            self.seg("First long enough line\nSecond long enough line"),
            ["First long enough line", "Second long enough line"],
        )

    def test_long_sentence_is_split_under_max_chars(self) -> None:
        long_sentence = " ".join(["word"] * 100)  # ~499 chars, no punctuation
        segments = self.seg(long_sentence, min_chars=12, max_chars=60)
        self.assertGreater(len(segments), 1)
        self.assertTrue(all(len(s) <= 60 for s in segments))
        # No content lost (modulo the spaces we split on).
        self.assertEqual(" ".join(segments).split(), long_sentence.split())

    def test_segments_preserve_order_and_content(self) -> None:
        text = "One sentence here. Two sentence here. Three sentence here."
        segments = self.seg(text)
        self.assertEqual(" ".join(segments), text)

    def test_single_word_longer_than_max_is_hard_sliced(self) -> None:
        segments = self.seg("x" * 50, min_chars=12, max_chars=20)
        self.assertTrue(all(len(s) <= 20 for s in segments))
        self.assertEqual("".join(segments), "x" * 50)


if __name__ == "__main__":
    unittest.main()
