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
    'http://localhost:5173',
    'https://rajasnacks.netlify.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// MongoDB Connection
const dbPassword = process.env.DB_PASSWORD;
const dbUri = `mongodb+srv://rajasnacks6:${dbPassword}@billing.qqyrxtl.mongodb.net/billing_system?retryWrites=true&w=majority`;

mongoose.connect(dbUri)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
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
  billNumber: { type: String, unique: true },
  items: [{
    productId: { type: Number, ref: 'Product', required: true },
    nameTamil: { type: String, required: true },
    quantity: { 
      type: Number, 
      required: true, 
      min: [1, 'Quantity must be at least 1'],
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be an integer'
      }
    },
    price: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 }
  }],
  grandTotal: { type: Number, required: true, min: 0 },
  customerName: { type: String, trim: true },
  mobileNumber: { 
    type: String, 
    trim: true,
    validate: {
      validator: function(v) {
        return /^\d{10}$/.test(v);
      },
      message: 'Mobile number must be 10 digits'
    }
  },
  date: { type: Date, default: Date.now }
});

billSchema.pre('save', async function(next) {
  if (!this.billNumber) {
    try {
      const counter = await Counter.findByIdAndUpdate(
        { _id: 'billNumber' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.billNumber = `BILL-${new Date().getFullYear()}-${counter.seq.toString().padStart(6, '0')}`;
      next();
    } catch (err) {
      next(err);
    }
  } else {
    next();
  }
});

const Bill = mongoose.model('Bill', billSchema);

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobileNumber: { 
    type: String, 
    required: true,
    unique: true,
    validate: {
      validator: function(v) {
        return /^\d{10}$/.test(v);
      },
      message: 'Mobile number must be 10 digits'
    }
  },
  lastUsed: { type: Date, default: Date.now }
});

const Contact = mongoose.model('Contact', contactSchema);

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
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch products', 
      error: err.message 
    });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const errors = validateProductData(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors 
      });
    }

    const product = new Product({
      name: req.body.name,
      nameTamil: req.body.nameTamil,
      price: req.body.price
    });

    await product.save();
    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product
    });
  } catch (err) {
    res.status(400).json({ 
      success: false,
      message: 'Failed to create product', 
      error: err.message 
    });
  }
});

app.post('/api/products/stock/bulk', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { updates } = req.body;

    if (!updates || !Array.isArray(updates)) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Updates array is required' 
      });
    }

    const bulkOperations = [];
    const results = [];
    
    for (const update of updates) {
      const productId = parseInt(update.productId);
      const quantity = parseInt(update.quantity);

      if (isNaN(productId) || isNaN(quantity)) {
        results.push({
          productId,
          status: 'failed',
          message: 'Invalid product ID or quantity'
        });
        continue;
      }

      bulkOperations.push({
        updateOne: {
          filter: { _id: productId },
          update: { $inc: { stock: quantity } }
        }
      });
    }

    let bulkResult = null;
    if (bulkOperations.length > 0) {
      bulkResult = await Product.bulkWrite(bulkOperations, { session });
    }

    const updatedProductIds = updates
      .map(u => parseInt(u.productId))
      .filter(id => !isNaN(id));
    
    const updatedProducts = await Product.find(
      { _id: { $in: updatedProductIds } },
      { _id: 1, stock: 1, nameTamil: 1 }
    ).session(session);

    const response = {
      success: true,
      message: 'Bulk update processed',
      results: updates.map(update => {
        const productId = parseInt(update.productId);
        const product = updatedProducts.find(p => p._id === productId);
        
        if (!product) {
          return {
            productId,
            status: 'failed',
            message: 'Product not found'
          };
        }

        return {
          productId,
          productName: product.nameTamil,
          newStock: product.stock,
          status: 'success',
          message: 'Stock updated successfully'
        };
      })
    };

    await session.commitTransaction();
    res.json(response);
  } catch (err) {
    await session.abortTransaction();
    console.error('Bulk update error:', err);
    res.status(400).json({ 
      success: false,
      message: 'Failed to process bulk update',
      error: err.message 
    });
  } finally {
    session.endSession();
  }
});

// Billing System
// Enhanced Billing Endpoint with better error handling
app.post('/api/bills', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { items, customerName, mobileNumber } = req.body;
    
    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'At least one bill item is required',
        errorType: 'NO_ITEMS'
      });
    }

    if (!customerName || !mobileNumber) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Customer name and mobile number are required',
        errorType: 'MISSING_CUSTOMER_INFO'
      });
    }

    // Validate mobile number format
    if (!/^\d{10}$/.test(mobileNumber)) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Mobile number must be 10 digits',
        errorType: 'INVALID_MOBILE_NUMBER'
      });
    }

    let grandTotal = 0;
    const billItems = [];
    const stockUpdates = [];
    const productCache = {};
    
    // Process each item with detailed validation
    for (const [index, item] of items.entries()) {
      try {
        const productId = parseInt(item.productId);
        const quantity = parseInt(item.quantity);
        
        if (isNaN(productId) || productId <= 0) {
          throw new Error(`Invalid product ID at position ${index}`);
        }
        
        if (isNaN(quantity) || quantity <= 0) {
          throw new Error(`Invalid quantity at position ${index}`);
        }

        // Check product cache first
        let product = productCache[productId];
        if (!product) {
          product = await Product.findOne({ _id: productId }).session(session);
          if (!product) {
            throw new Error(`Product ${productId} not found at position ${index}`);
          }
          productCache[productId] = product;
        }
        
        if (product.stock < quantity) {
          throw new Error(
            `Insufficient stock for ${product.nameTamil} (Available: ${product.stock}, Requested: ${quantity}) at position ${index}`
          );
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
      } catch (itemError) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: itemError.message,
          errorType: 'INVALID_ITEM',
          itemIndex: index
        });
      }
    }
    
    // Process stock updates in bulk
    try {
      if (stockUpdates.length > 0) {
        await Product.bulkWrite(stockUpdates, { session });
      }
    } catch (bulkWriteError) {
      await session.abortTransaction();
      return res.status(500).json({
        success: false,
        message: 'Failed to update product stock',
        error: bulkWriteError.message,
        errorType: 'STOCK_UPDATE_FAILED'
      });
    }
    
    // Create and save the bill
    const bill = new Bill({
      items: billItems,
      grandTotal,
      customerName,
      mobileNumber
    });
    
    const savedBill = await bill.save({ session });

    // Save contact if doesn't exist (but don't fail bill creation if this fails)
    try {
      const existingContact = await Contact.findOne({ mobileNumber }).session(session);
      if (!existingContact) {
        const newContact = new Contact({
          name: customerName,
          mobileNumber
        });
        await newContact.save({ session });
      }
    } catch (contactError) {
      console.error('Failed to save contact:', contactError);
      // Continue with bill creation even if contact save fails
    }

    await session.commitTransaction();
    
    return res.status(201).json({
      success: true,
      message: 'Bill created successfully',
      bill: savedBill
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Bill creation error:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during bill creation',
      error: err.message,
      errorType: 'INTERNAL_SERVER_ERROR'
    });
  } finally {
    session.endSession();
  }
});
// Stock Management Endpoint
app.post('/api/products/stock', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { productId, quantity } = req.body;

    if (!productId || isNaN(quantity)) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Product ID and valid quantity are required' 
      });
    }

    const product = await Product.findOneAndUpdate(
      { _id: productId },
      { $inc: { stock: quantity } },
      { new: true, session }
    );

    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ 
        success: false,
        message: 'Product not found' 
      });
    }

    await session.commitTransaction();
    
    res.json({
      success: true,
      message: 'Stock updated successfully',
      product: {
        _id: product._id,
        name: product.name,
        nameTamil: product.nameTamil,
        stock: product.stock
      }
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Stock update error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to update stock',
      error: err.message 
    });
  } finally {
    session.endSession();
  }
});
// Contact Management
app.post('/api/contacts', async (req, res) => {
  try {
    const { name, mobileNumber } = req.body;
    
    if (!name || !mobileNumber) {
      return res.status(400).json({ 
        success: false,
        message: 'Name and mobile number are required'
      });
    }

    const existingContact = await Contact.findOne({ mobileNumber });
    if (existingContact) {
      return res.status(200).json({
        success: true,
        message: 'Contact already exists',
        isNew: false
      });
    }

    const newContact = new Contact({
      name,
      mobileNumber
    });

    await newContact.save();
    
    res.status(201).json({
      success: true,
      message: 'Contact saved successfully',
      isNew: true,
      contact: newContact
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(200).json({
        success: true,
        message: 'Contact already exists',
        isNew: false
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to save contact',
      error: err.message
    });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ lastUsed: -1 }).limit(20);
    res.json({
      success: true,
      contacts
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contacts',
      error: err.message
    });
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    success: false,
    message: 'Internal server error',
    error: err.message
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    message: 'Endpoint not found' 
  });
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