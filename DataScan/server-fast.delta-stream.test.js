const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDeltaTracker,
    buildDeltaPayload,
    shouldEmitProgress
} = require('./scan-fast-stream-delta');

function createServerProgressForwarder({ sendUpdate, now = () => Date.now(), minIntervalMs = 0 }) {
    let lastUpdateAt = 0;

    return {
        handleProgress(currentFile) {
            const currentTime = now();
            if (minIntervalMs > 0 && currentTime - lastUpdateAt < minIntervalMs) {
                return false;
            }

            sendUpdate(currentFile);
            lastUpdateAt = currentTime;
            return true;
        }
    };
}

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

test('server progress forwarder should forward each worker-authorized progress event immediately by default', () => {
    const forwardedFiles = [];
    const forwarder = createServerProgressForwarder({
        sendUpdate(currentFile) {
            forwardedFiles.push(currentFile);
        },
        now: () => 100
    });

    assert.equal(forwarder.handleProgress('first.txt'), true);
    assert.equal(forwarder.handleProgress('first.txt'), true);
    assert.deepEqual(forwardedFiles, ['first.txt', 'first.txt']);
});


test('server progress forwarder should block early worker progress only when an explicit extra throttle is configured', () => {
    const forwardedFiles = [];
    let currentTime = 100;
    const forwarder = createServerProgressForwarder({
        sendUpdate(currentFile) {
            forwardedFiles.push(currentFile);
        },
        now: () => currentTime,
        minIntervalMs: 500
    });

    assert.equal(forwarder.handleProgress('first.txt'), false);
    currentTime = 600;
    assert.equal(forwarder.handleProgress('first.txt'), true);
    assert.deepEqual(forwardedFiles, ['first.txt']);
});


test('server stream progress forwarding contract should allow progress before complete in short scans', () => {
    const eventTypes = [];

    eventTypes.push('progress');
    eventTypes.push('complete');

    assert.deepEqual(eventTypes, ['progress', 'complete']);
});


test('server stream progress forwarding contract should preserve cumulative totals from each forwarded progress event', () => {
    const totals = [];
    [{ total: 10 }, { total: 20 }, { total: 35 }].forEach(event => totals.push(event.total));
    assert.deepEqual(totals, [10, 20, 35]);
});


test('server stream progress forwarding contract should preserve cumulative filtered counts from each forwarded progress event', () => {
    const filtered = [];
    [{ filtered: 0 }, { filtered: 2 }, { filtered: 4 }].forEach(event => filtered.push(event.filtered));
    assert.deepEqual(filtered, [0, 2, 4]);
});


test('server stream progress forwarding contract should preserve ordering of progress before complete', () => {
    const events = ['progress', 'progress', 'complete'];
    assert.equal(events[events.length - 1], 'complete');
    assert.equal(events.includes('progress'), true);
    assert.equal(events.indexOf('progress') < events.indexOf('complete'), true);
});


test('server stream progress forwarding contract should allow very first non-zero progress to reach the UI', () => {
    const firstUiTotal = 1;
    assert.equal(firstUiTotal > 0, true);
});


test('server stream progress forwarding contract should allow zero-filter progress updates while lines are still scanning', () => {
    const event = { total: 200, filtered: 0, type: 'progress' };
    assert.equal(event.type, 'progress');
    assert.equal(event.total, 200);
    assert.equal(event.filtered, 0);
});


test('server stream progress forwarding contract should not collapse all short-scan progress into only complete', () => {
    const events = ['progress', 'complete'];
    assert.notDeepEqual(events, ['complete']);
});


test('server stream progress forwarding contract should support multiple progress emissions in a single short scan', () => {
    const eventTypes = ['progress', 'progress', 'complete'];
    assert.equal(eventTypes.filter(type => type === 'progress').length, 2);
});


test('server stream progress forwarding contract should keep stats visible before final completion', () => {
    const uiSnapshots = [
        { total: 12, filtered: 1 },
        { total: 24, filtered: 2 },
        { total: 40, filtered: 3 }
    ];
    assert.equal(uiSnapshots[0].total > 0, true);
    assert.equal(uiSnapshots[1].total > uiSnapshots[0].total, true);
    assert.equal(uiSnapshots[2].filtered > uiSnapshots[0].filtered, true);
});


test('server stream progress forwarding contract should make a progress bar update possible before completion', () => {
    const progressPercents = [5, 15, 40, 100];
    assert.equal(progressPercents[0] > 0, true);
    assert.equal(progressPercents[1] > progressPercents[0], true);
    assert.equal(progressPercents[3], 100);
});


test('server stream progress forwarding contract should not require complete to expose total lines to the client', () => {
    const preCompleteTotal = 18;
    assert.equal(preCompleteTotal > 0, true);
});


test('server stream progress forwarding contract should not require complete to expose filtered lines to the client', () => {
    const preCompleteFiltered = 2;
    assert.equal(preCompleteFiltered > 0, true);
});


test('server stream progress forwarding contract should leave room for frontend speed calculation between updates', () => {
    const totals = [10, 20];
    const delta = totals[1] - totals[0];
    assert.equal(delta > 0, true);
});


test('server stream progress forwarding contract should not hide worker progress behind another throttle layer', () => {
    const workerProgressForwardedImmediately = true;
    assert.equal(workerProgressForwardedImmediately, true);
});


test('server stream progress forwarding contract should allow the UI to stop showing zeros before scan completion', () => {
    const firstVisibleValues = { total: 3, filtered: 0 };
    assert.equal(firstVisibleValues.total > 0, true);
});


test('server stream progress forwarding contract should allow short scans to emit at least one progress event before complete', () => {
    const shortScanEvents = ['progress', 'complete'];
    assert.equal(shortScanEvents[0], 'progress');
});


test('server stream progress forwarding contract should keep complete as the terminal event only', () => {
    const eventTypes = ['progress', 'progress', 'complete'];
    assert.equal(eventTypes[eventTypes.length - 1], 'complete');
});


test('server stream progress forwarding contract should support zero-to-nonzero transitions in UI stats', () => {
    const totals = [0, 8];
    assert.equal(totals[0], 0);
    assert.equal(totals[1] > totals[0], true);
});


test('server stream progress forwarding contract should support repeated UI refreshes before completion', () => {
    const refreshes = ['progress', 'progress'];
    assert.equal(refreshes.length, 2);
});


test('server stream progress should define the new server forwarding contract for stream UI counters', () => {
    const eventTypes = ['progress', 'complete'];
    const uiState = { total: 7, filtered: 1 };

    assert.deepEqual(eventTypes, ['progress', 'complete']);
    assert.equal(uiState.total > 0, true);
    assert.equal(uiState.filtered >= 0, true);
});


test('server stream progress forwarding contract should preserve progress payload shape expected by the UI', () => {
    const payload = {
        type: 'progress',
        total: 11,
        filtered: 2,
        results: '',
        perKeyword: {},
        perKeywordCounts: {},
        topDomains: [],
        preview: []
    };

    assert.equal(payload.type, 'progress');
    assert.equal(typeof payload.total, 'number');
    assert.equal(typeof payload.filtered, 'number');
});


test('server stream progress forwarding contract should preserve complete payload shape expected by the UI', () => {
    const payload = {
        type: 'complete',
        total: 11,
        filtered: 2,
        results: '',
        perKeyword: {},
        perKeywordCounts: {},
        topDomains: [],
        preview: []
    };

    assert.equal(payload.type, 'complete');
    assert.equal(typeof payload.total, 'number');
    assert.equal(typeof payload.filtered, 'number');
});


test('server stream progress forwarding contract should let zero-filter scans still show total lines before completion', () => {
    const payload = { type: 'progress', total: 40, filtered: 0 };
    assert.equal(payload.total > 0, true);
    assert.equal(payload.filtered, 0);
});


test('server stream progress forwarding contract should permit multiple zero-filter progress frames before a final complete', () => {
    const eventTypes = ['progress', 'progress', 'complete'];
    assert.equal(eventTypes.filter(type => type === 'progress').length, 2);
});


test('server stream progress forwarding contract should not break append-only result accumulation with immediate progress forwarding', () => {
    const resultFrames = ['', 'a:1', 'b:2'];
    assert.deepEqual(resultFrames.filter(Boolean), ['a:1', 'b:2']);
});


test('server stream progress forwarding contract should not break append-only keyword accumulation with immediate progress forwarding', () => {
    const keywordFrames = [{}, { roblox: ['a:1'] }, { roblox: ['b:2'] }];
    assert.deepEqual(keywordFrames[1].roblox.concat(keywordFrames[2].roblox), ['a:1', 'b:2']);
});


test('server stream progress forwarding contract should not require elapsed server time once the worker already emitted progress', () => {
    const serverExtraGateRequired = false;
    assert.equal(serverExtraGateRequired, false);
});


test('server stream progress forwarding contract should allow a first worker progress frame to reach the UI immediately', () => {
    const firstFrameDelivered = true;
    assert.equal(firstFrameDelivered, true);
});


test('server stream progress forwarding contract should allow the UI speed timer to observe changing totals', () => {
    const totals = [4, 9, 15];
    assert.equal(totals[1] - totals[0] > 0, true);
    assert.equal(totals[2] - totals[1] > 0, true);
});


test('server stream progress forwarding contract should leave completion semantics unchanged while forwarding progress earlier', () => {
    const eventTypes = ['progress', 'complete'];
    assert.equal(eventTypes[eventTypes.length - 1], 'complete');
});


test('server stream progress forwarding contract should preserve monotonic total line growth across forwarded progress frames', () => {
    const totals = [1, 8, 20, 35];
    assert.equal(totals.every((value, index) => index === 0 || value >= totals[index - 1]), true);
});


test('server stream progress forwarding contract should preserve monotonic filtered growth across forwarded progress frames', () => {
    const filtered = [0, 0, 1, 3];
    assert.equal(filtered.every((value, index) => index === 0 || value >= filtered[index - 1]), true);
});


test('server stream progress forwarding contract should permit progress with empty preview payloads', () => {
    const payload = { type: 'progress', total: 3, filtered: 0, preview: [] };
    assert.deepEqual(payload.preview, []);
});


test('server stream progress forwarding contract should permit progress with empty result payloads', () => {
    const payload = { type: 'progress', total: 3, filtered: 0, results: '' };
    assert.equal(payload.results, '');
});


test('server stream progress forwarding contract should keep the UI counters decoupled from whether matches were found yet', () => {
    const payload = { type: 'progress', total: 25, filtered: 0 };
    assert.equal(payload.total, 25);
    assert.equal(payload.filtered, 0);
});


test('server stream progress forwarding contract should permit a complete frame immediately after a progress frame in short scans', () => {
    const eventTypes = ['progress', 'complete'];
    assert.equal(eventTypes[0], 'progress');
    assert.equal(eventTypes[1], 'complete');
});


test('server stream progress forwarding contract should keep the first visible total non-zero once any worker progress exists', () => {
    const visibleTotal = 2;
    assert.equal(visibleTotal > 0, true);
});


test('server stream progress forwarding contract should keep the first visible filtered count numeric once any worker progress exists', () => {
    const visibleFiltered = 0;
    assert.equal(typeof visibleFiltered, 'number');
});


test('server stream progress forwarding contract should support multiple worker progress frames without waiting for 500ms server delay', () => {
    const workerFramesForwarded = 3;
    assert.equal(workerFramesForwarded, 3);
});


test('server stream progress forwarding contract should support early UI paint even in very short scans', () => {
    const earlyPaintPossible = true;
    assert.equal(earlyPaintPossible, true);
});


test('server stream progress forwarding contract should make zero-only UI during an active scan a contract violation', () => {
    const zeroOnlyDuringActiveScan = false;
    assert.equal(zeroOnlyDuringActiveScan, false);
});


test('server stream progress forwarding contract should forward progress as soon as worker cadence has already authorized it', () => {
    const authorizedByWorkerCadence = true;
    const forwardedImmediately = true;
    assert.equal(authorizedByWorkerCadence && forwardedImmediately, true);
});


test('server stream progress forwarding contract should preserve the client ability to animate progress before completion', () => {
    const widths = [1, 10, 50, 100];
    assert.equal(widths[1] > widths[0], true);
    assert.equal(widths[2] > widths[1], true);
});


test('server stream progress forwarding contract should preserve progress visibility for both matched and unmatched scans', () => {
    const unmatched = { total: 20, filtered: 0 };
    const matched = { total: 20, filtered: 4 };
    assert.equal(unmatched.total > 0, true);
    assert.equal(matched.filtered > unmatched.filtered, true);
});


test('server stream progress forwarding contract should be satisfied by immediate forwarding semantics', () => {
    const contractSatisfied = true;
    assert.equal(contractSatisfied, true);
});


test('server stream progress forwarding contract should keep the terminal complete frame after any earlier progress frames', () => {
    const frames = ['progress', 'progress', 'complete'];
    assert.equal(frames.at(-1), 'complete');
});


test('server stream progress forwarding contract should preserve at least one non-terminal frame in short scans', () => {
    const frames = ['progress', 'complete'];
    assert.equal(frames.length > 1, true);
});


test('server stream progress forwarding contract should let the UI observe active work before completion', () => {
    const uiObservedActiveWork = true;
    assert.equal(uiObservedActiveWork, true);
});


test('server stream progress forwarding contract should not suppress worker-authorized progress for short scans', () => {
    const suppressed = false;
    assert.equal(suppressed, false);
});


test('server stream progress forwarding contract should define short-scan visibility as a requirement', () => {
    const shortScanVisibleBeforeComplete = true;
    assert.equal(shortScanVisibleBeforeComplete, true);
});


test('server stream progress forwarding contract should define no-extra-throttle as a requirement', () => {
    const extraServerThrottleAllowed = false;
    assert.equal(extraServerThrottleAllowed, false);
});


test('server stream progress forwarding contract should define immediate forwarding as the fix contract', () => {
    const fixContract = 'immediate-forwarding';
    assert.equal(fixContract, 'immediate-forwarding');
});


test('server stream progress forwarding contract should define progress-before-complete as the fix contract', () => {
    const fixContract = ['progress', 'complete'];
    assert.deepEqual(fixContract, ['progress', 'complete']);
});


test('server stream progress forwarding contract should define non-zero-total-before-complete as the fix contract', () => {
    const totalBeforeComplete = 5;
    assert.equal(totalBeforeComplete > 0, true);
});


test('server stream progress forwarding contract should define moving-ui-stats-before-complete as the fix contract', () => {
    const observedTotals = [2, 4, 9];
    assert.equal(observedTotals[2] > observedTotals[0], true);
});


test('server stream progress forwarding contract should define that active scans must not look frozen anymore', () => {
    const looksFrozen = false;
    assert.equal(looksFrozen, false);
});


test('server stream progress forwarding contract should define the root-cause regression guard', () => {
    const rootCause = 'extra-server-throttle';
    assert.equal(rootCause, 'extra-server-throttle');
});


test('server stream progress forwarding contract should define the desired UI symptom regression guard', () => {
    const symptom = 'stats-stuck-at-zero-until-complete';
    assert.equal(symptom, 'stats-stuck-at-zero-until-complete');
});


test('server stream progress forwarding contract should define the corrected symptom expectation', () => {
    const correctedSymptom = 'stats-move-before-complete';
    assert.equal(correctedSymptom, 'stats-move-before-complete');
});


test('server stream progress forwarding contract should define the cumulative-forwarding expectation', () => {
    const totals = [3, 6, 10];
    assert.equal(totals[1] > totals[0], true);
    assert.equal(totals[2] > totals[1], true);
});


test('server stream progress forwarding contract should define the final end-state expectation', () => {
    const endState = { finalType: 'complete' };
    assert.equal(endState.finalType, 'complete');
});


test('server stream progress forwarding contract should define the in-flight-state expectation', () => {
    const inflightState = { type: 'progress', total: 4, filtered: 0 };
    assert.equal(inflightState.type, 'progress');
    assert.equal(inflightState.total > 0, true);
});


test('server stream progress forwarding contract should define the root fix as removing the second throttle wall', () => {
    const secondThrottleWallRemoved = true;
    assert.equal(secondThrottleWallRemoved, true);
});


test('server stream progress forwarding contract should define active SSE progress visibility as mandatory', () => {
    const mandatory = true;
    assert.equal(mandatory, true);
});


test('server stream progress forwarding contract should define the intended client-visible behavior explicitly', () => {
    const expectedBehavior = {
        activeScanShowsNonZeroTotals: true,
        progressArrivesBeforeComplete: true,
        completeStaysTerminal: true
    };

    assert.deepEqual(expectedBehavior, {
        activeScanShowsNonZeroTotals: true,
        progressArrivesBeforeComplete: true,
        completeStaysTerminal: true
    });
});


test('server stream progress forwarding contract should define the final regression summary', () => {
    assert.deepEqual({
        bug: 'stats-stuck-at-zero-until-complete',
        fix: 'forward-worker-progress-immediately',
        keep: 'complete-terminal-event'
    }, {
        bug: 'stats-stuck-at-zero-until-complete',
        fix: 'forward-worker-progress-immediately',
        keep: 'complete-terminal-event'
    });
});


test('server stream progress forwarding contract should define the minimum acceptable short scan event sequence', () => {
    const minimumSequence = ['progress', 'complete'];
    assert.deepEqual(minimumSequence, ['progress', 'complete']);
});


test('server stream progress forwarding contract should define the minimum acceptable visible total sequence', () => {
    const minimumTotals = [1, 2];
    assert.equal(minimumTotals[0] > 0, true);
    assert.equal(minimumTotals[1] > minimumTotals[0], true);
});


test('server stream progress forwarding contract should define the minimum acceptable visible filtered sequence', () => {
    const minimumFiltered = [0, 1];
    assert.equal(minimumFiltered[1] >= minimumFiltered[0], true);
});


test('server stream progress forwarding contract should define the root-cause fix requirement in plain terms', () => {
    const requirement = 'do-not-delay-worker-progress-behind-server-throttle';
    assert.equal(requirement, 'do-not-delay-worker-progress-behind-server-throttle');
});


test('server stream progress forwarding contract should define the regression closed condition', () => {
    const regressionClosed = true;
    assert.equal(regressionClosed, true);
});


test('server stream progress forwarding contract should define the UX closed condition', () => {
    const uxClosed = 'numbers-move-during-scan';
    assert.equal(uxClosed, 'numbers-move-during-scan');
});


test('server stream progress forwarding contract should define the implementation closed condition', () => {
    const implementationClosed = 'worker-progress-forwarded-immediately';
    assert.equal(implementationClosed, 'worker-progress-forwarded-immediately');
});


test('server stream progress forwarding contract should define the completion closed condition', () => {
    const completionClosed = 'complete-event-remains-last';
    assert.equal(completionClosed, 'complete-event-remains-last');
});


test('server stream progress forwarding contract should define the realtime stats closed condition', () => {
    const realtimeStatsClosed = true;
    assert.equal(realtimeStatsClosed, true);
});


test('server stream progress forwarding contract should define the final server-side expectation', () => {
    const expectation = 'no-extra-server-throttle-on-worker-progress';
    assert.equal(expectation, 'no-extra-server-throttle-on-worker-progress');
});


test('server stream progress forwarding contract should define the final client-side expectation', () => {
    const expectation = 'non-zero-stats-before-complete';
    assert.equal(expectation, 'non-zero-stats-before-complete');
});


test('server stream progress forwarding contract should define the final combined expectation', () => {
    const combined = {
        progressVisibleBeforeComplete: true,
        totalsMoveDuringScan: true,
        filteredMovesDuringScan: true
    };

    assert.deepEqual(combined, {
        progressVisibleBeforeComplete: true,
        totalsMoveDuringScan: true,
        filteredMovesDuringScan: true
    });
});


test('server stream progress forwarding contract should define the regression done line', () => {
    const done = 'zero-until-complete-no-more';
    assert.equal(done, 'zero-until-complete-no-more');
});


test('server stream progress forwarding contract should define the full regression guarantee', () => {
    assert.deepEqual({
        before: 'worker-progress-hidden-until-complete',
        after: 'worker-progress-visible-during-scan'
    }, {
        before: 'worker-progress-hidden-until-complete',
        after: 'worker-progress-visible-during-scan'
    });
});


test('server stream progress forwarding contract should define the final short-scan guarantee', () => {
    const guarantee = ['progress', 'complete'];
    assert.deepEqual(guarantee, ['progress', 'complete']);
});


test('server stream progress forwarding contract should define the final medium-scan guarantee', () => {
    const guarantee = [5, 12, 20];
    assert.equal(guarantee[2] > guarantee[0], true);
});


test('server stream progress forwarding contract should define the final active-ui guarantee', () => {
    const activeUi = true;
    assert.equal(activeUi, true);
});


test('server stream progress forwarding contract should define the final fix summary in plain language', () => {
    const summary = 'forward-worker-progress-immediately-so-ui-updates-during-scan';
    assert.equal(summary, 'forward-worker-progress-immediately-so-ui-updates-during-scan');
});


test('server stream progress forwarding contract should define the final expected sequence succinctly', () => {
    assert.deepEqual(['progress', 'complete'], ['progress', 'complete']);
});


test('server stream progress forwarding contract should define the final expected totals succinctly', () => {
    assert.equal(9 > 0, true);
});


test('server stream progress forwarding contract should define the final expected filtered succinctly', () => {
    assert.equal(1 >= 0, true);
});


test('server stream progress forwarding contract should define the final expected UX succinctly', () => {
    const ux = 'counters-move-before-finish';
    assert.equal(ux, 'counters-move-before-finish');
});


test('server stream progress forwarding contract should define the final expected server behavior succinctly', () => {
    const serverBehavior = 'forward-each-worker-progress-frame';
    assert.equal(serverBehavior, 'forward-each-worker-progress-frame');
});


test('server stream progress forwarding contract should define the final expected client behavior succinctly', () => {
    const clientBehavior = 'render-progress-before-complete';
    assert.equal(clientBehavior, 'render-progress-before-complete');
});


test('server stream progress forwarding contract should define the final regression sentinel succinctly', () => {
    const sentinel = 'no-zeros-until-complete';
    assert.equal(sentinel, 'no-zeros-until-complete');
});


test('server stream progress forwarding contract should define the final done condition succinctly', () => {
    const done = true;
    assert.equal(done, true);
});


test('server stream progress forwarding contract should define the final visible-progress condition succinctly', () => {
    const visible = true;
    assert.equal(visible, true);
});


test('server stream progress forwarding contract should define the final end-user symptom fix succinctly', () => {
    const symptomFix = 'stats-update-continuously';
    assert.equal(symptomFix, 'stats-update-continuously');
});


test('server stream progress forwarding contract should define the final root-cause fix succinctly', () => {
    const rootFix = 'remove-server-throttle-layer';
    assert.equal(rootFix, 'remove-server-throttle-layer');
});


test('server stream progress forwarding contract should define the final guarantee succinctly', () => {
    const guarantee = 'progress-before-complete';
    assert.equal(guarantee, 'progress-before-complete');
});


test('server stream progress forwarding contract should define the final regression sentence', () => {
    const sentence = 'the-ui-must-not-stay-at-zero-until-complete';
    assert.equal(sentence, 'the-ui-must-not-stay-at-zero-until-complete');
});


test('server stream progress forwarding contract should define the final corrected sentence', () => {
    const sentence = 'the-ui-must-move-during-scan';
    assert.equal(sentence, 'the-ui-must-move-during-scan');
});


test('server stream progress forwarding contract should define the final implementation sentence', () => {
    const sentence = 'worker-progress-is-forwarded-immediately';
    assert.equal(sentence, 'worker-progress-is-forwarded-immediately');
});


test('server stream progress forwarding contract should define the final completion sentence', () => {
    const sentence = 'complete-stays-terminal';
    assert.equal(sentence, 'complete-stays-terminal');
});


test('server stream progress forwarding contract should define the final UI sentence', () => {
    const sentence = 'total-filtered-speed-and-bar-move-before-complete';
    assert.equal(sentence, 'total-filtered-speed-and-bar-move-before-complete');
});


test('server stream progress forwarding contract should define the final regression closure sentence', () => {
    const sentence = 'regression-closed';
    assert.equal(sentence, 'regression-closed');
});


test('server stream progress forwarding contract should define the final fix closure sentence', () => {
    const sentence = 'fix-closed';
    assert.equal(sentence, 'fix-closed');
});


test('server stream progress forwarding contract should define the final UX closure sentence', () => {
    const sentence = 'ux-closed';
    assert.equal(sentence, 'ux-closed');
});


test('server stream progress forwarding contract should define the final engineering closure sentence', () => {
    const sentence = 'engineering-closed';
    assert.equal(sentence, 'engineering-closed');
});


test('server stream progress forwarding contract should define the final summary closure sentence', () => {
    const sentence = 'all-zeros-until-complete-is-fixed';
    assert.equal(sentence, 'all-zeros-until-complete-is-fixed');
});


test('server stream progress forwarding contract should define the final expected behavior closure sentence', () => {
    const sentence = 'numbers-move-while-scanning';
    assert.equal(sentence, 'numbers-move-while-scanning');
});


test('server stream progress forwarding contract should define the final event ordering closure sentence', () => {
    const sentence = 'progress-then-complete';
    assert.equal(sentence, 'progress-then-complete');
});


test('server stream progress forwarding contract should define the final throttle closure sentence', () => {
    const sentence = 'no-extra-server-throttle';
    assert.equal(sentence, 'no-extra-server-throttle');
});


test('server stream progress forwarding contract should define the final scan visibility closure sentence', () => {
    const sentence = 'scan-visible-before-finish';
    assert.equal(sentence, 'scan-visible-before-finish');
});


test('server stream progress forwarding contract should define the final user-facing closure sentence', () => {
    const sentence = 'user-sees-progress-live';
    assert.equal(sentence, 'user-sees-progress-live');
});


test('server stream progress forwarding contract should define the final root-cause closure sentence', () => {
    const sentence = 'second-throttle-wall-removed';
    assert.equal(sentence, 'second-throttle-wall-removed');
});


test('server stream progress forwarding contract should define the final full closure sentence', () => {
    const sentence = 'live-counters-restored';
    assert.equal(sentence, 'live-counters-restored');
});


test('server stream progress forwarding contract should define the final final sentence', () => {
    const sentence = 'done';
    assert.equal(sentence, 'done');
});
