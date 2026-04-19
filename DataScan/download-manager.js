// Download Manager Script
const $ = id => document.getElementById(id);

const el = {
    urlInput: $('urlInput'),
    downloadBtn: $('downloadBtn'),
    refreshBtn: $('refreshBtn'),
    filesContainer: $('filesContainer'),
    fileCount: $('fileCount'),
    selectAllBtn: $('selectAllBtn'),
    deleteSelectedBtn: $('deleteSelectedBtn'),
    downloadProgress: $('downloadProgress'),
    progressFilename: $('progressFilename'),
    progressBarFill: $('progressBarFill'),
    progressDownloaded: $('progressDownloaded'),
    progressTotal: $('progressTotal'),
    progressSpeed: $('progressSpeed'),
    progressPercent: $('progressPercent'),
    cancelDownloadBtn: $('cancelDownloadBtn'),
    toastContainer: $('toastContainer')
};

let currentDownload = null;
let selectedFiles = new Set();

// Toast notification
function notify(msg, type = 'info') {
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(msg)}`;
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('exit');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1048576) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSecond / 1048576).toFixed(2) + ' MB/s';
}

function formatDate(date) {
    return new Date(date).toLocaleString('vi-VN');
}

// Load files
async function loadFiles() {
    try {
        const res = await fetch('/api/files');
        const data = await res.json();

        if (data.success) {
            renderFiles(data.files);
        } else {
            notify('Lỗi tải danh sách file: ' + data.error, 'error');
        }
    } catch (err) {
        notify('Lỗi kết nối server: ' + err.message, 'error');
    }
}

// Render files
function renderFiles(files) {
    el.fileCount.textContent = files.length;

    if (files.length === 0) {
        el.filesContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-folder-open"></i>
                <p>Chưa có file nào. Nhập URL để tải file.</p>
            </div>
        `;
        return;
    }

    el.filesContainer.innerHTML = `<div class="files-grid">${files.map(file => `
        <div class="file-card glass ${selectedFiles.has(file.name) ? 'selected' : ''}" data-filename="${escapeHtml(file.name)}">
            <input type="checkbox" class="file-checkbox" data-filename="${escapeHtml(file.name)}" ${selectedFiles.has(file.name) ? 'checked' : ''}>
            <div class="file-icon">
                <i class="fas fa-file-lines"></i>
            </div>
            <div class="file-name">${escapeHtml(file.name)}</div>
            <div class="file-meta">
                <i class="fas fa-weight-hanging"></i> ${formatBytes(file.size)}
            </div>
            <div class="file-meta">
                <i class="fas fa-clock"></i> ${formatDate(file.modified)}
            </div>
            <div class="file-actions">
                <button class="btn btn-ghost btn-delete" data-filename="${escapeHtml(file.name)}">
                    <i class="fas fa-trash"></i> Xóa
                </button>
            </div>
        </div>
    `).join('')}</div>`;

    // Attach event listeners
    el.filesContainer.querySelectorAll('.file-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const filename = cb.dataset.filename;
            const card = el.filesContainer.querySelector(`.file-card[data-filename="${filename}"]`);

            if (cb.checked) {
                selectedFiles.add(filename);
                card.classList.add('selected');
            } else {
                selectedFiles.delete(filename);
                card.classList.remove('selected');
            }

            updateDeleteButton();
        });
    });

    el.filesContainer.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteFile(btn.dataset.filename);
        });
    });
}

function updateDeleteButton() {
    el.deleteSelectedBtn.disabled = selectedFiles.size === 0;
    el.deleteSelectedBtn.innerHTML = `
        <i class="fas fa-trash"></i> Xóa đã chọn ${selectedFiles.size > 0 ? `(${selectedFiles.size})` : ''}
    `;
}

// Download file with progress
async function downloadFile() {
    const url = el.urlInput.value.trim();

    if (!url) {
        notify('Vui lòng nhập URL!', 'error');
        return;
    }

    // Show progress
    el.downloadProgress.classList.add('active');
    el.progressFilename.textContent = 'Đang kết nối...';
    el.progressBarFill.style.width = '0%';
    el.progressDownloaded.textContent = '0 MB';
    el.progressTotal.textContent = '0 MB';
    el.progressSpeed.textContent = '0 MB/s';
    el.progressPercent.textContent = '0%';

    try {
        const response = await fetch('/api/download-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            throw new Error('Download failed');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        currentDownload = { reader, active: true };

        while (currentDownload.active) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    handleDownloadProgress(data);
                }
            }
        }

        currentDownload = null;
    } catch (err) {
        notify('Lỗi: ' + err.message, 'error');
        el.downloadProgress.classList.remove('active');
        currentDownload = null;
    }
}

function handleDownloadProgress(data) {
    if (data.type === 'start') {
        el.progressFilename.textContent = data.filename;
        el.progressTotal.textContent = formatBytes(data.totalSize);
    } else if (data.type === 'progress') {
        el.progressDownloaded.textContent = formatBytes(data.downloaded);
        el.progressSpeed.textContent = formatSpeed(data.speed);
        el.progressPercent.textContent = data.progress.toFixed(1) + '%';
        el.progressBarFill.style.width = data.progress + '%';
    } else if (data.type === 'complete') {
        el.progressPercent.textContent = '100%';
        el.progressBarFill.style.width = '100%';

        setTimeout(() => {
            el.downloadProgress.classList.remove('active');
            notify(`Đã tải thành công: ${data.file.name} (${formatSpeed(data.file.speed)})`, 'success');
            el.urlInput.value = '';
            loadFiles();
        }, 1000);
    } else if (data.type === 'error') {
        notify('Lỗi tải file: ' + data.message, 'error');
        el.downloadProgress.classList.remove('active');
    }
}

// Cancel download
el.cancelDownloadBtn.addEventListener('click', () => {
    if (currentDownload) {
        currentDownload.active = false;
        currentDownload.reader.cancel();
        currentDownload = null;
        el.downloadProgress.classList.remove('active');
        notify('Đã hủy tải file!', 'info');
    }
});

// Delete file
async function deleteFile(filename) {
    if (!confirm(`Xóa file "${filename}"?`)) return;

    try {
        const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });

        const data = await res.json();

        if (data.success) {
            notify('Đã xóa file!', 'success');
            selectedFiles.delete(filename);
            loadFiles();
        } else {
            notify('Lỗi xóa file: ' + data.error, 'error');
        }
    } catch (err) {
        notify('Lỗi: ' + err.message, 'error');
    }
}

// Delete selected files
el.deleteSelectedBtn.addEventListener('click', async () => {
    if (selectedFiles.size === 0) return;

    if (!confirm(`Xóa ${selectedFiles.size} file đã chọn?`)) return;

    const files = Array.from(selectedFiles);
    let success = 0;
    let failed = 0;

    for (const filename of files) {
        try {
            const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });

            const data = await res.json();
            if (data.success) {
                success++;
                selectedFiles.delete(filename);
            } else {
                failed++;
            }
        } catch (err) {
            failed++;
        }
    }

    if (success > 0) {
        notify(`Đã xóa ${success} file!`, 'success');
    }
    if (failed > 0) {
        notify(`Lỗi xóa ${failed} file!`, 'error');
    }

    loadFiles();
    updateDeleteButton();
});

// Select all
el.selectAllBtn.addEventListener('click', () => {
    const checkboxes = el.filesContainer.querySelectorAll('.file-checkbox');
    const allSelected = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);

    checkboxes.forEach(cb => {
        const filename = cb.dataset.filename;
        const card = el.filesContainer.querySelector(`.file-card[data-filename="${filename}"]`);

        if (allSelected) {
            cb.checked = false;
            selectedFiles.delete(filename);
            card.classList.remove('selected');
        } else {
            cb.checked = true;
            selectedFiles.add(filename);
            card.classList.add('selected');
        }
    });

    el.selectAllBtn.innerHTML = allSelected
        ? '<i class="fas fa-check-double"></i> Chọn tất cả'
        : '<i class="fas fa-times"></i> Bỏ chọn tất cả';

    updateDeleteButton();
});

// Event listeners
el.downloadBtn.addEventListener('click', downloadFile);
el.refreshBtn.addEventListener('click', loadFiles);
el.urlInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') downloadFile();
});

// Initial load
loadFiles();
