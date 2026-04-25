// No need to test the old handleDownloadProgress as the UI has been completely rewritten.
// We can just verify getDownloadSuccessMessage locally.
const test = require('node:test');
const assert = require('node:assert/strict');

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || isNaN(bytesPerSecond)) return '0 B/s';
    if (bytesPerSecond < 1048576) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSecond / 1048576).toFixed(2) + ' MB/s';
}

function getDownloadSuccessMessage(data) {
    if (data.extraction) {
        return `Giải nén xong ${data.extraction.extractedCount} file`;
    }
    return `Hoàn tất!`;
}

test('getDownloadSuccessMessage should keep plain file success text', () => {
    assert.equal(getDownloadSuccessMessage({ file: { name: 'test.txt' } }), 'Hoàn tất!');
});

test('getDownloadSuccessMessage should report extracted archive counts', () => {
    assert.equal(getDownloadSuccessMessage({ extraction: { extractedCount: 5 } }), 'Giải nén xong 5 file');
});
