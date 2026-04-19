# ZenScan v1.0 - Performance Comparison

## Tốc độ scan (ước tính):

### Mode 1: Client-side (Browser Worker)
- **Tốc độ**: ~50-100k dòng/giây
- **Giới hạn**: File < 2GB (memory limit)
- **CPU**: 1 core (Web Worker)

### Mode 2: Server Stream (Single Thread)
- **Tốc độ**: ~200-300k dòng/giây
- **Giới hạn**: Không giới hạn
- **CPU**: 1 core (Node.js single thread)

### Mode 3: Server Fast (Worker Threads) ⚡
- **Tốc độ**: ~1-2 triệu dòng/giây
- **Giới hạn**: Không giới hạn
- **CPU**: Tất cả cores (parallel)

## Ví dụ thực tế:

File 100GB (~1 tỷ dòng):

| Mode | Thời gian | CPU Usage |
|------|-----------|-----------|
| Client-side | Không chạy được | - |
| Server Stream | ~55 phút | 1 core (12.5%) |
| Server Fast | ~8-10 phút | 8 cores (100%) |

## Tối ưu hóa đã áp dụng:

✅ **Worker Threads** - Parallel processing trên nhiều CPU cores
✅ **String indexOf** - Nhanh hơn includes() và regex
✅ **Batch processing** - Gửi kết quả theo batch, giảm overhead
✅ **Stream reading** - Không load toàn bộ file vào memory
✅ **Zero-copy** - Xử lý trực tiếp từ buffer
✅ **Smart chunking** - Chia file đều cho workers

## Cách sử dụng:

```bash
npm start
```

Truy cập: http://localhost:8080/index-stream.html

Server tự động dùng tất cả CPU cores có sẵn!
