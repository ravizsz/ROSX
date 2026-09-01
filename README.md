# ROSX

ROSX is an AI-native embodied robotics platform foundation. The first milestone is a
simulation-first loop for:

```text
Human: "Go to the red cube."
Parser -> Planner -> World Model -> Safety -> Navigation Skill -> Simulated Nav2 Adapter
```

This repository intentionally starts with narrow, tested behavior rather than pretending
to be a complete robot operating system.

## Current Milestone

Implemented:

- Provider-independent AI/runtime boundaries.
- A typed world model with entities, locations, relationships, and confidence.
- A hierarchical planner for the first navigation task.
- A skill registry and a `navigate_to` skill.
- A safety policy gate before motion.
- A deterministic simulated navigation adapter with feedback events.
- A FastAPI entrypoint skeleton for future web control.
- A ROS 2 Jazzy workspace skeleton for future package integration.
- Unit tests covering the complete MVP loop and key failure behavior.

Not yet implemented:

- Real Nav2 action client bindings.
- Gazebo or Isaac Sim launch files.
- MoveIt 2 manipulation.
- Persistent PostgreSQL memory.
- Next.js dashboard.

## Run Tests

```bash
python -m pytest
```

## Run the MVP Example

```bash
python examples/run_red_cube.py
```

Expected result: a completed task trace showing the planner selecting `navigate_to`,
the world model resolving `red_cube`, the safety layer approving the goal, and the
simulated navigation adapter reaching the cube location.

## Repository Layout

```text
apps/api/                 FastAPI control API skeleton
ai/rosx_ai/               AI runtime, planner, world model, skills, simulation
robotics/ros_ws/src/      ROS 2 workspace/package skeletons
robotics/simulation/      Simulation scenario notes and future launch assets
configs/                  Experiment and runtime configuration
docs/                     Architecture and roadmap
examples/                 Runnable examples
tests/                    Unit and integration tests
```

