const { logger } = require("../logger");

const REQUIRED = [
    "RD_CRM_TOKEN",
    "JWT_SECRET",
    "SUPABASE_ANON_KEY_SISTEMAS"
];

const REQUIRED_DB = [
    "DATABASE_URL"
];

function validateEnv() {
    const missing = [];

    REQUIRED.forEach(key => {
        if (!process.env[key]) missing.push(key);
    });

    const hasDbUrl = !!process.env.DATABASE_URL;
    const hasDbParts = process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER;

    if (!hasDbUrl && !hasDbParts) {
        missing.push("DATABASE_URL (ou DB_HOST+DB_NAME+DB_USER)");
    }

    if (missing.length > 0) {
        logger.error({ message: "Variáveis de ambiente faltando", missing });
        if (process.env.NODE_ENV === "production") {
            process.exit(1);
        }
    }
}

module.exports = { validateEnv };
