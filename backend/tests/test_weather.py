from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.weather import (
    WeatherService,
    city_from_timezone,
    describe_weather_code,
)


_BST = timezone(timedelta(hours=1), "BST")
_NOW = datetime(2026, 6, 25, 14, 30, tzinfo=_BST)

# Canned Open-Meteo responses keyed by endpoint substring.
_GEOCODE_OK = {"results": [{"latitude": 50.83, "longitude": -0.14, "name": "Brighton"}]}
_FORECAST_OK = {"current": {"temperature_2m": 13.6, "weather_code": 61}}


class _FakeFetcher:
    """Records calls and replays canned JSON; can be told to fail."""

    def __init__(self, *, geocode=_GEOCODE_OK, forecast=_FORECAST_OK, raise_on=None) -> None:
        self.geocode = geocode
        self.forecast = forecast
        self.raise_on = raise_on
        self.calls: list[str] = []
        self.geocode_names: list[str] = []

    def __call__(self, url: str, params: dict) -> dict:
        self.calls.append(url)
        if "geocoding" in url:
            self.geocode_names.append(str(params.get("name")))
        if self.raise_on and self.raise_on in url:
            raise OSError("synthetic network failure")
        if "geocoding" in url:
            return self.geocode
        return self.forecast


class _Clock:
    def __init__(self, value: float = 1000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class WeatherHelpersTests(unittest.TestCase):
    def test_city_from_timezone(self) -> None:
        self.assertEqual("London", city_from_timezone("Europe/London"))
        self.assertEqual("New York", city_from_timezone("America/New_York"))
        self.assertEqual("", city_from_timezone("UTC"))
        self.assertEqual("", city_from_timezone(""))

    def test_describe_weather_code(self) -> None:
        self.assertEqual("clear sky", describe_weather_code(0))
        self.assertEqual("light rain", describe_weather_code(61))
        self.assertEqual("unknown conditions", describe_weather_code(None))
        self.assertEqual("unsettled", describe_weather_code(4242))


class WeatherServiceTests(unittest.TestCase):
    def _service(self, fetcher: _FakeFetcher, clock: _Clock) -> WeatherService:
        return WeatherService(fetch_json=fetcher, clock=clock)

    def _prime_and_refresh(self, service: WeatherService, *, location: str, timezone: str = "Europe/London") -> None:
        """Mirror the real flow: the first read sets the active query + schedules
        a refresh; the background thread then runs _refresh_blocking on it. Drive
        that refresh synchronously here."""
        service.ambient_weather_line(location=location, timezone=timezone, now=_NOW)
        query = (location or "").strip() or city_from_timezone(timezone)
        service._refresh_blocking(query)

    def test_first_call_returns_none_then_populates_after_refresh(self) -> None:
        fetcher, clock = _FakeFetcher(), _Clock()
        service = self._service(fetcher, clock)
        # First call schedules a refresh and returns nothing yet.
        self.assertIsNone(service.ambient_weather_line(location="Brighton, UK", timezone="Europe/London", now=_NOW))
        # Drive the refresh synchronously (production spawns a daemon thread).
        service._refresh_blocking("Brighton, UK")
        line = service.ambient_weather_line(location="Brighton, UK", timezone="Europe/London", now=_NOW)
        self.assertIsNotNone(line)
        self.assertIn("14°C", line)  # 13.6 rounds to 14
        self.assertIn("light rain", line)
        self.assertIn("(as of", line)

    def test_geocode_strips_country_suffix(self) -> None:
        # "Chester, UK" must geocode as "Chester" — Open-Meteo's geocoder returns
        # no match for the "City, Country" label.
        fetcher = _FakeFetcher()
        service = self._service(fetcher, _Clock())
        self._prime_and_refresh(service, location="Chester, UK")
        self.assertIn("Chester", fetcher.geocode_names)
        self.assertNotIn("Chester, UK", fetcher.geocode_names)
        self.assertIsNotNone(
            service.ambient_weather_line(location="Chester, UK", timezone="Europe/London", now=_NOW)
        )

    def test_blank_location_falls_back_to_timezone_city(self) -> None:
        fetcher, clock = _FakeFetcher(), _Clock()
        service = self._service(fetcher, clock)
        self._prime_and_refresh(service, location="", timezone="Europe/London")
        line = service.ambient_weather_line(location="", timezone="Europe/London", now=_NOW)
        self.assertIsNotNone(line)
        # Geocoding was queried with the derived city.
        self.assertTrue(any("geocoding" in url for url in fetcher.calls))

    def test_no_query_returns_none_without_network(self) -> None:
        fetcher, clock = _FakeFetcher(), _Clock()
        service = self._service(fetcher, clock)
        # Blank location + un-citydable zone => nothing to geocode, no fetch.
        self.assertIsNone(service.ambient_weather_line(location="", timezone="UTC", now=_NOW))
        self.assertEqual([], fetcher.calls)

    def test_geocode_failure_degrades_to_none(self) -> None:
        fetcher = _FakeFetcher(raise_on="geocoding")
        service = self._service(fetcher, _Clock())
        self._prime_and_refresh(service, location="Nowhere")
        self.assertIsNone(service.ambient_weather_line(location="Nowhere", timezone="Europe/London", now=_NOW))

    def test_forecast_failure_degrades_to_none(self) -> None:
        fetcher = _FakeFetcher(raise_on="forecast")
        service = self._service(fetcher, _Clock())
        self._prime_and_refresh(service, location="Brighton")
        self.assertIsNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))

    def test_no_geocode_match_degrades_to_none(self) -> None:
        fetcher = _FakeFetcher(geocode={"results": []})
        service = self._service(fetcher, _Clock())
        self._prime_and_refresh(service, location="Atlantis")
        self.assertIsNone(service.ambient_weather_line(location="Atlantis", timezone="Europe/London", now=_NOW))

    def test_hard_expiry_drops_stale_line(self) -> None:
        fetcher, clock = _FakeFetcher(), _Clock(1000.0)
        service = self._service(fetcher, clock)
        self._prime_and_refresh(service, location="Brighton")
        self.assertIsNotNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))
        # Jump far past the hard-expiry window: the cached value is too old to show.
        clock.value = 1000.0 + 5 * 60 * 60
        self.assertIsNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))

    def test_location_change_drops_previous_cache(self) -> None:
        fetcher, clock = _FakeFetcher(), _Clock()
        service = self._service(fetcher, clock)
        self._prime_and_refresh(service, location="Brighton")
        self.assertIsNotNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))
        # Switching location invalidates the old reading immediately.
        self.assertIsNone(service.ambient_weather_line(location="Tokyo", timezone="Europe/London", now=_NOW))


class WeatherPersistenceTests(unittest.TestCase):
    def _seed(self, path: Path, *, at_epoch: float = 1000.0) -> None:
        """Populate + persist a reading for 'Brighton' at a given clock time."""
        service = WeatherService(fetch_json=_FakeFetcher(), clock=_Clock(at_epoch), state_path=path)
        service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW)
        service._refresh_blocking("Brighton")
        self.assertIsNotNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))

    def test_reading_restored_and_reused_within_the_hour_without_refetch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session" / "weather-cache.json"
            self._seed(path, at_epoch=1000.0)
            # A fresh instance (restart) 30 min later restores the reading and does
            # NOT hit the network — the value is under an hour old.
            fetcher = _FakeFetcher()
            restarted = WeatherService(fetch_json=fetcher, clock=_Clock(1000.0 + 30 * 60), state_path=path)
            line = restarted.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW)
            self.assertIsNotNone(line)
            self.assertIn("light rain", line)
            self.assertEqual([], fetcher.calls)

    def test_one_hour_staleness_rule(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session" / "weather-cache.json"
            self._seed(path, at_epoch=1000.0)

            # 59 min old -> still fresh, no refresh scheduled.
            within = WeatherService(fetch_json=_FakeFetcher(), clock=_Clock(1000.0 + 59 * 60), state_path=path)
            within.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW)
            with within._lock:
                self.assertFalse(within._should_refresh_locked())

            # 61 min old -> over an hour, a refresh is due.
            after = WeatherService(fetch_json=_FakeFetcher(), clock=_Clock(1000.0 + 61 * 60), state_path=path)
            with after._lock:
                self.assertTrue(after._should_refresh_locked())

    def test_in_memory_service_does_not_touch_disk(self) -> None:
        service = WeatherService(fetch_json=_FakeFetcher(), clock=_Clock(), state_path=None)
        service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW)
        service._refresh_blocking("Brighton")  # no state_path => nothing persisted, no error
        self.assertIsNotNone(service.ambient_weather_line(location="Brighton", timezone="Europe/London", now=_NOW))


if __name__ == "__main__":
    unittest.main()
