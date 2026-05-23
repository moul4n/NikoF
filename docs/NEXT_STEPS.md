# Next Steps

Updated: 2026-05-22T00:00:00Z

1. Land the missing Faster-Whisper payload and provider entrypoint under the managed local roots so backend startup can leave scaffolded STT mode and the eventual microphone ingest path can reuse the same normalized contract.
2. Add regression coverage for the backend-owned TTS sidecar path: external-port refusal, clean degraded `unavailable` responses, and successful `audio_reference` publication through `tts_preview` and `text_question`.
3. Broaden frontend verification around canonical TTS artifact playback and the resource monitor tables now that `/api/session/speech-artifacts/{event_id}/audio`, owned-process snapshots, and GPU-process snapshots are all live surfaces.
4. Decide deliberately whether to keep the current GPT-SoVITS 488k lane as the development baseline or upgrade the local provider runtime to a true `v2Pro`-compatible path; the current provider code and `v2Pro/s2Gv2Pro.pth` override do not align.
5. Improve resource telemetry where Windows GPU permissions still hide per-process memory from `nvidia-smi`, so the operator panel can report stronger per-process VRAM numbers than the current `[Insufficient Permissions]` view.
6. Use [docs/ATTENTION_TRACKING_SPEC.md](docs/ATTENTION_TRACKING_SPEC.md) as the concrete implementation plan for optional camera-driven attention tracking before adding any live webcam or face-state wiring.
