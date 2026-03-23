'use strict';

/**
 * db.js — SQLite layer for PiggyBank
 *
 * Uses Node's built-in `node:sqlite` module (Node 22+).
 * No npm install required, no native compilation, works on all platforms.
 *
 * Schema
 * ──────
 *   users          id, name, email, password_hash, created_at
 *   piggy_banks    id, user_id, name, icon, goal, balance,
 *                  withdrawal_policy, cooling_days, created_at
 *   transactions   id, bank_id, type, amount, date
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// ── Open / create the database file ──────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'piggybank.db');
const db = new DatabaseSync(DB_PATH);

// Performance & integrity pragmas
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS piggy_banks (
    id                TEXT    PRIMARY KEY,
    user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT    NOT NULL,
    icon              TEXT    NOT NULL DEFAULT 'fa-piggy-bank',
    goal              REAL    NOT NULL DEFAULT 0,
    balance           REAL    NOT NULL DEFAULT 0,
    withdrawal_policy TEXT    NOT NULL DEFAULT 'free',
    cooling_days      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id      TEXT PRIMARY KEY,
    bank_id TEXT NOT NULL REFERENCES piggy_banks(id) ON DELETE CASCADE,
    type    TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
    amount  REAL NOT NULL,
    date    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_banks_user    ON piggy_banks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_bank       ON transactions(bank_id);
  CREATE INDEX IF NOT EXISTS idx_tx_date       ON transactions(date);
`);

// ── Transaction helper ────────────────────────────────────────
// node:sqlite has no .transaction() wrapper like better-sqlite3,
// so we provide our own thin helper that keeps BEGIN/COMMIT/ROLLBACK clean.
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Column name mapping helper ────────────────────────────────
// node:sqlite returns raw snake_case column names, so we remap to camelCase
// to keep the rest of the app unchanged.
function mapUser(row) {
  if (!row) return null;
  return {
    id:           row.id,
    name:         row.name,
    email:        row.email,
    passwordHash: row.password_hash,
    createdAt:    row.created_at,
  };
}

function mapBank(row) {
  if (!row) return null;
  return {
    id:               row.id,
    userId:           row.user_id,
    name:             row.name,
    icon:             row.icon,
    goal:             row.goal,
    balance:          row.balance,
    withdrawalPolicy: row.withdrawal_policy,
    coolingDays:      row.cooling_days,
    createdAt:        row.created_at,
  };
}

function mapTx(row) {
  if (!row) return null;
  return {
    id:     row.id,
    bankId: row.bank_id,
    type:   row.type,
    amount: row.amount,
    date:   row.date,
  };
}

// ═══════════════════════════════════════════════════════════
//  USER HELPERS
// ═══════════════════════════════════════════════════════════

const _insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, created_at)
  VALUES ($id, $name, $email, $passwordHash, $createdAt)
`);

const _getUserByEmail = db.prepare(
  `SELECT * FROM users WHERE email = $email COLLATE NOCASE`
);

const _getUserById = db.prepare(
  `SELECT * FROM users WHERE id = $id`
);

const _emailExists = db.prepare(
  `SELECT 1 AS found FROM users WHERE email = $email COLLATE NOCASE`
);

module.exports.createUser = (user) =>
  _insertUser.run({
    $id:           user.id,
    $name:         user.name,
    $email:        user.email,
    $passwordHash: user.passwordHash,
    $createdAt:    user.createdAt,
  });

module.exports.getUserByEmail = (email) =>
  mapUser(_getUserByEmail.get({ $email: email }));

module.exports.getUserById = (id) =>
  mapUser(_getUserById.get({ $id: id }));

module.exports.emailExists = (email) =>
  !!_emailExists.get({ $email: email });

// ═══════════════════════════════════════════════════════════
//  PIGGY BANK HELPERS
// ═══════════════════════════════════════════════════════════

const _insertBank = db.prepare(`
  INSERT INTO piggy_banks
    (id, user_id, name, icon, goal, balance, withdrawal_policy, cooling_days, created_at)
  VALUES
    ($id, $userId, $name, $icon, $goal, $balance, $withdrawalPolicy, $coolingDays, $createdAt)
`);

const _getBanksByUser = db.prepare(
  `SELECT * FROM piggy_banks WHERE user_id = $userId ORDER BY created_at DESC`
);

const _getBankById = db.prepare(
  `SELECT * FROM piggy_banks WHERE id = $id`
);

const _updateBalance = db.prepare(
  `UPDATE piggy_banks SET balance = $balance WHERE id = $id`
);

const _deleteBank = db.prepare(
  `DELETE FROM piggy_banks WHERE id = $id`
);

module.exports.createBank = (bank) =>
  _insertBank.run({
    $id:               bank.id,
    $userId:           bank.userId,
    $name:             bank.name,
    $icon:             bank.icon,
    $goal:             bank.goal,
    $balance:          bank.balance,
    $withdrawalPolicy: bank.withdrawalPolicy,
    $coolingDays:      bank.coolingDays,
    $createdAt:        bank.createdAt,
  });

module.exports.getBanksByUser = (userId) =>
  _getBanksByUser.all({ $userId: userId }).map(mapBank);

module.exports.getBankById = (id) =>
  mapBank(_getBankById.get({ $id: id }));

module.exports.updateBalance = (id, balance) =>
  _updateBalance.run({ $id: id, $balance: balance });

module.exports.deleteBank = (id) =>
  _deleteBank.run({ $id: id });

// ═══════════════════════════════════════════════════════════
//  TRANSACTION HELPERS
// ═══════════════════════════════════════════════════════════

const _insertTx = db.prepare(`
  INSERT INTO transactions (id, bank_id, type, amount, date)
  VALUES ($id, $bankId, $type, $amount, $date)
`);

const _getTxsByBank = db.prepare(
  `SELECT * FROM transactions WHERE bank_id = $bankId ORDER BY date ASC`
);

const _getDepositDaysByUser = db.prepare(`
  SELECT DISTINCT substr(t.date, 1, 10) AS day
  FROM transactions t
  JOIN piggy_banks b ON b.id = t.bank_id
  WHERE b.user_id = $userId AND t.type = 'deposit'
  ORDER BY day ASC
`);

const _getDepositTotals = db.prepare(`
  SELECT
    COUNT(*)                  AS totalDeposits,
    COALESCE(SUM(t.amount),0) AS totalSavedEver
  FROM transactions t
  JOIN piggy_banks b ON b.id = t.bank_id
  WHERE b.user_id = $userId AND t.type = 'deposit'
`);

/**
 * Atomically insert a transaction row AND update the bank balance.
 * Uses BEGIN/COMMIT so a crash mid-operation leaves data consistent.
 */
module.exports.recordTransaction = (tx, newBalance) =>
  withTransaction(() => {
    _insertTx.run({
      $id:     tx.id,
      $bankId: tx.bankId,
      $type:   tx.type,
      $amount: tx.amount,
      $date:   tx.date,
    });
    _updateBalance.run({ $id: tx.bankId, $balance: newBalance });
  });

module.exports.getTxsByBank = (bankId) =>
  _getTxsByBank.all({ $bankId: bankId }).map(mapTx);

/**
 * Returns streak / stats data using efficient aggregate SQL queries
 * rather than loading every transaction row into JS.
 */
module.exports.getStatsData = (userId) => {
  const rows   = _getDepositDaysByUser.all({ $userId: userId });
  const totals = _getDepositTotals.get({ $userId: userId });
  return {
    depositDays:   rows.map(r => r.day),
    totalDeposits: Number(totals.totalDeposits),
    totalSavedEver: Number(totals.totalSavedEver),
  };
};

// ── Graceful shutdown ─────────────────────────────────────────
process.on('exit',   () => db.close());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM',() => process.exit(0));