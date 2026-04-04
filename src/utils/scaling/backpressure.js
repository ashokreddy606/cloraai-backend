/**
 * Backpressure System (Queue Protection)
 * Prevents the queue from exceeding safe limits and protects Redis and workers.
 */

const logger = require('../logger');

/**
 * Checks if a queue is under backpressure (overloaded).
 * @param {import('bullmq').Queue} queue - The BullMQ queue instance to check.
 * @param {number} threshold - The threshold of waiting jobs before applying backpressure.
 * @returns {Promise<{overloaded: boolean, count: number}>} - Backpressure status.
 */
const checkBackpressure = async (queue, threshold = 10000) => {
    if (!queue) return { overloaded: false, count: 0 };

    try {
        const count = await queue.getWaitingCount();
        
        if (count > threshold) {
            logger.warn('BACKPRESSURE:ACTIVE', `Queue ${queue.name} is overloaded: ${count} jobs.`, { 
                threshold, 
                current: count 
            });
            return { overloaded: true, count };
        }

        return { overloaded: false, count };
    } catch (error) {
        logger.error('BACKPRESSURE:ERROR', `Failed to check backpressure for ${queue.name}`, { error: error.message });
        return { overloaded: false, count: 0 }; // Fail-open
    }
};

module.exports = { checkBackpressure };
