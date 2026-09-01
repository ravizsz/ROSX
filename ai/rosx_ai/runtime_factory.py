from __future__ import annotations

from rosx_ai.agent.runtime import AgentRuntime
from rosx_ai.events import EventLog
from rosx_ai.planning.hierarchical import HierarchicalPlanner
from rosx_ai.safety.policy import SafetyPolicy, WorkspaceBounds
from rosx_ai.simulation.nav2 import SimulatedNav2Adapter
from rosx_ai.skills.registry import build_default_skill_registry
from rosx_ai.world.model import WorldModel


def build_red_cube_runtime() -> AgentRuntime:
    world = WorldModel.red_cube_scenario()
    event_log = EventLog()
    navigation = SimulatedNav2Adapter(event_log)
    safety = SafetyPolicy(WorkspaceBounds(min_x=-5.0, max_x=5.0, min_y=-5.0, max_y=5.0))
    skills = build_default_skill_registry(
        world=world,
        event_log=event_log,
        navigation=navigation,
        safety_policy=safety,
    )
    return AgentRuntime(
        planner=HierarchicalPlanner(),
        world=world,
        skills=skills,
        event_log=event_log,
    )

