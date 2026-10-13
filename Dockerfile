FROM node:20-bookworm-slim

# Install Tor daemon and system utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    tor \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Configure Tor data directory and permissions
RUN mkdir -p /var/lib/tor /var/log/tor /etc/tor && \
    chown -R debian-tor:debian-tor /var/lib/tor /var/log/tor && \
    chmod 700 /var/lib/tor

# Copy Tor configuration
COPY torrc /etc/tor/torrc

WORKDIR /app

# Copy application files
COPY package.json ./
COPY bbb-vote-old.mjs ./
COPY server.mjs ./
COPY entrypoint.sh ./

# Ensure entrypoint has executable permissions
RUN chmod +x ./entrypoint.sh

# Expose default port (Railway automatically binds PORT)
EXPOSE 3000

# Start Tor and 24/7 voting engine
CMD ["./entrypoint.sh"]
