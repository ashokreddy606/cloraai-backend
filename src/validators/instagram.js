const { z } = require('zod');

const getPostInsightsSchema = z.object({
  params: z.object({
    mediaId: z.string().min(1, 'Media ID is required'),
  }),
});

const oauthCallbackSchema = z.object({
  query: z.object({
    code: z.string().min(1, 'Authorization code is required').optional(),
    state: z.string().min(1, 'State is required').optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
});

module.exports = {
  getPostInsightsSchema,
  oauthCallbackSchema,
};
