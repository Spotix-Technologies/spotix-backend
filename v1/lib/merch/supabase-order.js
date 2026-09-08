// v1/lib/merch/supabase-order.js
//
// Calls the record_merch_order() RPC (see
// /supabase/schema-merch.sql + schema-merch-migration-v2.sql) once per
// cart line item. That RPC, inside a single row-locked transaction:
//   - inserts the merch_orders row
//   - bumps merch_listings.total_amount / total_sold
//   - decrements merch_listings.quantity (clamped at 0)
// so this file never touches merch_listings directly — all the
// read-lock-write happens atomically on the Postgres side.

import { supabaseAdmin } from "../supabase-admin.js";

/**
 * @param {object} params
 * @param {string} params.orderId       SPTX-MH-{10 alphanumeric}, from order-id.js
 * @param {string} params.listingId
 * @param {string} params.fullName
 * @param {string|null} params.username
 * @param {string} params.email
 * @param {string} params.phoneNumber
 * @param {string} params.address
 * @param {number} params.qty
 * @param {number} params.amountPaid    gross line total (price * qty), pre-fee
 * @param {string|null} params.buyerUserId
 * @returns the inserted merch_orders row (snake_case, straight from Postgres)
 */
export async function recordMerchOrder(params) {
  const { data, error } = await supabaseAdmin.rpc("record_merch_order", {
    p_order_id: params.orderId,
    p_listing_id: params.listingId,
    p_full_name: params.fullName,
    p_username: params.username ?? null,
    p_email: params.email,
    p_phone_number: params.phoneNumber,
    p_address: params.address,
    p_qty: params.qty,
    p_amount_paid: params.amountPaid,
    p_buyer_user_id: params.buyerUserId ?? null,
  });

  if (error) throw error;
  return data;
}
