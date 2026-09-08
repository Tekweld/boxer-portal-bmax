const { DataTypes } = require("sequelize");

module.exports = (sequelize) => {
    const RateLimitHit = sequelize.define("RateLimitHit", {
        id: {
            type: DataTypes.BIGINT,
            autoIncrement: true,
            primaryKey: true
        },
        bucket: {
            type: DataTypes.STRING(60),
            allowNull: false
        },
        ip_address: {
            type: DataTypes.STRING(80),
            allowNull: false
        },
        created_at: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: "RateLimitHits",
        timestamps: false
    });

    return RateLimitHit;
}
