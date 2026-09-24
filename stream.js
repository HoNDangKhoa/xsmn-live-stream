const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// 1. Hàm kiểm tra trạng thái xổ từ API Vercel
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

  console.log('1. Khởi chạy trình duyệt và căn chỉnh bảng kết quả Full viền đỏ...');
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
  await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 1 });
  
  await page.goto('https://kqxs-phuocdanh-api.vercel.app/live', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });

  // Tối ưu CSS: Ẩn lề thừa, kéo giãn vừa khít 100% màn hình dọc 720x1280
  await page.evaluate(() => {
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#ffffff';

    // Tìm khung viền đỏ chính để căn tràn 100% màn hình
    const container = document.querySelector('.container') || 
                      document.querySelector('main') || 
                      document.querySelector('#root > div') || 
                      document.body.firstElementChild;

    if (container) {
      container.style.width = '100vw';
      container.style.maxWidth = '100vw';
      container.style.margin = '0 auto';
      container.style.padding = '0';
      container.style.boxSizing = 'border-box';
    }

    const table = document.querySelector('table');
    if (table) {
      table.style.width = '100%';
      table.style.maxWidth = '100%';
      table.style.margin = '0';
    }

    window.scrollTo(0, 0);
  });

  await new Promise((r) => setTimeout(r, 2000));
  console.log('2. Bảng đã căn chỉnh xong, bắt đầu đẩy luồng trực tiếp...');

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
  const MIN_STREAM_MS = 15 * 60 * 1000; // An toàn: Ít nhất phải chạy đủ 15 phút (đến 16:27) mới được phép xét tắt live
  let finalizedCaption = '';

  // Lấy ngày hôm nay theo giờ Việt Nam dạng YYYY-MM-DD
  const todayIso = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
                     .toISOString().slice(0, 10);

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

    // Kiểm tra tính hợp lệ: Phải có completed: true VÀ ngày trả về phải đúng là ngày hôm nay
    const apiDate = res?.dateIso || res?.date || '';
    const isToday = apiDate.includes(todayIso);

    if (res && res.completed && isToday && elapsed >= MIN_STREAM_MS) {
      console.log('Đã có kết quả giải Đặc Biệt hôm nay! Đóng live và cập nhật bài VOD...');
      clearInterval(pollInterval);
      finalizedCaption = res.captionAfterLive;

      await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
      ffmpeg.kill('SIGINT');
      await browser.close();
      process.exit(0);
    }
  }, 15000);

  // Tự ngắt an toàn sau 33 phút (16:45) nếu mạng gặp sự cố
  setTimeout(async () => {
    console.log('Đã đạt giới hạn 33 phút, tự động đóng Live...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 33 * 60 * 1000);
})();
