require('dotenv').config();
const mongoose = require('mongoose');
// Correct path to your models file
const { Admin, Client, Seller, Product, Catalog, Order } = require('./models/models.js');

const uri = process.env.DB_CONNECTION_STRING;

const seedDatabase = async () => {
  try {
    await mongoose.connect(uri);
    console.log("✅ Seeder connected to MongoDB!");

    console.log("🧹 Clearing all existing data...");
    await Promise.all([
        Admin.deleteMany({}), Client.deleteMany({}), Seller.deleteMany({}),
        Product.deleteMany({}), Catalog.deleteMany({}), Order.deleteMany({})
    ]);

    console.log("🌱 Seeding Admins...");
    await Admin.create([
      { email: 'super@udaipur.com', role: 'superadmin' },
      { email: 'mod@udaipur.com', role: 'moderator' }
    ]);

    console.log("🌱 Seeding Clients...");
    const clients = await Client.create([
      { name: 'Rohan Mehra', phone: '9876543210', email: 'rohan.m@email.com', otp_verified: true },
      { name: 'Priya Verma', phone: '8765432109', email: 'priya.v@email.com', otp_verified: true }
    ]);

    console.log("🌱 Seeding Sellers...");
    const sellers = await Seller.create([
      { business_name: 'Udaipur Kirana Store', email: 'kirana@udaipur.com', phone: '7654321098', business_type: 'Grocery', approved: true },
      { business_name: 'Paliwal Restaurant', email: 'paliwal@udaipur.com', phone: '6543210987', business_type: 'Restaurant', approved: true }
    ]);
    const kiranaStore = sellers[0];

    console.log("🌱 Seeding Catalogs...");
    const catalogs = await Catalog.create([
        { seller_id: sellers[0]._id, min_products_required: 10, published: true },
        { seller_id: sellers[1]._id, min_products_required: 5, published: true }
    ]);
    const kiranaCatalog = catalogs[0];

    console.log("🌱 Seeding Products...");
    const products = await Product.create([
      { seller_id: kiranaStore._id, name: 'Aashirvaad Atta 5kg', category: 'Grocery', price: 250, status: 'active' },
      { seller_id: kiranaStore._id, name: 'Amul Gold Milk 1L', category: 'Grocery', price: 65, status: 'active' },
      { seller_id: kiranaStore._id, name: 'Parle-G Biscuit', category: 'Grocery', price: 10, status: 'inactive' }
    ]);
    const atta = products[0];
    const milk = products[1];
    
    console.log("🌱 Seeding a complete Order...");
    const orderAmount = (atta.price * 1) + (milk.price * 2);
    await Order.create({
        client_id: clients[0]._id,
        seller_id: kiranaStore._id,
        catalog_id: kiranaCatalog._id,
        published: true,
        order_items: [
            { product_id: atta._id, qty: 1, price_snapshot: atta.price, name_snapshot: atta.name },
            { product_id: milk._id, qty: 2, price_snapshot: milk.price, name_snapshot: milk.name }
        ],
        payment: {
            amount: orderAmount,
            method: 'UPI',
            status: 'completed',
            payment_date: new Date('2025-09-15T10:00:00Z')
        },
        delivery: {
            delivery_status: 'dispatched',
            delivery_start_time: new Date('2025-09-15T11:00:00Z')
        }
    });

    console.log("🎉 Database seeded successfully!");

  } catch (error) {
    console.error("❌ An error occurred during seeding:", error);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 Seeder connection closed.");
  }
};

seedDatabase();