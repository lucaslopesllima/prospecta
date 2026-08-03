// Catálogo único de permissões do sistema. Fonte de verdade para: validação dos
// códigos salvos num grupo, seed dos grupos padrão e a matriz de checkboxes da UI
// (servida em GET /api/permissions/catalog). Convenção: `recurso.acao`.
//
// Permissão controla a AÇÃO. A visibilidade de linhas (quais registros o usuário
// enxerga) continua em scope.ts via owner_user_id/role — ortogonal a isto.

export interface Permission {
  code: string;
  label: string;
  module: 'Vendas' | 'Logística' | 'Financeiro' | 'Sistema';
}

export const PERMISSIONS: Permission[] = [
  // ── Vendas ──────────────────────────────────────────────────────────────
  { code: 'prospeccao.view', label: 'Buscar empresas / recomendações', module: 'Vendas' },

  { code: 'relationships.list', label: 'Funil/Clientes: listar', module: 'Vendas' },
  { code: 'relationships.read', label: 'Funil/Clientes: ver detalhe', module: 'Vendas' },
  { code: 'relationships.create', label: 'Funil/Clientes: criar', module: 'Vendas' },
  { code: 'relationships.update', label: 'Funil/Clientes: editar', module: 'Vendas' },
  { code: 'relationships.delete', label: 'Funil/Clientes: excluir', module: 'Vendas' },
  { code: 'relationships.import', label: 'Funil/Clientes: importar', module: 'Vendas' },
  { code: 'relationships.transfer', label: 'Funil/Clientes: transferir carteira', module: 'Vendas' },
  { code: 'carteiras.view', label: 'Carteiras: acessar', module: 'Vendas' },

  { code: 'orders.list', label: 'Pedidos: listar', module: 'Vendas' },
  { code: 'orders.read', label: 'Pedidos: ver detalhe', module: 'Vendas' },
  { code: 'orders.create', label: 'Pedidos: criar', module: 'Vendas' },
  { code: 'orders.update', label: 'Pedidos: editar', module: 'Vendas' },
  { code: 'orders.delete', label: 'Pedidos: excluir', module: 'Vendas' },
  { code: 'orders.transition', label: 'Pedidos: mudar status', module: 'Vendas' },
  { code: 'orders.import', label: 'Pedidos: importar', module: 'Vendas' },
  { code: 'orders.print', label: 'Pedidos: imprimir/exportar', module: 'Vendas' },

  { code: 'whatsapp.view', label: 'WhatsApp: ver conversas', module: 'Vendas' },
  { code: 'whatsapp.send', label: 'WhatsApp: enviar mensagem', module: 'Vendas' },
  { code: 'whatsapp.connect', label: 'WhatsApp: conectar/desconectar', module: 'Vendas' },
  { code: 'whatsapp.schedule', label: 'WhatsApp: agendar envio', module: 'Vendas' },
  { code: 'whatsapp.link', label: 'WhatsApp: vincular/mesclar/numero', module: 'Vendas' },

  { code: 'email_templates.list', label: 'E-mail templates: listar', module: 'Vendas' },
  { code: 'email_templates.create', label: 'E-mail templates: criar', module: 'Vendas' },
  { code: 'email_templates.update', label: 'E-mail templates: editar', module: 'Vendas' },
  { code: 'email_templates.delete', label: 'E-mail templates: excluir', module: 'Vendas' },
  { code: 'email_schedules.list', label: 'E-mail agendado: listar', module: 'Vendas' },
  { code: 'email_schedules.create', label: 'E-mail agendado: criar', module: 'Vendas' },
  { code: 'email_schedules.update', label: 'E-mail agendado: editar', module: 'Vendas' },
  { code: 'email_schedules.delete', label: 'E-mail agendado: excluir', module: 'Vendas' },

  { code: 'activities.list', label: 'Agenda: listar', module: 'Vendas' },
  { code: 'activities.create', label: 'Agenda: criar', module: 'Vendas' },
  { code: 'activities.update', label: 'Agenda: editar', module: 'Vendas' },
  { code: 'activities.delete', label: 'Agenda: excluir', module: 'Vendas' },
  { code: 'activities.checkin', label: 'Agenda: check-in', module: 'Vendas' },
  { code: 'activities.report', label: 'Agenda: relato de visita', module: 'Vendas' },

  // ── Logística ───────────────────────────────────────────────────────────
  { code: 'carriers.list', label: 'Transportadoras: listar', module: 'Logística' },
  { code: 'carriers.create', label: 'Transportadoras: criar', module: 'Logística' },
  { code: 'carriers.update', label: 'Transportadoras: editar', module: 'Logística' },
  { code: 'carriers.delete', label: 'Transportadoras: excluir', module: 'Logística' },

  { code: 'routes.list', label: 'Rotas: listar', module: 'Logística' },
  { code: 'routes.read', label: 'Rotas: ver detalhe', module: 'Logística' },
  { code: 'routes.create', label: 'Rotas: criar/salvar', module: 'Logística' },
  { code: 'routes.update', label: 'Rotas: editar', module: 'Logística' },
  { code: 'routes.delete', label: 'Rotas: excluir', module: 'Logística' },
  { code: 'routes.optimize', label: 'Rotas: otimizar', module: 'Logística' },
  { code: 'routes.expense', label: 'Rotas: lançar custo de viagem', module: 'Logística' },
  { code: 'routes.reuse', label: 'Rotas: reutilizar', module: 'Logística' },
  { code: 'routes.agenda', label: 'Rotas: gerar agenda', module: 'Logística' },

  { code: 'vehicles.list', label: 'Veículos: listar', module: 'Logística' },
  { code: 'vehicles.create', label: 'Veículos: criar', module: 'Logística' },
  { code: 'vehicles.update', label: 'Veículos: editar', module: 'Logística' },
  { code: 'vehicles.delete', label: 'Veículos: excluir', module: 'Logística' },

  { code: 'catalog.list', label: 'Mostruário: listar', module: 'Logística' },
  { code: 'catalog.create', label: 'Mostruário: criar', module: 'Logística' },
  { code: 'catalog.update', label: 'Mostruário: editar', module: 'Logística' },
  { code: 'catalog.delete', label: 'Mostruário: excluir', module: 'Logística' },

  { code: 'price_tables.list', label: 'Tabelas de preço: listar', module: 'Logística' },
  { code: 'price_tables.read', label: 'Tabelas de preço: ver detalhe', module: 'Logística' },
  { code: 'price_tables.create', label: 'Tabelas de preço: criar', module: 'Logística' },
  { code: 'price_tables.update', label: 'Tabelas de preço: editar', module: 'Logística' },
  { code: 'price_tables.delete', label: 'Tabelas de preço: excluir', module: 'Logística' },

  // ── Financeiro ──────────────────────────────────────────────────────────
  { code: 'commissions.list', label: 'Comissões: listar', module: 'Financeiro' },
  { code: 'commissions.settle', label: 'Comissões: baixar/receber', module: 'Financeiro' },
  { code: 'commissions.reconcile', label: 'Comissões: conciliar', module: 'Financeiro' },
  { code: 'commission_rules.list', label: 'Regras de comissão: listar', module: 'Financeiro' },
  { code: 'commission_rules.create', label: 'Regras de comissão: criar', module: 'Financeiro' },
  { code: 'commission_rules.update', label: 'Regras de comissão: editar', module: 'Financeiro' },
  { code: 'commission_rules.delete', label: 'Regras de comissão: excluir', module: 'Financeiro' },

  { code: 'finance.list', label: 'Financeiro: listar lançamentos', module: 'Financeiro' },
  { code: 'finance.read', label: 'Financeiro: ver lançamento', module: 'Financeiro' },
  { code: 'finance.create', label: 'Financeiro: criar lançamento', module: 'Financeiro' },
  { code: 'finance.update', label: 'Financeiro: editar lançamento', module: 'Financeiro' },
  { code: 'finance.delete', label: 'Financeiro: excluir lançamento', module: 'Financeiro' },
  { code: 'finance.recurrences', label: 'Financeiro: rodar recorrências', module: 'Financeiro' },
  { code: 'finance.cashflow', label: 'Financeiro: ver fluxo de caixa', module: 'Financeiro' },
  { code: 'finance.dre', label: 'Financeiro: ver DRE', module: 'Financeiro' },
  { code: 'finance_categories.list', label: 'Categorias financeiras: listar', module: 'Financeiro' },
  { code: 'finance_categories.create', label: 'Categorias financeiras: criar', module: 'Financeiro' },
  { code: 'finance_categories.update', label: 'Categorias financeiras: editar', module: 'Financeiro' },
  { code: 'finance_categories.delete', label: 'Categorias financeiras: excluir', module: 'Financeiro' },

  { code: 'reports.sales', label: 'Relatórios: vendas', module: 'Financeiro' },
  { code: 'reports.abc', label: 'Relatórios: curva ABC', module: 'Financeiro' },
  { code: 'reports.coverage', label: 'Relatórios: cobertura', module: 'Financeiro' },
  { code: 'reports.descartes', label: 'Relatórios: descartes', module: 'Financeiro' },

  // ── Sistema ─────────────────────────────────────────────────────────────
  { code: 'users.list', label: 'Equipe: listar usuários', module: 'Sistema' },
  { code: 'users.create', label: 'Equipe: criar usuário', module: 'Sistema' },
  { code: 'users.update', label: 'Equipe: editar usuário', module: 'Sistema' },
  { code: 'users.delete', label: 'Equipe: desativar usuário', module: 'Sistema' },
  { code: 'users.reset_password', label: 'Equipe: resetar senha', module: 'Sistema' },

  { code: 'goals.list', label: 'Metas: listar', module: 'Sistema' },
  { code: 'goals.create', label: 'Metas: criar', module: 'Sistema' },
  { code: 'goals.update', label: 'Metas: editar', module: 'Sistema' },
  { code: 'goals.delete', label: 'Metas: excluir', module: 'Sistema' },

  { code: 'groups.list', label: 'Grupos: listar', module: 'Sistema' },
  { code: 'groups.create', label: 'Grupos: criar', module: 'Sistema' },
  { code: 'groups.update', label: 'Grupos: editar', module: 'Sistema' },
  { code: 'groups.delete', label: 'Grupos: excluir', module: 'Sistema' },

  { code: 'represented.list', label: 'Representadas: listar', module: 'Sistema' },
  { code: 'represented.create', label: 'Representadas: criar', module: 'Sistema' },
  { code: 'represented.update', label: 'Representadas: editar', module: 'Sistema' },
  { code: 'represented.delete', label: 'Representadas: excluir', module: 'Sistema' },

  { code: 'brands.list', label: 'Marcas: listar', module: 'Sistema' },
  { code: 'brands.create', label: 'Marcas: criar', module: 'Sistema' },
  { code: 'brands.update', label: 'Marcas: editar', module: 'Sistema' },
  { code: 'brands.delete', label: 'Marcas: excluir', module: 'Sistema' },

  { code: 'contacts.list', label: 'Contatos: listar', module: 'Sistema' },
  { code: 'contacts.create', label: 'Contatos: criar', module: 'Sistema' },
  { code: 'contacts.update', label: 'Contatos: editar', module: 'Sistema' },
  { code: 'contacts.delete', label: 'Contatos: excluir', module: 'Sistema' },

  { code: 'private_labels.list', label: 'Private labels: listar', module: 'Sistema' },
  { code: 'private_labels.create', label: 'Private labels: criar', module: 'Sistema' },
  { code: 'private_labels.update', label: 'Private labels: editar', module: 'Sistema' },
  { code: 'private_labels.delete', label: 'Private labels: excluir', module: 'Sistema' },

  { code: 'scenarios.list', label: 'Cenários: listar', module: 'Sistema' },
  { code: 'scenarios.create', label: 'Cenários: criar', module: 'Sistema' },
  { code: 'scenarios.update', label: 'Cenários: editar', module: 'Sistema' },
  { code: 'scenarios.delete', label: 'Cenários: excluir', module: 'Sistema' },

  { code: 'actions.list', label: 'Ações: listar', module: 'Sistema' },
  { code: 'actions.create', label: 'Ações: criar', module: 'Sistema' },
  { code: 'actions.update', label: 'Ações: editar', module: 'Sistema' },
  { code: 'actions.delete', label: 'Ações: excluir', module: 'Sistema' },

  { code: 'stages.list', label: 'Etapas do funil: listar', module: 'Sistema' },
  { code: 'stages.create', label: 'Etapas do funil: criar', module: 'Sistema' },
  { code: 'stages.update', label: 'Etapas do funil: editar', module: 'Sistema' },
  { code: 'stages.delete', label: 'Etapas do funil: excluir', module: 'Sistema' },

  { code: 'sample_requests.list', label: 'Amostras: listar', module: 'Sistema' },
  { code: 'sample_requests.create', label: 'Amostras: criar', module: 'Sistema' },
  { code: 'sample_requests.update', label: 'Amostras: editar', module: 'Sistema' },
  { code: 'sample_requests.delete', label: 'Amostras: excluir', module: 'Sistema' },

  { code: 'tax_defaults.read', label: 'Alíquotas padrão: ver', module: 'Sistema' },
  { code: 'tax_defaults.update', label: 'Alíquotas padrão: editar', module: 'Sistema' },

  { code: 'settings.smtp.read', label: 'SMTP: ver config', module: 'Sistema' },
  { code: 'settings.smtp.update', label: 'SMTP: editar config', module: 'Sistema' },
  { code: 'settings.smtp.test', label: 'SMTP: enviar teste', module: 'Sistema' },

  { code: 'audit.read', label: 'Auditoria: consultar', module: 'Sistema' },
];

export const ALL_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);
const CODE_SET = new Set(ALL_CODES);

export function isValidCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_SET.has(code);
}

// Filtra os códigos recebidos mantendo só os válidos do catálogo (descarta
// inválidos/duplicados) — usado ao salvar um grupo.
export function sanitizeCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  return [...new Set(codes.filter(isValidCode))];
}

const byModule = (m: Permission['module']): string[] =>
  PERMISSIONS.filter((p) => p.module === m).map((p) => p.code);

// Ações de carteira ficavam restritas ao admin antes do RBAC fino — não entram
// no preset do vendedor para não afrouxar o que já era admin-only.
const ADMIN_ONLY_VENDAS = new Set(['carteiras.view', 'relationships.transfer', 'orders.import']);

// Cadastros de apoio que o funil/pedidos consomem no dia a dia (representadas,
// marcas, contatos, cenários, ações, etapas, amostras) — antes do RBAC eram só
// requireAuth, então o rep já mexia neles. Entram no Vendedor para não quebrar
// os fluxos de venda. Ficam de fora os itens de fato administrativos
// (users, groups, goals.write, commission_rules, smtp, audit, tax_defaults.update).
const VENDEDOR_CADASTROS = [
  'represented.list', 'represented.create', 'represented.update', 'represented.delete',
  'brands.list', 'brands.create', 'brands.update', 'brands.delete',
  'contacts.list', 'contacts.create', 'contacts.update', 'contacts.delete',
  'private_labels.list', 'private_labels.create', 'private_labels.update', 'private_labels.delete',
  'scenarios.list', 'scenarios.create', 'scenarios.update', 'scenarios.delete',
  'actions.list', 'actions.create', 'actions.update', 'actions.delete',
  'stages.list', 'stages.create', 'stages.update', 'stages.delete',
  'sample_requests.list', 'sample_requests.create', 'sample_requests.update', 'sample_requests.delete',
  'tax_defaults.read',
  'goals.list', 'commissions.list', 'commission_rules.list',
];

// Presets dos grupos padrão (reusados pelo seed da migração e pelos testes).
// Vendedor espelha o que o rep já fazia antes do RBAC fino — evita regressão.
export const PRESET_VENDEDOR: string[] = [
  ...new Set([
    ...byModule('Vendas').filter((c) => !ADMIN_ONLY_VENDAS.has(c)),
    ...byModule('Logística'),
    'reports.sales', 'reports.abc', 'reports.coverage', 'reports.descartes',
    'finance.list', 'finance.read',
    ...VENDEDOR_CADASTROS,
  ]),
];

export const PRESET_GERENTE: string[] = [
  ...new Set([
    ...PRESET_VENDEDOR,
    'commissions.list', 'goals.list', 'carteiras.view', 'relationships.transfer',
  ]),
];

export const PRESET_FINANCEIRO: string[] = [
  'finance.list', 'finance.read', 'finance.create', 'finance.update', 'finance.delete',
  'finance.recurrences', 'finance.cashflow', 'finance.dre',
  'finance_categories.list', 'finance_categories.create', 'finance_categories.update', 'finance_categories.delete',
  'commissions.list', 'commissions.settle', 'commissions.reconcile',
  'commission_rules.list', 'commission_rules.create', 'commission_rules.update', 'commission_rules.delete',
  'reports.sales', 'reports.abc', 'reports.coverage', 'reports.descartes',
];
