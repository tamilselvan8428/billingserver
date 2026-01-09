const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://tamil:tamil@cluster0.lxk1iio.mongodb.net/billing_system?retryWrites=true&w=majority";
const client = new MongoClient(uri);

async function updateStock() {
  try {
    await client.connect();
    const db = client.db();
    const result = await db.collection('products').updateMany(
      {},
      { $inc: { stock: 20 } }
    );
    console.log(`${result.modifiedCount} documents were updated`);
  } finally {
    await client.close();
  }
}

updateStock().catch(console.error);