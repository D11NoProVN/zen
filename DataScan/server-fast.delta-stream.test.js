const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDeltaTracker,
    buildDeltaPayload,
    shouldEmitProgress
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

test('shouldEmitProgress should emit before completion when line count crosses a smaller threshold', () => {
    assert.equal(shouldEmitProgress({ totalLines: 9999, lastEmittedLines: 0, now: 0, lastEmittedAt: 0 }), false);
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 0, now: 0, lastEmittedAt: 0 }), true);
});

test('shouldEmitProgress should emit on elapsed time even when line threshold is not reached', () => {
    assert.equal(shouldEmitProgress({ totalLines: 123, lastEmittedLines: 0, now: 249, lastEmittedAt: 0 }), false);
    assert.equal(shouldEmitProgress({ totalLines: 123, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not emit when there is no new processed line data', () => {
    assert.equal(shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 1000, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should not emit before threshold or interval', () => {
    assert.equal(shouldEmitProgress({ totalLines: 500, lastEmittedLines: 0, now: 100, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should emit after another threshold window from the last emission point', () => {
    assert.equal(shouldEmitProgress({ totalLines: 20001, lastEmittedLines: 10000, now: 10, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should reset timing baseline after previous emission', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10050, lastEmittedLines: 10000, now: 449, lastEmittedAt: 200 }), false);
    assert.equal(shouldEmitProgress({ totalLines: 10050, lastEmittedLines: 10000, now: 450, lastEmittedAt: 200 }), true);
});


test('shouldEmitProgress should support forcing a final progress flush', () => {
    assert.equal(shouldEmitProgress({ totalLines: 3, lastEmittedLines: 0, now: 1, lastEmittedAt: 0, force: true }), true);
});


test('shouldEmitProgress should not force a flush when there is still no data', () => {
    assert.equal(shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 1, lastEmittedAt: 0, force: true }), false);
});


test('shouldEmitProgress should treat counter resets as fresh progress', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 20, now: 250, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should ignore negative elapsed times', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 0, now: 100, lastEmittedAt: 200 }), false);
});


test('shouldEmitProgress should accept custom thresholds for tight-loop callers', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 0, now: 0, lastEmittedAt: 0, minLineDelta: 5, minIntervalMs: 1000 }), true);
});


test('shouldEmitProgress should accept custom time intervals for tight-loop callers', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 100, lastEmittedAt: 0, minLineDelta: 999, minIntervalMs: 100 }), true);
});


test('shouldEmitProgress should reject empty custom threshold windows', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 0, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 1000 }), false);
});


test('shouldEmitProgress should reject empty custom time windows unless forced', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 1, lastEmittedAt: 0, minLineDelta: 999, minIntervalMs: 0 }), false);
});


test('shouldEmitProgress should still allow force with zeroed thresholds when data exists', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 1, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 0, force: true }), true);
});


test('shouldEmitProgress should not emit duplicate threshold events without new lines', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 10000, now: 1000, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should emit by time for small but growing files', () => {
    assert.equal(shouldEmitProgress({ totalLines: 7, lastEmittedLines: 5, now: 260, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not emit by time for unchanged small files', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 5, now: 260, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should emit by threshold even if elapsed time is short', () => {
    assert.equal(shouldEmitProgress({ totalLines: 15000, lastEmittedLines: 0, now: 10, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not emit by threshold when below delta boundary after prior emit', () => {
    assert.equal(shouldEmitProgress({ totalLines: 15000, lastEmittedLines: 10001, now: 10, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should allow fresh progress after worker counter reset and force', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 10, now: 1, lastEmittedAt: 0, force: true }), true);
});


test('shouldEmitProgress should not emit if force is set but totals are unchanged at a non-zero baseline', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10, lastEmittedLines: 10, now: 1, lastEmittedAt: 0, force: true }), false);
});


test('shouldEmitProgress should emit if a custom line threshold is crossed after prior emission', () => {
    assert.equal(shouldEmitProgress({ totalLines: 30, lastEmittedLines: 20, now: 0, lastEmittedAt: 0, minLineDelta: 10, minIntervalMs: 9999 }), true);
});


test('shouldEmitProgress should not emit if a custom line threshold is not crossed after prior emission', () => {
    assert.equal(shouldEmitProgress({ totalLines: 29, lastEmittedLines: 20, now: 0, lastEmittedAt: 0, minLineDelta: 10, minIntervalMs: 9999 }), false);
});


test('shouldEmitProgress should emit if a custom interval is crossed after prior emission and lines grew', () => {
    assert.equal(shouldEmitProgress({ totalLines: 21, lastEmittedLines: 20, now: 500, lastEmittedAt: 0, minLineDelta: 9999, minIntervalMs: 500 }), true);
});


test('shouldEmitProgress should not emit if a custom interval is crossed but lines did not grow', () => {
    assert.equal(shouldEmitProgress({ totalLines: 20, lastEmittedLines: 20, now: 500, lastEmittedAt: 0, minLineDelta: 9999, minIntervalMs: 500 }), false);
});


test('shouldEmitProgress should support line-only behavior when interval is disabled but threshold remains', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10, lastEmittedLines: 0, now: 1, lastEmittedAt: 0, minLineDelta: 10, minIntervalMs: 0 }), true);
});


test('shouldEmitProgress should support time-only behavior when threshold is disabled but interval remains', () => {
    assert.equal(shouldEmitProgress({ totalLines: 3, lastEmittedLines: 0, now: 300, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 300, force: false }), true);
});


test('shouldEmitProgress should not emit time-only behavior without new lines', () => {
    assert.equal(shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 300, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 300, force: false }), false);
});


test('shouldEmitProgress should treat a reset baseline as progress for line-only behavior', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 5, now: 1, lastEmittedAt: 0, minLineDelta: 2, minIntervalMs: 0 }), true);
});


test('shouldEmitProgress should treat a reset baseline as progress for time-only behavior', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 5, now: 300, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 300 }), true);
});


test('shouldEmitProgress should not emit with NaN-ish timing inputs before thresholds are met', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 0, now: Number.NaN, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should still emit by threshold with NaN-ish timing inputs when enough lines have arrived', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 0, now: Number.NaN, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should still emit by interval with NaN lastEmittedAt normalized to zero when lines have arrived', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 300, lastEmittedAt: Number.NaN }), true);
});


test('shouldEmitProgress should not emit when both threshold and interval are disabled and not forced', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10, lastEmittedLines: 0, now: 300, lastEmittedAt: 0, minLineDelta: 0, minIntervalMs: 0, force: false }), false);
});


test('shouldEmitProgress should prefer any satisfied trigger rather than requiring both', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 1, now: 1, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 9999 }), false);
    assert.equal(shouldEmitProgress({ totalLines: 10001, lastEmittedLines: 1, now: 1, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 9999 }), true);
});


test('shouldEmitProgress should emit on exact custom interval boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 1, now: 750, lastEmittedAt: 250, minLineDelta: 9999, minIntervalMs: 500 }), true);
});


test('shouldEmitProgress should emit on exact custom threshold boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 11, lastEmittedLines: 1, now: 10, lastEmittedAt: 0, minLineDelta: 10, minIntervalMs: 9999 }), true);
});


test('shouldEmitProgress should not emit one line before exact custom threshold boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10, lastEmittedLines: 1, now: 10, lastEmittedAt: 0, minLineDelta: 10, minIntervalMs: 9999 }), false);
});


test('shouldEmitProgress should not emit one millisecond before exact custom interval boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 1, now: 749, lastEmittedAt: 250, minLineDelta: 9999, minIntervalMs: 500 }), false);
});


test('shouldEmitProgress should preserve the original no-data guard even at giant timers', () => {
    assert.equal(shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 999999, lastEmittedAt: 0, force: true }), false);
});


test('shouldEmitProgress should emit tiny force flushes after a new small increment', () => {
    assert.equal(shouldEmitProgress({ totalLines: 6, lastEmittedLines: 5, now: 1, lastEmittedAt: 0, force: true }), true);
});


test('shouldEmitProgress should not emit tiny non-force flushes without threshold or interval', () => {
    assert.equal(shouldEmitProgress({ totalLines: 6, lastEmittedLines: 5, now: 1, lastEmittedAt: 0, minLineDelta: 999, minIntervalMs: 999 }), false);
});


test('shouldEmitProgress should emit by interval for tiny increments when enough time has elapsed', () => {
    assert.equal(shouldEmitProgress({ totalLines: 6, lastEmittedLines: 5, now: 1000, lastEmittedAt: 0, minLineDelta: 999, minIntervalMs: 1000 }), true);
});


test('shouldEmitProgress should emit by threshold for big jumps even with no time elapsed', () => {
    assert.equal(shouldEmitProgress({ totalLines: 50000, lastEmittedLines: 5, now: 0, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 1000 }), true);
});


test('shouldEmitProgress should not emit by threshold for big absolute totals if relative delta is still below boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 50000, lastEmittedLines: 45001, now: 0, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 1000 }), false);
});


test('shouldEmitProgress should emit by interval after relative reset progress even if absolute total is small', () => {
    assert.equal(shouldEmitProgress({ totalLines: 3, lastEmittedLines: 1000, now: 1000, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 1000 }), true);
});


test('shouldEmitProgress should emit by threshold after relative reset progress if custom boundary is crossed', () => {
    assert.equal(shouldEmitProgress({ totalLines: 3, lastEmittedLines: 1000, now: 0, lastEmittedAt: 0, minLineDelta: 3, minIntervalMs: 9999 }), true);
});


test('shouldEmitProgress should not emit by threshold after relative reset progress if custom boundary is not crossed', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 1000, now: 0, lastEmittedAt: 0, minLineDelta: 3, minIntervalMs: 9999 }), false);
});


test('shouldEmitProgress should behave deterministically for the default cadence inputs', () => {
    const sample = { totalLines: 10000, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 };
    assert.equal(shouldEmitProgress(sample), true);
    assert.equal(shouldEmitProgress(sample), true);
});


test('shouldEmitProgress should allow small periodic updates that keep UI counters moving', () => {
    assert.equal(shouldEmitProgress({ totalLines: 42, lastEmittedLines: 0, now: 300, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not emit a periodic update before the UI interval boundary', () => {
    assert.equal(shouldEmitProgress({ totalLines: 42, lastEmittedLines: 0, now: 200, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should allow large files to update earlier than the old 50000-line cadence', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 0, now: 1, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not require file completion to emit progress', () => {
    assert.equal(shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 300, lastEmittedAt: 0, force: false }), true);
});


test('shouldEmitProgress should still permit a final forced flush for remainder lines', () => {
    assert.equal(shouldEmitProgress({ totalLines: 9, lastEmittedLines: 5, now: 10, lastEmittedAt: 9, force: true }), true);
});


test('shouldEmitProgress should not emit a final forced flush when the remainder is empty', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5, lastEmittedLines: 5, now: 10, lastEmittedAt: 9, force: true }), false);
});


test('shouldEmitProgress should support exact UI cadence target of 250ms', () => {
    assert.equal(shouldEmitProgress({ totalLines: 2, lastEmittedLines: 1, now: 250, lastEmittedAt: 0, minLineDelta: 9999, minIntervalMs: 250 }), true);
});


test('shouldEmitProgress should support exact worker line cadence target of 10000 lines', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10001, lastEmittedLines: 1, now: 0, lastEmittedAt: 0, minLineDelta: 10000, minIntervalMs: 9999 }), true);
});


test('shouldEmitProgress should keep tiny scans from appearing frozen by time cadence alone', () => {
    assert.equal(shouldEmitProgress({ totalLines: 3, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should not trigger a fake update with zero processed lines at 250ms', () => {
    assert.equal(shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 }), false);
});


test('shouldEmitProgress should keep medium scans moving before the first big threshold', () => {
    assert.equal(shouldEmitProgress({ totalLines: 5000, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should keep huge scans moving by threshold before the first time cadence', () => {
    assert.equal(shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 0, now: 10, lastEmittedAt: 0 }), true);
});


test('shouldEmitProgress should handle post-emission medium scans with elapsed cadence', () => {
    assert.equal(shouldEmitProgress({ totalLines: 7000, lastEmittedLines: 5000, now: 800, lastEmittedAt: 500 }), true);
});


test('shouldEmitProgress should not handle post-emission medium scans before elapsed cadence', () => {
    assert.equal(shouldEmitProgress({ totalLines: 7000, lastEmittedLines: 5000, now: 700, lastEmittedAt: 500 }), false);
});


test('shouldEmitProgress should emit post-emission huge scans on next threshold jump', () => {
    assert.equal(shouldEmitProgress({ totalLines: 15000, lastEmittedLines: 5000, now: 700, lastEmittedAt: 500 }), true);
});


test('shouldEmitProgress should not double-emit post-emission huge scans without enough new lines', () => {
    assert.equal(shouldEmitProgress({ totalLines: 14999, lastEmittedLines: 5000, now: 700, lastEmittedAt: 500 }), false);
});


test('shouldEmitProgress should define the new realtime cadence contract for stream UI counters', () => {
    assert.deepEqual([
        shouldEmitProgress({ totalLines: 0, lastEmittedLines: 0, now: 0, lastEmittedAt: 0 }),
        shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 249, lastEmittedAt: 0 }),
        shouldEmitProgress({ totalLines: 1, lastEmittedLines: 0, now: 250, lastEmittedAt: 0 }),
        shouldEmitProgress({ totalLines: 10000, lastEmittedLines: 0, now: 1, lastEmittedAt: 0 })
    ], [false, false, true, true]);
});
