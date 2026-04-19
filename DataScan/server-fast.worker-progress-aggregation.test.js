const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createAggregationState,
    applyWorkerProgress,
    dedupeAggregatedResults,
    mapKeywordPayloadToClientKeywords,
    finalizeAggregatedTotals,
    toTopDomains,
    rebuildDomainCountFromLineDomains,
    rebuildDomainCountFromLines
} = require('./scan-fast-worker-aggregation');

function createInitialState() {
    return createAggregationState(['bidaithanroblox.com']);
}

test('aggregation should apply worker progress as deltas, not cumulative totals', () => {
    const state = createInitialState();

    // Worker 0 sends cumulative progress snapshots
    applyWorkerProgress(state, 0, {
        total: 100,
        filtered: 10,
        lines: ['a1:p1', 'a2:p2'],
        perKeyword: {
            'bidaithanroblox.com': ['a1:p1', 'a2:p2']
        },
        domainCount: {
            'bidaithanroblox.com': 10
        }
    });

    applyWorkerProgress(state, 0, {
        total: 200,
        filtered: 15,
        lines: ['a3:p3'],
        perKeyword: {
            'bidaithanroblox.com': ['a3:p3']
        },
        domainCount: {
            'bidaithanroblox.com': 15
        }
    });

    finalizeAggregatedTotals(state);

    assert.equal(state.total, 200);
    assert.equal(state.filtered, 3);
    assert.equal(state.lines.length, 3);

    const top = toTopDomains(state, 10);
    assert.deepEqual(top, [['bidaithanroblox.com', 15]]);
});

test('aggregation should combine multiple workers without multiplicative overcount', () => {
    const state = createInitialState();

    applyWorkerProgress(state, 0, {
        total: 100,
        filtered: 2,
        lines: ['w0-1', 'w0-2'],
        perKeyword: {
            'bidaithanroblox.com': ['w0-1', 'w0-2']
        },
        domainCount: {
            'bidaithanroblox.com': 2
        }
    });

    applyWorkerProgress(state, 1, {
        total: 50,
        filtered: 1,
        lines: ['w1-1'],
        perKeyword: {
            'bidaithanroblox.com': ['w1-1']
        },
        domainCount: {
            'bidaithanroblox.com': 1
        }
    });

    // worker 0 sends another cumulative update that should add only delta total/domain
    applyWorkerProgress(state, 0, {
        total: 180,
        filtered: 4,
        lines: ['w0-3', 'w0-4'],
        perKeyword: {
            'bidaithanroblox.com': ['w0-3', 'w0-4']
        },
        domainCount: {
            'bidaithanroblox.com': 4
        }
    });

    finalizeAggregatedTotals(state);

    assert.equal(state.total, 230); // 180 + 50
    assert.equal(state.filtered, 5);
    assert.deepEqual(state.lines, ['w0-1', 'w0-2', 'w1-1', 'w0-3', 'w0-4']);

    const top = toTopDomains(state, 10);
    assert.deepEqual(top, [['bidaithanroblox.com', 5]]);
});

test('domain aggregation should not explode when many progress events arrive', () => {
    const state = createInitialState();

    // Simulate many cumulative updates from one worker
    for (let i = 1; i <= 100; i++) {
        applyWorkerProgress(state, 0, {
            total: i * 100,
            filtered: i,
            lines: [`u${i}:p${i}`],
            perKeyword: {
                'bidaithanroblox.com': [`u${i}:p${i}`]
            },
            domainCount: {
                'bidaithanroblox.com': i
            }
        });
    }

    finalizeAggregatedTotals(state);

    const top = toTopDomains(state, 10);

    // Correct final domain count should be 100 (latest cumulative), not sum(1..100)
    assert.deepEqual(top, [['bidaithanroblox.com', 100]]);
    assert.equal(state.filtered, 100);
});

test('rebuildDomainCountFromLines should produce domain counts from deduped lines', () => {
    const dedupedLines = [
        'https://bidaithanroblox.com/:u1:p1',
        'https://bidaithanroblox.com/:u2:p2',
        'https://example.com/:u3:p3'
    ];

    const domainMap = rebuildDomainCountFromLines(dedupedLines);

    assert.deepEqual(Array.from(domainMap.entries()).sort((a, b) => a[0].localeCompare(b[0])), [
        ['bidaithanroblox.com', 2],
        ['example.com', 1]
    ]);
});

test('deduped strip-url aggregation should preserve original URL domains instead of domains inside credentials', () => {
    const state = createInitialState();

    applyWorkerProgress(state, 0, {
        total: 2,
        filtered: 2,
        lines: ['gmail.com:pass123', 'gmail.com:pass123'],
        lineDomains: ['bidaithanroblox.com', 'bidaithanroblox.com'],
        perKeyword: {
            'bidaithanroblox.com': ['gmail.com:pass123', 'gmail.com:pass123']
        },
        domainCount: {
            'bidaithanroblox.com': 2
        }
    });

    dedupeAggregatedResults(state, ['bidaithanroblox.com']);
    finalizeAggregatedTotals(state);
    state.domainCount = rebuildDomainCountFromLineDomains(state.lineDomains);

    assert.deepEqual(state.lines, ['gmail.com:pass123']);
    assert.deepEqual(state.perKeyword['bidaithanroblox.com'], ['gmail.com:pass123']);
    assert.deepEqual(toTopDomains(state, 10), [['bidaithanroblox.com', 1]]);
});

test('mapKeywordPayloadToClientKeywords should remap normalized strip-url keys back to original client keywords', () => {
    const payload = mapKeywordPayloadToClientKeywords({
        perKeyword: {
            'bidaithanroblox.com': ['u1:p1', 'u2:p2']
        },
        perKeywordCounts: {
            'bidaithanroblox.com': 2
        }
    }, ['https://bidaithanroblox.com/'], true);

    assert.deepEqual(payload.perKeyword, {
        'https://bidaithanroblox.com/': ['u1:p1', 'u2:p2']
    });
    assert.deepEqual(payload.perKeywordCounts, {
        'https://bidaithanroblox.com/': 2
    });
});
