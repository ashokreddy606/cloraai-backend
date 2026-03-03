const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getTasks = async (req, res) => {
    try {
        const tasks = await prisma.calendarTask.findMany({
            where: { userId: req.userId },
            orderBy: { date: 'asc' }
        });
        res.json({ success: true, data: { tasks } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tasks', message: error.message });
    }
};

const createTask = async (req, res) => {
    try {
        const { title, date, startTime, endTime, repeat, notes, color } = req.body;
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
            }
        });
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
        res.json({ success: true, message: 'Task deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete task', message: error.message });
    }
};

module.exports = { getTasks, createTask, toggleTask, deleteTask };
