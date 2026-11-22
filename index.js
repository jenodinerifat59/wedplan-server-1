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
const FREE_LIMIT = 300;

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
  const vendorIds = [...new Set(services.map((s) => String(s.vendorId)))];
  const users = await (await col(USERS_COLLECTION)).find({ _id: { $in: vendorIds } }).toArray();
  const map = new Map(users.map((u) => [String(u._id), publicVendor(u)]));
  return services.map((s) => ({ ...s, vendor: map.get(String(s.vendorId)) || null }));
}


async function withBookingDetails(bookings) {
  if (!bookings.length) return [];

  const sIds = [
    ...new Set(bookings.map((b) => String(b.serviceId))),
  ]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const uIds = [
    ...new Set(
      bookings.flatMap((b) => [
        String(b.vendorId),
        String(b.customerId),
      ])
    ),
  ]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

const [services, users] = await Promise.all([
  (async () =>
    (await col("services"))
      .find({ _id: { $in: sIds } })
      .toArray())(),

  (async () =>
    (await col(USERS_COLLECTION))
      .find({ _id: { $in: uIds } })
      .toArray())(),
]);

  const sMap = new Map(
    services.map((s) => [String(s._id), s])
  );

  const uMap = new Map(
    users.map((u) => [String(u._id), u])
  );

  return bookings.map((b) => {
    const service = sMap.get(String(b.serviceId));
    const customer = uMap.get(String(b.customerId));
    const vendor = uMap.get(String(b.vendorId));

    return {
      ...b,

      service: service
        ? {
            _id: service._id,
            serviceName: service.serviceName,
            images: service.images,
            price: service.price,
          }
        : null,

      customer: customer
        ? {
            _id: customer._id,
            name: customer.name,
            email: customer.email,
            image: customer.image,
          }
        : null,

      vendor: vendor ? publicVendor(vendor) : null,
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

async function saveTransaction({
  vendorId,
  customerId,
  bookingId,
  amount,
  currency,
  id,
  subId,
  status,
  type = "subscription",
}) {
  const transaction = {
    type,
    amount,
    currency: String(currency || "").toLowerCase(),
    stripeSessionId: id,
    status,
    createdAt: new Date(),
  };

  // Vendor subscription payment
  if (vendorId) {
    transaction.vendorId = new ObjectId(vendorId);
    transaction.plan = "premium";
    transaction.stripeSubscriptionId = subId || null;
  }

  // Customer booking payment
  if (customerId) {
    transaction.customerId = new ObjectId(customerId);
    transaction.bookingId = new ObjectId(bookingId);
    transaction.plan = "booking";
  }

  await (await col("transactions")).updateOne(
    { stripeSessionId: id },
    {
      $setOnInsert: transaction,
    },
    { upsert: true }
  );
}

// When Premium ends, keep the 3 oldest active services and deactivate the rest
async function enforceFreeLimit(vendorId) {
  const services = await col("services");
  const active = await services
    .find({ vendorId, isActive: true, status: { $ne: "rejected" } })
    .sort({ createdAt: 1 })
    .toArray();
  const extra = active.slice(FREE_LIMIT).map((s) => s._id);
  if (extra.length) await services.updateMany({ _id: { $in: extra } }, { $set: { isActive: false } });
}

const invoiceSubId = (inv) =>
  inv.parent?.subscription_details?.subscription ?? inv.subscription ?? null;


async function handleStripeEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      // VENDOR PREMIUM SUBSCRIPTION PAYMENT
      if (obj.mode === "subscription" && obj.payment_status === "paid") {
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
          type: "subscription",
        });

        await activatePremium(vendorId, sub);
        break;
      }

      // CUSTOMER FULL BOOKING PAYMENT
      if (obj.mode === "payment" && obj.payment_status === "paid") {
        const bookingId = oid(obj.metadata?.bookingId);
        const customerId = oid(obj.metadata?.customerId);

        if (!bookingId || !customerId) {
          throw new Error("Invalid booking payment metadata");
        }

        const bookings = await col("bookings");

        const booking = await bookings.findOne({
          _id: bookingId,
          customerId,
          stripeSessionId: obj.id,
        });

        if (!booking) {
          throw new Error("Booking not found for Stripe session");
        }

        // Verify amount and currency against database values.
        const expectedAmount = Math.round(
          Number(booking.paymentAmount) * 100
        );

        if (
          !Number.isFinite(expectedAmount) ||
          obj.amount_total !== expectedAmount ||
          obj.currency !== "bdt"
        ) {
          throw new Error("Booking payment amount or currency mismatch");
        }

        // Update booking only once.
        const updateResult = await bookings.updateOne(
          {
            _id: bookingId,
            stripeSessionId: obj.id,
            paymentStatus: { $ne: "paid" },
          },
          {
            $set: {
              paymentStatus: "paid",
              paymentStatusUpdatedAt: new Date(),
              status: "pending",
              stripePaymentIntentId: obj.payment_intent || null,
            },
          }
        );

        // Save customer transaction idempotently.
        await saveTransaction({
          customerId: String(customerId),
          bookingId: String(bookingId),
          amount: obj.amount_total / 100,
          currency: obj.currency,
          id: obj.id,
          status: "paid",
          type: "booking",
        });

        // Notify admin only on the first successful update.
        if (updateResult.modifiedCount > 0) {
          await createAdminNotification({
            type: "payment",
            title: "Booking Payment Received",
            message: `Full payment received for ${booking.serviceId}.`,
            relatedId: bookingId,
          });
        }

        break;
      }

      break;
    }

    // VENDOR SUBSCRIPTION RENEWAL
    case "invoice.paid": {
      if (obj.billing_reason !== "subscription_cycle") break;

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
        type: "subscription",
      });

      await activatePremium(vendorId, sub);
      break;
    }

    // VENDOR SUBSCRIPTION PAYMENT FAILED
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
        type: "subscription",
      });

      break;
    }

    // VENDOR SUBSCRIPTION CANCELLED
    case "customer.subscription.deleted": {
      const vendor = await (
        await col(USERS_COLLECTION)
      ).findOneAndUpdate(
        { stripeSubscriptionId: obj.id },
        {
          $set: {
            subscriptionPlan: "free",
            subscriptionExpiresAt: null,
          },
        }
      );

      if (vendor) {
        await enforceFreeLimit(vendor._id);
      }

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

  if (!header.startsWith("Bearer ")) {
    return fail(res, 401, "Authentication token missing");
  }

  try {
    const { payload } = await jwtVerify(
      header.slice(7),
      JWKS,
      { issuer: BETTER_AUTH_URL }
    );

    const sub = payload.sub ?? payload.id;
    console.log("JWT User ID:", sub);
console.log("User Collection:", USERS_COLLECTION);

    if (!sub) {
      return fail(res, 401, "User ID missing from token");
    }

    const conditions = [
      { id: sub },
      { _id: sub },
    ];

    if (oid(sub)) {
      conditions.push({ _id: oid(sub) });
    }

    const userCollection = await col(USERS_COLLECTION);

    const user = await userCollection.findOne({
      $or: conditions,
    });

    console.log("JWT User ID:", sub);
    console.log("User Collection:", USERS_COLLECTION);
    console.log("User Found:", !!user);

    if (!user) {
      return fail(res, 401, "User not found");
    }

    if (user.isBlocked) {
      return fail(res, 403, "Your account has been blocked");
    }

    req.user = user;
    next();

  } catch (error) {
    console.error("JWT Verification Error:", error);
    return fail(res, 401, "Invalid or expired token");
  }
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

app.get("/api/locations", async (req, res) => {
  const locations = await (await col("services")).distinct("location", { status: "approved", isActive: true });
  res.json(locations.sort());
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

app.get("/api/vendor/services/:id", ...vendorOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid service ID");
  const s = await (await col("services")).findOne({ _id: id, vendorId: req.user._id });
  if (!s) return fail(res, 404, "Service not found");
  res.json(s);
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

await createAdminNotification({
  type: "service",
  title: "New Service Submitted",
  message: `${req.user.name || "A vendor"} submitted ${doc.serviceName} for approval.`,
  relatedId: r.insertedId,
});

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


app.post("/api/bookings", verifyJWT, async (req, res) => {
  try {
    const serviceId = oid(req.body.serviceId);
    const eventDate = new Date(req.body.eventDate);
    const eventLocation = str(req.body.eventLocation);

    if (!serviceId) return fail(res, 400, "Invalid service ID");

    if (isNaN(eventDate) || eventDate <= new Date()) {
      return fail(res, 400, "Event date must be a future date");
    }

    if (eventLocation.length < 2) {
      return fail(res, 400, "Event location is required");
    }

    if (req.user.role !== "customer") {
      return fail(res, 403, "Only customers can submit booking requests");
    }

    const service = await (await col("services")).findOne({
      _id: serviceId,
      status: "approved",
      isActive: true,
    });

    if (!service) {
      return fail(res, 404, "Service not found or unavailable");
    }

    if (String(service.vendorId) === String(req.user._id)) {
      return fail(res, 403, "You cannot book your own service");
    }

    const amount = Number(service.price);

    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(res, 400, "Invalid service price");
    }

    const bookings = await col("bookings");

    const dayStart = new Date(eventDate);
    dayStart.setUTCHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const dup = await bookings.findOne({
      serviceId,
      customerId: req.user._id,
      eventDate: { $gte: dayStart, $lt: dayEnd },
      status: { $in: ["pending", "accepted", "confirmed"] },
    });

    if (dup) {
      return fail(
        res,
        409,
        "You already have an active request for this service on that date"
      );
    }

    const bookingResult = await bookings.insertOne({
      serviceId,
      vendorId: service.vendorId,
      customerId: req.user._id,
      eventDate,
      eventLocation,
      message: str(req.body.message),

      status: "pending",
      paymentStatus: "unpaid",
      paymentAmount: amount,
      currency: "bdt",

      createdAt: new Date(),
    });

    const bookingId = String(bookingResult.insertedId);

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: req.user.email,
        client_reference_id: bookingId,

        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "bdt",
              unit_amount: Math.round(amount * 100),
              product_data: {
                name: service.serviceName,
                description: "WedPlan Booking Full Payment",
              },
            },
          },
        ],

        metadata: {
          type: "booking_payment",
          bookingId,
          serviceId: String(serviceId),
          vendorId: String(service.vendorId),
          customerId: String(req.user._id),
        },

        payment_intent_data: {
          metadata: {
            type: "booking_payment",
            bookingId,
          },
        },

        success_url: `${CLIENT}/booking/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT}/booking/payment/cancel?booking_id=${bookingId}`,
      });

      await bookings.updateOne(
        { _id: bookingResult.insertedId },
        {
          $set: {
            stripeSessionId: session.id,
            checkoutUrl: session.url,
          },
        }
      );

      return res.status(201).json({
        message: "Continue to payment",
        bookingId,
        url: session.url,
      });
    } catch (paymentError) {
      await bookings.deleteOne({ _id: bookingResult.insertedId });

      console.error("Booking checkout error:", paymentError);
      return fail(res, 500, "Unable to create payment session");
    }
  } catch (error) {
    console.error("Booking creation error:", error);
    return fail(res, 500, "Failed to create booking");
  }
});


app.get("/api/vendor/bookings", verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== "vendor") {
      return fail(res, 403, "Only vendors can view bookings");
    }

    const bookings = await (await col("bookings"))
      .aggregate([
        {
          $match: {
            vendorId: req.user._id,
          },
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
        {
          $lookup: {
            from: "services",
            localField: "serviceId",
            foreignField: "_id",
            as: "service",
          },
        },
        {
          $unwind: {
            path: "$service",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "customerId",
            foreignField: "_id",
            as: "customer",
          },
        },
        {
          $unwind: {
            path: "$customer",
            preserveNullAndEmptyArrays: true,
          },
        },
      ])
      .toArray();

    res.json({
      success: true,
      bookings,
    });
  } catch (error) {
    console.error("Vendor bookings error:", error);
    fail(res, 500, "Failed to fetch vendor bookings");
  }
});


app.get("/api/bookings/my-bookings", verifyJWT, async (req, res) => {
  try {
    if (req.user.role !== "customer") {
      return fail(res, 403, "Only customers can view their bookings");
    }

    const bookings = await (await col("bookings"))
      .find({
        customerEmail: req.user.email,
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      bookings,
    });
  } catch (error) {
    console.error("My bookings error:", error);
    fail(res, 500, "Failed to fetch bookings");
  }
});

app.patch("/api/bookings/:id/status", verifyJWT, async (req, res) => {
  try {
    // Only vendors can update booking status
    if (req.user.role !== "vendor") {
      return fail(res, 403, "Only vendors can update booking status");
    }

    const bookingId = oid(req.params.id);
    const status = str(req.body.status);

    if (!bookingId) {
      return fail(res, 400, "Invalid booking ID");
    }

    if (!["accepted", "rejected"].includes(status)) {
      return fail(res, 400, "Invalid booking status");
    }

    const bookings = await col("bookings");

    const result = await bookings.updateOne(
      {
        _id: bookingId,
        vendorId: req.user._id,
        status: "pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return fail(res, 404, "Pending booking not found");
    }

    res.json({
      success: true,
      message: `Booking ${status} successfully`,
    });
  } catch (error) {
    console.error("Update booking status error:", error);
    fail(res, 500, "Failed to update booking status");
  }
});


const customerOnly = [verifyJWT, requireRole("customer")];

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

app.get("/api/customer/bookings/:id", ...customerOnly, async (req, res) => {
  const id = oid(req.params.id);
  if (!id) return fail(res, 400, "Invalid booking ID");
  const b = await (await col("bookings")).findOne({ _id: id, customerId: req.user._id });
  if (!b) return fail(res, 404, "Booking not found");
  res.json((await withBookingDetails([b]))[0]);
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


app.get("/api/vendor/recent-bookings", ...vendorOnly, async (req, res) => {
  try {
    const bookings = await col("bookings");

    const list = await bookings
      .find({ vendorId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    res.json(await withBookingDetails(list));
  } catch (error) {
    console.error("Recent bookings error:", error);
    fail(res, 500, "Failed to load recent bookings");
  }
});
/* ------------------------------ Admin ------------------------------ */
const adminOnly = [verifyJWT, requireRole("admin")];

/* ------------------------- Admin Notifications APIs ------------------------- */

// Get all notifications
app.get("/api/admin/notifications", ...adminOnly, async (req, res) => {
  try {
    const notificationsCollection = await col("notifications");

    const [notifications, unreadCount] = await Promise.all([
      notificationsCollection
        .find()
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray(),

      notificationsCollection.countDocuments({
        isRead: false,
      }),
    ]);

    res.json({
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    fail(res, 500, "Failed to load notifications");
  }
});

// Mark one notification as read
app.patch(
  "/api/admin/notifications/:id/read",
  ...adminOnly,
  async (req, res) => {
    try {
      const id = oid(req.params.id);

      if (!id) return fail(res, 400, "Invalid notification ID");

      const result = await (await col("notifications")).updateOne(
        { _id: id },
        {
          $set: {
            isRead: true,
            readAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return fail(res, 404, "Notification not found");
      }

      res.json({ message: "Notification marked as read" });
    } catch (error) {
      console.error("Read notification error:", error);
      fail(res, 500, "Failed to update notification");
    }
  }
);

// Mark all notifications as read
app.patch(
  "/api/admin/notifications/read-all",
  ...adminOnly,
  async (req, res) => {
    try {
      await (await col("notifications")).updateMany(
        { isRead: false },
        {
          $set: {
            isRead: true,
            readAt: new Date(),
          },
        }
      );

      res.json({ message: "All notifications marked as read" });
    } catch (error) {
      console.error("Read all notifications error:", error);
      fail(res, 500, "Failed to update notifications");
    }
  }
);

// Delete one notification
app.delete(
  "/api/admin/notifications/:id",
  ...adminOnly,
  async (req, res) => {
    try {
      const id = oid(req.params.id);

      if (!id) return fail(res, 400, "Invalid notification ID");

      const result = await (await col("notifications")).deleteOne({
        _id: id,
      });

      if (!result.deletedCount) {
        return fail(res, 404, "Notification not found");
      }

      res.json({ message: "Notification deleted successfully" });
    } catch (error) {
      console.error("Delete notification error:", error);
      fail(res, 500, "Failed to delete notification");
    }
  }
);



app.get("/api/admin/overview", ...adminOnly, async (req, res) => {
  try {
    const users = await col(USERS_COLLECTION);
    const services = await col("services");
    const bookings = await col("bookings");
    const transactionsCollection = await col("transactions");

    const [
      totalUsers,
      vendors,
      customers,
      totalServices,
      pendingServices,
      transactions,
      totalBookings,
      paidTransactions,
    ] = await Promise.all([
      users.countDocuments(),
      users.countDocuments({ role: "vendor" }),
      users.countDocuments({ role: "customer" }),
      services.countDocuments(),
      services.countDocuments({ status: "pending" }),
      transactionsCollection.countDocuments(),
      bookings.countDocuments(),
      transactionsCollection
        .find({ status: "paid" })
        .toArray(),
    ]);

    const totalRevenue = paidTransactions.reduce(
      (total, transaction) =>
        total + Number(transaction.amount || 0),
      0
    );

    res.json({
      totalUsers,
      vendors,
      customers,
      totalServices,
      pendingServices,
      transactions,
      totalBookings,
      totalRevenue,
    });
  } catch (error) {
    console.error("Admin overview error:", error);
    fail(res, 500, "Failed to load admin overview");
  }
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

/* ------------------------- Admin Service Actions ------------------------- */

// Approve / Reject Service
app.patch("/api/admin/services/:id/status", ...adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id);
    const { status } = req.body;

    if (!id) return fail(res, 400, "Invalid service ID");

    if (!["approved", "rejected"].includes(status)) {
      return fail(res, 400, "Status must be approved or rejected");
    }

    const services = await col("services");

    const result = await services.updateOne(
      { _id: id },
      {
        $set: {
          status,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return fail(res, 404, "Service not found");
    }

    res.json({
      message: `Service ${status} successfully`,
    });
  } catch (error) {
    console.error("Update service status error:", error);
    fail(res, 500, "Failed to update service status");
  }
});

// Activate / Deactivate Service
app.patch("/api/admin/services/:id/active", ...adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id);
    const { isActive } = req.body;

    if (!id) return fail(res, 400, "Invalid service ID");

    if (typeof isActive !== "boolean") {
      return fail(res, 400, "isActive must be true or false");
    }

    const services = await col("services");

    const result = await services.updateOne(
      { _id: id },
      {
        $set: {
          isActive,
          updatedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return fail(res, 404, "Service not found");
    }

    res.json({
      message: `Service ${isActive ? "activated" : "deactivated"} successfully`,
    });
  } catch (error) {
    console.error("Update service active status error:", error);
    fail(res, 500, "Failed to update service active status");
  }
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

app.get("/api/admin/bookings", ...adminOnly, async (req, res) => {
  try {
    const { status, q } = req.query;

    const filter = {};

    if (status) {
      filter.status = String(status);
    }

    const list = await (await col("bookings"))
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    const bookings = await withBookingDetails(list);

    if (q) {
      const search = String(q).toLowerCase();

      const filtered = bookings.filter((booking) => {
        const customerName = booking.customer?.name || "";
        const customerEmail = booking.customer?.email || "";
        const vendorName = booking.vendor?.name || "";
        const serviceName = booking.service?.serviceName || "";

        return [
          customerName,
          customerEmail,
          vendorName,
          serviceName,
          String(booking._id),
        ].some((value) =>
          value.toLowerCase().includes(search)
        );
      });

      return res.json(filtered);
    }

    res.json(bookings);
  } catch (error) {
    console.error("Admin bookings error:", error);
    fail(res, 500, "Failed to load bookings");
  }
});

/* ------------------------- Admin Booking Status Update ------------------------- */

app.patch(
  "/api/admin/bookings/:id/status",
  ...adminOnly,
  async (req, res) => {
    try {
      const id = oid(req.params.id);
      const { status } = req.body;

      if (!id) {
        return fail(res, 400, "Invalid booking ID");
      }

      const allowedStatuses = [
        "pending",
        "confirmed",
        "completed",
        "cancelled",
      ];

      if (!allowedStatuses.includes(status)) {
        return fail(res, 400, "Invalid booking status");
      }

      const bookings = await col("bookings");

      const result = await bookings.updateOne(
        { _id: id },
        {
          $set: {
            status,
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return fail(res, 404, "Booking not found");
      }

      res.json({
        message: "Booking status updated successfully",
        status,
      });
    } catch (error) {
      console.error("Admin booking status update error:", error);
      fail(res, 500, "Failed to update booking status");
    }
  }
);

// Admin Platform Settings

app.get("/api/admin/settings", ...adminOnly, async (req, res) => {
  try {
    const settings = await (await col("platformSettings")).findOne({
      _id: "platform",
    });

    res.json(
      settings || {
        name: "WedPlan",
        email: "",
        phone: "",
        address: "",
      }
    );
  } catch (error) {
    console.error("Get platform settings error:", error);
    fail(res, 500, "Failed to load platform settings");
  }
});

app.patch("/api/admin/settings", ...adminOnly, async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;

    const settings = {
      name: str(name),
      email: str(email),
      phone: str(phone),
      address: str(address),
      updatedAt: new Date(),
    };

    if (settings.name.length < 2) {
      return fail(res, 400, "Platform name is required");
    }

    await (await col("platformSettings")).updateOne(
      { _id: "platform" },
      { $set: settings },
      { upsert: true }
    );

    res.json({
      message: "Platform settings updated successfully",
      settings,
    });
  } catch (error) {
    console.error("Update platform settings error:", error);
    fail(res, 500, "Failed to update platform settings");
  }
});


/* ------------------------- Notification Helper ------------------------- */

const createAdminNotification = async ({
  type,
  title,
  message,
  relatedId = null,
}) => {
  try {
    await (await col("notifications")).insertOne({
      type,
      title,
      message,
      relatedId,
      isRead: false,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("Notification creation error:", error);
  }
};

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