const validate = (schema) => async (req, res, next) => {
    try {
        const validatedData = await schema.parseAsync({
            body: req.body || {},
            query: req.query || {},
            params: req.params || {},
        });

        // Overwrite the request object with validated/stripped data
        req.body = validatedData.body;
        req.query = validatedData.query;
        req.params = validatedData.params;

        return next();
    } catch (error) {
        if (error.name === 'ZodError') {
            const issues = error.errors || error.issues || [];
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: issues.map(err => ({
                    field: err.path ? err.path.join('.') : 'unknown',
                    message: err.message,
                }))
            });
        }
        return res.status(500).json({ success: false, error: 'Internal validation error' });
    }
};

module.exports = validate;
