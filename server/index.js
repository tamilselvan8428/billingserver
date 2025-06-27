require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// MongoDB Connection
const dbPassword = process.env.DB_PASSWORD;
const dbUri = `mongodb+srv://rajasnacks6:${dbPassword}@billing.qqyrxtl.mongodb.net/billing_system?retryWrites=true&w=majority`;

mongoose.connect(dbUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Counter Schema for auto-increment
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// Product Schema
const productSchema = new mongoose.Schema({
  _id: { type: Number },
  name: { type: String, required: true },
  nameTamil: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Auto-increment middleware
productSchema.pre('save', async function(next) {
  if (this._id) return next(); // Skip if ID already exists
  
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

// Bill Schema
const billSchema = new mongoose.Schema({
  items: [{
    productId: { type: Number, ref: 'Product' },
    nameTamil: String,
    quantity: Number,
    price: Number,
    total: Number
  }],
  grandTotal: Number,
  date: { type: Date, default: Date.now }
});

const Bill = mongoose.model('Bill', billSchema);

// Routes

// Product Routes
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ _id: 1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, nameTamil, price } = req.body;
    
    if (!name || !nameTamil || !price) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const product = new Product({
      name,
      nameTamil,
      price: parseFloat(price)
    });
    
    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { name, nameTamil, price } = req.body;

    const product = await Product.findOneAndUpdate(
      { _id: productId },
      { name, nameTamil, price },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = await Product.findOneAndDelete({ _id: productId });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/products/stock', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    
    if (!productId || !quantity) {
      return res.status(400).json({ message: 'Both productId and quantity are required' });
    }

    const id = parseInt(productId);
    const qty = parseInt(quantity);

    if (isNaN(id) || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ message: 'Invalid product ID or quantity' });
    }

    const product = await Product.findOne({ _id: id });
    if (!product) {
      const existingIds = await Product.distinct('_id');
      return res.status(404).json({ 
        message: `Product ${id} not found. Available IDs: ${existingIds.join(', ')}`
      });
    }

    product.stock += qty;
    await product.save();
    res.json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get('/api/products/low-stock', async (req, res) => {
  try {
    const lowStockProducts = await Product.find({ stock: { $lt: 10 } });
    res.json(lowStockProducts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Billing Routes
app.post('/api/bills', async (req, res) => {
  const { items } = req.body;
  
  try {
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Invalid bill items' });
    }

    let grandTotal = 0;
    const billItems = [];
    
    for (const item of items) {
      const productId = parseInt(item.productId);
      const product = await Product.findOne({ _id: productId });
      
      if (!product) {
        return res.status(404).json({ message: `Product ${productId} not found` });
      }
      
      const quantity = parseInt(item.quantity);
      if (product.stock < quantity) {
        return res.status(400).json({ 
          message: `Insufficient stock for ${product.name}. Available: ${product.stock}`
        });
      }
      
      product.stock -= quantity;
      await product.save();
      
      const itemTotal = quantity * product.price;
      grandTotal += itemTotal;
      
      billItems.push({
        productId: product._id,
        nameTamil: product.nameTamil,
        quantity,
        price: product.price,
        total: itemTotal
      });
    }
    
    const bill = new Bill({
      items: billItems,
      grandTotal
    });
    
    await bill.save();
    res.status(201).json(bill);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get('/api/bills/:id', async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    
    const populatedBill = {
      ...bill.toObject(),
      items: await Promise.all(bill.items.map(async item => {
        const product = await Product.findOne({ _id: item.productId });
        return {
          ...item,
          productDetails: product || null
        };
      }))
    };
    
    res.json(populatedBill);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});