const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDeltaTracker,
    buildDeltaPayload
} = require('./scan-fast-stream-delta');

function collectDownloadLines(events) {
    const lines = [];

    for (const event of events) {
        if (event.results && event.results.length > 0) {
            lines.push(...event.results.split('\n').filter(Boolean));
        }
    }

    return lines;
}

test('buildDeltaPayload should emit only newly appended global and per-keyword lines', () => {
    const results = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: { roblox: [] },
        perKeywordCounts: { roblox: 0 }
    };

    const tracker = createDeltaTracker(['roblox']);

    results.total = 100;
    results.filtered = 2;
    results.lines.push('u1:p1', 'u2:p2');
    results.perKeyword.roblox.push('u1:p1', 'u2:p2');
    results.perKeywordCounts.roblox = 2;

    const p1 = buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 2]]);

    assert.equal(p1.results, 'u1:p1\nu2:p2');
    assert.deepEqual(p1.perKeyword, { roblox: ['u1:p1', 'u2:p2'] });
    assert.equal(results.filtered, 2);

    results.total = 200;
    results.filtered = 3;
    results.lines.push('u3:p3');
    results.perKeyword.roblox.push('u3:p3');
    results.perKeywordCounts.roblox = 3;

    const p2 = buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 3]]);

    assert.equal(p2.results, 'u3:p3');
    assert.deepEqual(p2.perKeyword, { roblox: ['u3:p3'] });
    assert.equal(results.filtered, 3);

    const p3 = buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 3]]);

    assert.equal(p3.results, '');
    assert.deepEqual(p3.perKeyword, {});
});

test('delta payloads should allow append-only client accumulation without duplicates', () => {
    const results = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: { roblox: [] },
        perKeywordCounts: { roblox: 0 }
    };

    const tracker = createDeltaTracker(['roblox']);
    const events = [];

    results.total = 100;
    results.filtered = 2;
    results.lines.push('a:1', 'b:2');
    results.perKeyword.roblox.push('a:1', 'b:2');
    results.perKeywordCounts.roblox = 2;
    events.push(buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 2]]));

    results.total = 200;
    results.filtered = 4;
    results.lines.push('c:3', 'd:4');
    results.perKeyword.roblox.push('c:3', 'd:4');
    results.perKeywordCounts.roblox = 4;
    events.push(buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 4]]));

    events.push(buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 4]]));

    const downloadedLines = collectDownloadLines(events);

    assert.deepEqual(downloadedLines, ['a:1', 'b:2', 'c:3', 'd:4']);
    assert.equal(new Set(downloadedLines).size, downloadedLines.length);
});

test('buildDeltaPayload should handle array shrink safely when final dedup reduces buffers', () => {
    const results = {
        total: 0,
        filtered: 0,
        lines: [],
        perKeyword: { roblox: [] },
        perKeywordCounts: { roblox: 0 }
    };

    const tracker = createDeltaTracker(['roblox']);

    results.total = 100;
    results.filtered = 3;
    results.lines.push('dup:1', 'dup:1', 'unique:2');
    results.perKeyword.roblox.push('dup:1', 'dup:1', 'unique:2');
    results.perKeywordCounts.roblox = 3;

    buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 3]]);

    // Simulate final global dedup collapsing arrays before complete payload
    results.filtered = 2;
    results.lines = ['dup:1', 'unique:2'];
    results.perKeyword.roblox = ['dup:1', 'unique:2'];
    results.perKeywordCounts.roblox = 2;

    const complete = buildDeltaPayload(results, tracker, [['bidaithanroblox.com', 2]]);

    assert.equal(complete.results, '');
    assert.deepEqual(complete.perKeyword, {});
    assert.equal(results.filtered, 2);
});
