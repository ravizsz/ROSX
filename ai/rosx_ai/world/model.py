from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EntityType(StrEnum):
    ROBOT = "robot"
    OBJECT = "object"
    PERSON = "person"
    LOCATION = "location"


@dataclass(frozen=True)
class Pose2D:
    x: float
    y: float
    theta: float = 0.0
    frame_id: str = "map"


@dataclass(frozen=True)
class Location:
    location_id: str
    name: str
    pose: Pose2D
    confidence: float = 1.0


@dataclass
class Entity:
    entity_id: str
    name: str
    entity_type: EntityType
    properties: dict[str, Any] = field(default_factory=dict)
    location_id: str | None = None
    confidence: float = 1.0


@dataclass(frozen=True)
class Relationship:
    subject_id: str
    predicate: str
    object_id: str
    confidence: float = 1.0


class WorldModel:
    """In-memory world state for the MVP.

    The API is intentionally small and replaceable; later milestones can back this with
    PostgreSQL, vector search, or ROS map integrations without changing planner code.
    """

    def __init__(self) -> None:
        self._entities: dict[str, Entity] = {}
        self._locations: dict[str, Location] = {}
        self._relationships: list[Relationship] = []

    def add_location(self, location: Location) -> None:
        self._locations[location.location_id] = location

    def add_entity(self, entity: Entity) -> None:
        if entity.location_id is not None and entity.location_id not in self._locations:
            raise ValueError(f"Unknown location_id: {entity.location_id}")
        self._entities[entity.entity_id] = entity

    def add_relationship(self, relationship: Relationship) -> None:
        if relationship.subject_id not in self._entities:
            raise ValueError(f"Unknown relationship subject: {relationship.subject_id}")
        known_object = (
            relationship.object_id in self._entities or relationship.object_id in self._locations
        )
        if not known_object:
            raise ValueError(f"Unknown relationship object: {relationship.object_id}")
        self._relationships.append(relationship)

    def entity(self, entity_id: str) -> Entity | None:
        return self._entities.get(entity_id)

    def location(self, location_id: str) -> Location | None:
        return self._locations.get(location_id)

    def find_object(self, *, color: str | None = None, name: str | None = None) -> Entity | None:
        candidates = [
            entity
            for entity in self._entities.values()
            if entity.entity_type == EntityType.OBJECT
            and (name is None or entity.name == name or entity.entity_id == name)
            and (color is None or entity.properties.get("color") == color)
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda entity: entity.confidence)

    def resolve_entity_location(self, entity_id: str) -> Location | None:
        entity = self._entities.get(entity_id)
        if entity is None or entity.location_id is None:
            return None
        return self._locations.get(entity.location_id)

    @classmethod
    def red_cube_scenario(cls) -> WorldModel:
        world = cls()
        world.add_location(Location("start", "Robot start", Pose2D(0.0, 0.0)))
        world.add_location(Location("cube_location", "Red cube location", Pose2D(2.0, 1.25)))
        world.add_entity(
            Entity(
                entity_id="robot_1",
                name="ROSX Mobile Base",
                entity_type=EntityType.ROBOT,
                location_id="start",
                properties={"capabilities": ["navigate"]},
            )
        )
        world.add_entity(
            Entity(
                entity_id="red_cube",
                name="red cube",
                entity_type=EntityType.OBJECT,
                location_id="cube_location",
                confidence=0.96,
                properties={"color": "red", "shape": "cube", "graspable": True},
            )
        )
        world.add_relationship(Relationship("red_cube", "located_at", "cube_location", 0.96))
        return world

