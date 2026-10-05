// v1/controllers/payment.controller.js
//
// Paystack payment initialize/verify/health-check logic, extracted from
// the old monolithic v1/payment.js so the route file (v1/routes/payment.js)
// is just Fastify wiring. Behavior is unchanged — same undici client, same
// cold-start timeout handling, same response shapes.

import { request as undiciRequest } from "undici";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const APP_URL = process.env.APP_URL;

// Track server start time for cold start detection
const serverStartTime = Date.now();

function isPotentialColdStart() {
  return Date.now() - serverStartTime < 60000; // First minute after start
}

// Common headers for Paystack requests
const commonHeaders = {
  Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
  "Content-Type": "application/json",
  "User-Agent": "Fastify-Payment-Service/1.0",
};

// Request timeout configuration (in milliseconds)
const REQUEST_TIMEOUT = 15000; // 15 seconds for Paystack API calls
const COLD_START_TIMEOUT = 45000; // 45 seconds for cold start scenarios

// Making Paystack API calls with cold start detection
async function makePaystackRequest(path, method = "GET", body = null, isColdStart = false) {
  const url = `https://api.paystack.co${path}`;
  const timeout = isColdStart ? COLD_START_TIMEOUT : REQUEST_TIMEOUT;

  const requestOptions = {
    method,
    headers: commonHeaders,
    bodyTimeout: timeout,
    headersTimeout: timeout,
  };

  if (body) {
    requestOptions.body = JSON.stringify(body);
  }

  try {
    const { statusCode, body: responseBody } = await undiciRequest(url, requestOptions);
    const data = await responseBody.json();
    return { statusCode, data };
  } catch (error) {
    if (error.code === "UND_ERR_CONNECT_TIMEOUT" || error.code === "UND_ERR_HEADERS_TIMEOUT") {
      throw new Error("Payment service timeout - please try again");
    }
    throw error;
  }
}

// Fastify schema for POST /payment
export const initializePaymentSchema = {
  body: {
    type: "object",
    required: ["amount", "email"],
    properties: {
      amount: {
        type: "number",
        minimum: 1,
        maximum: 10000000, // 100,000 NGN max
      },
      email: {
        type: "string",
        format: "email",
        maxLength: 254,
      },
      metadata: {
        type: "object",
      },
    },
  },
};

// Fastify schema for GET /payment/verify
export const verifyPaymentSchema = {
  querystring: {
    type: "object",
    required: ["reference"],
    properties: {
      reference: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        pattern: "^[a-zA-Z0-9_-]+$",
      },
    },
  },
};

export async function initializePayment(request, reply) {
  const { amount, email, metadata } = request.body;

  try {
    const paymentData = {
      email,
      amount: Math.round(amount * 100), // Convert to kobo
      callback_url: `${APP_URL}/paystack-success`,
    };

    if (metadata && Object.keys(metadata).length > 0) {
      paymentData.metadata = metadata;
    }

    const response = await makePaystackRequest(
      "/transaction/initialize",
      "POST",
      paymentData,
      isPotentialColdStart()
    );

    if (response.statusCode !== 200) {
      request.log.error("Paystack API error:", response.data);
      return reply.code(response.statusCode).send({
        error: response.data.message || "Payment initialization failed",
      });
    }

    return reply.code(200).send(response.data);
  } catch (error) {
    request.log.error("Payment initialization error:", error);

    if (error.message.includes("timeout")) {
      return reply.code(408).send({
        error: "Payment service timeout - please try again",
      });
    }

    return reply.code(500).send({
      error: "Failed to initialize payment",
    });
  }
}

export async function verifyPayment(request, reply) {
  const { reference } = request.query;

  try {
    const response = await makePaystackRequest(
      `/transaction/verify/${reference}`,
      "GET",
      null,
      isPotentialColdStart()
    );

    if (response.statusCode !== 200) {
      request.log.error("Paystack verification error:", response.data);
      return reply.code(response.statusCode).send({
        error: response.data.message || "Payment verification failed",
      });
    }

    return reply.code(200).send(response.data);
  } catch (error) {
    request.log.error("Payment verification error:", error);

    if (error.message.includes("timeout")) {
      return reply.code(408).send({
        error: "Payment verification timeout - please try again",
      });
    }

    return reply.code(500).send({
      error: "Failed to verify payment",
    });
  }
}

// Keep-alive endpoint to prevent cold starts
export async function pingPayment(request, reply) {
  return reply.code(200).send({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - serverStartTime) / 1000) + "s",
  });
}

// Health check endpoint for payment service
export async function healthCheckPayment(request, reply) {
  try {
    const start = Date.now();
    await makePaystackRequest("/transaction?perPage=1");
    const responseTime = Date.now() - start;

    return reply.code(200).send({
      status: "healthy",
      paystack: "connected",
      responseTime: `${responseTime}ms`,
    });
  } catch (error) {
    return reply.code(503).send({
      status: "unhealthy",
      paystack: "disconnected",
      error: error.message,
    });
  }
}
