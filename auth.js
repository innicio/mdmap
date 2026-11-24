const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const DATA_DIR = path.resolve(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const COOKIE_NAME = 'mdmap_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, keyHex] = String(stored || '').split(':');
  if (!salt || !keyHex) return false;
  const derived = await scryptAsync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
    isProd ? 'Secure' : ''
  ].filter(Boolean);
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const flags = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
    isProd ? 'Secure' : ''
  ].filter(Boolean);
  res.setHeader('Set-Cookie', flags.join('; '));
}

async function ensureAdminUser() {
  const users = readJson(USERS_FILE, []);
  if (users.length > 0) return users[0];

  const username = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('Define ADMIN_PASSWORD (mínimo 8 caracteres) en .env para crear la cuenta admin inicial.');
  }

  const admin = {
    id: 'usr_admin',
    username,
    role: 'admin',
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };
  writeJsonAtomic(USERS_FILE, [admin]);
  return admin;
}

function createSession(user) {
  const sessions = readJson(SESSIONS_FILE, {});
  const now = Date.now();
  // Limpiar sesiones expiradas
  for (const [sid, s] of Object.entries(sessions)) {
    if (!s || s.expiresAt < now) delete sessions[sid];
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    userId: user.id,
    username: user.username,
    role: user.role,
    expiresAt: now + SESSION_TTL_MS
  };
  writeJsonAtomic(SESSIONS_FILE, sessions);
  return token;
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const sessions = readJson(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session || session.expiresAt < Date.now()) return null;
  return { token, ...session };
}

function destroySession(token) {
  if (!token) return;
  const sessions = readJson(SESSIONS_FILE, {});
  if (sessions[token]) {
    delete sessions[token];
    writeJsonAtomic(SESSIONS_FILE, sessions);
  }
}

async function loginUser(usernameRaw, password) {
  const username = String(usernameRaw || '').trim().toLowerCase();
  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.username === username);
  if (!user) return null;
  const ok = await verifyPassword(String(password || ''), user.passwordHash);
  return ok ? user : null;
}

function createInvite(createdBy, note = '') {
  const invites = readJson(INVITES_FILE, []);
  const code = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 caracteres hex
  const invite = {
    code,
    createdBy,
    note: String(note || '').slice(0, 60),
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null
  };
  invites.push(invite);
  writeJsonAtomic(INVITES_FILE, invites);
  return invite;
}

function listInvites() {
  return readJson(INVITES_FILE, []);
}

async function registerWithInvite(usernameRaw, password, codeRaw) {
  const username = String(usernameRaw || '').trim().toLowerCase();
  const code = String(codeRaw || '').trim().toUpperCase();

  if (!USERNAME_RE.test(username)) {
    return { error: 'Usuario inválido (3-24 caracteres: letras, números, _ o -).' };
  }
  if (typeof password !== 'string' || password.length < 8) {
    return { error: 'La contraseña debe tener al menos 8 caracteres.' };
  }

  const invites = readJson(INVITES_FILE, []);
  const invite = invites.find((i) => i.code === code && !i.usedBy);
  if (!invite) {
    return { error: 'Código de invitación inválido o ya utilizado.' };
  }

  const users = readJson(USERS_FILE, []);
  if (users.some((u) => u.username === username)) {
    return { error: 'Ese nombre de usuario ya existe.' };
  }

  const user = {
    id: `usr_${crypto.randomBytes(8).toString('hex')}`,
    username,
    role: 'user',
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };

  users.push(user);
  invite.usedBy = username;
  invite.usedAt = new Date().toISOString();

  writeJsonAtomic(USERS_FILE, users);
  writeJsonAtomic(INVITES_FILE, invites);

  return { user };
}

function requireAuth(req, res, next) {
  const session = getSessionFromReq(req);
  if (!session) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/images/')) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/login.html');
  }
  req.user = { id: session.userId, username: session.username, role: session.role };
  req.sessionToken = session.token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo administrador' });
  }
  next();
}

async function changePassword(userId, currentPassword, newPassword, keepSessionToken = null) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return { error: 'La nueva contraseña debe tener al menos 8 caracteres.' };
  }

  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.id === userId);
  if (!user) return { error: 'Usuario no encontrado.' };

  const ok = await verifyPassword(String(currentPassword || ''), user.passwordHash);
  if (!ok) return { error: 'La contraseña actual no es correcta.' };

  user.passwordHash = await hashPassword(newPassword);
  user.passwordUpdatedAt = new Date().toISOString();
  writeJsonAtomic(USERS_FILE, users);

  // Revocar el resto de sesiones activas del usuario (manteniendo la actual)
  const sessions = readJson(SESSIONS_FILE, {});
  let changed = false;
  for (const [sid, s] of Object.entries(sessions)) {
    if (s && s.userId === userId && sid !== keepSessionToken) {
      delete sessions[sid];
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(SESSIONS_FILE, sessions);

  return { ok: true };
}

module.exports = {
  ensureAdminUser,
  createSession,
  getSessionFromReq,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  loginUser,
  createInvite,
  listInvites,
  registerWithInvite,
  requireAuth,
  requireAdmin,
  changePassword
};