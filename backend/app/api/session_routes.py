import asyncio
import json
from mimetypes import guess_type
from dataclasses import dataclass
from typing import Any, Callable

from app.schemas.animation import SessionAnimationSnapshot
from app.schemas.session import (
    AmbientContextUpdateRequest,
    DisplaySettingsUpdateRequest,
    SessionGestureRequest,
    SessionLifecycleUpdateRequest,
    AudioOutputUpdateRequest,
    SpeechLifecycleTransportSnapshot,
    StageBackgroundUpdateRequest,
)
from app.services.ambient_context import get_ambient_context_state
from app.services.audio_output_settings import get_audio_output_settings_state
from app.services.display_settings import get_display_settings_state
from app.services.stage_view import get_stage_view_state, is_known_stage_background_id
from app.services.animation import (
    AnimationService,
    SESSION_ANIMATION_STREAM,
    SessionAnimationLiveDeliveryService,
    SessionAnimationUpdate,
)
from app.services.character import CharacterService
from app.services.session import InvalidEventCursor, SessionService
from app.services.speech_audio_broadcast import get_speech_audio_broadcaster
from app.services.speech import (
    SPEECH_LIFECYCLE_STREAM,
    SpeechLifecycleLiveDeliveryService,
    SpeechLifecycleSnapshotService,
    resolve_session_speech_artifact_path,
)


SerializePayload = Callable[[Any], dict[str, Any]]


@dataclass(slots=True)
class SessionTransportRouteServices:
    session_service: SessionService
    character_service: CharacterService
    animation_service: AnimationService
    session_animation_live_delivery: SessionAnimationLiveDeliveryService
    speech_lifecycle_service: SpeechLifecycleSnapshotService
    speech_lifecycle_live_delivery: SpeechLifecycleLiveDeliveryService


def build_session_animation_response(
    snapshot: Any,
    animation_service: AnimationService,
) -> SessionAnimationSnapshot:
    return SessionAnimationSnapshot(
        session_id=snapshot.session_id,
        lifecycle_state=snapshot.lifecycle_state,
        active_character_id=snapshot.active_character_id,
        command=animation_service.resolve_session_command(snapshot),
    )


async def _iterate_blocking_iterator(iterator: Any):
    while True:
        item = await asyncio.to_thread(next, iterator, _STREAM_ITERATION_COMPLETE)
        if item is _STREAM_ITERATION_COMPLETE:
            break
        yield item


def _accepts_event_stream(request: Any) -> bool:
    return "text/event-stream" in request.headers.get("accept", "")


def _build_sse_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


def _build_sse_frame(
    *,
    event_name: str,
    payload: Any,
    serialize_dataclass_payload: SerializePayload,
    cursor: str | None = None,
) -> str:
    body = json.dumps(serialize_dataclass_payload(payload), separators=(",", ":"))
    frame_lines = [f"event: {event_name}"]
    if cursor is not None:
        frame_lines.append(f"id: {cursor}")
    frame_lines.append(f"data: {body}")
    return "\n".join(frame_lines) + "\n\n"


def register_session_transport_routes(
    router: Any,
    *,
    services: SessionTransportRouteServices,
    serialize_dataclass_payload: SerializePayload,
) -> None:
    from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect, status
    from fastapi.responses import FileResponse, StreamingResponse

    @router.get(
        "/session/animation",
        response_model=SessionAnimationSnapshot,
        response_model_exclude_none=True,
    )
    async def get_session_animation(
        request: Request,
        cursor: str | None = None,
    ) -> Any:
        snapshot = services.session_service.get_snapshot()
        animation_snapshot = build_session_animation_response(snapshot, services.animation_service)

        try:
            services.session_animation_live_delivery.read_updates(
                animation_snapshot.session_id,
                after_cursor=cursor,
            )
        except InvalidEventCursor as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

        if _accepts_event_stream(request):

            async def stream_updates():
                yield _build_sse_frame(
                    event_name=SESSION_ANIMATION_STREAM,
                    payload=animation_snapshot,
                    serialize_dataclass_payload=serialize_dataclass_payload,
                )
                async for update in _iterate_blocking_iterator(
                    services.session_animation_live_delivery.iter_live_updates(
                        animation_snapshot.session_id,
                        cursor=cursor,
                    )
                ):
                    if await request.is_disconnected():
                        break
                    yield _build_sse_frame(
                        event_name=SESSION_ANIMATION_STREAM,
                        payload=update.snapshot,
                        cursor=update.cursor,
                        serialize_dataclass_payload=serialize_dataclass_payload,
                    )

            return StreamingResponse(
                stream_updates(),
                media_type="text/event-stream",
                headers=_build_sse_headers(),
            )

        return animation_snapshot

    @router.put(
        "/session/lifecycle-state",
        response_model=SessionAnimationSnapshot,
        response_model_exclude_none=True,
    )
    def set_session_lifecycle_state(update: SessionLifecycleUpdateRequest) -> SessionAnimationSnapshot:
        snapshot = services.session_service.set_lifecycle_state(update.lifecycle_state)
        animation_snapshot = build_session_animation_response(snapshot, services.animation_service)
        services.session_animation_live_delivery.publish_snapshot(animation_snapshot)
        return animation_snapshot

    @router.post(
        "/session/animation/gesture",
        response_model=SessionAnimationSnapshot,
        response_model_exclude_none=True,
    )
    def trigger_session_gesture(request_body: SessionGestureRequest) -> SessionAnimationSnapshot:
        # Operator/control write seam for one-shot gestures. It does NOT change the
        # persisted lifecycle state (idle/listen/speak): it publishes a transient
        # gesture snapshot over the same session-animation stream the lifecycle
        # route uses, so every connected avatar client plays it once and settles
        # back to its current idle. Distinct from the speech write seam
        # (POST /session/operator-command).
        semantic_id = request_body.semantic_id.strip()
        if not semantic_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Gesture semantic id must not be blank.",
            )
        if not services.animation_service.is_known_semantic_id(semantic_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown gesture semantic id: {semantic_id}",
            )

        snapshot = services.session_service.get_snapshot()
        command = services.animation_service.resolve_gesture_command(snapshot, semantic_id)
        animation_snapshot = SessionAnimationSnapshot(
            session_id=snapshot.session_id,
            lifecycle_state=snapshot.lifecycle_state,
            active_character_id=snapshot.active_character_id,
            command=command,
        )
        services.session_animation_live_delivery.publish_snapshot(animation_snapshot)
        return animation_snapshot

    @router.get("/session/stage-background")
    def get_stage_background() -> dict[str, str]:
        # Presentation-only backdrop selection for the stage/display window.
        # Polled by the stage window so a control-surface change reaches the
        # separate Tauri window (which can't share browser state with it).
        return {"background_id": get_stage_view_state().background_id}

    @router.put("/session/stage-background")
    def put_stage_background(update: StageBackgroundUpdateRequest) -> dict[str, str]:
        background_id = update.background_id.strip()
        if not is_known_stage_background_id(background_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown stage background id: {background_id}",
            )
        get_stage_view_state().set_background(background_id)
        return {"background_id": background_id}

    @router.get("/session/display-settings")
    def get_display_settings() -> dict:
        # Presentation-only display/wardrobe settings for the stage/display
        # window. Polled by the stage window (like stage-background) so a
        # control-surface change reaches the separate always-on-top window.
        # Global bone-overlay/captions + per-character wardrobe values.
        return get_display_settings_state().snapshot()

    @router.put("/session/display-settings")
    def put_display_settings(update: DisplaySettingsUpdateRequest) -> dict:
        return get_display_settings_state().update(
            bone_overlay=update.bone_overlay,
            captions=update.captions,
            always_on_top=update.always_on_top,
            wardrobe=update.wardrobe,
        )

    @router.get("/session/ambient-context")
    def get_ambient_context() -> dict:
        # Durable ambient-context settings (enabled + timezone + location) the
        # planner prompt reads each turn. Editable from the control surface; read
        # live by the turn pipeline so a change applies without a restart.
        return get_ambient_context_state().snapshot()

    @router.put("/session/ambient-context")
    def put_ambient_context(update: AmbientContextUpdateRequest) -> dict:
        return get_ambient_context_state().update(
            enabled=update.enabled,
            timezone=update.timezone,
            location=update.location,
            weather_enabled=update.weather_enabled,
        )

    @router.get("/session/audio-output")
    def get_audio_output() -> dict:
        # Presentation-only "last used output device" choice for speech playback.
        # Polled by every surface that plays audio (incl. the separate display
        # window) so a control-surface change reaches them and survives restarts.
        return get_audio_output_settings_state().snapshot()

    @router.put("/session/audio-output")
    def put_audio_output(update: AudioOutputUpdateRequest) -> dict:
        device_id = update.device_id.strip() if isinstance(update.device_id, str) else None
        device_label = update.device_label.strip() if isinstance(update.device_label, str) else None
        return get_audio_output_settings_state().set_device(device_id or None, device_label or None)

    def _build_session_speech_artifact_audio_response(event_id: str) -> Any:
        snapshot = services.session_service.get_snapshot()
        audio_path = resolve_session_speech_artifact_path(
            services.session_service.event_store,
            session_id=snapshot.session_id,
            event_id=event_id,
        )
        if audio_path is None:
            raise HTTPException(
                status_code=404,
                detail="Speech audio artifact is unavailable for the current session.",
            )

        media_type = "audio/x-wav" if audio_path.suffix.lower() == ".wav" else guess_type(str(audio_path))[0]
        media_type = media_type or "application/octet-stream"
        return FileResponse(path=audio_path, media_type=media_type)

    @router.get("/session/speech-artifacts/{event_id}/audio")
    @router.get("/api/session/speech-artifacts/{event_id}/audio")
    def get_session_speech_artifact_audio(event_id: str) -> Any:
        return _build_session_speech_artifact_audio_response(event_id)

    @router.get(
        "/session/speech-lifecycle",
        response_model=SpeechLifecycleTransportSnapshot,
        response_model_exclude_none=True,
    )
    async def get_speech_lifecycle(
        request: Request,
        cursor: str | None = None,
    ) -> Any:
        snapshot = services.session_service.get_snapshot()
        active_character = services.character_service.get_character_summary(snapshot.active_character_id)
        try:
            services.session_service.event_store.read(
                SPEECH_LIFECYCLE_STREAM,
                session_id=snapshot.session_id,
                after_cursor=cursor,
            )
        except InvalidEventCursor as error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

        if _accepts_event_stream(request):
            speech_transport_snapshot = services.speech_lifecycle_service.get_snapshot(
                snapshot,
                character_id=active_character.character_id,
                cursor=cursor,
            )

            async def stream_events():
                yield _build_sse_frame(
                    event_name=SPEECH_LIFECYCLE_STREAM,
                    payload=speech_transport_snapshot,
                    serialize_dataclass_payload=serialize_dataclass_payload,
                )
                async for envelope in _iterate_blocking_iterator(
                    services.speech_lifecycle_live_delivery.iter_live_events(
                        snapshot,
                        character_id=active_character.character_id,
                        cursor=cursor,
                    )
                ):
                    if await request.is_disconnected():
                        break
                    yield _build_sse_frame(
                        event_name=SPEECH_LIFECYCLE_STREAM,
                        payload=envelope,
                        cursor=envelope.cursor,
                        serialize_dataclass_payload=serialize_dataclass_payload,
                    )

            return StreamingResponse(
                stream_events(),
                media_type="text/event-stream",
                headers=_build_sse_headers(),
            )

        return services.speech_lifecycle_service.get_snapshot(
            snapshot,
            character_id=active_character.character_id,
            cursor=cursor,
        )

    @router.websocket("/session/stream")
    async def session_stream(websocket: WebSocket) -> None:
        # Phase 2: unified streaming transport. Carries the SAME speech.lifecycle
        # envelopes as the SSE read seam (JSON control frames: {event,kind,cursor,
        # data}) AND binary audio frames per synthesized segment (a JSON header
        # {event:"speech.audio",utterance_id,segment_index,is_final,mime,bytes}
        # followed by the WAV bytes). SSE + file fetch remain the default fallback.
        await websocket.accept()
        cursor = websocket.query_params.get("cursor")
        snapshot = services.session_service.get_snapshot()
        active_character = services.character_service.get_character_summary(snapshot.active_character_id)
        transport_snapshot = services.speech_lifecycle_service.get_snapshot(
            snapshot,
            character_id=active_character.character_id,
            cursor=cursor,
        )
        broadcaster = get_speech_audio_broadcaster()
        broadcaster.bind_loop(asyncio.get_running_loop())
        audio_queue = broadcaster.subscribe(snapshot.session_id)

        async def pump_lifecycle() -> None:
            async for envelope in _iterate_blocking_iterator(
                services.speech_lifecycle_live_delivery.iter_live_events(
                    snapshot,
                    character_id=active_character.character_id,
                    cursor=cursor,
                )
            ):
                await websocket.send_json(
                    {
                        "event": SPEECH_LIFECYCLE_STREAM,
                        "kind": "event",
                        "cursor": envelope.cursor,
                        "data": serialize_dataclass_payload(envelope),
                    }
                )

        async def pump_audio() -> None:
            while True:
                frame, audio = await audio_queue.get()
                await websocket.send_json(frame)
                await websocket.send_bytes(audio)

        tasks: list[asyncio.Task] = []
        try:
            await websocket.send_json(
                {
                    "event": SPEECH_LIFECYCLE_STREAM,
                    "kind": "snapshot",
                    "cursor": None,
                    "data": serialize_dataclass_payload(transport_snapshot),
                }
            )
            tasks = [asyncio.create_task(pump_lifecycle()), asyncio.create_task(pump_audio())]
            # Either pump ending (lifecycle stream finished, or a send raised on
            # disconnect) tears the connection down.
            done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        except WebSocketDisconnect:
            pass
        except Exception:  # pragma: no cover - best-effort cleanup on unexpected errors
            pass
        finally:
            for task in tasks:
                task.cancel()
            broadcaster.unsubscribe(snapshot.session_id, audio_queue)
            try:
                await websocket.close()
            except Exception:
                pass


_STREAM_ITERATION_COMPLETE = object()