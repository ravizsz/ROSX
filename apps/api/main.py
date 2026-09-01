from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from rosx_ai.runtime_factory import build_red_cube_runtime

app = FastAPI(title="ROSX API", version="0.1.0")


class CommandRequest(BaseModel):
    instruction: str


@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/tasks")
async def create_task(request: CommandRequest) -> dict[str, object]:
    runtime = build_red_cube_runtime()
    result = await runtime.run_instruction(request.instruction)
    return {
        "task_id": result.plan.task_id,
        "status": result.plan.status,
        "summary": result.plan.summary,
        "events": [
            {
                "type": event.type,
                "timestamp": event.timestamp.isoformat(),
                "payload": event.payload,
            }
            for event in result.events
        ],
    }

