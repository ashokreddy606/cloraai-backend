const { s3Client } = require('../config/aws');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const deleteAccount = async (req, res) => {
    try {
        const { secureDeleteAccount } = require('../services/userService');
        await secureDeleteAccount(req.userId);
        res.status(200).json({ success: true, message: 'Account and associated data have been permanently deleted.' });
    } catch (error) {
        logger.error('PRIVACY', 'Delete account error:', error);
        res.status(500).json({ error: 'Failed to delete account securely' });
    }
};

const getNotifications = async (req, res) => {
    try {
        const userId = req.userId;
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 50 // Limit to last 50 for mobile performance
        });

        res.status(200).json({
            success: true,
            data: { notifications }
        });
    } catch (error) {
        logger.error('NOTIFICATION', 'Get notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
};

const markNotificationRead = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.userId;

        const notification = await prisma.notification.findUnique({ where: { id } });
        if (!notification || notification.userId !== userId) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        await prisma.notification.update({
            where: { id },
            data: { read: true }
        });

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error('NOTIFICATION', 'Mark notification read error:', error);
        res.status(500).json({ error: 'Failed to update notification' });
    }
};

module.exports = { deleteAccount, getNotifications, markNotificationRead };
