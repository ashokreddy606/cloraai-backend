require('dotenv').config();
const { s3Client, awsConfig } = require('../src/config/aws');
const { ListBucketsCommand } = require('@aws-sdk/client-s3');

async function testConfig() {
    console.log('--- AWS Config Test ---');
    console.log('Region:', awsConfig.region);
    console.log('Bucket:', awsConfig.bucketName);
    console.log('Access Key ID:', awsConfig.credentials.accessKeyId ? 'SET' : 'MISSING');
    console.log('Secret Access Key:', awsConfig.credentials.secretAccessKey ? 'SET' : 'MISSING');

    try {
        console.log('\nAttempting to list buckets (verifies credentials)...');
        // This might fail if the user doesn't have listBuckets permission, 
        // but even a 403 Forbidden is a good sign that the SDK connected correctly.
        const response = await s3Client.send(new ListBucketsCommand({}));
        console.log('SUCCESS! Number of buckets:', response.Buckets.length);
    } catch (err) {
        if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch') {
            console.error('FAILED! Credential Error:', err.name, err.message);
        } else if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) {
            console.log('PARTIAL SUCCESS! Connection worked, but Access Denied (expected if permissions are limited).');
        } else {
            console.error('FAILED! Unexpected Error:', err.name, err.message);
        }
    }
}

testConfig();
