from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any
from uuid import uuid4

from rosx_ai.world.model import WorldModel


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class TaskStep:
    name: str
    skill_name: str
    parameters: dict[str, Any]
    preconditions: list[str] = field(default_factory=list)
    postconditions: list[str] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING


@dataclass
class TaskPlan:
    task_id: str
    instruction: str
    summary: str
    steps: list[TaskStep]
    status: TaskStatus = TaskStatus.PENDING


class UnsupportedInstructionError(ValueError):
    pass


class HierarchicalPlanner:
    """Planner for initial embodied navigation tasks.

    This is deliberately deterministic for Milestone 1. It creates inspectable plans
    instead of sending untrusted natural language directly to robot interfaces.
    """

    def create_plan(self, instruction: str, world: WorldModel) -> TaskPlan:
        normalized = instruction.strip().lower().rstrip(".")
        if normalized not in {"go to the red cube", "navigate to the red cube"}:
            raise UnsupportedInstructionError(
                "Milestone 1 supports only navigation instructions like 'Go to the red cube.'"
            )

        target = world.find_object(color="red", name="red cube")
        if target is None:
            raise UnsupportedInstructionError("No known red cube exists in the world model.")

        target_location = world.resolve_entity_location(target.entity_id)
        if target_location is None:
            raise UnsupportedInstructionError("The red cube has no resolved navigable location.")

        return TaskPlan(
            task_id=str(uuid4()),
            instruction=instruction,
            summary="Navigate to the known red cube location.",
            steps=[
                TaskStep(
                    name="Resolve target object",
                    skill_name="world_query",
                    parameters={"entity_id": target.entity_id},
                    postconditions=[f"target:{target.entity_id}:resolved"],
                ),
                TaskStep(
                    name="Navigate to target location",
                    skill_name="navigate_to",
                    parameters={
                        "target_entity_id": target.entity_id,
                        "target_location_id": target_location.location_id,
                    },
                    preconditions=[f"target:{target.entity_id}:resolved"],
                    postconditions=[f"robot:near:{target.entity_id}"],
                ),
            ],
        )

