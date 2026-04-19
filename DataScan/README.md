# ZenScan v1.0

Premium Data Scanner & Download Manager

## Features

- **Data Scanner**: Quét và lọc dữ liệu theo keywords với tốc độ cao
- **Download Manager**: Tải file từ URL và quản lý downloads
- **Multi-keyword Support**: Hỗ trợ nhiều keywords, tách kết quả theo từng keyword
- **Real-time Analytics**: Thống kê domain, tốc độ quét real-time
- **Deduplication**: Loại bỏ dữ liệu trùng lặp
- **Export**: Tải xuống kết quả dạng ZIP hoặc copy clipboard

## Installation

```bash
npm install
```

## Usage

1. Start server:
```bash
npm start
```

2. Open browser:
- Scanner: http://localhost:8080
- Download Manager: http://localhost:8080/download.html

## How to use

### Download Manager
1. Nhập URL file .txt cần tải
2. Click "TẢI XUỐNG"
3. File sẽ được lưu vào folder `downloads/`

### Scanner
1. Upload file hoặc chọn từ Downloads
2. Nhập keywords (mỗi dòng 1 keyword)
3. Click "BẮT ĐẦU SCAN"
4. Xem kết quả và tải xuống

## Tech Stack

- Frontend: Vanilla JS, Web Workers
- Backend: Node.js, Express
- Storage: Local filesystem
