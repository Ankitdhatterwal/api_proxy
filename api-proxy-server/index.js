require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs').promises; // Use the promise-based API
const cron = require('node-cron');
const logger = require('./logger');

const app = express();

// Load environment variables
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW, 10) * 60 * 1000 || 60000; // Default to 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 10; // Default to 10 requests
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION, 10) || 60; // Default to 60 seconds
const API_URL = process.env.API_URL || 'https://jsonplaceholder.typicode.com/todos';

// Set up rate limiter
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  message: 'Too many requests, please try again later.',
  headers: true,
});

// Set up cache with a duration of CACHE_DURATION seconds
const cache = new NodeCache({ stdTTL: CACHE_DURATION });

// Apply rate limiter to all requests, except for cached responses
app.use((req, res, next) => {
  if (req.url === '/proxy' && cache.has('todos')) {
    // If the request is for the /proxy endpoint and the response is cached,
    // skip the rate limiter middleware
    return next();
  }
  limiter(req, res, next);
});

// Logging middleware
app.use((req, res, next) => {
  const rateLimitStatus = res.getHeaders()['x-ratelimit-remaining'];
  logger.info(`[${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl} - Rate Limit Remaining: ${rateLimitStatus}`);
  next();
});

// Function to fetch and store data
const fetchDataAndStore = async () => {
  try {
    const response = await axios.get(API_URL);
    const data = response.data;
    await fs.writeFile('data.json', JSON.stringify(data, null, 2));
    logger.info('Data fetched and stored successfully');
  } catch (error) {
    logger.error(`Error fetching data from API: ${error.message}`);
  }
};



// Proxy endpoint
app.get('/proxy', async (req, res, next) => {
  const cacheKey = 'todos';

  try {
    // Check if response is cached
    if (cache.has(cacheKey)) {
      logger.info('Serving from cache');
      const cachedData = cache.get(cacheKey);
      return res.json({
        data: cachedData,
        cacheFlag: true,
      });
    } else {
      logger.info('Cache miss');
    }

    // Check if data is available in local storage
    try {
      const data = await fs.readFile('data.json', 'utf8');
      const jsonData = JSON.parse(data);
      cache.set(cacheKey, jsonData); // Cache the data
      logger.info('Serving from local storage');
      return res.json({
        data: jsonData,
        cacheFlag: false,
      });
    } catch (error) {
      logger.error('Error reading local data file, fetching from API:', error.message);
    }

    // Fetch from API if cache and local storage are not available
    try {
      const response = await axios.get(API_URL, {
        params: req.query,
      });
      cache.set(cacheKey, response.data);
      logger.info('Serving from API');
      return res.json({
        data: response.data,
        cacheFlag: false, // Set cacheFlag to false when fetching from API
      });
    } catch (error) {
      logger.error(`Error fetching data from API: ${error.message}`);
      next(new Error('Error fetching data from API')); // Pass error to centralized error handler
    }
  } catch (error) {
    logger.error(`Error interacting with cache: ${error.message}`);
    next(new Error('Error interacting with cache')); // Pass error to centralized error handler
  }
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  logger.error(`[${new Date().toISOString()}] ${req.ip} ${req.method} ${req.originalUrl} - ${err.message}`);
  res.status(500).json({ error: err.message });
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
