require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
// Node 18+ has fetch() built in globally — no need to require node-fetch.

const app = express();
const PORT = process.env.PORT || 3000;

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY;
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET; // added after you register the webhook in the PayMongo dashboard
const PAYMONGO_AUTH = 'Basic ' + Buffer.from(PAYMONGO_SECRET_KEY + ':').toString('base64');

// Test keys start with sk_test_, live keys with sk_live_.
// Used below to pick the right signature field from the webhook header.
const IS_LIVE_MODE = (PAYMONGO_SECRET_KEY || '').startsWith('sk_live');

// service_role / sb_secret key — full DB access, backend only, never sent to the browser
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());

/* ---------------------------------------------------------
   HEALTH CHECK
   Lets you (or a free uptime pinger such as UptimeRobot) hit the
   server every few minutes so Render doesn't put it to sleep.
--------------------------------------------------------- */
app.get('/', (req, res) => {
    res.send('Crinkzie payment server is running.');
});

/* ---------------------------------------------------------
   HELPER: ask PayMongo for the real status of a payment intent.
   Returns e.g. "awaiting_payment_method", "awaiting_next_action",
   "processing", or "succeeded".
--------------------------------------------------------- */
async function fetchIntentStatus(paymentIntentId) {
    const r = await fetch(`https://api.paymongo.com/v1/payment_intents/${paymentIntentId}`, {
        headers: { Authorization: PAYMONGO_AUTH }
    });
    const body = await r.json();
    if (!r.ok) {
        throw new Error('PayMongo lookup failed: ' + JSON.stringify(body));
    }
    return body.data.attributes.status;
}

/* ---------------------------------------------------------
   CREATE PAYMENT INTENT  (QR Ph)
   Called from PaymentFlow.js when the customer hits "Pay".
   Body: { orderId: number }
   The amount is read from the database, NOT from the browser,
   so a customer can't tamper with how much they pay.
--------------------------------------------------------- */
app.post('/create-payment-intent', express.json(), async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required.' });
        }

        // 0. Look up the real order total from Supabase
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .select('id, total_amount, status')
            .eq('id', orderId)
            .single();

        if (orderError || !order) {
            console.error('Order lookup failed:', orderError);
            return res.status(404).json({ error: 'Order not found.' });
        }

        if (order.status === 'paid' || order.status === 'completed') {
            return res.status(400).json({ error: 'This order has already been paid.' });
        }

        // PayMongo expects the amount in centavos (smallest currency unit)
        const amountInCentavos = Math.round(Number(order.total_amount) * 100);

        if (!Number.isFinite(amountInCentavos) || amountInCentavos <= 0) {
            return res.status(400).json({ error: 'Invalid order amount.' });
        }

        // 1. Create the Payment Intent
        const intentRes = await fetch('https://api.paymongo.com/v1/payment_intents', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: PAYMONGO_AUTH
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        amount: amountInCentavos,
                        payment_method_allowed: ['qrph'],
                        payment_method_options: {
                            qrph: { request_referral_url: false }
                        },
                        currency: 'PHP',
                        description: `Order #${orderId}`,
                        metadata: { order_id: String(orderId) }
                    }
                }
            })
        });

        const intentData = await intentRes.json();
        if (!intentRes.ok) {
            console.error('PayMongo Payment Intent error:', intentData);
            return res.status(500).json({ error: 'Failed to create payment intent.' });
        }

        const paymentIntentId = intentData.data.id;
        const clientKey = intentData.data.attributes.client_key;

        // 2. Create a QR Ph Payment Method
        const methodRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: PAYMONGO_AUTH
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        type: 'qrph',
                        billing: {
                            name: 'Crinkzie Customer',
                            email: 'customer@example.com' // swap for the real logged-in customer's email if you have it
                        }
                    }
                }
            })
        });

        const methodData = await methodRes.json();
        if (!methodRes.ok) {
            console.error('PayMongo Payment Method error:', methodData);
            return res.status(500).json({ error: 'Failed to create payment method.' });
        }

        const paymentMethodId = methodData.data.id;

        // 3. Attach the Payment Method to the Payment Intent
        const attachRes = await fetch(
            `https://api.paymongo.com/v1/payment_intents/${paymentIntentId}/attach`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: PAYMONGO_AUTH
                },
                body: JSON.stringify({
                    data: {
                        attributes: {
                            payment_method: paymentMethodId,
                            client_key: clientKey
                        }
                    }
                })
            }
        );

        const attachData = await attachRes.json();
        if (!attachRes.ok) {
            console.error('PayMongo Attach error:', attachData);
            return res.status(500).json({ error: 'Failed to attach payment method.' });
        }

        const qrImageUrl = attachData.data.attributes.next_action?.code?.image_url;

        // Save the payment_intent id on the order now, so the webhook can find
        // this order later purely from PayMongo's event payload.
        const { error: refError } = await supabaseAdmin
            .from('orders')
            .update({ payment_reference: paymentIntentId })
            .eq('id', orderId);

        if (refError) {
            console.error('Failed to save payment_reference:', refError);
            return res.status(500).json({ error: 'Failed to link payment to order.' });
        }

        res.json({
            paymentIntentId,
            qrImageUrl,
            expiresInSeconds: 1800 // QR Ph codes expire after 30 minutes
        });
    } catch (err) {
        console.error('Unexpected error in /create-payment-intent:', err);
        res.status(500).json({ error: 'Something went wrong creating the payment.' });
    }
});

/* ---------------------------------------------------------
   CHECK PAYMENT  (backup for the webhook)
   The browser polls this while the QR is on screen. If the order isn't
   marked paid yet, we ask PayMongo directly; if PayMongo says the payment
   succeeded, we mark the order paid right here. This means a customer who
   paid is never left stuck, even if the webhook is down or disabled.
   It only ever marks an order paid when PayMongo itself says it succeeded.
--------------------------------------------------------- */
app.get('/check-payment/:orderId', async (req, res) => {
    try {
        const orderId = Number(req.params.orderId);
        if (!Number.isInteger(orderId)) {
            return res.status(400).json({ error: 'Invalid order id.' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .select('id, status, payment_reference')
            .eq('id', orderId)
            .maybeSingle();

        if (error || !order) {
            return res.status(404).json({ error: 'Order not found.' });
        }

        // Already paid, or a cash order with no online payment to check.
        if (
            order.status === 'paid' ||
            order.status === 'completed' ||
            !order.payment_reference
        ) {
            return res.json({ status: order.status });
        }

        const intentStatus = await fetchIntentStatus(order.payment_reference);

        if (intentStatus === 'succeeded') {
            const { error: updateError } = await supabaseAdmin
                .from('orders')
                .update({ status: 'paid' })
                .eq('id', orderId)
                .in('status', ['awaiting_payment', 'pending']);

            if (updateError) {
                console.error('Failed to mark order paid:', updateError);
                return res.json({ status: order.status });
            }

            console.log(`Order ${orderId} marked paid via /check-payment.`);
            return res.json({ status: 'paid' });
        }

        res.json({ status: order.status });
    } catch (err) {
        console.error('Unexpected error in /check-payment:', err);
        res.status(500).json({ error: 'Could not check payment.' });
    }
});

/* ---------------------------------------------------------
   WEBHOOK  — PayMongo calls this automatically
   Must use express.raw() here (NOT express.json()) so we can
   verify the signature against the exact raw bytes PayMongo sent.

   PayMongo DISABLES the webhook if it keeps getting 4xx/5xx replies,
   so after the signature checks out we always reply 200 and just log
   any problem (the /check-payment route and the sweep below recover
   anything the webhook misses).
--------------------------------------------------------- */
app.post(
    '/paymongo-webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const signatureHeader = req.headers['paymongo-signature'];
            if (!signatureHeader || !PAYMONGO_WEBHOOK_SECRET) {
                console.error('Missing signature header or webhook secret.');
                return res.sendStatus(401);
            }

            // Paymongo-Signature format: t=...,te=...,li=...
            const parts = Object.fromEntries(
                signatureHeader.split(',').map(p => p.split('='))
            );
            const { t, te, li } = parts;

            // "te" is the test-mode signature, "li" is the live-mode one.
            // Picked automatically from the type of secret key in use.
            const receivedSignature = IS_LIVE_MODE ? li : te;

            const signedPayload = `${t}.${req.body.toString()}`;
            const expectedSignature = crypto
                .createHmac('sha256', PAYMONGO_WEBHOOK_SECRET)
                .update(signedPayload)
                .digest('hex');

            // timingSafeEqual throws if lengths differ, so check length first
            const expectedBuf = Buffer.from(expectedSignature);
            const receivedBuf = Buffer.from(receivedSignature || '');

            const isValid =
                !!receivedSignature &&
                expectedBuf.length === receivedBuf.length &&
                crypto.timingSafeEqual(expectedBuf, receivedBuf);

            if (!isValid) {
                console.error(
                    'Webhook signature verification failed. Check that PAYMONGO_WEBHOOK_SECRET ' +
                    'is the secret of the webhook registered in the SAME mode (test/live) as your API key.'
                );
                return res.sendStatus(401);
            }

            const event = JSON.parse(req.body.toString());
            const eventType = event.data.attributes.type;
            const eventPayload = event.data.attributes.data;

            console.log('Received verified PayMongo event:', eventType);

            if (eventType === 'payment.paid') {
                const paymentIntentId = eventPayload.attributes.payment_intent_id;

                const { error } = await supabaseAdmin
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('payment_reference', paymentIntentId);

                if (error) {
                    // Don't reply 500: that can get the webhook disabled.
                    // /check-payment and the sweep will still mark it paid.
                    console.error('Failed to update order to paid:', error);
                }
            }

            if (eventType === 'payment.failed') {
                const paymentIntentId = eventPayload.attributes.payment_intent_id;
                console.warn(`Payment failed for intent ${paymentIntentId}`);
            }

            if (eventType === 'qrph.expired') {
                console.warn('A QR Ph code expired before payment.');
            }

            res.sendStatus(200);
        } catch (err) {
            console.error('Unexpected error in /paymongo-webhook:', err);
            // Still 200: this is our bug, not PayMongo's, and a non-2xx here
            // can get the webhook disabled.
            res.sendStatus(200);
        }
    }
);

/* ---------------------------------------------------------
   SWEEP STALE UNPAID ORDERS
   Runs on startup and every 10 minutes. For every "awaiting_payment" order
   older than 35 minutes (the QR has expired by then):
     - if PayMongo says it was actually paid → mark it paid (never lose a payment)
     - if PayMongo says it was not paid       → delete the order and its items
     - if PayMongo can't be reached           → leave it, try again next time
   This replaces the Supabase pg_cron job, which could not check PayMongo.
--------------------------------------------------------- */
const STALE_AFTER_MINUTES = 35;

async function sweepStaleUnpaidOrders() {
    try {
        const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();

        const { data: staleOrders, error } = await supabaseAdmin
            .from('orders')
            .select('id, payment_reference')
            .eq('status', 'awaiting_payment')
            .lt('created_at', cutoff);

        if (error) {
            console.error('Sweep: could not load stale orders:', error);
            return;
        }

        for (const order of staleOrders || []) {
            if (order.payment_reference) {
                try {
                    const intentStatus = await fetchIntentStatus(order.payment_reference);

                    if (intentStatus === 'succeeded') {
                        await supabaseAdmin
                            .from('orders')
                            .update({ status: 'paid' })
                            .eq('id', order.id)
                            .eq('status', 'awaiting_payment');
                        console.log(`Sweep: order ${order.id} was actually paid — marked paid.`);
                        continue;
                    }
                } catch (err) {
                    console.error(`Sweep: could not verify order ${order.id}, leaving it:`, err.message);
                    continue;
                }
            }

            await supabaseAdmin.from('order_items').delete().eq('order_id', order.id);
            await supabaseAdmin
                .from('orders')
                .delete()
                .eq('id', order.id)
                .eq('status', 'awaiting_payment');
            console.log(`Sweep: removed unpaid order ${order.id}.`);
        }
    } catch (err) {
        console.error('Sweep: unexpected error:', err);
    }
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    sweepStaleUnpaidOrders();
    setInterval(sweepStaleUnpaidOrders, 10 * 60 * 1000);
});