/* =====================================================================
   MOND SHIPPING — MOTOR ANALÍTICO DO DASHBOARD (MOND_dashboard.js)
   Regras de negócio para as abas comparativas, rankings e scorecards.
   ===================================================================== */

const ORIGENS_POR_ARMADOR = {
  'MAERSK': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao'],
  'COSCO': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xiamen', 'Xingang'],
  'PIL': ['Shenzhen', 'Ningbo', 'Shanghai'],
  'YML': ['Shenzhen', 'Ningbo', 'Shanghai'],
  'CMA': ['Shenzhen', 'Ningbo', 'Shanghai'],
  'EVERGREEN': ['Shenzhen', 'Ningbo', 'Shanghai'],
  'ONE': ['Shenzhen', 'Ningbo', 'Shanghai'],
  'HMM': ['Shenzhen', 'Ningbo', 'Shanghai']
};

// 1. diffVsAnterior(hoje, anterior) -> Variação por rota (delta + status)
function diffVsAnterior(hoje = [], anterior = []) {
  const keysAnterior = {};
  anterior.forEach(r => {
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    keysAnterior[k] = r;
  });

  const keysHoje = new Set();
  const result = [];

  hoje.forEach(r => {
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    keysHoje.add(k);

    const ant = keysAnterior[k];
    if (!ant) {
      result.push({ ...r, status: 'novo', delta: null });
    } else {
      const delta = Number(r.frete) - Number(ant.frete);
      let status = 'igual';
      if (delta < 0) status = 'caiu';
      else if (delta > 0) status = 'subiu';
      result.push({ ...r, status, delta });
    }
  });

  // Rotas que saíram (tinha ontem, sumiu hoje)
  anterior.forEach(r => {
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    if (!keysHoje.has(k)) {
      result.push({ ...r, status: 'saiu', delta: null, frete: null });
    }
  });

  return result;
}

// 2. melhorPorRota(porAgente) -> Melhor frete e ranking por rota+contêiner
function melhorPorRota(porAgente = {}) {
  const routes = {}; // key -> [ { agente, frete, row } ]

  for (const [agente, rows] of Object.entries(porAgente)) {
    if (!Array.isArray(rows)) continue;
    rows.forEach(r => {
      if (r.frete == null || isNaN(Number(r.frete))) return;
      const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
      if (!routes[k]) routes[k] = [];
      routes[k].push({ agente, frete: Number(r.frete), row: r });
    });
  }

  const out = {};
  for (const [k, list] of Object.entries(routes)) {
    if (list.length === 0) continue;
    // Ordena do menor para o maior frete
    list.sort((a, b) => a.frete - b.frete);
    const best = list[0];
    const worst = list[list.length - 1];
    const economia = worst.frete - best.frete;

    out[k] = {
      vencedor: best.agente,
      melhorFrete: best.frete,
      economia: economia,
      ranking: list.map(item => ({ agente: item.agente, frete: item.frete }))
    };
  }
  return out;
}

// 2b. melhorPorRotaSemArmador(porAgente) -> Melhor frete por ROTA (sem armador na chave)
// Cada agente compete com seu melhor preço na rota, independente do armador.
function melhorPorRotaSemArmador(porAgente = {}) {
  // key = "ORIGEM|DESTINO|CONTAINER" -> { agente -> { frete, armador } }
  const routes = {};

  for (const [agente, rows] of Object.entries(porAgente)) {
    if (!Array.isArray(rows)) continue;
    rows.forEach(r => {
      if (r.frete == null || isNaN(Number(r.frete))) return;
      const k = `${r.origem}|${r.destino}|${r.container}`.toUpperCase();
      if (!routes[k]) routes[k] = {};
      const frete = Number(r.frete);
      const armador = (r.armador || '').toUpperCase();
      // Para cada agente, manter só o melhor preço (menor frete)
      if (!routes[k][agente] || frete < routes[k][agente].frete) {
        routes[k][agente] = { frete, armador };
      }
    });
  }

  const out = {};
  for (const [k, agentMap] of Object.entries(routes)) {
    const entries = Object.entries(agentMap).map(([ag, info]) => ({
      agente: ag,
      frete: info.frete,
      armador: info.armador
    }));
    if (entries.length === 0) continue;
    entries.sort((a, b) => a.frete - b.frete);
    const best = entries[0];
    const worst = entries[entries.length - 1];

    out[k] = {
      vencedor: best.agente,
      armadorVencedor: best.armador,
      melhorFrete: best.frete,
      economia: worst.frete - best.frete,
      ranking: entries,
      porAgente: agentMap  // { AGENTE: { frete, armador } }
    };
  }
  return out;
}

// 3. preencherBasics(rowsAgente, porAgente) -> Completa basics herdando de Helka/Reach
function preencherBasics(rowsAgente = [], porAgente = {}) {
  const agentRoutes = new Set();
  rowsAgente.forEach(r => {
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    agentRoutes.add(k);
  });

  const helkaRows = porAgente['HELKA'] || [];
  const reachRows = porAgente['REACH'] || [];

  // Reúne rotas de referência de Helka e Reach escolhendo a mais barata
  const referenceRoutes = {};
  [...helkaRows, ...reachRows].forEach(r => {
    if (r.frete == null || isNaN(Number(r.frete))) return;
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    const existing = referenceRoutes[k];
    if (!existing || Number(r.frete) < Number(existing.frete)) {
      referenceRoutes[k] = r;
    }
  });

  const currentAgentName = rowsAgente.length > 0 ? rowsAgente[0].agente : 'TEMP';
  const filledRows = [...rowsAgente];

  for (const [k, refRow] of Object.entries(referenceRoutes)) {
    if (!agentRoutes.has(k)) {
      const inherited = {
        ...refRow,
        agente: currentAgentName,
        observacao: `basic herdado de ${refRow.agente.toUpperCase()}${refRow.observacao ? ' | ' + refRow.observacao : ''}`
      };
      filledRows.push(inherited);
    }
  }

  return filledRows;
}

// 4. scorecard(agente, porAgente, anteriorDoAgente, melhores) -> Métricas resumo do agente
function scorecard(agente, porAgente = {}, anteriorDoAgente = [], melhores = {}) {
  const hojeAgente = porAgente[agente] || [];
  const diffs = diffVsAnterior(hojeAgente, anteriorDoAgente);

  const uniqueRoutes = new Set();
  const uniqueArmadores = new Set();
  let cortou = 0;
  let subiu = 0;
  let bestCount = 0;

  hojeAgente.forEach(r => {
    const k = `${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase();
    uniqueRoutes.add(k);
    uniqueArmadores.add(r.armador.toUpperCase());

    if (melhores[k] && melhores[k].vencedor === agente) {
      bestCount++;
    }
  });

  diffs.forEach(d => {
    if (d.status === 'caiu') cortou++;
    if (d.status === 'subiu') subiu++;
  });

  const totalRoutes = uniqueRoutes.size;
  const bestShare = totalRoutes > 0 ? (bestCount / totalRoutes) * 100 : 0;

  return {
    cobertura: totalRoutes,
    armadores: uniqueArmadores.size,
    cortou,
    subiu,
    bestShare
  };
}

// 5. rankearAgentes(porAgente, anteriorPorAgente, pesos) -> Leaderboard com score
function rankearAgentes(porAgente = {}, anteriorPorAgente = {}, pesos = {}) {
  const defaultPesos = {
    competitividade: 0.4,
    cobertura: 0.2,
    movimento: 0.2,
    amplitude: 0.1,
    frescor: 0.1
  };
  const w = { ...defaultPesos, ...pesos };

  const agentes = Object.keys(porAgente);
  if (agentes.length === 0) return [];

  // Reúne metadados globais de referência
  const totalUniqueRoutes = new Set();
  const totalUniqueArmadores = new Set();
  let maxDate = 0;

  for (const [_, rows] of Object.entries(porAgente)) {
    rows.forEach(r => {
      totalUniqueRoutes.add(`${r.armador}|${r.origem}|${r.destino}|${r.container}`.toUpperCase());
      totalUniqueArmadores.add(r.armador.toUpperCase());
      if (r.data) {
        const d = new Date(r.data).getTime();
        if (!isNaN(d) && d > maxDate) maxDate = d;
      }
    });
  }

  const melhores = melhorPorRota(porAgente);
  const leaderboard = [];

  agentes.forEach(agente => {
    const hojeAgente = porAgente[agente] || [];
    const ontemAgente = anteriorPorAgente[agente] || [];
    
    // Calcula métricas
    const sc = scorecard(agente, porAgente, ontemAgente, melhores);

    // Calcula frescor baseando-se na data mais recente
    let lastDate = 0;
    hojeAgente.forEach(r => {
      if (r.data) {
        const d = new Date(r.data).getTime();
        if (!isNaN(d) && d > lastDate) lastDate = d;
      }
    });

    let frescorScore = 100;
    if (maxDate > 0 && lastDate > 0) {
      const diffDays = Math.max(0, Math.floor((maxDate - lastDate) / (1000 * 60 * 60 * 24)));
      frescorScore = Math.max(0, 100 - (diffDays * 10)); // Cai 10% por dia parado
    }

    // Normaliza scores parciais de 0 a 100
    const compScore = sc.bestShare; // % de vitórias
    const cobScore = totalUniqueRoutes.size > 0 ? (sc.cobertura / totalUniqueRoutes.size) * 100 : 0;
    const movScore = hojeAgente.length > 0 ? (sc.cortou / hojeAgente.length) * 100 : 0;
    const ampScore = totalUniqueArmadores.size > 0 ? (sc.armadores / totalUniqueArmadores.size) * 100 : 0;
    const freScore = frescorScore;

    // Score composto
    const scoreVal = (compScore * w.competitividade) +
                     (cobScore * w.cobertura) +
                     (movScore * w.movimento) +
                     (ampScore * w.amplitude) +
                     (freScore * w.frescor);

    leaderboard.push({
      agente,
      score: Number(scoreVal.toFixed(1)),
      bestShare: Number(sc.bestShare.toFixed(1)),
      cobertura: sc.cobertura,
      armadores: sc.armadores,
      cortou: sc.cortou,
      subiu: sc.subiu,
      avgDelta: 0
    });
  });

  // Ordena descendente por score
  leaderboard.sort((a, b) => b.score - a.score);

  // Adiciona a posição do ranking
  return leaderboard.map((item, idx) => ({
    posicao: idx + 1,
    ...item
  }));
}

if (typeof module !== 'undefined') {
  module.exports = {
    diffVsAnterior,
    melhorPorRota,
    melhorPorRotaSemArmador,
    preencherBasics,
    scorecard,
    rankearAgentes,
    ORIGENS_POR_ARMADOR
  };
} else {
  window.diffVsAnterior = diffVsAnterior;
  window.melhorPorRota = melhorPorRota;
  window.melhorPorRotaSemArmador = melhorPorRotaSemArmador;
  window.preencherBasics = preencherBasics;
  window.scorecard = scorecard;
  window.rankearAgentes = rankearAgentes;
  window.ORIGENS_POR_ARMADOR = ORIGENS_POR_ARMADOR;
}
