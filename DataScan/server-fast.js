// ZenScan Download Server - Ultra Fast Mode (Worker Threads)
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');
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

// API: Delete file
app.delete('/api/files/:filename', (req, res) => {
    try {
        const filepath = path.join(DOWNLOAD_DIR, req.params.filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Ultra-fast scan with Worker Threads
app.post('/api/scan-fast', async (req, res) => {
    const { filename, keywords, excludeKeywords, stripUrl, dedup } = req.body;

    if (!filename) {
        return res.status(400).json({ success: false, error: 'Filename is required' });
    }

    const filepath = path.join(DOWNLOAD_DIR, filename);

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
    const results = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: {},
        perKeywordCounts: {},
        domainCount: new Map()
    };

    keywords.forEach(kw => {
        results.perKeyword[kw] = [];
        results.perKeywordCounts[kw] = 0;
    });

    let completedWorkers = 0;
    let lastUpdate = Date.now();

    for (let i = 0; i < NUM_WORKERS; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
            workerData: {
                filepath,
                start,
                end,
                keywords,
                excludeKeywords,
                stripUrl,
                dedup: false // Dedup globally after merge
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                results.total += msg.total;
                results.filtered += msg.filtered;
                results.lines.push(...msg.lines);

                // Merge per-keyword results
                for (const [kw, lines] of Object.entries(msg.perKeyword)) {
                    results.perKeyword[kw].push(...lines);
                    results.perKeywordCounts[kw] += lines.length;
                }

                // Merge domain counts
                for (const [domain, count] of Object.entries(msg.domainCount)) {
                    results.domainCount.set(domain, (results.domainCount.get(domain) || 0) + count);
                }

                // Send update every 500ms
                const now = Date.now();
                if (now - lastUpdate > 500) {
                    sendUpdate();
                    lastUpdate = now;
                }
            } else if (msg.type === 'complete') {
                completedWorkers++;

                if (completedWorkers === NUM_WORKERS) {
                    // All workers done - apply global dedup if needed
                    if (dedup) {
                        const seen = new Set();
                        results.lines = results.lines.filter(line => {
                            if (seen.has(line)) return false;
                            seen.add(line);
                            return true;
                        });
                        results.filtered = results.lines.length;

                        // Dedup per-keyword
                        for (const kw of keywords) {
                            const kwSeen = new Set();
                            results.perKeyword[kw] = results.perKeyword[kw].filter(line => {
                                if (kwSeen.has(line)) return false;
                                kwSeen.add(line);
                                return true;
                            });
                            results.perKeywordCounts[kw] = results.perKeyword[kw].length;
                        }
                    }

                    // Send final result
                    const topDomains = Array.from(results.domainCount.entries())
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10);

                    const perKeyword = {};
                    for (const [kw, lines] of Object.entries(results.perKeyword)) {
                        perKeyword[kw] = lines;
                    }

                    res.write(`data: ${JSON.stringify({
                        type: 'complete',
                        total: results.total,
                        filtered: results.filtered,
                        results: results.lines.join('\n'),
                        perKeyword,
                        perKeywordCounts: results.perKeywordCounts,
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
        const topDomains = Array.from(results.domainCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const perKeyword = {};
        for (const [kw, lines] of Object.entries(results.perKeyword)) {
            if (lines.length > 0) {
                perKeyword[kw] = lines.slice(-100); // Send last 100 lines per keyword
            }
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            total: results.total,
            filtered: results.filtered,
            results: results.lines.slice(-1000).join('\n'), // Send last 1000 lines
            perKeyword,
            perKeywordCounts: results.perKeywordCounts,
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
    const { filename, keywords, excludeKeywords, stripUrl, dedup } = req.query;

    if (!filename) {
        return res.status(400).json({ success: false, error: 'Filename is required' });
    }

    const filepath = path.join(DOWNLOAD_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const keywordList = JSON.parse(keywords || '[]');
    const fileSize = fs.statSync(filepath).size;
    const chunkSize = Math.ceil(fileSize / NUM_WORKERS);

    // Split file into chunks for parallel processing
    const workers = [];
    const results = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: {},
        perKeywordCounts: {},
        domainCount: new Map()
    };

    keywordList.forEach(kw => {
        results.perKeyword[kw] = [];
        results.perKeywordCounts[kw] = 0;
    });

    let completedWorkers = 0;
    let lastUpdate = Date.now();

    for (let i = 0; i < NUM_WORKERS; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
            workerData: {
                filepath,
                start,
                end,
                keywords: keywordList,
                excludeKeywords: excludeKeywords || '',
                stripUrl: stripUrl === 'true',
                dedup: false
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                results.total += msg.total;
                results.filtered += msg.filtered;
                results.lines.push(...msg.lines);

                for (const [kw, lines] of Object.entries(msg.perKeyword)) {
                    results.perKeyword[kw].push(...lines);
                    results.perKeywordCounts[kw] += lines.length;
                }

                for (const [domain, count] of Object.entries(msg.domainCount)) {
                    results.domainCount.set(domain, (results.domainCount.get(domain) || 0) + count);
                }

                const now = Date.now();
                if (now - lastUpdate > 500) {
                    sendUpdate();
                    lastUpdate = now;
                }
            } else if (msg.type === 'complete') {
                completedWorkers++;

                if (completedWorkers === NUM_WORKERS) {
                    if (dedup === 'true') {
                        const seen = new Set();
                        results.lines = results.lines.filter(line => {
                            if (seen.has(line)) return false;
                            seen.add(line);
                            return true;
                        });
                        results.filtered = results.lines.length;

                        for (const kw of keywordList) {
                            const kwSeen = new Set();
                            results.perKeyword[kw] = results.perKeyword[kw].filter(line => {
                                if (kwSeen.has(line)) return false;
                                kwSeen.add(line);
                                return true;
                            });
                            results.perKeywordCounts[kw] = results.perKeyword[kw].length;
                        }
                    }

                    const topDomains = Array.from(results.domainCount.entries())
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10);

                    const perKeyword = {};
                    for (const [kw, lines] of Object.entries(results.perKeyword)) {
                        perKeyword[kw] = lines;
                    }

                    res.write(`data: ${JSON.stringify({
                        type: 'complete',
                        total: results.total,
                        filtered: results.filtered,
                        results: results.lines.join('\n'),
                        perKeyword,
                        perKeywordCounts: results.perKeywordCounts,
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
        const topDomains = Array.from(results.domainCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const perKeyword = {};
        for (const [kw, lines] of Object.entries(results.perKeyword)) {
            if (lines.length > 0) {
                perKeyword[kw] = lines.slice(-100);
            }
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            total: results.total,
            filtered: results.filtered,
            results: results.lines.slice(-1000).join('\n'),
            perKeyword,
            perKeywordCounts: results.perKeywordCounts,
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
