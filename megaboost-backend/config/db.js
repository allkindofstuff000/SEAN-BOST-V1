const mongoose = require("mongoose");

const isProduction = process.env.NODE_ENV === "production";
let listenersRegistered = false;

function getMongoUri() {
  const primary = String(process.env.MONGO_URI || "").trim();
  if (primary) return primary;
  return String(process.env.MONGODB_URI || "").trim();
}

function registerConnectionListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  mongoose.connection.on("error", (error) => {
    console.error(`MongoDB runtime error: ${error.message}`);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected");
  });

  mongoose.connection.on("reconnected", () => {
    console.log("MongoDB reconnected");
  });
}

async function connectDB() {
  const mongoUri = getMongoUri();

  if (!mongoUri) {
    const error = new Error("MONGO_URI/MONGODB_URI is not set");
    console.error(`MongoDB connection failed: ${error.message}`);
    if (isProduction) process.exit(1);
    throw error;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  registerConnectionListeners();
  mongoose.set("strictQuery", true);
  if (isProduction) {
    mongoose.set("autoIndex", false);
  }

  try {
    await mongoose.connect(mongoUri, {
      maxPoolSize: 20,
      minPoolSize: isProduction ? 5 : 0,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4
    });

    console.log("MongoDB connected");
    return mongoose.connection;
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    if (isProduction) process.exit(1);
    throw error;
  }
}

module.exports = connectDB;
