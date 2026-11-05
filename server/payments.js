// Checkout orders. The game never handles card data: it asks the server for an order,
// opens the returned URL in the browser, and polls the order until it is paid.
//
// PAYMENTS=mock   (default) built-in test page, no real money.
// PAYMENTS=stripe real Stripe Checkout. Needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and PUBLIC_URL.
//                 NOT TESTED YET: try it with Stripe *test* keys (sk_test_...) before going live.
// PAYMENTS=off    store disabled.
const crypto = require("crypto");
const BUNDLES = require("./bundles");

const MODE = (process.env.PAYMENTS || "mock").toLowerCase();
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();
const orders = new Map(); // id -> order (in memory; use a database before going live)

function publicInfo() {
  return { mode: MODE, currency: CURRENCY, bundles: BUNDLES };
}

function newOrder(bundleId, player) {
  const b = BUNDLES.find((x) => x.id === bundleId);
  if (!b) return null;
  const id = crypto.randomBytes(9).toString("hex");
  const o = {
    id, bundle: b.id, amount: b.amount + b.bonus, price_cents: b.price_cents, currency: CURRENCY,
    player: String(player || "").slice(0, 20), status: "pending", claimed: false, created: Date.now(), provider_ref: "",
  };
  orders.set(id, o);
  return o;
}

async function createCheckout(bundleId, player, baseUrl) {
  if (MODE === "off") return { error: "Store is closed", code: 503 };
  const o = newOrder(bundleId, player);
  if (!o) return { error: "Unknown bundle", code: 400 };
  if (MODE === "stripe") {
    const url = await stripeSession(o);
    if (!url) {
      o.status = "failed";
      return { error: "Payment provider error", code: 502 };
    }
    return { order_id: o.id, url, mode: MODE };
  }
  return { order_id: o.id, url: `${baseUrl}/pay/${o.id}`, mode: MODE };
}

function getOrder(id) {
  const o = orders.get(String(id));
  if (!o) return null;
  return { id: o.id, status: o.status, amount: o.amount, price_cents: o.price_cents, currency: o.currency, claimed: o.claimed };
}

// Returns the amount once per paid order, so a order can never be credited twice.
function claim(id) {
  const o = orders.get(String(id));
  if (!o || o.status !== "paid" || o.claimed) return 0;
  o.claimed = true;
  return o.amount;
}

function setStatus(id, status) {
  const o = orders.get(String(id));
  if (o && o.status === "pending") o.status = status;
  return o;
}

function money(cents, cur) {
  return (cents / 100).toFixed(2) + " " + cur.toUpperCase();
}

// ------------------------------------------------------------------ mock checkout page
function mockPage(id) {
  const o = orders.get(String(id));
  if (!o) return page("Order not found", "<p>This order does not exist or has expired.</p>");
  if (o.status !== "pending") return page("Order " + o.status, `<p>This order is already <b>${o.status}</b>. You can go back to the game.</p>`);
  return page("Oblox checkout",
    `<div class="badge">TEST MODE · no real money</div>
     <h1>◆ ${o.amount.toLocaleString("en-US")} ObloxBux</h1>
     <p class="muted">Order ${o.id}</p>
     <div class="row"><span>Total</span><b>${money(o.price_cents, o.currency)}</b></div>
     <p class="muted">This is the place where a real payment page (Stripe, Xsolla, YooKassa…) will open later.</p>
     <form method="post" action="/pay/${o.id}/confirm"><button class="pay">Pay (test)</button></form>
     <form method="post" action="/pay/${o.id}/cancel"><button class="cancel">Cancel</button></form>`);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;background:#0c0d10;color:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#191c22;border:1px solid #2a2e38;border-radius:18px;padding:32px;width:min(420px,90vw)}
h1{margin:12px 0 4px}.muted{color:#8b909c}.badge{display:inline-block;background:#c6f43222;color:#c6f432;border-radius:10px;padding:4px 10px;font-size:12px;font-weight:700}
.row{display:flex;justify-content:space-between;margin:18px 0;font-size:18px}button{width:100%;border:0;border-radius:10px;padding:12px;font-size:16px;font-weight:700;margin-top:8px;cursor:pointer}
.pay{background:#c6f432;color:#0c0d10}.cancel{background:#22262e;color:#f4f5f7}</style></head><body><main>${body}</main></body></html>`;
}

function resultPage(ok) {
  return page(ok ? "Payment complete" : "Payment canceled",
    ok ? `<h1>✓ Paid</h1><p>Go back to Oblox — your ObloxBux are being added.</p>`
       : `<h1>Canceled</h1><p>No money was taken. You can close this tab.</p>`);
}

// ------------------------------------------------------------------ Stripe (untested skeleton)
async function stripeSession(o) {
  const key = process.env.STRIPE_SECRET_KEY;
  const base = process.env.PUBLIC_URL;
  if (!key || !base) return null;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": o.currency,
    "line_items[0][price_data][unit_amount]": String(o.price_cents),
    "line_items[0][price_data][product_data][name]": `${o.amount} ObloxBux`,
    client_reference_id: o.id,
    success_url: `${base}/pay/${o.id}/done`,
    cancel_url: `${base}/pay/${o.id}/cancel`,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!r.ok) return null;
  const s = await r.json();
  o.provider_ref = s.id;
  return s.url;
}

// Stripe calls this; only a verified "checkout.session.completed" marks an order paid.
function stripeWebhook(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(String(sigHeader).split(",").map((kv) => kv.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  if (!parts.v1 || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const ev = JSON.parse(rawBody);
  if (ev.type === "checkout.session.completed" && ev.data.object.payment_status === "paid") {
    setStatus(ev.data.object.client_reference_id, "paid");
  }
  return true;
}

module.exports = { MODE, publicInfo, createCheckout, getOrder, claim, setStatus, mockPage, resultPage, stripeWebhook };
