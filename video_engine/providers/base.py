"""Base interface every video-generation provider must implement."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class GenerationResult:
    # Every provider returns a Cloudinary-hosted URL — never a local path.
    # See cloudinary_client.py: media is exchanged exclusively through
    # Cloudinary, both for the input image (Node uploads, Python passes the
    # URL to the model) and the output video (Python uploads, Node reuses
    # the URL). No filesystem hand-off between Node and this process, ever.
    video_url: str | None = None
    seed: int | None = None
    raw: dict | None = None


class ProviderError(Exception):
    """Base class for provider errors. Carries full diagnostic context —
    never collapse this down to a generic 'provider failed' message."""

    def __init__(self, message: str, *, category: str = "unknown", detail: dict | None = None):
        super().__init__(message)
        self.category = category  # quota | auth | network | validation | model | unknown
        self.detail = detail or {}


class VideoProvider(ABC):
    name: str = "base"

    @abstractmethod
    def generate(
        self,
        *,
        job_id: str,
        image_url: str,
        prompt: str,
        duration: float,
        width: int,
        height: int,
        seed: int | None,
        randomize_seed: bool,
        enhance_prompt: bool,
    ) -> GenerationResult:
        """Run generation for one shot and return its result.

        Implementations should raise ProviderError (not a bare Exception)
        for any failure, with `category` set so callers (e.g. token
        rotation / retry logic) can distinguish quota vs auth vs network
        vs validation vs model errors.
        """
        raise NotImplementedError