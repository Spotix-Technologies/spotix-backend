// v1/lib/ticket/finalize-reference.js
//
// Step 9 of ticket generation: mark the reference doc as fully generated
// and release the processingLock claimed in claim-lock.js. Once this
// commits, future calls for the same reference take the "already
// generated" short-circuit path instead of redoing any work.

export async function finalizeReference(
  fastify,
  referenceDocRef,
  { createdTicketIds, totalTicketCount, nowIso, reference }
) {
  await referenceDocRef.update({
    ticketGenerated: true,
    ticketGeneratedAt: nowIso,
    generatedTicketIds: createdTicketIds,
    totalTicketsGenerated: totalTicketCount,
    processingLock: false, // release — future requests will hit alreadyGenerated path
    updatedAt: nowIso,
  });

  fastify.log.info(`[step:9] Reference ${reference} marked complete`);
}
