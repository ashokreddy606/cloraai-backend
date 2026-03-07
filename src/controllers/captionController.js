const { OpenAIApi, Configuration } = require('openai');
const { appConfig } = require('../config');
const { logAIUsage } = require('../middleware/aiLimiter');
const prisma = require('../lib/prisma');

const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY
}));

// Generate Caption using AI
const generateCaption = async (req, res) => {
  try {
    const { topic, tone = 'casual', length = 'medium' } = req.body;

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

    if (!topic) {
      return res.status(400).json({
        error: 'Topic is required'
      });
    }

    // Plan and daily cap are enforced by aiLimiter middleware before reaching here.

    // Generate caption prompt
    const prompt = `Generate an Instagram caption for a ${topic} post. 
    Tone: ${tone}
    Length: ${length}
    Include relevant hashtags at the end.
    Format: [Caption text]
    #hashtags`;

    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: length === 'short' ? 100 : length === 'long' ? 300 : 150
    });

    const caption = response.data.choices[0].message.content;

    // Log token usage AFTER successful response (sourced from OpenAI metadata, not client)
    const tokensUsed = response.data.usage?.total_tokens || 0;
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
    console.error('Generate caption error:', error.response?.data || error.message);

    // Handle OpenAI specific errors for better frontend UX
    if (error.response?.status === 401 || error.message.includes('401')) {
      return res.status(500).json({
        error: 'OpenAI Configuration Error',
        message: 'The backend OpenAI API key is invalid or missing. Please check the Railway environment variables.'
      });
    }

    if (error.response?.status === 429 || error.message.includes('429')) {
      return res.status(500).json({
        error: 'OpenAI Quota Exceeded',
        message: 'The configured OpenAI account has run out of credits or hit its rate limit.'
      });
    }

    res.status(500).json({
      error: 'Failed to generate caption',
      message: error.response?.data?.error?.message || error.message
    });
  }
};

// Get Caption History
const getCaptions = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const skip = parseInt(req.query.skip) || 0;

    const captions = await prisma.caption.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip
    });

    const total = await prisma.caption.count({
      where: { userId: req.userId }
    });

    res.status(200).json({
      success: true,
      data: {
        captions,
        pagination: {
          total,
          limit,
          skip
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch captions',
      message: error.message
    });
  }
};

// Delete Caption
const deleteCaption = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership before deleting
    const caption = await prisma.caption.findUnique({
      where: { id }
    });

    if (!caption) {
      return res.status(404).json({
        error: 'Caption not found'
      });
    }

    if (caption.userId !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only delete your own captions'
      });
    }

    await prisma.caption.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: 'Caption deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to delete caption',
      message: error.message
    });
  }
};

module.exports = {
  generateCaption,
  getCaptions,
  deleteCaption
};
