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

function buildDownloadFilename(url) {
    const pathname = new URL(url).pathname;
    let basename = path.basename(pathname);
    if (!basename || basename === '/' || basename === '.') {
        return `download_${Date.now()}.txt`;
    }

    const lower = basename.toLowerCase();
    if (!lower.endsWith('.txt') && !lower.endsWith('.zip') && !lower.endsWith('.rar')) {
        basename += '.txt';
    }

    return basename;
}

async function finalizeDownloadedFile({ filepath, filename, password }) {
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

function getDownloadStartFilename(url) {
    return buildDownloadFilename(url);
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
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        const filename = getDownloadStartFilename(url);
        const filepath = getDownloadTargetPath(filename);

        await axios.head(url).catch(() => null);

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const writer = fs.createWriteStream(filepath);
        const startTime = Date.now();

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;
        const finalized = await finalizeDownloadedFile({ filepath, filename });

        res.json(createFinalDownloadPayload({ finalized, elapsed, speed }));
    } catch (err) {
        if (err instanceof ArchivePasswordRequiredError) {
            const filename = getDownloadStartFilename(url);
            return res.status(400).json({ success: false, error: 'PASSWORD_REQUIRED', filename, message: getDownloadErrorMessage(err) });
        }
        res.status(getDownloadErrorStatus(err)).json({ success: false, error: getDownloadErrorMessage(err) });
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
        const filename = getDownloadStartFilename(url);
        const filepath = getDownloadTargetPath(filename);

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

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = stats.size / elapsed;
        const finalized = await finalizeDownloadedFile({ filepath, filename });

        res.write(`data: ${JSON.stringify(createFinalDownloadEvent({ finalized, elapsed, speed }))}\n\n`);

        res.end();
    } catch (err) {
        if (err instanceof ArchivePasswordRequiredError) {
            const filename = getDownloadStartFilename(url);
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

async function runFastScan(res, req, normalized) {
    const { filenames, clientKeywords, normalizedKeywords, excludeKeywords, stripUrl, dedup } = normalized;
    const results = createAggregationState(normalizedKeywords);
    const deltaTracker = createDeltaTracker(normalizedKeywords);
    let aborted = false;
    let activeWorkers = [];

    req.on('close', () => {
        aborted = true;
        activeWorkers.forEach(w => w.terminate());
    });

    async function scanSingleFile(filename) {
        const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);
        if (!fs.existsSync(filepath)) {
            throw new InvalidRequestError(`File not found: ${filename}`);
        }

        const fileSize = fs.statSync(filepath).size;
        const chunkSize = Math.ceil(fileSize / NUM_WORKERS);

        await new Promise((resolve, reject) => {
            let completedWorkers = 0;
            const workers = [];
            activeWorkers = workers;

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
                    if (aborted) {
                        worker.terminate();
                        return;
                    }

                    if (msg.type === 'progress') {
                        applyWorkerProgress(results, `${filename}:${i}`, msg);
                        sendUpdate(filename);
                    } else if (msg.type === 'complete') {
                        completedWorkers++;
                        if (completedWorkers === NUM_WORKERS) {
                            activeWorkers = [];
                            resolve();
                        }
                    }
                });

                worker.on('error', reject);
                workers.push(worker);
            }
        });
    }

    function buildClientPayload() {
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

    function sendUpdate(currentFile) {
        res.write(`data: ${JSON.stringify({
            type: 'progress',
            currentFile,
            processedFiles: filenames.length,
            ...buildClientPayload()
        })}\n\n`);
    }

    for (const filename of filenames) {
        if (aborted) return;
        await scanSingleFile(filename);
    }

    if (dedup) {
        dedupeAggregatedResults(results, normalizedKeywords);
        results.domainCount = rebuildDomainCountFromLineDomains(results.lineDomains);
    }

    finalizeAggregatedTotals(results);

    res.write(`data: ${JSON.stringify({
        type: 'complete',
        ...buildClientPayload()
    })}\n\n`);
    res.end();
}

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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        await runFastScan(res, req, normalized);
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            return res.end();
        }
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
    }
});

// API: GET version for EventSource (SSE)
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
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: err.message });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        await runFastScan(res, req, normalized);
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            return res.end();
        }
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
    }
});

function startServer() {
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
