require('dotenv').config();
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

(async () => {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!(apiId && apiHash)) {
    console.log('✋ ضع TELEGRAM_API_ID و TELEGRAM_API_HASH في ملف .env');
    rl.close();
    return;
  }
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await ask('أدخل رقمك مع رمز الدولة (مثل +20...): '),
    password: async () => await ask('كلمة المرور (اتركها فارغة إن لم توجد): '),
    phoneCode: async () => await ask('أدخل كود التحقق الذي وصلك: '),
    onError: (e) => console.log('خطأ:', (e && e.message) || e),
  });
  const me = await client.getEntity('me');
  console.log(
    '✅ تم تسجيل الدخول بنجاح: ' + (me.firstName || '') + ' (@' + (me.username || '') + ')'
  );
  console.log('انسخ هذا السطر وأضفه إلى ملف .env:');
  console.log('TG_SESSION=' + client.session.save());
  await client.disconnect();
  rl.close();
})();