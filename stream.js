const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// 1. Kiểm tra trạng thái xổ số từ API Vercel
function checkKqxsStatus() {
  return new Promise((resolve) => {
    https.get('https://kqxs-phuocdanh-api.vercel.app/api/kqxs/today-mt', (res) => {
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
      description: caption || '🎰 [CHÍNH THỨC] KẾT QUẢ XỔ SỐ MIỀN TRUNG\n⭐ Đại lý vé số PHƯỚC DANH\n☎ Hotline: 091.949.4566\n🌐 https://vesophuocdanh.vn',
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

  console.log('1. Đang mở trình duyệt ảo và căn chỉnh Safe Zone...');
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
  
  await page.goto('https://kqxs-phuocdanh-api.vercel.app/live-mt', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });

  // Tối ưu vùng hiển thị Safe Zone chống che giải Đặc Biệt
  await page.evaluate(() => {
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.backgroundColor = '#18191a';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#18191a';

    const container = document.querySelector('.container') || 
                      document.querySelector('main') || 
                      document.querySelector('#root > div') || 
                      document.body.firstElementChild;

    if (container) {
      container.style.width = '700px';
      container.style.maxWidth = '700px';
      container.style.margin = '10px auto 0 auto';
      container.style.backgroundColor = '#ffffff';
      container.style.borderRadius = '8px';
      container.style.boxSizing = 'border-box';
      container.style.transformOrigin = 'top center';
      
      const rect = container.getBoundingClientRect();
      const availableHeight = 1020; 
      if (rect.height > availableHeight) {
        const scaleRatio = availableHeight / rect.height;
        container.style.transform = `scale(${scaleRatio})`;
      } else {
        container.style.transform = 'scale(0.96)';
      }
    }

    const table = document.querySelector('table');
    if (table) {
      table.style.width = '100%';
      table.style.maxWidth = '100%';
      table.style.margin = '0 auto';
    }

    window.scrollTo(0, 0);

    // Banner đếm ngược chờ trước 17:15
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
          ⏳ BUỔI XỔ SỐ MIỀN TRUNG SẮP BẮT ĐẦU
        </div>
        <div style="font-size: 19px; line-height: 1.4;">
          Hội đồng đang chuẩn bị quay số lúc <b>17:15</b>.<br>
          Quý khách vui lòng chờ trong giây lát!
        </div>
      </div>
    `;
    document.body.appendChild(waitingOverlay);

    const checkTimer = setInterval(() => {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= 17 * 60 + 15) {
        const overlay = document.getElementById('waiting-overlay');
        if (overlay) overlay.style.display = 'none';
        clearInterval(checkTimer);
      }
    }, 1000);
  });

  await new Promise((r) => setTimeout(r, 2000));
  console.log('2. Bắt đầu đẩy luồng trực tiếp chống nghẽn bộ đệm...');

  // Khởi chạy FFmpeg chuẩn định dạng RTMPS Facebook Live (Chống rớt mạng, chống đứng hình)
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'x11grab',
    '-video_size', '720x1280',
    '-framerate', '15',
    '-draw_mouse', '0',
    '-i', ':99.0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '1500k',
    '-maxrate', '1800k',
    '-bufsize', '3600k',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-keyint_min', '30',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    rtmpUrl
  ]);

  // Xả sạch log của FFmpeg để ngăn tràn bộ đệm bộ nhớ của tiến trình Node.js
  ffmpeg.stderr.on('data', (chunk) => {
    // Chỉ ghi nhận log khi cần thiết, giải phóng bộ nhớ đệm
  });

  ffmpeg.on('close', (code) => {
    console.log(`Tiến trình FFmpeg đã kết thúc với mã: ${code}`);
  });

  const startTime = Date.now();
  const MIN_STREAM_MS = 18 * 60 * 1000;
  let finalizedCaption = '';

  const todayIso = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
                     .toISOString().slice(0, 10);

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

    const apiDate = res?.dateIso || res?.date || '';
    const isToday = apiDate.includes(todayIso);

    if (res && res.completed && isToday && elapsed >= MIN_STREAM_MS) {
      console.log('Đã có giải Đặc Biệt hôm nay! Đóng live và cập nhật bài VOD...');
      clearInterval(pollInterval);
      finalizedCaption = res.captionAfterLive;

      await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
      ffmpeg.kill('SIGINT');
      await browser.close();
      process.exit(0);
    }
  }, 15000);

  // Tự ngắt tối đa sau 35 phút (17:45)
  setTimeout(async () => {
    console.log('Hết thời gian tối đa, tự động đóng phiên live...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, finalizedCaption);
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 35 * 60 * 1000);
})();
