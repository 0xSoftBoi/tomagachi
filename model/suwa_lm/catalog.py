"""The product catalog, loaded from model/characters.json.

Shared with the serving layer (agent/src/characters.ts) so a SKU is defined
exactly once: same id, same system prompt, same price, same eval anchors.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parents[1] / "characters.json"


@dataclass(frozen=True)
class Character:
    id: str
    name: str
    blurb: str
    system: str
    voice: tuple[str, ...]
    in_character: tuple[str, ...]
    out_of_character: tuple[str, ...]
    prompt_usd_per_m: float
    completion_usd_per_m: float


@dataclass(frozen=True)
class Catalog:
    base: str
    license_delay_days: int
    characters: tuple[Character, ...]

    def get(self, character_id: str) -> Character:
        for c in self.characters:
            if c.id == character_id:
                return c
        known = ", ".join(c.id for c in self.characters)
        raise KeyError(f"unknown character {character_id!r} (have: {known})")


def load(path: Path | str = CATALOG_PATH) -> Catalog:
    raw = json.loads(Path(path).read_text())
    return Catalog(
        base=raw["base"],
        license_delay_days=int(raw.get("license_delay_days", 90)),
        characters=tuple(
            Character(
                id=c["id"],
                name=c["name"],
                blurb=c["blurb"],
                system=c["system"],
                voice=tuple(c.get("voice", ())),
                in_character=tuple(c["anchors"]["in_character"]),
                out_of_character=tuple(c["anchors"]["out_of_character"]),
                prompt_usd_per_m=float(c["price_usd_per_m"]["prompt"]),
                completion_usd_per_m=float(c["price_usd_per_m"]["completion"]),
            )
            for c in raw["characters"]
        ),
    )
