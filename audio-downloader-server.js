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

// Temp directory for downloaded files
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Clean up old files every 5 minutes
setInterval(() => {
  fs.readdirSync(tempDir).forEach(file => {
    const filePath = path.join(tempDir, file);
    const stats = fs.statSync(filePath);
    const ageInMinutes = (Date.now() - stats.mtimeMs) / 60000;
    if (ageInMinutes > 30) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      } catch (e) {
        console.error(`Failed to clean up ${file}:`, e.message);
      }
    }
  });
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────
// PODCAST RSS PARSING
// ─────────────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function parseRSS(xmlData) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xmlData)) !== null) {
    const itemXml = match[1];
    
    // Extract fields
    const titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    
    // Try multiple enclosure formats
    let enclosureUrl = null;
    let enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]*)"[^>]*type="audio[^"]*"/);
    if (!enclosureMatch) {
      enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]*)"/);
    }
    if (enclosureMatch) {
      enclosureUrl = enclosureMatch[1];
    }

    // Try media:content as fallback
    if (!enclosureUrl) {
      const mediaMatch = itemXml.match(/<media:content[^>]*url="([^"]*)"/);
      if (mediaMatch) enclosureUrl = mediaMatch[1];
    }

    if (titleMatch && enclosureUrl) {
      items.push({
        title: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
        description: descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 200) : '',
        pubDate: pubDateMatch ? pubDateMatch[1] : '',
        audioUrl: enclosureUrl.trim()
      });
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────
// DEUTSCHE WELLE CONTENT
// ─────────────────────────────────────────────────────────────────────────

const DW_FEEDS = {
  'slow-german': {
    name: 'Slow German',
    url: 'https://www.slowgerman.com/en/feed',
    description: 'German for intermediate learners - clear pronunciation'
  },
  'easy-german': {
    name: 'Easy German (YouTube)',
    url: 'https://www.youtube.com/@easyeasy/videos',
    description: 'Simple everyday German conversations'
  },
  'dw-deutsch': {
    name: 'Deutsche Welle - Deutsch Lernen',
    url: 'https://www.dw.com/en/learning-german/deutsch-lernen/s-2469',
    description: 'Official DW German learning content'
  },
  'dw-news': {
    name: 'Deutsche Welle - News (German)',
    url: 'https://www.dw.com/de/rss',
    description: 'Daily German news from DW'
  }
};

// Map of podcast services with RSS feed patterns
const PODCAST_SERVICES = {
  'spotify': {
    canExtract: false,
    message: 'Spotify podcasts require authentication. Try pasting the podcast RSS feed instead.'
  },
  'apple': {
    canExtract: false,
    message: 'Apple Podcasts require special handling. Use the RSS feed URL instead.'
  },
  'rss': {
    canExtract: true,
    message: 'Direct RSS feed - will parse episodes'
  }
};

// ─────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────

// Download audio from direct URL (podcast RSS enclosure)
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
    console.log(`Downloading audio from: ${url}`);

    const timestamp = Date.now();
    const outputFile = path.join(tempDir, `audio-${timestamp}.mp3`);

    // Download audio file directly
    const audioData = await downloadFile(url, 300000); // 5 min timeout
    
    // Verify it's actually audio
    if (audioData.length < 10000) {
      throw new Error('Downloaded file is too small - may not be valid audio');
    }

    // Save to temp file
    fs.writeFileSync(outputFile, audioData);
    const stats = fs.statSync(outputFile);
    const fileSizeInMB = stats.size / (1024 * 1024);

    console.log(`Downloaded: ${outputFile} (${fileSizeInMB.toFixed(1)}MB)`);

    // Validate size
    if (fileSizeInMB > 500) {
      fs.unlinkSync(outputFile);
      return res.status(413).json({
        error: `File too large (${fileSizeInMB.toFixed(1)}MB). Max 500MB.`
      });
    }

    // Send file
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('X-File-Size-MB', fileSizeInMB.toFixed(1));

    const fileStream = fs.createReadStream(outputFile);

    fileStream.on('end', () => {
      setTimeout(() => {
        if (fs.existsSync(outputFile)) {
          fs.unlinkSync(outputFile);
          console.log(`Cleaned up: ${outputFile}`);
        }
      }, 5000);
    });

    fileStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    });

    fileStream.pipe(res);

  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({
      error: 'Failed to download audio',
      details: error.message
    });
  }
});

// Parse podcast RSS feed
app.post('/api/parse-podcast-feed', async (req, res) => {
  const { feedUrl } = req.body;

  if (!feedUrl) {
    return res.status(400).json({ error: 'Feed URL is required' });
  }

  try {
    new URL(feedUrl);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    console.log(`Parsing podcast feed: ${feedUrl}`);

    const xmlData = await fetchURL(feedUrl, 15000);
    const episodes = parseRSS(xmlData);

    if (!episodes.length) {
      return res.status(400).json({
        error: 'No episodes found in feed',
        suggestion: 'Verify the RSS feed URL is correct and contains audio content'
      });
    }

    // Return only the most recent episodes (limit to 10)
    const recentEpisodes = episodes.slice(0, 10).map(ep => ({
      title: ep.title,
      description: ep.description,
      pubDate: ep.pubDate,
      audioUrl: ep.audioUrl
    }));

    res.json({
      success: true,
      episodeCount: episodes.length,
      episodes: recentEpisodes
    });

  } catch (error) {
    console.error('Feed parsing error:', error.message);
    
    let errorMsg = 'Failed to parse podcast feed';
    if (error.message.includes('timeout')) {
      errorMsg = 'Feed request timed out - server may be slow or URL invalid';
    } else if (error.message.includes('ENOTFOUND')) {
      errorMsg = 'Feed URL not found - check if domain is correct';
    }

    res.status(400).json({
      error: errorMsg,
      details: error.message
    });
  }
});

// Get list of Deutsche Welle resources
app.get('/api/dw-sources', (req, res) => {
  res.json({
    sources: Object.entries(DW_FEEDS).map(([key, data]) => ({
      id: key,
      name: data.name,
      description: data.description,
      url: data.url,
      type: 'german-learning'
    })),
    note: 'These are curated German learning sources. Most have RSS feeds available.'
  });
});

// Get info about a specific DW source
app.get('/api/dw-sources/:sourceId', async (req, res) => {
  const { sourceId } = req.params;
  const source = DW_FEEDS[sourceId];

  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  try {
    // For slow-german, we can get the RSS feed
    if (sourceId === 'slow-german') {
      const xmlData = await fetchURL(source.url, 15000);
      const episodes = parseRSS(xmlData);
      
      return res.json({
        ...source,
        episodes: episodes.slice(0, 5) // Return 5 most recent
      });
    }

    // For others, just return info
    res.json({
      ...source,
      note: `For this source, please visit ${source.url} to find the RSS feed`
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch source content',
      details: error.message
    });
  }
});

// Get popular German podcast feeds (pre-curated list)
app.get('/api/popular-german-podcasts', (req, res) => {
  res.json({
    podcasts: [
      {
        name: 'Slow German',
        description: 'German for intermediate learners with clear pronunciation',
        feedUrl: 'https://www.slowgerman.com/en/feed',
        language: 'German/English',
        difficulty: 'B1-B2'
      },
      {
        name: 'Deutsche Welle - Deutsch Warum Nicht',
        description: 'DW\'s English-language German learning podcast',
        feedUrl: 'https://www.dw.com/de/warum-nicht/s-8244',
        language: 'German',
        difficulty: 'A2-B1'
      },
      {
        name: 'Podcast Deutsch',
        description: 'Various German language podcasts',
        feedUrl: 'https://www.podcast.de/podcasts/category/sprachen/deutsch',
        language: 'German',
        difficulty: 'B1-B2'
      },
      {
        name: 'NDR - Das Ding und andere Sachen',
        description: 'German radio stories and features',
        feedUrl: 'https://www.ndr.de/podcast/das_ding/',
        language: 'German',
        difficulty: 'B2+'
      },
      {
        name: 'ARD Audiothek',
        description: 'German public radio content',
        feedUrl: 'https://www.ardaudiothek.de/',
        language: 'German',
        difficulty: 'B1-B2'
      }
    ],
    instructions: 'Copy any feedUrl above and paste into the "Podcast RSS Feed" input in the Listening tab'
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'audio-downloader',
    features: ['podcast-rss', 'deutsche-welle', 'direct-download']
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function downloadFile(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
        downloadFile(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => { resolve(Buffer.concat(chunks)); });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`\n🎙️  Audio downloader service running on port ${port}`);
  console.log('\n✅ Features available:');
  console.log('  • Podcast RSS feed parsing');
  console.log('  • Deutsche Welle content');
  console.log('  • Direct audio download from any URL');
  console.log('\n📚 Example sources:');
  console.log('  • Slow German: https://www.slowgerman.com/en/feed');
  console.log('  • Deutsche Welle: https://www.dw.com/');
  console.log('  • Podcast platforms: Paste RSS feed URLs directly\n');
});
