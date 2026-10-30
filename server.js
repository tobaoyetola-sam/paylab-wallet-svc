// wallet-svc: owns the `wallets` and `ledger_entries` tables.
// Creates wallets and moves money between them with POST /transfers.
const express = require('express');
const { Pool } = require('pg');

const SERVICE = 'wallet-svc';
const PORT = Number(process.env.PORT || 8082);
const MAX_START_KOBO = 1000000; // ₦10,000 demo credit (default and maximum)
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

// One JSON object per line on stdout -> easy to read in CloudWatch Logs.
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, msg, ...extra }));
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'paylab',
  user: process.env.DB_USER || 'paylab',
  password: process.env.DB_PASSWORD || 'paylab',
  // RDS needs TLS; set DB_SSL=true on AWS (a local Postgres container does not use TLS).
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Wait for Postgres (it may still be starting), then create our tables.
async function initDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wallets (
          id           SERIAL PRIMARY KEY,
          owner        TEXT NOT NULL,
          handle       TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
          balance_kobo BIGINT NOT NULL CHECK (balance_kobo >= 0),
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ledger_entries (
          id                     SERIAL PRIMARY KEY,
          wallet_id              INT NOT NULL REFERENCES wallets(id),
          payment_reference      TEXT NOT NULL,
          direction              TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
          amount_kobo            BIGINT NOT NULL CHECK (amount_kobo > 0),
          counterparty_wallet_id INT NOT NULL REFERENCES wallets(id),
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (payment_reference, direction)
        )`);
      log('info', 'database ready');
      return;
    } catch (err) {
      log('warn', 'database not ready, retrying in 2s', { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('could not connect to database');
}

// BIGINT comes back from pg as a string; convert for nicer JSON.
const toWallet = (row) => ({ ...row, balance_kobo: Number(row.balance_kobo) });
const isId = (v) => /^[1-9][0-9]{0,9}$/.test(String(v));

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));

// Create a wallet: { owner, handle, initialBalanceKobo? }
app.post('/wallets', async (req, res) => {
  const owner = String(req.body?.owner || '').trim();
  const handle = String(req.body?.handle || '').trim().toLowerCase().replace(/^@/, '');
  const initial = req.body?.initialBalanceKobo ?? MAX_START_KOBO;
  if (!owner) return res.status(400).json({ error: 'owner is required' });
  if (!HANDLE_RE.test(handle)) {
    return res.status(400).json({ error: 'handle must be 3-20 characters: a-z, 0-9 or _' });
  }
  if (!Number.isInteger(initial) || initial < 0 || initial > MAX_START_KOBO) {
    return res.status(400).json({ error: `initialBalanceKobo must be an integer from 0 to ${MAX_START_KOBO}` });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO wallets (owner, handle, balance_kobo) VALUES ($1, $2, $3) RETURNING *',
      [owner, handle, initial]
    );
    log('info', 'wallet created', { walletId: rows[0].id, handle });
    res.status(201).json(toWallet(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `handle @${handle} is already taken` });
    log('error', 'create wallet failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// Directory for the "send to" picker: no balances here.
app.get('/wallets', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, owner, handle FROM wallets ORDER BY handle LIMIT 500');
    res.json(rows);
  } catch (err) {
    log('error', 'list wallets failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/wallets/by-handle/:handle', async (req, res) => {
  const handle = req.params.handle.trim().toLowerCase().replace(/^@/, '');
  try {
    const { rows } = await pool.query('SELECT * FROM wallets WHERE handle = $1', [handle]);
    if (rows.length === 0) return res.status(404).json({ error: `no wallet with handle @${handle}` });
    res.json(toWallet(rows[0]));
  } catch (err) {
    log('error', 'get wallet by handle failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/wallets/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'wallet not found' });
  try {
    const { rows } = await pool.query('SELECT * FROM wallets WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'wallet not found' });
    res.json(toWallet(rows[0]));
  } catch (err) {
    log('error', 'get wallet failed', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// Move money: { fromWalletId, toWalletId, amountKobo, reference }
// Everything happens in ONE database transaction, so money is never created or lost.
app.post('/transfers', async (req, res) => {
  const { fromWalletId, toWalletId, amountKobo, reference } = req.body || {};
  if (!Number.isInteger(fromWalletId) || !Number.isInteger(toWalletId) || !reference) {
    return res.status(400).json({ error: 'fromWalletId, toWalletId (integers) and reference are required' });
  }
  if (fromWalletId === toWalletId) return res.status(400).json({ error: 'cannot send money to the same wallet' });
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return res.status(400).json({ error: 'amountKobo must be a positive integer' });
  }

  // Look up a transfer that already happened (idempotency).
  const existing = async (db) => {
    const { rows } = await db.query(
      `SELECT wallet_id, counterparty_wallet_id, amount_kobo FROM ledger_entries
        WHERE payment_reference = $1 AND direction = 'debit'`,
      [reference]
    );
    if (rows.length === 0) return null;
    return {
      reference,
      fromWalletId: rows[0].wallet_id,
      toWalletId: rows[0].counterparty_wallet_id,
      amountKobo: Number(rows[0].amount_kobo),
      duplicate: true,
    };
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock BOTH wallet rows. Always in id order, so two opposite transfers
    //    (A->B and B->A at the same time) can't deadlock each other.
    const { rows: locked } = await client.query(
      'SELECT id, balance_kobo FROM wallets WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [[fromWalletId, toWalletId]]
    );
    if (locked.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'wallet not found' });
    }

    // 2. Same reference seen before? Return the original result, change nothing.
    const previous = await existing(client);
    if (previous) {
      await client.query('ROLLBACK');
      log('info', 'duplicate transfer reference', { reference });
      return res.status(200).json(previous);
    }

    // 3. Enough money?
    const payer = locked.find((w) => w.id === fromWalletId);
    if (Number(payer.balance_kobo) < amountKobo) {
      await client.query('ROLLBACK');
      log('warn', 'insufficient funds', { reference, fromWalletId, amountKobo });
      return res.status(409).json({ error: 'insufficient funds' });
    }

    // 4. Debit, credit, and write both ledger rows.
    const debited = await client.query(
      'UPDATE wallets SET balance_kobo = balance_kobo - $2 WHERE id = $1 RETURNING balance_kobo',
      [fromWalletId, amountKobo]
    );
    const credited = await client.query(
      'UPDATE wallets SET balance_kobo = balance_kobo + $2 WHERE id = $1 RETURNING balance_kobo',
      [toWalletId, amountKobo]
    );
    await client.query(
      `INSERT INTO ledger_entries (wallet_id, payment_reference, direction, amount_kobo, counterparty_wallet_id)
       VALUES ($1, $3, 'debit', $4, $2), ($2, $3, 'credit', $4, $1)`,
      [fromWalletId, toWalletId, reference, amountKobo]
    );
    await client.query('COMMIT');

    log('info', 'transfer done', { reference, fromWalletId, toWalletId, amountKobo });
    res.status(201).json({
      reference,
      fromWalletId,
      toWalletId,
      amountKobo,
      fromBalanceKobo: Number(debited.rows[0].balance_kobo),
      toBalanceKobo: Number(credited.rows[0].balance_kobo),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      // Another request with the same reference committed first.
      const previous = await existing(pool);
      if (previous) return res.status(200).json(previous);
    }
    log('error', 'transfer failed', { reference, error: err.message });
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

initDb()
  .then(() => app.listen(PORT, () => log('info', `listening on port ${PORT}`)))
  .catch((err) => {
    log('error', 'startup failed', { error: err.message });
    process.exit(1);
  });
