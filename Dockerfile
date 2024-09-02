# Use an official Node.js runtime as the base image
FROM node:20-alpine AS base

# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine
RUN apk add --no-cache libc6-compat

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the Next.js application
# RUN npm run build

# Production image, copy all the files and run next
FROM node:20-alpine AS runner

WORKDIR /app

# uncomment for production mode
# COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json

COPY . .

# Replace useradd with adduser for Alpine
RUN adduser -D -u 1001 app
USER app

# Copy source files into application directory
COPY --chown=app:app . /app

# Expose the port that the application will run on
EXPOSE 3003

# Start the application
CMD ["npm", "run", "dev"]