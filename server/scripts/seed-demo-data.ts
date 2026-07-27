// Conteúdo curado da base de demonstração (docs/DEMO_DATA.md §9).
//
// Tudo aqui é texto escrito à mão: nome de empresa, SKU, roteiro de conversa.
// O que separa uma demo boa de uma demo óbvia é justamente isto — "Empresa 001"
// e "Produto A" denunciam o seed na primeira tela. O arranjo (quem compra o
// quê, quando, de quem) é gerado com PRNG semeada em seed-demo.ts; o vocabulário
// é fixo e revisável.
//
// Persona: escritório de representação do ramo alimentício no interior de SP.

// ------------------------------------------------------------- geografia

export interface DemoCidade { id: number; nome: string; lat: number; lon: number; ddd: string; peso: number }

// Território único e coerente (§5): 30-80 km por perna, mapa e custo de rota
// realistas. `peso` distribui os clientes — Campinas concentra, o resto orbita.
export const CIDADES: DemoCidade[] = [
  { id: 3509502, nome: 'Campinas', lat: -22.9056, lon: -47.0608, ddd: '19', peso: 26 },
  { id: 3538709, nome: 'Piracicaba', lat: -22.7338, lon: -47.6476, ddd: '19', peso: 12 },
  { id: 3526902, nome: 'Limeira', lat: -22.5660, lon: -47.3970, ddd: '19', peso: 11 },
  { id: 3501608, nome: 'Americana', lat: -22.7374, lon: -47.3331, ddd: '19', peso: 10 },
  { id: 3552403, nome: 'Sumaré', lat: -22.8204, lon: -47.2728, ddd: '19', peso: 9 },
  { id: 3520509, nome: 'Indaiatuba', lat: -23.0816, lon: -47.2101, ddd: '19', peso: 8 },
  { id: 3545803, nome: "Santa Bárbara d'Oeste", lat: -22.7553, lon: -47.4143, ddd: '19', peso: 7 },
  { id: 3519071, nome: 'Hortolândia', lat: -22.8529, lon: -47.2143, ddd: '19', peso: 6 },
  { id: 3536505, nome: 'Paulínia', lat: -22.7542, lon: -47.1488, ddd: '19', peso: 4 },
  { id: 3533403, nome: 'Nova Odessa', lat: -22.7832, lon: -47.2941, ddd: '19', peso: 4 },
  { id: 3556206, nome: 'Valinhos', lat: -22.9698, lon: -46.9974, ddd: '19', peso: 3 },
];

// Bairros reais das cidades acima — endereço plausível na tela da empresa.
export const BAIRROS = [
  'CAMBUI', 'BARAO GERALDO', 'TAQUARAL', 'JARDIM CHAPADAO', 'VILA INDUSTRIAL',
  'CENTRO', 'JARDIM AURELIA', 'NOVA CAMPINAS', 'SWIFT', 'PONTE PRETA',
  'VILA REZENDE', 'JARDIM ELITE', 'PARQUE DAS INDUSTRIAS', 'VILA SANTA CATARINA',
  'JARDIM GLORIA', 'SAO DIMAS', 'VILA MONTE ALEGRE', 'JARDIM PAULISTA',
];

export const LOGRADOUROS = [
  'RUA BARAO DE JAGUARA', 'AV JOHN BOYD DUNLOP', 'RUA CONCEICAO', 'AV ORESTES QUERCIA',
  'RUA GENERAL OSORIO', 'AV BRASIL', 'RUA JOSE PAULINO', 'AV FRANCISCO GLICERIO',
  'RUA DOUTOR QUIRINO', 'AV ANDRADE NEVES', 'RUA MOREIRA PENTEADO', 'AV SANTA ISABEL',
  'RUA SETE DE SETEMBRO', 'AV DAS AMOREIRAS', 'RUA REGENTE FEIJO', 'AV MONTE CASTELO',
];

// ------------------------------------------------------------- representadas

export interface DemoProduto {
  nome: string; codigo: string; unidade: string; preco: number;
  icms: number; st?: number; ipi?: number;
}

export interface DemoRepresentada {
  nome: string; segmento: string; site: string; contato: string; notas: string;
  ativo: boolean;
  comissao: number;          // % da regra geral (5-8% sobre mercadoria)
  marcas: string[];
  produtos: DemoProduto[];
}

const pis = 1.65, cofins = 7.6; // aplicados a todo o catálogo em seed-demo.ts

export const REPRESENTADAS: DemoRepresentada[] = [
  {
    nome: 'Laticínios Serra Azul', segmento: 'Laticínios e frios',
    site: 'https://serraazul.com.br', contato: 'Marcelo Bianchi · Gerente comercial',
    notas: 'Entrega refrigerada 2x por semana na região de Campinas. Pedido mínimo R$ 800.',
    ativo: true, comissao: 6,
    marcas: ['Serra Azul', 'Vale do Leite', 'Cremosita'],
    produtos: [
      { nome: 'Mussarela Fatiada 2kg — CX c/ 5', codigo: 'LAT-0101', unidade: 'CX', preco: 289.9, icms: 12 },
      { nome: 'Mussarela Peça 4kg', codigo: 'LAT-0102', unidade: 'KG', preco: 38.5, icms: 12 },
      { nome: 'Queijo Prato Fatiado 1kg — CX c/ 10', codigo: 'LAT-0103', unidade: 'CX', preco: 372.0, icms: 12 },
      { nome: 'Requeijão Cremoso 1,8kg', codigo: 'LAT-0104', unidade: 'UN', preco: 41.9, icms: 18 },
      { nome: 'Creme de Leite UHT 1L — CX c/ 12', codigo: 'LAT-0105', unidade: 'CX', preco: 118.8, icms: 18 },
      { nome: 'Leite Condensado 2,5kg', codigo: 'LAT-0106', unidade: 'UN', preco: 36.4, icms: 18 },
      { nome: 'Manteiga Extra c/ Sal 500g — CX c/ 12', codigo: 'LAT-0107', unidade: 'CX', preco: 264.0, icms: 12 },
      { nome: 'Iogurte Natural Integral 1kg — FD c/ 6', codigo: 'LAT-0108', unidade: 'FD', preco: 62.4, icms: 18 },
      { nome: 'Bebida Láctea Morango 900ml — FD c/ 6', codigo: 'LAT-0109', unidade: 'FD', preco: 44.7, icms: 18 },
      { nome: 'Queijo Parmesão Ralado 1kg', codigo: 'LAT-0110', unidade: 'UN', preco: 58.9, icms: 12 },
      { nome: 'Provolone Defumado Peça 3kg', codigo: 'LAT-0111', unidade: 'KG', preco: 62.0, icms: 12 },
      { nome: 'Ricota Fresca 1kg — CX c/ 8', codigo: 'LAT-0112', unidade: 'CX', preco: 156.0, icms: 12 },
      { nome: 'Cream Cheese Balde 1,8kg', codigo: 'LAT-0113', unidade: 'UN', preco: 74.5, icms: 18 },
      { nome: 'Leite UHT Integral 1L — CX c/ 12', codigo: 'LAT-0114', unidade: 'CX', preco: 62.9, icms: 12 },
      { nome: 'Doce de Leite Pastoso 5kg', codigo: 'LAT-0115', unidade: 'UN', preco: 89.9, icms: 18 },
    ],
  },
  {
    nome: 'Massas Bella Nonna', segmento: 'Massas e panificação',
    site: 'https://bellanonna.ind.br', contato: 'Íris Fontana · Diretora de vendas',
    notas: 'Fábrica em Vinhedo. Congelados saem toda terça e sexta.',
    ativo: true, comissao: 7,
    marcas: ['Bella Nonna', 'Nonna Express'],
    produtos: [
      { nome: 'Lasanha Bolonhesa 2kg — CX c/ 6', codigo: 'BNN-0201', unidade: 'CX', preco: 219.0, icms: 18 },
      { nome: 'Lasanha Quatro Queijos 2kg — CX c/ 6', codigo: 'BNN-0202', unidade: 'CX', preco: 232.0, icms: 18 },
      { nome: 'Nhoque de Batata 1kg — CX c/ 10', codigo: 'BNN-0203', unidade: 'CX', preco: 148.0, icms: 18 },
      { nome: 'Capeletti de Frango 500g — CX c/ 12', codigo: 'BNN-0204', unidade: 'CX', preco: 186.0, icms: 18 },
      { nome: 'Ravioli de Ricota 500g — CX c/ 12', codigo: 'BNN-0205', unidade: 'CX', preco: 192.0, icms: 18 },
      { nome: 'Massa Fresca Talharim 1kg — CX c/ 10', codigo: 'BNN-0206', unidade: 'CX', preco: 129.0, icms: 18 },
      { nome: 'Pão de Queijo Coquetel 1kg — FD c/ 8', codigo: 'BNN-0207', unidade: 'FD', preco: 168.0, icms: 18 },
      { nome: 'Pão Francês Pré-assado 3kg — FD c/ 4', codigo: 'BNN-0208', unidade: 'FD', preco: 96.0, icms: 12 },
      { nome: 'Pizza Broto Mussarela — CX c/ 20', codigo: 'BNN-0209', unidade: 'CX', preco: 174.0, icms: 18 },
      { nome: 'Massa de Pastel Disco 15cm — PC c/ 50', codigo: 'BNN-0210', unidade: 'PC', preco: 22.4, icms: 18 },
      { nome: 'Esfiha Aberta de Carne — CX c/ 40', codigo: 'BNN-0211', unidade: 'CX', preco: 138.0, icms: 18 },
      { nome: 'Coxinha de Frango Congelada 25g — FD c/ 100', codigo: 'BNN-0212', unidade: 'FD', preco: 92.0, icms: 18 },
      { nome: 'Croissant Congelado 60g — CX c/ 50', codigo: 'BNN-0213', unidade: 'CX', preco: 118.0, icms: 18 },
      { nome: 'Sonho Recheado Doce de Leite — CX c/ 24', codigo: 'BNN-0214', unidade: 'CX', preco: 86.0, icms: 18 },
      { nome: 'Bolo Caseiro Fubá 400g — CX c/ 8', codigo: 'BNN-0215', unidade: 'CX', preco: 78.0, icms: 18 },
    ],
  },
  {
    nome: 'Frigorífico Vale Verde', segmento: 'Carnes e congelados',
    site: 'https://valeverdealimentos.com.br', contato: 'Cláudio Bastos · Supervisor regional',
    notas: 'Trabalha com pedido programado. Carga fechada tem 4% de bonificação.',
    ativo: true, comissao: 5,
    marcas: ['Vale Verde', 'Estância Boa', 'Corte Nobre'],
    produtos: [
      { nome: 'Coxa e Sobrecoxa Congelada — CX 15kg', codigo: 'VVE-0301', unidade: 'CX', preco: 189.0, icms: 12 },
      { nome: 'Filé de Peito de Frango IQF — CX 12kg', codigo: 'VVE-0302', unidade: 'CX', preco: 288.0, icms: 12 },
      { nome: 'Linguiça Toscana 5kg — FD c/ 2', codigo: 'VVE-0303', unidade: 'FD', preco: 172.0, icms: 12 },
      { nome: 'Linguiça Calabresa Defumada 4kg', codigo: 'VVE-0304', unidade: 'UN', preco: 148.0, icms: 12 },
      { nome: 'Bacon Manta Defumado 5kg', codigo: 'VVE-0305', unidade: 'KG', preco: 32.9, icms: 12 },
      { nome: 'Hambúrguer Bovino 90g — CX c/ 56', codigo: 'VVE-0306', unidade: 'CX', preco: 164.0, icms: 12 },
      { nome: 'Carne Moída Bovina Congelada — CX 10kg', codigo: 'VVE-0307', unidade: 'CX', preco: 312.0, icms: 12 },
      { nome: 'Picanha Peça Resfriada', codigo: 'VVE-0308', unidade: 'KG', preco: 78.9, icms: 12 },
      { nome: 'Alcatra Peça Resfriada', codigo: 'VVE-0309', unidade: 'KG', preco: 46.5, icms: 12 },
      { nome: 'Costela Bovina Congelada — CX 20kg', codigo: 'VVE-0310', unidade: 'CX', preco: 428.0, icms: 12 },
      { nome: 'Pernil Suíno sem Osso — CX 15kg', codigo: 'VVE-0311', unidade: 'CX', preco: 267.0, icms: 12 },
      { nome: 'Presunto Cozido Peça 4kg', codigo: 'VVE-0312', unidade: 'KG', preco: 24.9, icms: 12 },
      { nome: 'Mortadela Defumada 3,5kg', codigo: 'VVE-0313', unidade: 'UN', preco: 62.0, icms: 12 },
      { nome: 'Salsicha Hot Dog 5kg — FD c/ 2', codigo: 'VVE-0314', unidade: 'FD', preco: 98.0, icms: 12 },
      { nome: 'Tilápia Filé Congelado — CX 10kg', codigo: 'VVE-0315', unidade: 'CX', preco: 396.0, icms: 12 },
    ],
  },
  {
    nome: 'Bebidas Água Clara', segmento: 'Bebidas',
    site: 'https://aguaclarabebidas.com.br', contato: 'Simone Rebouças · Gerente de canal',
    notas: 'Substituição tributária em todo o mix. Bonificação por ponta de gôndola negociada por trimestre.',
    ativo: true, comissao: 5,
    marcas: ['Água Clara', 'Frutz', 'Vivaz'],
    produtos: [
      { nome: 'Refrigerante Cola 2L — FD c/ 6', codigo: 'AGC-0401', unidade: 'FD', preco: 42.6, icms: 18, st: 16 },
      { nome: 'Refrigerante Guaraná 2L — FD c/ 6', codigo: 'AGC-0402', unidade: 'FD', preco: 39.9, icms: 18, st: 16 },
      { nome: 'Refrigerante Laranja 600ml — FD c/ 12', codigo: 'AGC-0403', unidade: 'FD', preco: 36.4, icms: 18, st: 16 },
      { nome: 'Água Mineral s/ Gás 500ml — FD c/ 12', codigo: 'AGC-0404', unidade: 'FD', preco: 14.9, icms: 18, st: 16 },
      { nome: 'Água Mineral c/ Gás 500ml — FD c/ 12', codigo: 'AGC-0405', unidade: 'FD', preco: 16.4, icms: 18, st: 16 },
      { nome: 'Galão de Água 20L (com vasilhame)', codigo: 'AGC-0406', unidade: 'UN', preco: 23.0, icms: 18, st: 16 },
      { nome: 'Suco de Uva Integral 1L — CX c/ 6', codigo: 'AGC-0407', unidade: 'CX', preco: 74.4, icms: 18, st: 16 },
      { nome: 'Néctar de Laranja 1L — CX c/ 12', codigo: 'AGC-0408', unidade: 'CX', preco: 68.4, icms: 18, st: 16 },
      { nome: 'Refresco em Pó Uva 1kg — FD c/ 10', codigo: 'AGC-0409', unidade: 'FD', preco: 96.0, icms: 18, st: 16 },
      { nome: 'Energético Lata 269ml — CX c/ 24', codigo: 'AGC-0410', unidade: 'CX', preco: 148.8, icms: 18, st: 16 },
      { nome: 'Chá Gelado Limão 1,5L — FD c/ 6', codigo: 'AGC-0411', unidade: 'FD', preco: 46.2, icms: 18, st: 16 },
      { nome: 'Água de Coco 1L — CX c/ 12', codigo: 'AGC-0412', unidade: 'CX', preco: 118.8, icms: 18, st: 16 },
      { nome: 'Cerveja Pilsen Lata 350ml — CX c/ 12', codigo: 'AGC-0413', unidade: 'CX', preco: 42.0, icms: 18, st: 16 },
      { nome: 'Refrigerante Cola Lata 350ml — CX c/ 12', codigo: 'AGC-0414', unidade: 'CX', preco: 34.8, icms: 18, st: 16 },
      { nome: 'Isotônico Limão 500ml — CX c/ 12', codigo: 'AGC-0415', unidade: 'CX', preco: 78.0, icms: 18, st: 16 },
    ],
  },
  {
    nome: 'Mercearia Dom Sabor', segmento: 'Mercearia seca',
    site: 'https://domsabor.com.br', contato: 'Ronaldo Prates · Gerente nacional',
    notas: 'Mix de giro alto. Tabela reajustada trimestralmente.',
    ativo: true, comissao: 8,
    marcas: ['Dom Sabor', 'Grão Real'],
    produtos: [
      { nome: 'Arroz Tipo 1 5kg — FD c/ 6', codigo: 'DSB-0501', unidade: 'FD', preco: 146.0, icms: 12 },
      { nome: 'Feijão Carioca 1kg — FD c/ 10', codigo: 'DSB-0502', unidade: 'FD', preco: 78.0, icms: 12 },
      { nome: 'Açúcar Refinado 1kg — FD c/ 10', codigo: 'DSB-0503', unidade: 'FD', preco: 44.0, icms: 12 },
      { nome: 'Óleo de Soja 900ml — CX c/ 20', codigo: 'DSB-0504', unidade: 'CX', preco: 152.0, icms: 12 },
      { nome: 'Café Torrado e Moído 500g — FD c/ 10', codigo: 'DSB-0505', unidade: 'FD', preco: 189.0, icms: 12 },
      { nome: 'Macarrão Espaguete 500g — FD c/ 20', codigo: 'DSB-0506', unidade: 'FD', preco: 82.0, icms: 12 },
      { nome: 'Molho de Tomate Sachê 340g — CX c/ 24', codigo: 'DSB-0507', unidade: 'CX', preco: 68.4, icms: 18 },
      { nome: 'Extrato de Tomate 4,1kg', codigo: 'DSB-0508', unidade: 'UN', preco: 42.9, icms: 18 },
      { nome: 'Farinha de Trigo 5kg — FD c/ 4', codigo: 'DSB-0509', unidade: 'FD', preco: 74.0, icms: 12 },
      { nome: 'Sal Refinado 1kg — FD c/ 20', codigo: 'DSB-0510', unidade: 'FD', preco: 36.0, icms: 12 },
      { nome: 'Maionese Balde 3kg', codigo: 'DSB-0511', unidade: 'UN', preco: 38.9, icms: 18 },
      { nome: 'Vinagre de Álcool 5L', codigo: 'DSB-0512', unidade: 'UN', preco: 16.4, icms: 18 },
      { nome: 'Milho Verde em Conserva 2kg — CX c/ 6', codigo: 'DSB-0513', unidade: 'CX', preco: 94.8, icms: 18 },
      { nome: 'Leite em Pó Integral 1kg — CX c/ 10', codigo: 'DSB-0514', unidade: 'CX', preco: 268.0, icms: 12 },
      { nome: 'Biscoito Cream Cracker 400g — FD c/ 20', codigo: 'DSB-0515', unidade: 'FD', preco: 96.0, icms: 18 },
    ],
  },
  {
    nome: 'Embalagens Prátika', segmento: 'Descartáveis food service',
    site: 'https://pratikaembalagens.com.br', contato: 'Vanessa Kuroda · Consultora técnica',
    notas: 'Mix de delivery. Personalização de marmitex a partir de 20 mil unidades.',
    ativo: true, comissao: 8,
    marcas: ['Prátika', 'Prátika Bio'],
    produtos: [
      { nome: 'Marmitex Alumínio N8 — CX c/ 100', codigo: 'PRK-0601', unidade: 'CX', preco: 92.0, icms: 18, ipi: 5 },
      { nome: 'Marmitex Alumínio N9 — CX c/ 100', codigo: 'PRK-0602', unidade: 'CX', preco: 108.0, icms: 18, ipi: 5 },
      { nome: 'Pote Delivery 500ml c/ Tampa — CX c/ 500', codigo: 'PRK-0603', unidade: 'CX', preco: 186.0, icms: 18, ipi: 5 },
      { nome: 'Pote Delivery 750ml c/ Tampa — CX c/ 500', codigo: 'PRK-0604', unidade: 'CX', preco: 224.0, icms: 18, ipi: 5 },
      { nome: 'Copo Descartável 200ml — FD c/ 2500', codigo: 'PRK-0605', unidade: 'FD', preco: 132.0, icms: 18, ipi: 5 },
      { nome: 'Copo Térmico 300ml — FD c/ 1000', codigo: 'PRK-0606', unidade: 'FD', preco: 178.0, icms: 18, ipi: 5 },
      { nome: 'Sacola Alça Camiseta 40x50 — FD c/ 1000', codigo: 'PRK-0607', unidade: 'FD', preco: 96.0, icms: 18 },
      { nome: 'Saco Kraft Delivery M — CX c/ 500', codigo: 'PRK-0608', unidade: 'CX', preco: 148.0, icms: 18 },
      { nome: 'Guardanapo 24x24 — FD c/ 4000', codigo: 'PRK-0609', unidade: 'FD', preco: 88.0, icms: 18 },
      { nome: 'Papel Toalha Interfolha — FD c/ 1000', codigo: 'PRK-0610', unidade: 'FD', preco: 74.0, icms: 18 },
      { nome: 'Filme PVC 28cm x 300m', codigo: 'PRK-0611', unidade: 'UN', preco: 42.0, icms: 18 },
      { nome: 'Papel Alumínio 45cm x 100m', codigo: 'PRK-0612', unidade: 'UN', preco: 58.0, icms: 18 },
      { nome: 'Talher Descartável Kit — CX c/ 1000', codigo: 'PRK-0613', unidade: 'CX', preco: 118.0, icms: 18, ipi: 5 },
      { nome: 'Embalagem Pizza 35cm — FD c/ 50', codigo: 'PRK-0614', unidade: 'FD', preco: 96.0, icms: 18 },
      { nome: 'Luva Descartável PE — CX c/ 5000', codigo: 'PRK-0615', unidade: 'CX', preco: 72.0, icms: 18 },
    ],
  },
  {
    // Representada encerrada — a tela precisa mostrar o estado "inativa" (§6).
    nome: 'Doces Villa Rica', segmento: 'Confeitaria e sobremesas',
    site: 'https://docesvillarica.com.br', contato: 'Heitor Salgado · Sócio',
    notas: 'Contrato encerrado — indústria passou a atender direto pela matriz em MG.',
    ativo: false, comissao: 6,
    marcas: ['Villa Rica'],
    produtos: [],
  },
];

export const TAXAS_PADRAO = { pis, cofins };

// ------------------------------------------------------------- empresas-cliente

export interface DemoPerfil {
  cnae: number;
  tipo: string;              // prefixo do nome fantasia
  razaoSufixo: string;       // sufixo da razão social
  ticket: [number, number];  // faixa de ticket do pedido (R$)
  peso: number;              // frequência relativa na carteira
}

// CNAEs de varejo e food service (§5) — os mesmos que a tela de Recomendação usa
// como alvo, para a prospecção no pool real bater com a carteira da demo.
export const PERFIS: DemoPerfil[] = [
  { cnae: 4711302, tipo: 'Supermercado', razaoSufixo: 'COMERCIO DE ALIMENTOS LTDA', ticket: [6000, 25000], peso: 16 },
  { cnae: 4712100, tipo: 'Mercado', razaoSufixo: 'MERCEARIA LTDA', ticket: [1500, 6000], peso: 20 },
  { cnae: 4721102, tipo: 'Padaria', razaoSufixo: 'PANIFICADORA E CONFEITARIA LTDA', ticket: [1500, 7000], peso: 18 },
  { cnae: 4722901, tipo: 'Açougue', razaoSufixo: 'COMERCIO DE CARNES LTDA', ticket: [2000, 9000], peso: 8 },
  { cnae: 4724500, tipo: 'Hortifruti', razaoSufixo: 'COMERCIO DE HORTIFRUTIGRANJEIROS LTDA', ticket: [1500, 5500], peso: 6 },
  { cnae: 5611201, tipo: 'Restaurante', razaoSufixo: 'RESTAURANTE LTDA', ticket: [1500, 8000], peso: 14 },
  { cnae: 5611203, tipo: 'Lanchonete', razaoSufixo: 'LANCHONETE LTDA', ticket: [1500, 5000], peso: 10 },
  { cnae: 4639701, tipo: 'Distribuidora', razaoSufixo: 'DISTRIBUIDORA DE ALIMENTOS LTDA', ticket: [12000, 25000], peso: 8 },
];

// Núcleos de nome combináveis com qualquer perfil ("Supermercado Bom Preço",
// "Padaria Bom Preço"): 64 × 8 perfis cobre a carteira sem sufixo numérico.
export const NUCLEOS = [
  'Bom Preço', 'Vila Nova', 'Estrela', 'São Jorge', 'Primavera', 'Bela Vista',
  'Trigo Dourado', 'Dona Zica', 'do Zé', 'Santa Clara', 'Boa Safra', 'Rei do Frango',
  'Cantinho Mineiro', 'Sabor da Terra', 'Ponto Certo', 'Nossa Senhora Aparecida',
  'Colina', 'Ipê Amarelo', 'Recanto', 'Pé de Serra', 'Bom Jardim', 'Aliança',
  'Portal', 'Jequitibá', 'Flor de Lis', 'Guanabara', 'Rosa dos Ventos', 'Paraíso',
  'Nova Aurora', 'Império', 'Vale do Sol', 'Central', 'Marambaia', 'Girassol',
  'Boa Esperança', 'Casa Grande', 'Pontal', 'Costa Verde', 'Bom Retiro', 'Rio Branco',
  'Novo Horizonte', 'Cruzeiro', 'Tijuco Preto', 'Monte Belo', 'Serra Dourada',
  'São Benedito', 'Vila Rica', 'Beira Rio', 'Ouro Verde', 'Fonte Nova', 'Alvorada',
  'Ferradura', 'Nossa Casa', 'Bandeirantes', 'Pica-Pau', 'Sete Estrelas', 'Guarani',
  'Mangueira', 'Solar', 'Terra Nova', 'Boa Sorte', 'Águia', 'Panorama', 'Cascata',
];

// Nome de pessoa para contatos, sócios e usuários da equipe fictícia.
export const PRIMEIROS = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Fábio', 'Gabriela', 'Henrique',
  'Isabela', 'João', 'Karina', 'Leandro', 'Mariana', 'Nelson', 'Olívia', 'Paulo',
  'Renata', 'Sérgio', 'Tatiane', 'Vinícius', 'Wagner', 'Yara', 'Alexandre', 'Beatriz',
  'Cristiane', 'Douglas', 'Elaine', 'Fernando', 'Giovana', 'Hélio', 'Ivone', 'Jorge',
  'Luciana', 'Marcelo', 'Natália', 'Otávio', 'Priscila', 'Rodrigo', 'Silvana', 'Thiago',
];

export const SOBRENOMES = [
  'Almeida', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Ferreira', 'Gonçalves',
  'Henriques', 'Ibrahim', 'Jesus', 'Klein', 'Lima', 'Machado', 'Nogueira', 'Oliveira',
  'Pacheco', 'Queiroz', 'Ramos', 'Siqueira', 'Teixeira', 'Uchôa', 'Vasconcelos',
  'Watanabe', 'Xavier', 'Zanetti', 'Moretti', 'Bocaiúva', 'Peçanha', 'Andrade', 'Coelho',
];

export const CARGOS = [
  'Comprador', 'Compradora', 'Gerente de loja', 'Proprietário', 'Proprietária',
  'Encarregado de compras', 'Sócio-gerente', 'Chef de cozinha', 'Nutricionista',
  'Supervisor de perecíveis', 'Gerente de perecíveis', 'Financeiro',
];

// ------------------------------------------------------------- etiquetas / funil

// Private labels: marcas de terceiros para as quais uma empresa do funil
// trabalha. É informação de cadastro, não estrutura de produto — o vínculo diz
// "essa empresa produz/fornece para a marca X", e os contatos da empresa que
// respondem por esse acordo ficam pendurados na mesma marca.
//
// `dono` é a rede detentora da marca (vai na descrição, para o nome da label
// ficar sendo só a marca, que é como o comprador se refere a ela).
export const PRIVATE_LABELS: { nome: string; cor: string; dono: string }[] = [
  { nome: 'Seleção Prime', cor: '#6366f1', dono: 'Rede Mercantil Sul' },
  { nome: 'Nossa Mesa', cor: '#10b981', dono: 'Supermercados Andorinha' },
  { nome: 'Prato Cheio', cor: '#f59e0b', dono: 'Atacadão Boa Compra' },
  { nome: 'Vale Frios', cor: '#ef4444', dono: 'Rede Poupe Mais' },
];

export const CENARIOS = ['Abertura de loja', 'Troca de fornecedor', 'Ampliação de mix', 'Recompra programada'];
export const ACOES = ['Visita presencial', 'Ligação', 'Envio de tabela', 'Degustação', 'Proposta enviada'];

export const MOTIVOS_DESCARTE = [
  'Comprou de concorrente com prazo maior',
  'Loja fechou as portas',
  'Fora do território de entrega da representada',
  'Sem interesse no mix — trabalha só com marca própria',
  'Restrição de crédito',
];

export const NOTAS_FUNIL = [
  'Comprador só atende terça e quinta de manhã.',
  'Pediu tabela com prazo de 28 dias para fechar.',
  'Interessado no mix de congelados, quer degustação antes.',
  'Já trabalha com a concorrência — entrada pelo mix de laticínios.',
  'Rede em expansão, abre loja nova no próximo trimestre.',
  'Precisa de nota com desconto de bonificação destacado.',
  'Compra centralizada: decisão passa pela matriz.',
  'Pediu prioridade de entrega às segundas.',
];

// ------------------------------------------------------------- financeiro

export const CATEGORIAS_FINANCEIRAS: { nome: string; grupo: string; kind: 'pagar' | 'receber' | null }[] = [
  { nome: 'Comissões recebidas', grupo: 'Receita de representação', kind: 'receber' },
  { nome: 'Bonificações', grupo: 'Receita de representação', kind: 'receber' },
  { nome: 'Aluguel do escritório', grupo: 'Despesa fixa', kind: 'pagar' },
  { nome: 'Telefonia e internet', grupo: 'Despesa fixa', kind: 'pagar' },
  { nome: 'Software e assinaturas', grupo: 'Despesa fixa', kind: 'pagar' },
  { nome: 'Contabilidade', grupo: 'Despesa fixa', kind: 'pagar' },
  { nome: 'Combustível', grupo: 'Despesa variável', kind: 'pagar' },
  { nome: 'Manutenção de veículo', grupo: 'Despesa variável', kind: 'pagar' },
  { nome: 'Alimentação em viagem', grupo: 'Despesa variável', kind: 'pagar' },
  { nome: 'Material de degustação', grupo: 'Despesa variável', kind: 'pagar' },
  { nome: 'Pró-labore', grupo: 'Pessoal', kind: 'pagar' },
  { nome: 'Impostos e taxas', grupo: 'Impostos', kind: 'pagar' },
];

// Modelos mensais (recorrencia='mensal'): o seed cria o lançamento do mês de
// origem e recurrence.ts materializa os meses seguintes.
export const DESPESAS_FIXAS: { descricao: string; categoria: string; valor: number; dia: number }[] = [
  { descricao: 'Aluguel do escritório — Cambuí', categoria: 'Aluguel do escritório', valor: 3800, dia: 5 },
  { descricao: 'Internet fibra + linhas móveis', categoria: 'Telefonia e internet', valor: 689.9, dia: 10 },
  { descricao: 'Assinatura Rovva + Google Workspace', categoria: 'Software e assinaturas', valor: 428, dia: 12 },
  { descricao: 'Honorários contábeis', categoria: 'Contabilidade', valor: 1250, dia: 15 },
  { descricao: 'Pró-labore sócio', categoria: 'Pró-labore', valor: 9500, dia: 5 },
  { descricao: 'Simples Nacional — DAS', categoria: 'Impostos e taxas', valor: 2380, dia: 20 },
];

export const DESPESAS_VARIAVEIS = [
  { descricao: 'Combustível — rota Piracicaba/Limeira', categoria: 'Combustível', faixa: [280, 520] },
  { descricao: 'Combustível — rota Campinas/Sumaré', categoria: 'Combustível', faixa: [180, 340] },
  { descricao: 'Almoço com comprador', categoria: 'Alimentação em viagem', faixa: [90, 240] },
  { descricao: 'Kit de degustação — congelados', categoria: 'Material de degustação', faixa: [220, 680] },
  { descricao: 'Revisão e troca de óleo', categoria: 'Manutenção de veículo', faixa: [420, 890] },
  { descricao: 'Pedágio e estacionamento', categoria: 'Combustível', faixa: [60, 180] },
] as const;

// ------------------------------------------------------------- transportadoras / veículos

export const TRANSPORTADORAS = [
  { nome: 'Expresso Caminho Real', contato: 'Ubirajara Neves', obs: 'Coleta diária até as 16h. Entrega D+1 na região.' },
  { nome: 'Translog Interior', contato: 'Marta Bevilacqua', obs: 'Refrigerado. Exige agendamento para rede.' },
  { nome: 'Rodofrio Transportes', contato: 'Anderson Piovezan', obs: 'Congelados. Carga fechada apenas.' },
  { nome: 'Via Norte Cargas', contato: 'Sandra Kimura', obs: 'Fracionado. Entrega em até 72h.' },
];

export const VEICULOS = [
  { nome: 'Fiat Cronos 1.3 — Ricardo', placa: 'FGH2B34', combustivel: 'flex', consumo: 12.4, tanque: 48, preco: 5.89 },
  { nome: 'VW Polo 1.0 TSI — Juliana', placa: 'JKL5C67', combustivel: 'gasolina', consumo: 13.8, tanque: 52, preco: 6.12 },
  { nome: 'Renault Kwid — Marcos', placa: 'MNP8D90', combustivel: 'flex', consumo: 15.1, tanque: 38, preco: 5.89 },
];

// ------------------------------------------------------------- agenda

export const TITULOS_VISITA = [
  'Visita de reposição', 'Apresentação de tabela nova', 'Degustação de congelados',
  'Negociação de ponta de gôndola', 'Alinhamento de mix', 'Visita pós-venda',
  'Cobrança de pedido programado', 'Reunião com comprador da rede',
];

export const TITULOS_LIGACAO = [
  'Ligação de follow-up', 'Confirmar pedido programado', 'Cobrar retorno da proposta',
  'Checar recebimento da carga', 'Agendar degustação',
];

export const TITULOS_TAREFA = [
  'Montar proposta de mix', 'Conferir tabela reajustada', 'Enviar catálogo atualizado',
  'Fechar romaneio da semana', 'Conciliar comissões do mês',
];

export const RELATORIOS_VISITA: { resultado: string; proximo: string; texto: string }[] = [
  {
    resultado: 'Pedido fechado',
    proximo: 'Acompanhar faturamento e data de entrega',
    texto: 'Comprador aprovou o mix de laticínios. Fechou com prazo de 28 dias e pediu entrega dividida em duas cargas.',
  },
  {
    resultado: 'Proposta em análise',
    proximo: 'Retornar em 7 dias com a tabela revisada',
    texto: 'Gôndola bem abastecida, sem ruptura. Pediu revisão do preço do queijo prato antes de fechar.',
  },
  {
    resultado: 'Sem pedido',
    proximo: 'Nova visita no próximo ciclo',
    texto: 'Loja com estoque alto de congelados. Combinamos retorno depois da virada do mês.',
  },
  {
    resultado: 'Degustação realizada',
    proximo: 'Enviar proposta com bonificação de entrada',
    texto: 'Equipe da cozinha aprovou o pão de queijo coquetel. Chef pediu preço para volume mensal.',
  },
  {
    resultado: 'Ruptura identificada',
    proximo: 'Emitir pedido de reposição urgente',
    texto: 'Duas faces vazias no refrigerado. Encarregado autorizou reposição imediata pelo mesmo preço da última nota.',
  },
  {
    resultado: 'Pedido fechado',
    proximo: 'Enviar espelho da nota por WhatsApp',
    texto: 'Recompra do mix de mercearia seca. Cliente pediu para manter a mesma condição de pagamento.',
  },
];

// ------------------------------------------------------------- e-mail

export const EMAIL_TEMPLATES = [
  {
    nome: 'Apresentação do escritório',
    assunto: 'Sabor & Cia Representações — mix de alimentos para {{empresa}}',
    corpo: 'Olá, {{contato}}!\n\nSou representante da Sabor & Cia e atendo a região de Campinas com laticínios, '
      + 'congelados, massas, bebidas e mercearia seca.\n\nPosso passar na {{empresa}} esta semana para apresentar '
      + 'a tabela e deixar amostras?\n\nAbraço,\n{{vendedor}}',
  },
  {
    nome: 'Envio de tabela vigente',
    assunto: 'Tabela vigente — {{representada}}',
    corpo: 'Oi, {{contato}},\n\nSegue em anexo a tabela vigente da {{representada}}, válida até o fim do mês.\n\n'
      + 'Pedido mínimo de R$ 800 e entrega em até 48h para a região.\n\nQualquer dúvida é só chamar.\n\n{{vendedor}}',
  },
  {
    nome: 'Follow-up de proposta',
    assunto: 'Retomando nossa conversa — proposta {{empresa}}',
    corpo: 'Bom dia, {{contato}}!\n\nPassando para saber se conseguiu avaliar a proposta que enviei.\n\n'
      + 'Consigo segurar a condição de pagamento até sexta-feira.\n\nAbraço,\n{{vendedor}}',
  },
  {
    nome: 'Aviso de reajuste de tabela',
    assunto: 'Reajuste de tabela a partir do próximo mês',
    corpo: 'Olá, {{contato}},\n\nA {{representada}} reajusta a tabela no dia 1º. Pedidos colocados até o fim desta '
      + 'semana entram no preço atual.\n\nSe quiser, monto o pedido programado hoje mesmo.\n\n{{vendedor}}',
  },
];

// ------------------------------------------------------------- WhatsApp

export interface DemoMsg {
  me?: boolean;              // from_me (saiu do escritório)
  t?: string;                // corpo
  midia?: 'foto' | 'pdf' | 'audio';
  arquivo?: string;          // file_name da mídia
  nota?: boolean;            // internal = true (balão âmbar, nunca sai)
  resp?: number;             // índice da mensagem respondida DENTRO do roteiro
  min?: number;              // minutos decorridos desde a mensagem anterior
}

export interface DemoRoteiro { assunto: string; msgs: DemoMsg[] }

// Roteiros curados (§8) — um por conversa. O motivo de serem escritos e não
// gerados: o visitante LÊ o balão. Frase genérica ("mensagem de teste 12")
// derruba a demo inteira, mesmo com o resto do banco perfeito.
export const ROTEIROS: DemoRoteiro[] = [
  {
    assunto: 'Reposição de pedido',
    msgs: [
      { t: 'Bom dia! Preciso repor mussarela e requeijão, tá acabando aqui.' },
      { me: true, t: 'Bom dia! Já anoto. Fecho igual ao último pedido, 8 caixas de mussarela fatiada e 24 requeijão?', min: 9 },
      { t: 'Isso, mas sobe pra 10 caixas de mussarela. Semana que vem tem promoção na loja.', min: 6 },
      { me: true, t: 'Fechado. 10 CX de mussarela fatiada 2kg e 24 UN de requeijão 1,8kg.', min: 3 },
      { me: true, t: 'Mesma condição de sempre, 28 dias?', min: 1 },
      { t: 'Pode ser. E a entrega, sai quando?', min: 14 },
      { me: true, t: 'Coleta hoje ainda, entrega quinta de manhã pela Translog.', min: 4 },
      { t: 'Perfeito. Manda o espelho quando faturar.', min: 2 },
      { me: true, t: 'Combinado 👍', min: 1 },
      { me: true, t: 'Pedido lançado. Segue o espelho.', midia: 'pdf', arquivo: 'pedido-reposicao.pdf', min: 96 },
      { t: 'Recebi, obrigado!', min: 38 },
      { nota: true, t: 'Cliente aumentou 25% o volume de mussarela por causa da promoção da loja. Vale checar ruptura na semana que vem.' },
    ],
  },
  {
    assunto: 'Negociação de tabela',
    msgs: [
      { t: 'Oi, recebi a tabela nova. O queijo prato subiu bastante, né?' },
      { me: true, t: 'Subiu 6% na indústria. Te mando a tabela vigente pra conferir item a item.', min: 11 },
      { me: true, midia: 'pdf', arquivo: 'tabela-serra-azul.pdf', t: 'Tabela vigente — Laticínios Serra Azul', min: 2 },
      { t: 'Nesse preço eu não consigo girar. A concorrência tá 4% abaixo.', min: 22 },
      { me: true, t: 'Consigo trabalhar com desconto de 3% no fechamento de 15 caixas. Acima disso preciso pedir aprovação.', min: 7 },
      { t: 'Vê o que consegue. Se chegar em 5% eu fecho 20 caixas hoje.', min: 5 },
      { me: true, t: 'Vou falar com o Marcelo da indústria e te retorno ainda hoje.', min: 3 },
      { nota: true, t: 'Pedir 5% pro Marcelo. Cliente tem histórico de recompra mensal, compensa mesmo com margem menor.' },
      { me: true, t: 'Consegui os 5% pra fechamento de 20 caixas, válido até sexta.', min: 214 },
      { t: 'Boa! Pode lançar então.', min: 46 },
      { me: true, t: 'Lançado. Entrega terça pela manhã.', min: 6 },
      { t: 'Show. Obrigado pela força!', min: 12 },
    ],
  },
  {
    assunto: 'Foto de gôndola e ruptura',
    msgs: [
      { me: true, t: 'Passei aqui na loja agora, olha como tá a gôndola do refrigerado.' },
      { me: true, midia: 'foto', arquivo: 'gondola-refrigerado.png', min: 1 },
      { me: true, t: 'Duas faces vazias no prato fatiado e o requeijão acabou.', min: 1 },
      { t: 'Eita. O pessoal não me avisou.', min: 17 },
      { me: true, t: 'Consigo emergencial pra amanhã se você autorizar agora.', min: 2 },
      { t: 'Autorizo. Manda 6 caixas de prato e 12 requeijão.', min: 4 },
      { me: true, t: 'Lançando. Mesmo preço da última nota.', min: 2 },
      { t: 'Combinado.', min: 1 },
      { me: true, t: 'Pedido #— saiu. Amanhã antes das 11h tá na loja.', min: 33 },
      { t: 'Valeu mesmo. Semana que vem me passa de novo pra conferir.', min: 88 },
      { me: true, t: 'Passo sim, já agendei aqui na minha rota de quarta.', min: 5 },
    ],
  },
  {
    assunto: 'Cobrança de boleto',
    msgs: [
      { me: true, t: 'Oi, tudo bem? O boleto do pedido do mês passado venceu ontem.' },
      { t: 'Opa, deixa eu ver com o financeiro.', min: 41 },
      { t: 'Achei aqui. Foi pro e-mail errado, por isso não pagou.', min: 96 },
      { me: true, t: 'Sem problema. Reenvio pro e-mail do financeiro que você me passar.', min: 8 },
      { t: 'financeiro@ — pode mandar pra lá.', min: 3 },
      { me: true, t: 'Enviado com a segunda via e o vencimento prorrogado pra sexta.', min: 22 },
      { t: 'Perfeito, sexta paga.', min: 15 },
      { nota: true, t: 'Título vencido regularizado. Mantive a etiqueta de inadimplente até a baixa entrar.' },
      { me: true, t: 'Boleto baixado hoje. Obrigado!', min: 4310 },
      { t: '👍', min: 62 },
    ],
  },
  {
    assunto: 'Agendamento de visita',
    msgs: [
      { me: true, t: 'Bom dia! Consigo passar aí quinta de manhã pra apresentar o mix de congelados.' },
      { t: 'Quinta tá corrido. Sexta às 9h resolve?', min: 27 },
      { me: true, t: 'Resolve. Sexta 9h então, já anotei na agenda.', min: 4 },
      { t: 'Beleza. Traz amostra de hambúrguer e linguiça.', min: 2 },
      { me: true, t: 'Levo. Deixo também a tabela impressa.', min: 2 },
      { t: 'Ótimo.', min: 1 },
      { me: true, t: 'Bom dia! Confirmando nossa visita hoje às 9h.', min: 2760 },
      { t: 'Confirmado, te espero.', min: 26 },
      { me: true, t: 'Obrigado pelo tempo hoje. Segue a proposta com a bonificação de entrada.', min: 320 },
      { me: true, midia: 'pdf', arquivo: 'proposta-congelados.pdf', min: 1 },
      { t: 'Vou avaliar com meu sócio e te falo até segunda.', min: 74 },
    ],
  },
  {
    assunto: 'Amostra de produto novo',
    msgs: [
      { me: true, t: 'Chegou lançamento da Bella Nonna: pão de queijo coquetel 1kg.' },
      { me: true, t: 'Quer que eu deixe uma amostra pra cozinha testar?', min: 1 },
      { t: 'Quero sim. O chef tava procurando alguma coisa pro café da manhã do buffet.', min: 34 },
      { me: true, t: 'Deixo na terça junto com a entrega. Solicitei 2 fardos de amostra.', min: 6 },
      { t: 'Show.', min: 2 },
      { me: true, t: 'Amostra saiu hoje da fábrica, chega terça.', min: 1620 },
      { t: 'Chegou certinho. Chef aprovou, quer preço pra volume mensal.', min: 3120 },
      { me: true, t: 'Ótima notícia! Pra 20 fardos/mês fecho a R$ 159 o fardo.', min: 12 },
      { t: 'Fechado. Começa mês que vem.', min: 48 },
      { me: true, t: 'Perfeito, já deixo o pedido programado montado.', min: 5 },
      { nota: true, t: 'Converter em pedido programado mensal — 20 FD de pão de queijo coquetel.' },
    ],
  },
  {
    assunto: 'Reclamação de prazo de entrega',
    msgs: [
      { t: 'A carga não chegou. Era pra ter entregue ontem.' },
      { me: true, t: 'Vou checar agora com a transportadora e já te falo.', min: 4 },
      { me: true, t: 'A Rodofrio teve quebra no caminhão em Limeira. Remanejaram pra hoje à tarde.', min: 26 },
      { t: 'Isso me atrapalha o fim de semana. Já tinha vendido metade.', min: 3 },
      { me: true, t: 'Entendo. Consegui prioridade na descarga, entrega até as 15h.', min: 8 },
      { me: true, t: 'E pedi 2% de bonificação pelo atraso, entra na próxima nota.', min: 2 },
      { t: 'Assim melhora. Fico no aguardo.', min: 11 },
      { me: true, t: 'Entregue às 14h20. Confere pra mim?', min: 372 },
      { t: 'Confirmado, chegou tudo certo. Obrigado por resolver rápido.', min: 42 },
      { nota: true, t: 'Segunda ocorrência da Rodofrio no mês. Levar pro alinhamento com a representada.' },
    ],
  },
  {
    assunto: 'Pedido programado',
    msgs: [
      { me: true, t: 'Bom dia! Fechando o programado desta semana.' },
      { me: true, t: 'Mantenho arroz 5kg (12 FD), feijão (10 FD) e óleo (6 CX)?', min: 1 },
      { t: 'Sobe o óleo pra 8 caixas, o resto mantém.', min: 52 },
      { me: true, t: 'Ajustado. Total fica em R$ 3.412,00 com frete CIF.', min: 4 },
      { t: 'Pode faturar.', min: 3 },
      { me: true, t: 'Faturado. NF 18.442, entrega quarta.', min: 64 },
      { t: 'Anotado 👍', min: 22 },
      { me: true, t: 'Bom dia! Programado da semana, mesma grade?', min: 10080 },
      { t: 'Mesma, pode lançar.', min: 34 },
      { me: true, t: 'Lançado.', min: 3 },
    ],
  },
  {
    assunto: 'Abertura de loja nova',
    msgs: [
      { t: 'Oi! Abrimos a segunda loja em Sumaré mês que vem.' },
      { me: true, t: 'Que ótima notícia! Já pensou na grade de abertura?', min: 7 },
      { t: 'Ainda não. Queria uma sugestão de mix pro refrigerado e mercearia.', min: 4 },
      { me: true, t: 'Monto uma proposta de abertura com as duas representadas e te mando amanhã.', min: 6 },
      { t: 'Perfeito. E consigo prazo maior na primeira compra?', min: 3 },
      { me: true, t: 'Consigo 42 dias na carga de abertura. Depois volta pro padrão de 28.', min: 4 },
      { t: 'Fechou. Manda a proposta.', min: 2 },
      { me: true, midia: 'pdf', arquivo: 'proposta-abertura-sumare.pdf', t: 'Proposta de abertura — loja Sumaré', min: 1180 },
      { t: 'Recebido. Vou olhar com calma e te retorno.', min: 190 },
      { nota: true, t: 'Oportunidade grande — carga de abertura estimada em R$ 22 mil. Subir no funil.' },
      { me: true, t: 'Sem pressa. Qualquer ajuste no mix é só falar.', min: 14 },
    ],
  },
  {
    assunto: 'Confirmação de recebimento',
    msgs: [
      { me: true, t: 'Boa tarde! A carga da Vale Verde chegou hoje?' },
      { t: 'Chegou. Só veio uma caixa de hambúrguer a menos.', min: 88 },
      { me: true, t: 'Vou conferir o romaneio. Você assinou o canhoto com ressalva?', min: 5 },
      { t: 'Assinei, sim. Anotei a diferença.', min: 3 },
      { me: true, t: 'Perfeito, é o que precisava. Abro a ocorrência com a indústria.', min: 2 },
      { me: true, t: 'Me manda uma foto do canhoto?', min: 1 },
      { midia: 'foto', arquivo: 'canhoto-nf.png', min: 26 },
      { me: true, t: 'Recebi. Já registrei a ocorrência, a caixa entra na próxima entrega sem custo.', min: 18, resp: 6 },
      { t: 'Obrigado!', min: 9 },
    ],
  },
  {
    assunto: 'Áudio do comprador',
    msgs: [
      { t: 'Rapidinho, deixa eu te mandar um áudio que é mais fácil.' },
      { midia: 'audio', arquivo: 'audio-comprador.wav', min: 1 },
      { me: true, t: 'Escutei. Então: 4 caixas de linguiça toscana e 3 de calabresa, certo?', min: 14 },
      { t: 'Isso mesmo. E se tiver bacon manta manda 20kg.', min: 5 },
      { me: true, t: 'Tem sim. Lanço tudo junto.', min: 2 },
      { me: true, t: 'Total R$ 1.918,00, entrega quinta.', min: 8 },
      { t: 'Ok!', min: 21 },
    ],
  },
  {
    assunto: 'Troca de fornecedor',
    msgs: [
      { me: true, t: 'Boa tarde! Vi que vocês trabalham com bebidas de outra distribuidora.' },
      { t: 'Trabalhamos, mas o atendimento tá ruim. Sumiram faz duas semanas.', min: 62 },
      { me: true, t: 'Represento a Água Clara na região. Posso te passar a tabela?', min: 4 },
      { t: 'Pode. Me interessa refrigerante 2L e água 500ml.', min: 8 },
      { me: true, midia: 'pdf', arquivo: 'tabela-agua-clara.pdf', t: 'Tabela vigente — Bebidas Água Clara', min: 12 },
      { t: 'O preço tá competitivo. Qual o pedido mínimo?', min: 44 },
      { me: true, t: 'R$ 600 pra entrega em 48h na sua região.', min: 3 },
      { t: 'Vou fazer um teste com 10 fardos de cola 2L e 10 de água.', min: 6 },
      { me: true, t: 'Ótimo! Lançando como primeiro pedido, entrega quarta.', min: 3 },
      { nota: true, t: 'Entrada nova pela linha de bebidas. Se o teste rodar, oferecer o mix de sucos.' },
      { t: 'Perfeito.', min: 4 },
    ],
  },
  {
    assunto: 'Grupo de compradores da rede',
    msgs: [
      { t: 'Pessoal, a grade de abril precisa sair até sexta.' },
      { me: true, t: 'Bom dia a todos! Já montei a sugestão pras 4 lojas.', min: 18 },
      { me: true, midia: 'pdf', arquivo: 'grade-abril-rede.pdf', t: 'Grade sugerida — abril', min: 1 },
      { t: 'A loja do Taquaral tá com sobra de congelado, reduz lá.', min: 34 },
      { me: true, t: 'Reduzo 30% na grade do Taquaral e mantenho o resto.', min: 6 },
      { t: 'E o preço do queijo, ficou o mesmo da última?', min: 12 },
      { me: true, t: 'Mesmo preço, segurei a tabela anterior até o fim do mês.', min: 4, resp: 5 },
      { t: 'Ótimo. Pode fechar assim.', min: 9 },
      { me: true, t: 'Fechado. Faturo hoje e as cargas saem escalonadas por loja.', min: 3 },
      { t: 'Valeu!', min: 15 },
    ],
  },
  {
    assunto: 'Grupo interno da equipe',
    msgs: [
      { me: true, t: 'Bom dia, equipe! Fechamos o mês 12% acima da meta 🎉' },
      { me: true, t: 'Destaque pro mix de congelados, cresceu 22% no trimestre.', min: 2 },
      { me: true, t: 'Lembrando: a tabela da Serra Azul reajusta dia 1º. Quem tiver proposta aberta, feche até sexta.', min: 46 },
      { me: true, t: 'Alguém consegue cobrir a rota de Piracicaba na quinta? Tenho reunião na matriz.', min: 128 },
      { me: true, t: 'Eu pego. Já tenho duas visitas por lá mesmo.', min: 22 },
      { me: true, t: 'Fechado, obrigado!', min: 4 },
      { me: true, t: 'Romaneio da semana está fechado. Segue o resumo.', min: 1440 },
      { me: true, midia: 'pdf', arquivo: 'romaneio-semana.pdf', min: 1 },
    ],
  },
  {
    assunto: 'Contato novo sem cadastro',
    msgs: [
      { t: 'Boa tarde, é da Sabor & Cia?' },
      { me: true, t: 'Boa tarde! É sim, aqui é o escritório. Como posso ajudar?', min: 12 },
      { t: 'Tenho uma lanchonete no Jardim Chapadão e queria saber sobre congelados.', min: 6 },
      { me: true, t: 'Atendemos a região! Trabalhamos com hambúrguer, linguiça, pão de queijo e descartáveis.', min: 3 },
      { t: 'Qual o pedido mínimo?', min: 4 },
      { me: true, t: 'R$ 600. Consigo passar aí esta semana pra apresentar a tabela.', min: 2 },
      { t: 'Pode ser quinta à tarde.', min: 18 },
      { me: true, t: 'Anotado. Me passa o nome e o CNPJ pra eu já deixar o cadastro pronto?', min: 3 },
      { nota: true, t: 'Contato novo entrou pelo Instagram. Vincular à empresa depois que passar o CNPJ.' },
    ],
  },
  {
    assunto: 'Consulta rápida de preço',
    msgs: [
      { t: 'Oi, quanto tá o fardo de água 500ml?' },
      { me: true, t: 'R$ 14,90 o fardo com 12. À vista sai R$ 14,20.', min: 8 },
      { t: 'E o galão de 20L?', min: 3 },
      { me: true, t: 'R$ 23,00 com vasilhame, R$ 11,50 na troca.', min: 2 },
      { t: 'Beleza, depois eu fecho.', min: 4 },
      { me: true, t: 'Fico à disposição! 👍', min: 2 },
    ],
  },
  {
    assunto: 'Alinhamento com a representada',
    msgs: [
      { t: 'Oi! A fábrica liberou 4% de bonificação pra carga fechada em abril.' },
      { me: true, t: 'Boa! Já tenho dois clientes que fecham carga cheia.', min: 14 },
      { t: 'Manda os CNPJs que eu cadastro a campanha.', min: 6 },
      { me: true, t: 'Mando hoje ainda. A campanha vale até o fim do mês?', min: 4 },
      { t: 'Até dia 30, sim.', min: 2 },
      { me: true, t: 'Perfeito, vou trabalhar essa condição nas visitas da semana.', min: 3 },
      { nota: true, t: 'Campanha de 4% até dia 30 — usar nas contas de maior volume.' },
      { t: 'Qualquer coisa me chama.', min: 8 },
    ],
  },
  {
    assunto: 'Recompra de mercearia',
    msgs: [
      { me: true, t: 'Bom dia! Faz 3 semanas do último pedido, já é hora de repor?' },
      { t: 'É sim. Manda igual, mas tira o extrato de tomate que tá encalhado.', min: 46 },
      { me: true, t: 'Tiro. Aproveito e coloco o molho sachê, que gira mais.', min: 5 },
      { t: 'Pode colocar 5 caixas.', min: 3 },
      { me: true, t: 'Lançado. R$ 2.784,00 em 28 dias.', min: 9 },
      { t: 'Ok, obrigado.', min: 6 },
      { me: true, t: 'Entrega quinta pela Via Norte.', min: 2 },
    ],
  },
];

// Trocas curtas usadas para dar profundidade ao histórico das conversas (§8:
// ~600 mensagens em 30 dias). São pares escritos à mão; o seed sorteia QUAIS e
// QUANDO entram, nunca o texto.
export const HISTORICO_PARES: DemoMsg[][] = [
  [{ t: 'Bom dia!' }, { me: true, t: 'Bom dia! Tudo certo por aí?', min: 12 }, { t: 'Tudo. Depois te chamo pro pedido.', min: 5 }],
  [{ me: true, t: 'A carga saiu hoje, chega amanhã cedo.' }, { t: 'Combinado 👍', min: 34 }],
  [{ t: 'Consegue me mandar a segunda via da nota?' }, { me: true, t: 'Mando agora por e-mail.', min: 9 }, { t: 'Valeu!', min: 4 }],
  [{ me: true, t: 'Passo aí amanhã de manhã pra conferir a gôndola.' }, { t: 'Pode vir, estarei na loja.', min: 22 }],
  [{ t: 'O requeijão tá com que prazo de validade?' }, { me: true, t: 'Lote novo, 90 dias.', min: 7 }, { t: 'Perfeito.', min: 3 }],
  [{ me: true, t: 'Boa tarde! Alguma reposição pra esta semana?' }, { t: 'Ainda não, o estoque tá bom.', min: 51 }, { me: true, t: 'Sem problema, te chamo na semana que vem.', min: 6 }],
  [{ t: 'A entrega chegou certinho hoje.' }, { me: true, t: 'Ótimo! Qualquer coisa me avisa.', min: 11 }],
  [{ me: true, t: 'Seu boleto vence sexta, só lembrando 🙂' }, { t: 'Anotado, obrigado!', min: 28 }],
  [{ t: 'Vocês trabalham com descartável também?' }, { me: true, t: 'Trabalhamos! Marmitex, potes, copos e sacolas.', min: 8 }, { t: 'Depois me passa a tabela.', min: 6 }],
  [{ me: true, t: 'Feriado semana que vem — antecipa o pedido?' }, { t: 'Boa lembrança, antecipa sim.', min: 19 }],
  [{ t: 'Preciso trocar 2 caixas com avaria.' }, { me: true, t: 'Já abro a troca. Me manda foto da avaria?', min: 6 }, { t: 'Mando agora.', min: 3 }],
  [{ me: true, t: 'Tabela nova entra dia 1º, qualquer pedido até sexta fica no preço antigo.' }, { t: 'Vou adiantar o meu então.', min: 24 }],
  [{ t: 'Bom dia, o vendedor de vocês passa aqui hoje?' }, { me: true, t: 'Passa sim, no fim da manhã.', min: 14 }],
  [{ me: true, t: 'Fechei a bonificação de 3% pro seu próximo pedido.' }, { t: 'Show, obrigado!', min: 16 }],
];

// Nomes dos grupos do WhatsApp (§8: 2 grupos).
export const GRUPOS_WA = ['Compradores Rede Bom Preço', 'Equipe Sabor & Cia'];

// ------------------------------------------------------------- auditoria

// Eventos plausíveis da trilha (§6, tela Logs). entity/action existem em
// client/src/pages/Logs.tsx — código sem rótulo aparece cru na tela.
export const AUDIT_EVENTOS: { entity: string; action: string; diff: Record<string, unknown> }[] = [
  { entity: 'order', action: 'create', diff: { status: 'cotacao' } },
  { entity: 'order', action: 'transition', diff: { de: 'enviado', para: 'faturado' } },
  { entity: 'order', action: 'update', diff: { condicao_pagamento: '28 dias' } },
  { entity: 'relationship', action: 'transition', diff: { stage: 'Negociação' } },
  { entity: 'relationship', action: 'update', diff: { valor_estimado: 8400 } },
  { entity: 'relationship', action: 'link_contact', diff: {} },
  { entity: 'commission', action: 'settle', diff: { status: 'recebida' } },
  { entity: 'finance', action: 'create', diff: { kind: 'pagar', categoria: 'Combustível' } },
  { entity: 'finance', action: 'update', diff: { status: 'liquidado' } },
  { entity: 'activity', action: 'report', diff: { resultado: 'Pedido fechado' } },
  { entity: 'activity', action: 'create', diff: { tipo: 'visita' } },
  { entity: 'price_table', action: 'update', diff: { vigencia_fim: null } },
  { entity: 'sample_request', action: 'update', diff: { status: 'enviada' } },
  { entity: 'carrier', action: 'update', diff: { observacoes: 'Coleta até 16h' } },
  { entity: 'goal', action: 'create', diff: { valor_meta: 90000 } },
  { entity: 'email_schedule', action: 'create', diff: { recorrencia: null } },
  { entity: 'whatsapp_chat', action: 'link', diff: {} },
  { entity: 'commission_rule', action: 'create', diff: { percent: 6 } },
];
