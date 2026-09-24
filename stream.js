const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

(async () => {
  const rtmpUrl = process.env.RTMP_URL;
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

  // Lấy display ảo từ xvfb đẩy sang ffmpeg
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

  ffmpeg.stderr.on('data', (data) => {
    // In log stream ngắn gọn
    if (data.toString().includes('frame=')) {
      process.stdout.write('.');
    }
  });

  // Tự động dừng sau 32 phút (từ 16:13 đến 16:45)
  setTimeout(async () => {
    console.log('\nHết giờ xổ, kết thúc stream...');
    ffmpeg.kill('SIGINT');
    await browser.close();
    process.exit(0);
  }, 32 * 60 * 1000);
})();
