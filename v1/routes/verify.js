// api/verify.js
import fetch from "node-fetch"

export default async function verifyRoute(fastify, options) {
  fastify.get("/verify", async (request, reply) => {
    const { accountNumber, bankCode } = request.query || {}

    if (!accountNumber || !bankCode) {
      return reply.code(400).send({
        status: false,
        message: "accountNumber and bankCode are required",
      })
    }

    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY
    if (!paystackSecretKey) {
      console.error("Paystack secret key is missing")
      return reply.code(500).send({
        status: false,
        message: "Internal server error. Please contact support.",
      })
    }

    try {
      const url = `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
      })

      const data = await response.json()

      if (data.status === true && data.data && data.data.account_name) {
        return reply.send({
          status: true,
          account_name: data.data.account_name,
          account_number: data.data.account_number,
          bank_code: bankCode,
        })
      } else {
        return reply.code(400).send({
          status: false,
          message:
            data.message ||
            "Unable to verify account. Please check the account number and try again.",
        })
      }
    } catch (error) {
      console.error("Error from Paystack API:", error)
      return reply.code(500).send({
        status: false,
        message: "Failed to verify account. Please try again later.",
      })
    }
  })
}