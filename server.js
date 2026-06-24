const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const http = require('http');
const nodemailer = require('nodemailer');
const multer = require('multer');

const mailTransporter = nodemailer.createTransport({
  host: 'mail.s452.sureserver.com',
  port: 465,
  secure: true,
  auth: {
    user: 'support@chatbot360.ca',
    pass: 'bmMyR54AkUNojBQr2PUX'
  }
});

const app = express();
const PORT = 3000;

const DB_PATH = path.join(__dirname, 'data', 'submissions.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_type TEXT NOT NULL,
    form_data TEXT NOT NULL,
    submitted_at DATETIME DEFAULT (datetime('now','localtime')),
    ip_address TEXT,
    read_status INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    referrer TEXT,
    source TEXT DEFAULT 'direct',
    device TEXT DEFAULT 'desktop',
    browser TEXT,
    os TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    screen_w INTEGER,
    screen_h INTEGER,
    duration INTEGER DEFAULT 0,
    ip_address TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sessions_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    first_page TEXT,
    pages_viewed INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    device TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    ip_address TEXT,
    started_at DATETIME DEFAULT (datetime('now','localtime')),
    last_seen DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_pv_session ON page_views(session_id);
  CREATE INDEX IF NOT EXISTS idx_pv_path ON page_views(path);
  CREATE INDEX IF NOT EXISTS idx_sa_session ON sessions_analytics(session_id);
  CREATE INDEX IF NOT EXISTS idx_sa_last ON sessions_analytics(last_seen);

  CREATE TABLE IF NOT EXISTS borrowers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    town TEXT,
    province TEXT DEFAULT 'AB',
    brand TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS borrower_submissions (
    borrower_id INTEGER NOT NULL,
    submission_id INTEGER NOT NULL,
    linked_at DATETIME DEFAULT (datetime('now','localtime')),
    linked_by TEXT,
    PRIMARY KEY (borrower_id, submission_id),
    FOREIGN KEY (borrower_id) REFERENCES borrowers(id),
    FOREIGN KEY (submission_id) REFERENCES submissions(id)
  );
  CREATE TABLE IF NOT EXISTS borrower_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id INTEGER NOT NULL,
    staff_name TEXT NOT NULL,
    content TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (borrower_id) REFERENCES borrowers(id)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id INTEGER,
    submission_id INTEGER,
    staff_name TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_bs_borrower ON borrower_submissions(borrower_id);
  CREATE INDEX IF NOT EXISTS idx_bs_submission ON borrower_submissions(submission_id);
  CREATE INDEX IF NOT EXISTS idx_bn_borrower ON borrower_notes(borrower_id);
  CREATE INDEX IF NOT EXISTS idx_al_borrower ON activity_log(borrower_id);
  CREATE INDEX IF NOT EXISTS idx_al_created ON activity_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_borrowers_name ON borrowers(name);
`);

// Schema migrations
try { db.exec("ALTER TABLE admin_users ADD COLUMN display_name TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'staff'"); } catch(e) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN status TEXT DEFAULT 'active'"); } catch(e) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN last_login DATETIME"); } catch(e) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN admin_access INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN hub_access INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE borrowers ADD COLUMN pipeline_status TEXT DEFAULT 'form_received'"); } catch(e) {}
try { db.exec("ALTER TABLE submissions ADD COLUMN form_status TEXT DEFAULT 'new'"); } catch(e) {}
db.prepare("UPDATE admin_users SET role = 'super_admin', admin_access = 1, hub_access = 1, display_name = CASE WHEN display_name = '' OR display_name IS NULL THEN username ELSE display_name END WHERE username = 'admin'").run();

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ts = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${ts}-${safe}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|pdf|doc|docx|xls|xlsx|txt|heic|heif|webp)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('File type not allowed'), false);
  }
});

const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM admin_users').get();
if (adminCount.cnt === 0) {
  const hash = bcrypt.hashSync('FoothillsAdmin2026!', 10);
  db.prepare('INSERT INTO admin_users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?)').run('admin', hash, 'Admin', 'super_admin', 'active');
}

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(session({
  secret: 'foothills-livestock-2026-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  if (req.path.startsWith('/hub')) return res.redirect('/hub/login');
  res.redirect('/admin/login');
}

function requireAdminAccess(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/admin/login');
  }
  if (!req.session.adminAccess && req.session.role !== 'super_admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'No admin panel access' });
    return res.redirect('/admin/login?error=no_access');
  }
  next();
}

function requireHubAccess(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/hub/login');
  }
  if (!req.session.hubAccess && req.session.role !== 'super_admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'No hub access' });
    return res.redirect('/hub/login?error=no_access');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.role === 'super_admin') return next();
  res.status(403).json({ error: 'Super admin access required' });
}

// Chatbot API proxy — forwards /chatbot-api/* to the Contabo chatbot server
app.all('/chatbot-api/*', (req, res) => {
  const targetPath = req.originalUrl.replace('/chatbot-api', '') || '/';
  const postData = req.method === 'POST' ? JSON.stringify(req.body) : null;
  const opts = {
    hostname: '82.208.20.60',
    port: 8002,
    path: targetPath,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
    }
  };

  const isSSE = targetPath.includes('/chat/stream');
  if (isSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  const proxyReq = http.request(opts, (proxyRes) => {
    if (!isSSE) {
      res.status(proxyRes.statusCode);
      Object.entries(proxyRes.headers).forEach(([k, v]) => {
        if (!['transfer-encoding', 'connection'].includes(k.toLowerCase())) res.setHeader(k, v);
      });
    }
    proxyRes.on('data', (chunk) => res.write(chunk));
    proxyRes.on('end', () => res.end());
  });

  proxyReq.on('error', (err) => {
    console.error('Chatbot proxy error:', err.message);
    res.status(502).json({ error: 'Chatbot service unavailable' });
  });

  proxyReq.setTimeout(120000, () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'Chatbot timeout' });
  });

  if (postData) proxyReq.write(postData);
  proxyReq.end();
});

// Form submission endpoint (supports JSON or multipart with file attachments)
app.post('/api/submit', (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    upload.array('attachments', 5)(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'File too large (max 10MB each)' });
          if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ success: false, error: 'Too many files (max 5)' });
        }
        return res.status(400).json({ success: false, error: err.message || 'Upload error' });
      }
      handleSubmission(req, res);
    });
  } else {
    handleSubmission(req, res);
  }
});

function handleSubmission(req, res) {
  try {
    const formType = req.body.form_type || req.body.form_name || 'unknown';
    const formData = { ...req.body };
    delete formData.html;

    const uploadedFiles = (req.files || []).map(f => ({
      original: f.originalname,
      stored: f.filename,
      size: f.size,
      mime: f.mimetype
    }));
    if (uploadedFiles.length) formData.attachments = uploadedFiles;

    const stmt = db.prepare('INSERT INTO submissions (form_type, form_data, ip_address) VALUES (?, ?, ?)');
    const result = stmt.run(formType, JSON.stringify(formData), req.headers['x-real-ip'] || req.ip);

    if (req.body.html) {
      let formHtml = req.body.html;
      const sig = formData.signature || '';
      if (sig.startsWith('data:image/')) {
        formHtml = formHtml.replace(/<canvas\s+id="sigCanvas1"[^>]*><\/canvas>/i,
          `<img src="${sig}" style="display:block;width:100%;max-height:120px;object-fit:contain;border:1px solid #e0d5c8;border-radius:8px;background:#fff">`);
      }
      const safeName = formType.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
      const dir = path.join(__dirname, 'data', 'forms');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${safeName}-${result.lastInsertRowid}.html`), formHtml);
    }

    const applicantName = formData.name || formData.applicant_name || formData.full_name || formData.first_name || 'N/A';
    const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' });

    const attachmentRows = uploadedFiles.length
      ? `<tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Attachments</td><td style="padding:8px 12px;">${uploadedFiles.map(f => f.original).join(', ')} (${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''})</td></tr>`
      : '';

    const sigData = formData.signature || '';
    const signatureRow = sigData.startsWith('data:image/')
      ? `<tr><td style="padding:8px 12px;font-weight:bold;color:#555;">Signature</td><td style="padding:8px 12px;"><img src="${sigData}" style="max-width:300px;max-height:120px;border:1px solid #ddd;border-radius:4px;"></td></tr>`
      : '';

    const emailAttachments = uploadedFiles.map(f => ({
      filename: f.original,
      path: path.join(UPLOADS_DIR, f.stored)
    }));

    mailTransporter.sendMail({
      from: '"Foothills Livestock" <support@chatbot360.ca>',
      to: 'admin@sitebuilder360.com, frontdesk@foothillslivestock.ca',
      subject: `New Form Submission: ${formType}${uploadedFiles.length ? ` (${uploadedFiles.length} attachment${uploadedFiles.length > 1 ? 's' : ''})` : ''}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#2d5016;border-bottom:2px solid #2d5016;padding-bottom:10px;">New Form Submission</h2>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;width:140px;">Form Type</td><td style="padding:8px 12px;">${formType}</td></tr>
            <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Applicant Name</td><td style="padding:8px 12px;">${applicantName}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;">Submitted At</td><td style="padding:8px 12px;">${submittedAt}</td></tr>
            <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Submission ID</td><td style="padding:8px 12px;">#${result.lastInsertRowid}</td></tr>
            ${attachmentRows}
            ${signatureRow}
          </table>
          <a href="https://foothills.cloud360.ca/admin" style="display:inline-block;background:#2d5016;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;margin-top:10px;">View in Admin Panel</a>
        </div>`,
      attachments: emailAttachments
    }).then(() => {
      console.log(`Email notification sent for submission #${result.lastInsertRowid}` + (uploadedFiles.length ? ` with ${uploadedFiles.length} attachment(s)` : ''));
    }).catch((err) => {
      console.error('Email notification failed:', err.message);
    });

    const applicantEmail = formData.email || formData.applicant_email || formData.contact_email || '';
    if (applicantEmail && applicantEmail.includes('@')) {
      const friendlyType = formType.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      mailTransporter.sendMail({
        from: '"Foothills Livestock Co-op" <support@chatbot360.ca>',
        to: applicantEmail,
        subject: 'We\'ve received your submission — Foothills Livestock Co-op',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fffaf3;border:1px solid #e8e0d2;border-radius:8px;overflow:hidden;">
            <div style="background:linear-gradient(135deg,#6b3f1f,#8c5b31);padding:28px 32px;text-align:center;">
              <img src="https://foothills.cloud360.ca/assets/foothills-logo.png?v=3" alt="Foothills Livestock Co-op" style="height:50px;margin:0 auto;">
            </div>
            <div style="padding:32px;">
              <h2 style="color:#6b3f1f;margin:0 0 16px;font-size:1.3rem;">Thank you, ${applicantName}!</h2>
              <p style="color:#4f4a40;line-height:1.7;margin:0 0 20px;font-size:1rem;">We have received your <strong>${friendlyType}</strong> submission${uploadedFiles.length ? ' along with your ' + uploadedFiles.length + ' attached file' + (uploadedFiles.length > 1 ? 's' : '') : ''}. A member of our team will review it and be in touch with you shortly.</p>
              <div style="background:#f6f1e8;border-left:4px solid #c89a52;padding:16px 20px;border-radius:0 8px 8px 0;margin:0 0 20px;">
                <p style="color:#6b3f1f;margin:0 0 4px;font-weight:700;font-size:.9rem;">Submission Details</p>
                <p style="color:#4f4a40;margin:0;font-size:.95rem;">Form: ${friendlyType}<br>Reference: #${result.lastInsertRowid}<br>Date: ${submittedAt}</p>
              </div>
              <p style="color:#8c7a6a;font-size:.9rem;line-height:1.6;margin:0 0 24px;">If you need immediate assistance, please call us at <strong>403-845-6669</strong> (Toll Free: 1-866-848-6669) during office hours: Monday to Friday, 9:00 AM - 4:00 PM.</p>
              <hr style="border:none;border-top:1px solid #e8e0d2;margin:20px 0;">
              <p style="color:#a09888;font-size:.82rem;margin:0;text-align:center;">Foothills Livestock Co-op &bull; Box 725, Rocky Mountain House, AB T4T 1A5</p>
            </div>
          </div>`
      }).then(() => {
        console.log(`Confirmation email sent to ${applicantEmail} for submission #${result.lastInsertRowid}`);
      }).catch((err) => {
        console.error('Confirmation email failed:', err.message);
      });
    }

    res.json({ success: true, id: result.lastInsertRowid });

    // Auto-link this submission to a borrower immediately
    try { const n = autoLinkSubmissions(); if (n > 0) console.log(`Auto-linked ${n} new submission(s)`); } catch(e) { console.error('Auto-link error:', e.message); }
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// Contact form submission endpoint
app.post('/api/contact', (req, res) => {
  try {
    const { name, phone, email, inquiry_type, message } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }

    const formData = { name, phone: phone || '', email, inquiry_type: inquiry_type || 'General Inquiry', message: message || '' };
    const stmt = db.prepare('INSERT INTO submissions (form_type, form_data, ip_address) VALUES (?, ?, ?)');
    const result = stmt.run('contact-form', JSON.stringify(formData), req.headers['x-real-ip'] || req.ip);

    const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' });

    // Send admin notification
    mailTransporter.sendMail({
      from: '"Foothills Livestock" <support@chatbot360.ca>',
      to: 'admin@sitebuilder360.com, frontdesk@foothillslivestock.ca',
      subject: `New Contact Form: ${name} — ${inquiry_type || 'General Inquiry'}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#6b3f1f;border-bottom:2px solid #c89a52;padding-bottom:10px;">New Contact Form Submission</h2>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;width:140px;">Name</td><td style="padding:8px 12px;">${name}</td></tr>
            <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Phone</td><td style="padding:8px 12px;">${phone || 'N/A'}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;">Email</td><td style="padding:8px 12px;">${email}</td></tr>
            <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Inquiry Type</td><td style="padding:8px 12px;">${inquiry_type || 'General Inquiry'}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;">Message</td><td style="padding:8px 12px;">${message || 'N/A'}</td></tr>
            <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#555;">Submitted At</td><td style="padding:8px 12px;">${submittedAt}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;color:#555;">Submission ID</td><td style="padding:8px 12px;">#${result.lastInsertRowid}</td></tr>
          </table>
          <a href="https://foothills.cloud360.ca/admin" style="display:inline-block;background:#6b3f1f;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px;margin-top:10px;">View in Admin Panel</a>
        </div>`
    }).then(() => {
      console.log(`Admin notification sent for contact #${result.lastInsertRowid}`);
    }).catch((err) => {
      console.error('Admin contact email failed:', err.message);
    });

    // Send confirmation to customer
    mailTransporter.sendMail({
      from: '"Foothills Livestock Co-op" <support@chatbot360.ca>',
      to: email,
      subject: 'Thank you for contacting Foothills Livestock Co-op',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fffaf3;border:1px solid #e8e0d2;border-radius:8px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#6b3f1f,#8c5b31);padding:28px 32px;text-align:center;">
            <img src="https://foothills.cloud360.ca/assets/foothills-logo.png?v=3" alt="Foothills Livestock Co-op" style="height:50px;margin:0 auto;">
          </div>
          <div style="padding:32px;">
            <h2 style="color:#6b3f1f;margin:0 0 16px;font-size:1.3rem;">Thank you, ${name}!</h2>
            <p style="color:#4f4a40;line-height:1.7;margin:0 0 20px;font-size:1rem;">Thank you for contacting Foothills Livestock Co-op. We have received your message and will be contacting you shortly.</p>
            <div style="background:#f6f1e8;border-left:4px solid #c89a52;padding:16px 20px;border-radius:0 8px 8px 0;margin:0 0 20px;">
              <p style="color:#6b3f1f;margin:0 0 4px;font-weight:700;font-size:.9rem;">Your Inquiry</p>
              <p style="color:#4f4a40;margin:0;font-size:.95rem;">${inquiry_type || 'General Inquiry'}</p>
            </div>
            <p style="color:#8c7a6a;font-size:.9rem;line-height:1.6;margin:0 0 24px;">If you need immediate assistance, please call us at <strong>403-845-6669</strong> (Toll Free: 1-866-848-6669) during office hours: Monday to Friday, 9:00 AM - 4:00 PM.</p>
            <hr style="border:none;border-top:1px solid #e8e0d2;margin:20px 0;">
            <p style="color:#a09888;font-size:.82rem;margin:0;text-align:center;">Foothills Livestock Co-op &bull; Box 725, Rocky Mountain House, AB T4T 1A5</p>
          </div>
        </div>`
    }).then(() => {
      console.log(`Confirmation email sent to ${email} for contact #${result.lastInsertRowid}`);
    }).catch((err) => {
      console.error('Customer confirmation email failed:', err.message);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Contact submit error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Admin login page
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.userId && (req.session.adminAccess || req.session.role === 'super_admin')) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Hub login page
app.get('/hub/login', (req, res) => {
  if (req.session && req.session.userId && (req.session.hubAccess || req.session.role === 'super_admin')) return res.redirect('/hub');
  res.sendFile(path.join(__dirname, 'views', 'hub-login.html'));
});

app.post('/api/admin/login', (req, res) => {
  const { username, password, target } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  if (user.status === 'removed') return res.status(403).json({ error: 'Account has been deactivated.' });

  const isSuper = user.role === 'super_admin';
  const hasAdminAccess = isSuper || (user.admin_access === 1);
  const hasHubAccess = isSuper || (user.hub_access === 1);

  if (target === 'hub' && !hasHubAccess) {
    return res.status(403).json({ error: 'You do not have access to the Borrower Hub. Contact your administrator.' });
  }
  if (target === 'admin' && !hasAdminAccess) {
    return res.status(403).json({ error: 'You do not have access to the Admin Panel. Contact your administrator.' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.displayName = user.display_name || user.username;
  req.session.role = user.role || 'staff';
  req.session.adminAccess = hasAdminAccess;
  req.session.hubAccess = hasHubAccess;
  db.prepare("UPDATE admin_users SET last_login = datetime('now','localtime') WHERE id = ?").run(user.id);

  const redirect = target === 'hub' ? '/hub' : '/admin';
  res.json({ success: true, role: req.session.role, displayName: req.session.displayName, adminAccess: hasAdminAccess, hubAccess: hasHubAccess, redirect });
});

app.post('/api/admin/logout', (req, res) => {
  const wasHub = req.body && req.body.from === 'hub';
  req.session.destroy();
  res.json({ success: true, redirect: wasHub ? '/hub/login' : '/admin/login' });
});

// Admin dashboard
app.get('/admin', requireAdminAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Get submissions with filtering
app.get('/api/admin/submissions', requireAdminAccess, (req, res) => {
  const { form_type, search, start_date, end_date, page = 1, limit = 25 } = req.query;
  let where = [];
  let params = [];

  if (form_type && form_type !== 'all') {
    where.push('form_type = ?');
    params.push(form_type);
  }
  if (search) {
    where.push('form_data LIKE ?');
    params.push(`%${search}%`);
  }
  if (start_date) {
    where.push('submitted_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    where.push('submitted_at <= ?');
    params.push(end_date + ' 23:59:59');
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM submissions ${whereClause}`).get(...params);
  const rows = db.prepare(`SELECT * FROM submissions ${whereClause} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);

  const parsed = rows.map(r => ({
    ...r,
    form_data: JSON.parse(r.form_data)
  }));

  res.json({
    submissions: parsed,
    total: total.cnt,
    page: parseInt(page),
    pages: Math.ceil(total.cnt / limit)
  });
});

// Get single submission
app.get('/api/admin/submissions/:id', requireAdminAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.read_status) {
    db.prepare('UPDATE submissions SET read_status = 1 WHERE id = ?').run(req.params.id);
  }
  const hasFile = (() => {
    const safeName = (row.form_type || '').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
    const fp = path.join(__dirname, 'data', 'forms', `${safeName}-${row.id}.html`);
    return fs.existsSync(fp);
  })();
  res.json({ ...row, form_data: JSON.parse(row.form_data), has_form_file: hasFile });
});

// Download filled form HTML
app.get('/api/admin/submissions/:id/form', requireAdminAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const safeName = (row.form_type || '').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
  const fp = path.join(__dirname, 'data', 'forms', `${safeName}-${row.id}.html`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Form file not found' });
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename=${safeName}-${row.id}.html`);
  res.sendFile(fp);
});

// Download attachment from a submission
app.get('/api/admin/submissions/:id/attachment/:filename', requireAdminAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const data = JSON.parse(row.form_data);
  const attachments = data.attachments || [];
  const file = attachments.find(a => a.stored === req.params.filename);
  if (!file) return res.status(404).json({ error: 'Attachment not found' });
  const fp = path.join(UPLOADS_DIR, file.stored);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing from disk' });
  res.setHeader('Content-Disposition', `attachment; filename="${file.original}"`);
  res.sendFile(fp);
});

// Delete submission
app.delete('/api/admin/submissions/:id', requireAdminAccess, (req, res) => {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Import submission to hub (from admin panel)
app.post('/api/admin/submissions/:id/import-to-hub', requireAdminAccess, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  const alreadyLinked = db.prepare('SELECT borrower_id FROM borrower_submissions WHERE submission_id = ?').get(sub.id);
  if (alreadyLinked) {
    const borrower = db.prepare('SELECT name FROM borrowers WHERE id = ?').get(alreadyLinked.borrower_id);
    return res.json({ success: true, already_linked: true, borrower_id: alreadyLinked.borrower_id, borrower_name: borrower ? borrower.name : 'Unknown' });
  }

  const data = JSON.parse(sub.form_data);
  const name = (data.applicant_name || data.name || data.full_name || data.first_name || '').trim();
  if (!name || name === 'Not provided') return res.status(400).json({ error: 'Submission has no applicant name — cannot import' });

  const phone = (data.applicant_phone || data.phone || data.contact_number || '').trim();
  const email = (data.email || data.applicant_email || '').trim();
  const address = (data.applicant_address || data.address || data.mailing_address || '').trim();
  const brand = (data.animal_brand || data.brand || '').trim();

  let borrower = null;
  if (phone) borrower = db.prepare(`SELECT * FROM borrowers WHERE phone = ? AND phone != ''`).get(phone);
  if (!borrower && email) borrower = db.prepare(`SELECT * FROM borrowers WHERE email = ? AND email != ''`).get(email);
  if (!borrower) borrower = db.prepare('SELECT * FROM borrowers WHERE LOWER(name) = LOWER(?)').get(name);

  let created = false;
  if (!borrower) {
    const result = db.prepare('INSERT INTO borrowers (name, phone, email, address, brand) VALUES (?, ?, ?, ?, ?)').run(name, phone, email, address, brand);
    borrower = { id: result.lastInsertRowid, name };
    created = true;
    db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
      borrower.id, sub.id, req.session.displayName || 'Staff', 'borrower_created', `Created from admin import of ${sub.form_type}`
    );
  }

  db.prepare('INSERT OR IGNORE INTO borrower_submissions (borrower_id, submission_id, linked_by) VALUES (?, ?, ?)').run(borrower.id, sub.id, req.session.displayName || 'Staff');
  db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
    borrower.id, sub.id, req.session.displayName || 'Staff', 'form_linked', `Imported ${sub.form_type} from admin panel`
  );

  res.json({ success: true, borrower_id: borrower.id, borrower_name: borrower.name, created });
});

// Bulk import submissions to hub
app.post('/api/admin/submissions/bulk-import', requireAdminAccess, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No submission IDs provided' });

  let imported = 0, skipped = 0, failed = 0;
  const results = [];

  for (const id of ids) {
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!sub) { failed++; continue; }

    const alreadyLinked = db.prepare('SELECT borrower_id FROM borrower_submissions WHERE submission_id = ?').get(id);
    if (alreadyLinked) { skipped++; continue; }

    const data = JSON.parse(sub.form_data);
    const name = (data.applicant_name || data.name || data.full_name || data.first_name || '').trim();
    if (!name || name === 'Not provided') { failed++; continue; }

    const phone = (data.applicant_phone || data.phone || data.contact_number || '').trim();
    const email = (data.email || data.applicant_email || '').trim();
    const address = (data.applicant_address || data.address || data.mailing_address || '').trim();
    const brand = (data.animal_brand || data.brand || '').trim();

    let borrower = null;
    if (phone) borrower = db.prepare(`SELECT * FROM borrowers WHERE phone = ? AND phone != ''`).get(phone);
    if (!borrower && email) borrower = db.prepare(`SELECT * FROM borrowers WHERE email = ? AND email != ''`).get(email);
    if (!borrower) borrower = db.prepare('SELECT * FROM borrowers WHERE LOWER(name) = LOWER(?)').get(name);

    if (!borrower) {
      const result = db.prepare('INSERT INTO borrowers (name, phone, email, address, brand) VALUES (?, ?, ?, ?, ?)').run(name, phone, email, address, brand);
      borrower = { id: result.lastInsertRowid, name };
      db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
        borrower.id, id, req.session.displayName || 'Staff', 'borrower_created', `Bulk import from admin panel`
      );
    }

    db.prepare('INSERT OR IGNORE INTO borrower_submissions (borrower_id, submission_id, linked_by) VALUES (?, ?, ?)').run(borrower.id, id, req.session.displayName || 'Staff');
    db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
      borrower.id, id, req.session.displayName || 'Staff', 'form_linked', `Bulk imported ${sub.form_type}`
    );
    imported++;
    results.push({ id, borrower_id: borrower.id, borrower_name: borrower.name });
  }

  res.json({ success: true, imported, skipped, failed, results });
});

// Check hub link status for submissions
app.get('/api/admin/submissions/hub-status', requireAdminAccess, (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json({});
  const idList = ids.split(',').map(Number).filter(n => !isNaN(n));
  const result = {};
  for (const id of idList) {
    const link = db.prepare('SELECT bs.borrower_id, b.name as borrower_name FROM borrower_submissions bs JOIN borrowers b ON b.id = bs.borrower_id WHERE bs.submission_id = ?').get(id);
    result[id] = link || null;
  }
  res.json(result);
});

// Export CSV
app.get('/api/admin/export', requireAdminAccess, (req, res) => {
  const { form_type, start_date, end_date, ids } = req.query;
  let where = [];
  let params = [];

  if (ids) {
    const idList = ids.split(',').map(Number);
    where.push(`id IN (${idList.map(() => '?').join(',')})`);
    params.push(...idList);
  } else {
    if (form_type && form_type !== 'all') {
      where.push('form_type = ?');
      params.push(form_type);
    }
    if (start_date) {
      where.push('submitted_at >= ?');
      params.push(start_date);
    }
    if (end_date) {
      where.push('submitted_at <= ?');
      params.push(end_date + ' 23:59:59');
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM submissions ${whereClause} ORDER BY submitted_at DESC`).all(...params);

  if (rows.length === 0) return res.status(404).json({ error: 'No submissions found' });

  const allKeys = new Set();
  const parsed = rows.map(r => {
    const data = JSON.parse(r.form_data);
    Object.keys(data).forEach(k => allKeys.add(k));
    return { id: r.id, form_type: r.form_type, submitted_at: r.submitted_at, ...data };
  });

  const headers = ['id', 'form_type', 'submitted_at', ...allKeys];
  const csvRows = [headers.join(',')];
  parsed.forEach(row => {
    csvRows.push(headers.map(h => {
      const val = row[h] || '';
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=foothills-submissions-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csvRows.join('\n'));
});

// Stats
app.get('/api/admin/stats', requireAdminAccess, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM submissions').get();
  const unread = db.prepare('SELECT COUNT(*) as cnt FROM submissions WHERE read_status = 0').get();
  const today = db.prepare("SELECT COUNT(*) as cnt FROM submissions WHERE date(submitted_at) = date('now','localtime')").get();
  const byType = db.prepare('SELECT form_type, COUNT(*) as cnt FROM submissions GROUP BY form_type ORDER BY cnt DESC').all();
  res.json({ total: total.cnt, unread: unread.cnt, today: today.cnt, byType });
});

// Change password
app.post('/api/admin/change-password', requireAdminAccess, (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
  res.json({ success: true });
});

// ───── ANALYTICS ─────

function classifySource(ref) {
  if (!ref || ref === '') return 'direct';
  if (/google\./i.test(ref)) return 'google';
  if (/bing\./i.test(ref)) return 'bing';
  if (/yahoo\./i.test(ref)) return 'yahoo';
  if (/facebook\.com|fb\.com|instagram\.com/i.test(ref)) return 'social-meta';
  if (/twitter\.com|x\.com/i.test(ref)) return 'social-x';
  if (/linkedin\.com/i.test(ref)) return 'social-linkedin';
  if (/youtube\.com/i.test(ref)) return 'social-youtube';
  if (/t\.co|tiktok\.com|reddit\.com|pinterest/i.test(ref)) return 'social-other';
  if (/foothills|cloud360/i.test(ref)) return 'internal';
  return 'referral';
}

function parseUA(ua) {
  ua = ua || '';
  let device = 'desktop';
  if (/mobile|android|iphone|ipod/i.test(ua)) device = 'mobile';
  else if (/ipad|tablet/i.test(ua)) device = 'tablet';

  let browser = 'Other';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
  else if (/firefox/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  else if (/opera|opr/i.test(ua)) browser = 'Opera';

  let os = 'Other';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/macintosh|mac os/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua) && !/android/i.test(ua)) os = 'Linux';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';

  return { device, browser, os };
}

// Tracking pixel/endpoint (no auth - called from visitor's browser)
app.post('/api/track', (req, res) => {
  try {
    const { sid, path: pagePath, title, ref, sw, sh, dur } = req.body;
    if (!sid || !pagePath) return res.status(400).json({ ok: false });

    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip;
    const ua = req.headers['user-agent'] || '';
    const { device, browser, os } = parseUA(ua);
    const source = classifySource(ref);

    db.prepare(`INSERT INTO page_views (session_id, path, title, referrer, source, device, browser, os, screen_w, screen_h, duration, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sid, pagePath, title || '', ref || '', source, device, browser, os,
      parseInt(sw) || 0, parseInt(sh) || 0, parseInt(dur) || 0, ip
    );

    const existing = db.prepare('SELECT id, pages_viewed FROM sessions_analytics WHERE session_id = ?').get(sid);
    if (existing) {
      db.prepare(`UPDATE sessions_analytics SET pages_viewed = pages_viewed + 1, total_duration = total_duration + ?,
        last_seen = datetime('now','localtime') WHERE session_id = ?`).run(parseInt(dur) || 0, sid);
    } else {
      db.prepare(`INSERT INTO sessions_analytics (session_id, first_page, device, browser, os, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)`).run(sid, pagePath, device, browser, os, ip);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Track error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Heartbeat — updates session last_seen and adds duration
app.post('/api/track/heartbeat', (req, res) => {
  try {
    const { sid, dur } = req.body;
    if (!sid) return res.status(400).json({ ok: false });
    db.prepare(`UPDATE sessions_analytics SET total_duration = total_duration + ?, last_seen = datetime('now','localtime') WHERE session_id = ?`)
      .run(parseInt(dur) || 0, sid);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

function periodToSQL(period) {
  if (period === '24h') return "datetime('now','localtime','-1 day')";
  if (period === '7d') return "datetime('now','localtime','-7 days')";
  if (period === '30d') return "datetime('now','localtime','-30 days')";
  if (period === '90d') return "datetime('now','localtime','-90 days')";
  return "datetime('now','localtime','-7 days')";
}
function prevPeriodSQL(period) {
  if (period === '24h') return ["datetime('now','localtime','-2 days')", "datetime('now','localtime','-1 day')"];
  if (period === '7d') return ["datetime('now','localtime','-14 days')", "datetime('now','localtime','-7 days')"];
  if (period === '30d') return ["datetime('now','localtime','-60 days')", "datetime('now','localtime','-30 days')"];
  if (period === '90d') return ["datetime('now','localtime','-180 days')", "datetime('now','localtime','-90 days')"];
  return ["datetime('now','localtime','-14 days')", "datetime('now','localtime','-7 days')"];
}

app.get('/api/admin/analytics/overview', requireAdminAccess, (req, res) => {
  const p = req.query.period || '7d';
  const since = periodToSQL(p);
  const [prevStart, prevEnd] = prevPeriodSQL(p);

  const cur = db.prepare(`SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as visitors FROM page_views WHERE created_at >= ${since}`).get();
  const prev = db.prepare(`SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as visitors FROM page_views WHERE created_at >= ${prevStart} AND created_at < ${prevEnd}`).get();

  const avgDur = db.prepare(`SELECT AVG(total_duration) as avg FROM sessions_analytics WHERE last_seen >= ${since}`).get();
  const bounceRaw = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN pages_viewed = 1 THEN 1 ELSE 0 END) as bounced FROM sessions_analytics WHERE last_seen >= ${since}`).get();
  const bounceRate = bounceRaw.total > 0 ? Math.round((bounceRaw.bounced / bounceRaw.total) * 100) : 0;

  const todayViews = db.prepare(`SELECT COUNT(*) as cnt FROM page_views WHERE date(created_at) = date('now','localtime')`).get();
  const todayVisitors = db.prepare(`SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE date(created_at) = date('now','localtime')`).get();

  res.json({
    total_views: cur.views,
    unique_visitors: cur.visitors,
    avg_duration: Math.round(avgDur.avg || 0),
    bounce_rate: bounceRate,
    pages_today: todayViews.cnt,
    visitors_today: todayVisitors.cnt,
    prev_views: prev.views,
    prev_visitors: prev.visitors
  });
});

app.get('/api/admin/analytics/pages', requireAdminAccess, (req, res) => {
  const since = periodToSQL(req.query.period || '7d');
  const rows = db.prepare(`SELECT path, title, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_views
    FROM page_views WHERE created_at >= ${since} AND source != 'internal'
    GROUP BY path ORDER BY views DESC LIMIT 30`).all();
  res.json(rows);
});

app.get('/api/admin/analytics/traffic', requireAdminAccess, (req, res) => {
  const p = req.query.period || '7d';
  const since = periodToSQL(p);

  const daily = db.prepare(`SELECT date(created_at) as date, COUNT(*) as views, COUNT(DISTINCT session_id) as visitors
    FROM page_views WHERE created_at >= ${since} GROUP BY date(created_at) ORDER BY date`).all();

  const sources = db.prepare(`SELECT source, COUNT(*) as count FROM page_views WHERE created_at >= ${since} AND source != 'internal'
    GROUP BY source ORDER BY count DESC`).all();

  const devices = db.prepare(`SELECT device as type, COUNT(DISTINCT session_id) as count FROM page_views WHERE created_at >= ${since}
    GROUP BY device ORDER BY count DESC`).all();

  const browsers = db.prepare(`SELECT browser as name, COUNT(DISTINCT session_id) as count FROM page_views WHERE created_at >= ${since}
    GROUP BY browser ORDER BY count DESC LIMIT 8`).all();

  res.json({ daily, sources, devices, browsers });
});

app.get('/api/admin/analytics/realtime', requireAdminAccess, (req, res) => {
  const active = db.prepare(`SELECT COUNT(DISTINCT session_id) as cnt FROM sessions_analytics
    WHERE last_seen >= datetime('now','localtime','-5 minutes')`).get();

  const recent = db.prepare(`SELECT path, city, country, device, created_at as timestamp
    FROM page_views ORDER BY created_at DESC LIMIT 20`).all();

  res.json({ active_visitors: active.cnt, recent });
});

app.get('/api/admin/analytics/geo', requireAdminAccess, (req, res) => {
  const since = periodToSQL(req.query.period || '7d');
  const rows = db.prepare(`SELECT country, region, city, COUNT(*) as count
    FROM page_views WHERE created_at >= ${since} AND country IS NOT NULL AND country != ''
    GROUP BY country, region, city ORDER BY count DESC LIMIT 30`).all();
  res.json(rows);
});

// Serve analytics dashboard
app.get('/admin/analytics', requireAdminAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'analytics.html'));
});

app.get('/cloud360-server-truth-statement.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cloud360-server-truth-statement.html'));
});

app.get('/cloud360-source-of-truth-plan.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cloud360-source-of-truth-plan.html'));
});

// ═══════════════════════════════════════════════════════
// BORROWER HUB
// ═══════════════════════════════════════════════════════

app.get('/hub', requireHubAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'hub.html'));
});

// Auto-import: scan submissions and create borrower records for unlinked ones
function autoLinkSubmissions() {
  const unlinked = db.prepare(`
    SELECT s.id, s.form_data, s.form_type, s.submitted_at
    FROM submissions s
    LEFT JOIN borrower_submissions bs ON bs.submission_id = s.id
    WHERE bs.submission_id IS NULL
  `).all();

  let linked = 0;
  for (const sub of unlinked) {
    try {
      const data = JSON.parse(sub.form_data);
      const name = (data.applicant_name || data.name || data.full_name || data.first_name || '').trim();
      if (!name || name === 'Not provided') continue;

      const phone = (data.applicant_phone || data.phone || data.contact_number || '').trim();
      const email = (data.email || data.applicant_email || '').trim();
      const address = (data.applicant_address || data.address || data.mailing_address || '').trim();
      const brand = (data.animal_brand || data.brand || '').trim();

      let borrower = null;
      if (phone) borrower = db.prepare(`SELECT * FROM borrowers WHERE phone = ? AND phone != ''`).get(phone);
      if (!borrower && email) borrower = db.prepare(`SELECT * FROM borrowers WHERE email = ? AND email != ''`).get(email);
      if (!borrower) borrower = db.prepare('SELECT * FROM borrowers WHERE LOWER(name) = LOWER(?)').get(name);

      if (!borrower) {
        const result = db.prepare('INSERT INTO borrowers (name, phone, email, address, brand) VALUES (?, ?, ?, ?, ?)').run(name, phone, email, address, brand);
        borrower = { id: result.lastInsertRowid };
        db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
          borrower.id, sub.id, 'System', 'borrower_created', `Auto-created from ${sub.form_type} submission`
        );
      }

      db.prepare('INSERT OR IGNORE INTO borrower_submissions (borrower_id, submission_id, linked_by) VALUES (?, ?, ?)').run(borrower.id, sub.id, 'auto');
      db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
        borrower.id, sub.id, 'System', 'form_linked', `${sub.form_type} submitted`
      );
      linked++;
    } catch (e) { /* skip malformed */ }
  }
  return linked;
}

// Run auto-link on startup
try { const n = autoLinkSubmissions(); if (n > 0) console.log(`Auto-linked ${n} submissions to borrowers`); } catch(e) {}

// Hub stats
app.get('/api/hub/stats', requireHubAccess, (req, res) => {
  const totalBorrowers = db.prepare('SELECT COUNT(*) as cnt FROM borrowers').get();
  const activeBorrowers = db.prepare("SELECT COUNT(*) as cnt FROM borrowers WHERE status = 'active'").get();
  const totalForms = db.prepare('SELECT COUNT(*) as cnt FROM submissions').get();
  const formsThisMonth = db.prepare("SELECT COUNT(*) as cnt FROM submissions WHERE submitted_at >= date('now','start of month','localtime')").get();
  const unread = db.prepare('SELECT COUNT(*) as cnt FROM submissions WHERE read_status = 0').get();
  const totalNotes = db.prepare('SELECT COUNT(*) as cnt FROM borrower_notes').get();
  const inProgress = db.prepare("SELECT COUNT(*) as cnt FROM borrowers WHERE pipeline_status IN ('reviewed','pending','processing','info_required')").get();
  const approved = db.prepare("SELECT COUNT(*) as cnt FROM borrowers WHERE pipeline_status = 'approved'").get();
  const denied = db.prepare("SELECT COUNT(*) as cnt FROM borrowers WHERE pipeline_status = 'denied'").get();
  const pipelineCounts = db.prepare("SELECT pipeline_status, COUNT(*) as cnt FROM borrowers GROUP BY pipeline_status").all();
  const unlinkedForms = db.prepare('SELECT COUNT(*) as cnt FROM submissions s LEFT JOIN borrower_submissions bs ON bs.submission_id = s.id WHERE bs.submission_id IS NULL').get();
  res.json({
    totalBorrowers: totalBorrowers.cnt,
    activeBorrowers: activeBorrowers.cnt,
    totalForms: totalForms.cnt,
    formsThisMonth: formsThisMonth.cnt,
    unreadSubmissions: unread.cnt,
    totalNotes: totalNotes.cnt,
    inProgress: inProgress.cnt,
    approved: approved.cnt,
    denied: denied.cnt,
    pipelineCounts: pipelineCounts,
    unlinkedForms: unlinkedForms.cnt
  });
});

// List borrowers
app.get('/api/hub/borrowers', requireHubAccess, (req, res) => {
  const { search, sort = 'name', page = 1, limit = 50, letter, pipeline } = req.query;
  let where = [];
  let params = [];

  if (search) {
    where.push("(LOWER(name) LIKE ? OR phone LIKE ? OR LOWER(email) LIKE ? OR LOWER(brand) LIKE ?)");
    const s = `%${search.toLowerCase()}%`;
    params.push(s, s, s, s);
  }
  if (letter) {
    where.push("UPPER(SUBSTR(name, 1, 1)) = ?");
    params.push(letter.toUpperCase());
  }
  if (pipeline && pipeline !== 'all') {
    where.push("pipeline_status = ?");
    params.push(pipeline);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let orderBy = 'name ASC';
  if (sort === 'recent') orderBy = 'updated_at DESC';
  if (sort === 'forms') orderBy = 'forms_count DESC';

  const offset = (parseInt(page) - 1) * parseInt(limit);

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM borrowers ${whereClause}`).get(...params);

  const borrowers = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM borrower_submissions WHERE borrower_id = b.id) as forms_count,
      (SELECT COUNT(*) FROM borrower_notes WHERE borrower_id = b.id) as notes_count,
      (SELECT MAX(created_at) FROM activity_log WHERE borrower_id = b.id) as last_activity
    FROM borrowers b
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  const letters = db.prepare("SELECT DISTINCT UPPER(SUBSTR(name, 1, 1)) as letter FROM borrowers ORDER BY letter").all().map(r => r.letter);

  res.json({
    borrowers,
    total: total.cnt,
    page: parseInt(page),
    pages: Math.ceil(total.cnt / parseInt(limit)),
    letters
  });
});

// Single borrower
app.get('/api/hub/borrowers/:id', requireHubAccess, (req, res) => {
  const borrower = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM borrower_submissions WHERE borrower_id = b.id) as forms_count,
      (SELECT COUNT(*) FROM borrower_notes WHERE borrower_id = b.id) as notes_count
    FROM borrowers b WHERE b.id = ?
  `).get(req.params.id);
  if (!borrower) return res.status(404).json({ error: 'Borrower not found' });
  res.json(borrower);
});

// Create borrower
app.post('/api/hub/borrowers', requireHubAccess, (req, res) => {
  const { name, phone, email, address, town, province, brand, staff_name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const result = db.prepare('INSERT INTO borrowers (name, phone, email, address, town, province, brand) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    name.trim(), phone || '', email || '', address || '', town || '', province || 'AB', brand || ''
  );
  db.prepare('INSERT INTO activity_log (borrower_id, staff_name, action, details) VALUES (?, ?, ?, ?)').run(
    result.lastInsertRowid, staff_name || 'Staff', 'borrower_created', `Created borrower: ${name.trim()}`
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

// Update borrower
app.put('/api/hub/borrowers/:id', requireHubAccess, (req, res) => {
  const borrower = db.prepare('SELECT * FROM borrowers WHERE id = ?').get(req.params.id);
  if (!borrower) return res.status(404).json({ error: 'Not found' });

  const { name, phone, email, address, town, province, brand, status, staff_name } = req.body;
  const changes = [];
  if (name !== undefined && name !== borrower.name) changes.push(`Name: ${borrower.name} → ${name}`);
  if (phone !== undefined && phone !== borrower.phone) changes.push(`Phone: ${borrower.phone || '(empty)'} → ${phone}`);
  if (email !== undefined && email !== borrower.email) changes.push(`Email: ${borrower.email || '(empty)'} → ${email}`);
  if (status !== undefined && status !== borrower.status) changes.push(`Status: ${borrower.status} → ${status}`);

  db.prepare(`UPDATE borrowers SET
    name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email),
    address = COALESCE(?, address), town = COALESCE(?, town), province = COALESCE(?, province),
    brand = COALESCE(?, brand), status = COALESCE(?, status),
    updated_at = datetime('now','localtime')
    WHERE id = ?`
  ).run(name, phone, email, address, town, province, brand, status, req.params.id);

  if (changes.length > 0) {
    db.prepare('INSERT INTO activity_log (borrower_id, staff_name, action, details) VALUES (?, ?, ?, ?)').run(
      req.params.id, staff_name || 'Staff', 'borrower_updated', changes.join('; ')
    );
  }
  res.json({ success: true });
});

// Borrower forms
app.get('/api/hub/borrowers/:id/forms', requireHubAccess, (req, res) => {
  const forms = db.prepare(`
    SELECT s.*, bs.linked_at
    FROM submissions s
    JOIN borrower_submissions bs ON bs.submission_id = s.id
    WHERE bs.borrower_id = ?
    ORDER BY s.submitted_at DESC
  `).all(req.params.id);

  const parsed = forms.map(f => {
    const data = JSON.parse(f.form_data);
    const safeName = (f.form_type || '').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
    const fp = path.join(__dirname, 'data', 'forms', `${safeName}-${f.id}.html`);
    return { ...f, form_data: data, has_form_file: fs.existsSync(fp) };
  });
  res.json(parsed);
});

// Edit form data
app.put('/api/hub/borrowers/:id/forms/:formId', requireHubAccess, (req, res) => {
  const { updates, staff_name } = req.body;
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.formId);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  const data = JSON.parse(sub.form_data);
  const changes = [];
  for (const [key, val] of Object.entries(updates || {})) {
    if (data[key] !== val) {
      changes.push(`${key}: "${data[key] || ''}" → "${val}"`);
      data[key] = val;
    }
  }

  if (changes.length > 0) {
    db.prepare('UPDATE submissions SET form_data = ? WHERE id = ?').run(JSON.stringify(data), req.params.formId);
    db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
      req.params.id, req.params.formId, staff_name || 'Staff', 'form_edited', changes.join('; ')
    );
  }
  res.json({ success: true, changes: changes.length });
});

// Update form status
app.put('/api/hub/borrowers/:id/forms/:formId/status', requireHubAccess, (req, res) => {
  const { status } = req.body;
  const validFormStatuses = ['new','reviewing','info_required','verification','underwriting','conditionally_approved','approved','denied','funding','funded','withdrawn','expired','closed'];
  if (!validFormStatuses.includes(status)) return res.status(400).json({ error: 'Invalid form status' });
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.formId);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const oldStatus = sub.form_status || 'new';
  db.prepare('UPDATE submissions SET form_status = ? WHERE id = ?').run(status, req.params.formId);
  const staffName = req.session.displayName || req.body.staff_name || 'Staff';
  db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
    req.params.id, req.params.formId, staffName, 'form_status_changed', `Form status: ${oldStatus.replace(/_/g,' ')} → ${status.replace(/_/g,' ')}`
  );
  res.json({ success: true });
});

// Link an existing submission to a borrower
app.post('/api/hub/borrowers/:id/link/:submissionId', requireHubAccess, (req, res) => {
  const { staff_name } = req.body;
  try {
    db.prepare('INSERT OR IGNORE INTO borrower_submissions (borrower_id, submission_id, linked_by) VALUES (?, ?, ?)').run(
      req.params.id, req.params.submissionId, staff_name || 'Staff'
    );
    const sub = db.prepare('SELECT form_type FROM submissions WHERE id = ?').get(req.params.submissionId);
    db.prepare('INSERT INTO activity_log (borrower_id, submission_id, staff_name, action, details) VALUES (?, ?, ?, ?, ?)').run(
      req.params.id, req.params.submissionId, staff_name || 'Staff', 'form_linked', `Manually linked ${sub ? sub.form_type : 'form'}`
    );
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Could not link submission' });
  }
});

// Borrower notes
app.get('/api/hub/borrowers/:id/notes', requireHubAccess, (req, res) => {
  const notes = db.prepare('SELECT * FROM borrower_notes WHERE borrower_id = ? ORDER BY pinned DESC, created_at DESC').all(req.params.id);
  res.json(notes);
});

app.post('/api/hub/borrowers/:id/notes', requireHubAccess, (req, res) => {
  const { content, staff_name } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Note content required' });
  const result = db.prepare('INSERT INTO borrower_notes (borrower_id, staff_name, content) VALUES (?, ?, ?)').run(
    req.params.id, staff_name || 'Staff', content.trim()
  );
  db.prepare('INSERT INTO activity_log (borrower_id, staff_name, action, details) VALUES (?, ?, ?, ?)').run(
    req.params.id, staff_name || 'Staff', 'note_added', content.trim().substring(0, 200)
  );
  db.prepare("UPDATE borrowers SET updated_at = datetime('now','localtime') WHERE id = ?").run(req.params.id);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/hub/borrowers/:id/notes/:noteId/pin', requireHubAccess, (req, res) => {
  const note = db.prepare('SELECT * FROM borrower_notes WHERE id = ? AND borrower_id = ?').get(req.params.noteId, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  db.prepare('UPDATE borrower_notes SET pinned = ? WHERE id = ?').run(note.pinned ? 0 : 1, req.params.noteId);
  res.json({ success: true, pinned: !note.pinned });
});

app.delete('/api/hub/borrowers/:id/notes/:noteId', requireHubAccess, (req, res) => {
  db.prepare('DELETE FROM borrower_notes WHERE id = ? AND borrower_id = ?').run(req.params.noteId, req.params.id);
  res.json({ success: true });
});

// Activity log
app.get('/api/hub/borrowers/:id/activity', requireHubAccess, (req, res) => {
  const activity = db.prepare(`
    SELECT a.*, s.form_type
    FROM activity_log a
    LEFT JOIN submissions s ON s.id = a.submission_id
    WHERE a.borrower_id = ?
    ORDER BY a.created_at DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(activity);
});

// Global recent activity
app.get('/api/hub/recent-activity', requireHubAccess, (req, res) => {
  const activity = db.prepare(`
    SELECT a.*, b.name as borrower_name, s.form_type
    FROM activity_log a
    LEFT JOIN borrowers b ON b.id = a.borrower_id
    LEFT JOIN submissions s ON s.id = a.submission_id
    ORDER BY a.created_at DESC
    LIMIT 30
  `).all();
  res.json(activity);
});

// Unlinked submissions (for manual linking)
app.get('/api/hub/unlinked-submissions', requireHubAccess, (req, res) => {
  const { search } = req.query;
  let q = `
    SELECT s.* FROM submissions s
    LEFT JOIN borrower_submissions bs ON bs.submission_id = s.id
    WHERE bs.submission_id IS NULL
  `;
  const params = [];
  if (search) {
    q += ' AND form_data LIKE ?';
    params.push(`%${search}%`);
  }
  q += ' ORDER BY s.submitted_at DESC LIMIT 50';
  const rows = db.prepare(q).all(...params);
  res.json(rows.map(r => ({ ...r, form_data: JSON.parse(r.form_data) })));
});

// Re-run auto-link
app.post('/api/hub/auto-link', requireHubAccess, (req, res) => {
  const count = autoLinkSubmissions();
  res.json({ success: true, linked: count });
});

// Session info for hub
app.get('/api/hub/session', requireHubAccess, (req, res) => {
  res.json({
    id: req.session.userId,
    username: req.session.username,
    displayName: req.session.displayName || req.session.username,
    role: req.session.role || 'staff'
  });
});

// User management (super admin only)
app.get('/api/hub/users', requireHubAccess, requireSuperAdmin, (req, res) => {
  const users = db.prepare("SELECT id, username, display_name, role, status, admin_access, hub_access, last_login, created_at FROM admin_users ORDER BY created_at").all();
  res.json(users);
});

app.post('/api/hub/users', requireHubAccess, requireSuperAdmin, (req, res) => {
  const { username, password, display_name, role, admin_access, hub_access } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const aAccess = admin_access !== undefined ? (admin_access ? 1 : 0) : 1;
  const hAccess = hub_access !== undefined ? (hub_access ? 1 : 0) : 1;
  const result = db.prepare('INSERT INTO admin_users (username, password_hash, display_name, role, status, admin_access, hub_access) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    username, hash, display_name || username, role || 'staff', 'active', aAccess, hAccess
  );
  const accessParts = [];
  if (aAccess) accessParts.push('Admin');
  if (hAccess) accessParts.push('Hub');
  db.prepare('INSERT INTO activity_log (staff_name, action, details) VALUES (?, ?, ?)').run(
    req.session.displayName || 'Admin', 'user_created', `Created user: ${display_name || username} (${role || 'staff'}, access: ${accessParts.join('+') || 'none'})`
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/hub/users/:id', requireHubAccess, requireSuperAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { display_name, role, status, password, admin_access, hub_access } = req.body;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }
  const aAccess = admin_access !== undefined ? (admin_access ? 1 : 0) : null;
  const hAccess = hub_access !== undefined ? (hub_access ? 1 : 0) : null;
  db.prepare('UPDATE admin_users SET display_name = COALESCE(?, display_name), role = COALESCE(?, role), status = COALESCE(?, status), admin_access = COALESCE(?, admin_access), hub_access = COALESCE(?, hub_access) WHERE id = ?').run(
    display_name, role, status, aAccess, hAccess, req.params.id
  );
  const changes = [];
  if (display_name && display_name !== user.display_name) changes.push(`Name: ${user.display_name} → ${display_name}`);
  if (role && role !== user.role) changes.push(`Role: ${user.role} → ${role}`);
  if (status && status !== user.status) changes.push(`Status: ${user.status} → ${status}`);
  if (admin_access !== undefined && (admin_access ? 1 : 0) !== user.admin_access) changes.push(`Admin access: ${admin_access ? 'granted' : 'revoked'}`);
  if (hub_access !== undefined && (hub_access ? 1 : 0) !== user.hub_access) changes.push(`Hub access: ${hub_access ? 'granted' : 'revoked'}`);
  if (password) changes.push('Password reset');
  if (changes.length) {
    db.prepare('INSERT INTO activity_log (staff_name, action, details) VALUES (?, ?, ?)').run(
      req.session.displayName || 'Admin', 'user_updated', `${user.display_name}: ${changes.join('; ')}`
    );
  }
  res.json({ success: true });
});

// Pipeline status update
app.put('/api/hub/borrowers/:id/pipeline', requireHubAccess, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['lead','active','info_required','approved_member','denied','inactive','closed','new','form_received','reviewing','reviewed','verification','processing','underwriting','pending','conditionally_approved','approved','funding','funded','withdrawn','expired'];
  const parts = status.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length || !parts.every(p => validStatuses.includes(p))) return res.status(400).json({ error: 'Invalid pipeline status' });
  const borrower = db.prepare('SELECT * FROM borrowers WHERE id = ?').get(req.params.id);
  if (!borrower) return res.status(404).json({ error: 'Borrower not found' });
  const oldStatus = borrower.pipeline_status || 'form_received';
  db.prepare("UPDATE borrowers SET pipeline_status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, req.params.id);
  const staffName = req.session.displayName || req.body.staff_name || 'Staff';
  db.prepare('INSERT INTO activity_log (borrower_id, staff_name, action, details) VALUES (?, ?, ?, ?)').run(
    req.params.id, staffName, 'pipeline_changed', `Status: ${oldStatus.replace(/_/g, ' ')} → ${status.replace(/_/g, ' ')}`
  );
  res.json({ success: true });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Foothills backend running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, retrying in 3 seconds...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '127.0.0.1');
    }, 3000);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => process.exit(0));
});
