// ZenScan Download Server - Optimized for Large Files
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const {
    InvalidRequestError,
    normalizeScanPayload,
    resolveDownloadFilePath
} = require('./scan-request-utils');
const app = express();

const PORT = 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const CHUNK_SIZE = 10000; // Lines per chunk

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

// API: Download file from URL
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        // Extract filename from URL or generate one
        let filename = path.basename(new URL(url).pathname);
        if (!filename.endsWith('.txt')) {
            filename = `download_${Date.now()}.txt`;
        }

        const filepath = path.join(DOWNLOAD_DIR, filename);

        // Download file
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        res.json({
            success: true,
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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

// API: Stream scan file (optimized for large files)
app.post('/api/scan-stream', async (req, res) => {
    let normalized;
    try {
        normalized = normalizeScanPayload(req.body || {});
    } catch (err) {
        if (err instanceof InvalidRequestError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: err.message });
    }

    const { filename, clientKeywords, normalizedKeywords, excludeList, stripUrl, dedup } = normalized;
    const filepath = resolveDownloadFilePath(DOWNLOAD_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Set headers for SSE (Server-Sent Events)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const keywordList = normalizedKeywords;

    const clientKeywordMap = new Map();
    for (let i = 0; i < clientKeywords.length; i++) {
        clientKeywordMap.set(keywordList[i] || clientKeywords[i], clientKeywords[i]);
    }

    const seen = dedup ? new Set() : null;
    const domainCount = new Map();
    const perKeywordCounts = {};
    keywordList.forEach(k => perKeywordCounts[k] = 0);

    let totalLines = 0;
    let filteredLines = 0;
    let buffer = [];
    let perKeywordBuffer = {};
    keywordList.forEach(k => perKeywordBuffer[k] = []);

    const rl = createInterface({
        input: createReadStream(filepath),
        crlfDelay: Infinity
    });

    rl.on('line', (line) => {
        totalLines++;

        const lineLower = line.toLowerCase();

        let matchedKeyword = null;

        if (stripUrl) {
            const parsed = parseStripUrlLine(lineLower);
            if (!parsed) return;

            const { urlPartLower, credentialsLower } = parsed;

            // Check exclude against URL and credentials in strip mode
            if (excludeList.some(ex => urlPartLower.includes(ex) || credentialsLower.includes(ex))) return;

            for (const kw of keywordList) {
                if (urlPartLower.includes(kw) || credentialsLower.includes(kw)) {
                    matchedKeyword = kw;
                    break;
                }
            }
        } else {
            const lineToCheck = lineLower;

            // Check exclude
            if (excludeList.some(ex => lineToCheck.includes(ex))) return;

            for (const kw of keywordList) {
                if (lineToCheck.includes(kw)) {
                    matchedKeyword = kw;
                    break;
                }
            }
        }

        if (matchedKeyword) {
            // Dedup check
            if (dedup) {
                const dedupKey = stripUrl ? stripUrlFromLine(line) : line;
                if (seen.has(dedupKey)) return;
                seen.add(dedupKey);
            }

            const outputLine = stripUrl ? stripUrlFromLine(line) : line;

            filteredLines++;
            buffer.push(outputLine);
            perKeywordBuffer[matchedKeyword].push(outputLine);
            perKeywordCounts[matchedKeyword]++;

            // Extract domain for analytics
            const domain = extractDomain(line);
            if (domain) {
                domainCount.set(domain, (domainCount.get(domain) || 0) + 1);
            }
        }

        // Send chunk every CHUNK_SIZE lines
        if (buffer.length >= CHUNK_SIZE) {
            sendChunk();
        }
    });

    rl.on('close', () => {
        // Send remaining
        if (buffer.length > 0) {
            sendChunk();
        }

        const remappedCounts = {};
        for (const [kw, count] of Object.entries(perKeywordCounts)) {
            remappedCounts[clientKeywordMap.get(kw) || kw] = count;
        }

        // Send complete
        res.write(`data: ${JSON.stringify({
            type: 'complete',
            total: totalLines,
            filtered: filteredLines,
            perKeywordCounts: remappedCounts
        })}\n\n`);
        res.end();
    });

    rl.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
    });

    function sendChunk() {
        const topDomains = Array.from(domainCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const perKeyword = {};
        for (const [kw, lines] of Object.entries(perKeywordBuffer)) {
            if (lines.length > 0) {
                perKeyword[clientKeywordMap.get(kw) || kw] = lines.splice(0);
            }
        }

        const remappedCounts = {};
        for (const [kw, count] of Object.entries(perKeywordCounts)) {
            remappedCounts[clientKeywordMap.get(kw) || kw] = count;
        }

        res.write(`data: ${JSON.stringify({
            type: 'progress',
            total: totalLines,
            filtered: filteredLines,
            results: buffer.join('\n'),
            perKeyword,
            perKeywordCounts: remappedCounts,
            topDomains,
            preview: buffer.slice(-20)
        })}\n\n`);

        buffer = [];
    }

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

    function extractDomain(line) {
        const match = line.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
        return match ? match[1] : null;
    }

    // Handle client disconnect
    req.on('close', () => {
        rl.close();
    });
});

app.listen(PORT, () => {
    console.log(`ZenScan Server running at http://localhost:${PORT}`);
    console.log(`Downloads folder: ${DOWNLOAD_DIR}`);
});
