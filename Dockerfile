FROM node:18-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3-pip \
    && pip3 install yt-dlp \
    && rm -rf /var/lib/apt/lists/*

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
