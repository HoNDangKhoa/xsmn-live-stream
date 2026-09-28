// Phát bảng /live?stream=1 lên Facebook Live: Chrome (Xvfb 720x1280) + ffmpeg trộn nhạc nền.
// Miền Trung dùng lại file này: LIVE_PATH=/live-mt, API_PATH=/api/kqxs-mt/today.
const puppeteer = require('puppeteer');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'https://kqxs-phuocdanh-api.vercel.app';
const LIVE_PATH = process.env.LIVE_PATH || '/live';
const API_PATH = process.env.API_PATH || '/api/kqxs/today';
const RTMP_URL = process.env.RTMP_URL;
const LIVE_ID = process.env.LIVE_ID;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const MUSIC_FILE = process.env.MUSIC_FILE || `${BASE_URL}/audio/xo-so-live-bed.mp3`;
const DISPLAY = process.env.DISPLAY || ':99';

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
const MIN_STREAM_MS = 18 * 60 * 1000;
const HOLD_AFTER_DONE_MS = 3 * 60 * 1000;
const MAX_STREAM_MS = 45 * 60 * 1000;
const POLL_MS = 15 * 1000;
const MAX_FFMPEG_RESTARTS = 5;
const FRAMES_DIR = 'frames';

const DEFAULT_CAPTION =
  '🎰 [CHÍNH THỨC] KẾT QUẢ XỔ SỐ\n⭐ Đại lý vé số PHƯỚC DANH\n☎ Hotline: 091.949.4566\n🌐 https://vesophuocdanh.vn';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function todayVN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function finalizeLiveVideo(caption) {
  if (!LIVE_ID || !PAGE_TOKEN) return Promise.resolve();
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      end_live_video: 'true',
      description: caption || DEFAULT_CAPTION,
      access_token: PAGE_TOKEN,
    }).toString();
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/v19.0/${LIVE_ID}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        log(`Facebook đóng Live: HTTP ${res.statusCode}`);
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// Chụp đúng màn hình ffmpeg đang phát (kể cả thanh trình duyệt nếu lỡ hiện) để kiểm tra sau
function grabFrame(name) {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  spawnSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'x11grab', '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0+0,0`,
    '-frames:v', '1', `${FRAMES_DIR}/${name}.png`,
  ]);
}

function ffmpegArgs() {
  return [
    '-hide_banner', '-loglevel', 'warning', '-stats',
    '-thread_queue_size', '1024',
    '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(FPS),
    '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0+0,0`,
    '-thread_queue_size', '1024',
    '-re', '-stream_loop', '-1', '-i', MUSIC_FILE,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-af', 'aresample=async=1',
    '-f', 'flv', RTMP_URL,
  ];
}

(async () => {
  if (!RTMP_URL) {
    console.error('Thiếu RTMP_URL');
    process.exit(1);
  }

  const liveUrl = `${BASE_URL}${LIVE_PATH}?stream=1`;
  log(`Mở ${liveUrl} trong khung ${WIDTH}x${HEIGHT}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0',
      '--kiosk',
      '--hide-scrollbars',
      '--noerrdialogs',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--disable-features=Translate,TranslateUI',
      '--lang=vi-VN',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    env: { ...process.env, DISPLAY },
  });

  const [page] = await browser.pages();
  page.on('pageerror', (e) => log('Lỗi trang:', e.message));

  const openBoard = async () => {
    await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.live-shell.is-stream .live-table tbody tr', { timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 1500));
  };
  await openBoard();

  const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  if (size[0] !== WIDTH || size[1] !== HEIGHT) {
    log(`CẢNH BÁO: vùng hiển thị ${size[0]}x${size[1]}, cần ${WIDTH}x${HEIGHT} — kiểm tra --kiosk`);
  }
  grabFrame('01-truoc-khi-phat');

  let ffmpeg = null;
  let restarts = 0;
  let finishing = false;
  let lastStats = '';
  let pollTimer = null;
  let statsTimer = null;
  const errTail = [];

  const startFfmpeg = () => {
    log('Bắt đầu đẩy hình + nhạc lên Facebook');
    ffmpeg = spawn('ffmpeg', ffmpegArgs());
    ffmpeg.stderr.on('data', (buf) => {
      for (const line of buf.toString().split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        if (line.startsWith('frame=')) lastStats = line.trim();
        else {
          errTail.push(line.trim());
          if (errTail.length > 20) errTail.shift();
        }
      }
    });
    ffmpeg.on('close', (code) => {
      if (finishing) return;
      log(`ffmpeg dừng bất thường (mã ${code}). Log cuối:\n  ${errTail.join('\n  ')}`);
      if (restarts < MAX_FFMPEG_RESTARTS) {
        restarts += 1;
        log(`Nối lại luồng lần ${restarts}/${MAX_FFMPEG_RESTARTS} sau 3 giây`);
        setTimeout(startFfmpeg, 3000);
      } else {
        void finish(null, 'ffmpeg lỗi quá số lần nối lại');
      }
    });
  };
  startFfmpeg();

  statsTimer = setInterval(() => lastStats && log(`ffmpeg: ${lastStats}`), 60000);

  const startTime = Date.now();
  const today = todayVN();
  let doneAt = null;
  let caption = '';

  async function finish(finalCaption, reason) {
    if (finishing) return;
    finishing = true;
    log(`Kết thúc Live: ${reason}`);
    clearInterval(pollTimer);
    clearInterval(statsTimer);
    grabFrame('02-luc-ket-thuc');
    if (ffmpeg && ffmpeg.exitCode === null) {
      const closed = new Promise((r) => ffmpeg.once('close', r));
      ffmpeg.kill('SIGINT');
      await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))]);
    }
    await finalizeLiveVideo(finalCaption);
    await browser.close().catch(() => {});
    process.exit(0);
  }

  pollTimer = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    const res = await getJson(`${BASE_URL}${API_PATH}`);
    if (res && res.completed && res.dateIso === today) {
      if (!doneAt) {
        doneAt = Date.now();
        log('Đã đủ giải Đặc Biệt — giữ bảng thêm 3 phút cho người xem');
      }
      caption = res.captionAfterLive || caption;
    }
    if (doneAt && Date.now() - doneAt >= HOLD_AFTER_DONE_MS && elapsed >= MIN_STREAM_MS) {
      await finish(caption, 'đã có đủ kết quả hôm nay');
    } else if (elapsed >= MAX_STREAM_MS) {
      await finish(caption, 'hết thời gian tối đa');
    }
  }, POLL_MS);

  // Trang lỗi/treo thì mở lại, luồng video vẫn chạy liên tục
  page.on('error', () => openBoard().catch((e) => log('Mở lại trang lỗi:', e.message)));

  process.on('SIGTERM', () => void finish(caption, 'nhận SIGTERM'));
  process.on('SIGINT', () => void finish(caption, 'nhận SIGINT'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
