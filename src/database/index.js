const createUserModel = require("../models/User");
const createRepresentanteModel = require("../models/Representante");
const createRevendaModel = require("../models/Revenda");
const createRevendaFilialModel = require("../models/RevendaFilial");
const createNegociacaoModel = require("../models/Negociacao");
const createAuditLogModel = require("../models/AuditLog");
const createRateLimitHitModel = require("../models/RateLimitHit");
const dotenv = require("dotenv");
const { Sequelize } = require("sequelize");

dotenv.config();

const dialect = process.env.DB_DIALECT || "mysql";

const sequelize = process.env.DATABASE_URL
    ? new Sequelize(process.env.DATABASE_URL, {
        dialect: dialect,
        logging: false,
        ...(dialect === "postgres" && {
            dialectOptions: {
                ssl: { require: true, rejectUnauthorized: false }
            }
        })
    })
    : new Sequelize(
        process.env.DB_NAME,
        process.env.DB_USER,
        process.env.DB_PASS,
        {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || (dialect === "postgres" ? 5432 : 3306),
            dialect: dialect,
            logging: false,
        }
    );

// Inicializa models
const User = createUserModel(sequelize);
const Representante = createRepresentanteModel(sequelize);
const Revenda = createRevendaModel(sequelize);
const RevendaFilial = createRevendaFilialModel(sequelize);
const Negociacao = createNegociacaoModel(sequelize);
const AuditLog = createAuditLogModel(sequelize);
const RateLimitHit = createRateLimitHitModel(sequelize);

// Relacionamentos
User.hasOne(Representante, { foreignKey: "user_id" });
Representante.belongsTo(User, { foreignKey: "user_id" });
User.hasOne(Revenda, { foreignKey: "user_id" });
Revenda.belongsTo(User, { foreignKey: "user_id" });
Revenda.hasMany(RevendaFilial, { foreignKey: "user_id" });
RevendaFilial.belongsTo(Revenda, { foreignKey: "user_id" });
User.hasMany(Negociacao, { foreignKey: "user_id" });
Negociacao.belongsTo(User, { foreignKey: "user_id" });
User.hasMany(AuditLog, { foreignKey: "user_id" });
AuditLog.belongsTo(User, { foreignKey: "user_id" });

// Exporta tudo
module.exports = {
    sequelize,
    User,
    Representante,
    Revenda,
    RevendaFilial,
    Negociacao,
    AuditLog,
    RateLimitHit
};