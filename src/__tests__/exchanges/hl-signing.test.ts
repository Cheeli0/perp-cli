/**
 * Hyperliquid signing vs hyperliquid-python-sdk (2fdb18f) `utils/signing.py`.
 *
 * Vectors marked [sdk-test] are copied from the python SDK's tests/signing_test.py.
 * Vectors marked [derived] were produced by running the python SDK's own
 * sign_l1_action / sign_*_action on the same key and inputs (exchange.py action
 * shapes: update_leverage, update_isolated_margin, usd_class_transfer,
 * token_delegate, approve_builder_fee, plus the agentSendAsset action from the
 * exchange-endpoint docs). Key: 0x0123…0123 (python SDK test key).
 */
import { describe, it, expect } from "vitest";
import { LocalEvmSigner } from "../../signer/index.js";
import {
  buildHlUserSignedAction,
  hlL1ActionHash,
  hlUserSignedTypedData,
  signHlL1Action,
  signHlUserSignedAction,
  type HlSignature,
} from "../../exchanges/hl-signing.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const DEST = "0x5e9ee1089755c3435139848e47e6635505d5a13a";

/** python `to_hex` drops leading zeros of r/s — compare as integers. */
function expectSig(got: HlSignature, want: { r: string; s: string; v: number }) {
  expect(BigInt(got.r)).toBe(BigInt(want.r));
  expect(BigInt(got.s)).toBe(BigInt(want.s));
  expect(got.v).toBe(want.v);
}

const signer = () => LocalEvmSigner.create(KEY);

describe("L1 action signing (phantom agent) — python SDK vectors", () => {
  it("[sdk-test] dummy action, mainnet + testnet", async () => {
    const s = await signer();
    const action = { type: "dummy", num: 100000000000 }; // float_to_int_for_hashing(1000)
    expectSig(await signHlL1Action(s, action, 0, true), {
      r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      v: 27,
    });
    expectSig(await signHlL1Action(s, action, 0, false), {
      r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      v: 28,
    });
  });

  it("[sdk-test] order action (asset 1, Gtc)", async () => {
    const s = await signer();
    const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    expectSig(await signHlL1Action(s, action, 0, true), {
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      v: 28,
    });
  });

  it("[sdk-test] phantom agent connectionId for an IOC order", async () => {
    const action = { type: "order", orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
    expect(await hlL1ActionHash(action, 1677777606040, null, null))
      .toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  it("[sdk-test] vault address flag", async () => {
    const s = await signer();
    const action = { type: "dummy", num: 100000000000 };
    expectSig(await signHlL1Action(s, action, 0, true, "0x1719884eb866cb12b2287399b15f7db5e7d775ea"), {
      r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
      s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c",
      v: 28,
    });
  });

  it("[derived] vault + expiresAfter", async () => {
    const s = await signer();
    const action = { type: "dummy", num: 100000000000 };
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expect(await hlL1ActionHash(action, 0, vault, 1700000099999))
      .toBe("0x6c5ac759414c3ad39b525cb608e36244b705ccdc7d67ccd30c29ef1af36306a5");
    expectSig(await signHlL1Action(s, action, 0, true, vault, 1700000099999), {
      r: "0xe7ed9856a43540a261984c0f6df188222fe88a6d164772d1dcf78f7715d691f0",
      s: "0x3af35d6d2aa88e50bcdbd31944361a6a1d33168c39bdfc6dbff716b21fa6aef8",
      v: 28,
    });
  });

  it("[sdk-test] createSubAccount / scheduleCancel", async () => {
    const s = await signer();
    expectSig(await signHlL1Action(s, { type: "createSubAccount", name: "example" }, 0, false), {
      r: "0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b",
      s: "0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584",
      v: 28,
    });
    expectSig(await signHlL1Action(s, { type: "scheduleCancel", time: 123456789 }, 0, true), {
      r: "0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55",
      s: "0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b",
      v: 28,
    });
  });

  it("[derived] updateLeverage", async () => {
    const s = await signer();
    const action = { type: "updateLeverage", asset: 1, isCross: true, leverage: 5 };
    expect(await hlL1ActionHash(action, 1700000000000, null, null))
      .toBe("0xabcd0030f6e652ed0f555bc4149c09afb584e3f03d6638664ebc7cdc08f8f890");
    expectSig(await signHlL1Action(s, action, 1700000000000, false), {
      r: "0xe43f444a04f0535cc3af3786b85de1cde9ba4c52a2e68cf6889d053ca0e214d4",
      s: "0x3959216832fce48225f7eeed11bd4e56f0a83e67e7072fad4e50e77d725f8bb7",
      v: 27,
    });
  });

  it("[derived] updateIsolatedMargin: isBuy always true, signed ntli (remove = negative)", async () => {
    const s = await signer();
    const remove = { type: "updateIsolatedMargin", asset: 1, isBuy: true, ntli: -2500000 };
    expect(await hlL1ActionHash(remove, 1700000000001, null, null))
      .toBe("0x3a7d0b44dc307ff7bea79f176ca3124d4e5d9cf132c174c25e3c115c7808a914");
    expectSig(await signHlL1Action(s, remove, 1700000000001, false), {
      r: "0x49036c76cfee788ebc6a8354a42d173c8785ed927cfbe1f7a79abac8b92dbbdb",
      s: "0x1d4ec9eeb959a93c11a5f8124e8113dad8329f481ff7f1d9547e1bb1a66d93bb",
      v: 27,
    });
    const add = { type: "updateIsolatedMargin", asset: 1, isBuy: true, ntli: 2500000 };
    expect(await hlL1ActionHash(add, 1700000000002, null, null))
      .toBe("0x6b14d8563523880fc55bbd5ca3c487c3ddf3fe5787d4493de9d210f41787b10b");
  });

  it("[derived] agentSendAsset (spot → default perp dex)", async () => {
    const s = await signer();
    const nonce = 1700000000003;
    const action = {
      type: "agentSendAsset", destination: DEST, sourceDex: "spot", destinationDex: "",
      token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "12.5", fromSubAccount: "", nonce,
    };
    expect(await hlL1ActionHash(action, nonce, null, null))
      .toBe("0xfceb3ef8c33e340915c792805f851f867f95783e08d8347bd658cd3f396375dc");
    expectSig(await signHlL1Action(s, action, nonce, false), {
      r: "0x7458b22ed74196750bfddcc08f905e0d06a52de4e585090dc0a121ac2a9846aa",
      s: "0x31344de51b1119b016d7e3e69a7034ade198223b91e5df57f483654c8f4691d2",
      v: 28,
    });
  });
});

describe("user-signed actions (HyperliquidSignTransaction) — python SDK vectors (testnet, 0x66eee)", () => {
  it("[sdk-test] usdSend", async () => {
    const action = buildHlUserSignedAction("usdSend", "testnet", { destination: DEST, amount: "1", time: 1687816341423 });
    expect(action).toEqual({ type: "usdSend", signatureChainId: "0x66eee", hyperliquidChain: "Testnet", destination: DEST, amount: "1", time: 1687816341423 });
    expectSig(await signHlUserSignedAction(await signer(), action), {
      r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      v: 27,
    });
  });

  it("[sdk-test] withdraw3", async () => {
    const action = buildHlUserSignedAction("withdraw3", "testnet", { destination: DEST, amount: "1", time: 1687816341423 });
    const td = hlUserSignedTypedData(action);
    expect(td.domain).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(Object.keys(td.types)).toEqual(["HyperliquidTransaction:Withdraw"]);
    expectSig(await signHlUserSignedAction(await signer(), action), {
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      v: 28,
    });
  });

  it("[derived] usdClassTransfer", async () => {
    const action = buildHlUserSignedAction("usdClassTransfer", "testnet", { amount: "12.5", toPerp: true, nonce: 1700000000004 });
    expect(hlUserSignedTypedData(action).message).toEqual({ hyperliquidChain: "Testnet", amount: "12.5", toPerp: true, nonce: 1700000000004 });
    expectSig(await signHlUserSignedAction(await signer(), action), {
      r: "0x575c3ae4de134dec41ae41a1eccad5cacda33c5dcd87db90f391573546243478",
      s: "0x4b5d599b84be321bf61ee7a30948a266dd86942878f4f01527fe5ca12dc5faf3",
      v: 28,
    });
  });

  it("[derived] tokenDelegate", async () => {
    const action = buildHlUserSignedAction("tokenDelegate", "testnet", { validator: DEST, wei: 100000000, isUndelegate: false, nonce: 1700000000005 });
    expectSig(await signHlUserSignedAction(await signer(), action), {
      r: "0xaa51c8f75b71b1f0a00bcae740f9503af24d2f726943cfe1c1a712905dc0a6f8",
      s: "0xdaaf65669db80096c363839584d678ec6b099cc37659eadb306a123236c572d",
      v: 27,
    });
  });

  it("[derived] approveBuilderFee", async () => {
    const action = buildHlUserSignedAction("approveBuilderFee", "testnet", { maxFeeRate: "0.01%", builder: DEST, nonce: 1700000000006 });
    expectSig(await signHlUserSignedAction(await signer(), action), {
      r: "0x4a8e8c5b5e81681a822ea34fe9df8ee32ab59f10675ae8049dd758f29d1c60f",
      s: "0x7b0e1d53512f1e3d47c982bf48fa01cedb48469e644e26896587125754d3b30f",
      v: 27,
    });
  });

  it("mainnet uses HL_USER_SIGNED (Mainnet / 0xa4b1 → chainId 42161)", () => {
    const action = buildHlUserSignedAction("usdSend", "mainnet", { destination: DEST, amount: "1", time: 1 });
    expect(action.hyperliquidChain).toBe("Mainnet");
    expect(action.signatureChainId).toBe("0xa4b1");
    expect(hlUserSignedTypedData(action).domain.chainId).toBe(42161);
  });

  it("missing field → INVALID_PARAMS (never signs a partial message)", () => {
    const action = buildHlUserSignedAction("usdClassTransfer", "testnet", { amount: "1", toPerp: true });
    expect(() => hlUserSignedTypedData(action)).toThrow(/missing field nonce/);
  });
});
