const OpenAI = require('openai');
const { appConfig } = require('../config');
const { logAIUsage } = require('../middleware/aiLimiter');
const prisma = require('../lib/prisma');
const { createBreaker } = require('../utils/circuitBreaker');

// OpenAI SDK v4 — clean instantiation
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const openaiBreaker = createBreaker(async (params) => {
  return await openai.chat.completions.create(params);
}, 'OpenAI');

/**
 * Sanitize AI topic input:
 *  - Strip HTML/script injection characters
 *  - Enforce 200-char max length
 */
const sanitizeTopic = (topic) => {
  if (!topic || typeof topic !== 'string') return '';
  return topic
    .replace(/[<>{}"'`;\\]/g, '') // strip injection chars
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim()
    .substring(0, 200);
};

// Generate Caption using AI
const generateCaption = async (req, res) => {
  try {
    const { topic: rawTopic, tone = 'casual', length = 'medium' } = req.body;

    if (!appConfig.featureFlags.aiCaptionsEnabled) {
      return res.status(403).json({
        error: 'Feature Disabled',
        message: 'AI Captions have been temporarily disabled by the administrator.'
      });
    }

    if (appConfig.blockedFromAI.includes(req.userId)) {
      return res.status(403).json({
        error: 'Access Denied',
        message: 'Your account has been restricted from using AI features.'
      });
    }

    if (!rawTopic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    // Sanitize and validate topic
    const topic = sanitizeTopic(rawTopic);
    if (!topic) {
      return res.status(400).json({ error: 'Topic contains invalid characters or is empty after sanitization.' });
    }

    // Plan and daily cap are enforced by aiLimiter middleware before reaching here.

    // Generate caption prompt
    const maxTokens = length === 'short' ? 100 : length === 'long' ? 300 : 150;
    const prompt = `Generate an Instagram caption for a ${topic} post. \nTone: ${tone}\nLength: ${length}\nInclude relevant hashtags at the end.\nFormat: [Caption text]\n#hashtags`;

    // OpenAI SDK v4 API call wrapped in Circuit Breaker
    const response = await openaiBreaker.fire({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: maxTokens,
    });

    if (response.fallback) {
      return res.status(503).json({
        error: 'OpenAI Unavailable',
        message: 'The AI service is currently experiencing high load or is unreachable. Please try again later.'
      });
    }

    const caption = response.choices[0].message.content;

    // Log token usage AFTER successful response
    const tokensUsed = response.usage?.total_tokens || 0;
    await logAIUsage(req.userId, 'caption', tokensUsed);

    // Extract hashtags
    const hashtagMatch = caption.match(/#[\w]+/g);
    const hashtags = hashtagMatch ? hashtagMatch.join(' ') : '';
    const captionText = caption.replace(/#[\w]+/g, '').trim();

    // Save caption to database
    const savedCaption = await prisma.caption.create({
      data: {
        userId: req.userId,
        topic,
        tone,
        length,
        content: captionText,
        hashtags
      }
    });

    res.status(201).json({
      success: true,
      data: {
        caption: {
          id: savedCaption.id,
          content: captionText,
          hashtags
        }
      }
    });
  } catch (error) {
    console.error('Generate caption error:', error.status, error.code, error.message);

    // OpenAI SDK v4 error handling
    if (error.status === 401 || error.code === 'invalid_api_key') {
      return res.status(500).json({
        error: 'OpenAI Configuration Error',
        message: 'The backend OpenAI API key is invalid or missing. Please check the Railway environment variables.'
      });
    }

    if (error.status === 429) {
      return res.status(500).json({
        error: 'OpenAI Quota Exceeded',
        message: 'The configured OpenAI account has run out of credits or hit its rate limit.'
      });
    }

    res.status(500).json({
      error: 'Failed to generate caption',
      message: 'Internal server error'
    });
  }
};

// Get Caption History
const getCaptions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const [captions, total] = await Promise.all([
      prisma.caption.findMany({
        where: { userId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip
      }),
      prisma.caption.count({ where: { userId: req.userId } })
    ]);

    res.status(200).json({
      success: true,
      data: {
        captions,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch captions',
      message: 'Internal server error'
    });
  }
};

// Delete Caption
const deleteCaption = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership before deleting
    const caption = await prisma.caption.findUnique({ where: { id } });

    if (!caption) {
      return res.status(404).json({ error: 'Caption not found' });
    }

    if (caption.userId !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only delete your own captions'
      });
    }

    await prisma.caption.delete({ where: { id } });

    res.status(200).json({
      success: true,
      message: 'Caption deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to delete caption',
      message: 'Internal server error'
    });
  }
};

// Report/Flag AI-generated Caption (Google Play Compliance)
const reportCaption = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'General concern' } = req.body;

    const caption = await prisma.caption.findUnique({ where: { id } });
    if (!caption) return res.status(404).json({ error: 'Caption not found' });

    await prisma.caption.update({
      where: { id },
      data: {
        isReported: true,
        reportReason: reason,
        reportedAt: new Date()
      }
    });

    // Optionally log to AuditLog for admins
    await prisma.auditLog.create({
      data: {
        adminId: 'system', // or logged in user if they are reporting it
        targetId: id,
        action: 'REPORT_CAPTION',
        details: JSON.stringify({ userId: req.userId, reason })
      }
    });

    res.status(200).json({
      success: true,
      message: 'Thank you. The content has been flagged for human review.'
    });
  } catch (error) {
    console.error('Report caption error:', error);
    res.status(500).json({ error: 'Failed to report caption' });
  }
};

module.exports = {
  generateCaption,
  getCaptions,
  deleteCaption,
  reportCaption
};
