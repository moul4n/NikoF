from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class PrerequisiteBlocker:
    id: str
    status: str
    summary: str


@dataclass(slots=True, frozen=True)
class PrerequisiteLane:
    id: str
    display_name: str
    state: str
    blockers: list[PrerequisiteBlocker] = field(default_factory=list)


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
    prerequisite_lanes: list[PrerequisiteLane] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class SubsystemReadiness:
    """Live readiness of a managed runtime subsystem (worker/sidecar).

    Distinct from prerequisite lanes: lanes report install-time state, this
    reports run-time state so operators can tell "HTTP is up" apart from
    "the stack is actually ready to take a turn".
    """

    id: str
    state: str
    ready: bool
    detail: str | None = None


@dataclass(slots=True, frozen=True)
class HealthPayload:
    status: str
    mode: str
    diagnostics: HealthDiagnostics
    subsystems: list[SubsystemReadiness] = field(default_factory=list)