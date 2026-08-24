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

// Optional: OpenAI-compatible SDK for Grok — only used if XAI_API_KEY is set
let OpenAI;
try { OpenAI = require('openai'); } catch (e) { OpenAI = null; }

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
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || !OpenAI) {
    console.log('[AI] No XAI_API_KEY — using cached response');
    if (fs.existsSync(CACHED_RESP)) {
      const cached = JSON.parse(fs.readFileSync(CACHED_RESP, 'utf8'));
      cached.analysis_source = 'cached';
      fs.writeFileSync(aiOutPath, JSON.stringify(cached, null, 2));
    }
    return;
  }

  // ── Build prompt context from all four signals ────────────────────────────
  const captureContext = {
    trigger_type:     manifest.trigger_type,
    crash_timestamp:  manifest.crash_timestamp,
    frame_count:      manifest.frame_count,
    capture_method:   manifest.capture_method,
    capture_duration_ms: manifest.capture_duration_ms,
    upload_duration_ms:  manifest.upload_duration_ms,
    device_model:     manifest.device_model,
    android_version:  manifest.android_version,
    app_package:      manifest.app_package,
    app_version:      manifest.app_version,
  };

  const memoryContext = manifest.memory ? {
    used_ram_mb:      manifest.memory.used_ram_mb,
    total_ram_mb:     manifest.memory.total_ram_mb,
    available_ram_mb: manifest.memory.available_ram_mb,
    heap_allocated_mb:manifest.memory.heap_allocated_mb,
    heap_max_mb:      manifest.memory.heap_max_mb,
    low_memory:       manifest.memory.low_memory,
  } : null;

  const thermalContext = manifest.thermal ? {
    status_label:     manifest.thermal.status_label,
    cpu_temp_c:       manifest.thermal.cpu_temp_c,
    gpu_temp_c:       manifest.thermal.gpu_temp_c,
    battery_temp_c:   manifest.thermal.battery_temp_c,
  } : null;

  const performanceContext = manifest.performance ? {
    avg_fps:          manifest.performance.avg_fps,
    min_fps:          manifest.performance.min_fps,
    dropped_frames:   manifest.performance.dropped_frames,
    jank_count:       manifest.performance.jank_count,
    responsiveness:   manifest.performance.responsiveness,
  } : null;

  // Last 50 log lines (trim to stay within token budget)
  const logLines = logs
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(-50)
    .join('\n');

  const hasLogs    = logLines.length > 0;
  const hasMem     = memoryContext !== null;
  const hasThermal = thermalContext !== null;

  const prompt = `You are a senior Android crash analyst. You have four independent signals from a crash capture. Reason across ALL of them together — not just the stack trace. Note if any signal contradicts or adds nuance to what the stack trace alone would suggest.

== SIGNAL 1: STACK TRACE ==
${stackTrace || '(not available)'}

== SIGNAL 2: APPLICATION LOGS (last 50 lines) ==
${hasLogs ? logLines : '(not available — treat as missing signal)'}

== SIGNAL 3: MEMORY & PERFORMANCE METRICS ==
${hasMem ? JSON.stringify(memoryContext, null, 2) : '(not available)'}
${performanceContext ? JSON.stringify(performanceContext, null, 2) : ''}

== SIGNAL 4: THERMAL & CAPTURE CONTEXT ==
${hasThermal ? JSON.stringify(thermalContext, null, 2) : '(not available)'}
Capture context: ${JSON.stringify(captureContext, null, 2)}

== INSTRUCTIONS ==
1. Identify the root cause by reasoning across all available signals.
2. If the logs show activity immediately before the crash (e.g. a button click, a state change), factor that into your root cause — the stack trace shows WHERE it crashed, but the logs often show WHY it was in that state.
3. If memory pressure, thermal throttling, or dropped frames contributed or are noteworthy, say so explicitly.
4. In evidence_used, list ONLY the signals you actually referenced in your reasoning. Do not include a signal just because it was present — only include it if it influenced your conclusion.
5. For confidence: be honest. Use a lower number (40-60) if the evidence is ambiguous or signals conflict. Use a higher number (75-92) only if multiple signals consistently point to the same cause. Do not default to a high number.

Respond with ONLY this JSON — no markdown, no explanation outside the JSON:
{
  "root_cause": "1-2 plain-English sentences. If logs revealed the trigger, cite the specific log line or timestamp.",
  "suggested_fix": "1-2 plain-English sentences — concrete and actionable.",
  "analysis_source": "live",
  "confidence": <integer 0-100>,
  "evidence_used": <array containing only the signals you actually used — choose from: "stack_trace", "logs", "memory", "thermal", "performance", "capture_context">,
  "evidence": [
    "Specific observation from signal X at timestamp/line Y that supports the root cause",
    "Second observation — different signal or different aspect of same signal",
    "Third observation — note any signal that contradicted or added nuance"
  ]
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
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });
  const completion = await client.chat.completions.create({
    model: 'grok-3-mini',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = completion.choices[0].message.content.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Grok response');
  const result = JSON.parse(jsonMatch[0]);

  // Normalise: ensure evidence_used is an array of known strings, never fabricated
  const VALID_SIGNALS = ['stack_trace', 'logs', 'memory', 'thermal', 'performance', 'capture_context'];
  if (!Array.isArray(result.evidence_used)) {
    result.evidence_used = null;
  } else {
    result.evidence_used = result.evidence_used.filter(s => VALID_SIGNALS.includes(s));
    if (result.evidence_used.length === 0) result.evidence_used = null;
  }

  // Normalise confidence: must be integer 0-100 or null
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 100) {
    result.confidence = null;
  } else {
    result.confidence = Math.round(result.confidence);
  }

  return result;
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
