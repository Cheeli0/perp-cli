/**
 * settings.json writes are atomic (L4): every write (saveSettings and the one-time legacy
 * referralCodes.pacifica migration) goes through tmp + rename, so a failed write leaves the
 * previous file intact and no tmp file behind. HOME isolated (helpers/isolate-home.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "path";

let failRename = false;
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("fs")>();
  return {
    ...orig,
    renameSync: (from: string, to: string) => {
      if (failRename) throw new Error("simulated crash before rename");
      return orig.renameSync(from, to);
    },
  };
});

const fs = await vi.importActual<typeof import("fs")>("fs");
const { loadSettings, saveSettings } = await import("../settings.js");

const PERP_DIR = resolve(process.env.HOME ?? "", ".perp");
const SETTINGS = resolve(PERP_DIR, "settings.json");
const tmpFiles = () => fs.readdirSync(PERP_DIR).filter(f => f.endsWith(".tmp"));

beforeEach(() => {
  failRename = false;
  fs.rmSync(PERP_DIR, { recursive: true, force: true });
});

describe("atomic settings.json writes", () => {
  it("saveSettings: a failed write keeps the previous file intact and leaves no tmp file", () => {
    const s = loadSettings();
    s.defaultExchange = "hyperliquid";
    saveSettings(s);
    const before = fs.readFileSync(SETTINGS, "utf-8");
    expect((fs.statSync(SETTINGS).mode & 0o777).toString(8)).toBe("600");

    failRename = true;
    const next = loadSettings();
    next.defaultExchange = "aster";
    expect(() => saveSettings(next)).toThrow(/simulated crash/);
    expect(fs.readFileSync(SETTINGS, "utf-8")).toBe(before);
    expect(tmpFiles()).toEqual([]);
  });

  it("legacy referralCodes.pacifica migration writes through the same atomic path", () => {
    fs.mkdirSync(PERP_DIR, { recursive: true });
    const legacy = JSON.stringify({ referralCodes: { pacifica: "OLD" } });
    fs.writeFileSync(SETTINGS, legacy);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    failRename = true;
    expect(() => loadSettings()).toThrow(/simulated crash/);
    expect(fs.readFileSync(SETTINGS, "utf-8")).toBe(legacy);
    expect(tmpFiles()).toEqual([]);

    failRename = false;
    loadSettings();
    expect(JSON.parse(fs.readFileSync(SETTINGS, "utf-8")).referralCodes).toEqual({});
    expect(tmpFiles()).toEqual([]);
  });
});
