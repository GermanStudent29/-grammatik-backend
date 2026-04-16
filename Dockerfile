FROM node:18-slim

# Install ffmpeg (for audio compression)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy app files
COPY audio-downloader-server-final.js .

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "audio-downloader-server-final.js"]
