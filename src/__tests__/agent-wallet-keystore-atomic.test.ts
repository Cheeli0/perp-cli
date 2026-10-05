import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import { writeKeystoreAtomic } from "../agent-wallet/venue-keystore.js";

// Review L2: keystore writes are tmp + fsync + rename, mode 0600, and never leave a tmp file.
describe("writeKeystoreAtomic", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("writes 0600, replaces an existing file, and leaves no tmp file behind", () => {
    const d = mkdtempSync(join(os.tmpdir(), "perp-ks-"));
    dirs.push(d);
    const p = join(d, "k.json");
    writeFileSync(p, "old", { mode: 0o644 });
    writeKeystoreAtomic(p, "{\"new\":true}");
    expect(readFileSync(p, "utf-8")).toBe("{\"new\":true}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["k.json"]);
  });

  it("throws (no swallow) and leaves the previous file intact when the write cannot complete", () => {
    const d = mkdtempSync(join(os.tmpdir(), "perp-ks-"));
    dirs.push(d);
    const p = join(d, "k.json");
    writeFileSync(p, "old");
    // Target path is a directory → rename fails after the tmp file was written.
    const blocked = join(d, "dir.json");
    mkdirSync(join(blocked, "child"), { recursive: true });
    expect(() => writeKeystoreAtomic(blocked, "x")).toThrow();
    expect(readFileSync(p, "utf-8")).toBe("old");
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
