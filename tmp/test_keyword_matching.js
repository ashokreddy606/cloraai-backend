const { matchesKeyword } = require('../src/utils/automationUtils');

const testCases = [
    { text: "send info please", keyword: "info", expected: true },
    { text: "please send info", keyword: "send info", expected: true },
    { text: "info 🔥", keyword: "info", expected: true },
    { text: "tell me more!!", keyword: "more", expected: true },
    { text: "sending information", keyword: "info", expected: true }, // "information" contains "info"
    { text: "HELLO WORLD", keyword: "hello world", expected: true },
    { text: "multi-word test", keyword: "multi-word", expected: true },
    { text: "comma, test", keyword: "comma", expected: true },
    { text: "Multiple keywords test", keyword: "missing, keywords", expected: true },
    { text: "Exact match", keyword: "exact", expected: true },
    { text: "No match here", keyword: "missing", expected: false },
];

console.log("Running Keyword Matching Tests...\n");

let passed = 0;
testCases.forEach((tc, i) => {
    const result = matchesKeyword(tc.text, tc.keyword);
    const status = result === tc.expected ? "✅ PASS" : "❌ FAIL";
    console.log(`Test ${i + 1}: [Text: "${tc.text}"] [Keyword: "${tc.keyword}"]`);
    console.log(`Expected: ${tc.expected}, Got: ${result} -> ${status}\n`);
    if (result === tc.expected) passed++;
});

console.log(`Summary: ${passed}/${testCases.length} tests passed.`);

if (passed === testCases.length) {
    console.log("\nALL TESTS PASSED! 🚀");
} else {
    console.log("\nSOME TESTS FAILED. ⚠️");
    process.exit(1);
}
