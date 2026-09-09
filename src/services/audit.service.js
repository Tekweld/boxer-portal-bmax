const { Op } = require("sequelize");
const { AuditLog: AuditLogModel, sequelize } = require("../database");
const { logger } = require("../logger");

let auditTableExists = null;

async function isAuditTableAvailable() {
    if (auditTableExists !== null) return auditTableExists;

    try {
        const tables = await sequelize.getQueryInterface().showAllTables();
        const tableNames = tables.map((t) => (typeof t === "string" ? t : t.tableName));
        auditTableExists = tableNames.includes(AuditLogModel.getTableName());

        if (!auditTableExists) {
            logger.warn({ message: "Tabela AuditLogs não encontrada. Logs de auditoria serão ignorados até ela ser criada." });
        }
    } catch (error) {
        logger.error({ message: "Falha ao verificar tabela AuditLogs", error: error.message });
        auditTableExists = false;
    }

    return auditTableExists;
}

async function AuditLog(req, {
    action,
    entityType = null,
    entityId = null,
    status = "success",
    metadata = {}
}) {
    if (!(await isAuditTableAvailable())) {
        return null;
    }

    const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        null;

    try {
        return await AuditLogModel.create({
            user_id: req.user?.id || null,
            username: req.user?.username || req.body?.username || null,
            role: req.user?.role || req.body?.role || null,
            action,
            entity_type: entityType,
            entity_id: entityId,
            status,
            ip_address: ip,
            user_agent: req.headers["user-agent"] || null,
            metadata
        });
    } catch (error) {
        logger.error({ message: "Falha ao registrar log de auditoria", error: error.message });
        return null;
    }
}

async function listAuditLogs({ userId, page, pageSize }) {
    if (!(await isAuditTableAvailable())) {
        return { rows: [], count: 0 };
    }

    return AuditLogModel.findAndCountAll({
        where: userId ? { user_id: userId } : {},
        order: [["createdAt", "DESC"]],
        limit: pageSize,
        offset: (page - 1) * pageSize
    });
}

async function listAuditUsers() {
    if (!(await isAuditTableAvailable())) {
        return [];
    }

    const rows = await AuditLogModel.findAll({
        attributes: ["user_id", "username", "role"],
        where: { user_id: { [Op.ne]: null } },
        group: ["user_id", "username", "role"],
        order: [["username", "ASC"]]
    });

    return rows.map((r) => ({ user_id: r.user_id, username: r.username, role: r.role }));
}

module.exports = { AuditLog, listAuditLogs, listAuditUsers };
