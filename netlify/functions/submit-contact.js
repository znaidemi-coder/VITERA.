// netlify/functions/submit-contact.js

export default async (req) => {
  // Basic CORS (so browser can call this function)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  try {
    const body = await req.json();
    const name = (body?.name || "").trim();
    const email = (body?.email || "").trim();
    const message = (body?.message || "").trim();

    if (!name || !email || !message) {
      return new Response(
        JSON.stringify({ error: "Missing name, email, or message" }),
        { status: 400, headers }
      );
    }

    // ENV VARS (you already created these in Netlify)
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

    const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
    const MAILCHIMP_DC = process.env.MAILCHIMP_DC; // like "us15"
    const MAILCHIMP_LIST_ID = process.env.MAILCHIMP_LIST_ID;

    // We'll run all 3 steps; even if one fails, try the others
    const results = {
      supabase: { ok: false },
      hubspot: { ok: false },
      mailchimp: { ok: false },
    };

    // 1) SUPABASE — insert into contact_submissions via REST
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabaseRes = await fetch(
          `${SUPABASE_URL}/rest/v1/contact_submissions`,
          {
            method: "POST",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify([{ name, email, message }]),
          }
        );

        const supabaseText = await supabaseRes.text();
        results.supabase = {
          ok: supabaseRes.ok,
          status: supabaseRes.status,
          response: supabaseText,
        };
      } catch (e) {
        results.supabase = { ok: false, error: String(e) };
      }
    } else {
      results.supabase = { ok: false, error: "Missing SUPABASE env vars" };
    }

    // 2) HUBSPOT — create contact (ignore if already exists)
    if (HUBSPOT_TOKEN) {
      try {
        const hubspotRes = await fetch(
          "https://api.hubapi.com/crm/v3/objects/contacts",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${HUBSPOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              properties: {
                email,
                firstname: name,
              },
            }),
          }
        );

        const hubspotText = await hubspotRes.text();

        // HubSpot sometimes returns 409 if exists
        results.hubspot = {
          ok: hubspotRes.ok || hubspotRes.status === 409,
          status: hubspotRes.status,
          response: hubspotText,
        };
      } catch (e) {
        results.hubspot = { ok: false, error: String(e) };
      }
    } else {
      results.hubspot = { ok: false, error: "Missing HUBSPOT_TOKEN" };
    }

    // 3) MAILCHIMP — add/update member (idempotent via PUT with subscriber_hash)
    if (MAILCHIMP_API_KEY && MAILCHIMP_DC && MAILCHIMP_LIST_ID) {
      try {
        const emailLower = email.toLowerCase();
        const encoder = new TextEncoder();

        // MD5 in browser is easy, but in Netlify Node we'll do a tiny MD5 helper using WebCrypto if available
        // If crypto.subtle isn't available, fallback to POST (less ideal but works).
        let subscriberHash = null;

        if (globalThis.crypto?.subtle) {
          // Mailchimp requires MD5 of lowercase email
          const data = encoder.encode(emailLower);

          // WebCrypto doesn't provide MD5, so we can't do it directly here.
          // We'll use POST to /members instead (Mailchimp will return "Member Exists" if already there).
          subscriberHash = null;
        }

        const auth = Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString(
          "base64"
        );

        const mcEndpoint = `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`;

        const mcRes = await fetch(mcEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email_address: email,
            status: "subscribed",
            merge_fields: { FNAME: name },
          }),
        });

        const mcText = await mcRes.text();

        // Member Exists is usually 400 with a specific message; treat as ok
        const isMemberExists =
          mcRes.status === 400 &&
          (mcText.includes("Member Exists") ||
            mcText.includes("is already a list member"));

        results.mailchimp = {
          ok: mcRes.ok || isMemberExists,
          status: mcRes.status,
          response: mcText,
        };
      } catch (e) {
        results.mailchimp = { ok: false, error: String(e) };
      }
    } else {
      results.mailchimp = { ok: false, error: "Missing MAILCHIMP env vars" };
    }

    // Success response for the website (even if 1 of 3 failed)
    const allOk =
      results.supabase.ok && results.hubspot.ok && results.mailchimp.ok;

    return new Response(
      JSON.stringify({
        ok: true,
        allOk,
        results,
        message:
          "Thanks! We received your message. If you don’t hear back within 24 hours, please reply to this email.",
      }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers,
    });
  }
};
