/*
 * Account positions for each indexed instruction.
 *
 * Spout publishes no IDL, and several instructions gained or lost accounts in
 * program upgrades, so slots are read by position and — where a layout changed —
 * chosen by how many accounts the call carries. Every position here was checked
 * against the full devnet history (see README, "Accuracy").
 */

type Accounts = readonly string[];

/** `initialize_vault`: 17 accounts before the KYC-gated mints, 8 after. */
export function initializeVault(a: Accounts) {
  return a.length >= 17
    ? { collateralType: a[1]!, mint: a[2] as string | undefined, vault: a[3]!, user: a[7]! }
    : { collateralType: a[1]!, mint: undefined, vault: a[2]!, user: a[4]! };
}

/**
 * `deposit_collateral`, `top_up_collateral`, `borrow_stablecoin`, `repay_debt`:
 * the vault and its collateral type lead, and the user signs second to last
 * (just before the token program) in every version.
 */
export function vaultCall(a: Accounts) {
  return { vault: a[1]!, collateralType: a[2]!, user: a[a.length - 2]! };
}

/** The collateral mint of `deposit_collateral` / `top_up_collateral`. */
export const collateralMint = (a: Accounts) => a[3]!;

/** `seize_collateral` and `settle_liquidation_downside` (keeper-signed). */
export const liquidation = (a: Accounts) => ({ vault: a[2]!, collateralType: a[3]! });

/** `deposit_liquidity` / `withdraw_liquidity`. */
export const liquidity = (a: Accounts) => ({ user: a[1]!, shareMint: a[5]! });

/** `distribute_yield`: the keeper's USDC, the lender pool's USDC, the reserve's USDC. */
export const yieldAccounts = (a: Accounts) => ({ source: a[2]!, pool: a[4]!, reserve: a[5]! });

export const placeBuyOrder = (a: Accounts) => ({ order: a[3]!, user: a[9]!, mint: a[11]! });
export const placeSellOrder = (a: Accounts) => ({ order: a[3]!, user: a[7]!, mint: a[9]! });
export const fulfillOrder = (a: Accounts) => ({ order: a[1]!, mint: a[6]!, user: a[7]! });
export const cancelOrder = (a: Accounts) => ({ order: a[0]!, user: a[1]! });

/** `create_identity_for_user`: the wallet and the identity account created for it. */
export const createIdentity = (a: Accounts) => ({ user: a[2]!, identity: a[3]! });
/** `set_verified` names only the identity account, not the wallet behind it. */
export const setVerified = (a: Accounts) => ({ identity: a[2]! });
