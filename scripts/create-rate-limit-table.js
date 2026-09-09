const { sequelize } = require("../src/database");

const sql = `
CREATE TABLE IF NOT EXISTS "RateLimitHits" (
  "id" SERIAL PRIMARY KEY,
  "bucket" VARCHAR(60) NOT NULL,
  "ip_address" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ratelimit_bucket_ip ON "RateLimitHits"(bucket, ip_address);
CREATE INDEX IF NOT EXISTS idx_ratelimit_created_at ON "RateLimitHits"(created_at);
`;

async function createRateLimitTable() {
  try {
    console.log("Criando tabela RateLimitHits...");
    await sequelize.query(sql);
    console.log("✅ Tabela RateLimitHits criada com sucesso!");
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro ao criar tabela:");
    console.error(err);
    process.exit(1);
  }
}

createRateLimitTable();
