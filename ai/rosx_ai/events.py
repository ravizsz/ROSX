from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


@dataclass(frozen=True)
class Event:
    """A traceable runtime event emitted by planners, skills, and adapters."""

    type: str
    task_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))
    event_id: str = field(default_factory=lambda: str(uuid4()))


class EventLog:
    def __init__(self) -> None:
        self._events: list[Event] = []

    def emit(self, event_type: str, task_id: str, **payload: Any) -> Event:
        event = Event(type=event_type, task_id=task_id, payload=payload)
        self._events.append(event)
        return event

    def all(self) -> list[Event]:
        return list(self._events)

    def by_task(self, task_id: str) -> list[Event]:
        return [event for event in self._events if event.task_id == task_id]

