// Download Manager Script - Multi-Link Edition
const $ = id => document.getElementById(id);

const el = {
    urlInput: $('urlInput'),
    downloadBtn: $('downloadBtn'),
    refreshBtn: $('refreshBtn'),
    proxyInput: $('proxyInput'),
    filesContainer: $('filesContainer'),
    fileCount: $('fileCount'),
    selectAllBtn: $('selectAllBtn'),
    deleteSelectedBtn: $('deleteSelectedBtn'),
    activeDownloadsContainer: $('activeDownloadsContainer'),
    toastContainer: $('toastContainer')
};

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
    if (!bytes || isNaN(bytes)) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || isNaN(bytesPerSecond)) return '0 B/s';
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

// Multi-Download Trigger
async function downloadFiles() {
    const rawUrls = el.urlInput.value.trim();
    const proxy = el.proxyInput.value.trim();

    if (!rawUrls) {
        notify('Vui lòng nhập ít nhất một URL!', 'error');
        return;
    }

    const urls = rawUrls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    el.urlInput.value = ''; // Clear input

    notify(`Bắt đầu tải ${urls.length} file...`, 'info');

    urls.forEach(url => {
        startSingleDownload(url, proxy);
    });
}

async function startSingleDownload(url, proxy) {
    const downloadId = 'dl_' + Math.random().toString(36).substr(2, 9);
    
    // Create UI for this specific download
    const dlElement = document.createElement('div');
    dlElement.className = 'download-progress';
    dlElement.id = downloadId;
    dlElement.innerHTML = `
        <div class="progress-header">
            <div class="progress-filename loading">
                <i class="fas fa-spinner fa-spin"></i>
                <span class="progress-filename-text">${escapeHtml(url)}</span>
            </div>
            <button class="btn btn-ghost cancel-btn" style="padding: 0.2rem 0.5rem; font-size: 0.6rem;">
                <i class="fas fa-xmark"></i>
            </button>
        </div>
        <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: 0%"></div>
        </div>
        <div class="progress-stats">
            <div class="progress-stat">
                <span class="progress-stat-label">Đã tải</span>
                <span class="progress-stat-value downloaded-text">0 B</span>
            </div>
            <div class="progress-stat">
                <span class="progress-stat-label">Tốc độ</span>
                <span class="progress-stat-value speed-text">0 B/s</span>
            </div>
            <div class="progress-stat">
                <span class="progress-stat-label">Tiến độ</span>
                <span class="progress-stat-value percent-text">0%</span>
            </div>
        </div>
        <!-- Inline Password Box -->
        <div class="inline-password-box">
            <div class="inline-password-row">
                <input type="password" class="inline-password-input" placeholder="Nhập mật khẩu giải nén...">
                <button class="btn btn-primary inline-submit-btn" style="padding: 0.3rem 0.6rem; font-size: 0.7rem;">
                    <i class="fas fa-unlock"></i>
                </button>
            </div>
            <div class="inline-password-error">Mật khẩu sai, thử lại!</div>
        </div>
    `;
    
    el.activeDownloadsContainer.prepend(dlElement);

    const ui = {
        element: dlElement,
        filename: dlElement.querySelector('.progress-filename-text'),
        filenameContainer: dlElement.querySelector('.progress-filename'),
        bar: dlElement.querySelector('.progress-bar-fill'),
        downloaded: dlElement.querySelector('.downloaded-text'),
        speed: dlElement.querySelector('.speed-text'),
        percent: dlElement.querySelector('.percent-text'),
        cancelBtn: dlElement.querySelector('.cancel-btn'),
        passBox: dlElement.querySelector('.inline-password-box'),
        passInput: dlElement.querySelector('.inline-password-input'),
        passSubmit: dlElement.querySelector('.inline-submit-btn'),
        passError: dlElement.querySelector('.inline-password-error')
    };

    let active = true;
    let reader = null;

    ui.cancelBtn.addEventListener('click', () => {
        active = false;
        if (reader) reader.cancel();
        dlElement.style.opacity = '0.5';
        setTimeout(() => dlElement.remove(), 1000);
    });

    try {
        const response = await fetch('/api/download-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, proxy })
        });
        
        if (!response.ok) throw new Error('Kết nối thất bại');

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (active) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        handleSingleProgress(data, ui, downloadId);
                    } catch (e) {}
                }
            }
        }
    } catch (err) {
        if (active) {
            ui.element.classList.add('error');
            ui.filename.textContent = 'Lỗi: ' + err.message;
            ui.filenameContainer.classList.remove('loading');
            ui.filenameContainer.querySelector('i').className = 'fas fa-circle-exclamation';
        }
    }
}

function handleSingleProgress(data, ui, downloadId) {
    if (data.type === 'start') {
        ui.filename.textContent = data.filename;
        ui.filenameContainer.classList.remove('loading');
        ui.filenameContainer.querySelector('i').className = 'fas fa-file-arrow-down';
    } else if (data.type === 'progress') {
        ui.downloaded.textContent = formatBytes(data.downloaded);
        ui.speed.textContent = formatSpeed(data.speed);
        ui.percent.textContent = Math.round(data.progress) + '%';
        ui.bar.style.width = data.progress + '%';
    } else if (data.type === 'complete') {
        ui.element.classList.add('completed');
        ui.bar.style.width = '100%';
        ui.percent.textContent = '100%';
        ui.filenameContainer.querySelector('i').className = 'fas fa-check-circle';
        ui.filenameContainer.querySelector('i').style.color = '#2ecc71';
        
        let msg = data.extraction 
            ? `Giải nén xong ${data.extraction.extractedCount} file`
            : 'Hoàn tất!';
        ui.speed.textContent = msg;

        setTimeout(() => {
            ui.element.style.opacity = '0';
            setTimeout(() => {
                ui.element.remove();
                loadFiles();
            }, 500);
        }, 3000);

    } else if (data.type === 'password_required') {
        ui.element.classList.add('password-needed');
        ui.passBox.classList.add('active');
        ui.filenameContainer.querySelector('i').className = 'fas fa-key';
        ui.speed.textContent = 'Yêu cầu mật khẩu';

        const submitPass = () => {
            const password = ui.passInput.value.trim();
            if (!password) return;

            ui.passSubmit.disabled = true;
            ui.passSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            ui.passError.style.display = 'none';

            fetch('/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: data.filename, password })
            })
            .then(res => res.json())
            .then(resData => {
                if (resData.success) {
                    ui.passBox.classList.remove('active');
                    handleSingleProgress({ ...resData, type: 'complete' }, ui, downloadId);
                } else {
                    ui.passSubmit.disabled = false;
                    ui.passSubmit.innerHTML = '<i class="fas fa-unlock"></i>';
                    ui.passError.style.display = 'block';
                    ui.passInput.value = '';
                    ui.passInput.focus();
                }
            })
            .catch(() => {
                ui.passSubmit.disabled = false;
                ui.passSubmit.innerHTML = '<i class="fas fa-unlock"></i>';
            });
        };

        ui.passSubmit.onclick = submitPass;
        ui.passInput.onkeypress = e => { if (e.key === 'Enter') submitPass(); };

    } else if (data.type === 'error') {
        ui.element.classList.add('error');
        ui.filename.textContent = data.message;
        ui.filenameContainer.querySelector('i').className = 'fas fa-circle-exclamation';
        ui.filenameContainer.querySelector('i').style.color = '#ff6b6b';
    }
}

// Delete file
async function deleteFile(filename) {
    if (!confirm(`Xóa file "${filename}"?`)) return;
    try {
        const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
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
    for (const filename of files) {
        try {
            const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) selectedFiles.delete(filename);
        } catch (err) {}
    }
    notify(`Đã xử lý xong việc xóa file!`, 'info');
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
        cb.checked = !allSelected;
        if (!allSelected) { selectedFiles.add(filename); card.classList.add('selected'); }
        else { selectedFiles.delete(filename); card.classList.remove('selected'); }
    });
    updateDeleteButton();
});

// Event listeners
el.downloadBtn.addEventListener('click', downloadFiles);
el.refreshBtn.addEventListener('click', loadFiles);

// Initial load
loadFiles();
