const path = require("path");
const express = require("express");
const { validateEnv } = require("./config/validateEnv");
const { sequelize } = require("./database");
const app = require("./app");
const { logger } = require("./logger");

validateEnv();

app.use(express.static(path.join(__dirname, "../public")));
app.set("trust proxy", true);
app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

async function startServer() {
    try {
        // Skip sync in development to avoid enum conflicts
        // if (process.env.NODE_ENV !== "production") {
        //     await sequelize.sync({ alter: true });
        // }
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, "0.0.0.0", () => {
            logger.info({ message: "API rodando", port: PORT });
        });
    } catch (err) {
        logger.error({ message: "Erro ao iniciar servidor", error: err.message, stack: err.stack });
    }
}

startServer();
