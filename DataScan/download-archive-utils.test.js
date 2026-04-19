const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireFromProject = createRequire(path.join(__dirname, 'package.json'));
const yazl = requireFromProject('yazl');

const {
    extractDownloadedArchive,
    detectDownloadedArchiveType,
    ArchiveExtractionError
} = require('./download-archive-utils');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createZip(zipPath, entries) {
    return new Promise((resolve, reject) => {
        const zipFile = new yazl.ZipFile();
        for (const entry of entries) {
            zipFile.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name);
        }
        zipFile.end();

        const output = fs.createWriteStream(zipPath);
        zipFile.outputStream.pipe(output);
        output.on('close', resolve);
        output.on('error', reject);
    });
}

test('detectDownloadedArchiveType should detect zip and rar by extension', () => {
    assert.equal(detectDownloadedArchiveType('sample.zip'), 'zip');
    assert.equal(detectDownloadedArchiveType('sample.rar'), 'rar');
    assert.equal(detectDownloadedArchiveType('sample.txt'), null);
});

test('extractDownloadedArchive should extract nested text files from zip and remove archive', async () => {
    const tmpDir = makeTempDir('zenscan-zip-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'root.txt', content: 'root' },
        { name: 'nested/inner.txt', content: 'inner' },
        { name: 'nested/image.png', content: 'png' }
    ]);

    const result = await extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    });

    assert.equal(result.archiveType, 'zip');
    assert.equal(result.extractedCount, 2);
    assert.deepEqual(result.files.map(file => file.name).sort(), ['inner.txt', 'root.txt']);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'root.txt'), 'utf8'), 'root');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'inner.txt'), 'utf8'), 'inner');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extractDownloadedArchive should preserve duplicate text names from zip by auto-renaming', async () => {
    const tmpDir = makeTempDir('zenscan-zip-dup-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'team/report.txt', content: 'one' },
        { name: 'backup/report.txt', content: 'two' }
    ]);

    const result = await extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    });

    assert.deepEqual(result.files.map(file => file.name).sort(), ['report (1).txt', 'report.txt']);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'report.txt'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'report (1).txt'), 'utf8'), 'two');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extractDownloadedArchive should fail cleanly when zip contains no text files', async () => {
    const tmpDir = makeTempDir('zenscan-zip-empty-');
    const archivePath = path.join(tmpDir, 'sample.zip');
    await createZip(archivePath, [
        { name: 'nested/image.png', content: 'png' }
    ]);

    await assert.rejects(() => extractDownloadedArchive({
        archivePath,
        archiveType: 'zip',
        downloadDir: tmpDir
    }), ArchiveExtractionError);

    assert.equal(fs.existsSync(archivePath), false);
    assert.deepEqual(fs.readdirSync(tmpDir), []);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extractDownloadedArchive should fail cleanly when rar parsing fails', async () => {
    const tmpDir = makeTempDir('zenscan-rar-invalid-');
    const archivePath = path.join(tmpDir, 'sample.rar');
    fs.writeFileSync(archivePath, Buffer.from('not-a-real-rar'));

    await assert.rejects(async () => {
        await extractDownloadedArchive({
            archivePath,
            archiveType: 'rar',
            downloadDir: tmpDir
        });
    }, (err) => {
        assert.equal(err instanceof ArchiveExtractionError, true);
        assert.match(err.message, /rar/i);
        return true;
    });

    assert.equal(fs.existsSync(archivePath), false);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
