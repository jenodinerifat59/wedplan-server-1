
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';


const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error('Webhook Signature Error:', error.message);

      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        if (
          session.mode === 'subscription' &&
          session.payment_status === 'paid'
        ) {
          const vendorEmail = session.metadata?.vendorEmail;

          if (!vendorEmail) {
            return res.status(400).json({
              success: false,
              message: 'Vendor email missing from metadata'
            });
          }

          // Activate Premium Plan
          await db.collection('user').updateOne(
            { email: vendorEmail },
            {
              $set: {
                subscriptionPlan: 'premium',
                subscriptionExpiresAt: null
              }
            }
          );

          // Save Transaction
          await transactionsCollection.updateOne(
            { stripeEventId: event.id },
            {
              $setOnInsert: {
                stripeEventId: event.id,
                vendorEmail,
                sessionId: session.id,
                subscriptionId: session.subscription,
                amountTotal: session.amount_total,
                currency: session.currency,
                status: 'completed',
                createdAt: new Date()
              }
            },
            { upsert: true }
          );

          console.log('Vendor Premium Activated:', vendorEmail);
        }
      }

      res.status(200).json({
        received: true
      });

    } catch (error) {
      console.error('Webhook Processing Error:', error);

      res.status(500).json({
        success: false,
        message: 'Webhook processing failed'
      });
    }
  }
);
app.use(express.json());
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB Connection
const client = new MongoClient(process.env.MONGODB_URI);

let db = client.db(process.env.DB_NAME);

try {
  await client.connect();

  console.log('MongoDB Connected Successfully');

  db = client.db(process.env.DB_NAME);

  console.log('Database:', process.env.DB_NAME);

} catch (error) {
  console.error('MongoDB Connection Failed:', error);
  process.exit(1);
}

// Collections
const servicesCollection = db.collection('services');
const bookingsCollection = db.collection('bookings');
const transactionsCollection = db.collection('transactions');

// Test API
app.get('/', (req, res) => {
  res.send('WedPlan Server is Running!');
});

// Test Database API
app.get('/test-db', async (req, res) => {
  try {
    const services = await servicesCollection.find().toArray();

    res.status(200).json({
      success: true,
      message: 'Database Connected Successfully',
      services
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
app.get('/services', async (req, res) => {
  try {
    const services = await servicesCollection.find().toArray();

    res.status(200).json({
      success: true,
      data: services
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id)
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.status(200).json({
      success: true,
      data: service
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post('/services', async (req, res) => {
  try {
    const serviceData = req.body;

    const result = await servicesCollection.insertOne({
      ...serviceData,
      status: 'pending',
      createdAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: 'Service created successfully',
      data: result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
app.patch('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...updateData,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Service updated successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.delete('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Service deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

//boking api

app.post('/bookings', async (req, res) => {
  try {
    const bookingData = req.body;

    const newBooking = {
      ...bookingData,
      status: 'pending',
      createdAt: new Date()
    };

    const result = await bookingsCollection.insertOne(newBooking);

    res.status(201).json({
      success: true,
      message: 'Booking request submitted successfully',
      data: result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/bookings', async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: bookings.length,
      data: bookings
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Booking ID'
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id)
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.status(200).json({
      success: true,
      data: booking
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.patch('/bookings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Booking ID'
      });
    }

    const allowedStatus = ['accepted', 'rejected'];

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking status'
      });
    }

    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Booking ${status} successfully`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

//bookin cancellation
app.patch('/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Booking ID'
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        status: 'pending'
      },
      {
        $set: {
          status: 'cancelled',
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Pending booking not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// Transaction API
app.get('/transactions', async (req, res) => {
  try {
    const transactions = await transactionsCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: transactions.length,
      data: transactions
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
// create checkout session for subscription


app.post('/create-checkout-session', async (req, res) => {
  try {
    const { vendorEmail } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',

      metadata: {
        vendorEmail: vendorEmail
      },

      subscription_data: {
        metadata: {
          vendorEmail: vendorEmail
        }
      },

      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'WedPlan Premium Plan'
            },
            unit_amount: 1000,
            recurring: {
              interval: 'month'
            }
          },
          quantity: 1
        }
      ],

      success_url: `${process.env.CLIENT_URL}/payment-success`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancel`
    });

    res.status(200).json({
      success: true,
      checkoutUrl: session.url
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// Start Server
app.listen(port, () => {
  console.log(`WedPlan Server Running on port ${port}`);
});
