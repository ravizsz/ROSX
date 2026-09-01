# ROSX Architecture

## A. Architecture Assessment

The starting workspace contained only untracked static web files:

- `index.html`
- `i-hookup.html`
- `script.js`
- `styles.css`
- `static-server.js`

There was no existing robotics, AI runtime, package metadata, test suite, ROS 2
workspace, backend, or documentation. The current implementation therefore creates a
new ROSX monorepo foundation while leaving those files untouched.

## B. Proposed Architecture

ROSX is organized around explicit subsystem boundaries:

- **Agent Runtime** receives instructions, owns task state, invokes the planner, and
  executes validated skills.
- **Planner** turns supported intent into a typed hierarchical `TaskPlan` with
  preconditions and postconditions.
- **World Model** stores entities, locations, semantic relationships, confidence, and
  spatial state behind a replaceable API.
- **Skill Runtime** exposes named, validated robot skills such as `navigate_to`.
- **Safety Policy** gates physical actions before they reach robot adapters.
- **Robot Adapters** provide Nav2, MoveIt 2, simulator, and hardware bindings behind
  stable interfaces.
- **Event Log** records traceable task, skill, navigation, safety, and world events.
- **API Runtime** exposes versioned HTTP/WebSocket endpoints for operator tools.
- **Web Runtime** will provide the robot command center in a later milestone.

## C. Dependency Graph

```text
Frontend Command Center
        |
        v
FastAPI /v1
        |
        v
AgentRuntime
        |
        +--> HierarchicalPlanner
        |         |
        |         v
        |    WorldModel
        |
        +--> SkillRegistry
                  |
                  +--> SafetyPolicy
                  |
                  +--> NavigationAdapter
                            |
                            v
                      Nav2 or Simulation

All runtime components emit timestamped events into EventLog.
```

The LLM/VLM/provider layer is intentionally defined as interfaces, not wired into the
first deterministic milestone. This prevents untrusted model output from bypassing the
planner, skill registry, or safety system.

## E. MVP Definition

The smallest genuinely working embodied-AI system is:

1. Parse the instruction `Go to the red cube.`
2. Build a hierarchical task plan.
3. Query the world model for the red cube.
4. Resolve the cube's semantic location into a map pose.
5. Validate that pose against a safety policy.
6. Execute `navigate_to` through a Nav2-shaped simulation adapter.
7. Emit a complete task trace.
8. Pass automated tests.

This is intentionally not a chatbot and not a direct motor-command interface.

