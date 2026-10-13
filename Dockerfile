FROM node:20-bookworm-slim

# Install network proxy daemon and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    tor \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Configure directory structure and permissions
RUN mkdir -p /var/lib/tor /var/log/tor /etc/tor && \
    chown -R debian-tor:debian-tor /var/lib/tor /var/log/tor && \
    chmod 700 /var/lib/tor

# Copy proxy configuration
COPY net.conf /etc/tor/torrc

WORKDIR /app

# Copy application files
COPY package.json ./
COPY worker.mjs ./
COPY server.mjs ./
COPY entrypoint.sh ./

# Set execution permissions
RUN chmod +x ./entrypoint.sh

# Expose default port
EXPOSE 3000

# Start supervisor service
CMD ["./entrypoint.sh"]
