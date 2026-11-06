-- Termo de Formalização Digital BPartner — Fase 1 (06/11/2026). Banco: Supabase boxer-sistemas (schema public).
-- SOMENTE tabelas novas (aditivo). RLS ativo e sem policies: só a service_role do Portal acessa (backend).

create table if not exists public.comercial_bmax_conteudos_programa (
  id uuid primary key default gen_random_uuid(),
  programa text not null,
  tema text not null,
  versao integer not null,
  corpo jsonb not null,
  publicado_em timestamptz not null default now(),
  publicado_por text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (programa, tema, versao)
);

create table if not exists public.comercial_bmax_termos (
  id uuid primary key default gen_random_uuid(),
  grupo text not null,
  programa text not null check (programa in ('bpartner_prata','bpartner_ouro','bpartner_diamante')),
  classe_antes text,
  conteudo_id uuid references public.comercial_bmax_conteudos_programa(id),
  texto_renderizado text,
  hash_sha256 text,
  status text not null default 'aguardando_revenda' check (status in
    ('rascunho','aguardando_revenda','aguardando_representante','aguardando_boxer','aguardando_compra','aprovado','encerrado_sem_compra','cancelado','expirado')),
  representante_nome text,
  representante_user_id integer,
  emitido_por text,
  compra_prazo_ate date,
  compra_confirmada_em timestamptz,
  compra_confirmada_por text,
  compra_notas text,
  comprovante_path text,
  aprovado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ativo boolean not null default true
);
create index if not exists idx_termos_grupo on public.comercial_bmax_termos (grupo);
create index if not exists idx_termos_status on public.comercial_bmax_termos (status);

create table if not exists public.comercial_bmax_termo_lojas (
  id uuid primary key default gen_random_uuid(),
  termo_id uuid not null references public.comercial_bmax_termos(id) on delete cascade,
  revenda_id uuid references public.comercial_revendas_bmax(id),
  nova_loja boolean not null default false,
  cad_nome text, cad_cnpj text, cad_endereco text, cad_cep text, cad_cidade text, cad_estado text, cad_mesorregiao text,
  classe_antes text, classe_depois text,
  inf_razao_social text, inf_cnpj text, inf_logradouro text, inf_numero text, inf_bairro text, inf_complemento text,
  inf_cep text, inf_cidade text, inf_estado text, informado_em timestamptz,
  cadastro_atualizado_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists idx_termo_lojas_termo on public.comercial_bmax_termo_lojas (termo_id);

create table if not exists public.comercial_bmax_termo_aprovacoes (
  id uuid primary key default gen_random_uuid(),
  termo_id uuid not null references public.comercial_bmax_termos(id) on delete cascade,
  etapa text not null check (etapa in ('revenda','testemunha_representante','boxer')),
  usuario_id integer,
  usuario_email text,
  nome_aprovador text not null,
  cargo text,
  cpf text,
  declaracao text,
  detalhes jsonb,
  ip_address inet,
  user_agent text,
  aprovado_em timestamptz not null default now(),
  unique (termo_id, etapa)
);

create table if not exists public.comercial_bmax_termo_auditoria (
  id uuid primary key default gen_random_uuid(),
  termo_id uuid references public.comercial_bmax_termos(id),
  evento text not null,
  ator_email text,
  ator_tipo text,
  detalhes jsonb,
  ip_address inet,
  criado_em timestamptz not null default now()
);
create index if not exists idx_termo_audit_termo on public.comercial_bmax_termo_auditoria (termo_id);

-- Trilha imutável: o próprio banco recusa UPDATE e DELETE.
create or replace function public.comercial_bmax_termo_auditoria_imutavel() returns trigger
language plpgsql as $fn$ begin raise exception 'comercial_bmax_termo_auditoria é somente inserção'; end $fn$;
drop trigger if exists trg_termo_auditoria_imutavel on public.comercial_bmax_termo_auditoria;
create trigger trg_termo_auditoria_imutavel before update or delete on public.comercial_bmax_termo_auditoria
  for each row execute function public.comercial_bmax_termo_auditoria_imutavel();

alter table public.comercial_bmax_conteudos_programa enable row level security;
alter table public.comercial_bmax_termos enable row level security;
alter table public.comercial_bmax_termo_lojas enable row level security;
alter table public.comercial_bmax_termo_aprovacoes enable row level security;
alter table public.comercial_bmax_termo_auditoria enable row level security;

-- Bucket privado dos comprovantes em PDF
insert into storage.buckets (id, name, public) values ('bmax-termos', 'bmax-termos', false) on conflict (id) do nothing;

-- Texto-base v1 (cláusulas aprovadas por André em 06/11/2026). Sem exclusividade e sem percentuais.
do $seed$
declare
  comum jsonb := jsonb_build_array(
    jsonb_build_object('titulo','Objeto','texto','Este termo formaliza a adesão do grupo {{grupo}} ao programa BPartner {{nivel}} da Boxer Soldas, nas condições da Política Comercial BMax vigente.'),
    jsonb_build_object('titulo','Lojas e dados do grupo','texto','O grupo declara que as lojas relacionadas abaixo, com seus respectivos CNPJs e endereços, são as que participam do programa:{{lojas}}'),
    jsonb_build_object('titulo','Representação','texto','O signatário declara ter poderes para representar o grupo {{grupo}} e todas as lojas relacionadas neste termo.'),
    jsonb_build_object('titulo','Condições do programa','texto','A participação observa a Política Comercial BMax vigente, que define critérios, prazos, comissões e cashback, consultáveis no Portal BMax.'),
    jsonb_build_object('titulo','Mudanças no programa','texto','O grupo está ciente de que o programa BPartner pode passar por ajustes e atualizações ao longo do tempo, e que esta adesão permanece válida sob as condições vigentes a cada momento, comunicadas pela Boxer.'),
    jsonb_build_object('titulo','Atendimento a grandes contas','texto','A Boxer valoriza o varejo e a revenda como centro de sua estratégia e mantém, em paralelo, o atendimento direto a grandes contas industriais.'),
    jsonb_build_object('titulo','Aceite eletrônico','texto','A confirmação neste ambiente, com registro de data, hora, endereço de rede e identificação do signatário, tem o valor de aceite desta adesão pelas partes.'),
    jsonb_build_object('titulo','Testemunha','texto','O representante Boxer declara ter acompanhado esta adesão e conferido os dados das lojas relacionadas.')
  );
  diamante jsonb := jsonb_build_array(
    jsonb_build_object('titulo','Aquisição das máquinas Laser','texto','A classificação Diamante depende da aquisição, pelo grupo, das duas máquinas Laser descritas na Política vigente (uma para estoque e uma para demonstração), no prazo de 30 dias contados da aprovação final da Boxer. Sem a aquisição, o grupo permanece com a classificação Ouro.'),
    jsonb_build_object('titulo','Demonstração e capacitação','texto','O grupo se compromete a dedicar um funcionário às demonstrações de produtos Laser e a enviá-lo à capacitação oferecida pela Boxer.')
  );
begin
  insert into public.comercial_bmax_conteudos_programa (programa, tema, versao, corpo, publicado_por)
  values
    ('bpartner_prata','termo_adesao',1, jsonb_build_object('titulo','Termo de Adesão — BPartner Prata','clausulas',comum),'sistema'),
    ('bpartner_ouro','termo_adesao',1, jsonb_build_object('titulo','Termo de Adesão — BPartner Ouro','clausulas',comum),'sistema'),
    ('bpartner_diamante','termo_adesao',1, jsonb_build_object('titulo','Termo de Adesão — BPartner Diamante','clausulas',comum || diamante),'sistema')
  on conflict (programa, tema, versao) do nothing;
end $seed$;

-- Interruptor do recurso (nasce DESLIGADO)
insert into public.comercial_bmax_config (chave, valor, descricao)
select 'termos_ativo','false','Termo de Formalização Digital BPartner: true liga o recurso para revendas e representantes'
where not exists (select 1 from public.comercial_bmax_config where chave = 'termos_ativo');
