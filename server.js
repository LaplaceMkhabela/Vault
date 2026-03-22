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

const app  = express();
const PORT = process.env.PORT || 3000;