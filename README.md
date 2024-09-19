# Project Overview

This project is a Node.js server that interacts with various NFT marketplaces, allowing users to place bids, cancel orders, and manage tasks related to NFT trading. It utilizes WebSocket for real-time communication and Redis for task management and caching.

## Table of Contents

- [Installation](#installation)
- [Running the Project](#running-the-project)
- [Key Components](#key-components)
- [Functions Overview](#functions-overview)
- [Environment Variables](#environment-variables)
- [License](#license)

## Installation

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Set up Redis:**
   Ensure you have Redis installed and running. You can use Docker to run Redis:

   ```bash
   docker-compose up -d
   ```

4. **Set up environment variables:**
   Create a `.env` file in the root directory and add the following variables:
   ```env
   OPENSEA_API_KEY=<your_opensea_api_key>
   MONGODB_URI=<your_mongodb_uri>
   REDIS_URI=redis://localhost:6379
   PORT=3003
   ```

## Running the Project

To start the server in development mode, use:

npm run dev

## Key Components

- **Express:** The server framework used to handle HTTP requests.
- **WebSocket:** For real-time communication with clients.
- **BullMQ:** A queue system for managing tasks and jobs.
- **Mongoose:** ODM for MongoDB, used to interact with the database.
- **Redis:** Used for caching and managing state across tasks.

### Directory Structure

- `src/`: Contains the main application code.
  - `index.ts`: Entry point of the application.
  - `models/`: Mongoose models for MongoDB.
  - `marketplace/`: Functions related to different NFT marketplaces.
  - `utils/`: Utility functions and classes.
  - `adapter/`: WebSocket handling and event management.
  - `functions/`: Helper functions for various operations.

## Functions Overview

- **initialize():** Sets up the application, including rate limiting and API key configuration.
- **fetchCurrentTasks():** Retrieves current tasks from the database and adds them to the queue.
- **processNewTask(task):** Adds a new task to the queue and subscribes to the relevant collections.
- **updateStatus(task):** Updates the running status of a task.
- **connectWebSocket():** Establishes a connection to the OpenSea WebSocket for real-time updates.

## Environment Variables

Make sure to set the following environment variables in your `.env` file:

- `OPENSEA_API_KEY`: Your OpenSea API key.
- `MONGODB_URI`: Connection string for MongoDB.
- `REDIS_URI`: Connection string for Redis.
- `PORT`: Port on which the server will run (default is 3003).

## License

This project is licensed under the MIT License.
