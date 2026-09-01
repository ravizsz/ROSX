from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import StrEnum

from rosx_ai.events import EventLog
from rosx_ai.world.model import Location, Pose2D


class NavigationStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


@dataclass(frozen=True)
class NavigationResult:
    status: NavigationStatus
    final_pose: Pose2D
    message: str


class SimulatedNav2Adapter:
    """Deterministic Nav2-shaped adapter for tests and local development."""

    def __init__(self, event_log: EventLog, step_delay_seconds: float = 0.0) -> None:
        self.event_log = event_log
        self.step_delay_seconds = step_delay_seconds
        self.current_pose = Pose2D(0.0, 0.0)

    async def navigate_to(self, task_id: str, location: Location) -> NavigationResult:
        self.event_log.emit(
            "NavigationStarted",
            task_id,
            location_id=location.location_id,
            goal={"x": location.pose.x, "y": location.pose.y, "theta": location.pose.theta},
        )
        if self.step_delay_seconds > 0:
            await asyncio.sleep(self.step_delay_seconds)

        self.current_pose = location.pose
        self.event_log.emit(
            "NavigationCompleted",
            task_id,
            location_id=location.location_id,
            final_pose={"x": location.pose.x, "y": location.pose.y, "theta": location.pose.theta},
        )
        return NavigationResult(
            status=NavigationStatus.SUCCEEDED,
            final_pose=location.pose,
            message=f"Reached {location.name}.",
        )

