// Phát bảng /live?stream=1 lên Facebook Live: Chrome (Xvfb 720x1280) + ffmpeg trộn nhạc nền.
// Miền Trung dùng lại file này: LIVE_PATH=/live-mt, API_PATH=/api/kqxs-mt/today.
//
// Chống sập:
// - ffmpeg rớt / treo mạng -> tự nối lại (không giới hạn số lần trong thời gian Live).
// - Chrome crash / treo / tốn bộ nhớ -> tự mở lại bảng, luồng video không ngắt.
// - Mọi lỗi lạ chỉ ghi log, không làm chết tiến trình; luôn đóng Live gọn gàng khi kết thúc.
const puppeteer = require('puppeteer');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'https://kqxs-phuocdanh-api.vercel.app';
const LIVE_PATH = process.env.LIVE_PATH || '/live';
const API_PATH = process.env.API_PATH || '/api/kqxs/today';
const RTMP_URL = process.env.RTMP_URL;
const LIVE_ID = process.env.LIVE_ID;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const MUSIC_FILE = process.env.MUSIC_FILE || '';
const DISPLAY = process.env.DISPLAY || ':99';
const GRAPH = new URL(process.env.GRAPH || 'https://graph.facebook.com/v23.0');

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
const MIN_STREAM_MS = 18 * 60 * 1000;
const HOLD_AFTER_DONE_MS = 3 * 60 * 1000;
const MAX_STREAM_MS = 55 * 60 * 1000;
const POLL_MS = 15 * 1000;
const WATCHDOG_MS = 10 * 1000;
const FFMPEG_STALL_MS = 30 * 1000;
const FFMPEG_FAST_FAIL_MS = 15 * 1000;
const FFMPEG_MAX_FAST_FAILS = 8;
const PAGE_HEAP_LIMIT_MB = 300;
const PAGE_MAX_FAILS = 2;
const BOOT_TRIES = 5;
const FRAMES_DIR = 'frames';
const BOARD_SELECTOR = '.live-shell.is-stream .live-table tbody tr';

const DEFAULT_CAPTION =
  '🎰 [CHÍNH THỨC] KẾT QUẢ XỔ SỐ\n⭐ Đại lý vé số PHƯỚC DANH\n☎ Hotline: 091.949.4566\n🌐 https://vesophuocdanh.vn';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e && e.message) || String(e);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} quá ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

process.on('unhandledRejection', (e) => log('Lỗi chưa bắt (bỏ qua):', errMsg(e)));
process.on('uncaughtException', (e) => log('Lỗi chưa bắt (bỏ qua):', errMsg(e)));

function todayVN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 2_000_000) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
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
        hostname: GRAPH.hostname,
        path: `${GRAPH.pathname.replace(/\/$/, '')}/${LIVE_ID}`,
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
        res.on('error', resolve);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

// Chụp đúng màn hình ffmpeg đang phát để kiểm tra sau (tải ở mục Artifacts)
function grabFrame(name) {
  try {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    spawnSync(
      'ffmpeg',
      [
        '-loglevel', 'error', '-y',
        '-f', 'x11grab', '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0+0,0`,
        '-frames:v', '1', `${FRAMES_DIR}/${name}.png`,
      ],
      { timeout: 10000, stdio: 'ignore' }
    );
  } catch (e) {
    log('Không chụp được khung hình:', errMsg(e));
  }
}

function hasMusic() {
  try {
    return !!MUSIC_FILE && fs.statSync(MUSIC_FILE).size > 100_000;
  } catch {
    return false;
  }
}

function ffmpegArgs(withMusic) {
  const audioIn = withMusic
    ? ['-thread_queue_size', '1024', '-re', '-stream_loop', '-1', '-i', MUSIC_FILE]
    : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-stats',
    '-thread_queue_size', '1024',
    '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(FPS),
    '-video_size', `${WIDTH}x${HEIGHT}`, '-i', `${DISPLAY}.0+0,0`,
    ...audioIn,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-af', 'aresample=async=1',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv', RTMP_URL,
  ];
}

(async () => {
  if (!RTMP_URL) {
    console.error('Thiếu RTMP_URL');
    process.exit(1);
  }

  const liveUrl = `${BASE_URL}${LIVE_PATH}?stream=1`;
  const withMusic = hasMusic();
  if (!withMusic) log(`CẢNH BÁO: không thấy file nhạc (${MUSIC_FILE || 'trống'}) — phát kèm âm thanh im lặng`);

  let browser = null;
  let page = null;
  let reopening = false;
  let finishing = false;
  let pageFails = 0;
  let pageHeapMb = 0;
  let pageRecoveries = 0;

  let ffmpeg = null;
  let ffmpegStartedAt = 0;
  let ffmpegFastFails = 0;
  let ffmpegRestarts = 0;
  let lastFrame = -1;
  let lastProgressAt = 0;
  let lastStats = '';
  const errTail = [];

  let caption = '';
  let doneAt = null;
  let polling = false;
  let pollTimer = null;
  let watchTimer = null;
  let statsTimer = null;
  let hardStopTimer = null;

  async function closeBrowser() {
    const b = browser;
    browser = null;
    page = null;
    if (!b) return;
    b.removeAllListeners('disconnected');
    try {
      await withTimeout(b.close(), 10000, 'Đóng Chrome');
    } catch {
      try {
        b.process()?.kill('SIGKILL');
      } catch {}
    }
  }

  async function launchBrowser() {
    const b = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      protocolTimeout: 30000,
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
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      env: { ...process.env, DISPLAY },
    });
    browser = b;
    b.on('disconnected', () => {
      if (browser !== b || finishing) return;
      log('Chrome bị tắt bất thường — mở lại');
      void recoverBoard(true);
    });
    const [p] = await b.pages();
    p.on('pageerror', (e) => log('Lỗi JS trên trang:', errMsg(e)));
    p.on('error', () => {
      if (page !== p || finishing) return;
      log('Tab Chrome bị crash — mở lại');
      void recoverBoard(true);
    });
    page = p;
  }

  async function openBoard() {
    await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(BOARD_SELECTOR, { timeout: 45000 });
    await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)), 15000, 'Tải font');
    await sleep(1500);
  }

  // Mở (lại) bảng; relaunch = tắt hẳn Chrome cũ và mở Chrome mới
  async function recoverBoard(relaunch, maxTries = Infinity) {
    if (reopening || finishing) return false;
    reopening = true;
    try {
      for (let i = 1; i <= maxTries && !finishing; i++) {
        try {
          if (relaunch || !browser || !browser.connected || !page || page.isClosed()) {
            await closeBrowser();
            await launchBrowser();
          }
          await openBoard();
          pageFails = 0;
          return true;
        } catch (e) {
          log(`Mở bảng lần ${i} lỗi: ${errMsg(e)}`);
          relaunch = true;
          await sleep(Math.min(5000 * i, 30000));
        }
      }
      return false;
    } finally {
      reopening = false;
    }
  }

  async function checkBoard() {
    if (reopening || finishing || !page) return;
    try {
      const ok = await withTimeout(
        page.evaluate((sel) => !!document.querySelector(sel), BOARD_SELECTOR),
        10000,
        'Kiểm tra trang'
      );
      if (!ok) throw new Error('không thấy bảng kết quả');
      const m = await withTimeout(page.metrics(), 10000, 'Đo bộ nhớ trang');
      pageHeapMb = Math.round((m.JSHeapUsedSize || 0) / 1048576);
      pageFails = 0;
      if (pageHeapMb > PAGE_HEAP_LIMIT_MB) {
        log(`Trang dùng ${pageHeapMb}MB bộ nhớ — tải lại trang cho nhẹ`);
        pageRecoveries += 1;
        void recoverBoard(false);
      }
    } catch (e) {
      pageFails += 1;
      log(`Trang không phản hồi (${pageFails}/${PAGE_MAX_FAILS}): ${errMsg(e)}`);
      if (pageFails >= PAGE_MAX_FAILS) {
        pageRecoveries += 1;
        void recoverBoard(true);
      }
    }
  }

  function startFfmpeg() {
    if (finishing) return;
    log(ffmpegRestarts ? `Nối lại luồng lên Facebook (lần ${ffmpegRestarts})` : 'Bắt đầu đẩy hình + nhạc lên Facebook');
    ffmpegStartedAt = Date.now();
    lastProgressAt = Date.now();
    lastFrame = -1;
    const proc = spawn('ffmpeg', ffmpegArgs(withMusic), { stdio: ['ignore', 'ignore', 'pipe'] });
    ffmpeg = proc;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/[\r\n]+/)) {
        const text = line.trim();
        if (!text) continue;
        const frame = /frame=\s*(\d+)/.exec(text);
        if (frame) {
          lastStats = text;
          const n = Number(frame[1]);
          if (n > lastFrame) {
            lastFrame = n;
            lastProgressAt = Date.now();
          }
        } else {
          errTail.push(text.slice(0, 300));
          if (errTail.length > 20) errTail.shift();
        }
      }
    });
    proc.on('error', (e) => log('Không chạy được ffmpeg:', errMsg(e)));
    proc.on('close', (code, signal) => {
      if (ffmpeg === proc) ffmpeg = null;
      if (finishing) return;
      const ranMs = Date.now() - ffmpegStartedAt;
      ffmpegFastFails = ranMs < FFMPEG_FAST_FAIL_MS ? ffmpegFastFails + 1 : 0;
      log(`ffmpeg dừng (mã ${code ?? signal}, chạy ${Math.round(ranMs / 1000)}s). Log cuối:\n  ${errTail.join('\n  ')}`);
      if (ffmpegFastFails >= FFMPEG_MAX_FAST_FAILS) {
        void finish(caption, 'không kết nối được Facebook nhiều lần liền (Live đã bị đóng hoặc khóa stream hết hạn)');
        return;
      }
      ffmpegRestarts += 1;
      setTimeout(startFfmpeg, Math.min(2000 * 2 ** ffmpegFastFails, 20000));
    });
  }

  function checkFfmpeg() {
    if (finishing || !ffmpeg) return;
    const idle = Date.now() - lastProgressAt;
    if (idle > FFMPEG_STALL_MS) {
      log(`ffmpeg đứng hình ${Math.round(idle / 1000)}s (mạng treo) — khởi động lại luồng`);
      lastProgressAt = Date.now();
      ffmpeg.kill('SIGKILL');
    }
  }

  async function finish(finalCaption, reason) {
    if (finishing) return;
    finishing = true;
    setTimeout(() => process.exit(0), 60000);
    log(`Kết thúc Live: ${reason}`);
    [pollTimer, watchTimer, statsTimer].forEach((t) => clearInterval(t));
    clearTimeout(hardStopTimer);
    grabFrame('02-luc-ket-thuc');
    const proc = ffmpeg;
    if (proc && proc.exitCode === null) {
      const closed = new Promise((r) => proc.once('close', r));
      proc.kill('SIGINT');
      await Promise.race([closed, sleep(8000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    await finalizeLiveVideo(finalCaption);
    await closeBrowser();
    process.exit(0);
  }

  process.on('SIGTERM', () => void finish(caption, 'nhận SIGTERM'));
  process.on('SIGINT', () => void finish(caption, 'nhận SIGINT'));

  log(`Mở ${liveUrl} trong khung ${WIDTH}x${HEIGHT}`);
  if (!(await recoverBoard(true, BOOT_TRIES))) {
    log(`Không mở được bảng sau ${BOOT_TRIES} lần — hủy Live`);
    await finalizeLiveVideo('');
    await closeBrowser();
    process.exit(1);
  }

  const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => [0, 0]);
  if (size[0] !== WIDTH || size[1] !== HEIGHT) {
    log(`CẢNH BÁO: vùng hiển thị ${size[0]}x${size[1]}, cần ${WIDTH}x${HEIGHT} — kiểm tra --kiosk`);
  }
  const fonts = await page
    .evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))
    .catch(() => []);
  if (!fonts.some((f) => /Be.?Vietnam.?Pro/i.test(f) && !/Fallback/i.test(f))) {
    log(`CẢNH BÁO: chưa tải được font Be Vietnam Pro (đã có: ${fonts.join(', ') || 'không'}) — chữ số có thể khác mẫu`);
  }
  grabFrame('01-truoc-khi-phat');

  startFfmpeg();
  const startTime = Date.now();
  const today = todayVN();

  watchTimer = setInterval(() => {
    checkFfmpeg();
    void checkBoard();
  }, WATCHDOG_MS);

  statsTimer = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const freeMb = Math.round(os.freemem() / 1048576);
    const speed = Number((/speed=\s*([\d.]+)x/.exec(lastStats) || [])[1] || 1);
    if (speed < 0.9) log(`CẢNH BÁO: ffmpeg chỉ chạy ${speed}x thời gian thực — máy quá tải, hình có thể giật`);
    log(
      `ffmpeg: ${lastStats || '—'} | nối lại ${ffmpegRestarts} | trang ${pageHeapMb}MB, mở lại ${pageRecoveries} | node ${rssMb}MB | RAM trống ${freeMb}MB`
    );
  }, 60000);

  hardStopTimer = setTimeout(() => void finish(caption, 'hết thời gian tối đa'), MAX_STREAM_MS + 60000);

  pollTimer = setInterval(async () => {
    if (polling || finishing) return;
    polling = true;
    try {
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
    } finally {
      polling = false;
    }
  }, POLL_MS);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
