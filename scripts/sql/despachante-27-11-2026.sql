-- DESPACHANTE DOS ROBÔS (27/11/2026): reserva de rodadas, para nunca disparar a mesma rodada duas vezes. Só cria uma tabela NOVA. Reversível.
CREATE TABLE IF NOT EXISTS bmax_robo_disparo (
  robo              text        NOT NULL,           -- chave da rodada (ex.: auditor:manha, recalcular-comissoes)
  slot              timestamptz NOT NULL,           -- horário previsto da rodada (UTC)
  tentativas        integer     NOT NULL DEFAULT 0,
  ultima_tentativa  timestamptz NOT NULL DEFAULT now(),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (robo, slot)
);
-- Limpeza futura (opcional): DELETE FROM bmax_robo_disparo WHERE slot < now() - interval '30 days';
-- Reverter: DROP TABLE IF EXISTS bmax_robo_disparo;
