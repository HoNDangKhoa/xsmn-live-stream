const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

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

  console.log('1. Đang mở trình duyệt ảo chuẩn dọc 720x1280...');
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

  // Tối ưu CSS để bảng lọt trọn vẹn và bung full chiều cao/chiều rộng màn hình
  await page.addStyleTag({
    content: `
      body, html {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background-color: #ffffff !important;
        display: flex !important;
        justify-content: center !important;
      }
      /* Căn giữa bảng và vừa khít chiều cao màn hình dọc 1280px */
      body > div, table, .container, main {
        max-width: 100% !important;
        width: 100% !important;
        margin: 0 auto !important;
      }
    `
  });

  await new Promise((r) => setTimeout(r, 2000));
  console.log('2. Bảng đã căn chỉnh Full màn hình, bắt đầu stream sang Facebook Live...');

  // FFmpeg quay đúng kích thước dọc 720x1280
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
  const MIN_STREAM_MS = 3 * 60 * 1000;
  let finalizedCaption = '';

  const pollInterval = setInterval(async () => {
    const res = await checkKqxsStatus();
    const elapsed = Date.now() - startTime;

    if (res && res.completed && elapsed >= MIN_STREAM_MS) {
      console.log('Đã có giải ĐB và hết thời lượng test tối thiểu, dừng live...');
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
