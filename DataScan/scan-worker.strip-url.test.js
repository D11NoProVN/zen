const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

async function runScanWorker({ content, keywords, stripUrl = true, excludeKeywords = '', dedup = false, start = 0, end = null }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenscan-stripurl-'));
    const filepath = path.join(tmpDir, 'input.txt');

    await fs.writeFile(filepath, content, 'utf8');
    const stat = await fs.stat(filepath);

    const workerStart = start;
    const workerEnd = end ?? stat.size;

    return new Promise((resolve, reject) => {
        const aggregated = {
            total: 0,
            filtered: 0,
            lines: [],
            perKeyword: {},
            domainCount: {}
        };

        const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
            workerData: {
                filepath,
                start: workerStart,
                end: workerEnd,
                keywords,
                excludeKeywords,
                stripUrl,
                dedup
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                aggregated.total = msg.total;
                aggregated.filtered = msg.filtered;

                if (Array.isArray(msg.lines) && msg.lines.length > 0) {
                    aggregated.lines.push(...msg.lines);
                }

                if (msg.perKeyword) {
                    for (const [kw, lines] of Object.entries(msg.perKeyword)) {
                        if (!aggregated.perKeyword[kw]) aggregated.perKeyword[kw] = [];
                        aggregated.perKeyword[kw].push(...lines);
                    }
                }
            } else if (msg.type === 'error') {
                reject(new Error(msg.message));
            } else if (msg.type === 'complete') {
                resolve(aggregated);
            }
        });

        worker.on('error', reject);
    });
}

async function runScanWorkerAcrossChunks({ content, keywords, stripUrl = true, excludeKeywords = '', dedup = false, chunks = 2 }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenscan-stripurl-chunks-'));
    const filepath = path.join(tmpDir, 'input.txt');

    await fs.writeFile(filepath, content, 'utf8');
    const stat = await fs.stat(filepath);

    const fileSize = stat.size;
    const chunkSize = Math.ceil(fileSize / chunks);

    const runs = [];
    for (let i = 0; i < chunks; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        if (start >= end) continue;

        runs.push(
            runScanWorker({
                content,
                keywords,
                stripUrl,
                excludeKeywords,
                dedup,
                start,
                end
            })
        );
    }

    const results = await Promise.all(runs);
    const merged = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: {}
    };

    for (const result of results) {
        merged.total += result.total;
        merged.filtered += result.filtered;
        merged.lines.push(...result.lines);

        for (const [kw, lines] of Object.entries(result.perKeyword)) {
            if (!merged.perKeyword[kw]) merged.perKeyword[kw] = [];
            merged.perKeyword[kw].push(...lines);
        }
    }

    return merged;
}

function dedupPreserveOrder(lines) {
    const seen = new Set();
    const out = [];

    for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
    }

    return out;
}

function countByValue(lines) {
    const counts = new Map();

    for (const line of lines) {
        counts.set(line, (counts.get(line) || 0) + 1);
    }

    return counts;
}

function countMissingExpected(counts, expectedLines) {
    let missing = 0;

    for (const line of expectedLines) {
        if (!counts.has(line)) {
            missing++;
        }
    }

    return missing;
}

function countUnexpectedExtras(counts, expectedLines) {
    let extras = 0;

    for (const line of expectedLines) {
        const seenCount = counts.get(line) || 0;
        if (seenCount > 1) {
            extras += seenCount - 1;
        }
    }

    return extras;
}

function assertUnorderedMultisetEquality(actualLines, expectedLines) {
    const actualCounts = countByValue(actualLines);
    const expectedCounts = countByValue(expectedLines);

    assert.equal(actualLines.length, expectedLines.length, 'line count mismatch');
    assert.equal(countMissingExpected(actualCounts, expectedLines), 0, 'missing expected lines');
    assert.equal(countMissingExpected(expectedCounts, actualLines), 0, 'found unexpected lines');
    assert.equal(countUnexpectedExtras(actualCounts, expectedLines), 0, 'unexpected duplicate lines');
    assert.equal(countUnexpectedExtras(expectedCounts, actualLines), 0, 'missing duplicate lines');
}

function expectedStrippedCredentials(lines, keywordPrefix) {
    const normalizedKeyword = keywordPrefix.toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '')
        .replace(/\/+$/, '');

    const out = [];

    for (const line of lines) {
        const lower = line.toLowerCase();
        const withoutProto = lower
            .replace(/^https?:\/\//i, '')
            .replace(/^\/\//, '');

        if (!withoutProto.includes(normalizedKeyword)) continue;

        const firstSlash = withoutProto.indexOf('/');
        const firstColon = withoutProto.indexOf(':');

        if (firstSlash !== -1 && (firstColon === -1 || firstSlash < firstColon)) {
            const pathColon = withoutProto.indexOf(':', firstSlash + 1);
            if (pathColon !== -1) {
                const creds = withoutProto.slice(pathColon + 1);
                if (creds.includes(':')) out.push(creds);
                continue;
            }
        }

        const parts = withoutProto.split(':');
        if (parts.length < 3) continue;

        let credentialsStart = parts.length - 2;
        if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
            credentialsStart = 2;
        }

        const userPassParts = parts.slice(credentialsStart);
        if (userPassParts.length < 2) continue;

        out.push(userPassParts.join(':'));
    }

    return out;
}


async function runLegacySkipFirstLineBehavior({ content, keywords, stripUrl = true, excludeKeywords = '', dedup = false, chunks = 2 }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenscan-legacy-skip-'));
    const filepath = path.join(tmpDir, 'input.txt');

    await fs.writeFile(filepath, content, 'utf8');
    const stat = await fs.stat(filepath);

    const fileSize = stat.size;
    const chunkSize = Math.ceil(fileSize / chunks);

    const runs = [];

    for (let i = 0; i < chunks; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, fileSize);

        if (start >= end) continue;

        runs.push(new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
                workerData: {
                    filepath,
                    start,
                    end,
                    keywords,
                    excludeKeywords,
                    stripUrl,
                    dedup
                }
            });

            const aggregated = {
                lines: []
            };

            let firstLine = true;

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    const incoming = Array.isArray(msg.lines) ? msg.lines : [];

                    if (firstLine && start > 0 && incoming.length > 0) {
                        incoming.shift();
                    }

                    firstLine = false;

                    if (incoming.length > 0) {
                        aggregated.lines.push(...incoming);
                    }
                } else if (msg.type === 'error') {
                    reject(new Error(msg.message));
                } else if (msg.type === 'complete') {
                    resolve(aggregated.lines);
                }
            });

            worker.on('error', reject);
        }));
    }

    const results = await Promise.all(runs);
    return results.flat();
}

async function findFileContentForFalseSkipReproduction(chunks = 2) {
    for (let totalLines = 12; totalLines <= 120; totalLines++) {
        const lines = [];

        for (let i = 1; i <= totalLines; i++) {
            if (i % 3 === 0) {
                lines.push(`https://bidaithanroblox.com/path${i}:user${i}:pass${i}`);
            } else if (i % 3 === 1) {
                lines.push(`https://bidaithanroblox.com/:user${i}:pass${i}`);
            } else {
                lines.push(`https://bidaithanroblox.com:443:user${i}:pass${i}`);
            }
        }

        const content = lines.join('\n') + '\n';

        const modern = await runScanWorkerAcrossChunks({
            content,
            keywords: ['https://bidaithanroblox.com/'],
            stripUrl: true,
            dedup: false,
            chunks
        });

        const legacy = await runLegacySkipFirstLineBehavior({
            content,
            keywords: ['https://bidaithanroblox.com/'],
            stripUrl: true,
            dedup: false,
            chunks
        });

        const modernDeduped = dedupPreserveOrder(modern.lines);
        const legacyDeduped = dedupPreserveOrder(legacy);

        if (modernDeduped.length > legacyDeduped.length) {
            return { content, lines };
        }
    }

    throw new Error('Could not find deterministic content reproducing false skip behavior');
}

test('stripUrl should match URL keyword and output user:pass', async () => {
    const result = await runScanWorker({
        content: 'https://bidaithanroblox.com/:thang2207:123456789\n',
        keywords: ['https://bidaithanroblox.com/'],
        stripUrl: true
    });

    assert.equal(result.filtered, 1);
    assert.deepEqual(result.lines, ['thang2207:123456789']);
});

test('stripUrl should keep all matching lines and strip URL correctly across formats', async () => {
    const result = await runScanWorker({
        content: [
            'https://bidaithanroblox.com/:user1:pass1',
            'https://bidaithanroblox.com/home:user2:pass2',
            'https://bidaithanroblox.com:443:user3:pass3',
            'bidaithanroblox.com/:user4:pass4'
        ].join('\n') + '\n',
        keywords: ['https://bidaithanroblox.com/'],
        stripUrl: true
    });

    assert.equal(result.filtered, 4);
    assert.deepEqual(result.lines, [
        'user1:pass1',
        'user2:pass2',
        'user3:pass3',
        'user4:pass4'
    ]);
});

test('stripUrl + dedup should deduplicate by stripped credentials', async () => {
    const result = await runScanWorker({
        content: [
            'https://bidaithanroblox.com/:dup:123',
            'https://bidaithanroblox.com/home:dup:123',
            'https://bidaithanroblox.com/:unique:999'
        ].join('\n') + '\n',
        keywords: ['https://bidaithanroblox.com/'],
        stripUrl: true,
        dedup: true
    });

    assert.equal(result.filtered, 2);
    assert.deepEqual(result.lines, ['dup:123', 'unique:999']);
});

test('chunked scan should not drop valid first line of a chunk and should preserve full result set', async () => {
    const { content, lines } = await findFileContentForFalseSkipReproduction(2);

    const result = await runScanWorkerAcrossChunks({
        content,
        keywords: ['https://bidaithanroblox.com/'],
        stripUrl: true,
        dedup: false,
        chunks: 2
    });

    const expected = expectedStrippedCredentials(lines, 'https://bidaithanroblox.com/');

    // In production, merge order across workers is nondeterministic; validate as multiset.
    assertUnorderedMultisetEquality(result.lines, expected);
    assert.equal(result.filtered, result.lines.length);
});

test('legacy skip-first-line behavior reproduces line loss on chunk boundaries (pre-fix regression)', async () => {
    const { content, lines } = await findFileContentForFalseSkipReproduction(2);

    const legacyLines = await runLegacySkipFirstLineBehavior({
        content,
        keywords: ['https://bidaithanroblox.com/'],
        stripUrl: true,
        dedup: false,
        chunks: 2
    });

    const expected = expectedStrippedCredentials(lines, 'https://bidaithanroblox.com/');

    const legacyDeduped = dedupPreserveOrder(legacyLines);
    const expectedDeduped = dedupPreserveOrder(expected);

    assert.ok(legacyDeduped.length < expectedDeduped.length);
});

