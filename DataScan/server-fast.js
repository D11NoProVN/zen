// ZenScan Download Server - Ultra Fast Mode (Worker Threads)
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('node:stream/promises');
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
    parseFilenamesQueryParam,
    resolveDownloadFilePath,
    getUniqueUploadFilename
} = require('./scan-request-utils');
const {
    ArchiveExtractionError,
    ArchivePasswordRequiredError,
    detectDownloadedArchiveType,
    extractDownloadedArchive
} = require('./download-archive-utils');
const app = express();

function createDownloadSuccessPayload({ file, extraction }) {
    if (extraction) {
        return {
            success: true,
            extraction: {
                archiveType: extraction.archiveType,
                extractedCount: extraction.extractedCount,
                files: extraction.files
            }
        };
    }

    return {
        success: true,
        file
    };
}

function createDownloadCompleteEvent({ file, extraction }) {
    if (extraction) {
        return {
            type: 'complete',
            extraction: {
                archiveType: extraction.archiveType,
                extractedCount: extraction.extractedCount,
                files: extraction.files
            }
        };
    }

    return {
        type: 'complete',
        file
    };
}

function buildDownloadFilename(url, headers = {}) {
    const urlObj = new URL(url);
    
    // 1. Try filename from query params (common in some hosting sites)
    const queryFilename = urlObj.searchParams.get('filename');
    if (queryFilename) {
        return path.basename(queryFilename);
    }

    // 2. Try filename from Content-Disposition header
    const cd = headers['content-disposition'];
    if (cd) {
        const match = cd.match(/filename\*?=['"]?(?:UTF-8'')?([^'";]+)['"]?/i);
        if (match && match[1]) {
            return path.basename(decodeURIComponent(match[1]));
        }
    }

    const pathname = urlObj.pathname;
    let basename = path.basename(pathname);
    if (!basename || basename === '/' || basename === '.') {
        basename = `download_${Date.now()}`;
    }

    // 3. Try extension from Content-Type if missing or not an archive
    const ct = headers['content-type'] || '';
    const lower = basename.toLowerCase();
    const hasExtension = lower.endsWith('.txt') || lower.endsWith('.zip') || lower.endsWith('.rar');
    
    if (!hasExtension) {
        if (ct.includes('application/zip')) {
            basename += '.zip';
        } else if (ct.includes('application/x-rar') || ct.includes('application/vnd.rar')) {
            basename += '.rar';
        } else {
            basename += '.txt';
        }
    }

    return basename;
}

const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1'
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 0,
    maxRedirects: 10
};

function getAxiosConfig(url, proxyUrl = null) {
    const origin = new URL(url).origin;
    const config = {
        ...AXIOS_CONFIG,
        headers: {
            ...AXIOS_CONFIG.headers,
            'Referer': origin + '/'
        }
    };

    if (proxyUrl) {
        try {
            const p = new URL(proxyUrl);
            config.proxy = {
                protocol: p.protocol.replace(':', ''),
                host: p.hostname,
                port: parseInt(p.port || (p.protocol === 'https:' ? 443 : 80))
            };
            if (p.username) {
                config.proxy.auth = {
                    username: decodeURIComponent(p.username),
                    password: decodeURIComponent(p.password)
                };
            }
        } catch (err) {
            // Ignore invalid proxy
        }
    }

    return config;
}

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function startProxyServer(port = 8081) {
    const USER = 'zen';
    const PASS = '123456';

    function isAuthorizedProxyRequest(authHeader) {
        if (!authHeader) return false;

        const match = authHeader.match(/^Basic\s+(.+)$/i);
        if (!match) return false;

        try {
            return Buffer.from(match[1], 'base64').toString() === `${USER}:${PASS}`;
        } catch (err) {
            return false;
        }
    }

    function removeProxyHeaders(headers) {
        const cleanHeaders = { ...headers };
        delete cleanHeaders['proxy-authorization'];
        delete cleanHeaders['proxy-connection'];
        return cleanHeaders;
    }

    function writeProxyAuthRequired(socket) {
        socket.write([
            'HTTP/1.1 407 Proxy Authentication Required',
            'Proxy-Authenticate: Basic realm="ZenProxy"',
            'Connection: close',
            '',
            ''
        ].join('\r\n'));
        socket.end();
    }

    const server = http.createServer((req, res) => {
        if (!isAuthorizedProxyRequest(req.headers['proxy-authorization'])) {
            res.writeHead(407, {
                'Proxy-Authenticate': 'Basic realm="ZenProxy"',
                'Connection': 'close'
            });
            return res.end();
        }

        let targetUrl;
        try {
            targetUrl = new URL(req.url);
        } catch (err) {
            res.writeHead(400, { 'Connection': 'close' });
            return res.end('Invalid proxy target');
        }
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
            res.writeHead(400, { 'Connection': 'close' });
            return res.end('Unsupported proxy protocol');
        }

        const requestModule = targetUrl.protocol === 'https:' ? https : http;
        const proxyReq = requestModule.request({
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            method: req.method,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers: removeProxyHeaders(req.headers)
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Connection': 'close' });
            }
            res.end('Bad gateway');
        });

        req.pipe(proxyReq);
    });

    server.on('connect', (req, socket, head) => {
        if (!isAuthorizedProxyRequest(req.headers['proxy-authorization'])) {
            return writeProxyAuthRequired(socket);
        }

        const [host, rawPort] = req.url.split(':');
        const targetPort = parseInt(rawPort || '443', 10);
        if (!host || Number.isNaN(targetPort)) return socket.end();

        const targetSocket = net.connect(targetPort, host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) targetSocket.write(head);
            targetSocket.pipe(socket);
            socket.pipe(targetSocket);
        });

        targetSocket.on('error', () => {
            socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            socket.end();
        });
        socket.on('error', () => targetSocket.end());
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`\n==========================================`);
        console.log(`HTTP PROXY SERVER ACTIVE ON PORT ${port}`);
        console.log(`Auth: ${USER}:${PASS}`);
        console.log(`==========================================\n`);
    });
}

async function finalizeDownloadedFile({ filepath, filename, password }) {
    const stats = fs.statSync(filepath);
    if (stats.size === 0) {
        throw new Error('Downloaded file is empty (0 bytes). Check if the link is expired or blocked.');
    }

    const archiveType = detectDownloadedArchiveType(filename);
    if (!archiveType) {
        const stats = fs.statSync(filepath);
        return {
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath
            }
        };
    }

    const extraction = await extractDownloadedArchive({
        archivePath: filepath,
        archiveType,
        downloadDir: DOWNLOAD_DIR,
        password
    });

    return { extraction };
}

function isArchiveExtractionError(err) {
    return err instanceof ArchiveExtractionError;
}

function getDownloadErrorStatus(err) {
    return isArchiveExtractionError(err) ? 400 : 500;
}

function getDownloadErrorMessage(err) {
    return err.message;
}

function getDownloadStartFilename(url, headers = {}) {
    return buildDownloadFilename(url, headers);
}

function getDownloadTargetPath(filename) {
    return path.join(DOWNLOAD_DIR, filename);
}

function createDownloadFilePayload(file, downloadTime, speed) {
    return {
        ...file,
        downloadTime,
        speed
    };
}

function createFinalDownloadPayload({ finalized, elapsed, speed }) {
    if (finalized.file) {
        return createDownloadSuccessPayload({
            file: createDownloadFilePayload(finalized.file, elapsed, speed)
        });
    }

    return createDownloadSuccessPayload({ extraction: finalized.extraction });
}

function createFinalDownloadEvent({ finalized, elapsed, speed }) {
    if (finalized.file) {
        return createDownloadCompleteEvent({
            file: createDownloadFilePayload(finalized.file, elapsed, speed)
        });
    }

    return createDownloadCompleteEvent({ extraction: finalized.extraction });
}

const PORT = 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const NUM_WORKERS = os.cpus().length; // Dùng hết CPU cores

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
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
    const { url, proxy } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        const config = getAxiosConfig(url, proxy);
        const headResponse = await axios.head(url, config).catch(() => null);
        const filename = getDownloadStartFilename(url, headResponse?.headers);
        const filepath = getDownloadTargetPath(filename);

        const response = await axios({
            ...config,
            method: 'GET',
            url: url,
            responseType: 'stream',
            validateStatus: (status) => status === 200
        });

        const writer = fs.createWriteStream(filepath);
        const startTime = Date.now();

        try {
            await pipeline(response.data, writer);
        } catch (pipeErr) {
            // If pipeline fails, ensure writer is closed and cleanup
            writer.close();
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            throw new Error(`Download failed during transfer: ${pipeErr.message}. Possible out of disk space.`);
        }

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;
        const finalized = await finalizeDownloadedFile({ filepath, filename });

        res.json(createFinalDownloadPayload({ finalized, elapsed, speed }));
    } catch (err) {
        if (err instanceof ArchivePasswordRequiredError) {
            const config = getAxiosConfig(url, proxy);
            const headResponse = await axios.head(url, config).catch(() => null);
            const filename = getDownloadStartFilename(url, headResponse?.headers);
            return res.status(400).json({ success: false, error: 'PASSWORD_REQUIRED', filename, message: getDownloadErrorMessage(err) });
        }
        res.status(getDownloadErrorStatus(err)).json({ success: false, error: getDownloadErrorMessage(err) });
    }
});

// API: Download with SSE progress
app.post('/api/download-stream', async (req, res) => {
    const { url, proxy } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const config = getAxiosConfig(url, proxy);
        const headResponse = await axios.head(url, config).catch(() => null);
        const filename = getDownloadStartFilename(url, headResponse?.headers);
        const filepath = getDownloadTargetPath(filename);

        const totalSize = parseInt(headResponse?.headers['content-length'] || 0);

        res.write(`data: ${JSON.stringify({
            type: 'start',
            filename,
            totalSize
        })}\n\n`);

        const response = await axios({
            ...config,
            method: 'GET',
            url: url,
            responseType: 'stream',
            validateStatus: (status) => status === 200
        });

        const writer = fs.createWriteStream(filepath);
        let downloadedSize = 0;
        const startTime = Date.now();
        let lastUpdate = Date.now();

        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;

            const now = Date.now();
            if (now - lastUpdate > 500) {
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

        try {
            await pipeline(response.data, writer);
        } catch (pipeErr) {
            writer.close();
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            throw new Error(`Streaming download failed: ${pipeErr.message}. Possible out of disk space.`);
        }

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;
        const finalized = await finalizeDownloadedFile({ filepath, filename });

        res.write(`data: ${JSON.stringify(createFinalDownloadEvent({ finalized, elapsed, speed }))}\n\n`);

        res.end();
    } catch (err) {
        if (err instanceof ArchivePasswordRequiredError) {
            const config = getAxiosConfig(url);
            const headResponse = await axios.head(url, config).catch(() => null);
            const filename = getDownloadStartFilename(url, headResponse?.headers);
            res.write(`data: ${JSON.stringify({
                type: 'password_required',
                filename,
                message: getDownloadErrorMessage(err)
            })}\n\n`);
        } else {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: getDownloadErrorMessage(err)
            })}\n\n`);
        }
        res.end();
    }
});

app.post('/api/extract', async (req, res) => {
    const { filename, password } = req.body;
    if (!filename) {
        return res.status(400).json({ success: false, error: 'Filename is required' });
    }

    try {
        const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        const finalized = await finalizeDownloadedFile({ filepath, filename, password });
        res.json(createFinalDownloadPayload({ finalized, elapsed: 0, speed: 0 }));
    } catch (err) {
        if (err instanceof ArchivePasswordRequiredError) {
            return res.status(400).json({ success: false, error: 'PASSWORD_REQUIRED', message: getDownloadErrorMessage(err) });
        }
        res.status(getDownloadErrorStatus(err)).json({ success: false, error: getDownloadErrorMessage(err) });
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

app.post('/api/files/upload', async (req, res) => {
    try {
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        if (files.length === 0) {
            throw new InvalidRequestError('At least one file is required');
        }

        const uploaded = [];
        for (const file of files) {
            if (!file || typeof file.name !== 'string' || typeof file.content !== 'string') {
                throw new InvalidRequestError('Each uploaded file must include name and content');
            }

            const { filename, filepath } = getUniqueUploadFilename(DOWNLOAD_DIR, file.name);
            fs.writeFileSync(filepath, file.content, 'utf8');
            const stats = fs.statSync(filepath);
            uploaded.push({
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath
            });
        }

        res.json({ success: true, files: uploaded });
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

const globalActiveScans = new Map();

async function runFastScanBackground(scanId, normalized) {
    const scan = globalActiveScans.get(scanId);
    if (!scan) return;

    const { filenames, normalizedKeywords, excludeKeywords, stripUrl, dedup } = normalized;
    const results = createAggregationState(normalizedKeywords, dedup);
    const deltaTracker = createDeltaTracker(normalizedKeywords);
    
    scan.results = results;
    scan.deltaTracker = deltaTracker;
    scan.status = 'scanning';

    async function scanSingleFile(filename) {
        const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);
        if (!fs.existsSync(filepath)) return;

        const fileSize = fs.statSync(filepath).size;
        const chunkSize = Math.ceil(fileSize / NUM_WORKERS);

        await new Promise((resolve, reject) => {
            let completedWorkers = 0;
            const workers = [];
            scan.activeWorkers = workers;

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
                        dedup: false
                    }
                });

                worker.on('message', (msg) => {
                    if (scan.aborted) {
                        worker.terminate();
                        return;
                    }

                    if (msg.type === 'progress') {
                        applyWorkerProgress(results, `${filename}:${i}`, msg);
                        scan.lastUpdate = Date.now();
                    } else if (msg.type === 'complete') {
                        completedWorkers++;
                        if (completedWorkers === NUM_WORKERS) {
                            scan.activeWorkers = [];
                            resolve();
                        }
                    }
                });

                worker.on('error', (err) => {
                    console.error(`Worker error: ${err.message}`);
                    completedWorkers++;
                    if (completedWorkers === NUM_WORKERS) resolve();
                });
                workers.push(worker);
            }
        });
    }

    for (const filename of filenames) {
        if (scan.aborted) break;
        scan.currentFile = filename;
        await scanSingleFile(filename);
    }

    if (!scan.aborted) {
        finalizeAggregatedTotals(results);
        scan.status = 'completed';
    } else {
        scan.status = 'stopped';
    }
    
    scan.activeWorkers = [];
    // Keep results for 1 hour after completion so user can download
    setTimeout(() => {
        globalActiveScans.delete(scanId);
    }, 60 * 60 * 1000);
}

function buildClientPayload(results, deltaTracker, clientKeywords, stripUrl) {
    const topDomains = toTopDomains(results, 10);
    const delta = buildDeltaPayload(results, deltaTracker);
    const clientKeywordPayload = mapKeywordPayloadToClientKeywords({
        perKeyword: delta.perKeyword,
        perKeywordCounts: results.perKeywordCounts
    }, clientKeywords, Boolean(stripUrl));

    return {
        total: results.total,
        filtered: results.filtered,
        results: delta.results,
        perKeyword: clientKeywordPayload.perKeyword,
        perKeywordCounts: clientKeywordPayload.perKeywordCounts,
        topDomains,
        preview: results.lines.slice(-20)
    };
}

// API: Start background scan
app.get('/api/scan-fast', async (req, res) => {
    let normalized;
    try {
        normalized = normalizeScanPayload({
            filename: req.query.filename,
            filenames: parseFilenamesQueryParam(req.query.filenames),
            keywords: parseKeywordsQueryParam(req.query.keywords),
            excludeKeywords: req.query.excludeKeywords || '',
            stripUrl: req.query.stripUrl,
            dedup: req.query.dedup
        });
    } catch (err) {
        return res.status(err instanceof InvalidRequestError ? 400 : 500).json({ success: false, error: err.message });
    }

    const scanId = `scan_${Date.now()}`;
    globalActiveScans.set(scanId, {
        id: scanId,
        normalized,
        status: 'initializing',
        aborted: false,
        activeWorkers: [],
        results: null,
        deltaTracker: null,
        lastUpdate: Date.now(),
        currentFile: ''
    });

    runFastScanBackground(scanId, normalized);
    
    res.json({ success: true, scanId });
});

// API: Stream status for a scanId
app.get('/api/scan-status/:scanId', (req, res) => {
    const { scanId } = req.params;
    const scan = globalActiveScans.get(scanId);

    if (!scan) {
        return res.status(404).json({ success: false, error: 'Scan session not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendUpdate = (force = false) => {
        if (!scan.results) return;
        const payload = buildClientPayload(scan.results, scan.deltaTracker, scan.normalized.clientKeywords, scan.normalized.stripUrl);
        res.write(`data: ${JSON.stringify({
            type: scan.status === 'completed' ? 'complete' : 'progress',
            scanId,
            currentFile: scan.currentFile,
            processedFiles: scan.normalized.filenames.length,
            ...payload
        })}\n\n`);
    };

    const interval = setInterval(() => {
        if (scan.status === 'completed' || scan.status === 'stopped') {
            sendUpdate(true);
            clearInterval(interval);
            res.end();
            return;
        }
        sendUpdate();
    }, 800);

    req.on('close', () => {
        clearInterval(interval);
    });
    
    // Send immediate first frame
    if (scan.results) sendUpdate(true);
});

// API: Check for active scans
app.get('/api/scan-active', (req, res) => {
    const active = Array.from(globalActiveScans.values())
        .filter(s => s.status === 'scanning' || s.status === 'initializing')
        .map(s => ({ id: s.id, status: s.status }));
    res.json({ success: true, active });
});

// API: Stop scan
app.post('/api/scan-stop/:scanId', (req, res) => {
    const scan = globalActiveScans.get(req.params.scanId);
    if (scan) {
        scan.aborted = true;
        scan.activeWorkers.forEach(w => w.terminate());
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Scan not found' });
    }
});

function startServer() {
    // Start HTTP/HTTPS Proxy server on port 8081
    startProxyServer(8081);

    return app.listen(PORT, () => {
        console.log(`ZenScan Server running at http://localhost:${PORT}`);
        console.log(`Using ${NUM_WORKERS} CPU cores for parallel processing`);
        console.log(`Downloads folder: ${DOWNLOAD_DIR}`);
    });
}

module.exports = {
    app,
    ArchiveExtractionError,
    createDownloadSuccessPayload,
    createDownloadCompleteEvent,
    buildDownloadFilename,
    finalizeDownloadedFile,
    getDownloadErrorStatus,
    getDownloadErrorMessage,
    getDownloadStartFilename,
    getDownloadTargetPath,
    createFinalDownloadPayload,
    startServer
};

if (require.main === module) {
    startServer();
}
