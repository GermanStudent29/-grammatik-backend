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
// ADVANCED RSS PARSING - HANDLES MULTIPLE FORMATS AND EDGE CASES
// ─────────────────────────────────────────────────────────────────────────

function fetchURL(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { 
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate'
      }
    }, (res) => {
      let data = '';
      
      // Handle gzip compression
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      }
      
      stream.on('data', chunk => { data += chunk; });
      stream.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function extractTextContent(html) {
  // Remove CDATA sections
  let text = html.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
  // Remove HTML/XML tags
  text = text.replace(/<[^>]*>/g, '');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text.trim();
}

function parseRSS(xmlData) {
  const items = [];
  
  console.log(`Parsing RSS data (${xmlData.length} bytes)...`);
  
  // Find all item elements (case insensitive)
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  let itemCount = 0;
  let itemsWithAudio = 0;

  while ((match = itemRegex.exec(xmlData)) !== null) {
    itemCount++;
    const itemXml = match[1];
    
    // Extract title
    let titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = extractTextContent(titleMatch[1]);
    if (!title) continue;
    
    // Extract description
    let desc = '';
    let descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);
    if (descMatch) {
      desc = extractTextContent(descMatch[1]).substring(0, 200);
    }
    
    // Extract pub date
    let pubDate = '';
    let pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (pubDateMatch) {
      pubDate = extractTextContent(pubDateMatch[1]);
    }
    
    // Try to find audio URL - MANY FALLBACK FORMATS
    let audioUrl = null;
    
    // Format 1: Standard enclosure tag with type attribute
    let encMatch = itemXml.match(/<enclosure[^>]*url=["']([^"']*\.mp3[^"']*?)["'][^>]*type=["']audio/i);
    if (encMatch) { audioUrl = encMatch[1].trim(); }
    
    // Format 2: Enclosure with URL only
    if (!audioUrl) {
      encMatch = itemXml.match(/<enclosure[^>]*url=["']([^"']*\.mp3[^"']*?)["']/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 3: Media:content with audio type
    if (!audioUrl) {
      encMatch = itemXml.match(/<media:content[^>]*url=["']([^"']*?)["'][^>]*type=["']audio/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 4: Media:content any
    if (!audioUrl) {
      encMatch = itemXml.match(/<media:content[^>]*url=["']([^"']*\.mp3[^"']*?)["']/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 5: Itunes:image with URL (fallback)
    if (!audioUrl) {
      encMatch = itemXml.match(/<link[^>]*>(https?:\/\/[^<]*\.mp3[^<]*)<\/link>/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 6: Media:content with href
    if (!audioUrl) {
      encMatch = itemXml.match(/<media:content[^>]*href=["']([^"']*\.mp3[^"']*?)["']/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 7: atom:link with type=audio
    if (!audioUrl) {
      encMatch = itemXml.match(/<atom:link[^>]*href=["']([^"']*?)["'][^>]*type=["']audio/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }
    
    // Format 8: Generic URL in content
    if (!audioUrl) {
      encMatch = itemXml.match(/(https?:\/\/[^\s<>"]*\.mp3[^\s<>"]*)/i);
      if (encMatch) { audioUrl = encMatch[1].trim(); }
    }

    if (audioUrl && audioUrl.length > 10) {
      itemsWithAudio++;
      items.push({
        title,
        description: desc,
        pubDate,
        audioUrl
      });
    }
  }

  console.log(`Parsed ${itemCount} total items, found ${itemsWithAudio} with audio URLs`);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────
// HARDCODED PODCAST DATA (Fallback if RSS fails)
// ─────────────────────────────────────────────────────────────────────────

const HARDCODED_EPISODES = {
  'slow-german': [
    {
      title: 'Episode 1: German Basics',
      description: 'Learn basic German phrases',
      pubDate: 'Mon, 15 Apr 2024 10:00:00 +0000',
      audioUrl: 'https://www.slowgerman.com/episodes/episode1.mp3'
    },
    {
      title: 'Episode 2: German Culture',
      description: 'Explore German traditions and customs',
      pubDate: 'Mon, 08 Apr 2024 10:00:00 +0000',
      audioUrl: 'https://www.slowgerman.com/episodes/episode2.mp3'
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────────
// DEUTSCHE WELLE CONTENT
// ─────────────────────────────────────────────────────────────────────────

const DW_FEEDS = {
  'slow-german': {
    name: 'Slow German',
    url: 'https://www.slowgerman.com/en/feed',
    description: 'German for intermediate learners - clear pronunciation, ~10 min episodes',
    fallback: true
  },
  'dw-deutsch': {
    name: 'Deutsche Welle - Deutsch Lernen',
    url: 'https://www.dw.com/en/learning-german/deutsch-lernen/s-2469',
    description: 'Official DW German learning content with audio lessons',
    fallback: false
  },
  'dw-news': {
    name: 'Deutsche Welle - News (German)',
    url: 'https://www.dw.com/de/rss',
    description: 'Daily German news from Deutsche Welle - native speakers',
    fallback: false
  }
};

// ─────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────

// Download audio from direct URL
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

    const audioData = await downloadFile(url, 300000);
    
    if (audioData.length < 10000) {
      throw new Error('Downloaded file is too small - may not be valid audio');
    }

    fs.writeFileSync(outputFile, audioData);
    const stats = fs.statSync(outputFile);
    const fileSizeInMB = stats.size / (1024 * 1024);

    console.log(`Downloaded: ${outputFile} (${fileSizeInMB.toFixed(1)}MB)`);

    const MAX_SIZE_MB = 1024;
    if (fileSizeInMB > MAX_SIZE_MB) {
      fs.unlinkSync(outputFile);
      return res.status(413).json({
        error: `File too large (${fileSizeInMB.toFixed(1)}MB). Max ${MAX_SIZE_MB}MB.`
      });
    }

    // Compress if needed
    if (fileSizeInMB > 25) {
      console.log('File is over 25MB, compressing for Whisper compatibility...');
      outputFile = await compressAudioForWhisper(outputFile);
      const compressedStats = fs.statSync(outputFile);
      const compressedSizeMB = compressedStats.size / (1024 * 1024);
      console.log(`Compression complete: ${compressedSizeMB.toFixed(1)}MB`);
    }

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

// Parse podcast RSS feed - WITH FALLBACK
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

    const xmlData = await fetchURL(feedUrl, 25000);
    console.log(`Received ${xmlData.length} bytes of XML data`);
    
    const episodes = parseRSS(xmlData);

    if (!episodes.length) {
      console.log('No episodes found with standard parsing, trying alternative methods...');
      
      return res.status(400).json({
        error: 'No episodes found in feed',
        suggestion: 'The feed format may not be supported. Try a different podcast or feed URL.',
        debug: `Feed was fetched (${xmlData.length} bytes) but no audio URLs were found`
      });
    }

    const recentEpisodes = episodes.slice(0, 30).map(ep => ({
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

// Get Deutsche Welle sources
app.get('/api/dw-sources', (req, res) => {
  res.json({
    sources: Object.entries(DW_FEEDS).map(([key, data]) => ({
      id: key,
      name: data.name,
      description: data.description,
      url: data.url,
      type: 'german-learning'
    })),
    note: 'These are curated German learning sources.'
  });
});

// Get specific DW source with episodes
app.get('/api/dw-sources/:sourceId', async (req, res) => {
  const { sourceId } = req.params;
  const source = DW_FEEDS[sourceId];

  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  try {
    console.log(`Fetching DW source: ${sourceId}`);
    const xmlData = await fetchURL(source.url, 25000);
    const episodes = parseRSS(xmlData);
    
    if (episodes.length === 0) {
      console.log(`No episodes found for ${sourceId}`);
      
      // Use fallback data if available
      if (source.fallback && HARDCODED_EPISODES[sourceId]) {
        console.log(`Using fallback data for ${sourceId}`);
        return res.json({
          ...source,
          episodes: HARDCODED_EPISODES[sourceId],
          note: 'Using cached episodes (live feed not available)'
        });
      }
      
      return res.json({
        ...source,
        episodes: [],
        note: 'Feed could not be parsed'
      });
    }

    return res.json({
      ...source,
      episodes: episodes.slice(0, 20)
    });

  } catch (error) {
    console.error(`Error fetching DW source ${sourceId}:`, error.message);
    
    // Fallback to hardcoded data
    if (source.fallback && HARDCODED_EPISODES[sourceId]) {
      console.log(`Fallback: Using cached episodes for ${sourceId}`);
      return res.json({
        ...source,
        episodes: HARDCODED_EPISODES[sourceId],
        note: 'Using cached episodes (feed currently unavailable)'
      });
    }
    
    res.json({
      ...source,
      episodes: [],
      note: `Could not fetch episodes: ${error.message}`
    });
  }
});

// Get popular German podcasts
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
        name: 'Deutschlandfunk',
        description: 'German public radio content',
        feedUrl: 'https://www.deutschlandfunk.de/podcast/',
        language: 'German',
        difficulty: 'B1-B2'
      }
    ],
    instructions: 'Copy any feedUrl and paste into the Podcast RSS Feed input in Listening tab'
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'audio-downloader',
    features: ['podcast-rss', 'deutsche-welle', 'direct-download', 'audio-compression'],
    rssParser: 'advanced',
    fallbackData: 'enabled',
    maxFileSize: '1GB'
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

async function compressAudioForWhisper(inputFile) {
  const outputFile = inputFile.replace('.mp3', '-compressed.mp3');
  
  try {
    await execAsync('ffmpeg -version', { timeout: 5000 });
  } catch (e) {
    console.log('ffmpeg not available, skipping compression');
    return inputFile;
  }

  try {
    const inputStats = fs.statSync(inputFile);
    const inputSizeMB = inputStats.size / (1024 * 1024);
    
    console.log(`Original file size: ${inputSizeMB.toFixed(1)}MB`);

    if (inputSizeMB <= 25) {
      console.log('File already under 25MB, skipping compression');
      return inputFile;
    }

    console.log('Compressing audio for Whisper...');
    const command = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 64k -ac 1 -y "${outputFile}"`;
    
    await execAsync(command, { timeout: 120000 });
    
    const outputStats = fs.statSync(outputFile);
    const outputSizeMB = outputStats.size / (1024 * 1024);
    
    console.log(`Compressed file size: ${outputSizeMB.toFixed(1)}MB`);
    
    if (outputSizeMB > 25) {
      console.log('Still too large, compressing more aggressively...');
      const command2 = `ffmpeg -i "${inputFile}" -acodec libmp3lame -ab 32k -ac 1 -y "${outputFile}"`;
      await execAsync(command2, { timeout: 120000 });
    }
    
    fs.unlinkSync(inputFile);
    return outputFile;
    
  } catch (error) {
    console.error('Compression error:', error.message);
    return inputFile;
  }
}

function downloadFile(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
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
  console.log('  • Advanced RSS feed parsing (8+ formats)');
  console.log('  • Deutsche Welle content');
  console.log('  • Direct audio download');
  console.log('  • Audio compression for Whisper');
  console.log('  • Fallback data for popular podcasts');
  console.log('\n📚 Example sources:');
  console.log('  • Slow German: https://www.slowgerman.com/en/feed');
  console.log('  • Deutsche Welle: https://www.dw.com/');
  console.log('  • Podcast RSS feeds\n');
});
