const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    InvalidRequestError,
    resolveDownloadFilePath,
    normalizeScanPayload,
    parseKeywordsQueryParam
} = require('./scan-request-utils');

test('resolveDownloadFilePath should keep valid basenames inside downloads directory', () => {
    const downloadDir = path.resolve('F:/SSH/zen/DataScan/downloads');
    const resolved = resolveDownloadFilePath(downloadDir, 'sample.txt');

    assert.equal(resolved, path.join(downloadDir, 'sample.txt'));
});

test('resolveDownloadFilePath should reject traversal-like filenames', () => {
    const downloadDir = path.resolve('F:/SSH/zen/DataScan/downloads');

    assert.throws(() => resolveDownloadFilePath(downloadDir, '../secret.txt'), InvalidRequestError);
    assert.throws(() => resolveDownloadFilePath(downloadDir, 'nested/file.txt'), InvalidRequestError);
    assert.throws(() => resolveDownloadFilePath(downloadDir, ''), InvalidRequestError);
});

test('normalizeScanPayload should normalize booleans, keywords, and excludes', () => {
    const normalized = normalizeScanPayload({
        filename: 'data.txt',
        keywords: [' https://bidaithanroblox.com/ ', 'gmail.com'],
        excludeKeywords: ' admin , test ',
        stripUrl: true,
        dedup: 'true'
    });

    assert.equal(normalized.filename, 'data.txt');
    assert.deepEqual(normalized.clientKeywords, ['https://bidaithanroblox.com/', 'gmail.com']);
    assert.deepEqual(normalized.normalizedKeywords, ['bidaithanroblox.com', 'gmail.com']);
    assert.deepEqual(normalized.excludeList, ['admin', 'test']);
    assert.equal(normalized.excludeKeywords, 'admin,test');
    assert.equal(normalized.stripUrl, true);
    assert.equal(normalized.dedup, true);
});

test('normalizeScanPayload should reject invalid keyword shapes', () => {
    assert.throws(() => normalizeScanPayload({
        filename: 'data.txt',
        keywords: 'roblox',
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    }), InvalidRequestError);

    assert.throws(() => normalizeScanPayload({
        filename: 'data.txt',
        keywords: [123],
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    }), InvalidRequestError);

    assert.throws(() => normalizeScanPayload({
        filename: 'data.txt',
        keywords: ['   '],
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    }), InvalidRequestError);
});

test('normalizeScanPayload should normalize filenames arrays and keep backward-compatible filename access', () => {
    const normalized = normalizeScanPayload({
        filenames: ['first.txt', ' second.txt ', 'first.txt'],
        keywords: ['roblox'],
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    });

    assert.deepEqual(normalized.filenames, ['first.txt', 'second.txt']);
    assert.equal(normalized.filename, 'first.txt');
});

test('normalizeScanPayload should reject empty or invalid filenames arrays', () => {
    assert.throws(() => normalizeScanPayload({
        filenames: [],
        keywords: ['roblox'],
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    }), InvalidRequestError);

    assert.throws(() => normalizeScanPayload({
        filenames: ['../secret.txt'],
        keywords: ['roblox'],
        excludeKeywords: '',
        stripUrl: false,
        dedup: false
    }), InvalidRequestError);
});

test('parseKeywordsQueryParam should parse valid JSON arrays and reject malformed input', () => {
    assert.deepEqual(parseKeywordsQueryParam('["a","b"]'), ['a', 'b']);

    assert.throws(() => parseKeywordsQueryParam('not-json'), InvalidRequestError);
    assert.throws(() => parseKeywordsQueryParam('{"a":1}'), InvalidRequestError);
});
