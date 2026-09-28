/* ==========================================================================
   DICTIONARIES — MOND SHIPPING TARIFF BUILDER
   Reference data for carrier decode, port normalization, ISPS, containers.
   Spec §2–§5
   ========================================================================== */

// ── §2.1  Carrier Decode (raw → canonical) ──────────────────────────────────
const CARRIER_DECODE = {
    // Masked / abbreviated
    'H*M':      'HMM',
    'HMM':      'HMM',
    'MSK':      'MAERSK',
    'MSK-BR':   'MAERSK',
    'MAERSK':   'MAERSK',
    'C*A':      'CMA',
    'CMA':      'CMA',
    'CMA CGM':  'CMA',
    'O**L':     'OOCL',
    'OOCL':     'OOCL',
    'O*E':      'ONE',
    'ONE':      'ONE',
    'Y*L':      'YANG MING',
    'YML':      'YANG MING',
    'YANG MING':'YANG MING',
    'EMC':      'EVERGREEN',
    'EVERGREEN':'EVERGREEN',
    'HPL':      'HAPAG',
    'HAPAG':    'HAPAG',
    'HAPAG-LLOYD':'HAPAG',
    'MSC':      'MSC',
    'ZIM':      'ZIM',
    'COSCO':    'COSCO',
    'PIL':      'PIL',
};

// ── §2.2  Service Suffix Removal ─────────────────────────────────────────────
// Strip these from carrier names; the service name goes to Observação
const CARRIER_SERVICE_SUFFIXES = [
    /\s+FAST\s+SERVICE$/i,
    /\s+SANTANA\s+SERVICE$/i,
    /\s+IPANEMA\s+SERVICE$/i,
    /\s+CARIOCA\s+SERVICE$/i,
    /\s+JADE\s+SERVICE$/i,
    /\s+ONLINE$/i,
    /\s*\(NAC[^)]*\)$/i,
    /\s+NAC$/i,
    /\s+SERVICE$/i,
];

// Extract service name before stripping
function extractServiceName(raw) {
    const servicePatterns = [
        /\b(FAST\s+SERVICE|SANTANA\s+SERVICE|IPANEMA|CARIOCA|JADE|SANTANA)\b/i,
    ];
    for (const pat of servicePatterns) {
        const m = raw.match(pat);
        if (m) return m[1].trim();
    }
    return null;
}

// ── §2.3  ISPS Fallback Table ────────────────────────────────────────────────
// Rule: ALWAYS use value from email if present. This is fallback only.
const ISPS_FALLBACK = {
    'HMM':        25,
    'MAERSK':     29,
    'CMA':        14,
    'HAPAG':      15,
    'ONE':        15,
    'ZIM':        15,
    'MSC':        12,
    'COSCO':      15,
    'PIL':        15,
    'YANG MING':   9,
    'EVERGREEN':   0,
};

// ── §2.4  POL (Origin) Decode ────────────────────────────────────────────────
const POL_DECODE = {
    // China main
    'SH':        'Shanghai',
    'SHA':       'Shanghai',
    'SHANGHAI':  'Shanghai',
    'NB':        'Ningbo',
    'NGB':       'Ningbo',
    'NBO':       'Ningbo',
    'NINGBO':    'Ningbo',
    'QD':        'Qingdao',
    'QDO':       'Qingdao',
    'TAO':       'Qingdao',
    'QINGDAO':   'Qingdao',
    'YTN':       'Yantian',
    'YANTIAN':   'Yantian',
    'SKU':       'Shekou',
    'SHE':       'Shekou',
    'SHEKOU':    'Shekou',
    'SZ':        '__SHENZHEN__',
    'SHENZHEN':  '__SHENZHEN__',  // special: expands to Shekou + Yantian
    'XIN':       'Xingang',
    'XNG':       'Xingang',
    'TIANJIN':   'Xingang',
    'XINGANG':   'Xingang',
    'XIA':       'Xiamen',
    'XM':        'Xiamen',
    'XMN':       'Xiamen',
    'XIAMEN':    'Xiamen',
    'DLN':       'Dalian',
    'DALIAN':    'Dalian',
    'FZU':       'Fuzhou',
    'FUZHOU':    'Fuzhou',
    'NANSHA':    'Nansha',
    'NANJING':   'Nanjing',

    // Taiwan
    'KAO':       'Kaohsiung',
    'KAOHSIUNG': 'Kaohsiung',
    'KEE':       'Keelung',
    'KEELUNG':   'Keelung',
    'TXG':       'Taichung',
    'TAICHUNG':  'Taichung',
    'TAICHANG':  'Taichung',

    // Vietnam
    'HCM':       'Ho Chi Minh',
    'HPH':       'Hai Phong',
    'VNHPH':     'Hai Phong',

    // Malaysia
    'PKG':       'Port Klang',
    'MYPKG':     'Port Klang',
    'MYPGU':     'Pasir Gudang',

    // Thailand
    'LAEM CHABANG': 'Laem Chabang',
    'THLCH':     'Laem Chabang',
    'BKK':       'Bangkok',
    'THBKK':     'Bangkok',

    // Indonesia
    'JKT':       'Jakarta',

    // Philippines
    'MNL':       'Manila',

    // Singapore
    'SIN':       'Singapore',
    'SINGAPORE': 'Singapore',

    // Japan
    'JPNGO':     'Nagoya',
    'JPTYO':     'Tokyo',
    'JPYOK':     'Yokohama',
    'NAGOYA':    'Nagoya',
    'TOKYO':     'Tokyo',
    'YOKOHAMA':  'Yokohama',
};

// Japan ports set (for exotic toggle filtering)
const JAPAN_PORTS = new Set(['Nagoya', 'Tokyo', 'Yokohama']);

// ── §2.5  POD (Destination) Decode ───────────────────────────────────────────
const POD_DECODE = {
    'SSZ':       'Santos',
    'SANTOS':    'Santos',
    'PNG':       'Paranaguá',
    'PARANAGUA': 'Paranaguá',
    'NVT':       'Navegantes',
    'NAVEGANTES':'Navegantes',
    'IOA':       'Itapoá',
    'ITAPOA':    'Itapoá',
    'ITJ':       'Itajaí',
    'ITAJAI':    'Itajaí',
    'RIG':       'Rio Grande',
    'RIO GRANDE':'Rio Grande',
    'RIO':       'Rio de Janeiro',
    'RIODEJANEIRO':'Rio de Janeiro',
    'ITG':       'Itaguaí',
    'ITAGUAI':   'Itaguaí',
    'SUA':       'Suape',
    'SUAPE':     'Suape',
    'PEC':       'Pecém',
    'PECEM':     'Pecém',
    'SSA':       'Salvador',
    'SALVADOR':  'Salvador',
    'VIX':       'Vitória',
    'VITORIA':   'Vitória',
    'MAO':       'Manaus',
    'MANAUS':    'Manaus',
    'VILA DO CONDE': 'Vila do Conde',
};

// Destinations to ALWAYS discard
const DISCARD_PODS = new Set([
    'Montevidéu', 'Buenos Aires', 'Asunción',
]);
const DISCARD_POD_CODES = {
    'MVD':   'Montevidéu',
    'ARBUE': 'Buenos Aires',
};

// ── §2.7  Container Canonical Names ──────────────────────────────────────────
// Comentado para evitar conflito de redeclaração com MOND_engine_v2.js
// const CONTAINERS = ["20' DRY", "40' DRY", "40' HIGH CUBE", "40' NOR"];

// Mapping from raw column headers / keys to canonical containers
const CONTAINER_KEY_MAP = {
    '20':     "20' DRY",
    '20GP':   "20' DRY",
    '20DRY':  "20' DRY",
    "20'":    "20' DRY",
    "20'GP":  "20' DRY",
    "20'DRY": "20' DRY",
    '40':     "40' DRY",
    '40GP':   "40' DRY",
    "40'":    "40' DRY",
    "40'GP":  "40' DRY",
    "40'DRY": "40' DRY",
    '40DRY':  "40' DRY",
    '40HQ':   "40' HIGH CUBE",
    '40HC':   "40' HIGH CUBE",
    "40'HQ":  "40' HIGH CUBE",
    "40'HC":  "40' HIGH CUBE",
    '40NOR':  "40' NOR",
    "40'NOR": "40' NOR",
    '40RF':   "40' NOR",
    "40'RF":  "40' NOR",
    // Combined keys that map to BOTH 40' DRY and 40' HIGH CUBE
    '40/HC':       '__40_AND_HC__',
    '40GP/40HQ':   '__40_AND_HC__',
    '40HC/40GP':   '__40_AND_HC__',
    '40GP/40HC':   '__40_AND_HC__',
    '40HQ/40GP':   '__40_AND_HC__',
    "40'/HC":      '__40_AND_HC__',
    "40HC/40HQ":   '__40_AND_HC__',
    "40HQ/40HC":   '__40_AND_HC__',
};

// Which containers get DRY free time vs NOR free time
const FT_DRY_CONTAINERS = new Set(["20' DRY", "40' DRY", "40' HIGH CUBE"]);
const FT_NOR_CONTAINERS = new Set(["40' NOR"]);

// ── §3.4  Skip Markers ──────────────────────────────────────────────────────
const RE_SKIP = /^\s*(nil|\*|--|—|none|n\/?a)\s*$/i;

// ── §5  Regex Patterns (Post-extraction parsing) ─────────────────────────────
const RE_FRETE       = /(?:USD|US\$|\$)?\s*([\d][\d.,]*)/;
const RE_ISPS_TOKEN  = /([\d]+)\s*\+\s*isps/i;
const RE_ISPS_VAL    = /ISPS\s*(?:USD\s*)?(\d+)\s*\/?\s*CTN/i;
const RE_ADDON_CTN   = /\+?\s*ADD\s*ON\s*USD\s*(\d+)\s*\/\s*CTN/i;
const RE_ADDON_ORIG  = /([A-Z]+)\s*\+\s*(?:USD\s*)?(\d+)\s*\/\s*(40NOR|CTN|BOX|TEU|20GP|DRY)/i;
const RE_MINUS_ORIG  = /(?:ex|from)\s+([A-Z]+),?\s*(?:minus|less)\s*(?:USD\s*)?(\d+)\s*\/?\s*(box|ctn|teu)?/i;
const RE_ETD         = /(\d{1,2})\s*[-/ ]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i;
const RE_VALID_RANGE = /(\d{1,2})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/;
const RE_VALID_RANGE_SHORT = /(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})/;
const RE_VALID_TO    = /valid\s*to\s*(\d{1,2})\s*[-/ ]?\s*([A-Za-z]{3})/i;
const RE_ETD_ONLY    = /ETD\s*(\d{1,2})\s*[.\-/ ]?\s*([A-Za-z]{3}|\d{1,2})/i;
const RE_VOL         = /(\d+(?:\s*\+\s*\d+)*)\s*[*xX]\s*(40|20)\s*(GP|HQ|HC|NOR|DRY|RF)?/i;
const RE_CNTR_20     = /20'?\s*(GP|DRY)/i;
const RE_CNTR_40     = /40'?\s*(GP|HQ|HC)/i;
const RE_CNTR_NOR    = /40'?\s*NOR/i;
const RE_CAN_CHANGE  = /CAN\s+CHANGE\s+TO\s+([A-Z/ ]+)/i;
const RE_CAN_POD     = /CAN\s+CHANGE\s+POD/i;
const RE_GW_LIMIT    = /GW\s*(?:over|>|less than|<|under)\s*([\d.,]+)\s*(KGS?|TON|T)/i;
const RE_HANDLING    = /handling\s*(?:USD\s*)?(\d+)\s*\/?\s*(box|ctn|teu)/i;
const RE_HANDLING_EXCEPT = /except\s+([A-Z, ]+)/i;
const RE_EFF         = /EFF\s*(?:USD\s*)?(\d+)\s*\/?\s*(TEU|box|ctn)/i;
const RE_KB          = /(?:kickback|kb)\s*(?:USD\s*)?(\d+)\s*\/?\s*(box|ctn|teu)/i;
const RE_SUB_ISPS    = /sub\s*isps\s*(?:USD\s*)?(\d+)/i;
const RE_NO_EQUIP    = /no\s+equipment\s+(?:of\s+)?(\d+\s*(?:NOR|GP|HQ|HC|DRY|RF))/i;
const RE_PROFIT_SHARE = /profit\s*share\s*\d+\s*\/\s*\d+/i;

// Month name → number
const MONTH_MAP = {
    'JAN': 1,  'FEB': 2,  'MAR': 3,  'APR': 4,
    'MAY': 5,  'JUN': 6,  'JUL': 7,  'AUG': 8,
    'SEP': 9,  'OCT': 10, 'NOV': 11, 'DEC': 12,
};

// ── §3.1  Tarifário 34-column header ─────────────────────────────────────────
const TARIFARIO_HEADERS = [
    'Produto', 'Cliente', 'Cidade Coleta', 'Origem', 'Destino',
    'Cidade de Entrega', 'Zipcode Entrega', 'Armador', 'Coloader', 'Agente',
    'Tp Container', 'Moeda', 'Vl Minimo', 'Vl. Frete', 'Dt Inicio Validade',
    'Dt Fim Validade', 'Transit Time De', 'Transit Time Até', 'Tipo Embarque',
    'Modalidade do Transporte', 'Free Time', 'Contrato', 'Contrato Unico',
    'Mercadoria', 'Frequência', 'Limite de Peso', 'FT LS Destino Compra',
    'FT Destino Compra', 'FT LS Origem Compra', 'Tarifa', 'Transbordo',
    'Taxas', 'Observacao', 'FT Combinado Compra'
];

// §3.2  Tarifário fixed defaults
const TARIFARIO_DEFAULTS = {
    'Produto':        'Importação Marítima',
    'Moeda':          'USD',
    'Tipo Embarque':  'FCL',
    'Frequência':     'Semanal',
};

// §3.3  Required fields (yellow — block export if empty)
const TARIFARIO_REQUIRED = new Set([
    'Produto', 'Origem', 'Destino', 'Armador', 'Agente',
    'Tp Container', 'Moeda', 'Vl. Frete', 'Dt Inicio Validade',
    'Dt Fim Validade', 'Tipo Embarque', 'Free Time', 'Frequência',
]);

// ── §4.1  Space on Hand 9-column header ──────────────────────────────────────
const SPACE_HEADERS = [
    'AGENTE', 'POL', 'POD', 'VOL', 'ETD',
    'FRETE', 'FREE TIME', 'ARMADOR', 'OBSERVAÇÃO'
];
