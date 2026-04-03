const OpenAI = require('openai');
const { createBreaker } = require('./circuitBreaker');
const logger = require('./logger');
const { logAIUsage } = require('../middleware/aiLimiter');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const openaiBreaker = createBreaker(async (params) => {
  return await openai.chat.completions.create(params);
}, 'OpenAI');

/**
 * PRODUCTION SECURITY: PROMPT SANITIZATION
 * 
 * Prevents prompt injection by stripping dangerous characters 
 * and limiting length before sending to OpenAI.
 */
const sanitizePrompt = (text, maxLength = 300) => {
    if (!text || typeof text !== 'string') return '';
    // Strip common injection patterns and limit length
    return text
        .replace(/[\{\}\[\]\(\)\<\>\\]/g, '') // Basic character stripping
        .substring(0, maxLength)
        .trim();
};

/**
 * Generate a contextual AI reply for a comment/DM.
 * 
 * @param {string} text - Incoming message text
 * @param {object} options - Contextual options (productName, description, etc.)
 * @returns {Promise<string>}
 */
const generateAIReply = async (text, options = {}) => {
  try {
    const { userId, productName, productDescription, productUrl, isDM = false } = options;
    
    // 1. Sanitize user input (Anti-Injection)
    const safeText = sanitizePrompt(text);
    if (!safeText) return null;

    let systemPrompt = `You are a helpful and professional AI assistant for a creator on Instagram. 
    Your goal is to reply to comments or DMs in a friendly, concise, and helpful manner.
    Keep the tone casual but professional.
    Response should be no more than 160 characters (to fit in DMs/SMS well).`;

    if (productName) {
        systemPrompt += `\n\nSpecific context:\nThe user is asking about: ${productName}. 
        Description: ${productDescription || 'a great product'}.
        Link: ${productUrl || ''}`;
    }

    const userPrompt = `A user ${isDM ? 'sent a DM' : 'commented'}: "${safeText}"\n\nWrite a helpful ${isDM ? 'DM' : 'comment'} reply.`;

    const response = await openaiBreaker.fire({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 150,
    }, { timeout: 15000 });

    if (response.fallback) {
      throw new Error('AI Service currently unavailable');
    }

    // 2. Log Token Usage (Cost Protection)
    if (userId && response.usage) {
        // Log feature as 'caption' if it's broad, otherwise 'brand_deal' if applicable
        const feature = options.feature || 'caption'; 
        logAIUsage(userId, feature, response.usage.total_tokens).catch(e => 
            logger.warn('AI_LOG_FAIL', 'Failed to log AI usage', { error: e.message })
        );
    }

    return response.choices[0].message.content.trim();
  } catch (error) {
    logger.error('AI_REPLY', 'Failed to generate AI reply', { error: error.message });
    return null;
  }
};

module.exports = {
  generateAIReply,
  openai // Exported if directly needed elsewhere
};
