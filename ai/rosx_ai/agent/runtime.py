from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from rosx_ai.events import Event, EventLog
from rosx_ai.planning.hierarchical import HierarchicalPlanner, TaskPlan, TaskStatus
from rosx_ai.skills.registry import SkillRegistry
from rosx_ai.world.model import WorldModel


@dataclass(frozen=True)
class TaskExecutionResult:
    plan: TaskPlan
    events: list[Event]
    outputs: list[Any]


class AgentRuntime:
    """Coordinates planning and skill execution without touching low-level robot control."""

    def __init__(
        self,
        *,
        planner: HierarchicalPlanner,
        world: WorldModel,
        skills: SkillRegistry,
        event_log: EventLog,
    ) -> None:
        self.planner = planner
        self.world = world
        self.skills = skills
        self.event_log = event_log

    async def run_instruction(self, instruction: str) -> TaskExecutionResult:
        plan = self.planner.create_plan(instruction, self.world)
        outputs: list[Any] = []
        self.event_log.emit("TaskCreated", plan.task_id, instruction=instruction)
        self.event_log.emit("TaskStarted", plan.task_id, summary=plan.summary)
        plan.status = TaskStatus.RUNNING

        try:
            for step in plan.steps:
                step.status = TaskStatus.RUNNING
                self.event_log.emit(
                    "TaskStepStarted",
                    plan.task_id,
                    step_name=step.name,
                    skill_name=step.skill_name,
                )
                skill = self.skills.get(step.skill_name)
                output = await skill.handler(plan.task_id, step.parameters)
                outputs.append(output)
                step.status = TaskStatus.COMPLETED
                self.event_log.emit(
                    "TaskStepCompleted",
                    plan.task_id,
                    step_name=step.name,
                    skill_name=step.skill_name,
                )
        except Exception as exc:
            plan.status = TaskStatus.FAILED
            self.event_log.emit("TaskFailed", plan.task_id, error=str(exc))
            raise

        plan.status = TaskStatus.COMPLETED
        self.event_log.emit("TaskCompleted", plan.task_id)
        return TaskExecutionResult(plan=plan, events=self.event_log.by_task(plan.task_id), outputs=outputs)

