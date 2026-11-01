<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/aricxpoint-logo-white.png">
    <img alt="aricxpoint technologies" src=".github/aricxpoint-logo-black.png" width="320">
  </picture>
</p>

# paylab-wallet-svc

Part of **PayLab** (aricxpoint DevOps class: "Payment Web App Deployment").

Owns the `wallets` and `ledger_entries` tables and is the only service that changes balances.
Internal only: the gateway exposes `/api/wallets*`, but **`/transfers` is never public**: money moves only through payment-svc.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET  | `/health` | | `{"status":"ok"}` |
| POST | `/wallets` | `{"owner":"Ada","handle":"ada","initialBalanceKobo":1000000}` | 201. `handle` is unique, lowercase `[a-z0-9_]{3,20}` (409 if taken). Starting balance defaults to, and is capped at, 1,000,000 kobo (₦10,000 demo credit). |
| GET  | `/wallets` | | Directory: `[{id, owner, handle}]`, no balances |
| GET  | `/wallets/:id` | | Wallet incl. `balance_kobo`; 404 if missing |
| GET  | `/wallets/by-handle/:handle` | | Same, looked up by handle |
| POST | `/transfers` | `{"fromWalletId":1,"toWalletId":2,"amountKobo":150000,"reference":"ref-1"}` | Moves money. 201 done, 200 = this reference was already done (idempotent), 400 same wallet / amount <= 0, 404 unknown wallet, **409 insufficient funds** (nothing changes). |

### How a transfer stays correct

`POST /transfers` runs in **one database transaction**:

1. `SELECT ... FROM wallets WHERE id IN (payer, payee) ORDER BY id FOR UPDATE` locks both rows. Always in id order,
   so A->B and B->A at the same moment can't deadlock.
2. If ledger rows for this `reference` already exist, return the original result (idempotency).
3. Check the payer's balance; 409 and roll back if it's too low.
4. Debit the payer, credit the payee, insert two `ledger_entries` rows (`debit` + `credit`). `COMMIT`.

`UNIQUE (payment_reference, direction)` on the ledger is the final guard against double-processing, and
`CHECK (balance_kobo >= 0)` makes a negative balance impossible even if the code had a bug.

Tables (created on startup with `CREATE TABLE IF NOT EXISTS`; the service retries until Postgres is reachable):

```
wallets        (id, owner, handle UNIQUE, balance_kobo CHECK >= 0, created_at)
ledger_entries (id, wallet_id, payment_reference, direction debit|credit, amount_kobo,
                counterparty_wallet_id, created_at, UNIQUE (payment_reference, direction))
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` | `8082` | |
| `DB_HOST` | `localhost` | |
| `DB_PORT` | `5432` | |
| `DB_NAME` | `paylab` | |
| `DB_USER` | `paylab` | |
| `DB_PASSWORD` | `paylab` | On AWS ECS injects it from SSM Parameter Store `/paylab/db/password` (SecureString). |
| `DB_SSL` | unset | Set `true` on AWS: RDS PostgreSQL requires TLS. |

## Run it alone with Docker

```bash
docker network create paylab
docker run -d --name pg --network paylab \
  -e POSTGRES_DB=paylab -e POSTGRES_USER=paylab -e POSTGRES_PASSWORD=paylab-local-pass \
  -p 5432:5432 postgres:16-alpine

docker build -t paylab/wallet-svc .
docker run --rm --name wallet-svc --network paylab -p 8082:8082 \
  -e DB_HOST=pg -e DB_PASSWORD=paylab-local-pass paylab/wallet-svc

# in another terminal
curl -s -X POST localhost:8082/wallets -H 'Content-Type: application/json' -d '{"owner":"Ada","handle":"ada"}'
curl -s -X POST localhost:8082/wallets -H 'Content-Type: application/json' -d '{"owner":"Bola","handle":"bola"}'
curl -s -X POST localhost:8082/transfers -H 'Content-Type: application/json' \
  -d '{"fromWalletId":1,"toWalletId":2,"amountKobo":150000,"reference":"ref-1"}'        # 201
curl -s -X POST localhost:8082/transfers -H 'Content-Type: application/json' \
  -d '{"fromWalletId":1,"toWalletId":2,"amountKobo":99999900,"reference":"ref-2"}'      # 409 insufficient funds
curl -s localhost:8082/wallets/1     # balance_kobo 850000
```

Clean up: `docker rm -f pg && docker network rm paylab`

## Deployment (AWS)

This repo is deployed by its own **CodePipeline** `paylab-wallet-svc-pipeline` on every push to `main`:

```
git push (main) -> CodePipeline Source -> CodeBuild (buildspec.yml) -> ECR paylab/wallet-svc:<commit> -> ECS service "wallet-svc" in cluster "paylab"
```

| File | Purpose |
|---|---|
| `buildspec.yml` | CodeBuild steps: log in to ECR, build, push `:<short-commit>` and `:latest`, write `imagedefinitions.json`. |
| `taskdef.json` | ECS task definition template (with `<ACCOUNT_ID>`-style placeholders). Registered by `paylab-infra/terraform` (`ecs.tf`); the pipeline then registers a new revision on every deploy. |

The container name in `taskdef.json` and in `imagedefinitions.json` is `wallet-svc`. They **must match**, or the deploy stage fails.

The shared AWS setup (network, database, cluster, load balancer, pipelines) lives in the **paylab-infra** repo.
