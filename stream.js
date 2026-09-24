const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// 1. Hàm kiểm tra trạng thái hoàn thành từ API
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

// 2. Hàm đóng Live và cập nhật mô tả bài VOD trên Fanpage
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

  console.log('1. Đang mở trình duyệt ảo và cắt sát khung viền đỏ...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=720,1280',
      '--window-position=0,0',
      '--hide-scrollbars'
    ],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99'
    }
  });

  const page = await browser.newPage();
  // Khóa viewport 720x1280 chuẩn tỷ lệ màn hình video dọc Facebook Live
  await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 1 });
  
  await page.goto('https://kqxs-phuocdanh-api.vercel.app/live', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });

  // Tối ưu CSS: Ẩn phần thừa ngoài viền đỏ, căn bảng lấp đầy trọn vẹn khung hình
  await page.evaluate(() => {
    // Ẩn thanh cuộn và nền thừa hai bên
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#ffffff';

    // Tìm khối container chính của bảng kết quả
    const container = document.querySelector('.container') || 
                      document.querySelector('main') || 
                      document.querySelector('#root > div') || 
                      document.body.firstElementChild;

    if (container) {
      container.style.width = '720px';
      container.style.maxWidth = '720px';
      container.style.margin = '0 auto';
      container.style.padding = '0';
      container.style.boxSizing = 'border-box';
      // Cuộn lên góc trên cùng để đảm bảo bắt trọn từ header đến footer
      window.scrollTo(0, 0);
    }
  });

  await new Promise((r) => setTimeout(r, 2000));
  console.log('2. Đã khóa sát khung đỏ thành công. Bắt đầu đẩy luồng sang Facebook Live...');

  // FFmpeg thu chính xác khung 720x1280 không bị dính viền thừa
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'x11grab',
    '-video_size', '720x1280',
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

  const startTime = Date.now();
  const MIN_STREAM_MS = 3 * 60 * 1000; // Giữ tối thiểu 3 phút khi test
  let finalizedCaption = '';

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

    if (res && res.completed && elapsed >= MIN_STREAM_MS) {
      console.log('Xổ số hoàn tất và kết thúc phiên live...');
      clearInterval(pollInterval);
      finalizedCaption = res.captionAfterLive;

      await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
      ffmpeg.kill('SIGINT');
      await browser.close();
      process.exit(0);
    }
  }, 15000);

  setTimeout(async () => {
    console.log('Hết thời gian tối đa 33 phút...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 33 * 60 * 1000);
})();
