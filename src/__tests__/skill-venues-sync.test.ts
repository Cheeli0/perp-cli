/**
 * Every registered venue is documented in the shipped skill (SKILL.md and the command reference),
 * and an unofficial-API venue is called out as UNOFFICIAL there. Adding a venue without its skill
 * docs fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "../exchanges/venues/index.js";
import { listVenues } from "../exchanges/venue.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = readFileSync(resolve(ROOT, "skills/perp-cli/SKILL.md"), "utf-8");
const COMMANDS = readFileSync(resolve(ROOT, "skills/perp-cli/references/commands.md"), "utf-8");

describe("skill docs ↔ venue registry", () => {
  for (const v of listVenues()) {
    it(`${v.id} is documented in SKILL.md and references/commands.md`, () => {
      expect(SKILL.includes(v.id) || SKILL.includes(v.displayName)).toBe(true);
      expect(COMMANDS).toContain(`\`${v.id}`);
      if (v.apiStatus.kind === "unofficial") {
        expect(SKILL).toMatch(new RegExp(`${v.displayName}[^\\n]*UNOFFICIAL`));
      }
    });
  }
});
