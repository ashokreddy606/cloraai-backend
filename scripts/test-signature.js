const crypto = require('crypto');

// Simulate the signature verification logic
const verifySignature = (rawBody, signatureHeader, secret) => {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    
    const receivedSig = signatureHeader.slice('sha256='.length);
    const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(receivedSig, 'hex'),
            Buffer.from(expectedSig, 'hex')
        );
    } catch {
        return false;
    }
};

const SECRET = 'test_secret_123';
const PAYLOAD = JSON.stringify({ object: 'instagram', entry: [] });
const VALID_SIG = 'sha256=' + crypto.createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
const INVALID_SIG = 'sha256=wrong_signature';

console.log('Testing Signature Validation Logic...');
console.log('Valid Signature:', verifySignature(PAYLOAD, VALID_SIG, SECRET) ? '✅ PASS' : '❌ FAIL');
console.log('Invalid Signature:', !verifySignature(PAYLOAD, INVALID_SIG, SECRET) ? '✅ PASS' : '❌ FAIL');
console.log('Empty rawBody:', !verifySignature('', VALID_SIG, SECRET) ? '✅ PASS' : '❌ FAIL');
