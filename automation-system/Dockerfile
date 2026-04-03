# Use official Node.js 20 slim image
FROM node:20-slim

# Install Chromium and required system libraries for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    libasound2 \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading Chromium (use system one instead)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Create temp session directory (WhatsApp session files — ephemeral, actual data in Neon)
RUN mkdir -p /tmp/sessions

EXPOSE 3000

CMD ["node", "backend/app.js"]
