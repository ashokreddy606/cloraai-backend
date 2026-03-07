/**
 * Subscription Service for CloraAI
 * Handles complex logic like proration and date calculations.
 */

/**
 * Calculates the new plan expiry date including proration of existing days.
 * @param {Object} user - The Prisma user record.
 * @param {number} newPlanDurationDays - The duration of the new plan in days.
 * @returns {Date} - The new calculated expiry date.
 */
const calculateProratedExpiry = (user, newPlanDurationDays) => {
    const now = new Date();
    let baseDate = now;

    // If user has an active plan and it's not expired yet
    if (
        user.plan !== 'FREE' &&
        user.planEndDate &&
        new Date(user.planEndDate) > now
    ) {
        // Start the new plan after the current one ends
        baseDate = new Date(user.planEndDate);
    }

    const newExpiry = new Date(baseDate.getTime());
    newExpiry.setDate(newExpiry.getDate() + newPlanDurationDays);

    return newExpiry;
};

module.exports = {
    calculateProratedExpiry
};
