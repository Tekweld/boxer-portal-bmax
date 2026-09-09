const winston = require("winston");

const transports = [
    new winston.transports.Console(),
];

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
    try {
        transports.push(new winston.transports.File({ filename: "logs/error.log" }));
    } catch (e) {}
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports,
});

module.exports = {
    logger
};