/**
 * The product catalog, read from model/characters.json — the same file the
 * trainer conditions on. One definition per SKU: id, persona, price, and the
 * anchors its eval score is computed against.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface Character {
  id: string;
  name: string;
  blurb: string;
  system: string;
  voice: string[];
  price_usd_per_m: { prompt: number; completion: number };
  anchors: { in_character: string[]; out_of_character: string[] };
}

export interface Catalog {
  base: string;
  license_delay_days: number;
  characters: Character[];
}

let cached: Catalog | undefined;

export function catalog(): Catalog {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(config.modelDir, "characters.json"), "utf8"));
  }
  return cached!;
}

/** Accepts a bare id or a namespaced one, since routers prefix with the owner. */
export function findCharacter(model: string): Character | undefined {
  const id = model.includes("/") ? model.split("/").pop()! : model;
  return catalog().characters.find((c) => c.id === id);
}
