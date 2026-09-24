const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// Hàm kiểm tra trạng thái xổ từ API Vercel
function checkKqxsStatus() {
  return new Promise((resolve) => {
    https.get('https://kqxs-phuocdanh-api.vercel.app/api/kqxs/today', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ completed: false });
        }
      });
    }).on('error', () => resolve({ completed: false }));
  });
}

// Hàm kết thúc Live và cập nhật caption cho VOD trên Fanpage
function finalizeLiveVideo(liveId, pageToken, caption) {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      end_live_video: 'true',
      description: caption || '🎰 [CHÍNH THỨC] KẾT QUẢ XỔ SỐ MIỀN NAM\n⭐ Đại lý vé số PHƯỚC DANH\n☎ Hotline: 091.949.4566\n🌐 https://vesophuocdanh.vn',
      access_token: pageToken
    }).toString();

    const req = https.request({
      hostname: 'graph.facebook.com',
      port: 443,
      path: `/v19.0/${liveId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => resolve());

    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

(async () => {
  const rtmpUrl = process.env.RTMP_URL;
  const liveId = process.env.LIVE_ID;
  const pageToken = process.env.PAGE_TOKEN;

  if (!rtmpUrl) {
    console.error('Không tìm thấy RTMP_URL');
    process.exit(1);
  }

  console.log('1. Đang mở trình duyệt ảo hiển thị bảng /live...');
  const browser = await puppeteer.launch({
    headless: false, // Bắt buộc false trên màn hình ảo Xvfb để hiển thị UI thực tế
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,720',
      '--window-position=0,0',
      '--start-fullscreen'
    ],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99'
    }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  
  // Mở trang kết quả và đợi tải hoàn tất
  await page.goto('https://kqxs-phuocdanh-api.vercel.app/live', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });

  // Chờ 3 giây để giao diện bảng vẽ xong hoàn toàn
  await new Promise((r) => setTimeout(r, 3000));
  console.log('2. Bảng kết quả đã sẵn sàng, bắt đầu truyền hình ảnh sang Facebook Live...');

  // Bắt đầu đẩy luồng hình ảnh bằng FFmpeg
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'x11grab',
    '-video_size', '1280x720',
    '-framerate', '30',
    '-draw_mouse', '0',
    '-i', ':99.0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpUrl
  ]);

  ffmpeg.stderr.on('data', (data) => {
    // Theo dõi tiến độ stream
  });

  // Chờ tối thiểu 3 phút khi test để bạn xem được hình ảnh trực tiếp trên Facebook
  const startTime = Date.now();
  const MIN_STREAM_MS = 3 * 60 * 1000; // Tối thiểu 3 phút
  let finalizedCaption = '';

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

    // Chỉ kết thúc khi ĐÃ XỔ XONG VÀ ĐÃ STREAM TỐI THIỂU 3 PHÚT (để không bị tắt tức thì khi test ngoài giờ)
    if (res && res.completed && elapsed >= MIN_STREAM_MS) {
      console.log('Đã hoàn tất xổ số hôm nay và hết thời lượng quay tối thiểu. Đang kết thúc phiên live...');
      clearInterval(pollInterval);
      finalizedCaption = res.captionAfterLive;

      await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
      ffmpeg.kill('SIGINT');
      await browser.close();
      process.exit(0);
    }
  }, 15000);

  // Giới hạn tự ngắt sau 33 phút (sau 16:45) nếu có sự cố
  setTimeout(async () => {
    console.log('Đã đạt giới hạn tối đa 33 phút, tự động kết thúc Live...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 33 * 60 * 1000);
})();
