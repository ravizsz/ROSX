from __future__ import annotations

import asyncio
import unittest

from rosx_ai.planning.hierarchical import HierarchicalPlanner, TaskStatus, UnsupportedInstructionError
from rosx_ai.runtime_factory import build_red_cube_runtime
from rosx_ai.safety.policy import SafetyPolicy, SafetyViolationError, WorkspaceBounds
from rosx_ai.world.model import Location, Pose2D, WorldModel


class MvpLoopTests(unittest.TestCase):
    def test_red_cube_instruction_completes_end_to_end(self) -> None:
        runtime = build_red_cube_runtime()

        result = asyncio.run(runtime.run_instruction("Go to the red cube."))

        self.assertEqual(result.plan.status, TaskStatus.COMPLETED)
        self.assertEqual([step.skill_name for step in result.plan.steps], ["world_query", "navigate_to"])
        self.assertEqual(result.events[0].type, "TaskCreated")
        self.assertIn("SafetyCheckPassed", {event.type for event in result.events})
        self.assertEqual(result.events[-1].type, "TaskCompleted")

    def test_planner_rejects_unsupported_instruction(self) -> None:
        planner = HierarchicalPlanner()

        with self.assertRaises(UnsupportedInstructionError):
            planner.create_plan("Pick up the red cube.", WorldModel.red_cube_scenario())

    def test_safety_rejects_goal_outside_workspace(self) -> None:
        policy = SafetyPolicy(WorkspaceBounds(min_x=-1.0, max_x=1.0, min_y=-1.0, max_y=1.0))
        location = Location("far", "Far point", Pose2D(10.0, 0.0))

        with self.assertRaises(SafetyViolationError):
            policy.validate_navigation_goal(location)
