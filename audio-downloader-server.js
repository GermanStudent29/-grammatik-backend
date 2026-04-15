const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const { promisify } = require('util');

const app = express();
const execAsync = promisify(exec);
const port = process.env.PORT || 3001;

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
      fs.unlinkSync(filePath);
      console.log(`Cleaned up: ${file}`);
    }
  });
}, 5 * 60 * 1000);

// Download endpoint
app.post('/api/download-audio', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  // Validate URL format
  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  
  try {
    console.log(`Downloading: ${url}`);
    
    // Generate unique filename
    const timestamp = Date.now();
    const outputFile = path.join(tempDir, `audio-${timestamp}.mp3`);
    const tempFile = path.join(tempDir, `temp-${timestamp}`);
    
    // Use yt-dlp to download and convert to MP3
    const command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 192K -o "${tempFile}" "${url}" 2>&1`;
    
    console.log('Executing:', command);
    const { stdout, stderr } = await execAsync(command, { timeout: 300000 }); // 5 minute timeout
    
    // Find the output file (yt-dlp adds .mp3 extension)
    let downloadedFile = null;
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith(`temp-${timestamp}`)) {
        downloadedFile = path.join(tempDir, file);
        break;
      }
    }
    
    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error('Download completed but output file not found');
    }
    
    const stats = fs.statSync(downloadedFile);
    const fileSizeInMB = stats.size / (1024 * 1024);
    
    if (fileSizeInMB > 100) {
      fs.unlinkSync(downloadedFile);
      return res.status(413).json({ error: `File too large (${fileSizeInMB.toFixed(1)}MB). Max 100MB.` });
    }
    
    console.log(`Downloaded: ${downloadedFile} (${fileSizeInMB.toFixed(1)}MB)`);
    
    // Send file
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('X-File-Size', stats.size);
    
    const fileStream = fs.createReadStream(downloadedFile);
    fileStream.on('end', () => {
      // Clean up after sending
      setTimeout(() => {
        if (fs.existsSync(downloadedFile)) {
          fs.unlinkSync(downloadedFile);
          console.log(`Cleaned up: ${downloadedFile}`);
        }
      }, 5000);
    });
    
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Download error:', error.message);
    
    let errorMsg = 'Failed to download audio';
    if (error.message.includes('Unsupported URL')) {
      errorMsg = 'URL not supported. Try YouTube, Spotify, SoundCloud, etc.';
    } else if (error.message.includes('timeout')) {
      errorMsg = 'Download took too long. Video may be too long or link may be invalid.';
    } else if (error.message.includes('Permission denied')) {
      errorMsg = 'Server permission error. Contact admin.';
    }
    
    res.status(500).json({ error: errorMsg, details: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'audio-downloader' });
});

app.listen(port, () => {
  console.log(`Audio downloader service running on port ${port}`);
  console.log(`Make sure yt-dlp is installed: brew install yt-dlp (macOS) or apt-get install yt-dlp (Linux)`);
});
