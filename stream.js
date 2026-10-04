// Phát bảng /live?stream=1 lên Facebook Live: Chrome (Xvfb 720x1280) + ffmpeg trộn nhạc nền.
// Miền Trung dùng lại file này: LIVE_PATH=/live-mt, API_PATH=/api/kqxs-mt/today.
//
// Chống sập:
// - ffmpeg rớt / treo mạng -> tự nối lại (không giới hạn số lần trong thời gian Live).
// - Chrome crash / treo / tốn bộ nhớ -> tự mở lại bảng, luồng video không ngắt.
// - Mọi lỗi lạ chỉ ghi log, không làm chết tiến trình; luôn đóng Live gọn gàng khi kết thúc.
//
// Kết thúc khi đủ kết quả: đăng bài ảnh 1080x1920 trước, Facebook nhận bài rồi mới tắt Live
// và xóa video. Sai ngày, lệch số hoặc bảng vượt khung thì tải lại, tối đa 2 phút.
// Hết 2 phút vẫn sai thì không đăng, giữ video. Vòng quay ở ô không có số không hủy ảnh.
// Mực chữ còn trong viền ô thì vẫn đăng.
// DRY_RUN_PHOTO=YYYY-MM-DD: chỉ chụp + kiểm tra ảnh ngày đó (không Live, không đăng công khai).
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
const PAGE_ID = process.env.PAGE_ID;
const POST_PHOTO = process.env.POST_PHOTO !== '0';
const DELETE_VOD = process.env.DELETE_VOD === '1';
const DRY_RUN_PHOTO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.DRY_RUN_PHOTO || '') ? process.env.DRY_RUN_PHOTO : '';
const MUSIC_FILE = process.env.MUSIC_FILE || '';
const DISPLAY = process.env.DISPLAY || ':99';
const GRAPH = new URL(process.env.GRAPH || 'https://graph.facebook.com/v23.0');

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
// Bitrate cố định (CBR): luồng nhẹ, đều để app Facebook trên điện thoại (chế độ độ trễ thấp) không bị đứng hình
const VBITRATE = /^\d+k$/.test(process.env.VIDEO_BITRATE || '') ? process.env.VIDEO_BITRATE : '2000k';
// VIDEO_CBR=0: quay về kiểu cũ (bitrate dao động, đệm gấp đôi), phòng khi CBR chặt gây lỗi
const STRICT_CBR = process.env.VIDEO_CBR !== '0';
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

// Ảnh bài đăng: khung Live 720x1280 phóng 1.5 = 1080x1920; photo=1 bỏ vùng chừa nút Facebook, G.8/ĐB to hơn
const PHOTO_W = 720;
const PHOTO_H = 1280;
const PHOTO_SCALE = 1.5;
const PHOTO_QUERY = 'photo=1';
const PHOTO_WAIT_MS = 2 * 60 * 1000;
// Đúng thứ tự dòng của bảng /live
const ROW_KEYS = ['g8', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'gdb'];

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

// Gọi Graph API. POST gửi form (hoặc multipart khi có file); GET/DELETE gửi tham số trên URL.
// Luôn resolve { status, json } — lỗi mạng trả status 0.
function graphCall(method, path, fields = {}, file = null) {
  return new Promise((resolve) => {
    const url = new URL(`${GRAPH.pathname.replace(/\/$/, '')}/${path}`, GRAPH.origin);
    let body = null;
    const headers = {};
    if (method !== 'POST') {
      for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
    } else if (file) {
      const boundary = `----phuocdanh${Date.now().toString(16)}`;
      const parts = Object.entries(fields).map(([k, v]) =>
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      );
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${file.name}"\r\nContent-Type: image/png\r\n\r\n`
        ),
        file.data,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      );
      body = Buffer.concat(parts);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else {
      body = Buffer.from(new URLSearchParams(fields).toString());
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (body) headers['Content-Length'] = body.length;
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers, timeout: 60000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
        res.on('error', () => resolve({ status: 0, json: null }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('quá 60s')));
    req.on('error', (e) => resolve({ status: 0, json: { error: { message: errMsg(e) } } }));
    req.end(body || undefined);
  });
}

const graphError = (r) => `HTTP ${r.status} ${JSON.stringify((r.json && r.json.error) || r.json).slice(0, 300)}`;

async function finalizeLiveVideo(caption) {
  if (!LIVE_ID || !PAGE_TOKEN) return;
  const r = await graphCall('POST', LIVE_ID, {
    end_live_video: 'true',
    description: caption || DEFAULT_CAPTION,
    access_token: PAGE_TOKEN,
  });
  log(`Facebook đóng Live: HTTP ${r.status}`);
}

// Chạy trong trang: liệt kê mọi lỗi khiến ảnh chưa đạt chuẩn để đăng (mảng rỗng = đạt)
function checkBoardForPhoto(expected, ddmm) {
  const out = [];
  const shownDate = (document.querySelector('.live-date strong')?.textContent || '').trim();
  if (shownDate !== ddmm) out.push(`ngày trên bảng "${shownDate}" khác ${ddmm}`);
  const heads = document.querySelectorAll('.live-table thead th').length - 1;
  if (heads !== expected.length) out.push(`bảng có ${heads} đài, API có ${expected.length}`);
  const rows = [...document.querySelectorAll('.live-table tbody tr')];
  const digits = (s) => String(s || '').replace(/\D/g, '');
  expected.forEach((stationRows, si) => {
    stationRows.forEach((want, ri) => {
      const td = rows[ri] && rows[ri].children[si + 1];
      const got = td
        ? [...td.querySelectorAll('.live-num')].map((n) => digits(n.textContent)).filter(Boolean)
        : [];
      const exp = want.map(digits).filter(Boolean);
      if (!exp.length) out.push(`đài ${si + 1} dòng ${ri + 1}: API chưa có số`);
      else if (got.join(',') !== exp.join(',')) {
        out.push(`đài ${si + 1} dòng ${ri + 1}: bảng ${got.join(',') || 'trống'} ≠ API ${exp.join(',')}`);
      }
    });
    if (digits(stationRows[stationRows.length - 1][0]).length !== 6) out.push(`ĐB đài ${si + 1} chưa đủ 6 số`);
  });
  // Mực còn trong viền ô thì đạt. Chỉ hủy khi mực vượt viền ô hoặc bảng vượt khung ảnh.
  const clippedText = [
    ...document.querySelectorAll('.live-table th, .live-table td.col-giai, .live-bar *'),
  ].filter((c) => c.scrollWidth > c.offsetWidth + 1).length;
  const clippedNums = [...document.querySelectorAll('.live-table tbody td:not(.col-giai)')].filter((c) => {
    const r = c.getBoundingClientRect();
    return [...c.querySelectorAll('.live-num')].some((n) =>
      [n, ...n.children].some((e) => {
        const nr = e.getBoundingClientRect();
        return nr.width > 0 && (nr.left < r.left - 0.5 || nr.right > r.right + 0.5);
      })
    );
  }).length;
  const clipped = clippedText + clippedNums;
  if (clipped) out.push(`${clipped} ô mực vượt viền`);
  const t = document.querySelector('.live-table').getBoundingClientRect();
  if (t.left < 0 || t.right > innerWidth + 0.5 || t.bottom > innerHeight + 0.5) out.push('bảng vượt khung ảnh');
  const fontOk = [...document.fonts].some(
    (f) => f.status === 'loaded' && /Be.?Vietnam.?Pro/i.test(f.family) && !/Fallback/i.test(f.family)
  );
  if (!fontOk) out.push('chưa tải được font Be Vietnam Pro');
  return out;
}

// Chụp bảng ngày `date` (YYYY-MM-DD) bằng tab mới của trình duyệt `b`; chỉ trả ok khi ảnh đạt mọi kiểm tra
async function captureResultPhoto(b, date) {
  const api = await getJson(`${BASE_URL}${API_PATH}?date=${date}`);
  if (!api || api.dateIso !== date) return { ok: false, reason: `API không trả kết quả ngày ${date}` };
  if (!api.completed || !Array.isArray(api.stations) || !api.stations.length) {
    return { ok: false, reason: `API chưa đủ kết quả ngày ${date}` };
  }
  const expected = api.stations.map((s) => ROW_KEYS.map((k) => [].concat(s[k] || []).map(String)));
  const ddmm = `${date.slice(8, 10)}/${date.slice(5, 7)}`;
  const p = await b.newPage();
  try {
    await p.setViewport({ width: PHOTO_W, height: PHOTO_H, deviceScaleFactor: PHOTO_SCALE });
    const photoUrl = `${BASE_URL}${LIVE_PATH}?stream=1&date=${date}&${PHOTO_QUERY}`;
    const started = Date.now();
    let problems = [`chưa chụp được bảng ngày ${date}`];
    let attempt = 0;
    while (Date.now() - started < PHOTO_WAIT_MS) {
      attempt += 1;
      await p.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForSelector(BOARD_SELECTOR, { timeout: 45000 });
      await withTimeout(p.evaluate(() => document.fonts.ready.then(() => true)), 15000, 'Tải font');
      // 6 chữ số × 350ms. Chờ số hiện hết rồi mới so với API.
      await sleep(4000);
      problems = await p.evaluate(checkBoardForPhoto, expected, ddmm);
      if (!problems.length) break;
      log(`Ảnh kết quả lần ${attempt} chưa đạt: ${problems.slice(0, 5).join('; ')}`);
    }
    if (problems.length) return { ok: false, reason: problems.slice(0, 5).join('; ') };
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    const file = `${FRAMES_DIR}/03-anh-dang-bai-${date}.png`;
    await p.screenshot({ path: file, type: 'png' });
    const data = fs.readFileSync(file);
    const w = data.readUInt32BE(16);
    const h = data.readUInt32BE(20);
    if (w !== PHOTO_W * PHOTO_SCALE || h !== PHOTO_H * PHOTO_SCALE) {
      return { ok: false, reason: `ảnh ${w}x${h}, cần ${PHOTO_W * PHOTO_SCALE}x${PHOTO_H * PHOTO_SCALE}` };
    }
    log(`Ảnh kết quả đạt chuẩn: ${file} (${w}x${h}, ${Math.round(data.length / 1024)}KB)`);
    return { ok: true, file, data, caption: api.caption || DEFAULT_CAPTION };
  } finally {
    await p.close().catch(() => {});
  }
}

async function postResultPhoto(shot, published) {
  const r = await graphCall(
    'POST',
    `${PAGE_ID}/photos`,
    { message: shot.caption, published: String(published), access_token: PAGE_TOKEN },
    { name: 'ket-qua-xo-so.png', data: shot.data }
  );
  const id = r.json && (r.json.post_id || r.json.id);
  return id ? { ok: true, id, photoId: r.json.id } : { ok: false, reason: graphError(r) };
}

// Xóa bài video của Live (video VOD); thử lại vì Facebook còn xử lý video ngay sau khi tắt Live
async function deleteLiveVideo() {
  for (let i = 1; i <= 3; i++) {
    const info = await graphCall('GET', LIVE_ID, { fields: 'video', access_token: PAGE_TOKEN });
    const target = (info.json && info.json.video && info.json.video.id) || LIVE_ID;
    const r = await graphCall('DELETE', target, { access_token: PAGE_TOKEN });
    if (r.json && r.json.success === true) return { ok: true, target };
    log(`Xóa video Live lần ${i} lỗi: ${graphError(r)}`);
    if (i < 3) await sleep(15000);
  }
  return { ok: false };
}

function photoBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--lang=vi-VN'],
  });
}

// Chạy thử: chụp + kiểm tra ảnh ngày cũ; có token thì đăng ẩn (không công khai) rồi xóa ngay để thử quyền
async function dryRunPhoto() {
  log(`CHẠY THỬ ảnh kết quả ngày ${DRY_RUN_PHOTO} — không tạo Live, không đăng công khai`);
  const b = await photoBrowser();
  try {
    const shot = await captureResultPhoto(b, DRY_RUN_PHOTO);
    if (!shot.ok) {
      log(`Ảnh KHÔNG đạt: ${shot.reason}`);
      return 1;
    }
    if (!PAGE_ID || !PAGE_TOKEN) {
      log('Không có PAGE_ID/PAGE_TOKEN — chỉ lưu ảnh, bỏ qua thử quyền đăng');
      return 0;
    }
    const post = await postResultPhoto(shot, false);
    if (!post.ok) {
      log(`Token KHÔNG đăng được ảnh (cần quyền pages_manage_posts): ${post.reason}`);
      return 1;
    }
    const del = await graphCall('DELETE', post.photoId, { access_token: PAGE_TOKEN });
    log(`Token đăng ảnh được (đã đăng ẩn rồi xóa: ${del.json && del.json.success === true ? 'xóa xong' : graphError(del)})`);
    return 0;
  } finally {
    await b.close().catch(() => {});
  }
}

// Trạng thái Live trên Facebook: 'ended' (đã thành video / bị xóa), 'alive', hoặc 'unknown' (không hỏi được)
const ENDED_STATUSES = new Set(['VOD', 'PROCESSING', 'SCHEDULED_CANCELED', 'SCHEDULED_EXPIRED']);
async function liveStatus() {
  if (!LIVE_ID || !PAGE_TOKEN) return 'unknown';
  const url = new URL(`${GRAPH.pathname.replace(/\/$/, '')}/${LIVE_ID}`, GRAPH.origin);
  url.searchParams.set('fields', 'status');
  url.searchParams.set('access_token', PAGE_TOKEN);
  const res = await getJson(url.toString());
  if (res && res.status) return ENDED_STATUSES.has(res.status) ? 'ended' : 'alive';
  if (res && res.error && res.error.code === 100) return 'ended';
  return 'unknown';
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
    '-b:v', VBITRATE, '-maxrate', VBITRATE,
    ...(STRICT_CBR
      ? ['-bufsize', VBITRATE, '-x264-params', 'nal-hrd=cbr:force-cfr=1']
      : ['-bufsize', `${parseInt(VBITRATE, 10) * 2}k`]),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-af', 'aresample=async=1',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv', RTMP_URL,
  ];
}

(async () => {
  if (DRY_RUN_PHOTO) process.exit(await dryRunPhoto());
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
    log(ffmpegRestarts ? `Nối lại luồng lên Facebook (lần ${ffmpegRestarts})` : `Bắt đầu đẩy hình + nhạc lên Facebook (video ${VBITRATE}${STRICT_CBR ? ' CBR' : ''}, ${FPS}fps)`);
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
    proc.on('close', async (code, signal) => {
      if (ffmpeg === proc) ffmpeg = null;
      if (finishing) return;
      const ranMs = Date.now() - ffmpegStartedAt;
      ffmpegFastFails = ranMs < FFMPEG_FAST_FAIL_MS ? ffmpegFastFails + 1 : 0;
      log(`ffmpeg dừng (mã ${code ?? signal}, chạy ${Math.round(ranMs / 1000)}s). Log cuối:\n  ${errTail.join('\n  ')}`);
      errTail.length = 0;
      // Mạng đứt vài phút không được đóng Live: chỉ dừng khi Facebook xác nhận Live đã kết thúc,
      // còn lại cứ nối tiếp (hardStopTimer vẫn chặn ở thời gian tối đa).
      if (ffmpegFastFails >= FFMPEG_MAX_FAST_FAILS && ffmpegFastFails % FFMPEG_MAX_FAST_FAILS === 0) {
        const status = await liveStatus();
        if (finishing) return;
        log(`Nối lại thất bại ${ffmpegFastFails} lần liền — trạng thái Live trên Facebook: ${status}`);
        if (status === 'ended') {
          void finish(caption, 'Facebook đã kết thúc Live này, không nối lại được');
          return;
        }
      }
      ffmpegRestarts += 1;
      setTimeout(startFfmpeg, Math.min(2000 * 2 ** Math.min(ffmpegFastFails, 4), 20000));
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

  // Đăng bài ảnh trước khi tắt Live. true = Facebook đã nhận bài.
  async function publishResultPhoto() {
    if (!POST_PHOTO) return false;
    if (!PAGE_ID || !PAGE_TOKEN) {
      log('Không đăng ảnh kết quả: thiếu PAGE_ID hoặc PAGE_TOKEN — giữ video Live');
      return false;
    }
    let b = browser && browser.connected ? browser : null;
    const own = !b;
    try {
      if (own) b = await photoBrowser();
      for (let attempt = 1; attempt <= 3; attempt++) {
        const shot = await captureResultPhoto(b, today);
        if (!shot.ok) {
          log(`KHÔNG đăng ảnh (giữ video Live): ${shot.reason}`);
          return false;
        }
        const post = await postResultPhoto(shot, true);
        if (post.ok) {
          log(`Đã đăng bài ảnh kết quả: ${post.id}`);
          return true;
        }
        log(`Đăng ảnh lần ${attempt} lỗi: ${post.reason}`);
        if (attempt < 3) await sleep(5000);
      }
      log('Đăng ảnh lỗi (giữ video Live)');
      return false;
    } catch (e) {
      log(`Lỗi khi đăng ảnh kết quả (giữ video Live): ${errMsg(e)}`);
      return false;
    } finally {
      if (own && b) await b.close().catch(() => {});
    }
  }

  async function finish(finalCaption, reason, completed = false) {
    if (finishing) return;
    finishing = true;
    setTimeout(() => process.exit(0), 300000);
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
    const photoPosted = completed ? await publishResultPhoto() : false;
    await finalizeLiveVideo(finalCaption);
    if (photoPosted && DELETE_VOD && LIVE_ID) {
      const del = await deleteLiveVideo();
      log(del.ok ? `Đã xóa bài video Live (${del.target})` : 'KHÔNG xóa được bài video Live — cần xóa tay trên Fanpage');
    }
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
        await finish(caption, 'đã có đủ kết quả hôm nay', true);
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
