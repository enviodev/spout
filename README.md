# Spout indexer

A [HyperIndex](https://docs.envio.dev) indexer for [Spout Finance](https://spout.finance) —
0% loans against tokenized US stocks, funded by a tranched lending pool — streamed from
HyperSync on Solana devnet, where Spout's testnet runs.

- **Dashboard:** https://enviodev.github.io/spout/ (source in `docs/`, a single static page)
- **GraphQL:** https://enviodev-213a77d.internal.hyperindex.xyz/v1/graphql (Envio Cloud staging)
- **Coverage:** slot 485,196,645 (2026-08-17) to the chain head
- **Backfill time:** about 20 seconds on a laptop

## Programs

| Program | Address | What it does |
|---|---|---|
| Vault | [`spvaDgABYdpFKyatqo4Jr3nfwvVgWF5BbFxKFkzN3Am`](https://solscan.io/account/spvaDgABYdpFKyatqo4Jr3nfwvVgWF5BbFxKFkzN3Am?cluster=devnet) | Borrower vaults, the senior / junior lending pool, yield distribution, liquidations |
| Orders | [`SPoRXgsB4gWZmWPwyndoRWQrmZXKUc7o7oPMdkkGRcG`](https://solscan.io/account/SPoRXgsB4gWZmWPwyndoRWQrmZXKUc7o7oPMdkkGRcG?cluster=devnet) | Buy and sell orders for the tokenized stocks |
| OnchainId | [`SKYCVrkX3mQaHwZcLrUtuvzii43kma7kBUim5MaQm6k`](https://solscan.io/account/SKYCVrkX3mQaHwZcLrUtuvzii43kma7kBUim5MaQm6k?cluster=devnet) | The KYC identity a wallet needs to hold them |

The addresses come from the testnet app's own configuration.

## What it indexes

| Instruction | Becomes |
|---|---|
| `initialize_vault`, `deposit_collateral`, `top_up_collateral` | `Vault`, `VaultAction`, collateral per `Asset` |
| `borrow_stablecoin`, `repay_debt` | `VaultAction`, debt on `Vault` / `Account` / `Asset` / `Protocol` |
| `seize_collateral`, `settle_liquidation_downside` | `VaultAction`, vault status `FROZEN` → `SETTLED` |
| `deposit_liquidity`, `withdraw_liquidity` | `LiquidityAction`, `TrancheStat` (senior / junior), pool assets |
| `distribute_yield` | `YieldDistribution` — what each covered-call cycle paid lenders and the reserve |
| `place_buy_order`, `place_sell_order`, `fulfill_*`, `request_cancel_order` | `Order`, volume and last fill price per `Asset` |
| `create_identity_for_user`, `set_verified` | `Identity`, `Account.verified` |

Plus `Protocol` (one row of totals) and `DailyStat` (UTC-day buckets for charts). Entities are
described in `schema.graphql`.

Amounts are raw atoms: USDC with 6 decimals, stock tokens with 9.

## Accuracy

None of the three programs publishes an IDL, so the instruction layouts in `config.yaml` and
the account positions in `src/handlers/layout.ts` were recovered from devnet transactions,
then checked against what the programs themselves report (2026-11-19):

- Vault debt after every borrow and repay matches the program's own `Vault debt:` log line,
  for **521 of 521** logged loan events.
- Every fill finds its order, with the same wallet, mint and side: **3,105 of 3,105**.
- Senior and junior share supply match the share mints' on-chain supply exactly.
- Collateral per stock matches the collateral pool's token balance exactly for the 12
  retired mints, and to within the pool's 0.001-token seed for the current ones.

Things to know:

- **History starts at slot 485,196,645.** That is as far back as HyperSync serves devnet for
  these programs. About 120 order, 90 KYC and 20 vault-admin transactions from June to
  mid-August 2026 fall before it; no vault was opened that early.
- **Each ticker has two mints**: the original freeze-gated (Token-2022) mint and the current
  KYC-gated one. `Asset` is keyed by mint; group by `symbol` for a per-stock view.
- **`Asset.lastPrice` is the latest fill price**, not the oracle price the program borrows
  against.
- **`Protocol.poolAssets`** is the figure the program reports on each lender deposit or
  withdrawal, plus yield distributed since. It does not move on borrows or repayments.
- `YieldDistribution.source` (`OPTION_PREMIUM` / `TBILL`) is inferred from the instruction's
  two shapes, and the amounts are read from the USDC accounts' balance change.
- Admin and keeper instructions that move no user funds (collateral type setup, covered-call
  cycle bookkeeping, account migrations) are not indexed.

If Spout shares the programs' IDLs, the hand-written layouts can be replaced with `idl:` in
`config.yaml`, and the events the programs emit can be decoded by name.

## Run it

Requirements: Node 22.15+, pnpm, Docker, and an Envio API token
(free at https://envio.dev/app/api-tokens).

```bash
cp .env.example .env   # then paste your token into ENVIO_API_TOKEN
pnpm install
pnpm test              # handler tests on real devnet transactions, no network needed
pnpm dev               # Postgres + Hasura + indexer; GraphQL at http://localhost:8080
```

The GraphQL playground is at http://localhost:8080 (admin secret `testing`).

## Example queries

Protocol totals and both lending tranches:

```graphql
{
  Protocol { debtOutstanding totalBorrowed totalRepaid openLoanCount poolAssets yieldToLenders verifiedCount }
  TrancheStat { tranche deposited withdrawn shares sharePrice }
}
```

Collateral and debt per stock:

```graphql
{
  Asset(where: { symbol: { _is_null: false } }, order_by: { debtOutstanding: desc }) {
    id symbol collateral debtOutstanding vaultCount lastPrice
  }
}
```

A wallet's vaults and what it owes:

```graphql
query Borrower($wallet: String!) {
  Account(where: { id: { _eq: $wallet } }) {
    verified debt totalBorrowed totalRepaid
    vaults { id collateral debt status asset { symbol lastPrice } }
  }
}
```

The largest open loans:

```graphql
{
  Vault(where: { debt: { _gt: "0" } }, order_by: { debt: desc }, limit: 20) {
    id owner_id collateral debt asset { symbol lastPrice }
  }
}
```

Latest fills:

```graphql
{
  Order(where: { status: { _eq: FILLED } }, order_by: { filledAt: desc }, limit: 20) {
    ticker side amountIn amountOut price filledAt fillTx account_id
  }
}
```

What each covered-call cycle paid out:

```graphql
{
  YieldDistribution(order_by: { cycle: asc }) { cycle source toLenders toReserve time }
}
```

## Layout

- `config.yaml` — program ids, start slot, instruction layouts
- `schema.graphql` — entities
- `src/handlers/SpoutHandlers.ts` — handlers
- `src/handlers/layout.ts` — account positions, including the layouts retired by upgrades
- `test/` — tests built on real devnet instructions
- `docs/index.html` — the dashboard, served by GitHub Pages

## Deployment

Envio Cloud deploys the indexer from the `envio` branch; `main` carries everything else, so
dashboard changes don't trigger a re-index. To ship an indexer change:
`git push origin main:envio`.
