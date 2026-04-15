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
    try {
      const stats = fs.statSync(filePath);
      const ageInMinutes = (Date.now() - stats.mtimeMs) / 60000;
      if (ageInMinutes > 30) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      }
    } catch (e) {
      console.error(`Failed to cleanup ${file}:`, e.message);
    }
  });
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────
// AUDIO COMPRESSION FOR WHISPER (< 25MB requirement)
// ─────────────────────────────────────────────────────────────────────────

async function compressAudioForWhisper(inputFile) {
  const outputFile = inputFile.replace('.mp3', '-compressed.mp3');
  
  // Check if ffmpeg is available
  try {
    await execAsync('ffmpeg -version', { timeout: 5000 });
  } catch (e) {
    console.log('ffmpeg not available, skipping compression');
    return inputFile; // Return original if ffmpeg not available
  }

  try {
    // Get original file size
    const inputStats = fs.statSync(inputFile);
    const inputSizeMB = inputStats.size / (1024 * 1024);
    
    console.log(`Original file size: ${inputSizeMB.toFixed(1)}MB`);

    // Only compress if larger than 25MB
    if (inputSizeMB <= 25) {
      console.log('File already under 25MB, skipping compression');
      return inputFile;
    }

    console.log('Compressing audio for Whisper...');
    
    // Calculate bitrate to fit under 25MB
    // Formula: bitrate (kbps) = (target size in KB / duration in seconds) * 8
    // We'll use a conservative approach: compress to 64kbps mono
    const command = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 64k -ac 1 -y "${outputFile}"`;
    
    await execAsync(command, { timeout: 120000 }); // 2 minute timeout
    
    // Check compressed file size
    const outputStats = fs.statSync(outputFile);
    const outputSizeMB = outputStats.size / (1024 * 1024);
    
    console.log(`Compressed file size: ${outputSizeMB.toFixed(1)}MB`);
    
    // If still too large, compress more aggressively
    if (outputSizeMB > 25) {
      console.log('Still too large, compressing more aggressively...');
      const command2 = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 32k -ac 1 -y "${outputFile}"`;
      await execAsync(command2, { timeout: 120000 });
      const finalStats = fs.statSync(outputFile);
      const finalSizeMB = finalStats.size / (1024 * 1024);
      console.log(`Final compressed size: ${finalSizeMB.toFixed(1)}MB`);
    }
    
    // Delete original and return compressed
    fs.unlinkSync(inputFile);
    return outputFile;
    
  } catch (error) {
    console.error('Compression error:', error.message);
    // If compression fails, return original file
    return inputFile;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PODCAST RSS PARSING - IMPROVED WITH BETTER ERROR HANDLING
// ─────────────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { 
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
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
  
  // Try to parse items
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  let itemCount = 0;

  while ((match = itemRegex.exec(xmlData)) !== null) {
    itemCount++;
    const itemXml = match[1];
    
    // Extract fields - try multiple formats
    const titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    
    // Try multiple enclosure formats
    let enclosureUrl = null;
    
    // Format 1: enclosure with audio type
    let enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]*)"[^>]*type="audio[^"]*"/);
    if (!enclosureMatch) {
      // Format 2: enclosure without type filter
      enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]*)"/);
    }
    if (enclosureMatch) {
      enclosureUrl = enclosureMatch[1].trim();
    }

    // Format 3: media:content
    if (!enclosureUrl) {
      const mediaMatch = itemXml.match(/<media:content[^>]*url="([^"]*)"/);
      if (mediaMatch) enclosureUrl = mediaMatch[1].trim();
    }

    // Format 4: link tag (last resort)
    if (!enclosureUrl) {
      const linkMatch = itemXml.match(/<link[^>]*>(https?:\/\/[^<]*\.mp3[^<]*)<\/link>/i);
      if (linkMatch) enclosureUrl = linkMatch[1].trim();
    }

    if (titleMatch && enclosureUrl) {
      const cleanTitle = titleMatch[1]
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();

      items.push({
        title: cleanTitle,
        description: descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 200) : '',
        pubDate: pubDateMatch ? pubDateMatch[1] : '',
        audioUrl: enclosureUrl
      });
    }
  }

  console.log(`Parsed ${itemCount} total items, found ${items.length} with audio URLs`);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────
// DEUTSCHE WELLE CONTENT
// ─────────────────────────────────────────────────────────────────────────

const DW_FEEDS = {
  'slow-german': {
    name: 'Slow German',
    url: 'https://www.slowgerman.com/en/feed',
    description: 'German for intermediate learners - clear pronunciation, ~10 min episodes'
  },
  'dw-deutsch': {
    name: 'Deutsche Welle - Deutsch Lernen',
    url: 'https://www.dw.com/en/learning-german/deutsch-lernen/s-2469',
    description: 'Official DW German learning content with audio lessons'
  },
  'dw-news': {
    name: 'Deutsche Welle - News (German)',
    url: 'https://www.dw.com/de/rss',
    description: 'Daily German news from Deutsche Welle - native speakers'
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
    let outputFile = path.join(tempDir, `audio-${timestamp}.mp3`);

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

    // Validate size - INCREASED TO 1GB for larger files
    const MAX_SIZE_MB = 1024; // 1GB instead of 500MB
    if (fileSizeInMB > MAX_SIZE_MB) {
      fs.unlinkSync(outputFile);
      return res.status(413).json({
        error: `File too large (${fileSizeInMB.toFixed(1)}MB). Max ${MAX_SIZE_MB}MB.`
      });
    }

    // Compress if needed for Whisper (< 25MB requirement)
    if (fileSizeInMB > 25) {
      console.log('File is over 25MB, compressing for Whisper compatibility...');
      outputFile = await compressAudioForWhisper(outputFile);
      const compressedStats = fs.statSync(outputFile);
      const compressedSizeMB = compressedStats.size / (1024 * 1024);
      console.log(`Compression complete: ${compressedSizeMB.toFixed(1)}MB`);
    }

    // Send file
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('X-File-Size-MB', (fs.statSync(outputFile).size / (1024 * 1024)).toFixed(1));

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

// Parse podcast RSS feed - IMPROVED
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

    const xmlData = await fetchURL(feedUrl, 20000); // Increased timeout
    const episodes = parseRSS(xmlData);

    if (!episodes.length) {
      return res.status(400).json({
        error: 'No episodes found in feed',
        suggestion: 'Verify the RSS feed URL is correct and contains audio content',
        debug: 'Feed was fetched but no audio URLs were found in items'
      });
    }

    // Return only the most recent episodes (limit to 20)
    const recentEpisodes = episodes.slice(0, 20).map(ep => ({
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

// Get info about a specific DW source - IMPROVED with fallback
app.get('/api/dw-sources/:sourceId', async (req, res) => {
  const { sourceId } = req.params;
  const source = DW_FEEDS[sourceId];

  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  try {
    console.log(`Fetching DW source: ${sourceId}`);
    const xmlData = await fetchURL(source.url, 20000);
    const episodes = parseRSS(xmlData);
    
    if (episodes.length === 0) {
      console.log(`No episodes found for ${sourceId}, returning info only`);
      return res.json({
        ...source,
        episodes: [],
        note: 'Feed could not be parsed, but source is available'
      });
    }

    return res.json({
      ...source,
      episodes: episodes.slice(0, 10) // Return 10 most recent
    });

  } catch (error) {
    console.error(`Error fetching DW source ${sourceId}:`, error.message);
    // Return source info without episodes on error
    res.json({
      ...source,
      episodes: [],
      note: `Could not fetch episodes (${error.message}), but you can visit the URL directly`
    });
  }
});

// Get popular German podcast feeds
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
        description: 'DW\'s German learning podcast with explanations',
        feedUrl: 'https://www.dw.com/en/learning-german/deutsch-lernen/s-2469',
        language: 'German',
        difficulty: 'A2-B1'
      },
      {
        name: 'Easy German (Podcast)',
        description: 'Street interviews and everyday German conversations',
        feedUrl: 'https://easygerman.org/podcast',
        language: 'German/English',
        difficulty: 'A1-A2'
      },
      {
        name: 'NDR - Das Ding',
        description: 'German radio stories and features from NDR',
        feedUrl: 'https://www.ndr.de/podcast/das_ding/',
        language: 'German',
        difficulty: 'B2+'
      },
      {
        name: 'Deutsche Welle - News',
        description: 'Daily German news from Deutsche Welle',
        feedUrl: 'https://www.dw.com/de/rss',
        language: 'German',
        difficulty: 'B1-B2'
      },
      {
        name: 'Podcast Deutsch - DeLSo',
        description: 'Deutsche Sprache learning podcast',
        feedUrl: 'https://www.dw.com/de/podcast/s-100822',
        language: 'German',
        difficulty: 'A1-B1'
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
    features: ['podcast-rss', 'deutsche-welle', 'direct-download', 'audio-compression'],
    maxFileSize: '1GB',
    whisperCompatible: 'Yes (auto-compresses >25MB)',
    timestamp: new Date().toISOString()
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
  console.log('  • Podcast RSS feed parsing (improved)');
  console.log('  • Deutsche Welle content');
  console.log('  • Direct audio download from any URL');
  console.log('  • Auto-compression for Whisper (>25MB files)');
  console.log('  • Max file size: 1GB');
  console.log('\n📚 Example sources:');
  console.log('  • Slow German: https://www.slowgerman.com/en/feed');
  console.log('  • Deutsche Welle: https://www.dw.com/');
  console.log('  • Podcast platforms: Paste RSS feed URLs directly\n');
});
