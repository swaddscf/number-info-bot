const { analyzeNumber, lookupCarrier } = require('./bot');

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
  '+14155552671',
];

let failed = 0;
let passed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✖ ' + label); }
}

console.log('=== [1] analyzeNumber: valid numbers ===');
for (const n of nums) {
  console.log('\n' + n);
  try {
    const r = analyzeNumber(n);
    assert(r && typeof r.e164 === 'string' && r.e164.startsWith('+'), 'e164 starts with +');
    assert(typeof r.intl === 'string' && r.intl.length > 5, 'intl is set: ' + r.intl);
    assert(typeof r.countryCode === 'number' && r.countryCode > 0, 'countryCode > 0: ' + r.countryCode);
    assert(typeof r.type === 'string' && r.type.length > 0, 'type set: ' + r.type);
    console.log('  ' + r.intl + ' | type=' + r.type + ' | carrier=' + (r.carrier || '(none)'));
  } catch (e) {
    failed++;
    console.log('  ✖ unexpected throw: ' + e.message);
  }
}

console.log('\n=== [2] invalid number should throw ===');
try {
  analyzeNumber('+12');
  failed++;
  console.log('  ✖ did not throw for +12');
} catch (e) {
  passed++;
  console.log('  ✔ threw: ' + e.message);
}

console.log('\n=== [3] lookupCarrier robustness ===');
try {
  const c1 = lookupCarrier('9647701234567');
  console.log('  lookupCarrier => ' + (c1 ? c1.name : 'null (carriers.json empty)'));
  assert(c1 === null || (c1 && typeof c1.name === 'string'), 'lookupCarrier returns null or carrier object');
} catch (e) {
  failed++;
  console.log('  ✖ lookupCarrier threw: ' + e.message);
}

console.log(`\n=== SUMMARY: passed=${passed} failed=${failed} ===`);
process.exit(failed > 0 ? 1 : 0);
