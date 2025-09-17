// Load environment variables from .env file
require('dotenv').config();
const mongoose = require('mongoose');

// Get the connection string and port from environment variables
const uri = process.env.DB_CONNECTION_STRING;
const port = process.env.PORT || 3000; // Use port from .env or default to 3000

// Main function to connect to the database
async function connectToDatabase() {
  if (!uri) {
    console.error("❌ DB_CONNECTION_STRING not found in .env file.");
    process.exit(1); // Exit the application if the connection string is missing
  }

  try {
    await mongoose.connect(uri);
    console.log("✅ Successfully connected to MongoDB Atlas!");

   
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
    process.exit(1);
  }
}

// Function to demonstrate the connection and then exit
async function run() {
    await connectToDatabase();
    // In a real server, you wouldn't close the connection. This is just for a connection test.
    await mongoose.connection.close();
    console.log("🔌 Connection closed for this script. In a real server, it would stay open.");
}

run();