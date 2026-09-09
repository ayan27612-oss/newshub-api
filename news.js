/**
 * ============================================================================
 * PROJECT: NewsHub Enterprise API
 * FILE: news.js
 * DESCRIPTION: A zero-dependency, highly scalable, pure Node.js News API Server.
 * FEATURES: Custom Routing, Caching, Rate Limiting, Logging, Error Handling.
 * AUTHOR: AI Assistant & You
 * VERSION: 1.0.0
 * ============================================================================
 */

'use strict';

const http = require('http');
const url = require('url');
const crypto = require('crypto');

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '127.0.0.1',
    ENVIRONMENT: process.env.NODE_ENV || 'development',
    CACHE_TTL: 60 * 1000, // 60 seconds cache
    RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: 100,
};

// ============================================================================
// 2. ADVANCED LOGGER SYSTEM
// ============================================================================
class Logger {
    static info(message, meta = {}) {
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
    }
    static warn(message, meta = {}) {
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`);
    }
    static error(message, error = null) {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
        if (error) console.error(error.stack || error);
    }
}

// ============================================================================
// 3. CUSTOM ERROR HANDLING
// ============================================================================
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

// ============================================================================
// 4. IN-MEMORY CACHE MANAGER
// ============================================================================
class CacheManager {
    constructor(ttl) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        const expiresAt = Date.now() + this.ttl;
        this.cache.set(key, { value, expiresAt });
        Logger.info(`Cache set for key: ${key}`);
    }

    get(key) {
        const data = this.cache.get(key);
        if (!data) return null;
        
        if (Date.now() > data.expiresAt) {
            this.cache.delete(key);
            Logger.info(`Cache expired for key: ${key}`);
            return null;
        }
        Logger.info(`Cache HIT for key: ${key}`);
        return data.value;
    }
}
const apiCache = new CacheManager(CONFIG.CACHE_TTL);

// ============================================================================
// 5. RATE LIMITER MIDDLEWARE
// ============================================================================
const rateLimitStore = new Map();

function rateLimiter(ip) {
    const currentTime = Date.now();
    if (!rateLimitStore.has(ip)) {
        rateLimitStore.set(ip, { count: 1, startTime: currentTime });
        return true;
    }

    const requestData = rateLimitStore.get(ip);
    if (currentTime - requestData.startTime < CONFIG.RATE_LIMIT_WINDOW) {
        requestData.count++;
        if (requestData.count > CONFIG.RATE_LIMIT_MAX_REQUESTS) {
            return false; // Rate limit exceeded
        }
    } else {
        rateLimitStore.set(ip, { count: 1, startTime: currentTime });
    }
    return true;
}

// ============================================================================
// 6. MOCK DATABASE (NEWS DATA)
// ============================================================================
const MOCK_NEWS_DB = Array.from({ length: 150 }).map((_, index) => ({
    id: crypto.randomUUID(),
    title: `Breaking News Headline ${index + 1}`,
    content: `This is the detailed content for news article number ${index + 1}. It covers global events, tech updates, and more.`,
    category: ['Technology', 'Business', 'Sports', 'Entertainment', 'Health'][Math.floor(Math.random() * 5)],
    author: `Journalist ${Math.floor(Math.random() * 20) + 1}`,
    publishedAt: new Date(Date.now() - Math.floor(Math.random() * 10000000000)).toISOString(),
}));

// ============================================================================
// 7. NEWS SERVICE (BUSINESS LOGIC)
// ============================================================================
class NewsService {
    static async getNews({ page = 1, limit = 10, category = null, search = null }) {
        return new Promise((resolve) => {
            setTimeout(() => { 
                let filteredNews = [...MOCK_NEWS_DB];

                if (category) {
                    filteredNews = filteredNews.filter(news => news.category.toLowerCase() === category.toLowerCase());
                }

                if (search) {
                    filteredNews = filteredNews.filter(news => 
                        news.title.toLowerCase().includes(search.toLowerCase()) || 
                        news.content.toLowerCase().includes(search.toLowerCase())
                    );
                }

                filteredNews.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

                const startIndex = (page - 1) * limit;
                const endIndex = page * limit;
                const paginatedResults = filteredNews.slice(startIndex, endIndex);

                resolve({
                    totalResults: filteredNews.length,
                    totalPages: Math.ceil(filteredNews.length / limit),
                    currentPage: Number(page),
                    data: paginatedResults
                });
            }, 150);
        });
    }
}

// ============================================================================
// 8. CUSTOM ROUTER & SERVER FRAMEWORK
// ============================================================================
class Router {
    constructor() {
        this.routes = { GET: {}, POST: {} };
    }

    get(path, handler) { this.routes.GET[path] = handler; }

    async handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const path = parsedUrl.pathname;
        const method = req.method;
        const clientIp = req.socket.remoteAddress;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (!rateLimiter(clientIp)) {
            return this.sendResponse(res, 429, { status: 'error', message: 'Too many requests.' });
        }

        Logger.info(`Incoming Request: ${method} ${path}`);
        const handler = this.routes[method]?.[path];

        if (handler) {
            try {
                req.query = parsedUrl.query;
                await handler(req, res);
            } catch (error) {
                this.handleError(error, res);
            }
        } else {
            this.sendResponse(res, 404, { status: 'error', message: `Route not found.` });
        }
    }

    sendResponse(res, statusCode, data) {
        res.writeHead(statusCode);
        res.end(JSON.stringify(data));
    }

    handleError(error, res) {
        Logger.error('SERVER ERROR:', error);
        this.sendResponse(res, 500, { status: 'error', message: 'Internal Server Error' });
    }
}

const app = new Router();

// ============================================================================
// 9. API ENDPOINTS
// ============================================================================

// GET /api/news - Fetch all news
app.get('/api/news', async (req, res) => {
    const cacheKey = req.url;
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData) {
        return app.sendResponse(res, 200, { status: 'success', source: 'cache', ...cachedData });
    }

    const { page, limit, category, search } = req.query;
    const newsData = await NewsService.getNews({ page, limit, category, search });
    
    apiCache.set(cacheKey, newsData);
    app.sendResponse(res, 200, { status: 'success', source: 'database', ...newsData });
});

// GET /api/health - Server health check
app.get('/api/health', (req, res) => {
    app.sendResponse(res, 200, { status: 'success', uptime: process.uptime() });
});

// ============================================================================
// 10. SERVER INITIALIZATION
// ============================================================================
const server = http.createServer((req, res) => app.handleRequest(req, res));

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🚀 NewsHub API running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
});
