'use strict';

const { emitWarning } = process;
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string' && warning.includes('SQLite')) return;
  emitWarning.call(process, warning, ...args);
};

const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'piggybank-super-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,   // set true when behind HTTPS
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// No-cache for all API routes — prevents stale GET responses after mutations
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── Auth guard ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/'))
    return res.status(401).json({ error: 'Unauthorised. Please log in.' });
  res.redirect('/login');
}

// ═══════════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════════

const page = (f) => path.join(__dirname, 'public', f);

app.get('/',             (_req, res) => res.sendFile(page('page_1.html')));
app.get('/how-it-works', (_req, res) => res.sendFile(page('page_2.html')));
app.get('/security',     (_req, res) => res.sendFile(page('page_3.html')));
app.get('/signup',       (_req, res) => res.sendFile(page('page_4.html')));
app.get('/login',        (_req, res) => res.sendFile(page('page_5.html')));
app.get('/dashboard', requireAuth, (_req, res) => res.sendFile(page('dashboard.html')));

// ═══════════════════════════════════════════════════════════
//  AUTH API
// ═══════════════════════════════════════════════════════════

/** POST /api/register */
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.emailExists(email))
      return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id:           uuidv4(),
      name:         name.trim(),
      email:        email.toLowerCase().trim(),
      passwordHash,
      createdAt:    new Date().toISOString(),
    };

    db.createUser(user);

    req.session.userId    = user.id;
    req.session.userEmail = user.email;

    res.status(201).json({
      message: 'Account created successfully.',
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/** POST /api/login */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password, remember } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = db.getUserByEmail(email);
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match)
      return res.status(401).json({ error: 'Invalid email or password.' });

    req.session.userId    = user.id;
    req.session.userEmail = user.email;

    if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

    res.json({
      message: 'Logged in successfully.',
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/** POST /api/logout */
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out.' });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully.' });
  });
});

/** GET /api/me */
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });
});

// ═══════════════════════════════════════════════════════════
//  PIGGY BANK API
// ═══════════════════════════════════════════════════════════

const VALID_POLICIES = ['free', 'goal_only', 'cooling', 'goal_and_cooling'];

/** Returns an error string if the withdrawal policy blocks the action, else null. */
function checkWithdrawalPolicy(bank) {
  const { withdrawalPolicy, coolingDays, goal, balance, createdAt } = bank;
  const goalReached     = goal > 0 && balance >= goal;
  const daysSinceCreate = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  const coolingElapsed  = daysSinceCreate >= (coolingDays || 0);

  switch (withdrawalPolicy) {
    case 'goal_only':
      if (!goalReached)
        return goal > 0
          ? `Withdrawals are locked until your goal of $${goal.toFixed(2)} is reached. You need $${(goal - balance).toFixed(2)} more.`
          : 'Withdrawals are locked until the savings goal is reached.';
      break;

    case 'cooling': {
      if (!coolingElapsed) {
        const left = Math.ceil(coolingDays - daysSinceCreate);
        return `Cooling period active — withdrawals unlock in ${left} day${left !== 1 ? 's' : ''}.`;
      }
      break;
    }

    case 'goal_and_cooling': {
      const errors = [];
      if (!goalReached && goal > 0)
        errors.push(`reach your $${goal.toFixed(2)} goal ($${(goal - balance).toFixed(2)} remaining)`);
      if (!coolingElapsed) {
        const left = Math.ceil(coolingDays - daysSinceCreate);
        errors.push(`wait ${left} more day${left !== 1 ? 's' : ''} (cooling period)`);
      }
      if (errors.length) return `To withdraw you must: ${errors.join(' and ')}.`;
      break;
    }
  }
  return null;
}

/** Attach the transactions array to a bank object (used where needed) */
function bankWithTx(bank) {
  return { ...bank, transactions: db.getTxsByBank(bank.id) };
}

/** GET /api/piggybanks */
app.get('/api/piggybanks', requireAuth, (req, res) => {
  const banks = db.getBanksByUser(req.session.userId).map(bankWithTx);
  res.json(banks);
});

/** POST /api/piggybanks */
app.post('/api/piggybanks', requireAuth, (req, res) => {
  const { name, icon, goal, withdrawalPolicy, coolingDays } = req.body;

  if (!name) return res.status(400).json({ error: 'A name is required.' });

  const policy = VALID_POLICIES.includes(withdrawalPolicy) ? withdrawalPolicy : 'free';
  const days   = parseInt(coolingDays, 10) || 0;

  if (['goal_only', 'goal_and_cooling'].includes(policy) && !(parseFloat(goal) > 0))
    return res.status(400).json({ error: 'A goal amount is required for this withdrawal policy.' });
  if (['cooling', 'goal_and_cooling'].includes(policy) && days < 1)
    return res.status(400).json({ error: 'A cooling period of at least 1 day is required.' });

  const bank = {
    id:               uuidv4(),
    userId:           req.session.userId,
    name:             name.trim(),
    icon:             icon || 'fa-piggy-bank',
    goal:             parseFloat(goal) || 0,
    balance:          0,
    withdrawalPolicy: policy,
    coolingDays:      days,
    createdAt:        new Date().toISOString(),
  };

  db.createBank(bank);
  res.status(201).json({ ...bank, transactions: [] });
});

/** POST /api/piggybanks/:id/deposit */
app.post('/api/piggybanks/:id/deposit', requireAuth, (req, res) => {
  const bank = db.getBankById(req.params.id);
  if (!bank)                              return res.status(404).json({ error: 'Piggy bank not found.' });
  if (bank.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden.' });

  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });

  const newBalance = parseFloat((bank.balance + amount).toFixed(2));
  const tx = { id: uuidv4(), bankId: bank.id, type: 'deposit', amount, date: new Date().toISOString() };

  db.recordTransaction(tx, newBalance);

  res.json({ ...bank, balance: newBalance, transactions: db.getTxsByBank(bank.id) });
});

/** POST /api/piggybanks/:id/withdraw */
app.post('/api/piggybanks/:id/withdraw', requireAuth, (req, res) => {
  const bank = db.getBankById(req.params.id);
  if (!bank)                              return res.status(404).json({ error: 'Piggy bank not found.' });
  if (bank.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden.' });

  const policyError = checkWithdrawalPolicy(bank);
  if (policyError) return res.status(403).json({ error: policyError, policyBlocked: true });

  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0)   return res.status(400).json({ error: 'Amount must be a positive number.' });
  if (amount > bank.balance)    return res.status(400).json({ error: 'Insufficient balance.' });

  const newBalance = parseFloat((bank.balance - amount).toFixed(2));
  const tx = { id: uuidv4(), bankId: bank.id, type: 'withdrawal', amount, date: new Date().toISOString() };

  db.recordTransaction(tx, newBalance);

  res.json({ ...bank, balance: newBalance, transactions: db.getTxsByBank(bank.id) });
});

/** DELETE /api/piggybanks/:id */
app.delete('/api/piggybanks/:id', requireAuth, (req, res) => {
  const bank = db.getBankById(req.params.id);
  if (!bank)                              return res.status(404).json({ error: 'Piggy bank not found.' });
  if (bank.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden.' });

  db.deleteBank(bank.id);  // CASCADE deletes transactions too
  res.json({ message: 'Piggy bank deleted.' });
});

const app  = express();
const PORT = process.env.PORT || 3000;