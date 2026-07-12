// Corre dentro do GitHub Action. Lê stores.json + secrets do ambiente,
// vai buscar dados reais ao Shopify e ao Flyweel, e escreve data.json.

const fs = require('fs');
const path = require('path');

const stores = JSON.parse(fs.readFileSync(path.join(__dirname, '../stores.json'), 'utf8'));
const DATA_PATH = path.join(__dirname, '../data.json');

function envKey(storeId, prefix) {
  return `${prefix}_${storeId.toUpperCase()}`;
}

function loadPreviousData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function getExchangeRate() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=HUF');
    const data = await res.json();
    return data.rates.HUF;
  } catch (e) {
    console.error('Falha ao obter taxa de câmbio EUR/HUF:', e.message);
    return null;
  }
}

function localDateString(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Mantém um histórico diário de receita (upsert por data, últimos 30 dias) para o sparkline.
function updateRevenueHistory(previousHistory, todayStr, revenueToday) {
  const history = Array.isArray(previousHistory) ? [...previousHistory] : [];
  const idx = history.findIndex(h => h.date === todayStr);
  if (idx >= 0) history[idx] = { date: todayStr, revenue: revenueToday };
  else history.push({ date: todayStr, revenue: revenueToday });
  history.sort((a, b) => a.date.localeCompare(b.date));
  return history.slice(-30);
}

// Alertas + top produtos + reembolsos + tempo médio de envio, tudo a partir das mesmas encomendas.
function computeShopifyMetrics(orders, timeZone) {
  if (!orders) return { alerts: [], top_products: [] };
  const now = new Date();
  const todayStr = localDateString(now, timeZone);
  const last7Days = new Set();
  for (let i = 0; i < 7; i++) {
    last7Days.add(localDateString(new Date(now.getTime() - i * 24 * 3600 * 1000), timeZone));
  }

  let revenueToday = 0, ordersToday = 0, revenue7d = 0;
  let refundedToday = 0, refundCountToday = 0;
  const unfulfilled = [];
  const productTotals = {};
  const fulfillmentHoursToday = [];

  orders.forEach(o => {
    const created = new Date(o.created_at);
    const createdStr = localDateString(created, timeZone);
    const total = parseFloat(o.total_price || '0');
    const isToday = createdStr === todayStr;

    if (isToday) { revenueToday += total; ordersToday++; }
    if (last7Days.has(createdStr)) { revenue7d += total; }

    if (isToday && Array.isArray(o.line_items)) {
      o.line_items.forEach(li => {
        const name = li.title || li.name || 'Produto sem nome';
        const qty = li.quantity || 0;
        const lineRevenue = parseFloat(li.price || '0') * qty;
        if (!productTotals[name]) productTotals[name] = { quantity: 0, revenue: 0 };
        productTotals[name].quantity += qty;
        productTotals[name].revenue += lineRevenue;
      });
    }

    if (o.financial_status === 'paid' && !o.fulfillment_status) {
      const ageHours = (now - created) / 36e5;
      if (ageHours > 24) unfulfilled.push({ number: o.order_number, hours: Math.round(ageHours) });
    }

    // Reembolsos processados hoje.
    if (Array.isArray(o.refunds)) {
      o.refunds.forEach(r => {
        const processedStr = r.processed_at ? localDateString(new Date(r.processed_at), timeZone) : null;
        if (processedStr === todayStr) {
          const amount = (r.transactions || []).reduce((s, t) => s + parseFloat(t.amount || '0'), 0);
          refundedToday += amount;
          refundCountToday++;
        }
      });
    }

    // Tempo entre criação e primeiro envio, para encomendas cumpridas hoje.
    if (Array.isArray(o.fulfillments) && o.fulfillments.length > 0) {
      const firstFulfillment = o.fulfillments[0];
      const fulfilledStr = firstFulfillment.created_at ? localDateString(new Date(firstFulfillment.created_at), timeZone) : null;
      if (fulfilledStr === todayStr) {
        const hours = (new Date(firstFulfillment.created_at) - created) / 36e5;
        if (hours >= 0) fulfillmentHoursToday.push(hours);
      }
    }
  });

  const alerts = [];
  if (unfulfilled.length > 0) {
    const severe = unfulfilled.filter(o => o.hours > 48);
    unfulfilled.sort((a, b) => b.hours - a.hours);
    alerts.push({
      type: 'unfulfilled_orders',
      severity: severe.length > 0 ? 'high' : 'medium',
      count: unfulfilled.length,
      count_severe: severe.length,
      message: `${unfulfilled.length} encomenda${unfulfilled.length !== 1 ? 's' : ''} por cumprir` +
        (severe.length > 0 ? ` (${severe.length} há mais de 48h)` : ''),
      examples: unfulfilled.slice(0, 8)
    });
  }

  const top_products = Object.entries(productTotals)
    .map(([name, v]) => ({ name, quantity: v.quantity, revenue: v.revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const avgFulfillmentHours = fulfillmentHoursToday.length
    ? fulfillmentHoursToday.reduce((s, h) => s + h, 0) / fulfillmentHoursToday.length
    : null;

  return {
    revenue_today: revenueToday,
    revenue_avg7d: revenue7d / 7,
    orders_today: ordersToday,
    aov: ordersToday ? revenueToday / ordersToday : null,
    refunded_today: refundedToday,
    refund_count_today: refundCountToday,
    avg_fulfillment_hours: avgFulfillmentHours,
    alerts,
    top_products,
    _todayStr: todayStr
  };
}

async function getShopifyAccessToken(store) {
  const clientId = process.env[envKey(store.id, 'SHOPIFY_CLIENT_ID')];
  const clientSecret = process.env[envKey(store.id, 'SHOPIFY_CLIENT_SECRET')];
  if (!clientId || !clientSecret) {
    console.warn(`Sem SHOPIFY_CLIENT_ID/SECRET para ${store.id} — a saltar.`);
    return null;
  }
  const res = await fetch(`https://${store.shopify_domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  });
  if (!res.ok) {
    console.error(`Falha a trocar credenciais por token (${store.id}): ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.access_token || null;
}

async function fetchShopifyOrders(store) {
  const token = await getShopifyAccessToken(store);
  if (!token) return null;
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  const url = `https://${store.shopify_domain}/admin/api/2026-07/orders.json?status=any&limit=250&order=created_at+desc&created_at_min=${eightDaysAgo}`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) {
    console.error(`Shopify erro (${store.id}): ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  // NOTA: limite de 250 encomendas sem paginação. Se a loja passar a ter
  // mais de 250 encomendas em 8 dias, é preciso paginar (Link header).
  return data.orders || [];
}

const SALES_OBJECTIVE_HINTS = ['SALES', 'CONVERSION', 'PURCHASE', 'CATALOG'];
function looksLikeSalesObjective(objective) {
  if (!objective) return false;
  const o = objective.toString().toUpperCase();
  return SALES_OBJECTIVE_HINTS.some(hint => o.includes(hint));
}

function mapCampaignRows(rows) {
  return rows.map(r => {
    const roas = r.purchase_roas || 0;
    const spend = r.spend || 0;
    const purchases = r.purchases || 0;
    return {
      name: r.campaign,
      status: (r.campaign_status || 'DESCONHECIDO').toString().toUpperCase(),
      objective: r.objective || null,
      spend, cpc: r.cpc, ctr: r.ctr, atc: r.add_to_cart, purchases,
      frequency: r.frequency, roas,
      cpa: (spend && purchases) ? spend / purchases : null
    };
  });
}

// Pede vários períodos de uma vez (correlated queries — a Flyweel aceita até 5 por pedido).
// NOTA: "orçamento da campanha" continua indisponível — esta ferramenta só dá métricas de
// performance, não configuração da campanha (confirmado na lista de métricas válidas).
async function fetchFlyweelCampaigns(store) {
  const key = process.env[envKey(store.id, 'FLYWEEL_KEY')];
  if (!key || !store.flyweel_ad_account_id) {
    console.warn(`Sem FLYWEEL_KEY ou ad_account_id para ${store.id} — a saltar.`);
    return null;
  }
  const ranges = ['today', 'yesterday', 'last_7d', 'last_30d'];
  const metrics = ['spend', 'cpc', 'ctr', 'add_to_cart', 'purchases', 'frequency', 'purchase_roas'];
  const dimensions = ['campaign', 'campaign_status', 'objective'];
  try {
    const res = await fetch('https://api.flyweel.co/functions/v1/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'query_metrics',
          arguments: {
            queries: ranges.map(date_range => ({
              dataSource: 'ads', ad_account_id: store.flyweel_ad_account_id, metrics, dimensions, date_range
            }))
          }
        }
      })
    });
    if (!res.ok) {
      console.error(`Flyweel erro (${store.id}): ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    console.log('DEBUG Flyweel resposta (multi-período):', JSON.stringify(data).slice(0, 4000));
    const results = data?.result?.structuredContent?.results || [];

    const campaignsByRange = {};
    ranges.forEach((range, i) => {
      const result = results[i];
      if (!result || result.success === false) {
        console.warn(`DEBUG período "${range}" falhou ou não veio: ${result ? JSON.stringify(result.error) : 'sem resultado'}`);
        campaignsByRange[range] = [];
        return;
      }
      const rows = result?.data?.data || result?.rows || [];
      campaignsByRange[range] = mapCampaignRows(rows);
    });

    const distinctStatuses = [...new Set((campaignsByRange.today || []).map(c => c.status))];
    console.log('DEBUG estados de campanha encontrados (hoje):', JSON.stringify(distinctStatuses));

    const todayCampaigns = campaignsByRange.today || [];
    const activeToday = todayCampaigns.filter(c => c.status === 'ACTIVE');
    const spend_total = activeToday.reduce((s, c) => s + (c.spend || 0), 0);
    const revenue_attributed = activeToday.reduce((s, c) => s + ((c.roas || 0) * (c.spend || 0)), 0);

    const campaignAlerts = todayCampaigns
      .filter(c => c.status === 'ACTIVE' && c.spend > 5 && looksLikeSalesObjective(c.objective) && c.roas < 1)
      .map(c => ({
        type: 'campaign_roas', severity: 'high',
        message: `Campanha "${c.name}" com ROAS abaixo de 1x hoje (${c.roas.toFixed(2)}x)`,
        campaign: c.name, roas: c.roas
      }));

    return {
      campaigns_by_range: campaignsByRange,
      ads_spend_total: spend_total,
      ads_revenue_attributed: revenue_attributed,
      campaign_alerts: campaignAlerts
    };
  } catch (e) {
    console.error(`Falha Flyweel (${store.id}): ${e.message}`);
    return null;
  }
}

async function main() {
  const previous = loadPreviousData();
  const eurHufRate = await getExchangeRate();
  const results = { generated_at: new Date().toISOString(), eur_huf_rate: eurHufRate, stores: [] };

  for (const store of stores) {
    if (!store.active) {
      results.stores.push({ id: store.id, name: store.name, country: store.country, active: false });
      continue;
    }
    const prevStore = previous?.stores?.find(s => s.id === store.id);
    const orders = await fetchShopifyOrders(store);
    const shopifyMetrics = computeShopifyMetrics(orders, store.timezone || 'UTC');
    const adsMetrics = (await fetchFlyweelCampaigns(store)) || {};

    const revenue_history = updateRevenueHistory(prevStore?.revenue_history, shopifyMetrics._todayStr, shopifyMetrics.revenue_today);
    delete shopifyMetrics._todayStr;

    const alerts = [...(shopifyMetrics.alerts || []), ...(adsMetrics.campaign_alerts || [])];
    delete adsMetrics.campaign_alerts;

    results.stores.push({
      id: store.id, name: store.name, country: store.country, currency: store.currency, active: true,
      profit_margin_pct: store.profit_margin_pct ?? null,
      ...shopifyMetrics, ...adsMetrics, alerts, revenue_history
    });
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(results, null, 2));
  console.log('data.json atualizado com sucesso.');
}

main().catch(err => { console.error(err); process.exit(1); });
