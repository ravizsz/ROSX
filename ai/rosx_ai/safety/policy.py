from __future__ import annotations

from dataclasses import dataclass

from rosx_ai.world.model import Location, Pose2D


@dataclass(frozen=True)
class WorkspaceBounds:
    min_x: float
    max_x: float
    min_y: float
    max_y: float

    def contains(self, pose: Pose2D) -> bool:
        return self.min_x <= pose.x <= self.max_x and self.min_y <= pose.y <= self.max_y


class SafetyViolationError(PermissionError):
    pass


class SafetyPolicy:
    def __init__(self, workspace_bounds: WorkspaceBounds, min_goal_confidence: float = 0.7) -> None:
        self.workspace_bounds = workspace_bounds
        self.min_goal_confidence = min_goal_confidence

    def validate_navigation_goal(self, location: Location) -> None:
        if location.confidence < self.min_goal_confidence:
            raise SafetyViolationError(
                f"Goal confidence {location.confidence:.2f} is below "
                f"{self.min_goal_confidence:.2f}."
            )
        if not self.workspace_bounds.contains(location.pose):
            raise SafetyViolationError(
                f"Goal pose ({location.pose.x}, {location.pose.y}) is outside workspace bounds."
            )

