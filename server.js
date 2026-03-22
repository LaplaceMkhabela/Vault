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


const app  = express();
const PORT = process.env.PORT || 3000;