from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class GenerationRequest:
    prompt: str
    system: str | None = None


@dataclass(frozen=True)
class GenerationResponse:
    text: str
    provider: str


class LLMProvider(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        """Generate language output from a provider-specific backend."""


class VLMProvider(Protocol):
    async def analyze(self, image_bytes: bytes, prompt: str) -> GenerationResponse:
        """Analyze an image with language-grounded output."""


class EmbeddingProvider(Protocol):
    async def embed(self, text: str) -> list[float]:
        """Return an embedding vector for semantic memory and retrieval."""

