/**
 * SnapTrace AI — Laptop Server
 * Receives crash packages from Android, runs AI analysis, serves dashboard data.
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const AdmZip   = require('adm-zip');
const fs       = require('fs');
const path     = require('path');

// Optional: Anthropic SDK — only used if ANTHROPIC_API_KEY is set
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { Anthropic = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Directories ─────────────────────────────────────────────────────────────
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const LATEST_DIR   = path.join(__dirname, 'latest');
const CACHED_RESP  = path.join(__dirname, 'cached-response.json');

[UPLOADS_DIR, LATEST_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Ensure all responses include charset=utf-8
app.use((req, res, next) => {
  const send = res.send.bind(res);
  res.send = function (body) {
    const ct = res.getHeader('Content-Type');
    if (ct && typeof ct === 'string' && ct.includes('application/json') && !ct.includes('charset')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    if (ct && typeof ct === 'string' && ct.includes('text/html') && !ct.includes('charset')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    return send(body);
  };
  next();
});

// Serve dashboard static files with explicit charset
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
  }
}));

// Serve individual frame files from latest package
app.use('/frames', express.static(path.join(LATEST_DIR, 'frames')));

// ─── Multer — accept zip uploads ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ts   = Date.now();
    const name = `package_${ts}.zip`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── POST /upload — receive crash package ────────────────────────────────────
app.post('/upload', upload.single('package'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  console.log(`[upload] Received: ${req.file.filename} (${req.file.size} bytes)`);

  try {
    // Unzip into LATEST_DIR (overwrite every time — we always serve the latest)
    clearDir(LATEST_DIR);
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(LATEST_DIR, true);

    // Create frames sub-dir if not present
    const framesDir = path.join(LATEST_DIR, 'frames');
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

    // Move any loose *.jpg / *.png frame files into frames/ sub-dir
    fs.readdirSync(LATEST_DIR).forEach(f => {
      if (/^frame_\d+\.(jpg|png)$/.test(f)) {
        fs.renameSync(path.join(LATEST_DIR, f), path.join(framesDir, f));
      }
    });

    console.log('[upload] Unzipped to latest/');

    // Kick off async AI analysis (don't block the HTTP response)
    analyzePackage().catch(e => console.error('[AI]', e.message));

    res.json({ status: 'ok', file: req.file.filename });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/latest — dashboard fetches this ─────────────────────────────────
app.get('/api/latest', (req, res) => {
  const manifestPath = path.join(LATEST_DIR, 'manifest.json');
  const aiPath       = path.join(LATEST_DIR, 'ai-analysis.json');

  if (!fs.existsSync(manifestPath)) {
    // Serve the mock-data manifest as fallback so the dashboard always has data
    const mockManifest = path.join(__dirname, '..', 'mock-data', 'manifest.json');
    if (fs.existsSync(mockManifest)) {
      const manifest = JSON.parse(fs.readFileSync(mockManifest, 'utf8'));
      const aiAnalysis = fs.existsSync(CACHED_RESP)
        ? JSON.parse(fs.readFileSync(CACHED_RESP, 'utf8'))
        : null;
      return res.json({ manifest, ai: aiAnalysis, source: 'mock' });
    }
    return res.status(404).json({ error: 'No package received yet' });
  }

  const manifest   = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const aiAnalysis = fs.existsSync(aiPath)
    ? JSON.parse(fs.readFileSync(aiPath, 'utf8'))
    : (fs.existsSync(CACHED_RESP) ? JSON.parse(fs.readFileSync(CACHED_RESP, 'utf8')) : null);

  res.json({ manifest, ai: aiAnalysis, source: 'real' });
});

// ─── GET /api/logs — serve logcat lines ───────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const logsPath = path.join(LATEST_DIR, 'logs.txt');
  const mockLogs = path.join(__dirname, '..', 'mock-data', 'logs.txt');
  const target   = fs.existsSync(logsPath) ? logsPath : mockLogs;
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'logs.txt not found' });
  res.type('text/plain').send(fs.readFileSync(target, 'utf8'));
});

// ─── GET /api/stacktrace ──────────────────────────────────────────────────────
app.get('/api/stacktrace', (req, res) => {
  const stPath   = path.join(LATEST_DIR, 'stack_trace.txt');
  const mockSt   = path.join(__dirname, '..', 'mock-data', 'stack_trace.txt');
  const target   = fs.existsSync(stPath) ? stPath : mockSt;
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'stack_trace.txt not found' });
  res.type('text/plain').send(fs.readFileSync(target, 'utf8'));
});

// ─── GET /api/frames — list available frames ──────────────────────────────────
app.get('/api/frames', (req, res) => {
  const framesDir = path.join(LATEST_DIR, 'frames');
  if (!fs.existsSync(framesDir)) return res.json({ frames: [] });
  const files = fs.readdirSync(framesDir)
    .filter(f => /\.(jpg|png)$/i.test(f))
    .sort()
    .map((f, i) => ({ file: f, url: `/frames/${f}`, index: i }));
  res.json({ frames: files });
});

// ─── AI analysis ──────────────────────────────────────────────────────────────
async function analyzePackage() {
  const manifestPath = path.join(LATEST_DIR, 'manifest.json');
  const logsPath     = path.join(LATEST_DIR, 'logs.txt');
  const stPath       = path.join(LATEST_DIR, 'stack_trace.txt');
  const aiOutPath    = path.join(LATEST_DIR, 'ai-analysis.json');

  if (!fs.existsSync(manifestPath)) return;

  const manifest   = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const logs       = fs.existsSync(logsPath) ? fs.readFileSync(logsPath, 'utf8').slice(0, 4000) : '';
  const stackTrace = fs.existsSync(stPath)   ? fs.readFileSync(stPath, 'utf8')                  : '';

  // If no API key, fall back to cached immediately
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) {
    console.log('[AI] No API key — using cached response');
    if (fs.existsSync(CACHED_RESP)) {
      const cached = JSON.parse(fs.readFileSync(CACHED_RESP, 'utf8'));
      cached.analysis_source = 'cached';
      fs.writeFileSync(aiOutPath, JSON.stringify(cached, null, 2));
    }
    return;
  }

  const prompt = `You are a senior Android crash analyst. Analyze this crash report and respond with ONLY valid JSON.

MANIFEST:
${JSON.stringify({ exception_type: manifest.exception_type, exception_message: manifest.exception_message, exception_class: manifest.exception_class, exception_method: manifest.exception_method, exception_line: manifest.exception_line }, null, 2)}

STACK TRACE:
${stackTrace}

RECENT LOGS (last 50 lines):
${logs}

Respond with this exact JSON structure:
{
  "root_cause": "1-2 plain English sentences explaining what caused the crash",
  "suggested_fix": "1-2 plain English sentences describing the fix",
  "analysis_source": "live",
  "evidence": ["key evidence point 1", "key evidence point 2", "key evidence point 3"]
}`;

  // Race: AI call vs 2s timeout → use cached if timeout wins
  const aiPromise = callAI(apiKey, prompt);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI timeout')), 2000)
  );

  try {
    const result = await Promise.race([aiPromise, timeoutPromise]);
    fs.writeFileSync(aiOutPath, JSON.stringify(result, null, 2));
    console.log('[AI] Live analysis complete');
  } catch (err) {
    console.warn('[AI] Falling back to cache:', err.message);
    if (fs.existsSync(CACHED_RESP)) {
      const cached = JSON.parse(fs.readFileSync(CACHED_RESP, 'utf8'));
      cached.analysis_source = 'cached';
      fs.writeFileSync(aiOutPath, JSON.stringify(cached, null, 2));
    }
  }
}

async function callAI(apiKey, prompt) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = msg.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');
  return JSON.parse(jsonMatch[0]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
    else fs.unlinkSync(fp);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SnapTrace server running on http://localhost:${PORT}`);
  console.log(`  Upload endpoint: POST http://localhost:${PORT}/upload`);
  console.log(`  Dashboard data:  GET  http://localhost:${PORT}/api/latest`);
  console.log(`  Dashboard:       http://localhost:${PORT}/dashboard`);
});
