# Multi-stage build for the notification worker
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources
COPY tsconfig.json ./
COPY index.ts ./

# Build TS -> JS
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# By default, run the scheduler
CMD ["node", "dist/index.js"]
