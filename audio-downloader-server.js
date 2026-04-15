const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const execAsync = promisify(exec);
const port = process.env.PORT || 3001;

console.log(`Using port: ${port}`);

// Middleware
app.use(cors());
app.use(express.json());

// Temp directory
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Cleanup old files
setInterval(() => {
  try {
    fs.readdirSync(tempDir).forEach(file => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      if ((Date.now() - stats.mtimeMs) / 60000 > 30) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (e) {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────
// RSS PARSING
// ─────────────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { 
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GrammatikBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    }, (res) => {
      let data = '';
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

function parseRSS(xmlData) {
  const items = [];
  
  if (!xmlData || xmlData.length === 0) {
    console.log('Empty XML data');
    return items;
  }

  // Find items
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlData)) !== null) {
    const itemXml = match[1];
    
    // Title
    let titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
    
    if (!title) continue;

    // Audio URL - many formats
    let audioUrl = null;
    
    // Try enclosure
    let match1 = itemXml.match(/<enclosure[^>]*url=["']([^"']*\.mp3[^"']*?)["']/i);
    if (match1) audioUrl = match1[1].trim();
    
    // Try media:content
    if (!audioUrl) {
      let match2 = itemXml.match(/<media:content[^>]*url=["']([^"']*?)["']/i);
      if (match2) audioUrl = match2[1].trim();
    }
    
    // Try generic URL
    if (!audioUrl) {
      let match3 = itemXml.match(/(https?:\/\/[^\s<>"]*\.mp3[^\s<>"]*)/i);
      if (match3) audioUrl = match3[1].trim();
    }

    if (audioUrl && audioUrl.length > 10) {
      items.push({
        title,
        audioUrl
      });
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────

app.post('/api/download-audio', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    console.log(`Downloading: ${url}`);

    const timestamp = Date.now();
    let outputFile = path.join(tempDir, `audio-${timestamp}.mp3`);

    const audioData = await downloadFile(url, 300000);
    
    if (audioData.length < 10000) {
      throw new Error('Downloaded file is too small');
    }

    fs.writeFileSync(outputFile, audioData);
    const fileSizeInMB = audioData.length / (1024 * 1024);

    console.log(`Downloaded: ${fileSizeInMB.toFixed(1)}MB`);

    if (fileSizeInMB > 1024) {
      fs.unlinkSync(outputFile);
      return res.status(413).json({ error: 'File too large' });
    }

    // Compress if needed
    if (fileSizeInMB > 25) {
      try {
        await execAsync('ffmpeg -version', { timeout: 5000 });
        console.log('Compressing...');
        const compressed = await compressAudio(outputFile);
        fs.unlinkSync(outputFile);
        outputFile = compressed;
      } catch (e) {
        console.log('ffmpeg not available, using original');
      }
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');

    const fileStream = fs.createReadStream(outputFile);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      setTimeout(() => {
        try { fs.unlinkSync(outputFile); } catch (e) {}
      }, 5000);
    });

  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/parse-podcast-feed', async (req, res) => {
  const { feedUrl } = req.body;

  if (!feedUrl) {
    return res.status(400).json({ error: 'Feed URL required' });
  }

  try {
    new URL(feedUrl);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    console.log(`Parsing: ${feedUrl}`);
    const xmlData = await fetchURL(feedUrl, 30000);
    const episodes = parseRSS(xmlData);

    if (episodes.length === 0) {
      return res.status(400).json({
        error: 'No episodes found',
        suggestion: 'Feed may be unavailable or in unsupported format'
      });
    }

    res.json({
      success: true,
      episodeCount: episodes.length,
      episodes: episodes.slice(0, 30)
    });

  } catch (error) {
    console.error('Parse error:', error.message);
    res.status(400).json({
      error: error.message
    });
  }
});

app.get('/api/popular-german-podcasts', (req, res) => {
  res.json({
    podcasts: [
      {
        name: 'Slow German (Direct)',
        description: 'German for intermediate learners',
        feedUrl: 'https://feeds.podigee.com/slow-german-english',
        difficulty: 'B1-B2'
      },
      {
        name: 'Easy German',
        description: 'Everyday German conversations',
        feedUrl: 'https://feeds.megaphone.fm/easygerman',
        difficulty: 'A1-A2'
      },
      {
        name: 'Deutsche Welle - Deutsch Lernen',
        description: 'Official DW learning content',
        feedUrl: 'https://feeds.dw.com/rde/deu/playlist',
        difficulty: 'A2-B1'
      },
      {
        name: 'Deutschlandfunk Kultur Podcasts',
        description: 'German public radio - culture',
        feedUrl: 'https://www.deutschlandfunkkultur.de/podcast-feeds.rss',
        difficulty: 'B1-B2'
      },
      {
        name: 'Podcast Deutsch',
        description: 'Variety of German podcasts',
        feedUrl: 'https://www.podcast.de/feed/',
        difficulty: 'B1-B2'
      },
      {
        name: 'ARD Audiothek Selection',
        description: 'German public broadcaster podcasts',
        feedUrl: 'https://www.ardaudiothek.de/feeds/',
        difficulty: 'B1-B2'
      }
    ],
    note: 'If a feed fails, try another. Some feeds may have access restrictions.'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'audio-downloader',
    features: ['podcast-rss', 'direct-download'],
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

async function compressAudio(inputFile) {
  const outputFile = inputFile.replace('.mp3', '-comp.mp3');
  const command = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 64k -ac 1 -y "${outputFile}" 2>&1`;
  
  try {
    await execAsync(command, { timeout: 120000 });
    return outputFile;
  } catch (e) {
    console.error('Compression failed:', e.message);
    return inputFile;
  }
}

function downloadFile(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`\n🎙️  Backend running on port ${port}`);
  console.log('✅ Features: podcast-rss, direct-download, compression\n');
});
