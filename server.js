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


const app  = express();
const PORT = process.env.PORT || 3000;