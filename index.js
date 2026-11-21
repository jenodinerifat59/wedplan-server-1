import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const {
  MONGODB_URI,
  DB_NAME = "wedplan",
  USERS_COLLECTION = "user", // Better Auth default collection name
  CLIENT_URL = "http://localhost:3000", // comma separated allowed origins
  BETTER_AUTH_URL = "http://localhost:3000", // where Better Auth runs (Next.js app)
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  IMGBB_API_KEY,
  ADMIN_EMAILS = "",
  PREMIUM_PRICE_CENTS = "1000",
  PORT = 5000,
} = process.env;

const ORIGINS = CLIENT_URL.split(",").map((s) => s.trim());
const CLIENT = ORIGINS[0];
const CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];
const FREE_LIMIT = 3;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/* ------------------------------ Database ------------------------------ */
const client = new MongoClient(MONGODB_URI);
let dbPromise;
const getDb = () =>
  (dbPromise ??= client.connect().then(async (c) => {
    const db = c.db(DB_NAME);
    await db
      .collection("transactions")
      .createIndex({ stripeSessionId: 1 }, { unique: true });
    await db.collection("services").createIndex({ vendorId: 1, status: 1 });
    await db.collection("bookings").createIndex({ vendorId: 1 });
    await db.collection("bookings").createIndex({ customerId: 1 });
    // Admin is assigned securely from the server env, never via public signup
    const admins = ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (admins.length) {
      await db
        .collection(USERS_COLLECTION)
        .updateMany({ email: { $in: admins } }, { $set: { role: "admin" } });
    }
    return db;
  }));
const col = async (name) => (await getDb()).collection(name);

/* ------------------------------ Helpers ------------------------------- */
const oid = (v) => (typeof v === "string" && /^[a-f\d]{24}$/i.test(v) ? new ObjectId(v) : null);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isPremium = (u) =>
  u?.subscriptionPlan === "premium" &&
  u?.subscriptionExpiresAt &&
  new Date(u.subscriptionExpiresAt) > new Date();
const str = (v) => (typeof v === "string" ? v.trim() : "");
const fail = (res, code, message) => res.status(code).json({ message });

const publicVendor = (u) =>
  u && {
    _id: u._id,
    name: u.name,
    image: u.image,
    businessName: u.businessName,
    isPremium: isPremium(u),
  };

async function withVendors(services) {
  const ids = [...new Set(services.map((s) => String(s.vendorId)))].map((i) => new ObjectId(i));
  const users = await (await col(USERS_COLLECTION)).find({ _id: { $in: ids } }).toArray();
  const map = new Map(users.map((u) => [String(u._id), publicVendor(u)]));
  return services.map((s) => ({ ...s, vendor: map.get(String(s.vendorId)) || null }));
}

async function withBookingDetails(bookings) {
  const sIds = [...new Set(bookings.map((b) => String(b.serviceId)))].map((i) => new ObjectId(i));
  const uIds = [
    ...new Set(bookings.flatMap((b) => [String(b.vendorId), String(b.customerId)])),
  ].map((i) => new ObjectId(i));
  const services = await (await col("services")).find({ _id: { $in: sIds } }).toArray();
  const users = await (await col(USERS_COLLECTION)).find({ _id: { $in: uIds } }).toArray();
  const sMap = new Map(services.map((s) => [String(s._id), s]));
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  return bookings.map((b) => {
    const s = sMap.get(String(b.serviceId));
    return {
      ...b,
      service: s && { _id: s._id, serviceName: s.serviceName, images: s.images, price: s.price },
      vendor: publicVendor(uMap.get(String(b.vendorId))),
      customer: uMap.get(String(b.customerId)) && {
        _id: b.customerId,
        name: uMap.get(String(b.customerId)).name,
        email: uMap.get(String(b.customerId)).email,
        image: uMap.get(String(b.customerId)).image,
      },
    };
  });
}

/* ------------------------- Stripe webhook (raw body) ------------------------- */
const periodEnd = (sub) => {
  const s = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return s ? new Date(s * 1000) : null;
};

async function activatePremium(vendorId, sub) {
  await (await col(USERS_COLLECTION)).updateOne(
    { _id: new ObjectId(vendorId) },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt: periodEnd(sub),
        stripeSubscriptionId: sub.id,
      },
    }
  );
}

async function saveTransaction({ vendorId, amount, currency, id, subId, status }) {
  await (await col("transactions")).updateOne(
    { stripeSessionId: id },
    {
      $setOnInsert: {
        vendorId: new ObjectId(vendorId),
        plan: "premium",
        amount,
        currency,
        stripeSessionId: id,
        stripeSubscriptionId: subId,
        status,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

const invoiceSubId = (inv) =>
  inv.parent?.subscription_details?.subscription ?? inv.subscription ?? null;

async function handleStripeEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || obj.payment_status !== "paid") break;
      const sub = await stripe.subscriptions.retrieve(obj.subscription);
      const vendorId = obj.metadata?.vendorId;
      if (!vendorId) break;
      await saveTransaction({
        vendorId,
        amount: obj.amount_total / 100,
        currency: obj.currency,
        id: obj.id,
        subId: sub.id,
        status: "paid",
      });
      await activatePremium(vendorId, sub);
      break;
    }
    case "invoice.paid": {
      if (obj.billing_reason !== "subscription_cycle") break; // first payment handled above
      const subId = invoiceSubId(obj);
      if (!subId) break;
      const sub = await stripe.subscriptions.retrieve(subId);
      const vendorId = sub.metadata?.vendorId;
      if (!vendorId) break;
      await saveTransaction({
        vendorId,
        amount: obj.amount_paid / 100,
        currency: obj.currency,
        id: obj.id,
        subId,
        status: "paid",
      });
      await activatePremium(vendorId, sub);
      break;
    }
    case "invoice.payment_failed": {
      const subId = invoiceSubId(obj);
      if (!subId) break;
      const sub = await stripe.subscriptions.retrieve(subId);
      const vendorId = sub.metadata?.vendorId;
      if (!vendorId) break;
      await saveTransaction({
        vendorId,
        amount: obj.amount_due / 100,
        currency: obj.currency,
        id: obj.id,
        subId,
        status: "failed",
      });
      break;
    }
    case "customer.subscription.deleted": {
      await (await col(USERS_COLLECTION)).updateOne(
        { stripeSubscriptionId: obj.id },
        { $set: { subscriptionPlan: "free", subscriptionExpiresAt: null } }
      );
      break;
    }
    default:
      break;
  }
}

app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler failed:", err);
    res.status(500).json({ received: false });
  }
});

/* ------------------------------ Middleware ------------------------------ */
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(async (req, res, next) => {
  await getDb();
  next();
});

const JWKS = createRemoteJWKSet(new URL(`${BETTER_AUTH_URL}/api/auth/jwks`));

const verifyJWT = async (req, res, next) => {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return fail(res, 401, "Authentication token missing");
  let payload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), JWKS, { issuer: BETTER_AUTH_URL }));
  } catch {
    return fail(res, 401, "Invalid or expired token");
  }
  const sub = payload.sub ?? payload.id;
  const conditions = [{ id: sub }];
  if (oid(sub)) conditions.push({ _id: oid(sub) });
  const user = await (await col(USERS_COLLECTION)).findOne({ $or: conditions });
  if (!user) return fail(res, 401, "User not found");
  if (user.isBlocked) return fail(res, 403, "Your account has been blocked");
  req.user = user; // role & block status always come from the DB, never from the client
  next();
};

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : fail(res, 403, "Forbidden: insufficient permissions");

/* ------------------------------ Misc routes ------------------------------ */
app.get("/", (req, res) => res.json({ message: "WedPlan API running" }));

app.post("/api/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return fail(res, 400, "Image file is required");
  if (!req.file.mimetype.startsWith("image/")) return fail(res, 400, "Only image files allowed");
  const form = new FormData();
  form.append("image", req.file.buffer.toString("base64"));
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
    method: "POST",
    body: form,
  });
  const data = await r.json();
  if (!r.ok || !data?.data?.url) return fail(res, 502, "Image upload failed");
  res.json({ url: data.data.url });
});

app.get("/api/me", verifyJWT, (req, res) => {
  const { _id, name, email, image, role, businessName, subscriptionPlan, subscriptionExpiresAt } =
    req.user;
  res.json({
    _id, name, email, image, role, businessName,
    subscriptionPlan: isPremium(req.user) ? "premium" : "free",
    subscriptionExpiresAt,
  });
});

// Only safe fields — role / subscription can never be changed here
app.patch("/api/me", verifyJWT, async (req, res) => {
  const update = {};
  if (req.body.name !== undefined) {
    if (str(req.body.name).length < 2) return fail(res, 400, "Name is too short");
    update.name = str(req.body.name);
  }
  if (req.body.image !== undefined) update.image = str(req.body.image);
  if (req.body.businessName !== undefined && req.user.role === "vendor")
    update.businessName = str(req.body.businessName);
  if (!Object.keys(update).length) return fail(res, 400, "Nothing to update");
  update.updatedAt = new Date();
  await (await col(USERS_COLLECTION)).updateOne({ _id: req.user._id }, { $set: update });
  res.json({ message: "Profile updated" });
});

/* ------------------------------ Public services ------------------------------ */
app.get("/api/categories", async (req, res) => {
  const counts = await (await col("services"))
    .aggregate([
      { $match: { status: "approved", isActive: true } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ])
    .toArray();
  const map = new Map(counts.map((c) => [c._id, c.count]));
  res.json(CATEGORIES.map((name) => ({ name, count: map.get(name) || 0 })));
});

app.get("/api/services/featured", async (req, res) => {
  const items = await (await col("services"))
    .find({ status: "approved", isActive: true })
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();
  res.json(await withVendors(items));
});

app.get("/api/services", async (req, res) => {
  const { q, category, location, sort, order = "asc" } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
  const filter = { status: "approved", isActive: true };
  if (q) filter.serviceName = { $regex: escapeRegex(q), $options: "i" };
  if (category) filter.category = String(category);
  if (location) filter.location = { $regex: escapeRegex(location), $options: "i" };
  const sortBy = sort === "price" ? { price: order === "desc" ? -1 : 1 } : { createdAt: -1 };
  const services = await col("services");
  const total = await services.countDocuments(filter);
  const items = await services.find(filter).sort(sortBy).skip((page - 1) * limit).limit(limit).toArray();
  res.json({ items: await withVendors(items), total, page, pages: Math.ceil(total / limit) });
});

app.get("/api/services/:id", async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  const s = await (await col("services")).findOne({ _id: id, status: "approved", isActive: true });
  if (!s) return fail(res, 404, "Service not found or unavailable");
  res.json((await withVendors([s]))[0]);
});

/* ------------------------------ Vendor ------------------------------ */
const vendorOnly = [verifyJWT, requireRole("vendor")];

const activeCount = async (vendorId, excludeId) =>
  (await col("services")).countDocuments({
    vendorId,
    isActive: true,
    status: { $ne: "rejected" },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });

function validateService(b, partial = false) {
  const out = {};
  const need = (k, ok) => {
    if (b[k] === undefined) return partial ? null : `${k} is required`;
    return ok ? null : `${k} is invalid`;
  };
  const checks = [
    ["serviceName", (v) => str(v).length >= 3],
    ["category", (v) => CATEGORIES.includes(v)],
    ["description", (v) => str(v).length >= 10],
    ["price", (v) => Number(v) > 0],
    ["location", (v) => str(v).length >= 2],
    ["images", (v) => Array.isArray(v) && v.length > 0 && v.every((i) => typeof i === "string")],
  ];
  for (const [k, ok] of checks) {
    const err = need(k, ok(b[k]));
    if (err) return { error: err };
    if (b[k] !== undefined) out[k] = k === "price" ? Number(b[k]) : k === "images" ? b[k] : str(b[k]);
  }
  return { data: out };
}

app.get("/api/vendor/overview", ...vendorOnly, async (req, res) => {
  const services = await col("services");
  const bookings = await col("bookings");
  const [total, active, pending, accepted] = await Promise.all([
    services.countDocuments({ vendorId: req.user._id }),
    services.countDocuments({ vendorId: req.user._id, status: "approved", isActive: true }),
    bookings.countDocuments({ vendorId: req.user._id, status: "pending" }),
    bookings.countDocuments({ vendorId: req.user._id, status: "accepted" }),
  ]);
  res.json({
    totalServices: total,
    activeServices: active,
    pendingBookings: pending,
    acceptedBookings: accepted,
    plan: isPremium(req.user) ? "premium" : "free",
  });
});

app.get("/api/vendor/services", ...vendorOnly, async (req, res) => {
  res.json(await (await col("services")).find({ vendorId: req.user._id }).sort({ createdAt: -1 }).toArray());
});

app.post("/api/vendor/services", ...vendorOnly, async (req, res) => {
  const { data, error } = validateService(req.body);
  if (error) return fail(res, 400, error);
  if (!isPremium(req.user) && (await activeCount(req.user._id)) >= FREE_LIMIT)
    return fail(res, 403, "Free plan allows 3 active services. Upgrade to Premium for unlimited.");
  const doc = {
    ...data,
    vendorId: req.user._id,
    status: "pending",
    isActive: true,
    createdAt: new Date(),
  };
  const r = await (await col("services")).insertOne(doc);
  res.status(201).json({ message: "Service submitted for approval", _id: r.insertedId });
});

app.patch("/api/vendor/services/:id", ...vendorOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  const services = await col("services");
  const existing = await services.findOne({ _id: id, vendorId: req.user._id }); // ownership check
  if (!existing) return fail(res, 404, "Service not found");
  const { data, error } = validateService(req.body, true);
  if (error) return fail(res, 400, error);
  const update = { ...data };
  if (Object.keys(data).length && existing.status === "approved") update.status = "pending"; // re-review after edit
  if (typeof req.body.isActive === "boolean") {
    if (req.body.isActive && !existing.isActive && !isPremium(req.user) &&
        (await activeCount(req.user._id, id)) >= FREE_LIMIT)
      return fail(res, 403, "Free plan allows 3 active services. Upgrade to Premium.");
    update.isActive = req.body.isActive;
  }
  if (!Object.keys(update).length) return fail(res, 400, "Nothing to update");
  await services.updateOne({ _id: id, vendorId: req.user._id }, { $set: update });
  res.json({ message: "Service updated" });
});

app.delete("/api/vendor/services/:id", ...vendorOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  const r = await (await col("services")).deleteOne({ _id: id, vendorId: req.user._id });
  if (!r.deletedCount) return fail(res, 404, "Service not found");
  res.json({ message: "Service deleted" });
});

app.get("/api/vendor/bookings", ...vendorOnly, async (req, res) => {
  const list = await (await col("bookings")).find({ vendorId: req.user._id }).sort({ createdAt: -1 }).toArray();
  res.json(await withBookingDetails(list));
});

app.patch("/api/vendor/bookings/:id", ...vendorOnly, async (req, res) => {
  const id = oid(req.params.id);
  const status = req.body.status;
  if (!id) return fail(res, 400, "Invalid booking ID");
  if (!["accepted", "rejected"].includes(status)) return fail(res, 400, "Status must be accepted or rejected");
  const bookings = await col("bookings");
  const r = await bookings.updateOne(
    { _id: id, vendorId: req.user._id, status: "pending" }, // atomic: only own + pending
    { $set: { status, updatedAt: new Date() } }
  );
  if (r.matchedCount) return res.json({ message: `Booking ${status}` });
  const b = await bookings.findOne({ _id: id });
  if (!b || String(b.vendorId) !== String(req.user._id)) return fail(res, 404, "Booking not found");
  fail(res, 409, "Only pending requests can be processed");
});

/* ------------------------------ Payments ------------------------------ */
app.post("/api/payments/create-checkout-session", ...vendorOnly, async (req, res) => {
  if (isPremium(req.user)) return fail(res, 409, "You are already a Premium vendor");
  const vendorId = String(req.user._id); // always from the verified token, never from the body
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: req.user.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Number(PREMIUM_PRICE_CENTS),
          recurring: { interval: "month" },
          product_data: { name: "WedPlan Premium Vendor" },
        },
      },
    ],
    metadata: { vendorId },
    subscription_data: { metadata: { vendorId } },
    success_url: `${CLIENT}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${CLIENT}/payment/cancel`,
  });
  res.json({ url: session.url });
});

// Read-only: tells the success page whether the *webhook* has already activated premium
app.get("/api/payments/session/:sessionId", ...vendorOnly, async (req, res) => {
  const t = await (await col("transactions")).findOne({
    stripeSessionId: req.params.sessionId,
    vendorId: req.user._id,
  });
  if (!t) return res.json({ status: "processing" });
  res.json({ status: t.status, amount: t.amount, currency: t.currency, plan: t.plan });
});

app.post("/api/payments/cancel-subscription", ...vendorOnly, async (req, res) => {
  if (!req.user.stripeSubscriptionId) return fail(res, 400, "No active subscription");
  await stripe.subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end: true });
  res.json({ message: "Subscription will end at the current period end" });
});

/* ------------------------------ Bookings / Customer ------------------------------ */
app.post("/api/bookings", verifyJWT, requireRole("customer", "vendor"), async (req, res) => {
  const serviceId = oid(req.body.serviceId);
  const eventDate = new Date(req.body.eventDate);
  const eventLocation = str(req.body.eventLocation);
  if (!serviceId) return fail(res, 400, "Invalid service ID");
  if (isNaN(eventDate) || eventDate <= new Date()) return fail(res, 400, "Event date must be a future date");
  if (eventLocation.length < 2) return fail(res, 400, "Event location is required");
  const service = await (await col("services")).findOne({ _id: serviceId, status: "approved", isActive: true });
  if (!service) return fail(res, 404, "Service not found or unavailable");
  if (String(service.vendorId) === String(req.user._id)) return fail(res, 403, "You cannot book your own service");
  const bookings = await col("bookings");
  const dayStart = new Date(eventDate); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const dup = await bookings.findOne({
    serviceId,
    customerId: req.user._id,
    eventDate: { $gte: dayStart, $lt: dayEnd },
    status: { $in: ["pending", "accepted"] },
  });
  if (dup) return fail(res, 409, "You already have an active request for this service on that date");
  const r = await bookings.insertOne({
    serviceId,
    vendorId: service.vendorId,
    customerId: req.user._id,
    eventDate,
    eventLocation,
    message: str(req.body.message),
    status: "pending",
    createdAt: new Date(),
  });
  res.status(201).json({ message: "Booking request submitted", _id: r.insertedId });
});

const customerOnly = [verifyJWT, requireRole("customer", "vendor")];

app.get("/api/customer/overview", ...customerOnly, async (req, res) => {
  const b = await col("bookings");
  const q = (status) => b.countDocuments({ customerId: req.user._id, ...(status ? { status } : {}) });
  const [total, pending, accepted, rejected] = await Promise.all([q(), q("pending"), q("accepted"), q("rejected")]);
  res.json({ total, pending, accepted, rejected });
});

app.get("/api/customer/bookings", ...customerOnly, async (req, res) => {
  const list = await (await col("bookings")).find({ customerId: req.user._id }).sort({ createdAt: -1 }).toArray();
  res.json(await withBookingDetails(list));
});

app.patch("/api/customer/bookings/:id/cancel", ...customerOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid booking ID");
  const bookings = await col("bookings");
  const r = await bookings.updateOne(
    { _id: id, customerId: req.user._id, status: "pending" },
    { $set: { status: "cancelled", updatedAt: new Date() } }
  );
  if (r.matchedCount) return res.json({ message: "Booking cancelled" });
  const b = await bookings.findOne({ _id: id });
  if (!b || String(b.customerId) !== String(req.user._id)) return fail(res, 404, "Booking not found");
  fail(res, 409, "Only pending bookings can be cancelled");
});

/* ------------------------------ Admin ------------------------------ */
const adminOnly = [verifyJWT, requireRole("admin")];

app.get("/api/admin/overview", ...adminOnly, async (req, res) => {
  const users = await col(USERS_COLLECTION);
  const services = await col("services");
  const [totalUsers, vendors, customers, totalServices, pendingServices, transactions] = await Promise.all([
    users.countDocuments(),
    users.countDocuments({ role: "vendor" }),
    users.countDocuments({ role: "customer" }),
    services.countDocuments(),
    services.countDocuments({ status: "pending" }),
    (await col("transactions")).countDocuments(),
  ]);
  res.json({ totalUsers, vendors, customers, totalServices, pendingServices, transactions });
});

app.get("/api/admin/users", ...adminOnly, async (req, res) => {
  const { q, role } = req.query;
  const filter = {};
  if (role) filter.role = String(role);
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: "i" };
    filter.$or = [{ name: rx }, { email: rx }];
  }
  res.json(await (await col(USERS_COLLECTION)).find(filter).sort({ createdAt: -1 }).limit(200).toArray());
});

app.get("/api/admin/users/:id", ...adminOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid user ID");
  const u = await (await col(USERS_COLLECTION)).findOne({ _id: id });
  if (!u) return fail(res, 404, "User not found");
  res.json(u);
});

app.patch("/api/admin/users/:id/block", ...adminOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid user ID");
  if (typeof req.body.isBlocked !== "boolean") return fail(res, 400, "isBlocked must be boolean");
  const users = await col(USERS_COLLECTION);
  const target = await users.findOne({ _id: id });
  if (!target) return fail(res, 404, "User not found");
  if (target.role === "admin") return fail(res, 403, "Admin accounts cannot be blocked");
  await users.updateOne({ _id: id }, { $set: { isBlocked: req.body.isBlocked } });
  res.json({ message: req.body.isBlocked ? "User blocked" : "User unblocked" });
});

app.get("/api/admin/services", ...adminOnly, async (req, res) => {
  const { q, status, category } = req.query;
  const filter = {};
  if (status) filter.status = String(status);
  if (category) filter.category = String(category);
  if (q) filter.serviceName = { $regex: escapeRegex(q), $options: "i" };
  const items = await (await col("services")).find(filter).sort({ createdAt: -1 }).toArray();
  res.json(await withVendors(items));
});

app.patch("/api/admin/services/:id/status", ...adminOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  if (!["approved", "rejected", "pending"].includes(req.body.status)) return fail(res, 400, "Invalid status");
  const r = await (await col("services")).updateOne({ _id: id }, { $set: { status: req.body.status } });
  if (!r.matchedCount) return fail(res, 404, "Service not found");
  res.json({ message: `Service ${req.body.status}` });
});

app.delete("/api/admin/services/:id", ...adminOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  const r = await (await col("services")).deleteOne({ _id: id });
  if (!r.deletedCount) return fail(res, 404, "Service not found");
  res.json({ message: "Service deleted" });
});

// Read-only on purpose: admins can never edit payment records
app.get("/api/admin/transactions", ...adminOnly, async (req, res) => {
  const list = await (await col("transactions")).find().sort({ createdAt: -1 }).limit(500).toArray();
  const ids = [...new Set(list.map((t) => String(t.vendorId)))].map((i) => new ObjectId(i));
  const users = await (await col(USERS_COLLECTION)).find({ _id: { $in: ids } }).toArray();
  const map = new Map(users.map((u) => [String(u._id), publicVendor(u)]));
  res.json(list.map((t) => ({ ...t, vendor: map.get(String(t.vendorId)) || null })));
});

/* ------------------------------ Errors ------------------------------ */
app.use((req, res) => fail(res, 404, "Route not found"));

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return fail(res, 400, err.message);
  fail(res, 500, "Internal server error");
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`WedPlan server running on port ${PORT}`));
}

export default app;