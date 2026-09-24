const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https');

// Hàm kiểm tra API Vercel xem đã xổ xong chưa
function checkCompleted() {
  return new Promise((resolve) => {
    https.get('https://kqxs-phuocdanh-api.vercel.app/api/kqxs/today', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ completed: false });
        }
      });
    }).on('error', () => resolve({ completed: false }));
  });
}

// Hàm cập nhật mô tả VOD và ngắt Live trên Facebook
function finalizeLiveVideo(liveId, pageToken, caption) {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      end_live_video: 'true',
      description: caption || 'Đại lý vé số Phước Danh · 0919.494.566 · vesophuocdanh.vn',
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
    }, (res) => {
      resolve();
    });

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

  console.log('Đang khởi chạy trình duyệt ảo...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,720',
      '--disable-infobars'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto('https://kqxs-phuocdanh-api.vercel.app/live', { waitUntil: 'networkidle2' });

  console.log('Mở /live thành công, bắt đầu pipe sang FFmpeg...');

  // Pipe display :99 sang FFmpeg
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'x11grab',
    '-video_size', '1280x720',
    '-framerate', '30',
    '-i', ':99.0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
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

  // Vòng lặp kiểm tra: Cứ mỗi 15 giây hỏi API một lần
  const pollInterval = setInterval(async () => {
    const res = await checkCompleted();
    if (res && res.completed) {
      console.log('\nĐã có kết quả giải Đặc Biệt (completed: true)! Đang đóng Live và cập nhật bài VOD...');
      clearInterval(pollInterval);
      
      // Đóng live và cập nhật mô tả bài viết
      await finalizeLiveVideo(liveId, pageToken, res.captionAfterLive);
      
      ffmpeg.kill('SIGINT');
      await browser.close();
      process.exit(0);
    }
  }, 15000);

  // Giới hạn an toàn tối đa: 35 phút tự tắt nếu có trục trặc mạng
  setTimeout(async () => {
    console.log('\nĐạt giới hạn thời gian tối đa, kết thúc phiên live...');
    clearInterval(pollInterval);
    await finalizeLiveVideo(liveId, pageToken, 'Đại lý vé số Phước Danh · 0919.494.566 · vesophuocdanh.vn');
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 35 * 60 * 1000);
})();
