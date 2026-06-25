"""Keyless ambient weather via Open-Meteo (live-info Stage A+).

Fetches current weather for the configured location and exposes a short line for
the companion's `[AMBIENT]` block (e.g. "14°C, light rain (as of 14:22)"). No API
key or account — Open-Meteo is free and keyless. Only a coordinate pair (resolved
from the location label, or the timezone's city when the label is blank) leaves
the machine; never conversation, persona, or memory.

The refresh runs in the background, off the turn's hot path: `ambient_weather_line`
returns the last cached value (or None) immediately and, when the cache is stale,
spawns a daemon thread to refresh. It degrades silently to *no* weather line on any
error / offline — the companion simply doesn't mention weather rather than guessing.

The reading + lookup timestamp are persisted to disk, and a refresh only happens
when the stored reading is over an hour old — so a backend restart reuses a recent
value instead of immediately re-calling Open-Meteo.

Two keyless Open-Meteo endpoints are used:
- geocoding-api.open-meteo.com/v1/search?name=<city>&count=1  -> lat/lon
- api.open-meteo.com/v1/forecast?...&current=temperature_2m,weather_code
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

logger = logging.getLogger(__name__)

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Re-fetch only when the stored reading is over an hour old (the reading +
# timestamp are persisted, so a restart reuses a recent value), and stop showing
# a value at all once it is older than the hard-expiry window (offline too long).
_REFRESH_INTERVAL_SECONDS = 60 * 60
_HARD_EXPIRY_SECONDS = 3 * 60 * 60
# Don't re-attempt a failing fetch on every single turn.
_MIN_RETRY_INTERVAL_SECONDS = 60
_HTTP_TIMEOUT_SECONDS = 4.0

# WMO weather interpretation codes -> short human labels (Open-Meteo `weather_code`).
_WMO_CODE_LABELS: dict[int, str] = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "rime fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "freezing drizzle",
    57: "freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light showers",
    81: "showers",
    82: "heavy showers",
    85: "snow showers",
    86: "heavy snow showers",
    95: "thunderstorm",
    96: "thunderstorm with hail",
    99: "thunderstorm with hail",
}


def describe_weather_code(code: int | None) -> str:
    if code is None:
        return "unknown conditions"
    return _WMO_CODE_LABELS.get(int(code), "unsettled")


def city_from_timezone(timezone: str) -> str:
    """Derive a geocoding-friendly city from an IANA zone when no location label
    is set: "Europe/London" -> "London", "America/New_York" -> "New York"."""
    name = (timezone or "").strip()
    if not name or "/" not in name:
        return ""
    return name.rsplit("/", 1)[-1].replace("_", " ").strip()


def _http_get_json(url: str, params: dict[str, object], *, timeout: float = _HTTP_TIMEOUT_SECONDS) -> dict:
    """GET a JSON document. Raises on any network/parse error (callers degrade)."""
    query = urllib_parse.urlencode(params)
    request = urllib_request.Request(f"{url}?{query}", method="GET")
    with urllib_request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class WeatherService:
    """Cached current-weather line for one location at a time. Thread-safe; the
    network refresh runs off the caller's thread."""

    def __init__(
        self,
        *,
        fetch_json: Callable[[str, dict], dict] | None = None,
        clock: Callable[[], float] | None = None,
        state_path: Path | None = None,
    ) -> None:
        self._fetch_json = fetch_json or (lambda url, params: _http_get_json(url, params))
        self._clock = clock or time.time
        self._state_path = state_path
        self._lock = threading.Lock()
        self._query: str = ""
        self._temp_c: float | None = None
        self._code: int | None = None
        self._fetched_epoch: float | None = None
        self._last_attempt_epoch: float | None = None
        self._refreshing: bool = False
        self._restore()

    # -- persistence ---------------------------------------------------------
    def _restore(self) -> None:
        """Reload the last reading + timestamp so a restart reuses a recent value
        (state_path None = in-memory only, for tests)."""
        if self._state_path is None:
            return
        try:
            raw = self._state_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return
        try:
            data = json.loads(raw)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        query = data.get("query")
        fetched = data.get("fetched_epoch")
        if isinstance(query, str) and isinstance(fetched, (int, float)) and not isinstance(fetched, bool):
            self._query = query
            self._fetched_epoch = float(fetched)
            temp = data.get("temperature_c")
            code = data.get("weather_code")
            self._temp_c = float(temp) if isinstance(temp, (int, float)) and not isinstance(temp, bool) else None
            self._code = int(code) if isinstance(code, (int, float)) and not isinstance(code, bool) else None

    def _persist(self) -> None:
        if self._state_path is None:
            return
        with self._lock:
            document = {
                "query": self._query,
                "temperature_c": self._temp_c,
                "weather_code": self._code,
                "fetched_epoch": self._fetched_epoch,
            }
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(document), encoding="utf-8")
        except OSError:
            logger.debug("Failed to persist weather cache to %s", self._state_path, exc_info=True)

    @staticmethod
    def _candidate_queries(location: str, timezone: str) -> list[str]:
        """Geocoding candidates in priority order: the Location label first, then
        the timezone's city as a fallback (used when Location is blank *or* when
        Location returns no geocode match)."""
        candidates: list[str] = []
        loc = (location or "").strip()
        if loc:
            candidates.append(loc)
        tz_city = city_from_timezone(timezone)
        if tz_city and tz_city not in candidates:
            candidates.append(tz_city)
        return candidates

    # -- read seam -----------------------------------------------------------
    def ambient_weather_line(self, *, location: str, timezone: str, now: datetime) -> str | None:
        """Return a short weather line for the ambient block, or None when not
        yet available / stale / offline. Never blocks on the network: a stale
        cache only *schedules* a background refresh."""
        candidates = self._candidate_queries(location, timezone)
        if not candidates:
            return None
        identity = " | ".join(candidates)

        with self._lock:
            if identity != self._query:
                # Location/timezone changed -> drop the previous cache.
                self._query = identity
                self._temp_c = None
                self._code = None
                self._fetched_epoch = None
                self._last_attempt_epoch = None
            line = self._format_line_locked(now)
            should_refresh = self._should_refresh_locked()
            if should_refresh:
                self._refreshing = True
                self._last_attempt_epoch = self._clock()
                pending = list(candidates)

        if should_refresh:
            self._spawn_refresh(pending)
        return line

    def _should_refresh_locked(self) -> bool:
        now_epoch = self._clock()
        if self._refreshing:
            return False
        if self._last_attempt_epoch is not None and now_epoch - self._last_attempt_epoch < _MIN_RETRY_INTERVAL_SECONDS:
            return False
        if self._fetched_epoch is None:
            return True
        return now_epoch - self._fetched_epoch >= _REFRESH_INTERVAL_SECONDS

    def _format_line_locked(self, now: datetime) -> str | None:
        if self._temp_c is None or self._fetched_epoch is None:
            return None
        if self._clock() - self._fetched_epoch > _HARD_EXPIRY_SECONDS:
            return None
        as_of = datetime.fromtimestamp(self._fetched_epoch, tz=now.tzinfo).strftime("%H:%M")
        return f"{round(self._temp_c)}°C, {describe_weather_code(self._code)} (as of {as_of})"

    # -- refresh -------------------------------------------------------------
    def _spawn_refresh(self, candidates: list[str]) -> None:
        thread = threading.Thread(target=self._refresh_blocking, args=(candidates,), daemon=True)
        thread.start()

    def _refresh_blocking(self, candidates: list[str]) -> None:
        """Geocode the candidates in order (Location first, then the timezone city
        fallback) until one resolves, then fetch current weather and update the
        cache. Any failure leaves the previous cache intact and logs at debug."""
        identity = " | ".join(candidates)
        try:
            coords = None
            for candidate in candidates:
                coords = self._geocode(candidate)
                if coords is not None:
                    break
            if coords is None:
                logger.debug("Weather geocode found no match for any of %r", candidates)
                return
            latitude, longitude = coords
            temp_c, code = self._fetch_current(latitude, longitude)
            with self._lock:
                # A concurrent location change may have superseded this query.
                if identity != self._query:
                    return
                self._temp_c = temp_c
                self._code = code
                self._fetched_epoch = self._clock()
            # Persist outside the lock so a restart reuses this reading + timestamp.
            self._persist()
        except (urllib_error.URLError, TimeoutError, OSError, ValueError, KeyError) as exc:
            logger.debug("Weather refresh for %r failed: %s", candidates, exc)
        finally:
            with self._lock:
                self._refreshing = False

    def _geocode(self, query: str) -> tuple[float, float] | None:
        # Open-Meteo's geocoder matches a bare place name; a "City, Country" label
        # (e.g. "Chester, UK") returns no match, so geocode the part before the
        # first comma. The full label is still used for display in the prompt.
        name = query.split(",", 1)[0].strip() or query
        data = self._fetch_json(GEOCODE_URL, {"name": name, "count": 1, "format": "json"})
        results = data.get("results")
        if not isinstance(results, list) or not results:
            return None
        first = results[0]
        return float(first["latitude"]), float(first["longitude"])

    def _fetch_current(self, latitude: float, longitude: float) -> tuple[float, int | None]:
        data = self._fetch_json(
            FORECAST_URL,
            {
                "latitude": latitude,
                "longitude": longitude,
                "current": "temperature_2m,weather_code",
            },
        )
        current = data.get("current") or {}
        temp_c = float(current["temperature_2m"])
        raw_code = current.get("weather_code")
        code = int(raw_code) if isinstance(raw_code, (int, float)) else None
        return temp_c, code


_weather_service: WeatherService | None = None


def get_weather_service() -> WeatherService:
    """Process-wide cached weather service (one location at a time), with the last
    reading persisted under the app's local data root so a restart reuses it."""
    global _weather_service
    if _weather_service is None:
        from app.core.settings import get_app_paths

        _weather_service = WeatherService(
            state_path=get_app_paths().local_data_root / "session" / "weather-cache.json"
        )
    return _weather_service
