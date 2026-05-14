from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class DiagnosticProbe:
    name: str
    configured_by: str
    required_for_stage: str
    available: bool


@dataclass(slots=True, frozen=True)
class HealthDiagnostics:
    character_packages_available: int
    storage_probes: list[DiagnosticProbe]
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class HealthPayload:
    status: str
    mode: str
    diagnostics: HealthDiagnostics