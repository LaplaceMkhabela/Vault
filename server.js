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

// ═══════════════════════════════════════════════════════════
//  STATS, STREAKS & BADGES
// ═══════════════════════════════════════════════════════════

const BADGE_DEFS = [
  { id:'first_deposit',  icon:'🐣', title:'First Deposit',   desc:'Made your very first deposit.',
    earned:(s)    => s.totalDeposits >= 1 },
  { id:'three_day',      icon:'🔥', title:'On Fire',         desc:'Saved 3 days in a row.',
    earned:(s)    => s.currentStreak >= 3 },
  { id:'week_warrior',   icon:'⚡', title:'Week Warrior',    desc:'Maintained a 7-day savings streak.',
    earned:(s)    => s.longestStreak >= 7 },
  { id:'month_master',   icon:'🏆', title:'Month Master',    desc:'30-day savings streak achieved.',
    earned:(s)    => s.longestStreak >= 30 },
  { id:'goal_getter',    icon:'🎯', title:'Goal Getter',     desc:'Reached a savings goal.',
    earned:(s,b)  => b.some(bk => bk.goal > 0 && bk.balance >= bk.goal) },
  { id:'multi_saver',    icon:'🐷', title:'Multi-Saver',     desc:'Created 3 or more piggy banks.',
    earned:(s,b)  => b.length >= 3 },
  { id:'ton_club',       icon:'💰', title:'$100 Club',       desc:'Total savings hit $100.',
    earned:(s)    => s.totalSaved >= 100 },
  { id:'grand_saver',    icon:'💎', title:'Grand Saver',     desc:'Total savings hit $1,000.',
    earned:(s)    => s.totalSaved >= 1000 },
  { id:'streak_master',  icon:'🌟', title:'Streak Master',   desc:'14-day savings streak.',
    earned:(s)    => s.longestStreak >= 14 },
  { id:'consistent',     icon:'📅', title:'Consistent',      desc:'Deposited on 10 separate days.',
    earned:(s)    => s.uniqueDepositDays >= 10 },
  { id:'big_depositor',  icon:'🚀', title:'Big Depositor',   desc:'Made 20 or more deposits.',
    earned:(s)    => s.totalDeposits >= 20 },
  { id:'two_goals',      icon:'🎪', title:'Double Trouble',  desc:'Reached 2 different goals.',
    earned:(s,b)  => b.filter(bk => bk.goal > 0 && bk.balance >= bk.goal).length >= 2 },
];

function computeStats(userId) {
  const banks = db.getBanksByUser(userId);
  const totalSaved = parseFloat(banks.reduce((s, b) => s + b.balance, 0).toFixed(2));
  const goalsMet   = banks.filter(b => b.goal > 0 && b.balance >= b.goal).length;

  // Efficient DB query — no need to load every transaction into JS
  const { depositDays, totalDeposits, totalSavedEver } = db.getStatsData(userId);

  const depositDaySet = new Set(depositDays);

  // ── Current streak ───────────────────────────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  let currentStreak = 0;
  const startFrom   = depositDaySet.has(todayStr) ? 0 : 1; // allow yesterday to keep streak alive

  for (let i = startFrom; ; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (depositDaySet.has(key)) currentStreak++;
    else break;
  }

  // ── Longest streak ───────────────────────────────────────
  let longestStreak = 0, run = 0;
  depositDays.forEach((day, i) => {
    if (i === 0) { run = 1; return; }
    const diff = (new Date(day) - new Date(depositDays[i - 1])) / 86_400_000;
    run = diff === 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
  });
  if (depositDays.length === 1) longestStreak = 1;

  // ── Last 30 days activity map ────────────────────────────
  const activityMap = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    activityMap[key] = depositDaySet.has(key);
  }

  return {
    totalSaved,
    totalSavedEver:   parseFloat(totalSavedEver.toFixed(2)),
    totalDeposits,
    uniqueDepositDays: depositDaySet.size,
    currentStreak,
    longestStreak,
    bankCount: banks.length,
    goalsMet,
    activityMap,
  };
}

/** GET /api/stats */
app.get('/api/stats', requireAuth, (req, res) => {
  res.json(computeStats(req.session.userId));
});

/** GET /api/badges */
app.get('/api/badges', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const stats  = computeStats(userId);
  const banks  = db.getBanksByUser(userId);

  res.json(BADGE_DEFS.map(def => ({
    id:     def.id,
    icon:   def.icon,
    title:  def.title,
    desc:   def.desc,
    earned: def.earned(stats, banks),
  })));
});

// ═══════════════════════════════════════════════════════════
//  ADVISOR — Marcus (Groq / Llama-3)
// ═══════════════════════════════════════════════════════════

function buildSystemPrompt(user, stats, banks) {
  const bankSummary = banks.length
    ? banks.map(b => {
        const pct    = b.goal > 0 ? ((b.balance / b.goal) * 100).toFixed(0) : null;
        const policy = {
          free:             'no withdrawal restrictions',
          goal_only:        'locked until goal is reached',
          cooling:          `cooling period of ${b.coolingDays} days`,
          goal_and_cooling: `locked until goal AND ${b.coolingDays}-day cooling period`,
        }[b.withdrawalPolicy] || 'no restrictions';
        return `• "${b.name}" — balance $${b.balance.toFixed(2)}${b.goal > 0 ? `, goal $${b.goal.toFixed(2)} (${pct}% there)` : ', no goal set'}, policy: ${policy}`;
      }).join('\n')
    : '• No piggy banks created yet.';

  const first       = user.name.split(' ')[0];
  const streakNote  = stats.currentStreak >= 3
    ? `${first} is on a ${stats.currentStreak}-day savings streak right now — acknowledge this positively when it comes up naturally.`
    : stats.currentStreak === 0
      ? `${first} hasn't saved anything yet today — gently encourage them without being preachy.`
      : '';

  return `You are Marcus — a warm, straight-talking personal finance advisor. You're like that friend everyone wishes they had: the one who actually works in finance and will give you a real, honest opinion over WhatsApp rather than a corporate spiel.

PERSONALITY:
- Conversational and direct. You use first names naturally but not in every sentence.
- You give concrete, specific advice — not vague platitudes.
- You're occasionally witty but never flippant about someone's financial situation.
- You never say "As an AI", "I'm a language model", "I cannot" or anything that sounds robotic. You are Marcus.
- You keep replies concise — this is a chat, not an essay. 2–4 short paragraphs maximum unless the user explicitly asks for detail.
- You don't use bullet points or markdown. Write like you're texting.
- You use their first name sparingly and naturally.
- When you don't know something, say so honestly like a human would.

YOUR CLIENT'S PROFILE:
Name: ${user.name}
Member since: ${new Date(user.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' })}
Total currently saved: $${stats.totalSaved.toFixed(2)}
Total deposited ever: $${stats.totalSavedEver.toFixed(2)}
Current savings streak: ${stats.currentStreak} day${stats.currentStreak !== 1 ? 's' : ''}
Longest streak ever: ${stats.longestStreak} days
Total deposits made: ${stats.totalDeposits}
Savings goals reached: ${stats.goalsMet}
Piggy banks: ${stats.bankCount}

THEIR PIGGY BANKS:
${bankSummary}

${streakNote}

GUIDANCE:
- Base advice on their actual numbers. Be specific.
- If they're close to a goal, call it out.
- Encourage streaks and consistency over big one-time deposits.
- If they seem discouraged, be honest but supportive — don't just cheerlead.
- Never invent numbers. If you need more info, ask one clear question.`;
}

/** POST /api/advisor/chat */
app.post('/api/advisor/chat', requireAuth, async (req, res) => {
  const GROQ_API_KEY = "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";
  if (!GROQ_API_KEY)
    return res.status(503).json({ error: 'Advisor is not configured. Set GROQ_API_KEY in your environment.' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  const userId = req.session.userId;
  const user   = db.getUserById(userId);
  const stats  = computeStats(userId);
  const banks  = db.getBanksByUser(userId);

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        max_tokens:  400,
        temperature: 0.75,
        messages: [
          { role: 'system', content: buildSystemPrompt(user, stats, banks) },
          ...messages.slice(-12),
        ],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      console.error('Groq error:', err);
      return res.status(502).json({ error: 'Marcus is unavailable right now. Try again in a moment.' });
    }

    const data  = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'Got an empty reply. Try again.' });

    res.json({ reply });
  } catch (err) {
    console.error('Advisor fetch error:', err);
    res.status(502).json({ error: 'Marcus is unavailable right now. Try again in a moment.' });
  }
});

// ── 404 ───────────────────────────────────────────────────────
app.use((_req, res) =>
  res.status(404).send('<h1>404 — Page not found</h1><a href="/">← Home</a>'));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐷  PiggyBank server running at http://localhost:${PORT}`);
  console.log(`    DB         → ${require('./db').constructor?.name || 'SQLite'} (piggybank.db)`);
  console.log(`    Landing    → http://localhost:${PORT}/`);
  console.log(`    Sign Up    → http://localhost:${PORT}/signup`);
  console.log(`    Dashboard  → http://localhost:${PORT}/dashboard  (auth required)\n`);
});

module.exports = app;

const app  = express();
const PORT = process.env.PORT || 3000;