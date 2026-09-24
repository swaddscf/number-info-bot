require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const phonenumbers = require('google-libphonenumber');
const tzLookup = require('tz-lookup');

const util = phonenumbers.PhoneNumberUtil.getInstance();
const COUNTRIES_AR = require('./countries.json');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : '';
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

let bot = null;

// ===================== التخزين =====================
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

const DEFAULT_CONFIG = {
  locationEnabled: true,  // عرض الموقع / الخريطة
  usernameEnabled: true,  // عرض يوزر تيليجرام
  regionEnabled: true,    // عرض المنطقة / المدينة
  dailyLimit: 0,          // 0 = غير محدود (لكل مستخدم في اليوم)
  perSearchStars: 0,      // 0 = ميزة الدفع معطلة
};

let config = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) };
let users = readJSON(USERS_FILE, {});

function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

function todayKey() { return new Date().toISOString().slice(0, 10); }

function getUser(id) {
  const k = String(id);
  if (!users[k]) users[k] = { date: todayKey(), used: 0, limit: null, paid: 0, total: 0, premium: false };
  return users[k];
}

function resetIfNewDay(u) {
  if (u.date !== todayKey()) { u.date = todayKey(); u.used = 0; }
}

function dailyLimitFor(u) {
  return u.limit != null ? u.limit : config.dailyLimit;
}

function isPremiumUser(u) {
  return !!(u && u.premium);
}

function freeSearchAllowed(u) {
  resetIfNewDay(u);
  if (isPremiumUser(u)) return true; // المميز يبحث بلا حدود
  const lim = dailyLimitFor(u);
  return lim === 0 || u.used < lim;
}

function premiumUsers() {
  return Object.keys(users).filter((k) => users[k].premium);
}

function isOwner(id) {
  return OWNER_ID && String(id) === OWNER_ID;
}

// ===================== أدوات =====================
let CARRIERS = {};
try { CARRIERS = require('./carriers.json') || {}; } catch (e) { CARRIERS = {}; }

const PN_TYPES = {
  0: '☎️ خط أرضي',
  1: '📱 جوال',
  2: '📞 أرضي أو جوال',
  3: '🎁 رقم مجاني',
  4: '💎 رقم مميز (مدفوع)',
  5: '🔁 تكلفة مشتركة',
  6: '💬 VoIP',
  7: '👤 رقم شخصي',
  8: '📟 بيجر',
  9: '🌐 UAN',
  10: '📤 بريد صوتي',
  '-1': '❓ غير معروف',
};

const CENTROIDS = {
  AF: [33.94, 67.71], AL: [41.15, 20.17], DZ: [28.03, 1.66],
  AD: [42.55, 1.60], AO: [-12.30, 17.60], AR: [-38.42, -63.62],
  AM: [40.07, 45.04], AU: [-25.27, 133.78], AT: [47.52, 14.55],
  AZ: [40.14, 47.58], BH: [26.07, 50.55], BD: [23.68, 90.36],
  BY: [53.71, 27.95], BE: [50.50, 4.47], BJ: [9.30, 2.30],
  BO: [-16.29, -63.59], BA: [44.31, 17.68], BW: [-24.60, 24.68],
  BR: [-14.24, -51.93], BG: [42.73, 25.49], BF: [12.24, -1.56],
  BI: [-3.37, 29.92], KH: [12.57, 104.99], CM: [7.37, 12.35],
  CA: [56.13, -106.35], CF: [6.61, 20.94], TD: [15.45, 18.73],
  CL: [-35.68, -71.54], CN: [35.86, 104.20], CO: [4.57, -74.30],
  CD: [-4.04, 21.76], CG: [-0.23, 15.83], CR: [9.75, -83.75],
  HR: [45.10, 15.20], CU: [21.52, -77.78], CY: [35.13, 33.43],
  CZ: [49.82, 15.47], DK: [56.26, 9.50], DO: [18.74, -70.16],
  EC: [-1.83, -78.18], EG: [26.82, 30.80], SV: [13.79, -88.90],
  ER: [15.18, 39.78], EE: [58.60, 25.01], SZ: [-26.52, 31.47],
  ET: [9.15, 40.49], FJ: [-17.71, 178.07], FI: [61.92, 25.75],
  FR: [46.23, 2.21], GA: [-0.80, 11.61], GM: [13.44, -15.31],
  GE: [42.32, 43.36], DE: [51.17, 10.45], GH: [7.95, -1.02],
  GR: [39.07, 21.82], GT: [15.78, -90.23], GN: [9.95, -9.70],
  HT: [18.97, -72.28], HN: [15.20, -86.24], HU: [47.16, 19.50],
  IS: [64.96, -19.02], IN: [20.59, 78.96], ID: [-0.79, 113.92],
  IR: [32.43, 53.69], IQ: [33.22, 43.68], IE: [53.41, -8.24],
  IL: [31.05, 34.85], IT: [41.87, 12.57], CI: [7.54, -5.55],
  JM: [18.11, -77.30], JP: [36.20, 138.25], JO: [31.24, 36.57],
  KZ: [48.02, 66.92], KE: [-0.02, 37.91], KW: [29.31, 47.48],
  KG: [41.20, 74.77], LA: [19.86, 102.50], LV: [56.88, 24.60],
  LB: [33.85, 35.86], LS: [-29.61, 28.23], LY: [26.34, 17.23],
  LT: [55.17, 23.88], LU: [49.82, 6.13], MY: [4.21, 101.98],
  ML: [17.57, -3.99], MR: [21.01, -10.94], MU: [-20.35, 57.55],
  MX: [23.63, -102.55], MD: [47.41, 28.37], MN: [46.86, 103.72],
  ME: [42.71, 19.37], MA: [31.79, -7.09], MZ: [-18.67, 35.53],
  MM: [21.92, 95.96], NA: [-22.96, 18.49], NP: [28.39, 84.12],
  NL: [52.13, 5.29], NZ: [-40.90, 174.89], NI: [12.87, -85.21],
  NE: [17.61, 8.08], NG: [9.08, 8.68], KP: [40.34, 127.51],
  MK: [41.61, 21.75], NO: [60.47, 8.47], OM: [21.47, 55.98],
  PK: [30.38, 69.35], PS: [31.95, 35.23], PA: [8.54, -80.78],
  PG: [-6.31, 143.96], PY: [-23.44, -58.44], PE: [-9.19, -75.02],
  PH: [12.88, 121.77], PL: [51.92, 19.15], PT: [39.40, -8.22],
  QA: [25.35, 51.18], RO: [45.94, 24.97], RU: [61.52, 105.32],
  RW: [-1.94, 29.87], SA: [23.89, 45.08], SN: [14.50, -14.45],
  RS: [44.02, 21.01], SL: [8.46, -11.78], SG: [1.35, 103.82],
  SK: [48.67, 19.70], SI: [46.15, 14.98], SO: [5.15, 46.20],
  ZA: [-30.56, 22.94], KR: [35.91, 127.77], SS: [6.88, 31.31],
  ES: [40.46, -3.75], LK: [7.87, 80.77], SD: [12.86, 30.22],
  SR: [3.92, -56.03], SE: [60.13, 18.64], CH: [46.82, 8.23],
  SY: [34.80, 38.52], TW: [23.70, 120.96], TJ: [38.86, 71.28],
  TZ: [-6.37, 34.89], TH: [15.87, 100.99], TG: [8.62, 0.82],
  TT: [10.69, -61.22], TN: [33.89, 9.56], TR: [38.96, 35.24],
  TM: [38.97, 59.56], UG: [1.37, 32.29], UA: [48.38, 31.17],
  AE: [24.00, 54.00], GB: [55.38, -3.44], US: [37.09, -95.71],
  UY: [-32.52, -55.77], UZ: [41.38, 64.59], VE: [6.42, -66.59],
  VN: [16.05, 108.28], YE: [15.55, 48.52], ZM: [-13.13, 27.85],
  ZW: [-19.02, 29.15],
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cleanNumber(text) {
  const s = (text || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00') && s.length > 2) return '+' + s.slice(2);
  return s.startsWith('+') ? s : '+' + s;
}

function regionFlag(regionCode) {
  if (!regionCode || regionCode.length !== 2) return '';
  return [...regionCode.toUpperCase()]
    .map((c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
    .join('');
}

function lookupCarrier(countryPrefix, national) {
  const list = CARRIERS[countryPrefix];
  if (!list) return null;
  const nationalStr = String(national);
  let best = null;
  let max = 0;
  for (const [prefix, name] of list) {
    if (nationalStr.startsWith(prefix) && prefix.length > max) {
      max = prefix.length;
      best = name;
    }
  }
  return best;
}

const REGION_CACHE = new Map();

const fetchJSON = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'number-info-bot/1.2' }, signal: AbortSignal.timeout(8000) });
  return res.json();
};

async function regionInfo(regionCode) {
  if (REGION_CACHE.has(regionCode)) return REGION_CACHE.get(regionCode);
  const cc = (regionCode || '').toLowerCase();
  const fallbackName = COUNTRIES_AR[regionCode] || regionCode || '';
  let result = null;
  try {
    const searchUrl =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1' +
      `&accept-language=ar&countrycodes=${cc}&q=${encodeURIComponent(fallbackName)}`;
    const data = await fetchJSON(searchUrl);
    if (data && data[0]) {
      const coords = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
      const rvUrl =
        'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
        `&lat=${coords[0]}&lon=${coords[1]}&accept-language=ar`;
      const rd = await fetchJSON(rvUrl);
      const address = (rd && rd.address) || {};
      const countryAr = address.country || fallbackName;
      const regionAr =
        address.state || address.province || address.governorate ||
        address.county || address.state_district || address.region || null;
      result = { coords, countryAr, regionAr };
    }
  } catch (e) { /* تجاهل — نقع للاحتياط */ }
  if (!result) {
    const center = CENTROIDS[(regionCode || '').toUpperCase()];
    result = { coords: center || null, countryAr: null, regionAr: null };
  }
  REGION_CACHE.set(regionCode, result);
  return result;
}

async function analyzeNumber(raw) {
  const clean = cleanNumber(raw);
  if (!clean) return { ok: false, error: 'noraw' };

  let number;
  try { number = util.parse(clean, null); } catch (e) { number = null; }
  if (!number || !util.isValidNumber(number)) return { ok: false, error: 'invalid' };

  const intl = util
    .format(number, phonenumbers.PhoneNumberFormat.INTERNATIONAL)
    .replace(/[\u200e\u200f]/g, '');
  const e164 = util.format(number, phonenumbers.PhoneNumberFormat.E164);
  const regionCode = util.getRegionCodeForNumber(number) || '';
  const flag = regionFlag(regionCode);
  const national = String(number.getNationalNumber());
  const countryPrefix = '+' + number.getCountryCode();

  const geo = await regionInfo(regionCode);
  const countryAr = geo.countryAr || COUNTRIES_AR[regionCode.toUpperCase()] || 'غير معروف';
  const regionAr = geo.regionAr && geo.regionAr !== countryAr ? geo.regionAr : null;
  const coords = geo.coords || CENTROIDS[regionCode.toUpperCase()] || null;

  let tzName = null;
  if (coords) {
    try { tzName = tzLookup(coords[0], coords[1]); } catch (e) { tzName = null; }
  }

  const ntype = util.getNumberType(number);
  const typeText = PN_TYPES[ntype] || PN_TYPES[-1];
  const carrierName = lookupCarrier(countryPrefix, national);
  const valid = util.isValidNumber(number);
  const possible = util.isPossibleNumber(number);

  const text = buildOutput({
    intl, countryAr, flag, regionAr, carrierName, typeText, tzName, coords, valid, possible,
  }, true, true).join('\n');

  const title = regionAr ? `${regionAr}، ${countryAr}` : countryAr;

  return {
    ok: true,
    intl,
    e164,
    regionCode,
    flag,
    national,
    countryPrefix,
    countryAr,
    regionAr,
    coords,
    tzName,
    typeText,
    carrierName,
    valid,
    possible,
    text,
    title,
  };
}

function buildOutput(r, showRegion, showLocation) {
  const lines = [
    '🔍 <b>معلومـات الرقـم</b>',
    '━━━━━━━━━━━━━',
    `📞 <b>الرقم:</b> <code>${esc(r.intl)}</code>`,
    `🌍 <b>الدولة:</b> ${esc(r.countryAr)} ${esc(r.flag)}`,
  ];
  if (showRegion && r.regionAr) lines.push(`📍 <b>المنطقة / المدينة:</b> ${esc(r.regionAr)}`);
  else if (!showRegion) lines.push('📍 <b>المنطقة / المدينة:</b> مقفل من الإدارة 🔒');
  if (r.carrierName) lines.push(`📶 <b>المشغّل:</b> ${esc(r.carrierName)}`);
  lines.push(`📱 <b>نوع الخط:</b> ${r.typeText}`);
  lines.push(`⏰ <b>المنطقة الزمنية:</b> ${esc(r.tzName || 'غير معروف')}`);
  if (showLocation && r.coords) lines.push(`🧭 <b>الإحداثيات:</b> ${r.coords[0].toFixed(4)}, ${r.coords[1].toFixed(4)}`);
  else if (!showLocation) lines.push('🧭 <b>الموقع / الخريطة:</b> مقفل من الإدارة 🔒');
  if (r.valid) lines.push('🟢 <b>الحالة:</b> ✅ رقم صحيح');
  else if (r.possible) lines.push('🟡 <b>الحالة:</b> ⚠️ رقم ممكن (غير مؤكد)');
  else lines.push('🔴 <b>الحالة:</b> ❌ رقم غير صالح');
  lines.push('━━━━━━━━━━━━━');
  return lines;
}

// ===================== جلسة تيليجرام =====================
function statusAr(status) {
  if (!status) return null;
  const cn = status.className || '';
  if (cn === 'UserStatusOnline') return 'متصل الآن 🟢';
  if (cn === 'UserStatusRecently') return 'شوهد مؤخرًا 🕐';
  if (cn === 'UserStatusLastWeek') return 'شوهد هذا الأسبوع 📅';
  if (cn === 'UserStatusLastMonth') return 'شوهد هذا الشهر 📅';
  if (cn === 'UserStatusEmpty') return 'خاص (مخفي)';
  if (cn === 'UserStatusOffline' && status.wasOnline) {
    return 'آخر ظهور: ' + new Date(status.wasOnline * 1000).toLocaleString('ar-EG') + ' 🕓';
  }
  return null;
}

let _tg = null;
let _tgInit = false;

async function getTgClient() {
  if (_tg) return _tg;
  if (_tgInit) return null; // محاولة فاشلة سابقًا — نمنع إعادة المحاولة كل رسالة
  if (!(API_ID && API_HASH && TG_SESSION)) return null;
  _tgInit = true;
  try {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const client = new TelegramClient(
      new StringSession(TG_SESSION), API_ID, API_HASH,
      { connectionRetries: 3, deviceModel: 'number-info-bot' }
    );
    await client.connect();
    _tg = client;
  } catch (e) {
    console.error('تعذّر الربط بجلسة تيليجرام:', e.message || e);
    _tgInit = false;
  }
  return _tg;
}

async function tgAccountInfo(e164) {
  const client = await getTgClient();
  if (!client) {
    return '🤖 <b>حساب تيليجرام:</b> غير مفعّل — راجع README';
  }
  try {
    const t = require('telegram');
    const res = await client.invoke(new t.Api.contacts.ImportContacts({
      contacts: [
        new t.Api.InputPhoneContact({
          clientId: Date.now(),
          phone: e164,
          firstName: 'فحص',
          lastName: '',
        }),
      ],
    }));
    const usersList = res.users || [];
    if (!usersList.length) return '👤 <b>حساب تيليجرام:</b> لا يوجد 🚫';
    const u = usersList[0];
    const lines = ['👤 <b>حساب تيليجرام:</b> موجود ✅'];
    if (u.username) lines.push(`🔗 <b>اليوزر:</b> <code>@${esc(u.username)}</code>`);
    const name = u.firstName || u.lastName || '';
    if (name) lines.push(`✏️ <b>الاسم:</b> ${esc(name)}`);
    const st = statusAr(u.status);
    if (st) lines.push(`🕒 <b>الحالة:</b> ${esc(st)}`);
    return lines.join('\n');
  } catch (e) {
    console.error('فشل فحص تيليجرام:', e.message || e);
    return '👤 <b>حساب تيليجرام:</b> تعذّر الفحص ⚠️';
  }
}

// ===================== لوحة المالك =====================
function adminKeyboard() {
  const t = (v) => (v ? '🔓 مفتوح' : '🔒 مقفل');
  return {
    inline_keyboard: [
      [{ text: `📍 عرض الموقع: ${t(config.locationEnabled)}`, callback_data: 'tog:location' }],
      [{ text: `👤 يوزر تيليجرام: ${t(config.usernameEnabled)}`, callback_data: 'tog:username' }],
      [{ text: `🏙️ المنطقة / المدينة: ${t(config.regionEnabled)}`, callback_data: 'tog:region' }],
      [{ text: '🔒 قفل الكل', callback_data: 'lock:all' }, { text: '🔓 فتح الكل', callback_data: 'unlock:all' }],
      [{ text: `⭐ المميزون (بحث بلا حدود): ${premiumUsers().length}`, callback_data: 'list:premium' }],
      [{ text: `📊 الحصة اليومية: ${config.dailyLimit === 0 ? 'غير محدود' : config.dailyLimit + ' بحث'}`, callback_data: 'info:limit' }],
      [{ text: `⭐ سعر البحث الكامل: ${config.perSearchStars === 0 ? 'معطل' : config.perSearchStars + ' ⭐'}`, callback_data: 'info:stars' }],
    ],
  };
}

async function renderResult(chatId, r, { paid }) {
  const showLocation = paid || config.locationEnabled;
  const showRegion = paid || config.regionEnabled;
  const showUsername = paid || config.usernameEnabled;

  const lines = buildOutput(r, showRegion, showLocation);

  if (showUsername) {
    lines.push(await tgAccountInfo(r.e164));
  } else {
    lines.push('🤖 <b>حساب تيليجرام:</b> مقفول من الإدارة 🔒');
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });

  if (showLocation && r.coords) {
    try {
      await bot.sendVenue(
        chatId,
        r.coords[0],
        r.coords[1],
        String(r.title || '').slice(0, 64),
        String(r.countryAr || '').slice(0, 64)
      );
    } catch (e) { console.error('تعذّر إرسال الموقع:', e.message || e); }
  }
}

async function sendStarInvoice(chatId, number, stars) {
  await bot.sendInvoice(
    chatId,
    '🔓 بحث كامل وشامل',
    'يفتح لك كل معلومات الرقم حتى لو كانت ميزاته مقفلة من الإدارة. الدفع مرة واحدة لهذا الرقم فقط.\n' + number,
    number,
    '',
    'XTR',
    [
      { label: 'بحث كامل (مرة واحدة)', amount: stars },
    ]
  );
}

// ===================== المعالجة =====================
async function onMessage(msg) {
  if (!msg.text) return;
  const text = msg.text.trim();
  if (text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const r = await analyzeNumber(text);
  if (!r.ok) {
    const reason = r.error === 'noraw'
      ? 'لم أجد رقمًا في رسالتك.'
      : 'الرقم غير صالح أو ناقص.';
    await bot.sendMessage(
      chatId,
      `❌ ${reason}\nأرسل الرقم بالصيغة الدولية مثل: <code>+201012345678</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const u = getUser(userId);
  const fullAccess = isOwner(userId) || isPremiumUser(u);

  if (fullAccess || freeSearchAllowed(u)) {
    if (!fullAccess) {
      u.used += 1;
      u.total = (u.total || 0) + 1;
      saveUsers();
    }
    await renderResult(chatId, r, { paid: fullAccess });
    return;
  }

  if (config.perSearchStars > 0) {
    await bot.sendMessage(
      chatId,
      '⏳ <b>انتهت حصتك اليومية.</b>\n' +
      `📊 حصتك: <b>${dailyLimitFor(u) === 0 ? 'غير محدود' : dailyLimitFor(u) + ' بحث / يوم'}</b>\n` +
      'للبحث الآن بعرض <b>كل المعلومات</b> حتى المقفلة منها، ادفع:',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: `💳 ادفع ${config.perSearchStars} ⭐ والبحث كامل`, callback_data: 'pay:' + encodeURIComponent(r.intl) },
          ]],
        },
      }
    );
  } else {
    await bot.sendMessage(
      chatId,
      '⛔ <b>انتهت حصتك اليومية.</b>\nهذه الحصة تعود تلقائيًا غدًا. 🔄',
      { parse_mode: 'HTML' }
    );
  }
}

async function onCallback(cb) {
  const data = cb.data || '';
  const userId = cb.from.id;

  if (data.startsWith('pay:')) {
    const number = decodeURIComponent(data.slice(4));
    const chatId = cb.message ? cb.message.chat.id : userId;
    if (config.perSearchStars <= 0) {
      await bot.answerCallbackQuery(cb.id, { text: 'ميزة الدفع معطلة حاليًا.' });
      return;
    }
    try {
      await sendStarInvoice(chatId, number, config.perSearchStars);
    } catch (e) {
      console.error('فشل إرسال الفاتورة:', e.message || e);
      await bot.answerCallbackQuery(cb.id, { text: 'تعذّر إنشاء الفاتورة، حاول مرة أخرى.' });
      return;
    }
    await bot.answerCallbackQuery(cb.id);
    return;
  }

  if (!isOwner(userId)) {
    await bot.answerCallbackQuery(cb.id, { text: 'هذه الأزرار للإدارة فقط.' });
    return;
  }
  if (!cb.message || !cb.message.chat || !cb.message.message_id) return;

  if (data === 'list:premium') {
    const ids = premiumUsers();
    if (!ids.length) {
      await bot.answerCallbackQuery(cb.id, { text: 'لا يوجد مميزون بعد — أرسل /premium <id>' });
      return;
    }
    const kb = {
      inline_keyboard: ids.map((id) => [
        { text: `❌ إزالة تمييز ${id}`, callback_data: 'unprem:' + id },
      ]),
    };
    await bot.sendMessage(
      cb.message.chat.id,
      '⭐ <b>المستخدمون المميزون</b> (بحث غير محدود):\n' +
      ids.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n') +
      '\n\nلإضافة مميز جديد أرسل: <code>/premium &lt;id&gt;</code>',
      { parse_mode: 'HTML', reply_markup: kb }
    );
    await bot.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith('unprem:')) {
    const id = data.slice(7);
    if (users[id]) users[id].premium = false;
    saveUsers();
    await bot.answerCallbackQuery(cb.id, { text: 'تمت إزالة التمييز ✅' });
    return;
  }

  if (data === 'tog:location') { config.locationEnabled = !config.locationEnabled; saveConfig(); }
  else if (data === 'tog:username') { config.usernameEnabled = !config.usernameEnabled; saveConfig(); }
  else if (data === 'tog:region') { config.regionEnabled = !config.regionEnabled; saveConfig(); }
  else if (data === 'lock:all') {
    config.locationEnabled = config.usernameEnabled = config.regionEnabled = false;
    saveConfig();
  } else if (data === 'unlock:all') {
    config.locationEnabled = config.usernameEnabled = config.regionEnabled = true;
    saveConfig();
  } else if (data === 'info:limit') {
    await bot.answerCallbackQuery(cb.id, { text: 'لتغييره أرسل: /setlimit <عدد> (0 = غير محدود)' });
    return;
  } else if (data === 'info:stars') {
    await bot.answerCallbackQuery(cb.id, { text: 'لتغييره أرسل: /setprice <عدد النجوم>' });
    return;
  } else {
    await bot.answerCallbackQuery(cb.id);
    return;
  }

  await bot.answerCallbackQuery(cb.id, { text: 'تم التحديث ✅' });
  try {
    await bot.editMessageReplyMarkup(
      adminKeyboard(),
      { chat_id: cb.message.chat.id, message_id: cb.message.message_id }
    );
  } catch (e) { /* تم تحديثها بالفعل */ }
}

async function onStart(msg) {
  const text =
    '👋 أهلاً بك في بوت <b>معلومـات الأرقـام</b>\n' +
    '━━━━━━━━━━━━━\n' +
    'أرسل لي رقم هاتف بالصيغة <b>الدولية</b> مثل:\n' +
    '<code>+201012345678</code>\n\n' +
    'سأعرض لك:\n' +
    '• 🌍 الدولة والمنطقة / المدينة\n' +
    '• 📶 المشغّل ومقدّم الخدمة\n' +
    '• 📱 نوع الخط (جوال / أرضي / ...)\n' +
    '• ⏰ المنطقة الزمنية\n' +
    '• 🗺️ موقعه التقريبي على الخريطة\n' +
    '• 🤖 إذا كان الرقم مسجلاً في تيليجرام سأعرض يوزر الحساب\n\n' +
    '⚠️ <i>الموقع تقريبي ويعتمد على الدولة/المنطقة فقط، وليس موقع الشخص الفعلي.</i>';
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function onAdmin(msg) {
  await bot.sendMessage(
    msg.chat.id,
    '🛠 <b>لوحة تحكم الإدارة</b>\n\n' +
    'اضغط على زر لفتح/قفل ميزة، أو استخدم الأوامر:\n' +
    '• <code>/setlimit 3</code> — الحصة اليومية للجميع (0 = غير محدود)\n' +
    '• <code>/setlimit &lt;معرّف المستخدم&gt; 5</code> — حصة لمستخدم معين\n' +
    '• <code>/premium &lt;معرّف المستخدم&gt;</code> — رفع/إزالة مميز (بحث بلا حدود)\n' +
    '• <code>/lookup @يوزر</code> أو <code>/lookup &lt;آيدي&gt;</code> — جلب معلومات مستخدم\n' +
    '• <code>/setprice 2</code> — سعر البحث الكامل بالنجوم (0 = تعطيل الدفع)\n' +
    '• <code>/stats</code> — إحصائيات',
    { parse_mode: 'HTML', reply_markup: adminKeyboard() }
  );
}

async function onSetLimit(msg, arg) {
  const chatId = msg.chat.id;
  if (!arg) {
    await bot.sendMessage(chatId,
      'الاستخدام:\n<code>/setlimit 3</code> — لكل المستخدمين (0 = غير محدود)\n<code>/setlimit &lt;معرّف&gt; 5</code> — لمستخدم معين',
      { parse_mode: 'HTML' });
    return;
  }
  const parts = arg.trim().split(/\s+/);
  const isNum = (s) => /^\d+$/.test(s);
  if (parts.length === 2 && isNum(parts[0]) && isNum(parts[1]) && Number(parts[1]) <= 1000000) {
    const n = Number(parts[1]);
    const u = getUser(parts[0]);
    u.limit = n;
    saveUsers();
    await bot.sendMessage(chatId,
      `✅ حصة المستخدم <code>${parts[0]}</code>: ${n === 0 ? 'غير محدودة' : n + ' بحث/يوم'}`,
      { parse_mode: 'HTML' });
  } else if (parts.length === 1 && isNum(parts[0]) && Number(parts[0]) <= 1000000) {
    const n = Number(parts[0]);
    config.dailyLimit = n;
    saveConfig();
    await bot.sendMessage(chatId,
      `✅ الحصة اليومية للجميع: ${n === 0 ? 'غير محدودة' : n + ' بحث/يوم'}`,
      { parse_mode: 'HTML' });
  } else {
    await bot.sendMessage(chatId, '❌ صيغة غير صحيحة.', { parse_mode: 'HTML' });
  }
}

async function onSetPrice(msg, arg) {
  const chatId = msg.chat.id;
  if (!arg || !/^\d+$/.test(arg.trim())) {
    await bot.sendMessage(chatId, 'الاستخدام: <code>/setprice 2</code> — عدد النجوم للبحث الكامل (0 = تعطيل الدفع)', { parse_mode: 'HTML' });
    return;
  }
  const n = Number(arg.trim());
  config.perSearchStars = n;
  saveConfig();
  await bot.sendMessage(chatId, `✅ سعر البحث الكامل: ${n === 0 ? 'معطل' : n + ' ⭐ في المرة'}`);
}

async function onPremium(msg, arg) {
  const chatId = msg.chat.id;
  if (!arg || !arg.trim()) {
    const ids = premiumUsers();
    if (!ids.length) {
      await bot.sendMessage(chatId,
        'لا يوجد مستخدمون مميزون حاليًا.\nالاستخدام:\n<code>/premium &lt;انيد المستخدم&gt;</code> — رفع / إزالة مميز',
        { parse_mode: 'HTML' });
      return;
    }
    await bot.sendMessage(chatId,
      '⭐ <b>المستخدمون المميزون:</b>\n' +
      ids.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n'),
      { parse_mode: 'HTML' });
    return;
  }
  const id = arg.trim().replace(/[^\d]/g, '');
  if (!id) {
    await bot.sendMessage(chatId, '❌ آيدي غير صالح.', { parse_mode: 'HTML' });
    return;
  }
  const u = getUser(id);
  u.premium = !u.premium;
  saveUsers();
  await bot.sendMessage(chatId,
    `✅ المستخدم <code>${id}</code>: ${u.premium ? 'أصبح مميزًا (بحث بلا حدود)' : 'أُزيلت ميزة التمييز'}.`,
    { parse_mode: 'HTML' });
}

async function resolveUserInfo(raw) {
  const client = await getTgClient();
  if (!client) {
    return '✋ جلسة تيليجرام غير مفعّلة.\nضع <code>TELEGRAM_API_ID</code> و <code>TELEGRAM_API_HASH</code> في .env وشغّل <code>npm run setup</code> ثم أعد التشغيل.';
  }
  const t = require('telegram');
  const input = (raw || '').trim();
  try {
    let entity;
    if (/^\d+$/.test(input)) {
      entity = await client.getEntity(input);
    } else {
      const uname = input.startsWith('@') ? input.slice(1) : input;
      entity = await client.getEntity(uname);
    }
    if (!entity) throw new Error('لا يوجد مستخدم');
    const full = await client.invoke(new t.Api.users.GetFullUser({ id: entity }));
    const u = full.users[0];
    const info = full.full_user || {};
    const lines = ['🧾 <b>معلومات المستخدم</b>', '━━━━━━━━━━━━━'];
    lines.push(`🆔 <b>الآيدي:</b> <code>${String(u.id)}</code>`);
    if (u.username) lines.push(`🔗 <b>اليوزر:</b> <code>@${esc(u.username)}</code>`);
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    if (name) lines.push(`✏️ <b>الاسم:</b> ${esc(name)}`);
    if (u.phone) lines.push(`📞 <b>الهاتف (إن كان ظاهرًا):</b> <code>+${esc(u.phone)}</code>`);
    if (info.about) lines.push(`📝 <b>النّبذة / البايو:</b> ${esc(info.about)}`);
    const st = statusAr(u.status);
    if (st) lines.push(`🕒 <b>الحالة:</b> ${esc(st)}`);
    if (info.common_chats_count != null) lines.push(`👥 <b>الشاتات المشتركة:</b> ${info.common_chats_count}`);
    return lines.join('\n');
  } catch (e) {
    console.error('فشل /lookup:', e.message || e);
    return `❌ تعذّر إيجاد المستخدم: <code>${esc(input)}</code>\nتأكد من صحة اليوزر أو أن الآيدي ظاهر للجلسة. (${esc(e.message || e)})`;
  }
}

async function onLookup(msg, arg) {
  const chatId = msg.chat.id;
  if (!arg || !arg.trim()) {
    await bot.sendMessage(chatId,
      'الاستخدام:\n<code>/lookup @username</code> — معلومات مستخدم باليوزر\n<code>/lookup 123456789</code> — بالآيدي',
      { parse_mode: 'HTML' });
    return;
  }
  const text = await resolveUserInfo(arg);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function onStats(msg) {
  const today = todayKey();
  let todaySearches = 0;
  let total = 0;
  let paidStars = 0;
  for (const k of Object.keys(users)) {
    const u = users[k];
    if (u.date === today) todaySearches += u.used || 0;
    total += u.total || 0;
    paidStars += u.paid || 0;
  }
  await bot.sendMessage(
    msg.chat.id,
    '📊 <b>إحصائيات البوت</b>\n' +
    '━━━━━━━━━━━━━\n' +
    `👥 المستخدمون: <b>${Object.keys(users).length}</b>\n` +
    `📈 عمليات بحث اليوم: <b>${todaySearches}</b>\n` +
    `📚 إجمالي العمليات: <b>${total}</b>\n` +
    `⭐ نجوم مدفوعة: <b>${paidStars}</b>`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { analyzeNumber, cleanNumber, regionFlag, lookupCarrier, buildOutput };

// ===================== التشغيل =====================
if (require.main === module) {
  if (!BOT_TOKEN) {
    console.error('✋ ضع BOT_TOKEN في ملف .env ثم أعد التشغيل.');
    process.exit(1);
  }

  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/^\/(start|help)(@\w+)?/, onStart);
  bot.onText(/^\/admin(@\w+)?$/, async (msg) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onAdmin(msg);
  });
  bot.onText(/^\/setlimit(@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onSetLimit(msg, match[2]);
  });
  bot.onText(/^\/setprice(@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onSetPrice(msg, match[2]);
  });
  bot.onText(/^\/premium(@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onPremium(msg, match[2]);
  });
  bot.onText(/^\/lookup(@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onLookup(msg, match[2]);
  });
  bot.onText(/^\/stats(@\w+)?$/, async (msg) => {
    if (!isOwner(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, '⛔ هذا الأمر للإدارة فقط.');
      return;
    }
    await onStats(msg);
  });

  bot.on('callback_query', (cb) => onCallback(cb).catch((e) => console.error('خطأ في الأزرار:', e.message || e)));
  bot.on('pre_checkout_query', (q) => bot.answerPreCheckoutQuery(q.id, true).catch(() => {}));

  bot.on('successful_payment', async (msg) => {
    try {
      const userId = msg.from.id;
      const number = msg.successful_payment.invoice_payload || '';
      const stars = msg.successful_payment.total_amount || 0;
      const u = getUser(userId);
      u.paid = (u.paid || 0) + stars;
      saveUsers();
      const r = await analyzeNumber(number);
      if (r.ok) {
        await renderResult(msg.chat.id, r, { paid: true });
      } else {
        await bot.sendMessage(msg.chat.id, '❌ تعذّر معالجة الرقم بعد الدفع. أرسل الرقم مرة أخرى.', { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('خطأ في الدفع:', e.message || e);
    }
  });

  bot.on('polling_error', (e) => console.error('polling_error:', e.message || e));

  bot.on('message', (msg) => onMessage(msg).catch((e) => console.error('خطأ في المعالجة:', e.message || e)));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('number-info-bot is running');
  });
  server.listen(PORT, () => console.log(`🌐 خادم الـ HTTP يعمل على المنفذ ${PORT}`));

  // ===== حماية الاستمرار 24/7: لا يموت البوت من خطأ عابر =====
  process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err && (err.message || err)));
  process.on('uncaughtException', (err) => console.error('uncaughtException:', err && (err.message || err)));
  ['SIGTERM', 'SIGINT'].forEach((sig) =>
    process.on(sig, () => {
      console.log('🛑 إيقاف نظيف...');
      try { if (bot) bot.stopPolling(); } catch (e) { /* */ }
      process.exit(0);
    })
  );

  // نبض دوري خفيف يبقي العملية نشطة على المنصات المجانية
  setInterval(() => { /* no-op keep-alive */ }, 60 * 1000).unref();

  console.log('🚀 البوت يعمل الآن...');
  console.log(`📂 مجلد البيانات: ${DATA_DIR}`);
  if (OWNER_ID) console.log(`🔑 المالك مفعّل: ${OWNER_ID}`);
  else console.log('⚠️ لم يتم ضبط OWNER_ID — أوامر الإدارة معطلة.');
  if (config.perSearchStars > 0) console.log(`⭐ دفع النجوم مفعل: ${config.perSearchStars} ⭐ للبحث الكامل.`);
}