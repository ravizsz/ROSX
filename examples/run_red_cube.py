from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ai"))

from rosx_ai.runtime_factory import build_red_cube_runtime


async def main() -> None:
    runtime = build_red_cube_runtime()
    result = await runtime.run_instruction("Go to the red cube.")
    print(f"task_id={result.plan.task_id}")
    print(f"status={result.plan.status}")
    for event in result.events:
        print(f"{event.type}: {event.payload}")


if __name__ == "__main__":
    asyncio.run(main())
