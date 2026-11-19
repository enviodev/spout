/*
 * Spout Finance (spout.finance) on Solana devnet.
 *
 *   Vault      borrow USDC at 0% against tokenized stocks; lenders fund a
 *              senior / junior pool and are paid from covered-call premium
 *   Orders     KYC-gated buy and sell orders for the tokenized stocks
 *   OnchainId  the KYC identity each wallet needs before it can hold them
 *
 * Units: USDC in raw atoms (6 decimals), stock tokens in raw atoms (9 decimals).
 */
import {
  indexer,
  type Account,
  type Asset,
  type DailyStat,
  type Protocol,
  type SvmOnSlotContext,
  type TrancheStat,
  type Vault,
} from "envio";
import * as layout from "./layout.js";

type Ctx = SvmOnSlotContext;

const PROTOCOL_ID = "spout";
const DAY = 86_400;
const USDC_DECIMALS = 6;
const STOCK_DECIMALS = 9;

/** Anchor event discriminators (the first 8 bytes of a `Program data:` log). */
const EVENT_LIQUIDITY_DEPOSITED = "da9b4ac13b425e7a";
const EVENT_LIQUIDITY_WITHDRAWN = "f078498b9a1fda44";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const u64 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
const u128 = (b: Uint8Array, at: number) => u64(b, at) | (u64(b, at + 8) << 64n);

/** USDC per whole stock token. */
export const price = (usdc: bigint, stock: bigint) =>
  stock === 0n ? undefined : (Number(usdc) / 10 ** USDC_DECIMALS) / (Number(stock) / 10 ** STOCK_DECIMALS);

const actionId = (signature: string, path: readonly number[]) => `${signature}-${path.join(".")}`;

/** Finds an Anchor event among an instruction's logs and returns its body. */
function findEvent(logs: readonly { kind: string; message: string }[], discriminator: string) {
  for (const log of logs) {
    if (log.kind !== "data") continue;
    const bytes = Buffer.from(log.message, "base64");
    if (bytes.subarray(0, 8).toString("hex") === discriminator) return bytes;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entity defaults
// ---------------------------------------------------------------------------

async function getProtocol(context: Ctx): Promise<Protocol> {
  return (
    (await context.Protocol.get(PROTOCOL_ID)) ?? {
      id: PROTOCOL_ID,
      debtOutstanding: 0n,
      totalBorrowed: 0n,
      totalRepaid: 0n,
      vaultCount: 0,
      openLoanCount: 0,
      borrowerCount: 0,
      liquidationCount: 0,
      poolAssets: 0n,
      lpDeposited: 0n,
      lpWithdrawn: 0n,
      lenderCount: 0,
      yieldToLenders: 0n,
      identityCount: 0,
      verifiedCount: 0,
      orderCount: 0,
      filledOrderCount: 0,
      buyVolume: 0n,
      sellVolume: 0n,
      lastSlot: 0,
      lastTime: 0,
    }
  );
}

async function getAccount(context: Ctx, id: string, time: number): Promise<Account> {
  return (
    (await context.Account.get(id)) ?? {
      id,
      identity: undefined,
      verified: false,
      vaultCount: 0,
      debt: 0n,
      totalBorrowed: 0n,
      totalRepaid: 0n,
      lpDeposited: 0n,
      lpWithdrawn: 0n,
      seniorShares: 0n,
      juniorShares: 0n,
      orderCount: 0,
      buyVolume: 0n,
      sellVolume: 0n,
      firstSeen: time,
    }
  );
}

async function getAsset(context: Ctx, id: string): Promise<Asset> {
  return (
    (await context.Asset.get(id)) ?? {
      id,
      symbol: undefined,
      collateral: 0n,
      debtOutstanding: 0n,
      totalBorrowed: 0n,
      vaultCount: 0,
      orderCount: 0,
      buyVolume: 0n,
      sellVolume: 0n,
      lastPrice: undefined,
      lastPriceTime: undefined,
    }
  );
}

async function getDay(context: Ctx, time: number): Promise<DailyStat> {
  const day = Math.floor(time / DAY);
  return (
    (await context.DailyStat.get(String(day))) ?? {
      id: String(day),
      date: day * DAY,
      borrowed: 0n,
      repaid: 0n,
      lpDeposited: 0n,
      lpWithdrawn: 0n,
      buyVolume: 0n,
      sellVolume: 0n,
      ordersPlaced: 0,
      vaultsOpened: 0,
      usersVerified: 0,
      debtOutstanding: 0n,
      poolAssets: 0n,
    }
  );
}

/** Writes the protocol row and the day bucket, stamping both with the protocol's closing values. */
function commit(context: Ctx, protocol: Protocol, day: DailyStat, slot: number, time: number) {
  context.Protocol.set({ ...protocol, lastSlot: slot, lastTime: time });
  context.DailyStat.set({ ...day, debtOutstanding: protocol.debtOutstanding, poolAssets: protocol.poolAssets });
}

/**
 * Loads a vault, creating it when this is the first time it is seen. Returns
 * what changed so the caller can fold it into the same writes.
 */
async function openVault(
  context: Ctx,
  ids: { vault: string; user: string; collateralType: string; mint?: string },
  time: number,
) {
  const existing = await context.Vault.get(ids.vault);
  if (existing) return { vault: existing, created: false };
  const vault: Vault = {
    id: ids.vault,
    owner_id: ids.user,
    asset_id: ids.mint,
    collateralType: ids.collateralType,
    collateral: 0n,
    debt: 0n,
    totalBorrowed: 0n,
    totalRepaid: 0n,
    status: "ACTIVE",
    openedAt: time,
    updatedAt: time,
  };
  return { vault, created: true };
}

// ---------------------------------------------------------------------------
// Vault: borrowers
// ---------------------------------------------------------------------------

const fields = {
  instruction: ["args", "accountArguments", "path"],
  transaction: ["signature", "success"],
  block: ["time"],
} as const;

indexer.onInstruction(
  { program: "Vault", instruction: "initialize_vault", fields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.initializeVault(instruction.accountArguments);
    const { slot, time } = instruction.block;

    const { vault, created } = await openVault(context, ids, time);
    if (!created) return;
    const [protocol, account, day] = await Promise.all([
      getProtocol(context),
      getAccount(context, ids.user, time),
      getDay(context, time),
    ]);

    context.Vault.set(vault);
    context.Account.set({ ...account, vaultCount: account.vaultCount + 1 });
    if (ids.mint) {
      const asset = await getAsset(context, ids.mint);
      context.Asset.set({ ...asset, vaultCount: asset.vaultCount + 1 });
    }
    commit(
      context,
      {
        ...protocol,
        vaultCount: protocol.vaultCount + 1,
        borrowerCount: protocol.borrowerCount + (account.vaultCount === 0 ? 1 : 0),
      },
      { ...day, vaultsOpened: day.vaultsOpened + 1 },
      slot,
      time,
    );
  },
);

for (const [name, kind] of [
  ["deposit_collateral", "DEPOSIT"],
  ["top_up_collateral", "TOP_UP"],
] as const) {
  indexer.onInstruction({ program: "Vault", instruction: name, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const accounts = instruction.accountArguments;
    const ids = { ...layout.vaultCall(accounts), mint: layout.collateralMint(accounts) };
    const { slot, time } = instruction.block;
    const amount = instruction.args.amount;

    const [{ vault }, asset] = await Promise.all([openVault(context, ids, time), getAsset(context, ids.mint)]);
    // A vault opened under the current layout learns its mint from its first deposit.
    const firstDeposit = vault.asset_id === undefined;

    context.Vault.set({
      ...vault,
      asset_id: ids.mint,
      collateral: vault.collateral + amount,
      // A settled vault is the same account; posting collateral again reopens it.
      status: vault.status === "SETTLED" ? "ACTIVE" : vault.status,
      updatedAt: time,
    });
    context.Asset.set({
      ...asset,
      collateral: asset.collateral + amount,
      vaultCount: asset.vaultCount + (firstDeposit ? 1 : 0),
    });
    context.VaultAction.set({
      id: actionId(instruction.transaction.signature, instruction.path),
      vault_id: vault.id,
      account_id: vault.owner_id,
      asset_id: ids.mint,
      kind,
      amount,
      debtAfter: vault.debt,
      slot,
      time,
      txSignature: instruction.transaction.signature,
    });
  });
}

for (const [name, kind] of [
  ["borrow_stablecoin", "BORROW"],
  ["repay_debt", "REPAY"],
] as const) {
  indexer.onInstruction({ program: "Vault", instruction: name, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.vaultCall(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const amount = instruction.args.amount;
    const borrowed = kind === "BORROW" ? amount : 0n;
    const repaid = kind === "REPAY" ? amount : 0n;

    const { vault } = await openVault(context, ids, time);
    const [protocol, account, day, asset] = await Promise.all([
      getProtocol(context),
      getAccount(context, vault.owner_id, time),
      getDay(context, time),
      vault.asset_id ? getAsset(context, vault.asset_id) : undefined,
    ]);
    const debt = vault.debt + borrowed - repaid;
    const opened = vault.debt === 0n && debt > 0n ? 1 : 0;
    const closed = vault.debt > 0n && debt === 0n ? 1 : 0;

    context.Vault.set({
      ...vault,
      debt,
      totalBorrowed: vault.totalBorrowed + borrowed,
      totalRepaid: vault.totalRepaid + repaid,
      updatedAt: time,
    });
    context.Account.set({
      ...account,
      debt: account.debt + borrowed - repaid,
      totalBorrowed: account.totalBorrowed + borrowed,
      totalRepaid: account.totalRepaid + repaid,
    });
    if (asset) {
      context.Asset.set({
        ...asset,
        debtOutstanding: asset.debtOutstanding + borrowed - repaid,
        totalBorrowed: asset.totalBorrowed + borrowed,
      });
    }
    context.VaultAction.set({
      id: actionId(instruction.transaction.signature, instruction.path),
      vault_id: vault.id,
      account_id: vault.owner_id,
      asset_id: vault.asset_id,
      kind,
      amount,
      debtAfter: debt,
      slot,
      time,
      txSignature: instruction.transaction.signature,
    });
    commit(
      context,
      {
        ...protocol,
        debtOutstanding: protocol.debtOutstanding + borrowed - repaid,
        totalBorrowed: protocol.totalBorrowed + borrowed,
        totalRepaid: protocol.totalRepaid + repaid,
        openLoanCount: protocol.openLoanCount + opened - closed,
      },
      { ...day, borrowed: day.borrowed + borrowed, repaid: day.repaid + repaid },
      slot,
      time,
    );
  });
}

// ---------------------------------------------------------------------------
// Vault: liquidations
// ---------------------------------------------------------------------------

indexer.onInstruction(
  {
    program: "Vault",
    instruction: "seize_collateral",
    fields: { instruction: ["accountArguments", "path"], transaction: ["signature", "success"], block: ["time"] },
  },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.liquidation(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const vault = await context.Vault.get(ids.vault);
    if (!vault) return;

    context.Vault.set({ ...vault, status: "FROZEN", updatedAt: time });
    context.VaultAction.set({
      id: actionId(instruction.transaction.signature, instruction.path),
      vault_id: vault.id,
      account_id: vault.owner_id,
      asset_id: vault.asset_id,
      kind: "SEIZE",
      amount: 0n,
      debtAfter: vault.debt,
      slot,
      time,
      txSignature: instruction.transaction.signature,
    });
  },
);

indexer.onInstruction(
  { program: "Vault", instruction: "settle_liquidation_downside", fields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.liquidation(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const vault = await context.Vault.get(ids.vault);
    if (!vault) return;

    const [protocol, account, day, asset] = await Promise.all([
      getProtocol(context),
      getAccount(context, vault.owner_id, time),
      getDay(context, time),
      vault.asset_id ? getAsset(context, vault.asset_id) : undefined,
    ]);

    // The collateral is sold and the sale clears the vault's debt.
    context.Vault.set({ ...vault, status: "SETTLED", collateral: 0n, debt: 0n, updatedAt: time });
    context.Account.set({ ...account, debt: account.debt - vault.debt });
    if (asset) {
      context.Asset.set({
        ...asset,
        collateral: asset.collateral - vault.collateral,
        debtOutstanding: asset.debtOutstanding - vault.debt,
      });
    }
    context.VaultAction.set({
      id: actionId(instruction.transaction.signature, instruction.path),
      vault_id: vault.id,
      account_id: vault.owner_id,
      asset_id: vault.asset_id,
      kind: "SETTLE",
      amount: instruction.args.proceeds,
      debtAfter: 0n,
      slot,
      time,
      txSignature: instruction.transaction.signature,
    });
    commit(
      context,
      {
        ...protocol,
        debtOutstanding: protocol.debtOutstanding - vault.debt,
        openLoanCount: protocol.openLoanCount - (vault.debt > 0n ? 1 : 0),
        liquidationCount: protocol.liquidationCount + 1,
      },
      day,
      slot,
      time,
    );
  },
);

// ---------------------------------------------------------------------------
// Vault: lenders
// ---------------------------------------------------------------------------

const rawFields = {
  instruction: ["data", "accountArguments", "path"],
  transaction: ["signature", "success"],
  block: ["time"],
  log: ["kind", "message"],
} as const;

/** Instruction data is `discriminator(8) amount(8) limit(8) reserved(8) [tranche(1)]`. */
const trancheOf = (data: Uint8Array) => (data.length > 32 && data[32] === 1 ? "JUNIOR" : "SENIOR");

function trancheDefaults(tranche: "SENIOR" | "JUNIOR", shareMint: string): TrancheStat {
  return {
    id: tranche,
    tranche,
    shareMint,
    deposited: 0n,
    withdrawn: 0n,
    shares: 0n,
    sharePrice: undefined,
    depositCount: 0,
    withdrawCount: 0,
  };
}

for (const kind of ["DEPOSIT", "WITHDRAW"] as const) {
  indexer.onInstruction(
    {
      program: "Vault",
      instruction: kind === "DEPOSIT" ? "deposit_liquidity" : "withdraw_liquidity",
      fields: rawFields,
    },
    async ({ instruction, context }) => {
      if (!instruction.transaction.success) return;
      const ids = layout.liquidity(instruction.accountArguments);
      const { slot, time } = instruction.block;
      const data = instruction.data;
      const tranche = trancheOf(data);
      const amount = u64(data, 8);

      // The instruction carries what goes in (USDC on deposit, shares on
      // withdrawal); the program's event carries what comes out, plus the
      // tranche's share supply and the pool's assets afterwards.
      let usdc: bigint;
      let shares: bigint;
      let supply: bigint | undefined;
      let poolAssets: bigint | undefined;
      if (kind === "DEPOSIT") {
        const event = findEvent(instruction.logs, EVENT_LIQUIDITY_DEPOSITED);
        usdc = amount;
        shares = event ? u128(event, 48) : amount;
        supply = event && u128(event, 64);
        poolAssets = event && u128(event, 80);
      } else {
        const event = findEvent(instruction.logs, EVENT_LIQUIDITY_WITHDRAWN);
        if (!event) context.log.warn(`withdraw_liquidity without its event in ${instruction.transaction.signature}`);
        shares = amount;
        usdc = event ? u128(event, 56) : 0n;
        supply = event && u128(event, 72);
        poolAssets = event && u128(event, 88);
      }
      const deposited = kind === "DEPOSIT" ? usdc : 0n;
      const withdrawn = kind === "WITHDRAW" ? usdc : 0n;
      const shareDelta = kind === "DEPOSIT" ? shares : -shares;

      const [protocol, account, day, stat] = await Promise.all([
        getProtocol(context),
        getAccount(context, ids.user, time),
        getDay(context, time),
        context.TrancheStat.get(tranche),
      ]);
      const current = stat ?? trancheDefaults(tranche, ids.shareMint);
      const isNewLender = account.lpDeposited === 0n && deposited > 0n;

      context.TrancheStat.set({
        ...current,
        shareMint: ids.shareMint,
        deposited: current.deposited + deposited,
        withdrawn: current.withdrawn + withdrawn,
        shares: supply ?? current.shares + shareDelta,
        sharePrice: shares === 0n ? current.sharePrice : Number(usdc) / Number(shares),
        depositCount: current.depositCount + (kind === "DEPOSIT" ? 1 : 0),
        withdrawCount: current.withdrawCount + (kind === "WITHDRAW" ? 1 : 0),
      });
      context.Account.set({
        ...account,
        lpDeposited: account.lpDeposited + deposited,
        lpWithdrawn: account.lpWithdrawn + withdrawn,
        seniorShares: account.seniorShares + (tranche === "SENIOR" ? shareDelta : 0n),
        juniorShares: account.juniorShares + (tranche === "JUNIOR" ? shareDelta : 0n),
      });
      context.LiquidityAction.set({
        id: actionId(instruction.transaction.signature, instruction.path),
        account_id: ids.user,
        kind,
        tranche,
        usdc,
        shares,
        slot,
        time,
        txSignature: instruction.transaction.signature,
      });
      commit(
        context,
        {
          ...protocol,
          poolAssets: poolAssets ?? protocol.poolAssets + deposited - withdrawn,
          lpDeposited: protocol.lpDeposited + deposited,
          lpWithdrawn: protocol.lpWithdrawn + withdrawn,
          lenderCount: protocol.lenderCount + (isNewLender ? 1 : 0),
        },
        { ...day, lpDeposited: day.lpDeposited + deposited, lpWithdrawn: day.lpWithdrawn + withdrawn },
        slot,
        time,
      );
    },
  );
}

indexer.onInstruction(
  {
    program: "Vault",
    instruction: "distribute_yield",
    fields: {
      instruction: ["data", "accountArguments", "path"],
      transaction: ["signature", "success"],
      block: ["time"],
      accountActivity: ["address", "token.preAmount", "token.postAmount"],
    },
  },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.yieldAccounts(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const data = instruction.data;

    // What each side received is read from the USDC accounts' balance change.
    const received = (address: string) => {
      const token = instruction.transaction.accountActivities.find((a) => a.address === address)?.token;
      const delta = (token?.postAmount ?? 0n) - (token?.preAmount ?? 0n);
      return delta > 0n ? delta : 0n;
    };
    const toLenders = received(ids.pool);
    const toReserve = ids.reserve === ids.source ? 0n : received(ids.reserve);

    const [protocol, day] = await Promise.all([getProtocol(context), getDay(context, time)]);
    context.YieldDistribution.set({
      id: actionId(instruction.transaction.signature, instruction.path),
      cycle: Number(u64(data, 8)),
      source: data[16] === 1 ? "OPTION_PREMIUM" : "TBILL",
      toLenders,
      toReserve,
      slot,
      time,
      txSignature: instruction.transaction.signature,
    });
    commit(
      context,
      {
        ...protocol,
        yieldToLenders: protocol.yieldToLenders + toLenders,
        poolAssets: protocol.poolAssets + toLenders,
      },
      day,
      slot,
      time,
    );
  },
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

for (const side of ["BUY", "SELL"] as const) {
  indexer.onInstruction(
    { program: "Orders", instruction: side === "BUY" ? "place_buy_order" : "place_sell_order", fields },
    async ({ instruction, context }) => {
      if (!instruction.transaction.success) return;
      const accounts = instruction.accountArguments;
      const ids = side === "BUY" ? layout.placeBuyOrder(accounts) : layout.placeSellOrder(accounts);
      const { slot, time } = instruction.block;
      const args = instruction.args;

      const [protocol, account, day, asset] = await Promise.all([
        getProtocol(context),
        getAccount(context, ids.user, time),
        getDay(context, time),
        getAsset(context, ids.mint),
      ]);

      context.Order.set({
        id: ids.order,
        orderId: args.order_id,
        account_id: ids.user,
        asset_id: ids.mint,
        ticker: args.ticker,
        side,
        status: "OPEN",
        amountIn: args.amount,
        amountOut: undefined,
        price: undefined,
        placedSlot: slot,
        placedAt: time,
        filledAt: undefined,
        placeTx: instruction.transaction.signature,
        fillTx: undefined,
      });
      context.Asset.set({ ...asset, symbol: args.ticker, orderCount: asset.orderCount + 1 });
      context.Account.set({ ...account, orderCount: account.orderCount + 1 });
      commit(
        context,
        { ...protocol, orderCount: protocol.orderCount + 1 },
        { ...day, ordersPlaced: day.ordersPlaced + 1 },
        slot,
        time,
      );
    },
  );
}

for (const [name, side] of [
  ["fulfill_buy_order_freeze_gated", "BUY"],
  ["fulfill_buy_order_kyc_gated", "BUY"],
  ["fulfill_sell_order_freeze_gated", "SELL"],
  ["fulfill_sell_order_kyc_gated", "SELL"],
] as const) {
  indexer.onInstruction({ program: "Orders", instruction: name, fields }, async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.fulfillOrder(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const amountOut = instruction.args.amount;

    const order = await context.Order.get(ids.order);
    // Orders placed before the indexer's first slot are filled here without a row to update.
    if (!order || order.status === "FILLED") return;
    const [protocol, account, day, asset] = await Promise.all([
      getProtocol(context),
      getAccount(context, order.account_id, time),
      getDay(context, time),
      getAsset(context, order.asset_id),
    ]);

    // A buy pays USDC for minted stock; a sell hands over stock for USDC.
    const usdc = side === "BUY" ? order.amountIn : amountOut;
    const stock = side === "BUY" ? amountOut : order.amountIn;
    const fillPrice = price(usdc, stock);
    const buy = side === "BUY" ? usdc : 0n;
    const sell = side === "SELL" ? usdc : 0n;

    context.Order.set({
      ...order,
      status: "FILLED",
      amountOut,
      price: fillPrice,
      filledAt: time,
      fillTx: instruction.transaction.signature,
    });
    context.Asset.set({
      ...asset,
      buyVolume: asset.buyVolume + buy,
      sellVolume: asset.sellVolume + sell,
      lastPrice: fillPrice ?? asset.lastPrice,
      lastPriceTime: fillPrice === undefined ? asset.lastPriceTime : time,
    });
    context.Account.set({
      ...account,
      buyVolume: account.buyVolume + buy,
      sellVolume: account.sellVolume + sell,
    });
    commit(
      context,
      {
        ...protocol,
        filledOrderCount: protocol.filledOrderCount + 1,
        buyVolume: protocol.buyVolume + buy,
        sellVolume: protocol.sellVolume + sell,
      },
      { ...day, buyVolume: day.buyVolume + buy, sellVolume: day.sellVolume + sell },
      slot,
      time,
    );
  });
}

indexer.onInstruction(
  { program: "Orders", instruction: "request_cancel_order", fields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.cancelOrder(instruction.accountArguments);
    const order = await context.Order.get(ids.order);
    if (!order || order.status !== "OPEN") return;
    context.Order.set({ ...order, status: "CANCEL_REQUESTED" });
  },
);

// ---------------------------------------------------------------------------
// OnchainId: KYC
// ---------------------------------------------------------------------------

indexer.onInstruction(
  { program: "OnchainId", instruction: "create_identity_for_user", fields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.createIdentity(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const [protocol, account, day, existing] = await Promise.all([
      getProtocol(context),
      getAccount(context, ids.user, time),
      getDay(context, time),
      context.Identity.get(ids.identity),
    ]);
    if (existing) return;

    context.Identity.set({ id: ids.identity, account_id: ids.user, verified: false, createdAt: time });
    context.Account.set({ ...account, identity: ids.identity });
    commit(context, { ...protocol, identityCount: protocol.identityCount + 1 }, day, slot, time);
  },
);

indexer.onInstruction(
  { program: "OnchainId", instruction: "set_verified", fields },
  async ({ instruction, context }) => {
    if (!instruction.transaction.success) return;
    const ids = layout.setVerified(instruction.accountArguments);
    const { slot, time } = instruction.block;
    const verified = instruction.args.verified;
    // An identity created before the indexer's first slot has no wallet on record.
    const identity = await context.Identity.get(ids.identity);
    if (!identity || identity.verified === verified) return;
    const [protocol, account, day] = await Promise.all([
      getProtocol(context),
      getAccount(context, identity.account_id, time),
      getDay(context, time),
    ]);

    context.Identity.set({ ...identity, verified });
    context.Account.set({ ...account, verified });
    commit(
      context,
      { ...protocol, verifiedCount: protocol.verifiedCount + (verified ? 1 : -1) },
      { ...day, usersVerified: day.usersVerified + (verified ? 1 : 0) },
      slot,
      time,
    );
  },
);
