/**
 * Dynamic Delay Engine (Load-Based)
 * Mimics human behavior by adjusting job delays based on queue pressure.
 */

const logger = require('../logger');

/**
 * Calculates a dynamic delay in milliseconds based on current queue size.
 * @param {import('bullmq').Queue} queue - The BullMQ queue instance to check.
 * @returns {Promise<number>} - Delay in milliseconds.
 */
const getDynamicDelay = async (queue) => {
    if (!queue) return 0;

    try {
        const count = await queue.getWaitingCount();
        let min = 2000;
        let max = 10000;

        if (count >= 500) {
            min = 30000;
            max = 90000;
        } else if (count >= 50) {
            min = 10000;
            max = 30000;
        }

        // Simulate human behavior with randomness
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        
        if (count > 50) {
            logger.debug('SCALING:DELAY_APPLIED', `Queue ${queue.name} size: ${count}. Applying ${delay}ms delay.`);
        }
        
        return delay;
    } catch (error) {
        logger.error('SCALING:DELAY_ERROR', `Failed to calculate dynamic delay for ${queue.name}`, { error: error.message });
        return 0; // Default to no delay on error
    }
};

module.exports = { getDynamicDelay };
