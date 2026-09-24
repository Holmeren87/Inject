const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ALLOWED_FILE_EXTENSIONS = new Set(["step","stp","stl","pdf","dxf","jpg","jpeg","png","webp","heic","heif"]);
const MAX_FILES = 8;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "inject-api", email_configured: Boolean(env.RESEND_API_KEY) });
      }

      if (url.pathname === "/api/rfq" && request.method === "POST") {
        return createRfq(request, env);
      }

      if (url.pathname === "/api/events" && request.method === "POST") {
        return recordPublicEvent(request, env);
      }

      if (url.pathname === "/admin/api/requests" && request.method === "GET") {
        const auth = requireAdmin(request, url);
        if (auth instanceof Response) return auth;
        return listRequests(request, env);
      }

      const requestMatch = url.pathname.match(/^\/admin\/api\/requests\/(INJ-\d{4}-\d{6})$/);
      if (requestMatch && request.method === "GET") {
        const auth = requireAdmin(request, url);
        if (auth instanceof Response) return auth;
        return getRequest(requestMatch[1], env);
      }
      if (requestMatch && request.method === "PATCH") {
        const auth = requireAdmin(request, url);
        if (auth instanceof Response) return auth;
        return updateRequest(requestMatch[1], request, env, auth.email);
      }

      const fileMatch = url.pathname.match(/^\/admin\/api\/files\/(\d+)$/);
      if (fileMatch && request.method === "GET") {
        const auth = requireAdmin(request, url);
        if (auth instanceof Response) return auth;
        return downloadFile(Number(fileMatch[1]), env);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Inject API error", error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function requireAdmin(request, url) {
  if (url.hostname !== "inject.dk") {
    return json({ ok: false, error: "admin_host_not_allowed" }, 403);
  }
  const email = request.headers.get("cf-access-authenticated-user-email");
  if (!email) {
    return json({ ok: false, error: "access_required" }, 401);
  }
  return { email: email.toLowerCase() };
}

async function parsePayload(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const data = {};
    const files = [];
    for (const [key, value] of form.entries()) {
      if (value instanceof File) files.push(value);
      else data[key] = value;
    }
    return { data, files };
  }
  if (type.includes("application/json")) {
    return { data: await request.json(), files: [] };
  }
  throw new HttpError(415, "unsupported_content_type");
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function text(value, max = 4000) {
  if (value == null) return null;
  const v = String(value).trim();
  return v ? v.slice(0, max) : null;
}

function email(value) {
  const v = text(value, 320);
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v.toLowerCase();
}

function positiveInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100000000 ? n : null;
}

function money(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function quantityBucket(n) {
  if (!n) return "unknown";
  if (n <= 1000) return "0-1000";
  if (n <= 5000) return "1001-5000";
  if (n <= 10000) return "5001-10000";
  if (n <= 25000) return "10001-25000";
  return "25001+";
}

function normalizedQuantityBucket(value, quantity) {
  const allowed = new Set(["0-1000","1001-5000","5001-10000","10001-25000","25001+","unknown"]);
  const v = text(value, 40);
  if (v && allowed.has(v)) return v;
  return quantityBucket(quantity);
}

function sanitizeFilename(name) {
  const cleaned = String(name || "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 140);
  return cleaned || "file";
}

function extension(name) {
  const parts = String(name).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

async function nextCaseNumber(env, year) {
  const counter = `request_sequence_${year}`;
  await env.DB.prepare("INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)").bind(counter).run();
  const row = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value").bind(counter).first();
  if (!row || !row.value) throw new Error("counter_failed");
  return `INJ-${year}-${String(row.value).padStart(6, "0")}`;
}

async function createRfq(request, env) {
  try {
    const { data, files } = await parsePayload(request);

    const contactName = text(data.contact_name || data.name, 180);
    const customerEmail = email(data.email);
    const description = text(data.description || data.message, 6000);

    if (!contactName || !customerEmail || !description) {
      throw new HttpError(400, "missing_required_fields");
    }

    if (files.length > MAX_FILES) throw new HttpError(400, "too_many_files");

    let totalBytes = 0;
    for (const file of files) {
      const ext = extension(file.name);
      if (!ALLOWED_FILE_EXTENSIONS.has(ext)) throw new HttpError(400, "file_type_not_allowed");
      if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw new HttpError(400, "file_too_large");
      totalBytes += file.size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(400, "files_total_too_large");

    const quantity = positiveInt(data.quantity);
    const quantityBucketValue = normalizedQuantityBucket(data.quantity_bucket, quantity);
    const annualQuantity = positiveInt(data.annual_quantity);
    const now = new Date();
    const year = now.getUTCFullYear();
    const caseNumber = await nextCaseNumber(env, year);

    const customerResult = await env.DB.prepare(
      "INSERT INTO customers(company_name, contact_name, email, phone, vat_number, country_code) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      text(data.company_name || data.company, 240),
      contactName,
      customerEmail,
      text(data.phone, 80),
      text(data.vat_number || data.cvr, 40),
      text(data.country_code, 2) || "DK"
    ).run();

    const customerId = customerResult.meta?.last_row_id;
    if (!customerId) throw new Error("customer_insert_failed");

    const requestResult = await env.DB.prepare(
      `INSERT INTO requests(
        case_number, customer_id, description, quantity, quantity_bucket, annual_quantity,
        material, material_other, color, delivery_bucket, delivery_date,
        current_process, current_unit_price, source, landing_page, referrer,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      caseNumber,
      customerId,
      description,
      quantity,
      quantityBucketValue,
      annualQuantity,
      text(data.material, 120) || "Ved ikke",
      text(data.material_other, 200),
      text(data.color, 120),
      text(data.delivery_bucket || data.delivery, 120) || "Ikke angivet",
      text(data.delivery_date, 30),
      text(data.current_process, 160),
      money(data.current_unit_price),
      text(data.source, 160),
      text(data.landing_page, 1200),
      text(data.referrer, 1200),
      text(data.utm_source, 240),
      text(data.utm_medium, 240),
      text(data.utm_campaign, 240),
      text(data.utm_term, 240),
      text(data.utm_content, 240),
      text(data.gclid, 500)
    ).run();

    const requestId = requestResult.meta?.last_row_id;
    if (!requestId) throw new Error("request_insert_failed");

    const storedFiles = [];
    for (const file of files) {
      const safeName = sanitizeFilename(file.name);
      const ext = extension(safeName);
      const key = `rfq/${caseNumber}/${crypto.randomUUID()}-${safeName}`;
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");

      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { caseNumber, originalName: file.name, sha256 }
      });

      const fileResult = await env.DB.prepare(
        "INSERT INTO request_files(request_id, original_name, storage_key, mime_type, extension, size_bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(requestId, file.name, key, file.type || null, ext, file.size, sha256).run();

      storedFiles.push({
        id: fileResult.meta?.last_row_id || null,
        name: file.name,
        size: file.size,
        extension: ext
      });
    }

    await env.DB.prepare(
      "INSERT INTO request_events(request_id, event_name, event_value, session_id, page_url) VALUES (?, ?, ?, ?, ?)"
    ).bind(
      requestId,
      "rfq_submitted",
      JSON.stringify({ files: storedFiles.length, quantity_bucket: quantityBucketValue }),
      text(data.session_id, 160),
      text(data.landing_page, 1200)
    ).run();

    await env.DB.prepare(
      "INSERT INTO audit_log(request_id, actor, action, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(requestId, "public_form", "request_created", "status", null, "new").run();

    const notification = await sendLeadNotification(env, {
      caseNumber,
      companyName: text(data.company_name || data.company, 240),
      contactName,
      quantityBucket: quantityBucketValue,
      material: text(data.material, 120) || "Ved ikke",
      delivery: text(data.delivery_bucket || data.delivery, 120) || "Ikke angivet"
    });

    await env.DB.prepare(
      "INSERT INTO request_events(request_id, event_name, event_value, session_id, page_url) VALUES (?, ?, ?, ?, ?)"
    ).bind(
      requestId,
      notification.sent ? "lead_notification_sent" : (notification.skipped ? "lead_notification_skipped" : "lead_notification_failed"),
      JSON.stringify(notification),
      text(data.session_id, 160),
      text(data.landing_page, 1200)
    ).run();

    return json({
      ok: true,
      case_number: caseNumber,
      files: storedFiles,
      notification_sent: Boolean(notification.sent),
      message: "Forespørgslen er modtaget."
    }, 201);
  } catch (error) {
    if (error instanceof HttpError) return json({ ok: false, error: error.code }, error.status);
    console.error("createRfq", error);
    return json({ ok: false, error: "request_failed" }, 500);
  }
}

async function sendLeadNotification(env, lead) {
  if (!env.RESEND_API_KEY) return { skipped: true, reason: "resend_api_key_missing" };

  const subject = `Nyt lead på Inject · ${lead.caseNumber}`;
  const textBody =
    `Nyt lead på Inject\n\n` +
    `Sagsnr.: ${lead.caseNumber}\n` +
    `Kunde: ${lead.companyName || "Privat"}\n` +
    `Kontakt: ${lead.contactName}\n` +
    `Antal: ${lead.quantityBucket || "Ikke angivet"}\n` +
    `Materiale: ${lead.material || "Ved ikke"}\n` +
    `Levering: ${lead.delivery || "Ikke angivet"}\n\n` +
    `Åbn admin: https://inject.dk/admin/\n`;

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">' +
    '<h2 style="margin:0 0 14px">Nyt lead på Inject</h2>' +
    '<p><strong>Sagsnr.:</strong> ' + escapeHtml(lead.caseNumber) + '<br>' +
    '<strong>Kunde:</strong> ' + escapeHtml(lead.companyName || "Privat") + '<br>' +
    '<strong>Kontakt:</strong> ' + escapeHtml(lead.contactName) + '<br>' +
    '<strong>Antal:</strong> ' + escapeHtml(lead.quantityBucket || "Ikke angivet") + '<br>' +
    '<strong>Materiale:</strong> ' + escapeHtml(lead.material || "Ved ikke") + '<br>' +
    '<strong>Levering:</strong> ' + escapeHtml(lead.delivery || "Ikke angivet") + '</p>' +
    '<p><a href="https://inject.dk/admin/">Åbn Inject Admin</a></p>' +
    '</div>';

  const requestBody = JSON.stringify({
    from: "Inject Leads <leads@notify.inject.dk>",
    to: ["contact@inject.dk"],
    subject,
    text: textBody,
    html: htmlBody
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "authorization": "Bearer " + env.RESEND_API_KEY,
          "content-type": "application/json",
          "Idempotency-Key": "inject-lead/" + lead.caseNumber
        },
        body: requestBody
      });

      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        return { sent: true, provider: "resend", id: payload?.id || null, attempts: attempt };
      }

      lastError = { status: response.status, error: payload?.message || "resend_failed" };
      console.error("Resend lead notification failed", attempt, response.status, payload);

      // Do not retry permanent 4xx errors. 429 and 5xx may be transient.
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = { error: String(error && error.message || error) };
      console.error("lead notification failed", attempt, error);
    }

    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 350));
  }

  return { sent: false, provider: "resend", attempts: 3, ...(lastError || { error: "resend_failed" }) };
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[ch];
  });
}

async function recordPublicEvent(request, env) {
  try {
    const { data } = await parsePayload(request);
    const allowed = new Set(["form_started","file_added","form_validation_error"]);
    const eventName = text(data.event_name, 80);
    if (!allowed.has(eventName)) throw new HttpError(400, "event_not_allowed");

    await env.DB.prepare(
      "INSERT INTO request_events(request_id, event_name, event_value, session_id, page_url) VALUES (NULL, ?, ?, ?, ?)"
    ).bind(
      eventName,
      text(data.event_value, 1200),
      text(data.session_id, 160),
      text(data.page_url, 1200)
    ).run();

    return json({ ok: true }, 201);
  } catch (error) {
    if (error instanceof HttpError) return json({ ok: false, error: error.code }, error.status);
    return json({ ok: false, error: "event_failed" }, 500);
  }
}

async function listRequests(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 250, 1), 500);
  const status = text(url.searchParams.get("status"), 40);
  const material = text(url.searchParams.get("material"), 120);
  const q = text(url.searchParams.get("q"), 200);

  const where = [];
  const binds = [];

  if (status) { where.push("r.status = ?"); binds.push(status); }
  if (material) { where.push("r.material = ?"); binds.push(material); }
  if (q) {
    where.push("(r.case_number LIKE ? OR c.company_name LIKE ? OR c.contact_name LIKE ? OR c.email LIKE ? OR r.description LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }

  const sql = `
    SELECT
      r.id, r.case_number, r.description, r.quantity, r.quantity_bucket, r.annual_quantity,
      r.material, r.material_other, r.color, r.delivery_bucket, r.delivery_date,
      r.current_process, r.current_unit_price, r.status, r.source,
      r.landing_page, r.referrer, r.utm_source, r.utm_medium, r.utm_campaign,
      r.first_response_at, r.quote_sent_at, r.quote_amount, r.won_at, r.lost_at, r.lost_reason,
      r.assigned_to, r.internal_note, r.created_at, r.updated_at,
      c.company_name, c.contact_name, c.email, c.phone, c.vat_number, c.country_code,
      COUNT(f.id) AS file_count,
      GROUP_CONCAT(f.original_name, '|||') AS file_names
    FROM requests r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN request_files f ON f.request_id = r.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY r.id
    ORDER BY r.created_at DESC
    LIMIT ?
  `;

  const result = await env.DB.prepare(sql).bind(...binds, limit).all();
  return json({ ok: true, requests: result.results || [] });
}

async function getRequest(caseNumber, env) {
  const row = await env.DB.prepare(
    `SELECT r.*, c.company_name, c.contact_name, c.email, c.phone, c.vat_number, c.country_code
     FROM requests r JOIN customers c ON c.id = r.customer_id
     WHERE r.case_number = ?`
  ).bind(caseNumber).first();

  if (!row) return json({ ok: false, error: "not_found" }, 404);

  const files = await env.DB.prepare(
    "SELECT id, original_name, mime_type, extension, size_bytes, sha256, uploaded_at FROM request_files WHERE request_id = ? ORDER BY uploaded_at"
  ).bind(row.id).all();

  const events = await env.DB.prepare(
    "SELECT id, event_name, event_value, created_at FROM request_events WHERE request_id = ? ORDER BY created_at DESC LIMIT 100"
  ).bind(row.id).all();

  const audit = await env.DB.prepare(
    "SELECT id, actor, action, field_name, old_value, new_value, created_at FROM audit_log WHERE request_id = ? ORDER BY created_at DESC LIMIT 100"
  ).bind(row.id).all();

  return json({ ok: true, request: row, files: files.results || [], events: events.results || [], audit: audit.results || [] });
}

async function updateRequest(caseNumber, request, env, actorEmail) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const row = await env.DB.prepare("SELECT * FROM requests WHERE case_number = ?").bind(caseNumber).first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);

  const setters = [];
  const values = [];
  const audits = [];

  const setField = (field, value) => {
    const oldValue = row[field] == null ? null : String(row[field]);
    const newValue = value == null ? null : String(value);
    if (oldValue === newValue) return;
    setters.push(`${field} = ?`);
    values.push(value);
    audits.push([field, oldValue, newValue]);
  };

  if ("status" in body) {
    const allowed = new Set(["new","reviewing","quoted","won","lost","closed"]);
    if (!allowed.has(body.status)) return json({ ok: false, error: "invalid_status" }, 400);
    setField("status", body.status);
    if (body.status === "quoted" && !row.quote_sent_at) setField("quote_sent_at", new Date().toISOString());
    if (body.status === "won" && !row.won_at) setField("won_at", new Date().toISOString());
    if (body.status === "lost" && !row.lost_at) setField("lost_at", new Date().toISOString());
  }
  if ("assigned_to" in body) setField("assigned_to", text(body.assigned_to, 180));
  if ("internal_note" in body) setField("internal_note", text(body.internal_note, 6000));
  if ("quote_amount" in body) setField("quote_amount", money(body.quote_amount));
  if ("lost_reason" in body) setField("lost_reason", text(body.lost_reason, 1000));

  if (!setters.length) return json({ ok: true, unchanged: true });

  setters.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(caseNumber);

  await env.DB.prepare(`UPDATE requests SET ${setters.join(", ")} WHERE case_number = ?`).bind(...values).run();

  for (const [field, oldValue, newValue] of audits) {
    await env.DB.prepare(
      "INSERT INTO audit_log(request_id, actor, action, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(row.id, actorEmail, "field_updated", field, oldValue, newValue).run();
  }

  return json({ ok: true, case_number: caseNumber });
}

async function downloadFile(fileId, env) {
  const row = await env.DB.prepare(
    "SELECT original_name, storage_key, mime_type FROM request_files WHERE id = ?"
  ).bind(fileId).first();

  if (!row) return json({ ok: false, error: "not_found" }, 404);

  const object = await env.FILES.get(row.storage_key);
  if (!object) return json({ ok: false, error: "object_not_found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", row.mime_type || headers.get("content-type") || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  headers.set("cache-control", "private, no-store");

  return new Response(object.body, { headers });
}
