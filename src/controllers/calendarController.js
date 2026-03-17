const prisma = require('../lib/prisma');
const { cache } = require('../utils/cache');

const getTasks = async (req, res) => {
    try {
        const { platform } = req.query;
        const where = { userId: req.userId };
        if (platform && platform !== 'all') where.platform = platform;

        const tasks = await prisma.calendarTask.findMany({
            where,
            orderBy: { date: 'asc' }
        });
        res.json({ success: true, data: { tasks } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tasks', message: error.message });
    }
};

const createTask = async (req, res) => {
    try {
        const { title, date, startTime, endTime, repeat, notes, color, platform } = req.body;
        if (!title || !date) {
            return res.status(400).json({ error: 'Title and date are required' });
        }
        const task = await prisma.calendarTask.create({
            data: {
                userId: req.userId,
                title,
                date: new Date(date),
                startTime: startTime || null,
                endTime: endTime || null,
                repeat: repeat || 'one-time',
                notes: notes || null,
                color: color || '#6D28D9',
                platform: platform || 'general',
            }
        });

        // Server-side Push Notification
        const { createNotification } = require('./notificationController');
        await createNotification(req.userId, {
            type: 'schedule',
            icon: 'calendar',
            color: '#6D28D9',
            title: 'Task Created Successfully ✅',
            body: `"${title}" has been added to your calendar.`
        }).catch(err => console.warn('Push notification failed for createTask:', err.message));

        await cache.clearUserCache(req.userId);
        res.status(201).json({ success: true, data: { task } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create task', message: error.message });
    }
};

const toggleTask = async (req, res) => {
    try {
        const task = await prisma.calendarTask.findFirst({
            where: { id: req.params.id, userId: req.userId }
        });
        if (!task) return res.status(404).json({ error: 'Task not found' });

        const updated = await prisma.calendarTask.update({
            where: { id: req.params.id },
            data: { completed: !task.completed }
        });
        await cache.clearUserCache(req.userId);
        res.json({ success: true, data: { task: updated } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update task', message: error.message });
    }
};

const deleteTask = async (req, res) => {
    try {
        await prisma.calendarTask.deleteMany({
            where: { id: req.params.id, userId: req.userId }
        });
        await cache.clearUserCache(req.userId);
        res.json({ success: true, message: 'Task deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete task', message: error.message });
    }
};

const generateCalendar = async (req, res) => {
    try {
        const { platforms, postsPerWeek, preferredTimes } = req.body;
        if (!platforms || !postsPerWeek) {
            return res.status(400).json({ error: 'Platforms and postsPerWeek are required' });
        }

        const userId = req.userId;
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + 30);

        // Best time suggestions
        const defaultTimes = {
            instagram: ["10:00", "14:00", "18:00"],
            youtube: ["12:00", "19:00"]
        };

        const finalPreferredTimes = preferredTimes && preferredTimes.length > 0 ? preferredTimes : null;

        const scheduledPosts = [];
        const daysToPost = [];
        const interval = Math.floor(7 / postsPerWeek);

        for (let i = 0; i < 30; i++) {
            if (i % interval === 0 && daysToPost.length < postsPerWeek * 5) { // rough 30 days
                daysToPost.push(i);
            }
        }

        for (const dayOffset of daysToPost) {
            const date = new Date(startDate);
            date.setDate(date.getDate() + dayOffset);

            for (const platform of platforms) {
                const times = finalPreferredTimes || defaultTimes[platform] || ["12:00"];
                // Pick one time for now or spread if needed. User says "Generate schedule".
                // Let's pick the first available time for each post.
                const timeStr = times[0];
                const [hours, minutes] = timeStr.split(':');

                const scheduledAt = new Date(date);
                scheduledAt.setHours(parseInt(hours), parseInt(minutes), 0, 0);

                scheduledPosts.push({
                    userId,
                    platform,
                    mediaUrl: '', // placeholder
                    caption: `Auto-generated post for ${platform}`,
                    scheduledAt,
                    status: 'scheduled',
                    calendarDay: dayOffset + 1
                });
            }
        }

        // Save in DB
        await prisma.scheduledPost.createMany({
            data: scheduledPosts
        });

        await prisma.contentCalendar.create({
            data: {
                userId,
                startDate,
                endDate
            }
        });

        await cache.clearUserCache(req.userId);

        res.json({ success: true, message: "30-day content calendar generated" });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate calendar', message: error.message });
    }
};

const getCalendar = async (req, res) => {
    try {
        const posts = await prisma.scheduledPost.findMany({
            where: { userId: req.userId },
            orderBy: { scheduledAt: 'asc' }
        });

        const grouped = posts.reduce((acc, post) => {
            const dateStr = post.scheduledAt.toISOString().split('T')[0];
            if (!acc[dateStr]) acc[dateStr] = [];
            acc[dateStr].push({
                id: post.id,
                platform: post.platform,
                caption: post.caption,
                title: post.title,
                scheduledAt: post.scheduledAt,
                status: post.status
            });
            return acc;
        }, {});

        res.json({ success: true, data: grouped });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch calendar', message: error.message });
    }
};

const getCalendarIdeas = async (req, res) => {
    try {
        // Mock OpenAI response for now as per instructions or implement simple logic
        // In a real scenario, we'd use OpenAI API here.
        const ideas = [
            "30 Instagram Reel ideas for fitness creators.",
            "Morning routine vlog for YouTube",
            "Behind the scenes of your workstation",
            "Top 5 tools you use daily",
            "How to stay motivated while coding"
        ];
        res.json({ success: true, ideas });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch ideas', message: error.message });
    }
};

module.exports = { getTasks, createTask, toggleTask, deleteTask, generateCalendar, getCalendar, getCalendarIdeas };
