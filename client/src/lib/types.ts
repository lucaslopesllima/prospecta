export interface Recommendation {
  id: string;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  cnae_principal: number;
  municipio_id: number;
  uf: string;
  porte: string;
  capital_social: string;
  lat: number;
  lon: number;
  score: number;
  reason: {
    cnae_match: 'classe' | 'divisao' | 'secao' | 'nenhum';
    cnae_principal: number;
    distancia_km: number;
    porte: string;
    capital_social: number;
    idade_anos: number | null;
    componentes: { cnae: number; proximidade: number; porte: number; capital: number; idade: number };
  };
}

export interface Municipio { id: number; nome: string; uf: string; regiao: string }

export interface CnaeItem { codigo: number; descricao: string; secao: string; divisao: number }
export interface CnaeGrupo { divisao: number; secao: string; itens: CnaeItem[] }

export interface Stage { id: number; nome: string; ordem: number }

export interface RepresentedCompany {
  id: number; nome: string; cnpj: string | null; segmento: string | null;
  site: string | null; contato: string | null; notas: string | null; ativo: boolean;
}
export interface KanbanCard {
  id: number; company_id: number; stage_id: number | null; status: string;
  owner_user_id: number | null;
  valor_estimado: string | null; notas: string | null; razao_social: string; nome_fantasia: string | null;
  uf: string; municipio_id: number; cidade: string | null;
  cnpj: string; cnae_principal: number; porte: string; capital_social: string;
  telefone1: string | null;
  // FKs into the prospecção cadastros + their joined labels.
  represented_id: number | null; representada: string | null;
  marca_id: number | null; marca: string | null;
  contatos: { id: number; nome: string; cargo: string | null }[];
  catalogo: { id: number; nome: string; codigo: string | null; preco: string | null }[];
  amostras: { id: number; produto: string; status: string }[];
  cenario_id: number | null; cenario: string | null;
  acao_id: number | null; acao: string | null;
  // private labels da EMPRESA do card (só o /api/kanban devolve; ver KANBAN_LABELS)
  private_labels?: { id: number; nome: string; cor: string | null }[];
  data_contato: string | null; previsao_data: string | null;
  motivo_descarte: string | null;
}

export interface Socio {
  identificador: number | null; nome: string | null; cnpj_cpf: string | null;
  qualificacao: number | null; qualificacao_descricao: string | null;
  data_entrada: string | null; faixa_etaria: number | null;
  nome_representante: string | null; representante_legal: string | null;
}

export interface CompanyDetail {
  id: number; cnpj: string; razao_social: string; nome_fantasia: string | null;
  cnae_principal: number; cnae_descricao: string | null; cnae_secundarios: number[];
  uf: string; municipio_id: number | null; cidade: string | null; regiao: string;
  porte: string; capital_social: string; situacao_cadastral: string; source: string;
  logradouro: string | null; numero: string | null; complemento: string | null;
  bairro: string | null; cep: string | null;
  telefone1: string | null; telefone2: string | null; email: string | null; fax: string | null;
  data_inicio_atividade: string | null; matriz_filial: number | null;
  natureza_juridica: number | null; natureza_descricao: string | null;
  qualificacao_responsavel: number | null; qualificacao_descricao: string | null;
  ente_federativo: string | null;
  motivo_situacao: number | null; motivo_descricao: string | null;
  data_situacao_cadastral: string | null; situacao_especial: string | null;
  data_situacao_especial: string | null;
  nome_cidade_exterior: string | null; pais: number | null; pais_nome: string | null;
  opcao_simples: string | null; data_opcao_simples: string | null; data_exclusao_simples: string | null;
  opcao_mei: string | null; data_opcao_mei: string | null; data_exclusao_mei: string | null;
  lat: number | null; lon: number | null; raw_data: Record<string, unknown> | null;
  geo_lat: number | null; geo_lon: number | null; geo_precisao: string | null;
}

export interface GeocodeResult {
  lat: number; lon: number; precisao: string; fonte: string; cached: boolean;
}

export interface CatalogItem {
  id: number; nome: string; codigo: string | null; descricao: string | null;
  preco: string | null; unidade_medida: string | null; represented_id: number | null; ativo: boolean;
  // alíquotas por produto (numeric vem string do pg). null = não definido →
  // pedido cai no default da org. Ver TaxDefaults.
  icms_pct: string | null; ipi_pct: string | null; st_pct: string | null;
  pis_pct: string | null; cofins_pct: string | null; iss_pct: string | null;
}

export type SampleStatus = 'solicitada' | 'enviada' | 'recebida' | 'cancelada';
export interface SampleRequest {
  id: number; relationship_id: number; catalog_item_id: number | null; produto_snapshot: string;
  contact_id: number | null; activity_id: number | null; owner_user_id: number | null;
  status: SampleStatus; quantidade: string | null;
  data_solicitacao: string | null; data_prevista: string | null; notas: string | null;
  created_at: string; produto_codigo: string | null; contato: string | null;
  atividade_titulo: string | null; atividade_start: string | null;
}

export interface Brand { id: number; represented_id: number; nome: string }
export interface Contact {
  id: number; nome: string; cargo: string | null; email: string | null; telefone: string | null;
  company_id: number | null; represented_id: number | null; company_name?: string | null;
}
export interface NamedItem { id: number; nome: string }

// Private label = marca própria que a empresa fornece p/ terceiros marcarem.
// Org-scoped, N:N com empresas (base global) e contatos. Ver rota /api/private-labels.
export interface PrivateLabel {
  id: number; nome: string; descricao: string | null; cor: string | null;
  created_at: string; companies_count?: number; contacts_count?: number;
}
// Empresa vinculada a uma label (subset da base global RFB).
export interface PrivateLabelCompany {
  id: number; cnpj: string; razao_social: string; nome_fantasia: string | null; uf: string;
}

export interface AccountOrg {
  id: number; nome: string; cnpj: string | null; telefone: string | null;
  cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null;
  bairro: string | null; cidade: string | null; uf: string | null;
  tipo_conta: 'escritorio' | 'individual';
}
export interface AccountUser { id: number; email: string; role: string }

export interface Relationship {
  id: number; company_id: number; stage_id: number | null; status: string;
  valor_estimado: string | null; notas: string | null; razao_social: string;
}

// Cliente = company_relationship com status='cliente'. NÃO duplica a empresa:
// só referencia o registro global (company_id) e guarda o estado do tenant.
// Os campos da empresa (razao_social, cnpj, uf…) vêm do JOIN, são read-only.
export interface Cliente {
  id: number; company_id: number; status: string; ativo: boolean;
  valor_estimado: string | null; notas: string | null;
  owner_user_id: number | null; represented_id: number | null;
  representada: string | null; updated_at: string;
  contatos: { id: number; nome: string; cargo: string | null }[];
  // espelho da empresa global (apenas leitura)
  razao_social: string; nome_fantasia: string | null; cnpj: string;
  cnae_principal: number; municipio_id: number | null; uf: string;
}

export interface VisitReport { resultado: string; proximo_passo: string | null; texto: string | null }
export interface Activity {
  id: number; tipo: string; titulo: string; start_at: string; end_at: string | null;
  company_id: number | null; status: string; razao_social: string | null;
  represented_id: number | null; contact_id: number | null;
  represented_nome: string | null; contact_nome: string | null;
  checkin_lat?: number | null; checkin_lon?: number | null; checkin_at?: string | null;
  relatorio?: VisitReport | null;
}

export interface Vehicle {
  id: number; nome: string; placa: string | null;
  combustivel: 'gasolina' | 'etanol' | 'diesel' | 'flex';
  consumo_kml: string; tanque_litros: string | null; preco_litro: string | null; ativo: boolean;
}

// Empresa do funil selecionável para montar a rota (subset de GET /api/relationships).
export interface FunnelCompany {
  id: number; company_id: number; razao_social: string; nome_fantasia: string | null;
  uf: string; municipio_id: number; lat: number | null; lon: number | null;
}

export interface RouteStop {
  seq: number; company_id: number; razao_social: string; nome_fantasia: string | null;
  uf: string; cidade: string | null; lat: number; lon: number;
  leg_dist_km: number | null; leg_dur_min: number | null;
}

export interface OptimizeResult {
  origem: { lat: number; lon: number };
  stops: RouteStop[];
  dist_km: number; dur_min: number;
  preco_litro: number | null; litros: number | null; custo_total: number | null;
  geometry: { coordinates: [number, number][] };
  skipped: number[];
}

export interface SavedRoute {
  id: number; nome: string; vehicle_id: number | null; veiculo: string | null;
  dist_km: string | null; dur_min: string | null; litros: string | null;
  custo_total: string | null; template?: boolean; recorrencia?: string | null;
  created_at: string; paradas: string;
}

export interface PriceTableItem {
  id: number; catalog_item_id: number; preco: string; desconto_max_pct: string | null;
  catalog_nome: string; codigo: string | null;
}
export interface PriceTable {
  id: number; represented_id: number; nome: string;
  vigencia_inicio: string; vigencia_fim: string | null; ativo: boolean;
  created_at: string; represented_nome: string; itens: number;
  items?: PriceTableItem[];
}

export interface Carrier {
  id: number; nome: string; cnpj: string | null; telefone: string | null;
  email: string | null; contato: string | null; observacoes: string | null; ativo: boolean;
}

export type OrderStatus = 'cotacao' | 'rascunho' | 'enviado' | 'faturado' | 'entregue' | 'cancelado';
export interface OrderItem {
  id: number; catalog_item_id: number | null; descricao_snapshot: string;
  unidade_medida_snapshot: string | null;
  qtd: string; preco_unit: string; desconto_pct: string;
  icms_pct: string; ipi_pct: string; st_pct: string; pis_pct: string; cofins_pct: string; iss_pct: string;
  total: string;
}
// Alíquotas default da org (numbers; ver /api/tax-defaults).
export interface TaxDefaults {
  icms_pct: number; ipi_pct: number; st_pct: number; pis_pct: number; cofins_pct: number; iss_pct: number;
}
export interface Order {
  id: number; numero: number; relationship_id: number | null; company_id: number;
  represented_id: number; owner_user_id: number | null; price_table_id: number | null;
  status: OrderStatus; validade: string | null;
  condicao_pagamento: string | null; transportadora: string | null;
  carrier_id: number | null; carrier_nome: string | null;
  contact_id: number | null; contact_nome: string | null;
  frete: string; observacoes: string | null; total: string;
  nf_numero: string | null; emitido_em: string | null; faturado_em: string | null;
  created_at: string; updated_at: string;
  company_nome: string; company_cnpj: string; represented_nome: string;
  owner_email: string | null; owner_nome: string | null;
  items?: OrderItem[];
}

export type CommissionStatus = 'prevista' | 'recebida' | 'divergente' | 'cancelada';
export interface CommissionEntry {
  id: number; order_id: number; user_id: number | null; represented_id: number;
  competencia: string; valor_previsto: string; valor_recebido: string | null;
  percent_aplicado: string; vendedor_split_pct: string;
  status: CommissionStatus; recebida_em: string | null; observacao: string | null;
  finance_entry_id: number | null; created_at: string;
  order_numero: number; nf_numero: string | null; order_total: string;
  company_nome: string; represented_nome: string;
  vendedor_nome: string | null; vendedor_email: string | null;
  valor_vendedor: string;
}

export interface CommissionRule {
  id: number; represented_id: number; catalog_item_id: number | null;
  company_id: number | null; user_id: number | null;
  percent: string; vendedor_split_pct: string;
  vigencia_inicio: string; vigencia_fim: string | null; ativo: boolean; created_at: string;
  represented_nome: string; catalog_nome: string | null; company_nome: string | null;
  user_nome: string | null; user_email: string | null;
}

export interface OrgUser {
  id: number; nome: string | null; email: string; role: string; ativo: boolean;
  must_change_password?: boolean;
  group_id?: number | null; group_nome?: string | null;
}

// Grupo de permissões (RBAC fino). is_admin = bypass total; permissions = códigos do catálogo.
export interface PermissionGroup {
  id: number; nome: string; is_admin: boolean; permissions: string[];
  created_at: string; user_count?: number;
}

// Item do catálogo de permissões servido por GET /api/permissions/catalog.
export interface PermissionCatalogItem {
  code: string; label: string; module: string;
}

export interface Goal {
  id: number; user_id: number; represented_id: number | null;
  competencia: string; valor_meta: string; created_at: string;
  vendedor_nome: string | null; vendedor_email: string | null; represented_nome: string | null;
}

export interface GoalProgress {
  id: number; user_id: number; represented_id: number | null; competencia: string;
  valor_meta: string; realizado: number; pct: number | null;
  vendedor_nome: string | null; vendedor_email: string | null; represented_nome: string | null;
}

export interface FinanceEntry {
  id: number;
  kind: 'pagar' | 'receber';
  descricao: string;
  valor: string;
  vencimento: string;
  liquidacao_data: string | null;
  status: 'pendente' | 'liquidado' | 'cancelado';
  categoria: string | null;
  categoria_id: number | null;
  notas: string | null;
  company_id: number | null;
  represented_id: number | null;
  activity_id: number | null;
  owner_user_id: number | null;
  route_id: number | null;
  recorrencia: string | null;
  recorrencia_fim: string | null;
  recorrencia_origem_id: number | null;
  created_at: string;
  company_nome: string | null;
  represented_nome: string | null;
  activity_titulo: string | null;
  route_nome: string | null;
  categoria_nome: string | null;
  categoria_grupo_dre: string | null;
}

// Resultado da busca na base global de empresas (RFB) p/ autopreencher cadastros.
export interface CompanyHit {
  id: number;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  telefone1: string | null;
  telefone2: string | null;
  email: string | null;
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cep: string | null;
  uf: string;
  cidade: string | null;
  in_funnel?: boolean; // já tem relationship no org atual (usado p/ desativar no CompanySearch)
}

export interface FinanceCategory {
  id: number;
  nome: string;
  grupo_dre: string;
  kind: 'pagar' | 'receber' | null;
  ativo: boolean;
  created_at: string;
}

// Modelo de e-mail reutilizável (assunto + corpo) da org.
export interface EmailTemplate {
  id: number;
  nome: string;
  assunto: string;
  corpo: string;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export type EmailScheduleStatus = 'pendente' | 'enviado' | 'cancelado' | 'erro';

// E-mail agendado. company_id/empresa preenchidos quando o destinatário foi
// puxado de uma empresa da base; senão destinatario é digitado manual.
export interface EmailSchedule {
  id: number;
  template_id: number | null;
  company_id: number | null;
  empresa: string | null;
  remetente: string | null;
  destinatario: string;
  assunto: string;
  corpo: string;
  agendado_para: string;
  recorrencia: string | null;
  serie_id: string | null;
  status: EmailScheduleStatus;
  enviado_em: string | null;
  erro: string | null;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: number;
  tipo: 'vencimento' | 'agenda' | 'comissao' | 'parado';
  chave: string;
  titulo: string;
  payload: Record<string, unknown>;
  lida: boolean;
  created_at: string;
}

// WhatsApp (Evolution API). Status da conexão da instância da org.
export type WaStatus = 'desconectado' | 'conectando' | 'conectado';

export interface WaChat {
  id: number;
  remote_jid: string;
  numero: string | null;
  nome: string | null;
  foto_url: string | null;
  last_message_at: string | null;
  last_preview: string | null;
  lid: string | null;
  nao_lidas: number;
  company_id: number | null;
  relationship_id: number | null;
  company_nome: string | null;
  company_fantasia: string | null;
  contact_id: number | null;
  contact_nome: string | null;
  represented_id: number | null;
  represented_nome: string | null;
  agendamentos_pendentes: number;
}

export type WaRecorrencia = 'diaria' | 'semanal' | 'mensal' | 'anual';

export interface WaSchedule {
  id: number;
  chat_id: number | null;
  corpo: string;
  agendado_para: string;
  status: string;
  recorrencia: WaRecorrencia | null;
  serie_id: string | null;
}

export interface WaMessage {
  id: number;
  evolution_id: string | null;
  from_me: boolean;
  tipo: string; // texto|imagem|audio|video|documento
  corpo: string | null;
  status: string | null; // enviado|entregue|lido
  momento: string;
  mime: string | null;
  file_name: string | null;
  sender_nome: string | null; // atendente que enviou pelo sistema (null: recebida ou enviada pelo celular)
  internal?: boolean; // nota interna: só a equipe vê, nunca enviada ao contato
  reply_to_id?: string | number | null; // id da mensagem citada (nota pendurada)
}

export interface AuditEntry {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
  diff: unknown | null;
  created_at: string;
  user_nome: string | null;
  user_email: string | null;
}
