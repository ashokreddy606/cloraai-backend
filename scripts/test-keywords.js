const { matchesKeyword } = require('../src/utils/automationUtils');

const tests = [
    { text: 'hello world', keyword: 'hello', expected: true },
    { text: 'hello world', keyword: 'world', expected: true },
    { text: 'hello world', keyword: 'hey', expected: false },
    { text: 'Send me the info', keyword: 'info, details', expected: true },
    { text: 'Sending the information', keyword: 'info', expected: false }, // Word boundary check
    { text: 'HELP!', keyword: 'help', expected: true },
    { text: 'price please', keyword: 'price', expected: true },
    { text: 'Is there a discount?', keyword: 'discount', expected: true }
];

console.log('Testing Keyword Matching Utility...');
let passed = 0;
tests.forEach((t, i) => {
    const result = matchesKeyword(t.text, t.keyword);
    const success = result === t.expected;
    if (success) passed++;
    console.log(`Test ${i + 1}: "${t.text}" vs "${t.keyword}" -> ${result} (${success ? '✅' : '❌'})`);
});

console.log(`\nPassed ${passed}/${tests.length} tests.`);
if (passed === tests.length) {
    process.exit(0);
} else {
    process.exit(1);
}
