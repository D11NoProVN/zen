const test = require('node:test');
const assert = require('node:assert/strict');

const {
    processLegacyScanLine,
    parseKeywordsForLegacyWorker
} = require('./worker-v6-utils');

test('parseKeywordsForLegacyWorker should preserve raw trimmed keywords when stripUrl is false', () => {
    const keywords = parseKeywordsForLegacyWorker('https://bidaithanroblox.com/\n Gmail.com ', false);
    assert.deepEqual(keywords, ['https://bidaithanroblox.com/', 'gmail.com']);
});

test('parseKeywordsForLegacyWorker should strip-normalize keywords when stripUrl is true', () => {
    const keywords = parseKeywordsForLegacyWorker('https://bidaithanroblox.com/\n Gmail.com ', true);
    assert.deepEqual(keywords, ['bidaithanroblox.com', 'gmail.com']);
});

test('processLegacyScanLine should match strip-url keywords against url and credentials and preserve server-style domain analytics', () => {
    const matched = processLegacyScanLine({
        line: 'https://bidaithanroblox.com/:gmail.com:pass123',
        keywords: ['bidaithanroblox.com', 'gmail.com'],
        excludeKeywords: [],
        stripUrl: true,
        dedup: false,
        seenSet: new Set()
    });

    assert.deepEqual(matched, {
        matchedKeyword: 'bidaithanroblox.com',
        outputLine: 'gmail.com:pass123',
        domain: 'bidaithanroblox.com'
    });
});

test('processLegacyScanLine should exclude strip-url matches when exclude term is found in credentials', () => {
    const matched = processLegacyScanLine({
        line: 'https://bidaithanroblox.com/:gmail.com:pass123',
        keywords: ['bidaithanroblox.com'],
        excludeKeywords: ['gmail.com'],
        stripUrl: true,
        dedup: false,
        seenSet: new Set()
    });

    assert.equal(matched, null);
});

test('processLegacyScanLine should deduplicate by output line', () => {
    const seenSet = new Set();

    const first = processLegacyScanLine({
        line: 'https://bidaithanroblox.com/:u1:p1',
        keywords: ['bidaithanroblox.com'],
        excludeKeywords: [],
        stripUrl: true,
        dedup: true,
        seenSet
    });
    const second = processLegacyScanLine({
        line: 'https://bidaithanroblox.com/:u1:p1',
        keywords: ['bidaithanroblox.com'],
        excludeKeywords: [],
        stripUrl: true,
        dedup: true,
        seenSet
    });

    assert.ok(first);
    assert.equal(second, null);
});
