const { analyzeNumber } = require('./bot');

const nums = [
  '+201012345678',
  '+971501234567',
  '+966551234567',
  '+12025550123',
  '+447911123456',
  '+9647701234567',
  '+213661234567',
  '+905551234567',
  '+96551123456',
];

(async () => {
  for (const n of nums) {
    const r = await analyzeNumber(n);
    if (!r.ok) {
      console.log(`\n=== ${n}: ERROR (${r.error}) ===`);
      continue;
    }
    console.log(`\n=== ${n} ===`);
    console.log(r.text);
    console.log('MAP:', r.coords ? r.coords.map((c) => c.toFixed(3)).join(', ') : 'غير متاح');
    console.log('TITLE:', r.title);
    console.log('FIELDS:', ['intl', 'e164', 'countryAr', 'typeText', 'valid'].map((k) => `${k}=${r[k]}`).join(' | '));
  }
})();