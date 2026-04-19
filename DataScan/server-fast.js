// ZenScan Download Server - Ultra Fast Mode (Worker Threads)
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');
const {
    createDeltaTracker,
    buildDeltaPayload
} = require('./scan-fast-stream-delta');
const {
    createAggregationState,
    applyWorkerProgress,
    dedupeAggregatedResults,
    mapKeywordPayloadToClientKeywords,
    rebuildDomainCountFromLineDomains,
    finalizeAggregatedTotals,
    toTopDomains
} = require('./scan-fast-worker-aggregation');
const {
    InvalidRequestError,
    normalizeScanPayload,
    parseKeywordsQueryParam,
    resolveDownloadFilePath
} = require('./scan-request-utils');
const app = express();

const PORT = 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const NUM_WORKERS = os.cpus().length; // Dùng hết CPU cores

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(__dirname));

function stripUrlFromKeyword(kw) {
    return kw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function parseStripUrlLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const noProtocol = trimmed
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '');

    const firstSlash = noProtocol.indexOf('/');
    const firstColon = noProtocol.indexOf(':');

    // host/path:user:pass
    if (firstSlash !== -1 && (firstColon === -1 || firstSlash < firstColon)) {
        const pathColon = noProtocol.indexOf(':', firstSlash + 1);
        if (pathColon !== -1) {
            const userPass = noProtocol.slice(pathColon + 1);
            if (!userPass.includes(':')) return null;

            return {
                urlPartLower: noProtocol.slice(0, pathColon).replace(/\/+$/, ''),
                credentialsLower: userPass
            };
        }
    }

    const parts = noProtocol.split(':');
    if (parts.length < 3) return null;

    let credentialsStart = parts.length - 2;

    // host:port:user:pass
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
        credentialsStart = 2;
    }

    const userPassParts = parts.slice(credentialsStart);
    if (userPassParts.length < 2) return null;

    const credentialsLower = userPassParts.join(':');
    const urlPartLower = parts.slice(0, credentialsStart).join(':').replace(/\/+$/, '');

    return {
        urlPartLower,
        credentialsLower
    };
}

function stripUrlFromLine(line) {
    const parsed = parseStripUrlLine(line);
    if (parsed) {
        return parsed.credentialsLower;
    }

    return line.replace(/^https?:\/\//i, '');
}

// API: Get list of downloaded files
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR)
            .filter(f => f.endsWith('.txt'))
            .map(filename => {
                const filepath = path.join(DOWNLOAD_DIR, filename);
                const stats = fs.statSync(filepath);
                return {
                    name: filename,
                    size: stats.size,
                    modified: stats.mtime,
                    path: filepath
                };
            })
            .sort((a, b) => b.modified - a.modified);
        res.json({ success: true, files });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Download file from URL with progress
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        let filename = path.basename(new URL(url).pathname);
        if (!filename.endsWith('.txt')) {
            filename = `download_${Date.now()}.txt`;
        }

        const filepath = path.join(DOWNLOAD_DIR, filename);

        // Get file size first
        const headResponse = await axios.head(url).catch(() => null);
        const totalSize = headResponse?.headers['content-length'] || 0;

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const writer = fs.createWriteStream(filepath);
        let downloadedSize = 0;
        const startTime = Date.now();

        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;

        res.json({
            success: true,
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath,
                downloadTime: elapsed,
                speed: speed
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Download with SSE progress
app.post('/api/download-stream', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        let filename = path.basename(new URL(url).pathname);
        if (!filename.endsWith('.txt')) {
            filename = `download_${Date.now()}.txt`;
        }

        const filepath = path.join(DOWNLOAD_DIR, filename);

        // Get file size
        const headResponse = await axios.head(url).catch(() => null);
        const totalSize = parseInt(headResponse?.headers['content-length'] || 0);

        res.write(`data: ${JSON.stringify({
            type: 'start',
            filename,
            totalSize
        })}\n\n`);

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const writer = fs.createWriteStream(filepath);
        let downloadedSize = 0;
        const startTime = Date.now();
        let lastUpdate = Date.now();

        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;

            const now = Date.now();
            if (now - lastUpdate > 500) { // Update every 500ms
                const elapsed = (now - startTime) / 1000;
                const speed = downloadedSize / elapsed;
                const progress = totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;

                res.write(`data: ${JSON.stringify({
                    type: 'progress',
                    downloaded: downloadedSize,
                    total: totalSize,
                    progress,
                    speed,
                    elapsed
                })}\n\n`);

                lastUpdate = now;
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;

        res.write(`data: ${JSON.stringify({
            type: 'complete',
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                downloadTime: elapsed,
                speed
            }
        })}\n\n`);

        res.end();
    } catch (err) {
        res.write(`data: ${JSON.stringify({
            type: 'error',
            message: err.message
        })}\n\n`);
        res.end();
    }
});

// API: File content for legacy UI downloads loader
app.get('/api/files/:filename/content', (req, res) => {
    try {
        const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, req.params.filename);
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        res.sendFile(filepath);
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Delete file
app.delete('/api/files/:filename', (req, res) => {
    try {
        const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, req.params.filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Ultra-fast scan with Worker Threads
app.post('/api/scan-fast', async (req, res) => {
    let normalized;
    try {
        normalized = normalizeScanPayload(req.body || {});
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: err.message });
    }

    const { filename, excludeKeywords, stripUrl, dedup } = normalized;
    const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const fileSize = fs.statSync(filepath).size;
    const chunkSize = Math.ceil(fileSize / NUM_WORKERS);

    // Split file into chunks for parallel processing
    const normalizedKeywords = normalized.normalizedKeywords;

    const clientKeywords = normalized.clientKeywords;
    const workers = [];
    const results = createAggregationState(normalizedKeywords);

    let completedWorkers = 0;
    let lastUpdate = Date.now();
    const deltaTracker = createDeltaTracker(normalizedKeywords);

    for (let i = 0; i < NUM_WORKERS; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
            workerData: {
                filepath,
                start,
                end,
                keywords: normalizedKeywords,
                excludeKeywords,
                stripUrl,
                dedup: false // Dedup globally after merge
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                applyWorkerProgress(results, i, msg);

                // Send update every 500ms
                const now = Date.now();
                if (now - lastUpdate > 500) {
                    sendUpdate();
                    lastUpdate = now;
                }
            } else if (msg.type === 'complete') {
                completedWorkers++;

                if (completedWorkers === NUM_WORKERS) {
                    if (dedup) {
                        dedupeAggregatedResults(results, normalizedKeywords);
                        results.domainCount = rebuildDomainCountFromLineDomains(results.lineDomains);
                    }

                    finalizeAggregatedTotals(results);

                    const topDomains = toTopDomains(results, 10);
                    const delta = buildDeltaPayload(results, deltaTracker);
                    const clientKeywordPayload = mapKeywordPayloadToClientKeywords({
                        perKeyword: delta.perKeyword,
                        perKeywordCounts: results.perKeywordCounts
                    }, clientKeywords, Boolean(stripUrl));

                    res.write(`data: ${JSON.stringify({
                        type: 'complete',
                        total: results.total,
                        filtered: results.filtered,
                        results: delta.results,
                        perKeyword: clientKeywordPayload.perKeyword,
                        perKeywordCounts: clientKeywordPayload.perKeywordCounts,
                        topDomains,
                        preview: results.lines.slice(-20)
                    })}\n\n`);

                    res.end();
                }
            }
        });

        worker.on('error', (err) => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        });

        workers.push(worker);
    }

    function sendUpdate() {
        const topDomains = toTopDomains(results, 10);
        const delta = buildDeltaPayload(results, deltaTracker);
        const clientKeywordPayload = mapKeywordPayloadToClientKeywords({
            perKeyword: delta.perKeyword,
            perKeywordCounts: results.perKeywordCounts
        }, clientKeywords, Boolean(stripUrl));

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            total: results.total,
            filtered: results.filtered,
            results: delta.results,
            perKeyword: clientKeywordPayload.perKeyword,
            perKeywordCounts: clientKeywordPayload.perKeywordCounts,
            topDomains,
            preview: results.lines.slice(-20)
        })}\n\n`);
    }

    // Handle client disconnect
    req.on('close', () => {
        workers.forEach(w => w.terminate());
    });
});

// API: GET version for EventSource (SSE)
app.get('/api/scan-fast', async (req, res) => {
    let normalized;
    try {
        normalized = normalizeScanPayload({
            filename: req.query.filename,
            keywords: parseKeywordsQueryParam(req.query.keywords),
            excludeKeywords: req.query.excludeKeywords || '',
            stripUrl: req.query.stripUrl,
            dedup: req.query.dedup
        });
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: err.message });
    }

    const { filename, clientKeywords, normalizedKeywords: normalizedKeywordList, excludeKeywords, stripUrl, dedup } = normalized;
    const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const fileSize = fs.statSync(filepath).size;
    const chunkSize = Math.ceil(fileSize / NUM_WORKERS);

    // Split file into chunks for parallel processing
    const workers = [];
    const results = createAggregationState(normalizedKeywordList);

    let completedWorkers = 0;
    let lastUpdate = Date.now();
    const deltaTracker = createDeltaTracker(normalizedKeywordList);

    for (let i = 0; i < NUM_WORKERS; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
            workerData: {
                filepath,
                start,
                end,
                keywords: normalizedKeywordList,
                excludeKeywords: excludeKeywords || '',
                stripUrl: stripUrl === 'true',
                dedup: false
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                applyWorkerProgress(results, i, msg);

                const now = Date.now();
                if (now - lastUpdate > 500) {
                    sendUpdate();
                    lastUpdate = now;
                }
            } else if (msg.type === 'complete') {
                completedWorkers++;

                if (completedWorkers === NUM_WORKERS) {
                    if (dedup === 'true') {
                        dedupeAggregatedResults(results, normalizedKeywordList);
                        results.domainCount = rebuildDomainCountFromLineDomains(results.lineDomains);
                    }

                    finalizeAggregatedTotals(results);

                    const topDomains = toTopDomains(results, 10);
                    const delta = buildDeltaPayload(results, deltaTracker);
                    const clientKeywordPayload = mapKeywordPayloadToClientKeywords({
                        perKeyword: delta.perKeyword,
                        perKeywordCounts: results.perKeywordCounts
                    }, clientKeywords, stripUrl === 'true');

                    res.write(`data: ${JSON.stringify({
                        type: 'complete',
                        total: results.total,
                        filtered: results.filtered,
                        results: delta.results,
                        perKeyword: clientKeywordPayload.perKeyword,
                        perKeywordCounts: clientKeywordPayload.perKeywordCounts,
                        topDomains,
                        preview: results.lines.slice(-20)
                    })}\n\n`);

                    res.end();
                }
            }
        });

        worker.on('error', (err) => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        });

        workers.push(worker);
    }

    function sendUpdate() {
        const topDomains = toTopDomains(results, 10);
        const delta = buildDeltaPayload(results, deltaTracker);
        const clientKeywordPayload = mapKeywordPayloadToClientKeywords({
            perKeyword: delta.perKeyword,
            perKeywordCounts: results.perKeywordCounts
        }, clientKeywords, stripUrl === 'true');

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            total: results.total,
            filtered: results.filtered,
            results: delta.results,
            perKeyword: clientKeywordPayload.perKeyword,
            perKeywordCounts: clientKeywordPayload.perKeywordCounts,
            topDomains,
            preview: results.lines.slice(-20)
        })}\n\n`);
    }

    req.on('close', () => {
        workers.forEach(w => w.terminate());
    });
});

app.listen(PORT, () => {
    console.log(`ZenScan Server running at http://localhost:${PORT}`);
    console.log(`Using ${NUM_WORKERS} CPU cores for parallel processing`);
    console.log(`Downloads folder: ${DOWNLOAD_DIR}`);
});
