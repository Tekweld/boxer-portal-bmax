const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

async function getCachedLeads(cacheKey, ttlMs = CACHE_TTL_MS) {
    const rows = await sequelize.query(
        `SELECT data, updated_at FROM leads_cache WHERE cache_key = :key LIMIT 1`,
        { replacements: { key: cacheKey }, type: QueryTypes.SELECT }
    );

    if (!rows.length) return null;

    const row = rows[0];
    const age = Date.now() - new Date(row.updated_at).getTime();

    if (age > ttlMs) return null;

    return row.data;
}

async function setCachedLeads(cacheKey, data) {
    await sequelize.query(
        `INSERT INTO leads_cache (cache_key, data, updated_at)
         VALUES (:key, :data, NOW())
         ON CONFLICT (cache_key)
         DO UPDATE SET data = :data, updated_at = NOW()`,
        { replacements: { key: cacheKey, data: JSON.stringify(data) }, type: QueryTypes.INSERT }
    );
}

async function invalidateLeadsCache() {
    await sequelize.query(`DELETE FROM leads_cache`, { type: QueryTypes.DELETE });
}

module.exports = { getCachedLeads, setCachedLeads, invalidateLeadsCache };
