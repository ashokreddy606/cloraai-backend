const { z } = require('zod');

const registerSchema = z.object({
    body: z.object({
        email: z.string().email('Invalid email address format'),
        password: z.string()
            .min(8, 'Password must be at least 8 characters long')
            .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
            .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
            .regex(/[0-9]/, 'Password must contain at least one number')
            .regex(/[!@#$%^&*()_+\-=\[\]{};':",./<>?]/, 'Password must contain at least one special character'),
        username: z.string().min(3, 'Username must be at least 3 characters long').max(30, 'Username must not exceed 30 characters'),
        referredByCode: z.string().optional(),
        tosAccepted: z.boolean().refine(val => val === true, {
            message: 'You must accept the Terms of Service to register'
        })
    })
});

const loginSchema = z.object({
    body: z.object({
        email: z.string().email('Invalid email address format'),
        password: z.string().min(1, 'Password is required'),
        deviceName: z.string().optional(),
        deviceType: z.string().optional(),
        os: z.string().optional(),
    })
});

const resetPasswordSchema = z.object({
    params: z.object({
        token: z.string().min(1, 'Token is required')
    }),
    body: z.object({
        password: z.string()
            .min(8, 'Password must be at least 8 characters long')
            .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
            .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
            .regex(/[0-9]/, 'Password must contain at least one number')
            .regex(/[!@#$%^&*()_+\-=\[\]{};':",./<>?]/, 'Password must contain at least one special character')
    })
});


const googleAuthSchema = z.object({
    body: z.object({
        idToken: z.string().min(1, 'Google ID Token is required'),
        deviceName: z.string().optional(),
        deviceType: z.string().optional(),
        os: z.string().optional(),
    })
});

module.exports = {
    registerSchema,
    loginSchema,
    resetPasswordSchema,
    googleAuthSchema
};
