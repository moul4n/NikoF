from __future__ import annotations

from pathlib import Path
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.text_segmentation import StreamingSentenceSegmenter, iter_sentence_segments


class StreamingSentenceSegmenterTests(unittest.TestCase):
    def _segmenter(self) -> StreamingSentenceSegmenter:
        return StreamingSentenceSegmenter(min_chars=12, max_chars=240)

    def test_eager_first_emits_opening_sentence_immediately(self) -> None:
        segmenter = self._segmenter()
        emitted: list[str] = []
        # Eager: the opening sentence dispatches on its first boundary so first
        # audio can start while the LLM is still generating the rest.
        emitted += segmenter.feed("First sentence here. Second sen")
        self.assertEqual(emitted, ["First sentence here."])
        # Later sentences hold the last complete one for merge-forward.
        emitted += segmenter.feed("tence here. Third sentence here.")
        self.assertEqual(emitted, ["First sentence here."])
        emitted += segmenter.flush()
        self.assertEqual(
            emitted,
            ["First sentence here.", "Second sentence here.", "Third sentence here."],
        )

    def test_eager_first_holds_short_opening_fragment_until_it_merges(self) -> None:
        segmenter = self._segmenter()
        # "Sure." is below min_chars, so eager dispatch waits and lets it merge.
        self.assertEqual(segmenter.feed("Sure. "), [])
        self.assertEqual(segmenter.feed("Here is the real first sentence. And more."), ["Sure. Here is the real first sentence."])

    def test_hold_back_mode_waits_for_second_boundary(self) -> None:
        segmenter = StreamingSentenceSegmenter(min_chars=12, max_chars=240, eager_first=False)
        self.assertEqual(segmenter.feed("First sentence here. Second sen"), [])
        self.assertEqual(segmenter.feed("tence here. Third sentence here."), ["First sentence here."])

    def test_flush_only_when_no_boundary_seen(self) -> None:
        segmenter = self._segmenter()
        self.assertEqual(segmenter.feed("No terminal punctuation yet"), [])
        self.assertEqual(segmenter.flush(), ["No terminal punctuation yet"])

    def test_streamed_matches_batch_segmentation(self) -> None:
        text = "First sentence here. Second sentence here. Third one is here."
        # Feed it in awkward 7-char slices.
        segmenter = self._segmenter()
        streamed: list[str] = []
        for index in range(0, len(text), 7):
            streamed += segmenter.feed(text[index : index + 7])
        streamed += segmenter.flush()
        batch = iter_sentence_segments(text, min_chars=12, max_chars=240)
        self.assertEqual(streamed, batch)

    def test_short_leading_fragment_merges_forward(self) -> None:
        segmenter = self._segmenter()
        emitted = segmenter.feed("Sure. ")
        # "Sure." is below min_chars, so nothing is emitted yet.
        self.assertEqual(emitted, [])
        emitted += segmenter.feed("I can do that now.")
        emitted += segmenter.flush()
        self.assertEqual(emitted, ["Sure. I can do that now."])


if __name__ == "__main__":
    unittest.main()
