# ROSX Roadmap

## D. Implementation Roadmap

### Milestone 1: Deterministic Embodied Loop

- Create monorepo structure.
- Implement typed world model.
- Implement planner and skill registry.
- Implement safety-gated simulated navigation.
- Add FastAPI skeleton.
- Add ROS 2 workspace skeleton.
- Test the `Go to the red cube.` loop.

### Milestone 2: ROS 2 Integration

- Add `rclpy` package wrappers.
- Implement a real Nav2 action client adapter.
- Add launch files and topic/action contracts.
- Add ROS integration tests where ROS 2 Jazzy is available.

### Milestone 3: Simulation Scenarios

- Add Gazebo world for the red cube scenario.
- Add deterministic scenario fixtures.
- Add robot spawn, localization, and map setup.
- Add CI paths that can validate non-GUI simulation components.

### Milestone 4: Web Command Center

- Add Next.js, TypeScript, and Tailwind dashboard.
- Stream task events through WebSockets.
- Display robot health, task graph, map state, logs, and cancellation controls.

### Milestone 5: Perception and Semantic Mapping

- Add perception result interfaces.
- Add object detection adapters.
- Connect detected entities to the world model.
- Add confidence-aware replanning.

### Milestone 6: Manipulation

- Add MoveIt 2 adapter boundaries.
- Model grasp candidates, plan validation, execution, and verification.
- Extend safety with workspace and collision constraints.

## F. Risks

- **Technical:** ROS 2, Nav2, simulation, backend, and web runtime can easily become
  coupled if interfaces are not kept narrow.
- **Hardware:** Different robots expose incompatible sensors, controller limits, frames,
  and safety mechanisms.
- **AI reliability:** LLMs can produce unsupported plans or overconfident summaries; model
  output must remain advisory until validated.
- **Safety:** Navigation and manipulation require policy checks, emergency stop hooks,
  confidence thresholds, cancellation, and audit trails.
- **Scalability:** Long-running memory, high-rate perception, event streams, and traces
  will need persistent storage and retention policies.

