const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// 1. Kiểm tra trạng thái xổ số từ API Vercel
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

// 2. Đóng live và cập nhật mô tả bài VOD
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

  console.log('1. Đang mở trình duyệt ảo tối ưu tài nguyên...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=720,1280',
      '--window-position=0,0',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
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

  // Tối ưu căn chỉnh tràn màn hình và hiển thị bảng chờ trước 16:15
  await page.evaluate(() => {
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#ffffff';

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

    // Banner đếm ngược chờ đến 16:15
    const waitingOverlay = document.createElement('div');
    waitingOverlay.id = 'waiting-overlay';
    waitingOverlay.innerHTML = `
      <div style="
        position: fixed;
        bottom: 40px;
        left: 50%;
        transform: translateX(-50%);
        background: linear-gradient(135deg, #d32f2f, #b71c1c);
        color: #fff;
        padding: 20px 30px;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        text-align: center;
        width: 88%;
        z-index: 999999;
        font-family: Arial, sans-serif;
        border: 2px solid #ffeb3b;
      ">
        <div style="font-size: 24px; font-weight: bold; margin-bottom: 8px; color: #ffeb3b;">
          ⏳ BUỔI XỔ SỐ SẮP DIỄN RA
        </div>
        <div style="font-size: 19px; line-height: 1.4;">
          Hội đồng đang chuẩn bị quay số lúc <b>16:15</b>.<br>
          Quý khách vui lòng chờ trong giây lát!
        </div>
      </div>
    `;
    document.body.appendChild(waitingOverlay);

    // Đúng 16:15 tự ẩn bảng chờ
    const checkTimer = setInterval(() => {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= 16 * 60 + 15) {
        const overlay = document.getElementById('waiting-overlay');
        if (overlay) overlay.style.display = 'none';
        clearInterval(checkTimer);
      }
    }, 1000);
  });

  await new Promise((r) => setTimeout(r, 2000));
  console.log('2. Bắt đầu đẩy luồng trực tiếp (Zero-Buffer Low Latency)...');

  // Cấu hình FFmpeg loại bỏ hoàn toàn bộ nhớ đệm, tối ưu tốc độ phản hồi
  const ffmpeg = spawn('ffmpeg', [
    '-fflags', 'nobuffer',              // Không đệm luồng đầu vào
    '-f', 'x11grab',
    '-video_size', '720x1280',
    '-framerate', '15',                 // 15 FPS: Nhẹ máy, triệt tiêu lag CPU
    '-draw_mouse', '0',
    '-i', ':99.0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',             // Tốc độ mã hóa nhanh nhất
    '-tune', 'zerolatency',             // Triệt tiêu trễ x264
    '-b:v', '1500k',
    '-maxrate', '1500k',
    '-bufsize', '1500k',                // Bộ đệm tối thiểu
    '-pix_fmt', 'yuv420p',
    '-g', '15',                         // 1 giây / 1 keyframe: Facebook phát tức thì
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '44100',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    rtmpUrl
  ]);

  const startTime = Date.now();
  const MIN_STREAM_MS = 18 * 60 * 1000; // Tối thiểu 18 phút (đến 16:28) mới duyệt điều kiện tắt
  let finalizedCaption = '';

  const todayIso = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
                     .toISOString().slice(0, 10);

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

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

  // Tự ngắt tối đa sau 35 phút (16:45)
  setTimeout(async () => {
    console.log('Đạt giới hạn tối đa, tự động đóng Live...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 35 * 60 * 1000);
})();
