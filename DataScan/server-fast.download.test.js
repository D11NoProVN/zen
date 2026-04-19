const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDownloadSuccessPayload,
    createDownloadCompleteEvent,
    ArchiveExtractionError
} = require('./server-fast');

test('createDownloadSuccessPayload should keep plain text downloads unchanged', () => {
    const file = {
        name: 'sample.txt',
        size: 123,
        modified: new Date('2026-04-19T10:00:00Z'),
        path: '/tmp/sample.txt',
        downloadTime: 1.5,
        speed: 82
    };

    assert.deepEqual(createDownloadSuccessPayload({ file }), {
        success: true,
        file
    });
});

test('createDownloadSuccessPayload should include extraction metadata for archive downloads', () => {
    const extraction = {
        archiveType: 'zip',
        extractedCount: 2,
        files: [
            { name: 'a.txt', size: 10 },
            { name: 'b.txt', size: 20 }
        ]
    };

    assert.deepEqual(createDownloadSuccessPayload({ extraction }), {
        success: true,
        extraction: {
            archiveType: 'zip',
            extractedCount: 2,
            files: extraction.files
        }
    });
});

test('createDownloadCompleteEvent should include file for plain downloads and extraction for archives', () => {
    const file = {
        name: 'plain.txt',
        size: 55,
        modified: new Date('2026-04-19T10:00:00Z'),
        downloadTime: 2,
        speed: 22
    };
    const extraction = {
        archiveType: 'rar',
        extractedCount: 1,
        files: [
            { name: 'inner.txt', size: 55 }
        ]
    };

    assert.deepEqual(createDownloadCompleteEvent({ file }), {
        type: 'complete',
        file
    });
    assert.deepEqual(createDownloadCompleteEvent({ extraction }), {
        type: 'complete',
        extraction: {
            archiveType: 'rar',
            extractedCount: 1,
            files: extraction.files
        }
    });
});

test('ArchiveExtractionError should be re-exported for route-level handling', () => {
    const err = new ArchiveExtractionError('bad archive');
    assert.equal(err.message, 'bad archive');
});
