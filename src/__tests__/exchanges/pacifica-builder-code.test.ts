/**
 * Pacifica builder_code is attached ONLY when the caller passes one (builder fees are
 * opt-in: settings builder.pacifica + confirmed approval, decided by the adapter —
 * src/exchanges/builder-fee.ts). There is no embedded default code any more.
 * When passed, it rides on every order-creation endpoint (builder-program docs:
 * create_market / create / stop/create / positions/tpsl). TWAP documents none → never sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PacificaClient } from "../../pacifica/client.js";
import * as constants from "../../pacifica/constants.js";

const BUILDER = "BUILDERCODE1";

function makeClient() {
  const client = new PacificaClient({ network: "mainnet" });
  const post = vi.fn().mockResolvedValue({ success: true });
  (client as unknown as { post: unknown }).post = post;
  // signedBody hands the payload straight through to post(); capture what it built.
  (client as unknown as { signedBody: unknown }).signedBody = vi.fn(
    async (type: string, payload: Record<string, unknown>) => ({ type, ...payload }),
  );
  return { client, post };
}

const sign = async () => new Uint8Array(64);

describe("Pacifica builder_code — explicit per call, never defaulted", () => {
  let client: PacificaClient;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, post } = makeClient());
  });

  const calls: Array<[string, string, (c: PacificaClient, code: string | null) => Promise<unknown>]> = [
    ["createMarketOrder", "/orders/create_market", (c, code) => c.createMarketOrder({ symbol: "BTC" } as never, "acct", sign, code)],
    ["createLimitOrder", "/orders/create", (c, code) => c.createLimitOrder({ symbol: "BTC" } as never, "acct", sign, code)],
    ["createStopOrder", "/orders/stop/create", (c, code) => c.createStopOrder({ symbol: "BTC" } as never, "acct", sign, code)],
    ["setTPSL", "/positions/tpsl", (c, code) => c.setTPSL({ symbol: "BTC" } as never, "acct", sign, code)],
  ];

  it("createTWAP never carries builder_code (create_twap_order documents none)", async () => {
    await client.createTWAP({ symbol: "BTC" } as never, "acct", sign);
    expect(post.mock.calls[0][0]).toBe("/orders/twap/create");
    expect("builder_code" in post.mock.calls[0][1]).toBe(false);
  });

  it.each(calls)("%s carries builder_code when one is passed", async (_n, path, call) => {
    await call(client, BUILDER);
    expect(post.mock.calls[0][0]).toBe(path);
    expect(post.mock.calls[0][1].builder_code).toBe(BUILDER);
  });

  it.each(calls)("%s sends NO builder_code when null is passed (default off)", async (_n, _path, call) => {
    await call(client, null);
    expect("builder_code" in post.mock.calls[0][1]).toBe(false);
  });

  it("there is no embedded default builder code (the former PERPCLI constant is gone)", () => {
    expect("BUILDER_CODE" in constants).toBe(false);
  });
});
