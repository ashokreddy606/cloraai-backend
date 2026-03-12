const { enqueueJob, commentQueue } = require('./utils/queue');
const logger = require('./utils/logger');
require('dotenv').config();

/**
 * MOCK TEST SCRIPT
 * This script manually pushes a job to the BullMQ comment-queue
 * to verify if the worker picks it up and processes it.
 */
async function testQueue() {
    console.log("--- Starting Mock Queue Test ---");
    
    const mockJobData = {
        mediaId: "test_media_123",
        commentId: "test_comment_456",
        commentText: "hello world", // Ensure this matches an active rule keyword in your DB for full test
        instagramId: "test_ig_account",
        senderId: "test_sender_789",
        userId: "test_user_id", // Replace with a real User ID from your DB for rule matching
        instagramAccessToken: "test_token"
    };

    console.log("Enqueuing mock job...");
    await enqueueJob(commentQueue, 'process-comment', mockJobData);
    
    console.log("Job enqueued! Check your server/worker logs for processing output.");
    process.exit(0);
}

testQueue().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
