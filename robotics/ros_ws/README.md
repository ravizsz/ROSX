# ROS 2 Workspace

This directory is the ROS 2 Jazzy workspace boundary for ROSX.

Milestone 1 keeps executable robot behavior in a deterministic Python simulation adapter
so the repository can be tested on machines without ROS installed. Future milestones will
add packages under `src/` for Nav2, perception, skills, world-model bridges, and safety
nodes.

Expected future package groups:

- `embodied_core`
- `embodied_agent`
- `embodied_perception`
- `embodied_navigation`
- `embodied_manipulation`
- `embodied_skills`
- `embodied_world`
- `embodied_safety`

