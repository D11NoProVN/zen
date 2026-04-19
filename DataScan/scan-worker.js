// Scan Worker - Ultra Fast Processing
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');

const {
    filepath,
    start,
    end,
    keywords,
    excludeKeywords,
    stripUrl,
    dedup
} = workerData;

const keywordList = keywords
    .map(k => stripUrl ? stripUrlFromKeyword(k) : k.toLowerCase())
    .filter(Boolean);

const excludeList = excludeKeywords
    ? excludeKeywords
        .split(',')
        .map(k => stripUrl ? stripUrlFromKeyword(k) : k.trim().toLowerCase())
        .filter(Boolean)
    : [];

let totalLines = 0;
let filteredLines = 0;
const results = [];
const perKeyword = {};
const domainCount = {};
const lineDomains = [];
const seenSet = dedup ? new Set() : null;

keywordList.forEach(kw => perKeyword[kw] = []);

const fileSize = fs.statSync(filepath).size;
const adjustedEndExclusive = adjustEndToLineBoundary(filepath, end, fileSize);

// Create read stream for this chunk
const stream = createReadStream(filepath, {
    start,
    end: adjustedEndExclusive - 1,
    encoding: 'utf8'
});

const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
});

let isFirstLine = true;
const shouldSkipFirstLine = shouldSkipFirstLineAtOffset(filepath, start);

rl.on('line', (line) => {
    // Skip partial first line only when the chunk starts mid-line
    if (isFirstLine && shouldSkipFirstLine) {
        isFirstLine = false;
        return;
    }
    isFirstLine = false;

    totalLines++;

    const lineLower = line.toLowerCase();

    let matched = false;
    let matchedKeyword = null;

    if (stripUrl) {
        const parsed = parseStripUrlLine(lineLower);
        if (!parsed) return;

        const { urlPartLower, credentialsLower } = parsed;

        // Fast exclude check (applies to URL and credentials in strip mode)
        if (excludeList.length > 0) {
            let excluded = false;
            for (let i = 0; i < excludeList.length; i++) {
                const ex = excludeList[i];
                if (urlPartLower.indexOf(ex) !== -1 || credentialsLower.indexOf(ex) !== -1) {
                    excluded = true;
                    break;
                }
            }
            if (excluded) return;
        }

        // Match keyword primarily on URL part, also allow credentials match for non-URL keywords
        for (let i = 0; i < keywordList.length; i++) {
            const kw = keywordList[i];
            if (urlPartLower.indexOf(kw) !== -1 || credentialsLower.indexOf(kw) !== -1) {
                matched = true;
                matchedKeyword = kw;
                break;
            }
        }
    } else {
        const lineToCheck = lineLower;

        // Fast exclude check
        if (excludeList.length > 0) {
            let excluded = false;
            for (let i = 0; i < excludeList.length; i++) {
                if (lineToCheck.indexOf(excludeList[i]) !== -1) {
                    excluded = true;
                    break;
                }
            }
            if (excluded) return;
        }

        for (let i = 0; i < keywordList.length; i++) {
            const kw = keywordList[i];
            if (lineToCheck.indexOf(kw) !== -1) {
                matched = true;
                matchedKeyword = kw;
                break;
            }
        }
    }

    if (matched) {
        // Output the stripped line if stripUrl is enabled, otherwise original
        const outputLine = stripUrl ? stripUrlFromLine(line) : line;

        if (dedup) {
            if (seenSet.has(outputLine)) return;
            seenSet.add(outputLine);
        }

        filteredLines++;
        results.push(outputLine);
        perKeyword[matchedKeyword].push(outputLine);

        // Extract domain
        const domain = extractDomain(line);
        lineDomains.push(domain || null);
        if (domain) {
            domainCount[domain] = (domainCount[domain] || 0) + 1;
        }
    }

    // Send progress every 50k lines
    if (totalLines % 50000 === 0) {
        parentPort.postMessage({
            type: 'progress',
            total: totalLines,
            filtered: filteredLines,
            lines: results.splice(0), // Send and clear
            lineDomains: lineDomains.splice(0),
            perKeyword: cloneAndClear(perKeyword),
            domainCount: { ...domainCount }
        });
    }
});

rl.on('close', () => {
    // Send remaining data
    parentPort.postMessage({
        type: 'progress',
        total: totalLines,
        filtered: filteredLines,
        lines: results,
        lineDomains,
        perKeyword,
        domainCount
    });

    parentPort.postMessage({ type: 'complete' });
});

rl.on('error', (err) => {
    parentPort.postMessage({ type: 'error', message: err.message });
});

// Helper functions
function stripUrlFromKeyword(kw) {
    // Normalize keyword into a host[:port][/path]-style token for strip-url matching
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

    // Fallback: preserve legacy behavior
    return line.replace(/^https?:\/\//i, '');
}

function extractDomain(line) {
    const match = line.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1] : null;
}

function shouldSkipFirstLineAtOffset(filepath, startOffset) {
    if (startOffset <= 0) return false;

    try {
        const fd = fs.openSync(filepath, 'r');
        const prevByte = Buffer.alloc(1);
        const bytesRead = fs.readSync(fd, prevByte, 0, 1, startOffset - 1);
        fs.closeSync(fd);

        if (bytesRead === 0) return false;

        // Skip first emitted line only when chunk begins in the middle of a line
        return prevByte[0] !== 0x0a && prevByte[0] !== 0x0d;
    } catch {
        // Preserve previous safe behavior if offset inspection fails
        return startOffset > 0;
    }
}

function adjustEndToLineBoundary(filepath, requestedEndExclusive, fileSize) {
    if (requestedEndExclusive >= fileSize) return fileSize;
    if (requestedEndExclusive <= 0) return requestedEndExclusive;

    try {
        const fd = fs.openSync(filepath, 'r');
        const byte = Buffer.alloc(1);
        let cursor = requestedEndExclusive;

        while (cursor < fileSize) {
            const bytesRead = fs.readSync(fd, byte, 0, 1, cursor);
            if (bytesRead === 0) break;
            if (byte[0] === 0x0a) {
                fs.closeSync(fd);
                return cursor + 1; // include newline so next worker starts after full line
            }
            cursor++;
        }

        fs.closeSync(fd);
        return fileSize;
    } catch {
        // Fallback to old behavior if boundary adjustment fails
        return requestedEndExclusive;
    }
}

function cloneAndClear(obj) {
    const clone = {};
    for (const key in obj) {
        clone[key] = obj[key].splice(0);
    }
    return clone;
}
