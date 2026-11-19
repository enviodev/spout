import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

// Envio's chain id for Solana devnet (`id: solana-devnet` in config.yaml).
const DEVNET = 7565165;
// Spout's devnet USDC mint.
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Real devnet instructions, captured from HyperSync (test/fixtures.json).
// Expected values come from the programs' own logs for the same transactions.
type Fixture = {
  program: string;
  instruction: string;
  slot: number;
  time: number;
  path: number[];
  signature: string;
  accounts: string[];
  args?: Record<string, string | boolean>;
  data?: string;
  logs?: { kind: string; message: string }[];
  activities?: { address: string; pre: string; post: string }[];
};
const fixtures: Record<string, Fixture[]> = JSON.parse(
  readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

const item = (f: Fixture) => ({
  program: f.program,
  instruction: f.instruction,
  slot: f.slot,
  path: f.path,
  accountArguments: f.accounts,
  ...(f.args && {
    args: Object.fromEntries(
      Object.entries(f.args).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v]),
    ),
  }),
  ...(f.data && { data: Uint8Array.from(Buffer.from(f.data, "hex")) }),
  ...(f.logs && { logs: f.logs }),
  block: { time: f.time },
  transaction: {
    signature: f.signature,
    success: true,
    ...(f.activities && {
      accountActivities: f.activities.map((a) => ({
        address: a.address,
        token: { mint: USDC, owner: a.address, decimals: 6, preAmount: BigInt(a.pre), postAmount: BigInt(a.post) },
      })),
    }),
  },
});

const run = async (...names: string[]) => {
  const indexer = createTestIndexer();
  const simulate = names.flatMap((n) => fixtures[n]!.map(item)) as never[];
  await indexer.process({ chains: { [DEVNET]: { simulate } } });
  return indexer;
};

describe("Spout handlers", () => {
  it("opens a vault, posts collateral, borrows and repays", async (t) => {
    const indexer = await run("vault");
    const VAULT = "2dkr8L8hgnhrkJhuqY9SwY1Syx2VDu3QagxJWzrFA3q8";
    const OWNER = "3C6DqYJtehNVCoXAY39KyRdGViV8oxS5Wr3NrJKFPX6A";
    const IBIT = "9HfMBSLn26e7ZTDjjGRBVuF2wfEFoQeqCPMqz6ZK6PyH";

    // Program log on the repay: "Repaid 20000000 stablecoins", "Vault debt: 0".
    t.expect(await indexer.Vault.getOrThrow(VAULT)).toMatchObject({
      owner_id: OWNER,
      asset_id: IBIT,
      collateral: 3_213_728_191n,
      debt: 0n,
      totalBorrowed: 20_000_000n,
      totalRepaid: 20_000_000n,
      status: "ACTIVE",
    });
    t.expect(await indexer.Asset.getOrThrow(IBIT)).toMatchObject({
      collateral: 3_213_728_191n,
      debtOutstanding: 0n,
      vaultCount: 1,
    });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({
      vaultCount: 1,
      borrowerCount: 1,
      openLoanCount: 0,
      debtOutstanding: 0n,
      totalBorrowed: 20_000_000n,
      totalRepaid: 20_000_000n,
    });
    const actions = await indexer.VaultAction.getAll();
    t.expect(actions.map((a) => a.kind).sort()).toEqual(["BORROW", "DEPOSIT", "REPAY"]);
    t.expect(actions.find((a) => a.kind === "BORROW")).toMatchObject({ amount: 20_000_000n, debtAfter: 20_000_000n });
  });

  it("reads the original 17-account vault layout", async (t) => {
    const indexer = await run("vaultLegacy");
    // Program log: "Vault initialized for user J5SS8K…", "Vault debt: 1000000".
    t.expect(await indexer.Vault.getOrThrow("2Hpy3ejM35o2G9oJd6n68rRKdphvDCcviAy1KYULJXMF")).toMatchObject({
      owner_id: "J5SS8KD7jMoEdcmZ75a5DsQQEivaZLmp5LgvrcPRvAB6",
      asset_id: "6a2yZjSpCncEyiPrB3ifnAJdqJVUNymu7vEvLCaySqmp",
      collateral: 29_581_593n,
      debt: 1_000_000n,
    });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({ openLoanCount: 1, debtOutstanding: 1_000_000n });
  });

  it("fills a buy order and prices the asset from it", async (t) => {
    const indexer = await run("buy");
    // Program log: "Buy order fulfilled: … order_id=2170064843612815884361298362089268824, asset_minted=59608269".
    const order = await indexer.Order.getOrThrow("EcswTGaAGQxUtEC84XdtQdKH5V5wxjodr5hzJqsAXKkq");
    t.expect(order).toMatchObject({
      orderId: 2170064843612815884361298362089268824n,
      account_id: "6ipBypumqXAxaYGUGG5m9yxYmgfWTrMZWzsPPbBFz6PS",
      ticker: "NVDA",
      side: "BUY",
      status: "FILLED",
      amountIn: 9_000_000n,
      amountOut: 59_608_269n,
    });
    t.expect(order.price).toBeCloseTo(150.9858, 3);
    t.expect(await indexer.Asset.getOrThrow(order.asset_id)).toMatchObject({ symbol: "NVDA", buyVolume: 9_000_000n });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({
      orderCount: 1,
      filledOrderCount: 1,
      buyVolume: 9_000_000n,
    });
  });

  it("fills a sell order", async (t) => {
    const indexer = await run("sell");
    // Program log: "Sell order fulfilled: … usdc_paid=2819000".
    t.expect(await indexer.Order.getOrThrow("7TLbDKF2XT8TVmpc8WDSU8MZFiSonCZCgmLWMeygDKaW")).toMatchObject({
      ticker: "PFE",
      side: "SELL",
      status: "FILLED",
      amountIn: 100_000_000n,
      amountOut: 2_819_000n,
    });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({ sellVolume: 2_819_000n, buyVolume: 0n });
  });

  it("reads shares and pool assets from the lender events", async (t) => {
    const indexer = await run("withdraw", "deposit");
    const LENDER = "6AdpLmuZJWFKVwBTZv6txUMFaFWeRoBUq48MHBrA9zSU";

    // 10 USDC into the junior tranche minted 2.838837 shares.
    t.expect(await indexer.Account.getOrThrow(LENDER)).toMatchObject({
      lpDeposited: 10_000_000n,
      juniorShares: 2_838_837n,
      seniorShares: 0n,
    });
    t.expect(await indexer.TrancheStat.getOrThrow("JUNIOR")).toMatchObject({
      shareMint: "66AiVkkptgBqk8frWdsbAPo2QchzMLw2dz5UDajD1VyJ",
      deposited: 10_000_000n,
      depositCount: 1,
    });
    // 100 senior shares redeemed for 100.002647 USDC.
    t.expect(await indexer.TrancheStat.getOrThrow("SENIOR")).toMatchObject({ withdrawn: 100_002_647n, withdrawCount: 1 });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({
      lpDeposited: 10_000_000n,
      lpWithdrawn: 100_002_647n,
      lenderCount: 1,
    });
  });

  it("splits a premium distribution between lenders and the reserve", async (t) => {
    const indexer = await run("yield");
    const [distribution] = await indexer.YieldDistribution.getAll();
    t.expect(distribution).toMatchObject({
      cycle: 9,
      source: "OPTION_PREMIUM",
      toLenders: 206_400_000n,
      toReserve: 25_800_000n,
    });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({ yieldToLenders: 206_400_000n });
  });

  it("links a KYC identity to its wallet and marks it verified", async (t) => {
    const indexer = await run("kyc");
    t.expect(await indexer.Account.getOrThrow("DEEJUWpfnoaBapaBRctjDwB4HqVJqVaY3N6sQbdem5Kp")).toMatchObject({
      identity: "8NnJgXKYa4DQoytFJwQ4BBhQiuu8Tc5g4rCHJ8xeZ45n",
      verified: true,
    });
    t.expect(await indexer.Protocol.getOrThrow("spout")).toMatchObject({ identityCount: 1, verifiedCount: 1 });
  });
});
