
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

// Start Server
app.listen(port, () => {
  console.log(`WedPlan Server Running on port ${port}`);
});
