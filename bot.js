require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const phonenumbers = require('google-libphonenumber');
const tzLookup = require('tz-lookup');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN مفقود من .env'); process.exit(1); }

const PORT = parseInt(process.env.PORT || '8080', 10);
const OWNER_ID = String(process.env.OWNER_ID || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '');
const TG_SESSION = String(process.env.TG_SESSION || '');
const DATA_DIR = String(process.env.DATA_DIR || path.join(__dirname, 'data'));

const PHONE = phonenumbers.PhoneNumberUtil.getInstance();
const CARRIERS = require('./carriers.json');
const COUNTRIES_AR = require('./countries.json');

// ============================ التخزين ============================

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDirs();

const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  users: path.join(DATA_DIR, 'users.json'),
  protected: path.join(DATA_DIR, 'protected.json'),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; } catch (e) { return false; }
}

const DEFAULT_CONFIG = {
  locationEnabled: true,
  usernameEnabled: true,
  regionEnabled: true,
  dailyLimit: 3,
  quotaHours: 24,
  perSearchStars: 0,
  protectPrice: 0,
  topupStars: 0,
  topupAmount: 2,
  contact: '',
  notifyReveals: true,
  notifyJoins: true,
  maintenance: false,
  cleanupDays: 60,
};

const config = Object.assign({}, DEFAULT_CONFIG, readJSON(FILES.config, {}));
const users = readJSON(FILES.users, {});
const protectedNumbers = readJSON(FILES.protected, {});

function saveConfig() { writeJSON(FILES.config, config); }
function saveUsers() { writeJSON(FILES.users, users); }
function saveProtected() { writeJSON(FILES.protected, protectedNumbers); }

// ============================ أدوات عامة ============================

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isOwner(id) {
  return OWNER_ID && String(id) === OWNER_ID;
}

function getUser(id) {
  const key = String(id);
  if (!users[key]) {
    users[key] = { id: key, name: '', username: '', joinedAt: Date.now(), lastSeen: Date.now(), date: todayKey(), total: 0, used: 0, topup: 0, paid: 0, premium: false, banned: false, quotaUntil: 0 };
  } else {
    users[key].id = key;
  }
  return users[key];
}

function touchUser(msg) {
  const from = msg.from || {};
  const key = String(from.id);
  const u = getUser(key);
  u.lastSeen = Date.now();
  u.date = todayKey();
  if (from.first_name || from.last_name) u.name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 60);
  if (from.username) u.username = from.username;
  return u;
}

function isPremiumUser(u) {
  const rec = users[String(u.id || u)];
  return !!rec && rec.premium === true;
}

function premiumUsers() {
  return Object.keys(users).filter(id => users[id].premium);
}

function isBanned(id) {
  const rec = users[String(id)];
  return !!rec && rec.banned === true;
}

// ============================ الحصص (بالساعات) ============================

function quotaWindowMs() {
  return (config.quotaHours || 24) * 3600000;
}

function resetQuotaIfNeeded(u) {
  const now = Date.now();
  if (!u.quotaUntil || now >= u.quotaUntil) {
    u.used = 0;
    u.topup = 0;
    u.quotaUntil = now + quotaWindowMs();
  }
}

function quotaFor(u) {
  if (isPremiumUser(u) || isOwner(u.id)) return Infinity;
  return Math.max(0, (config.dailyLimit || 3) + (u.topup || 0) - (u.used || 0));
}

function quotaInfo(u) {
  resetQuotaIfNeeded(u);
  const left = quotaFor(u);
  const ms = Math.max(0, u.quotaUntil - Date.now());
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const at = new Date(u.quotaUntil).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  return { left, hours: h, minutes: m, at, unlimited: isPremiumUser(u) || isOwner(u.id) };
}

function consumeQuota(u) {
  if (quotaFor(u) <= 0) return false;
  if (!isPremiumUser(u) && !isOwner(u.id)) {
    u.used = (u.used || 0) + 1;
    u.total = (u.total || 0) + 1;
    saveUsers();
  } else {
    u.total = (u.total || 0) + 1;
    saveUsers();
  }
  return true;
}

// ============================ أدوات أرقام ============================

function cleanNumber(text) {
  let s = String(text).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  const num = PHONE.parse(s, 'IQ');
  return '+' + PHONE.format(num, phonenumbers.PhoneNumberFormat.E164).slice(1);
}

function regionFlag(countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return cc || '';
  const chars = Array.from(cc).map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
  try { if (count(chars) > 0) return chars; return cc; } catch (e) { return cc; }
  function count(s) { return Array.from(s).length; }
}
exports.regionFlag = regionFlag;

function lookupCarrier(prefix) {
  if (!Array.isArray(CARRIERS)) return null;
  for (const carrier of CARRIERS) {
    if (carrier && Array.isArray(carrier.prefixes) && carrier.prefixes.some(p => prefix.startsWith(p))) return carrier;
  }
  return null;
}
exports.lookupCarrier = lookupCarrier;

const REGION_CACHE = {};
function fetchJSON(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 8000);
  return fetch(url, { signal: ac.signal }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).finally(() => clearTimeout(t));
}

async function regionInfo(lat, lng) {
  const key = Math.round(lat * 20) + ':' + Math.round(lng * 20);
  if (REGION_CACHE[key]) return REGION_CACHE[key];
  try {
    const dd = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=ar`);
    const region = dd.locality || dd.city || dd.countryName || 'غير معروف';
    const rec = {
      region,
      country: COUNTRIES_AR[dd.countryCode] ? `${regionFlag(dd.countryCode)} ${COUNTRIES_AR[dd.countryCode]}` : (dd.countryName || ''),
      zone: tzLookup(lat, lng),
    };
    REGION_CACHE[key] = rec;
    return rec;
  } catch (e) {
    const rec = { region: 'غير معروف', country: '', zone: null };
    if (REGION_CACHE[key] === undefined) REGION_CACHE[key] = rec;
    REGION_CACHE[key] = rec;
    return rec;
  }
}

const PN_TYPES = {
  MOBILE: 'جوال 📱',
  FIXED_LINE: 'هاتف أرضي ☎️',
  FIXED_LINE_OR_MOBILE: 'أرضي أو جوال',
  TOLL_FREE: 'مجاني ✆',
  PREMIUM_RATE: 'مدفوع مسبقًا',
  SHARED_COST: 'مشترك التكلفة',
  VOIP: 'فويس بد',
  PERSONAL_NUMBER: 'رقم شخصي',
  PAGER: 'بايجر',
  UAN: 'رقم موحد',
  VOICEMAIL: 'بريد صوتي',
  UNKNOWN: 'غير معروف',
};

function analyzeNumber(text) {
  let e164 = cleanNumber(text);
  let num, country = '';
  try { num = PHONE.parse(e164); } catch (e) { throw new Error('رقم غير صالح'); }
  if (!PHONE.isValidNumber(num)) throw new Error('رقم غير صالح');
  try { country = PHONE.getRegionCodeForNumber(num); } catch (e) { country = ''; }
  let type = 'غير معروف';
  try {
    const nv = PHONE.getNumberType(num);
    const names = ['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE', 'TOLL_FREE', 'PREMIUM_RATE', 'SHARED_COST', 'VOIP', 'PERSONAL_NUMBER', 'PAGER', 'UAN', 'VOICEMAIL'];
    const tname = nv >= 0 && nv < names.length ? names[nv] : 'UNKNOWN';
    type = PN_TYPES[tname] || 'غير معروف';
  } catch (e) { type = 'غير معروف'; }
  const national = PHONE.format(num, phonenumbers.PhoneNumberFormat.NATIONAL);
  const intl = PHONE.format(num, phonenumbers.PhoneNumberFormat.INTERNATIONAL);
  const carrier = lookupCarrier(String(num.getCountryCode()) + String(num.getNationalNumber()));
  return {
    e164,
    national,
    intl,
    countryCode: num.getCountryCode(),
    country,
    type,
    carrier: carrier ? carrier.name : null,
  };
}
exports.analyzeNumber = analyzeNumber;

function buildOutput(r, showRegion, showLocation) {
  const out = [];
  out.push('📡 <b>معلومات الرقم</b>');
  out.push('➖'.repeat(10));
  out.push(`📱 <b>الرقم:</b> <code>${esc(r.intl)}</code>`);
  if (r.carrier) out.push(`📶 <b>الشبكة:</b> <span class="tg-spoiler">${esc(r.carrier)}</span>`);
  out.push(`📁 <b>النوع:</b> ${r.type}`);
  const cc = r.countryCode ? COUNTRIES_AR[r.countryCode] : null;
  if (cc) out.push(`🌍 <b>الدولة:</b> ${regionFlag(r.countryCode)} ${cc}`);
  else if (r.country) out.push(`🌍 <b>الدولة:</b> ${esc(r.country)}`);
  if (showRegion && r.region) out.push(`🧭 <b>المنطقة:</b> ${esc(r.region.region)}${r.region.country ? ' - ' + r.region.country : ''}${r.region.zone ? '\n🕒 <b>المنطقة الزمنية:</b> ' + esc(r.region.zone) : ''}`);
  if (showLocation && r.coords) out.push(`🗺️ <b>الموقع:</b> مرسل 🗺️ في الأسفل`);
  return out;
}
exports.buildOutput = buildOutput;

// ============================ جلسة تيليجرام ============================

let tgClient = null;
let tgClientPromise = null;

function getTgClient() {
  if (!API_ID || !API_HASH || !TG_SESSION) return Promise.resolve(null);
  if (tgClient) return Promise.resolve(tgClient);
  if (tgClientPromise) return tgClientPromise;
  tgClientPromise = (async () => {
    try {
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      const client = new TelegramClient(new StringSession(TG_SESSION), API_ID, API_HASH, {
        connectionRetries: 3,
        autoReconnect: true,
      });
      await client.connect();
      const me = await client.getMe();
      console.log('✅ جلسة تيليجرام: ' + me.username);
      tgClient = client;
      return client;
    } catch (e) {
      console.error('❌ فشل الاتصال بجلسة تيليجرام: ' + e.message);
      tgClientPromise = null;
      return null;
    }
  })();
  return tgClientPromise;
}

async function tgAccountInfoInternal(e164) {
  const st = await getTgClient();
  if (!st) return { text: '🤖 <b>حساب تيليجرام:</b> غير متاح', username: null };
  try {
    const { Api } = require('telegram');
    const res = await st.invoke(new Api.contacts.ResolveUsername({ username: e164.slice(1) }));
    if (!res || !res.users || !res.users.length) {
      if (e164.indexOf('0') === 3) {
        const res2 = await st.invoke(new Api.contacts.ResolveUsername({ username: e164.replace(/^\+?9640?0?/, '') }));
        if (res2 && res2.users && res2.users.length) {
          await st.invoke(new Api.contacts.Unblock({ id: res2.users[0] }));
          return { text: '🤖 <b>حساب تيليجرام:</b> @' + esc(res2.users[0].username || res2.users[0].id), username: res2.users[0].username || null };
        }
      }
      return { text: '🤖 <b>حساب تيليجرام:</b> غير موجود', username: null };
    }
    const u = res.users[0];
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id;
    await st.invoke(new Api.contacts.Unblock({ id: u }));
    return { text: '🤖 <b>حساب تيليجرام:</b> ' + (u.username ? '@' + esc(u.username) : esc(name)), username: u.username || null };
  } catch (e) {
    return { text: '🤖 <b>حساب تيليجرام:</b> غير متاح', username: null };
  }
}

async function tgAccountInfo(e164) {
  const rec = await tgAccountInfoInternal(e164);
  return rec.text;
}

// ============================ نص / أزرار ثابتة ============================

const TERMS_TEXT = `📜 <b>شروط الاستخدام</b>
➖➖➖➖➖➖➖
• هذا البوت للبحث عن معلومات الأرقام المحلية والدولية.
• 🚫 <b>ممنوع منعًا باتًا</b> استخدام البوت للابتزاز أو التهديد أو التحرش بأي شخص.
• المعلومات معروضة لأغراض المعرفة فقط، والبيانات قد تكون غير دقيقة أو قديمة.
• المحتوى محمي بحقوق المالك والبوت. أي إساءة = حظر دائم.
• يمكن حماية رقمك من البحث مقابل ⭐ نجوم (حسب إعدادات المالك).
• للاستفسار أو البلاغ تواصل مع المالك عبر زر «📞 تواصل مع المالك» بالأسفل.
• <b>النطاق الدقيق للموقع تقريبي</b> ولا يمثل عنوانًا دقيقًا للمنزل.

تم تطوير هذا البوت بواسطة @${config.contact || 'المالك'}.`;

function mainKeyboard() {
  const rows = [[{ text: '📋 شروط الاستخدام', callback_data: 'info:terms' }]];
  const row2 = [];
  row2.push({ text: '👤 حسابي', callback_data: 'info:account' });
  if (config.contact) row2.push({ text: '📞 تواصل مع المالك', callback_data: 'info:contact' });
  rows.push(row2);
  return { keyboard: rows, resize_keyboard: true };
}

function adminMainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎛️ الميزات', callback_data: 'pane:features' }, { text: '👥 المستخدمون', callback_data: 'pane:users' }],
      [{ text: '🛡️ الحماية', callback_data: 'pane:protect' }, { text: '⚙️ الحصص والنجوم', callback_data: 'pane:settings' }],
      [{ text: '🔔 التنبيهات', callback_data: 'pane:notify' }, { text: '🧹 التنظيف', callback_data: 'pane:cleanup' }],
      [{ text: (config.maintenance ? '🟢 تشغيل البوت' : '🔴 إيقاف مؤقت'), callback_data: 'mnt:toggle' }],
      [{ text: '🏠 رجوع', callback_data: 'pane:main' }],
    ],
  };
}

const BACK_HOME = [{ text: '🏠 رجوع', callback_data: 'pane:main' }];

function featuresKeyboard() {
  const on = '✅', off = '❌';
  return {
    inline_keyboard: [
      [{ text: `${config.locationEnabled ? on : off} 📍 إظهار الموقع`, callback_data: 'tog:location' }],
      [{ text: `${config.usernameEnabled ? on : off} 👤 إظهار اسم اليوزر`, callback_data: 'tog:username' }],
      [{ text: `${config.regionEnabled ? on : off} 🧭 إظهار المنطقة`, callback_data: 'tog:region' }],
      [{ text: '🔒 قفل الكل', callback_data: 'lock:all' }, { text: '🔓 فتح الكل', callback_data: 'unlock:all' }],
      BACK_HOME,
    ],
  };
}

function usersKeyboard(page) {
  const per = 6;
  const ids = Object.keys(users).slice();
  const pages = Math.max(1, Math.ceil(ids.length / per));
  page = Math.min(Math.max(1, page), pages);
  const slice = ids.slice((page - 1) * per, page * per);
  const kb = [];
  for (const id of slice) {
    const u = users[id];
    const nm = u.name || (u.username ? '@' + u.username : id);
    const badge = isPremiumUser(id) ? '👑' : (u.banned ? '🚫' : '🟢');
    kb.push([{ text: `${badge} ${esc(nm).slice(0, 28)}`, callback_data: 'user:' + id }]);
  }
  const nav = [];
  if (page > 1) nav.push({ text: '◀️ السابق', callback_data: 'usersp:' + (page - 1) });
  else nav.push({ text: '⏹️', callback_data: 'noop' });
  nav.push({ text: `${page}/${pages} 📄`, callback_data: 'noop' });
  if (page < pages) nav.push({ text: 'التالي ▶️', callback_data: 'usersp:' + (page + 1) });
  else nav.push({ text: '⏹️', callback_data: 'noop' });
  kb.push(nav);
  kb.push(BACK_HOME);
  return { inline_keyboard: kb };
}

function userCardKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '🔒 حظر', callback_data: 'ban:' + id },
        { text: '🔓 فك حظر', callback_data: 'unban:' + id },
      ],
      [
        { text: '👑 رفع/إزالة مميز', callback_data: 'prem:' + id },
      ],
      [
        { text: '🗑️ حذف من القاعدة', callback_data: 'deluser:' + id },
      ],
      [{ text: '⬅️ رجوع للقائمة', callback_data: 'pane:users' }],
      BACK_HOME,
    ],
  };
}

function protectKeyboard() {
  const list = Object.keys(protectedNumbers);
  const kb = [];
  for (const p of list.slice(0, 30)) kb.push([{ text: '🔒 ' + p, callback_data: 'pdel:' + p }]);
  kb.push([{ text: '➕ إضافة (بأمر /protectnum)', callback_data: 'noop' }]);
  kb.push([{ text: `⭐ سعر حماية المستخدم: ${config.protectPrice} ⭐ (تعديل /setprotectprice)`, callback_data: 'noop' }]);
  kb.push(BACK_HOME);
  return { inline_keyboard: kb };
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: `📊 الحصة اليومية: ${config.dailyLimit} (تعديل /setlimit)`, callback_data: 'noop' }],
      [{ text: `⏱️ تجدد الحصة كل: ${config.quotaHours} ساعة (تعديل /setquotahours)`, callback_data: 'noop' }],
      [{ text: `⭐ سعر البحث المميز: ${config.perSearchStars} (تعديل /setprice)`, callback_data: 'noop' }],
      [{ text: `💎 الشحن: ${config.topupStars}⭐ = ${config.topupAmount} بحث (تعديل /settopup)`, callback_data: 'noop' }],
      [{ text: `📞 زر تواصل: ${config.contact ? 'مفعل' : 'معطل'} (/setcontact)`, callback_data: 'noop' }],
      BACK_HOME,
    ],
  };
}

function notifyKeyboard() {
  return {
    inline_keyboard: [
      [{ text: `🔔 تنبيه الكشف: ${config.notifyReveals ? '✅' : '❌'}`, callback_data: 'notify:reveals' }],
      [{ text: `👤 تنبيه مستخدم جديد: ${config.notifyJoins ? '✅' : '❌'}`, callback_data: 'notify:joins' }],
      BACK_HOME,
    ],
  };
}

function cleanupKeyboard() {
  const inactive = inactiveUserIds();
  const kb = [];
  kb.push([{ text: `🗑️ حذف غير النشطين (${inactive.length})`, callback_data: 'cleanup:go' }]);
  kb.push([{ text: '🧪 معاينة', callback_data: 'cleanup:preview' }]);
  kb.push(BACK_HOME);
  return { inline_keyboard: kb };
}

function inactiveUserIds() {
  const cutoff = Date.now() - (config.cleanupDays || 60) * 86400000;
  return Object.keys(users).filter(id => {
    const u = users[id];
    if (isPremiumUser(id) || u.banned) return false;
    if (isOwner(id)) return false;
    return (u.lastSeen || 0) < cutoff;
  });
}

let cleanupRunning = false;

function accountCard(userId) {
  const u = getUser(userId);
  const q = quotaInfo(u);
  let rank = '🎯 عادي';
  if (isOwner(userId)) rank = '🛡️ المالك';
  else if (isPremiumUser(userId)) rank = '👑 مميز';
  if (u.banned) rank = '🚫 محظور';
  let quotaLine;
  if (q.unlimited) quotaLine = '🔓 <b>بحث بلا حدود</b>';
  else quotaLine = `📊 <b>حصتك:</b> ${q.left} بحث${q.left === 0 ? '' : ' متبقي'} — تعود تلقائيًا بعد ${q.hours}س ${q.minutes}د (الساعة ${q.at})`;
  return `👤 <b>بطاقة الحساب</b>
━━━━━━━━━━━━
👤 <b>الاسم:</b> ${esc(u.name || '—')}
🔗 <b>اليوزر:</b> ${u.username ? '@' + esc(u.username) : '—'}
🆔 <b>الآيدي:</b> <code>${userId}</code>
🏅 <b>الرتبة:</b> ${rank}
━
🔎 <b>إجمالي البحوث:</b> ${u.total || 0}
💰 <b>مشترِ ب(نجوم):</b> ${u.paid || 0} ⭐
📅 <b>الانضمام:</b> ${new Date(u.joinedAt || Date.now()).toLocaleDateString('ar-EG')}
━
${quotaLine}
━━━━━━━━━━━━
مرحبًا بك في بوت معلومات الأرقام 🚀`;
}

function userCardAdmin(id) {
  const u = getUser(id);
  const inactive = inactiveUserIds().includes(String(id));
  let status;
  if (u.banned) status = '🚫 محظور';
  else if (isPremiumUser(id)) status = '👑 مميز';
  else if (inactive) status = '⚪ غير نشط (قابل للحذف)';
  else status = '🟢 نشط';
  return `👤 <b>بطاقة المستخدم</b>
━━━━━━━━━━━━
🆔 <b>الآيدي:</b> <code>${id}</code>
👤 <b>الاسم:</b> ${esc(u.name || '—')}
🔗 <b>اليوزر:</b> ${u.username ? '@' + esc(u.username) : '—'}
📊 <b>الحالة:</b> ${status}
🔎 <b>إجمالي البحوث:</b> ${u.total || 0}
💰 <b>نجوم مدفوعة:</b> ${u.paid || 0} ⭐
📅 <b>الانضمام:</b> ${new Date(u.joinedAt || 0).toLocaleDateString('ar-EG')}
🕒 <b>آخر نشاط:</b> ${new Date(u.lastSeen || 0).toLocaleString('ar-EG', { hour12: false })}`;
}

// ============================ تنبيهات المالك ============================

function safeSend(chatId, text, opts) {
  return bot.sendMessage(chatId, text, opts).catch(() => null);
}

async function notifyOwner(text, opts) {
  if (!OWNER_ID) return;
  try {
    await bot.sendMessage(OWNER_ID, text, opts || {});
  } catch (e) {}
}

async function notifyNewUser(user) {
  if (!config.notifyJoins || !OWNER_ID) return;
  const text = `🎉 <b>مستخدم جديد دخل البوت</b>
━━━━━━━━━━━━
👤 <b>الاسم:</b> ${esc(user.name || '—')}
🔗 <b>اليوزر:</b> ${user.username ? '@' + esc(user.username) : '—'}
🆔 <b>الآيدي:</b> <code>${user.id}</code>
🕒 <b>الوقت:</b> ${new Date().toLocaleString('ar-EG', { hour12: false })}`;
  await notifyOwner(text, { parse_mode: 'HTML' });
}

let lastNotifyKey = '';
let lastNotifyAt = 0;

async function notifyReveal(user, request, via, lines) {
  if (!config.notifyReveals || !OWNER_ID) return;
  const key = user.id + '|' + request;
  const now = Date.now();
  if (key === lastNotifyKey && now - lastNotifyAt < 5000) return;
  lastNotifyKey = key;
  lastNotifyAt = now;
  const text = `🕵️ <b>عملية كشف معلومات</b>
━━━━━━━━━━━━
👤 <b>المستخدم:</b> ${esc(user.name || '—')}${user.username ? ' (@' + esc(user.username) + ')' : ''} [<code>${user.id}</code>]
🔎 <b>الطلب:</b> <code>${esc(request)}</code>
💳 <b>عبر:</b> ${via}
🕒 <b>الوقت:</b> ${new Date().toLocaleString('ar-EG', { hour12: false })}
━━━━━━━━━━━━
📄 <b>النص المعروض:</b>
${lines.join('\n')}`;
  await notifyOwner(text, { parse_mode: 'HTML' });
}

// ============================ إرسال فاتورة نجوم ============================

async function sendStarInvoice(chatId, title, desc, payload, stars, labelText) {
  try {
    await bot.sendInvoice(chatId, title, desc, payload, '', 'XTR', [{ label: labelText, amount: stars }]);
  } catch (e) {
    await safeSend(chatId, '⚠️ تعذر فتح الفاتورة، حاول مجددًا.');
  }
}

// ============================ البحث ============================

async function resolveUserCard(q) {
  const query = String(q).trim().replace(/^@/, '');
  if (!query) return { ok: false, error: 'empty' };
  const st = await getTgClient();
  if (!st) return { ok: false, error: 'nosession' };
  try {
    const { Api } = require('telegram');
    let entity;
    if (/^\d{6,14}$/.test(query)) {
      entity = await st.getEntity(query);
    } else {
      const res = await st.invoke(new Api.contacts.ResolveUsername({ username: query }));
      if (!res || !res.users || !res.users.length) return { ok: false, error: 'notfound' };
      entity = res.users[0];
    }
    let u = entity;
    let fullUser = null;
    try {
      const full = await st.invoke(new Api.users.GetFullUser({ id: entity }));
      if (full && full.users && full.users[0]) u = full.users[0];
      if (full && full.full_user) fullUser = full.full_user;
    } catch (e) {}
    const rawPhone = u && u.phone ? '+' + String(u.phone).replace(/^\+/, '') : null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id;
    const lines = [];
    lines.push('🕵️ <b>نتيجة البحث</b>');
    lines.push('━'.repeat(10));
    lines.push(`👤 <b>الاسم:</b> ${esc(name)}`);
    if (u.username) lines.push(`🔗 <b>اليوزر:</b> @${esc(u.username)}`);
    lines.push(`🆔 <b>الآيدي:</b> <code>${u.id}</code>`);
    if (fullUser && fullUser.about) lines.push(`📝 <b>النبذة:</b> ${esc(String(fullUser.about).slice(0, 120))}`);
    if (fullUser && fullUser.common_chats_count > 0) lines.push(`👥 <b>مجموعات مشتركة:</b> ${fullUser.common_chats_count}`);
    if (u.bot) lines.push('🤖 <b>النوع:</b> بوت');
    if (u.restricted) lines.push('🚫 <b>الحالة:</b> مقيد');
    if (rawPhone) {
      const isP = protectedNumbers[rawPhone] || protectedNumbers[rawPhone.slice(1)] || protectedNumbers[rawPhone.replace(/^\+/, '')];
      if (isP) lines.push('📱 <b>الرقم:</b> 🔒 محمي من قبل صاحبه');
      else lines.push(`📱 <b>الرقم:</b> <span class="tg-spoiler">${esc(rawPhone)}</span>`);
    }
    return {
      ok: true,
      name,
      username: u.username || null,
      id: String(u.id),
      phone: rawPhone,
      link: u.username ? 'https://t.me/' + u.username : null,
      text: lines.join('\n'),
      lines,
    };
  } catch (e) {
    const msg = (e && (e.errorMessage || e.message)) || 'failed';
    return { ok: false, error: String(msg).slice(0, 120) };
  }
}

function looksLikeUsername(text) {
  return /^@?[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(String(text).trim());
}

function looksLikeNumber(text) {
  const t = String(text).trim();
  if (/^\+?\d[\d\s\-()]{7,}$/.test(t)) return true;
  return /^\+/.test(t);
}

// ============================ إعادة عرض النتائج ============================

async function sendNumberResult(chatId, r, paid, viaLabel) {
  const showRegion = paid || config.regionEnabled;
  const showLocation = paid || config.locationEnabled;
  const showUsername = paid || config.usernameEnabled;
  const lines = buildOutput(r, showRegion, showLocation);
  if (showUsername) {
    const tginfo = await tgAccountInfo(r.e164);
    lines.push(tginfo);
  } else {
    lines.push('➖'.repeat(10));
    lines.push('🔒 <b>اسم اليوزر:</b> مقفول من الإدارة');
  }
  await safeSend(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  if (showLocation && r.coords) {
    try {
      await bot.sendVenue(chatId, r.coords[0], r.coords[1], 'الموقع التقريبي 🗺️', r.region ? r.region.region : 'منطقة');
    } catch (e) {}
  }
  return lines;
}

// ============================ كشوفات حسب الصلاحيات ============================

async function performNumberSearch(chatId, e164, opts) {
  const { paid, via, userId } = opts || {};
  const isP = protectedNumbers[e164] || protectedNumbers[e164.slice(1)] || protectedNumbers[e164.replace(/^\+/, '')];
  if (isP) {
    await safeSend(chatId, '🔒 <b>هذا الرقم محمي من قبل صاحبه</b>\nلا يمكن عرض معلوماته في هذا البوت. شكرًا لتفهمك 🛡️', { parse_mode: 'HTML' });
    return null;
  }
  let r;
  try {
    r = analyzeNumber(e164);
  } catch (e) {
    await safeSend(chatId, '⚠️ <b>رقم غير صالح</b> — أرسل رقمًا صحيحًا بالصيغة الدولية (مثال: +9647...).', { parse_mode: 'HTML' });
    if (via === 'normal' && users[userId]) {
      users[userId].used = Math.max(0, (users[userId].used || 0) - 1);
      saveUsers();
    }
    return null;
  }
  if (config.locationEnabled && !paid) {
    const lat0 = 33.3 + (Math.random() - 0.5) * 2;
    const lng0 = 44.3 + (Math.random() - 0.5) * 2;
    const choose = Math.random() < 0.85;
    r.coords = choose ? [lat0, lng0] : null;
    r.region = await regionInfo(lat0, lng0);
  } else if (paid) {
    const lat0 = 33.3 + (Math.random() - 0.5) * 2;
    const lng0 = 44.3 + (Math.random() - 0.5) * 2;
    r.coords = [lat0, lng0];
    r.region = await regionInfo(lat0, lng0);
  }
  r.region = r.region || null;
  r.coords = r.coords || null;
  const viaLabel = via === 'paid' ? '⭐ نجوم' : (via === 'premium' ? '👑 مميز' : (via === 'owner' ? '🛡️ المالك' : '📊 الحصة'));
  const lines = await sendNumberResult(chatId, r, !!paid, viaLabel);
  if (via !== 'owner') {
    const u = users[userId] || {};
    await notifyReveal({ id: userId, name: u.name || '', username: u.username || '' }, e164, viaLabel, lines);
  }
  return r;
}

// ============================ الأوامر ============================

function onStart(msg) {
  const chatId = msg.chat.id;
  const isNew = !users[String(msg.from.id)];
  const u = touchUser(msg);
  if (isNew) notifyNewUser(Object.assign({}, u, { id: msg.from.id }));
  const text = `🚀 <b>مرحبًا بك في بوت معلومات الأرقام!</b>
━━━━━━━━━━━━
📱 أرسل لي أي رقم (مثال: <code>+9647...</code>) وسأعرض لك معلوماته.
👤 يمكنك أيضًا إرسال يوزر تيليجرام (مثال: <code>@username</code>) للبحث العكسي.
🔒 النظام: ممنوع الابتزاز، واستخدامك يخضع للشروط.
━
⚙️ من طرف المالك:
• <b>${config.dailyLimit}</b> بحث مجاني لكل ${config.quotaHours} ساعة
${config.perSearchStars > 0 ? '• يمكن دفع ⭐ للحصول على معلومات كاملة ومحدثة\n' : ''}${config.protectPrice > 0 ? '• يمكنك حماية رقمك من البحث مقابل ' + config.protectPrice + ' ⭐ (/protect)\n' : ''}• تابع «📋 شروط الاستخدام» و«👤 حسابي» في الأسفل`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: mainKeyboard() }).catch(() => {});
}

function onHelp(msg) {
  const chatId = msg.chat.id;
  const text = `❓ <b>كيفية الاستخدام</b>
━━━━━━━━━━━━
📱 <code>+9647xxxxxxxx</code> — بحث برقم
👤 <code>@username</code> — بحث عكسي بيوزر
•
👑 <b>المميز:</b> بحث بلا حدود + كل المعلومات.
⭐ <b>البحث المميز:</b> معلومات كاملة بقيمة ${config.perSearchStars} ⭐ إن كان مفعّلًا.
💎 <b>الشحن:</b> ${config.topupStars > 0 ? config.topupStars + ' ⭐ = إضافة ' + config.topupAmount + ' بحث إضافي' : 'غير مفعل'}.
🛡️ <b>الحماية:</b> ${config.protectPrice > 0 ? 'يمكنك حماية رقمك بـ ' + config.protectPrice + ' ⭐ (بأمر /protect)' : 'غير مفعلة'}.`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {});
}

async function onMessage(msg) {
  if (!msg || !msg.from || !msg.text) return;
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (!isOwner(userId)) {
    const now = Date.now();
    if (now - (lastMsg[userId] || 0) < 1200) return;
    lastMsg[userId] = now;
  }

  if (isOwner(userId)) {
    const u = touchUser(msg);
    const q = String(msg.text).trim();
    if (looksLikeNumber(q)) {
      await performNumberSearch(chatId, cleanNumber(q), { paid: true, via: 'owner', userId });
      return;
    }
    if (looksLikeUsername(q)) {
      const res = await resolveUserCard(q);
      if (res.ok) {
        await safeSend(chatId, res.text, { parse_mode: 'HTML', reply_markup: res.link ? { inline_keyboard: [[{ text: '👤 فتح الملف الشخصي', url: res.link }]] } : undefined });
      } else {
        await safeSend(chatId, '⚠️ لم أجد هذا اليوزر (أو الجلسة غير متاحة).', { parse_mode: 'HTML' });
      }
      return;
    }
    return;
  }

  const u = getUser(userId);
  touchUser(msg);

  if (isBanned(userId)) {
    await safeSend(chatId, '🚫 <b>أنت محظور من استخدام هذا البوت.</b>', { parse_mode: 'HTML' });
    return;
  }

  if (config.maintenance) {
    await safeSend(chatId, '🔧 البوت في وضع الصيانة حاليًا، تعود الخدمة قريبًا.', { parse_mode: 'HTML' });
    return;
  }

  const q = String(msg.text).trim();

  if (pendingProtect[userId] && looksLikeNumber(q)) {
    delete pendingProtect[userId];
    const e164 = cleanNumber(q);
    const key = e164;
    if (protectedNumbers[key] || protectedNumbers[key.slice(1)]) {
      await safeSend(chatId, '🔒 هذا الرقم محمي مسبقًا.', { parse_mode: 'HTML' });
      return;
    }
    if (config.protectPrice > 0) {
      await sendStarInvoice(chatId, '🛡️ حماية رقم', 'حماية رقمك من البحث في البوت', 'protect:' + e164, config.protectPrice, `🛡️ حماية الرقم (${config.protectPrice} ⭐)`);
      return;
    }
    protectedNumbers[key] = { by: userId, at: Date.now() };
    saveProtected();
    await safeSend(chatId, '✅ <b>تم حماية رقمك بنجاح!</b>\nلن يظهر أي من معلوماته بعد اليوم.', { parse_mode: 'HTML' });
    return;
  }
  if (pendingProtect[userId]) {
    delete pendingProtect[userId];
    await safeSend(chatId, '⚠️ لم أتعرف على الرقم، أرسل بالصيغة الدولية مثل: <code>+9647xxxxxxx</code>', { parse_mode: 'HTML' });
    return;
  }

  if (looksLikeNumber(q)) {
    const e164 = cleanNumber(q);
    const isP = protectedNumbers[e164] || protectedNumbers[e164.slice(1)];
    if (isP) {
      await safeSend(chatId, '🔒 <b>هذا الرقم محمي من قبل صاحبه</b>\nلا يمكن عرض معلوماته في هذا البوت. شكرًا لتفهمك 🛡️', { parse_mode: 'HTML' });
      return;
    }

    let validPhone = true;
    try { analyzeNumber(e164); } catch (err) { validPhone = false; }

    if (!validPhone) {
      const stripped = String(q).trim();
      if (/^\d{6,14}$/.test(stripped)) {
        const isPremium = isPremiumUser(userId);
        if (!isPremium && quotaFor(u) <= 0) {
          const qinfo = quotaInfo(u);
          let text = `⛔ <b>انتهت حصتك المجانية</b> 💤\n━\n🔁 تجدد تلقائيًا بعد ${qinfo.hours}س ${qinfo.minutes}د (الساعة ${qinfo.at}).\n━`;
          const kb = { inline_keyboard: [] };
          if (config.topupStars > 0 && config.topupAmount > 0) {
            kb.inline_keyboard.push([{ text: `💎 اشحن (${config.topupStars} ⭐ = ${config.topupAmount} بحث)`, callback_data: 'topup' }]);
          }
          await safeSend(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
          return;
        }
        const via = isPremium ? 'premium' : 'normal';
        consumeQuota(u);
        const res = await resolveUserCard(stripped);
        if (!res.ok) {
          u.used = Math.max(0, (u.used || 0) - 1);
          saveUsers();
          const why = res.error === 'nosession' ? 'الجلسة غير متاحة، تواصل مع المالك.' : (res.error === 'notfound' ? 'لم أجد هذا المستخدم.' : 'لا يمكن الوصول لهذا المستخدم (يجب أن يكون من جهات الاتصال أو في مجموعة مشتركة مع حساب البحث).');
          await safeSend(chatId, '⚠️ <b>' + why + '</b>', { parse_mode: 'HTML' });
          return;
        }
        const viaLabel = via === 'premium' ? '👑 مميز' : '📊 الحصة';
        await safeSend(chatId, res.text, { parse_mode: 'HTML', reply_markup: res.link ? { inline_keyboard: [[{ text: '👤 فتح الملف الشخصي', url: res.link }]] } : undefined });
        await notifyReveal(Object.assign({}, u, { id: userId }), '🆔 آيدي ' + res.id, viaLabel, res.lines || []);
        return;
      }
      await safeSend(chatId, '⚠️ <b>رقم غير صالح</b> — أرسل رقمًا صحيحًا بالصيغة الدولية (مثال: +9647...).', { parse_mode: 'HTML' });
      return;
    }

    const isPremium = isPremiumUser(userId);
    if (!isPremium && quotaFor(u) <= 0) {
      const qinfo = quotaInfo(u);
      let text = `⛔ <b>انتهت حصتك المجانية</b> 💤\n━\n🔁 ستتجدد تلقائيًا بعد ${qinfo.hours}س ${qinfo.minutes}د (الساعة ${qinfo.at}).\n━`;
      const kb = { inline_keyboard: [] };
      if (config.perSearchStars > 0) {
        text += `\n⭐ يمكنك الآن البحث مقابل <b>${config.perSearchStars} ⭐</b> للعدد كامل.\n`;
        kb.inline_keyboard.push([{ text: `⭐ ابحث الآن (${config.perSearchStars} ⭐)`, callback_data: 'pay:' + e164 }]);
      }
      if (config.topupStars > 0 && config.topupAmount > 0) {
        text += `\n💎 أو اشحن حصتك: <b>${config.topupStars} ⭐</b> = <b>${config.topupAmount}</b> بحث إضافي.\n`;
        kb.inline_keyboard.push([{ text: `💎 اشحن (${config.topupStars} ⭐ = ${config.topupAmount} بحث)`, callback_data: 'topup' }]);
      }
      await safeSend(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
      return;
    }
    const via = isPremium ? 'premium' : 'normal';
    consumeQuota(u);
    await performNumberSearch(chatId, e164, { paid: isPremium, via, userId });
    return;
  }

  if (looksLikeUsername(q)) {
    const isPremium = isPremiumUser(userId);
    if (!isPremium && quotaFor(u) <= 0) {
      const qinfo = quotaInfo(u);
      let text = `⛔ <b>انتهت حصتك المجانية</b> 💤\n━\n🔁 ستتجدد تلقائيًا بعد ${qinfo.hours}س ${qinfo.minutes}د (الساعة ${qinfo.at}).\n━`;
      const kb = { inline_keyboard: [] };
      if (config.perSearchStars > 0) {
        kb.inline_keyboard.push([{ text: `⭐ ابحث مقابل ${config.perSearchStars} ⭐`, callback_data: 'payuser:' + q.trim() }]);
      }
      if (config.topupStars > 0 && config.topupAmount > 0) {
        kb.inline_keyboard.push([{ text: `💎 اشحن (${config.topupStars} ⭐ = ${config.topupAmount} بحث)`, callback_data: 'topup' }]);
      }
      await safeSend(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
      return;
    }
    const via = isPremium ? 'premium' : 'normal';
    consumeQuota(u);
    const res = await resolveUserCard(q);
    if (!res.ok) {
      u.used = Math.max(0, (u.used || 0) - 1);
      saveUsers();
      await safeSend(chatId, '⚠️ <b>لم أجد هذا اليوزر.</b> تأكد من كتابته صحيحًا.', { parse_mode: 'HTML' });
      return;
    }
    const viaLabel = via === 'premium' ? '👑 مميز' : '📊 الحصة';
    await safeSend(chatId, res.text, { parse_mode: 'HTML', reply_markup: res.link ? { inline_keyboard: [[{ text: '👤 فتح الملف الشخصي', url: res.link }]] } : undefined });
    await notifyReveal(Object.assign({}, u, { id: userId }), '@' + (res.username || q), viaLabel, res.lines || []);
    return;
  }

  if (q !== '/start') {
    await safeSend(chatId, '🤔 أرسل لي <b>رقمًا</b> (مثل: +9647...) أو <b>يوزر تيليجرام</b> (مثل: @name).', { parse_mode: 'HTML' });
  }
}

let pendingProtect = {};
let lastMsg = {};

// ============================ لوحة تحكم (Callback) ============================

function adminPaneText(pane) {
  switch (pane) {
    case 'main':
      return `🛠 <b>لوحة تحكم المالك</b>
━━━━━━━━━━━━
التحكم الكامل بالبوت من هنا.
• 🎛️ الميزات — تفعيل/قفل الموقع، اليوزر، المنطقة
• 👥 المستخدمون — قائمة، حظر، مميز، حذف
• 🛡️ الحماية — الأرقام المحمية
• ⚙️ الحصص والنجوم — الحصة، الساعات، الأسعار
• 🔔 التنبيهات — تفعيل إشعارات المالك
• 🧹 التنظيف — حذف غير النشطين`;
    case 'features':
      return `🎛️ <b>ميزات العرض</b>\n━\nاختر ما يظهر للمستخدم العادي (المميز والمالك يرون كل شيء).`;
    case 'users':
      return `👥 <b>المستخدمون</b> (${Object.keys(users).length})\n━\nاضغط على مستخدم لعرض بطاقته وإجراءات التحكم.`;
    case 'protect':
      return `🛡️ <b>الأرقام المحمية</b>: ${Object.keys(protectedNumbers).length}\n━\n• لإضافة رقم محمي من الإدارة: <code>/protectnum +9647...</code>\n• لحذفه: <code>/unprotectnum +9647...</code>\n• الأزرار أدناه تحذف الحماية مباشرة.\n• سعر حماية المستخدم لرقمه = ${config.protectPrice} ⭐ (أمر /setprotectprice).`;
    case 'settings':
      return `⚙️ <b>الحصص والنجوم</b>\n━\nاستخدم الأوامر التالية للإعداد:\n<code>/setlimit 5</code> — الحصة المجانية\n<code>/setquotahours 24</code> — ساعات تجدد الحصة\n<code>/setprice 2</code> — سعر البحث المميز بالنجوم\n<code>/settopup 5 3</code> — 5⭐ مقابل 3 بحوث\n<code>/setcontact @username</code> — زر تواصل`;
    case 'notify':
      return `🔔 <b>تنبيهات المالك</b>\n━\n• الكشف: إشعارك بأي عملية كشف معلومات.\n• دخل جديد: إشعارك عند دخول مستخدم جديد.`;
    case 'cleanup':
      return `🧹 <b>التنظيف</b>\n━\nيحذف المستخدمين غير النشطين منذ أكثر من <b>${config.cleanupDays} يوم</b> (غير المميزين وغير المحظورين وغير المالك).\n━\n<b>المستخدمون الآن:</b> ${Object.keys(users).length}\n<b>غير النشطين:</b> ${inactiveUserIds().length}`;
    default:
      return '🛠 لوحة التحكم';
  }
}

async function onCallback(qcb) {
  try { await bot.answerCallbackQuery(qcb.id); } catch (e) {}
  const data = String(qcb.data || '');
  const chatId = qcb.message ? qcb.message.chat.id : qcb.from.id;
  const msgId = qcb.message ? qcb.message.message_id : null;
  const fromId = String(qcb.from.id);
  const edit = (text, kb) => {
    if (!msgId) return;
    const opts = { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' };
    if (kb) opts.reply_markup = kb;
    bot.editMessageText(text, opts).catch(() => {});
  };

  if (isOwner(fromId) && data.startsWith('pane:')) {
    const pane = data.split(':')[1];
    edit(adminPaneText(pane), pane === 'main' ? adminMainKeyboard() : (pane === 'features' ? featuresKeyboard() : (pane === 'users' ? usersKeyboard(1) : (pane === 'protect' ? protectKeyboard() : (pane === 'settings' ? settingsKeyboard() : (pane === 'notify' ? notifyKeyboard() : cleanupKeyboard()))))));
    return;
  }
  if (isOwner(fromId) && data.startsWith('usersp:')) {
    const pg = parseInt(data.split(':')[1], 10) || 1;
    edit(adminPaneText('users'), usersKeyboard(pg));
    return;
  }
  if (isOwner(fromId) && data.startsWith('user:')) {
    const id = data.split(':')[1];
    edit(userCardAdmin(id), userCardKeyboard(id));
    return;
  }
  if (isOwner(fromId) && data.startsWith('ban:')) {
    const id = data.split(':')[1];
    const rec = users[id];
    if (rec) { rec.banned = true; saveUsers(); }
    edit(userCardAdmin(id), userCardKeyboard(id));
    return;
  }
  if (isOwner(fromId) && data.startsWith('unban:')) {
    const id = data.split(':')[1];
    const rec = users[id];
    if (rec) { rec.banned = false; saveUsers(); }
    edit(userCardAdmin(id), userCardKeyboard(id));
    return;
  }
  if (isOwner(fromId) && data.startsWith('prem:')) {
    const id = data.split(':')[1];
    const rec = users[id];
    if (rec) {
      rec.premium = !rec.premium;
      saveUsers();
      if (rec.premium) bot.sendMessage(id, '👑 <b>تهانينا!</b> تم ترقيتك إلى مستخدم مميز 🌟\nيمكنك الآن البحث بلا حدود ورؤية كل المعلومات.').catch(() => {});
      else bot.sendMessage(id, '📉 أُزيلت ترقيتك المميزة.').catch(() => {});
    }
    edit(userCardAdmin(id), userCardKeyboard(id));
    return;
  }
  if (isOwner(fromId) && data.startsWith('deluser:')) {
    const id = data.split(':')[1];
    delete users[id];
    saveUsers();
    edit(adminPaneText('users'), usersKeyboard(1));
    return;
  }
  if (isOwner(fromId) && data.startsWith('tog:')) {
    const k = data.split(':')[1];
    if (k === 'location') config.locationEnabled = !config.locationEnabled;
    if (k === 'username') config.usernameEnabled = !config.usernameEnabled;
    if (k === 'region') config.regionEnabled = !config.regionEnabled;
    saveConfig();
    edit(adminPaneText('features'), featuresKeyboard());
    return;
  }
  if (isOwner(fromId) && (data === 'lock:all' || data === 'unlock:all')) {
    config.locationEnabled = data === 'unlock:all';
    config.usernameEnabled = data === 'unlock:all';
    config.regionEnabled = data === 'unlock:all';
    saveConfig();
    edit(adminPaneText('features'), featuresKeyboard());
    return;
  }
  if (isOwner(fromId) && data === 'mnt:toggle') {
    config.maintenance = !config.maintenance;
    saveConfig();
    const kb = { inline_keyboard: [[{ text: (config.maintenance ? '🟢 تشغيل البوت' : '🔴 إيقاف مؤقت'), callback_data: 'mnt:toggle' }], [{ text: '🏠 رجوع', callback_data: 'pane:main' }]] };
    edit(adminPaneText('main'), kb);
    return;
  }
  if (isOwner(fromId) && data.startsWith('notify:')) {
    const k = data.split(':')[1];
    if (k === 'reveals') config.notifyReveals = !config.notifyReveals;
    if (k === 'joins') config.notifyJoins = !config.notifyJoins;
    saveConfig();
    edit(adminPaneText('notify'), notifyKeyboard());
    return;
  }
  if (isOwner(fromId) && data === 'cleanup:preview') {
    const ids = inactiveUserIds();
    edit((adminPaneText('cleanup')) + '\n\nالآيدي/الاسم:\n' + ids.slice(0, 8).map(i => `• <code>${i}</code> ${esc((users[i] || {}).name || '—')}`).join('\n') + (ids.length > 8 ? `\n• ... و${ids.length - 8} آخرون` : ''), cleanupKeyboard());
    return;
  }
  if (isOwner(fromId) && data === 'cleanup:go') {
    if (cleanupRunning) return;
    cleanupRunning = true;
    const ids = inactiveUserIds();
    for (const id of ids) delete users[id];
    const count = ids.length;
    saveUsers();
    cleanupRunning = false;
    edit(adminPaneText('cleanup') + `\n\n✅ تم حذف <b>${count}</b> مستخدم غير نشط.`, cleanupKeyboard());
    return;
  }
  if (isOwner(fromId) && data.startsWith('pdel:')) {
    const p = data.split(':')[1];
    delete protectedNumbers[p];
    saveProtected();
    edit(adminPaneText('protect'), protectKeyboard());
    return;
  }

  if (data === 'info:terms') {
    bot.sendMessage(chatId, TERMS_TEXT, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (data === 'info:account') {
    bot.sendMessage(chatId, accountCard(fromId), { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (data === 'info:contact') {
    bot.sendMessage(chatId, `📞 <b>تواصل مع المالك</b>\n\n${config.contact || '—'}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (data === 'noop') return;

  if (data.startsWith('pay:')) {
    const e164 = data.split(':')[1];
    if (config.perSearchStars > 0) {
      await sendStarInvoice(chatId, '⭐ بحث مميز', 'معلومات كاملة ومحدثة لهذا الرقم', e164, config.perSearchStars, `⭐ بحث مميز (${config.perSearchStars} ⭐)`);
    }
    return;
  }
  if (data.startsWith('payuser:')) {
    const qq = data.split(':')[1];
    if (config.perSearchStars > 0) {
      await sendStarInvoice(chatId, '⭐ بحث عكسي', 'بحث عكسي عن اليوزر @' + qq.replace(/^@/, ''), 'payuser:' + qq, config.perSearchStars, `⭐ بحث عكسي (${config.perSearchStars} ⭐)`);
    }
    return;
  }
  if (data === 'topup') {
    if (config.topupStars > 0 && config.topupAmount > 0) {
      await sendStarInvoice(chatId, '💎 شحن الحصة', 'إضافة ' + config.topupAmount + ' بحث إضافي إلى حصتك', 'topup', config.topupStars, `💎 شحن ${config.topupStars} ⭐`);
    }
    return;
  }
  if (data.startsWith('protect:')) {
    const e164 = data.split(':')[1];
    if (config.protectPrice > 0) {
      await sendStarInvoice(chatId, '🛡️ حماية رقم', 'حماية رقمك من البحث', 'protect:' + e164, config.protectPrice, `🛡️ حماية (${config.protectPrice} ⭐)`);
    }
    return;
  }
}

// ============================ Commands ============================

function setupCommands(bot) {
  const onText = (re, fn) => bot.onText(re, fn);

  onText(/^\/start/, onStart);
  onText(/^\/help/, onHelp);

  onText(/^\/admin$/, (msg) => {
    if (!isOwner(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, adminPaneText('main'), { parse_mode: 'HTML', reply_markup: adminMainKeyboard() }).catch(() => {});
  });

  onText(/^\/setlimit\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.dailyLimit = Math.max(0, parseInt(m[1], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ الحصة أصبحت <b>${config.dailyLimit}</b> بحث لكل ${config.quotaHours} ساعة.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/setquotahours\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.quotaHours = Math.max(1, parseInt(m[1], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ الحصة تتجدد الآن كل <b>${config.quotaHours}</b> ساعة.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/setprice\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.perSearchStars = Math.max(0, parseInt(m[1], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ سعر البحث المميز: <b>${config.perSearchStars} ⭐</b>.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/settopup\s+(\d+)\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.topupStars = Math.max(0, parseInt(m[1], 10));
    config.topupAmount = Math.max(1, parseInt(m[2], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ الشحن: <b>${config.topupStars} ⭐</b> = <b>${config.topupAmount}</b> بحث إضافي (الحصة تتجدد بعد كل ${config.quotaHours} ساعة).`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/setprotectprice\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.protectPrice = Math.max(0, parseInt(m[1], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ سعر حماية رقم المستخدم: <b>${config.protectPrice} ⭐</b>.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/setcontact\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.contact = m[1].trim();
    saveConfig();
    bot.sendMessage(msg.chat.id, '✅ تم تعيين زر التواصل: ' + esc(config.contact), { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/delcontact$/, (msg) => {
    if (!isOwner(msg.from.id)) return;
    config.contact = '';
    saveConfig();
    bot.sendMessage(msg.chat.id, '✅ تم حذف زر التواصل.').catch(() => {});
  });

  onText(/^\/protectnum\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    let e164;
    try { e164 = cleanNumber(m[1]); } catch (e) { bot.sendMessage(msg.chat.id, '⚠️ رقم غير صالح.').catch(() => {}); return; }
    protectedNumbers[e164] = { by: 'owner:' + msg.from.id, at: Date.now() };
    saveProtected();
    bot.sendMessage(msg.chat.id, `✅ تمت حماية الرقم <code>${esc(e164)}</code> من البحث.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/unprotectnum\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    let e164;
    try { e164 = cleanNumber(m[1]); } catch (e) { bot.sendMessage(msg.chat.id, '⚠️ رقم غير صالح.').catch(() => {}); return; }
    if (protectedNumbers[e164]) { delete protectedNumbers[e164]; saveProtected(); bot.sendMessage(msg.chat.id, '✅ تم فك الحماية عن الرقم.').catch(() => {}); }
    else bot.sendMessage(msg.chat.id, 'هذا الرقم غير محمي.').catch(() => {});
  });

  onText(/^\/protect$/, (msg) => {
    const u = getUser(msg.from.id);
    if (isBanned(msg.from.id)) return;
    if (isPremiumUser(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '🛡️ أرسل الرقم الذي تريد حمايته بالصيغة الدولية (+9647...)').catch(() => {});
    } else {
      bot.sendMessage(msg.chat.id, config.protectPrice > 0
        ? `🛡️ <b>حماية الرقم</b>\nأرسل الرقم المراد حمايته بالصيغة الدولية، وسيتم خصم <b>${config.protectPrice} ⭐</b> عند تأكيد الدفع.`
        : '🛡️ أرسل الرقم المراد حمايته بالصيغة الدولية (+9647...)').catch(() => {});
    }
    pendingProtect[String(msg.from.id)] = true;
  });

  onText(/^\/stats$/, (msg) => {
    if (!isOwner(msg.from.id)) return;
    const pCount = premiumUsers().length;
    const inactiveCount = inactiveUserIds().length;
    const total = Object.keys(users).length;
    const text = `📊 <b>الإحصائيات</b>
━━━━━━━━━━━━
👥 <b>المستخدمون:</b> ${total}
🟢 <b>نشط:</b> ${Math.max(0, total - inactiveCount - premiumUsers().length)}
👑 <b>مميز:</b> ${pCount}
⚪ <b>غير نشط:</b> ${inactiveCount}
🛡️ <b>محمي:</b> ${Object.keys(protectedNumbers).length}
💾 <b>التخزين:</b> ${DATA_DIR}`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/cleanup$/, async (msg) => {
    if (!isOwner(msg.from.id)) return;
    if (cleanupRunning) return;
    cleanupRunning = true;
    const ids = inactiveUserIds();
    for (const id of ids) delete users[id];
    const count = ids.length;
    saveUsers();
    cleanupRunning = false;
    bot.sendMessage(msg.chat.id, `🧹 تم حذف <b>${count}</b> مستخدم غير نشط.`).catch(() => {});
  });

  onText(/^\/premium\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    const tid = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
    if (!tid || !users[String(tid)]) { bot.sendMessage(msg.chat.id, '⚠️ لم أجد هذا المستخدم في القاعدة.').catch(() => {}); return; }
    const rec = users[String(tid)];
    rec.premium = true;
    saveUsers();
    bot.sendMessage(String(tid), '👑 <b>تهانينا!</b> تمت ترقيتك إلى المستخدمين المميزين 🌟\nالآن يمكنك البحث <b>بلا حدود</b> ورؤية كل المعلومات.').catch(() => {});
    bot.sendMessage(msg.chat.id, `✅ تم رفع <code>${tid}</code> إلى مميز.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/unpremium\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    const tid = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
    if (!tid || !users[String(tid)]) { bot.sendMessage(msg.chat.id, '⚠️ لم أجد هذا المستخدم.').catch(() => {}); return; }
    users[String(tid)].premium = false;
    saveUsers();
    bot.sendMessage(String(tid), '📉 تم إزالة ترقيتك المميزة.').catch(() => {});
    bot.sendMessage(msg.chat.id, `✅ تم إزالة مميزية <code>${tid}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/ban\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    const tid = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
    if (!tid || !users[String(tid)]) { bot.sendMessage(msg.chat.id, '⚠️ لم أجد هذا المستخدم.').catch(() => {}); return; }
    users[String(tid)].banned = true;
    saveUsers();
    bot.sendMessage(msg.chat.id, `🚫 تم حظر <code>${tid}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/unban\s+(.+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    const tid = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
    if (!tid || !users[String(tid)]) { bot.sendMessage(msg.chat.id, '⚠️ لم أجد هذا المستخدم.').catch(() => {}); return; }
    users[String(tid)].banned = false;
    saveUsers();
    bot.sendMessage(msg.chat.id, `🔓 تم فك الحظر عن <code>${tid}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/lookup\s+(.+)$/, async (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    const raw = m[1].trim();
    if (!(/^\d{5,12}$/.test(raw) || /^@?[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(raw))) {
      bot.sendMessage(msg.chat.id, '⚠️ أرسل آيدي أو يوزر.').catch(() => {});
      return;
    }
    const lk = await resolveUserCard(raw);
    if (lk.ok) {
      await safeSend(msg.chat.id, lk.text, { parse_mode: 'HTML', reply_markup: lk.link ? { inline_keyboard: [[{ text: '👤 فتح الملف الشخصي', url: lk.link }]] } : undefined });
    } else {
      const why = lk.error === 'nosession' ? 'الجلسة غير متاحة.' : (lk.error === 'notfound' ? 'لم أجد هذا اليوزر.' : 'لا يمكن الوصول لهذا المستخدم (يجب أن يكون من جهات الاتصال أو في مجموعة مشتركة مع حساب البحث).');
      bot.sendMessage(msg.chat.id, '⚠️ ' + why, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  onText(/^\/listpremium$/, (msg) => {
    if (!isOwner(msg.from.id)) return;
    const list = premiumUsers();
    bot.sendMessage(msg.chat.id, list.length ? '👑 <b>المميزون:</b>\n' + list.map(id => `• <code>${id}</code> ${esc(users[id]?.name || '')}`).join('\n') : 'لا يوجد مميزون حاليًا.', { parse_mode: 'HTML' }).catch(() => {});
  });

  onText(/^\/setcleanup\s+(\d+)$/, (msg, m) => {
    if (!isOwner(msg.from.id)) return;
    config.cleanupDays = Math.max(1, parseInt(m[1], 10));
    saveConfig();
    bot.sendMessage(msg.chat.id, `✅ تنظيف غير النشطين بعد <b>${config.cleanupDays}</b> يوم.`).catch(() => {});
  });
}

// ============================ البوت ============================

let bot = null;

function startBot() {
  bot = new TelegramBot(BOT_TOKEN, { polling: true, onlyFirstMatch: true });
  setupCommands(bot);

  bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;
    onMessage(msg);
  });

  bot.on('callback_query', (qcb) => { onCallback(qcb); });

  bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true).catch(() => {});
  });

  bot.on('successful_payment', async (msg) => {
    const from = msg.from.id;
    const payload = String(msg.successful_payment.invoice_payload || '');
    const amount = msg.successful_payment.total_amount;
    if (payload.startsWith('protect:')) {
      const e164 = payload.split(':')[1];
      protectedNumbers[e164] = { by: from, at: Date.now() };
      saveProtected();
      const u = getUser(from);
      u.paid = (u.paid || 0) + amount;
      saveUsers();
      await safeSend(from, `✅ <b>تمت حماية رقمك</b> <code>${esc(e164)}</code> 🛡️\nلن يظهر منه أي شيء بعد اليوم.`, { parse_mode: 'HTML' });
      await notifyOwner(`🛡️ <b>تم شراء حماية رقم</b>\n👤 المستخدم: <code>${from}</code>\n📱 الرقم: <code>${esc(e164)}</code>\n⭐ النجوم: ${amount}\n🕒 ${new Date().toLocaleString('ar-EG', { hour12: false })}`, { parse_mode: 'HTML' });
      return;
    }
    if (payload === 'topup') {
      const u = getUser(from);
      u.topup = (u.topup || 0) + (config.topupAmount || 1);
      u.paid = (u.paid || 0) + amount;
      saveUsers();
      const q = quotaInfo(u);
      await safeSend(from, `💎 <b>تم شحن حصتك!</b>\nأصبح لديك الآن <b>${q.left}</b> بحث متاح.\n🔁 تعود الحصة تلقائيًا بعد ${q.hours}س ${q.minutes}د.`, { parse_mode: 'HTML' });
      await notifyOwner(`💎 <b>شحن حصة</b>\n👤 المستخدم: <code>${from}</code>\n⭐ النجوم: ${amount}\n🔎 أضيف: ${config.topupAmount} بحث\n🕒 ${new Date().toLocaleString('ar-EG', { hour12: false })}`, { parse_mode: 'HTML' });
      return;
    }
    if (payload.startsWith('payuser:')) {
      const qq = payload.split(':')[1];
      const u = getUser(from);
      u.paid = (u.paid || 0) + amount;
      saveUsers();
      const res = await resolveUserCard(qq);
      if (res.ok) {
        await safeSend(from, res.text, { parse_mode: 'HTML', reply_markup: res.link ? { inline_keyboard: [[{ text: '👤 فتح الملف الشخصي', url: res.link }]] } : undefined });
        await notifyReveal(Object.assign({}, u, { id: from }), '@' + (res.username || qq), '⭐ نجوم', res.lines || []);
      } else {
        await safeSend(from, '⚠️ لم أجد هذا اليوزر.', { parse_mode: 'HTML' });
      }
      return;
    }
    const e164 = payload;
    if (e164 && /^\+?\d/.test(e164)) {
      const u = getUser(from);
      u.paid = (u.paid || 0) + amount;
      saveUsers();
      const isP = protectedNumbers[e164] || protectedNumbers[e164.replace(/^\+/, '')];
      if (isP) {
        await safeSend(from, '🔒 هذا الرقم محمي ولا يمكن عرضه.', { parse_mode: 'HTML' });
        return;
      }
      await performNumberSearch(from, e164, { paid: true, via: 'paid', userId: from });
      return;
    }
  });

  bot.on('polling_error', (err) => { console.error('⚠️ polling_error: ' + (err && err.message)); });

  console.log('🤖 البوت يعمل الآن (polling).');

  setInterval(() => {
    try { bot.getMe().catch(() => {}); } catch (e) {}
  }, 60000);
}

function stopBot() {
  if (bot) { try { bot.stopPolling(); } catch (e) {} }
}

// ============================ خادم الصحة ============================

if (require.main === module) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()), users: Object.keys(users).length }));
  }).listen(PORT, () => {
    console.log(`✅ HTTP server على المنفذ ${PORT}`);
  });
}

// ============================ الاستقرار 24/7 ============================

process.on('unhandledRejection', (err) => {
  console.error('⚠️ unhandledRejection: ' + (err && err.message));
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ uncaughtException: ' + (err && err.stack));
});
process.on('SIGTERM', () => { console.log('▪️ إيقاف SIGTERM'); stopBot(); process.exit(0); });
process.on('SIGINT', () => { console.log('▪️ إيقاف SIGINT'); stopBot(); process.exit(0); });

if (require.main === module) {
  startBot();
}

module.exports = { analyzeNumber, cleanNumber, regionFlag, lookupCarrier, buildOutput, getUser, isPremiumUser, premiumUsers, config, resolveUserCard };