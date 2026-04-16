// audio-downloader-server-final.js
// Backend for Grammatik: RSS parsing, audio download proxy, Whisper proxy.
// Works on Node 18+ (uses global fetch). For Node 16, install node-fetch.

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const multer = require('multer');

const app = express();
const execAsync = promisify(exec);
const port = process.env.PORT || 3001;

console.log(`Using port: ${port}`);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB Whisper limit
});

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

setInterval(() => {
  try {
    fs.readdirSync(tempDir).forEach(file => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      if ((Date.now() - stats.mtimeMs) / 60000 > 30) fs.unlinkSync(filePath);
    });
  } catch (e) {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────
// HTTP HELPERS (with redirect handling)
// ─────────────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = 30000, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('Too many redirects'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GrammatikBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    }, (res) => {
      // Follow redirects for feed URLs too
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return fetchURL(next, timeout, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching feed`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`Received ${data.length} bytes from ${url}`);
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function downloadFile(url, timeout = 300000, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('Too many redirects'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrammatikBot/1.0)' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return downloadFile(next, timeout, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// RSS PARSING
// ─────────────────────────────────────────────────────────────────────────

function parseRSS(xmlData) {
  const items = [];
  if (!xmlData || xmlData.length === 0) return items;

  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xmlData)) !== null) {
    const itemXml = match[1];

    let titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    if (!title) continue;

    let audioUrl = null;

    // 1) <enclosure url="..." type="audio/...">
    let m = itemXml.match(/<enclosure[^>]*url=["']([^"']+?)["'][^>]*type=["']audio/i);
    if (m) audioUrl = m[1].trim();

    // 2) <enclosure url="..."> with audio extension
    if (!audioUrl) {
      m = itemXml.match(/<enclosure[^>]*url=["']([^"']+?)["']/i);
      if (m) {
        const u = m[1].trim();
        if (/audio|\.mp3|\.m4a|\.wav|\.ogg|podcast|media/i.test(u)) audioUrl = u;
      }
    }

    // 3) <media:content>
    if (!audioUrl) {
      m = itemXml.match(/<media:content[^>]*url=["']([^"']+?)["']/i);
      if (m) audioUrl = m[1].trim();
    }

    // 4) generic mp3 url anywhere
    if (!audioUrl) {
      m = itemXml.match(/(https?:\/\/[^\s<>"']+\.mp3[^\s<>"']*)/i);
      if (m) audioUrl = m[1].trim();
    }

    if (audioUrl && audioUrl.length > 10) items.push({ title, audioUrl });
  }

  console.log(`Parsed ${items.length} episodes from feed`);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'grammatik-backend',
    features: ['podcast-rss', 'download-proxy', 'whisper-proxy'],
    timestamp: new Date().toISOString()
  });
});

// Curated working German podcasts (verified active feeds)
app.get('/api/popular-german-podcasts', (req, res) => {
  res.json({
    podcasts: [
      { name: 'Korpo Talk',              feedUrl: 'https://korpo-talk.podigee.io/feed/mp3',                              difficulty: 'B1-B2' },
      { name: 'Easy German',             feedUrl: 'https://proxyfeed.svmaudio.com/feeds/easygerman/feed.xml',            difficulty: 'A1-A2' },
      { name: 'Top Thema mit Vokabeln',  feedUrl: 'https://rss.dw.com/xml/DKpodcast_topthemamitvokabeln_de',            difficulty: 'A2-B1' },
      { name: 'German Learning Podcast', feedUrl: 'https://anchor.fm/s/10155178c/podcast/rss',                           difficulty: 'A1-B2' }
    ],
    note: 'Top suggestions for German language learning.'
  });
});

app.post('/api/parse-podcast-feed', async (req, res) => {
  const { feedUrl } = req.body;
  if (!feedUrl) return res.status(400).json({ error: 'Feed URL required' });
  try { new URL(feedUrl); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }

  try {
    console.log(`\n📡 Parsing feed: ${feedUrl}`);
    const xmlData = await fetchURL(feedUrl, 30000);
    const episodes = parseRSS(xmlData);

    if (episodes.length === 0) {
      return res.status(400).json({
        error: 'No episodes found in this feed.',
        suggestion: 'The feed may be empty, blocked, or in an unsupported format. Try another podcast.',
        feedUrl,
        receivedBytes: xmlData.length
      });
    }

    res.json({ success: true, episodeCount: episodes.length, episodes: episodes.slice(0, 30) });
  } catch (error) {
    console.error(`✗ Parse error: ${error.message}`);
    res.status(400).json({ error: error.message || 'Failed to parse feed', feedUrl });
  }
});

// Browser cannot fetch most podcast hosts directly (CORS). Proxy + optional compress.
app.post('/api/download-audio', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }

  try {
    console.log(`Downloading: ${url}`);
    const timestamp = Date.now();
    let outputFile = path.join(tempDir, `audio-${timestamp}.mp3`);

    const audioData = await downloadFile(url, 300000);
    if (audioData.length < 10000) throw new Error('Downloaded file is too small');

    fs.writeFileSync(outputFile, audioData);
    const sizeMB = audioData.length / (1024 * 1024);
    console.log(`Downloaded: ${sizeMB.toFixed(1)}MB`);

    if (sizeMB > 1024) { fs.unlinkSync(outputFile); return res.status(413).json({ error: 'File too large' }); }

    if (sizeMB > 25) {
      try {
        await execAsync('ffmpeg -version', { timeout: 5000 });
        const compressed = await compressAudio(outputFile);
        if (compressed !== outputFile) { fs.unlinkSync(outputFile); outputFile = compressed; }
      } catch (e) { console.log('ffmpeg not available, sending original'); }
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => setTimeout(() => { try { fs.unlinkSync(outputFile); } catch (e) {} }, 5000));
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Whisper proxy — fixes browser CORS to OpenAI and avoids exposing key in console
// Returns both text and segment timestamps for lyric sync
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  try {
    console.log('Transcribe request received');
    console.log('  file:', req.file ? `${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)}MB, ${req.file.mimetype})` : 'MISSING');
    console.log('  apiKey:', req.body.apiKey ? `${req.body.apiKey.substring(0,8)}...` : 'MISSING');

    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const openaiKey = req.body.apiKey || process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI API key provided' });

    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/mpeg' });
    const formData = new globalThis.FormData();
    formData.append('file', blob, req.file.originalname || 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('language', req.body.language || 'de');
    formData.append('response_format', 'verbose_json');

    console.log('  Forwarding to OpenAI Whisper (verbose_json)...');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData
    });

    const text = await response.text();
    console.log('  Whisper response:', response.status, text.substring(0, 300));

    if (!response.ok) {
      let msg = `Whisper error ${response.status}`;
      try { const j = JSON.parse(text); msg = (j.error && j.error.message) || msg; } catch (e) {}
      return res.status(response.status).json({ error: msg });
    }
    const result = JSON.parse(text);
    // Return full text AND segments with start/end timestamps
    res.json({
      text: result.text,
      segments: (result.segments || []).map(s => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end
      }))
    });
  } catch (error) {
    console.error('Transcribe error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// COMPRESSION
// ─────────────────────────────────────────────────────────────────────────

async function compressAudio(inputFile) {
  const outputFile = inputFile.replace('.mp3', '-comp.mp3');
  const inputSizeMB = fs.statSync(inputFile).size / (1024 * 1024);
  console.log(`Compressing: ${inputSizeMB.toFixed(1)}MB`);
  let bitrate = inputSizeMB > 100 ? '16k' : '32k';
  const cmd = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab ${bitrate} -ac 1 -y "${outputFile}" 2>&1`;
  try {
    await execAsync(cmd, { timeout: 180000 });
    const outMB = fs.statSync(outputFile).size / (1024 * 1024);
    console.log(`Compressed: ${outMB.toFixed(1)}MB`);
    if (outMB > 25) {
      console.log('Still over 25MB, recompressing at 16kbps...');
      await execAsync(`ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 16k -ac 1 -y "${outputFile}" 2>&1`, { timeout: 180000 });
    }
    return outputFile;
  } catch (e) {
    console.error('Compression failed:', e.message);
    return inputFile;
  }
}

app.listen(port, () => {
  console.log(`\n🎙️  Grammatik backend running on port ${port}`);
  console.log('✅ Endpoints: /api/health  /api/popular-german-podcasts  /api/parse-podcast-feed  /api/download-audio  /api/transcribe\n');
});
