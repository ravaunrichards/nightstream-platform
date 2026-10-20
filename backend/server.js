'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const {
  ALLOWED_CATEGORIES,
  isValidEmail,
  isStrongEnoughPassword,
  isAdultDateOfBirth,
  validUsername,
  normalizeVideoMetadata,
  validReportCategory
} = require('./validators');

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const publicDir = path.resolve(__dirname, '..', 'public');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const maxUploadBytes = Math.max(1_048_576, Number(process.env.MAX_UPLOAD_BYTES || 2_147_483_648));
const jwtSecret = process.env.JWT_SECRET || '';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: true } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

const allowedMimeTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const videoExtension = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, username: user.username }, jwtSecret, { expiresIn: '2h', issuer: 'nightstream' });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    emailVerified: Boolean(user.email_verified_at),
    ageAssuranceStatus: user.age_assurance_status,
    createdAt: user.created_at
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(match[1], jwtSecret, { issuer: 'nightstream' });
    req.auth = { userId: payload.sub, role: payload.role, username: payload.username };
    return next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function requireModerator(req, res, next) {
  if (!['moderator', 'admin'].includes(req.auth?.role)) {
    return res.status(403).json({ error: 'Moderator access is required.' });
  }
  return next();
}

function requireProductionConfiguration() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  if (isProduction) {
    if (process.env.AGE_ASSURANCE_DEV_BYPASS === 'true') throw new Error('AGE_ASSURANCE_DEV_BYPASS cannot be enabled in production.');
    if (!process.env.AGE_ASSURANCE_WEBHOOK_SECRET || process.env.AGE_ASSURANCE_WEBHOOK_SECRET.length < 32) {
      throw new Error('A strong AGE_ASSURANCE_WEBHOOK_SECRET is required in production.');
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required in production.');
    }
  }
}

function smtpTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  });
}

async function issueVerification(user) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 minutes\')',
    [user.id, sha256(raw)]
  );
  const baseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const url = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(raw)}`;
  const transport = smtpTransport();
  if (transport) {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'NightStream <no-reply@example.com>',
      to: user.email,
      subject: 'Verify your NightStream email',
      text: `Use this link within 30 minutes to verify your email: ${url}\n\nIf you did not create this account, you can ignore this message.`
    });
    return null;
  }
  if (isProduction) throw new Error('Email delivery is not configured.');
  console.info(`[development-only] Email verification URL for ${user.email}: ${url}`);
  return url;
}

function sniffVideoSignature(buffer, mime) {
  if (mime === 'video/webm') return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${videoExtension[file.mimetype] || '.bin'}`)
});
const videoUpload = multer({
  storage,
  limits: { fileSize: maxUploadBytes, files: 1, fields: 12, fieldSize: 10_000 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) return callback(new Error('Unsupported file type. Upload MP4, WebM, or MOV video only.'));
    callback(null, true);
  }
});

app.disable('x-powered-by');
app.set('trust proxy', isProduction ? 1 : false);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many account attempts. Try again later.' } });
const reportLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'nightstream-api', database: 'connected' });
}));

app.get('/api/config', (_req, res) => {
  res.json({
    brand: 'NightStream',
    categories: ALLOWED_CATEGORIES,
    maxUploadBytes,
    ageAssuranceConfigured: Boolean(process.env.AGE_ASSURANCE_WEBHOOK_SECRET),
    note: 'Age-assurance provider integration is required before public launch.'
  });
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  const dateOfBirth = req.body.dateOfBirth;
  const ageAttestation = req.body.ageAttestation === true || req.body.ageAttestation === 'yes';
  const termsAccepted = req.body.termsAccepted === true || req.body.termsAccepted === 'yes';
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validUsername(username)) return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, or underscores.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be 12–128 characters.' });
  if (!isAdultDateOfBirth(dateOfBirth)) return res.status(400).json({ error: 'Accounts are restricted to adults aged 18 or older.' });
  if (!ageAttestation || !termsAccepted) return res.status(400).json({ error: 'Confirm the adult-only terms and accept the platform terms to continue.' });

  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO users (email, username, password_hash, date_of_birth, terms_accepted_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, username, role, age_assurance_status, email_verified_at, created_at`,
      [email, username, passwordHash, dateOfBirth]
    );
    user = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'That email or username is already registered.' });
    throw error;
  } finally {
    client.release();
  }
  try {
    const developmentVerificationUrl = await issueVerification(user);
    return res.status(201).json({
      message: 'Account created. Verify your email before signing in. Age assurance is a separate required step before uploading.',
      ...(developmentVerificationUrl ? { developmentVerificationUrl } : {})
    });
  } catch (error) {
    console.error('Verification delivery error:', error.message);
    return res.status(201).json({ message: 'Account created, but verification email delivery needs configuration. Contact the platform operator.' });
  }
}));

app.get('/api/auth/verify-email', asyncRoute(async (req, res) => {
  const rawToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (rawToken.length < 30 || rawToken.length > 200) return res.status(400).send('Invalid or expired verification link.');
  const tokenHash = sha256(rawToken);
  const result = await pool.query(
    `UPDATE users SET email_verified_at = NOW(), updated_at = NOW()
     WHERE id = (SELECT user_id FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > NOW())
     RETURNING id`, [tokenHash]
  );
  if (!result.rowCount) return res.status(400).send('This verification link is invalid or expired. Please request a new account verification email.');
  await pool.query('DELETE FROM email_verification_tokens WHERE token_hash = $1 OR expires_at <= NOW()', [tokenHash]);
  return res.status(200).send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email verified</title><body style="font:16px system-ui;background:#11131a;color:#f8fafc;padding:3rem;max-width:40rem;margin:auto"><h1>Email verified</h1><p>Your NightStream email is verified. Return to the app and sign in. Adult age-assurance verification is still required before creator uploads can be submitted.</p><a style="color:#bda0ff" href="/">Return to NightStream</a></body></html>`);
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!isValidEmail(email) || password.length > 128) return res.status(400).json({ error: 'Enter your email and password.' });
  const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  const user = result.rows[0];
  const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!matches) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (!user.email_verified_at) return res.status(403).json({ error: 'Verify your email before signing in.' });
  const currentUser = publicUser(user);
  res.json({ token: createToken(user), user: currentUser });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id, email, username, role, age_assurance_status, email_verified_at, created_at FROM users WHERE id = $1',
    [req.auth.userId]
  );
  if (!result.rowCount) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({ user: publicUser(result.rows[0]) });
}));

// Generic server-to-server callback seam for an external age-assurance provider.
// The external provider must perform the legally appropriate check; this endpoint is not itself verification.
app.post('/api/age-assurance/webhook', asyncRoute(async (req, res) => {
  const secret = process.env.AGE_ASSURANCE_WEBHOOK_SECRET || '';
  if (secret.length < 32 || !safeEqual(req.get('x-age-assurance-secret') || '', secret)) {
    return res.status(401).json({ error: 'Unauthorized provider callback.' });
  }
  const { userId, status, provider, providerReference } = req.body || {};
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || '')) || !['pending', 'verified', 'rejected'].includes(status) || typeof provider !== 'string' || provider.length < 2 || provider.length > 100) {
    return res.status(400).json({ error: 'Invalid callback payload.' });
  }
  const result = await pool.query(
    'UPDATE users SET age_assurance_status = $1, updated_at = NOW() WHERE id = $2 RETURNING id', [status, userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Account not found.' });
  await pool.query(
    'INSERT INTO age_assurance_events (user_id, provider, provider_reference, status) VALUES ($1, $2, $3, $4)',
    [userId, provider, typeof providerReference === 'string' ? providerReference.slice(0, 250) : null, status]
  );
  res.json({ accepted: true });
}));

app.get('/api/videos', asyncRoute(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 24, 1), 60);
  const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, 0), 100_000);
  const params = [];
  let where = "v.status = 'published'";
  if (query) {
    params.push(query);
    where += ` AND (v.title ILIKE '%' || $${params.length} || '%' OR v.description ILIKE '%' || $${params.length} || '%' OR EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE t ILIKE '%' || $${params.length} || '%'))`;
  }
  if (category && ALLOWED_CATEGORIES.includes(category)) {
    params.push(category);
    where += ` AND v.category = $${params.length}`;
  }
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT v.id, v.title, v.description, v.category, v.tags, v.created_at,
            u.username AS creator
     FROM videos v JOIN users u ON u.id = v.uploaded_by
     WHERE ${where} ORDER BY v.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ videos: result.rows, limit, offset });
}));

app.get('/api/videos/:id', asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID.' });
  const result = await pool.query(
    `SELECT v.id, v.title, v.description, v.category, v.tags, v.created_at, u.username AS creator
     FROM videos v JOIN users u ON u.id = v.uploaded_by WHERE v.id = $1 AND v.status = 'published'`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Video not found.' });
  res.json({ video: result.rows[0] });
}));

app.get('/api/videos/:id/stream', asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).end();
  const result = await pool.query("SELECT storage_key, mime_type, file_size_bytes FROM videos WHERE id = $1 AND status = 'published'", [req.params.id]);
  if (!result.rowCount) return res.status(404).end();
  const video = result.rows[0];
  const resolved = path.resolve(uploadDir, path.basename(video.storage_key));
  if (!resolved.startsWith(`${uploadDir}${path.sep}`)) return res.status(404).end();
  let stats;
  try { stats = await fsp.stat(resolved); } catch { return res.status(404).end(); }
  const total = stats.size;
  const rangeHeader = req.headers.range;
  res.setHeader('Content-Type', video.mime_type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!rangeHeader) {
    res.setHeader('Content-Length', total);
    return fs.createReadStream(resolved).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return res.status(416).set('Content-Range', `bytes */${total}`).end();
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start)) {
    const suffixLength = end;
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else if (Number.isNaN(end)) {
    end = total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
    return res.status(416).set('Content-Range', `bytes */${total}`).end();
  }
  end = Math.min(end, total - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  return fs.createReadStream(resolved, { start, end }).pipe(res);
}));

app.post('/api/videos/upload', requireAuth, asyncRoute(async (req, res, next) => {
  const userResult = await pool.query('SELECT id, email_verified_at, age_assurance_status FROM users WHERE id = $1', [req.auth.userId]);
  if (!userResult.rowCount) return res.status(401).json({ error: 'Account no longer exists.' });
  const user = userResult.rows[0];
  if (!user.email_verified_at) return res.status(403).json({ error: 'Verify your email before uploading.' });
  const localBypass = !isProduction && process.env.AGE_ASSURANCE_DEV_BYPASS === 'true';
  if (user.age_assurance_status !== 'verified' && !localBypass) {
    return res.status(403).json({ error: 'Creator uploads are locked until an approved age-assurance provider verifies the account. A date-of-birth checkbox alone is not sufficient.' });
  }
  return videoUpload.single('video')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Video exceeds the configured ${Math.floor(maxUploadBytes / (1024 * 1024))} MB upload limit.` });
      return res.status(400).json({ error: uploadError.message || 'Unable to accept this file.' });
    }
    let createdFilePath;
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose a video file.' });
      createdFilePath = req.file.path;
      const metadata = normalizeVideoMetadata(req.body);
      if (metadata.error) return res.status(400).json({ error: metadata.error });
      if (req.body.rightsAttested !== 'yes' || req.body.performersAdults !== 'yes' || req.body.performerConsent !== 'yes') {
        return res.status(400).json({ error: 'Confirm ownership or authorization, every depicted performer is an adult, and documented informed consent is retained.' });
      }
      const handle = await fsp.open(req.file.path, 'r');
      const signature = Buffer.alloc(16);
      const read = await handle.read(signature, 0, signature.length, 0);
      await handle.close();
      if (!sniffVideoSignature(signature.subarray(0, read.bytesRead), req.file.mimetype)) {
        return res.status(400).json({ error: 'The file signature does not match an accepted video format.' });
      }
      const result = await pool.query(
        `INSERT INTO videos (uploaded_by, title, description, category, tags, storage_key, mime_type,
         file_size_bytes, creator_rights_attested_at, consent_documentation_confirmed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), TRUE)
         RETURNING id, title, status, created_at`,
        [req.auth.userId, metadata.value.title, metadata.value.description, metadata.value.category,
          metadata.value.tags, path.basename(req.file.filename), req.file.mimetype, req.file.size]
      );
      createdFilePath = null;
      res.status(201).json({ message: 'Video submitted for moderation. It is not publicly listed while review is pending.', video: result.rows[0] });
    } catch (error) {
      next(error);
    } finally {
      if (createdFilePath) await fsp.unlink(createdFilePath).catch(() => {});
    }
  });
}));

app.get('/api/me/videos', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, title, category, status, moderation_note, created_at, reviewed_at
     FROM videos WHERE uploaded_by = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.auth.userId]
  );
  res.json({ videos: result.rows });
}));

app.delete('/api/me/videos/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID.' });
  const result = await pool.query(
    `UPDATE videos SET status = 'removed', updated_at = NOW()
     WHERE id = $1 AND uploaded_by = $2 AND status <> 'removed' RETURNING id`,
    [req.params.id, req.auth.userId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Video not found or already removed.' });
  res.json({ removed: true });
}));

app.post('/api/reports', reportLimiter, asyncRoute(async (req, res) => {
  const videoId = typeof req.body.videoId === 'string' && /^[0-9a-f-]{36}$/i.test(req.body.videoId) ? req.body.videoId : null;
  const category = req.body.category;
  const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
  const contactEmail = typeof req.body.contactEmail === 'string' && isValidEmail(req.body.contactEmail.trim()) ? req.body.contactEmail.trim().toLowerCase() : null;
  if (!validReportCategory(category)) return res.status(400).json({ error: 'Choose a valid report category.' });
  if (details.length < 10 || details.length > 2000) return res.status(400).json({ error: 'Details must be 10–2,000 characters.' });
  if (req.body.videoId && !videoId) return res.status(400).json({ error: 'Invalid video ID.' });
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  let reporterId = null;
  if (token) {
    try { reporterId = jwt.verify(token[1], jwtSecret, { issuer: 'nightstream' }).sub; } catch { reporterId = null; }
  }
  const result = await pool.query(
    `INSERT INTO reports (video_id, reporter_user_id, category, details, contact_email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
    [videoId, reporterId, category, details, contactEmail]
  );
  res.status(201).json({ message: 'Report received. The moderation team can review it.', report: result.rows[0] });
}));

app.get('/api/moderation/videos', requireAuth, requireModerator, asyncRoute(async (req, res) => {
  const status = ['pending_review', 'published', 'rejected', 'removed'].includes(req.query.status) ? req.query.status : 'pending_review';
  const result = await pool.query(
    `SELECT v.id, v.title, v.description, v.category, v.tags, v.mime_type, v.file_size_bytes,
            v.status, v.created_at, u.username AS creator, u.email AS creator_email
     FROM videos v JOIN users u ON u.id = v.uploaded_by WHERE v.status = $1
     ORDER BY v.created_at ASC LIMIT 100`, [status]
  );
  res.json({ videos: result.rows });
}));

app.get('/api/moderation/reports', requireAuth, requireModerator, asyncRoute(async (req, res) => {
  const status = ['open', 'investigating', 'actioned', 'closed'].includes(req.query.status) ? req.query.status : 'open';
  const result = await pool.query(
    `SELECT r.id, r.video_id, r.category, r.details, r.contact_email, r.status, r.created_at,
            v.title AS video_title
     FROM reports r LEFT JOIN videos v ON v.id = r.video_id
     WHERE r.status = $1 ORDER BY r.created_at ASC LIMIT 100`, [status]
  );
  res.json({ reports: result.rows });
}));

app.patch('/api/moderation/videos/:id', requireAuth, requireModerator, asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID.' });
  const action = req.body.action;
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
  if (!['publish', 'reject', 'remove'].includes(action)) return res.status(400).json({ error: 'Choose publish, reject, or remove.' });
  const nextStatus = { publish: 'published', reject: 'rejected', remove: 'removed' }[action];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE videos SET status = $1, moderation_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND status <> 'removed' RETURNING id, status`, [nextStatus, note || null, req.auth.userId, req.params.id]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Video not found or already removed.' });
    }
    await client.query(
      `INSERT INTO moderation_audit_log (moderator_user_id, target_type, target_id, action, note)
       VALUES ($1, 'video', $2, $3, $4)`, [req.auth.userId, req.params.id, action, note || null]
    );
    await client.query('COMMIT');
    res.json({ video: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.patch('/api/moderation/reports/:id', requireAuth, requireModerator, asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid report ID.' });
  const status = req.body.status;
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
  if (!['investigating', 'actioned', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid report status.' });
  const result = await pool.query(
    `UPDATE reports SET status = $1, assigned_to = $2, resolution_note = $3, updated_at = NOW()
     WHERE id = $4 RETURNING id, status`, [status, req.auth.userId, note || null, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Report not found.' });
  await pool.query(
    `INSERT INTO moderation_audit_log (moderator_user_id, target_type, target_id, action, note)
     VALUES ($1, 'report', $2, $3, $4)`, [req.auth.userId, req.params.id, status, note || null]
  );
  res.json({ report: result.rows[0] });
}));

app.use(express.static(publicDir, { extensions: ['html'], maxAge: isProduction ? '1h' : 0, etag: true }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Uploaded file is too large.' });
  if (error.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, error.stack || error.message || error);
  res.status(500).json({ error: 'Unexpected server error. Check the server logs for the request ID/time.' });
});

async function start() {
  requireProductionConfiguration();
  await fsp.mkdir(uploadDir, { recursive: true });
  await pool.query('SELECT 1');
  app.listen(port, () => console.log(`NightStream listening on http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { app, sniffVideoSignature, safeEqual };
