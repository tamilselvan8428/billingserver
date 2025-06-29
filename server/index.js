require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();

// Basic Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Security Middleware
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:5173',        // Local development
    'https://rajasnacks.netlify.app' // Production - NO trailing slash
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Added OPTIONS
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // If using cookies/auth tokens
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// Custom Sanitizer Middleware
app.use((req, _, next) => {
  const sanitize = (obj) => {
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'string') {
          obj[key] = obj[key].replace(/\$/g, '_').replace(/\./g, '_');
        } else if (typeof obj[key] === 'object') {
          sanitize(obj[key]);
        }
      });
    }
  };

  ['body', 'params', 'query'].forEach(prop => {
    if (req[prop]) sanitize(req[prop]);
  });
  next();
});

// MongoDB Connection
const dbPassword = process.env.DB_PASSWORD;
const dbUri = `mongodb+srv://rajasnacks6:${dbPassword}@billing.qqyrxtl.mongodb.net/billing_system?retryWrites=true&w=majority`;

mongoose.connect(dbUri)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err) ;
    process.exit(1);
  });

// Database Models
const Counter = mongoose.model('Counter', new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
}));

const productSchema = new mongoose.Schema({
  _id: { type: Number },
  name: { type: String, required: true, trim: true },
  nameTamil: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, default: 0, min: 0 },
  minStockLevel: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now }
});

productSchema.pre('save', async function(next) {
  if (this._id) return next();
  
  try {
    const counter = await Counter.findByIdAndUpdate(
      { _id: 'productId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this._id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

const Product = mongoose.model('Product', productSchema);

const billSchema = new mongoose.Schema({
  items: [{
    productId: { type: Number, ref: 'Product', required: true },
    nameTamil: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 }
  }],
  grandTotal: { type: Number, required: true, min: 0 },
  customerName: { type: String, trim: true },
  mobileNumber: { type: String, trim: true },
  date: { type: Date, default: Date.now }
});

const Bill = mongoose.model('Bill', billSchema);

// Helper Functions
const validateProductData = (data) => {
  const errors = [];
  if (!data.name) errors.push('Product name is required');
  if (!data.nameTamil) errors.push('Tamil product name is required');
  if (!data.price || isNaN(data.price)) errors.push('Valid price is required');
  return errors;
};

// API Routes

// Product Management
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ _id: 1 });
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ message: 'Failed to fetch products', error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const errors = validateProductData(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation failed', errors });
    }

    const product = new Product({
      name: req.body.name,
      nameTamil: req.body.nameTamil,
      price: req.body.price
    });

    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: 'Failed to create product', error: err.message });
  }
});
// Add this after your existing stock management routes
app.post('/api/products/stock/bulk', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { updates } = req.body;
    
    if (!updates || !Array.isArray(updates)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Updates array is required' });
    }

    const bulkOperations = [];
    const results = [];
    
    for (const update of updates) {
      const productId = parseInt(update.productId);
      const quantity = parseInt(update.quantity);
      
      if (isNaN(productId)){
        results.push({
          productId,
          status: 'failed',
          message: 'Invalid product ID'
        });
        continue;
      }

      if (isNaN(quantity)) {
        results.push({
          productId,
          status: 'failed',
          message: 'Invalid quantity'
        });
        continue;
      }

      bulkOperations.push({
        updateOne: {
          filter: { _id: productId },
          update: { $inc: { stock: quantity } }
        }
      });

      results.push({
        productId,
        status: 'pending'
      });
    }

    if (bulkOperations.length > 0) {
      const bulkResult = await Product.bulkWrite(bulkOperations, { session });
      
      // Update results with actual operation status
      bulkResult.result?.nModified?.forEach((modified, index) => {
        if (results[index]) {
          results[index].status = modified ? 'success' : 'failed';
          results[index].message = modified ? 'Stock updated' : 'No changes made';
        }
      });
    }

    await session.commitTransaction();
    res.json({ message: 'Bulk update processed', results });
  } catch (err) {
    await session.abortTransaction();
    res.status(400).json({ message: 'Failed to process bulk update', error: err.message });
  } finally {
    session.endSession();
  }
});
app.put('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    if (isNaN(productId)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    const errors = validateProductData(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ message: 'Validation failed', errors });
    }

    const product = await Product.findOneAndUpdate(
      { _id: productId },
      {
        name: req.body.name,
        nameTamil: req.body.nameTamil,
        price: parseFloat(req.body.price)
      },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(400).json({ message: 'Failed to update product', error: err.message });
  }
});

// Stock Management
app.post('/api/products/stock', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    
    if (!productId || !quantity || isNaN(quantity)) {
      return res.status(400).json({ message: 'Valid product ID and quantity are required' });
    }

    const id = parseInt(productId);
    const qty = parseInt(quantity);

    const product = await Product.findOneAndUpdate(
      { _id: id },
      { $inc: { stock: qty } },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({
      ...product.toObject(),
      message: `Stock updated. New stock level: ${product.stock}`
    });
  } catch (err) {
    res.status(400).json({ message: 'Failed to update stock', error: err.message });
  }
});

app.get('/api/products/low-stock', async (req, res) => {
  try {
    const lowStockProducts = await Product.find({
      $expr: { $lt: ['$stock', '$minStockLevel'] }
    });
    res.json(lowStockProducts);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch low stock products', error: err.message });
  }
});

// Billing System
app.post('/api/bills', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { items, customerName, mobileNumber } = req.body;
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'At least one bill item is required' });
    }

    let grandTotal = 0;
    const billItems = [];
    const stockUpdates = [];
    
    // Validate all items first
    for (const item of items) {
      const productId = parseInt(item.productId);
      const quantity = parseInt(item.quantity);
      
      if (isNaN(productId) || isNaN(quantity) || quantity <= 0) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Invalid product ID or quantity' });
      }

      const product = await Product.findOne({ _id: productId }).session(session);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ message: `Product ${productId} not found` });
      }
      
      if (product.stock < quantity) {
        await session.abortTransaction();
        return res.status(400).json({ 
          message: `Insufficient stock for ${product.nameTamil}. Available: ${product.stock}`,
          productId: product._id,
          availableStock: product.stock
        });
      }
      
      const itemTotal = quantity * product.price;
      grandTotal += itemTotal;
      
      billItems.push({
        productId: product._id,
        nameTamil: product.nameTamil,
        quantity,
        price: product.price,
        total: itemTotal
      });
      
      stockUpdates.push({
        updateOne: {
          filter: { _id: product._id },
          update: { $inc: { stock: -quantity } }
        }
      });
    }
    
    // Process all updates in a single operation
    if (stockUpdates.length > 0) {
      await Product.bulkWrite(stockUpdates, { session });
    }
    
    const bill = new Bill({
      items: billItems,
      grandTotal,
      customerName,
      mobileNumber
    });
    
    await bill.save({ session });
    await session.commitTransaction();
    
    res.status(201).json(bill);
  } catch (err) {
    await session.abortTransaction();
    res.status(400).json({ message: 'Failed to create bill', error: err.message });
  } finally {
    session.endSession();
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: 'Endpoint not found' });
});

// Server Startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  process.exit(0);
});