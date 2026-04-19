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

const keywordList = keywords.map(k => stripUrl ? stripUrlFromKeyword(k) : k.toLowerCase());
const excludeList = excludeKeywords ? excludeKeywords.split(',').map(k => k.trim().toLowerCase()) : [];

let totalLines = 0;
let filteredLines = 0;
const results = [];
const perKeyword = {};
const domainCount = {};

keywordList.forEach(kw => perKeyword[kw] = []);

// Create read stream for this chunk
const stream = createReadStream(filepath, {
    start,
    end: end - 1,
    encoding: 'utf8'
});

const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
});

let buffer = '';
let isFirstLine = true;

rl.on('line', (line) => {
    // Skip partial first line if not starting at beginning
    if (isFirstLine && start > 0) {
        isFirstLine = false;
        return;
    }
    isFirstLine = false;

    totalLines++;

    const lineLower = line.toLowerCase();
    const lineToCheck = stripUrl ? stripUrlFromLine(lineLower) : lineLower;

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

    // Fast keyword check
    for (let i = 0; i < keywordList.length; i++) {
        const kw = keywordList[i];
        if (lineToCheck.indexOf(kw) !== -1) {
            filteredLines++;
            results.push(line);
            perKeyword[kw].push(line);

            // Extract domain
            const domain = extractDomain(line);
            if (domain) {
                domainCount[domain] = (domainCount[domain] || 0) + 1;
            }

            break; // Only match first keyword
        }
    }

    // Send progress every 50k lines
    if (totalLines % 50000 === 0) {
        parentPort.postMessage({
            type: 'progress',
            total: totalLines,
            filtered: filteredLines,
            lines: results.splice(0), // Send and clear
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
    return kw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

function stripUrlFromLine(line) {
    return line.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function extractDomain(line) {
    const match = line.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1] : null;
}

function cloneAndClear(obj) {
    const clone = {};
    for (const key in obj) {
        clone[key] = obj[key].splice(0);
    }
    return clone;
}
