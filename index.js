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

// service_role / sb_secret key — full DB access, backend only, never sent to the browser
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());

/* ---------------------------------------------------------
   CREATE PAYMENT INTENT  (QR Ph)
   Called from Checkout.js when the customer hits "Pay".
   Body: { orderId: number, amount: number }  -- amount in PESOS (e.g. 250.00)
--------------------------------------------------------- */
app.post('/create-payment-intent', express.json(), async (req, res) => {
    try {
        const { orderId, amount } = req.body;

        if (!orderId || !amount) {
            return res.status(400).json({ error: 'orderId and amount are required.' });
        }

        // PayMongo expects the amount in centavos (smallest currency unit)
        const amountInCentavos = Math.round(Number(amount) * 100);

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
        await supabaseAdmin
            .from('orders')
            .update({ payment_reference: paymentIntentId })
            .eq('id', orderId);

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
   WEBHOOK  — PayMongo calls this automatically
   Must use express.raw() here (NOT express.json()) so we can
   verify the signature against the exact raw bytes PayMongo sent.
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
            const { t, te } = parts; // using "te" since we're in TEST mode — switch to "li" once you go live

            const signedPayload = `${t}.${req.body.toString()}`;
            const expectedSignature = crypto
                .createHmac('sha256', PAYMONGO_WEBHOOK_SECRET)
                .update(signedPayload)
                .digest('hex');

            const isValid =
                te &&
                crypto.timingSafeEqual(
                    Buffer.from(expectedSignature),
                    Buffer.from(te)
                );

            if (!isValid) {
                console.error('Webhook signature verification failed.');
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

                if (error) console.error('Failed to update order to paid:', error);
            }

            if (eventType === 'payment.failed') {
                const paymentIntentId = eventPayload.attributes.payment_intent_id;
                console.warn(`Payment failed for intent ${paymentIntentId}`);
                // Order stays "pending" — customer can retry.
            }

            if (eventType === 'qrph.expired') {
                console.warn('A QR Ph code expired before payment.');
                // Order stays "pending" — customer needs a fresh QR code.
            }

            res.sendStatus(200); // PayMongo retries up to 12x if you don't return 2xx
        } catch (err) {
            console.error('Unexpected error in /paymongo-webhook:', err);
            res.sendStatus(500);
        }
    }
);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});