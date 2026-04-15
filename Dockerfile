FROM node:18-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3-full \
    pipx \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pipx (cleaner than pip)
RUN pipx install yt-dlp

# Make sure yt-dlp is in PATH
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy app files
COPY audio-downloader-server.js .

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "audio-downloader-server.js"]
