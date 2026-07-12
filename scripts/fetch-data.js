// Corre dentro do GitHub Action. Lê stores.json + secrets do ambiente,
// vai buscar dados reais ao Shopify e ao Flyweel, e escreve data.json.

const fs = require('fs');
const path = require('path');

const stores = JSON.parse(fs.readFileSync(path.join(__dirname, '../stores.json'), 'utf8'));

function envKey(storeId, prefix) {
  return `${prefix}_${storeId.toUpperCase()}`;
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

// Agrega os alertas de encomendas em UM alerta por tipo (em vez de um por encomenda),
// com uma lista de exemplos para o frontend poder mostrar detalhe se quiser.
function computeShopifyMetrics(orders, timeZone) {
  if (!orders) return { alerts: [] };
  const now = new Date();
  const todayStr = localDateString(now, timeZone);
  const last7Days = new Set();
  for (let i = 0; i < 7; i++) {
    last7Days.add(localDateString(new Date(now.getTime() - i * 24 * 3600 * 1000), timeZone));
  }

  let revenueToday = 0, ordersToday = 0, revenue7d = 0;
  const unfulfilled = [];
  const highDiscount = [];

  orders.forEach(o => {
    const created = new Date(o.created_at);
    const createdStr = localDateString(created, timeZone);
    const total = parseFloat(o.total_price || '0');

    if (createdStr === todayStr) { revenueToday += total; ordersToday++; }
    if (last7Days.has(createdStr)) { revenue7d += total; }

    if (o.financial_status === 'paid' && !o.fulfillment_status) {
      const ageHours = (now - created) / 36e5;
      if (ageHours > 24) {
        unfulfilled.push({ number: o.order_number, hours: Math.round(ageHours) });
      }
    }
    const subtotal = parseFloat(o.subtotal_price || '0');
    const discount = parseFloat(o.total_discounts || '0');
    if (subtotal > 0 && (discount / subtotal) > 0.25) {
      highDiscount.push({ number: o.order_number, pct: Math.round((discount / subtotal) * 100) });
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
  if (highDiscount.length > 0) {
    alerts.push({
      type: 'high_discount',
      severity: 'medium',
      count: highDiscount.length,
      message: `${highDiscount.length} encomenda${highDiscount.length !== 1 ? 's' : ''} com desconto acima de 25%`,
      examples: highDiscount.slice(0, 8)
    });
  }

  return {
    revenue_today: revenueToday,
    revenue_avg7d: revenue7d / 7,
    orders_today: ordersToday,
    aov: ordersToday ? revenueToday / ordersToday : null,
    alerts
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

// Devolve TODAS as campanhas com um campo "status" (normalizado em maiúsculas).
// A filtragem para "ativas"/"agendadas" acontece no frontend (index.html),
// para não precisarmos de correr o Action outra vez só para afinar isso.
async function fetchFlyweelCampaigns(store) {
  const key = process.env[envKey(store.id, 'FLYWEEL_KEY')];
  if (!key || !store.flyweel_ad_account_id) {
    console.warn(`Sem FLYWEEL_KEY ou ad_account_id para ${store.id} — a saltar.`);
    return null;
  }
  try {
    const res = await fetch('https://api.flyweel.co/functions/v1/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_metrics',
          arguments: {
            queries: [
              {
                dataSource: 'ads',
                ad_account_id: store.flyweel_ad_account_id,
                metrics: ['spend', 'converted_product_value', 'purchase_roas', 'purchases', 'ctr', 'frequency'],
                dimensions: ['campaign', 'campaign_status'],
                date_range: 'last_7d'
              }
            ]
          }
        }
      })
    });
    if (!res.ok) {
      console.error(`Flyweel erro (${store.id}): ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    console.log('DEBUG Flyweel resposta:', JSON.stringify(data).slice(0, 2500));
    const rows = data?.result?.structuredContent?.results?.[0]?.data?.data
      || data?.result?.structuredContent?.results?.[0]?.rows
      || data?.result?.content?.[0]?.rows || data?.result?.rows || [];

    const campaigns = rows.map(r => {
      const roas = r.purchase_roas || 0;
      const spend = r.spend || 0;
      const revenue = (r.converted_product_value && r.converted_product_value > 0)
        ? r.converted_product_value
        : (roas && spend ? roas * spend : 0);
      return {
        name: r.campaign,
        status: (r.campaign_status || 'DESCONHECIDO').toString().toUpperCase(),
        spend,
        revenue,
        roas,
        cpa: (spend && r.purchases) ? spend / r.purchases : null,
        ctr: r.ctr,
        frequency: r.frequency
      };
    });

    const activeSpending = campaigns.filter(c => c.status === 'ACTIVE');
    const spend_total = activeSpending.reduce((s, c) => s + (c.spend || 0), 0);
    const revenue_attributed = activeSpending.reduce((s, c) => s + (c.revenue || 0), 0);

    // Alertas de performance de campanhas: ativa, com spend real, e ROAS abaixo de 1x.
    const campaignAlerts = campaigns
      .filter(c => c.status === 'ACTIVE' && c.spend > 0 && c.roas < 1)
      .map(c => ({
        type: 'campaign_roas',
        severity: 'high',
        message: `Campanha "${c.name}" com ROAS abaixo de 1x (${c.roas.toFixed(2)}x)`,
        campaign: c.name,
        roas: c.roas
      }));

    return { campaigns, ads_spend_total: spend_total, ads_revenue_attributed: revenue_attributed, campaign_alerts: campaignAlerts };
  } catch (e) {
    console.error(`Falha Flyweel (${store.id}): ${e.message}`);
    return null;
  }
}

async function main() {
  const eurHufRate = await getExchangeRate();
  const results = { generated_at: new Date().toISOString(), eur_huf_rate: eurHufRate, stores: [] };

  for (const store of stores) {
    if (!store.active) {
      results.stores.push({ id: store.id, name: store.name, country: store.country, active: false });
      continue;
    }
    const orders = await fetchShopifyOrders(store);
    const shopifyMetrics = computeShopifyMetrics(orders, store.timezone || 'UTC');
    const adsMetrics = (await fetchFlyweelCampaigns(store)) || {};

    const alerts = [...(shopifyMetrics.alerts || []), ...(adsMetrics.campaign_alerts || [])];
    delete adsMetrics.campaign_alerts;

    results.stores.push({
      id: store.id,
      name: store.name,
      country: store.country,
      currency: store.currency,
      active: true,
      profit_margin_pct: store.profit_margin_pct ?? null,
      ...shopifyMetrics,
      ...adsMetrics,
      alerts
    });
  }

  fs.writeFileSync(path.join(__dirname, '../data.json'), JSON.stringify(results, null, 2));
  console.log('data.json atualizado com sucesso.');
}

main().catch(err => { console.error(err); process.exit(1); });
