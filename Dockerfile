# Use a lightweight Node.js base image
FROM node:20-alpine

# Install tools required for native modules and MongoDB backups (mongodump)
RUN apk add --no-cache \
	python3 \
	make \
	g++ \
	bash \
	curl \
	ca-certificates \
	mongodb-tools && \
	mongodump --version

# Create and set working directory
WORKDIR /usr/src/app

# Set NODE_ENV to production by default
ENV NODE_ENV=production

# Install dependencies first (leverage Docker layer cache)
COPY package*.json ./
# Prefer reproducible installs; if lockfile is out of sync, fall back to npm install
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source
COPY . .

# Ensure scripts and backup directory are present with sane permissions
RUN chmod +x scripts/*.sh 2>/dev/null || true && \
	mkdir -p backups && \
	chmod 755 backups

# Cloud Run provides a PORT env var; default to 8080
ENV PORT=8080
EXPOSE 8080

# Start the server with PORT explicitly set
CMD ["sh", "-c", "PORT=${PORT:-8080} npm start"]
