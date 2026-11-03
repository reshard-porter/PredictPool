'use strict';
/**
 * Simulated identity & eligibility provider. Real launch requires a KYC vendor approved for the
 * configured jurisdiction. Rules here are placeholders driven by config.
 * Test hooks: document numbers starting with "000" are rejected as unverifiable.
 */
const crypto = require('crypto');
const { config } = require('../config');

function ageOn(dob, now = new Date()) {
  const d = new Date(dob + 'T00:00:00Z');
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

async function verifyIdentity({ fullName, dateOfBirth, documentNumber, jurisdiction }) {
  const reasons = [];
  if (!fullName || fullName.trim().length < 3) reasons.push('NAME_MISSING');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth || '')) reasons.push('DOB_INVALID');
  else if (ageOn(dateOfBirth) < config.launch.minimumAge) reasons.push('UNDER_MINIMUM_AGE');
  if (!config.launch.eligibleJurisdictions.includes(jurisdiction)) reasons.push('JURISDICTION_NOT_ELIGIBLE');
  if (!documentNumber || documentNumber.length < 6 || documentNumber.startsWith('000')) reasons.push('DOCUMENT_UNVERIFIABLE');
  return { provider: 'mockkyc', providerRef: `kyc_${crypto.randomBytes(6).toString('hex')}`,
    decision: reasons.length ? 'REJECTED' : 'VERIFIED', reasons };
}

module.exports = { verifyIdentity, ageOn };
