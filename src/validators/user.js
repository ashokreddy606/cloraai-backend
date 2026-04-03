const { z } = require('zod');
const { objectIdSchema } = require('./common');

const updateProfileSchema = z.object({
  body: z.object({
    username: z.string().regex(/^[a-zA-Z0-9_]{3,30}$/, 'Username must be 3-30 characters and contain only letters, numbers, and underscores').optional(),
    phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format').optional().nullable(),
    bio: z.string().max(300, 'Bio is too long').optional().nullable(),
    profileImage: z.string().url('Invalid image URL').optional().nullable(),
  }),
});

const markNotificationReadSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

const logoutSessionSchema = z.object({
  body: z.object({
    sessionId: objectIdSchema,
    password: z.string().min(1, 'Password is required'),
  }),
});

const logoutAllDevicesSchema = z.object({
  body: z.object({
    password: z.string().min(1, 'Password is required'),
  }),
});

const registerPushTokenSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Push token is required'),
  }),
});

module.exports = {
  updateProfileSchema,
  markNotificationReadSchema,
  logoutSessionSchema,
  logoutAllDevicesSchema,
  registerPushTokenSchema,
};
