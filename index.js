
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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

// Start Server
app.listen(port, () => {
  console.log(`WedPlan Server Running on port ${port}`);
});
