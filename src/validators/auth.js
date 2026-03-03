const { z } = require('zod');

const registerSchema = z.object({
    body: z.object({
        email: z.string().email('Invalid email address format'),
        password: z.string().min(6, 'Password must be at least 6 characters long'),
        username: z.string().min(3, 'Username must be at least 3 characters long').max(30, 'Username must not exceed 30 characters'),
        referredByCode: z.string().optional()
    })
});

const loginSchema = z.object({
    body: z.object({
        email: z.string().email('Invalid email address format'),
        password: z.string().min(1, 'Password is required'),
    })
});

const resetPasswordSchema = z.object({
    body: z.object({
        token: z.string().min(1, 'Token is required'),
        newPassword: z.string().min(6, 'Password must be at least 6 characters long')
    })
});

const googleAuthSchema = z.object({
    body: z.object({
        idToken: z.string().min(1, 'Google ID Token is required')
    })
});

module.exports = {
    registerSchema,
    loginSchema,
    resetPasswordSchema,
    googleAuthSchema
};
