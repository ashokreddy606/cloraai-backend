const { z } = require('zod');

const recordSnapshotSchema = z.object({
  body: z.object({}).passthrough(), // Allow empty body or arbitrary data for snapshots if metrics are automated
});

const getMonthlyAnalyticsSchema = z.object({
  query: z.object({
    year: z.coerce.number().int().min(2020).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  }),
});

module.exports = {
  recordSnapshotSchema,
  getMonthlyAnalyticsSchema,
};
