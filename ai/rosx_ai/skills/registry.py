from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from rosx_ai.events import EventLog
from rosx_ai.safety.policy import SafetyPolicy
from rosx_ai.simulation.nav2 import NavigationResult, SimulatedNav2Adapter
from rosx_ai.world.model import WorldModel

SkillHandler = Callable[[str, dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    description: str
    required_capabilities: tuple[str, ...]
    timeout_seconds: float
    failure_modes: tuple[str, ...]
    recovery_strategy: str
    handler: SkillHandler


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, SkillDefinition] = {}

    def register(self, skill: SkillDefinition) -> None:
        if skill.name in self._skills:
            raise ValueError(f"Skill already registered: {skill.name}")
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillDefinition:
        try:
            return self._skills[name]
        except KeyError as exc:
            raise KeyError(f"Unknown skill: {name}") from exc

    def names(self) -> list[str]:
        return sorted(self._skills)


def build_default_skill_registry(
    *,
    world: WorldModel,
    event_log: EventLog,
    navigation: SimulatedNav2Adapter,
    safety_policy: SafetyPolicy,
) -> SkillRegistry:
    registry = SkillRegistry()

    async def world_query(task_id: str, parameters: dict[str, Any]) -> dict[str, Any]:
        entity_id = str(parameters["entity_id"])
        entity = world.entity(entity_id)
        if entity is None:
            raise ValueError(f"Entity not found: {entity_id}")
        location = world.resolve_entity_location(entity_id)
        event_log.emit(
            "WorldStateQueried",
            task_id,
            entity_id=entity_id,
            location_id=location.location_id if location else None,
            confidence=entity.confidence,
        )
        return {"entity": entity, "location": location}

    async def navigate_to(task_id: str, parameters: dict[str, Any]) -> NavigationResult:
        location_id = str(parameters["target_location_id"])
        location = world.location(location_id)
        if location is None:
            raise ValueError(f"Location not found: {location_id}")
        safety_policy.validate_navigation_goal(location)
        event_log.emit("SafetyCheckPassed", task_id, action="navigate_to", location_id=location_id)
        return await navigation.navigate_to(task_id, location)

    registry.register(
        SkillDefinition(
            name="world_query",
            description="Resolve an entity from the world model.",
            required_capabilities=(),
            timeout_seconds=2.0,
            failure_modes=("entity_not_found", "location_unknown"),
            recovery_strategy="ask_for_clarification_or_replan",
            handler=world_query,
        )
    )
    registry.register(
        SkillDefinition(
            name="navigate_to",
            description="Navigate to a validated semantic location through a Nav2-compatible adapter.",
            required_capabilities=("mobile_base", "navigation"),
            timeout_seconds=30.0,
            failure_modes=("goal_rejected", "timeout", "path_blocked", "controller_failure"),
            recovery_strategy="cancel_goal_then_replan_or_request_operator_help",
            handler=navigate_to,
        )
    )
    return registry

