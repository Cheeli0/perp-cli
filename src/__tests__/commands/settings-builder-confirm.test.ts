/**
 * `perp settings set builder.<venue>` interactive confirmation (L5): the y/N prompt shows the
 * fee; anything but y/yes saves nothing. HOME isolated; readline is mocked (no real TTY).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const answers: string[] = [];
const questions: string[] = [];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => { questions.push(q); return answers.shift() ?? ""; },
    close: () => {},
  }),
}));

const { buildProgram } = await import("../../cli-program.js");
const { loadSettings } = await import("../../settings.js");

async function run(args: string[]): Promise<void> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "test" });
  await program.parseAsync(["node", "perp", ...args]);
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  questions.length = 0;
  process.exitCode = 0;
});

describe("settings set builder.<venue> — y/N confirmation", () => {
  it("shows the fee; 'n' (or empty) saves nothing, 'y' saves", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    answers.push("n");
    await run(["settings", "set", "builder.ondo", "mycode,2"]);
    expect(questions[0]).toMatch(/builder\.ondo = mycode charges 2 bps on YOUR ondo perp orders/);
    expect(questions[0]).toMatch(/\[y\/N\]/);
    expect(loadSettings().builder.ondo).toBeUndefined();

    answers.push("y");
    await run(["settings", "set", "builder.ondo", "mycode,2"]);
    expect(loadSettings().builder.ondo).toEqual({ code: "mycode", feeBps: 2 });
  });

  it("feeKind max (pacifica) is shown as 'up to'", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    answers.push("");
    await run(["settings", "set", "builder.pacifica", "ABC123,3"]);
    expect(questions[0]).toMatch(/charges up to 3 bps/);
    expect(loadSettings().builder.pacifica).toBeUndefined();
  });
});
